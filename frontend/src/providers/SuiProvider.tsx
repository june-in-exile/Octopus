"use client";

import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import {
  SuiClientProvider,
  WalletProvider,
  createNetworkConfig,
  type ThemeVars,
} from "@mysten/dapp-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { NETWORK } from "@/lib/constants";
import { NetworkConfigProvider } from "@/providers/NetworkConfigProvider";

import "@mysten/dapp-kit/dist/index.css";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" as const },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" as const },
});

// Custom dark theme matching Octopus design
const octopusTheme: ThemeVars = {
  blurs: {
    modalOverlay: "blur(10px)",
  },
  backgroundColors: {
    primaryButton: "#rgba(255, 255, 255, 0.9)",
    primaryButtonHover: "rgba(9, 42, 48, 0.9)",
    outlineButtonHover: "rgba(0, 217, 255, 0.1)",
    walletItemHover: "rgba(0, 217, 255, 0.05)",
    walletItemSelected: "rgba(0, 217, 255, 0.15)",
    modalOverlay: "rgba(5, 5, 8, 0.95)",
    modalPrimary: "#050508",
    modalSecondary: "#0a1a2a",
    iconButton: "#0a0a0d",
    iconButtonHover: "rgba(0, 217, 255, 0.1)",
    dropdownMenu: "#0a1a2a",
    dropdownMenuSeparator: "rgba(0, 217, 255, 0.2)",
  },
  borderColors: {
    outlineButton: "#00d9ff",
  },
  colors: {
    primaryButton: "#050508",
    outlineButton: "#00d9ff",
    iconButton: "#00d9ff",
    body: "#ffffff",
    bodyMuted: "rgba(0, 217, 255, 0.7)",
    bodyDanger: "#ef4444",
  },
  radii: {
    small: "0.25rem",
    medium: "0.5rem",
    large: "0.75rem",
    xlarge: "1rem",
  },
  shadows: {
    primaryButton: "none",
    walletItemSelected: "none",
  },
  fontWeights: {
    normal: "400",
    medium: "600",
    bold: "700",
  },
  fontSizes: {
    small: "0.875rem",
    medium: "1rem",
    large: "1.125rem",
    xlarge: "1.25rem",
  },
  typography: {
    fontFamily:
      "'Courier New', monospace, system-ui, -apple-system, sans-serif",
    fontStyle: "normal",
    lineHeight: "1.5",
    letterSpacing: "0.05em",
  },
};

interface SuiProviderProps {
  children: ReactNode;
}

export function SuiProvider({ children }: SuiProviderProps) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={NETWORK === "mainnet" ? "mainnet" : "testnet"}>
        <WalletProvider autoConnect theme={octopusTheme}>
          <NetworkConfigProvider>{children}</NetworkConfigProvider>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
