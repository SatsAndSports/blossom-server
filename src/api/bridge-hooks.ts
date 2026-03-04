import { channelConfig } from "../config.js";
import { spilmanStores, channelActivity } from "./stores.js";
import {
  createSpilmanHost,
  getServerPubkey,
  fetchAndCacheKeysetsForMint,
  init as initKitWasm,
} from "cdk-spilman-kit";

/**
 * Initializes the WASM module via the integration kit.
 * All WASM imports (server + tests) come from cdk-spilman-kit,
 * so only the kit's module needs initialization.
 */
export async function initWasm() {
  await initKitWasm();
}

/**
 * Creates the SpilmanHost hooks object using the integration kit,
 * with a thin wrapper for blossom-specific activity tracking.
 */
function createBlossomHost() {
  const host = createSpilmanHost({
    secretKeyHex: channelConfig.secretKey,
    mints: channelConfig.mints,
    pricing: channelConfig.pricing,
    stores: spilmanStores,
    pricingScale: channelConfig.pricing_scale,
    minExpirySeconds: channelConfig.min_expiry_seconds,
    refreshKeysets: async (mint: string) => {
      await fetchAndCacheKeysetsForMint(mint, channelConfig.pricing, spilmanStores.keysetCache);
    },
  });

  // Wrap recordPayment to also track activity (blossom-specific)
  const originalRecordPayment = host.recordPayment;
  host.recordPayment = (channelId: string, balance: number, signature: string, contextJson: string) => {
    originalRecordPayment(channelId, balance, signature, contextJson);
    channelActivity.recordPayment(channelId);
  };

  host.refreshAllKeysets = async (mint: string): Promise<void> => {
    await fetchAndCacheKeysetsForMint(mint, channelConfig.pricing, spilmanStores.keysetCache);
  };

  return host;
}

export const spilmanHooks = createBlossomHost();

export { getServerPubkey };
