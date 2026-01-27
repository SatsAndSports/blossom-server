import * as secp from "@noble/secp256k1";
import { koaBody } from "koa-body";
import { config } from "../config.js";
import { router } from "./router.js";
import logger from "../logger.js";
import {
  getChannelStatus,
  bridge,
  getKeysetInfoJson,
} from "./fetch.js";
import {
  calculateAmountDue,
  channelFunding,
  channelUsage,
  channelClosed,
  channelActivity,
  KeysetWithKeys,
  mintsUnitsKeysets,
  MintsUnitsKeysets,
} from "./stores.js";
import { unblind_and_verify_dleq } from "../wasm/cdk_wasm.js";
import { spilmanHooks } from "./bridge-hooks.js";

const log = logger.extend("channel-mint-setup");

// Type for keyset info from mint's /v1/keysets endpoint
interface MintKeyset {
  id: string;
  unit: string;
  active: boolean;
  input_fee_ppk?: number;
}

// Derive compressed public key (33 bytes) from secret key
export function getReceiverPubkey(): string {
  const secretHex = config.channel.secretKey;
  if (!secretHex) {
    throw new Error("Channel secretKey not configured");
  }
  const secretBytes = Buffer.from(secretHex, "hex");
  const pubkeyBytes = secp.getPublicKey(secretBytes, true); // true = compressed
  return Buffer.from(pubkeyBytes).toString("hex");
}

// Fetch full keys for a specific keyset
async function fetchKeysForKeyset(mintUrl: string, keysetId: string): Promise<Record<string, string> | null> {
  const url = `${mintUrl}/v1/keys/${keysetId}`;
  log(`GET ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      log(`Failed to fetch keys for ${keysetId}: ${response.status}`);
      return null;
    }

    const data = await response.json() as { keysets: Array<{ id: string; unit: string; keys: Record<string, string> }> };
    const keyset = data.keysets?.find(k => k.id === keysetId);
    if (!keyset) {
      log(`Keyset ${keysetId} not found in response`);
      return null;
    }

    log(`Fetched ${Object.keys(keyset.keys).length} keys for keyset ${keysetId}`);
    return keyset.keys;
  } catch (e) {
    log(`Error fetching keys for ${keysetId}: ${e}`);
    return null;
  }
}

// Fetch keysets from a mint for specific units (including full keys)
async function fetchKeysetsFromMint(mintUrl: string, units: string[]): Promise<Record<string, KeysetWithKeys[]>> {
  const url = `${mintUrl}/v1/keysets`;
  log(`GET ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      log(`Failed: ${response.status}`);
      return {};
    }

    const data = await response.json() as { keysets: MintKeyset[] };
    log(`Mint returned ${data.keysets?.length ?? 0} keysets`);

    for (const k of data.keysets || []) {
      log(`  keyset: id=${k.id} unit=${k.unit} active=${k.active}`);
    }

    const result: Record<string, KeysetWithKeys[]> = {};

    for (const unit of units) {
      const keysetInfos = data.keysets.filter(k => k.unit === unit);
      log(`Filtering for unit="${unit}": found ${keysetInfos.length} keysets`);

      if (keysetInfos.length > 0) {
        const unitKeysets: KeysetWithKeys[] = [];

        for (const keysetInfo of keysetInfos) {
          const keys = await fetchKeysForKeyset(mintUrl, keysetInfo.id);
          if (keys) {
            unitKeysets.push({
              id: keysetInfo.id,
              keys,
              active: keysetInfo.active,
              input_fee_ppk: keysetInfo.input_fee_ppk ?? 0,
            });
          }
        }

        if (unitKeysets.length > 0) {
          result[unit] = unitKeysets;
        }
      }
    }

    return result;
  } catch (e) {
    log(`Error fetching from ${mintUrl}: ${e}`);
    return {};
  }
}

// Initialize keysets from all configured mints
export async function initializeChannelKeysets(): Promise<void> {
  if (!config.channel.enabled) {
    return;
  }

  const approvedMintsAndUnits = config.channel.approvedMintsAndUnits || {};
  log("approvedMintsAndUnits: %O", approvedMintsAndUnits);

  for (const [mintUrl, units] of Object.entries(approvedMintsAndUnits)) {
    log(`Fetching keysets from ${mintUrl} for units: ${units.join(", ")}`);
    const keysets = await fetchKeysetsFromMint(mintUrl, units);

    if (Object.keys(keysets).length > 0) {
      mintsUnitsKeysets[mintUrl] = keysets;
      for (const [unit, keysetsForUnit] of Object.entries(keysets)) {
        const ids = keysetsForUnit.map(k => k.id);
        const keyCount = keysetsForUnit.reduce((sum, k) => sum + Object.keys(k.keys).length, 0);
        log(`  ${unit}: ${ids.join(", ")} (${keyCount} keys total)`);
      }
    } else {
      log(`  No keysets found`);
    }
  }

  log("Keyset initialization complete");
}

// Refresh keysets for a specific mint (called when a swap fails, possibly due to stale keyset data)
export async function refreshKeysetsForMint(mintUrl: string): Promise<void> {
  const approvedMintsAndUnits = config.channel.approvedMintsAndUnits || {};
  const units = approvedMintsAndUnits[mintUrl];

  if (!units) {
    log(`refreshKeysetsForMint: ${mintUrl} not in approved mints list`);
    return;
  }

  log(`Refreshing keysets from ${mintUrl} for units: ${units.join(", ")}`);
  const keysets = await fetchKeysetsFromMint(mintUrl, units);

  if (Object.keys(keysets).length > 0) {
    mintsUnitsKeysets[mintUrl] = keysets;
    for (const [unit, keysetsForUnit] of Object.entries(keysets)) {
      const ids = keysetsForUnit.map(k => k.id);
      const keyCount = keysetsForUnit.reduce((sum, k) => sum + Object.keys(k.keys).length, 0);
      log(`  ${unit}: ${ids.join(", ")} (${keyCount} keys total)`);
    }
  } else {
    log(`  No keysets found during refresh`);
  }
}

// Get keys for a specific keyset (for payment verification)
export function getKeysetKeys(mintUrl: string, keysetId: string): Record<string, string> | null {
  const mintData = mintsUnitsKeysets[mintUrl];
  if (!mintData) return null;

  for (const keysetsForUnit of Object.values(mintData)) {
    const keyset = keysetsForUnit.find(k => k.id === keysetId);
    if (keyset) return keyset.keys;
  }
  return null;
}

router.get("/channel/params", async (ctx) => {
  if (!config.channel.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const receiverPubkey = getReceiverPubkey();

  // Transform internal format to API format (just keyset IDs, not full keys)
  const mintsUnitsKeysetIds: Record<string, Record<string, string[]>> = {};
  for (const [mintUrl, unitsData] of Object.entries(mintsUnitsKeysets)) {
    mintsUnitsKeysetIds[mintUrl] = {};
    for (const [unit, keysets] of Object.entries(unitsData)) {
      mintsUnitsKeysetIds[mintUrl][unit] = keysets.map(k => k.id);
    }
  }

  ctx.body = {
    receiver_pubkey: receiverPubkey,
    pricing: config.channel.pricing,
    mints_units_keysets: mintsUnitsKeysetIds,
    min_expiry_in_seconds: config.channel.minExpiryInSeconds,
  };
});

router.get("/channel/:channel_id/status", async (ctx) => {
  if (!config.channel.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const channelId = ctx.params.channel_id;

  try {
    const status = getChannelStatus(channelId);
    ctx.body = status;
  } catch (e) {
    const message = (e as Error).message;
    if (message === "unknown channel") {
      ctx.status = 404;
      ctx.body = { error: "unknown channel" };
    } else {
      ctx.status = 500;
      ctx.body = { error: message };
    }
  }
});

const closeLog = logger.extend("channel-close");

// Channel closing endpoint
router.post("/channel/:channel_id/close", koaBody(), async (ctx) => {
  if (!config.channel?.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const channelId = ctx.params.channel_id;
  const body = ctx.request.body as any;

  // Copy channel_id from URL params so we can use shared validation
  body.channel_id = channelId;

  const { balance, signature } = body;
  if (balance === undefined || !signature) {
    ctx.status = 400;
    ctx.body = { error: "missing balance or signature" };
    return;
  }

  closeLog("Close request for channel=%s balance=%d", channelId.substring(0, 8), balance);

  // Check if channel is already closed FIRST (for idempotent closing)
  const closedData = channelClosed.get(channelId);
  if (closedData !== null) {
    if (balance === closedData.closedAmount) {
      // Idempotent close - same amount, return success with cached sender proofs
      closeLog("Channel already closed with same amount: channel=%s amount=%d",
        channelId.substring(0, 8), closedData.closedAmount);
      ctx.status = 200;
      ctx.body = {
        success: true,
        channel_id: channelId,
        total_value: closedData.valueAfterStage1,
        sender_proofs: JSON.parse(closedData.senderProofsJson),
        already_closed: true,
      };
      return;
    } else {
      // Different amount - reject
      closeLog("Channel already closed with different amount: channel=%s closed=%d requested=%d",
        channelId.substring(0, 8), closedData.closedAmount, balance);
      ctx.status = 400;
      ctx.body = {
        error: "channel already closed with a different amount",
        closed_amount: closedData.closedAmount,
        requested_amount: balance,
      };
      return;
    }
  }

  // Use bridge.validateAndPrepareCooperativeClose() to validate signature and get fully-signed swap request
  // This also saves unknown channels to the funding store
  const closeResultJson = bridge.validateAndPrepareCooperativeClose(JSON.stringify(body));
  const closeResult = JSON.parse(closeResultJson);

  if (!closeResult.success) {
    closeLog("Close validation failed: %s", closeResult.error);
    ctx.status = 402;
    ctx.set("X-Cashu-Channel", closeResultJson);
    ctx.body = { ...closeResult, error: "Payment required", reason: closeResult.error };
    return;
  }

  // Get funding after validation (in case it was just saved)
  const fundingAfterValidation = channelFunding.get(channelId)!;
  const channelParams = JSON.parse(fundingAfterValidation.paramsJson);

  const swapRequestJson = JSON.stringify(closeResult.swap_request);
  const expectedTotal = closeResult.expected_total;
  const secretsWithBlinding = closeResult.secrets_with_blinding;
  const outputKeysetInfoJson = JSON.stringify(closeResult.output_keyset_info);
  closeLog("Swap request created, expected_total=%d, secrets=%d", expectedTotal, secretsWithBlinding.length);

  // Submit swap to mint via host hook
  const mintUrl = channelParams.mint;
  let swapResponse: any;
  try {
    closeLog("Submitting swap to mint via hook: %s", mintUrl);
    const swapResponseText = await spilmanHooks.callMintSwap(mintUrl, swapRequestJson);
    swapResponse = JSON.parse(swapResponseText);
    
    // Check if the hook returned an error
    if (swapResponse.error) {
      closeLog("Mint swap hook returned error: %s", swapResponse.error);
      ctx.status = 502;
      ctx.body = { error: "mint rejected swap", mint_error: swapResponse.error };
      return;
    }
    closeLog("Swap response received: %d signatures", swapResponse.signatures?.length ?? 0);
  } catch (e) {
    closeLog("Failed to contact mint: %s", (e as Error).message);
    ctx.status = 502;
    ctx.body = { error: "failed to contact mint", reason: (e as Error).message };
    return;
  }

  // Unblind signatures and verify DLEQ proofs
  let unblindResult: {
    receiver_proofs: any[];
    sender_proofs: any[];
    receiver_sum_after_stage1: number;
    sender_sum_after_stage1: number;
  };
  try {
    unblindResult = JSON.parse(unblind_and_verify_dleq(
      JSON.stringify(swapResponse.signatures || []),
      JSON.stringify(secretsWithBlinding),
      fundingAfterValidation.paramsJson,
      fundingAfterValidation.keysetInfoJson,
      fundingAfterValidation.sharedSecret,
      BigInt(balance),
      outputKeysetInfoJson
    ));
    closeLog(
      "Unblinded and DLEQ verified: receiver=%d proofs (%d nominal), sender=%d proofs (%d nominal)",
      unblindResult.receiver_proofs.length,
      unblindResult.receiver_sum_after_stage1,
      unblindResult.sender_proofs.length,
      unblindResult.sender_sum_after_stage1
    );
  } catch (e) {
    closeLog("Unblind/DLEQ verification failed: %s", (e as Error).message || e);
    ctx.status = 500;
    ctx.body = { error: "unblind verification failed", reason: String(e) };
    return;
  }

  // Verify total matches expected
  const actualTotal = unblindResult.receiver_sum_after_stage1 + unblindResult.sender_sum_after_stage1;
  if (actualTotal !== expectedTotal) {
    closeLog("Total mismatch: expected=%d actual=%d", expectedTotal, actualTotal);
    ctx.status = 500;
    ctx.body = {
      error: "swap response total mismatch",
      expected: expectedTotal,
      actual: actualTotal,
    };
    return;
  }

  closeLog("Channel closed successfully: channel=%s total_value=%d", channelId.substring(0, 8), actualTotal);

  // Stringify proofs for storage
  const receiverProofsJson = JSON.stringify(unblindResult.receiver_proofs);
  const senderProofsJson = JSON.stringify(unblindResult.sender_proofs);

  // Mark channel as closed via host hook (prevents reuse until locktime expires)
  spilmanHooks.markChannelClosed(
    channelId,
    channelParams.locktime,
    balance,
    receiverProofsJson,
    senderProofsJson,
    unblindResult.receiver_sum_after_stage1,
    unblindResult.sender_sum_after_stage1
  );

  // Success - return sender proofs so Alice can claim her change
  ctx.status = 200;
  ctx.body = {
    success: true,
    channel_id: channelId,
    total_value: actualTotal,
    sender_proofs: unblindResult.sender_proofs,
    already_closed: false,
  };
});

router.get("/channel/stats", async (ctx) => {
  if (!config.channel?.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const windowSeconds = parseInt(ctx.query.window as string) || 300; // default 5 min
  ctx.body = {
    active_channels: channelActivity.getActiveCount(windowSeconds),
    window_seconds: windowSeconds,
  };
});
