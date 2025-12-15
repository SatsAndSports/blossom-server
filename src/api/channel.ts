import * as secp from "@noble/secp256k1";
import { config } from "../config.js";
import { router } from "./router.js";
import logger from "../logger.js";

const log = logger.extend("channel");

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

router.get("/channel/params", async (ctx) => {
  if (!config.channel.enabled) {
    ctx.status = 404;
    ctx.body = { error: "Channel payments not enabled" };
    return;
  }

  const receiverPubkey = getReceiverPubkey();
  log(`Channel params requested, pubkey: ${receiverPubkey}`);

  ctx.body = {
    receiver_pubkey: receiverPubkey,
    approved_mints: config.channel.approvedMints,
    price_per_segment: config.channel.pricePerSegment,
  };
});
