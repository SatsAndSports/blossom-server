import dayjs from "dayjs";
import logger from "../logger.js";

const paymentLog = logger.extend("payments");

// Data types for channel stores
export interface ChannelFundingData {
  paramsJson: string;
  fundingProofsJson: string;
  sharedSecret: string;
  secretKey: string;  // Server's secret key used for this channel
  keysetInfoJson: string;  // Complete keyset info (keysetId, unit, keys, inputFeePpk, amounts)
}

export interface ChannelUsage {
  blobsServed: number;
  bytesServed: number;
}

export interface ChannelBalance {
  balance: number;
  signature: string;
}

export interface ClosedChannelData {
  locktime: number;
  closedAmount: number;
  valueAfterStage1: number;
  receiverProofsJson: string;  // Charlie's proofs (P2PK to his blinded pubkey)
  senderProofsJson: string;    // Alice's proofs (her change)
}

// ============================================================================
// Channel Funding Store
// ============================================================================

const channelFundingStore = new Map<string, ChannelFundingData>();

export const channelFunding = {
  get(channelId: string): ChannelFundingData | null {
    return channelFundingStore.get(channelId) ?? null;
  },

  insert(channelId: string, data: ChannelFundingData): void {
    if (!channelFundingStore.has(channelId)) {
      channelFundingStore.set(channelId, data);
      paymentLog("channelFunding: inserted channel=%s", channelId.substring(0, 8));
    }
  },
};

// ============================================================================
// Channel Balance Store
// ============================================================================

const channelBalanceStore = new Map<string, ChannelBalance>();

export const channelBalance = {
  get(channelId: string): ChannelBalance | null {
    return channelBalanceStore.get(channelId) ?? null;
  },

  update(channelId: string, balance: number, signature: string): void {
    const current = channelBalanceStore.get(channelId);
    if (!current || balance > current.balance) {
      channelBalanceStore.set(channelId, { balance, signature });
      paymentLog("channel=%s balance updated: %d -> %d",
        channelId.substring(0, 8), current?.balance ?? 0, balance);
    }
  },
};

// ============================================================================
// Channel Usage Store
// ============================================================================

const channelUsageStore = new Map<string, ChannelUsage>();

export const channelUsage = {
  get(channelId: string): ChannelUsage | null {
    return channelUsageStore.get(channelId) ?? null;
  },

  recordBlobServed(channelId: string, size: number): void {
    let usage = channelUsageStore.get(channelId);
    if (!usage) {
      usage = { blobsServed: 0, bytesServed: 0 };
      channelUsageStore.set(channelId, usage);
    }
    usage.blobsServed += 1;
    usage.bytesServed += size;
    paymentLog("channel=%s served blob size=%d total: blobs=%d bytes=%d",
      channelId.substring(0, 8), size, usage.blobsServed, usage.bytesServed);
  },
};

// ============================================================================
// Channel Activity Store
// ============================================================================

const channelActivityStore = new Map<string, number>(); // channel_id -> timestamp

export const channelActivity = {
  recordPayment(channelId: string): void {
    channelActivityStore.set(channelId, Date.now());
  },

  getActiveCount(windowSeconds: number): number {
    const cutoff = Date.now() - (windowSeconds * 1000);
    let count = 0;
    for (const timestamp of channelActivityStore.values()) {
      if (timestamp >= cutoff) count++;
    }
    return count;
  },

  cleanup(windowSeconds: number): void {
    const cutoff = Date.now() - (windowSeconds * 1000);
    for (const [channelId, timestamp] of channelActivityStore) {
      if (timestamp < cutoff) {
        channelActivityStore.delete(channelId);
      }
    }
  },
};

// ============================================================================
// Exported getters for channel status endpoint
// ============================================================================

export interface ChannelStatus {
  channel_id: string;
  capacity: number;
  balance: number;
  blobs_served: number;
  bytes_served: number;
  amount_due: number;
  closed: boolean;
  closed_amount?: number;
}

const channelClosedStore = new Map<string, ClosedChannelData>();

export const channelClosed = {
  isClosed(channelId: string): boolean {
    return channelClosedStore.has(channelId);
  },

  markClosed(
    channelId: string,
    locktime: number,
    closedAmount: number,
    valueAfterStage1: number,
    receiverProofsJson: string,
    senderProofsJson: string
  ): void {
    channelClosedStore.set(channelId, {
      locktime,
      closedAmount,
      valueAfterStage1,
      receiverProofsJson,
      senderProofsJson,
    });
    paymentLog("channelClosed: channel=%s locktime=%d closedAmount=%d valueAfterStage1=%d receiverProofs=%d senderProofs=%d",
      channelId.substring(0, 8), locktime, closedAmount, valueAfterStage1,
      JSON.parse(receiverProofsJson).length, JSON.parse(senderProofsJson).length);
  },

  get(channelId: string): ClosedChannelData | null {
    return channelClosedStore.get(channelId) ?? null;
  },
};

// Calculate amount due based on usage and pricing
export function calculateAmountDue(
  blobsServed: number,
  bytesServed: number,
  pricing: { perRequestPpk: number; perMegabytePpk: number }
): number {
  const megabytes = bytesServed / 1_000_000;
  return Math.ceil(
    (blobsServed * pricing.perRequestPpk + megabytes * pricing.perMegabytePpk) / 1000
  );
}
