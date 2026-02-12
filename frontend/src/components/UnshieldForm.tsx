"use client";

import { useState } from "react";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import {
  cn,
  parseTokenAmount,
  formatTokenAmount,
  truncateAddress,
} from "@/lib/utils";
import type { TokenConfig } from "@/lib/constants";
import { selectNotesWithProofs } from "@/lib/noteSelectionWithProofs";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import { NumberInput } from "@/components/NumberInput";
import {
  createUnshieldOutputs,
  generateUnshieldProof,
  deriveViewingPublicKey,
  encryptNote,
} from "@june_zk/octopus-sdk";

interface UnshieldFormProps {
  keypair: OctopusKeypair | null;
  tokenConfig: TokenConfig;
  maxAmount: bigint,
  notes: OwnedNote[];
  loading: boolean;
  onSuccess?: () => void | Promise<void>;
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
  loading: notesLoading,
  onSuccess,
}: UnshieldFormProps) {
  const { packageId, network } = useNetworkConfig();
  const account = useCurrentAccount();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<UnshieldState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; txDigest?: string } | null>(null);
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const isProcessing = state !== "idle" && state !== "error" && state !== "success";

  const getProgressMessage = () => {
    switch (state) {
      case "fetching-merkle-proofs":
        return "// Fetching Merkle proofs";
      case "generating-proof":
        return "// Proof generation in progress (30-60s)";
      case "submitting":
        return "// Awaiting wallet confirmation";
      default:
        return "";
    }
  };

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

    if (!recipient || !recipient.startsWith("0x")) {
      setError("Please enter a valid recipient address");
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      setError("Please enter a valid amount");
      return;
    }
    const amountBase = parseTokenAmount(amount, tokenConfig.decimals);

    try {
      // 1. Select notes and fetch proofs
      setState("fetching-merkle-proofs");
      const notesWithProofs = await selectNotesWithProofs(
        notes,
        amountBase,
        keypair,
        tokenConfig.poolId
      );

      // 2. Create output notes (change note)
      const inputTotal = notesWithProofs.reduce((sum: bigint, n: { note: { amount: bigint } }) => sum + n.note.amount, 0n);
      const noteToken = notesWithProofs[0].note.token; // Use actual token from selected note
      const outputNote = createUnshieldOutputs(
        keypair.masterPublicKey,
        amountBase,
        inputTotal,
        noteToken
      );

      // 3. Generate ZK proof (returns Sui format directly)
      setState("generating-proof");
      const proof = await generateUnshieldProof({
        keypair,
        inputNotes: notesWithProofs.map(n => n.note),
        inputLeafIndices: notesWithProofs.map(n => n.leafIndex),
        inputPathElements: notesWithProofs.map(n => n.pathElements!),
        unshieldAmount: amountBase,
        outputNote,
        token: notesWithProofs[0].note.token,
      });

      // 4. Encrypt output note using viewing public keys
      const viewingPk = deriveViewingPublicKey(keypair!.spendingKey);
      const encryptedChangeNote = encryptNote(outputNote, viewingPk)

      // 5. Build and submit transaction
      setState("submitting");
      const tx = new Transaction();

      tx.moveCall({
        target: `${packageId}::pool::unshield`,
        typeArguments: [tokenConfig.type],
        arguments: [
          tx.object(tokenConfig.poolId),
          tx.pure.vector("u8", Array.from(proof.proofBytes)),
          tx.pure.vector("u8", Array.from(proof.publicInputsBytes)),
          tx.pure.address(recipient),
          tx.pure.vector("u8", Array.from(encryptedChangeNote)),
        ],
      });

      const result = await signAndExecute({ transaction: tx });

      // 6. Success!
      setState("success");
      let successMessage = `Unshielded ${amount} ${tokenConfig.symbol}`;
      if (outputNote.amount > 0n) {
        successMessage += ` (Change: ${formatTokenAmount(outputNote.amount, tokenConfig.decimals)} ${tokenConfig.symbol})`;
      }
      setSuccess({
        message: successMessage,
        txDigest: result.digest
      });

      // Clear form inputs on success
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
                {getProgressMessage()}
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

      {/* Info Box - Hidden when success is shown */}
      {!success && (
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
      )}
    </form>
  );
}
