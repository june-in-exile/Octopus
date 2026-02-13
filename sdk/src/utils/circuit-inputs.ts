import { type Note, MERKLE_TREE_DEPTH } from "../types.js";
import { computeMerkleRoot } from "../crypto.js";

/** Validate input notes, leaf indices, and path elements for 1-2 input circuits */
export function validateInputs(
  inputNotes: Note[],
  inputLeafIndices: number[],
  inputPathElements: bigint[][],
  token: bigint,
  label: string,
): void {
  if (inputNotes.length < 1 || inputNotes.length > 2) {
    throw new Error(`${label} requires 1 or 2 input notes`);
  }
  if (inputLeafIndices.length !== inputNotes.length || inputPathElements.length !== inputNotes.length) {
    throw new Error("Leaf indices and path elements must match notes count");
  }
  for (const paths of inputPathElements) {
    if (paths.length !== MERKLE_TREE_DEPTH) {
      throw new Error(
        `Invalid path elements length: ${paths.length}, expected ${MERKLE_TREE_DEPTH}`
      );
    }
  }
  if (inputNotes.some(n => n.token !== token)) {
    throw new Error("All input notes must be same token type");
  }
}

/**
 * Pad inputs to exactly 2 notes, adding a dummy zero-amount note if only 1 is provided.
 * Returns new (non-mutating) copies of all three arrays.
 */
export function padInputsTo2(
  inputNotes: Note[],
  inputLeafIndices: number[],
  inputPathElements: bigint[][],
  token: bigint,
): [Note[], number[], bigint[][]] {
  const paddedInputs = [...inputNotes];
  const paddedIndices = [...inputLeafIndices];
  const paddedPaths = [...inputPathElements];

  if (paddedInputs.length === 1) {
    const dummyNote: Note = {
      nsk: 0n,
      token,
      amount: 0n,
      random: 0n,
      commitment: 0n,
    };
    paddedInputs.push(dummyNote);
    paddedIndices.push(inputLeafIndices[0] === 0 ? 1 : 0);
    paddedPaths.push(Array(MERKLE_TREE_DEPTH).fill(0n));
  }

  return [paddedInputs, paddedIndices, paddedPaths];
}

/**
 * Compute Merkle root from the first padded input, and verify the second
 * input (if non-dummy) produces the same root.
 */
export function computeAndVerifyMerkleRoot(
  paddedInputs: Note[],
  paddedPaths: bigint[][],
  paddedIndices: number[],
): bigint {
  const merkleRoot = computeMerkleRoot(
    paddedInputs[0].commitment,
    paddedPaths[0],
    paddedIndices[0]
  );

  if (paddedInputs.length === 2 && paddedInputs[1].amount > 0n) {
    const root2 = computeMerkleRoot(
      paddedInputs[1].commitment,
      paddedPaths[1],
      paddedIndices[1]
    );
    if (root2 !== merkleRoot) {
      throw new Error(
        `Merkle root mismatch! This will cause circuit failure.\n` +
        `Input 0: leafIndex=${paddedIndices[0]}, root=${merkleRoot.toString()}\n` +
        `Input 1: leafIndex=${paddedIndices[1]}, root=${root2.toString()}\n`
      );
    }
  }

  return merkleRoot;
}
