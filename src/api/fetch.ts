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

// In-memory channel usage tracking
// Map of channel_id -> { blobsServed, bytesServed, lastBalance }
interface ChannelUsage {
  blobsServed: number;
  bytesServed: number;
  lastBalance: number;  // Last balance claimed by client
}
const channelUsage: Map<string, ChannelUsage> = new Map();

// In-memory channel params storage
// Map of channel_id -> params JSON string
const channelParams: Map<string, string> = new Map();

// In-memory channel funding proofs storage
// Map of channel_id -> funding proofs JSON string
const channelFundingProofs: Map<string, string> = new Map();

// Get usage for a channel
function getChannelUsage(channelId: string): ChannelUsage {
  return channelUsage.get(channelId) ?? { blobsServed: 0, bytesServed: 0, lastBalance: 0 };
}

// Update the last balance claimed by client (only if higher than current)
function updateChannelBalance(channelId: string, newBalance: number): void {
  const usage = getChannelUsage(channelId);
  if (newBalance > usage.lastBalance) {
    channelUsage.set(channelId, { ...usage, lastBalance: newBalance });
  }
}

// Record that a blob was served to a channel (call after response is sent)
function recordBlobServed(channelId: string, size: number): void {
  const usage = getChannelUsage(channelId);
  channelUsage.set(channelId, {
    ...usage,
    blobsServed: usage.blobsServed + 1,
    bytesServed: usage.bytesServed + size,
  });
  paymentLog("channel=%s served blob size=%d total: blobs=%d bytes=%d",
    channelId.substring(0, 8), size, usage.blobsServed + 1, usage.bytesServed + size);
}

// Get params for a channel (null if unknown)
function getChannelParams(channelId: string): string | null {
  return channelParams.get(channelId) ?? null;
}

// Store params for a channel (only if not already stored)
function storeChannelParams(channelId: string, paramsJson: string): void {
  if (!channelParams.has(channelId)) {
    channelParams.set(channelId, paramsJson);
    paymentLog("channel=%s params stored", channelId.substring(0, 8));
  }
}

// Get funding proofs for a channel (null if unknown)
function getChannelFundingProofs(channelId: string): string | null {
  return channelFundingProofs.get(channelId) ?? null;
}

// Store funding proofs for a channel (only if not already stored)
function storeChannelFundingProofs(channelId: string, fundingProofsJson: string): void {
  if (!channelFundingProofs.has(channelId)) {
    channelFundingProofs.set(channelId, fundingProofsJson);
    paymentLog("channel=%s funding proofs stored", channelId.substring(0, 8));
  }
}

router.get("/:hash", range, async (ctx, next) => {
  const paymentHeader = ctx.headers["x-cashu-channel"] as string | undefined;
  paymentLog("request path=%s hasPayment=%s", ctx.path, !!paymentHeader);
  if (paymentHeader) {
    paymentLog("X-Cashu-Channel: %s", paymentHeader);
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
    if (paymentHeader) {
      try {
        const payment = JSON.parse(paymentHeader);
        const usage = getChannelUsage(payment.channel_id);
        const hasParams = !!getChannelParams(payment.channel_id);
        const fundingProofsJson = getChannelFundingProofs(payment.channel_id);
        const numProofs = fundingProofsJson ? JSON.parse(fundingProofsJson).length : 0;
        paymentLog("channel=%s balance: %d -> %d (client) served: blobs=%d bytes=%d hasParams=%s proofs=%d",
          payment.channel_id?.substring(0, 8),
          usage.lastBalance,
          payment.balance,
          usage.blobsServed,
          usage.bytesServed,
          hasParams,
          numProofs
        );

        // Verify signature if we have params and funding proofs (either from header or cache)
        const paramsJsonForVerify = payment.params ? JSON.stringify(payment.params) : getChannelParams(payment.channel_id);
        const fundingProofsForVerify = payment.funding_proofs ? JSON.stringify(payment.funding_proofs) : getChannelFundingProofs(payment.channel_id);

        let signatureValid = false;
        if (paramsJsonForVerify && fundingProofsForVerify && config.channel?.secretKey) {
          try {
            const params = JSON.parse(paramsJsonForVerify);
            const sharedSecret = compute_shared_secret(config.channel.secretKey, params.alice_pubkey);
            signatureValid = verify_balance_update_signature(
              paramsJsonForVerify,
              sharedSecret,
              fundingProofsForVerify,
              payment.channel_id,
              BigInt(payment.balance),
              payment.signature
            );
            paymentLog("signature verify: %s", signatureValid ? "VALID" : "INVALID");
          } catch (e) {
            paymentLog("signature verify: ERROR - %s", (e as Error).message);
          }
        }

        // Verify channel_id and store params if provided
        if (payment.params && config.channel?.secretKey) {
          const paramsJson = JSON.stringify(payment.params);
          const alicePubkey = payment.params.alice_pubkey;
          const sharedSecret = compute_shared_secret(config.channel.secretKey, alicePubkey);
          const computedChannelId = channel_parameters_get_channel_id(paramsJson, sharedSecret);
          const channelIdMatch = computedChannelId === payment.channel_id;
          paymentLog("channel_id verify: computed=%s provided=%s match=%s",
            computedChannelId.substring(0, 8),
            payment.channel_id?.substring(0, 8),
            channelIdMatch ? "YES" : "NO"
          );

          // Update balance and store params/funding proofs if channel_id is valid
          if (channelIdMatch) {
            updateChannelBalance(payment.channel_id, payment.balance);
            storeChannelParams(payment.channel_id, paramsJson);
            if (payment.funding_proofs) {
              storeChannelFundingProofs(payment.channel_id, JSON.stringify(payment.funding_proofs));
            }
            // Record blob served after successful payment verification
            if (signatureValid) {
              recordBlobServed(payment.channel_id, storageResult.size);
            }
          }
        } else if (payment.channel_id && getChannelParams(payment.channel_id)) {
          // Params not in header, but we have them stored - update balance
          updateChannelBalance(payment.channel_id, payment.balance);
          // Record blob served after successful payment verification
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
