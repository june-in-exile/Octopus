"use client";

import Image from "next/image";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function OverviewPage() {
  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* Page Title */}
        <div className="mb-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 border-t-2 border-r-2 border-cyber-blue/30 clip-corner opacity-50" />

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

            <h1 className="text-5xl md:text-6xl font-black tracking-tighter text-cyber-blue uppercase mb-4 text-cyber">
              PROTOCOL OVERVIEW
            </h1>

            <p className="text-gray-400 text-sm md:text-base tracking-wider font-mono max-w-2xl">
              Understanding how Octopus enables private transactions on Sui
            </p>
          </div>
        </div>

        {/* Concept Diagram */}
        <div className="card mb-12">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              ARCHITECTURE DIAGRAM
            </h2>
          </div>

          <div className="bg-white/5 rounded-lg p-6 border border-gray-800">
            <Image
              src="/concept.svg"
              alt="Octopus Protocol Architecture"
              width={1200}
              height={800}
              className="w-full h-auto"
              priority
            />
          </div>
        </div>

        {/* User Interactions */}
        <div className="card mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              USER INTERACTIONS
            </h2>
          </div>

          <div className="space-y-6">
            {/* Shield */}
            <div className="group border border-gray-800 p-6 hover:border-purple-500/50 transition-all clip-corner">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-cyber-blue/10 group-hover:bg-purple-500/10 flex items-center justify-center border border-cyber-blue/30 group-hover:border-purple-500/30 flex-shrink-0 transition-colors">
                  <span className="text-cyber-blue group-hover:text-purple-500 text-2xl transition-colors">▲</span>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold uppercase tracking-wider text-cyber-blue group-hover:text-purple-500 mb-2 transition-colors">
                    SHIELD (Deposit)
                  </h3>
                  <p className="text-gray-400 text-sm font-mono leading-relaxed mb-3">
                    Users deposit tokens into the privacy pool, converting them into encrypted notes.
                    Each note is represented by a commitment stored in a Merkle tree, making it
                    indistinguishable from other notes.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-2 py-1 text-xs font-mono bg-cyber-blue/10 group-hover:bg-purple-500/10 text-cyber-blue group-hover:text-purple-500 border border-cyber-blue/30 group-hover:border-purple-500/30 transition-colors">
                      NO ZK PROOF REQUIRED
                    </span>
                    <span className="px-2 py-1 text-xs font-mono bg-gray-800/50 text-gray-400 border border-gray-700">
                      ENCRYPTION: ChaCha20-Poly1305
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Transfer */}
            <div className="group border border-gray-800 p-6 hover:border-purple-500/50 transition-all clip-corner">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-cyber-blue/10 group-hover:bg-purple-500/10 flex items-center justify-center border border-cyber-blue/30 group-hover:border-purple-500/30 flex-shrink-0 transition-colors">
                  <span className="text-cyber-blue group-hover:text-purple-500 text-2xl transition-colors">⇄</span>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold uppercase tracking-wider text-cyber-blue group-hover:text-purple-500 mb-2 transition-colors">
                    TRANSFER (Private Payment)
                  </h3>
                  <p className="text-gray-400 text-sm font-mono leading-relaxed mb-3">
                    Send tokens privately to another user within the pool. Each transaction accepts
                    up to 2 input notes and produces 1 transfer note to the recipient, plus 1 change
                    note if any remainder exists — completely hiding sender, recipient, and amount
                    from observers.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-2 py-1 text-xs font-mono bg-cyber-blue/10 group-hover:bg-purple-500/10 text-cyber-blue group-hover:text-purple-500 border border-cyber-blue/30 group-hover:border-purple-500/30 transition-colors">
                      ZK PROOF VERIFIED
                    </span>
                    <span className="px-2 py-1 text-xs font-mono bg-gray-800/50 text-gray-400 border border-gray-700">
                      2-INPUT / 2-OUTPUT UTXO
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Swap */}
            <div className="group border border-gray-800 p-6 hover:border-purple-500/50 transition-all clip-corner">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-cyber-blue/10 group-hover:bg-purple-500/10 flex items-center justify-center border border-cyber-blue/30 group-hover:border-purple-500/30 flex-shrink-0 transition-colors">
                  <span className="text-cyber-blue group-hover:text-purple-500 text-2xl transition-colors">⇌</span>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold uppercase tracking-wider text-cyber-blue group-hover:text-purple-500 mb-2 transition-colors">
                    SWAP (Private Exchange)
                  </h3>
                  <p className="text-gray-400 text-sm font-mono leading-relaxed mb-3">
                    Exchange tokens privately through integrated DEXs. The swap happens within the
                    privacy pool, maintaining anonymity while leveraging external liquidity sources
                    like DeepBook V3.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-2 py-1 text-xs font-mono bg-cyber-blue/10 group-hover:bg-purple-500/10 text-cyber-blue group-hover:text-purple-500 border border-cyber-blue/30 group-hover:border-purple-500/30 transition-colors">
                      ZK PROOF VERIFIED
                    </span>
                    <span className="px-2 py-1 text-xs font-mono bg-gray-800/50 text-gray-400 border border-gray-700">
                      DEEPBOOK V3
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Unshield */}
            <div className="group border border-gray-800 p-6 hover:border-purple-500/50 transition-all clip-corner">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-cyber-blue/10 group-hover:bg-purple-500/10 flex items-center justify-center border border-cyber-blue/30 group-hover:border-purple-500/30 flex-shrink-0 transition-colors">
                  <span className="text-cyber-blue group-hover:text-purple-500 text-2xl transition-colors">▼</span>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold uppercase tracking-wider text-cyber-blue group-hover:text-purple-500 mb-2 transition-colors">
                    UNSHIELD (Withdraw)
                  </h3>
                  <p className="text-gray-400 text-sm font-mono leading-relaxed mb-3">
                    Withdraw tokens from the privacy pool using ZK proofs. The proof verifies ownership
                    without revealing which deposit it came from, breaking the link between deposits
                    and withdrawals.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-2 py-1 text-xs font-mono bg-cyber-blue/10 group-hover:bg-purple-500/10 text-cyber-blue group-hover:text-purple-500 border border-cyber-blue/30 group-hover:border-purple-500/30 transition-colors">
                      ZK PROOF VERIFIED
                    </span>
                    <span className="px-2 py-1 text-xs font-mono bg-gray-800/50 text-gray-400 border border-gray-700">
                      AUTO CHANGE NOTES
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Relayer Network */}
        <div className="card mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-purple to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-purple">
              COMING SOON: RELAYER NETWORK
            </h2>
          </div>

          <p className="text-gray-400 text-sm font-mono mb-6">
            Today, users submit transactions directly from their wallets — which means your public
            address is visible on-chain, even if the contents of your notes are hidden. A relayer
            network eliminates this last remaining metadata leak.
          </p>

          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div className="border border-red-500/20 bg-red-500/5 p-4 rounded">
              <h3 className="text-sm font-bold text-red-400 uppercase mb-3">WITHOUT RELAYER</h3>
              <ul className="text-xs text-gray-400 font-mono space-y-2">
                <li><span className="text-red-400">•</span> Sender&apos;s public address is exposed on-chain</li>
                <li><span className="text-red-400">•</span> Gas payment source is traceable</li>
                <li><span className="text-red-400">•</span> Transaction timing reveals behavioral patterns</li>
                <li><span className="text-red-400">•</span> Shield / unshield operations can be correlated</li>
              </ul>
            </div>

            <div className="border border-green-500/20 bg-green-500/5 p-4 rounded">
              <h3 className="text-sm font-bold text-green-400 uppercase mb-3">WITH RELAYER</h3>
              <ul className="text-xs text-gray-400 font-mono space-y-2">
                <li><span className="text-green-400">•</span> Transactions appear to originate from relayer addresses</li>
                <li><span className="text-green-400">•</span> User&apos;s public address never touches the privacy pool</li>
                <li><span className="text-green-400">•</span> Gas paid by relayer, reimbursed in shielded tokens</li>
                <li><span className="text-green-400">•</span> On-chain correlation between operations is broken</li>
              </ul>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="px-2 py-1 text-xs font-mono bg-cyber-purple/10 text-cyber-purple border border-cyber-purple/30">
              PLANNED
            </span>
            <span className="px-2 py-1 text-xs font-mono bg-gray-800/50 text-gray-400 border border-gray-700">
              DECENTRALIZED BROADCASTER NETWORK
            </span>
            <span className="px-2 py-1 text-xs font-mono bg-gray-800/50 text-gray-400 border border-gray-700">
              FEE IN SHIELDED TOKENS
            </span>
          </div>
        </div>

        {/* Privacy Benefits */}
        <div className="card">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              PRIVACY GUARANTEES
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="border border-gray-800 p-4 clip-corner">
              <h3 className="text-sm font-bold uppercase tracking-wider text-cyber-blue mb-2">
                SENDER ANONYMITY
              </h3>
              <p className="text-xs text-gray-400 font-mono leading-relaxed">
                ZK proofs hide the sender's identity by not revealing which note is being spent
              </p>
            </div>

            <div className="border border-gray-800 p-4 clip-corner">
              <h3 className="text-sm font-bold uppercase tracking-wider text-cyber-blue mb-2">
                RECIPIENT PRIVACY
              </h3>
              <p className="text-xs text-gray-400 font-mono leading-relaxed">
                Output notes are encrypted, only decryptable by the intended recipient
              </p>
            </div>

            <div className="border border-gray-800 p-4 clip-corner">
              <h3 className="text-sm font-bold uppercase tracking-wider text-cyber-blue mb-2">
                AMOUNT CONFIDENTIALITY
              </h3>
              <p className="text-xs text-gray-400 font-mono leading-relaxed">
                Transaction amounts are hidden within encrypted notes, not visible on-chain
              </p>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
