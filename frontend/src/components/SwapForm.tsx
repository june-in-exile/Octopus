"use client";

import { useState, useEffect } from "react";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
  useSuiClientContext,
  useSuiClientQuery,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import {
  cn,
  parseTokenAmount,
  formatSui,
  getTokenIdFromCoinType,
  formatTokenAmount,
  truncateAddress,
} from "@/lib/utils";
import {
  NETWORK_CONFIG,
  CLOCK_OBJECT_ID,
  ESTIMATED_DEEP_FEE,
} from "@/lib/constants";
import { selectNotesWithProofs } from "@/lib/noteSelectionWithProofs";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import { NumberInput } from "@/components/NumberInput";
import {
  createSwapOutputs,
  generateSwapProof,
  estimateDeepBookSwap,
  encryptNote,
  deriveViewingPublicKey,
} from "@june_zk/octopus-sdk";

interface SwapFormProps {
  keypair: OctopusKeypair | null;
  notes: OwnedNote[];
  loading: boolean;
  selectedToken?: "SUI" | "USDC" | "DBUSDC";
  onSuccess?: () => void | Promise<void>;
}

type SwapState =
  | "idle"
  | "fetching-merkle-proofs"
  | "generating-proof"
  | "submitting"
  | "success"
  | "error";

export function SwapForm({
  keypair,
  notes,
  loading: notesLoading,
  selectedToken,
  onSuccess,
}: SwapFormProps) {
  const { packageId, tokens: tokenConfig } = useNetworkConfig();
  const account = useCurrentAccount();

  const { network } = useSuiClientContext();
  const isMainnet = network === "mainnet";

  // Determine available tokens based on network
  const availableTokens = isMainnet ? ["SUI", "USDC"] as const : ["SUI", "DBUSDC"] as const;
  const defaultTokenOut = isMainnet ? "USDC" : "DBUSDC";

  const [tokenInSymbol, setTokenInSymbol] = useState<"SUI" | "USDC" | "DBUSDC">(selectedToken ?? "SUI");
  const [tokenOutSymbol, setTokenOutSymbol] = useState<"SUI" | "USDC" | "DBUSDC">(
    selectedToken && selectedToken !== "SUI" ? "SUI" : defaultTokenOut
  );

  useEffect(() => {
    if (!selectedToken) return;
    setTokenInSymbol(selectedToken);
    setTokenOutSymbol(selectedToken === "SUI" ? defaultTokenOut : "SUI");
  }, [selectedToken]);
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  const [slippage, setSlippage] = useState(50); // 0.5% in bps
  const [isEstimating, setIsEstimating] = useState(false);
  const [state, setState] = useState<SwapState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; txDigest?: string } | null>(null);
  const [priceImpact, setPriceImpact] = useState<number>(0);
  const [estimationWarning, setEstimationWarning] = useState<string | null>(null);
  const [selectedDeepCoin, setSelectedDeepCoin] = useState<string | null>(null);

  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const isProcessing = state !== "idle" && state !== "error" && state !== "success";

  const getProgressMessage = () => {
    switch (state) {
      case "fetching-merkle-proofs":
        return "// Building Merkle proofs";
      case "generating-proof":
        return "// Proof generation in progress (30-60s)";
      case "submitting":
        return "// Awaiting wallet confirmation";
      default:
        return "";
    }
  };

  // Query DEEP tokens (only in production mode)
  const { data: deepBalance } = useSuiClientQuery(
    "getCoins",
    {
      owner: account?.address ?? "",
      coinType: NETWORK_CONFIG[network === "mainnet" ? 'mainnet' : 'testnet'].deepCoinType,
    },
    {
      enabled: !!account?.address,
    }
  );

  // Auto-select DEEP coin with sufficient balance
  useEffect(() => {
    if (deepBalance?.data) {
      const adequateCoin = deepBalance.data.find(
        (coin) => BigInt(coin.balance) >= ESTIMATED_DEEP_FEE
      );
      setSelectedDeepCoin(adequateCoin?.coinObjectId || null);
    } else {
      setSelectedDeepCoin(null);
    }
  }, [deepBalance]);

  // Switch token pair
  const handleSwitchTokens = () => {
    setTokenInSymbol(tokenOutSymbol);
    setTokenOutSymbol(tokenInSymbol);
    setAmountIn(amountOut);
    setAmountOut("");
  };

  // Estimate output amount when input changes
  useEffect(() => {
    const estimateOutput = async () => {
      if (!amountIn || parseFloat(amountIn) <= 0) {
        setEstimationWarning(null);
        setAmountOut("");
        setPriceImpact(0);
        return;
      }

      setIsEstimating(true);
      try {
        const amountInFloat = parseFloat(amountIn);

        // Check if swapping same token
        if (tokenInSymbol === tokenOutSymbol) {
          setAmountOut(amountIn);
          setPriceImpact(0);
          setIsEstimating(false);
          return;
        }

        const deepbookPoolId = (network === "mainnet" ? NETWORK_CONFIG.mainnet.suiusdcPoolId : NETWORK_CONFIG.testnet.suidbusdcPoolId);
        if (!deepbookPoolId || deepbookPoolId === "0x...") {
          throw new Error(`DeepBook pool not configured for ${tokenInSymbol}_${tokenOutSymbol}`);
        }

        // Convert to smallest units
        const tokenInConfig = tokenConfig?.[tokenInSymbol as keyof typeof tokenConfig];
        const tokenOutConfig = tokenConfig?.[tokenOutSymbol as keyof typeof tokenConfig];
        const tokenInDecimals = tokenInConfig?.decimals ?? 9;
        const amountInBigInt = BigInt(
          Math.floor(amountInFloat * Math.pow(10, tokenInDecimals))
        );

        // Estimate swap using DeepBook
        // isBid = buying base (SUI) with quote (DBUSDC/USDC)
        const isBid = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC";
        // DeepBook pool base/quote are fixed regardless of swap direction
        const baseType = isBid ? tokenOutConfig?.type : tokenInConfig?.type;
        const quoteType = isBid ? tokenInConfig?.type : tokenOutConfig?.type;
        if (!baseType || !quoteType) {
          throw new Error("Token type not configured");
        }
        const estimation = await estimateDeepBookSwap(
          client,
          deepbookPoolId,
          amountInBigInt,
          isBid,
          baseType,
          quoteType,
          (network === "mainnet" ? "mainnet" : "testnet"),
        );

        // Convert output to display units
        const tokenOutDecimals = tokenOutConfig?.decimals ?? 9;
        const amountOutFloat = Number(estimation.amountOut) /
          Math.pow(10, tokenOutDecimals);

        setAmountOut(amountOutFloat.toFixed(tokenOutDecimals));
        setPriceImpact(estimation.priceImpact);
        setEstimationWarning(
          estimation.isApproximate
            ? "Insufficient order book depth — estimated from mid price. Actual fill price may vary."
            : null
        );
      } catch (err) {
        console.error("Failed to estimate output:", err);
        setAmountOut("0");
        setError(err instanceof Error ? err.message : "Failed to get price");
      } finally {
        setIsEstimating(false);
      }
    };

    const debounce = setTimeout(estimateOutput, 500);
    return () => clearTimeout(debounce);
  }, [amountIn, tokenInSymbol, tokenOutSymbol, client]);

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

    if (!amountIn || parseFloat(amountIn) <= 0) {
      setError("Please enter a valid amount");
      return;
    }

    if (!amountOut || parseFloat(amountOut) <= 0) {
      setError("Cannot estimate output amount");
      return;
    }

    const tokenInConfig = tokenConfig?.[tokenInSymbol as keyof typeof tokenConfig];
    if (!tokenInConfig) {
      throw new Error(`Token config not found for ${tokenInSymbol}`);
    }
    const tokenOutConfig = tokenConfig?.[tokenOutSymbol as keyof typeof tokenConfig];
    if (!tokenOutConfig) {
      throw new Error(`Token config not found for ${tokenOutSymbol}`);
    }

    const amountInBase = parseTokenAmount(amountIn, tokenInConfig.decimals);
    const amountOutBase = parseTokenAmount(amountOut, tokenOutConfig.decimals);
    // Slippage-adjusted minimum: this is what the ZKP commits to and the note is spendable for
    const minAmountOutBase = (amountOutBase * BigInt(10000 - slippage)) / 10000n;

    try {
      // 1. Select notes and fetch proofs
      setState("fetching-merkle-proofs");
      const notesWithProofs = await selectNotesWithProofs(
        notes,
        amountInBase,
        keypair,
        tokenInConfig.poolId
      );

      // 2. Create output notes (swap + change)
      // swapNote commits to minAmountOut — the slippage-protected minimum the circuit guarantees
      const inputTotal = notesWithProofs.reduce((sum, n) => sum + n.note.amount, 0n);
      const tokenIn = notesWithProofs[0].note.token;
      const tokenOut = getTokenIdFromCoinType(tokenOutConfig.type);
      const [swapNote, changeNote] = createSwapOutputs(
        keypair.masterPublicKey,
        amountInBase,
        minAmountOutBase,
        inputTotal,
        tokenIn,
        tokenOut,
      )

      // 3. Generate ZK proof (returns proof + nullifiers separately)
      setState("generating-proof");
      const { proof, nullifiers } = await generateSwapProof({
        keypair,
        inputNotes: notesWithProofs.map(n => n.note),
        inputLeafIndices: notesWithProofs.map(n => n.leafIndex),
        inputPathElements: notesWithProofs.map(n => n.pathElements!),
        swapNote,
        changeNote,
      });

      // 4. Encrypt output note using viewing public keys
      const viewingPk = deriveViewingPublicKey(keypair.spendingKey);
      const encryptedOutputNote = encryptNote(swapNote, viewingPk);
      const encryptedChangeNote = encryptNote(changeNote, viewingPk);

      // 5. Get DeepBook pool ID
      const deepbookPoolId = (network === "mainnet" ? NETWORK_CONFIG.mainnet.suiusdcPoolId : NETWORK_CONFIG.testnet.suidbusdcPoolId);
      if (!deepbookPoolId || deepbookPoolId === "0x...") {
        throw new Error(`DeepBook pool not configured for ${tokenInSymbol}_${tokenOutSymbol}`);
      }

      if (!selectedDeepCoin) {
        throw new Error(
          "DEEP tokens required for swap. Please acquire DEEP tokens."
        );
      }
      const deepCoinBalance = deepBalance?.data?.find(
        (c) => c.coinObjectId === selectedDeepCoin
      );
      if (!deepCoinBalance || BigInt(deepCoinBalance.balance) < ESTIMATED_DEEP_FEE) {
        throw new Error("Insufficient DEEP balance for swap fees");
      }

      // 6. Build and submit transaction
      setState("submitting");
      const tx = new Transaction();

      // isBid = tokenIn is the quote token (e.g. DBUSDC → SUI)
      const isBid = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC";

      if (isBid) {
        // Bid: quote → base. Contract function swap_bid<Base, Quote>.
        // Type args must be [baseType, quoteType] to match DeepBookPool<Base, Quote>.
        tx.moveCall({
          target: `${packageId}::pool::swap_bid`,
          typeArguments: [tokenOutConfig.type, tokenInConfig.type], // [Base, Quote]
          arguments: [
            tx.object(tokenInConfig.poolId),   // pool_in = quote (DBUSDC) pool
            tx.object(tokenOutConfig.poolId),  // pool_out = base (SUI) pool
            tx.object(deepbookPoolId),
            tx.pure.vector("u8", Array.from(proof.proofBytes)),
            tx.pure.vector("u8", Array.from(proof.publicInputsBytes)),
            tx.pure(nullifiers),
            tx.object(selectedDeepCoin!),
            tx.object(CLOCK_OBJECT_ID),
            tx.pure.vector("u8", Array.from(encryptedOutputNote)),
            tx.pure.vector("u8", Array.from(encryptedChangeNote)),
          ],
        });
      } else {
        // Ask: base → quote (e.g. SUI → DBUSDC)
        tx.moveCall({
          target: `${packageId}::pool::swap`,
          typeArguments: [tokenInConfig.type, tokenOutConfig.type],
          arguments: [
            tx.object(tokenInConfig.poolId),
            tx.object(tokenOutConfig.poolId),
            tx.object(deepbookPoolId),
            tx.pure.vector("u8", Array.from(proof.proofBytes)),
            tx.pure.vector("u8", Array.from(proof.publicInputsBytes)),
            tx.pure(nullifiers),
            tx.object(selectedDeepCoin!),
            tx.object(CLOCK_OBJECT_ID),
            tx.pure.vector("u8", Array.from(encryptedOutputNote)),
            tx.pure.vector("u8", Array.from(encryptedChangeNote)),
          ],
        });
      }
      
      const result = await signAndExecute({ transaction: tx });
      
      // 7. Success!
      setState("success");
      const actualAmountOut = formatTokenAmount(swapNote.amount, tokenOutConfig.decimals);
      let successMessage = `Swapped ${amountIn} ${tokenInSymbol} → ${actualAmountOut} ${tokenOutSymbol}`;
      if (changeNote.amount > 0n) {
        successMessage += ` (Change: ${formatTokenAmount(changeNote.amount, tokenInConfig.decimals)} ${tokenInSymbol})`;
      }
      setSuccess({
        message: successMessage,
        txDigest: result.digest
      });
      setAmountIn("");
      setAmountOut("");

      // 8. Trigger note rescan to pick up the output and change notes
      await onSuccess?.();
    } catch (err) {
      console.error("Swap failed:", err);
      setState("error");
      setError(err instanceof Error ? err.message : "Swap failed");
    }
  };

  const unspentNotes = notes.filter((n) => !n.spent);

  const isFormValid =
    !!account &&
    !!keypair &&
    !!amountIn &&
    parseFloat(amountIn) > 0 &&
    !!amountOut &&
    parseFloat(amountOut) > 0 &&
    unspentNotes.length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* DEEP Token Status */}
      <div className={cn(
        "p-3 border clip-corner",
        selectedDeepCoin
          ? "border-green-600/40 bg-green-900/20"
          : "border-yellow-600/40 bg-yellow-900/20"
      )}>
        <div className="flex items-start gap-2">
          <span className={selectedDeepCoin ? "text-green-400" : "text-yellow-400"}>
            {selectedDeepCoin ? "✓" : "!"}
          </span>
          <div className="flex-1">
            <p className={cn(
              "text-xs font-mono leading-relaxed",
              selectedDeepCoin ? "text-green-400" : "text-yellow-400"
            )}>
              {selectedDeepCoin
                ? `DEEP tokens available (${formatSui(BigInt(deepBalance?.data?.find(c => c.coinObjectId === selectedDeepCoin)?.balance || "0"))} DEEP)`
                : "DEEP tokens required for swap fees. Please acquire DEEP tokens."
              }
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {/* Token In */}
        <div>
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
            From
          </label>
          <div className="flex gap-2">
            <select
              value={tokenInSymbol}
              onChange={(e) => {
                const newTokenIn = e.target.value as "SUI" | "USDC" | "DBUSDC";
                setTokenInSymbol(newTokenIn);
                if (newTokenIn === tokenOutSymbol) {
                  setTokenOutSymbol(tokenInSymbol);
                }
              }}
              className="input w-24"
              disabled={isProcessing}
            >
              {availableTokens.map(token => (
                <option key={token} value={token}>{token}</option>
              ))}
            </select>
            <NumberInput
              value={amountIn}
              onChange={setAmountIn}
              placeholder="0.0"
              step={0.000000001}
              min={0}
              disabled={isProcessing}
              className="flex-1"
            />
          </div>
        </div>

        {/* Swap Direction Button */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={handleSwitchTokens}
            className="p-2 clip-corner border border-cyber-blue/30 hover:bg-cyber-blue/10 transition"
            disabled={isProcessing}
          >
            <svg className="w-5 h-5 text-cyber-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </button>
        </div>

        {/* Token Out */}
        <div>
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
            To (Estimated)
          </label>
          <div className="flex gap-2">
            <select
              value={tokenOutSymbol}
              onChange={(e) => {
                const newTokenOut = e.target.value as "SUI" | "USDC" | "DBUSDC";
                setTokenOutSymbol(newTokenOut);
                if (newTokenOut === tokenInSymbol) {
                  setTokenInSymbol(tokenOutSymbol);
                }
              }}
              className="input w-24"
              disabled={isProcessing}
            >
              {availableTokens.map(token => (
                <option key={token} value={token}>{token}</option>
              ))}
            </select>
            <input
              type="text"
              value={isEstimating ? "Estimating..." : amountOut}
              readOnly
              className="input flex-1 bg-black/30"
            />
          </div>
          {isEstimating && (
            <p className="mt-2 text-[10px] text-gray-500 font-mono flex items-center gap-2">
              <svg
                className="h-3 w-3 animate-spin text-cyber-blue"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              FETCHING PRICE...
            </p>
          )}
          {!isEstimating && amountOut && parseFloat(amountOut) > 0 && priceImpact > 1.0 && (
            <p className="mt-2 text-[10px] text-orange-500 font-mono flex items-center gap-1">
              <span>⚠</span>
              <span>HIGH PRICE IMPACT: {priceImpact.toFixed(2)}%</span>
            </p>
          )}
          {!isEstimating && estimationWarning && (
            <p className="mt-2 text-[10px] text-yellow-500 font-mono flex items-center gap-1">
              <span>⚠</span>
              <span>{estimationWarning}</span>
            </p>
          )}
        </div>

        {/* Slippage Settings */}
        <div>
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
            Slippage Tolerance
          </label>
          <div className="flex gap-2">
            {[10, 50, 100, 500].map((bps) => (
              <button
                key={bps}
                type="button"
                onClick={() => setSlippage(bps)}
                disabled={isProcessing}
                className={cn(
                  "px-3 py-1.5 text-xs font-mono font-bold uppercase tracking-wider transition clip-corner",
                  slippage === bps
                    ? "bg-cyber-blue text-black border border-cyber-blue"
                    : "bg-black/30 text-gray-400 border border-gray-800 hover:border-cyber-blue/50"
                )}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>

        {/* Price Impact */}
        {priceImpact > 0 && (
          <div className="p-3 border border-cyber-blue/30 bg-cyber-blue/10 clip-corner">
            <p className="text-[10px] text-gray-300 font-mono">
              <span className="text-gray-500">PRICE IMPACT:</span>{" "}
              <span className={cn(
                "font-bold",
                priceImpact > 5 ? "text-red-400" : "text-green-400"
              )}>
                {priceImpact.toFixed(2)}%
              </span>
            </p>
          </div>
        )}

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

        {/* Error Message */}
        {error && (
          <div className="p-3 border border-red-600/30 bg-red-900/20 clip-corner">
            <div className="flex items-start gap-2">
              <span className="text-red-500 text-sm">✕</span>
              <p className="text-xs text-red-400 font-mono leading-relaxed">{error}</p>
            </div>
          </div>
        )}

        {/* Success Message */}
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
      </div>

      {/* Submit Button */}
      <button
        type="submit"
        disabled={!isFormValid || isProcessing}
        className={cn(
          "btn-primary w-full",
          isProcessing && "cursor-wait opacity-70"
        )}
      >
        {isProcessing ? "◉ PROCESSING..." : "⇄ PRIVATE SWAP"}
      </button>

      {/* Info Box */}
      <div className="p-4 border border-gray-800 bg-black/30 clip-corner space-y-3">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-cyber-blue font-mono">
          Swap Process:
        </h4>
        <ol className="text-[10px] text-gray-400 space-y-1.5 list-decimal list-inside font-mono leading-relaxed">
          <li>Select input notes from pool</li>
          <li>Fetch price from DeepBook DEX</li>
          <li>Generate Merkle proofs</li>
          <li>Calculate nullifiers (prevent double-spending)</li>
          <li>Generate ZK proof (30-60s)</li>
          <li>Execute private swap</li>
          <li>Shield output tokens to pool</li>
        </ol>
        <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent" />
        <p className="text-[10px] text-gray-500 font-mono">
          <span className="text-cyber-blue">◉</span> Privacy: Swap amounts and addresses remain hidden via ZK proofs
        </p>
      </div>
    </form>
  );
}
