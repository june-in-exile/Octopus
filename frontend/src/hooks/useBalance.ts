"use client";

import { useState, useEffect, useCallback } from "react";
import { useSuiClient } from "@mysten/dapp-kit";
import type { WalletAccount } from "@mysten/wallet-standard";
import type { TokenConfig } from "@/lib/constants";

/**
 * Hook to fetch wallet balance for a specific token
 *
 * @param account - Connected wallet account (from useCurrentAccount)
 * @param tokenConfig - Token configuration with type and metadata
 * @returns Balance in base units, loading state, error, and refresh function
 */
export function useBalance(
  account: WalletAccount | null | undefined,
  tokenConfig: TokenConfig | null
) {
  const client = useSuiClient();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Expose refresh function to manually trigger a refetch
  const refresh = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  useEffect(() => {
    let isCancelled = false;

    async function fetchBalance() {
      // Early return if no account or token config
      if (!account?.address || !tokenConfig) {
        setBalance(null);
        setLoading(false);
        setError(null);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const balanceResult = await client.getBalance({
          owner: account.address,
          coinType: tokenConfig.type,
        });

        if (isCancelled) return;

        setBalance(BigInt(balanceResult.totalBalance));
      } catch (err) {
        if (!isCancelled) {
          console.error("[useBalance] Failed to fetch balance:", err);
          setError(err instanceof Error ? err.message : "Failed to fetch balance");
          setBalance(null);
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    }

    fetchBalance();

    return () => {
      isCancelled = true;
    };
  }, [account?.address, client, tokenConfig?.type, refreshTrigger]);

  return {
    balance,
    loading,
    error,
    refresh,
  };
}
