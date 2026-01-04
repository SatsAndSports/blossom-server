import * as secp from "@noble/secp256k1";
import { config } from "../config.js";
import { router } from "./router.js";
import logger from "../logger.js";
import { getChannelStatus } from "./fetch.js";

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
