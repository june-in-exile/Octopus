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
  type Note,
  MERKLE_TREE_DEPTH,
} from "./types.js";
import {
  computeMerkleRoot,
  poseidonHash,
} from "./crypto.js";

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

function validateMerkleRoot(expected: string, actual: string): void {
  if (expected !== actual) {
    console.warn("Merkle root mismatch between SDK and circuit");
  }
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
    unshieldValue,
    outputNote,
    token
  } = unshieldInput;

  // Validate inputs
  if (inputNotes.length < 1 || inputNotes.length > 2) {
    throw new Error("Unshield requires 1 or 2 input notes");
  }
  if (inputLeafIndices.length !== inputNotes.length || inputPathElements.length !== inputNotes.length) {
    throw new Error("Leaf indices and path elements must match notes count");
  }

  // Verify all path elements have correct length
  for (const paths of inputPathElements) {
    if (paths.length !== MERKLE_TREE_DEPTH) {
      throw new Error(
        `Invalid path elements length: ${paths.length}, expected ${MERKLE_TREE_DEPTH}`
      );
    }
  }

  // Verify all notes have same token
  if (inputNotes.some(n => n.token !== token)) {
    throw new Error("All input notes must be same token type");
  }

  // Pad to 2 inputs if only 1 provided (dummy note with value=0)
  const paddedInputs = [...inputNotes];
  const paddedIndices = [...inputLeafIndices];
  const paddedPaths = [...inputPathElements];

  if (paddedInputs.length === 1) {
    // Create dummy note (value=0 triggers Merkle bypass in circuit)
    const dummyRandom = 0n;
    const dummyNote: Note = {
      nsk: 0n,
      token: token,
      value: 0n,               // Triggers Merkle bypass
      random: dummyRandom,
      commitment: 0n
    };
    paddedInputs.push(dummyNote);
    // Use a unique leaf index for the dummy note to avoid nullifier collision.
    const dummyIndex = inputLeafIndices[0] === 0 ? 1 : 0;
    paddedIndices.push(dummyIndex);
    // For dummy input, path elements should all be zero
    paddedPaths.push(Array(MERKLE_TREE_DEPTH).fill(0n));
  }

  // Validate balance
  const inputSum = paddedInputs.reduce((sum, n) => sum + n.value, 0n);
  const changeNote = outputNote;
  if (unshieldValue <= 0n) {
    throw new Error(`Unshield amount must be positive, got: ${unshieldValue}`);
  }
  if (unshieldValue > inputSum) {
    throw new Error(
      `Unshield amount (${unshieldValue}) exceeds total input value (${inputSum})`
    );
  }
  const outputSum = unshieldValue + changeNote.value;
  if (inputSum !== outputSum) {
    throw new Error(
      `Balance mismatch: inputs=${inputSum}, outputs=${outputSum}. ` +
      `Unshield requires input_sum === unshield_value + change_value`
    );
  }

  // Compute merkle root from first input note
  const merkleRoot = computeMerkleRoot(
    paddedInputs[0].commitment,
    paddedPaths[0],
    paddedIndices[0]
  );

  // Verify second input (if non-dummy) has same root
  if (paddedInputs.length === 2 && paddedInputs[1].value > 0n) {
    const root2 = computeMerkleRoot(
      paddedInputs[1].commitment,
      paddedPaths[1],
      paddedIndices[1]
    );

    if (root2 !== merkleRoot) {
      throw new Error(
        `Merkle root mismatch! This will cause circuit failure.\n` +
        `Input 0: leafIndex=${paddedIndices[0]}, root=${merkleRoot.toString()}\n` +
        `Input 1: leafIndex=${paddedIndices[1]}, root=${root2.toString()}\n`
      );
    }
  }

  const circuitInput: UnshieldCircuitInput = {
    // Private inputs
    spending_key: keypair.spendingKey.toString(),
    nullifying_key: keypair.nullifyingKey.toString(),

    input_randoms: paddedInputs.map(n => n.random.toString()),
    input_values: paddedInputs.map(n => n.value.toString()),
    input_leaf_indices: paddedIndices.map(idx => idx.toString()),
    input_path_elements: paddedPaths.map(path => path.map(e => e.toString())),

    change_value: changeNote.value.toString(),
    change_random: changeNote.random.toString(),

    // Public inputs
    unshield_value: unshieldValue.toString(),
    token: token.toString(),
    merkle_root: merkleRoot.toString(),
  };

  return circuitInput;
}

/**
 * Generate unshield proof using snarkjs (with change support)
 */
export async function generateUnshieldProof(
  unshieldInput: UnshieldInput,
): Promise<{ proof: snarkjs.Groth16Proof; publicSignals: string[] }> {
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

  return { proof, publicSignals };
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
    outputNotes,
    token
  } = transferInput;

  // Validate inputs
  if (inputNotes.length < 1 || inputNotes.length > 2) {
    throw new Error("Transfer requires 1 or 2 input notes");
  }
  if (inputLeafIndices.length !== inputNotes.length || inputPathElements.length !== inputNotes.length) {
    throw new Error("Leaf indices and path elements must match notes count");
  }

  // Verify all path elements have correct length
  for (const paths of inputPathElements) {
    if (paths.length !== MERKLE_TREE_DEPTH) {
      throw new Error(
        `Invalid path elements length: ${paths.length}, expected ${MERKLE_TREE_DEPTH}`
      );
    }
  }

  // Verify all notes have same token
  if (inputNotes.some(n => n.token !== token)) {
    throw new Error("All input notes must be same token type");
  }

  // Pad to 2 inputs if only 1 provided (use dummy note with value=0)
  const paddedInputs = [...inputNotes];
  const paddedIndices = [...inputLeafIndices];
  const paddedPaths = [...inputPathElements];

  if (paddedInputs.length === 1) {
    // Create dummy note (value=0 triggers Merkle bypass in circuit)
    const dummyRandom = 0n;
    const dummyNote: Note = {
      nsk: 0n,
      token: token,
      value: 0n,               // Triggers Merkle bypass
      random: dummyRandom,
      commitment: 0n
    };
    paddedInputs.push(dummyNote);
    // Use a unique leaf index for the dummy note to avoid nullifier collision.
    const dummyIndex = inputLeafIndices[0] === 0 ? 1 : 0;
    paddedIndices.push(dummyIndex);
    // For dummy input, path elements should all be zero
    paddedPaths.push(Array(MERKLE_TREE_DEPTH).fill(0n));
  }

  // Validate balance
  const inputSum = inputNotes.reduce((sum, note) => sum + note.value, 0n);
  const transferNote = outputNotes[0];
  const changeNote = outputNotes[1];
  if (transferNote.value <= 0n) {
    throw new Error(`Transfer amount must be positive, got: ${transferNote.value}`);
  }
  if (transferNote.value > inputSum) {
    throw new Error(
      `Transfer amount (${transferNote.value}) exceeds total input value (${inputSum})`
    );
  }
  const outputSum = transferNote.value + changeNote.value;
  if (inputSum !== outputSum) {
    throw new Error(
      `Balance mismatch: inputs=${inputSum}, outputs=${outputSum}. ` +
      `Transfer requires input_sum === transfer_value + change_value`
    );
  }

  // Compute merkle root from first input note
  const merkleRoot = computeMerkleRoot(
    paddedInputs[0].commitment,
    paddedPaths[0],
    paddedIndices[0]
  );

  // Verify second input (if non-dummy) has same root
  if (paddedInputs.length === 2 && paddedInputs[1].value > 0n) {
    const root2 = computeMerkleRoot(
      paddedInputs[1].commitment,
      paddedPaths[1],
      paddedIndices[1]
    );

    if (root2 !== merkleRoot) {
      throw new Error(
        `Merkle root mismatch! This will cause circuit failure.\n` +
        `Input 0: leafIndex=${paddedIndices[0]}, root=${merkleRoot.toString()}\n` +
        `Input 1: leafIndex=${paddedIndices[1]}, root=${root2.toString()}\n`
      );
    }
  }

  const circuitInput: TransferCircuitInput = {
    // Private inputs
    spending_key: keypair.spendingKey.toString(),
    nullifying_key: keypair.nullifyingKey.toString(),

    input_randoms: paddedInputs.map((n) => n.random.toString()),
    input_values: paddedInputs.map((n) => n.value.toString()),
    input_leaf_indices: paddedIndices.map((idx) => idx.toString()),
    input_path_elements: paddedPaths.map((path) => path.map((e) => e.toString())),

    recipient_mpk: recipientMpk.toString(),
    transfer_value: transferNote.value.toString(),
    transfer_random: transferNote.random.toString(),

    change_value: changeNote.value.toString(),
    change_random: changeNote.random.toString(),

    // Public inputs
    token: token.toString(),
    merkle_root: merkleRoot.toString(),
  };

  return circuitInput;
}

/**
 * Generate transfer proof using snarkjs
 */
export async function generateTransferProof(
  transferInput: TransferInput,
): Promise<{ proof: snarkjs.Groth16Proof; publicSignals: string[] }> {
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

  validateMerkleRoot(circuitInput.merkle_root, publicSignals[5]);

  return { proof, publicSignals };
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
    swapParams,
    outputNSK,
    outputRandom,
    outputValue,
    changeNSK,
    changeRandom,
    changeValue,
  } = swapInput;

  // Ensure we have exactly 2 input notes (pad with dummy if needed)
  const notes = [...inputNotes];
  const leafIndices = [...inputLeafIndices];
  const pathElements = [...inputPathElements];

  while (notes.length < 2) {
    // Create dummy note with zero value
    // IMPORTANT: NSK must satisfy circuit constraint: NSK = Poseidon(MPK, random)
    // We use random=0 for simplicity, so NSK = Poseidon(MPK, 0)
    const dummyRandom = 0n;
    const dummyNSK = poseidonHash([keypair.masterPublicKey, dummyRandom]);
    const dummyNote: Note = {
      nsk: dummyNSK,  // Correctly derived NSK
      token: swapParams.tokenIn,
      value: 0n,
      random: dummyRandom,
      commitment: poseidonHash([dummyNSK, swapParams.tokenIn, 0n]),
    };
    notes.push(dummyNote);
    leafIndices.push(0);
    pathElements.push(new Array(MERKLE_TREE_DEPTH).fill(0n));
  }

  // Verify path elements length
  if (pathElements[0].length !== MERKLE_TREE_DEPTH) {
    throw new Error(
      `Invalid path elements length: ${pathElements[0].length}, expected ${MERKLE_TREE_DEPTH}`
    );
  }

  // Compute nullifiers for input notes
  const nullifier1 = poseidonHash([keypair.nullifyingKey, BigInt(leafIndices[0])]);
  const nullifier2 = poseidonHash([keypair.nullifyingKey, BigInt(leafIndices[1])]);

  // Compute output commitment = Poseidon(NSK, token_out, output_value)
  const outputCommitment = poseidonHash([outputNSK, swapParams.tokenOut, outputValue]);

  // Compute change commitment = Poseidon(NSK, token_in, change_value)
  const changeCommitment = poseidonHash([changeNSK, swapParams.tokenIn, changeValue]);

  // Compute swap data hash = Poseidon(token_in, token_out, amount_in, min_amount_out, dex_pool_id)
  const swapDataHash = poseidonHash([
    swapParams.tokenIn,
    swapParams.tokenOut,
    swapParams.amountIn,
    swapParams.minAmountOut,
    swapParams.dexPoolId,
  ]);

  // Compute Merkle root from both input notes and verify they match
  const roots: bigint[] = [];

  for (let noteIdx = 0; noteIdx < 2; noteIdx++) {
    let root = notes[noteIdx].commitment;
    const indices = BigInt(leafIndices[noteIdx]);

    for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
      const sibling = pathElements[noteIdx][level];
      // Check if index bit is 0 or 1
      const isRight = (indices >> BigInt(level)) & 1n;
      if (isRight === 0n) {
        root = poseidonHash([root, sibling]);
      } else {
        root = poseidonHash([sibling, root]);
      }
    }

    roots.push(root);
  }

  // Verify both notes compute the same Merkle root
  if (roots[0] !== roots[1]) {
    throw new Error(
      `Merkle root mismatch! ` +
      `Note 0 (leafIndex=${leafIndices[0]}): ${roots[0].toString()} ` +
      `Note 1 (leafIndex=${leafIndices[1]}): ${roots[1].toString()}. ` +
      `This usually means the notes have stale Merkle proofs. Try refreshing your notes.`
    );
  }

  const root = roots[0];

  return {
    // Private inputs - Keypair
    spending_key: keypair.spendingKey.toString(),
    nullifying_key: keypair.nullifyingKey.toString(),

    // Private inputs - Input notes
    input_nsks: notes.map(n => n.nsk.toString()),
    input_values: notes.map(n => n.value.toString()),
    input_randoms: notes.map(n => n.random.toString()),
    input_leaf_indices: leafIndices.map(i => i.toString()),
    input_path_elements: pathElements.map(path =>
      path.map(element => element.toString())
    ),

    // Private inputs - Swap parameters
    token_in: swapParams.tokenIn.toString(),
    token_out: swapParams.tokenOut.toString(),
    amount_in: swapParams.amountIn.toString(),
    min_amount_out: swapParams.minAmountOut.toString(),
    dex_pool_id: swapParams.dexPoolId.toString(),

    // Private inputs - Output note
    output_nsk: outputNSK.toString(),
    output_value: outputValue.toString(),
    output_random: outputRandom.toString(),

    // Private inputs - Change note
    change_nsk: changeNSK.toString(),
    change_value: changeValue.toString(),
    change_random: changeRandom.toString(),

    // Public inputs
    merkle_root: root.toString(),
    input_nullifiers: [nullifier1.toString(), nullifier2.toString()],
    output_commitment: outputCommitment.toString(),
    change_commitment: changeCommitment.toString(),
    swap_data_hash: swapDataHash.toString(),
  };
}

/**
 * Generate a swap proof using the swap circuit
 *
 * Returns raw proof and public signals. Use convertSwapProofToSui() to convert to Sui format.
 * This matches the pattern used in prover.ts for consistency.
 */
export async function generateSwapProof(
  swapInput: SwapInput,
): Promise<{ proof: snarkjs.Groth16Proof; publicSignals: string[] }> {
  const { wasmPath, zkeyPath } = getSwapCircuitPaths();

  // Build circuit input
  const input = buildSwapInput(swapInput);

  // 1. Prepare resources (get content or paths based on environment)
  const [wasm, zkey] = isNodeEnvironment()
    ? validateAndGetPaths(wasmPath, zkeyPath)
    : await loadBrowserBuffers(wasmPath, zkeyPath);

  // Generate proof using snarkjs
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input as unknown as snarkjs.CircuitSignals,
    wasm,
    zkey
  );

  return { proof, publicSignals };
}
