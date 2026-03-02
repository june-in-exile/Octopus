"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useSuiClientContext } from "@mysten/dapp-kit";
import { NETWORK_CONFIG, SUI_COIN_TYPE, type TokenConfig } from "@/lib/constants";

type TestnetConfig = typeof NETWORK_CONFIG.testnet;
type MainnetConfig = typeof NETWORK_CONFIG.mainnet;

function isTestnetConfig(config: TestnetConfig | MainnetConfig): config is TestnetConfig {
  return "dbusdcCoinType" in config;
}

interface NetworkConfigValue {
  packageId: string | null; // For function calls (published-at)
  originalPackageId: string | null; // For event queries (original-id)
  suiPoolId: string | null;
  usdcPoolId: string | null;
  usdcCoinType: string | null;
  graphqlUrl: string | null;
  tokens: (Record<"SUI" | "USDC", TokenConfig> & Partial<Record<"DBUSDC" | "DEEP", TokenConfig>>) | null;
  isConfigured: boolean;
  network: string;
}

const NetworkConfigContext = createContext<NetworkConfigValue | null>(null);

export function NetworkConfigProvider({ children }: { children: ReactNode }) {
  const { network } = useSuiClientContext();

  const config = NETWORK_CONFIG[network as keyof typeof NETWORK_CONFIG] ?? null;

  const isConfigured =
    config !== null &&
    !!config.packageId &&
    !!config.originalPackageId &&
    !!config.suiPoolId &&
    (isTestnetConfig(config)
      ? !!config.usdcPoolId && !!config.dbusdcCoinType && !!config.dbusdcPoolId
      : !!config.usdcPoolId && !!config.usdcCoinType);

  const tokens: NetworkConfigValue["tokens"] = (() => {
    if (!isConfigured || !config) return null;

    const base = {
      SUI: {
        type: SUI_COIN_TYPE,
        symbol: "SUI",
        decimals: 9,
        poolId: config.suiPoolId!,
      },
      USDC: {
        type: config.usdcCoinType!,
        symbol: "USDC",
        decimals: 6,
        poolId: config.usdcPoolId!,
      },
    };

    const deep =
      config.deepPoolId && config.deepCoinType
        ? {
            DEEP: {
              type: config.deepCoinType,
              symbol: "DEEP",
              decimals: 6,
              poolId: config.deepPoolId,
            } satisfies TokenConfig,
          }
        : {};

    if (isTestnetConfig(config)) {
      return {
        ...base,
        DBUSDC: {
          type: config.dbusdcCoinType!,
          symbol: "DBUSDC",
          decimals: 6,
          poolId: config.dbusdcPoolId!,
        },
        ...deep,
      };
    }

    return { ...base, ...deep };
  })();

  return (
    <NetworkConfigContext.Provider
      value={{
        packageId: config?.packageId ?? null,
        originalPackageId: config?.originalPackageId ?? null,
        suiPoolId: config?.suiPoolId ?? null,
        usdcPoolId: config?.usdcPoolId ?? null,
        usdcCoinType: config?.usdcCoinType ?? null,
        graphqlUrl: config?.graphqlUrl ?? null,
        tokens,
        isConfigured,
        network,
      }}
    >
      {children}
    </NetworkConfigContext.Provider>
  );
}

export function useNetworkConfig(): NetworkConfigValue {
  const ctx = useContext(NetworkConfigContext);
  if (!ctx) {
    throw new Error("useNetworkConfig must be used within NetworkConfigProvider");
  }
  return ctx;
}
