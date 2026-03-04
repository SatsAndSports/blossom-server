import { koaBody } from "koa-body";
import { channelConfig } from "../config.js";
import { router } from "./router.js";
import logger from "../logger.js";
import {
  getServerPubkey,
  fetchAndCacheKeysetsForMint,
} from "cdk-spilman-kit";
import {
  getChannelStatus,
  getBridge,
  extractBridgeError,
} from "./fetch.js";
import {
  spilmanStores,
  channelActivity,
} from "./stores.js";

const log = logger.extend("channel-mint-setup");

// ============================================================================
// Keyset Management (delegates to kit's KeysetCache)
// ============================================================================

// Initialize keysets from all configured mints
export async function initializeChannelKeysets(): Promise<void> {
  if (!channelConfig.enabled) {
    return;
  }

  const mints = channelConfig.mints || {};
  log("mints: %O", mints);

  for (const [mintUrl, _units] of Object.entries(mints)) {
    log(`Fetching keysets from ${mintUrl}...`);
    try {
      await fetchAndCacheKeysetsForMint(mintUrl, channelConfig.pricing, spilmanStores.keysetCache);
      log(`  Keysets cached for ${mintUrl}`);
    } catch (e) {
      log(`  Failed to fetch keysets from ${mintUrl}: ${e}`);
    }
  }

  log("Keyset initialization complete");
}

// Refresh keysets for a specific mint
export async function refreshKeysetsForMint(mintUrl: string): Promise<void> {
  const units = channelConfig.mints[mintUrl];
  if (!units) {
    log(`refreshKeysetsForMint: ${mintUrl} not in approved mints list`);
    return;
  }

  log(`Refreshing keysets from ${mintUrl}...`);
  try {
    spilmanStores.keysetCache.clearForMint(mintUrl);
    await fetchAndCacheKeysetsForMint(mintUrl, channelConfig.pricing, spilmanStores.keysetCache);
    log(`  Keysets refreshed for ${mintUrl}`);
  } catch (e) {
    log(`  Failed to refresh keysets from ${mintUrl}: ${e}`);
  }
}

// ============================================================================
// Channel Management Routes
// ============================================================================

router.get("/channel/params", async (ctx) => {
  if (!channelConfig.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const receiverPubkey = getServerPubkey(channelConfig.secretKey);

  ctx.body = {
    receiver_pubkey: receiverPubkey,
    pricing: channelConfig.pricing,
    mints_units_keysets: spilmanStores.keysetCache.getMintsUnitsKeysets(),
    min_expiry_in_seconds: channelConfig.min_expiry_seconds,
    pricing_scale: channelConfig.pricing_scale ?? 1,
  };
});

router.get("/channel/:channel_id/status", async (ctx) => {
  if (!channelConfig.enabled) {
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
  if (!channelConfig?.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const channelId = ctx.params.channel_id;
  const body = ctx.request.body as any;
  body.channel_id = channelId;

  const { balance, signature } = body;
  if (balance === undefined || !signature) {
    ctx.status = 400;
    ctx.body = { error: "missing balance or signature" };
    return;
  }

  closeLog("Close request for channel=%s balance=%d", channelId.substring(0, 8), balance);

  // Check if channel is already closed (idempotent)
  const closedData = spilmanStores.channelClosed.get(channelId);
  if (closedData !== null) {
    if (balance === closedData.closedAmount) {
      closeLog("Channel already closed with same amount: channel=%s amount=%d",
        channelId.substring(0, 8), closedData.closedAmount);
      ctx.status = 200;
      ctx.body = {
        success: true,
        channel_id: channelId,
        total_value: closedData.valueAfterStage1,
        receiver_sum: closedData.receiverSum,
        sender_sum: closedData.senderSum,
        sender_proofs: JSON.parse(closedData.senderProofsJson),
        already_closed: true,
      };
      return;
    } else {
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

  let result: any;
  try {
    result = await getBridge().executeCooperativeClose(JSON.stringify(body));
  } catch (e: any) {
    let closeError: any;
    if (typeof e === 'object' && e !== null && 'type' in e) {
      closeError = e;
    } else {
      const errorMsg = (e as Error).message || String(e);
      try {
        closeError = JSON.parse(errorMsg);
      } catch {
        closeError = { type: "InternalError", reason: errorMsg, status: 500 };
      }
    }
    const status = closeError.status || 402;
    const reason = closeError.reason || closeError.mint_error || String(closeError);
    closeLog("Close failed: %s (status=%d)", reason, status);
    ctx.status = status;
    const responseBody: any = {
      success: false,
      error: status === 402 ? "Payment required" : reason,
      reason: reason,
    };
    if (closeError.expected_balance !== undefined) {
      responseBody.expected = closeError.expected_balance;
    }
    if (closeError.actual_balance !== undefined) {
      responseBody.actual = closeError.actual_balance;
    }
    ctx.body = responseBody;
    return;
  }

  const senderProofs = typeof result.sender_proofs === 'string'
    ? JSON.parse(result.sender_proofs)
    : result.sender_proofs;

  closeLog("Channel closed successfully: channel=%s total_value=%d", channelId.substring(0, 8), result.total_value);
  ctx.status = 200;
  ctx.body = {
    success: true,
    channel_id: result.channel_id,
    total_value: result.total_value,
    receiver_sum: result.receiver_sum,
    sender_sum: result.sender_sum,
    sender_proofs: senderProofs,
    already_closed: result.already_closed,
  };
});

// Unilateral (server-initiated) channel close endpoint
router.post("/channel/:channel_id/unilateral-close", async (ctx) => {
  if (!channelConfig?.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const channelId = ctx.params.channel_id;
  closeLog("Unilateral close request for channel=%s", channelId.substring(0, 8));

  // Check if channel exists
  if (!spilmanStores.channelFunding.get(channelId)) {
    ctx.status = 404;
    ctx.body = { error: "unknown channel" };
    return;
  }

  // Check if already closed (idempotent)
  const closedData = spilmanStores.channelClosed.get(channelId);
  if (closedData !== null) {
    closeLog("Channel already closed, returning cached result");
    ctx.status = 200;
    ctx.body = {
      success: true,
      channel_id: channelId,
      earnedBeforeStage2Fees: closedData.receiverSum,
      already_closed: true,
    };
    return;
  }

  let result: any;
  try {
    result = await getBridge().executeUnilateralClose(channelId);
  } catch (e: any) {
    let closeError: any;
    if (typeof e === 'object' && e !== null && 'type' in e) {
      closeError = e;
    } else {
      const errorMsg = (e as Error).message || String(e);
      try {
        closeError = JSON.parse(errorMsg);
      } catch {
        closeError = { type: "InternalError", reason: errorMsg, status: 500 };
      }
    }
    const status = closeError.status || 500;
    const reason = closeError.reason || closeError.mint_error || String(closeError);
    closeLog("Unilateral close failed: %s (status=%d)", reason, status);
    ctx.status = status;
    ctx.body = { success: false, error: reason, ...closeError };
    return;
  }

  closeLog("Unilateral close successful: channel=%s earned=%d", channelId.substring(0, 8), result.receiver_sum);
  ctx.status = 200;
  ctx.body = {
    success: true,
    channel_id: channelId,
    earnedBeforeStage2Fees: result.receiver_sum,
    already_closed: false,
  };
});

router.get("/channel/stats", async (ctx) => {
  if (!channelConfig?.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const windowSeconds = parseInt(ctx.query.window as string) || 300;
  ctx.body = {
    active_channels: channelActivity.getActiveCount(windowSeconds),
    window_seconds: windowSeconds,
  };
});

const registerLog = logger.extend("channel-register");

// POST /channel/register - Pre-register a channel (balance=0, no usage recorded)
router.post("/channel/register", koaBody(), async (ctx) => {
  if (!channelConfig?.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const { channel_id, balance, signature, params, funding_proofs } = ctx.request.body as any;

  if (!channel_id || signature === undefined || !params || !funding_proofs) {
    ctx.status = 400;
    ctx.body = {
      error: "Bad request",
      reason: "missing required fields: channel_id, signature, params, funding_proofs",
    };
    return;
  }

  if (balance !== 0) {
    ctx.status = 400;
    ctx.body = {
      error: "Bad request",
      reason: `registration requires balance=0, got ${balance}`,
    };
    return;
  }

  registerLog("Register request for channel=%s", channel_id.substring(0, 8));

  const registerBody = { channel_id, balance: 0, signature, params, funding_proofs };

  try {
    const result = getBridge().fundChannel(JSON.stringify(registerBody));

    registerLog("Register SUCCESS: channel=%s capacity=%d already_known=%s",
      result.channel_id.substring(0, 8), result.capacity, result.already_known);
    ctx.body = {
      success: true,
      channel_id: result.channel_id,
      capacity: result.capacity,
      already_known: result.already_known,
    };
  } catch (e) {
    const { errorMsg, status: bridgeStatus } = extractBridgeError(e);
    const lowerMsg = errorMsg.toLowerCase();

    let status = typeof bridgeStatus === "number" ? bridgeStatus : 402;
    if (bridgeStatus === undefined) {
      if (lowerMsg.includes("unknown channel")) {
        status = 404;
      } else if (lowerMsg.includes("invalid base64") ||
                 lowerMsg.includes("invalid utf8") ||
                 lowerMsg.includes("invalid json") ||
                 lowerMsg.includes("missing channel_id") ||
                 lowerMsg.includes("missing signature") ||
                 lowerMsg.includes("missing params") ||
                 lowerMsg.includes("missing funding_proofs")) {
        status = 400;
      } else if (lowerMsg.includes("internal") || lowerMsg.includes("misconfigured")) {
        status = 500;
      }
    }

    registerLog("Register REJECTED: %s", errorMsg);
    ctx.status = status;
    ctx.body = { success: false, error: errorMsg, reason: errorMsg };
  }
});
