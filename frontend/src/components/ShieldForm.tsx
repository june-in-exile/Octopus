"use client";

import { useState } from "react";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import {
  cn,
  parseTokenAmount,
  formatTokenAmount,
  truncateAddress,
  getTokenIdFromCoinType
} from "@/lib/utils";
import type { TokenConfig } from "@/lib/constants";
import { initPoseidon } from "@/lib/poseidon";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import { NumberInput } from "@/components/NumberInput";
import {
  createNote,
  encryptNote,
  bigIntToLE32,
  deriveViewingPublicKey
} from "@june_zk/octopus-sdk";

interface ShieldFormProps {
  keypair: OctopusKeypair | null;
  tokenConfig: TokenConfig;
  balance: bigint | null;
  loading: boolean;
  onSuccess?: () => void | Promise<void>;
}

type ShieldState =
  | "idle"
  | "processing"
  | "submitting"
  | "success"
  | "error";

export function ShieldForm({
  keypair,
  tokenConfig,
  balance,
  loading,
  onSuccess,
}: ShieldFormProps) {
  const { packageId, network } = useNetworkConfig();
  const account = useCurrentAccount();
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<ShieldState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; txDigest?: string } | null>(null);
  
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const isProcessing = state !== "idle" && state !== "error" && state !== "success";

  const getProgressMessage = () => {
    switch (state) {
      case "processing":
        return "// Creating and encrypting note";
      case "submitting":
        return "// Awaiting wallet confirmation";
      default:
        return "";
    }
  };

  // Build coin argument for the shield transaction
  async function buildCoinArg(tx: Transaction, amountBase: bigint) {
    if (tokenConfig.type === "0x2::sui::SUI") {
      // SUI: split from gas coin
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountBase)]);
      return coin;
    }

    // Non-SUI: select from owned coins
    const coins = await client.getCoins({
      owner: account!.address,
      coinType: tokenConfig.type,
    });

    if (coins.data.length === 0) {
      throw new Error(`No ${tokenConfig.symbol} coins found in wallet`);
    }

    // Sort descending by balance
    const sorted = [...coins.data].sort(
      (a, b) => Number(BigInt(b.balance) - BigInt(a.balance))
    );

    const total = coins.data.reduce((sum, c) => sum + BigInt(c.balance), 0n);
    if (total < amountBase) {
      throw new Error(
        `Insufficient ${tokenConfig.symbol} balance: need ${formatTokenAmount(amountBase, tokenConfig.decimals)}, have ${formatTokenAmount(total, tokenConfig.decimals)}`
      );
    }

    const primaryCoinId = sorted[0].coinObjectId;
    if (BigInt(sorted[0].balance) >= amountBase) {
      // Single coin is enough
      const [coin] = tx.splitCoins(tx.object(primaryCoinId), [tx.pure.u64(amountBase)]);
      return coin;
    }

    // Merge coins first, then split
    const primaryCoin = tx.object(primaryCoinId);
    const otherCoins = sorted.slice(1).map((c) => tx.object(c.coinObjectId));
    tx.mergeCoins(primaryCoin, otherCoins);
    const [coin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountBase)]);
    return coin;
  }

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

    const numericAmount = parseFloat(amount);
    if (amount.trim() === "" || isNaN(numericAmount) || numericAmount <= 0) {
      setError("Please enter a valid amount");
      return;
    }

    const amountBase = parseTokenAmount(amount, tokenConfig.decimals);

    if (balance !== null && amountBase > balance) {
      setError(
        `Insufficient balance. You have ${formatTokenAmount(balance, tokenConfig.decimals)} ${tokenConfig.symbol} available.`
      );
      return;
    }

    try {
      // 1. Creating and encrypting note
      setState("processing");
      await initPoseidon();

      const tokenId = getTokenIdFromCoinType(tokenConfig.type);

      const note = createNote(keypair.masterPublicKey, tokenId, amountBase);

      const viewingPk = deriveViewingPublicKey(keypair.spendingKey);
      const encryptedNoteData = encryptNote(note, viewingPk);

      const commitmentBytes = bigIntToLE32(note.commitment);

      // 2. Building and submitting transaction
      setState("submitting");
      const tx = new Transaction();
      const coin = await buildCoinArg(tx, amountBase);

      tx.moveCall({
        target: `${packageId}::pool::shield`,
        typeArguments: [tokenConfig.type],
        arguments: [
          tx.object(tokenConfig.poolId),
          coin,
          tx.pure.vector("u8", Array.from(commitmentBytes)),
          tx.pure.vector("u8", Array.from(encryptedNoteData)),
        ],
      });

      const result = await signAndExecute({ transaction: tx });

      // 3. Success!
      setState("success");
      const successMessage = `Successfully shielded ${formatTokenAmount(amountBase, tokenConfig.decimals)} ${tokenConfig.symbol}!`;
      setSuccess({
        message: successMessage,
        txDigest: result.digest,
      });
      setAmount("");

      // 4. Trigger note rescan to pick up the change note
      await onSuccess?.();
    } catch (err) {
      console.error("Shield failed:", err);
      setState("error");
      setError(err instanceof Error ? err.message : "Shield failed");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label
              htmlFor="shield-amount"
              className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono"
            >
              Amount ({tokenConfig.symbol})
            </label>
            {account && (
              <span className="text-[10px] text-gray-500 font-mono">
                {loading ? (
                  "// Loading..."
                ) : balance !== null ? (
                  <>BAL: {formatTokenAmount(balance, tokenConfig.decimals)}</>
                ) : (
                  "// Unavailable"
                )}
              </span>
            )}
          </div>
          <NumberInput
            id="shield-amount"
            value={amount}
            onChange={setAmount}
            placeholder={`0.${"0".repeat(tokenConfig.decimals)}`}
            step={1 / 10 ** tokenConfig.decimals}
            min={0}
            disabled={isProcessing}
            onMax={balance !== null ? () => setAmount(formatTokenAmount(balance, tokenConfig.decimals)) : undefined}
          />
        </div>

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
                    {" "}
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
                {state === "processing" ? "Creating Note..." : "Submitting Transaction..."}
              </p>
              <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                {getProgressMessage()}
              </p>
            </div>
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
        style={{
          backgroundColor: "transparent",
          color: "#00d9ff",
          borderColor: "#00d9ff",
        }}
      >
        {isProcessing ? "◉ PROCESSING..." : "▲ SHIELD TOKENS"}
      </button>

      {/* Info Box - Hidden when success is shown */}
      {!success && (
        <div className="p-4 border border-gray-800 bg-black/30 clip-corner space-y-3">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-cyber-blue font-mono">
            Shield Process:
          </h4>
          <ol className="text-[10px] text-gray-400 space-y-1.5 list-decimal list-inside font-mono leading-relaxed">
            <li>Enter amount to shield</li>
            <li>Create private note with commitment</li>
            <li>Encrypt note for recovery</li>
            <li>Submit deposit transaction</li>
            <li>Note added to Merkle tree</li>
          </ol>
          <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />
          <p className="text-[10px] text-gray-500 font-mono">
            <span className="text-cyber-blue">◉</span> Privacy: Token amount and ownership hidden on-chain
          </p>
        </div>
      )}
    </form>
  );
}
