"use client";

import { useState, useEffect, useCallback } from "react";
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
  getTokenIdFromCoinType,
  formatTokenAmount,
  truncateAddress,
} from "@/lib/utils";
import {
  NETWORK_CONFIG,
  CLOCK_OBJECT_ID,
  ESTIMATED_DEEP_FEE,
} from "@/lib/constants";
import { selectNotesWithProofs } from "@/lib/noteSelection";
import type { OctopusKeypair } from "@/hooks/useLocalKeypair";
import type { OwnedNote } from "@/hooks/useNotes";
import { NumberInput } from "@/components/NumberInput";
import { NoteBalanceDisplay } from "@/components/NoteBalanceDisplay";
import {
  createSwapOutputs,
  generateSwapProof,
  estimateDeepBookSwap,
  getPoolBookParams,
  encryptNote,
  deriveViewingPublicKey,
  RelayerClient,
} from "@june_zk/octopus-sdk";
import { RelayerSelector, type RelayerStatus } from "@/components/RelayerSelector";

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
  loading: _notesLoading,
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
  }, [selectedToken, defaultTokenOut]);
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  const [isTargetAmount, setIsTargetAmount] = useState(false);
  const [activeInput, setActiveInput] = useState<"from" | "to">("from");
  const [isEstimatingReverse, setIsEstimatingReverse] = useState(false);
  const [slippage, setSlippage] = useState(50); // 0.5% in bps
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [state, setState] = useState<SwapState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; txDigest?: string } | null>(null);
  const [priceImpact, setPriceImpact] = useState<number>(0);
  const [estimationWarning, setEstimationWarning] = useState<string | null>(null);
  const [selectedDeepCoin, setSelectedDeepCoin] = useState<string | null>(null);
  const [lotSize, setLotSize] = useState<bigint>(1n);
  const [minSize, setMinSize] = useState<bigint>(1n);
  const [useRelayer, setUseRelayer] = useState(false);
  const [relayerUrl, setRelayerUrl] = useState<string | null>(null);
  const [relayerStatus, setRelayerStatus] = useState<RelayerStatus>("idle");

  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const handleRelayerToggle = useCallback((enabled: boolean, url: string | null, status: RelayerStatus) => {
    setUseRelayer(enabled);
    setRelayerUrl(url);
    setRelayerStatus(status);
  }, []);

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

  // Auto-select the DEEP coin with the largest balance
  useEffect(() => {
    if (deepBalance?.data) {
      const best = deepBalance.data.reduce<(typeof deepBalance.data)[0] | null>(
        (max, coin) =>
          !max || BigInt(coin.balance) > BigInt(max.balance) ? coin : max,
        null
      );
      setSelectedDeepCoin(
        best && BigInt(best.balance) >= ESTIMATED_DEEP_FEE
          ? best.coinObjectId
          : null
      );
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
    setIsTargetAmount(false);
    setActiveInput("from");
  };

  // Estimate output amount when input changes (forward: FROM → TO)
  useEffect(() => {
    const estimateOutput = async () => {
      if (activeInput === "to") return;
      setIsTargetAmount(false);
      if (!amountIn || parseFloat(amountIn) <= 0) {
        setEstimationWarning(null);
        setAmountOut("");
        setPriceImpact(0);
        setExchangeRate(null);
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
        const amountInRaw = BigInt(
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

        // Fetch lot size first so we can align amountIn before estimation
        let currentLotSize = lotSize;
        try {
          const params = await getPoolBookParams(
            client,
            deepbookPoolId,
            baseType,
            quoteType,
            network === "mainnet" ? "mainnet" : "testnet",
          );
          currentLotSize = params.lotSize;
          setLotSize(params.lotSize);
          setMinSize(params.minSize);
        } catch {
          // Keep default lotSize/minSize of 1n if fetch fails
        }

        // Align amountIn to nearest lot size (round down) so DeepBook doesn't silently truncate.
        // For bid (USDC→SUI), amountInRaw is in quote units — lotSize is in base (SUI) units,
        // so alignment must be skipped to avoid dividing a small USDC amount by a large SUI lot size (→ 0).
        const amountInBigInt = (!isBid && currentLotSize > 1n)
          ? (amountInRaw / currentLotSize) * currentLotSize
          : amountInRaw;

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

        if (estimation.isApproximate) {
          setAmountOut("");
          setExchangeRate(null);
          setPriceImpact(0);
          setEstimationWarning("Insufficient liquidity in DeepBook pool for this amount.");
          return;
        }

        setAmountOut(amountOutFloat.toFixed(tokenOutDecimals));
        setExchangeRate(amountInFloat > 0 ? amountOutFloat / amountInFloat : null);
        setPriceImpact(estimation.priceImpact);
        setEstimationWarning(null);
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
  }, [amountIn, tokenInSymbol, tokenOutSymbol, client, activeInput, tokenConfig, network]);

  // Estimate required input amount when output changes (reverse: TO → FROM)
  useEffect(() => {
    if (activeInput !== "to") return;

    const estimateInput = async () => {
      if (!amountOut || parseFloat(amountOut) <= 0) {
        setAmountIn("");
        setExchangeRate(null);
        setPriceImpact(0);
        setEstimationWarning(null);
        return;
      }

      setIsEstimatingReverse(true);
      try {
        const amountOutFloat = parseFloat(amountOut);

        if (tokenInSymbol === tokenOutSymbol) {
          setAmountIn(amountOut);
          return;
        }

        const deepbookPoolId = network === "mainnet"
          ? NETWORK_CONFIG.mainnet.suiusdcPoolId
          : NETWORK_CONFIG.testnet.suidbusdcPoolId;
        if (!deepbookPoolId || deepbookPoolId === "0x...") return;

        const tokenInCfg = tokenConfig?.[tokenInSymbol as keyof typeof tokenConfig];
        const tokenOutCfg = tokenConfig?.[tokenOutSymbol as keyof typeof tokenConfig];
        if (!tokenInCfg || !tokenOutCfg) return;

        const tokenInDecimals = tokenInCfg.decimals ?? 9;
        const tokenOutDecimals = tokenOutCfg.decimals ?? 9;
        const isBid = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC";
        const baseType = isBid ? tokenOutCfg.type : tokenInCfg.type;
        const quoteType = isBid ? tokenInCfg.type : tokenOutCfg.type;
        const networkKey = network === "mainnet" ? "mainnet" as const : "testnet" as const;

        // Fetch lot size
        let currentLotSize = lotSize;
        try {
          const params = await getPoolBookParams(client, deepbookPoolId, baseType, quoteType, networkKey);
          currentLotSize = params.lotSize;
          setLotSize(params.lotSize);
          setMinSize(params.minSize);
        } catch { /* keep existing lotSize */ }

        const alignToLot = (raw: bigint) =>
          !isBid && currentLotSize > 1n ? (raw / currentLotSize) * currentLotSize : raw;

        // Step 1: Get exchange rate — bootstrap with 1 unit if not yet available
        let currentRate = exchangeRate;
        if (!currentRate) {
          const probeRaw = alignToLot(BigInt(Math.pow(10, tokenInDecimals)));
          if (probeRaw > 0n) {
            const probeEst = await estimateDeepBookSwap(client, deepbookPoolId, probeRaw, isBid, baseType, quoteType, networkKey);
            if (probeEst.isApproximate) {
              setAmountIn("");
              setExchangeRate(null);
              setPriceImpact(0);
              setEstimationWarning("Insufficient liquidity in DeepBook pool for this amount.");
              return;
            }
            const probeOut = Number(probeEst.amountOut) / Math.pow(10, tokenOutDecimals);
            if (probeOut > 0) currentRate = probeOut;
          }
        }
        if (!currentRate || currentRate <= 0) return;

        // Step 2: Approximate amountIn = amountOut / rate
        const approxInRaw = alignToLot(
          BigInt(Math.floor((amountOutFloat / currentRate) * Math.pow(10, tokenInDecimals)))
        );
        if (approxInRaw <= 0n) return;

        // Step 3: Run forward estimation to refine and get price impact
        const refined = await estimateDeepBookSwap(client, deepbookPoolId, approxInRaw, isBid, baseType, quoteType, networkKey);
        if (refined.isApproximate) {
          setAmountIn("");
          setExchangeRate(null);
          setPriceImpact(0);
          setEstimationWarning("Insufficient liquidity in DeepBook pool for this amount.");
          return;
        }
        const refinedOutFloat = Number(refined.amountOut) / Math.pow(10, tokenOutDecimals);

        // Step 4: Scale proportionally to hit the target output
        let finalInRaw = approxInRaw;
        if (refinedOutFloat > 0) {
          const scaled = BigInt(Math.floor(Number(approxInRaw) * (amountOutFloat / refinedOutFloat)));
          finalInRaw = alignToLot(scaled);
        }
        if (finalInRaw <= 0n) return;

        const finalInFloat = Number(finalInRaw) / Math.pow(10, tokenInDecimals);
        setAmountIn(finalInFloat.toFixed(tokenInDecimals));

        const approxInFloat = Number(approxInRaw) / Math.pow(10, tokenInDecimals);
        setExchangeRate(approxInFloat > 0 ? refinedOutFloat / approxInFloat : null);
        setPriceImpact(refined.priceImpact);
        setEstimationWarning(null);
      } catch (err) {
        console.error("Failed to estimate input:", err);
      } finally {
        setIsEstimatingReverse(false);
      }
    };

    const debounce = setTimeout(estimateInput, 500);
    return () => clearTimeout(debounce);
  }, [amountOut, activeInput, tokenInSymbol, tokenOutSymbol, client, tokenConfig, network]);

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

    const tokenInDecimals = tokenConfig?.[tokenInSymbol as keyof typeof tokenConfig]?.decimals ?? 9;
    const amountInSmallest = BigInt(Math.floor(parseFloat(amountIn) * Math.pow(10, tokenInDecimals)));

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

    // lotSize is in base asset (SUI) units — only align for ask (SUI→USDC), not bid (USDC→SUI)
    const isBid = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC";
    const amountInBase = (!isBid && lotSize > 1n)
      ? (amountInSmallest / lotSize) * lotSize
      : amountInSmallest;
    const amountOutBase = parseTokenAmount(amountOut, tokenOutConfig.decimals);
    // Slippage-adjusted minimum: this is what the ZKP commits to and the note is spendable for
    const minAmountOutBase = (amountOutBase * BigInt(10000 - slippage)) / 10000n;

    // Validate minimum order size (minSize is always in base asset / SUI units)
    if (!isBid) {
      // Ask (SUI→USDC): amountIn is base asset, compare directly
      if (amountInSmallest < minSize) {
        const minDisplay = Number(minSize) / Math.pow(10, tokenInDecimals);
        setError(`Minimum swap amount is ${minDisplay} ${tokenInSymbol} (DeepBook minimum order size)`);
        return;
      }
    } else {
      // Bid (USDC→SUI): minSize is in SUI output terms, validate estimated output
      const suiDecimals = tokenOutConfig.decimals;
      const estimatedBaseOut = parseTokenAmount(amountOut, suiDecimals);
      if (estimatedBaseOut < minSize) {
        const minDisplay = Number(minSize) / Math.pow(10, suiDecimals);
        setError(`Estimated SUI output must be at least ${minDisplay} SUI (DeepBook minimum order size)`);
        return;
      }
    }

    if (useRelayer && relayerStatus !== "online") {
      setError("Relayer is offline. Please check the relayer connection.");
      return;
    }

    const relayerClient = useRelayer && relayerUrl
      ? new RelayerClient({ url: relayerUrl, network: network === "mainnet" ? "mainnet" : "testnet" })
      : null;

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

      // Relayer handles its own DEEP — only validate when submitting directly
      if (!useRelayer) {
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
      }

      // 6. Build and submit transaction
      setState("submitting");

      let txDigest: string;

      if (relayerClient) {
        txDigest = await relayerClient.submitSwap({
          poolInId: tokenInConfig.poolId,
          poolOutId: tokenOutConfig.poolId,
          deepbookPoolId,
          tokenTypeIn: tokenInConfig.type,
          tokenTypeOut: tokenOutConfig.type,
          isBid,
          proofBytes: proof.proofBytes,
          publicInputsBytes: proof.publicInputsBytes,
          nullifiers,
          encryptedOutputNote,
          encryptedChangeNote,
        });
      } else {
        const tx = new Transaction();

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
        txDigest = result.digest;
      }

      // 7. Success!
      setState("success");
      const actualAmountOut = formatTokenAmount(swapNote.amount, tokenOutConfig.decimals);
      const actualAmountIn = formatTokenAmount(amountInBase, tokenInConfig.decimals);
      let successMessage = `Swapped ${actualAmountIn} ${tokenInSymbol} → ${actualAmountOut} ${tokenOutSymbol}`;
      if (changeNote.amount > 0n) {
        successMessage += ` (Change: ${formatTokenAmount(changeNote.amount, tokenInConfig.decimals)} ${tokenInSymbol})`;
      }
      setSuccess({
        message: successMessage,
        txDigest,
      });
      setAmountIn("");
      setAmountOut("");

      // 8. Trigger note rescan to pick up the output and change notes
      await onSuccess?.();
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Swap failed");
    }
  };

  const unspentNotes = notes.filter((n) => !n.spent);

  const tokenInConfig = tokenConfig?.[tokenInSymbol as keyof typeof tokenConfig];
  // lotSize is in base asset (SUI) units; don't apply it as step for bid (USDC input)
  const isBidForStep = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC";
  const tokenInDecimals = tokenInConfig?.decimals ?? 9;
  const lotSizeStep = (!isBidForStep && lotSize > 1n)
    ? Number(lotSize) / Math.pow(10, tokenInDecimals)
    : Math.pow(10, -tokenInDecimals);
  const maxAmountIn = unspentNotes
    .filter((n) => tokenInConfig && n.note.token === getTokenIdFromCoinType(tokenInConfig.type))
    .reduce((sum, n) => sum + n.note.amount, 0n);
  const handleMaxIn = () => {
    const decimals = tokenInConfig?.decimals ?? 9;
    setAmountIn((Number(maxAmountIn) / 10 ** decimals).toFixed(decimals));
  };

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
      <div className="space-y-4">
        {/* Token In */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
              From
            </label>
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
          </div>
          <NumberInput
            value={isEstimatingReverse ? "" : amountIn}
            onChange={(val) => {
              setAmountIn(val);
              setActiveInput("from");
            }}
            placeholder={isEstimatingReverse ? "Estimating..." : "0.0"}
            step={lotSizeStep}
            min={0}
            disabled={isEstimatingReverse || isProcessing}
            onMax={handleMaxIn}
          />
          {(() => {
            const tokenNotes = unspentNotes.filter(
              (n) => tokenInConfig && n.note.token === getTokenIdFromCoinType(tokenInConfig.type)
            );
            return (
              <NoteBalanceDisplay
                loading={_notesLoading}
                noteCount={tokenNotes.length}
                total={maxAmountIn}
                decimals={tokenInConfig?.decimals ?? 9}
                tokenSymbol={tokenInSymbol}
              />
            );
          })()}
          {amountIn && (() => {
            const decimals = tokenInConfig?.decimals ?? 9;
            const raw = BigInt(Math.floor(parseFloat(amountIn) * Math.pow(10, decimals)));
            const isBidInline = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC";
            // For bid (USDC→SUI): minSize is in SUI output terms — warn using estimated output
            if (isBidInline && minSize > 1n && !isEstimating && amountOut && parseFloat(amountOut) > 0) {
              const tokenOutConfig = tokenConfig?.[tokenOutSymbol as keyof typeof tokenConfig];
              const suiDecimals = tokenOutConfig?.decimals ?? 9;
              const estimatedBaseOut = parseTokenAmount(amountOut, suiDecimals);
              if (estimatedBaseOut < minSize) {
                const minDisplay = (Number(minSize) / Math.pow(10, suiDecimals)).toFixed(suiDecimals).replace(/\.?0+$/, '');
                return (
                  <p className="mt-1 text-[10px] text-yellow-400 font-mono">
                    ⚠ Estimated SUI output below minimum: {minDisplay} SUI required
                  </p>
                );
              }
            }
            // minSize is in base asset (SUI) units; only show inline warning for ask direction
            if (!isBidInline && minSize > 1n && raw < minSize) {
              const minDisplay = (Number(minSize) / Math.pow(10, decimals)).toFixed(decimals).replace(/\.?0+$/, '');
              return (
                <p className="mt-1 text-[10px] text-yellow-400 font-mono">
                  ⚠ Minimum swap amount is {minDisplay} {tokenInSymbol}
                </p>
              );
            }
            if (!isBidInline && lotSize > 1n) {
              const aligned = (raw / lotSize) * lotSize;
              if (raw !== aligned) {
                const alignedDisplay = (Number(aligned) / Math.pow(10, decimals)).toFixed(decimals).replace(/\.?0+$/, '');
                return (
                  <p className="mt-1 text-[10px] text-yellow-400 font-mono">
                    ⚠ Will round down to nearest lot size: {alignedDisplay} {tokenInSymbol}
                  </p>
                );
              }
            }
            return null;
          })()}
        </div>

        {/* Swap Direction Button */}
        <div className="relative flex justify-center">
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
          {!useRelayer && (
            <p className={cn(
              "absolute right-0 bottom-0 text-[10px] font-mono",
              selectedDeepCoin ? "text-gray-500" : "text-yellow-600"
            )}>
              {selectedDeepCoin
                ? `DEEP: ${formatTokenAmount(deepBalance?.data?.reduce((sum, c) => sum + BigInt(c.balance), 0n) ?? 0n, 6)}`
                : "⚠ No DEEP (higher fees)"}
            </p>
          )}
        </div>

        {/* Token Out */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
              {isTargetAmount ? "To (Target)" : "To (Estimated)"}
            </label>
            <select
              value={tokenOutSymbol}
              onChange={(e) => {
                const newTokenOut = e.target.value as "SUI" | "USDC" | "DBUSDC";
                setTokenOutSymbol(newTokenOut);
                setIsTargetAmount(false);
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
          </div>
          <NumberInput
            value={isEstimating ? "" : amountOut}
            onChange={(val) => {
              setAmountOut(val);
              if (val !== "" && parseFloat(val) > 0) {
                setIsTargetAmount(true);
                setActiveInput("to");
              } else {
                setIsTargetAmount(false);
                setActiveInput("from");
                setAmountIn("");
              }
            }}
            placeholder={isEstimating ? "Estimating..." : "0.0"}
            step={0.000000001}
            min={0}
            disabled={isEstimating || isProcessing}
          />
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
          {!isEstimating && exchangeRate !== null && (
            <p className="mt-2 text-[10px] text-gray-400 font-mono">
              <span className="text-gray-500">RATE:</span>{" "}
              <span className="text-cyber-blue font-bold">
                1 {tokenInSymbol} = {exchangeRate.toFixed(tokenConfig?.[tokenOutSymbol as keyof typeof tokenConfig]?.decimals ?? 6)} {tokenOutSymbol}
              </span>
            </p>
          )}
        </div>

        {/* Slippage Settings */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
              Slippage Tolerance
            </label>
            <span className="text-xs font-mono font-bold text-cyber-blue">
              {(slippage / 100).toFixed(1)}%
            </span>
          </div>
          <input
            type="range"
            min={10}
            max={1000}
            step={10}
            value={slippage}
            onChange={(e) => setSlippage(Number(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const delta = e.key === "ArrowUp" ? 100 : -100;
                setSlippage((prev) => Math.min(1000, Math.max(10, prev + delta)));
              }
            }}
            disabled={isProcessing}
            className="w-full h-1.5 appearance-none rounded-none cursor-pointer accent-cyber-blue bg-gray-800 disabled:opacity-50"
          />
          <div className="mt-1 flex justify-between text-[10px] text-gray-600 font-mono">
            <span>0.1%</span>
            <span>2.5%</span>
            <span>5%</span>
            <span>10%</span>
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

      {/* Relayer Selector */}
      <RelayerSelector
        network={network}
        disabled={isProcessing}
        onToggle={handleRelayerToggle}
      />

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
