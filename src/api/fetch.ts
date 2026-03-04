import { extname } from "node:path";
import { PassThrough } from "node:stream";
import dayjs from "dayjs";
import mime from "mime";
import HttpErrors from "http-errors";
import range from "koa-range";

import { config, channelConfig } from "../config.js";
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
import { WasmSpilmanBridge, decodePaymentHeader, mapErrorStatus, getBridgeErrorReason } from "cdk-spilman-kit";
import { spilmanHooks } from "./bridge-hooks.js";
import { getChannelStatus } from "./stores.js";
export { getChannelStatus } from "./stores.js";

const paymentLog = logger.extend("payments");

// Blossom-specific error extraction: enriches the kit's error parsing
// with regex-based extraction of numeric values from WASM bridge error messages
export function extractBridgeError(err: unknown): { errorMsg: string; status?: number; code?: string; extra?: Record<string, unknown> } {
  const reason = getBridgeErrorReason(err);
  const status = mapErrorStatus(err);
  return { errorMsg: reason, status };
}

let cachedBridge: WasmSpilmanBridge | null = null;
export function getBridge(): WasmSpilmanBridge {
  if (!cachedBridge) {
    cachedBridge = new WasmSpilmanBridge(spilmanHooks);
  }
  return cachedBridge;
}

router.get("/:hash", range, async (ctx, next) => {
  const paymentHeader = ctx.headers["x-cashu-channel"] as string | undefined;
  paymentLog("request path=%s hasPayment=%s", ctx.path, !!paymentHeader);

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

    // Validate payment via Bridge
    if (channelConfig?.enabled) {
      if (!paymentHeader) {
        ctx.status = 402;
        ctx.set("X-Cashu-Channel", JSON.stringify({ error: "missing", size: storageResult.size }));
        ctx.body = { error: "Payment required", reason: "missing", size: storageResult.size };
        return;
      }

      // Decode base64-encoded payment header
      let paymentJson: string;
      try {
        paymentJson = decodePaymentHeader(paymentHeader);
      } catch (e) {
        ctx.status = 400;
        ctx.set("X-Cashu-Channel", JSON.stringify({ error: "invalid base64", size: storageResult.size }));
        ctx.body = { error: "Invalid payment header", reason: "invalid base64 encoding" };
        return;
      }

      try {
        // processPayment now returns PaymentSuccess directly and throws on error
        const result = getBridge().processPayment(
          paymentJson,
          JSON.stringify({ blobs: 1, bytes: storageResult.size })
        );

        // Success - result IS the payment data: { channel_id, balance, amount_due, capacity }
        const header = {
          channel_id: result.channel_id,
          balance: result.balance,
          amount_due: result.amount_due,
          capacity: result.capacity,
          size: storageResult.size,
        };
        ctx.set("X-Cashu-Channel", JSON.stringify(header));
      } catch (e) {
        // Error is thrown - determine status from error message
        const { errorMsg, status: bridgeStatus, code, extra } = extractBridgeError(e);
        const lowerMsg = errorMsg.toLowerCase();

        // Determine HTTP status from error type
        // Most payment/validation errors are 402 (Payment Required)
        // Only structural/format errors are 400 (Bad Request)
        let status = typeof bridgeStatus === "number" ? bridgeStatus : 402; // Default to Payment Required
        if (bridgeStatus === undefined) {
          if (lowerMsg.includes("invalid base64") ||
              lowerMsg.includes("invalid utf8") ||
              lowerMsg.includes("invalid json") ||
              lowerMsg.includes("missing channel_id") ||
              lowerMsg.includes("missing signature") ||
              lowerMsg.includes("missing balance") ||
              // Serde deserialization errors for missing fields: "missing field `channel_id`"
              lowerMsg.includes("missing field") ||
              // Serde deserialization errors for wrong types
              lowerMsg.includes("invalid type") ||
              (lowerMsg.includes("expected") && (lowerMsg.includes("string") || lowerMsg.includes("integer") || lowerMsg.includes("u64")))) {
            status = 400; // Bad Request for malformed request
          } else if (lowerMsg.includes("internal") || lowerMsg.includes("misconfigured")) {
            status = 500; // Server Error
          }
        } else if (code) {
          const paymentRequiredCodes = new Set(["unknown_channel", "channel_closed", "channel_closing"]);
          if (paymentRequiredCodes.has(code)) {
            status = 402;
          }
        }

        if (
          status !== 402 &&
          (lowerMsg.includes("unknown channel") || lowerMsg.includes("channel closed") || lowerMsg.includes("channel closing"))
        ) {
          status = 402;
        }

        // Parse extra fields from error message for client use
        const headerData: Record<string, any> = { error: errorMsg, size: storageResult.size };
        if (code) headerData.code = code;
        if (extra && typeof extra === "object") {
          for (const [key, value] of Object.entries(extra)) {
            if (headerData[key] === undefined) headerData[key] = value;
          }
        }

        // Extract balance/capacity from "balance exceeds capacity: X > Y"
        const balanceCapacityMatch = errorMsg.match(/balance exceeds capacity: (\d+) > (\d+)/);
        if (balanceCapacityMatch) {
          headerData.balance = parseInt(balanceCapacityMatch[1]);
          headerData.capacity = parseInt(balanceCapacityMatch[2]);
        }

        // Extract balance/amount_due from "insufficient balance: X < Y"
        const insufficientMatch = errorMsg.match(/insufficient balance: (\d+) < (\d+)/);
        if (insufficientMatch) {
          headerData.balance = parseInt(insufficientMatch[1]);
          headerData.amount_due = parseInt(insufficientMatch[2]);
        }

        // Extract capacity/min_capacity from "capacity too small: X < Y"
        const capacityMatch = errorMsg.match(/capacity too small: (\d+) < (\d+)/);
        if (capacityMatch) {
          headerData.capacity = parseInt(capacityMatch[1]);
          headerData.min_capacity = parseInt(capacityMatch[2]);
        }

        // Extract locktime info from "locktime too soon: X < Y (Zs remaining)"
        const locktimeMatch = errorMsg.match(/locktime too soon: (\d+) < (\d+) \((\d+)s remaining\)/);
        if (locktimeMatch) {
          const locktime = parseInt(locktimeMatch[1]);
          const minLocktime = parseInt(locktimeMatch[2]);
          const secondsRemaining = parseInt(locktimeMatch[3]);
          headerData.locktime = locktime;
          headerData.min_locktime = minLocktime;
          // min_expiry_in_seconds = min_locktime - now, where now = locktime - seconds_remaining
          headerData.min_expiry_in_seconds = minLocktime - locktime + secondsRemaining;
          headerData.seconds_remaining = secondsRemaining;
        }

        // Extract max_amount info from "max_amount_per_output exceeded: X > Y"
        const maxAmountMatch = errorMsg.match(/max_amount_per_output exceeded: (\d+) > (\d+)/);
        if (maxAmountMatch) {
          headerData.maximum_amount = parseInt(maxAmountMatch[1]);
          headerData.max_allowed = parseInt(maxAmountMatch[2]);
        }

        // Extract validation_errors from "channel validation failed: [...]"
        const validationMatch = errorMsg.match(/channel validation failed: (\[.*\])/);
        if (validationMatch) {
          try {
            headerData.validation_errors = JSON.parse(validationMatch[1]);
          } catch {
            // Ignore parse errors
          }
        }

        ctx.status = status;
        ctx.set("X-Cashu-Channel", JSON.stringify(headerData));
        ctx.body = { error: "Payment failed", reason: errorMsg };
        paymentLog("%s %s", status, errorMsg);
        return;
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
