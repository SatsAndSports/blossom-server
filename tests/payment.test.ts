import { test, describe, expect } from './fixtures';
import { createHash, randomBytes } from 'crypto';
import * as secp from '@noble/secp256k1';

// Import WASM functions
import {
  compute_shared_secret,
  channel_parameters_get_channel_id,
  create_funding_outputs,
  construct_proofs,
  spilman_channel_sender_create_signed_balance_update,
  get_sender_blinded_secret_key_for_stage2_output,
} from '../src/wasm/cdk_wasm.js';



// Generate a random keypair for Alice
function generateKeypair(): { secretHex: string; pubkeyHex: string } {
  const secretBytes = randomBytes(32);
  const secretHex = secretBytes.toString('hex');
  const pubkeyBytes = secp.getPublicKey(secretBytes, true); // compressed
  const pubkeyHex = Buffer.from(pubkeyBytes).toString('hex');
  return { secretHex, pubkeyHex };
}

// Derive compressed pubkey from secret key
function secretKeyToPubkey(secretHex: string): string {
  const secretBytes = Buffer.from(secretHex, 'hex');
  const pubkeyBytes = secp.getPublicKey(secretBytes, true); // compressed
  return Buffer.from(pubkeyBytes).toString('hex');
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
}

// Helper to mint a funded channel - returns everything needed to make payments
// maximumAmount defaults to 64 for backwards compatibility with existing tests
async function mintFundedChannel(server: Server, unit: string, maximumAmount: number = 64) {
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

  const channelParams = {
    mint: mintUrl,
    unit: unit,
    capacity: capacity,
    keyset_id: keysetId,
    input_fee_ppk: keysetInfo.inputFeePpk,
    maximum_amount: maximumAmount,
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
  const keysetInfoJson = JSON.stringify(keysetInfo);
  const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret, keysetInfoJson);

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
  test('accepts valid payment on new channel and serves blob', async ({ server }) => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Step 2: Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
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

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    console.log(`Response status: ${response.status}`);

    expect(response.status).toBe(200);
    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(content)).toBe(true);
    console.log('Blob content verified ✓');

    // Verify response header
    const responseHeader = response.headers.get('X-Cashu-Channel');
    expect(responseHeader).toBeTruthy();
    const headerData = JSON.parse(responseHeader!);
    expect(headerData.channel_id).toBe(channel.channelId);
    expect(headerData.balance).toBe(balance);
    expect(headerData.amount_due).toBe(server.getAmountDue('sat', 1, content.length));
    expect(headerData.capacity).toBe(channel.capacity);
    expect(headerData.size).toBe(content.length);
    console.log(`Response header: channel_id=${headerData.channel_id.substring(0, 8)}... balance=${headerData.balance} amount_due=${headerData.amount_due} capacity=${headerData.capacity} size=${headerData.size} ✓`);
  });

  test('response header shows balance higher than amount_due when pre-paying', async ({ server }) => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);

    // Step 2: Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Step 3: Create a balance update with pre-payment (10 sats, but only need 1)
    const balance = 10;
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(balance)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Step 4: Request the blob with pre-payment
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    expect(response.status).toBe(200);

    // Verify response header shows balance > amount_due
    const responseHeader = response.headers.get('X-Cashu-Channel');
    expect(responseHeader).toBeTruthy();
    const headerData = JSON.parse(responseHeader!);

    const expectedAmountDue = server.getAmountDue('sat', 1, content.length);
    expect(headerData.balance).toBe(balance);  // 10 (what client sent)
    expect(headerData.amount_due).toBe(expectedAmountDue);  // 1 (what server charged)
    expect(headerData.balance).toBeGreaterThan(headerData.amount_due);

    console.log(`Pre-payment: balance=${headerData.balance} amount_due=${headerData.amount_due} (credit=${headerData.balance - headerData.amount_due}) ✓`);
  });

  test('accepts valid payment with usd channel', async ({ server }) => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Step 2: Mint a funded channel with USD
    const channel = await mintFundedChannel(server, 'usd');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);
    console.log(`Channel unit: ${channel.channelParams.unit}`);

    // Step 3: Create a balance update (paying 1 cent for this request)
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
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    console.log(`Response status: ${response.status}`);

    expect(response.status).toBe(200);
    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(content)).toBe(true);
    console.log('USD channel payment accepted ✓');
  });

  test('accepts multiple payments with msat channel', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Mint a funded channel with msat
    const channel = await mintFundedChannel(server, 'msat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);
    console.log(`Channel unit: ${channel.channelParams.unit}`);
    console.log(`Channel capacity: ${channel.capacity} msat`);

    // Make 20 requests to test msat payments
    // Each request uses the precise amount_due for that many blobs/bytes
    // Before each valid payment, attempt with 1 msat too few (if amount_due >= 1)
    for (let i = 1; i <= 20; i++) {
      const balance = server.getAmountDue('msat', i, content.length * i);

      // Attempt payment with 1 msat too few (should get 402 insufficient balance)
      if (balance >= 1) {
        const insufficientBalance = balance - 1;
        const insufficientBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
          channel.channelParamsJson,
          JSON.stringify(channel.keysetInfo),
          channel.alice.secretHex,
          JSON.stringify(channel.proofs),
          BigInt(insufficientBalance)
        );
        const insufficientBalanceUpdate = JSON.parse(insufficientBalanceUpdateJson);

        const insufficientPaymentHeader = JSON.stringify({
          channel_id: insufficientBalanceUpdate.channel_id,
          balance: insufficientBalance,
          signature: insufficientBalanceUpdate.signature,
          // Only send params/funding_proofs on first request
          ...(i === 1 ? { params: channel.channelParams, funding_proofs: channel.proofs } : {}),
        });

        const insufficientResponse = await fetch(`${server.baseUrl}/${hash}`, {
          headers: { 'X-Cashu-Channel': insufficientPaymentHeader },
        });
        expect(insufficientResponse.status).toBe(402);
        const errorHeader = JSON.parse(insufficientResponse.headers.get('X-Cashu-Channel')!);
        expect(errorHeader.error).toContain('insufficient balance');
      }

      // Now make the valid payment
      const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
        channel.channelParamsJson,
        JSON.stringify(channel.keysetInfo),
        channel.alice.secretHex,
        JSON.stringify(channel.proofs),
        BigInt(balance)
      );
      const balanceUpdate = JSON.parse(balanceUpdateJson);

      const paymentHeader = JSON.stringify({
        channel_id: balanceUpdate.channel_id,
        balance: balance,
        signature: balanceUpdate.signature,
        // Only send params/funding_proofs on first request (but we may have sent them in the insufficient attempt)
        ...(i === 1 ? { params: channel.channelParams, funding_proofs: channel.proofs } : {}),
      });

      const response = await fetch(`${server.baseUrl}/${hash}`, {
        headers: { 'X-Cashu-Channel': paymentHeader },
      });
      expect(response.status).toBe(200);
    }
    console.log(`Made 20 msat blob requests (with insufficient balance checks) ✓`);

    // Get final status
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status = await statusResponse.json();
    console.log(`Final status: amount_due=${status.amount_due} balance=${status.balance} msat`);
    expect(status.amount_due).toBeGreaterThan(0);

    // Close the channel
    const closeBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(status.amount_due)
    );
    const closeBalanceUpdate = JSON.parse(closeBalanceUpdateJson);

    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: status.amount_due,
        signature: closeBalanceUpdate.signature,
      }),
    });

    expect(closeResponse.status).toBe(200);
    const closeResult = await closeResponse.json();
    console.log(`Close result: success=${closeResult.success} total_value=${closeResult.total_value}`);
    expect(closeResult.success).toBe(true);
    console.log('msat channel payment + close accepted ✓');
  });

  test('returns 402 without payment, then 200 with valid payment', async ({ server }) => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Step 2: Request blob WITHOUT payment - should get 402
    const noPaymentResponse = await fetch(`${server.baseUrl}/${hash}`);
    expect(noPaymentResponse.status).toBe(402);
    const channelHeader = noPaymentResponse.headers.get('X-Cashu-Channel');
    expect(channelHeader).toBeDefined();
    const headerData = JSON.parse(channelHeader!);
    expect(headerData.error).toBe('missing');
    expect(headerData.size).toBe(content.length);
    console.log(`Got 402 without payment ✓ (size=${headerData.size})`);

    // Step 3: Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
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

    const paidResponse = await fetch(`${server.baseUrl}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    expect(paidResponse.status).toBe(200);
    const fetched = Buffer.from(await paidResponse.arrayBuffer());
    expect(fetched.equals(content)).toBe(true);
    console.log('Got 200 with payment, blob content verified ✓');
  });

  test('returns 402 when DLEQ proof is tampered', async ({ server }) => {
    // Step 1: Upload a blob
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);
    console.log(`Uploaded blob: ${hash.substring(0, 16)}... (${content.length} bytes)`);

    // Step 2: Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
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

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: {
        'X-Cashu-Channel': paymentHeader,
      },
    });

    console.log(`Response status: ${response.status}`);
    expect(response.status).toBe(402);
    const headerData = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(headerData.error).toContain('channel validation failed');
    console.log(`Response status: 402`);
    console.log(`X-Cashu-Channel: ${JSON.stringify(headerData)}`);

    expect(headerData.error).toContain('channel validation failed');
    expect(headerData.validation_errors).toBeDefined();
    expect(headerData.validation_errors.length).toBeGreaterThan(0);

    expect(headerData.validation_errors[0].type).toBe('InvalidDleq');
    console.log('Tampered DLEQ rejected with 402 ✓');
  });

  test('returns 402 when proof amount has no mint key', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Tamper with proof amount to a non-existent denomination
    const tamperedProofs = JSON.parse(JSON.stringify(channel.proofs));
    const originalAmount = tamperedProofs[0].amount;
    tamperedProofs[0].amount = 3;  // Not a power of 2, no mint key exists
    console.log(`Tampered amount: ${originalAmount} -> 3`);

    // Send directly with tampered proofs - server will fail on channel validation
    // before checking signature, so we can use a fake signature
    const paymentHeader = JSON.stringify({
      channel_id: channel.channelId,
      balance: 1,
      signature: 'fake_signature',
      params: channel.channelParams,
      funding_proofs: tamperedProofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const headerData = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(headerData.error).toContain('channel validation failed');
    expect(headerData.validation_errors).toBeDefined();
    expect(headerData.validation_errors[0].type).toBe('MissingMintKey');
    console.log('MissingMintKey (invalid amount): 402 ✓');
  });
});

describe('Payment header validation', () => {
  test('returns 402 for invalid or missing header fields', async ({ server }) => {
    // Upload a blob to test against
    const { content, hash } = generateBlob();
    const uploadRes = await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadRes.status).toBe(200);

    const testCases402 = [
      {
        name: 'missing channel_id',
        header: JSON.stringify({ balance: 1, signature: 'def456' }),
        expectedError: 'channel_id',
      },
      {
        name: 'empty channel_id',
        header: JSON.stringify({ channel_id: '', balance: 1, signature: 'def456' }),
        expectedError: 'missing channel_id',
      },
      {
        name: 'non-string channel_id',
        header: JSON.stringify({ channel_id: 12345, balance: 1, signature: 'def456' }),
        expectedError: 'integer',
      },
      {
        name: 'missing balance',
        header: JSON.stringify({ channel_id: 'abc123', signature: 'def456' }),
        expectedError: 'balance',
      },
      {
        name: 'non-integer balance',
        header: JSON.stringify({ channel_id: 'abc123', balance: 1.5, signature: 'def456' }),
        expectedError: 'u64',
      },
      {
        name: 'missing signature',
        header: JSON.stringify({ channel_id: 'abc123', balance: 1 }),
        expectedError: 'signature',
      },
      {
        name: 'empty signature',
        header: JSON.stringify({ channel_id: 'abc123', balance: 1, signature: '' }),
        expectedError: 'signature',
      },
      {
        name: 'non-string signature',
        header: JSON.stringify({ channel_id: 'abc123', balance: 1, signature: 12345 }),
        expectedError: 'string',
      },
    ];

    for (const tc of testCases402) {
      const response = await fetch(`${server.baseUrl}/${hash}`, {
        headers: { 'X-Cashu-Channel': tc.header },
      });

      expect(response.status, `${tc.name}: expected 402`).toBe(402);

      const channelHeader = response.headers.get('X-Cashu-Channel');
      expect(channelHeader, `${tc.name}: expected X-Cashu-Channel header`).toBeDefined();

      const headerData = JSON.parse(channelHeader!);
      expect(headerData.error, `${tc.name}: wrong error`).toContain(tc.expectedError);
      expect(headerData.size, `${tc.name}: expected size`).toBe(content.length);

      console.log(`${tc.name}: 402 with error="${headerData.error}" ✓`);
    }

    const testCases400 = [
      {
        name: 'invalid JSON',
        header: 'not-json',
        expectedError: 'Invalid payment header',
      },
    ];

    for (const tc of testCases400) {
      const response = await fetch(`${server.baseUrl}/${hash}`, {
        headers: { 'X-Cashu-Channel': tc.header },
      });

      expect(response.status, `${tc.name}: expected 400`).toBe(400);
      const body = await response.json();
      expect(body.error).toBe(tc.expectedError);
      console.log(`${tc.name}: 400 with error="${body.error}" ✓`);
    }

  });
});

describe('Channel validation errors', () => {
  test('returns 402 when channel_id does not match params', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Create a valid balance update
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Tamper with the channel_id (flip last character)
    const tamperedChannelId = balanceUpdate.channel_id.slice(0, -1) +
      (balanceUpdate.channel_id.slice(-1) === 'a' ? 'b' : 'a');

    const paymentHeader = JSON.stringify({
      channel_id: tamperedChannelId,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const headerData = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(headerData.error).toBe('channel_id mismatch');
    console.log('channel_id mismatch: 402 ✓');
  });

  test('returns 402 for unknown channel', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Send payment header with random channel_id (no params/funding_proofs)
    const paymentHeader = JSON.stringify({
      channel_id: randomBytes(32).toString('hex'),
      balance: 1,
      signature: 'fake_signature',
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const headerData = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(headerData.error).toBe('unknown channel');
    console.log('unknown channel: 402 ✓');
  });

  test('returns 402 when keyset is not from approved mint', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Tamper with keyset_id in params - use a keyset that's not from an approved mint
    const tamperedParams = { ...channel.channelParams, keyset_id: '00deadbeef123456' };

    // Use a fake channel_id - the server will reject based on unknown keyset 
    // before it even checks the channel_id
    const paymentHeader = JSON.stringify({
      channel_id: 'aaaa' + channel.channelId.substring(4),  // fake channel_id
      balance: 1,
      signature: 'fake_signature',  // Won't get this far anyway
      params: tamperedParams,
      funding_proofs: channel.proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const headerData = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(headerData.error).toBe('mint or keyset not acceptable');
    console.log('mint or keyset not acceptable: 402 ✓');
  });

  test('returns 402 when channel capacity is too small', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Get server's min_capacity
    const minCapacity = server.getMinCapacity('sat');
    const tooSmallCapacity = minCapacity - 1;
    console.log(`Server min_capacity=${minCapacity}, using capacity=${tooSmallCapacity}`);

    // Generate Alice's keypair
    const alice = generateKeypair();

    // Get keyset for sat
    const mintUrl = server.mintUrl;
    const unitKeysets = server.channelParams.mints_units_keysets[mintUrl]?.['sat'];
    if (!unitKeysets || unitKeysets.length === 0) {
      throw new Error(`No keyset found for unit "sat" at ${mintUrl}`);
    }
    const keysetId = unitKeysets[0];
    const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);

    // Build channel parameters with capacity below minimum
    const setupTimestamp = Math.floor(Date.now() / 1000);
    const locktime = setupTimestamp + 7 * 24 * 60 * 60;
    const senderNonce = randomBytes(32).toString('hex');

    const channelParams = {
      mint: mintUrl,
      unit: 'sat',
      capacity: tooSmallCapacity,  // Below min_capacity!
      keyset_id: keysetId,
      input_fee_ppk: keysetInfo.inputFeePpk,
      maximum_amount: 64,
      setup_timestamp: setupTimestamp,
      alice_pubkey: alice.pubkeyHex,
      charlie_pubkey: server.channelParams.receiver_pubkey,
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
        unit: 'sat',
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
    const sharedSecret = compute_shared_secret(alice.secretHex, server.channelParams.receiver_pubkey);
    const keysetInfoJson = JSON.stringify(keysetInfo);
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret, keysetInfoJson);

    // Create balance update
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channelParamsJson,
      JSON.stringify(keysetInfo),
      alice.secretHex,
      JSON.stringify(proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Send payment with low-capacity channel
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channelParams,
      funding_proofs: proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const errorHeader = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(errorHeader.error).toContain('capacity too small');
    expect(errorHeader.capacity).toBe(tooSmallCapacity);
    expect(errorHeader.min_capacity).toBe(minCapacity);
    console.log(`capacity too small: 402 (capacity=${errorHeader.capacity} < min_capacity=${errorHeader.min_capacity}) ✓`);
  });

  test('returns 402 when channel locktime is too soon', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Get server's min_expiry_in_seconds
    const minExpiryInSeconds = server.channelParams.min_expiry_in_seconds;
    const tooSoonLocktime = Math.floor(Date.now() / 1000) + 60; // Only 1 minute from now
    console.log(`Server min_expiry_in_seconds=${minExpiryInSeconds}, using locktime=${tooSoonLocktime} (60s from now)`);

    // Generate Alice's keypair
    const alice = generateKeypair();

    // Get keyset for sat
    const mintUrl = server.mintUrl;
    const unitKeysets = server.channelParams.mints_units_keysets[mintUrl]?.['sat'];
    if (!unitKeysets || unitKeysets.length === 0) {
      throw new Error(`No keyset found for unit "sat" at ${mintUrl}`);
    }
    const keysetId = unitKeysets[0];
    const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);

    // Build channel parameters with locktime too soon
    const setupTimestamp = Math.floor(Date.now() / 1000);
    const senderNonce = randomBytes(32).toString('hex');

    const channelParams = {
      mint: mintUrl,
      unit: 'sat',
      capacity: 100,
      keyset_id: keysetId,
      input_fee_ppk: keysetInfo.inputFeePpk,
      maximum_amount: 64,
      setup_timestamp: setupTimestamp,
      alice_pubkey: alice.pubkeyHex,
      charlie_pubkey: server.channelParams.receiver_pubkey,
      locktime: tooSoonLocktime,  // Too soon!
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
        unit: 'sat',
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
    const sharedSecret = compute_shared_secret(alice.secretHex, server.channelParams.receiver_pubkey);
    const keysetInfoJson = JSON.stringify(keysetInfo);
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret, keysetInfoJson);

    // Create balance update
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channelParamsJson,
      JSON.stringify(keysetInfo),
      alice.secretHex,
      JSON.stringify(proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Send payment with too-soon locktime
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channelParams,
      funding_proofs: proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const errorHeader = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(errorHeader.error).toContain('locktime too soon');
    expect(errorHeader.locktime).toBe(tooSoonLocktime);
    expect(errorHeader.min_expiry_in_seconds).toBe(minExpiryInSeconds);
    expect(errorHeader.seconds_remaining).toBeLessThan(minExpiryInSeconds);
    console.log(`locktime too soon: 402 (locktime=${errorHeader.locktime}, seconds_remaining=${errorHeader.seconds_remaining}, need ${errorHeader.min_expiry_in_seconds}s) ✓`);
  });

  test('returns 402 when maximum_amount exceeds server limit', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // USD has maxAmountPerOutput: 1048576 (2^20) configured in test config
    // Create a channel with maximum_amount: 2097152 (2^21) to exceed the limit
    const exceedingMaxAmount = 2097152;  // 2^21
    const serverLimit = 1048576;  // 2^20 as configured in test config
    console.log(`Server maxAmountPerOutput=${serverLimit}, using maximum_amount=${exceedingMaxAmount}`);

    // Mint a funded channel with excessive maximum_amount
    const channel = await mintFundedChannel(server, 'usd', exceedingMaxAmount);

    // Create a balance update
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Try to make a payment - should get 402
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: 1,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const errorHeader = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(errorHeader.error).toContain('max_amount_per_output exceeded');
    expect(errorHeader.maximum_amount).toBe(exceedingMaxAmount);
    expect(errorHeader.max_allowed).toBe(serverLimit);
    console.log(`max_amount_per_output exceeded: 402 (maximum_amount=${errorHeader.maximum_amount} > max_allowed=${errorHeader.max_allowed}) ✓`);
  });

  test('returns 402 when signature does not match balance', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Create a valid balance update for balance=1
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Send with balance=2 but signature for balance=1
    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: 2,  // Wrong balance!
      signature: balanceUpdate.signature,  // Signature is for balance=1
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const headerData = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(headerData.error).toContain('invalid signature');
    console.log('invalid signature (balance mismatch): 402 ✓');
  });

  test('returns 402 when balance exceeds capacity', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel (capacity = 100)
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel capacity: ${channel.capacity}`);

    // First, establish the channel with a valid payment
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // Establish channel with valid payment
    const establishRes = await fetch(`${server.baseUrl}/${hash}`, {
      headers: {
        'X-Cashu-Channel': JSON.stringify({
          channel_id: balanceUpdate.channel_id,
          balance: balanceUpdate.amount,
          signature: balanceUpdate.signature,
          params: channel.channelParams,
          funding_proofs: channel.proofs,
        }),
      },
    });
    expect(establishRes.status).toBe(200);

    // Now send a request with balance exceeding capacity (fake signature is fine
    // because capacity check happens before signature verification)
    const paymentHeader = JSON.stringify({
      channel_id: channel.channelId,
      balance: 101,  // Exceeds capacity of 100
      signature: 'fake_signature',
    });

    const response = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(response.status).toBe(402);
    const headerData = JSON.parse(response.headers.get('X-Cashu-Channel')!);
    expect(headerData.error).toContain('balance exceeds capacity');
    expect(headerData.capacity).toBe(100);
    expect(headerData.balance).toBe(101);
    console.log('balance exceeds capacity: 402 ✓');
  });
});

describe('Channel closing', () => {
  test('closes unused channel and verifies sender can derive secret keys for returned proofs', async ({ server }) => {
    // Alice mints a funded channel but never uses it
    // She can close immediately with balance=0
    // After close, she should be able to derive the secret key for each returned proof
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Create a balance update for balance=0 (closing unused channel)
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);
    console.log(`Signed balance update for close: balance=0`);

    // Close the channel (server doesn't know about it yet, so include params and funding_proofs)
    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: balanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });

    console.log(`Close response status: ${closeResponse.status}`);
    expect(closeResponse.status).toBe(200);

    const closeResult = await closeResponse.json();
    console.log(`Close result: success=${closeResult.success} total_value=${closeResult.total_value}`);
    expect(closeResult.success).toBe(true);
    expect(closeResult.channel_id).toBe(channel.channelId);
    // total_value should be the full channel capacity minus fees
    expect(closeResult.total_value).toBeGreaterThan(0);
    // sender_proofs should be returned (Alice's change - full capacity since balance=0)
    expect(closeResult.sender_proofs).toBeDefined();
    expect(Array.isArray(closeResult.sender_proofs)).toBe(true);
    expect(closeResult.sender_proofs.length).toBeGreaterThan(0);
    // Each proof should have required fields
    for (const proof of closeResult.sender_proofs) {
      expect(proof.amount).toBeDefined();
      expect(proof.id).toBeDefined();
      expect(proof.secret).toBeDefined();
      expect(proof.C).toBeDefined();
    }
    const senderSum = closeResult.sender_proofs.reduce((sum: number, p: any) => sum + p.amount, 0);
    console.log(`Channel closed with total_value=${closeResult.total_value}, sender_proofs=${closeResult.sender_proofs.length} (sum=${senderSum}) ✓`);

    // Verify Alice can derive the secret key for each sender_proof
    // The proofs are sorted smallest-amount-first, then by index within each amount
    const indexByAmount: Record<number, number> = {};
    for (const proof of closeResult.sender_proofs) {
      const amount = proof.amount;
      const index = indexByAmount[amount] ?? 0;
      indexByAmount[amount] = index + 1;

      // Get Alice's blinded secret key for this specific output
      const blindedSecretHex = get_sender_blinded_secret_key_for_stage2_output(
        channel.channelParamsJson,
        JSON.stringify(channel.keysetInfo),
        channel.alice.secretHex,
        BigInt(amount),
        index
      );

      // Derive pubkey from the secret key
      const derivedPubkey = secretKeyToPubkey(blindedSecretHex);

      // Parse the P2PK secret from the proof to get the locked pubkey
      // Secret format is: ["P2PK", {"nonce": "...", "data": "pubkey_hex", ...}]
      const secretArr = JSON.parse(proof.secret);
      expect(Array.isArray(secretArr)).toBe(true);
      expect(secretArr[0]).toBe('P2PK');
      const lockedPubkey = secretArr[1].data;

      // Verify they match
      expect(derivedPubkey).toBe(lockedPubkey);
    }
    console.log(`Alice can derive secret keys for all ${closeResult.sender_proofs.length} sender_proofs ✓`);

    // Verify status shows closed=true and closed_amount=0 after close
    const statusAfter = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const statusAfterJson = await statusAfter.json();
    console.log(`Status after close: closed=${statusAfterJson.closed} closed_amount=${statusAfterJson.closed_amount}`);
    expect(statusAfterJson.closed).toBe(true);
    expect(statusAfterJson.closed_amount).toBe(0);
  });

  test('closes channel with multiple payments ensuring receiver gets proofs', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Make 20 requests to accumulate a higher amount_due
    // Each request uses the precise amount_due for that many blobs/bytes
    // Before each valid payment, attempt with 1 sat too few (if amount_due >= 1)
    for (let i = 1; i <= 20; i++) {
      const balance = server.getAmountDue('sat', i, content.length * i);

      // Attempt payment with 1 sat too few (should get 402 insufficient balance)
      if (balance >= 1) {
        const insufficientBalance = balance - 1;
        const insufficientBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
          channel.channelParamsJson,
          JSON.stringify(channel.keysetInfo),
          channel.alice.secretHex,
          JSON.stringify(channel.proofs),
          BigInt(insufficientBalance)
        );
        const insufficientBalanceUpdate = JSON.parse(insufficientBalanceUpdateJson);

        const insufficientPaymentHeader = JSON.stringify({
          channel_id: insufficientBalanceUpdate.channel_id,
          balance: insufficientBalance,
          signature: insufficientBalanceUpdate.signature,
          // Only send params/funding_proofs on first request
          ...(i === 1 ? { params: channel.channelParams, funding_proofs: channel.proofs } : {}),
        });

        const insufficientResponse = await fetch(`${server.baseUrl}/${hash}`, {
          headers: { 'X-Cashu-Channel': insufficientPaymentHeader },
        });
        expect(insufficientResponse.status).toBe(402);
        const errorHeader = JSON.parse(insufficientResponse.headers.get('X-Cashu-Channel')!);
        expect(errorHeader.error).toContain('insufficient balance');
      }

      // Now make the valid payment
      const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
        channel.channelParamsJson,
        JSON.stringify(channel.keysetInfo),
        channel.alice.secretHex,
        JSON.stringify(channel.proofs),
        BigInt(balance)
      );
      const balanceUpdate = JSON.parse(balanceUpdateJson);

      const paymentHeader = JSON.stringify({
        channel_id: balanceUpdate.channel_id,
        balance: balance,
        signature: balanceUpdate.signature,
        // Only send params/funding_proofs on first request (but we may have sent them in the insufficient attempt)
        ...(i === 1 ? { params: channel.channelParams, funding_proofs: channel.proofs } : {}),
      });

      const response = await fetch(`${server.baseUrl}/${hash}`, {
        headers: { 'X-Cashu-Channel': paymentHeader },
      });
      expect(response.status).toBe(200);
    }
    console.log(`Made 20 blob requests (with insufficient balance checks) ✓`);

    // Get amount_due
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status = await statusResponse.json();
    const amountDue = status.amount_due;
    console.log(`Status before close: amount_due=${amountDue} balance=${status.balance}`);
    expect(amountDue).toBeGreaterThan(0);

    // Close with amount_due - this triggers unblind_and_verify_dleq which logs receiver proof verification
    const closeBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(amountDue)
    );
    const closeBalanceUpdate = JSON.parse(closeBalanceUpdateJson);

    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: amountDue,
        signature: closeBalanceUpdate.signature,
      }),
    });

    expect(closeResponse.status).toBe(200);
    const closeResult = await closeResponse.json();
    console.log(`Close result: success=${closeResult.success} total_value=${closeResult.total_value}`);
    expect(closeResult.success).toBe(true);

    // Verify receiver got proofs (Charlie's proofs from the payment)
    // The receiver_proofs are not returned in the response, but the server verifies them internally
    // and logs [RECEIVER PROOF VERIFY] lines for each one
    expect(closeResult.sender_proofs).toBeDefined();
    expect(Array.isArray(closeResult.sender_proofs)).toBe(true);

    // The key verification is in the server logs - [RECEIVER PROOF VERIFY] lines
    // will show for each receiver proof with amount, index, expected_pubkey, observed_pubkey
    console.log(`Channel closed - check server logs above for [RECEIVER PROOF VERIFY] lines ✓`);
  });

  test('closes a channel after usage (known channel)', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Make a payment (balance=1)
    const balanceUpdate1Json = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate1 = JSON.parse(balanceUpdate1Json);

    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate1.channel_id,
      balance: balanceUpdate1.amount,
      signature: balanceUpdate1.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const blobResponse = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });
    expect(blobResponse.status).toBe(200);
    console.log(`Blob fetched with balance=1 ✓`);

    // Get current amount_due from status (before close)
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status = await statusResponse.json();
    const amountDue = status.amount_due;
    console.log(`Status before close: amount_due=${amountDue} closed=${status.closed}`);
    expect(status.closed).toBe(false);

    // Create balance update for closing (balance = amount_due)
    const closeBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(amountDue)
    );
    const closeBalanceUpdate = JSON.parse(closeBalanceUpdateJson);

    // Close the channel (server already knows about it, so no need for params/funding_proofs)
    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: amountDue,
        signature: closeBalanceUpdate.signature,
      }),
    });

    console.log(`Close response status: ${closeResponse.status}`);
    expect(closeResponse.status).toBe(200);

    const closeResult = await closeResponse.json();
    console.log(`Close result: success=${closeResult.success} total_value=${closeResult.total_value}`);
    expect(closeResult.success).toBe(true);
    expect(closeResult.channel_id).toBe(channel.channelId);
    expect(closeResult.total_value).toBeGreaterThan(0);
    // sender_proofs should be returned (Alice's change)
    expect(closeResult.sender_proofs).toBeDefined();
    expect(Array.isArray(closeResult.sender_proofs)).toBe(true);
    // Since we used some balance, sender_proofs should have proofs (unless we used entire capacity)
    const senderSum = closeResult.sender_proofs.reduce((sum: number, p: any) => sum + p.amount, 0);
    console.log(`Channel closed with total_value=${closeResult.total_value}, sender_proofs=${closeResult.sender_proofs.length} (sum=${senderSum}) ✓`);

    // Verify status shows closed=true and closed_amount=amountDue after close
    const statusAfter = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const statusAfterJson = await statusAfter.json();
    console.log(`Status after close: closed=${statusAfterJson.closed} closed_amount=${statusAfterJson.closed_amount}`);
    expect(statusAfterJson.closed).toBe(true);
    expect(statusAfterJson.closed_amount).toBe(amountDue);
  });

  test('rejects close with balance less than amount_due', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel and make a payment
    const channel = await mintFundedChannel(server, 'sat');

    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    // Get amount_due
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status = await statusResponse.json();
    const amountDue = status.amount_due;
    console.log(`amount_due=${amountDue}`);

    // Try to close with balance=0 (less than amount_due)
    const zeroBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const zeroBalanceUpdate = JSON.parse(zeroBalanceUpdateJson);

    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: zeroBalanceUpdate.signature,
      }),
    });

    expect(closeResponse.status).toBe(400);
    const result = await closeResponse.json();
    expect(result.error).toBe('balance must equal amount_due for closing');
    expect(result.balance).toBe(0);
    expect(result.amount_due).toBe(amountDue);
    console.log(`Close rejected with balance < amount_due ✓`);
  });

  test('rejects close with nonzero balance of an unused channel', async ({ server }) => {
    // Mint a funded channel (no usage, so amount_due = 0)
    const channel = await mintFundedChannel(server, 'sat');

    // Create balance update for balance=10 (but amount_due is 0 since channel was never used)
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(10)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 10,
        signature: balanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });

    expect(closeResponse.status).toBe(400);
    const result = await closeResponse.json();
    expect(result.error).toBe('balance must equal amount_due for closing');
    expect(result.balance).toBe(10);
    expect(result.amount_due).toBe(0);
    console.log(`Close rejected with nonzero balance on unused channel ✓`);
  });

  test('rejects close with balance greater than amount_due on used channel', async ({ server }) => {
    // Mint a funded channel and upload a blob
    const channel = await mintFundedChannel(server, 'sat');
    const testData = Buffer.from('test blob for close overpayment test');
    const hash = createHash('sha256').update(testData).digest('hex');

    // Upload the blob
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': `Bearer ${server.adminAuth}`,
      },
      body: testData,
    });

    // Make a payment to create usage
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    // Get amount_due (should be 1)
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status = await statusResponse.json();
    const amountDue = status.amount_due;
    console.log(`amount_due=${amountDue}`);
    expect(amountDue).toBeGreaterThan(0);

    // Try to close with balance > amount_due
    const overpayBalance = amountDue + 5;
    const overpayBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(overpayBalance)
    );
    const overpayBalanceUpdate = JSON.parse(overpayBalanceUpdateJson);

    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: overpayBalance,
        signature: overpayBalanceUpdate.signature,
      }),
    });

    expect(closeResponse.status).toBe(400);
    const result = await closeResponse.json();
    expect(result.error).toBe('balance must equal amount_due for closing');
    expect(result.balance).toBe(overpayBalance);
    expect(result.amount_due).toBe(amountDue);
    console.log(`Close rejected with balance > amount_due on used channel ✓`);
  });

  test('rejects close with invalid signature', async ({ server }) => {
    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: 'invalid_signature_that_will_not_verify',
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });

    expect(closeResponse.status).toBe(402);
    const channelHeader = closeResponse.headers.get('X-Cashu-Channel');
    expect(channelHeader).toBeDefined();
    const headerData = JSON.parse(channelHeader!);
    expect(headerData.error).toContain('invalid signature');
    console.log(`Close rejected with invalid signature ✓`);
  });

  test('rejects close for unknown channel without params', async ({ server }) => {
    // Generate a random channel ID that the server doesn't know about
    const fakeChannelId = randomBytes(32).toString('hex');

    const closeResponse = await fetch(`${server.baseUrl}/channel/${fakeChannelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: 'any_signature',
        // No params or funding_proofs provided
      }),
    });

    expect(closeResponse.status).toBe(402);
    const channelHeader = closeResponse.headers.get('X-Cashu-Channel');
    expect(channelHeader).toBeDefined();
    const headerData = JSON.parse(channelHeader!);
    expect(headerData.error).toBe('unknown channel');
    console.log(`Close rejected for unknown channel without params ✓`);
  });

  test('idempotent close with same amount succeeds', async ({ server }) => {
    // Mint and close a channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Create balance update for balance=0
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    // First close
    const closeResponse1 = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: balanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });
    expect(closeResponse1.status).toBe(200);
    const closeResult1 = await closeResponse1.json();
    expect(closeResult1.success).toBe(true);
    expect(closeResult1.already_closed).toBe(false);
    expect(closeResult1.sender_proofs).toBeDefined();
    expect(Array.isArray(closeResult1.sender_proofs)).toBe(true);
    console.log(`First close succeeded: total_value=${closeResult1.total_value}, sender_proofs=${closeResult1.sender_proofs.length}`);

    // Second close with same amount - should succeed with already_closed=true and return same sender_proofs
    const closeResponse2 = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: balanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });
    expect(closeResponse2.status).toBe(200);
    const closeResult2 = await closeResponse2.json();
    expect(closeResult2.success).toBe(true);
    expect(closeResult2.already_closed).toBe(true);
    expect(closeResult2.total_value).toBe(closeResult1.total_value);
    // Idempotent close should return the same sender_proofs
    expect(closeResult2.sender_proofs).toBeDefined();
    expect(Array.isArray(closeResult2.sender_proofs)).toBe(true);
    expect(closeResult2.sender_proofs.length).toBe(closeResult1.sender_proofs.length);
    console.log(`Second close succeeded (idempotent): already_closed=true, sender_proofs=${closeResult2.sender_proofs.length} ✓`);
  });

  test('rejects close of already-closed channel with different amount', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint and use a channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Make a payment to establish usage
    const paymentBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const paymentBalanceUpdate = JSON.parse(paymentBalanceUpdateJson);

    const blobResponse = await fetch(`${server.baseUrl}/${hash}`, {
      headers: {
        'X-Cashu-Channel': JSON.stringify({
          channel_id: paymentBalanceUpdate.channel_id,
          balance: paymentBalanceUpdate.amount,
          signature: paymentBalanceUpdate.signature,
          params: channel.channelParams,
          funding_proofs: channel.proofs,
        }),
      },
    });
    expect(blobResponse.status).toBe(200);
    console.log(`Blob fetched with balance=1`);

    // Get amount_due
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status = await statusResponse.json();
    const amountDue = status.amount_due;
    console.log(`amount_due=${amountDue}`);

    // Close with correct amount_due
    const closeBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(amountDue)
    );
    const closeBalanceUpdate = JSON.parse(closeBalanceUpdateJson);

    const closeResponse1 = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: amountDue,
        signature: closeBalanceUpdate.signature,
      }),
    });
    expect(closeResponse1.status).toBe(200);
    const closeResult1 = await closeResponse1.json();
    expect(closeResult1.success).toBe(true);
    console.log(`First close succeeded with amount_due=${amountDue}`);

    // Try to close again with different amount (0 instead of amountDue)
    const zeroBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const zeroBalanceUpdate = JSON.parse(zeroBalanceUpdateJson);

    const closeResponse2 = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: zeroBalanceUpdate.signature,
      }),
    });

    expect(closeResponse2.status).toBe(400);
    const closeResult2 = await closeResponse2.json();
    expect(closeResult2.error).toBe('channel already closed with a different amount');
    expect(closeResult2.closed_amount).toBe(amountDue);
    expect(closeResult2.requested_amount).toBe(0);
    console.log(`Second close rejected (different amount): closed_amount=${amountDue} requested=0 ✓`);
  });

  test('rejects payment on a closed channel', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint and close a channel
    const channel = await mintFundedChannel(server, 'sat');
    console.log(`Channel ID: ${channel.channelId.substring(0, 16)}...`);

    // Close the channel with balance=0
    const closeBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(0)
    );
    const closeBalanceUpdate = JSON.parse(closeBalanceUpdateJson);

    const closeResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        balance: 0,
        signature: closeBalanceUpdate.signature,
        params: channel.channelParams,
        funding_proofs: channel.proofs,
      }),
    });
    expect(closeResponse.status).toBe(200);
    console.log(`Channel closed successfully`);

    // Now try to use the closed channel to fetch a blob
    const paymentBalanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const paymentBalanceUpdate = JSON.parse(paymentBalanceUpdateJson);

    const paymentHeader = JSON.stringify({
      channel_id: paymentBalanceUpdate.channel_id,
      balance: paymentBalanceUpdate.amount,
      signature: paymentBalanceUpdate.signature,
    });

    const blobResponse = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });

    expect(blobResponse.status).toBe(402);
    const channelHeader = blobResponse.headers.get('X-Cashu-Channel');
    expect(channelHeader).toBeDefined();
    const headerData = JSON.parse(channelHeader!);
    expect(headerData.error).toBe('channel closed');
    console.log(`Payment rejected on closed channel ✓`);
  });
});

describe('Channel status endpoint', () => {
  test('returns status with zeroes before payment, then updated after payment', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Create a balance update to establish the channel (but don't fetch a blob yet)
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    // Make a paid request to establish the channel
    const blobResponse = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });
    expect(blobResponse.status).toBe(200);

    // Check status after first payment
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    expect(statusResponse.status).toBe(200);

    const status = await statusResponse.json();
    expect(status.channel_id).toBe(channel.channelId);
    expect(status.capacity).toBe(channel.capacity);
    expect(status.balance).toBe(1);
    expect(status.blobs_served).toBe(1);
    expect(status.bytes_served).toBe(content.length);
    expect(status.amount_due).toBe(server.getAmountDue('sat', 1, content.length));

    console.log(`Channel status after payment: capacity=${status.capacity} balance=${status.balance} blobs=${status.blobs_served} bytes=${status.bytes_served} amount_due=${status.amount_due} ✓`);

    // Make another request for the same blob with balance=2
    const balanceUpdate2Json = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(2)
    );
    const balanceUpdate2 = JSON.parse(balanceUpdate2Json);

    const paymentHeader2 = JSON.stringify({
      channel_id: balanceUpdate2.channel_id,
      balance: balanceUpdate2.amount,
      signature: balanceUpdate2.signature,
      // No need to send params/funding_proofs again - server has them cached
    });

    const blobResponse2 = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader2 },
    });
    expect(blobResponse2.status).toBe(200);

    // Check updated status
    const statusResponse2 = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status2 = await statusResponse2.json();

    expect(status2.balance).toBe(2);
    expect(status2.blobs_served).toBe(2);
    expect(status2.bytes_served).toBe(content.length * 2);
    expect(status2.amount_due).toBe(server.getAmountDue('sat', 2, content.length * 2));

    console.log(`Channel status after 2nd payment: balance=${status2.balance} blobs=${status2.blobs_served} bytes=${status2.bytes_served} amount_due=${status2.amount_due} ✓`);
  });

  test('does not update status when payment fails', async ({ server }) => {
    // Upload a blob
    const { content, hash } = generateBlob();
    await fetch(`${server.baseUrl}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });

    // Mint a funded channel
    const channel = await mintFundedChannel(server, 'sat');

    // Create a balance update and make a successful payment
    const balanceUpdateJson = spilman_channel_sender_create_signed_balance_update(
      channel.channelParamsJson,
      JSON.stringify(channel.keysetInfo),
      channel.alice.secretHex,
      JSON.stringify(channel.proofs),
      BigInt(1)
    );
    const balanceUpdate = JSON.parse(balanceUpdateJson);

    const paymentHeader = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: balanceUpdate.amount,
      signature: balanceUpdate.signature,
      params: channel.channelParams,
      funding_proofs: channel.proofs,
    });

    const blobResponse = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader },
    });
    expect(blobResponse.status).toBe(200);

    // Check status after first payment
    const statusResponse = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status = await statusResponse.json();
    expect(status.balance).toBe(1);
    expect(status.blobs_served).toBe(1);
    expect(status.bytes_served).toBe(content.length);
    expect(status.amount_due).toBe(server.getAmountDue('sat', 1, content.length));
    console.log(`Channel status after payment: balance=${status.balance} blobs=${status.blobs_served} bytes=${status.bytes_served} amount_due=${status.amount_due} ✓`);

    // Attempt a second request with wrong balance (signature is for balance=1, but we send balance=2)
    const paymentHeader2 = JSON.stringify({
      channel_id: balanceUpdate.channel_id,
      balance: 2,  // Wrong! Signature is for balance=1
      signature: balanceUpdate.signature,
    });

    const blobResponse2 = await fetch(`${server.baseUrl}/${hash}`, {
      headers: { 'X-Cashu-Channel': paymentHeader2 },
    });
    expect(blobResponse2.status).toBe(402);
    const errorData = JSON.parse(blobResponse2.headers.get('X-Cashu-Channel')!);
    expect(errorData.error).toContain('invalid signature');
    console.log(`Failed payment rejected: ${errorData.error} ✓`);

    // Check status has NOT changed
    const statusResponse2 = await fetch(`${server.baseUrl}/channel/${channel.channelId}/status`);
    const status2 = await statusResponse2.json();

    expect(status2.balance).toBe(1);  // Still 1, not 2
    expect(status2.blobs_served).toBe(1);  // Still 1, not 2
    expect(status2.bytes_served).toBe(content.length);  // Still same
    expect(status2.amount_due).toBe(server.getAmountDue('sat', 1, content.length));  // Still same

    console.log(`Channel status unchanged after failed payment: balance=${status2.balance} blobs=${status2.blobs_served} bytes=${status2.bytes_served} amount_due=${status2.amount_due} ✓`);
  });
});
