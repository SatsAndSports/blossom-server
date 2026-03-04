import path from "node:path";
import fs from "node:fs";
import logger from "../logger.js";
import { channelConfig } from "../config.js";
import {
  createSqliteStores,
  createInMemoryStores,
  getChannelStatus as kitGetChannelStatus,
  type SpilmanStores,
  type UsageMap,
  type ChannelStatus as KitChannelStatus,
} from "cdk-spilman-kit";

const paymentLog = logger.extend("payments");

// ============================================================================
// Initialize Spilman stores based on channel-config storage settings
// ============================================================================

let stores: SpilmanStores;
if (channelConfig.storage?.type === "sqlite" && channelConfig.storage.path) {
  const dbPath = channelConfig.storage.path;
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  stores = createSqliteStores(dbPath);
} else {
  stores = createInMemoryStores();
}

export const spilmanStores = stores;

// ============================================================================
// Channel Activity Store (blossom-specific: tracks payment timestamps)
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
// Channel Status (extends kit's ChannelStatus with backward-compat fields)
// ============================================================================

export interface BlossomChannelStatus extends KitChannelStatus {
  blobs_served: number;
  bytes_served: number;
}

export function getChannelStatus(channelId: string): BlossomChannelStatus {
  const status = kitGetChannelStatus(
    channelId,
    channelConfig.pricing,
    spilmanStores,
    channelConfig.pricing_scale ?? 1
  );

  return {
    ...status,
    blobs_served: status.usage?.blobs ?? 0,
    bytes_served: status.usage?.bytes ?? 0,
  };
}
