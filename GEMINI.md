# Gemini Context: Octopus Privacy Protocol

This document provides a comprehensive overview of the Octopus project, its architecture, and development workflow to guide AI-assisted development.

Before we dive into the formal project description, let’s establish a few ground rules:

Start every interaction with 'June' (the username). For example: 'Hi June, the job is done...', 'Yes, June. ...', 'Good morning June, ...'

Before writing any code, please check if the existing code can be used directly or refactored for the task, rather than jumping straight into writing new code every time.

When modifying features, do not leave deprecated versions; remove them directly.

Sync all modifications with the existing documentation. If a change conflicts with files like README.md, CLAUDE.md, or GEMINI.md, ensure the documentation is updated accordingly.

## 1. Project Overview

**Octopus** is a privacy protocol for the Sui blockchain that enables on-chain transaction obfuscation. It implements a UTXO-based privacy pool using Groth16 ZK-SNARKs, allowing users to shield, transfer, swap, and unshield tokens privately.

The project is a **Production-Ready MVP** with all core features fully working: shield, unshield, private transfers, and private swaps via DeepBook V3. Both testnet and mainnet are deployed and active.

**Key Technologies:**

* **Blockchain**: Sui
* **Smart Contracts**: Move
* **ZK Circuits**: Circom (Groth16 proofs, BN254 curve, Poseidon hash)
* **Frontend**: Next.js (React/TypeScript) with `@mysten/dapp-kit`
* **SDK**: Custom TypeScript SDK (`@octopus/sdk`) to link the frontend with the ZK circuits and contracts.
* **Tooling**: Node.js, npm, Sui CLI

## 2. Architecture

The project is a monorepo composed of four main components:

1. **`circuits/`**: Contains the Circom source code for the ZK-SNARKs. These circuits generate proofs for the core privacy-preserving actions:
    * `unshield.circom`: Proves ownership to withdraw tokens from the pool.
    * `transfer.circom`: Proves validity of a private 2-input, 2-output transfer.
    * `swap.circom`: Proves validity of a private token swap within the pool.

2. **`contracts/`**: Contains the Move smart contracts for the Sui blockchain. These contracts manage the Merkle tree of deposits, handle the nullifier set to prevent double-spends, and verify the ZK proofs on-chain.

3. **`sdk/`**: A TypeScript SDK that acts as the connective tissue. It provides an API for the frontend to interact with the circuits (e.g., generating proofs) and the smart contracts (e.g., submitting transactions).

4. **`frontend/`**: A Next.js web application that provides the user interface for interacting with the Octopus protocol. It allows users to manage keypairs, view shielded balances, and initiate shield, transfer, swap, and unshield operations.

## 3. Development Workflow & Commands

Follow this sequence to set up and run the entire project.

### Step 1: Build ZK Circuits

The circuits must be compiled first, as their artifacts (WASM, proving keys, verification keys) are used by the other components.

```bash
cd circuits
npm install
./scripts/compile.sh
```

*This process is slow and generates large `_final.zkey` files.*

### Step 2: Build and Test Smart Contracts

With the circuit artifacts generated, you can build and test the Move contracts. The verification keys (`_vk.json`) are needed for on-chain proof verification.

```bash
cd contracts
sui move build
sui move test
```

*Expect around 28 tests to pass.*

### 3. Build SDK (Required for Frontend)

```bash
cd sdk
npm install
npm run build
```

### 4. Run Frontend (Web UI)

```bash
cd frontend
npm install
npm run dev
```

The application will be available at `http://localhost:3000`.

### Key Scripts Summary

* **Circuits (`circuits/`):**
  * `scripts/compile_*.sh`: Compiles and generates all necessary circuit artifacts.
* **Contracts (`contracts/`):**
  * `sui move build`: Compiles the Move contracts.
  * `sui move test`: Runs the test suite for the contracts.
* **Frontend (`frontend/`):**
  * `npm run dev`: Starts the Next.js development server.
  * `npm run build`: Creates a production build of the frontend.
  * `npm run lint`: Lints the frontend codebase.

## Key Cryptographic Formulas

``` txt
// Key Derivation Hierarchy
nullifying_key = Poseidon(spending_key, 1)
MPK = Poseidon(spending_key, nullifying_key)   // Master Public Key

// Viewing Keys (for note encryption/decryption)
viewing_private_key = X25519(SHA256(spending_key))
viewing_public_key = X25519.publicKey(viewing_private_key)

// Note Creation
NSK = Poseidon(MPK, random)                    // Note Secret Key
commitment = Poseidon(NSK, token, value)       // Note Commitment

// Spending
nullifier = Poseidon(nullifying_key, leaf_index)
```

## Move Contract Entry Points

**Shield** (deposit): `pool::shield<T>(pool, coin, commitment, encrypted_note, ctx)`

* No ZK proof required, adds commitment to Merkle tree

**Unshield** (withdraw): `pool::unshield<T>(pool, proof_bytes, public_inputs_bytes, recipient, encrypted_change_note, ctx)`

* Requires 128-byte Groth16 proof + 128-byte public inputs (nullifier, root, change_commitment, amount)
* Supports automatic change note creation (no fund loss)
* Amount is extracted from public inputs (no separate parameter needed)
* Verifies proof, marks nullifier spent, transfers tokens, creates change note if needed

**Transfer** (private transfer): `pool::transfer<T>(pool, proof_bytes, public_inputs_bytes, encrypted_notes, ctx)`

* Requires Groth16 proof for a 2-input, 2-output private transfer.
* Public inputs (160 bytes): root, 2 input nullifiers, 2 output commitments.
* Spends two input notes and creates two new output notes within the pool.

**Swap** (private swap): `pool::swap<TokenIn, TokenOut>(pool_in, pool_out, deepbook_pool, proof_bytes, public_inputs_bytes, amount_in, min_amount_out, encrypted_output_note, encrypted_change_note, ctx)`

* Requires Groth16 proof for a private swap. Public inputs (256 bytes, 8 field elements): `token_in, token_out, merkle_root` (public inputs) + `nullifiers[2], swap_data_hash, output_commitment, change_commitment` (public outputs).
* Verifies proof, spends input notes, executes swap via DeepBook pool, creates output and change notes.
* For testing without a real DeepBook pool, use `pool::swap_for_testing` (skips proof verification, uses 1:1 mock swap).

## Deployment Info

### Mainnet

```txt
Package ID:  0x76c4ce9b941bc9d2988b07a38d8a72147c8275b95007ebb84c97b762c5a5d37e
SUI Pool:    0x375608b40591a0c2ab275dcc1f6b9341a16e1c3b04603d44515535d41ccfdd06
USDC Pool:   0x1cc65740f79fa1dace7d7b11b8c29a37b7c1750ac840ad17d36c3794e5165313
```

### Testnet

```txt
Package ID:  0x13bde5f943246578a98ce1da85350b2a8bc2304a2581ec8cf1eea9fb266724ce
SUI Pool:    0x33d00746b1053c4bb94d4513003ade8b82a9790b486246b7628d56a8600baf25
USDC Pool:   0x4a9bcb0999beebc31dd133f6be78780283a50168a0034af97a50f5987174d002
DBUSDC Pool: 0x3b74a9b4850ea59e9dc5f75ea4138731ce6cab275cd7bfc1b36fc1bef0d38e28 (testnet-only)
```

### Milestones

Detailed implementation plans are available in the [milestones/](milestones/) directory:

1. **[Private Transfers](milestones/01-private-transfers.md)** ✅ Complete
   * 2-input, 2-output private transfer circuit
   * Foundation for all other features

2. **[DeFi Integration](milestones/02-defi-integration.md)** ✅ Complete
   * Private swaps via DeepBook V3
   * Bi-directional estimation, lot size enforcement, slippage protection
   * Active on mainnet (SUI ↔ USDC) and testnet (SUI ↔ DBUSDC)

3. **[Relayer Network](milestones/03-relayer-network.md)** (Future)
   * Improves privacy by hiding transaction origin
   * Decentralized broadcaster network
   * Fee payment in shielded tokens

4. **[Compliance Features](milestones/04-compliance-features.md)** (Future)
   * Private Proofs of Innocence (PPOI)
   * View keys for selective disclosure
   * Tax reporting tools

See [docs/](docs/) for detailed milestone documentation.
