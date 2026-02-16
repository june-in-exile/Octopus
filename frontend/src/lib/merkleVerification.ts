import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { poseidonHash, bytesToBigIntLE } from "@june_zk/octopus-sdk";
import type { OwnedNote } from "@/hooks/useNotes";

const MERKLE_TREE_DEPTH = 16;

/**
 * Compute Merkle root from a note's commitment and path elements
 */
export function computeMerkleRoot(
  commitment: bigint,
  leafIndex: number,
  pathElements: bigint[]
): bigint {
  let root = commitment;
  const leafIndexBigInt = BigInt(leafIndex);

  for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
    const sibling = pathElements[level];
    const isRight = (leafIndexBigInt >> BigInt(level)) & 1n;

    if (isRight === 0n) {
      root = poseidonHash([root, sibling]);
    } else {
      root = poseidonHash([sibling, root]);
    }
  }

  return root;
}

/**
 * Verify NSK derivation and compute Merkle roots for input notes
 * Throws if NSK derivation fails or if roots don't match
 */
export function verifyNotesAndComputeRoots(
  notesWithProofs: OwnedNote[],
  masterPublicKey: bigint
): bigint[] {
  const computedRoots: bigint[] = [];

  for (let i = 0; i < notesWithProofs.length; i++) {
    const note = notesWithProofs[i].note;
    const expectedNSK = poseidonHash([masterPublicKey, note.random]);
    const nskMatches = expectedNSK === note.nsk;

    // Compute Merkle root
    const root = computeMerkleRoot(
      note.commitment,
      notesWithProofs[i].leafIndex,
      notesWithProofs[i].pathElements!
    );
    computedRoots.push(root);

    if (!nskMatches) {
      throw new Error(
        `Input note ${i} has invalid NSK! Expected ${expectedNSK} but got ${note.nsk}`
      );
    }
  }

  // Verify both notes have the same Merkle root
  if (computedRoots.length === 2 && computedRoots[0] !== computedRoots[1]) {
    throw new Error(
      `Merkle root mismatch detected!\n` +
      `Note 0 root: ${computedRoots[0].toString()}\n` +
      `Note 1 root: ${computedRoots[1].toString()}\n` +
      `Your notes have stale Merkle proofs. Please refresh your notes and try again.`
    );
  }

  return computedRoots;
}

/**
 * Fetch and verify on-chain Merkle root matches local computed root
 * @param stage - Description of when verification is happening (e.g., "pre-proof", "post-proof")
 */
export async function verifyOnChainRoot(
  client: SuiJsonRpcClient,
  packageId: string,
  poolId: string,
  coinType: string,
  senderAddress: string,
  localRoot: bigint,
  stage: string
): Promise<void> {
  const onChainRootResult = await client.devInspectTransactionBlock({
    transactionBlock: (() => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${packageId}::pool::get_merkle_root`,
        typeArguments: [coinType],
        arguments: [tx.object(poolId)],
      });
      return tx;
    })(),
    sender: senderAddress || "0x0",
  });

  if (onChainRootResult.results?.[0]?.returnValues?.[0]) {
    // returnValues[0] is a tuple: [bytes: number[], type: string]
    const [rootBytes] = onChainRootResult.results[0].returnValues[0];

    // Use SDK's tested utility function for LE byte conversion
    const onChainRoot = bytesToBigIntLE(rootBytes);

    if (onChainRoot !== localRoot) {
      throw new Error(
        `Your notes have outdated Merkle proofs! (detected at ${stage})\n` +
        `Local root: ${localRoot.toString()}\n` +
        `On-chain root: ${onChainRoot.toString()}\n\n` +
        `New notes have been added to the pool since you last scanned. ` +
        `Please refresh your notes and try again.`
      );
    }
  }
}
