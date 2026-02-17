"use client";

import { useState, useEffect, useCallback } from "react";
import { bigIntToHex, hexToBigInt } from "@/lib/utils";
import {
  getDefaultIdentifier,
  getSavedKeypairs,
  saveKeypair,
  deleteKeypair,
  clearActiveKeypair,
  getActiveKeypair,
  setActiveKeypair,
  updateKeypairLabel,
  type StoredKeypair,
} from "@/lib/keypairStorage";

export interface OctopusKeypair {
  spendingKey: bigint;
  nullifyingKey: bigint;
  masterPublicKey: bigint;
}

/**
 * Hook to manage Octopus keypair in localStorage
 * Organized by wallet address and pool package ID
 * For demo purposes only - not secure for production!
 */
export function useLocalKeypair(walletAddress: string | undefined) {
  const [keypair, setKeypair] = useState<OctopusKeypair | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [poseidonReady, setPoseidonReady] = useState(false);
  const [savedKeypairs, setSavedKeypairs] = useState<StoredKeypair[]>([]);

  // Initialize Poseidon and load keypair from storage
  useEffect(() => {
    async function init() {
      setIsLoading(true);  // Ensure loading state is set at start
      try {
        // Use shared singleton to avoid concurrent WebAssembly allocations
        const { initPoseidon } = await import("@/lib/poseidon");
        await initPoseidon();
        setPoseidonReady(true);
        // Don't set isLoading=false here - wait for keypair to load in next effect
      } catch (error) {
        console.error("Failed to initialize:", error);
        setIsLoading(false); // Only set to false on error
      }
    }

    init();
  }, []);

  // Auto-load active keypair when wallet address changes
  useEffect(() => {
    if (!walletAddress) {
      // Wallet disconnected - clear everything
      setKeypair(null);
      setSavedKeypairs([]);
      setIsLoading(false); // Wallet disconnected, stop loading
      return;
    }

    // Wait for Poseidon to be ready before loading keypair
    if (!poseidonReady) {
      return; // Still initializing, keep isLoading = true
    }

    // Poseidon is ready - safe to load keypair from localStorage
    const identifier = getDefaultIdentifier(walletAddress);
    const activeKeypair = getActiveKeypair(identifier);

    if (activeKeypair) {
      // Auto-load active keypair for this address
      const keypairObj: OctopusKeypair = {
        spendingKey: hexToBigInt(activeKeypair.spendingKey),
        nullifyingKey: hexToBigInt(activeKeypair.nullifyingKey),
        masterPublicKey: hexToBigInt(activeKeypair.masterPublicKey),
      };
      setKeypair(keypairObj);
    } else {
      // No active keypair for this address - clear
      setKeypair(null);
    }

    // Update saved keypairs list
    const saved = getSavedKeypairs(identifier);
    setSavedKeypairs(saved);

    // Initialization complete - Poseidon is ready and keypair is loaded (or confirmed absent)
    setIsLoading(false);
  }, [walletAddress, poseidonReady]);

  // Generate a new keypair
  const generateKeypair = useCallback(async () => {
    if (!poseidonReady) {
      throw new Error("Poseidon not ready");
    }

    if (!walletAddress) {
      throw new Error("Wallet not connected");
    }

    try {
      const { poseidonHash, randomFieldElement } = await import("@june_zk/octopus-sdk");

      // Generate random spending key using SDK's secure random generator
      const spendingKey = randomFieldElement();

      // Derive nullifying key: Poseidon(spendingKey, 1)
      const nullifyingKey = poseidonHash([spendingKey, 1n]);

      // Derive master public key: Poseidon(spendingKey, nullifyingKey)
      const masterPublicKey = poseidonHash([spendingKey, nullifyingKey]);

      const newKeypair: OctopusKeypair = {
        spendingKey,
        nullifyingKey,
        masterPublicKey,
      };

      // Store in localStorage organized by wallet address and pool ID
      const identifier = getDefaultIdentifier(walletAddress);
      const toStore: StoredKeypair = {
        spendingKey: bigIntToHex(spendingKey),
        nullifyingKey: bigIntToHex(nullifyingKey),
        masterPublicKey: bigIntToHex(masterPublicKey),
        timestamp: Date.now(),
      };

      // Save to the list of keypairs
      saveKeypair(identifier, toStore);

      // Set as active keypair
      setActiveKeypair(identifier, toStore);

      // Update state
      setKeypair(newKeypair);
      setSavedKeypairs(getSavedKeypairs(identifier));

      return newKeypair;
    } catch (error) {
      console.error("Failed to generate keypair:", error);
      throw error;
    }
  }, [poseidonReady, walletAddress]);

  // Select an existing keypair
  const selectKeypair = useCallback(
    (masterPublicKey: string) => {
      if (!walletAddress) {
        return;
      }

      const identifier = getDefaultIdentifier(walletAddress);
      const saved = getSavedKeypairs(identifier);
      const selected = saved.find((kp) => kp.masterPublicKey === masterPublicKey);

      if (selected) {
        const keypairObj: OctopusKeypair = {
          spendingKey: hexToBigInt(selected.spendingKey),
          nullifyingKey: hexToBigInt(selected.nullifyingKey),
          masterPublicKey: hexToBigInt(selected.masterPublicKey),
        };

        setKeypair(keypairObj);
        setActiveKeypair(identifier, selected);
      }
    },
    [walletAddress]
  );

  // Clear active keypair (but keep it in saved list)
  const clearKeypair = useCallback(() => {
    if (!walletAddress) return;

    const identifier = getDefaultIdentifier(walletAddress);
    clearActiveKeypair(identifier);
    setKeypair(null);
  }, [walletAddress]);

  // Delete a keypair permanently from saved list
  const removeKeypair = useCallback(
    (masterPublicKey: string) => {
      if (!walletAddress) return;

      const identifier = getDefaultIdentifier(walletAddress);
      deleteKeypair(identifier, masterPublicKey);

      // If the removed keypair was active, clear it
      if (keypair && bigIntToHex(keypair.masterPublicKey) === masterPublicKey) {
        setKeypair(null);
        clearActiveKeypair(identifier);
      }

      // Update saved keypairs list
      setSavedKeypairs(getSavedKeypairs(identifier));
    },
    [walletAddress, keypair]
  );

  // Rename a keypair (set label)
  const renameKeypair = useCallback(
    (masterPublicKey: string, label: string) => {
      if (!walletAddress) return;

      const identifier = getDefaultIdentifier(walletAddress);
      updateKeypairLabel(identifier, masterPublicKey, label);
      setSavedKeypairs(getSavedKeypairs(identifier));
    },
    [walletAddress]
  );

  // Restore keypair from existing spending key
  const restoreKeypair = useCallback(async (spendingKeyHex: string) => {
    if (!poseidonReady) {
      throw new Error("Poseidon not ready");
    }

    if (!walletAddress) {
      throw new Error("Wallet not connected");
    }

    try {
      const { deriveKeypair } = await import("@june_zk/octopus-sdk");

      // Parse spending key from hex
      const spendingKey = hexToBigInt(spendingKeyHex);

      // Derive all keys from spending key
      const derived = deriveKeypair(spendingKey);

      const restoredKeypair: OctopusKeypair = {
        spendingKey: derived.spendingKey,
        nullifyingKey: derived.nullifyingKey,
        masterPublicKey: derived.masterPublicKey,
      };

      // Store in localStorage
      const identifier = getDefaultIdentifier(walletAddress);
      const toStore: StoredKeypair = {
        spendingKey: bigIntToHex(derived.spendingKey),
        nullifyingKey: bigIntToHex(derived.nullifyingKey),
        masterPublicKey: bigIntToHex(derived.masterPublicKey),
        timestamp: Date.now(),
      };

      // Save to the list of keypairs
      saveKeypair(identifier, toStore);

      // Set as active keypair
      setActiveKeypair(identifier, toStore);

      // Update state
      setKeypair(restoredKeypair);
      setSavedKeypairs(getSavedKeypairs(identifier));

      return restoredKeypair;
    } catch (error) {
      console.error("Failed to restore keypair:", error);
      throw error;
    }
  }, [poseidonReady, walletAddress]);

  return {
    keypair,
    isLoading,
    savedKeypairs,
    generateKeypair,
    selectKeypair,
    clearKeypair,
    removeKeypair,
    restoreKeypair,
    renameKeypair,
  };
}
