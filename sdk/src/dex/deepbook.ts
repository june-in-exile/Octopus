import { SuiClient } from "@mysten/sui/client";

/**
 * DeepBook V3 pool configuration
 */
export interface DeepBookPoolConfig {
  poolId: string;
  baseCoinType: string;
  quoteCoinType: string;
  takerFeeBps: number;
}

/**
 * Swap estimation result
 */
export interface SwapEstimation {
  amountOut: bigint;
  priceImpact: number;
  effectivePrice: number;
  feeAmount: bigint;
}

/**
 * Fetch DeepBook pool information
 *
 * @param client - Sui client instance
 * @param poolId - DeepBook pool object ID
 * @returns Pool configuration
 */
export async function getDeepBookPool(
  client: SuiClient,
  poolId: string
): Promise<DeepBookPoolConfig> {
  try {
    const poolObject = await client.getObject({
      id: poolId,
      options: { showContent: true },
    });

    if (!poolObject.data?.content || poolObject.data.content.dataType !== "moveObject") {
      throw new Error(`Invalid DeepBook pool: ${poolId}`);
    }

    const fields = poolObject.data.content.fields as Record<string, any>;

    return {
      poolId,
      baseCoinType: fields.base_coin_type || "",
      quoteCoinType: fields.quote_coin_type || "",
      takerFeeBps: parseInt(fields.taker_fee_bps || "25", 10),
    };
  } catch (error) {
    throw new Error(`Failed to fetch DeepBook pool ${poolId}: ${error}`);
  }
}

/**
 * Estimate swap output from DeepBook order book
 *
 * Note: This is a simplified estimation. In production, this should query
 * the actual order book depth and walk through orders to get accurate pricing.
 *
 * @param client - Sui client instance
 * @param poolId - DeepBook pool object ID
 * @param amountIn - Input amount in smallest units
 * @param isBid - true if buying base with quote, false if selling base for quote
 * @returns Swap estimation with output amount, price impact, and fees
 */
export async function estimateDeepBookSwap(
  client: SuiClient,
  poolId: string,
  amountIn: bigint,
  isBid: boolean
): Promise<SwapEstimation> {
  // Calculate 0.25% taker fee (25 basis points)
  const feeAmount = (amountIn * 25n) / 10000n;
  const amountInAfterFee = amountIn - feeAmount;

  // Simplified estimation (query order book in production)
  // Mock: 1 SUI = 3 USDC for testnet
  // In production, this should query actual order book and walk through orders
  let amountOut: bigint;
  if (isBid) {
    // Buying base (SUI) with quote (USDC): divide by 3
    amountOut = amountInAfterFee / 3n;
  } else {
    // Selling base (SUI) for quote (USDC): multiply by 3
    amountOut = amountInAfterFee * 3n;
  }

  const effectivePrice = Number(amountOut) / Number(amountIn);
  const priceImpact = 0.1; // Mock ~0.1% for testnet

  return {
    amountOut,
    priceImpact,
    effectivePrice,
    feeAmount,
  };
}

/**
 * Get current mid-market price from DeepBook
 *
 * @param client - Sui client instance
 * @param poolId - DeepBook pool object ID
 * @returns Mid-market price (best bid + best ask) / 2
 */
export async function getDeepBookPrice(
  client: SuiClient,
  poolId: string
): Promise<number> {
  // TODO: Query best bid/ask from order book
  // For testnet: return fixed 3.0 (1 SUI = 3 USDC)
  return 3.0;
}

/**
 * Known DeepBook pools (network-specific)
 *
 * Note: These need to be configured with actual pool IDs from testnet
 */
export const DEEPBOOK_POOLS = {
  mainnet: {
    /** SUI/USDC pool ID - mainnet */
    SUI_USDC: process.env.NEXT_PUBLIC_MAINNET_DEEPBOOK_SUI_USDC || "0x...",
  },
  testnet: {
    /** SUI/USDC pool ID - testnet */
    SUI_USDC: process.env.NEXT_PUBLIC_TESTNET_DEEPBOOK_SUI_USDC || "0x...",
  },
};
