import * as secp from "@noble/secp256k1";
import { config } from "../config.js";
import { router } from "./router.js";
import logger from "../logger.js";

const log = logger.extend("channel");

// Type for keyset info from mint
interface MintKeyset {
  id: string;
  unit: string;
  active: boolean;
}

// Cached keyset data: { mintUrl: { unit: [keyset_ids] } }
type MintsUnitsKeysets = Record<string, Record<string, string[]>>;
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

// Fetch active keysets from a mint for specific units
async function fetchKeysetsFromMint(mintUrl: string, units: string[]): Promise<Record<string, string[]>> {
  const url = `${mintUrl}/v1/keysets`;
  console.log(`[channel] GET ${url}`);

  try {
    const response = await fetch(url);
    console.log(`[channel] Response status: ${response.status}`);

    if (!response.ok) {
      console.log(`[channel] Failed to fetch keysets from ${mintUrl}: ${response.status}`);
      return {};
    }

    const data = await response.json() as { keysets: MintKeyset[] };
    console.log(`[channel] Mint returned ${data.keysets?.length ?? 0} keysets`);

    // Log all keysets for debugging
    for (const k of data.keysets || []) {
      console.log(`[channel]   keyset: id=${k.id} unit=${k.unit} active=${k.active}`);
    }

    const result: Record<string, string[]> = {};

    for (const unit of units) {
      const activeKeysets = data.keysets
        .filter(k => k.unit === unit && k.active)
        .map(k => k.id);

      console.log(`[channel] Filtering for unit="${unit}": found ${activeKeysets.length} active keysets`);

      if (activeKeysets.length > 0) {
        result[unit] = activeKeysets;
      }
    }

    return result;
  } catch (e) {
    console.log(`[channel] Error fetching keysets from ${mintUrl}: ${e}`);
    return {};
  }
}

// Initialize keysets from all configured mints
export async function initializeChannelKeysets(): Promise<void> {
  console.log("[channel] initializeChannelKeysets called");
  console.log("[channel] config.channel.enabled:", config.channel.enabled);

  if (!config.channel.enabled) {
    console.log("[channel] Channel not enabled, skipping keyset init");
    return;
  }

  const approvedMintsAndUnits = config.channel.approvedMintsAndUnits || {};
  console.log("[channel] approvedMintsAndUnits:", JSON.stringify(approvedMintsAndUnits));

  log("Fetching keysets from configured mints...");

  for (const [mintUrl, units] of Object.entries(approvedMintsAndUnits)) {
    log(`Fetching keysets from ${mintUrl} for units: ${units.join(", ")}`);
    const keysets = await fetchKeysetsFromMint(mintUrl, units);

    if (Object.keys(keysets).length > 0) {
      mintsUnitsKeysets[mintUrl] = keysets;
      for (const [unit, ids] of Object.entries(keysets)) {
        log(`  ${unit}: ${ids.join(", ")}`);
      }
    } else {
      log(`  No active keysets found`);
    }
  }

  log("Keyset initialization complete");
}

router.get("/channel/params", async (ctx) => {
  console.log("[channel/params] Route hit");
  console.log("[channel/params] config.channel.enabled:", config.channel.enabled);
  console.log("[channel/params] mintsUnitsKeysets:", JSON.stringify(mintsUnitsKeysets));

  if (!config.channel.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const receiverPubkey = getReceiverPubkey();
  console.log("[channel/params] receiverPubkey:", receiverPubkey);

  ctx.body = {
    receiver_pubkey: receiverPubkey,
    price_per_segment: config.channel.pricePerSegment,
    mints_units_keysets: mintsUnitsKeysets,
  };
});
