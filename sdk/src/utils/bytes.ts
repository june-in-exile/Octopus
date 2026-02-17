/**
 * Unified byte conversion utilities
 *
 * This module provides consistent byte conversion functions with clear
 * naming conventions to avoid confusion between different byte orders.
 *
 * Naming convention:
 * - LE = Little-Endian (least significant byte first)
 * - BE = Big-Endian (most significant byte first)
 */

/**
 * Convert BigInt to 32-byte little-endian Uint8Array
 *
 * Used for:
 * - Sui proof serialization (public inputs, curve points)
 * - Groth16 proof formatting for on-chain verification
 *
 * @param n - BigInt value to convert
 * @returns 32-byte little-endian representation
 */
export function bigIntToLE32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

/**
 * Convert BigInt to 32-byte big-endian Uint8Array
 *
 * Used for:
 * - Note encryption (NSK, token, value, random)
 * - General cryptographic operations
 *
 * @param n - BigInt value to convert
 * @returns 32-byte big-endian representation
 */
export function bigIntToBE32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

/**
 * Convert Uint8Array to BigInt (big-endian)
 *
 * Used for:
 * - Decrypting note data
 * - General BE byte array conversion
 *
 * @param bytes - Byte array to convert
 * @returns BigInt value
 */
export function bytesToBigIntBE(bytes: Uint8Array | number[]): bigint {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let result = 0n;
  for (let i = 0; i < arr.length; i++) {
    result = (result << 8n) | BigInt(arr[i]);
  }
  return result;
}

/**
 * Convert little-endian byte array to BigInt with BN254 field modulus
 *
 * Used specifically for:
 * - Parsing on-chain commitments from Sui events
 * - Matching Move's bytes_to_u256 behavior
 *
 * This function reads bytes in little-endian order and applies the BN254
 * scalar field modulus to ensure the result is a valid field element.
 *
 * @param bytes - 32-byte array in little-endian format
 * @returns BigInt reduced modulo BN254 scalar field
 * @throws Error if bytes length is not 32
 */
export function bytesToBigIntLE_BN254(bytes: number[] | Uint8Array): bigint {
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes);

  if (arr.length !== 32) {
    throw new Error(`Invalid bytes length: ${arr.length}, expected 32`);
  }

  // Read from high byte to low byte (LE format)
  let result = 0n;
  for (let i = 31; i >= 0; i--) {
    result = (result << 8n) | BigInt(arr[i]);
  }

  // Reduce modulo BN254 scalar field (same as on-chain)
  const BN254_SCALAR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  return result % BN254_SCALAR_MODULUS;
}

/**
 * Convert hex string to Uint8Array
 *
 * Accepts hex strings with or without "0x" prefix.
 *
 * @param hex - Hex string to convert
 * @returns Byte array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string (without "0x" prefix)
 *
 * @param bytes - Byte array to convert
 * @returns Hex string (lowercase, no prefix)
 */
export function bytesToHex(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

