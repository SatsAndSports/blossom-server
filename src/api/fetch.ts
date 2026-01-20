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
import { WasmSpilmanBridge } from "../wasm/cdk_wasm.js";
import { getKeysetKeys } from "./channel.js";
import { spilmanHooks } from "./bridge-hooks.js";
import { 
  channelFunding, 
  channelBalance, 
  channelUsage, 
  channelActivity, 
  channelClosed, 
  calculateAmountDue,
  ChannelStatus
} from "./stores.js";

const paymentLog = logger.extend("payments");

export const bridge = new WasmSpilmanBridge(spilmanHooks, config.channel.secretKey);

// ============================================================================
// Exported getters for channel status endpoint
// ============================================================================

export function getChannelStatus(channelId: string): ChannelStatus {
  const funding = channelFunding.get(channelId);
  if (!funding) {
    throw new Error("unknown channel");
  }

  const params = JSON.parse(funding.paramsJson);
  const balance = channelBalance.get(channelId);
  const usage = channelUsage.get(channelId);

  const blobsServed = usage?.blobsServed ?? 0;
  const bytesServed = usage?.bytesServed ?? 0;

  // Get pricing for this channel's unit
  const unit = params.unit;
  const pricing = config.channel.pricing[unit];
  if (!pricing) {
    throw new Error(`No pricing configured for unit: ${unit}`);
  }

  const amountDue = calculateAmountDue(blobsServed, bytesServed, pricing);

  const closedData = channelClosed.get(channelId);

  return {
    channel_id: channelId,
    capacity: params.capacity,
    balance: balance?.balance ?? 0,
    blobs_served: blobsServed,
    bytes_served: bytesServed,
    amount_due: amountDue,
    closed: closedData !== null,
    ...(closedData && { closed_amount: closedData.closedAmount }),
  };
}

// Resolve full keysetInfo from startup cache
export function getKeysetInfoJson(
  mintUrl: string,
  keysetId: string,
  unit: string,
  inputFeePpk: number
): string | null {
  const cachedKeys = getKeysetKeys(mintUrl, keysetId);

  if (cachedKeys) {
    return JSON.stringify({
      keysetId,
      unit,
      keys: cachedKeys,
      inputFeePpk,
      amounts: Object.keys(cachedKeys).map(Number).sort((a, b) => b - a),
    });
  }

  return null;
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
    if (config.channel?.enabled) {
      if (!paymentHeader) {
        ctx.status = 402;
        ctx.set("X-Cashu-Channel", JSON.stringify({ error: "missing", size: storageResult.size }));
        ctx.body = { error: "Payment required", reason: "missing", size: storageResult.size };
        return;
      }

      let keysetInfo: string | null = null;
      try {
        const payment = JSON.parse(paymentHeader);
        if (payment.params) {
          keysetInfo = getKeysetInfoJson(
            payment.params.mint,
            payment.params.keyset_id,
            payment.params.unit,
            payment.params.input_fee_ppk || 0
          );
        }

        const bridgeResultJson = bridge.processPayment(
          paymentHeader,
          JSON.stringify({ type: "blob", size: storageResult.size }),
          keysetInfo
        );
        const result = JSON.parse(bridgeResultJson);

        if (!result.success) {
          ctx.status = 402; // or result.code
          if (result.header) {
            // Add size to header for client-side tracking
            result.header.size = storageResult.size;
            ctx.set("X-Cashu-Channel", JSON.stringify(result.header));
          }
          ctx.body = result.body;
          paymentLog("402 %s", JSON.stringify(result.header));
          return;
        }

        // Success - update confirmation header with size
        if (result.header) {
          result.header.size = storageResult.size;
          ctx.set("X-Cashu-Channel", JSON.stringify(result.header));
        }
      } catch (e) {
        ctx.status = 400;
        ctx.body = { error: "Invalid payment header", reason: (e as Error).message };
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
