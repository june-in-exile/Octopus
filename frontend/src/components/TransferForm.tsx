"use client";

import { useState, useCallback } from "react";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import {
  cn,
  parseTokenAmount,
  formatTokenAmount,
  truncateAddress,
} from "@/lib/utils";
import type { TokenConfig } from "@/lib/constants";
import { selectNotesWithProofs } from "@/lib/noteSelection";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import { NumberInput } from "@/components/NumberInput";
import { NoteBalanceDisplay } from "@/components/NoteBalanceDisplay";
import { RecipientInput } from "@/components/RecipientInput";
import { RelayerSelector, type RelayerStatus } from "@/components/RelayerSelector";
import {
  createTransferOutputs,
  generateTransferProof,
  importViewingPublicKey,
  deriveViewingPublicKey,
  encryptNote,
  RelayerClient,
  type RecipientProfile,
} from "@june_zk/octopus-sdk";

interface TransferFormProps {
  keypair: OctopusKeypair | null;
  tokenConfig: TokenConfig;
  maxAmount: bigint,
  notes: OwnedNote[];
  loading: boolean;
  onSuccess?: () => void | Promise<void>;
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
}: TransferFormProps) {
  const { packageId, network } = useNetworkConfig();
  const account = useCurrentAccount();
  const [recipientProfile, setRecipientProfile] = useState<RecipientProfile | null>(null);
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<TransferState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; txDigest?: string } | null>(null);
  const [useRelayer, setUseRelayer] = useState(false);
  const [relayerUrl, setRelayerUrl] = useState<string | null>(null);
  const [relayerStatus, setRelayerStatus] = useState<RelayerStatus>("idle");

  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const isProcessing = state !== "idle" && state !== "error" && state !== "success";

  const getProgressMessage = () => {
    switch (state) {
      case "fetching-merkle-proofs":
        return "// Fetching Merkle proofs";
      case "generating-proof":
        return "// Proof generation in progress (30-60s)";
      case "submitting":
        return useRelayer ? "// Sending to relayer" : "// Awaiting wallet confirmation";
      default:
        return "";
    }
  };

  const handleRelayerToggle = useCallback((enabled: boolean, url: string | null, status: RelayerStatus) => {
    setUseRelayer(enabled);
    setRelayerUrl(url);
    setRelayerStatus(status);
  }, []);

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
    const amountBase = parseTokenAmount(amount, tokenConfig.decimals);

    if (useRelayer && relayerStatus !== "online") {
      setError("Relayer is offline. Please check the relayer connection.");
      return;
    }

    const relayerClient = useRelayer && relayerUrl
      ? new RelayerClient({ url: relayerUrl, network: network as "mainnet" | "testnet" })
      : null;

    try {
      // 1. Select notes and fetch proofs
      setState("fetching-merkle-proofs");
      const notesWithProofs = await selectNotesWithProofs(
        notes,
        amountBase,
        keypair,
        tokenConfig.poolId
      );

      // 2. Create output notes (recipient + change)
      const inputTotal = notesWithProofs.reduce((sum: bigint, n: { note: { amount: bigint } }) => sum + n.note.amount, 0n);
      const token = notesWithProofs[0].note.token;
      const [recipientNote, changeNote] = createTransferOutputs(
        recipientProfile.mpk,
        keypair.masterPublicKey,
        amountBase,
        inputTotal,
        token
      );

      // 3. Generate ZK proof
      setState("generating-proof");
      const { proof, nullifiers } = await generateTransferProof({
        keypair,
        inputNotes: notesWithProofs.map((n) => n.note),
        inputLeafIndices: notesWithProofs.map((n) => n.leafIndex),
        inputPathElements: notesWithProofs.map((n) => n.pathElements!),
        recipientMpk: recipientProfile.mpk,
        recipientNote,
        changeNote,
        token: notesWithProofs[0].note.token,
      });

      // 4. Encrypt output notes using viewing public keys
      const recipientViewingPk = typeof recipientProfile.viewingPublicKey === 'string'
        ? importViewingPublicKey(recipientProfile.viewingPublicKey)
        : recipientProfile.viewingPublicKey;
      const encryptedRecipientNote = encryptNote(recipientNote, recipientViewingPk);

      const myViewingPk = deriveViewingPublicKey(keypair.spendingKey);
      const encryptedChangeNote = encryptNote(changeNote, myViewingPk);

      // 5. Submit via relayer or direct wallet
      setState("submitting");
      let txDigest: string;

      if (relayerClient) {
        txDigest = await relayerClient.submitTransfer({
          poolId: tokenConfig.poolId,
          tokenType: tokenConfig.type,
          proofBytes: proof.proofBytes,
          publicInputsBytes: proof.publicInputsBytes,
          nullifiers,
          encryptedNotes: [encryptedRecipientNote, encryptedChangeNote],
        });
      } else {
        const tx = new Transaction();
        tx.moveCall({
          target: `${packageId}::pool::transfer`,
          typeArguments: [tokenConfig.type],
          arguments: [
            tx.object(tokenConfig.poolId),
            tx.pure.vector("u8", Array.from(proof.proofBytes)),
            tx.pure.vector("u8", Array.from(proof.publicInputsBytes)),
            tx.pure(nullifiers),
            tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize([encryptedRecipientNote, encryptedChangeNote]).toBytes()),
          ],
        });
        const result = await signAndExecute({ transaction: tx });
        txDigest = result.digest;
      }

      // 6. Success!
      setState("success");
      let successMessage = `Transferred ${amount} ${tokenConfig.symbol}`;
      if (changeNote.amount > 0n) {
        successMessage += ` (Change: ${formatTokenAmount(changeNote.amount, tokenConfig.decimals)} ${tokenConfig.symbol})`;
      }
      setSuccess({
        message: successMessage,
        txDigest,
      });
      setRecipientProfile(null);
      setAmount("");

      // 7. Trigger note rescan to pick up the change note
      await onSuccess?.();
    } catch (err) {
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
            disabled={isProcessing}
            onMax={() => setAmount((Number(maxAmount) / 10 ** tokenConfig.decimals).toFixed(tokenConfig.decimals))}
          />
          <NoteBalanceDisplay
            loading={notesLoading}
            noteCount={notes.filter((n) => !n.spent).length}
            total={maxAmount}
            decimals={tokenConfig.decimals}
            tokenSymbol={tokenConfig.symbol}
          />
        </div>

        {/* Recipient Profile Input */}
        <RecipientInput
          onRecipientChange={setRecipientProfile}
          disabled={isProcessing}
        />

        {/* Relayer Selector */}
        <RelayerSelector
          network={network}
          disabled={isProcessing}
          onToggle={handleRelayerToggle}
        />
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
        disabled={!account || !keypair || isProcessing}
        className={cn(
          "btn-primary w-full",
          isProcessing && "cursor-wait opacity-70"
        )}
      >
        {isProcessing ? "◉ PROCESSING..." : "⇄ PRIVATE TRANSFER"}
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
