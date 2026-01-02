import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import * as secp from '@noble/secp256k1';

// Import WASM functions
import {
  compute_shared_secret,
  channel_parameters_get_channel_id,
  create_funding_outputs,
  construct_proofs,
  spilman_channel_sender_create_signed_balance_update,
} from '../src/wasm/cdk_wasm.js';

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const MINT_URL = 'http://localhost:3338';

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

// Helper to mint a funded channel - returns everything needed to make payments
async function mintFundedChannel() {
  // Get channel params from server
  const paramsRes = await fetch(`${BASE_URL}/channel/params`);
  const serverParams = await paramsRes.json();
  const charliePubkey = serverParams.receiver_pubkey;

  // Get first available mint and keyset
  const mintUrl = Object.keys(serverParams.mints_units_keysets)[0];
  const units = serverParams.mints_units_keysets[mintUrl];
  const unit = Object.keys(units)[0];
  const keysetId = units[unit][0];

  // Generate Alice's keypair
  const alice = generateKeypair();

  // Fetch keyset info from mint
  const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);

  // Build channel parameters
  const setupTimestamp = Math.floor(Date.now() / 1000);
  const locktime = setupTimestamp + 7 * 24 * 60 * 60;
  const senderNonce = randomBytes(32).toString('hex');
  const capacity = 100;

  const channelParams = {
    mint: mintUrl,
    unit: unit,
    capacity: capacity,
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
  const sharedSecret = compute_shared_secret(alice.secretHex, charliePubkey);
  const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret);

  return {
    alice,
    channelParams,
    channelParamsJson,
    channelId,
    sharedSecret,
    proofs,
    keysetInfo,
    capacity,
  };
}

describe('New channel payment', () => {
  it('accepts valid payment on new channel and serves blob', async () => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${BASE_URL}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Step 2: Mint a funded channel
    const channel = await mintFundedChannel();
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);
    console.log(`Channel capacity: ${channel.capacity} sats`);

    // Step 3: Create a balance update (paying 1 sat for this request)
    const balance = 1;
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(balance)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);
    console.log(`Signed balance update: balance=${balanceUpdate.amount}, sig=${balanceUpdate.signature.substring(0, 16)}...`);

    // Step 4: Request the blob with payment header
    // First request includes params and funding_proofs to establish the channel
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const response = await fetch(`${BASE_URL}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    console.log(`Response status: ${response.status}`);

    expect(response.status).toBe(200);
    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(content)).toBe(true);
    console.log('Blob content verified ✓');
  });

  it('returns 402 without payment, then 200 with valid payment', async () => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${BASE_URL}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Step 2: Request blob WITHOUT payment - should get 402
    const noPaymentResponse = await fetch(`${BASE_URL}/${hash}`);
    expect(noPaymentResponse.status).toBe(402);
    const channelHeader = noPaymentResponse.headers.get('X-Cashu-Channel');
    expect(channelHeader).toBeDefined();
    const headerData = JSON.parse(channelHeader!);
    expect(headerData.error).toBe('missing');
    expect(headerData.size).toBe(content.length);
    console.log(`Got 402 without payment ✓ (size=${headerData.size})`);

    // Step 3: Mint a funded channel
    const channel = await mintFundedChannel();
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Step 4: Create a balance update
    const balance = 1;
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(balance)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Step 5: Retry WITH payment - should get 200
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const paidResponse = await fetch(`${BASE_URL}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    expect(paidResponse.status).toBe(200);
    const fetched = Buffer.from(await paidResponse.arrayBuffer());
    expect(fetched.equals(content)).toBe(true);
    console.log('Got 200 with payment, blob content verified ✓');
  });

  it('returns 402 when DLEQ proof is tampered', async () => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${BASE_URL}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Step 2: Mint a funded channel
    const channel = await mintFundedChannel();
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Step 3: Tamper with a DLEQ proof
    const tamperedProofs = JSON.parse(JSON.stringify(channel.proofs));
    const originalE = tamperedProofs[0].dleq.e;
    tamperedProofs[0].dleq.e = originalE.slice(0, -1) + (originalE.slice(-1) === 'a' ? 'b' : 'a');
    console.log(`Tampered DLEQ e: ${originalE.substring(0, 16)}... -> ${tamperedProofs[0].dleq.e.substring(0, 16)}...`);

    // Step 4: Create a balance update with tampered proofs
    const balance = 1;
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(tamperedProofs),
      BigInt(balance)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Step 5: Request the blob with tampered payment
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: tamperedProofs,
    });

    const response = await fetch(`${BASE_URL}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    console.log(`Response status: ${response.status}`);
    expect(response.status).toBe(402);

    // Check the error details
    const channelHeader = response.headers.get('X-Cashu-Channel');
    expect(channelHeader).toBeDefined();
    const headerData = JSON.parse(channelHeader!);
    console.log(`X-Cashu-Channel: ${JSON.stringify(headerData)}`);

    expect(headerData.error).toBe('channel validation failed');
    expect(headerData.validation_errors).toBeDefined();
    expect(headerData.validation_errors.length).toBeGreaterThan(0);
    expect(headerData.validation_errors[0].type).toBe('InvalidDleq');
    console.log('Tampered DLEQ rejected with 402 ✓');
  });
});
