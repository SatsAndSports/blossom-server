import { test, describe, expect } from './fixtures';
import { createHash, randomBytes } from 'crypto';
import * as secp from '@noble/secp256k1';

// Import WASM functions
import {
  compute_channel_secret,
  compute_funding_token_amount,
  channel_parameters_get_channel_id,
  create_funding_outputs,
  construct_proofs,
  spilman_channel_sender_create_signed_balance_update,
} from '../src/wasm/cdk_wasm.js';

// Generate a random keypair for Alice
function generateKeypair(): { secretHex: string; pubkeyHex: string } {
  const secretBytes = randomBytes(32);
  const secretHex = secretBytes.toString('hex');
  const pubkeyBytes = secp.getPublicKey(secretBytes, true); // compressed
  const pubkeyHex = Buffer.from(pubkeyBytes).toString('hex');
  return { secretHex, pubkeyHex };
}

// Generate unique blob content
function generateBlob(): { content: Buffer; hash: string } {
  const content = Buffer.from(`test-blob-${randomBytes(16).toString('hex')}`);
  const hash = createHash('sha256').update(content).digest('hex');
  return { content, hash };
}

// Encode payment object to base64 for X-Cashu-Channel header
function encodePaymentHeader(payment: object): string {
  return Buffer.from(JSON.stringify(payment)).toString('base64');
}

// Fetch keyset info from mint
async function fetchKeysetInfo(mintUrl: string, keysetId: string): Promise<any> {
  const keysRes = await fetch(`${mintUrl}/v1/keys/${keysetId}`);
  const keysData = await keysRes.json();

  const keysetsRes = await fetch(`${mintUrl}/v1/keysets`);
  const keysetsData = await keysetsRes.json();
  const keyset = keysetsData.keysets.find((k: any) => k.id === keysetId);

  const keys: Record<string, string> = {};
  if (keysData.keysets && keysData.keysets[0]?.keys) {
    for (const [amount, pubkey] of Object.entries(keysData.keysets[0].keys)) {
      keys[amount] = pubkey as string;
    }
  }

  return {
    keysetId,
    unit: keyset?.unit || 'sat',
    keys,
    inputFeePpk: keyset?.input_fee_ppk || 0,
    amounts: Object.keys(keys).map(Number).sort((a, b) => b - a),
  };
}

// Server type for fixture
interface Server {
  baseUrl: string;
  mintUrl: string;
  channelParams: {
    receiver_pubkey: string;
    pricing: Record<string, { perRequestPpk: number; perMegabytePpk: number }>;
    mints_units_keysets: Record<string, Record<string, string[]>>;
  };
  getPricing(unit: string): { perRequestPpk: number; perMegabytePpk: number } | undefined;
  getAmountDue(unit: string, blobsServed: number, bytesServed: number): number;
}

// Helper to mint a funded channel - returns everything needed to make payments
async function mintFundedChannel(server: Server, unit: string) {
  // Use cached channel params from server fixture
  const charliePubkey = server.channelParams.receiver_pubkey;

  // Get keyset for the specified unit
  const mintUrl = server.mintUrl;
  const unitKeysets = server.channelParams.mints_units_keysets[mintUrl]?.[unit];
  if (!unitKeysets || unitKeysets.length === 0) {
    throw new Error(`No keyset found for unit "${unit}" at ${mintUrl}`);
  }
  const keysetId = unitKeysets[0];

  // Generate Alice's keypair
  const alice = generateKeypair();

  // Fetch keyset info from mint
  const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);

  // Build channel parameters
  const setupTimestamp = Math.floor(Date.now() / 1000);
  const locktime = setupTimestamp + 7 * 24 * 60 * 60;
  const senderNonce = randomBytes(32).toString('hex');
  const capacity = 100;

  const fundingTokenAmount = Number(compute_funding_token_amount(
    BigInt(capacity), JSON.stringify(keysetInfo), BigInt(64),
  ));
  const channelParams = {
    mint: mintUrl,
    unit: unit,
    capacity: capacity,
    funding_token_amount: fundingTokenAmount,
    keyset_id: keysetId,
    input_fee_ppk: keysetInfo.inputFeePpk,
    maximum_amount: 64,
    setup_timestamp: setupTimestamp,
    alice_pubkey: alice.pubkeyHex,
    charlie_pubkey: charliePubkey,
    locktime: locktime,
    sender_nonce: senderNonce,
  };
  const channelParamsJson = JSON.stringify(channelParams);

  // Generate funding outputs
  const fundingOutputsJson = create_funding_outputs(
    channelParamsJson,
    alice.secretHex,
    JSON.stringify(keysetInfo)
  );
  const fundingOutputs = JSON.parse(fundingOutputsJson);

  // Create mint quote
  const quoteRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: fundingOutputs.funding_token_nominal,
      unit: unit,
    }),
  });
  const quote = await quoteRes.json();

  // Wait for payment (FakeWallet auto-pays)
  for (let i = 0; i < 30; i++) {
    const statusRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11/${quote.quote}`);
    const status = await statusRes.json();
    if (status.state === 'PAID') break;
    await new Promise(r => setTimeout(r, 100));
  }

  // Mint with our blinded messages
  const mintReq = {
    quote: quote.quote,
    outputs: fundingOutputs.blinded_messages.map((bm: any) => ({
      amount: bm.amount,
      id: bm.id,
      B_: bm.B_,
    })),
  };

  const mintRes = await fetch(`${mintUrl}/v1/mint/bolt11`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mintReq),
  });
  const mintData = await mintRes.json();

  // Construct proofs (unblind signatures)
  const proofsJson = construct_proofs(
    JSON.stringify(mintData.signatures),
    JSON.stringify(fundingOutputs.secrets_with_blinding),
    JSON.stringify(keysetInfo)
  );
  const proofs = JSON.parse(proofsJson);

  // Compute shared secret and channel ID
  const channelSecret = compute_channel_secret(alice.secretHex, charliePubkey);
  const keysetInfoJson = JSON.stringify(keysetInfo);
  const channelId = channel_parameters_get_channel_id(channelParamsJson, channelSecret, keysetInfoJson);

  return {
    alice,
    channelParams,
    channelParamsJson,
    channelId,
    channelSecret,
    proofs,
    keysetInfo,
    capacity,
  };
}

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

describe.concurrent('POST /channel/register', () => {
  test('registers a channel with balance=0 signature', async ({ server }) => {
    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Create a signature for balance=0
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Register the channel
    const response = await fetch(`${server.baseUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: channel.channelId,
        balance: 0,
        signature: balanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.channel_id).toBe(channel.channelId);
    expect(result.capacity).toBe(100);
    expect(result.already_known).toBe(false);
    console.log(`Registered channel: capacity=${result.capacity}, already_known=${result.already_known}`);
  });

  test('is idempotent (second register returns already_known=true)', async ({ server }) => {
    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Create a signature for balance=0
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const registerBody = {
      channel_id: channel.channelId,
      balance: 0,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    };

    // First registration
    const response1 = await fetch(`${server.baseUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerBody),
    });
    expect(response1.status).toBe(200);
    const result1 = await response1.json();
    expect(result1.already_known).toBe(false);
    console.log(`First register: already_known=${result1.already_known}`);

    // Second registration (should be idempotent)
    const response2 = await fetch(`${server.baseUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerBody),
    });
    expect(response2.status).toBe(200);
    const result2 = await response2.json();
    expect(result2.success).toBe(true);
    expect(result2.already_known).toBe(true);
    console.log(`Second register: already_known=${result2.already_known}`);
  });

  test('rejects registration with non-zero balance', async ({ server }) => {
    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Create a signature for balance=5 (not 0)
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(5)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const response = await fetch(`${server.baseUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: channel.channelId,
        balance: 5,
        signature: balanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });

    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Bad request');
    expect(result.reason).toContain('balance=0');
    console.log(`Rejected non-zero balance: ${result.reason}`);
  });

  test('rejects registration with invalid signature', async ({ server }) => {
    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Use a fake signature
    const fakeSignature = 'a'.repeat(128); // 64 bytes hex = 128 chars

    const response = await fetch(`${server.baseUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: channel.channelId,
        balance: 0,
        signature: fakeSignature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });

    expect(response.status).toBe(402);
    const result = await response.json();
    expect(result.success).toBe(false);
    expect(result.reason).toContain('signature');
    console.log(`Rejected invalid signature: ${result.reason}`);
  });

  test('allows subsequent payments on pre-registered channel', async ({ server }) => {
    // Upload a blob first
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Register with balance=0
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const registerResponse = await fetch(`${server.baseUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: channel.channelId,
        balance: 0,
        signature: balanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });
    expect(registerResponse.status).toBe(200);
    console.log(`Channel registered`);

    // Now make a payment (without params/funding_proofs since already registered)
    const paymentBalanceJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const paymentBalance = JSON.parse(paymentBalanceJson);

    const paymentHeader = encodePaymentHeader({
      channel_id: paymentBalance.channel_id,
      balance: paymentBalance.amount,
      signature: paymentBalance.signature,
      // No params or funding_proofs - already registered!
    });

    const blobResponse = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(blobResponse.status).toBe(200);
    const responseHeader = blobResponse.headers.get('X-Cashu-Channel');
    expect(responseHeader).toBeTruthy();
    const headerData = JSON.parse(responseHeader!);
    expect(headerData.channel_id).toBe(channel.channelId);
    expect(headerData.balance).toBe(1);
    console.log(`Payment succeeded on pre-registered channel: balance=${headerData.balance}, amount_due=${headerData.amount_due}`);
  });

  test('rejects registration with missing fields', async ({ server }) => {
    const response = await fetch(`${server.baseUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: 'test',
        balance: 0,
        // missing signature, params, funding_proofs
      }),
    });

    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Bad request');
    expect(result.reason).toContain('missing');
    console.log(`Rejected missing fields: ${result.reason}`);
  });
});
