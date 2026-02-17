"use client";

import Image from "next/image";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function DeveloperPage() {
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
              DEVELOPER GUIDE
            </h1>

            <p className="text-gray-400 text-sm md:text-base tracking-wider font-mono max-w-2xl">
              Technical implementation details and cryptographic primitives
            </p>
          </div>
        </div>

        {/* Cryptographic Primitives Diagram */}
        <div className="card mb-12">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              CRYPTOGRAPHIC PRIMITIVES
            </h2>
          </div>

          <div className="bg-white/5 rounded-lg p-6 border border-gray-800">
            <Image
              src="/technical.svg"
              alt="Cryptographic Primitives"
              width={1200}
              height={800}
              className="w-full h-auto"
              priority
            />
          </div>
        </div>

        {/* Key Hierarchy */}
        <div className="card mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              KEY DERIVATION HIERARCHY
            </h2>
          </div>

          <div className="space-y-4">
            <div className="bg-gray-900/50 border border-gray-800 rounded p-4 font-mono text-sm">
              <div className="text-cyber-blue mb-2">// Master Keys</div>
              <div className="text-gray-300 space-y-1">
                <div><span className="text-cyber-purple">nullifying_key</span> = Poseidon(<span className="text-yellow-400">spending_key</span>, 1)</div>
                <div><span className="text-cyber-purple">MPK</span> = Poseidon(<span className="text-yellow-400">spending_key</span>, <span className="text-cyber-purple">nullifying_key</span>)</div>
              </div>
            </div>

            <div className="bg-gray-900/50 border border-gray-800 rounded p-4 font-mono text-sm">
              <div className="text-cyber-blue mb-2">// Viewing Keys (for note encryption/decryption)</div>
              <div className="text-gray-300 space-y-1">
                <div><span className="text-cyber-purple">viewing_private_key</span> = X25519(SHA256(<span className="text-yellow-400">spending_key</span>))</div>
                <div><span className="text-cyber-purple">viewing_public_key</span> = X25519.publicKey(<span className="text-cyber-purple">viewing_private_key</span>)</div>
              </div>
            </div>

            <div className="bg-gray-900/50 border border-gray-800 rounded p-4 font-mono text-sm">
              <div className="text-cyber-blue mb-2">// Note Creation</div>
              <div className="text-gray-300 space-y-1">
                <div><span className="text-cyber-purple">NSK</span> = Poseidon(<span className="text-cyber-purple">MPK</span>, <span className="text-green-400">random</span>)</div>
                <div><span className="text-cyber-purple">commitment</span> = Poseidon(<span className="text-cyber-purple">NSK</span>, <span className="text-green-400">token</span>, <span className="text-green-400">value</span>)</div>
              </div>
            </div>

            <div className="bg-gray-900/50 border border-gray-800 rounded p-4 font-mono text-sm">
              <div className="text-cyber-blue mb-2">// Spending (Double-Spend Prevention)</div>
              <div className="text-gray-300">
                <div><span className="text-cyber-purple">nullifier</span> = Poseidon(<span className="text-yellow-400">nullifying_key</span>, <span className="text-green-400">leaf_index</span>)</div>
              </div>
            </div>
          </div>

          <div className="mt-6 p-4 bg-cyber-blue/5 border border-cyber-blue/30 rounded">
            <h3 className="text-sm font-bold text-cyber-blue mb-2 uppercase">KEY PROPERTIES</h3>
            <ul className="text-xs text-gray-400 font-mono space-y-2">
              <li><span className="text-red-400">•</span> <span className="text-yellow-400">spending_key</span>: Root secret — <span className="text-red-400">must be kept private and backed up</span>. It is the only way to recover your account; losing it means permanent loss of all shielded funds.</li>
              <li><span className="text-red-400">•</span> <span className="text-cyber-purple">nullifying_key</span>: Derived from spending_key — <span className="text-red-400">must be kept private</span>. Exposure allows an attacker to generate your nullifiers and front-run your spends.</li>
              <li><span className="text-cyber-blue">•</span> <span className="text-cyber-purple">MPK</span>: Master Public Key — safe to share. Senders need your MPK to create a note commitment addressed to you.</li>
              <li><span className="text-cyber-blue">•</span> <span className="text-cyber-purple">viewing_private_key</span>: Derived via X25519(SHA256(spending_key)) — used locally to decrypt incoming notes. Never leave the client.</li>
              <li><span className="text-cyber-blue">•</span> <span className="text-cyber-purple">viewing_public_key</span>: Safe to share. Senders need your VPK to encrypt the note payload so only you can read it. Together with MPK, it forms your <span className="text-white">transfer address</span>.</li>
              <li><span className="text-cyber-blue">•</span> <span className="text-cyber-purple">NSK</span>: Note Secret Key — unique per note, derived from MPK and a random value.</li>
              <li><span className="text-cyber-blue">•</span> <span className="text-cyber-purple">commitment</span>: Public commitment to a note, stored in the Merkle tree.</li>
              <li><span className="text-cyber-blue">•</span> <span className="text-cyber-purple">nullifier</span>: Unique identifier for a spent note, prevents double-spending.</li>
            </ul>
          </div>

          <div className="mt-4 p-4 bg-yellow-500/5 border border-yellow-500/30 rounded">
            <h3 className="text-sm font-bold text-yellow-400 mb-2 uppercase">SENDING A TRANSFER</h3>
            <p className="text-xs text-gray-400 font-mono leading-relaxed">
              To send tokens to another user, you need their <span className="text-cyber-purple">MPK</span> and <span className="text-cyber-purple">viewing_public_key (VPK)</span>.
              MPK is used to derive the output note commitment; VPK is used to encrypt the note payload via ECDH so only the recipient can decrypt it.
              Both values together act as the recipient&apos;s <span className="text-white">shielded address</span>.
            </p>
          </div>
        </div>

        {/* Shield Operation */}
        <div className="card mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              ▲ SHIELD OPERATION
            </h2>
          </div>

          <p className="text-gray-400 text-sm font-mono mb-6">
            Deposit tokens into the privacy pool by creating an encrypted note commitment
          </p>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-cyber-blue uppercase mb-3">PROCESS FLOW</h3>
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">1</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Generate Note Parameters</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Create random value for NSK derivation, compute NSK = Poseidon(MPK, random)
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">2</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Compute Commitment</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      commitment = Poseidon(NSK, token_id, amount)
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">3</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Encrypt Note Data</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Encrypt (NSK, token, value, random) using ChaCha20-Poly1305 with recipient's viewing key
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">4</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Submit to Pool</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Call pool::shield(pool, coin, commitment, encrypted_note) - NO ZK PROOF REQUIRED
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-green-500/5 border border-green-500/30 rounded">
              <h3 className="text-sm font-bold text-green-400 mb-2 uppercase">RESULT</h3>
              <ul className="text-xs text-gray-400 font-mono space-y-1">
                <li><span className="text-green-400">•</span> Commitment added to Merkle tree</li>
                <li><span className="text-green-400">•</span> Encrypted note stored on-chain via event</li>
                <li><span className="text-green-400">•</span> User's public balance decreases</li>
                <li><span className="text-green-400">•</span> Shielded balance increases (only visible to user)</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Unshield Operation */}
        <div className="card mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              ▼ UNSHIELD OPERATION
            </h2>
          </div>

          <p className="text-gray-400 text-sm font-mono mb-6">
            Withdraw tokens from the privacy pool using a zero-knowledge proof of ownership
          </p>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-cyber-blue uppercase mb-3">PROCESS FLOW</h3>
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">1</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Select Input Note</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Choose an unspent note with sufficient balance for withdrawal
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">2</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Compute Nullifier</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      nullifier = Poseidon(nullifying_key, leaf_index) - prevents double-spending
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">3</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Create Change Note (if needed)</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      If input_value &gt; withdraw_amount, create change commitment for remaining balance
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">4</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Generate ZK Proof</h4>
                    <p className="text-xs text-gray-400 font-mono mb-2">
                      Prove: (1) ownership of note, (2) note exists in Merkle tree, (3) correct nullifier,
                      (4) balance conservation, (5) correct change commitment
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">5</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Submit to Pool</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Call pool::unshield(pool, proof, public_inputs, recipient, encrypted_change_note)
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-green-500/5 border border-green-500/30 rounded">
              <h3 className="text-sm font-bold text-green-400 mb-2 uppercase">RESULT</h3>
              <ul className="text-xs text-gray-400 font-mono space-y-1">
                <li><span className="text-green-400">•</span> ZK proof verified on-chain</li>
                <li><span className="text-green-400">•</span> Nullifier marked as spent (prevents double-spending)</li>
                <li><span className="text-green-400">•</span> Tokens transferred to recipient address</li>
                <li><span className="text-green-400">•</span> Change note added to Merkle tree (if any)</li>
                <li><span className="text-green-400">•</span> No link between deposit and withdrawal revealed</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Transfer Operation */}
        <div className="card mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              ⇄ TRANSFER OPERATION
            </h2>
          </div>

          <p className="text-gray-400 text-sm font-mono mb-6">
            Privately transfer tokens using 2 inputs to generate a recipient note and optional change, completely hiding sender, receiver, and value from observers.
          </p>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-cyber-blue uppercase mb-3">PROCESS FLOW</h3>
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">1</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Select Input Notes</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Choose up to 2 unspent notes with sufficient total balance. If only 1 note needed, use a dummy note.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">2</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Create Output Notes</h4>
                    <p className="text-xs text-gray-400 font-mono mb-1">
                      Output 1: Recipient's note with transfer amount
                    </p>
                    <p className="text-xs text-gray-400 font-mono">
                      Output 2: Sender's change note with remaining balance
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">3</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Compute Nullifiers</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Generate nullifier for each input note to mark them as spent
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">4</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Generate ZK Proof</h4>
                    <p className="text-xs text-gray-400 font-mono mb-2">
                      Prove: (1) ownership of input notes, (2) inputs exist in Merkle tree,
                      (3) correct nullifiers, (4) balance conservation (in = out), (5) valid output commitments
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">5</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Submit to Pool</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Call pool::transfer(pool, proof, public_inputs, encrypted_notes)
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-green-500/5 border border-green-500/30 rounded">
              <h3 className="text-sm font-bold text-green-400 mb-2 uppercase">RESULT</h3>
              <ul className="text-xs text-gray-400 font-mono space-y-1">
                <li><span className="text-green-400">•</span> ZK proof verified on-chain</li>
                <li><span className="text-green-400">•</span> Input nullifiers marked as spent</li>
                <li><span className="text-green-400">•</span> Output commitments added to Merkle tree</li>
                <li><span className="text-green-400">•</span> Sender, recipient, and amount remain hidden</li>
                <li><span className="text-green-400">•</span> Only recipient can decrypt their note using viewing key</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Swap Operation */}
        <div className="card mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
            <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
              ⇌ SWAP OPERATION
            </h2>
          </div>

          <p className="text-gray-400 text-sm font-mono mb-6">
            Exchange tokens privately via DeepBook V3, spending shielded input notes and receiving shielded output notes
          </p>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-cyber-blue uppercase mb-3">PROCESS FLOW</h3>
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">1</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Select Input Notes</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Choose up to 2 unspent notes of the input token with sufficient total balance
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">2</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Compute Swap Data Hash</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Hash swap parameters (token_in, token_out, amount_in, min_amount_out) to bind them to the proof
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">3</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Create Output Notes</h4>
                    <p className="text-xs text-gray-400 font-mono mb-1">
                      Output note: recipient commitment for the swapped token_out amount
                    </p>
                    <p className="text-xs text-gray-400 font-mono">
                      Change note: sender's change commitment if input exceeds amount_in
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">4</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Generate ZK Proof</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Prove: (1) ownership of input notes, (2) inputs exist in Merkle tree,
                      (3) correct nullifiers, (4) valid swap_data_hash, (5) valid output commitments
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-cyber-blue/10 flex items-center justify-center border border-cyber-blue/30 flex-shrink-0">
                    <span className="text-cyber-blue text-xs font-bold">5</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-gray-300 mb-1">Submit to Pool</h4>
                    <p className="text-xs text-gray-400 font-mono">
                      Call pool::swap(pool_in, pool_out, deepbook_pool, proof, public_inputs, amount_in, min_amount_out, encrypted_output_note, encrypted_change_note)
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-green-500/5 border border-green-500/30 rounded">
              <h3 className="text-sm font-bold text-green-400 mb-2 uppercase">RESULT</h3>
              <ul className="text-xs text-gray-400 font-mono space-y-1">
                <li><span className="text-green-400">•</span> ZK proof verified on-chain</li>
                <li><span className="text-green-400">•</span> Input nullifiers marked as spent</li>
                <li><span className="text-green-400">•</span> Swap executed via DeepBook V3</li>
                <li><span className="text-green-400">•</span> Output and change commitments added to Merkle tree</li>
                <li><span className="text-green-400">•</span> Token amounts and identities remain hidden</li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
