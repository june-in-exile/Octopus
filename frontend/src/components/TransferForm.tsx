"use client";

import { useState } from "react";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { cn, parseTokenAmount, formatTokenAmount, truncateAddress } from "@/lib/utils";
import type { TokenConfig } from "@/lib/constants";
import { fetchMerkleProofs } from "@/lib/merkleProofFetcher";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import { NumberInput } from "@/components/NumberInput";
import { RecipientInput } from "@/components/RecipientInput";
import {
  selectNotes,
  createTransferOutputs,
  generateTransferProof,
  convertTransferProofToSui,
  importViewingPublicKey,
  deriveViewingPublicKey,
  encryptNote,
  buildTransferTransaction,
  type RecipientProfile,
  type SelectableNote,
} from "@june_zk/octopus-sdk";

interface TransferFormProps {
  keypair: OctopusKeypair | null;
  tokenConfig: TokenConfig;
  maxAmount: bigint,
  notes: OwnedNote[];
  loading: boolean;
  onSuccess?: () => void | Promise<void>;
  markNoteSpent?: (nullifier: bigint) => void;
}

type TransferState =
  | "idle"
  | "fetching-merkle-proofs"
  | "generating-proof"
  | "submitting"
  | "success"
  | "error";

export function TransferForm({
  keypair,
  tokenConfig,
  maxAmount,
  notes,
  loading: notesLoading,
  onSuccess,
  markNoteSpent,
}: TransferFormProps) {
  const { packageId, network } = useNetworkConfig();
  const account = useCurrentAccount();
  const [recipientProfile, setRecipientProfile] = useState<RecipientProfile | null>(null);
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<TransferState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; txDigest?: string } | null>(null);
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

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

    if (!recipientProfile) {
      setError("Please enter valid recipient profile");
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      setError("Please enter a valid amount");
      return;
    }
    const amountMist = parseTokenAmount(amount, tokenConfig.decimals);

    try {
      // 1. Get unspent notes
      const unspentNotes = notes.filter((n: OwnedNote) => !n.spent);
      if (unspentNotes.length === 0) {
        setState("error");
        setError("No unspent notes available. Shield some tokens first!");
        return;
      }

      // 2. Select notes to cover amount
      const selectableNotes: SelectableNote[] = unspentNotes.map((n) => ({
        note: n.note,
        leafIndex: n.leafIndex,
        pathElements: n.pathElements,
      }))

      const selectedNotes = selectNotes(selectableNotes, amountMist);
      if (!selectedNotes || selectedNotes.length === 0) {
        setState("error");
        setError("Insufficient balance or unable to select appropriate notes!");
        return;
      }

      // Convert back to OwnedNote[]
      const selectedOwnedNotes = selectedNotes.map((selectedNote: SelectableNote) => {
        const ownedNote = unspentNotes.find((n) => n.leafIndex === selectedNote.leafIndex);
        if (!ownedNote) {
          throw new Error(`Could not find owned note for leafIndex ${selectedNote.leafIndex}`);
        }
        return ownedNote;
      });

      // 3. Fetch Merkle proofs for selected notes
      setState("fetching-merkle-proofs");
      const leafIndices = selectedOwnedNotes.map(n => n.leafIndex);

      const merkleProofs = await fetchMerkleProofs(
        keypair.spendingKey,
        tokenConfig.poolId,
        leafIndices
      );

      // Attach Merkle proofs to selected notes
      const notesWithProofs = selectedOwnedNotes.map(n => {
        const pathElements = merkleProofs.get(n.leafIndex);
        if (!pathElements || pathElements.length === 0) {
          throw new Error(`Failed to generate Merkle proof for note at leaf index ${n.leafIndex}`);
        }
        return { ...n, pathElements };
      });

      // 4. Mark notes as spent before generating proof
      selectedOwnedNotes.forEach((ownedNote) => {
        markNoteSpent?.(ownedNote.nullifier);
      });

      // 5. Create output notes (recipient + change)
      const inputTotal = notesWithProofs.reduce((sum: bigint, n: { note: { value: bigint } }) => sum + n.note.value, 0n);
      const noteToken = notesWithProofs[0].note.token; // Use actual token from selected note
      const [recipientNote, changeNote] = createTransferOutputs(
        recipientProfile.mpk,
        keypair.masterPublicKey,
        amountMist,
        inputTotal,
        noteToken
      );

      // 6. Generate ZK proof
      setState("generating-proof");
      const proof = await generateTransferProof({
        keypair,
        inputNotes: notesWithProofs.map((n) => n.note),
        inputLeafIndices: notesWithProofs.map((n) => n.leafIndex),
        inputPathElements: notesWithProofs.map((n) => n.pathElements!),
        recipientMpk: recipientProfile.mpk,
        outputNotes: [recipientNote, changeNote],
        token: notesWithProofs[0].note.token,
      });

      // 7. Convert proof to Sui format
      const suiProof = convertTransferProofToSui(proof.proof, proof.publicSignals);

      // 8. Encrypt output notes using viewing public keys
      const recipientViewingPk = typeof recipientProfile.viewingPublicKey === 'string'
        ? importViewingPublicKey(recipientProfile.viewingPublicKey)
        : recipientProfile.viewingPublicKey;
      const encryptedRecipientNote = encryptNote(recipientNote, recipientViewingPk);

      const myViewingPk = deriveViewingPublicKey(keypair.spendingKey);
      const encryptedChangeNote = encryptNote(changeNote, myViewingPk);

      // 9. Build and submit transaction
      setState("submitting");
      const tx = buildTransferTransaction(
        packageId!,
        tokenConfig.poolId,
        tokenConfig.type,
        suiProof,
        [encryptedRecipientNote, encryptedChangeNote]
      );

      const result = await signAndExecute({ transaction: tx });

      // 10. Success!
      setState("success");
      let successMessage = `Transferred ${amount} ${tokenConfig.symbol}!`;
      if (changeNote.value > 0n) {
        successMessage += ` (Change: ${formatTokenAmount(changeNote.value, tokenConfig.decimals)} ${tokenConfig.symbol})`;
      }
      setSuccess({
        message: successMessage,
        txDigest: result.digest
      });

      // Clear form inputs on success
      setRecipientProfile(null);
      setAmount("");

      // Trigger note rescan to pick up the change note
      await onSuccess?.();
    } catch (err) {
      console.error("Transfer failed:", err);
      setState("error");
      setError(err instanceof Error ? err.message : "Transfer failed");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-4">
        {/* Amount Input */}
        <div>
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
            Amount ({tokenConfig.symbol})
          </label>
          <NumberInput
            value={amount}
            onChange={setAmount}
            placeholder="0.000000000"
            step={0.000000001}
            min={0}
            disabled={state !== "idle" && state !== "error"}
          />
          <p className="mt-2 text-[10px] text-gray-500 font-mono">
            {notesLoading ? (
              <>LOADING NOTES...</>
            ) : notes.length > 0 ? (
              <>
                TOTAL: {formatTokenAmount(maxAmount, tokenConfig.decimals)}
                {notes.filter((n: OwnedNote) => !n.spent).length > 1 && (
                  <span className="text-gray-600">
                    {" "}// {notes.filter((n: OwnedNote) => !n.spent).length} NOTES
                  </span>
                )}
              </>
            ) : (
              <>NO NOTES // Shield tokens first</>
            )}
          </p>
        </div>

        {/* Recipient Profile Input */}
        <RecipientInput
          onRecipientChange={setRecipientProfile}
          disabled={state !== "idle" && state !== "error"}
        />

        {/* Note Selection Info */}
        <div className="p-3 border border-cyber-blue/30 bg-cyber-blue/10 clip-corner">
          <p className="text-[10px] text-gray-300 font-mono leading-relaxed">
            <span className="text-cyber-blue font-bold">AUTO SELECT:</span> SDK automatically selects notes to cover transfer amount
          </p>
        </div>
      </div>

      {/* Progress indicator */}
      {(state === "fetching-merkle-proofs" || state === "generating-proof" || state === "submitting") && (
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
                {state === "generating-proof"
                  ? "// Proof generation in progress (30-60s)"
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
            <p className="text-xs text-green-400 font-mono leading-relaxed">
              {success.message}
              {success.txDigest && (
                <>
                  {' '}
                  <a
                    href={`https://${network}.suivision.xyz/txblock/${success.txDigest}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyber-blue hover:text-cyber-blue/80 underline"
                    title={`View transaction: ${success.txDigest}`}
                  >
                    [{truncateAddress(success.txDigest, 6)}]
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={!account || !keypair || (state !== "idle" && state !== "error")}
        className={cn(
          "btn-primary w-full",
          (state !== "idle" && state !== "error") && "cursor-wait opacity-70"
        )}
        style={{
          backgroundColor: 'transparent',
          color: '#00d9ff',
          borderColor: '#00d9ff',
        }}
      >
        {(state !== "idle" && state !== "error") ? "◉ PROCESSING..." : "⇄ PRIVATE TRANSFER"}
      </button>

      {/* Info Box - Hidden when success is shown */}
      {!success && (
        <div className="p-4 border border-gray-800 bg-black/30 clip-corner space-y-3">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-cyber-blue font-mono">
            Transfer Process:
          </h4>
          <ol className="text-[10px] text-gray-400 space-y-1.5 list-decimal list-inside font-mono leading-relaxed">
            <li>Select notes (1-2 inputs)</li>
            <li>Create output notes (recipient + change)</li>
            <li>Generate Merkle proofs</li>
            <li>Calculate nullifiers (prevent double-spending)</li>
            <li>Generate ZK proof (30-60s)</li>
            <li>Submit private transaction</li>
          </ol>
          <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />
          <p className="text-[10px] text-gray-500 font-mono">
            <span className="text-cyber-blue">◉</span> Privacy: Sender, recipient, amount remain hidden on-chain
          </p>
        </div>
      )}
    </form>
  );
}
