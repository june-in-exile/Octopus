/**
 * Worker Message Protocol Types
 *
 * Defines the message protocol for communication between the main thread
 * and the note scanning Web Worker.
 *
 * Uses string serialization for BigInt values to ensure JSON compatibility.
 */

// ============================================================================
// Request Types (Main Thread → Worker)
// ============================================================================

export type WorkerRequest =
  | InitRequest
  | ScanNotesRequest
  | CountPoolNotesRequest
  | BatchDecryptRequest
  | ComputeNullifierRequest
  | BuildMerkleTreeRequest
  | GetMerkleProofRequest
  | GetCommitmentsRequest
  | ClearCacheRequest
  | GetCacheInfoRequest;

/**
 * Initialize Poseidon hash function in worker
 */
export interface InitRequest {
  type: "init";
}

/**
 * Scan notes from blockchain (query events + decrypt + build tree)
 *
 * PHASE 2 OPTIMIZATION: Incremental Scanning
 * - Supports resuming from last scan position via cursors
 * - Accepts cached commitments to avoid rebuilding entire Merkle tree
 */
export interface ScanNotesRequest {
  type: "scan_notes";
  id: string;
  graphqlUrl: string; // GraphQL endpoint
  packageId: string; // Package ID for event filtering
  poolId: string; // Pool ID for filtering events
  spendingKey: string; // BigInt as string
  nullifyingKey: string; // BigInt as string
  masterPublicKey: string; // BigInt as string
}

/**
 * Count total notes in a pool without decrypting (lightweight)
 */
export interface CountPoolNotesRequest {
  type: "count_pool_notes";
  id: string;
  graphqlUrl: string;
  packageId: string;
  poolId: string;
}

/**
 * Batch decrypt multiple encrypted notes
 */
export interface BatchDecryptRequest {
  type: "batch_decrypt";
  id: string; // Request ID for correlation
  notes: Array<{
    noteId: string;
    encryptedNote: number[];
  }>;
  spendingKey: string; // BigInt as string
  masterPublicKey: string; // BigInt as string
}

/**
 * Compute nullifier for a note at a specific leaf index
 */
export interface ComputeNullifierRequest {
  type: "compute_nullifier";
  id: string;
  nullifyingKey: string; // BigInt as string
  leafIndex: number;
}

/**
 * Build Merkle tree from commitments
 */
export interface BuildMerkleTreeRequest {
  type: "build_merkle_tree";
  id: string;
  commitments: Array<{
    commitment: string; // BigInt as string
    leafIndex: number;
  }>;
}

/**
 * Get Merkle proof for a specific leaf
 */
export interface GetMerkleProofRequest {
  type: "get_merkle_proof";
  id: string;
  treeId: string; // Reference to built tree
  leafIndex: number;
}

/**
 * Clear scan cache
 */
export interface ClearCacheRequest {
  type: "clear_cache";
  id: string;
  userKey?: string; // Optional: clear specific user's cache
  poolId?: string; // Optional: clear specific pool's cache
}

/**
 * Get commitments from cache (for lazy Merkle proof generation)
 */
export interface GetCommitmentsRequest {
  type: "get_commitments";
  id: string;
  userKey: string;
  poolId: string;
}

/**
 * Get cache info for a specific user and pool
 */
export interface GetCacheInfoRequest {
  type: "get_cache_info";
  id: string;
  userKey: string;
  poolId: string;
}

// ============================================================================
// Response Types (Worker → Main Thread)
// ============================================================================

export type WorkerResponse =
  | InitResponse
  | ScanNotesResponse
  | CountPoolNotesResponse
  | BatchDecryptResponse
  | ComputeNullifierResponse
  | BuildMerkleTreeResponse
  | GetMerkleProofResponse
  | GetCommitmentsResponse
  | ClearCacheResponse
  | GetCacheInfoResponse
  | ErrorResponse
  | ProgressResponse;

/**
 * Poseidon initialization complete
 */
export interface InitResponse {
  type: "init_complete";
  success: boolean;
}

/**
 * Scan notes result (pathElements now optional - generated lazily at transaction time)
 */
export interface ScanNotesResponse {
  type: "scan_notes_result";
  id: string;
  notes: Array<{
    note: SerializedNote;
    leafIndex: number;
    pathElements?: string[]; // OPTIONAL: BigInt[] as string[] - computed lazily when needed
    nullifier: string; // BigInt as string
    txDigest: string;
  }>;

  // Total notes in pool (ShieldEvents - UnshieldEvents)
  totalNotesInPool?: number;
}

/**
 * Count pool notes result
 */
export interface CountPoolNotesResponse {
  type: "count_pool_notes_result";
  id: string;
  totalNotesInPool: number;
}

/**
 * Batch decryption results
 */
export interface BatchDecryptResponse {
  type: "batch_decrypt_result";
  id: string;
  results: Array<{
    noteId: string;
    note: SerializedNote | null;
  }>;
}

/**
 * Nullifier computation result
 */
export interface ComputeNullifierResponse {
  type: "compute_nullifier_result";
  id: string;
  nullifier: string; // BigInt as string
}

/**
 * Merkle tree build result
 */
export interface BuildMerkleTreeResponse {
  type: "build_merkle_tree_result";
  id: string;
  treeId: string;
  root: string; // BigInt as string
}

/**
 * Merkle proof result
 */
export interface GetMerkleProofResponse {
  type: "get_merkle_proof_result";
  id: string;
  pathElements: string[]; // BigInt[] as string[]
}

/**
 * Get commitments result (for lazy Merkle proof generation)
 */
export interface GetCommitmentsResponse {
  type: "get_commitments_result";
  id: string;
  commitments: Array<{
    commitment: string; // BigInt as string
    leafIndex: number;
  }>;
}

/**
 * Clear cache result
 */
export interface ClearCacheResponse {
  type: "clear_cache_result";
  id: string;
  success: boolean;
}

/**
 * Get cache info result
 */
export interface GetCacheInfoResponse {
  type: "get_cache_info_result";
  id: string;
  cacheExists: boolean;
  lastScanned?: number; // Timestamp
  noteCount?: number;
  totalNotesInPool?: number;
}

/**
 * Error response
 */
export interface ErrorResponse {
  type: "error";
  id?: string;
  error: string;
}

/**
 * Progress update (streaming)
 */
export interface ProgressResponse {
  type: "progress";
  id: string;
  current: number;
  total: number;
  message: string;
  totalNotesInPool?: number; // Available after event query completes
}

// ============================================================================
// Data Types
// ============================================================================

/**
 * Serialized note with BigInt → string conversion
 */
export interface SerializedNote {
  nsk: string; // BigInt as string
  token: string; // BigInt as string
  amount: string; // BigInt as string
  random: string; // BigInt as string
  commitment: string; // BigInt as string
}
