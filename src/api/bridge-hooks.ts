import dayjs from "dayjs";
import * as secp from "@noble/secp256k1";
import { config } from "../config.js";
import { 
  channelFunding, 
  channelBalance, 
  channelUsage, 
  channelActivity, 
  channelClosing,
  channelClosed, 
  calculateAmountDue, 
  mintsUnitsKeysets
} from "./stores.js";
import { getKeysetInfoJson } from "./fetch.js";
import { refreshKeysetsForMint } from "./channel.js";

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
    keysetInfoJson: string,
    initialBalance: number,
    initialSignature: string
  ) => {
    channelFunding.insert(channelId, {
      paramsJson,
      fundingProofsJson,
      sharedSecret,
      secretKey: config.channel.secretKey!,
      keysetInfoJson,
    });
    // Store the initial balance/signature for closing
    // Note: WASM passes u64 as BigInt, convert to number for JSON serialization
    channelBalance.update(channelId, Number(initialBalance), initialSignature);
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

  // Note: WASM passes u64 values as BigInt; we convert to number at this boundary
  // since all channel values fit safely in JS number (< 2^53).
  recordPayment: (channelId: string, balance: number, signature: string, contextJson: string) => {
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

  // Returns: "open" | "closing" | "closed"
  getChannelState: (channelId: string): string => {
    if (channelClosed.isClosed(channelId)) return "closed";
    if (channelClosing.isClosing(channelId)) return "closing";
    return "open";
  },

  // Throws on error, returns nothing on success
  markChannelClosing: (
    channelId: string,
    locktime: number,
    balance: number,
    signature: string
  ): void => {
    // Check if already closed - reject with error
    if (channelClosed.isClosed(channelId)) {
      throw new Error("channel already closed");
    }
    // Open or Closing channels can be marked as closing
    channelClosing.markClosing(channelId, Number(locktime), Number(balance), signature);
  },

  getClosingData: (channelId: string) => {
    const data = channelClosing.get(channelId);
    if (!data) return null;
    return {
      locktime: data.locktime,
      balance: data.balance,
      signature: data.signature,
    };
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
    
    // Find the keyset to get its unit and fee
    for (const [unit, keysets] of Object.entries(mintData)) {
      const keyset = keysets.find(k => k.id === keysetId);
      if (keyset) {
        return getKeysetInfoJson(mint, keysetId, unit, keyset.input_fee_ppk);
      }
    }
    return null;
  },

  callMintSwap: async (mintUrl: string, swapRequestJson: string): Promise<string> => {
    const response = await fetch(`${mintUrl}/v1/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: swapRequestJson,
    });
    if (!response.ok) {
      const text = await response.text();
      return JSON.stringify({ error: `Mint rejected swap: ${text}` });
    }
    return await response.text();
  },

  // Throws on error, returns nothing on success
  markChannelClosed: (
    channelId: string,
    locktime: number,
    balance: number,
    receiverProofsJson: string,
    senderProofsJson: string,
    receiverSum: number,
    senderSum: number
  ): void => {
    // Check if channel is already closed (shouldn't happen, but be defensive)
    if (channelClosed.isClosed(channelId)) {
      throw new Error("channel already closed");
    }
    const locktimeNum = Number(locktime);
    const balanceNum = Number(balance);
    const receiverSumNum = Number(receiverSum);
    const senderSumNum = Number(senderSum);
    channelClosed.markClosed(
      channelId,
      locktimeNum,
      balanceNum,
      receiverSumNum + senderSumNum,  // valueAfterStage1
      receiverSumNum,
      senderSumNum,
      receiverProofsJson,
      senderProofsJson
    );
  },

  refreshActiveKeysets: async (mint: string): Promise<void> => {
    await refreshKeysetsForMint(mint);
  },
};
