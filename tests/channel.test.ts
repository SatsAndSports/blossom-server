import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;

describe('GET /channel/params', () => {
  it('returns receiver pubkey', async () => {
    const response = await fetch(`${BASE_URL}/channel/params`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.receiver_pubkey).toBeDefined();
    expect(data.receiver_pubkey).toMatch(/^[0-9a-f]{66}$/); // compressed pubkey
  });

  it('returns pricing for configured units', async () => {
    const response = await fetch(`${BASE_URL}/channel/params`);
    const data = await response.json();

    expect(data.pricing).toBeDefined();
    expect(data.pricing.sat).toBeDefined();
    expect(typeof data.pricing.sat.perRequestPpk).toBe('number');
    expect(typeof data.pricing.sat.perMegabytePpk).toBe('number');
    expect(data.pricing.usd).toBeDefined();
    expect(typeof data.pricing.usd.perRequestPpk).toBe('number');
    expect(typeof data.pricing.usd.perMegabytePpk).toBe('number');
  });

  it('returns mints_units_keysets with approved mints', async () => {
    const response = await fetch(`${BASE_URL}/channel/params`);
    const data = await response.json();

    expect(data.mints_units_keysets).toBeDefined();
    // Should have localhost:3338 configured
    const mintUrl = 'http://localhost:3338';
    expect(data.mints_units_keysets[mintUrl]).toBeDefined();
    expect(data.mints_units_keysets[mintUrl].sat).toBeDefined();
    expect(Array.isArray(data.mints_units_keysets[mintUrl].sat)).toBe(true);
    expect(data.mints_units_keysets[mintUrl].usd).toBeDefined();
    expect(Array.isArray(data.mints_units_keysets[mintUrl].usd)).toBe(true);
  });
});

describe('GET /channel/:channel_id/status', () => {
  it('returns 404 for unknown channel', async () => {
    const fakeChannelId = randomBytes(32).toString('hex');
    const response = await fetch(`${BASE_URL}/channel/${fakeChannelId}/status`);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('unknown channel');
  });
});
