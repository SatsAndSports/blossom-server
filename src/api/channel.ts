import * as secp from "@noble/secp256k1";
import { config } from "../config.js";
import { router } from "./router.js";
import logger from "../logger.js";

const log = logger.extend("channel-mint-setup");

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

    const result: Record<string, string[]> = {};

    for (const unit of units) {
      const activeKeysets = data.keysets
        .filter(k => k.unit === unit && k.active)
        .map(k => k.id);

      log(`Filtering for unit="${unit}": found ${activeKeysets.length} active`);

      if (activeKeysets.length > 0) {
        result[unit] = activeKeysets;
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
  if (!config.channel.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const receiverPubkey = getReceiverPubkey();

  ctx.body = {
    receiver_pubkey: receiverPubkey,
    price_per_segment: config.channel.pricePerSegment,
    mints_units_keysets: mintsUnitsKeysets,
  };
});
