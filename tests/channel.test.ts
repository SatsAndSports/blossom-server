import { test, describe, expect } from './fixtures';
import { randomBytes } from 'crypto';

describe.concurrent('GET /channel/params', () => {
  test('returns receiver pubkey', async ({ server }) => {
    // Using cached channelParams from fixture
    expect(server.channelParams.receiver_pubkey).toBeDefined();
    expect(server.channelParams.receiver_pubkey).toMatch(/^[0-9a-f]{66}$/); // compressed pubkey
  });

  test('returns pricing for configured units', async ({ server }) => {
    expect(server.channelParams.pricing).toBeDefined();
    expect(server.channelParams.pricing.sat).toBeDefined();
    expect(typeof server.channelParams.pricing.sat.perRequestPpk).toBe('number');
    expect(typeof server.channelParams.pricing.sat.perMegabytePpk).toBe('number');
    expect(server.channelParams.pricing.usd).toBeDefined();
    expect(typeof server.channelParams.pricing.usd.perRequestPpk).toBe('number');
    expect(typeof server.channelParams.pricing.usd.perMegabytePpk).toBe('number');
  });

  test('returns mints_units_keysets with approved mints', async ({ server }) => {
    expect(server.channelParams.mints_units_keysets).toBeDefined();
    // Should have localhost:3338 configured
    expect(server.channelParams.mints_units_keysets[server.mintUrl]).toBeDefined();
    expect(server.channelParams.mints_units_keysets[server.mintUrl].sat).toBeDefined();
    expect(Array.isArray(server.channelParams.mints_units_keysets[server.mintUrl].sat)).toBe(true);
    expect(server.channelParams.mints_units_keysets[server.mintUrl].usd).toBeDefined();
    expect(Array.isArray(server.channelParams.mints_units_keysets[server.mintUrl].usd)).toBe(true);
  });
});

describe.concurrent('GET /channel/:channel_id/status', () => {
  test('returns 404 for unknown channel', async ({ server }) => {
    const fakeChannelId = randomBytes(32).toString('hex');
    const response = await fetch(`${server.baseUrl}/channel/${fakeChannelId}/status`);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('unknown channel');
  });
});
