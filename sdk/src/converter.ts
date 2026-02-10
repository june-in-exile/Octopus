/**
 * Octopus SDK - ZK Proof Generation
 *
 * Generates Groth16 proofs for unshield operations using snarkjs.
 */

import * as snarkjs from "snarkjs";
import {
  type SuiUnshieldProof,
  type SuiTransferProof,
  type SuiSwapProof,
} from "./types.js";

import {
  serializeProof,
  serializePublicInputs,
} from "./utils/index.js";

/**
 * Convert snarkjs proof to Sui-compatible format (Arkworks compressed) with 2-input support
 *
 * Uses shared compression utilities for consistent serialization.
 */
export function convertUnshieldProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[],
): SuiUnshieldProof {
  // Validate public signals count for 2-input unshield circuit
  // Expected: [unshield_value, token, merkle_root] (public inputs) + [nullifiers[2], change_commitment] (outputs) = 6 total
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
 * Convert transfer proof to Sui-compatible format (Arkworks compressed)
 *
 * Uses shared compression utilities for consistent serialization.
 *
 * IMPORTANT: Circom outputs public signals in this order:
 *   [0] nullifier1, [1] nullifier2, [2] transfer_commitment, [3] change_commitment, [4] token, [5] merkle_root
 *
 * But Move contract expects this order:
 *   [0] token, [1] merkle_root, [2] nullifier1, [3] nullifier2, [4] transfer_commitment, [5] change_commitment
 *
 * So we need to reorder the signals before serialization.
 */
export function convertTransferProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[]
): SuiTransferProof {
  // Validate public signals count for transfer circuit
  if (publicSignals.length !== 6) {
    throw new Error(`Expected 6 public signals for transfer, got ${publicSignals.length}`);
  }

  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}

/**
 * Convert swap proof to Sui-compatible format (Arkworks compressed)
 *
 * Uses shared compression utilities for consistent serialization.
 * This matches the pattern used in prover.ts for unshield and transfer proofs.
 */
export function convertSwapProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[]
): SuiSwapProof {
  // Validate public signals count for swap circuit
  // Expected: merkle_root, nullifier1, nullifier2, output_commitment, change_commitment, swap_data_hash
  if (publicSignals.length !== 6) {
    throw new Error(`Expected 6 public signals for swap, got ${publicSignals.length}`);
  }

  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}