/**
 * Octopus Frontend Constants
 */

// Network configuration - must be defined first
export const NETWORK = "testnet" as "testnet" | "mainnet" | "devnet" | "localnet";

// Per-network contract addresses (all baked into the bundle at build time)
export const NETWORK_CONFIG = {
  testnet: {
    packageId: process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID || null,
    suiPoolId: process.env.NEXT_PUBLIC_TESTNET_SUI_POOL_ID || null,
    usdcPoolId: process.env.NEXT_PUBLIC_TESTNET_USDC_POOL_ID || null,
    usdcCoinType: process.env.NEXT_PUBLIC_TESTNET_USDC_TYPE || null,
    dbusdcPoolId: process.env.NEXT_PUBLIC_TESTNET_USDC_POOL_ID || null, // DBUSDC uses same pool as USDC
    dbusdcCoinType: process.env.NEXT_PUBLIC_TESTNET_DBUSDC_TYPE || null,
    graphqlUrl: "https://graphql.testnet.sui.io/graphql",
  },
  mainnet: {
    packageId: process.env.NEXT_PUBLIC_MAINNET_PACKAGE_ID || null,
    suiPoolId: process.env.NEXT_PUBLIC_MAINNET_SUI_POOL_ID || null,
    usdcPoolId: process.env.NEXT_PUBLIC_MAINNET_USDC_POOL_ID || null,
    usdcCoinType: process.env.NEXT_PUBLIC_MAINNET_USDC_TYPE || null,
    graphqlUrl: "https://graphql.mainnet.sui.io/graphql",
  },
} as const;

// Static token type (same across networks)
export const SUI_COIN_TYPE = "0x2::sui::SUI";

// LocalStorage keys
export const STORAGE_KEYS = {
  KEYPAIR: "octopus_keypair",
  NOTES: "octopus_notes",
} as const;

// DeepBook V3 configuration
export const DEEPBOOK_PACKAGE_ID = "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809";

// Token configurations
export interface TokenConfig {
  type: string;
  symbol: string;
  decimals: number;
  poolId: string;
}

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
    // Legacy USDC pool (for backward compatibility, test mode only)
    if (tokenPair === "SUI_USDC" || tokenPair === "USDC_SUI") {
      return process.env.NEXT_PUBLIC_TESTNET_DEEPBOOK_SUI_USDC || "0x...";
    }
  }
  return "0x...";
};

export const DEEPBOOK_POOLS: Record<string, string> = {
  // Mainnet pools
  SUI_USDC: getDeepBookPoolId("SUI_USDC"),
  USDC_SUI: getDeepBookPoolId("USDC_SUI"),
  // Testnet pools
  SUI_DBUSDC: getDeepBookPoolId("SUI_DBUSDC"),
  DBUSDC_SUI: getDeepBookPoolId("DBUSDC_SUI"),
};

// DEEP token configuration for DeepBook fees
export const DEEP_TOKEN_CONFIG = {
  testnet: {
    type: process.env.NEXT_PUBLIC_TESTNET_DEEP_TYPE || "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP",
    decimals: 6,
  },
  mainnet: {
    type: process.env.NEXT_PUBLIC_MAINNET_DEEP_TYPE || "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
    decimals: 6,
  },
} as const;

// Get DEEP token type for current network
export const DEEP_TOKEN_TYPE = NETWORK === "mainnet"
  ? DEEP_TOKEN_CONFIG.mainnet.type
  : DEEP_TOKEN_CONFIG.testnet.type;

// Estimated DEEP fee for swap operations (~0.01 DEEP)
export const ESTIMATED_DEEP_FEE = 10_000_000n; // In smallest units (6 decimals)

// Sui Clock shared object (same across all networks)
export const CLOCK_OBJECT_ID = "0x6";

// Default swap mode (test mode for testnet, can be overridden by user)
export const DEFAULT_SWAP_MODE: "test" | "production" = NETWORK === "mainnet" ? "production" : "test";
