import { test as base, beforeAll } from 'vitest';
import { initWasm } from '../src/api/bridge-hooks.js';

// Test configuration
const TEST_PORT = 3099;
const MINT_URL = process.env.MINT_URL || 'http://localhost:3338';

beforeAll(async () => {
  await initWasm();
});

// Types
interface Pricing {
  perRequestPpk: number;
  perMegabytePpk: number;
  minCapacity: number;
}

interface ChannelParams {
  receiver_pubkey: string;
  pricing: Record<string, Pricing>;
  mints_units_keysets: Record<string, Record<string, string[]>>;
  min_expiry_in_seconds: number;
}

interface Server {
  baseUrl: string;
  mintUrl: string;
  channelParams: ChannelParams;
  getPricing(unit: string): Pricing | undefined;
  getAmountDue(unit: string, blobsServed: number, bytesServed: number): number;
  getMinCapacity(unit: string): number;
}

export const test = base.extend<{
  server: Server;
}>({
  server: [
    async ({}, use) => {
      const baseUrl = `http://localhost:${TEST_PORT}`;

      // Fetch channel params once (includes pricing, receiver_pubkey, keysets)
      const paramsRes = await fetch(`${baseUrl}/channel/params`);
      const channelParams: ChannelParams = await paramsRes.json();

      const server: Server = {
        baseUrl,
        mintUrl: MINT_URL,
        channelParams,
        getPricing(unit: string) {
          return this.channelParams.pricing[unit];
        },
        getAmountDue(unit: string, blobsServed: number, bytesServed: number): number {
          const pricing = this.getPricing(unit);
          if (!pricing) throw new Error(`No pricing configured for unit "${unit}"`);
          const megabytes = bytesServed / 1_000_000;
          return Math.ceil(
            (blobsServed * pricing.perRequestPpk + megabytes * pricing.perMegabytePpk) / 1000
          );
        },
        getMinCapacity(unit: string): number {
          return this.channelParams.pricing[unit]?.minCapacity ?? 0;
        },
      };

      await use(server);
    },
    { scope: 'file' }
  ],
});

// Re-export everything from vitest so tests only need one import
export { describe, expect } from 'vitest';
