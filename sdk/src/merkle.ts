import { poseidonHash, computeZeroHashes } from "./crypto.js";
import { MERKLE_TREE_DEPTH } from "./types.js";

/**
 * Client-side Merkle tree for generating proofs
 */
export class ClientMerkleTree {
  private leaves: Map<number, bigint>; // leafIndex -> commitment
  private zeros: bigint[];
  private depth: number;

  constructor(depth: number = MERKLE_TREE_DEPTH) {
    this.leaves = new Map();
    this.zeros = computeZeroHashes();
    this.depth = depth;
  }

  /**
   * Insert a commitment at a specific index
   */
  insert(leafIndex: number, commitment: bigint): void {
    this.leaves.set(leafIndex, commitment);
  }

  /**
   * Generate Merkle proof for a leaf at the given index
   *
   * @param leafIndex - Position of the leaf in the tree
   * @returns Array of 16 sibling hashes (path elements)
   */
  getMerkleProof(leafIndex: number): bigint[] {
    const commitment = this.leaves.get(leafIndex);
    if (!commitment) {
      throw new Error(`No leaf found at index ${leafIndex}`);
    }

    const pathElements: bigint[] = [];
    let currentIndex = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      // Compute the sibling hash at this level
      const siblingSubtreeStart = siblingIndex * (1 << level);
      const siblingSubtreeEnd = (siblingIndex + 1) * (1 << level);

      // Check if any leaves exist in the sibling's subtree range
      let hasLeaves = false;
      for (let i = siblingSubtreeStart; i < siblingSubtreeEnd; i++) {
        if (this.leaves.has(i)) {
          hasLeaves = true;
          break;
        }
      }

      let sibling: bigint;
      if (hasLeaves) {
        // Compute the hash of the sibling subtree
        sibling = this.computeSubtreeHash(
          siblingIndex,
          level,
          siblingSubtreeStart,
          siblingSubtreeEnd
        );
      } else {
        // No leaves in sibling subtree, use zero hash
        sibling = this.zeros[level];
      }

      pathElements.push(sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return pathElements;
  }

  /**
   * Compute the root hash of the tree
   */
  getRoot(): bigint {
    if (this.leaves.size === 0) {
      return this.zeros[this.depth];
    }

    // Compute root by hashing from leaves to root
    // The root is the hash of the entire tree from index 0 to 2^depth
    return this.computeSubtreeHash(0, this.depth, 0, 1 << this.depth);
  }

  /**
   * Compute hash of a subtree
   *
   * @param nodeIndex - Index of the node at the given level
   * @param level - Current level (0 = leaf level, depth = root level)
   * @param rangeStart - Start of leaf range covered by this subtree
   * @param rangeEnd - End of leaf range (exclusive)
   */
  private computeSubtreeHash(
    nodeIndex: number,
    level: number,
    rangeStart: number = nodeIndex * (1 << level),
    rangeEnd: number = (nodeIndex + 1) * (1 << level)
  ): bigint {
    if (level === 0) {
      // Leaf level
      return this.leaves.get(nodeIndex) || this.zeros[0];
    }

    // Compute left and right children
    const leftIndex = nodeIndex * 2;
    const rightIndex = nodeIndex * 2 + 1;
    const midPoint = rangeStart + (rangeEnd - rangeStart) / 2;

    const leftHash = this.computeSubtreeHash(
      leftIndex,
      level - 1,
      rangeStart,
      midPoint
    );
    const rightHash = this.computeSubtreeHash(
      rightIndex,
      level - 1,
      midPoint,
      rangeEnd
    );

    return poseidonHash([leftHash, rightHash]);
  }

  /**
   * Get number of leaves in the tree
   */
  get size(): number {
    return this.leaves.size;
  }
}