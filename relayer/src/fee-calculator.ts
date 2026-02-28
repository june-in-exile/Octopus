import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";

export interface GasEstimate {
  computationCost: bigint;
  storageCost: bigint;
  storageRebate: bigint;
  totalGas: bigint;
}

const DEFAULT_GAS_ESTIMATE: GasEstimate = {
  computationCost: 1_000_000n,
  storageCost: 1_000_000n,
  storageRebate: 0n,
  totalGas: 2_000_000n,
};

export async function estimateGas(
  client: SuiClient,
  transactionBytes: Uint8Array,
): Promise<GasEstimate> {
  try {
    const dryRunResult = await client.dryRunTransactionBlock({
      transactionBlock: transactionBytes,
    });
    const gasUsed = dryRunResult.effects?.gasUsed;
    if (!gasUsed) return DEFAULT_GAS_ESTIMATE;

    const computationCost = BigInt(gasUsed.computationCost);
    const storageCost = BigInt(gasUsed.storageCost);
    const storageRebate = BigInt(gasUsed.storageRebate);
    const totalGas = computationCost + storageCost - storageRebate;

    return { computationCost, storageCost, storageRebate, totalGas };
  } catch {
    return DEFAULT_GAS_ESTIMATE;
  }
}
