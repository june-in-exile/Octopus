"use client";

import { useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { cn, parseTokenAmount, formatTokenAmount, truncateAddress } from "@/lib/utils";
import type { TokenConfig } from "@/lib/constants";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import {
  generateUnshieldProof,
  convertUnshieldProofToSui,
  deriveViewingPublicKey,
  buildUnshieldTransaction,
  encryptNote,
  selectNotes,
  type SelectableNote,
} from "@june_zk/octopus-sdk";
import { NumberInput } from "@/components/NumberInput";
import { fetchMerkleProofs } from "@/lib/merkleProofFetcher";

interface UnshieldFormProps {
  keypair: OctopusKeypair | null;
  tokenConfig: TokenConfig;
  maxAmount: bigint;
  notes: OwnedNote[];
  onSuccess?: () => void | Promise<void>;
  markNoteSpent?: (nullifier: bigint) => void;
}

type UnshieldState =
  | "idle"
  | "fetching-merkle-proofs"
  | "generating-proof"
  | "submitting"
  | "success"
  | "error";

export function UnshieldForm({
  keypair,
  tokenConfig,
  maxAmount,
  notes,
  onSuccess,
  markNoteSpent,
}: UnshieldFormProps) {
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [state, setState] = useState<UnshieldState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; txDigests?: string[] } | null>(null);

  const { packageId, network } = useNetworkConfig();
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  // Auto-fill recipient with connected wallet
  const handleUseMyAddress = () => {
    if (account?.address) {
      setRecipient(account.address);
    }
  };


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!account) {
      setError("Please connect your wallet");
      return;
    }

    if (!keypair) {
      setError("Please generate a keypair first");
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      setError("Please enter a valid amount");
      return;
    }

    if (!recipient || !recipient.startsWith("0x")) {
      setError("Please enter a valid recipient address");
      return;
    }

    const amountMist = parseTokenAmount(amount, tokenConfig.decimals);
    if (amountMist > maxAmount) {
      setError("Insufficient shielded balance");
      return;
    }

    try {
      // Get unspent notes
      const unspentNotes = notes.filter((n: OwnedNote) => !n.spent);
      if (unspentNotes.length === 0) {
        throw new Error("No unspent notes available");
      }

      // Convert OwnedNote[] to SelectableNote[] format for SDK
      const selectableNotes: SelectableNote[] = unspentNotes.map(n => ({
        note: n.note,
        leafIndex: n.leafIndex,
        pathElements: n.pathElements
      }));

      // Select notes using SDK's optimized strategy (supports 1-2 notes)
      const selected = selectNotes(selectableNotes, amountMist);

      if (selected.length > 2) {
        throw new Error("SDK optimization allows max 2 notes per unshield. Please use a smaller amount.");
      }

      // Convert back to OwnedNote[]
      const selectedNotes = selected.map((s: SelectableNote) =>
        unspentNotes.find(n => n.leafIndex === s.leafIndex)!
      );

      // Fetch Merkle proofs for all selected notes
      setState("fetching-merkle-proofs");
      const leafIndices = selectedNotes.map(n => n.leafIndex);

      let merkleProofs: Map<number, bigint[]>;
      try {
        merkleProofs = await fetchMerkleProofs(
          keypair!.spendingKey,
          tokenConfig.poolId,
          leafIndices
        );
      } catch (err) {
        // If stale cache detected, automatically trigger rescan
        if (err instanceof Error && err.message.includes("Stale cache detected")) {
          console.log("[UnshieldForm] Stale cache detected. Triggering automatic rescan...");

          // Trigger rescan in background
          const rescanPromise = onSuccess?.();
          if (rescanPromise) {
            rescanPromise.catch(console.error);
          }

          // Throw clear error to user
          throw new Error(
            "Your notes are outdated. Refreshing your notes... Please wait for the refresh to complete and try again."
          );
        }
        throw err;
      }

      // Build note array with proofs
      const notesWithProofs = selectedNotes.map(n => {
        const pathElements = merkleProofs.get(n.leafIndex);
        if (!pathElements || pathElements.length === 0) {
          throw new Error(`Failed to generate Merkle proof for note at leaf index ${n.leafIndex}`);
        }
        return { ...n, pathElements };
      });

      // Generate single proof for all notes (1 or 2)
      setState("generating-proof");
      const { proof, publicSignals, changeNote } = await generateUnshieldProof({
        inputNotes: notesWithProofs.map(n => n.note),
        leafIndices: notesWithProofs.map(n => n.leafIndex),
        inputPathElements: notesWithProofs.map(n => n.pathElements!),
        keypair: keypair!,
        unshieldValue: amountMist,
      });

      // Submit single transaction
      setState("submitting");
      const viewingPk = deriveViewingPublicKey(keypair!.spendingKey);
      const suiProof = convertUnshieldProofToSui(proof, publicSignals);
      const encryptedChangeNote = changeNote
        ? encryptNote(changeNote, viewingPk)
        : new Uint8Array(0);

      const tx = buildUnshieldTransaction(
        packageId!,
        tokenConfig.poolId,
        tokenConfig.type,
        suiProof,
        recipient,
        encryptedChangeNote
      );

      const result = await signAndExecute({ transaction: tx });

      // Mark all notes spent optimistically
      selectedNotes.forEach(n => markNoteSpent?.(n.nullifier));

      setState("success");

      // Build success message
      const changeValue = changeNote ? changeNote.value : 0n;
      let successMessage = `Successfully unshielded ${formatTokenAmount(amountMist, tokenConfig.decimals)} ${tokenConfig.symbol}`;
      if (changeValue > 0n) {
        successMessage += ` (Change: ${formatTokenAmount(changeValue, tokenConfig.decimals)} ${tokenConfig.symbol})`;
      }

      setSuccess({
        message: successMessage,
        txDigests: [result.digest]
      });
      setAmount("");
      setRecipient("");

      // Trigger note rescan to pick up the change note
      await onSuccess?.();
    } catch (err) {
      console.error("Unshield failed:", err);
      setState("error");
      setError(err instanceof Error ? err.message : "Unshield failed");
    }
  };

  const isProcessing = state === "fetching-merkle-proofs" || state === "generating-proof" || state === "submitting";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-4">
        <div>
          <label
            htmlFor="unshield-amount"
            className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400 font-mono"
          >
            Amount ({tokenConfig.symbol})
          </label>
          <NumberInput
            id="unshield-amount"
            value={amount}
            onChange={setAmount}
            placeholder="0.000000000"
            step={0.000000001}
            min={0}
            disabled={isProcessing}
          />
          <p className="mt-2 text-[10px] text-gray-500 font-mono">
            {notes.length > 0 ? (
              <>
                TOTAL: {formatTokenAmount(maxAmount, tokenConfig.decimals)}
                {notes.filter((n: OwnedNote) => !n.spent).length > 1 && (
                  <span className="text-gray-600">
                    {" "}// {notes.filter((n: OwnedNote) => !n.spent).length} NOTES
                  </span>
                )}
              </>
            ) : (
              <>MAX: {formatTokenAmount(maxAmount, tokenConfig.decimals)}</>
            )}
          </p>
        </div>

        <div>
          <label
            htmlFor="recipient"
            className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400 font-mono"
          >
            Recipient Address
          </label>
          <div className="flex gap-2">
            <input
              id="recipient"
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="0x..."
              className="input flex-1"
              disabled={isProcessing}
            />
            <button
              type="button"
              onClick={handleUseMyAddress}
              className="btn-secondary whitespace-nowrap text-xs"
              disabled={!account || isProcessing}
            >
              MY ADDR
            </button>
          </div>
        </div>
      </div>

      {/* Progress indicator */}
      {isProcessing && (
        <div className="p-4 border border-cyber-blue/30 bg-cyber-blue/10 clip-corner">
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 animate-spin text-cyber-blue"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <div>
              <p className="font-bold text-cyber-blue text-xs uppercase tracking-wider">
                {state === "fetching-merkle-proofs"
                  ? "Building Merkle Tree..."
                  : state === "generating-proof"
                    ? "Generating ZK Proof..."
                    : "Submitting Transaction..."}
              </p>
              <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                {state === "fetching-merkle-proofs"
                  ? "// Fetching Merkle proofs"
                  : state === "generating-proof"
                    ? "// Single transaction for 1-2 notes (20-60s)"
                    : "// Awaiting wallet confirmation"}
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 border border-red-600/30 bg-red-900/20 clip-corner">
          <div className="flex items-start gap-2">
            <span className="text-red-500 text-sm">✕</span>
            <p className="text-xs text-red-400 font-mono leading-relaxed">{error}</p>
          </div>
        </div>
      )}

      {success && (
        <div className="p-3 border border-green-600/30 bg-green-900/20 clip-corner">
          <div className="flex items-start gap-2">
            <span className="text-green-500 text-sm">✓</span>
            <div className="text-xs text-green-400 font-mono leading-relaxed">
              <p>{success.message}</p>
              {success.txDigests && success.txDigests.length > 0 && (
                <p className="mt-1">
                  {success.txDigests.length === 1 ? (
                    <>
                      TX:{' '}
                      <a
                        href={`https://${network}.suivision.xyz/txblock/${success.txDigests[0]}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyber-blue hover:text-cyber-blue/80 underline"
                      >
                        [{truncateAddress(success.txDigests[0], 6)}]
                      </a>
                    </>
                  ) : (
                    <>
                      TXs:{' '}
                      {success.txDigests.map((digest, i) => (
                        <span key={digest}>
                          {i > 0 && ', '}
                          <a
                            href={`https://${network}.suivision.xyz/txblock/${digest}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyber-blue hover:text-cyber-blue/80 underline"
                          >
                            [{i + 1}]
                          </a>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={!account || !keypair || isProcessing || maxAmount === 0n}
        className={cn(
          "btn-primary w-full",
          isProcessing && "cursor-wait opacity-70"
        )}
        style={{
          backgroundColor: 'transparent',
          color: '#00d9ff',
          borderColor: '#00d9ff',
        }}
      >
        {isProcessing ? "◉ PROCESSING..." : "▼ UNSHIELD TOKENS"}
      </button>

      {/* Info Box */}
      <div className="p-4 border border-gray-800 bg-black/30 clip-corner space-y-3">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-cyber-blue font-mono">
          Unshield Process:
        </h4>
        <ol className="text-[10px] text-gray-400 space-y-1.5 list-decimal list-inside font-mono leading-relaxed">
          <li>Select note(s) to spend (1-2 notes)</li>
          <li>Generate Merkle proof for each note</li>
          <li>Calculate nullifiers (prevent double-spending)</li>
          <li>Compute change note (if amount &lt; total value)</li>
          <li>Generate ZK proof (single transaction for 1-2 notes)</li>
          <li>Submit transaction</li>
          <li>Tokens sent to recipient + change note created</li>
        </ol>
        <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />
        <div className="space-y-1">
          <p className="text-[10px] text-gray-500 font-mono">
            <span className="text-cyber-blue">◉</span> Privacy: Note details remain hidden, only nullifier revealed
          </p>
        </div>
      </div>
    </form>
  );
}
