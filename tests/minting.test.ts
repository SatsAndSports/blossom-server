import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import * as secp from '@noble/secp256k1';

// Import WASM functions
import {
  compute_shared_secret,
  channel_parameters_get_channel_id,
  create_funding_outputs,
  construct_proofs,
  verify_proof_dleq,
  verify_channel,
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

describe('Minting flow', () => {
  it('mints a funding token with deterministic outputs', async () => {
    // Step 1: Get channel params from server
    const paramsRes = await fetch(`${BASE_URL}/channel/params`);
    expect(paramsRes.status).toBe(200);
    const serverParams = await paramsRes.json();
    const charliePubkey = serverParams.receiver_pubkey;
    expect(charliePubkey).toMatch(/^[0-9a-f]{66}$/);

    // Get first available mint and keyset
    const mintUrl = Object.keys(serverParams.mints_units_keysets)[0];
    expect(mintUrl).toBeDefined();
    const units = serverParams.mints_units_keysets[mintUrl];
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

    const channelParamsJson = JSON.stringify({
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
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret);
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

describe('Channel verification', () => {
  it('detects tampered keyset keys', async () => {
    // Step 1: Get channel params from server
    const paramsRes = await fetch(`${BASE_URL}/channel/params`);
    expect(paramsRes.status).toBe(200);
    const serverParams = await paramsRes.json();
    const charliePubkey = serverParams.receiver_pubkey;
    expect(charliePubkey).toMatch(/^[0-9a-f]{66}$/);

    // Get first available mint and keyset
    const mintUrl = Object.keys(serverParams.mints_units_keysets)[0];
    expect(mintUrl).toBeDefined();
    const units = serverParams.mints_units_keysets[mintUrl];
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

    const channelParamsJson = JSON.stringify({
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
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret);
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
    const tamperedKeysetInfo = JSON.parse(JSON.stringify(keysetInfo));
    // Change one character in the first key (amount "1")
    const originalKey = tamperedKeysetInfo.keys["1"];
    tamperedKeysetInfo.keys["1"] = originalKey.slice(0, -1) + (originalKey.slice(-1) === 'a' ? 'b' : 'a');
    console.log(`Tampered key for amount 1: ${originalKey} -> ${tamperedKeysetInfo.keys["1"]}`);

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

  it('detects tampered DLEQ proofs', async () => {
    // Step 1: Get channel params from server
    const paramsRes = await fetch(`${BASE_URL}/channel/params`);
    expect(paramsRes.status).toBe(200);
    const serverParams = await paramsRes.json();
    const charliePubkey = serverParams.receiver_pubkey;
    expect(charliePubkey).toMatch(/^[0-9a-f]{66}$/);

    // Get first available mint and keyset
    const mintUrl = Object.keys(serverParams.mints_units_keysets)[0];
    expect(mintUrl).toBeDefined();
    const units = serverParams.mints_units_keysets[mintUrl];
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

    const channelParamsJson = JSON.stringify({
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
    const channelId = channel_parameters_get_channel_id(channelParamsJson, sharedSecret);
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

  it('collects multiple error types (keyset + DLEQ)', async () => {
    // Step 1: Get channel params from server
    const paramsRes = await fetch(`${BASE_URL}/channel/params`);
    expect(paramsRes.status).toBe(200);
    const serverParams = await paramsRes.json();
    const charliePubkey = serverParams.receiver_pubkey;

    // Get first available mint and keyset
    const mintUrl = Object.keys(serverParams.mints_units_keysets)[0];
    const units = serverParams.mints_units_keysets[mintUrl];
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

    const channelParamsJson = JSON.stringify({
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

    // Step 12: Tamper with BOTH keyset AND DLEQ proofs
    const tamperedKeysetInfo = JSON.parse(JSON.stringify(keysetInfo));
    const originalKey = tamperedKeysetInfo.keys["1"];
    tamperedKeysetInfo.keys["1"] = originalKey.slice(0, -1) + (originalKey.slice(-1) === 'a' ? 'b' : 'a');

    const tamperedProofs = JSON.parse(JSON.stringify(proofs));
    const originalE = tamperedProofs[0].dleq.e;
    tamperedProofs[0].dleq.e = originalE.slice(0, -1) + (originalE.slice(-1) === 'a' ? 'b' : 'a');

    console.log(`Tampered key for amount 1: ${originalKey.substring(0, 16)}... -> ${tamperedKeysetInfo.keys["1"].substring(0, 16)}...`);
    console.log(`Tampered DLEQ e: ${originalE.substring(0, 16)}... -> ${tamperedProofs[0].dleq.e.substring(0, 16)}...`);

    // Step 13: Verify with both tamperings - should collect BOTH errors
    const tamperedResultJson = verify_channel(
      channelParamsJson,
      sharedSecret,
      JSON.stringify(tamperedProofs),
      JSON.stringify(tamperedKeysetInfo)
    );
    const tamperedResult = JSON.parse(tamperedResultJson);
    console.log(`Tampered verification: valid=${tamperedResult.valid}, errors=${tamperedResult.errors.length}`);
    console.log(`Error types: ${tamperedResult.errors.map((e: any) => e.type).join(', ')}`);

    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.errors.length).toBeGreaterThanOrEqual(2);

    // Check that we have both error types
    const errorTypes = tamperedResult.errors.map((e: any) => e.type);
    expect(errorTypes).toContain('InvalidKeysetId');
    expect(errorTypes).toContain('InvalidDleq');
    console.log('Multiple errors collected ✓ (InvalidKeysetId + InvalidDleq)');
  });
});
