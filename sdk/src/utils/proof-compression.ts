/**
 * Shared utilities for converting Groth16 proofs to Sui-compatible Arkworks format
 *
 * BN254 curve compression:
 * - G1 points: 32 bytes (x-coordinate + sign bit in MSB)
 * - G2 points: 64 bytes (two Fq elements for x-coordinate + sign bit)
 * - Scalar field elements: 32 bytes little-endian
 */

import { bigIntToLE32 } from "./bytes.js";

/** BN254 field modulus for Fq */
const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

/**
 * Compress G1 point to Arkworks format (32 bytes)
 *
 * Format: x-coordinate (32 bytes LE) with sign bit in most significant bit.
 * If y > p/2, set the MSB of byte 31 to indicate negative y.
 *
 * @param point - G1 point as [x, y] string array from snarkjs
 * @returns 32-byte compressed representation
 */
function compressG1(point: string[]): Uint8Array {
  const x = BigInt(point[0]);
  const y = BigInt(point[1]);

  const buf = bigIntToLE32(x);

  // Set sign bit if y > p/2 (indicating negative y in compressed form)
  if (y > FIELD_MODULUS / 2n) {
    buf[31] |= 0x80;
  }

  return buf;
}

/**
 * Compress G2 point to Arkworks format (64 bytes)
 *
 * G2 points are over Fq2, represented as (c0, c1) pairs.
 * Format: x.c0 (32 bytes LE) || x.c1 (32 bytes LE) with sign bit in MSB of byte 63.
 *
 * Sign determination:
 * - Compare y with -y lexicographically (first by c1, then by c0)
 * - If y > -y, set sign bit
 *
 * @param point - G2 point as [[x.c0, x.c1], [y.c0, y.c1]] from snarkjs
 * @returns 64-byte compressed representation
 */
function compressG2(point: string[][]): Uint8Array {
  const x0 = BigInt(point[0][0]);
  const x1 = BigInt(point[0][1]);
  const y0 = BigInt(point[1][0]);
  const y1 = BigInt(point[1][1]);

  const buf = new Uint8Array(64);

  // Write x.c0 in little-endian
  const x0Bytes = bigIntToLE32(x0);
  buf.set(x0Bytes, 0);

  // Write x.c1 in little-endian
  const x1Bytes = bigIntToLE32(x1);
  buf.set(x1Bytes, 32);

  // Determine sign bit: compare y with -y lexicographically
  const negY0 = y0 === 0n ? 0n : FIELD_MODULUS - y0;
  const negY1 = y1 === 0n ? 0n : FIELD_MODULUS - y1;

  let yIsLarger = false;
  if (y1 > negY1) {
    yIsLarger = true;
  } else if (y1 === negY1 && y0 > negY0) {
    yIsLarger = true;
  }

  if (yIsLarger) {
    buf[63] |= 0x80;
  }

  return buf;
}

/**
 * Convert Groth16 proof to Sui format
 *
 * Format: A (32 bytes) || B (64 bytes) || C (32 bytes) = 128 bytes total
 *
 * @param proof - Groth16 proof from snarkjs
 * @returns 128-byte proof in Arkworks compressed format
 */
export function serializeProof(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Uint8Array {
  const piA = compressG1(proof.pi_a);
  const piB = compressG2(proof.pi_b);
  const piC = compressG1(proof.pi_c);

  const proofBytes = new Uint8Array(128);
  proofBytes.set(piA, 0);
  proofBytes.set(piB, 32);
  proofBytes.set(piC, 96);

  return proofBytes;
}

/**
 * Convert public signals to Sui format (little-endian)
 *
 * Each signal is converted to a 32-byte little-endian representation.
 *
 * @param publicSignals - Array of public signals as strings
 * @returns Concatenated public inputs bytes (32 bytes per signal)
 */
export function serializePublicInputs(publicSignals: string[]): Uint8Array {
  const publicInputsBytes = new Uint8Array(publicSignals.length * 32);

  for (let i = 0; i < publicSignals.length; i++) {
    const inputBytes = bigIntToLE32(BigInt(publicSignals[i]));
    publicInputsBytes.set(inputBytes, i * 32);
  }

  return publicInputsBytes;
}
