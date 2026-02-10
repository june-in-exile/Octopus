# @octopus/sdk

TypeScript SDK for interacting with the Octopus privacy protocol on Sui blockchain.

## Overview

Octopus is a privacy protocol for the Sui blockchain that enables on-chain transaction obfuscation using Groth16 ZK-SNARKs. This SDK provides a complete TypeScript API for generating zero-knowledge proofs, managing keypairs, and building privacy-preserving transactions.

## Features

- **Zero-Knowledge Proofs**: Generate Groth16 proofs for unshield, transfer, and swap operations
- **Key Management**: Derive keypairs using Poseidon hash functions on the BN254 curve
- **Note Encryption**: ECDH + ChaCha20-Poly1305 encryption for private notes
- **Merkle Trees**: Client-side Merkle tree construction and proof generation
- **Sui Integration**: Transaction builders for all privacy operations
- **DEX Integration**: Price fetching and swap estimation for DeepBook
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

```typescript
import { createNote, encryptNoteExplicit, buildShieldTransaction, exportViewingPublicKey, bigIntToBE32 } from '@octopus/sdk';

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

// Build shield transaction
const tx = buildShieldTransaction(
  packageId,
  poolId,
  '0x2::sui::SUI',
  coinObjectId,
  bigIntToBE32(note.commitment),
  encryptedNote
);

// Sign and execute with Sui wallet
const result = await suiClient.signAndExecuteTransaction({ transaction: tx });
```

### Unshield Tokens (Withdraw)

```typescript
import {
  generateUnshieldProof,
  convertUnshieldProofToSui,
  buildUnshieldTransaction
} from '@octopus/sdk';

// Generate ZK proof
const unshieldInput = {
  note: myNote,
  leafIndex: 42,
  pathElements: merkleProof,
  keypair: myKeypair
};

const { proof, publicSignals } = await generateUnshieldProof(unshieldInput);
const suiProof = convertUnshieldProofToSui(proof, publicSignals);

// Build unshield transaction
const tx = buildUnshieldTransaction(
  packageId,
  poolId,
  '0x2::sui::SUI',
  suiProof,
  1000n, // amount to withdraw
  recipientAddress
);

const result = await suiClient.signAndExecuteTransaction({ transaction: tx });
```

### Private Transfer

```typescript
import {
  selectNotes,
  createTransferOutputs,
  generateTransferProof,
  convertTransferProofToSui,
  buildTransferTransaction,
  encryptNoteExplicit,
  exportViewingPublicKey
} from '@octopus/sdk';

// Recipient shares their viewing public key (received out-of-band)
const recipientViewingPublicKey = "a1b2c3d4..."; // 64-char hex string

// Select input notes to cover the amount
const inputNotes = selectNotes(myNotes, 500n);

// Create output notes (recipient + change)
const [recipientNote, changeNote] = createTransferOutputs(
  recipientMpk,
  senderKeypair.masterPublicKey,
  500n, // amount to send
  inputNotes.reduce((sum, n) => sum + n.note.value, 0n), // total input
  1n // token type
);

// Generate transfer proof
const transferInput = {
  keypair: senderKeypair,
  inputNotes: inputNotes.map(n => n.note),
  inputLeafIndices: inputNotes.map(n => n.leafIndex),
  inputPathElements: inputNotes.map(n => n.pathElements!),
  outputNotes: [recipientNote, changeNote],
  token: 1n
};

const { proof, publicSignals } = await generateTransferProof(transferInput);
const suiProof = convertTransferProofToSui(proof, publicSignals);

// Encrypt output notes with explicit viewing keys
const myViewingPublicKey = exportViewingPublicKey(senderKeypair.spendingKey);

const encryptedNotes = [
  encryptNoteExplicit(recipientNote, recipientViewingPublicKey),
  encryptNoteExplicit(changeNote, myViewingPublicKey)
];

// Build transfer transaction
const tx = buildTransferTransaction(
  packageId,
  poolId,
  '0x2::sui::SUI',
  suiProof,
  encryptedNotes
);

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

#### `createNote(recipientMpk: bigint, token: bigint, value: bigint, random?: bigint): Note`

Create a new shielded note (UTXO).

**Formula:**

- NSK = Poseidon(MPK, random)
- commitment = Poseidon(NSK, token, value)

#### `computeNullifier(nullifyingKey: bigint, leafIndex: number): bigint`

Compute nullifier for spending a note.

**Formula:** nullifier = Poseidon(nullifyingKey, leafIndex)

#### `encryptNote(note: Note, recipientViewingPk: Uint8Array): Uint8Array`

Encrypt note data using ECDH + ChaCha20-Poly1305.

**Format:** ephemeral_pk (32) || nonce (12) || ciphertext (128 + 16 tag)

#### `decryptNote(encryptedData: Uint8Array, mySpendingKey: bigint, myMpk: bigint): Note | null`

Decrypt and verify note ownership. Returns `null` if the note doesn't belong to the user.

### Proof Generation

#### `generateUnshieldProof(input: UnshieldInput, config?: ProverConfig): Promise<{proof, publicSignals}>`

Generate Groth16 proof for unshielding a note.

**Input:**

```typescript
{
  note: Note;
  leafIndex: number;
  pathElements: bigint[]; // Length must be 16
  keypair: OctopusKeypair;
}
```

**Public Inputs:** merkle_root, nullifier

#### `convertUnshieldProofToSui(proof, publicSignals): SuiUnshieldProof`

Convert snarkjs proof to Sui-compatible Arkworks compressed format.

**Returns:**

```typescript
{
  proofBytes: Uint8Array;      // 128 bytes: A || B || C
  publicInputsBytes: Uint8Array; // 64 bytes: root || nullifier
}
```

#### `generateTransferProof(input: TransferInput, config?: ProverConfig): Promise<{proof, publicSignals}>`

Generate Groth16 proof for a private 2-input, 2-output transfer.

**Input:**

```typescript
{
  keypair: OctopusKeypair;
  inputNotes: Note[];          // 1 or 2 notes (padded automatically)
  inputLeafIndices: number[];
  inputPathElements: bigint[][];
  outputNotes: Note[];         // Exactly 2 notes [recipient, change]
  token: bigint;
}
```

**Public Inputs:** merkle_root, nullifier1, nullifier2, commitment1, commitment2

#### `convertTransferProofToSui(proof, publicSignals): SuiTransferProof`

Convert transfer proof to Sui format.

**Returns:**

```typescript
{
  proofBytes: Uint8Array;      // 128 bytes
  publicInputsBytes: Uint8Array; // 160 bytes
}
```

#### `generateSwapProof(input: SwapInput, config?: ProverConfig): Promise<{proof, publicSignals}>`

Generate Groth16 proof for a private token swap.

**Public Inputs:** merkle_root, nullifier1, nullifier2, output_commitment, change_commitment, swap_data_hash

### Transaction Builders

#### `buildShieldTransaction(packageId, poolId, coinType, coinObjectId, commitment, encryptedNote): Transaction`

Build a shield (deposit) transaction.

#### `buildUnshieldTransaction(packageId, poolId, coinType, proof, amount, recipient): Transaction`

Build an unshield (withdrawal) transaction.

#### `buildTransferTransaction(packageId, poolId, coinType, proof, encryptedNotes): Transaction`

Build a private transfer transaction.

#### `buildSwapTransaction(packageId, poolInId, poolOutId, coinTypeIn, coinTypeOut, proof, amountIn, minAmountOut, encryptedOutputNote, encryptedChangeNote): Transaction`

Build a private swap transaction.

### Wallet Utilities

#### `selectNotes(availableNotes: SelectableNote[], amount: bigint): SelectableNote[]`

Select notes to cover the required amount (1 or 2 notes). This function is used for transfers, unshields, and swaps.

**Strategy:**

1. Find single note ≥ amount (most efficient)
2. Find smallest pair that covers amount (minimize change)
3. Throw error if insufficient balance or circuit limitation

#### `createTransferOutputs(recipientMpk, senderMpk, amount, inputTotal, token): [Note, Note]`

Create output notes for transfer [recipient, change].

### Merkle Tree

#### `ClientMerkleTree`

Client-side Merkle tree for tracking deposits.

**Methods:**

```typescript
const tree = new ClientMerkleTree();

tree.insert(commitment: bigint): number  // Returns leaf index
tree.getProof(leafIndex: number): bigint[]  // Returns Merkle proof path
tree.root: bigint  // Current Merkle root
```

### DEX Integration

#### `getDeepBookPrice(pool: DeepBookPoolConfig): Promise<number>`

Get current price from DeepBook pool.

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

- Key derivation: MPK = Poseidon(spending_key, nullifying_key)
- Note secret keys: NSK = Poseidon(MPK, random)
- Commitments: commitment = Poseidon(NSK, token, value)
- Nullifiers: nullifier = Poseidon(nullifying_key, leaf_index)
- Merkle tree: node = Poseidon(left, right)

**Field Elements:** All values are reduced modulo the BN254 scalar field:

```
21888242871839275222246405745257275088548364400416034343698204186575808495617
```

### UTXO Model

Octopus uses a UTXO (Unspent Transaction Output) model similar to Bitcoin:

1. **Shield**: Creates a new note (UTXO) and adds commitment to Merkle tree
2. **Transfer**: Spends input notes (marks nullifiers) and creates new output notes
3. **Unshield**: Spends a note and withdraws tokens to a public address
4. **Swap**: Spends input notes, performs DEX swap, creates output notes

### Privacy Guarantees

**Anonymity Set:** All deposits with the same token type share the same anonymity set. The more deposits, the stronger the privacy.

**Unlinkability:** Transfers use nullifiers instead of commitments, breaking the link between inputs and outputs.

**Encryption:** All note data is encrypted using ECDH, only readable by the recipient.

**Zero-Knowledge:** Proofs reveal nothing about:

- Note values (except for unshield amount)
- Note owners
- Transaction graphs
- Token amounts being transferred

### Security Model

**Trusted Setup:** Uses Powers of Tau ceremony + circuit-specific setup for Groth16 proofs.

**Double-Spend Prevention:** Nullifiers are tracked on-chain. Each note can only be spent once.

**Merkle Root History:** Supports 100 recent roots for concurrent transactions.

**Note Encryption:**

- X25519 ECDH for key agreement
- HKDF-SHA256 for key derivation
- ChaCha20-Poly1305 AEAD for encryption

## Viewing Key Management

### Overview

Viewing keys enable secure note encryption without exposing the spending key. Users share their **viewing public key** with senders, who use it to encrypt notes. Only the recipient (with the spending-key-derived viewing private key) can decrypt.

### Key Hierarchy

```
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

#### Production Method (Recommended)

```typescript
import {
  createNote,
  encryptNoteExplicit,
  importViewingPublicKey
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

#### Alternative (Direct Usage)

```typescript
import { encryptNote, importViewingPublicKey } from '@octopus/sdk';

const viewingPk = importViewingPublicKey(recipientViewingKeyHex);
const encrypted = encryptNote(note, viewingPk);
```

### Recipient Management Pattern

```typescript
interface RecipientProfile {
  mpk: bigint;                     // For creating notes
  viewingPublicKey: string;        // For encrypting notes
  label?: string;                  // Optional nickname
}

// Save recipients to localStorage
const recipients: RecipientProfile[] = [
  {
    mpk: BigInt("123456789..."),
    viewingPublicKey: "a1b2c3d4...",
    label: "Alice"
  },
  {
    mpk: BigInt("987654321..."),
    viewingPublicKey: "e5f6g7h8...",
    label: "Bob"
  }
];

// Use saved recipient for transfer
const recipient = recipients[0];
const note = createNote(recipient.mpk, tokenId, amount);
const encrypted = encryptNoteExplicit(note, recipient.viewingPublicKey);
```

### Security Best Practices

✅ **DO:**

- Share viewing public keys through secure channels (encrypted messaging, QR codes)
- Validate viewing key format before importing
- Store viewing public keys separately from MPKs
- Use explicit viewing keys for all cross-user transfers

⚠️ **DON'T:**

- Share spending keys (these authorize spending!)
- Assume viewing public keys are the same as MPKs
- Skip validation when importing user-provided keys

### Viewing Key Use Cases

1. **Private Transfers:** Encrypt notes for specific recipients
2. **View-Only Wallets:** Share viewing key for read-only access (future)
3. **Compliance:** Selective disclosure to auditors (Milestone 4)
4. **Tax Reporting:** Export transaction history without spending authority

### API Reference

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

## Examples

### Complete Shield → Transfer → Unshield Flow

```typescript
import {
  initPoseidon,
  generateKeypair,
  createNote,
  encryptNoteExplicit,
  exportViewingPublicKey,
  ClientMerkleTree,
  selectNotes,
  createTransferOutputs,
  generateUnshieldProof,
  generateTransferProof,
  convertUnshieldProofToSui,
  convertTransferProofToSui,
  buildShieldTransaction,
  buildTransferTransaction,
  buildUnshieldTransaction,
  bigIntToBE32
} from '@octopus/sdk';

// 1. Initialize
await initPoseidon();

// 2. Generate keypairs
const alice = generateKeypair();
const bob = generateKeypair();

// Export viewing public keys
const aliceViewingPubKey = exportViewingPublicKey(alice.spendingKey);
const bobViewingPubKey = exportViewingPublicKey(bob.spendingKey);

// 3. Alice shields 1000 tokens
const aliceNote = createNote(alice.masterPublicKey, 1n, 1000n);
const encryptedAliceNote = encryptNoteExplicit(aliceNote, aliceViewingPubKey);

const shieldTx = buildShieldTransaction(
  packageId,
  poolId,
  '0x2::sui::SUI',
  aliceCoinId,
  bigIntToBE32(aliceNote.commitment),
  encryptedAliceNote
);

// Execute shield transaction...
// Track commitment in local Merkle tree
const tree = new ClientMerkleTree();
const aliceLeafIndex = tree.insert(aliceNote.commitment);

// 4. Alice transfers 600 tokens to Bob
const [bobNote, aliceChangeNote] = createTransferOutputs(
  bob.masterPublicKey,
  alice.masterPublicKey,
  600n,
  1000n,
  1n
);

const transferInput = {
  keypair: alice,
  inputNotes: [aliceNote],
  inputLeafIndices: [aliceLeafIndex],
  inputPathElements: [tree.getProof(aliceLeafIndex)],
  outputNotes: [bobNote, aliceChangeNote],
  token: 1n
};

const { proof: transferProof, publicSignals: transferSignals } =
  await generateTransferProof(transferInput);
const suiTransferProof = convertTransferProofToSui(transferProof, transferSignals);

// Encrypt with explicit viewing keys
const encryptedNotes = [
  encryptNoteExplicit(bobNote, bobViewingPubKey),
  encryptNoteExplicit(aliceChangeNote, aliceViewingPubKey)
];

const transferTx = buildTransferTransaction(
  packageId,
  poolId,
  '0x2::sui::SUI',
  suiTransferProof,
  encryptedNotes
);

// Execute transfer transaction...
// Update Merkle tree
const bobLeafIndex = tree.insert(bobNote.commitment);
const aliceChangeLeafIndex = tree.insert(aliceChangeNote.commitment);

// 5. Bob unshields 600 tokens
const unshieldInput = {
  note: bobNote,
  leafIndex: bobLeafIndex,
  pathElements: tree.getProof(bobLeafIndex),
  keypair: bob
};

const { proof: unshieldProof, publicSignals: unshieldSignals } =
  await generateUnshieldProof(unshieldInput);
const suiUnshieldProof = convertUnshieldProofToSui(unshieldProof, unshieldSignals);

const unshieldTx = buildUnshieldTransaction(
  packageId,
  poolId,
  '0x2::sui::SUI',
  suiUnshieldProof,
  600n,
  bobAddress
);

// Execute unshield transaction...
```

### Batch Note Decryption (Wallet Scanning)

```typescript
import { decryptNote } from '@octopus/sdk';

// Fetch all encrypted notes from on-chain events
const encryptedNotes = await fetchEncryptedNotesFromChain();

// Try to decrypt each note
const myNotes = [];
for (const { encryptedData, leafIndex } of encryptedNotes) {
  const note = decryptNote(
    encryptedData,
    myKeypair.spendingKey,
    myKeypair.masterPublicKey
  );

  if (note) {
    // This note belongs to me!
    myNotes.push({
      note,
      leafIndex,
      // Fetch Merkle proof when needed for spending
    });
  }
}

console.log(`Found ${myNotes.length} notes owned by me`);
```

## Configuration

### Browser Environment

Place circuit artifacts in your `public/` directory:

```
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

```
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
const { proof, publicSignals } = await generateUnshieldProof(input, {
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

### Circuit Sizes

- **Unshield**: ~250K constraints
- **Transfer**: ~550K constraints
- **Swap**: ~800K constraints

**Recommendation:**

- For browser environments, use Web Workers to avoid blocking the UI
- Consider server-side proof generation for production applications

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

### Viewing Keys

**Current Implementation:**

The SDK now uses explicit viewing key sharing as the standard approach:

- Recipients export their viewing public key using `exportViewingPublicKey(spendingKey)`
- Senders encrypt notes using `encryptNoteExplicit(note, recipientViewingPubKey)`
- Viewing public keys are shared out-of-band (QR codes, secure messaging, etc.)

**Best Practices:**

- Always use explicit viewing keys for cross-user transfers
- Store viewing keypairs separately from spending keys
- Validate viewing key format with `isValidViewingPublicKey()` before importing
- Share viewing public keys through secure channels only

### Random Number Generation

All random values use `crypto.getRandomValues()` which is cryptographically secure in both Node.js and browsers.

### Circuit Validation

⚠️ Always validate circuit outputs before submitting transactions:

```typescript
// Verify Merkle root matches on-chain state
const onChainRoot = await fetchLatestRoot();
if (merkleRoot !== onChainRoot) {
  throw new Error('Merkle root mismatch - refresh your proofs');
}

// Verify nullifiers haven't been spent
const isSpent = await checkNullifierSpent(nullifier);
if (isSpent) {
  throw new Error('Note already spent (double-spend detected)');
}
```

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

// Use minAmountOut in swap proof
const minAmountOut = estimation.minAmountOut;
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
  SuiUnshieldProof,
  SuiTransferProof,
  SuiSwapProof,
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

## Contributing

Contributions are welcome! Please ensure:

1. All tests pass
2. Code follows existing style conventions
3. Add tests for new features
4. Update documentation for API changes

## Support

For issues and questions:

- GitHub Issues: [octopus-privacy/issues](https://github.com/octopus-privacy/octopus/issues)
- Documentation: See [../docs](../docs) for detailed protocol specification

## Acknowledgments

- **Circom/SnarkJS**: ZK proof system
- **Poseidon Hash**: Efficient zero-knowledge hash function
- **Sui**: High-performance blockchain platform
- **Noble Cryptography**: Modern, audited crypto libraries
