/**
 * Octopus SDK - Type Definitions
 */

/** BN254 scalar field modulus */
export const SCALAR_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

/** Merkle tree depth (supports 2^16 = 65536 notes) */
export const MERKLE_TREE_DEPTH = 16;

/**
 * Keypair derived from master spending key
 */
export interface OctopusKeypair {
  /** Master spending key (private) */
  spendingKey: bigint;
  /** Nullifying key derived from spending key */
  nullifyingKey: bigint;
  /** Master public key = Poseidon(spendingKey, nullifyingKey) */
  masterPublicKey: bigint;
}

/**
 * A shielded note (UTXO) in the privacy pool
 */
export interface Note {
  /** Note secret key = Poseidon(MPK, random) */
  nsk: bigint;
  /** Token type identifier */
  token: bigint;
  /** Value/amount */
  amount: bigint;
  /** Random blinding factor */
  random: bigint;
  /** Computed commitment = Poseidon(nsk, token, amount) */
  commitment: bigint;
}

/**
 * ZK proof in Sui-compatible format
 */
export interface SuiProof {
  /** Proof points (128 bytes: A || B || C) */
  proofBytes: Uint8Array;
  /** Public inputs */
  publicInputsBytes: Uint8Array;
}

// ============ Unshield Types ============

/**
 * Input for unshielding notes with automatic change handling (2-input support)
 */
export interface UnshieldInput {
  /** The keypair that owns these notes */
  keypair: OctopusKeypair;
  /** Input notes to unshield (1 or 2, will be padded to 2 with dummy if needed) */
  inputNotes: Note[];
  /** Positions in the Merkle tree */
  inputLeafIndices: number[];
  /** Merkle proof path elements for each note */
  inputPathElements: bigint[][];
  /** Amount to unshield */
  unshieldAmount: bigint;
  /** Change note */
  changeNote: Note;
  /** Token type */
  token: bigint;
  /** Recipient Sui address as hex string (e.g. "0x...") — bound to the ZK proof */
  recipient: string;
}

/**
 * Circuit input for unshield proof generation
 */
export interface UnshieldCircuitInput {
  // Private inputs
  spending_key: string;
  nullifying_key: string;

  input_randoms: string[];          // [2] - Random blinding factors for inputs
  input_amounts: string[];          // [2] - Amounts for inputs (can be 0 for dummy)
  input_leaf_indices: string[];     // [2] - Leaf positions in tree
  input_path_elements: string[][];  // [2][levels] - Merkle proof siblings

  change_random: string;            // Random for change note (private input)
  change_amount: string;            // Change amount (private input)

  nullifiers: string[];             // [2] - Precomputed nullifiers (constrained by circuit)

  recipient_addr_lo: string;        // Private: bytes[0..16] of recipient address as LE u128
  recipient_addr_hi: string;        // Private: bytes[16..32] of recipient address as LE u128

  // Public inputs
  unshield_amount: string;          // Amount to unshield
  token: string;                    // Token type to unshield
  merkle_root: string;              // Merkle root to verify against
}

// ============ Transfer Types ============

/**
 * Input for generating a transfer proof (2-input, 2-output)
 */
export interface TransferInput {
  /** Sender's keypair */
  keypair: OctopusKeypair;
  /** Input notes to spend (1 or 2, will be padded to 2 with dummy if needed) */
  inputNotes: Note[];
  /** Leaf indices for input notes */
  inputLeafIndices: number[];
  /** Merkle proof paths for input notes */
  inputPathElements: bigint[][];
  /** Recipient's master public key (for transfer output) */
  recipientMpk: bigint;
  /** Recipient note */
  recipientNote: Note;
  /** Change note */
  changeNote: Note;
  /** Token type */
  token: bigint;
}

/**
 * Circuit input for transfer proof generation
 */
export interface TransferCircuitInput {
  // Private inputs
  spending_key: string;
  nullifying_key: string;

  input_randoms: string[];          // [2] - Random blinding factors for inputs
  input_amounts: string[];          // [2] - Amounts for inputs (can be 0 for dummy)
  input_leaf_indices: string[];     // [2] - Leaf positions in tree
  input_path_elements: string[][];  // [2][levels] - Merkle proof siblings

  recipient_mpk: string;            // Recipient's master public key
  recipient_amount: string;          // Amount to transfer to recipient
  recipient_random: string;          // Random for transfer commitment

  change_amount: string;            // Change amount back to sender
  change_random: string;            // Random for change commitment

  nullifiers: string[];             // [2] - Precomputed nullifiers (constrained by circuit)

  // Public inputs
  token: string;                    // Token type to transfer
  merkle_root: string;              // Merkle root to verify against
}


// ============ Swap Types ============

/**
 * Input for generating a swap proof
 */
export interface SwapInput {
  /** Sender's keypair */
  keypair: OctopusKeypair;
  /** Input notes to spend (same token type as tokenIn) */
  inputNotes: Note[];
  /** Leaf indices for input notes */
  inputLeafIndices: number[];
  /** Merkle proof paths for input notes */
  inputPathElements: bigint[][];
  /** Swap note */
  swapNote: Note;
  /** Change note */
  changeNote: Note;
}

/**
 * Circuit input for swap proof generation
 */
export interface SwapCircuitInput {
  // Private inputs - Keypair
  spending_key: string;
  nullifying_key: string;

  // Private inputs - Input notes
  input_amounts: string[];
  input_randoms: string[];
  input_leaf_indices: string[];
  input_path_elements: string[][];

  // Private inputs - Swap note
  swap_random: string;

  // Private inputs - Change note
  change_random: string;
  change_amount: string;

  // Private inputs - Nullifiers (precomputed, constrained by circuit)
  nullifiers: string[];

  // Public inputs
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  merkle_root: string;
}


// ============ Viewing Key & Recipient Management ============

/**
 * Recipient profile for encrypted transfers
 *
 * Contains both the MPK (for creating notes) and the viewing public key
 * (for encrypting notes). Recipients must explicitly share both values.
 */
export interface RecipientProfile {
  /** Master Public Key (for creating notes) */
  mpk: bigint;

  /** Viewing Public Key (for encrypting notes) - explicitly shared by recipient */
  viewingPublicKey: Uint8Array | string;

  /** Optional label/name for this recipient */
  label?: string;
}

/**
 * Stored recipient profile (serialized for localStorage)
 *
 * All bigint and Uint8Array values are converted to hex strings for storage.
 */
export interface RecipientProfileStored {
  /** Master Public Key as hex string */
  mpk: string;

  /** Viewing Public Key as 64-character hex string */
  viewingPublicKey: string;

  /** Optional label/name */
  label?: string;

  /** Timestamp when recipient was added */
  addedAt: number;
}