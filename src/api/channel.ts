import * as secp from "@noble/secp256k1";
import { koaBody } from "koa-body";
import { config } from "../config.js";
import { router } from "./router.js";
import logger from "../logger.js";
import {
  getChannelStatus,
  calculateAmountDue,
  validateChannelAndSignature,
  isValidatedChannel,
  channelFunding,
  channelUsage,
  channelClosed,
} from "./fetch.js";
import { create_close_swap_request, unblind_and_verify_dleq } from "../wasm/cdk_wasm.js";

const log = logger.extend("channel-mint-setup");

// Type for keyset info from mint's /v1/keysets endpoint
interface MintKeyset {
  id: string;
  unit: string;
  active: boolean;
}

// Type for full keyset with keys
interface KeysetWithKeys {
  id: string;
  keys: Record<string, string>;  // { amount: pubkey }
}

// Cached keyset data: { mintUrl: { unit: [{ id, keys }] } }
type MintsUnitsKeysets = Record<string, Record<string, KeysetWithKeys[]>>;
let mintsUnitsKeysets: MintsUnitsKeysets = {};

// Derive compressed public key (33 bytes) from secret key
function getReceiverPubkey(): string {
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

// Fetch active keysets from a mint for specific units (including full keys)
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
      const activeKeysetInfos = data.keysets.filter(k => k.unit === unit && k.active);
      log(`Filtering for unit="${unit}": found ${activeKeysetInfos.length} active`);

      if (activeKeysetInfos.length > 0) {
        const keysetsWithKeys: KeysetWithKeys[] = [];

        for (const keysetInfo of activeKeysetInfos) {
          const keys = await fetchKeysForKeyset(mintUrl, keysetInfo.id);
          if (keys) {
            keysetsWithKeys.push({ id: keysetInfo.id, keys });
          }
        }

        if (keysetsWithKeys.length > 0) {
          result[unit] = keysetsWithKeys;
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
      log(`  No active keysets found`);
    }
  }

  log("Keyset initialization complete");
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

router.post("/channel/:channel_id/close", koaBody(), async (ctx) => {
  if (!config.channel?.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const channelId = ctx.params.channel_id;
  const body = ctx.request.body as any;

  // Validate required fields
  if (typeof body.balance !== "number" || Number.isNaN(body.balance)) {
    ctx.status = 400;
    ctx.body = { error: "invalid or missing balance" };
    return;
  }
  if (typeof body.signature !== "string" || !body.signature) {
    ctx.status = 400;
    ctx.body = { error: "invalid or missing signature" };
    return;
  }

  closeLog("Close request for channel=%s balance=%d", channelId.substring(0, 8), body.balance);

  // Check if channel is already closed FIRST (for idempotent closing)
  // This must happen before validateChannelAndSignature because that function
  // rejects closed channels (which is correct for payments, but not for close)
  const closedData = channelClosed.get(channelId);
  if (closedData !== null) {
    if (body.balance === closedData.closedAmount) {
      // Idempotent close - same amount, return success
      closeLog("Channel already closed with same amount: channel=%s amount=%d",
        channelId.substring(0, 8), closedData.closedAmount);
      ctx.status = 200;
      ctx.body = {
        success: true,
        channel_id: channelId,
        total_value: closedData.valueAfterStage1,
        already_closed: true,
      };
      return;
    } else {
      // Different amount - reject
      closeLog("Channel already closed with different amount: channel=%s closed=%d requested=%d",
        channelId.substring(0, 8), closedData.closedAmount, body.balance);
      ctx.status = 400;
      ctx.body = {
        error: "channel already closed with a different amount",
        closed_amount: closedData.closedAmount,
        requested_amount: body.balance,
      };
      return;
    }
  }

  // Validate channel and signature (handles both known and unknown channels)
  const validationResult = validateChannelAndSignature(
    channelId,
    body.balance,
    body.signature,
    body.params,
    body.funding_proofs,
    0,  // blobSize not relevant for close
    channelFunding
  );

  if (!isValidatedChannel(validationResult)) {
    closeLog("Validation failed: %s", validationResult.body.reason);
    ctx.status = 402;
    ctx.set("X-Cashu-Channel", JSON.stringify(validationResult.header));
    ctx.body = validationResult.body;
    return;
  }

  const { funding, params: channelParams } = validationResult;

  // Calculate amount_due from usage
  const usage = channelUsage.get(channelId);
  const blobsServed = usage?.blobsServed ?? 0;
  const bytesServed = usage?.bytesServed ?? 0;
  const pricing = config.channel.pricing[channelParams.unit];

  if (!pricing) {
    closeLog("Unsupported unit: %s", channelParams.unit);
    ctx.status = 400;
    ctx.body = { error: "unsupported unit", unit: channelParams.unit };
    return;
  }

  const amountDue = calculateAmountDue(blobsServed, bytesServed, pricing);
  closeLog("Usage: blobs=%d bytes=%d amount_due=%d", blobsServed, bytesServed, amountDue);

  // Verify balance === amount_due (exact match required for closing)
  if (body.balance !== amountDue) {
    closeLog("Balance mismatch: balance=%d amount_due=%d", body.balance, amountDue);
    ctx.status = 400;
    ctx.body = {
      error: "balance must equal amount_due for closing",
      balance: body.balance,
      amount_due: amountDue,
    };
    return;
  }

  // Create fully-signed swap request using WASM
  let swapRequestJson: string;
  let expectedTotal: number;
  let secretsWithBlinding: any[];
  try {
    const result = JSON.parse(create_close_swap_request(
      funding.paramsJson,
      funding.keysetInfoJson,
      funding.secretKey,
      funding.fundingProofsJson,
      channelId,
      BigInt(body.balance),
      body.signature
    ));
    swapRequestJson = JSON.stringify(result.swap_request);
    expectedTotal = result.expected_total;
    secretsWithBlinding = result.secrets_with_blinding;
    closeLog("Swap request created, expected_total=%d, secrets=%d", expectedTotal, secretsWithBlinding.length);
  } catch (e) {
    closeLog("Failed to create swap request: %s", (e as Error).message);
    ctx.status = 400;
    ctx.body = { error: "failed to create swap request", reason: (e as Error).message };
    return;
  }

  // Submit swap to mint
  const mintUrl = channelParams.mint;
  let swapResponse: any;
  try {
    closeLog("Submitting swap to mint: %s", mintUrl);
    const response = await fetch(`${mintUrl}/v1/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: swapRequestJson,
    });
    if (!response.ok) {
      const errorText = await response.text();
      closeLog("Mint rejected swap: %s", errorText);
      ctx.status = 502;
      ctx.body = { error: "mint rejected swap", mint_error: errorText };
      return;
    }
    swapResponse = await response.json();
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
      funding.paramsJson,
      funding.keysetInfoJson,
      BigInt(body.balance)
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

  // Mark channel as closed (prevents reuse until locktime expires)
  channelClosed.markClosed(channelId, channelParams.locktime, body.balance, actualTotal);

  // Success
  ctx.status = 200;
  ctx.body = {
    success: true,
    channel_id: channelId,
    total_value: actualTotal,
    already_closed: false,
  };
});
