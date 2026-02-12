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
import { cn, parseSui, formatSui } from "@/lib/utils";
import {
  SUI_COIN_TYPE,
  DEEPBOOK_POOLS,
  DEEP_TOKEN_TYPE,
  ESTIMATED_DEEP_FEE,
  DEFAULT_SWAP_MODE,
} from "@/lib/constants";
import { selectNotesWithProofs } from "@/lib/noteSelectionWithProofs";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import { NumberInput } from "@/components/NumberInput";
import {
  generateSwapProof,
  calculateMinOutput,
  estimateDeepBookSwap,
  encryptNote,
  deriveViewingPublicKey,
  type SwapParams,
} from "@june_zk/octopus-sdk";
import { initPoseidon } from "@/lib/poseidon";
import {
  verifyNotesAndComputeRoots,
  verifyOnChainRoot,
} from "@/lib/merkleVerification";
import {
  deriveTokenIdFromCoinType,
  buildSwapInput,
  validateSufficientBalance,
  checkCacheStaleness,
} from "@/lib/swapUtils";

interface SwapFormProps {
  keypair: OctopusKeypair | null;
  notes: OwnedNote[];
  loading: boolean;
  error: string | null;
  onSuccess?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  lastScanStats?: {
    eventsScanned: number;
    notesDecrypted: number;
    timestamp: number;
  } | null;
}

export function SwapForm({ keypair, notes, loading: notesLoading, error: notesError, onSuccess, onRefresh, lastScanStats }: SwapFormProps) {
  const { packageId, suiPoolId, tokens } = useNetworkConfig();
  const { network } = useSuiClientContext();
  const isMainnet = network === "mainnet";

  // Determine available tokens based on network
  const availableTokens = isMainnet ? ["SUI", "USDC"] as const : ["SUI", "DBUSDC"] as const;
  const defaultTokenOut = isMainnet ? "USDC" : "DBUSDC";

  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  const [tokenIn, setTokenIn] = useState<"SUI" | "USDC" | "DBUSDC">("SUI");
  const [tokenOut, setTokenOut] = useState<"SUI" | "USDC" | "DBUSDC">(defaultTokenOut);
  const [slippage, setSlippage] = useState(50); // 0.5% in bps
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEstimating, setIsEstimating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [priceImpact, setPriceImpact] = useState<number>(0);
  const [swapMode, setSwapMode] = useState<"test" | "production">(DEFAULT_SWAP_MODE);
  const [selectedDeepCoin, setSelectedDeepCoin] = useState<string | null>(null);

  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  // Query DEEP tokens (only in production mode)
  const { data: deepBalance } = useSuiClientQuery(
    "getCoins",
    {
      owner: account?.address ?? "",
      coinType: DEEP_TOKEN_TYPE,
    },
    {
      enabled: swapMode === "production" && !!account?.address,
    }
  );

  // Auto-select DEEP coin with sufficient balance
  useEffect(() => {
    if (swapMode === "production" && deepBalance?.data) {
      const adequateCoin = deepBalance.data.find(
        (coin) => BigInt(coin.balance) >= ESTIMATED_DEEP_FEE
      );
      setSelectedDeepCoin(adequateCoin?.coinObjectId || null);
    } else {
      setSelectedDeepCoin(null);
    }
  }, [swapMode, deepBalance]);

  // Switch token pair
  const handleSwitchTokens = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn(amountOut);
    setAmountOut("");
  };

  // Estimate output amount when input changes
  useEffect(() => {
    const estimateOutput = async () => {
      if (!amountIn || parseFloat(amountIn) <= 0) {
        setAmountOut("");
        setPriceImpact(0);
        return;
      }

      setIsEstimating(true);
      try {
        const amountInFloat = parseFloat(amountIn);

        // Check if swapping same token
        if (tokenIn === tokenOut) {
          setAmountOut(amountIn);
          setPriceImpact(0);
          setIsEstimating(false);
          return;
        }

        // Test mode uses 1:1 mock swap (matches contract behavior)
        if (swapMode === "test") {
          setAmountOut(amountIn);
          setPriceImpact(0);
          setIsEstimating(false);
          return;
        }

        // Production mode: Get real price from DeepBook
        const poolKey = `${tokenIn}_${tokenOut}`;
        const deepbookPoolId = DEEPBOOK_POOLS[poolKey];

        if (!deepbookPoolId || deepbookPoolId === "0x...") {
          throw new Error(`DeepBook pool not configured for ${poolKey}`);
        }

        // Convert to smallest units
        const inConfig = tokens?.[tokenIn as keyof typeof tokens];
        const outConfig = tokens?.[tokenOut as keyof typeof tokens];
        const tokenInDecimals = inConfig?.decimals ?? 9;
        const amountInBigInt = BigInt(
          Math.floor(amountInFloat * Math.pow(10, tokenInDecimals))
        );

        // Estimate swap using DeepBook
        const isBid = tokenIn === "USDC" || tokenIn === "DBUSDC"; // Buying SUI with USDC/DBUSDC
        const estimation = await estimateDeepBookSwap(
          client,
          deepbookPoolId,
          amountInBigInt,
          isBid
        );

        // Convert output to display units
        const tokenOutDecimals = outConfig?.decimals ?? 9;
        const amountOutFloat = Number(estimation.amountOut) /
          Math.pow(10, tokenOutDecimals);

        setAmountOut(amountOutFloat.toFixed(tokenOutDecimals));
        setPriceImpact(estimation.priceImpact);
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
  }, [amountIn, tokenIn, tokenOut, client, swapMode]);

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

    setIsSubmitting(true);

    try {
      await initPoseidon();

      const amountInBigInt = parseSui(amountIn);
      const amountOutBigInt = parseSui(amountOut);
      const minAmountOut = calculateMinOutput(amountOutBigInt, slippage);

      // Validate sufficient balance early
      validateSufficientBalance(notes, amountInBigInt, tokenIn);

      // Check cache staleness
      checkCacheStaleness(lastScanStats);

      // Get token configurations
      const tokenInConfig = tokens?.[tokenIn as keyof typeof tokens];
      const tokenOutConfig = tokens?.[tokenOut as keyof typeof tokens];

      if (!tokenInConfig) {
        throw new Error(`Token config not found for ${tokenIn}`);
      }
      if (!tokenOutConfig) {
        throw new Error(`Token config not found for ${tokenOut}`);
      }

      // 1. Select notes and fetch proofs
      const notesWithProofs = await selectNotesWithProofs(
        notes,
        amountInBigInt,
        keypair,
        tokenInConfig.poolId
      );

      // 2. Derive token IDs
      const inputTokenId = notesWithProofs[0].note.token;
      const outputCoinType = tokenOutConfig.type;
      const outputTokenId = deriveTokenIdFromCoinType(outputCoinType);

      // 3. Get DeepBook pool ID
      const poolKey = `${tokenIn}_${tokenOut}`;
      const deepbookPoolId = DEEPBOOK_POOLS[poolKey];

      if (swapMode === "production" && (!deepbookPoolId || deepbookPoolId === "0x...")) {
        throw new Error(
          `DeepBook pool not configured for ${poolKey}. Please set the pool ID or switch to test mode.`
        );
      }

      const poolIdToUse = swapMode === "test" ? "0x0" : deepbookPoolId;
      const poolIdBytes = poolIdToUse.replace("0x", "");
      const poolIdBigInt = poolIdBytes === "" ? 0n : BigInt("0x" + poolIdBytes);

      // 4. Build swap parameters
      const swapParams: SwapParams = {
        tokenIn: inputTokenId,
        tokenOut: outputTokenId,
        amountIn: amountInBigInt,
        minAmountOut,
        dexPoolId: poolIdBigInt,
        slippageBps: slippage,
      };

      // 5. Verify notes and compute Merkle roots
      const computedRoots = verifyNotesAndComputeRoots(
        notesWithProofs,
        keypair.masterPublicKey
      );

      // 6. Verify on-chain root (pre-proof)
      await verifyOnChainRoot(
        client,
        packageId!,
        suiPoolId!,
        SUI_COIN_TYPE,
        account.address,
        computedRoots[0],
        "pre-proof"
      );

      console.log("MPK:", keypair.masterPublicKey.toString());
      console.log("Token In:", inputTokenId.toString());
      console.log("Token Out:", outputTokenId.toString());
      console.log("Merkle Root (verified):", computedRoots[0]?.toString());

      // 7. Build swap input
      const { swapInput, outputNote, changeNote } = buildSwapInput(
        keypair,
        notesWithProofs,
        swapParams,
        outputTokenId,
        amountOutBigInt
      );

      // 8. Generate ZK proof (30-60s)
      const proof = await generateSwapProof(swapInput);

      // 9. Re-verify on-chain root (post-proof)
      await verifyOnChainRoot(
        client,
        packageId!,
        suiPoolId!,
        SUI_COIN_TYPE,
        account.address,
        computedRoots[0],
        "post-proof"
      );

      // 10. Encrypt notes
      const myViewingPk = deriveViewingPublicKey(keypair.spendingKey);
      const encryptedOutputNote = encryptNote(outputNote, myViewingPk);
      const encryptedChangeNote = encryptNote(changeNote, myViewingPk);

      // 11. Validate production mode requirements
      if (swapMode === "production") {
        if (!selectedDeepCoin) {
          throw new Error(
            "DEEP tokens required for production swap. Please acquire DEEP tokens or switch to test mode."
          );
        }
        const deepCoinBalance = deepBalance?.data?.find(
          (c) => c.coinObjectId === selectedDeepCoin
        );
        if (!deepCoinBalance || BigInt(deepCoinBalance.balance) < ESTIMATED_DEEP_FEE) {
          throw new Error("Insufficient DEEP balance for swap fees");
        }
      }

      // 12. Build and execute transaction
      const tx = new Transaction();

      if (swapMode === "production") { 
        tx.moveCall({
          target: `${packageId}::pool::swap`,
          typeArguments: [tokenInConfig.type, tokenOutConfig.type],
          arguments: [
            tx.object(tokenInConfig.poolId),
            tx.object(tokenOutConfig.poolId),
            tx.object(deepbookPoolId),
            tx.pure.vector("u8", Array.from(proof.proofBytes)),
            tx.pure.vector("u8", Array.from(proof.publicInputsBytes)),
            tx.pure.u64(amountIn),
            tx.pure.u64(minAmountOut),
            tx.object(selectedDeepCoin!),
            tx.object('0x6'), // Clock shared object
            tx.pure.vector("u8", Array.from(encryptedOutputNote)),
            tx.pure.vector("u8", Array.from(encryptedChangeNote)),
          ],
        });
      } else { 
        const [mockDeepCoin] = tx.splitCoins(tx.gas, [1]);

        tx.moveCall({
          target: `${packageId}::pool::swap_for_testing`,
          typeArguments: [tokenInConfig.type, tokenOutConfig.type],
          arguments: [
            tx.object(tokenInConfig.poolId),
            tx.object(tokenOutConfig.poolId),
            tx.pure.vector("u8", Array.from(proof.proofBytes)),
            tx.pure.vector("u8", Array.from(proof.publicInputsBytes)),
            tx.pure.u64(amountIn),
            tx.pure.u64(minAmountOut),
            mockDeepCoin,
            tx.object('0x6'), // Clock shared object
            tx.pure.vector("u8", Array.from(encryptedOutputNote)),
            tx.pure.vector("u8", Array.from(encryptedChangeNote)),
          ],
        });
      }

      const result = await signAndExecute({ transaction: tx });

      setSuccess(`Swap successful! TX: ${result.digest}`);
      if (onSuccess) await onSuccess();
    } catch (err) {
      console.error("Swap failed:", err);
      setError(err instanceof Error ? err.message : "Swap failed");

      // If transaction fails, trigger refresh to reconcile state
      if (onRefresh) {
        setTimeout(() => {
          onRefresh();
        }, 1000);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const unspentNotes = notes.filter((n) => !n.spent);

  // Allow production mode on mainnet, or on testnet for SUI/DBUSDC swaps only
  const canUseProductionMode = isMainnet || (
    !isMainnet &&
    swapMode === "production" &&
    tokenIn === "SUI" &&
    tokenOut === "DBUSDC"
  );

  const isFormValid =
    (canUseProductionMode || swapMode === "test") &&
    !!account &&
    !!keypair &&
    !!amountIn &&
    parseFloat(amountIn) > 0 &&
    !!amountOut &&
    parseFloat(amountOut) > 0 &&
    unspentNotes.length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Mode Toggle */}
      <div className="flex items-center justify-between p-3 border border-cyber-blue/30 bg-black/40 clip-corner">
        <div>
          <p className="text-xs font-mono text-gray-300 mb-1">Swap Mode</p>
          <p className="text-[10px] text-gray-500 font-mono">
            {swapMode === "test" ? "Mock 1:1 swap (no DEEP required)" : "Real DeepBook swap (requires DEEP)"}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSwapMode("test")}
            className={cn(
              "px-3 py-1 text-xs font-mono clip-corner border transition",
              swapMode === "test"
                ? "bg-cyber-blue/20 border-cyber-blue text-cyber-blue"
                : "border-gray-600 text-gray-400 hover:border-gray-500"
            )}
          >
            Test
          </button>
          <button
            type="button"
            onClick={() => setSwapMode("production")}
            className={cn(
              "px-3 py-1 text-xs font-mono clip-corner border transition",
              swapMode === "production"
                ? "bg-cyber-blue/20 border-cyber-blue text-cyber-blue"
                : "border-gray-600 text-gray-400 hover:border-gray-500"
            )}
          >
            Production
          </button>
        </div>
      </div>

      {/* DEEP Token Warning (Production Mode) */}
      {swapMode === "production" && (
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
                  : "DEEP tokens required for swap fees. Please acquire DEEP tokens or switch to test mode."
                }
              </p>
            </div>
          </div>
        </div>
      )}

      {!isMainnet && swapMode === "production" && (tokenIn !== "SUI" || tokenOut !== "DBUSDC") && (
        <div className="p-3 border border-red-600/40 bg-red-900/20 clip-corner">
          <div className="flex items-start gap-2">
            <span className="text-red-400 text-sm">✕</span>
            <p className="text-xs text-red-400 font-mono leading-relaxed">
              Production swap on testnet only supports <span className="text-amber-400 font-bold">SUI/DBUSDC</span>. Switch to test mode or select SUI/DBUSDC pair.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {/* Token In */}
        <div>
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
            From
          </label>
          <div className="flex gap-2">
            <select
              value={tokenIn}
              onChange={(e) => setTokenIn(e.target.value as "SUI" | "USDC" | "DBUSDC")}
              className="input w-24"
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
            disabled={isSubmitting}
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
              value={tokenOut}
              onChange={(e) => setTokenOut(e.target.value as "SUI" | "USDC" | "DBUSDC")}
              className="input w-24"
              disabled={isSubmitting}
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
                disabled={isSubmitting}
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
              <p className="text-xs text-green-400 font-mono leading-relaxed">{success}</p>
            </div>
          </div>
        )}
      </div>

      {/* Submit Button */}
      <button
        type="submit"
        disabled={!isFormValid || isSubmitting}
        className={cn(
          "btn-primary w-full",
          isSubmitting && "cursor-wait opacity-70"
        )}
      >
        {isSubmitting ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
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
            GENERATING PROOF...
          </span>
        ) : (
          "⇄ PRIVATE SWAP"
        )}
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
