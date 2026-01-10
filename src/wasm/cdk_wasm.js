
let imports = {};
imports['__wbindgen_placeholder__'] = module.exports;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

/**
 * Get channel_id from params JSON, shared secret, and keyset info
 *
 * This is effectively a method on ChannelParameters for FFI.
 * Takes the params JSON, the pre-computed shared secret (hex), and keyset info JSON.
 * @param {string} params_json
 * @param {string} shared_secret_hex
 * @param {string} keyset_info_json
 * @returns {string}
 */
function channel_parameters_get_channel_id(params_json, shared_secret_hex, keyset_info_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(shared_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.channel_parameters_get_channel_id(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}
exports.channel_parameters_get_channel_id = channel_parameters_get_channel_id;

/**
 * Compute ECDH shared secret from a secret key and counterparty's public key
 *
 * Returns the x-coordinate of the shared point as a hex string (32 bytes).
 * @param {string} my_secret_hex
 * @param {string} their_pubkey_hex
 * @returns {string}
 */
function compute_shared_secret(my_secret_hex, their_pubkey_hex) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(my_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(their_pubkey_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.compute_shared_secret(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}
exports.compute_shared_secret = compute_shared_secret;

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
 * @param {string} blind_signatures_json
 * @param {string} secrets_with_blinding_json
 * @param {string} keyset_info_json
 * @returns {string}
 */
function construct_proofs(blind_signatures_json, secrets_with_blinding_json, keyset_info_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(blind_signatures_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(secrets_with_blinding_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.construct_proofs(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}
exports.construct_proofs = construct_proofs;

/**
 * Create a fully-signed swap request for channel closing (Charlie's side)
 *
 * Charlie (the receiver/server) uses this to:
 * 1. Verify Alice's signature on the balance update
 * 2. Add his own signature to complete the 2-of-2 multisig
 * 3. Get the swap request ready to submit to the mint
 *
 * Takes:
 * - `params_json`: Channel parameters JSON
 * - `keyset_info_json`: KeysetInfo JSON (with full keys for output computation)
 * - `charlie_secret_hex`: Charlie's secret key (hex)
 * - `funding_proofs_json`: JSON array of funding proofs
 * - `channel_id`: The channel ID
 * - `balance`: Charlie's balance (the amount_due)
 * - `alice_signature`: Alice's Schnorr signature (hex) from the close request
 *
 * Returns JSON with:
 * - `swap_request`: The fully-signed swap request ready for mint
 * - `expected_total`: Expected total output amount (value after stage 1 fees)
 * @param {string} params_json
 * @param {string} keyset_info_json
 * @param {string} charlie_secret_hex
 * @param {string} funding_proofs_json
 * @param {string} channel_id
 * @param {bigint} balance
 * @param {string} alice_signature
 * @returns {string}
 */
function create_close_swap_request(params_json, keyset_info_json, charlie_secret_hex, funding_proofs_json, channel_id, balance, alice_signature) {
    let deferred8_0;
    let deferred8_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(charlie_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(funding_proofs_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(alice_signature, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ret = wasm.create_close_swap_request(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, balance, ptr5, len5);
        var ptr7 = ret[0];
        var len7 = ret[1];
        if (ret[3]) {
            ptr7 = 0; len7 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred8_0 = ptr7;
        deferred8_1 = len7;
        return getStringFromWasm0(ptr7, len7);
    } finally {
        wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
    }
}
exports.create_close_swap_request = create_close_swap_request;

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
 * @param {string} params_json
 * @param {string} my_secret_hex
 * @param {string} keyset_info_json
 * @returns {string}
 */
function create_funding_outputs(params_json, my_secret_hex, keyset_info_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(my_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.create_funding_outputs(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}
exports.create_funding_outputs = create_funding_outputs;

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
 * @param {string} params_json
 * @param {string} keyset_info_json
 * @param {string} charlie_secret_hex
 * @param {string} shared_secret_hex
 * @param {bigint} amount
 * @param {number} index
 * @returns {string}
 */
function get_receiver_blinded_secret_key_for_stage2_output(params_json, keyset_info_json, charlie_secret_hex, shared_secret_hex, amount, index) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(charlie_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(shared_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.get_receiver_blinded_secret_key_for_stage2_output(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, amount, index);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}
exports.get_receiver_blinded_secret_key_for_stage2_output = get_receiver_blinded_secret_key_for_stage2_output;

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
 * @param {string} params_json
 * @param {string} keyset_info_json
 * @param {string} alice_secret_hex
 * @param {bigint} amount
 * @param {number} index
 * @returns {string}
 */
function get_sender_blinded_secret_key_for_stage2_output(params_json, keyset_info_json, alice_secret_hex, amount, index) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(alice_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.get_sender_blinded_secret_key_for_stage2_output(ptr0, len0, ptr1, len1, ptr2, len2, amount, index);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}
exports.get_sender_blinded_secret_key_for_stage2_output = get_sender_blinded_secret_key_for_stage2_output;

/**
 * Initialize panic hook for better error messages in browser console
 */
function init() {
    wasm.init();
}
exports.init = init;

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
 * @param {string} params_json
 * @param {string} keyset_info_json
 * @param {string} alice_secret_hex
 * @param {string} funding_proofs_json
 * @param {bigint} charlie_balance
 * @returns {string}
 */
function spilman_channel_sender_create_signed_balance_update(params_json, keyset_info_json, alice_secret_hex, funding_proofs_json, charlie_balance) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(alice_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(funding_proofs_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.spilman_channel_sender_create_signed_balance_update(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, charlie_balance);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}
exports.spilman_channel_sender_create_signed_balance_update = spilman_channel_sender_create_signed_balance_update;

/**
 * Unblind blind signatures and verify DLEQ proofs
 *
 * Takes blind signatures from a mint swap response, unblinds them using the
 * secrets and blinding factors from create_close_swap_request, verifies DLEQ
 * proofs, and returns the separated receiver/sender proofs.
 *
 * # Arguments
 * * `blind_signatures_json` - JSON array of blind signatures from mint's swap response
 * * `secrets_with_blinding_json` - JSON array from create_close_swap_request's secrets_with_blinding
 * * `params_json` - Full channel parameters JSON (for keyset_info and maximum_amount)
 * * `keyset_info_json` - KeysetInfo JSON (from fetchKeysetInfo)
 * * `shared_secret_hex` - Pre-computed shared secret (hex) for blinded pubkey derivation
 * * `balance` - The receiver's (Charlie's) intended balance (for verification)
 *
 * # Returns
 * JSON object with:
 * - `receiver_proofs`: Array of Charlie's P2PK proofs (DLEQ verified)
 * - `sender_proofs`: Array of Alice's P2PK proofs (DLEQ verified)
 * - `receiver_sum_after_stage1`: Sum of receiver proof amounts
 * - `sender_sum_after_stage1`: Sum of sender proof amounts
 * @param {string} blind_signatures_json
 * @param {string} secrets_with_blinding_json
 * @param {string} params_json
 * @param {string} keyset_info_json
 * @param {string} shared_secret_hex
 * @param {bigint} balance
 * @returns {string}
 */
function unblind_and_verify_dleq(blind_signatures_json, secrets_with_blinding_json, params_json, keyset_info_json, shared_secret_hex, balance) {
    let deferred7_0;
    let deferred7_1;
    try {
        const ptr0 = passStringToWasm0(blind_signatures_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(secrets_with_blinding_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(shared_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.unblind_and_verify_dleq(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, balance);
        var ptr6 = ret[0];
        var len6 = ret[1];
        if (ret[3]) {
            ptr6 = 0; len6 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred7_0 = ptr6;
        deferred7_1 = len6;
        return getStringFromWasm0(ptr6, len6);
    } finally {
        wasm.__wbindgen_free(deferred7_0, deferred7_1, 1);
    }
}
exports.unblind_and_verify_dleq = unblind_and_verify_dleq;

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
 * @param {string} params_json
 * @param {string} shared_secret_hex
 * @param {string} funding_proofs_json
 * @param {string} keyset_info_json
 * @param {string} channel_id
 * @param {bigint} balance
 * @param {string} signature
 * @returns {boolean}
 */
function verify_balance_update_signature(params_json, shared_secret_hex, funding_proofs_json, keyset_info_json, channel_id, balance, signature) {
    const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(shared_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(funding_proofs_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passStringToWasm0(signature, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len5 = WASM_VECTOR_LEN;
    const ret = wasm.verify_balance_update_signature(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, balance, ptr5, len5);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
exports.verify_balance_update_signature = verify_balance_update_signature;

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
 * @param {string} params_json
 * @param {string} shared_secret_hex
 * @param {string} funding_proofs_json
 * @param {string} keyset_info_json
 * @returns {string}
 */
function verify_channel(params_json, shared_secret_hex, funding_proofs_json, keyset_info_json) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(shared_secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(funding_proofs_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(keyset_info_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.verify_channel(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}
exports.verify_channel = verify_channel;

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
 * @param {string} proof_json
 * @param {string} mint_pubkey_hex
 * @returns {boolean}
 */
function verify_proof_dleq(proof_json, mint_pubkey_hex) {
    const ptr0 = passStringToWasm0(proof_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(mint_pubkey_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.verify_proof_dleq(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
exports.verify_proof_dleq = verify_proof_dleq;

exports.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
};

exports.__wbg___wbindgen_is_object_ce774f3490692386 = function(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
};

exports.__wbg___wbindgen_is_string_704ef9c8fc131030 = function(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
};

exports.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
    const ret = arg0 === undefined;
    return ret;
};

exports.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

exports.__wbg_call_3020136f7a2d6e44 = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments) };

exports.__wbg_call_abb4ff46ce38be40 = function() { return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
}, arguments) };

exports.__wbg_crypto_574e78ad8b13b65f = function(arg0) {
    const ret = arg0.crypto;
    return ret;
};

exports.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
};

exports.__wbg_getRandomValues_b8f5dbd5f3995a9e = function() { return handleError(function (arg0, arg1) {
    arg0.getRandomValues(arg1);
}, arguments) };

exports.__wbg_length_22ac23eaec9d8053 = function(arg0) {
    const ret = arg0.length;
    return ret;
};

exports.__wbg_msCrypto_a61aeb35a24c1329 = function(arg0) {
    const ret = arg0.msCrypto;
    return ret;
};

exports.__wbg_new_8a6f238a6ece86ea = function() {
    const ret = new Error();
    return ret;
};

exports.__wbg_new_no_args_cb138f77cf6151ee = function(arg0, arg1) {
    const ret = new Function(getStringFromWasm0(arg0, arg1));
    return ret;
};

exports.__wbg_new_with_length_aa5eaf41d35235e5 = function(arg0) {
    const ret = new Uint8Array(arg0 >>> 0);
    return ret;
};

exports.__wbg_node_905d3e251edff8a2 = function(arg0) {
    const ret = arg0.node;
    return ret;
};

exports.__wbg_now_69d776cd24f5215b = function() {
    const ret = Date.now();
    return ret;
};

exports.__wbg_process_dc0fbacc7c1c06f7 = function(arg0) {
    const ret = arg0.process;
    return ret;
};

exports.__wbg_prototypesetcall_dfe9b766cdc1f1fd = function(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
};

exports.__wbg_randomFillSync_ac0988aba3254290 = function() { return handleError(function (arg0, arg1) {
    arg0.randomFillSync(arg1);
}, arguments) };

exports.__wbg_require_60cc747a6bc5215a = function() { return handleError(function () {
    const ret = module.require;
    return ret;
}, arguments) };

exports.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
};

exports.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = function() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

exports.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = function() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

exports.__wbg_static_accessor_SELF_08f5a74c69739274 = function() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

exports.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = function() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
};

exports.__wbg_subarray_845f2f5bce7d061a = function(arg0, arg1, arg2) {
    const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
    return ret;
};

exports.__wbg_versions_c01dfd4722a88165 = function(arg0) {
    const ret = arg0.versions;
    return ret;
};

exports.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
};

exports.__wbindgen_cast_cb9088102bce6b30 = function(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
    const ret = getArrayU8FromWasm0(arg0, arg1);
    return ret;
};

exports.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
};

const wasmPath = `${__dirname}/cdk_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasm = exports.__wasm = new WebAssembly.Instance(wasmModule, imports).exports;

wasm.__wbindgen_start();
