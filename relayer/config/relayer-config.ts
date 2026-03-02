import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export type Network = "mainnet" | "testnet";

export interface RelayerConfig {
  network: Network;
  rpcUrl: string;
  packageId: string;
  keypair: Ed25519Keypair;
  feePremium: number;
  supportedTokens: string[];
  deepCoinType: string;
  estimatedDeepFee: bigint;
  /** Octopus pool object IDs this relayer will interact with. Empty = no restriction. */
  allowedPools: Set<string>;
  /** DeepBook pool object IDs this relayer will route swaps through. Empty = no restriction. */
  allowedDeepbookPools: Set<string>;
}

interface NetworkDefaults {
  rpcUrl: string;
  deepCoinType: string;
  /** Env var names whose values are Octopus pool object IDs */
  poolEnvVars: string[];
  /** Env var names whose values are DeepBook pool object IDs */
  deepbookPoolEnvVars: string[];
  /** Env var names whose values are token type strings */
  tokenTypeEnvVars: string[];
  /** Native token types that are always supported (no env var needed) */
  nativeTokenTypes: string[];
}

const NETWORK_DEFAULTS: Record<Network, NetworkDefaults> = {
  mainnet: {
    rpcUrl: "https://fullnode.mainnet.sui.io",
    deepCoinType:
      "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
    poolEnvVars: [
      "MAINNET_SUI_POOL_ID",
      "MAINNET_USDC_POOL_ID",
    ],
    deepbookPoolEnvVars: ["MAINNET_DEEPBOOK_SUI_USDC"],
    tokenTypeEnvVars: [
      "MAINNET_USDC_TYPE",
      "MAINNET_DEEP_TYPE",
    ],
    nativeTokenTypes: ["0x2::sui::SUI"],
  },
  testnet: {
    rpcUrl: "https://fullnode.testnet.sui.io",
    deepCoinType:
      "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP",
    poolEnvVars: [
      "TESTNET_SUI_POOL_ID",
      "TESTNET_USDC_POOL_ID",
      "TESTNET_DBUSDC_POOL_ID",
    ],
    deepbookPoolEnvVars: ["TESTNET_DEEPBOOK_SUI_DBUSDC"],
    tokenTypeEnvVars: [
      "TESTNET_USDC_TYPE",
      "TESTNET_DBUSDC_TYPE",
      "TESTNET_DEEP_TYPE",
    ],
    nativeTokenTypes: ["0x2::sui::SUI"],
  },
};

function collectEnvValues(envVars: string[]): string[] {
  return envVars.map((v) => process.env[v]).filter((v): v is string => !!v);
}

function loadKeypair(network: Network): Ed25519Keypair {
  const networkKey = network.toUpperCase();
  const privateKey = process.env[`${networkKey}_RELAYER_PRIVATE_KEY`];
  if (!privateKey) {
    throw new Error(
      `${networkKey}_RELAYER_PRIVATE_KEY environment variable is not set`,
    );
  }
  return Ed25519Keypair.fromSecretKey(privateKey);
}

export function loadNetworkConfig(network: Network): RelayerConfig {
  const defaults = NETWORK_DEFAULTS[network];
  const networkKey = network.toUpperCase();

  const rpcUrl = process.env[`${networkKey}_RPC_URL`] ?? defaults.rpcUrl;

  const packageId = process.env[`${networkKey}_PACKAGE_ID`];
  if (!packageId) {
    throw new Error(
      `${networkKey}_PACKAGE_ID environment variable is not set`,
    );
  }

  const allowedPools = new Set(collectEnvValues(defaults.poolEnvVars));
  const allowedDeepbookPools = new Set(collectEnvValues(defaults.deepbookPoolEnvVars));

  if (allowedPools.size === 0) {
    console.warn(
      `[relayer:${network}] WARNING: No pool whitelist configured (${defaults.poolEnvVars.join(", ")} not set). All Octopus pool IDs will be accepted.`,
    );
  }
  if (allowedDeepbookPools.size === 0) {
    console.warn(
      `[relayer:${network}] WARNING: No DeepBook pool whitelist configured (${defaults.deepbookPoolEnvVars.join(", ")} not set). All DeepBook pool IDs will be accepted.`,
    );
  }

  return {
    network,
    rpcUrl,
    packageId,
    keypair: loadKeypair(network),
    feePremium: 0,
    supportedTokens: [
      ...defaults.nativeTokenTypes,
      ...collectEnvValues(defaults.tokenTypeEnvVars),
    ],
    deepCoinType: process.env[`${networkKey}_DEEP_TYPE`] ?? defaults.deepCoinType,
    estimatedDeepFee: 10_000n,
    allowedPools,
    allowedDeepbookPools,
  };
}

export function loadAllConfigs(): Partial<Record<Network, RelayerConfig>> {
  const configs: Partial<Record<Network, RelayerConfig>> = {};
  for (const network of ["mainnet", "testnet"] as Network[]) {
    try {
      configs[network] = loadNetworkConfig(network);
    } catch (err) {
      console.warn(
        `[relayer] Skipping ${network}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (Object.keys(configs).length === 0) {
    throw new Error(
      "No networks configured. Set at least one network's RELAYER_PRIVATE_KEY and PACKAGE_ID.",
    );
  }
  return configs;
}
