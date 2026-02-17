"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentAccount, useSuiClientContext } from "@mysten/dapp-kit";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { KeypairSetup } from "@/components/KeypairSetup";
import { BalanceCard } from "@/components/BalanceCard";
import { AvailableNotesList } from "@/components/AvailableNotesList";
import { ShieldForm } from "@/components/ShieldForm";
import { UnshieldForm } from "@/components/UnshieldForm";
import { TransferForm } from "@/components/TransferForm";
import { SwapForm } from "@/components/SwapForm";
import { useLocalKeypair } from "@/hooks/useLocalKeypair";
import { useNotes } from "@/hooks/useNotes";
import { usePoolInfo } from "@/hooks/usePoolInfo";
import { useBalance } from "@/hooks/useBalance";
import type { TokenConfig } from "@/lib/constants";
import { useNetworkConfig } from "@/providers/NetworkConfigProvider";
import { getWorkerManager } from "@/lib/workerManager";
import { initPoseidon } from "@/lib/poseidon";

type TabType = "shield" | "unshield" | "transfer" | "swap";
type TokenSymbol = "SUI" | "USDC" | "DBUSDC";

export default function Home() {
  const account = useCurrentAccount();
  const { network } = useSuiClientContext();
  const { packageId, originalPackageId, tokens, graphqlUrl, isConfigured } = useNetworkConfig();
  const isMainnet = network === "mainnet";
  const [activeTab, setActiveTab] = useState<TabType>("shield");
  const [selectedToken, setSelectedToken] = useState<TokenSymbol>("SUI");
  const tokenConfig: TokenConfig | null = tokens?.[selectedToken] ?? null;

  // Initialize Poseidon early to prevent race conditions
  useEffect(() => {
    initPoseidon().catch((err) => {
      console.error("[App] Failed to initialize Poseidon:", err);
    });
  }, []);

  const {
    keypair,
    isLoading,
    savedKeypairs,
    generateKeypair,
    selectKeypair,
    clearKeypair,
    removeKeypair,
    restoreKeypair,
    renameKeypair,
  } = useLocalKeypair(account?.address);

  // Fetch all notes from blockchain (includes Merkle proofs)
  // Loads in background as soon as keypair is selected
  // Pass isLoading to prevent showing 0 balance during initialization
  const {
    notes,
    loading: isLoadingNotes,
    error: notesError,
    refresh: refreshNotes,
    forceFullRefresh: forceFullRefreshNotes,
    lastScanStats,
  } = useNotes(keypair, isLoading, tokenConfig?.poolId ?? "", tokenConfig?.type ?? "");

  // Fetch wallet balance for ShieldForm
  const { balance: walletBalance, loading: isLoadingBalance } = useBalance(account, tokenConfig);

  // Pool note counts — scanned once at startup for all pools, updated after operations
  const [workerNoteCounts, setWorkerNoteCounts] = useState<Record<string, number>>({});

  const refreshAllPoolCounts = useCallback(async () => {
    if (!tokens || !packageId || !originalPackageId || !graphqlUrl) return;
    const worker = getWorkerManager();
    const results = await Promise.allSettled(
      Object.values(tokens).map(async (token) => {
        const count = await worker.countPoolNotes(graphqlUrl, originalPackageId, token.poolId);
        return { poolId: token.poolId, count };
      })
    );
    const updates: Record<string, number> = {};
    for (const result of results) {
      if (result.status === "fulfilled") {
        updates[result.value.poolId] = result.value.count;
      }
    }
    setWorkerNoteCounts((prev) => ({ ...prev, ...updates }));
  }, [tokens, packageId, originalPackageId, graphqlUrl]);

  // Scan all pools at startup
  useEffect(() => {
    refreshAllPoolCounts();
  }, [refreshAllPoolCounts]);

  // Fetch pool information for refresh only
  const { refresh: refreshPoolInfo } = usePoolInfo(tokenConfig?.poolId ?? "");

  // Calculate balance and note count from loaded notesamount
  const unspentNotes = notes.filter((n) => !n.spent);
  const shieldedBalance = unspentNotes.reduce((sum, n) => sum + (n.displayAmount ?? n.note.amount), 0n);
  const noteCount = unspentNotes.length;
  
  const handleOperationSuccess = async () => {
    // Refresh notes and pool info from blockchain after successful operation
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    forceFullRefreshNotes();
    refreshPoolInfo();
    refreshAllPoolCounts();
  };

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-12 relative overflow-hidden">
          {/* Top corner accent */}
          <div className="absolute top-0 right-0 w-32 h-32 border-t-2 border-r-2 border-cyber-blue/30 clip-corner opacity-50" />

          {/* Main title section */}
          <div className="relative border-l-2 border-cyber-blue/50 pl-6 py-8 pr-4">
            {/* Scanning line effect - sweeps across the entire title section */}
            <div className="absolute inset-0 -left-6 -right-4 pointer-events-none z-20 overflow-hidden">
              <div className="absolute w-full h-[3px] top-0 animate-scan-full">
                {/* Outer glow */}
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-cyber-blue to-transparent opacity-60 blur-md" />
                {/* Main scanning line */}
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-cyber-blue to-transparent opacity-60" />
                {/* Bright core */}
                <div className="absolute inset-0 h-[1px] top-1/2 -translate-y-1/2 bg-gradient-to-r from-transparent via-white to-transparent" />
              </div>
            </div>
            {/* Animated line */}
            <div className="absolute left-0 top-0 w-0.5 h-full bg-gradient-to-b from-cyber-blue via-cyber-purple to-transparent animate-pulse-slow" />

            {/* Status indicator - fixed position */}
            <div className="absolute top-8 right-4 flex flex-col gap-1 text-xs text-gray-600 font-mono">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-cyber-blue rounded-full animate-pulse" />
                <span>ACTIVE</span>
              </div>
              <div className="flex items-center gap-2 opacity-70">
                <span className="w-1 h-1 bg-cyber-purple rounded-full" />
                <span className="text-[12px]">v1.0</span>
              </div>
            </div>

            <div className="mb-6">
              <div className="relative">
                <h1 className="text-6xl md:text-7xl font-black tracking-tighter text-cyber-blue uppercase relative z-10 text-cyber">
                  O.C.T.O.P.U.S.
                </h1>
                <div className="absolute -inset-2 bg-cyber-blue/10 blur-2xl -z-10" />
              </div>
            </div>

            {/* Subtitle with grid accent */}
            <div className="relative">
              <div className="absolute -left-6 top-0 w-1 h-full bg-gradient-to-b from-transparent via-cyber-purple/30 to-transparent" />
              <p className="text-gray-400 text-sm md:text-base tracking-wider font-mono mb-4 max-w-2xl">
                On-Chain Transaction Obfuscation Protocol Underlying Sui
              </p>
              <div className="space-y-1.5">
                {packageId && (
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-gray-500 uppercase tracking-wider">Package:</span>
                    <a
                      href={`https://${network}.suivision.xyz/package/${packageId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-cyber-blue hover:text-cyber-purple/80 transition-colors truncate max-w-md"
                      title={packageId}
                    >
                      {packageId.slice(0, 8)}...{packageId.slice(-6)}
                    </a>
                  </div>
                )}
                {tokens && Object.values(tokens).map((token) => (
                  <div key={token.symbol} className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-gray-500 uppercase tracking-wider">{token.symbol} Pool:</span>
                    <a
                      href={`https://${network}.suivision.xyz/object/${token.poolId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-cyber-blue hover:text-cyber-purple/80 transition-colors"
                      title={token.poolId}
                    >
                      {token.poolId.slice(0, 8)}...{token.poolId.slice(-6)}
                    </a>
                    <span className="text-gray-500">
                      {" | "}Type:
                      <span className="text-cyber-blue ml-1">{token.symbol}</span>
                      {" | "}Total Notes:
                      <span className="text-cyber-blue ml-1">
                        {workerNoteCounts[token.poolId]?.toLocaleString() ?? "—"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Bottom corner accent */}
          <div className="absolute bottom-0 left-0 w-24 h-24 border-b-2 border-l-2 border-cyber-purple/20 clip-corner opacity-30" />
        </div>

        {!account ? (
          // Not connected state
          <div className="mx-auto max-w-xl">
            <div className="card-glow text-center py-12">
              <h2 className="mb-3 text-2xl font-black uppercase tracking-wider text-cyber-blue text-cyber">
                WALLET CONNECTION REQUIRED
              </h2>
              <div className="mt-6 h-px bg-gradient-to-r from-transparent via-cyber-blue to-transparent" />
            </div>
          </div>
        ) : (
          // Connected state
          <>
            {!isConfigured && (
              <div className="mb-6 p-3 border border-amber-600/40 bg-amber-900/20 clip-corner">
                <p className="text-xs text-amber-400 font-mono">
                  ⚠ No contract deployed on <span className="font-bold uppercase">{network}</span>. Switch to Testnet or deploy contracts first.
                </p>
              </div>
            )}
            <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
              {/* Left Column */}
              <div className="space-y-6">
                <KeypairSetup
                  keypair={keypair}
                  isLoading={isLoading}
                  savedKeypairs={savedKeypairs}
                  onGenerate={generateKeypair}
                  onSelect={selectKeypair}
                  onClear={clearKeypair}
                  onRemove={removeKeypair}
                  onRestore={restoreKeypair}
                  onRename={renameKeypair}
                />
                {tokenConfig && (
                  <>
                    <BalanceCard
                      shieldedBalance={shieldedBalance}
                      noteCount={noteCount}
                      tokenConfig={tokenConfig}
                      isLoading={isLoading}
                      isRefreshing={isLoadingNotes}
                      onRefresh={refreshNotes}
                    />
                    <AvailableNotesList
                      notes={notes}
                      loading={isLoadingNotes}
                      error={notesError}
                      tokenConfig={tokenConfig}
                      lastScanStats={lastScanStats}
                    />
                  </>
                )}
              </div>

              {/* Right Column */}
              <div className="space-y-6">
                {/* Token Selector */}
                <div className="card">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Token:</span>
                    {(tokens ? Object.keys(tokens) as TokenSymbol[] : ["SUI", "USDC"] as TokenSymbol[]).map((sym) => (
                      <button
                        key={sym}
                        onClick={() => setSelectedToken(sym)}
                        className={`text-xs font-mono px-3 py-1 border transition-colors ${selectedToken === sym
                          ? "border-cyber-blue text-cyber-blue bg-cyber-blue/10"
                          : "border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300"
                          }`}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tab Navigation */}
                <div className="card">
                  <div className="flex border-b-2 border-gray-800 relative">
                    <button
                      onClick={() => setActiveTab("shield")}
                      className={`tab-button flex-1 ${activeTab === "shield"
                        ? "text-cyber-blue active"
                        : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                      ▲ SHIELD
                    </button>
                    <button
                      onClick={() => setActiveTab("transfer")}
                      className={`tab-button flex-1 ${activeTab === "transfer"
                        ? "text-cyber-blue active"
                        : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                      ⇄ TRANSFER
                    </button>
                    <button
                      onClick={() => setActiveTab("swap")}
                      className={`tab-button flex-1 flex flex-col items-center gap-0.5 ${activeTab === "swap"
                        ? "text-cyber-blue active"
                        : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                      <span>⇌ SWAP</span>
                      {!isMainnet && (
                        <span className="text-[8px] text-green-500/70 font-mono">TEST MODE</span>
                      )}
                    </button>
                    <button
                      onClick={() => setActiveTab("unshield")}
                      className={`tab-button flex-1 ${activeTab === "unshield"
                        ? "text-cyber-blue active"
                        : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                      ▼ UNSHIELD
                    </button>
                  </div>

                  {/* Tab Content */}
                  <div className="p-6">
                    {!tokenConfig ? (
                      <p className="text-xs text-amber-400 font-mono text-center py-4">
                        ⚠ No contract on {network}
                      </p>
                    ) : (
                      <>
                        {activeTab === "shield" && (
                          <ShieldForm
                            keypair={keypair}
                            tokenConfig={tokenConfig}
                            balance={walletBalance}
                            loading={isLoadingBalance}
                            onSuccess={handleOperationSuccess}
                          />
                        )}
                        {activeTab === "transfer" && (
                          <TransferForm
                            keypair={keypair}
                            tokenConfig={tokenConfig}
                            maxAmount={shieldedBalance}
                            notes={notes}
                            loading={isLoadingNotes}
                            onSuccess={handleOperationSuccess}
                          />
                        )}
                        {activeTab === "swap" && (
                          <SwapForm
                            keypair={keypair}
                            notes={notes}
                            loading={isLoadingNotes}
                            selectedToken={selectedToken}
                            onSuccess={handleOperationSuccess}
                          />
                        )}
                        {activeTab === "unshield" && (
                          <UnshieldForm
                            keypair={keypair}
                            tokenConfig={tokenConfig}
                            maxAmount={shieldedBalance}
                            notes={notes}
                            loading={isLoadingNotes}
                            onSuccess={handleOperationSuccess}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Info Section */}
        <div className="mt-16 card border-gray-800">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              PROTOCOL WORKFLOW
            </h2>
          </div>
          <div className="grid gap-6 md:grid-cols-5">
            <div className="group relative p-4 border border-gray-800 hover:border-cyber-blue transition-all duration-300 clip-corner">
              <div className="absolute top-0 right-0 text-6xl font-black text-gray-900 opacity-20 select-none">01</div>
              <div className="relative z-10">
                <div className="mb-3 w-10 h-10 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30">
                  <span className="text-cyber-blue text-xl">▲</span>
                </div>
                <h3 className="mb-2 font-bold uppercase tracking-wider text-cyber-blue text-sm">
                  SHIELD
                </h3>
                <p className="text-xs text-gray-400 font-mono leading-relaxed">
                  Deposit SUI into privacy pool. Tokens converted to encrypted notes.
                </p>
              </div>
            </div>
            <div className="group relative p-4 border border-gray-800 hover:border-cyber-blue transition-all duration-300 clip-corner">
              <div className="absolute top-0 right-0 text-6xl font-black text-gray-900 opacity-20 select-none">04</div>
              <div className="relative z-10">
                <div className="mb-3 w-10 h-10 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30">
                  <span className="text-cyber-blue text-xl">●</span>
                </div>
                <h3 className="mb-2 font-bold uppercase tracking-wider text-cyber-blue text-sm">
                  HOLD
                </h3>
                <p className="text-xs text-gray-400 font-mono leading-relaxed">
                  Shielded balance encrypted. Only accessible with your keypair.
                </p>
              </div>
            </div>
            <div className="group relative p-4 border border-gray-800 hover:border-cyber-blue transition-all duration-300 clip-corner">
              <div className="absolute top-0 right-0 text-6xl font-black text-gray-900 opacity-20 select-none">02</div>
              <div className="relative z-10">
                <div className="mb-3 w-10 h-10 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30">
                  <span className="text-cyber-blue text-xl">⇄</span>
                </div>
                <h3 className="mb-2 font-bold uppercase tracking-wider text-cyber-blue text-sm">
                  TRANSFER
                </h3>
                <p className="text-xs text-gray-400 font-mono leading-relaxed">
                  Private transactions within pool. Sender, recipient, amount hidden.
                </p>
              </div>
            </div>
            <div className="group relative p-4 border border-gray-800 hover:border-cyber-blue transition-all duration-300 clip-corner">
              <div className="absolute top-0 right-0 text-6xl font-black text-gray-900 opacity-20 select-none">03</div>
              <div className="relative z-10">
                <div className="mb-3 w-10 h-10 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30">
                  <span className="text-cyber-blue text-xl">⇌</span>
                </div>
                <h3 className="mb-2 font-bold uppercase tracking-wider text-cyber-blue text-sm">
                  SWAP
                </h3>
                <p className="text-xs text-gray-400 font-mono leading-relaxed">
                  Private token swaps. Exchange tokens while maintaining full privacy.
                </p>
              </div>
            </div>
            <div className="group relative p-4 border border-gray-800 hover:border-cyber-blue transition-all duration-300 clip-corner">
              <div className="absolute top-0 right-0 text-6xl font-black text-gray-900 opacity-20 select-none">05</div>
              <div className="relative z-10">
                <div className="mb-3 w-10 h-10 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30">
                  <span className="text-cyber-blue text-xl">▼</span>
                </div>
                <h3 className="mb-2 font-bold uppercase tracking-wider text-cyber-blue text-sm">
                  UNSHIELD
                </h3>
                <p className="text-xs text-gray-400 font-mono leading-relaxed">
                  Withdraw via ZK-proof. Deposit-withdrawal linkage impossible.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
