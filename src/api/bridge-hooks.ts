import dayjs from "dayjs";
import * as secp from "@noble/secp256k1";
import { config } from "../config.js";
import { 
  channelFunding, 
  channelBalance, 
  channelUsage, 
  channelActivity, 
  channelClosed, 
  calculateAmountDue, 
  mintsUnitsKeysets
} from "./stores.js";
import { getKeysetInfoJson } from "./fetch.js";

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
  getFundingAndParams: (channelId: string) => {
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

  getAmountDue: (channelId: string, contextJson: string | null) => {
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

    if (contextJson) {
      const context = JSON.parse(contextJson);
      if (context.type === "blob") {
        totalBlobs += 1;
        totalBytes += context.size || 0;
      }
    }

    return BigInt(calculateAmountDue(totalBlobs, totalBytes, pricing));
  },

  recordPayment: (channelId: string, balance: bigint, signature: string, contextJson: string) => {
    // 1. Commit the actual usage recorded in the context
    const context = JSON.parse(contextJson);
    if (context.type === "blob") {
      channelUsage.recordBlobServed(channelId, context.size || 0);
    }

    // 2. Commit the payment proof for future channel closure
    channelBalance.update(channelId, Number(balance), signature);

    // 3. Update activity heartbeat
    channelActivity.recordPayment(channelId);
  },

  isClosed: (channelId: string) => {
    return channelClosed.isClosed(channelId);
  },

  getChannelPolicy: () => {
    return JSON.stringify({
      min_expiry_in_seconds: config.channel.minExpiryInSeconds,
      pricing: config.channel.pricing,
    });
  },

  nowSeconds: () => {
    return BigInt(dayjs().unix());
  },

  getBalanceAndSignatureForUnilateralExit: (channelId: string) => {
    const balanceData = channelBalance.get(channelId);
    if (!balanceData) {
      return null;
    }
    // Return as [balance, signature] array for WASM consumption
    return [balanceData.balance, balanceData.signature];
  },

  getActiveKeysetIds: (mint: string, unit: string) => {
    const mintData = mintsUnitsKeysets[mint];
    if (!mintData) return [];
    const keysets = mintData[unit];
    if (!keysets) return [];
    return keysets.filter((k) => k.active).map((k) => k.id);
  },

  getKeysetInfo: (mint: string, keysetId: string) => {
    const mintData = mintsUnitsKeysets[mint];
    if (!mintData) return null;
    
    // Find the keyset to get its unit and fees (for now fees are in params but we need them for KeysetInfo)
    for (const [unit, keysets] of Object.entries(mintData)) {
      const keyset = keysets.find(k => k.id === keysetId);
      if (keyset) {
        // We need to provide the input_fee_ppk. It's usually in the config or fetched from mint.
        // For now we'll assume 0 if not easily available, or we could look it up from config.
        const inputFeePpk = config.channel.approvedMintsAndUnits[mint]?.includes(unit) ? 0 : 0; // TODO: better fee lookup
        return getKeysetInfoJson(mint, keysetId, unit, inputFeePpk);
      }
    }
    return null;
  },
};
