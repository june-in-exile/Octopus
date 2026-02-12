"use client";

import { useState, useEffect } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
  useSuiClientContext,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { cn, parseSui, formatSui } from "@/lib/utils";
import { SUI_COIN_TYPE, DEEPBOOK_POOLS, DEEP_TOKEN_TYPE, ESTIMATED_DEEP_FEE, DEFAULT_SWAP_MODE } from "@/lib/constants";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import { useSuiClientQuery } from "@mysten/dapp-kit";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import {
  generateSwapProof,
  convertSwapProofToSui,
  calculateMinOutput,
  estimateDeepBookSwap,
  buildSwapTransaction,
  buildSwapTransactionForTesting,
  createNote,
  randomFieldElement,
  encryptNote,
  deriveViewingPublicKey,
  poseidonHash,
  bytesToBigIntLE,
  type SwapParams,
  type SwapInput,
} from "@june_zk/octopus-sdk";
import { initPoseidon } from "@/lib/poseidon";
import { NumberInput } from "@/components/NumberInput";
import { selectNotesWithProofs } from "@/lib/noteSelectionWithProofs";

interface SwapFormProps {
  keypair: OctopusKeypair | null;
  notes: OwnedNote[];
  loading: boolean;
  error: string | null;
  onSuccess?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  markNoteSpent?: (nullifier: bigint) => void;
  lastScanStats?: {
    eventsScanned: number;
    notesDecrypted: number;
    timestamp: number;
  } | null;
}

export function SwapForm({ keypair, notes, loading: notesLoading, error: notesError, onSuccess, onRefresh, markNoteSpent, lastScanStats }: SwapFormProps) {
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
        const tokenInDecimals = tokens?.[tokenIn]?.decimals ?? 9;
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
        const tokenOutDecimals = tokens?.[tokenOut]?.decimals ?? 9;
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

    // Validate sufficient shielded balance early (before expensive proof generation)
    const unspentNotes = notes.filter((n: OwnedNote) => !n.spent);
    const totalShieldedBalance = unspentNotes.reduce((sum, n) => sum + n.note.amount, 0n);
    const amountInBigInt = parseSui(amountIn);

    if (totalShieldedBalance < amountInBigInt) {
      setError(
        `Insufficient shielded balance. You need ${amountIn} ${tokenIn} but only have ` +
        `${formatSui(totalShieldedBalance)} ${tokenIn} available. Please shield more tokens first.`
      );
      return;
    }

    // Check cache staleness and warn user
    const STALENESS_WARNING_MS = 5 * 60 * 1000; // 5 minutes
    if (lastScanStats) {
      const cacheAge = Date.now() - lastScanStats.timestamp;
      if (cacheAge > STALENESS_WARNING_MS) {
        const ageMinutes = Math.floor(cacheAge / 60000);
        console.warn(`⚠️ Notes cache is ${ageMinutes} minutes old. Consider refreshing before swap.`);
        // Note: We don't block the swap, but the dual root checks will catch any issues
      }
    }

    setIsSubmitting(true);

    try {
      await initPoseidon();

      const amountInBigInt = parseSui(amountIn);
      const amountOutBigInt = parseSui(amountOut);
      const minAmountOut = calculateMinOutput(amountOutBigInt, slippage);

      // Get unspent notes
      const unspentNotes = notes.filter((n: OwnedNote) => !n.spent);

      if (unspentNotes.length === 0) {
        setError("No unspent notes found. Please shield tokens first.");
        setIsSubmitting(false);
        return;
      }

      // 1-3. Select notes, fetch proofs, and mark as spent
      const tokenInPoolId = tokens?.[tokenIn]?.poolId;
      if (!tokenInPoolId) {
        throw new Error(`Pool ID not found for ${tokenIn}`);
      }

      const notesWithProofs = await selectNotesWithProofs(
        notes,
        amountInBigInt,
        keypair,
        tokenInPoolId,
        markNoteSpent
      );

      // 4. Get token IDs from selected notes
      const inputTokenId = notesWithProofs[0].note.token;

      // Derive output token ID from coin type (same as shield operation)
      const outputCoinType = tokens?.[tokenOut]?.type;
      if (!outputCoinType) {
        throw new Error(`Coin type not found for ${tokenOut}`);
      }
      const outputPackageAddr = outputCoinType.split("::")[0];
      const outputTokenId = poseidonHash([BigInt(outputPackageAddr)]);

      // Get DeepBook pool ID (only required for production mode)
      const poolKey = `${tokenIn}_${tokenOut}`;
      const deepbookPoolId = DEEPBOOK_POOLS[poolKey];

      // In production mode, validate pool configuration
      if (swapMode === "production" && (!deepbookPoolId || deepbookPoolId === "0x...")) {
        throw new Error(`DeepBook pool not configured for ${poolKey}. Please set the pool ID in your environment variables or switch to test mode.`);
      }

      // Convert pool ID to BigInt (use placeholder 0x0 in test mode)
      const poolIdToUse = swapMode === "test" ? "0x0" : deepbookPoolId;
      const poolIdBytes = poolIdToUse.replace("0x", "");
      const poolIdBigInt = poolIdBytes === "" ? 0n : BigInt("0x" + poolIdBytes);

      // 5. Build swap parameters
      const swapParams: SwapParams = {
        tokenIn: inputTokenId,
        tokenOut: outputTokenId,
        amountIn: amountInBigInt,
        minAmountOut,
        dexPoolId: poolIdBigInt,
        slippageBps: slippage,
      };

      // 6. Create output note (swapped tokens for recipient - self)
      const outputRandom = randomFieldElement();
      const outputNote = createNote(
        keypair.masterPublicKey,
        outputTokenId,
        amountOutBigInt,
        outputRandom
      );

      // 7. Calculate change amount (remaining input tokens)
      const totalInputValue = notesWithProofs.reduce((sum, n) => sum + n.note.amount, 0n);
      const changeAmount = totalInputValue - amountInBigInt;

      const changeRandom = randomFieldElement();
      const changeNote = createNote(
        keypair.masterPublicKey,
        inputTokenId,
        changeAmount,
        changeRandom
      );

      // 8. Build swap input for proof generation
      // Debug: Verify NSK derivation and Merkle proofs for each input note
      console.log("=== Swap Input Verification ===");
      const MERKLE_TREE_DEPTH = 16;
      const computedRoots: bigint[] = [];

      for (let i = 0; i < notesWithProofs.length; i++) {
        const note = notesWithProofs[i].note;
        const expectedNSK = poseidonHash([keypair.masterPublicKey, note.random]);
        const matches = expectedNSK === note.nsk;

        // Compute Merkle root from this note's proof
        let root = note.commitment;
        const leafIndex = BigInt(notesWithProofs[i].leafIndex);
        const pathElements = notesWithProofs[i].pathElements!;

        for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
          const sibling = pathElements[level];
          const isRight = (leafIndex >> BigInt(level)) & 1n;
          if (isRight === 0n) {
            root = poseidonHash([root, sibling]);
          } else {
            root = poseidonHash([sibling, root]);
          }
        }

        computedRoots.push(root);

        console.log(`Input Note ${i}:`, {
          token: note.token.toString(),
          value: note.amount.toString(),
          nsk: note.nsk.toString(),
          random: note.random.toString(),
          expectedNSK: expectedNSK.toString(),
          nskMatches: matches,
          leafIndex: notesWithProofs[i].leafIndex,
          commitment: note.commitment.toString(),
          merkleRoot: root.toString(),
        });

        if (!matches) {
          throw new Error(`Input note ${i} has invalid NSK! Expected ${expectedNSK} but got ${note.nsk}`);
        }
      }

      // Verify both notes have the same Merkle root
      if (computedRoots.length === 2 && computedRoots[0] !== computedRoots[1]) {
        throw new Error(
          `Merkle root mismatch detected!\n` +
          `Note 0 root: ${computedRoots[0].toString()}\n` +
          `Note 1 root: ${computedRoots[1].toString()}\n` +
          `Your notes have stale Merkle proofs. Please refresh your notes and try again.`
        );
      }

      // Helper function to fetch and verify on-chain root
      const verifyOnChainRoot = async (stage: string) => {
        const onChainRootResult = await client.devInspectTransactionBlock({
          transactionBlock: (() => {
            const tx = new Transaction();
            tx.moveCall({
              target: `${packageId}::pool::get_merkle_root`,
              typeArguments: [SUI_COIN_TYPE],
              arguments: [tx.object(suiPoolId!)],
            });
            return tx;
          })(),
          sender: account?.address || "0x0",
        });

        if (onChainRootResult.results?.[0]?.returnValues?.[0]) {
          // returnValues[0] is a tuple: [bytes: number[], type: string]
          const [rootBytes] = onChainRootResult.results[0].returnValues[0];

          // Use SDK's tested utility function for LE byte conversion
          const onChainRoot = bytesToBigIntLE(rootBytes);
          const localRoot = computedRoots[0];

          console.log(`[${stage}] On-chain root (hex):`, onChainRoot.toString(16));
          console.log(`[${stage}] Local root (hex):`, localRoot.toString(16));
          console.log(`[${stage}] On-chain Merkle Root:`, onChainRoot.toString());
          console.log(`[${stage}] Local Merkle Root:`, localRoot.toString());

          if (onChainRoot !== localRoot) {
            throw new Error(
              `Your notes have outdated Merkle proofs! (detected at ${stage})\n` +
              `Local root: ${localRoot.toString()}\n` +
              `On-chain root: ${onChainRoot.toString()}\n\n` +
              `New notes have been added to the pool since you last scanned. ` +
              `Please refresh your notes and try again.`
            );
          }

          console.log(`✓ [${stage}] Merkle proof validation passed!`);
        }
      };

      // Verify computed root matches on-chain root (pre-proof check)
      await verifyOnChainRoot("pre-proof");

      console.log("MPK:", keypair.masterPublicKey.toString());
      console.log("Token In:", inputTokenId.toString());
      console.log("Token Out:", outputTokenId.toString());
      console.log("Merkle Root (verified):", computedRoots[0]?.toString());

      const swapInput: SwapInput = {
        keypair,
        inputNotes: notesWithProofs.map(n => n.note),
        inputLeafIndices: notesWithProofs.map(n => n.leafIndex),
        inputPathElements: notesWithProofs.map(n => n.pathElements!),
        swapParams,
        outputNSK: outputNote.nsk,
        outputRandom: outputNote.random,
        outputAmount: outputNote.amount,
        changeNSK: changeNote.nsk,
        changeRandom: changeNote.random,
        changeAmount: changeNote.amount,
      };

      // 9. Generate ZK proof (30-60 seconds)
      const { proof, publicSignals } = await generateSwapProof(swapInput);

      // 9.5. Re-verify on-chain root after proof generation
      // (catch any changes that happened during the 30-60s proof generation window)
      await verifyOnChainRoot("post-proof");

      // 10. Convert proof to Sui format
      const suiProof = convertSwapProofToSui(proof, publicSignals);

      // 11. Encrypt notes for recipient (self)
      const myViewingPk = deriveViewingPublicKey(keypair.spendingKey);
      const encryptedOutputNote = encryptNote(outputNote, myViewingPk);
      const encryptedChangeNote = encryptNote(changeNote, myViewingPk);

      // 12. Validate production mode requirements
      if (swapMode === "production") {
        if (!selectedDeepCoin) {
          throw new Error("DEEP tokens required for production swap. Please acquire DEEP tokens or switch to test mode.");
        }
        const deepCoinBalance = deepBalance?.data?.find(c => c.coinObjectId === selectedDeepCoin);
        if (!deepCoinBalance || BigInt(deepCoinBalance.balance) < ESTIMATED_DEEP_FEE) {
          throw new Error("Insufficient DEEP balance for swap fees");
        }
      }

      // 13. Build and execute transaction (mode-specific)
      const tokenInType = tokens?.[tokenIn]?.type;
      const tokenOutType = tokens?.[tokenOut]?.type;
      const tokenOutPoolId = tokens?.[tokenOut]?.poolId;

      if (!tokenInType || !tokenOutType || !tokenInPoolId || !tokenOutPoolId) {
        throw new Error("Token configuration incomplete");
      }

      const tx = swapMode === "production"
        ? buildSwapTransaction(
          packageId!,
          tokenInPoolId,
          tokenOutPoolId,
          deepbookPoolId,
          tokenInType,
          tokenOutType,
          suiProof,
          amountInBigInt,
          minAmountOut,
          selectedDeepCoin!,
          encryptedOutputNote,
          encryptedChangeNote
        )
        : buildSwapTransactionForTesting(
          packageId!,
          tokenInPoolId,
          tokenOutPoolId,
          tokenInType,
          tokenOutType,
          suiProof,
          amountInBigInt,
          minAmountOut,
          encryptedOutputNote,
          encryptedChangeNote
        );

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
