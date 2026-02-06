import { test, describe, expect } from './fixtures';
import { randomBytes } from 'crypto';
import * as secp from '@noble/secp256k1';

// Import WASM functions
import {
  compute_shared_secret,
  compute_funding_token_amount,
  channel_parameters_get_channel_id,
  create_funding_outputs,
  construct_proofs,
  verify_proof_dleq,
  verify_channel,
} from '../src/wasm/cdk_wasm.js';

// Generate a random keypair for Alice
function generateKeypair(): { secretHex: string; pubkeyHex: string } {
  const secretBytes = randomBytes(32);
  const secretHex = secretBytes.toString('hex');
  const pubkeyBytes = secp.getPublicKey(secretBytes, true); // compressed
  const pubkeyHex = Buffer.from(pubkeyBytes).toString('hex');
  return { secretHex, pubkeyHex };
}

// Fetch keyset info from mint
async function fetchKeysetInfo(mintUrl: string, keysetId: string): Promise<any> {
  // Get keys for this keyset
  const keysRes = await fetch(`${mintUrl}/v1/keys/${keysetId}`);
  const keysData = await keysRes.json();

  // Get keysets to find the unit
  const keysetsRes = await fetch(`${mintUrl}/v1/keysets`);
  const keysetsData = await keysetsRes.json();
  const keyset = keysetsData.keysets.find((k: any) => k.id === keysetId);

  // Transform keys from { keysets: [{ keys: { "1": "02..." } }] } format
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

describe.concurrent('Minting flow', () => {
  test('mints a funding token with deterministic outputs', async ({ server }) => {
    // Step 1: Use cached channel params from fixture
    const charliePubkey = server.channelParams.receiver_pubkey;
    expect(charliePubkey).toMatch(/^[0-9a-f]{66}$/);

    // Get first available mint and keyset
    const mintUrl = Object.keys(server.channelParams.mints_units_keysets)[0];
    expect(mintUrl).toBeDefined();
    const units = server.channelParams.mints_units_keysets[mintUrl];
    const unit = Object.keys(units)[0]; // 'sat' or 'usd'
    const keysetId = units[unit][0];
    console.log(`Using mint=${mintUrl} unit=${unit} keyset=${keysetId}`);

    // Step 2: Generate Alice's keypair
    const alice = generateKeypair();
    console.log(`Alice pubkey: ${alice.pubkeyHex}`);

    // Step 3: Fetch keyset info from mint
    const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);
    console.log(`Keyset info: ${keysetInfo.amounts.length} denominations, fee=${keysetInfo.inputFeePpk}ppk`);

    // Step 4: Build channel parameters JSON
    const setupTimestamp = Math.floor(Date.now() / 1000);
    const locktime = setupTimestamp + 7 * 24 * 60 * 60; // 1 week
    const senderNonce = randomBytes(32).toString('hex');
    const capacity = 100; // 100 sats
    const fundingTokenAmount = Number(compute_funding_token_amount(
      BigInt(capacity), JSON.stringify(keysetInfo), BigInt(64),
    ));

    const channelParamsJson = JSON.stringify({
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
    });
    console.log(`Channel params: ${channelParamsJson}`);

    // Step 5: Generate funding outputs using WASM
    const fundingOutputsJson = create_funding_outputs(
      channelParamsJson,
      alice.secretHex,
      JSON.stringify(keysetInfo)
    );
    const fundingOutputs = JSON.parse(fundingOutputsJson);
    console.log(`Funding outputs: nominal=${fundingOutputs.funding_token_nominal}, ${fundingOutputs.blinded_messages.length} blinded messages`);

    expect(fundingOutputs.funding_token_nominal).toBeGreaterThan(0);
    expect(fundingOutputs.blinded_messages.length).toBeGreaterThan(0);
    expect(fundingOutputs.secrets_with_blinding.length).toBe(fundingOutputs.blinded_messages.length);

    // Step 6: Create mint quote
    const quoteRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: fundingOutputs.funding_token_nominal,
        unit: unit,
      }),
    });
    expect(quoteRes.status).toBe(200);
    const quote = await quoteRes.json();
    console.log(`Mint quote: ${quote.quote.substring(0, 16)}...`);

    // Step 7: Wait for payment (FakeWallet auto-pays)
    let paid = false;
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11/${quote.quote}`);
      const status = await statusRes.json();
      if (status.state === 'PAID') {
        paid = true;
        console.log('Payment confirmed!');
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(paid).toBe(true);

    // Step 8: Mint with our custom blinded messages
    const mintReq = {
      quote: quote.quote,
      outputs: fundingOutputs.blinded_messages.map((bm: any) => ({
        amount: bm.amount,
        id: bm.id,
        B_: bm.B_,
      })),
    };
    console.log(`Minting ${mintReq.outputs.length} outputs...`);

    const mintRes = await fetch(`${mintUrl}/v1/mint/bolt11`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mintReq),
    });
    expect(mintRes.status).toBe(200);
    const mintData = await mintRes.json();
    console.log(`Received ${mintData.signatures.length} blind signatures`);
    console.log(`Mint response: ${JSON.stringify(mintData, null, 2)}`);

    expect(mintData.signatures.length).toBe(fundingOutputs.blinded_messages.length);

    // Step 9: Construct proofs (unblind the signatures)
    const proofsJson = construct_proofs(
      JSON.stringify(mintData.signatures),
      JSON.stringify(fundingOutputs.secrets_with_blinding),
      JSON.stringify(keysetInfo)
    );
    const proofs = JSON.parse(proofsJson);
    console.log(`Constructed ${proofs.length} proofs`);

    expect(proofs.length).toBe(fundingOutputs.blinded_messages.length);

    // Verify proof structure
    for (const proof of proofs) {
      expect(proof.amount).toBeGreaterThan(0);
      expect(proof.id).toBe(keysetId);
      expect(proof.secret).toBeDefined();
      expect(proof.C).toBeDefined();
      expect(proof.dleq).toBeDefined();
      expect(proof.dleq.e).toBeDefined();
      expect(proof.dleq.s).toBeDefined();
      expect(proof.dleq.r).toBeDefined();
    }

    // Calculate total
    const total = proofs.reduce((sum: number, p: any) => sum + p.amount, 0);
    console.log(`Total minted: ${total} ${unit}`);
    expect(total).toBe(fundingOutputs.funding_token_nominal);

    // Step 10: Compute shared secret and channel ID
    const sharedSecret = compute_shared_secret(alice.secretHex, charliePubkey);
    const keysetInfoJson = JSON.stringify(keysetInfo);
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret, keysetInfoJson);
    console.log(`Channel ID: ${channelId.substring(0, 16)}...`);
    expect(channelId).toMatch(/^[0-9a-f]{64}$/);

    // Step 11: Verify the channel using verify_channel (comprehensive verification)
    // This verifies DLEQ proofs and other channel validity checks
    const verificationResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(proofs),
      JSON.stringify(keysetInfo)
    );
    const verificationResult = JSON.parse(verificationResultJson);
    console.log(`Channel verification: valid=${verificationResult.valid}, errors=${verificationResult.errors.length}`);

    if (!verificationResult.valid) {
      console.log(`Verification errors: ${JSON.stringify(verificationResult.errors, null, 2)}`);
    }
    expect(verificationResult.valid).toBe(true);
    expect(verificationResult.errors).toHaveLength(0);
    console.log('Channel verified ✓');
  });
});

describe.concurrent('Channel verification', () => {
  test('detects tampered keyset keys', async ({ server }) => {
    // Step 1: Use cached channel params from fixture
    const charliePubkey = server.channelParams.receiver_pubkey;
    expect(charliePubkey).toMatch(/^[0-9a-f]{66}$/);

    // Get first available mint and keyset
    const mintUrl = Object.keys(server.channelParams.mints_units_keysets)[0];
    expect(mintUrl).toBeDefined();
    const units = server.channelParams.mints_units_keysets[mintUrl];
    const unit = Object.keys(units)[0]; // 'sat' or 'usd'
    const keysetId = units[unit][0];
    console.log(`Using mint=${mintUrl} unit=${unit} keyset=${keysetId}`);

    // Step 2: Generate Alice's keypair
    const alice = generateKeypair();
    console.log(`Alice pubkey: ${alice.pubkeyHex}`);

    // Step 3: Fetch keyset info from mint
    const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);
    console.log(`Keyset info: ${keysetInfo.amounts.length} denominations, fee=${keysetInfo.inputFeePpk}ppk`);

    // Step 4: Build channel parameters JSON
    const setupTimestamp = Math.floor(Date.now() / 1000);
    const locktime = setupTimestamp + 7 * 24 * 60 * 60; // 1 week
    const senderNonce = randomBytes(32).toString('hex');
    const capacity = 100; // 100 sats
    const fundingTokenAmount = Number(compute_funding_token_amount(
      BigInt(capacity), JSON.stringify(keysetInfo), BigInt(64),
    ));

    const channelParamsJson = JSON.stringify({
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
    });
    console.log(`Channel params: ${channelParamsJson}`);

    // Step 5: Generate funding outputs using WASM
    const fundingOutputsJson = create_funding_outputs(
      channelParamsJson,
      alice.secretHex,
      JSON.stringify(keysetInfo)
    );
    const fundingOutputs = JSON.parse(fundingOutputsJson);
    console.log(`Funding outputs: nominal=${fundingOutputs.funding_token_nominal}, ${fundingOutputs.blinded_messages.length} blinded messages`);

    expect(fundingOutputs.funding_token_nominal).toBeGreaterThan(0);
    expect(fundingOutputs.blinded_messages.length).toBeGreaterThan(0);
    expect(fundingOutputs.secrets_with_blinding.length).toBe(fundingOutputs.blinded_messages.length);

    // Step 6: Create mint quote
    const quoteRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: fundingOutputs.funding_token_nominal,
        unit: unit,
      }),
    });
    expect(quoteRes.status).toBe(200);
    const quote = await quoteRes.json();
    console.log(`Mint quote: ${quote.quote.substring(0, 16)}...`);

    // Step 7: Wait for payment (FakeWallet auto-pays)
    let paid = false;
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11/${quote.quote}`);
      const status = await statusRes.json();
      if (status.state === 'PAID') {
        paid = true;
        console.log('Payment confirmed!');
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(paid).toBe(true);

    // Step 8: Mint with our custom blinded messages
    const mintReq = {
      quote: quote.quote,
      outputs: fundingOutputs.blinded_messages.map((bm: any) => ({
        amount: bm.amount,
        id: bm.id,
        B_: bm.B_,
      })),
    };
    console.log(`Minting ${mintReq.outputs.length} outputs...`);

    const mintRes = await fetch(`${mintUrl}/v1/mint/bolt11`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mintReq),
    });
    expect(mintRes.status).toBe(200);
    const mintData = await mintRes.json();
    console.log(`Received ${mintData.signatures.length} blind signatures`);

    expect(mintData.signatures.length).toBe(fundingOutputs.blinded_messages.length);

    // Step 9: Construct proofs (unblind the signatures)
    const proofsJson = construct_proofs(
      JSON.stringify(mintData.signatures),
      JSON.stringify(fundingOutputs.secrets_with_blinding),
      JSON.stringify(keysetInfo)
    );
    const proofs = JSON.parse(proofsJson);
    console.log(`Constructed ${proofs.length} proofs`);

    expect(proofs.length).toBe(fundingOutputs.blinded_messages.length);

    // Verify proof structure
    for (const proof of proofs) {
      expect(proof.amount).toBeGreaterThan(0);
      expect(proof.id).toBe(keysetId);
      expect(proof.secret).toBeDefined();
      expect(proof.C).toBeDefined();
      expect(proof.dleq).toBeDefined();
      expect(proof.dleq.e).toBeDefined();
      expect(proof.dleq.s).toBeDefined();
      expect(proof.dleq.r).toBeDefined();
    }

    // Calculate total
    const total = proofs.reduce((sum: number, p: any) => sum + p.amount, 0);
    console.log(`Total minted: ${total} ${unit}`);
    expect(total).toBe(fundingOutputs.funding_token_nominal);

    // Step 10: Compute shared secret and channel ID
    const sharedSecret = compute_shared_secret(alice.secretHex, charliePubkey);
    const keysetInfoJson = JSON.stringify(keysetInfo);
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret, keysetInfoJson);
    console.log(`Channel ID: ${channelId.substring(0, 16)}...`);
    expect(channelId).toMatch(/^[0-9a-f]{64}$/);

    // Step 11: Verify the channel with original keyset (should pass)
    const verificationResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(proofs),
      JSON.stringify(keysetInfo)
    );
    const verificationResult = JSON.parse(verificationResultJson);
    console.log(`Baseline verification: valid=${verificationResult.valid}, errors=${verificationResult.errors.length}`);

    expect(verificationResult.valid).toBe(true);
    expect(verificationResult.errors).toHaveLength(0);
    console.log('Baseline verified ✓');

    // Step 12: Tamper with a key and verify it's detected
    // We'll substitute a completely different valid pubkey to trigger InvalidKeysetId
    // (simply changing one character often creates an invalid curve point)
    const tamperedKeysetInfo = JSON.parse(JSON.stringify(keysetInfo));
    const originalKey = tamperedKeysetInfo.keys["1"];
    // Use a different valid pubkey (generator point G)
    const differentValidPubkey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    tamperedKeysetInfo.keys["1"] = differentValidPubkey;
    console.log(`Tampered key for amount 1: ${originalKey.substring(0, 20)}... -> ${differentValidPubkey.substring(0, 20)}...`);

    const tamperedResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(proofs),
      JSON.stringify(tamperedKeysetInfo)
    );
    const tamperedResult = JSON.parse(tamperedResultJson);
    console.log(`Tampered verification: valid=${tamperedResult.valid}, errors=${tamperedResult.errors.length}`);

    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.errors.length).toBeGreaterThan(0);
    expect(tamperedResult.errors[0].type).toBe('InvalidKeysetId');
    console.log(`Tampered keyset detected ✓ (error: ${tamperedResult.errors[0].type})`);

    // Step 13: Restore the key and verify it passes again
    const restoredResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(proofs),
      JSON.stringify(keysetInfo)  // Use original keysetInfo
    );
    const restoredResult = JSON.parse(restoredResultJson);
    console.log(`Restored verification: valid=${restoredResult.valid}, errors=${restoredResult.errors.length}`);

    expect(restoredResult.valid).toBe(true);
    expect(restoredResult.errors).toHaveLength(0);
    console.log('Restored keyset verified ✓');
  });

  test('detects tampered DLEQ proofs', async ({ server }) => {
    // Step 1: Use cached channel params from fixture
    const charliePubkey = server.channelParams.receiver_pubkey;
    expect(charliePubkey).toMatch(/^[0-9a-f]{66}$/);

    // Get first available mint and keyset
    const mintUrl = Object.keys(server.channelParams.mints_units_keysets)[0];
    expect(mintUrl).toBeDefined();
    const units = server.channelParams.mints_units_keysets[mintUrl];
    const unit = Object.keys(units)[0]; // 'sat' or 'usd'
    const keysetId = units[unit][0];
    console.log(`Using mint=${mintUrl} unit=${unit} keyset=${keysetId}`);

    // Step 2: Generate Alice's keypair
    const alice = generateKeypair();
    console.log(`Alice pubkey: ${alice.pubkeyHex}`);

    // Step 3: Fetch keyset info from mint
    const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);
    console.log(`Keyset info: ${keysetInfo.amounts.length} denominations, fee=${keysetInfo.inputFeePpk}ppk`);

    // Step 4: Build channel parameters JSON
    const setupTimestamp = Math.floor(Date.now() / 1000);
    const locktime = setupTimestamp + 7 * 24 * 60 * 60; // 1 week
    const senderNonce = randomBytes(32).toString('hex');
    const capacity = 100; // 100 sats
    const fundingTokenAmount = Number(compute_funding_token_amount(
      BigInt(capacity), JSON.stringify(keysetInfo), BigInt(64),
    ));

    const channelParamsJson = JSON.stringify({
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
    });
    console.log(`Channel params: ${channelParamsJson}`);

    // Step 5: Generate funding outputs using WASM
    const fundingOutputsJson = create_funding_outputs(
      channelParamsJson,
      alice.secretHex,
      JSON.stringify(keysetInfo)
    );
    const fundingOutputs = JSON.parse(fundingOutputsJson);
    console.log(`Funding outputs: nominal=${fundingOutputs.funding_token_nominal}, ${fundingOutputs.blinded_messages.length} blinded messages`);

    expect(fundingOutputs.funding_token_nominal).toBeGreaterThan(0);
    expect(fundingOutputs.blinded_messages.length).toBeGreaterThan(0);
    expect(fundingOutputs.secrets_with_blinding.length).toBe(fundingOutputs.blinded_messages.length);

    // Step 6: Create mint quote
    const quoteRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: fundingOutputs.funding_token_nominal,
        unit: unit,
      }),
    });
    expect(quoteRes.status).toBe(200);
    const quote = await quoteRes.json();
    console.log(`Mint quote: ${quote.quote.substring(0, 16)}...`);

    // Step 7: Wait for payment (FakeWallet auto-pays)
    let paid = false;
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11/${quote.quote}`);
      const status = await statusRes.json();
      if (status.state === 'PAID') {
        paid = true;
        console.log('Payment confirmed!');
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(paid).toBe(true);

    // Step 8: Mint with our custom blinded messages
    const mintReq = {
      quote: quote.quote,
      outputs: fundingOutputs.blinded_messages.map((bm: any) => ({
        amount: bm.amount,
        id: bm.id,
        B_: bm.B_,
      })),
    };
    console.log(`Minting ${mintReq.outputs.length} outputs...`);

    const mintRes = await fetch(`${mintUrl}/v1/mint/bolt11`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mintReq),
    });
    expect(mintRes.status).toBe(200);
    const mintData = await mintRes.json();
    console.log(`Received ${mintData.signatures.length} blind signatures`);

    expect(mintData.signatures.length).toBe(fundingOutputs.blinded_messages.length);

    // Step 9: Construct proofs (unblind the signatures)
    const proofsJson = construct_proofs(
      JSON.stringify(mintData.signatures),
      JSON.stringify(fundingOutputs.secrets_with_blinding),
      JSON.stringify(keysetInfo)
    );
    const proofs = JSON.parse(proofsJson);
    console.log(`Constructed ${proofs.length} proofs`);

    expect(proofs.length).toBe(fundingOutputs.blinded_messages.length);

    // Verify proof structure
    for (const proof of proofs) {
      expect(proof.amount).toBeGreaterThan(0);
      expect(proof.id).toBe(keysetId);
      expect(proof.secret).toBeDefined();
      expect(proof.C).toBeDefined();
      expect(proof.dleq).toBeDefined();
      expect(proof.dleq.e).toBeDefined();
      expect(proof.dleq.s).toBeDefined();
      expect(proof.dleq.r).toBeDefined();
    }

    // Calculate total
    const total = proofs.reduce((sum: number, p: any) => sum + p.amount, 0);
    console.log(`Total minted: ${total} ${unit}`);
    expect(total).toBe(fundingOutputs.funding_token_nominal);

    // Step 10: Compute shared secret and channel ID
    const sharedSecret = compute_shared_secret(alice.secretHex, charliePubkey);
    const keysetInfoJson = JSON.stringify(keysetInfo);
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret, keysetInfoJson);
    console.log(`Channel ID: ${channelId.substring(0, 16)}...`);
    expect(channelId).toMatch(/^[0-9a-f]{64}$/);

    // Step 11: Verify the channel with original proofs (should pass)
    const verificationResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(proofs),
      JSON.stringify(keysetInfo)
    );
    const verificationResult = JSON.parse(verificationResultJson);
    console.log(`Baseline verification: valid=${verificationResult.valid}, errors=${verificationResult.errors.length}`);

    expect(verificationResult.valid).toBe(true);
    expect(verificationResult.errors).toHaveLength(0);
    console.log('Baseline verified ✓');

    // Step 12: Tamper with a DLEQ proof and verify it's detected
    const tamperedProofs = JSON.parse(JSON.stringify(proofs));
    // Change one character in the first proof's DLEQ 'e' value
    const originalE = tamperedProofs[0].dleq.e;
    tamperedProofs[0].dleq.e = originalE.slice(0, -1) + (originalE.slice(-1) === 'a' ? 'b' : 'a');
    console.log(`Tampered DLEQ e: ${originalE} -> ${tamperedProofs[0].dleq.e}`);

    const tamperedResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(tamperedProofs),
      JSON.stringify(keysetInfo)
    );
    const tamperedResult = JSON.parse(tamperedResultJson);
    console.log(`Tampered verification: valid=${tamperedResult.valid}, errors=${tamperedResult.errors.length}`);

    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.errors.length).toBeGreaterThan(0);
    expect(tamperedResult.errors[0].type).toBe('InvalidDleq');
    console.log(`Tampered DLEQ detected ✓ (error: ${tamperedResult.errors[0].type})`);

    // Step 13: Restore the proof and verify it passes again
    const restoredResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(proofs),  // Use original proofs
      JSON.stringify(keysetInfo)
    );
    const restoredResult = JSON.parse(restoredResultJson);
    console.log(`Restored verification: valid=${restoredResult.valid}, errors=${restoredResult.errors.length}`);

    expect(restoredResult.valid).toBe(true);
    expect(restoredResult.errors).toHaveLength(0);
    console.log('Restored proofs verified ✓');
  });

  test('collects multiple error types (keyset + DLEQ)', async ({ server }) => {
    // Step 1: Use cached channel params from fixture
    const charliePubkey = server.channelParams.receiver_pubkey;

    // Get first available mint and keyset
    const mintUrl = Object.keys(server.channelParams.mints_units_keysets)[0];
    const units = server.channelParams.mints_units_keysets[mintUrl];
    const unit = Object.keys(units)[0];
    const keysetId = units[unit][0];

    // Step 2: Generate Alice's keypair
    const alice = generateKeypair();

    // Step 3: Fetch keyset info from mint
    const keysetInfo = await fetchKeysetInfo(mintUrl, keysetId);

    // Step 4: Build channel parameters JSON
    const setupTimestamp = Math.floor(Date.now() / 1000);
    const locktime = setupTimestamp + 7 * 24 * 60 * 60;
    const senderNonce = randomBytes(32).toString('hex');
    const capacity = 100;
    const fundingTokenAmount = Number(compute_funding_token_amount(
      BigInt(capacity), JSON.stringify(keysetInfo), BigInt(64),
    ));

    const channelParamsJson = JSON.stringify({
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
    });

    // Step 5: Generate funding outputs using WASM
    const fundingOutputsJson = create_funding_outputs(
      channelParamsJson,
      alice.secretHex,
      JSON.stringify(keysetInfo)
    );
    const fundingOutputs = JSON.parse(fundingOutputsJson);

    // Step 6: Create mint quote
    const quoteRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: fundingOutputs.funding_token_nominal,
        unit: unit,
      }),
    });
    const quote = await quoteRes.json();

    // Step 7: Wait for payment (FakeWallet auto-pays)
    let paid = false;
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(`${mintUrl}/v1/mint/quote/bolt11/${quote.quote}`);
      const status = await statusRes.json();
      if (status.state === 'PAID') {
        paid = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(paid).toBe(true);

    // Step 8: Mint with our custom blinded messages
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

    // Step 9: Construct proofs (unblind the signatures)
    const proofsJson = construct_proofs(
      JSON.stringify(mintData.signatures),
      JSON.stringify(fundingOutputs.secrets_with_blinding),
      JSON.stringify(keysetInfo)
    );
    const proofs = JSON.parse(proofsJson);

    // Step 10: Compute shared secret
    const sharedSecret = compute_shared_secret(alice.secretHex, charliePubkey);

    // Step 11: Verify baseline passes
    const baselineResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(proofs),
      JSON.stringify(keysetInfo)
    );
    const baselineResult = JSON.parse(baselineResultJson);
    expect(baselineResult.valid).toBe(true);
    console.log('Baseline verified ✓');

    // Step 12: Introduce multiple distinct error types to test error collection
    // We'll create four different errors:
    // 1. InvalidKeysetId - tamper with a key in keysetInfo (changes computed keyset ID)
    // 2. InvalidDleq - tamper with the DLEQ 'e' value on proof 0
    // 3. MissingDleq - remove the dleq field entirely from proof 1
    // 4. MissingMintKey - remove a key from keysetInfo for proof 2's amount
    
    const tamperedProofs = JSON.parse(JSON.stringify(proofs));
    const tamperedKeysetInfo = JSON.parse(JSON.stringify(keysetInfo));
    
    // Error 1: InvalidKeysetId - substitute a different valid pubkey for an unused amount
    // Find an amount that's not in our proofs (e.g., amount "1" if no proof uses it)
    const proofAmounts = new Set(tamperedProofs.map((p: any) => p.amount.toString()));
    const unusedAmount = Object.keys(tamperedKeysetInfo.keys).find(amt => !proofAmounts.has(amt));
    if (unusedAmount) {
      // Use a different valid pubkey (generator point G) instead of tampering characters
      const differentValidPubkey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
      tamperedKeysetInfo.keys[unusedAmount] = differentValidPubkey;
      console.log(`Tampered unused key for amount ${unusedAmount} to trigger InvalidKeysetId`);
    }
    
    // Error 2: InvalidDleq on proof 0
    const originalE = tamperedProofs[0].dleq.e;
    tamperedProofs[0].dleq.e = originalE.slice(0, -1) + (originalE.slice(-1) === 'a' ? 'b' : 'a');
    console.log(`Tampered DLEQ e on proof 0: ${originalE.substring(0, 16)}... -> ${tamperedProofs[0].dleq.e.substring(0, 16)}...`);
    
    // Error 3: MissingDleq on proof 1 (if we have at least 2 proofs)
    if (tamperedProofs.length > 1) {
      console.log(`Removing DLEQ from proof 1 (amount=${tamperedProofs[1].amount})`);
      delete tamperedProofs[1].dleq;
    }
    
    // Error 4: MissingMintKey on proof 2 (if we have at least 3 proofs)
    if (tamperedProofs.length > 2) {
      const amount2 = tamperedProofs[2].amount.toString();
      console.log(`Removing mint key for amount ${amount2} from keysetInfo`);
      delete tamperedKeysetInfo.keys[amount2];
    }

    // Step 13: Verify with multiple tamperings - should collect ALL errors
    const tamperedResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(tamperedProofs),
      JSON.stringify(tamperedKeysetInfo)
    );
    const tamperedResult = JSON.parse(tamperedResultJson);
    console.log(`Tampered verification: valid=${tamperedResult.valid}, errors=${tamperedResult.errors.length}`);
    console.log(`Error details: ${JSON.stringify(tamperedResult.errors, null, 2)}`);

    expect(tamperedResult.valid).toBe(false);
    
    // We should have at least 4 errors (one per tampering)
    const errorTypes = tamperedResult.errors.map((e: any) => e.type);
    console.log(`Error types: ${errorTypes.join(', ')}`);
    
    // Verify we collected multiple distinct error types
    expect(errorTypes).toContain('InvalidKeysetId');
    expect(errorTypes).toContain('InvalidDleq');
    if (proofs.length > 1) {
      expect(errorTypes).toContain('MissingDleq');
    }
    if (proofs.length > 2) {
      expect(errorTypes).toContain('MissingMintKey');
    }
    
    // Verify we have at least as many errors as tamperings we introduced
    const expectedErrorCount = Math.min(proofs.length, 3);
    expect(tamperedResult.errors.length).toBeGreaterThanOrEqual(expectedErrorCount);
    console.log(`Multiple error types collected ✓ (${errorTypes.join(' + ')})`);
  });
});
