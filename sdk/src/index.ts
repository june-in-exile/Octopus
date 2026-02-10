// DEX Integration (DeepBook price fetching - legacy Cetus exports deprecated)
// Note: Cetus integration has been replaced with DeepBook
// export {
//   getCetusPool,
//   estimateCetusSwap,
//   findCetusPool,
//   getCetusPrice,
//   CETUS_TESTNET_POOLS,
//   type CetusPoolConfig,
//   type SwapEstimation,
// } from "./dex.js";

// DeepBook V3 Integration
export {
  estimateDeepBookSwap,
  getDeepBookPrice,
  getDeepBookPool,
  type DeepBookPoolConfig,
} from "./dex/deepbook.js";

// DEX Adapter Interface
export {
  type DexAdapter,
} from "./dex/adapter.js";

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
  type ProverConfig,
  generateUnshieldProof,
  convertUnshieldProofToSui,
  generateTransferProof,
  convertTransferProofToSui,
  generateSwapProof,
  convertSwapProofToSui,
} from "./prover.js";

// Sui interactions
export {
  buildShieldTransaction,
  buildUnshieldTransaction,
  buildTransferTransaction,
  buildSwapTransaction,
  TESTNET_CONFIG,
  type SuiConfig,
} from "./transaction.js";

// Transfer utilities
export {
  createTransferOutputs,
} from "./transfer.js";

// Types
export * from "./types.js";