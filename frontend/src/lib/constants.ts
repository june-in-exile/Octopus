/**
 * Octopus Frontend Constants
 */

// Network configuration - must be defined first
export const NETWORK = "testnet" as "testnet" | "mainnet" | "devnet" | "localnet";

// Per-network contract addresses (all baked into the bundle at build time)
const trimEnv = (value: string | undefined): string | null =>
  value?.trim() || null;

export const NETWORK_CONFIG = {
  mainnet: {
    packageId: trimEnv(process.env.NEXT_PUBLIC_MAINNET_PACKAGE_ID), // For function calls (published-at)
    originalPackageId: trimEnv(process.env.NEXT_PUBLIC_MAINNET_ORIGINAL_PACKAGE_ID), // For event queries (original-id)
    suiPoolId: trimEnv(process.env.NEXT_PUBLIC_MAINNET_SUI_POOL_ID),
    usdcPoolId: trimEnv(process.env.NEXT_PUBLIC_MAINNET_USDC_POOL_ID),
    deepPoolId: trimEnv(process.env.NEXT_PUBLIC_MAINNET_DEEP_POOL_ID),
    usdcCoinType: trimEnv(process.env.NEXT_PUBLIC_MAINNET_USDC_TYPE),
    deepCoinType: trimEnv(process.env.NEXT_PUBLIC_MAINNET_DEEP_TYPE),
    suiusdcPoolId: trimEnv(process.env.NEXT_PUBLIC_MAINNET_DEEPBOOK_SUI_USDC),
    deepsuiPoolId: trimEnv(process.env.NEXT_PUBLIC_MAINNET_DEEPBOOK_DEEP_SUI),
    graphqlUrl: "https://graphql.mainnet.sui.io/graphql",
  },
  testnet: {
    packageId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID), // For function calls (published-at)
    originalPackageId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_ORIGINAL_PACKAGE_ID), // For event queries (original-id)
    suiPoolId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_SUI_POOL_ID),
    usdcPoolId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_USDC_POOL_ID),
    dbusdcPoolId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_DBUSDC_POOL_ID),
    deepPoolId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_DEEP_POOL_ID),
    usdcCoinType: trimEnv(process.env.NEXT_PUBLIC_TESTNET_USDC_TYPE),
    dbusdcCoinType: trimEnv(process.env.NEXT_PUBLIC_TESTNET_DBUSDC_TYPE),
    deepCoinType: trimEnv(process.env.NEXT_PUBLIC_TESTNET_DEEP_TYPE),
    suidbusdcPoolId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_DEEPBOOK_SUI_DBUSDC),
    deepsuiPoolId: trimEnv(process.env.NEXT_PUBLIC_TESTNET_DEEPBOOK_DEEP_SUI),
    graphqlUrl: "https://graphql.testnet.sui.io/graphql",
  },
} as const;

// Sui Clock shared object
export const CLOCK_OBJECT_ID = "0x6";

// Static token type
export const SUI_COIN_TYPE = "0x2::sui::SUI";

// Estimated DEEP fee for swap operations (~0.01 DEEP)
export const ESTIMATED_DEEP_FEE = 10_000n; // 0.01 DEEP in smallest units (6 decimals)

// Token configurations
export interface TokenConfig {
  type: string;
  symbol: string;
  decimals: number;
  poolId: string;
}

// DeepBook pair configuration
export interface DeepBookPairConfig {
  poolId: string;
  base: string; // base token symbol (e.g. "SUI", "DEEP")
  quote: string; // quote token symbol (e.g. "USDC", "SUI")
}

// Returns the DeepBook pair config for a given tokenIn/tokenOut combination, or null if no pool is configured.
// isBid = tokenIn is the quote token (buying base with quote).
export function getDeepBookPairConfig(
  tokenIn: string,
  tokenOut: string,
  network: "mainnet" | "testnet",
): DeepBookPairConfig | null {
  const cfg = NETWORK_CONFIG[network];

  // Mainnet pairs
  if (network === "mainnet") {
    const mainCfg = cfg as typeof NETWORK_CONFIG.mainnet;
    if ((tokenIn === "SUI" && tokenOut === "USDC") || (tokenIn === "USDC" && tokenOut === "SUI")) {
      if (!mainCfg.suiusdcPoolId) return null;
      return { poolId: mainCfg.suiusdcPoolId, base: "SUI", quote: "USDC" };
    }
    if ((tokenIn === "DEEP" && tokenOut === "SUI") || (tokenIn === "SUI" && tokenOut === "DEEP")) {
      if (!mainCfg.deepsuiPoolId) return null;
      return { poolId: mainCfg.deepsuiPoolId, base: "DEEP", quote: "SUI" };
    }
  }

  // Testnet pairs
  if (network === "testnet") {
    const testCfg = cfg as typeof NETWORK_CONFIG.testnet;
    if (
      (tokenIn === "SUI" && tokenOut === "DBUSDC") ||
      (tokenIn === "DBUSDC" && tokenOut === "SUI")
    ) {
      if (!testCfg.suidbusdcPoolId) return null;
      return { poolId: testCfg.suidbusdcPoolId, base: "SUI", quote: "DBUSDC" };
    }
    if ((tokenIn === "DEEP" && tokenOut === "SUI") || (tokenIn === "SUI" && tokenOut === "DEEP")) {
      if (!testCfg.deepsuiPoolId) return null;
      return { poolId: testCfg.deepsuiPoolId, base: "DEEP", quote: "SUI" };
    }
  }

  return null;
}