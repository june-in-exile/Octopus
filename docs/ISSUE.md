# Optimization Plan: 2-Input Unshield Circuit

## Context

**Problem:** Currently, unshielding tokens that require 2 notes must execute 2 separate transactions, each with its own ~15-30s proof generation time and wallet confirmation. This creates poor UX compared to the transfer operation, which can handle 2 input notes in a single transaction.

**User Request:** Optimize unshield to match transfer's capabilities - support 2 input notes in 1 transaction.

**Root Cause:** The unshield circuit (`unshield.circom`) is designed with 1-input architecture, while the transfer circuit (`transfer.circom`) uses 2-input architecture with conditional logic for dummy note padding.

---

## Recommended Approach

**Modify the existing unshield.circom** to support 2 inputs (following the transfer circuit pattern) rather than creating a separate circuit.

**Why this approach:**

- Single unified API (one `generateUnshieldProof` function)
- Simpler maintenance (one circuit to compile)
- Clear migration path (all existing notes remain valid)
- Follows immutability principles (extend, don't duplicate)

**Trade-offs:**

- Proof generation time increases ~2x for single-note unshields (15-30s → 30-60s)
- Circuit size increases ~2x (5.3MB → ~10MB zkey file)
- Breaking change requires circuit recompilation and contract redeployment

**Net benefit:** For 2-note unshields, users save 1 transaction (~45-90s total time + gas costs).

---

## Implementation Plan

### Phase 1: Circuit Modifications

**File:** `/Users/june/Projects/Octopus/circuits/unshield.circom`

**Changes needed:**

1. **Convert single inputs to arrays:**

   ```circom
   // OLD:
   signal input random;
   signal input value;
   signal input leaf_index;
   signal input path_elements[levels];

   // NEW:
   signal input input_randoms[2];
   signal input input_values[2];
   signal input input_leaf_indices[2];
   signal input input_path_elements[2][levels];
   ```

2. **Add dummy note detection** (pattern from transfer.circom):

   ```circom
   signal isValueZero[2];
   signal input_nullifiers[2];

   for (var i = 0; i < 2; i++) {
       // Detect dummy notes (value == 0)
       isValueZero[i] <== IsZero()(input_values[i]);

       // Compute commitment and NSK
       input_nsks[i] <== Poseidon(2)([mpk, input_randoms[i]]);
       input_commitments[i] <== Poseidon(3)([input_nsks[i], token, input_values[i]]);

       // Verify Merkle proof (bypassed for dummy notes)
       calculated_roots[i] <== MerkleProof(levels)(...);
       (1 - isValueZero[i]) * (calculated_roots[i] - merkle_root) === 0;

       // Generate nullifier (0 for dummy notes)
       calculated_nullifiers[i] <== Poseidon(2)([nullifying_key, input_leaf_indices[i]]);
       input_nullifiers[i] <== (1 - isValueZero[i]) * calculated_nullifiers[i];
   }
   ```

3. **Update balance conservation:**

   ```circom
   signal input_sum <== input_values[0] + input_values[1];
   signal change_value <== input_sum - unshield_amount;

   // Range check: unshield_amount <= input_sum
   signal rangeCheck <== LessEqThan(120)([unshield_amount, input_sum]);
   rangeCheck === 1;
   ```

4. **Update public outputs:**

   ```circom
   signal output input_nullifiers[2];  // Was: signal output nullifier
   signal output merkle_root;
   signal output change_commitment;
   ```

5. **Update component declaration:**

   ```circom
   component main {public [token, unshield_amount]} = Unshield(16);
   ```

**Compile:**

```bash
cd circuits
./scripts/compile.sh  # ~1 hour, generates ~10MB zkey file
```

---

### Phase 2: Move Contract Updates

**File:** `/Users/june/Projects/Octopus/contracts/sources/pool.move`

**Changes needed:**

1. **Update function signature** (line 274):

   ```move
   public fun unshield<T>(
       pool: &mut PrivacyPool<T>,
       proof_bytes: vector<u8>,          // 128 bytes (unchanged)
       public_inputs_bytes: vector<u8>,  // 192 bytes (was 128)
       recipient: address,
       encrypted_change_note: vector<u8>,
       ctx: &mut TxContext,
   )
   ```

2. **Update public inputs parser** (line 633):

   ```move
   fun parse_unshield_public_inputs(bytes: &vector<u8>):
       (vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>) {

       assert!(vector::length(bytes) == 192, E_INVALID_PUBLIC_INPUTS); // 6 fields

       // Parse: [token, unshield_amount] (public inputs)
       //        [input_nullifiers[2], merkle_root, change_commitment] (outputs)
       // ...
   }
   ```

3. **Update nullifier handling** (line 295):

   ```move
   // Mark both nullifiers as spent (skip if zero)
   nullifier::mark_spent(&mut pool.nullifiers, nullifier1);
   if (!is_zero_commitment(&nullifier2)) {
       nullifier::mark_spent(&mut pool.nullifiers, nullifier2);
   };
   ```

4. **Update UnshieldEvent struct:**

   ```move
   public struct UnshieldEvent has copy, drop {
       pool_id: ID,
       nullifiers: vector<vector<u8>>,  // Array instead of single nullifier
       recipient: address,
       amount: u64,
       change_commitment: vector<u8>,
       change_position: u64,
   }
   ```

**Test:**

```bash
cd contracts
sui move build
sui move test  # Expect ~27 tests to pass
```

---

### Phase 3: SDK Updates

**Files:**

- `/Users/june/Projects/Octopus/sdk/src/types.ts`
- `/Users/june/Projects/Octopus/sdk/src/prover.ts`

**Type definitions changes:**

```typescript
// types.ts
export interface UnshieldInput {
  // OLD: note, leafIndex, pathElements (single)
  // NEW: arrays
  notes: Note[];              // 1 or 2 input notes
  leafIndices: number[];      // Corresponding leaf indices
  pathElements: bigint[][];   // Corresponding Merkle proofs

  keypair: OctopusKeypair;
  unshieldAmount: bigint;
}

export interface UnshieldCircuitInput {
  spending_key: string;
  nullifying_key: string;

  // Arrays to match circuit
  input_randoms: string[];          // [2]
  input_values: string[];           // [2]
  input_leaf_indices: string[];     // [2]
  input_path_elements: string[][];  // [2][16]
  token: string;

  change_random: string;
  unshield_amount: string;
}

export interface SuiUnshieldProof {
  proofBytes: Uint8Array;           // 128 bytes (unchanged)
  publicInputsBytes: Uint8Array;    // 192 bytes (was 128)
}
```

**Prover logic changes (prover.ts):**

```typescript
export function buildUnshieldInput(unshieldInput: UnshieldInput): {
  circuitInput: UnshieldCircuitInput;
  changeNote: Note | null;
  changeRandom: bigint;
} {
  const { notes, leafIndices, pathElements, keypair, unshieldAmount } = unshieldInput;

  // Validate
  if (notes.length < 1 || notes.length > 2) {
    throw new Error("Unshield requires 1 or 2 input notes");
  }

  // Pad to 2 inputs if only 1 provided
  const paddedNotes = [...notes];
  const paddedIndices = [...leafIndices];
  const paddedPaths = [...pathElements];

  if (paddedNotes.length === 1) {
    // Create dummy note (value=0 triggers Merkle bypass)
    const dummyNote: Note = {
      nsk: 0n, token: notes[0].token, value: 0n,
      random: 0n, commitment: 0n
    };
    paddedNotes.push(dummyNote);
    paddedIndices.push(leafIndices[0] === 0 ? 1 : 0);
    paddedPaths.push(Array(MERKLE_TREE_DEPTH).fill(0n));
  }

  // Validate balance
  const inputSum = paddedNotes.reduce((sum, n) => sum + n.value, 0n);
  if (unshieldAmount > inputSum) {
    throw new Error(`Insufficient balance`);
  }

  // Calculate change
  const changeValue = inputSum - unshieldAmount;
  const changeRandom = randomFieldElement();

  const mpk = poseidonHash([keypair.spendingKey, keypair.nullifyingKey]);
  const changeNpk = poseidonHash([mpk, changeRandom]);
  const changeCommitment = changeValue > 0n
    ? poseidonHash([changeNpk, notes[0].token, changeValue])
    : 0n;

  return {
    circuitInput: {
      spending_key: keypair.spendingKey.toString(),
      nullifying_key: keypair.nullifyingKey.toString(),
      input_randoms: paddedNotes.map(n => n.random.toString()),
      input_values: paddedNotes.map(n => n.value.toString()),
      input_leaf_indices: paddedIndices.map(idx => idx.toString()),
      input_path_elements: paddedPaths.map(path => path.map(e => e.toString())),
      token: notes[0].token.toString(),
      change_random: changeRandom.toString(),
      unshield_amount: unshieldAmount.toString(),
    },
    changeNote: changeValue > 0n ? { nsk: changeNpk, token: notes[0].token, value: changeValue, random: changeRandom, commitment: changeCommitment } : null,
    changeRandom
  };
}

// Update convertUnshieldProofToSui
export function convertUnshieldProofToSui(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[],
): SuiUnshieldProof {
  // Expect 6 public signals (was 4)
  if (publicSignals.length !== 6) {
    throw new Error(`Expected 6 public signals, got ${publicSignals.length}`);
  }

  const proofBytes = serializeProof(proof);
  const publicInputsBytes = serializePublicInputs(publicSignals);

  return { proofBytes, publicInputsBytes };
}
```

**Test:**

```bash
cd sdk
npm run build
npm test
```

---

### Phase 4: Frontend Integration

**File:** `/Users/june/Projects/Octopus/frontend/src/components/UnshieldForm.tsx`

**Changes needed:**

1. **Replace sequential execution** with single-transaction flow:

```typescript
const handleSubmit = async (e: React.FormEvent) => {
  // ... validation ...

  try {
    // Select notes (supports 1-2 notes)
    const selected = selectNotes(selectableNotes, amountMist);

    if (selected.length > 2) {
      throw new Error("SDK optimization allows max 2 notes per unshield");
    }

    const selectedNotes = selected.map(s =>
      unspentNotes.find(n => n.leafIndex === s.leafIndex)!
    );

    // Fetch Merkle proofs
    setState("fetching-merkle-proofs");
    const leafIndices = selectedNotes.map(n => n.leafIndex);
    const merkleProofs = await fetchMerkleProofs(
      keypair!.spendingKey,
      tokenConfig.poolId,
      leafIndices
    );

    const notesWithProofs = selectedNotes.map(n => ({
      ...n,
      pathElements: merkleProofs.get(n.leafIndex)
    }));

    // Generate single proof for all notes
    setState("generating-proof");
    const { proof, publicSignals, changeNote } = await generateUnshieldProof({
      notes: notesWithProofs.map(n => n.note),
      leafIndices: notesWithProofs.map(n => n.leafIndex),
      pathElements: notesWithProofs.map(n => n.pathElements!),
      keypair: keypair!,
      unshieldAmount: amountMist,
    });

    // Submit single transaction
    setState("submitting");
    const viewingPk = deriveViewingPublicKey(keypair!.spendingKey);
    const suiProof = convertUnshieldProofToSui(proof, publicSignals);
    const encryptedChangeNote = changeNote
      ? encryptNote(changeNote, viewingPk)
      : new Uint8Array(0);

    const tx = buildUnshieldTransaction(
      packageId!,
      tokenConfig.poolId,
      tokenConfig.type,
      suiProof,
      recipient,
      encryptedChangeNote
    );

    const result = await signAndExecute({ transaction: tx });

    // Mark all notes spent
    selectedNotes.forEach(n => markNoteSpent?.(n.nullifier));

    setState("success");
    setSuccess({
      message: `Successfully unshielded ${formatTokenAmount(amountMist, tokenConfig.decimals)} ${tokenConfig.symbol}`,
      txDigests: [result.digest]
    });

    await onSuccess?.();
  } catch (err) {
    // ... error handling ...
  }
};
```

1. **Remove obsolete code:**
   - Delete `executeSequentialUnshields()` function
   - Remove multi-transaction progress tracking state
   - Simplify progress indicator UI

2. **Update info text:**

   ```tsx
   <p className="text-[10px] text-gray-400 font-mono mt-0.5">
     // Single transaction for 1-2 notes
   </p>
   ```

**Test:**

```bash
cd frontend
npm run dev
# Manual testing: unshield 1 note, unshield 2 notes, verify change notes
```

---

## Verification Plan

### Circuit Tests

```bash
cd circuits
# Test cases:
# 1. 1-input unshield (with dummy padding)
# 2. 2-input unshield (both real)
# 3. 2-input partial unshield (with change)
# 4. Balance validation failure
# 5. Dummy note Merkle bypass
```

### Contract Tests

```bash
cd contracts
sui move test
# Test cases:
# 1. test_unshield_single_note()
# 2. test_unshield_two_notes()
# 3. test_unshield_with_change()
# 4. test_unshield_double_spend_protection()
# 5. test_unshield_zero_nullifier_handling()
```

### SDK Tests

```bash
cd sdk
npm test
# Test cases:
# 1. buildUnshieldInput with single note (padded correctly)
# 2. buildUnshieldInput with two notes
# 3. Balance validation
# 4. Public signals conversion (6 fields)
```

### Integration Tests (E2E)

1. Shield tokens → Unshield 1 note (full amount)
2. Shield tokens → Unshield 1 note (partial, creates change)
3. Shield tokens → Unshield 2 notes (exact amount)
4. Shield tokens → Unshield 2 notes (partial, creates change)
5. Verify change notes appear after rescan
6. Verify nullifiers prevent double-spend
7. Check transaction events on Sui explorer

---

## Migration Considerations

### Breaking Changes

1. **Circuit artifacts**: Requires recompilation (`./scripts/compile.sh`)
2. **Move contract**: Requires redeployment (new package ID)
3. **SDK API**: Breaking change to `UnshieldInput` interface

### Data Migration

- **Good news**: All existing shielded notes remain valid
- Old notes work with new circuit (will be padded with dummy)
- No data migration required
- Users simply update to new frontend version

### Deployment Strategy

1. Deploy new contracts to testnet
2. Update testnet frontend
3. Community testing (1-2 weeks)
4. Fix bugs if any
5. Deploy to mainnet
6. Update production frontend
7. Announce breaking changes

---

## Performance Impact

| Metric | Current (1-input) | Optimized (2-input) | Delta |
|--------|-------------------|---------------------|-------|
| Circuit size | 5.3MB | ~10MB | +88% |
| Constraints | ~64K | ~128K | +100% |
| Proof time (1 note) | 15-30s | 30-60s | +100% |
| Proof time (2 notes) | 30-60s (2 txs) | 30-60s (1 tx) | **-50% txs** |
| Total time (2 notes) | 30-60s + 2 confirmations | 30-60s + 1 confirmation | **-1 confirmation** |
| Gas cost (2 notes) | 2× unshield tx | 1× unshield tx | **-50%** |

**Net benefit:** For 2-note unshields, users save 1 transaction (~45-90s + gas).

**Trade-off:** Single-note unshields are slower, but most users prefer unified UX.

---

## Critical Files

Implementation sequence (5 most critical files):

1. **`/Users/june/Projects/Octopus/circuits/unshield.circom`**
   - Core circuit logic, convert to 2-input architecture
   - Priority: CRITICAL PATH BLOCKER

2. **`/Users/june/Projects/Octopus/contracts/sources/pool.move`**
   - On-chain verification, parse 192-byte public inputs
   - Priority: REQUIRED for proof verification

3. **`/Users/june/Projects/Octopus/sdk/src/prover.ts`**
   - Proof generation, implement note padding logic
   - Priority: REQUIRED for frontend integration

4. **`/Users/june/Projects/Octopus/sdk/src/types.ts`**
   - Type definitions, update interfaces
   - Priority: FOUNDATION for SDK changes

5. **`/Users/june/Projects/Octopus/frontend/src/components/UnshieldForm.tsx`**
   - User-facing component, single-transaction flow
   - Priority: USER EXPERIENCE IMPROVEMENTS

---

## Security Checklist

- [ ] Verify both nullifiers are marked spent in Move contract
- [ ] Handle zero nullifier (dummy note) correctly
- [ ] Validate Merkle root consistency for 2-note case
- [ ] Test double-spend prevention
- [ ] Audit balance conservation constraints
- [ ] Review conditional Merkle bypass logic
- [ ] Test gas costs don't exceed limits
- [ ] Verify event emissions include all nullifiers

---

## Timeline Estimate

- **Week 1-2**: Circuit implementation + compilation
- **Week 2-3**: SDK updates + testing
- **Week 3**: Frontend integration
- **Week 4**: Testnet deployment + community testing
- **Week 5**: Mainnet deployment

**Total**: ~5 weeks for full production rollout

---

## Summary

This optimization extends unshield to match transfer's 2-input capabilities, enabling single-transaction multi-note unshields. The implementation follows the proven transfer circuit pattern (dummy note padding, conditional Merkle verification) and maintains all existing security guarantees. While single-note unshields become slower (~2x proof time), the overall UX improves significantly for users unshielding multiple notes (1 transaction instead of 2).
