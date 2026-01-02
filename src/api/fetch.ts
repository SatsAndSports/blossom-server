import { extname } from "node:path";
import { PassThrough } from "node:stream";
import dayjs from "dayjs";
import mime from "mime";
import HttpErrors from "http-errors";
import range from "koa-range";

import { config } from "../config.js";
import { BlobPointer, BlobSearch } from "../types.js";
import * as upstreamDiscovery from "../discover/upstream.js";
import * as nostrDiscovery from "../discover/nostr.js";
import * as httpTransport from "../transport/http.js";
import * as uploadModule from "../storage/upload.js";
import { getFileRule } from "../rules/index.js";
import storage, { getStorageRedirect, readStoragePointer, searchStorage } from "../storage/index.js";
import { updateBlobAccess } from "../db/methods.js";
import { blobDB, masterHashCache, incrementVideoViews } from "../db/db.js";
import logger from "../logger.js";
import { log, router } from "./router.js";
import { channel_parameters_get_channel_id, compute_shared_secret, verify_balance_update_signature, verify_channel } from "../wasm/cdk_wasm.js";
import { getKeysetKeys } from "./channel.js";

const paymentLog = logger.extend("payments");

// Result of payment validation - null means success
interface PaymentError {
  header: Record<string, any>;  // JSON for X-Cashu-Channel header
  body: Record<string, any>;    // JSON for response body
}

// Validate a payment and return error info if invalid, null if valid
function validatePayment(
  paymentHeader: string | undefined,
  blobSize: number
): PaymentError | null {
  // Check if channel payments are enabled
  if (!config.channel?.enabled) {
    return null; // Payments not required
  }

  // Check header is present and valid JSON
  if (!paymentHeader) {
    paymentLog("No X-Cashu-Channel header (size=%d)", blobSize);
    return {
      header: { error: "missing", size: blobSize },
      body: { error: "Payment required", reason: "missing" },
    };
  }

  let payment: any;
  try {
    payment = JSON.parse(paymentHeader);
  } catch {
    paymentLog("Invalid JSON in X-Cashu-Channel header");
    return {
      header: { error: "invalid JSON", size: blobSize },
      body: { error: "Payment required", reason: "invalid JSON" },
    };
  }

  // Check required fields
  if (!payment.channel_id || typeof payment.channel_id !== "string") {
    return {
      header: { error: "missing channel_id", size: blobSize },
      body: { error: "Payment required", reason: "missing channel_id" },
    };
  }
  if (typeof payment.balance !== "number") {
    return {
      header: { error: "missing balance", size: blobSize },
      body: { error: "Payment required", reason: "missing balance" },
    };
  }
  if (!payment.signature || typeof payment.signature !== "string") {
    return {
      header: { error: "missing signature", size: blobSize },
      body: { error: "Payment required", reason: "missing signature" },
    };
  }

  // For new channels with params and funding proofs, validate everything first
  // before checking any server-side caches
  if (payment.params && payment.funding_proofs) {
    const paramsJson = JSON.stringify(payment.params);
    const fundingProofsJson = JSON.stringify(payment.funding_proofs);
    const alicePubkey = payment.params.alice_pubkey;

    if (!config.channel.secretKey) {
      return {
        header: { error: "server misconfigured", size: blobSize },
        body: { error: "Payment required", reason: "server misconfigured" },
      };
    }

    const sharedSecret = compute_shared_secret(config.channel.secretKey, alicePubkey);
    const computedChannelId = channel_parameters_get_channel_id(paramsJson, sharedSecret);
    const channelIdMatch = computedChannelId === payment.channel_id;
    paymentLog("channel_id verify: computed=%s provided=%s match=%s",
      computedChannelId.substring(0, 8),
      payment.channel_id?.substring(0, 8),
      channelIdMatch ? "YES" : "NO"
    );

    if (!channelIdMatch) {
      return {
        header: { error: "channel_id mismatch", size: blobSize },
        body: { error: "Payment required", reason: "channel_id mismatch" },
      };
    }

    // Check keyset is from approved mint
    const mintUrl = payment.params.mint;
    const keysetId = payment.params.keyset_id;
    const cachedKeys = getKeysetKeys(mintUrl, keysetId);

    if (!cachedKeys) {
      paymentLog("channel validation FAILED: keyset %s not from approved mint %s", keysetId, mintUrl);
      return {
        header: { error: "keyset not from approved mint", size: blobSize, mint: mintUrl, keyset_id: keysetId },
        body: { error: "Payment required", reason: "keyset not from approved mint" },
      };
    }

    // Build keyset info for verification
    const keysetInfo = {
      keysetId: keysetId,
      keys: cachedKeys,
      inputFeePpk: payment.params.input_fee_ppk || 0,
    };

    // Run full channel verification (DLEQ, keyset ID match)
    try {
      const verificationResultJson = verify_channel(
        paramsJson,
        sharedSecret,
        fundingProofsJson,
        JSON.stringify(keysetInfo)
      );
      const verificationResult = JSON.parse(verificationResultJson);
      paymentLog("channel validation: valid=%s errors=%d", verificationResult.valid, verificationResult.errors.length);

      if (!verificationResult.valid) {
        paymentLog("channel validation FAILED: %s", JSON.stringify(verificationResult.errors));
        return {
          header: { error: "channel validation failed", size: blobSize, validation_errors: verificationResult.errors },
          body: { error: "Payment required", reason: "channel validation failed", details: verificationResult.errors },
        };
      }
    } catch (e) {
      paymentLog("channel validation ERROR: %s", (e as Error).message);
      return {
        header: { error: "channel validation error", size: blobSize, message: (e as Error).message },
        body: { error: "Payment required", reason: "channel validation error" },
      };
    }

    // Verify signature
    let signatureValid = false;
    try {
      signatureValid = verify_balance_update_signature(
        paramsJson,
        sharedSecret,
        fundingProofsJson,
        payment.channel_id,
        BigInt(payment.balance),
        payment.signature
      );
      paymentLog("signature verify: %s", signatureValid ? "VALID" : "INVALID");
    } catch (e) {
      paymentLog("signature verify: ERROR - %s", (e as Error).message);
    }

    if (!signatureValid) {
      return {
        header: { error: "invalid signature", size: blobSize },
        body: { error: "Payment required", reason: "invalid signature" },
      };
    }

    // Channel is valid, store it
    storeChannel(payment.channel_id, paramsJson, fundingProofsJson);
    updateChannelBalance(payment.channel_id, payment.balance);
    recordBlobServed(payment.channel_id, blobSize);

    return null; // Success
  }

  // No params/funding_proofs provided - check if this is a known channel
  // (Only now do we check server-side caches)
  const channel = getChannel(payment.channel_id);
  paymentLog("channel=%s balance: %d -> %d (client) served: blobs=%d bytes=%d known=%s",
    payment.channel_id?.substring(0, 8),
    channel?.lastBalance ?? 0,
    payment.balance,
    channel?.blobsServed ?? 0,
    channel?.bytesServed ?? 0,
    !!channel
  );

  if (!channel) {
    // Unknown channel and no params/funding_proofs provided
    return {
      header: { error: "unknown channel", size: blobSize },
      body: { error: "Payment required", reason: "unknown channel - provide params and funding_proofs" },
    };
  }

  // Known channel - verify signature and update balance
  const paramsJson = channel.paramsJson;
  const fundingProofsJson = channel.fundingProofsJson;
  const params = JSON.parse(paramsJson);
  const sharedSecret = compute_shared_secret(config.channel.secretKey, params.alice_pubkey);

  let signatureValid = false;
  try {
    signatureValid = verify_balance_update_signature(
      paramsJson,
      sharedSecret,
      fundingProofsJson,
      payment.channel_id,
      BigInt(payment.balance),
      payment.signature
    );
    paymentLog("signature verify: %s", signatureValid ? "VALID" : "INVALID");
  } catch (e) {
    paymentLog("signature verify: ERROR - %s", (e as Error).message);
  }

  if (!signatureValid) {
    return {
      header: { error: "invalid signature", size: blobSize },
      body: { error: "Payment required", reason: "invalid signature" },
    };
  }

  updateChannelBalance(payment.channel_id, payment.balance);
  recordBlobServed(payment.channel_id, blobSize);

  return null; // Success
}

// In-memory channel state
// Stores everything we need to verify payments for a channel
interface ChannelState {
  paramsJson: string;        // Channel parameters JSON
  fundingProofsJson: string; // Funding proofs JSON
  blobsServed: number;       // Number of blobs served
  bytesServed: number;       // Total bytes served
  lastBalance: number;       // Last balance claimed by client
}
const channels: Map<string, ChannelState> = new Map();

// Get channel state (null if unknown)
function getChannel(channelId: string): ChannelState | null {
  return channels.get(channelId) ?? null;
}

// Store channel (only if not already stored)
function storeChannel(channelId: string, paramsJson: string, fundingProofsJson: string): void {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      paramsJson,
      fundingProofsJson,
      blobsServed: 0,
      bytesServed: 0,
      lastBalance: 0,
    });
    paymentLog("channel=%s stored (params + funding)", channelId.substring(0, 8));
  }
}

// Update the last balance claimed by client (only if higher than current)
function updateChannelBalance(channelId: string, newBalance: number): void {
  const channel = channels.get(channelId);
  if (channel && newBalance > channel.lastBalance) {
    channel.lastBalance = newBalance;
  }
}

// Record that a blob was served to a channel
function recordBlobServed(channelId: string, size: number): void {
  const channel = channels.get(channelId);
  if (channel) {
    channel.blobsServed += 1;
    channel.bytesServed += size;
    paymentLog("channel=%s served blob size=%d total: blobs=%d bytes=%d",
      channelId.substring(0, 8), size, channel.blobsServed, channel.bytesServed);
  }
}

router.get("/:hash", range, async (ctx, next) => {
  const paymentHeader = ctx.headers["x-cashu-channel"] as string | undefined;
  paymentLog("request path=%s hasPayment=%s", ctx.path, !!paymentHeader);
  if (paymentHeader) {
    // Log a condensed version of the header (replace funding_proofs array with "FUNDED")
    try {
      const parsed = JSON.parse(paymentHeader);
      if (parsed.funding_proofs) {
        parsed.funding_proofs = "...FUNDING TOKEN REDACTED...";
      }
      paymentLog("X-Cashu-Channel: %s", JSON.stringify(parsed));
    } catch {
      paymentLog("X-Cashu-Channel: %s", paymentHeader);
    }
  }

  const match = ctx.path.match(/([0-9a-f]{64})/);
  if (!match) return next();

  const hash = match[1];
  const ext = extname(ctx.path) ?? undefined;

  const search: BlobSearch = {
    hash,
    ext,
    type: mime.getType(ctx.path) ?? undefined,
  };

  // Look up blob first - no point verifying payment if blob doesn't exist
  const storageResult = await searchStorage(search);
  if (storageResult) {
    updateBlobAccess(search.hash, dayjs().unix());

    // Increment view count if this is a video master playlist
    if (masterHashCache.has(search.hash)) {
      incrementVideoViews(search.hash);
    }

    // Validate payment
    const paymentError = validatePayment(paymentHeader, storageResult.size);
    if (paymentError) {
      ctx.status = 402;
      ctx.set("X-Cashu-Channel", JSON.stringify(paymentError.header));
      ctx.body = paymentError.body;
      return;
    }

    const redirect = getStorageRedirect(storageResult);
    if (redirect) return ctx.redirect(redirect);

    // explicitly set type and length since this is a stream
    if (storageResult.type) ctx.type = storageResult.type;
    ctx.length = storageResult.size;

    // koa cannot set Content-Length from stream
    ctx.body = await readStoragePointer(storageResult);
    return;
  }

  log("Looking for", search.hash);

  // we don't have the blob, go looking for it
  const pointers: BlobPointer[] = [];

  if (config.discovery.nostr.enabled) {
    let nostrPointers = await nostrDiscovery.search(search);
    for (const pointer of nostrPointers) pointers.push(pointer);
  }

  if (config.discovery.upstream.enabled) {
    const cdnPointer = await upstreamDiscovery.search(search);
    if (cdnPointer) pointers.push(cdnPointer);
  }

  // download it from pointers if any where found
  for (const pointer of pointers) {
    try {
      if (pointer.kind === "http") {
        const response = await httpTransport.readHTTPPointer(pointer);

        if (!ctx.type) {
          // if the pointer has a binary stream, try to use the search mime type
          if (pointer.type === "application/octet-stream" && search.type) ctx.type = search.type;
          else if (pointer.type) ctx.type = pointer.type;
          else if (search.type) ctx.type = search.type;
        }

        const pass = (ctx.body = new PassThrough());

        // set the Content-Length since koa cannot set it from a stream
        ctx.length = pointer.size;
        response.pipe(pass);

        // save to cache
        const rule = getFileRule(
          { type: pointer.type || search.type, pubkey: pointer.metadata?.pubkey },
          config.storage.rules,
        );
        if (rule) {
          // save the blob in the background (no await)
          uploadModule.saveFromResponse(response).then(async (upload) => {
            if (upload.sha256 !== pointer.hash) return;

            // if the storage dose not have the blob. upload it
            if (!(await storage.hasBlob(upload.sha256))) {
              const type = upload.type || ctx.type || "";
              await storage.writeBlob(upload.sha256, uploadModule.readUpload(upload), type);
              await uploadModule.removeUpload(upload);

              if (!blobDB.hasBlob(upload.sha256)) {
                blobDB.addBlob({ sha256: upload.sha256, size: upload.size, type, uploaded: dayjs().unix() });
              }
            } else {
              await uploadModule.removeUpload(upload);
            }
          });
        }

        return;
      }
    } catch (e) {}
  }

  if (!ctx.body) throw new HttpErrors.NotFound("Cant find blob for hash");
});
