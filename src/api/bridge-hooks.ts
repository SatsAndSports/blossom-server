import dayjs from "dayjs";
import * as secp from "@noble/secp256k1";
import { config } from "../config.js";
import { channelFunding, channelBalance, channelUsage, channelActivity, channelClosed, calculateAmountDue } from "./fetch.js";

let cachedServerPubkey: string | null = null;

function getServerPubkey(): string | null {
  if (cachedServerPubkey) return cachedServerPubkey;
  if (!config.channel.secretKey) return null;
  try {
    const secretBytes = Buffer.from(config.channel.secretKey, "hex");
    const pubkeyBytes = secp.getPublicKey(secretBytes, true);
    cachedServerPubkey = Buffer.from(pubkeyBytes).toString("hex");
    return cachedServerPubkey;
  } catch (e) {
    return null;
  }
}

export const spilmanHooks = {
  getFunding: (channelId: string) => {
    const funding = channelFunding.get(channelId);
    if (!funding) return null;
    return [
      funding.paramsJson,
      funding.fundingProofsJson,
      funding.sharedSecret,
      funding.keysetInfoJson,
    ];
  },

  receiverKeyIsAcceptable: (receiverPubkeyHex: string) => {
    const serverPubkey = getServerPubkey();
    if (!serverPubkey) return false;
    return receiverPubkeyHex.toLowerCase() === serverPubkey.toLowerCase();
  },

  mintAndKeysetIsAcceptable: (mint: string, keysetId: string) => {
    // We still have a circular dependency issue if we use getKeysetKeys from channel.js
    // But maybe we can just check if it's in the config's approved list for now,
    // and skip the "is it in cache" check if it's too hard to reach.
    const approved = config.channel.approvedMintsAndUnits[mint];
    return !!approved;
  },

  saveFunding: (
    channelId: string,
    paramsJson: string,
    fundingProofsJson: string,
    sharedSecret: string,
    keysetInfoJson: string
  ) => {
    channelFunding.insert(channelId, {
      paramsJson,
      fundingProofsJson,
      sharedSecret,
      secretKey: config.channel.secretKey!,
      keysetInfoJson,
    });
  },

  getAmountDue: (channelId: string, contextJson: string) => {
    const context = JSON.parse(contextJson);
    const usage = channelUsage.get(channelId);
    const blobsServed = usage?.blobsServed ?? 0;
    const bytesServed = usage?.bytesServed ?? 0;

    // Check if we have params to get the unit
    const funding = channelFunding.get(channelId);
    if (!funding) return BigInt(0); // Should not happen if bridge is calling this

    const params = JSON.parse(funding.paramsJson);
    const pricing = config.channel.pricing[params.unit];
    if (!pricing) return BigInt(0);

    let totalBlobs = blobsServed;
    let totalBytes = bytesServed;

    if (context.type === "blob") {
      totalBlobs += 1;
      totalBytes += context.size || 0;
    }

    return BigInt(calculateAmountDue(totalBlobs, totalBytes, pricing));
  },

  recordPayment: (channelId: string, balance: bigint, signature: string, amountDue: bigint) => {
    // Note: contextJson is not passed here, but we know the size from the previous getAmountDue call
    // Wait, recordPayment needs to know which blob was served to update usage counters.
    // Actually, recordPayment in bridge.rs is called AFTER successful validation.
    
    // In our current blossom-server implementation, we update counters in the router handler,
    // not in validatePayment. We should probably keep it that way for now, or pass more info.
    
    // For now, we'll just update the balance and activity.
    // usage counter update will still happen in router.get("/:hash")
    channelBalance.update(channelId, Number(balance), signature);
    channelActivity.recordPayment(channelId);
  },

  isClosed: (channelId: string) => {
    return channelClosed.isClosed(channelId);
  },

  getServerConfig: () => {
    return JSON.stringify({
      min_expiry_in_seconds: config.channel.minExpiryInSeconds,
      pricing: config.channel.pricing,
    });
  },

  nowSeconds: () => {
    return BigInt(dayjs().unix());
  },
};
