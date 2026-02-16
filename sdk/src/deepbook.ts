import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

interface SuiClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  devInspectTransactionBlock(input: { transactionBlock: any; sender: string }): Promise<any>;
}

/**
 * Swap estimation result
 */
export interface SwapEstimation {
  amountOut: bigint;
  priceImpact: number;
  effectivePrice: number;
  feeAmount: bigint;
  /** True when amountOut is estimated from mid_price due to insufficient order book depth */
  isApproximate?: boolean;
}

// DeepBook V3 package ID fallback defaults.
// Callers should pass the latest package ID via the `deepbookPackageId` parameter
// (e.g. from NEXT_PUBLIC_*_DEEPBOOK_PACKAGE_ID env vars) to avoid stale hardcoded values.
const DEEPBOOK_PACKAGE_ID_DEFAULTS: Record<"testnet" | "mainnet", string> = {
  mainnet: "0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497",
  testnet: "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c",
};

const CLOCK_OBJECT_ID = "0x6";

// DeepBook FLOAT_SCALING factor for price values
const FLOAT_SCALING = 1_000_000_000n;

/**
 * DeepBook pool book parameters (tick size, lot size, min size).
 */
export interface PoolBookParams {
  tickSize: bigint;
  lotSize: bigint;
  minSize: bigint;
}

/**
 * Fetch the book parameters for a DeepBook pool via devInspect.
 * Returns tick_size, lot_size, and min_size set at pool creation.
 */
export async function getPoolBookParams(
  client: SuiClientLike,
  poolId: string,
  baseType: string,
  quoteType: string,
  network: "testnet" | "mainnet",
  deepbookPackageId?: string,
): Promise<PoolBookParams> {
  const packageId = deepbookPackageId ?? DEEPBOOK_PACKAGE_ID_DEFAULTS[network];
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::pool_book_params`,
    typeArguments: [baseType, quoteType],
    arguments: [tx.object(poolId)],
  });

  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
  });

  const returnValues = result.results?.[0]?.returnValues;
  if (!returnValues || returnValues.length < 3) {
    throw new Error("Failed to fetch pool book params");
  }

  return {
    tickSize: BigInt(bcs.U64.parse(new Uint8Array(returnValues[0][0]))),
    lotSize: BigInt(bcs.U64.parse(new Uint8Array(returnValues[1][0]))),
    minSize: BigInt(bcs.U64.parse(new Uint8Array(returnValues[2][0]))),
  };
}

/**
 * Fallback estimation using DeepBook mid_price when order book depth is insufficient.
 * mid_price = (best_bid + best_ask) / 2, scaled by FLOAT_SCALING (1e9).
 */
async function estimateFromMidPrice(
  client: SuiClientLike,
  poolId: string,
  amountIn: bigint,
  isBid: boolean,
  baseType: string,
  quoteType: string,
  packageId: string,
): Promise<SwapEstimation> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::mid_price`,
    typeArguments: [baseType, quoteType],
    arguments: [tx.object(poolId), tx.object(CLOCK_OBJECT_ID)],
  });

  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
  });

  if (!result.results?.[0]?.returnValues?.[0]) {
    return { amountOut: 0n, priceImpact: 0, effectivePrice: 0, feeAmount: 0n, isApproximate: true };
  }

  const midPriceRaw = BigInt(bcs.U64.parse(new Uint8Array(result.results[0].returnValues[0][0])));

  if (midPriceRaw === 0n) {
    return { amountOut: 0n, priceImpact: 0, effectivePrice: 0, feeAmount: 0n, isApproximate: true };
  }

  // mid_price = quote_per_base * FLOAT_SCALING
  // base→quote: amountOut = amountIn * midPrice / FLOAT_SCALING
  // quote→base: amountOut = amountIn * FLOAT_SCALING / midPrice
  const amountOut = isBid
    ? (amountIn * FLOAT_SCALING) / midPriceRaw
    : (amountIn * midPriceRaw) / FLOAT_SCALING;

  const effectivePrice = Number(amountOut) / Number(amountIn);

  return {
    amountOut,
    priceImpact: 0,
    effectivePrice,
    feeAmount: 0n,
    isApproximate: true,
  };
}

/**
 * Estimate swap output by simulating the DeepBook order book query on-chain.
 *
 * Uses devInspectTransactionBlock to call DeepBook's view functions:
 * - `pool::get_quote_quantity_out`: base → quote (e.g. SUI → DBUSDC)
 * - `pool::get_base_quantity_out`: quote → base (e.g. DBUSDC → SUI)
 *
 * @param client - Sui RPC client
 * @param poolId - DeepBook pool object ID
 * @param amountIn - Input amount in smallest units
 * @param isBid - true if buying base with quote (quote→base), false if selling base for quote (base→quote)
 * @param baseType - Full coin type of the base token (e.g. "0x2::sui::SUI")
 * @param quoteType - Full coin type of the quote token
 * @param network - "testnet" or "mainnet"
 * @param deepbookPackageId - Override the DeepBook package ID (e.g. from env vars). Falls back to hardcoded default.
 * @returns Swap estimation with output amount, price impact, and fees
 */
export async function estimateDeepBookSwap(
  client: SuiClientLike,
  poolId: string,
  amountIn: bigint,
  isBid: boolean,
  baseType: string,
  quoteType: string,
  network: "testnet" | "mainnet" = "testnet",
  deepbookPackageId?: string,
): Promise<SwapEstimation> {
  if (amountIn === 0n) {
    return { amountOut: 0n, priceImpact: 0, effectivePrice: 0, feeAmount: 0n };
  }

  const packageId = deepbookPackageId ?? DEEPBOOK_PACKAGE_ID_DEFAULTS[network];

  const tx = new Transaction();

  if (isBid) {
    // Buying base (SUI) with quote (DBUSDC): quote → base
    tx.moveCall({
      target: `${packageId}::pool::get_base_quantity_out`,
      typeArguments: [baseType, quoteType],
      arguments: [
        tx.object(poolId),
        tx.pure(bcs.U64.serialize(amountIn)),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
  } else {
    // Selling base (SUI) for quote (DBUSDC): base → quote
    tx.moveCall({
      target: `${packageId}::pool::get_quote_quantity_out`,
      typeArguments: [baseType, quoteType],
      arguments: [
        tx.object(poolId),
        tx.pure(bcs.U64.serialize(amountIn)),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
  }

  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
  });

  if (result.error) {
    throw new Error(`DeepBook estimation failed: ${result.error}`);
  }

  if (!result.results?.[0]?.returnValues) {
    throw new Error(
      `DeepBook estimation failed: no return values. ` +
      `status=${JSON.stringify(result.effects?.status)}`
    );
  }

  const returnValues = result.results[0].returnValues;

  // Return values: [base_quantity_out, quote_quantity_out, deep_quantity_required]
  // For base→quote swap: quote_quantity_out is what we receive
  // For quote→base swap: base_quantity_out is what we receive
  const baseOut = BigInt(bcs.U64.parse(new Uint8Array(returnValues[0][0])));
  const quoteOut = BigInt(bcs.U64.parse(new Uint8Array(returnValues[1][0])));
  const deepRequired = BigInt(bcs.U64.parse(new Uint8Array(returnValues[2][0])));

  const amountOut = isBid ? baseOut : quoteOut;

  // amountOut = 0 means the order book depth is insufficient for this amount
  // (e.g. amount too small for minimum lot size). Fall back to mid_price estimation.
  if (amountOut === 0n) {
    return estimateFromMidPrice(client, poolId, amountIn, isBid, baseType, quoteType, packageId);
  }

  const effectivePrice = Number(amountOut) / Number(amountIn);

  return {
    amountOut,
    priceImpact: 0, // DeepBook doesn't expose price impact directly; slippage tolerance handles this
    effectivePrice,
    feeAmount: deepRequired,
  };
}
