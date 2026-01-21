/* tslint:disable */
/* eslint-disable */

export class WasmSpilmanBridge {
  free(): void;
  [Symbol.dispose](): void;
  processPayment(payment_json: string, context_json: string, keyset_info_json?: string | null): string;
  /**
   * Create data needed to close a channel
   *
   * Validates the payment signature and creates the fully-signed swap request
   * ready to submit to the mint, plus secrets for unblinding the response.
   *
   * # Arguments
   * * `payment_json` - Payment request JSON with channel_id, balance, signature,
   *   and optionally params + funding_proofs for unknown channels
   * * `keyset_info_json` - Optional keyset info JSON (required for unknown channels)
   *
   * # Returns
   * JSON with:
   * - `swap_request`: The fully-signed swap request ready for mint
   * - `expected_total`: Expected total output value after stage 1 fees
   * - `secrets_with_blinding`: Array of {secret, blinding_factor, amount, index, is_receiver}
   *
   * # Errors
   * Returns error JSON with same structure as processPayment 402 responses
   */
  createCloseData(payment_json: string, keyset_info_json?: string | null): string;
  /**
   * Create data for a unilateral (server-initiated) channel close
   *
   * This retrieves the largest balance and signature from the host
   * and constructs a fully-signed swap request ready for the mint.
   *
   * # Arguments
   * * `channel_id` - The channel ID to close
   *
   * # Returns
   * JSON with same structure as createCloseData:
   * - `swap_request`: The fully-signed swap request ready for mint
   * - `expected_total`: Expected total output value after stage 1 fees
   * - `secrets_with_blinding`: Array of {secret, blinding_factor, amount, index, is_receiver}
   *
   * # Errors
   * Returns error JSON if no payment proof stored, channel closed, or validation fails
   */
  createUnilateralCloseData(channel_id: string): string;
  constructor(js_host: any, server_secret_key_hex?: string | null);
}

/**
 * Get channel_id from params JSON, shared secret, and keyset info
 *
 * This is effectively a method on ChannelParameters for FFI.
 * Takes the params JSON, the pre-computed shared secret (hex), and keyset info JSON.
 */
export function channel_parameters_get_channel_id(params_json: string, shared_secret_hex: string, keyset_info_json: string): string;

/**
 * Compute ECDH shared secret from a secret key and counterparty's public key
 *
 * Returns the x-coordinate of the shared point as a hex string (32 bytes).
 */
export function compute_shared_secret(my_secret_hex: string, their_pubkey_hex: string): string;

/**
 * Construct proofs from blind signatures
 *
 * Takes the blind signatures from the mint and unblinds them using the
 * secrets and blinding factors from `create_funding_outputs`.
 *
 * Takes:
 * - `blind_signatures_json`: JSON array of blind signatures from mint response
 *   Format: [{"amount": 1, "id": "00...", "C_": "02..."}, ...]
 * - `secrets_with_blinding_json`: JSON array from `create_funding_outputs`
 *   Format: [{"secret": "...", "blinding_factor": "...", "amount": 1}, ...]
 * - `keyset_info_json`: KeysetInfo JSON (from fetchKeysetInfo)
 *
 * Returns JSON array of proofs ready for use
 */
export function construct_proofs(blind_signatures_json: string, secrets_with_blinding_json: string, keyset_info_json: string): string;

/**
 * Create funding outputs for a Spilman channel
 *
 * Takes:
 * - `params_json`: Channel parameters JSON (from get_channel_id_params_json or stored in DB)
 * - `my_secret_hex`: Alice's secret key (hex)
 * - `keyset_info_json`: KeysetInfo JSON (from fetchKeysetInfo)
 *
 * Returns JSON with:
 * - `funding_token_nominal`: The nominal amount to request when minting the funding token
 * - `blinded_messages`: Array of blinded messages (ready for mint request)
 * - `secrets_with_blinding`: Array of {secret, blinding_factor, amount} for unblinding later
 */
export function create_funding_outputs(params_json: string, my_secret_hex: string, keyset_info_json: string): string;

/**
 * Get Charlie's blinded secret key for a specific stage 2 output
 *
 * Charlie uses this to sign when spending a specific stage 1 proof in stage 2.
 * Each stage 1 output is P2PK locked to a UNIQUE blinded pubkey derived from (amount, index),
 * so he needs the corresponding blinded secret key to spend each one.
 *
 * # Arguments
 * * `params_json` - Channel parameters JSON
 * * `keyset_info_json` - Keyset info JSON with keys and fee info
 * * `charlie_secret_hex` - Charlie's raw secret key in hex
 * * `shared_secret_hex` - Pre-computed shared secret (hex)
 * * `amount` - The proof amount
 * * `index` - The proof index within proofs of the same amount
 *
 * # Returns
 * Hex string of Charlie's blinded secret key for this specific output
 */
export function get_receiver_blinded_secret_key_for_stage2_output(params_json: string, keyset_info_json: string, charlie_secret_hex: string, shared_secret_hex: string, amount: bigint, index: number): string;

/**
 * Get Alice's blinded secret key for a specific stage 2 output
 *
 * Alice uses this to sign when spending a specific stage 1 proof in stage 2.
 * Each stage 1 output is P2PK locked to a UNIQUE blinded pubkey derived from (amount, index),
 * so she needs the corresponding blinded secret key to spend each one.
 *
 * # Arguments
 * * `params_json` - Channel parameters JSON
 * * `keyset_info_json` - Keyset info JSON with keys and fee info
 * * `alice_secret_hex` - Alice's raw secret key in hex
 * * `amount` - The proof amount
 * * `index` - The proof index within proofs of the same amount
 *
 * # Returns
 * Hex string of Alice's blinded secret key for this specific output
 */
export function get_sender_blinded_secret_key_for_stage2_output(params_json: string, keyset_info_json: string, alice_secret_hex: string, amount: bigint, index: number): string;

/**
 * Initialize panic hook for better error messages in browser console
 */
export function init(): void;

/**
 * Create a signed balance update from Alice (sender) to Charlie (receiver)
 *
 * This function creates a balance update message signed by Alice, which authorizes
 * Charlie to claim the specified balance when closing the channel.
 *
 * # Arguments
 * * `params_json` - Channel parameters JSON
 * * `keyset_info_json` - Keyset info JSON with keys and fee info
 * * `alice_secret_hex` - Alice's secret key in hex
 * * `funding_proofs_json` - JSON array of funding proofs
 * * `charlie_balance` - The balance to authorize for Charlie
 *
 * # Returns
 * JSON object with:
 * - `channel_id`: The channel ID
 * - `amount`: The authorized balance
 * - `signature`: Alice's signature over the balance update
 */
export function spilman_channel_sender_create_signed_balance_update(params_json: string, keyset_info_json: string, alice_secret_hex: string, funding_proofs_json: string, charlie_balance: bigint): string;

/**
 * Unblind blind signatures and verify DLEQ proofs
 *
 * Takes blind signatures from a mint swap response, unblinds them using the
 * secrets and blinding factors from bridge.createCloseData(), verifies DLEQ
 * proofs, and returns the separated receiver/sender proofs.
 *
 * # Arguments
 * * `blind_signatures_json` - JSON array of blind signatures from mint's swap response
 * * `secrets_with_blinding_json` - JSON array from createCloseData's secrets_with_blinding
 * * `params_json` - Full channel parameters JSON (for keyset_info and maximum_amount)
 * * `keyset_info_json` - KeysetInfo JSON (from fetchKeysetInfo)
 * * `shared_secret_hex` - Pre-computed shared secret (hex) for blinded pubkey derivation
 * * `balance` - The receiver's (Charlie's) intended balance (for verification)
 * * `output_keyset_info_json` - Optional KeysetInfo JSON for outputs (if switched during close)
 *
 * # Returns
 * JSON object with:
 * - `receiver_proofs`: Array of Charlie's P2PK proofs (DLEQ verified)
 * - `sender_proofs`: Array of Alice's P2PK proofs (DLEQ verified)
 * - `receiver_sum_after_stage1`: Sum of receiver proof amounts
 * - `sender_sum_after_stage1`: Sum of sender proof amounts
 */
export function unblind_and_verify_dleq(blind_signatures_json: string, secrets_with_blinding_json: string, params_json: string, keyset_info_json: string, shared_secret_hex: string, balance: bigint, output_keyset_info_json?: string | null): string;

/**
 * Verify a balance update signature from the sender (Alice)
 *
 * Takes:
 * - `params_json`: Channel parameters JSON
 * - `shared_secret_hex`: Pre-computed shared secret (hex)
 * - `funding_proofs_json`: JSON array of funding proofs
 * - `keyset_info_json`: KeysetInfo JSON (from fetchKeysetInfo)
 * - `channel_id`: The channel ID from the balance update
 * - `balance`: The balance amount from the balance update
 * - `signature`: Alice's Schnorr signature (hex)
 *
 * Returns `true` if the signature is valid, or an error if invalid
 */
export function verify_balance_update_signature(params_json: string, shared_secret_hex: string, funding_proofs_json: string, keyset_info_json: string, channel_id: string, balance: bigint, signature: string): boolean;

/**
 * Verify that a channel is valid
 *
 * This verifies everything about a channel that the receiver (Charlie)
 * needs to check before accepting it:
 *
 * 1. DLEQ proofs - the mint actually signed each funding proof
 *
 * Takes:
 * - `params_json`: Channel parameters JSON
 * - `shared_secret_hex`: Pre-computed shared secret (hex)
 * - `funding_proofs_json`: JSON array of funding proofs
 * - `keyset_info_json`: KeysetInfo JSON (from fetchKeysetInfo)
 *
 * Returns JSON: {"valid": true, "errors": []} or {"valid": false, "errors": [...]}
 */
export function verify_channel(params_json: string, shared_secret_hex: string, funding_proofs_json: string, keyset_info_json: string): string;

/**
 * Verify DLEQ proof on a Proof (offline signature verification)
 *
 * This allows anyone to verify that the mint really signed this token,
 * without needing to contact the mint. The proof must include the DLEQ
 * data (e, s, r) from construct_proofs.
 *
 * Takes:
 * - `proof_json`: A single proof with DLEQ data
 *   Format: {"amount": 1, "id": "00...", "secret": "...", "C": "02...", "dleq": {"e": "...", "s": "...", "r": "..."}}
 * - `mint_pubkey_hex`: The mint's public key for this amount (from keyset keys)
 *
 * Returns `true` if the DLEQ is valid, throws error otherwise
 */
export function verify_proof_dleq(proof_json: string, mint_pubkey_hex: string): boolean;
