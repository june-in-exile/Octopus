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
 * Build circuit input for unshield proof (2-input support with change)
 */
function buildUnshieldInput(unshieldInput: UnshieldInput): UnshieldCircuitInput {
  const {
    keypair,
    inputNotes,
    inputLeafIndices,
    inputPathElements,
    unshieldAmount,
    changeNote,
    token
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
  // Validate public signals count for 2-input unshield circuit
  if (publicSignals.length !== 6) {
    throw new Error(`Expected 6 public signals for 2-input unshield, got ${publicSignals.length}`);
  }

  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return {
    proofBytes,
    publicInputsBytes
  };
}

/**
 * Generate unshield proof and convert to Sui format (with change support)
 */
export async function generateUnshieldProof(
  unshieldInput: UnshieldInput,
): Promise<SuiProof> {
  const { wasmPath, zkeyPath } = getUnshieldCircuitPaths();

  // 1. Build circuit input
  const circuitInput = buildUnshieldInput(unshieldInput);

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

  // 4. Convert to Sui format
  return convertUnshieldProofToSui(proof, publicSignals);
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
function buildTransferInput(transferInput: TransferInput): TransferCircuitInput {
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
  // Validate public signals count for transfer circuit
  if (publicSignals.length !== 6) {
    throw new Error(`Expected 6 public signals for transfer, got ${publicSignals.length}`);
  }

  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}

/**
 * Generate transfer proof and convert to Sui format
 */
export async function generateTransferProof(
  transferInput: TransferInput,
): Promise<SuiProof> {
  const { wasmPath, zkeyPath } = getTransferCircuitPaths();

  // 1. Build circuit input
  const circuitInput = buildTransferInput(transferInput);

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

  // 4. Convert to Sui format
  return convertTransferProofToSui(proof, publicSignals);
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
 * Build circuit input for swap proof
 */
function buildSwapInput(swapInput: SwapInput): SwapCircuitInput {
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

    // Public inputs
    token_in: tokenIn.toString(),
    token_out: tokenOut.toString(),
    amount_in: (paddedInputs.reduce((sum, n) => { return sum + BigInt(n.amount) }, 0n) - changeNote.amount).toString(),
    amount_out: swapNote.amount.toString(),
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
  // Validate public signals count for swap circuit
  // Expected: nullifier1, nullifier2, swap_data_hash, output_commitment, change_commitment, token_in, token_out, merkle_root
  if (publicSignals.length !== 8) {
    throw new Error(`Expected 8 public signals for swap, got ${publicSignals.length}`);
  }

  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}

/**
 * Generate a swap proof and convert to Sui format
 */
export async function generateSwapProof(
  swapInput: SwapInput,
): Promise<SuiProof> {
  const { wasmPath, zkeyPath } = getSwapCircuitPaths();

  // 1. Build circuit input
  const circuitInput = buildSwapInput(swapInput);

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

  // 4. Convert to Sui format
  return convertSwapProofToSui(proof, publicSignals);
}
