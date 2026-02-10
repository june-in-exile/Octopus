# Known Issues and Fixes

This document tracks significant bugs and their resolutions in the Octopus project.

---

## E_INVALID_ROOT After Receiving Transfers (FIXED)

**Date:** 2026-02-10
**Commit that introduced bug:** 0c60f9f ("feat(note-scanning): optimize with viewing tags and incremental cache")
**Status:** ✅ Fixed

### Issue

Users experienced `E_INVALID_ROOT` errors when trying to transfer or unshield notes after any transfer occurred in the pool, even if there were no new transactions between refreshing notes and attempting the transaction.

### Root Cause

The viewing tag optimization (`quickCheckNote`) introduced a critical bug where commitment collection was placed **after** the ownership check. The code flow was:

1. Check if note belongs to us (using `quickCheckNote`)
2. If not, `continue` to skip the note
3. **Commitment collection never reached** for notes that don't belong to us

This resulted in incomplete Merkle trees where only commitments for owned notes were collected, not ALL commitments in the pool.

**Example scenario:**
```typescript
// Transfer creates 2 output commitments at indices 100, 101
// - Commitment 100: belongs to User A ✅
// - Commitment 101: belongs to User B ❌

// User A's scan:
for (const output of transferOutputs) {
  if (!quickCheckNote(output, userA_spendingKey)) {
    continue; // ❌ Skips commitment 101!
  }
  // Collect commitment (never reached for commitment 101)
  allCommitments.push(output.commitment);
}

// Result: User A's cache has [0-99, 100] but missing 101
// When User A tries to spend note at index 100:
// - Builds Merkle tree with [0-99, 100] → wrong root
// - On-chain tree has [0-99, 100, 101] → different root
// - Transaction fails: E_INVALID_ROOT
```

### Why This Matters

**The Merkle tree needs ALL commitments from the pool, not just the commitments for notes we own.**

- **On-chain:** The Merkle tree contains commitments for ALL users' notes (indices 0, 1, 2, ..., N)
- **Client-side (buggy):** The Merkle tree only contained commitments for OUR notes (sparse indices with gaps)
- **Result:** Different tree structure → different root → E_INVALID_ROOT

### Fix

Moved commitment collection **before** the ownership check in both Shield and Transfer event processing.

**Before (buggy):**
```typescript
// Check ownership first
if (!quickCheckNote(note, myKey)) {
  continue; // Skip commitment collection!
}

// Collect commitment (never reached if continue was called)
allCommitments.push(commitment);
```

**After (fixed):**
```typescript
// ALWAYS collect commitment first
allCommitments.push(commitment);

// Then check ownership (only for deciding whether to decrypt)
if (!quickCheckNote(note, myKey)) {
  continue; // Skip decryption, but commitment already collected
}
```

**Key principle:**
- **Commitment collection** = for Merkle tree = needs ALL commitments
- **Note decryption** = for user's wallet = only needs OUR notes

These are two separate concerns that were incorrectly coupled.

### Files Modified

- [`frontend/src/workers/noteScanWorker.ts`](../frontend/src/workers/noteScanWorker.ts)
  - Fixed Transfer event processing (lines 689-737)
  - Fixed Shield event processing (lines 640-684)

### Impact

- ✅ Users can now spend notes after any transfer occurs
- ✅ Maintains the 10x performance improvement from viewing tag optimization
- ✅ No changes to commitment parsing or Merkle tree construction
- ✅ No performance impact (commitment collection was already happening, just in wrong order)

### Lesson Learned

When optimizing code, be careful not to couple unrelated concerns. In this case:
- The viewing tag optimization (`quickCheckNote`) was meant to speed up note scanning by skipping unnecessary decryptions
- But it accidentally also skipped commitment collection, which is a separate concern
- The fix properly separates these concerns: collect ALL commitments (for tree completeness), THEN filter by ownership (for decryption optimization)

---

