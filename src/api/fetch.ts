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
import { validatePaymentFields } from "../helpers/payment-validation.js";

const paymentLog = logger.extend("payments");

// Helper function to create and log 402 payment errors
// Every 402 response goes through this function for consistent logging
function paymentError(
  error: string,
  blobSize: number,
  extra?: Record<string, any>,
  bodyHint?: string  // optional extra text for body.reason
): PaymentError {
  const headerData = { error, size: blobSize, ...extra };
  paymentLog("402 %s", JSON.stringify(headerData));
  return {
    header: headerData,
    body: { error: "Payment required", reason: bodyHint ? `${error} - ${bodyHint}` : error, ...extra },
  };
}

// Result of payment validation
export interface PaymentError {
  header: Record<string, any>;  // JSON for X-Cashu-Channel header
  body: Record<string, any>;    // JSON for response body
}

interface ValidPayment {
  channelId: string;
  balance: number;
  signature: string;
  amountDue: number;
  capacity: number;
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
      return paymentError("server misconfigured", blobSize);
    }

    // Resolve keysetInfo early - needed for channel_id computation
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
      return paymentError("keyset not from approved mint", blobSize, { mint: mintUrl, keyset_id: keysetId });
    }

    const keysetInfoJson = JSON.stringify(keysetInfo);
    const sharedSecret = compute_shared_secret(config.channel.secretKey, alicePubkey);
    const computedChannelId = channel_parameters_get_channel_id(paramsJson, sharedSecret, keysetInfoJson);
    const channelIdMatch = computedChannelId === channelId;
    paymentLog("channel_id verify: computed=%s provided=%s match=%s",
      computedChannelId.substring(0, 8),
      channelId?.substring(0, 8),
      channelIdMatch ? "YES" : "NO"
    );

    if (!channelIdMatch) {
      return paymentError("channel_id mismatch", blobSize);
    }

    // Check capacity meets minimum requirement for this unit
    const unitPricing = config.channel.pricing[paramsObj.unit];
    const minCapacity = unitPricing?.minCapacity ?? 0;
    if (paramsObj.capacity < minCapacity) {
      return paymentError("capacity too small", blobSize, { capacity: paramsObj.capacity, min_capacity: minCapacity });
    }

    // Check locktime is far enough in the future
    const now = Math.floor(Date.now() / 1000);
    const minLocktime = now + config.channel.minExpiryInSeconds;
    if (paramsObj.locktime < minLocktime) {
      const secondsRemaining = paramsObj.locktime - now;
      return paymentError("locktime too soon", blobSize, {
        locktime: paramsObj.locktime,
        min_expiry_in_seconds: config.channel.minExpiryInSeconds,
        seconds_remaining: secondsRemaining,
      });
    }

    // Check maximum_amount doesn't exceed server's limit for this unit
    const maxAmountPerOutput = unitPricing?.maxAmountPerOutput ?? 0;
    if (maxAmountPerOutput > 0 && paramsObj.maximum_amount > maxAmountPerOutput) {
      return paymentError("max_amount_per_output exceeded", blobSize, {
        maximum_amount: paramsObj.maximum_amount,
        max_allowed: maxAmountPerOutput,
      });
    }

    // Run full channel verification (DLEQ, keyset ID match)
    try {
      const verificationResultJson = verify_channel(
        paramsJson,
        sharedSecret,
        fundingProofsJson,
        keysetInfoJson
      );
      const verificationResult = JSON.parse(verificationResultJson);
      paymentLog("channel validation: valid=%s errors=%d", verificationResult.valid, verificationResult.errors.length);

      if (!verificationResult.valid) {
        return paymentError("channel validation failed", blobSize, { validation_errors: verificationResult.errors });
      }
    } catch (e) {
      return paymentError("channel validation error", blobSize, { message: (e as Error).message });
    }

    // Channel funding is valid - cache it
    fundingStore.insert(channelId, {
      paramsJson,
      fundingProofsJson,
      sharedSecret,
      secretKey: config.channel.secretKey,
      keysetInfoJson,
    });
  }

  // Look up cached funding (either just inserted above, or from a previous request)
  const funding = fundingStore.get(channelId);
  if (!funding) {
    return paymentError("unknown channel", blobSize, {}, "provide params and funding_proofs");
  }

  // Check if channel has been closed
  if (channelClosed.isClosed(channelId)) {
    return paymentError("channel closed", blobSize, {}, "use a different channel");
  }

  // Parse params for validation checks
  const params = JSON.parse(funding.paramsJson);

  // Check balance doesn't exceed capacity
  if (balance > params.capacity) {
    return paymentError("balance exceeds capacity", blobSize, { capacity: params.capacity, balance });
  }

  // Verify signature
  let signatureValid = false;
  try {
    signatureValid = verify_balance_update_signature(
      funding.paramsJson,
      funding.sharedSecret,
      funding.fundingProofsJson,
      funding.keysetInfoJson,
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
    return paymentError("invalid signature", blobSize);
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
    return paymentError("missing", blobSize);
  }

  let payment: any;
  try {
    payment = JSON.parse(paymentHeader);
  } catch {
    return paymentError("invalid JSON", blobSize);
  }

  // Check required fields
  const fieldValidation = validatePaymentFields(payment);
  if (!fieldValidation.valid) {
    return paymentError(fieldValidation.error!, blobSize);
  }

  const { channelId, balance, signature } = fieldValidation.fields;

  // Validate channel funding (DLEQ) and signature
  const validationResult = validateChannelAndSignature(
    channelId,
    balance,
    signature,
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
    return paymentError("unsupported unit", blobSize, { unit });
  }

  // Get existing usage (defaults to zero for new channels)
  const usage = usageStore.get(payment.channel_id);
  const previousBlobs = usage?.blobsServed ?? 0;
  const previousBytes = usage?.bytesServed ?? 0;

  // Compute total due including this request
  const totalBlobs = previousBlobs + 1;
  const totalBytes = previousBytes + blobSize;
  const amountDue = calculateAmountDue(totalBlobs, totalBytes, pricing);

  if (payment.balance < amountDue) {
    return paymentError("insufficient balance", blobSize, {
      amount_due: amountDue,
      balance: payment.balance,
      total_blobs: totalBlobs,
      total_bytes: totalBytes,
      pricing: {
        per_request_ppk: pricing.perRequestPpk,
        per_megabyte_ppk: pricing.perMegabytePpk,
      },
    });
  }

  return {
    channelId: payment.channel_id,
    balance: payment.balance,
    signature: payment.signature,
    amountDue,
    capacity: params.capacity,
  };
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
// Channel Activity Store
// Tracks last successful payment timestamp per channel for active user counting
// ============================================================================

const channelActivityStore = new Map<string, number>(); // channel_id -> timestamp

export const channelActivity = {
  recordPayment(channelId: string): void {
    channelActivityStore.set(channelId, Date.now());
  },

  getActiveCount(windowSeconds: number): number {
    const cutoff = Date.now() - (windowSeconds * 1000);
    let count = 0;
    for (const timestamp of channelActivityStore.values()) {
      if (timestamp >= cutoff) count++;
    }
    return count;
  },

  cleanup(windowSeconds: number): void {
    const cutoff = Date.now() - (windowSeconds * 1000);
    for (const [channelId, timestamp] of channelActivityStore) {
      if (timestamp < cutoff) {
        channelActivityStore.delete(channelId);
      }
    }
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
  receiverProofsJson: string;  // Charlie's proofs (P2PK to his blinded pubkey)
  senderProofsJson: string;    // Alice's proofs (her change)
}

const channelClosedStore = new Map<string, ClosedChannelData>();

export const channelClosed = {
  isClosed(channelId: string): boolean {
    return channelClosedStore.has(channelId);
  },

  markClosed(
    channelId: string,
    locktime: number,
    closedAmount: number,
    valueAfterStage1: number,
    receiverProofsJson: string,
    senderProofsJson: string
  ): void {
    channelClosedStore.set(channelId, {
      locktime,
      closedAmount,
      valueAfterStage1,
      receiverProofsJson,
      senderProofsJson,
    });
    paymentLog("channelClosed: channel=%s locktime=%d closedAmount=%d valueAfterStage1=%d receiverProofs=%d senderProofs=%d",
      channelId.substring(0, 8), locktime, closedAmount, valueAfterStage1,
      JSON.parse(receiverProofsJson).length, JSON.parse(senderProofsJson).length);
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
      channelActivity.recordPayment(paymentResult.channelId);

      // Add payment confirmation header
      ctx.set("X-Cashu-Channel", JSON.stringify({
        channel_id: paymentResult.channelId,
        balance: paymentResult.balance,
        amount_due: paymentResult.amountDue,
        capacity: paymentResult.capacity,
        size: storageResult.size,
      }));
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
