"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSuiClient } from "@mysten/dapp-kit";
import type { OctopusKeypair } from "./useLocalKeypair";
import type { Note } from "@june_zk/octopus-sdk";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import { bigIntToLE32 } from "@june_zk/octopus-sdk";
import { getWorkerManager } from "@/lib/workerManager";
import { generateCacheKey } from "@/lib/notesCache";
import { getTokenIdFromCoinType } from "@/lib/utils";

/**
 * Owned note with metadata for selection and spending
 */
export interface OwnedNote {
  /** The note itself */
  note: Note;
  /** Position in the Merkle tree */
  leafIndex: number;
  /** Merkle proof path elements (fetched lazily when needed) */
  pathElements?: bigint[];
  /** Computed nullifier for double-spend checking */
  nullifier: bigint;
  /** Whether this note has been spent */
  spent: boolean;
  /** Transaction digest where this note was created */
  txDigest: string;
  /** Actual amount received from DeepBook (swap output notes only).
   *  Use this for display. note.amount holds min_amount_out (for proof generation). */
  displayAmount?: bigint;
}

/**
 * Hook to scan blockchain events and track user's owned notes.
 *
 * Scans:
 * - ShieldEvents: Public → Private deposits
 * - TransferEvents: Private → Private transfers
 *
 * For each event, attempts to decrypt the note using the user's MPK.
 * If successful, the note belongs to this user.
 *
 * @param keypair - The Octopus keypair to scan notes for
 * @param isInitializing - Whether the keypair is still being initialized (Poseidon, etc.)
 * @returns Notes, loading state, and helper functions
 */

export function useNotes(
  keypair: OctopusKeypair | null,
  isInitializing = false,
  poolId: string = "",
  tokenType: string = ""
) {
  const client = useSuiClient();
  const { originalPackageId, graphqlUrl } = useNetworkConfig();
  const [notes, setNotes] = useState<OwnedNote[]>([]);
  const [notesPoolId, setNotesPoolId] = useState<string>(""); // Track which pool the current notes are from
  const [loading, setLoading] = useState(true);  // Start with loading=true to avoid showing balance=0 before first scan
  const [error, setError] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [lastScanStats, setLastScanStats] = useState<{
    eventsScanned: number;
    notesDecrypted: number;
    timestamp: number;
  } | null>(null);
  // Track current keypair and poolId to detect changes
  const currentKeypairRef = useRef<bigint | null>(null);
  const currentPoolIdRef = useRef<string | null>(null);
  // Track if a scan is currently in progress to prevent concurrent scans
  const isScanningRef = useRef(false);
  // Track previous refreshTrigger to detect manual refresh button clicks
  const prevRefreshTrigger = useRef(refreshTrigger);
  // Track whether next refresh should force full cache clear (used after operations)
  const [shouldClearCache, setShouldClearCache] = useState(false);

  // Manual refresh function (incremental scan with cache)
  const refresh = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  // Force full refresh (clear cache, used after operations)
  const forceFullRefresh = () => {
    setShouldClearCache(true);
    setRefreshTrigger((prev) => prev + 1);
  };

  // Batch check multiple nullifiers for spent status (more efficient than one-by-one)
  const batchCheckNullifierStatus = useCallback(
    async (nullifiers: bigint[], pid: string): Promise<Map<string, boolean>> => {
      if (nullifiers.length === 0) return new Map();

      try {
        // Get nullifier registry ID (only query once)
        const poolObject = await client.getObject({
          id: pid,
          options: { showContent: true },
        });

        if (
          poolObject.data?.content?.dataType !== "moveObject" ||
          !poolObject.data.content.fields
        ) {
          return new Map();
        }

        const fields = poolObject.data.content.fields as any;
        const nullifierRegistryId = fields.nullifiers.fields.id.id;

        // OPTIMIZATION: Batch query (increased from 10 to 50 for better performance)
        const batchSize = 50;
        const spentMap = new Map<string, boolean>();

        for (let i = 0; i < nullifiers.length; i += batchSize) {
          const batch = nullifiers.slice(i, i + batchSize);
          const results = await Promise.allSettled(
            batch.map((nullifier) =>
              client.getDynamicFieldObject({
                parentId: nullifierRegistryId,
                name: {
                  type: "vector<u8>",
                  value: Array.from(bigIntToLE32(nullifier)),
                },
              })
            )
          );

          batch.forEach((nullifier, idx) => {
            const result = results[idx];
            const spent =
              result.status === "fulfilled" &&
              result.value.data !== null &&
              result.value.data !== undefined;
            spentMap.set(nullifier.toString(), spent);
          });
        }

        return spentMap;
      } catch (err) {
        return new Map();
      }
    },
    [client]
  );

  useEffect(() => {
    if (!keypair) {
      setNotes([]);

      // Only set loading=false if we're not still initializing
      // This prevents showing "0 SUI" while Poseidon/keypair are still loading
      if (!isInitializing) {
        setLoading(false);
      }
      // If still initializing, keep loading=true to show loading state

      currentKeypairRef.current = null;
      return;
    }

    // Check if keypair or pool changed
    const previousMPK = currentKeypairRef.current;
    const keypairChanged = previousMPK !== null && previousMPK !== keypair.masterPublicKey;
    const poolChanged = currentPoolIdRef.current !== null && currentPoolIdRef.current !== poolId;

    if (keypairChanged || poolChanged) {
      setNotes([]);
      setNotesPoolId(""); // Clear pool ID tracking
    }

    currentKeypairRef.current = keypair.masterPublicKey;
    currentPoolIdRef.current = poolId;

    // Determine if this is a manual refresh button click
    const isManualRefresh = refreshTrigger !== prevRefreshTrigger.current;
    prevRefreshTrigger.current = refreshTrigger;

    let isCancelled = false;

    async function scanNotesWithWorker() {
      if (!keypair) return; // TypeScript null check

      // Prevent concurrent scans - if already scanning, skip
      if (isScanningRef.current) {
        return;
      }

      isScanningRef.current = true;
      setLoading(true);
      setError(null);

      // Ensure loading state is visible for at least 500ms
      const startTime = Date.now();

      try {
        const worker = getWorkerManager();

        // Determine if we should clear cache:
        // 1. Page load or keypair change → always clear
        // 2. Manual refresh with shouldClearCache flag → clear (e.g., after operations)
        // 3. Regular manual refresh → incremental scan with cache
        const needsCacheClear = !isManualRefresh || shouldClearCache;

        if (needsCacheClear && keypair) {
          const cacheKey = await generateCacheKey(keypair.spendingKey.toString());
          if (poolId) {
            await worker.clearCache(cacheKey, poolId);
          }
          // Reset the flag after clearing
          if (shouldClearCache) {
            setShouldClearCache(false);
          }
        }

        // Scan notes using Worker (GraphQL + decrypt + Merkle tree in background)
        const result = await worker.scanNotes(
          graphqlUrl ?? "https://graphql.testnet.sui.io/graphql",
          originalPackageId ?? "",
          poolId,
          keypair.spendingKey,
          keypair.nullifyingKey,
          keypair.masterPublicKey,
          {
            onProgress: (progress) => {
              // Extract scan stats from the final progress message
              if (progress.current === 60) {
                const match = progress.message.match(/Scanned (\d+) events.*Decrypted (\d+) notes/);
                if (match) {
                  setLastScanStats({
                    eventsScanned: parseInt(match[1]),
                    notesDecrypted: parseInt(match[2]),
                    timestamp: Date.now(),
                  });
                }
              }
            },
          }
        );

        if (isCancelled) return;

        // Collect all nullifiers for batch checking
        const nullifiers = result.notes.map((s) => s.nullifier);

        // Batch check spent status (more efficient than one-by-one)
        const spentMap = await batchCheckNullifierStatus(nullifiers, poolId);

        // Build OwnedNote array with spent status from batch query
        const newOwnedNotes: OwnedNote[] = [];
        for (const scanned of result.notes) {
          try {
            // Validate note data before deserialization
            if (!scanned.note ||
              scanned.note.nsk === undefined ||
              scanned.note.token === undefined ||
              scanned.note.amount === undefined ||
              scanned.note.random === undefined ||
              scanned.note.commitment === undefined) {
              console.error("Invalid note data (undefined):", scanned);
              continue;
            }

            // Check for invalid string values ("NaN", "undefined", empty strings)
            if (scanned.note.nsk === "NaN" || scanned.note.nsk === "undefined" || scanned.note.nsk === "" ||
              scanned.note.token === "NaN" || scanned.note.token === "undefined" || scanned.note.token === "" ||
              scanned.note.amount === "NaN" || scanned.note.amount === "undefined" || scanned.note.amount === "" ||
              scanned.note.random === "NaN" || scanned.note.random === "undefined" || scanned.note.random === "" ||
              scanned.note.commitment === "NaN" || scanned.note.commitment === "undefined" || scanned.note.commitment === "") {
              console.error("Invalid note data (NaN or empty string):", scanned);
              continue;
            }

            // Deserialize note with validation
            const note: Note = {
              nsk: BigInt(scanned.note.nsk),
              token: BigInt(scanned.note.token),
              amount: BigInt(scanned.note.amount),
              random: BigInt(scanned.note.random),
              commitment: BigInt(scanned.note.commitment),
            };

            // Get spent status from batch query result
            const spent = spentMap.get(scanned.nullifier.toString()) ?? false;

            const ownedNote = {
              note,
              leafIndex: scanned.leafIndex,
              nullifier: scanned.nullifier,
              pathElements: scanned.pathElements,
              spent,
              txDigest: scanned.txDigest,
              displayAmount: (scanned as any).displayAmount !== undefined
                ? BigInt((scanned as any).displayAmount)
                : undefined,
            };

            newOwnedNotes.push(ownedNote);
          } catch (err) {
            console.error("Failed to deserialize note:", scanned, err);
            // Skip this note and continue with others
            continue;
          }
        }

        if (!isCancelled) {
          // PHASE 2 FIX: Merge new notes with existing notes for incremental scanning
          // Only merge existing notes if this is the SAME keypair (not a fresh scan)
          // We use the saved keypairChanged flag from the start of useEffect
          const shouldMergeExisting = !keypairChanged;

          const notesMap = new Map<number, OwnedNote>();

          // Only merge existing notes if keypair hasn't changed
          if (shouldMergeExisting) {
            for (const existingNote of notes) {
              notesMap.set(existingNote.leafIndex, existingNote);
            }
          }

          // Add/update with new notes (new notes take precedence)
          for (const newNote of newOwnedNotes) {
            notesMap.set(newNote.leafIndex, newNote);
          }

          // Convert back to array and sort by leafIndex
          const mergedNotes = Array.from(notesMap.values()).sort(
            (a, b) => a.leafIndex - b.leafIndex
          );

          setNotes(mergedNotes);
          // Mark which pool these notes are from
          setNotesPoolId(poolId);
        }
      } catch (err) {
        if (!isCancelled) {
          setError(err instanceof Error ? err.message : "Failed to scan notes");
        }
      } finally {
        // Ensure minimum loading duration for better UX
        const elapsed = Date.now() - startTime;
        const minLoadingDuration = 500; // 500ms minimum

        if (elapsed < minLoadingDuration) {
          await new Promise(resolve => setTimeout(resolve, minLoadingDuration - elapsed));
        }

        if (!isCancelled) {
          setLoading(false);
        }

        // Reset scanning flag to allow future scans
        isScanningRef.current = false;
      }
    }

    scanNotesWithWorker();

    return () => {
      isCancelled = true;
      // Reset scanning flag when effect is cleaned up
      isScanningRef.current = false;
    };
  }, [keypair?.masterPublicKey, poolId, client, refreshTrigger, isInitializing, shouldClearCache, batchCheckNullifierStatus]);

  // Periodic reconciliation: re-check unspent notes to catch missed events
  useEffect(() => {
    if (!keypair || notes.length === 0) return;

    // Capture current keypair MPK to ensure we only update if keypair hasn't changed
    const currentMPK = keypair.masterPublicKey;

    const intervalId = setInterval(async () => {
      // Safety check: only reconcile if we're still on the same keypair
      if (currentKeypairRef.current !== currentMPK) {
        return;
      }

      // Only check notes marked as unspent
      const unspentNotes = notes.filter((n) => !n.spent);
      if (unspentNotes.length === 0) return;

      const nullifiers = unspentNotes.map((n) => n.nullifier);
      const spentMap = await batchCheckNullifierStatus(nullifiers, poolId);

      // Check if any status changed
      let hasChanges = false;
      const updatedNotes = notes.map((note) => {
        if (!note.spent) {
          const nowSpent = spentMap.get(note.nullifier.toString()) ?? false;
          if (nowSpent) {
            hasChanges = true;
            return { ...note, spent: true };
          }
        }
        return note;
      });

      if (hasChanges) {
        // Double-check keypair hasn't changed before updating
        if (currentKeypairRef.current === currentMPK) {
          setNotes(updatedNotes);
        }
      }
    }, 30000); // Every 30 seconds

    return () => clearInterval(intervalId);
  }, [keypair, notes, batchCheckNullifierStatus]);

  // Compute expected token ID for this token type
  const expectedTokenId = useMemo(() => {
    if (!tokenType) return null;
    try {
      return getTokenIdFromCoinType(tokenType);
    } catch (err) {
      return null;
    }
  }, [tokenType]);

  // Filter by pool ID AND token type
  const filteredNotes = useMemo(() => {
    // Must match pool ID
    if (notesPoolId !== poolId) {
      return [];
    }

    // If token type specified, also filter by token field
    if (expectedTokenId !== null) {
      return notes.filter(n => n.note.token === expectedTokenId);
    }

    // No token filter specified, return all notes from this pool
    return notes;
  }, [notesPoolId, poolId, notes, expectedTokenId]);
  
  return {
    notes: filteredNotes,
    loading,
    error,
    refresh,
    forceFullRefresh,
    lastScanStats,
  };
}

