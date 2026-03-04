import { test as base, beforeAll } from 'vitest';
import { init as initWasm } from 'cdk-spilman-kit';

// Test configuration
const TEST_PORT = 3099;
const MINT_URL = process.env.MINT_URL || 'http://localhost:3338';

beforeAll(async () => {
  await initWasm();
});

// Types
interface Pricing {
  min_capacity: number;
  variables: Record<string, number>;
}

interface ChannelParams {
  receiver_pubkey: string;
  pricing: Record<string, Pricing>;
  mints_units_keysets: Record<string, Record<string, string[]>>;
  min_expiry_in_seconds: number;
  pricing_scale: number;
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
          const variables = pricing.variables || {};
          const scale = this.channelParams.pricing_scale || 1;
          return Math.ceil(
            (blobsServed * (variables.blobs || 0) + bytesServed * (variables.bytes || 0)) / scale
          );
        },
        getMinCapacity(unit: string): number {
          return this.channelParams.pricing[unit]?.min_capacity ?? 0;
        },
      };

      await use(server);
    },
    { scope: 'file' }
  ],
});

// Re-export everything from vitest so tests only need one import
export { describe, expect } from 'vitest';
