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

// Result of payment validation
export interface PaymentError {
  header: Record<string, any>;  // JSON for X-Cashu-Channel header
  body: Record<string, any>;    // JSON for response body
}

interface ValidPayment {
  channelId: string;
  balance: number;
  signature: string;
}

// Result of core channel validation (without blob-specific checks)
export interface ValidatedChannel {
  funding: ChannelFundingData;
  params: any;  // parsed from funding.paramsJson
}

function isPaymentError(result: PaymentError | ValidPayment | null): result is PaymentError {
  return result !== null && 'header' in result;
}

export function isValidatedChannel(result: ValidatedChannel | PaymentError): result is ValidatedChannel {
  return 'funding' in result;
}

// Data types for channel stores
export interface ChannelFundingData {
  paramsJson: string;
  fundingProofsJson: string;
  sharedSecret: string;
  secretKey: string;  // Server's secret key used for this channel
  keysetInfoJson: string;  // Complete keyset info (keysetId, unit, keys, inputFeePpk, amounts)
}

interface ChannelUsage {
  blobsServed: number;
  bytesServed: number;
}

// Store interfaces for dependency injection
interface FundingStore {
  get(channelId: string): ChannelFundingData | null;
  insert(channelId: string, data: ChannelFundingData): void;
}

interface UsageStore {
  get(channelId: string): ChannelUsage | null;
}

// Calculate amount due based on usage and pricing
// Used by validatePayment() and getChannelStatus()
export function calculateAmountDue(
  blobsServed: number,
  bytesServed: number,
  pricing: { perRequestPpk: number; perMegabytePpk: number }
): number {
  const megabytes = bytesServed / 1_000_000;
  return Math.ceil(
    (blobsServed * pricing.perRequestPpk + megabytes * pricing.perMegabytePpk) / 1000
  );
}

// Resolve full keysetInfo from startup cache or channel funding cache
// Returns null if keyset is not available from either source
function getFullKeysetInfo(
  mintUrl: string,
  keysetId: string,
  unit: string,
  inputFeePpk: number,
  channelId: string,
  fundingStore: FundingStore
): any | null {
  const cachedKeys = getKeysetKeys(mintUrl, keysetId);

  if (cachedKeys) {
    // Build from startup cache
    return {
      keysetId,
      unit,
      keys: cachedKeys,
      inputFeePpk,
      amounts: Object.keys(cachedKeys).map(Number).sort((a, b) => b - a),
    };
  }

  // Keyset rotated out - try channel funding cache
  const existingFunding = fundingStore.get(channelId);
  if (existingFunding) {
    paymentLog("Using cached keysetInfo for rotated keyset %s", keysetId);
    return JSON.parse(existingFunding.keysetInfoJson);
  }

  return null;
}

// Core channel validation: verify funding (DLEQ) and signature
// Used by validatePayment() and channel close endpoint
// Does NOT check blob-specific things like usage or amount_due
export function validateChannelAndSignature(
  channelId: string,
  balance: number,
  signature: string,
  paramsObj: any | undefined,
  fundingProofsObj: any | undefined,
  blobSize: number,  // for error responses
  fundingStore: FundingStore
): ValidatedChannel | PaymentError {
  // If params and funding proofs are provided, validate and cache them
  // (clients may include these on any request, not just the first)
  if (paramsObj && fundingProofsObj) {
    const paramsJson = JSON.stringify(paramsObj);
    const fundingProofsJson = JSON.stringify(fundingProofsObj);
    const alicePubkey = paramsObj.alice_pubkey;

    if (!config.channel.secretKey) {
      return {
        header: { error: "server misconfigured", size: blobSize },
        body: { error: "Payment required", reason: "server misconfigured" },
      };
    }

    const sharedSecret = compute_shared_secret(config.channel.secretKey, alicePubkey);
    const computedChannelId = channel_parameters_get_channel_id(paramsJson, sharedSecret);
    const channelIdMatch = computedChannelId === channelId;
    paymentLog("channel_id verify: computed=%s provided=%s match=%s",
      computedChannelId.substring(0, 8),
      channelId?.substring(0, 8),
      channelIdMatch ? "YES" : "NO"
    );

    if (!channelIdMatch) {
      return {
        header: { error: "channel_id mismatch", size: blobSize },
        body: { error: "Payment required", reason: "channel_id mismatch" },
      };
    }

    // Resolve keysetInfo from startup cache or channel funding cache
    const mintUrl = paramsObj.mint;
    const keysetId = paramsObj.keyset_id;
    const keysetInfo = getFullKeysetInfo(
      mintUrl,
      keysetId,
      paramsObj.unit,
      paramsObj.input_fee_ppk || 0,
      channelId,
      fundingStore
    );

    if (!keysetInfo) {
      paymentLog("channel validation FAILED: keyset %s not from approved mint %s", keysetId, mintUrl);
      return {
        header: { error: "keyset not from approved mint", size: blobSize, mint: mintUrl, keyset_id: keysetId },
        body: { error: "Payment required", reason: "keyset not from approved mint" },
      };
    }

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

    // Channel funding is valid - cache it
    fundingStore.insert(channelId, {
      paramsJson,
      fundingProofsJson,
      sharedSecret,
      secretKey: config.channel.secretKey,
      keysetInfoJson: JSON.stringify(keysetInfo),
    });
  }

  // Look up cached funding (either just inserted above, or from a previous request)
  const funding = fundingStore.get(channelId);
  if (!funding) {
    return {
      header: { error: "unknown channel", size: blobSize },
      body: { error: "Payment required", reason: "unknown channel - provide params and funding_proofs" },
    };
  }

  // Check if channel has been closed
  if (channelClosed.isClosed(channelId)) {
    paymentLog("channel %s is closed, rejecting payment", channelId.substring(0, 8));
    return {
      header: { error: "channel closed", size: blobSize },
      body: { error: "Payment required", reason: "channel closed - use a different channel" },
    };
  }

  // Parse params for validation checks
  const params = JSON.parse(funding.paramsJson);

  // Check balance doesn't exceed capacity
  if (balance > params.capacity) {
    return {
      header: { error: "balance exceeds capacity", size: blobSize, capacity: params.capacity, balance: balance },
      body: { error: "Payment required", reason: "balance exceeds capacity", capacity: params.capacity },
    };
  }

  // Verify signature
  let signatureValid = false;
  try {
    signatureValid = verify_balance_update_signature(
      funding.paramsJson,
      funding.sharedSecret,
      funding.fundingProofsJson,
      channelId,
      BigInt(balance),
      signature
    );
    paymentLog("signature verify: %s", signatureValid ? "VALID" : "INVALID");
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    paymentLog("signature verify: ERROR - %s", errMsg);
  }

  if (!signatureValid) {
    return {
      header: { error: "invalid signature", size: blobSize },
      body: { error: "Payment required", reason: "invalid signature" },
    };
  }

  return { funding, params };
}

// Validate a payment and return error info if invalid, or valid payment info if successful
// Returns null if payments are not required
function validatePayment(
  paymentHeader: string | undefined,
  blobSize: number,
  fundingStore: FundingStore,
  usageStore: UsageStore
): PaymentError | ValidPayment | null {
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
  if (typeof payment.channel_id !== "string" || !payment.channel_id) {
    return {
      header: { error: "invalid or missing channel_id", size: blobSize },
      body: { error: "Payment required", reason: "invalid or missing channel_id" },
    };
  }
  if (typeof payment.balance !== "number" || Number.isNaN(payment.balance)) {
    return {
      header: { error: "invalid or missing balance", size: blobSize },
      body: { error: "Payment required", reason: "invalid or missing balance" },
    };
  }
  if (typeof payment.signature !== "string" || !payment.signature) {
    return {
      header: { error: "invalid or missing signature", size: blobSize },
      body: { error: "Payment required", reason: "invalid or missing signature" },
    };
  }

  // Validate channel funding (DLEQ) and signature
  const validationResult = validateChannelAndSignature(
    payment.channel_id,
    payment.balance,
    payment.signature,
    payment.params,
    payment.funding_proofs,
    blobSize,
    fundingStore
  );

  if (!isValidatedChannel(validationResult)) {
    return validationResult;  // Return the PaymentError
  }

  const { params } = validationResult;

  // Check balance covers usage + this request
  const unit = params.unit;
  const pricing = config.channel.pricing[unit];
  if (!pricing) {
    paymentLog("no pricing for unit=%s", unit);
    return {
      header: { error: "unsupported unit", size: blobSize, unit },
      body: { error: "Payment required", reason: "unsupported unit" },
    };
  }

  // Get existing usage (defaults to zero for new channels)
  const usage = usageStore.get(payment.channel_id);
  const previousBlobs = usage?.blobsServed ?? 0;
  const previousBytes = usage?.bytesServed ?? 0;

  // Compute total due including this request
  const totalBlobs = previousBlobs + 1;
  const totalBytes = previousBytes + blobSize;
  const amountDue = calculateAmountDue(totalBlobs, totalBytes, pricing);

  paymentLog("channel=%s usage: blobs=%d bytes=%d amountDue=%d balance=%d",
    payment.channel_id.substring(0, 8), totalBlobs, totalBytes, amountDue, payment.balance);

  if (payment.balance < amountDue) {
    return {
      header: {
        error: "insufficient balance",
        size: blobSize,
        amount_due: amountDue,
        balance: payment.balance,
        // Debug info: usage and pricing
        total_blobs: totalBlobs,
        total_bytes: totalBytes,
        pricing: {
          per_request_ppk: pricing.perRequestPpk,
          per_megabyte_ppk: pricing.perMegabytePpk,
        },
      },
      body: {
        error: "Payment required",
        reason: "insufficient balance",
        amount_due: amountDue,
        total_blobs: totalBlobs,
        total_bytes: totalBytes,
        pricing: {
          per_request_ppk: pricing.perRequestPpk,
          per_megabyte_ppk: pricing.perMegabytePpk,
        },
      },
    };
  }

  return { channelId: payment.channel_id, balance: payment.balance, signature: payment.signature };
}

// ============================================================================
// Channel Funding Store
// Immutable data about a channel that has been validated (DLEQ verified, etc.)
// This is stored separately so we can skip re-validation for known channels.
// ============================================================================

const channelFundingStore = new Map<string, ChannelFundingData>();

export const channelFunding = {
  get(channelId: string): ChannelFundingData | null {
    return channelFundingStore.get(channelId) ?? null;
  },

  insert(channelId: string, data: ChannelFundingData): void {
    if (!channelFundingStore.has(channelId)) {
      channelFundingStore.set(channelId, data);
      paymentLog("channelFunding: inserted channel=%s", channelId.substring(0, 8));
    }
  },
};

// ============================================================================
// Channel Balance Store
// Tracks the last known balance and signature for each channel
// ============================================================================

interface ChannelBalance {
  balance: number;
  signature: string;
}

const channelBalanceStore = new Map<string, ChannelBalance>();

const channelBalance = {
  get(channelId: string): ChannelBalance | null {
    return channelBalanceStore.get(channelId) ?? null;
  },

  update(channelId: string, balance: number, signature: string): void {
    const current = channelBalanceStore.get(channelId);
    if (!current || balance > current.balance) {
      channelBalanceStore.set(channelId, { balance, signature });
      paymentLog("channel=%s balance updated: %d -> %d",
        channelId.substring(0, 8), current?.balance ?? 0, balance);
    }
  },
};

// ============================================================================
// Channel Usage Store
// Tracks blobs and bytes served per channel (for analytics/logging)
// ============================================================================

const channelUsageStore = new Map<string, ChannelUsage>();

export const channelUsage = {
  get(channelId: string): ChannelUsage | null {
    return channelUsageStore.get(channelId) ?? null;
  },

  recordBlobServed(channelId: string, size: number): void {
    let usage = channelUsageStore.get(channelId);
    if (!usage) {
      usage = { blobsServed: 0, bytesServed: 0 };
      channelUsageStore.set(channelId, usage);
    }
    usage.blobsServed += 1;
    usage.bytesServed += size;
    paymentLog("channel=%s served blob size=%d total: blobs=%d bytes=%d",
      channelId.substring(0, 8), size, usage.blobsServed, usage.bytesServed);
  },
};

// ============================================================================
// Closed Channels Store
// Tracks channels that have been closed. We need to reject payments on closed
// channels to prevent Alice from re-using a channel after Charlie redeemed it.
// ============================================================================

interface ClosedChannelData {
  locktime: number;
  closedAmount: number;
  valueAfterStage1: number;
}

const channelClosedStore = new Map<string, ClosedChannelData>();

export const channelClosed = {
  isClosed(channelId: string): boolean {
    return channelClosedStore.has(channelId);
  },

  markClosed(channelId: string, locktime: number, closedAmount: number, valueAfterStage1: number): void {
    channelClosedStore.set(channelId, { locktime, closedAmount, valueAfterStage1 });
    paymentLog("channelClosed: channel=%s locktime=%d closedAmount=%d valueAfterStage1=%d",
      channelId.substring(0, 8), locktime, closedAmount, valueAfterStage1);
  },

  get(channelId: string): ClosedChannelData | null {
    return channelClosedStore.get(channelId) ?? null;
  },
};

// ============================================================================
// Exported getters for channel status endpoint
// ============================================================================

export interface ChannelStatus {
  channel_id: string;
  capacity: number;
  balance: number;
  blobs_served: number;
  bytes_served: number;
  amount_due: number;
  closed: boolean;
  closed_amount?: number;
}

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
    const paymentResult = validatePayment(paymentHeader, storageResult.size, channelFunding, channelUsage);
    if (isPaymentError(paymentResult)) {
      ctx.status = 402;
      ctx.set("X-Cashu-Channel", JSON.stringify(paymentResult.header));
      ctx.body = paymentResult.body;
      return;
    }

    // Update stores if payment was validated
    if (paymentResult) {
      channelBalance.update(paymentResult.channelId, paymentResult.balance, paymentResult.signature);
      channelUsage.recordBlobServed(paymentResult.channelId, storageResult.size);
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
