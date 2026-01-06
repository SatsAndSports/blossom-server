import { test as base } from 'vitest';

// Test configuration
const TEST_PORT = 3099;
const MINT_URL = 'http://localhost:3338';

// Types
interface Pricing {
  perRequestPpk: number;
  perMegabytePpk: number;
}

interface ChannelParams {
  receiver_pubkey: string;
  pricing: Record<string, Pricing>;
  mints_units_keysets: Record<string, Record<string, string[]>>;
}

interface Server {
  baseUrl: string;
  mintUrl: string;
  channelParams: ChannelParams;
  getPricing(unit: string): Pricing | undefined;
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
      };

      await use(server);
    },
    { scope: 'file' }
  ],
});

// Re-export everything from vitest so tests only need one import
export { describe, expect } from 'vitest';
