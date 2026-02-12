"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useSuiClientContext } from "@mysten/dapp-kit";
import { NETWORK_CONFIG, SUI_COIN_TYPE, type TokenConfig } from "@/lib/constants";

interface NetworkConfigValue {
  packageId: string | null;
  suiPoolId: string | null;
  usdcPoolId: string | null;
  usdcCoinType: string | null;
  graphqlUrl: string | null;
  tokens: (Record<"SUI" | "USDC", TokenConfig> & Partial<Record<"DBUSDC", TokenConfig>>) | null;
  isConfigured: boolean;
  network: string;
}

const NetworkConfigContext = createContext<NetworkConfigValue | null>(null);

export function NetworkConfigProvider({ children }: { children: ReactNode }) {
  const { network } = useSuiClientContext();

  const config = NETWORK_CONFIG[network as keyof typeof NETWORK_CONFIG] ?? null;
  const isTestnet = network === "testnet";
  const isConfigured =
    !!config?.packageId &&
    !!config?.suiPoolId &&
    (isTestnet
      ? !!(config as any).dbusdcPoolId && !!(config as any).dbusdcCoinType
      : !!config.usdcPoolId && !!config.usdcCoinType);

  const tokens = isConfigured
    ? isTestnet
      ? {
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
          DBUSDC: {
            type: (config as any).dbusdcCoinType!,
            symbol: "DBUSDC",
            decimals: 6,
            poolId: (config as any).dbusdcPoolId!,
          },
        }
      : {
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
        }
    : null;

  return (
    <NetworkConfigContext.Provider
      value={{
        packageId: config?.packageId ?? null,
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
