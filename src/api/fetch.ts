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
import { channel_parameters_get_channel_id, compute_shared_secret, verify_balance_update_signature } from "../wasm/cdk_wasm.js";

const paymentLog = logger.extend("payments");

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

    // Process payment header if present (now we know blob size)
    // Check if channel payments are enabled
    if (config.channel?.enabled) {
      // Validate the payment header
      let payment: any = null;
      let headerError: string | null = null;

      if (!paymentHeader) {
        headerError = "missing";
        paymentLog("No X-Cashu-Channel header for hash %s (size=%d)", hash, storageResult.size);
      } else {
        try {
          payment = JSON.parse(paymentHeader);
          // Check required fields
          if (!payment.channel_id || typeof payment.channel_id !== "string") {
            headerError = "missing channel_id";
          } else if (typeof payment.balance !== "number") {
            headerError = "missing balance";
          } else if (!payment.signature || typeof payment.signature !== "string") {
            headerError = "missing signature";
          }
        } catch {
          headerError = "invalid JSON";
          paymentLog("Invalid JSON in X-Cashu-Channel header");
        }
      }

      // Return 402 if header is missing or invalid
      if (headerError) {
        ctx.status = 402;
        ctx.set("X-Cashu-Channel", JSON.stringify({
          error: headerError,
          size: storageResult.size,
        }));
        ctx.body = { error: "Payment required", reason: headerError };
        return;
      }
    }

    if (paymentHeader) {
      try {
        const payment = JSON.parse(paymentHeader);
        const channel = getChannel(payment.channel_id);
        paymentLog("channel=%s balance: %d -> %d (client) served: blobs=%d bytes=%d known=%s",
          payment.channel_id?.substring(0, 8),
          channel?.lastBalance ?? 0,
          payment.balance,
          channel?.blobsServed ?? 0,
          channel?.bytesServed ?? 0,
          !!channel
        );

        // Get params and funding proofs (from header or cache)
        const paramsJson = payment.params ? JSON.stringify(payment.params) : channel?.paramsJson;
        const fundingProofsJson = payment.funding_proofs ? JSON.stringify(payment.funding_proofs) : channel?.fundingProofsJson;

        // Verify signature if we have params and funding proofs
        let signatureValid = false;
        if (paramsJson && fundingProofsJson && config.channel?.secretKey) {
          try {
            const params = JSON.parse(paramsJson);
            const sharedSecret = compute_shared_secret(config.channel.secretKey, params.alice_pubkey);
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
        }

        // Store new channel if params and funding proofs provided
        if (payment.params && payment.funding_proofs && config.channel?.secretKey) {
          const paramsJson = JSON.stringify(payment.params);
          const fundingProofsJson = JSON.stringify(payment.funding_proofs);
          const alicePubkey = payment.params.alice_pubkey;
          const sharedSecret = compute_shared_secret(config.channel.secretKey, alicePubkey);
          const computedChannelId = channel_parameters_get_channel_id(paramsJson, sharedSecret);
          const channelIdMatch = computedChannelId === payment.channel_id;
          paymentLog("channel_id verify: computed=%s provided=%s match=%s",
            computedChannelId.substring(0, 8),
            payment.channel_id?.substring(0, 8),
            channelIdMatch ? "YES" : "NO"
          );

          if (channelIdMatch) {
            storeChannel(payment.channel_id, paramsJson, fundingProofsJson);
            updateChannelBalance(payment.channel_id, payment.balance);
            if (signatureValid) {
              recordBlobServed(payment.channel_id, storageResult.size);
            }
          }
        } else if (channel) {
          // Known channel, update balance
          updateChannelBalance(payment.channel_id, payment.balance);
          if (signatureValid) {
            recordBlobServed(payment.channel_id, storageResult.size);
          }
        }
      } catch (e) {
        paymentLog("hash=%s invalid payment header: %s", hash.substring(0, 8), paymentHeader);
      }
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
