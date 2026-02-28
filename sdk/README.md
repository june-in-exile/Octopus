# @octopus/sdk

TypeScript SDK for the Octopus privacy protocol on Sui — generates ZK proofs, manages keypairs, and builds privacy-preserving transactions.

## Installation

```bash
npm install @octopus/sdk
```

## Quick Start

### 1. Initialize

Must be called once at app startup before any cryptographic operations:

```typescript
import { initPoseidon } from '@octopus/sdk';
await initPoseidon();
```

### 2. Keypair

```typescript
import { generateKeypair, deriveKeypair } from '@octopus/sdk';

const keypair = generateKeypair();                   // random
const keypair = deriveKeypair(spendingKey);          // from stored key

// { spendingKey, nullifyingKey, masterPublicKey }
```

### 3. Shield (Deposit)

No ZK proof required. Build the transaction manually:

```typescript
import { createNote, encryptNoteExplicit, exportViewingPublicKey, bigIntToBE32 } from '@octopus/sdk';
import { Transaction } from '@mysten/sui/transactions';

const note = createNote(keypair.masterPublicKey, tokenId, 1000n);
const encrypted = encryptNoteExplicit(note, exportViewingPublicKey(keypair.spendingKey));

const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::pool::shield`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [tx.object(poolId), tx.object(coinObjectId), tx.pure(bigIntToBE32(note.commitment)), tx.pure(encrypted)],
});
await suiClient.signAndExecuteTransaction({ transaction: tx });
```

### 4. Unshield (Withdraw)

```typescript
import { selectNotes, createUnshieldOutputs, generateUnshieldProof, encryptNoteExplicit, exportViewingPublicKey } from '@octopus/sdk';

const selected = selectNotes(myNotes, 1000n);
const inputTotal = selected.reduce((s, n) => s + n.note.amount, 0n);
const changeNote = createUnshieldOutputs(keypair.masterPublicKey, 1000n, inputTotal, tokenId);

const { proof, nullifiers } = await generateUnshieldProof({
  keypair,
  inputNotes: selected.map(n => n.note),
  inputLeafIndices: selected.map(n => n.leafIndex),
  inputPathElements: selected.map(n => n.pathElements),
  unshieldAmount: 1000n,
  changeNote,
  token: tokenId,
  recipient: '0xrecipient...', // Sui address — cryptographically bound to the proof
});

const encryptedChange = encryptNoteExplicit(changeNote, exportViewingPublicKey(keypair.spendingKey));

const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::pool::unshield`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [tx.object(poolId), tx.pure(proof.proofBytes), tx.pure(proof.publicInputsBytes), tx.pure(nullifiers), tx.pure('0xrecipient...'), tx.pure(encryptedChange)],
});
```

### 5. Private Transfer

```typescript
import { selectNotes, createTransferOutputs, generateTransferProof, encryptNoteExplicit, exportViewingPublicKey } from '@octopus/sdk';

const selected = selectNotes(myNotes, 500n);
const inputTotal = selected.reduce((s, n) => s + n.note.amount, 0n);
const [recipientNote, changeNote] = createTransferOutputs(recipientMpk, keypair.masterPublicKey, 500n, inputTotal, tokenId);

const { proof, nullifiers } = await generateTransferProof({
  keypair,
  inputNotes: selected.map(n => n.note),
  inputLeafIndices: selected.map(n => n.leafIndex),
  inputPathElements: selected.map(n => n.pathElements),
  recipientMpk,
  recipientNote,
  changeNote,
  token: tokenId,
});

const encryptedNotes = [
  encryptNoteExplicit(recipientNote, recipientViewingPublicKey),
  encryptNoteExplicit(changeNote, exportViewingPublicKey(keypair.spendingKey)),
];

const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::pool::transfer`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [tx.object(poolId), tx.pure(proof.proofBytes), tx.pure(proof.publicInputsBytes), tx.pure(nullifiers), tx.pure(encryptedNotes)],
});
```

## API Reference

### Cryptography

```typescript
initPoseidon(): Promise<void>

generateKeypair(): OctopusKeypair
deriveKeypair(spendingKey: bigint): OctopusKeypair

createNote(recipientMpk: bigint, token: bigint, amount: bigint, random?: bigint): Note
computeNullifier(nullifyingKey: bigint, leafIndex: number): bigint

// Note encryption (196 bytes: ephemeral_pk || nonce || ciphertext)
encryptNote(note: Note, recipientViewingPk: Uint8Array): Uint8Array
encryptNoteExplicit(note: Note, recipientViewingPk: Uint8Array | string): Uint8Array
decryptNote(encryptedData: Uint8Array, mySpendingKey: bigint, myMpk: bigint): Note | null
quickCheckNote(encryptedData: Uint8Array, mySpendingKey: bigint): boolean  // fast pre-filter (~0.1ms)

// Viewing keys (X25519; share with senders for note encryption)
exportViewingPublicKey(spendingKey: bigint): string    // 64-char hex
importViewingPublicKey(hexString: string): Uint8Array
isValidViewingPublicKey(hexString: string): boolean
```

### Proof Generation

All functions return `{ proof: SuiProof, nullifiers: Uint8Array }`.

`nullifiers` must be passed as a separate argument to the contract (BCS-encoded `vector<vector<u8>>`). They are private circuit inputs but required on-chain for double-spend prevention.

```typescript
generateUnshieldProof(input: UnshieldInput): Promise<{ proof: SuiProof, nullifiers: Uint8Array }>
generateTransferProof(input: TransferInput): Promise<{ proof: SuiProof, nullifiers: Uint8Array }>
generateSwapProof(input: SwapInput): Promise<{ proof: SuiProof, nullifiers: Uint8Array }>
```

**Input types:**

```typescript
interface UnshieldInput {
  keypair: OctopusKeypair;
  inputNotes: Note[];            // 1 or 2 notes (padded automatically)
  inputLeafIndices: number[];
  inputPathElements: bigint[][];
  unshieldAmount: bigint;
  changeNote: Note;
  token: bigint;
  recipient: string;             // Sui address ("0x...") — bound to proof, prevents substitution
}

interface TransferInput {
  keypair: OctopusKeypair;
  inputNotes: Note[];
  inputLeafIndices: number[];
  inputPathElements: bigint[][];
  recipientMpk: bigint;
  recipientNote: Note;
  changeNote: Note;
  token: bigint;
}

interface SwapInput {
  keypair: OctopusKeypair;
  inputNotes: Note[];
  inputLeafIndices: number[];
  inputPathElements: bigint[][];
  swapNote: Note;                // token_out, min_amount_out
  changeNote: Note;              // token_in change
}
```

### Output Note Creation

```typescript
createUnshieldOutputs(mpk, unshieldAmount, inputTotal, token): Note
createTransferOutputs(recipientMpk, senderMpk, amount, inputTotal, token): [Note, Note]
createSwapOutputs(mpk, amountIn, minAmountOut, inputTotal, tokenIn, tokenOut): [Note, Note]
```

### Note Selection

```typescript
selectNotes(availableNotes: SelectableNote[], amount: bigint): SelectableNote[]
```

Strategy: prefers a single note ≥ amount; falls back to the smallest two-note pair. Throws if balance is insufficient or more than 2 notes are needed.

### Merkle Tree

```typescript
const tree = new ClientMerkleTree();        // depth 16 (65,536 leaves)

tree.insert(leafIndex: number, commitment: bigint): void
tree.getMerkleProof(leafIndex: number): bigint[]  // 16 sibling hashes
tree.getRoot(): bigint
tree.size: number
```

### DEX Integration

```typescript
estimateDeepBookSwap(
  client: SuiClient,
  poolId: string,
  amountIn: bigint,
  isBid: boolean,                     // true = quote→base, false = base→quote
  baseType: string,
  quoteType: string,
  network?: 'testnet' | 'mainnet',
  deepbookPackageId?: string,
): Promise<SwapEstimation>

interface SwapEstimation {
  amountOut: bigint;
  priceImpact: number;
  effectivePrice: number;
  feeAmount: bigint;
  isApproximate?: boolean;            // true when estimated from mid_price
}
```

### Utilities

```typescript
bigIntToBE32(value: bigint): Uint8Array   // 32-byte big-endian (for commitments)
bigIntToLE32(value: bigint): Uint8Array   // 32-byte little-endian (for Sui proofs)
bytesToBigIntBE(bytes: Uint8Array): bigint
hexToBytes(hex: string): Uint8Array
bytesToHex(bytes: Uint8Array): string
```

## Core Concepts

**UTXO Model:** Each shielded balance is a set of "notes" (UTXOs). Spending a note produces new notes as outputs. Unspent notes are tracked by the Merkle tree of commitments.

**Commitment:** `Poseidon(NSK, token, amount)` where `NSK = Poseidon(MPK, random)`. Commitments are added to the on-chain Merkle tree at deposit.

**Nullifier:** `Poseidon(nullifyingKey, leafIndex)`. Submitted on-chain when spending; prevents double-spends. Only the note owner can compute it.

**Recipient Encoding (Unshield):** Sui addresses are 32 bytes, which can overflow the BN254 field. The circuit takes `addr_lo` / `addr_hi` (two 128-bit halves) as private inputs and exposes only `Poseidon(addr_lo, addr_hi)` as a public output. This binds the proof to the recipient without revealing the address.

**Viewing Keys:** X25519 keypair derived from spending key. Share the public key with senders so they can encrypt notes to you. Never share spending keys.

**Proof Format:** 128-byte Groth16 proof (Arkworks compressed A‖B‖C). Public inputs are 32 bytes each, little-endian.

## Configuration

### Browser

Serve circuit artifacts under `public/circuits/`:

```text
public/circuits/
  unshield_js/unshield.wasm
  unshield_final.zkey
  transfer_js/transfer.wasm
  transfer_final.zkey
  swap_js/swap.wasm
  swap_final.zkey
```

### Node.js

Place artifacts at `circuits/build/` relative to the project root. Override paths via a second argument:

```typescript
await generateUnshieldProof(input, {
  wasmPath: '/custom/unshield.wasm',
  zkeyPath: '/custom/unshield_final.zkey',
});
```

## Types

```typescript
import type {
  OctopusKeypair,
  Note,
  SuiProof,
  SelectableNote,
  UnshieldInput,
  TransferInput,
  SwapInput,
  SwapEstimation,
  RecipientProfile,
  RecipientProfileStored,
  PoolBookParams,
} from '@octopus/sdk';
```

## Constants

```typescript
import { SCALAR_MODULUS, MERKLE_TREE_DEPTH } from '@octopus/sdk';
// SCALAR_MODULUS: BN254 scalar field modulus
// MERKLE_TREE_DEPTH: 16 (2^16 = 65,536 leaves)
```

## Security Notes

- **Spending keys** authorize spending — never log, transmit, or store in plaintext.
- **Double-spend prevention** is not automatic — query on-chain nullifiers before generating proofs.
- **Proof generation** takes 2–10s depending on circuit; show a loading indicator.

## License

MIT
