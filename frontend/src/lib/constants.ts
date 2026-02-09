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

// Circuit artifact URLs
export const CIRCUIT_URLS = {
  UNSHIELD: {
    WASM: "/circuits/unshield_js/unshield.wasm",
    ZKEY: "/circuits/unshield_final.zkey",
    VK: "/circuits/unshield_vk.json",
  },
  TRANSFER: {
    WASM: "/circuits/transfer_js/transfer.wasm",
    ZKEY: "/circuits/transfer_final.zkey",
    VK: "/circuits/transfer_vk.json",
  },
  SWAP: {
    WASM: "/circuits/swap_js/swap.wasm",
    ZKEY: "/circuits/swap_final.zkey",
    VK: "/circuits/swap_vk.json",
  },
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

// DeepBook pool mappings (SUI/USDC pair - network-specific)
const getDeepBookPoolId = () => {
  if (NETWORK === "mainnet") {
    return process.env.NEXT_PUBLIC_MAINNET_DEEPBOOK_SUI_USDC || "0x...";
  }
  return process.env.NEXT_PUBLIC_TESTNET_DEEPBOOK_SUI_USDC || "0x...";
};

export const DEEPBOOK_POOLS: Record<string, string> = {
  SUI_USDC: getDeepBookPoolId(),
  USDC_SUI: getDeepBookPoolId(), // Same pool, reverse direction
};
