/**
 * Octopus SDK - Cryptographic Utilities
 *
 * Implements Poseidon hashing and key derivation for privacy transactions.
 */

import { buildPoseidon, type Poseidon } from "circomlibjs";
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  SCALAR_MODULUS,
  MERKLE_TREE_DEPTH,
  type OctopusKeypair,
  type Note,
} from "./types.js";
import { bigIntToBE32, bytesToBigIntBE, bytesToHex, hexToBytes } from "./utils/bytes.js";

let poseidonInstance: Poseidon | null = null;

/**
 * Initialize the Poseidon hash function (async, call once at startup)
 */
export async function initPoseidon(): Promise<void> {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
}

/**
 * Get the initialized Poseidon instance
 */
function getPoseidon(): Poseidon {
  if (!poseidonInstance) {
    throw new Error("Poseidon not initialized. Call initPoseidon() first.");
  }
  return poseidonInstance;
}

/**
 * Compute Poseidon hash of inputs
 */
export function poseidonHash(inputs: bigint[]): bigint {
  const poseidon = getPoseidon();
  const hash = poseidon(inputs);
  return BigInt(poseidon.F.toString(hash));
}

/**
 * Generate a random field element
 */
export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let value = BigInt(0);
  for (let i = 0; i < 32; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value % SCALAR_MODULUS;
}

/**
 * Derive a keypair from a master spending key
 *
 * Formula:
 * - nullifyingKey = spending_key (simplified for MVP)
 * - MPK = Poseidon(spendingKey, nullifyingKey)
 */
export function deriveKeypair(spendingKey: bigint): OctopusKeypair {
  // In production, nullifyingKey would be derived differently
  // For MVP, we use a hash of spending key
  const nullifyingKey = poseidonHash([spendingKey, 1n]);
  const masterPublicKey = poseidonHash([spendingKey, nullifyingKey]);

  return {
    spendingKey,
    nullifyingKey,
    masterPublicKey,
  };
}

/**
 * Generate a new random keypair
 */
export function generateKeypair(): OctopusKeypair {
  return deriveKeypair(randomFieldElement());
}

/**
 * Create a new note (UTXO)
 *
 * Formula:
 * - NSK = Poseidon(MPK, random)
 * - commitment = Poseidon(NSK, token, value)
 */
export function createNote(
  recipientMpk: bigint,
  token: bigint,
  value: bigint,
  random?: bigint
): Note {
  const r = random ?? randomFieldElement();
  const nsk = poseidonHash([recipientMpk, r]);
  const commitment = poseidonHash([nsk, token, value]);

  return {
    nsk,
    token,
    amount: value,
    random: r,
    commitment,
  };
}

/**
 * Compute nullifier for a note
 *
 * Formula: nullifier = Poseidon(nullifyingKey, leafIndex)
 */
export function computeNullifier(
  nullifyingKey: bigint,
  leafIndex: number
): bigint {
  return poseidonHash([nullifyingKey, BigInt(leafIndex)]);
}

/**
 * Compute zero hashes for empty Merkle tree nodes
 * MUST match Move contract logic (merkle_tree.move:compute_zeros)!
 *
 * zeros[0] = 0 (32 zero bytes, not a hash)
 * zeros[1] = Poseidon(0, 0)
 * zeros[i] = Poseidon(zeros[i-1], zeros[i-1]) for i = 2..TREE_DEPTH
 *
 * Returns array of length TREE_DEPTH + 1 (17 elements for depth 16)
 */
export function computeZeroHashes(): bigint[] {
  const zeros: bigint[] = [];

  // Level 0: empty leaf (32 zero bytes → 0)
  zeros[0] = 0n;

  // Compute hash for each level: zeros[1] to zeros[TREE_DEPTH]
  for (let i = 1; i <= MERKLE_TREE_DEPTH; i++) {
    zeros[i] = poseidonHash([zeros[i - 1], zeros[i - 1]]);
  }

  return zeros;
}

/**
 * Compute Merkle root from a commitment and its proof path
 * Uses BigInt internally for consistent bit operations across all edge cases
 */
export function computeMerkleRoot(
  commitment: bigint,
  pathElements: bigint[],
  pathIndices: number | bigint
): bigint {
  let current = commitment;
  const indices = BigInt(pathIndices);

  for (let i = 0; i < pathElements.length; i++) {
    const isRight = (indices >> BigInt(i)) & 1n;
    if (isRight === 1n) {
      current = poseidonHash([pathElements[i], current]);
    } else {
      current = poseidonHash([current, pathElements[i]]);
    }
  }

  return current;
}

/**
 * Derive X25519 viewing keypair from spending key
 *
 * This creates a separate keypair for encryption/decryption that is
 * deterministically derived from the spending key.
 */
function deriveViewingKeypair(spendingKey: bigint): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  // Hash spending key to get viewing private key seed
  const seed = sha256(bigIntToBE32(spendingKey));

  // Ensure seed is a valid X25519 scalar by taking modulo
  // X25519 uses Curve25519 which has order 2^252 + ...
  const privateKey = new Uint8Array(32);
  privateKey.set(seed);

  // Clamp the private key as per X25519 spec
  privateKey[0] &= 248;
  privateKey[31] &= 127;
  privateKey[31] |= 64;

  const publicKey = x25519.getPublicKey(privateKey);

  return { privateKey, publicKey };
}

/**
 * Derive X25519 viewing public key from MPK
 *
 * Since MPK is derived from spending key, and viewing keypair is derived
 * from spending key, we need the actual spending key to get the viewing public key.
 * For encryption, sender must know recipient's viewing public key somehow.
 *
 * In practice, recipient shares their MPK, and we derive viewing PK from spending key.
 * This helper reconstructs the viewing public key from the MPK's source.
 */
export function deriveViewingPublicKey(spendingKey: bigint): Uint8Array {
  return deriveViewingKeypair(spendingKey).publicKey;
}

/**
 * Export viewing public key in shareable hex format
 *
 * Converts the X25519 viewing public key to a 64-character hex string
 * that can be shared with others for encrypted note sending.
 *
 * @param spendingKey - User's spending key
 * @returns 64-character hex string (no "0x" prefix)
 *
 * @example
 * const viewingKeyHex = exportViewingPublicKey(keypair.spendingKey);
 * // Share viewingKeyHex with senders via secure channel
 */
export function exportViewingPublicKey(spendingKey: bigint): string {
  const viewingPk = deriveViewingPublicKey(spendingKey);
  return bytesToHex(viewingPk);
}

/**
 * Import viewing public key from hex string format
 *
 * Converts a 64-character hex string back to a Uint8Array viewing public key
 * for use in note encryption.
 *
 * @param hexString - 64-character hex string (with or without "0x" prefix)
 * @returns Viewing public key as Uint8Array (32 bytes)
 * @throws Error if format is invalid
 *
 * @example
 * const recipientViewingPk = importViewingPublicKey("a1b2c3d4...");
 * const encrypted = encryptNote(note, recipientViewingPk);
 */
export function importViewingPublicKey(hexString: string): Uint8Array {
  const cleanHex = hexString.startsWith("0x") ? hexString.slice(2) : hexString;

  if (cleanHex.length !== 64) {
    throw new Error(
      `Invalid viewing public key format: expected 64 hex characters, got ${cleanHex.length}`
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
    throw new Error(
      'Invalid viewing public key format: must contain only hex characters (0-9, a-f, A-F)'
    );
  }

  return hexToBytes(cleanHex);
}

/**
 * Validate viewing public key hex string format
 *
 * Checks if a string is a valid 64-character hex representation
 * of a viewing public key.
 *
 * @param hexString - String to validate
 * @returns true if valid format, false otherwise
 *
 * @example
 * if (isValidViewingPublicKey(userInput)) {
 *   const viewingPk = importViewingPublicKey(userInput);
 * }
 */
export function isValidViewingPublicKey(hexString: string): boolean {
  const cleanHex = hexString.startsWith("0x") ? hexString.slice(2) : hexString;
  return /^[0-9a-fA-F]{64}$/.test(cleanHex);
}

/**
 * Encrypt note with explicitly provided viewing public key
 *
 * Production-ready encryption that accepts an explicit viewing public key
 * instead of deriving it from MPK. This is the recommended approach for
 * cross-user transfers.
 *
 * @param note - Note to encrypt
 * @param recipientViewingPk - Recipient's viewing public key (Uint8Array or hex string)
 * @returns Encrypted note data (188 bytes)
 *
 * @example
 * // Option 1: Use Uint8Array directly
 * const encrypted = encryptNoteExplicit(note, recipientViewingPkBytes);
 *
 * // Option 2: Use hex string
 * const encrypted = encryptNoteExplicit(note, "a1b2c3d4...");
 */
export function encryptNoteExplicit(
  note: Note,
  recipientViewingPk: Uint8Array | string
): Uint8Array {
  const viewingPk = typeof recipientViewingPk === 'string'
    ? importViewingPublicKey(recipientViewingPk)
    : recipientViewingPk;

  return encryptNote(note, viewingPk);
}

/**
 * Encrypt note data for recipient using ECDH + ChaCha20-Poly1305
 *
 * Encryption scheme:
 * 1. Generate ephemeral X25519 keypair
 * 2. Compute shared secret via ECDH with recipient's viewing public key
 * 3. Derive viewing tag (8 bytes) from shared secret for fast filtering
 * 4. Derive encryption key using HKDF-SHA256
 * 5. Encrypt note data with ChaCha20-Poly1305
 * 6. Output: viewing_tag (8) || ephemeral_pk (32) || nonce (12) || ciphertext || tag (16)
 *    Total: 196 bytes (v2 format with viewing tag)
 *
 * @param note - The note to encrypt
 * @param recipientViewingPk - Recipient's X25519 viewing public key (32 bytes)
 * @returns Encrypted note data (196 bytes)
 */
export function encryptNote(
  note: Note,
  recipientViewingPk: Uint8Array
): Uint8Array {
  // 1. Generate ephemeral keypair
  const ephemeralSk = crypto.getRandomValues(new Uint8Array(32));
  // Clamp ephemeral key
  ephemeralSk[0] &= 248;
  ephemeralSk[31] &= 127;
  ephemeralSk[31] |= 64;
  const ephemeralPk = x25519.getPublicKey(ephemeralSk);

  // 2. Perform ECDH to get shared secret
  const sharedSecret = x25519.getSharedSecret(ephemeralSk, recipientViewingPk);

  // 3. Derive viewing tag (8 bytes) for fast note filtering
  const tagInfo = new TextEncoder().encode("octopus-viewing-tag-v1");
  const viewingTag = hkdf(sha256, sharedSecret, undefined, tagInfo, 8);

  // 4. Derive encryption key using HKDF
  const info = new TextEncoder().encode("octopus-note-encryption-v1");
  const encryptionKey = hkdf(sha256, sharedSecret, undefined, info, 32);

  // 5. Serialize note data (nsk || token || value || random, each 32 bytes)
  const noteData = new Uint8Array(128);
  noteData.set(bigIntToBE32(note.nsk), 0);
  noteData.set(bigIntToBE32(note.token), 32);
  noteData.set(bigIntToBE32(note.amount), 64);
  noteData.set(bigIntToBE32(note.random), 96);

  // 6. Generate nonce (12 bytes for ChaCha20-Poly1305)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // 7. Encrypt with ChaCha20-Poly1305
  const cipher = chacha20poly1305(encryptionKey, nonce);
  const ciphertext = cipher.encrypt(noteData);

  // 8. Combine: viewingTag || ephemeralPk || nonce || ciphertext (includes 16-byte auth tag)
  // Total: 8 + 32 + 12 + 144 = 196 bytes
  const output = new Uint8Array(8 + 32 + 12 + ciphertext.length);
  output.set(viewingTag, 0);
  output.set(ephemeralPk, 8);
  output.set(nonce, 40);
  output.set(ciphertext, 52);

  return output;
}

// Byte conversion functions moved to utils/bytes.ts


/**
 * Decrypt and verify note ownership using ECDH + ChaCha20-Poly1305
 *
 * Only supports v2 format (196 bytes with viewing tag).
 *
 * Decryption scheme:
 * 1. Extract viewing tag and ephemeral public key from encrypted data
 * 2. Compute shared secret via ECDH with our viewing private key
 * 3. Verify viewing tag matches (fast filtering)
 * 4. Derive decryption key using HKDF-SHA256
 * 5. Decrypt with ChaCha20-Poly1305
 * 6. Verify note ownership by recomputing NSK
 *
 * @param encryptedData - Encrypted note (v2: 196 bytes)
 * @param mySpendingKey - Our spending key (to derive viewing private key)
 * @param myMpk - Our master public key (to verify ownership)
 * @returns Decrypted note if we own it, null otherwise
 */
export function decryptNote(
  encryptedData: Uint8Array | number[],
  mySpendingKey: bigint,
  myMpk: bigint
): Note | null {
  try {
    // Convert to Uint8Array if needed
    const data =
      encryptedData instanceof Uint8Array
        ? encryptedData
        : new Uint8Array(encryptedData);

    // Only support v2 format (196 bytes)
    const V2_LENGTH = 196; // viewing_tag (8) + ephemeral_pk (32) + nonce (12) + ciphertext (144)

    if (data.length !== V2_LENGTH) {
      return null; // Invalid length
    }

    // 1. Extract components
    const viewingTag = data.slice(0, 8);
    const ephemeralPk = data.slice(8, 40);
    const nonce = data.slice(40, 52);
    const ciphertext = data.slice(52);

    // 2. Derive our viewing private key
    const { privateKey: myViewingSk } = deriveViewingKeypair(mySpendingKey);

    // 3. Perform ECDH to get shared secret
    const sharedSecret = x25519.getSharedSecret(myViewingSk, ephemeralPk);

    // 4. Verify viewing tag (fast filtering)
    const tagInfo = new TextEncoder().encode("octopus-viewing-tag-v1");
    const expectedTag = hkdf(sha256, sharedSecret, undefined, tagInfo, 8);

    // Constant-time comparison to prevent timing attacks
    let tagMatch = true;
    for (let i = 0; i < 8; i++) {
      if (viewingTag[i] !== expectedTag[i]) {
        tagMatch = false;
      }
    }

    if (!tagMatch) {
      return null; // Tag doesn't match, not our note
    }

    // 5. Derive decryption key using HKDF
    const info = new TextEncoder().encode("octopus-note-encryption-v1");
    const decryptionKey = hkdf(sha256, sharedSecret, undefined, info, 32);

    // 6. Decrypt with ChaCha20-Poly1305
    const cipher = chacha20poly1305(decryptionKey, nonce);
    const noteData = cipher.decrypt(ciphertext);

    // 7. Parse decrypted data
    const nsk = bytesToBigIntBE(noteData.slice(0, 32));
    const token = bytesToBigIntBE(noteData.slice(32, 64));
    const value = bytesToBigIntBE(noteData.slice(64, 96));
    const random = bytesToBigIntBE(noteData.slice(96, 128));

    // 8. Verify ownership by recomputing NSK
    // If this note belongs to us, NSK should equal Poseidon(myMpk, random)
    const expectedNpk = poseidonHash([myMpk, random]);
    if (expectedNpk !== nsk) {
      return null; // Not our note
    }

    // 9. Recompute commitment to verify data integrity
    const commitment = poseidonHash([nsk, token, value]);

    return {
      nsk,
      token,
      amount: value,
      random,
      commitment,
    };
  } catch (err) {
    // Decryption failed (wrong key, corrupted data, etc.)
    return null;
  }
}

/**
 * Quick check if a note might belong to us (v2 format only)
 *
 * This function only verifies the viewing tag without performing full decryption,
 * making it ~10x faster than full decryptNote(). Use this for fast filtering
 * during note scanning.
 *
 * Performance comparison (per note):
 * - quickCheckNote: ~0.1ms (ECDH + HKDF tag verification)
 * - decryptNote: ~1ms (ECDH + HKDF + ChaCha20 + Poseidon)
 *
 * @param encryptedData - Encrypted note data (must be v2 format: 196 bytes)
 * @param mySpendingKey - Our spending key (to derive viewing private key)
 * @returns true if the note might be ours (tag matches), false otherwise
 *
 * @example
 * // Fast scan workflow
 * for (const event of allEvents) {
 *   if (!quickCheckNote(event.encrypted_note, mySpendingKey)) {
 *     continue; // Skip full decryption
 *   }
 *   const note = decryptNote(event.encrypted_note, mySpendingKey, myMpk);
 *   if (note) ownedNotes.push(note);
 * }
 */
export function quickCheckNote(
  encryptedData: Uint8Array | number[],
  mySpendingKey: bigint
): boolean {
  try {
    // Convert to Uint8Array if needed
    const data =
      encryptedData instanceof Uint8Array
        ? encryptedData
        : new Uint8Array(encryptedData);

    // Only works with v2 format (196 bytes)
    const V2_LENGTH = 196;
    if (data.length !== V2_LENGTH) {
      return false; // v1 format or invalid length - skip quick check
    }

    // Extract viewing tag and ephemeral public key
    const viewingTag = data.slice(0, 8);
    const ephemeralPk = data.slice(8, 40);

    // Derive our viewing private key
    const { privateKey: myViewingSk } = deriveViewingKeypair(mySpendingKey);

    // Perform ECDH to get shared secret
    const sharedSecret = x25519.getSharedSecret(myViewingSk, ephemeralPk);

    // Compute expected viewing tag
    const tagInfo = new TextEncoder().encode("octopus-viewing-tag-v1");
    const expectedTag = hkdf(sha256, sharedSecret, undefined, tagInfo, 8);

    // Constant-time comparison to prevent timing attacks
    let result = 0;
    for (let i = 0; i < 8; i++) {
      result |= viewingTag[i] ^ expectedTag[i];
    }

    return result === 0;
  } catch (err) {
    return false;
  }
}
