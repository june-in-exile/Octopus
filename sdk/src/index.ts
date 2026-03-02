// Byte conversion, math, and proof compression utilities
export * from "./utils/index.js";

// Cryptographic utilities
export {
  initPoseidon,
  poseidonHash,
  randomFieldElement,
  deriveKeypair,
  generateKeypair,
  createNote,
  computeNullifier,
  computeZeroHashes,
  computeMerkleRoot,
  deriveViewingPublicKey,
  exportViewingPublicKey,
  importViewingPublicKey,
  isValidViewingPublicKey,
  encryptNoteExplicit,
  encryptNote,
  decryptNote,
  quickCheckNote,
} from "./crypto.js";

// DeepBook V3 Integration
export {
  estimateDeepBookSwap,
  getPoolBookParams,
  type PoolBookParams,
} from "./deepbook.js";

// Merkle tree utilities
export {
  ClientMerkleTree,
} from "./merkle.js";

// Note utilities (Note selection)
export {
  selectNotes,
  type SelectableNote,
} from "./note.js";

// Proof generation
export {
  generateUnshieldProof,
  generateTransferProof,
  generateSwapProof,
} from "./prover.js";

// Swap utilities
export {
  createSwapOutputs,
} from "./swap.js";

// Transfer utilities
export {
  createTransferOutputs,
} from "./transfer.js";

// Types
export * from "./types.js";

// Transfer utilities
export {
  createUnshieldOutputs,
} from "./unshield.js";

// Relayer client
export {
  RelayerClient,
  type RelayerConfig,
  type TransferRelayRequest,
  type UnshieldRelayRequest,
  type SwapRelayRequest,
  type FeeQuote,
  type RelayerInfo,
} from "./relayer.js";