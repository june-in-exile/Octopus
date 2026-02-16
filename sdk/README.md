# @octopus/sdk

TypeScript SDK for interacting with the Octopus privacy protocol on Sui blockchain.

## Overview

Octopus is a privacy protocol for the Sui blockchain that enables on-chain transaction obfuscation using Groth16 ZK-SNARKs. This SDK provides a complete TypeScript API for generating zero-knowledge proofs, managing keypairs, and building privacy-preserving transactions.

## Features

- **Zero-Knowledge Proofs**: Generate Groth16 proofs for unshield, transfer, and swap operations
- **Key Management**: Derive keypairs using Poseidon hash functions on the BN254 curve
- **Note Encryption**: ECDH + ChaCha20-Poly1305 encryption for private notes
- **Merkle Trees**: Client-side Merkle tree construction and proof generation
- **DEX Integration**: Swap estimation for DeepBook V3
- **Cross-Platform**: Works in both Node.js and browser environments

## Installation

```bash
npm install @octopus/sdk
```

## Prerequisites

Before using the SDK, ensure you have:

1. **Circuit Artifacts**: Compiled Circom circuits (WASM and zkey files)
   - For Node.js: Place in `circuits/build/`
   - For Browser: Serve from `public/circuits/`

2. **Sui Configuration**: Deployed Octopus contract package ID and pool object IDs

## Quick Start

### Initialize Poseidon

The SDK uses Poseidon hashing extensively. Initialize it once at application startup:

```typescript
import { initPoseidon } from '@octopus/sdk';

await initPoseidon();
```

### Generate a Keypair

```typescript
import { generateKeypair, deriveKeypair } from '@octopus/sdk';

// Generate a new random keypair
const keypair = generateKeypair();

// Or derive from a master spending key
const masterKey = 12345n; // In production, use secure random generation
const keypair = deriveKeypair(masterKey);

console.log('Master Public Key:', keypair.masterPublicKey);
```

### Shield Tokens (Deposit)

The shield transaction is built directly using `@mysten/sui` — no proof is required.

```typescript
import { createNote, encryptNoteExplicit, exportViewingPublicKey, bigIntToBE32 } from '@octopus/sdk';
import { Transaction } from '@mysten/sui/transactions';

// Create a note for 1000 tokens
const note = createNote(
  keypair.masterPublicKey,
  1n, // token type ID
  1000n // amount
);

// Export your viewing public key for encrypting notes to yourself
const myViewingPublicKey = exportViewingPublicKey(keypair.spendingKey);

// Encrypt the note for yourself
const encryptedNote = encryptNoteExplicit(note, myViewingPublicKey);

// Build shield transaction manually
const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::pool::shield`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [
    tx.object(poolId),
    tx.object(coinObjectId),
    tx.pure(bigIntToBE32(note.commitment)),
    tx.pure(encryptedNote),
  ],
});

const result = await suiClient.signAndExecuteTransaction({ transaction: tx });
```

### Unshield Tokens (Withdraw)

```typescript
import {
  createUnshieldOutputs,
  generateUnshieldProof,
  selectNotes,
} from '@octopus/sdk';
import { Transaction } from '@mysten/sui/transactions';

// Select notes to cover the withdrawal amount
const selectedNotes = selectNotes(myNotes, 1000n);
const inputTotal = selectedNotes.reduce((s, n) => s + n.note.amount, 0n);

// Create change note
const changeNote = createUnshieldOutputs(
  keypair.masterPublicKey,
  1000n,
  inputTotal,
  1n // token type
);

// Generate ZK proof
const { proof, nullifiers } = await generateUnshieldProof({
  keypair,
  inputNotes: selectedNotes.map(n => n.note),
  inputLeafIndices: selectedNotes.map(n => n.leafIndex),
  inputPathElements: selectedNotes.map(n => n.pathElements),
  unshieldAmount: 1000n,
  changeNote,
  token: 1n,
});

// Encrypt change note for yourself
const encryptedChangeNote = encryptNoteExplicit(changeNote, exportViewingPublicKey(keypair.spendingKey));

// Build unshield transaction manually
const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::pool::unshield`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [
    tx.object(poolId),
    tx.pure(proof.proofBytes),
    tx.pure(proof.publicInputsBytes),
    tx.pure(nullifiers),
    tx.pure(recipientAddress),
    tx.pure(encryptedChangeNote),
  ],
});

const result = await suiClient.signAndExecuteTransaction({ transaction: tx });
```

### Private Transfer

```typescript
import {
  selectNotes,
  createTransferOutputs,
  generateTransferProof,
  encryptNoteExplicit,
  exportViewingPublicKey,
} from '@octopus/sdk';
import { Transaction } from '@mysten/sui/transactions';

// Recipient shares their viewing public key and MPK (received out-of-band)
const recipientViewingPublicKey = "a1b2c3d4..."; // 64-char hex string
const recipientMpk = BigInt("123456789...");

// Select input notes to cover the amount
const selectedNotes = selectNotes(myNotes, 500n);
const inputTotal = selectedNotes.reduce((s, n) => s + n.note.amount, 0n);

// Create output notes (recipient + change)
const [recipientNote, changeNote] = createTransferOutputs(
  recipientMpk,
  keypair.masterPublicKey,
  500n, // amount to send
  inputTotal,
  1n // token type
);

// Generate transfer proof
const { proof, nullifiers } = await generateTransferProof({
  keypair,
  inputNotes: selectedNotes.map(n => n.note),
  inputLeafIndices: selectedNotes.map(n => n.leafIndex),
  inputPathElements: selectedNotes.map(n => n.pathElements),
  recipientMpk,
  recipientNote,
  changeNote,
  token: 1n,
});

// Encrypt output notes with explicit viewing keys
const myViewingPublicKey = exportViewingPublicKey(keypair.spendingKey);
const encryptedNotes = [
  encryptNoteExplicit(recipientNote, recipientViewingPublicKey),
  encryptNoteExplicit(changeNote, myViewingPublicKey),
];

// Build transfer transaction manually
const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::pool::transfer`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [
    tx.object(poolId),
    tx.pure(proof.proofBytes),
    tx.pure(proof.publicInputsBytes),
    tx.pure(nullifiers),
    tx.pure(encryptedNotes),
  ],
});

const result = await suiClient.signAndExecuteTransaction({ transaction: tx });
```

## API Reference

### Cryptography

#### `initPoseidon(): Promise<void>`

Initialize Poseidon hash function. Must be called once before using any cryptographic functions.

#### `generateKeypair(): OctopusKeypair`

Generate a new random keypair.

#### `deriveKeypair(spendingKey: bigint): OctopusKeypair`

Derive keypair from a master spending key.

**Returns:**

```typescript
{
  spendingKey: bigint;
  nullifyingKey: bigint;
  masterPublicKey: bigint; // MPK = Poseidon(spendingKey, nullifyingKey)
}
```

#### `createNote(recipientMpk: bigint, token: bigint, amount: bigint, random?: bigint): Note`

Create a new shielded note (UTXO).

**Formula:**

- NSK = Poseidon(MPK, random)
- commitment = Poseidon(NSK, token, amount)

#### `computeNullifier(nullifyingKey: bigint, leafIndex: number): bigint`

Compute nullifier for spending a note.

**Formula:** nullifier = Poseidon(nullifyingKey, leafIndex)

#### `encryptNote(note: Note, recipientViewingPk: Uint8Array): Uint8Array`

Encrypt note data using ECDH + ChaCha20-Poly1305.

**Format:** ephemeral_pk (32) || nonce (12) || ciphertext (128 + 16 tag)

#### `encryptNoteExplicit(note: Note, recipientViewingPk: Uint8Array | string): Uint8Array`

Encrypt note with an explicitly provided viewing public key (hex string or raw bytes).

#### `decryptNote(encryptedData: Uint8Array, mySpendingKey: bigint, myMpk: bigint): Note | null`

Decrypt and verify note ownership. Returns `null` if the note doesn't belong to the user.

### Proof Generation

All proof generation functions return `{ proof: SuiProof, nullifiers: Uint8Array }`.
The `nullifiers` are BCS-encoded as `vector<vector<u8>>` and must be passed as a separate argument to the contract (they are private in the circuit but required on-chain for double-spend prevention).

#### `generateUnshieldProof(input: UnshieldInput): Promise<{ proof: SuiProof, nullifiers: Uint8Array }>`

Generate Groth16 proof for unshielding notes.

**Input:**

```typescript
{
  keypair: OctopusKeypair;
  inputNotes: Note[];           // 1 or 2 notes (padded automatically)
  inputLeafIndices: number[];
  inputPathElements: bigint[][];
  unshieldAmount: bigint;
  changeNote: Note;             // Pre-created change note
  token: bigint;
}
```

**Proof public inputs:** `unshield_amount`, `token`, `merkle_root`
**Proof public outputs:** `nullifiers_hash`, `change_commitment`

#### `generateTransferProof(input: TransferInput): Promise<{ proof: SuiProof, nullifiers: Uint8Array }>`

Generate Groth16 proof for a private 2-input, 2-output transfer.

**Input:**

```typescript
{
  keypair: OctopusKeypair;
  inputNotes: Note[];           // 1 or 2 notes (padded automatically)
  inputLeafIndices: number[];
  inputPathElements: bigint[][];
  recipientMpk: bigint;
  recipientNote: Note;          // Pre-created recipient note
  changeNote: Note;             // Pre-created change note
  token: bigint;
}
```

**Proof public inputs:** `token`, `merkle_root`
**Proof public outputs:** `nullifiers_hash`, `recipient_commitment`, `change_commitment`

#### `generateSwapProof(input: SwapInput): Promise<{ proof: SuiProof, nullifiers: Uint8Array }>`

Generate Groth16 proof for a private token swap.

**Input:**

```typescript
{
  keypair: OctopusKeypair;
  inputNotes: Note[];           // 1 or 2 notes in token_in
  inputLeafIndices: number[];
  inputPathElements: bigint[][];
  swapNote: Note;               // Pre-created swap output note (token_out, min_amount_out)
  changeNote: Note;             // Pre-created change note (token_in)
}
```

**Proof public inputs:** `token_in`, `token_out`, `amount_in`, `min_amount_out`, `merkle_root`
**Proof public outputs:** `nullifiers_hash`, `swap_commitment`, `change_commitment`

### Output Note Creation

#### `createUnshieldOutputs(mpk, unshieldAmount, inputTotal, token): Note`

Create the change note for an unshield operation.

#### `createTransferOutputs(recipientMpk, senderMpk, amount, inputTotal, token): [Note, Note]`

Create output notes for a transfer `[recipient, change]`.

#### `createSwapOutputs(mpk, amountIn, minAmountOut, inputTotal, tokenIn, tokenOut): [Note, Note]`

Create output notes for a swap `[swapNote, changeNote]`.

### Wallet Utilities

#### `selectNotes(availableNotes: SelectableNote[], amount: bigint): SelectableNote[]`

Select notes to cover the required amount (1 or 2 notes).

**Strategy:**

1. Find single note ≥ amount (most efficient)
2. Find smallest pair that covers amount (minimize change)
3. Throw error if insufficient balance or circuit limitation

### Merkle Tree

#### `ClientMerkleTree`

Client-side Merkle tree for tracking deposits.

**Methods:**

```typescript
const tree = new ClientMerkleTree();

tree.insert(commitment: bigint): number  // Returns leaf index
tree.getProof(leafIndex: number): bigint[]  // Returns Merkle proof path (length 16)
tree.root: bigint  // Current Merkle root
```

### DEX Integration

#### `estimateDeepBookSwap(pool: DeepBookPoolConfig, amountIn: bigint, slippageBps: number): Promise<SwapEstimation>`

Estimate swap output with slippage protection.

**Returns:**

```typescript
{
  amountOut: bigint;
  minAmountOut: bigint;  // With slippage protection
  priceImpact: number;   // Percentage
}
```

### Utility Functions

#### Byte Conversion

- `bigIntToBE32(value: bigint): Uint8Array` - Convert to 32-byte big-endian
- `bytesToBigIntBE(bytes: Uint8Array): bigint` - Parse big-endian bytes
- `hexToBytes(hex: string): Uint8Array`
- `bytesToHex(bytes: Uint8Array): string`

#### Math Utilities

- `calculateMinOutput(amountOut: bigint, slippageBps: number): bigint`
- `calculatePriceImpact(amountIn: bigint, amountOut: bigint, spotPrice: number): number`

## Core Concepts

### Cryptographic Primitives

**Poseidon Hash:** BN254-friendly hash function used for:

- Key derivation: `nullifyingKey = Poseidon(spendingKey, 1)`, `MPK = Poseidon(spendingKey, nullifyingKey)`
- Note secret keys: `NSK = Poseidon(MPK, random)`
- Commitments: `commitment = Poseidon(nsk, token, amount)`
- Nullifiers: `nullifier = Poseidon(nullifyingKey, leafIndex)`
- Merkle tree: `node = Poseidon(left, right)`

**Field Elements:** All values are reduced modulo the BN254 scalar field:

```text
21888242871839275222246405745257275088548364400416034343698204186575808495617
```

### UTXO Model

Octopus uses a UTXO (Unspent Transaction Output) model similar to Bitcoin:

1. **Shield**: Creates a new note (UTXO) and adds commitment to Merkle tree
2. **Transfer**: Spends input notes (marks nullifiers) and creates new output notes
3. **Unshield**: Spends a note and withdraws tokens to a public address
4. **Swap**: Spends input notes, performs DEX swap, creates output notes

### Nullifier Handling

Nullifiers are **private inputs** to the ZK circuit — they are not revealed in the proof's public signals. Instead, the circuit outputs a `nullifiers_hash = Poseidon(nullifier1, nullifier2)`. The actual nullifiers must be passed **separately** to the contract as `vector<vector<u8>>` (BCS-encoded). The contract verifies: `Poseidon(nullifier1, nullifier2) === nullifiers_hash` before marking them spent.

### Privacy Guarantees

**Anonymity Set:** All deposits with the same token type share the same anonymity set.

**Unlinkability:** Transfers use nullifiers instead of commitments, breaking the link between inputs and outputs.

**Encryption:** All note data is encrypted using ECDH, only readable by the recipient.

**Zero-Knowledge:** Proofs reveal nothing about note values (except unshield amount), note owners, or transaction graphs.

### Security Model

**Trusted Setup:** Uses Powers of Tau ceremony + circuit-specific setup for Groth16 proofs.

**Double-Spend Prevention:** Nullifiers are tracked on-chain. Each note can only be spent once.

**Merkle Root History:** Supports 100 recent roots for concurrent transactions.

**Note Encryption:**

- X25519 ECDH for key agreement
- HKDF-SHA256 for key derivation
- ChaCha20-Poly1305 AEAD for encryption

## Viewing Key Management

Viewing keys enable secure note encryption without exposing the spending key. Users share their **viewing public key** with senders, who use it to encrypt notes. Only the recipient (with the spending-key-derived viewing private key) can decrypt.

### Key Hierarchy

```text
Random Spending Key (256-bit)
    ↓
┌───────────────────┴────────────────────┐
│                                        │
Nullifying Key                   Viewing Keypair (X25519)
    ↓                                    ↓
Master Public Key (MPK)          Viewing Public Key (shareable)
    ↓
Note Secret Key (NSK)
```

**Key Derivation:**

- `nullifyingKey = Poseidon(spendingKey, 1)`
- `MPK = Poseidon(spendingKey, nullifyingKey)`
- `viewingPrivateKey = X25519(SHA256(spendingKey))`
- `viewingPublicKey = X25519.publicKey(viewingPrivateKey)`

### Exporting Viewing Keys

```typescript
import { exportViewingPublicKey } from '@octopus/sdk';

// Export viewing public key for sharing
const viewingKeyHex = exportViewingPublicKey(keypair.spendingKey);
// Returns: 64-character hex string (e.g., "a1b2c3d4...")

// Share this with senders via secure channel
console.log("My Viewing Public Key:", viewingKeyHex);
```

### Importing Viewing Keys

```typescript
import { importViewingPublicKey, isValidViewingPublicKey } from '@octopus/sdk';

const recipientViewingKey = "a1b2c3d4..."; // Received from recipient

// Validate format (optional but recommended)
if (!isValidViewingPublicKey(recipientViewingKey)) {
  throw new Error('Invalid viewing key format');
}

// Import for use in encryption
const viewingPk = importViewingPublicKey(recipientViewingKey);
```

### Encrypting Notes for Recipients

```typescript
import {
  createNote,
  encryptNoteExplicit,
} from '@octopus/sdk';

// 1. Recipient shares both MPK and viewing public key
const recipientProfile = {
  mpk: BigInt("123456789..."),
  viewingPublicKey: "a1b2c3d4..." // 64-char hex
};

// 2. Create note for recipient
const note = createNote(
  recipientProfile.mpk,
  tokenId,
  amountNano
);

// 3. Encrypt with explicitly shared viewing key
const encrypted = encryptNoteExplicit(
  note,
  recipientProfile.viewingPublicKey
);
```

### Security Best Practices

✅ **DO:**

- Share viewing public keys through secure channels (encrypted messaging, QR codes)
- Validate viewing key format before importing
- Use explicit viewing keys for all cross-user transfers

⚠️ **DON'T:**

- Share spending keys (these authorize spending!)
- Assume viewing public keys are the same as MPKs
- Skip validation when importing user-provided keys

### Viewing Key API Reference

```typescript
// Export viewing public key from spending key
function exportViewingPublicKey(spendingKey: bigint): string;

// Import viewing public key from hex string
function importViewingPublicKey(hexString: string): Uint8Array;

// Validate viewing public key format
function isValidViewingPublicKey(hexString: string): boolean;

// Encrypt note with explicit viewing key
function encryptNoteExplicit(
  note: Note,
  recipientViewingPk: Uint8Array | string
): Uint8Array;

// Derive viewing public key from spending key (low-level)
function deriveViewingPublicKey(spendingKey: bigint): Uint8Array;
```

## Configuration

### Browser Environment

Place circuit artifacts in your `public/` directory:

```text
public/
  circuits/
    unshield_js/
      unshield.wasm
    unshield_final.zkey
    unshield_vk.json
    transfer_js/
      transfer.wasm
    transfer_final.zkey
    transfer_vk.json
    swap_js/
      swap.wasm
    swap_final.zkey
    swap_vk.json
```

The SDK will fetch these files automatically.

### Node.js Environment

Place circuit artifacts relative to the SDK package:

```text
project/
  node_modules/
    @octopus/sdk/
  circuits/
    build/
      unshield_js/
        unshield.wasm
      unshield_final.zkey
      unshield_vk.json
      (similar for transfer and swap)
```

### Custom Paths

Override default paths using `ProverConfig`:

```typescript
const { proof, nullifiers } = await generateUnshieldProof(input, {
  wasmPath: '/custom/path/unshield.wasm',
  zkeyPath: '/custom/path/unshield_final.zkey'
});
```

## Performance Considerations

### Proof Generation Times

On a modern CPU (M1 Mac):

- **Unshield**: ~2-3 seconds
- **Transfer**: ~5-7 seconds (2-input, 2-output)
- **Swap**: ~8-10 seconds

**Recommendation:** Show loading indicators during proof generation.

### Merkle Tree Sync

**Depth 16** supports up to **65,536 deposits**.

**Recommendation:**

- Cache Merkle proofs in IndexedDB (browser) or database (server)
- Periodically sync with on-chain state
- Use event listeners to detect new deposits

## Security Considerations

### Key Management

⚠️ **CRITICAL:** Spending keys must be stored securely!

- **Never** log spending keys to console
- **Never** transmit spending keys over network
- Use hardware wallets or secure enclaves in production
- Consider key derivation from mnemonic phrases (BIP39/BIP44)

### Double-Spend Prevention

The SDK does **NOT** automatically check for double-spends. Your application must:

1. Track spent nullifiers locally
2. Query on-chain nullifier set before generating proofs
3. Handle transaction failures gracefully

### Slippage Protection

For swap operations, always set reasonable slippage tolerance:

```typescript
const slippageBps = 50; // 0.5%
const estimation = await estimateDeepBookSwap(pool, amountIn, slippageBps);

// Use minAmountOut in swap outputs
const [swapNote, changeNote] = createSwapOutputs(
  keypair.masterPublicKey,
  amountIn,
  estimation.minAmountOut,
  inputTotal,
  tokenIn,
  tokenOut
);
```

## TypeScript Support

This SDK is written in TypeScript and provides full type definitions. All types are exported:

```typescript
import type {
  OctopusKeypair,
  Note,
  UnshieldInput,
  TransferInput,
  SwapInput,
  SuiProof,
  RecipientProfile,
  RecipientProfileStored,
  SelectableNote,
  // ... and more
} from '@octopus/sdk';
```

## Constants

```typescript
import {
  FIELD_MODULUS,      // BN254 field modulus
  SCALAR_MODULUS,     // BN254 scalar field modulus
  MERKLE_TREE_DEPTH,  // 16 levels (65,536 leaves)
  ROOT_HISTORY_SIZE   // 100 recent roots
} from '@octopus/sdk';
```

## Testing

```bash
npm test
```

## Building

```bash
npm run build
```

Outputs to `dist/` directory with both CommonJS and ESM support.

## License

MIT

## Acknowledgments

- **Circom/SnarkJS**: ZK proof system
- **Poseidon Hash**: Efficient zero-knowledge hash function
- **Sui**: High-performance blockchain platform
- **Noble Cryptography**: Modern, audited crypto libraries
