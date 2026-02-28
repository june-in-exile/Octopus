/**
 * Octopus SDK - ZK Proof Generation
 *
 * Generates Groth16 proofs for unshield operations using snarkjs.
 */

import * as snarkjs from "snarkjs";
import {
  type UnshieldInput,
  type UnshieldCircuitInput,
  type TransferInput,
  type TransferCircuitInput,
  type SwapInput,
  type SwapCircuitInput,
  type SuiProof,
} from "./types.js";
import {
  serializeProof,
  serializePublicInputs,
  validateInputs,
  padInputsTo2,
  computeAndVerifyMerkleRoot,
} from "./utils/index.js";
import { computeNullifier } from "./crypto.js";
import { bigIntToLE32 } from "./utils/bytes.js";


// Lazy-loaded Node.js modules (only used in Node.js environment)
let fs: any;
let path: any;
let url: any;

/** Check if running in Node.js environment */
function isNodeEnvironment(): boolean {
  return typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null;
}

/** Helper: Path validation for Node.js environment */
function validateAndGetPaths(wasmPath: string, zkeyPath: string): [string, string] {
  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`Zkey not found: ${zkeyPath}`);
  return [wasmPath, zkeyPath];
}

/** Load file in browser environment via fetch */
async function loadFileBrowser(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.arrayBuffer();
}

/** Helper: Resource loading for browser environment */
async function loadBrowserBuffers(wasmPath: string, zkeyPath: string): Promise<[Uint8Array, Uint8Array]> {
  const [wasmBuf, zkeyBuf] = await Promise.all([
    loadFileBrowser(wasmPath),
    loadFileBrowser(zkeyPath),
  ]);
  return [new Uint8Array(wasmBuf), new Uint8Array(zkeyBuf)];
}

/**
 * BCS-encode a vector<vector<u8>> for Sui transaction arguments.
 * Each inner vector length and the outer length are encoded as ULEB128 (single byte for < 128).
 */
function encodeBcsVectorOfVectors(arrays: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  // Outer length (ULEB128, single byte since arrays.length < 128)
  parts.push(new Uint8Array([arrays.length]));
  for (const arr of arrays) {
    // Inner length (ULEB128, single byte since arr.length < 128)
    parts.push(new Uint8Array([arr.length]));
    parts.push(arr);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

// ============ Unshield Proof Functions ============

/** Get default paths to unshield circuit artifacts */
function getUnshieldCircuitPaths() {
  if (isNodeEnvironment()) {
    // Node.js: Load from filesystem
    if (!fs) {
      fs = require('fs');
      path = require('path');
      url = require('url');
    }

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

    return {
      wasmPath: path.resolve(__dirname, "../../circuits/build/unshield_js/unshield.wasm"),
      zkeyPath: path.resolve(__dirname, "../../circuits/build/unshield_final.zkey"),
      vkPath: path.resolve(__dirname, "../../circuits/build/unshield_vk.json"),
    };
  } else {
    // Browser: Load from public directory via fetch
    return {
      wasmPath: "/circuits/unshield_js/unshield.wasm",
      zkeyPath: "/circuits/unshield_final.zkey",
      vkPath: "/circuits/unshield_vk.json",
    };
  }
}

/**
 * Split a Sui address into two 128-bit LE field elements for Poseidon hashing.
 *
 * Sui addresses are 32 bytes (256-bit). BN254 scalar field is ~254.85 bits — direct
 * encoding overflows ~1.4% of addresses. Splitting into 128-bit halves is safe.
 * Mirrors compute_recipient_hash() in the Move contract.
 */
function recipientToFieldElements(recipientHex: string): { lo: bigint; hi: bigint } {
  const clean = recipientHex.startsWith('0x') ? recipientHex.slice(2) : recipientHex;
  if (clean.length !== 64) {
    throw new Error(`Invalid Sui address: expected 64 hex chars, got ${clean.length}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  // lo: bytes[0..16] as little-endian u128
  let lo = 0n;
  for (let i = 15; i >= 0; i--) lo = (lo << 8n) | BigInt(bytes[i]);
  // hi: bytes[16..32] as little-endian u128
  let hi = 0n;
  for (let i = 31; i >= 16; i--) hi = (hi << 8n) | BigInt(bytes[i]);
  return { lo, hi };
}

/**
 * Build circuit input for unshield proof
 */
function buildUnshieldCircuitInput(unshieldInput: UnshieldInput): UnshieldCircuitInput {
  const {
    keypair,
    inputNotes,
    inputLeafIndices,
    inputPathElements,
    unshieldAmount,
    changeNote,
    token,
    recipient
  } = unshieldInput;

  validateInputs(inputNotes, inputLeafIndices, inputPathElements, token, "Unshield");

  const [paddedInputs, paddedIndices, paddedPaths] = padInputsTo2(
    inputNotes, inputLeafIndices, inputPathElements, token
  );

  // Validate balance
  const inputSum = inputNotes.reduce((sum, n) => sum + n.amount, 0n);
  if (unshieldAmount <= 0n) {
    throw new Error(`Unshield amount must be positive, got: ${unshieldAmount}`);
  }
  if (unshieldAmount > inputSum) {
    throw new Error(
      `Unshield amount (${unshieldAmount}) exceeds total input anount (${inputSum})`
    );
  }
  const outputSum = unshieldAmount + changeNote.amount;
  if (inputSum !== outputSum) {
    throw new Error(
      `Balance mismatch: inputs=${inputSum}, outputs=${outputSum}. ` +
      `Unshield requires input_sum === unshield_anount + change_anount`
    );
  }

  const merkleRoot = computeAndVerifyMerkleRoot(paddedInputs, paddedPaths, paddedIndices);

  // Compute nullifiers: Poseidon(nullifying_key, leaf_index), 0 for dummy notes (amount === 0)
  const nullifierValues: bigint[] = paddedInputs.map((note, i) =>
    note.amount === 0n ? 0n : computeNullifier(keypair.nullifyingKey, paddedIndices[i])
  );
  const nullifiers = nullifierValues.map(v => v.toString());

  const { lo: recipientAddrLo, hi: recipientAddrHi } = recipientToFieldElements(recipient);

  const circuitInput: UnshieldCircuitInput = {
    // Private inputs
    spending_key: keypair.spendingKey.toString(),
    nullifying_key: keypair.nullifyingKey.toString(),

    input_randoms: paddedInputs.map(n => n.random.toString()),
    input_amounts: paddedInputs.map(n => n.amount.toString()),
    input_leaf_indices: paddedIndices.map(idx => idx.toString()),
    input_path_elements: paddedPaths.map(path => path.map(e => e.toString())),

    change_random: changeNote.random.toString(),
    change_amount: changeNote.amount.toString(),

    nullifiers,

    recipient_addr_lo: recipientAddrLo.toString(),
    recipient_addr_hi: recipientAddrHi.toString(),

    // Public inputs
    unshield_amount: unshieldAmount.toString(),
    token: token.toString(),
    merkle_root: merkleRoot.toString(),
  };

  return circuitInput;
}

/**
 * Convert snarkjs proof to Sui-compatible format (Arkworks compressed) with 2-input support
 */
function convertUnshieldProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[],
): SuiProof {
  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return {
    proofBytes,
    publicInputsBytes
  };
}

/**
 * Generate unshield proof and convert to Sui format (with change support).
 * Returns the ZK proof and the nullifiers separately — nullifiers must be
 * passed explicitly to the contract (as vector<vector<u8>>) alongside the proof.
 */
export async function generateUnshieldProof(
  unshieldInput: UnshieldInput,
): Promise<{ proof: SuiProof; nullifiers: Uint8Array }> {
  const { wasmPath, zkeyPath } = getUnshieldCircuitPaths();

  // 1. Build circuit input (includes precomputed nullifiers as private inputs)
  const circuitInput = buildUnshieldCircuitInput(unshieldInput);

  // 2. Prepare resources (get content or paths based on environment)
  const [wasm, zkey] = isNodeEnvironment()
    ? validateAndGetPaths(wasmPath, zkeyPath)
    : await loadBrowserBuffers(wasmPath, zkeyPath);

  // 3. Execute proof generation
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput as unknown as snarkjs.CircuitSignals,
    wasm,
    zkey
  );

  // 4. Serialize nullifiers as LE32 bytes and BCS-encode as vector<vector<u8>>
  const nullifierArrays = circuitInput.nullifiers.map((v: string) => {
    const n = BigInt(v);
    return n === 0n ? new Uint8Array(32) : bigIntToLE32(n);
  });
  const nullifiers = encodeBcsVectorOfVectors(nullifierArrays);

  return { proof: convertUnshieldProofToSui(proof, publicSignals), nullifiers };
}

// ============ Transfer Proof Functions ============

/** Get default paths to transfer circuit artifacts */
function getTransferCircuitPaths() {
  if (isNodeEnvironment()) {
    // Node.js: Load from filesystem
    if (!fs) {
      fs = require('fs');
      path = require('path');
      url = require('url');
    }

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

    return {
      wasmPath: path.resolve(__dirname, "../../circuits/build/transfer_js/transfer.wasm"),
      zkeyPath: path.resolve(__dirname, "../../circuits/build/transfer_final.zkey"),
      vkPath: path.resolve(__dirname, "../../circuits/build/transfer_vk.json"),
    };
  } else {
    // Browser: Load from public directory via fetch
    return {
      wasmPath: "/circuits/transfer_js/transfer.wasm",
      zkeyPath: "/circuits/transfer_final.zkey",
      vkPath: "/circuits/transfer_vk.json",
    };
  }
}

/**
 * Build circuit input for transfer proof (2-input, 2-output)
 * Updated to match new transfer.circom interface with separate transfer/change outputs
 */
function buildTransferCircuitInput(transferInput: TransferInput): TransferCircuitInput {
  const {
    keypair,
    inputNotes,
    inputLeafIndices,
    inputPathElements,
    recipientMpk,
    recipientNote,
    changeNote,
    token
  } = transferInput;

  validateInputs(inputNotes, inputLeafIndices, inputPathElements, token, "Transfer");

  const [paddedInputs, paddedIndices, paddedPaths] = padInputsTo2(
    inputNotes, inputLeafIndices, inputPathElements, token
  );

  // Validate balance
  const inputSum = inputNotes.reduce((sum, note) => sum + note.amount, 0n);
  if (recipientNote.amount <= 0n) {
    throw new Error(`Transfer amount must be positive, got: ${recipientNote.amount}`);
  }
  if (recipientNote.amount > inputSum) {
    throw new Error(
      `Transfer amount (${recipientNote.amount}) exceeds total input anount (${inputSum})`
    );
  }
  const outputSum = recipientNote.amount + changeNote.amount;
  if (inputSum !== outputSum) {
    throw new Error(
      `Balance mismatch: inputs=${inputSum}, outputs=${outputSum}. ` +
      `Transfer requires input_sum === transfer_anount + change_anount`
    );
  }

  const merkleRoot = computeAndVerifyMerkleRoot(paddedInputs, paddedPaths, paddedIndices);

  // Compute nullifiers: Poseidon(nullifying_key, leaf_index), 0 for dummy notes (amount === 0)
  const nullifierValues: bigint[] = paddedInputs.map((note, i) =>
    note.amount === 0n ? 0n : computeNullifier(keypair.nullifyingKey, paddedIndices[i])
  );
  const nullifiers = nullifierValues.map(v => v.toString());

  const circuitInput: TransferCircuitInput = {
    // Private inputs
    spending_key: keypair.spendingKey.toString(),
    nullifying_key: keypair.nullifyingKey.toString(),

    input_randoms: paddedInputs.map((n) => n.random.toString()),
    input_amounts: paddedInputs.map((n) => n.amount.toString()),
    input_leaf_indices: paddedIndices.map((idx) => idx.toString()),
    input_path_elements: paddedPaths.map((path) => path.map((e) => e.toString())),

    recipient_mpk: recipientMpk.toString(),
    recipient_random: recipientNote.random.toString(),
    recipient_amount: recipientNote.amount.toString(),

    change_random: changeNote.random.toString(),
    change_amount: changeNote.amount.toString(),

    nullifiers,

    // Public inputs
    token: token.toString(),
    merkle_root: merkleRoot.toString(),
  };

  return circuitInput;
}

/**
 * Convert transfer proof to Sui-compatible format (Arkworks compressed)
 */
function convertTransferProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[]
): SuiProof {
  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}

/**
 * Generate transfer proof and convert to Sui format.
 * Returns the ZK proof and the nullifiers separately — nullifiers must be
 * passed explicitly to the contract (as vector<vector<u8>>) alongside the proof.
 */
export async function generateTransferProof(
  transferInput: TransferInput,
): Promise<{ proof: SuiProof; nullifiers: Uint8Array }> {
  const { wasmPath, zkeyPath } = getTransferCircuitPaths();

  // 1. Build circuit input (includes precomputed nullifiers as private inputs)
  const circuitInput = buildTransferCircuitInput(transferInput);

  // 2. Prepare resources (get content or paths based on environment)
  const [wasm, zkey] = isNodeEnvironment()
    ? validateAndGetPaths(wasmPath, zkeyPath)
    : await loadBrowserBuffers(wasmPath, zkeyPath);

  // 3. Execute proof generation
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput as unknown as snarkjs.CircuitSignals,
    wasm,
    zkey
  );

  // 4. Serialize nullifiers as LE32 bytes and BCS-encode as vector<vector<u8>>
  const nullifierArrays = circuitInput.nullifiers.map((v: string) => {
    const n = BigInt(v);
    return n === 0n ? new Uint8Array(32) : bigIntToLE32(n);
  });
  const nullifiers = encodeBcsVectorOfVectors(nullifierArrays);

  return { proof: convertTransferProofToSui(proof, publicSignals), nullifiers };
}

// ============ Swap Proof Functions ============

/**
 * Get default paths to swap circuit artifacts
 */
function getSwapCircuitPaths() {
  if (isNodeEnvironment()) {
    // Node.js: Load from filesystem
    if (!fs) {
      fs = require('fs');
      path = require('path');
      url = require('url');
    }

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

    return {
      wasmPath: path.resolve(__dirname, "../../circuits/build/swap_js/swap.wasm"),
      zkeyPath: path.resolve(__dirname, "../../circuits/build/swap_final.zkey"),
    };
  } else {
    // Browser: Load from public directory via fetch
    return {
      wasmPath: "/circuits/swap_js/swap.wasm",
      zkeyPath: "/circuits/swap_final.zkey",
    };
  }
}

/**
 * Build circuit input for swap proof.
 * Returns the circuit input along with padded inputs/indices (used to compute nullifiers).
 */
function buildSwapCircuitInput(swapInput: SwapInput): SwapCircuitInput {
  const {
    keypair,
    inputNotes,
    inputLeafIndices,
    inputPathElements,
    swapNote,
    changeNote,
  } = swapInput;

  const tokenIn = changeNote.token;
  const tokenOut = swapNote.token;

  validateInputs(inputNotes, inputLeafIndices, inputPathElements, tokenIn, "Swap");

  const [paddedInputs, paddedIndices, paddedPaths] = padInputsTo2(
    inputNotes, inputLeafIndices, inputPathElements, tokenIn
  );

  const merkleRoot = computeAndVerifyMerkleRoot(paddedInputs, paddedPaths, paddedIndices);

  // Compute nullifiers: Poseidon(nullifying_key, leaf_index), 0 for dummy notes (amount === 0)
  const nullifierValues: bigint[] = paddedInputs.map((note, i) =>
    note.amount === 0n ? 0n : computeNullifier(keypair.nullifyingKey, paddedIndices[i])
  );
  const nullifiers = nullifierValues.map(v => v.toString());

  const circuitInput: SwapCircuitInput = {
    // Private inputs
    spending_key: keypair.spendingKey.toString(),
    nullifying_key: keypair.nullifyingKey.toString(),

    input_randoms: paddedInputs.map((n) => n.random.toString()),
    input_amounts: paddedInputs.map(n => n.amount.toString()),
    input_leaf_indices: paddedIndices.map((idx) => idx.toString()),
    input_path_elements: paddedPaths.map((path) => path.map((e) => e.toString())),

    swap_random: swapNote.random.toString(),

    change_random: changeNote.random.toString(),
    change_amount: changeNote.amount.toString(),

    nullifiers,

    // Public inputs
    token_in: tokenIn.toString(),
    token_out: tokenOut.toString(),
    amount_in: (paddedInputs.reduce((sum, n) => { return sum + BigInt(n.amount) }, 0n) - changeNote.amount).toString(),
    min_amount_out: swapNote.amount.toString(),
    merkle_root: merkleRoot.toString(),
  };

  return circuitInput;
}

/**
 * Convert swap proof to Sui-compatible format (Arkworks compressed)
 */
function convertSwapProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[]
): SuiProof {
  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}

/**
 * Generate a swap proof and convert to Sui format.
 * Returns the ZK proof and the nullifiers separately — nullifiers must be
 * passed explicitly to the contract (as vector<vector<u8>>) alongside the proof.
 */
export async function generateSwapProof(
  swapInput: SwapInput,
): Promise<{ proof: SuiProof; nullifiers: Uint8Array }> {
  const { wasmPath, zkeyPath } = getSwapCircuitPaths();

  // 1. Build circuit input (includes precomputed nullifiers as private inputs)
  const circuitInput = buildSwapCircuitInput(swapInput);

  // 2. Prepare resources (get content or paths based on environment)
  const [wasm, zkey] = isNodeEnvironment()
    ? validateAndGetPaths(wasmPath, zkeyPath)
    : await loadBrowserBuffers(wasmPath, zkeyPath);

  // 3. Execute proof generation
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput as unknown as snarkjs.CircuitSignals,
    wasm,
    zkey
  );

  // 4. Serialize nullifiers as LE32 bytes and BCS-encode as vector<vector<u8>>
  const nullifierArrays = circuitInput.nullifiers.map((v: string) => {
    const n = BigInt(v);
    return n === 0n ? new Uint8Array(32) : bigIntToLE32(n);
  });
  const nullifiers = encodeBcsVectorOfVectors(nullifierArrays);

  return { proof: convertSwapProofToSui(proof, publicSignals), nullifiers };
}
