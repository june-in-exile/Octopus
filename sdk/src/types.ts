/**
 * Octopus SDK - Type Definitions
 */

/** BN254 curve field modulus */
export const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

/** BN254 scalar field modulus */
export const SCALAR_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

/** Merkle tree depth (supports 2^16 = 65536 notes) */
export const MERKLE_TREE_DEPTH = 16;

/** Number of historical roots stored for concurrent transactions */
export const ROOT_HISTORY_SIZE = 100;

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
 * Verification key in Sui-compatible format
 */
export interface SuiVerificationKey {
  /** VK bytes in Arkworks compressed format */
  vkBytes: Uint8Array;
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
  outputNote: Note;
  /** Token type */
  token: bigint;
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

  change_amount: string;            // Change amount (private input)
  change_random: string;            // Random for change note (private input)

  // Public inputs
  unshield_amount: string;          // Amount to unshield
  token: string;                    // Token type to unshield
  merkle_root: string;              // Merkle root to verify against
}

/**
 * Unshield proof in Sui-compatible format
 */
export interface SuiUnshieldProof {
  /** Proof points (128 bytes: A || B || C) */
  proofBytes: Uint8Array;
  /** Public inputs */
  publicInputsBytes: Uint8Array;
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
  /** Output notes (recipient and change) */
  outputNotes: Note[];
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
  transfer_amount: string;          // Amount to transfer to recipient
  transfer_random: string;          // Random for transfer commitment

  change_amount: string;            // Change amount back to sender
  change_random: string;            // Random for change commitment

  // Public inputs
  token: string;                    // Token type to transfer
  merkle_root: string;              // Merkle root to verify against
}

/**
 * Transfer proof in Sui-compatible format
 */
export interface SuiTransferProof {
  /** Proof points (128 bytes: A || B || C) */
  proofBytes: Uint8Array;
  /** Public inputs */
  publicInputsBytes: Uint8Array;
}

// ============ Swap Types ============

/**
 * Swap transaction parameters
 */
export interface SwapParams {
  /** Input token type (e.g., SUI) */
  tokenIn: bigint;
  /** Output token type (e.g., USDC) */
  tokenOut: bigint;
  /** Exact amount to swap */
  amountIn: bigint;
  /** Minimum output amount (slippage protection) */
  minAmountOut: bigint;
  /** DEX pool identifier hash */
  dexPoolId: bigint;
  /** Slippage tolerance in basis points (e.g., 50 = 0.5%) */
  slippageBps: number;
}

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
  /** Swap parameters */
  swapParams: SwapParams;
  /** Output note recipient's NSK */
  outputNSK: bigint;
  /** Random blinding factor for output note */
  outputRandom: bigint;
  /** Expected output amount from DEX */
  outputAmount: bigint;
  /** Change note recipient's NSK (usually sender's own NSK) */
  changeNSK: bigint;
  /** Random blinding factor for change note */
  changeRandom: bigint;
  /** Change amount (excess input) */
  changeAmount: bigint;
}

/**
 * Circuit input for swap proof generation
 */
export interface SwapCircuitInput {
  // Private inputs - Keypair
  spending_key: string;
  nullifying_key: string;

  // Private inputs - Input notes
  input_nsks: string[];
  input_amounts: string[];
  input_randoms: string[];
  input_leaf_indices: string[];
  input_path_elements: string[][];

  // Private inputs - Swap parameters
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  dex_pool_id: string;

  // Private inputs - Output note
  output_nsk: string;
  output_amount: string;
  output_random: string;

  // Private inputs - Change note
  change_nsk: string;
  change_amount: string;
  change_random: string;

  // Public inputs
  merkle_root: string;
  input_nullifiers: string[];
  output_commitment: string;
  change_commitment: string;
  swap_data_hash: string;
}

/**
 * Swap proof in Sui-compatible format
 */
export interface SuiSwapProof {
  /** Proof points (128 bytes: A || B || C) */
  proofBytes: Uint8Array;
  /** Public inputs (192 bytes: root || nullifiers[2] || output_commitment || change_commitment || swap_data_hash) */
  publicInputsBytes: Uint8Array;
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