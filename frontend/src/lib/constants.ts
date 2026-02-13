/**
 * Octopus Frontend Constants
 */

// Network configuration - must be defined first
export const NETWORK = "testnet" as "testnet" | "mainnet" | "devnet" | "localnet";

// Per-network contract addresses (all baked into the bundle at build time)
export const NETWORK_CONFIG = {
  mainnet: {
    packageId: process.env.NEXT_PUBLIC_MAINNET_PACKAGE_ID || null, // For function calls (published-at)
    originalPackageId: process.env.NEXT_PUBLIC_MAINNET_ORIGINAL_PACKAGE_ID || null, // For event queries (original-id)
    suiPoolId: process.env.NEXT_PUBLIC_MAINNET_SUI_POOL_ID || null,
    usdcPoolId: process.env.NEXT_PUBLIC_MAINNET_USDC_POOL_ID || null,
    usdcCoinType: process.env.NEXT_PUBLIC_MAINNET_USDC_TYPE || null,
    deepCoinType: process.env.NEXT_PUBLIC_MAINNET_DEEP_TYPE || null,
    suiusdcPoolId: process.env.NEXT_PUBLIC_MAINNET_DEEPBOOK_SUI_USDC || null,
    graphqlUrl: "https://graphql.mainnet.sui.io/graphql",
  },
  testnet: {
    packageId: process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID || null, // For function calls (published-at)
    originalPackageId: process.env.NEXT_PUBLIC_TESTNET_ORIGINAL_PACKAGE_ID || null, // For event queries (original-id)
    suiPoolId: process.env.NEXT_PUBLIC_TESTNET_SUI_POOL_ID || null,
    usdcPoolId: process.env.NEXT_PUBLIC_TESTNET_USDC_POOL_ID || null,
    dbusdcPoolId: process.env.NEXT_PUBLIC_TESTNET_DBUSDC_POOL_ID || null,
    usdcCoinType: process.env.NEXT_PUBLIC_TESTNET_USDC_TYPE || null,
    dbusdcCoinType: process.env.NEXT_PUBLIC_TESTNET_DBUSDC_TYPE || null,
    deepCoinType: process.env.NEXT_PUBLIC_TESTNET_DEEP_TYPE || null,
    suidbusdcPoolId: process.env.NEXT_PUBLIC_TESTNET_DEEPBOOK_SUI_DBUSDC || null,
    graphqlUrl: "https://graphql.testnet.sui.io/graphql",
  },
} as const;

// Sui Clock shared object
export const CLOCK_OBJECT_ID = "0x6";

// Static token type
export const SUI_COIN_TYPE = "0x2::sui::SUI";

// DeepBook pool mappings (network-specific)
const getDeepBookPoolId = (tokenPair: string) => {
  if (NETWORK === "mainnet") {
    // Mainnet uses SUI/USDC pool
    if (tokenPair === "SUI_USDC" || tokenPair === "USDC_SUI") {
      return process.env.NEXT_PUBLIC_MAINNET_DEEPBOOK_SUI_USDC || "0x...";
    }
  } else {
    // Testnet uses SUI/DBUSDC pool
    if (tokenPair === "SUI_DBUSDC" || tokenPair === "DBUSDC_SUI") {
      return process.env.NEXT_PUBLIC_TESTNET_DEEPBOOK_SUI_DBUSDC || "0x...";
    }
  }
  return "0x...";
};

// Estimated DEEP fee for swap operations (~0.01 DEEP)
export const ESTIMATED_DEEP_FEE = 10_000_000n; // In smallest units (6 decimals)

// Default swap mode (test mode for testnet, can be overridden by user)
export const DEFAULT_SWAP_MODE: "test" | "production" = NETWORK === "mainnet" ? "production" : "test";

// Token configurations
export interface TokenConfig {
  type: string;
  symbol: string;
  decimals: number;
  poolId: string;
}