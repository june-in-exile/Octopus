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
 */
export function convertUnshieldProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[],
): SuiUnshieldProof {
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
 * Convert transfer proof to Sui-compatible format (Arkworks compressed)
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
 */
export function convertSwapProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[]
): SuiSwapProof {
  // Validate public signals count for swap circuit
  // Expected: nullifier1, nullifier2, swap_data_hash, output_commitment, change_commitment, token_in, token_out, merkle_root
  if (publicSignals.length !== 8) {
    throw new Error(`Expected 8 public signals for swap, got ${publicSignals.length}`);
  }

  const proofBytes = serializeProof(proof as any);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}