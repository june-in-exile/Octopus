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
}

const NETWORK_DEFAULTS: Record<Network, { rpcUrl: string; deepCoinType: string }> = {
  mainnet: {
    rpcUrl: "https://fullnode.mainnet.sui.io",
    deepCoinType:
      "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946501f::deep::DEEP",
  },
  testnet: {
    rpcUrl: "https://fullnode.testnet.sui.io",
    deepCoinType:
      "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP",
  },
};

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

  const packageId = process.env[`NEXT_PUBLIC_${networkKey}_PACKAGE_ID`];
  if (!packageId) {
    throw new Error(
      `NEXT_PUBLIC_${networkKey}_PACKAGE_ID environment variable is not set`,
    );
  }

  return {
    network,
    rpcUrl,
    packageId,
    keypair: loadKeypair(network),
    feePremium: 0,
    supportedTokens: [],
    deepCoinType: defaults.deepCoinType,
    estimatedDeepFee: 10_000n,
  };
}

export function loadAllConfigs(): Record<Network, RelayerConfig> {
  return {
    mainnet: loadNetworkConfig("mainnet"),
    testnet: loadNetworkConfig("testnet"),
  };
}
