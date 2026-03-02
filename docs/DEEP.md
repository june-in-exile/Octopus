# DEEP Token Full Support Plan

## Overview

This document describes the plan and implementation for adding DEEP as a first-class asset in Octopus — supporting Shield, Unshield, Transfer, and Swap on both mainnet and testnet.

**Current state:** DEEP is only used as a fee token for DeepBook swap gas; it is not a shieldable/swappable asset.

**Target state:** Users can Shield, Unshield, Transfer, and Swap DEEP privately, just like SUI and USDC.

---

## What Requires No Changes

The ZK circuits, Move contracts, and SDK are fully token-agnostic. **No changes needed** to:

- `circuits/` (Circom ZK proofs)
- `contracts/` (Move pool logic)
- `sdk/` (proof generation, transaction building)
- `relayer/` (already accepts `tokenTypeIn/Out` and `isBid` as parameters)

---

## Prerequisites (On-chain Work)

Before any code change, the following on-chain work must be completed to obtain Object IDs:

**Mainnet:**

- Deploy `PrivacyPool<DEEP>` via `sui client call --package $PKG --module pool --function create_shared_pool ...`
- Record Octopus DEEP Pool Object ID
- Look up DeepBook DEEP/SUI Pool ID via SuiScan / DeepBook registry

**Testnet:**

- Deploy `PrivacyPool<DEEP>` (same command)
- Record Octopus DEEP Pool Object ID
- Look up DeepBook DEEP/SUI Pool ID (may not exist — see strategy below)

### Testnet Strategy

If no DeepBook DEEP/SUI pool exists on testnet:

- Still deploy `PrivacyPool<DEEP>` → enables Shield/Unshield/Transfer on testnet
- DEEP will not appear in SwapForm token list (filtered out when no DeepBook pool is configured)

---

## Implementation Steps

### Step 1: Environment Variables

Add to `.env` and `.env.example`:

```bash
# Mainnet - DEEP Pool
NEXT_PUBLIC_MAINNET_DEEP_POOL_ID=0x...           # Octopus PrivacyPool<DEEP>
NEXT_PUBLIC_MAINNET_DEEPBOOK_DEEP_SUI=0x...      # DeepBook DEEP/SUI pool

# Testnet - DEEP Pool
NEXT_PUBLIC_TESTNET_DEEP_POOL_ID=0x...           # Octopus PrivacyPool<DEEP>
NEXT_PUBLIC_TESTNET_DEEPBOOK_DEEP_SUI=0x...      # DeepBook DEEP/SUI pool (if it exists)
```

---

### Step 2: `frontend/src/lib/constants.ts`

Add `deepPoolId` and `deepSuiPoolId` to `NETWORK_CONFIG`, plus a `getDeepBookPairConfig` helper that centralizes all DeepBook pool selection and `isBid` logic (replacing the hardcoded `tokenInSymbol === "USDC"` checks scattered across `SwapForm.tsx`).

```typescript
export interface DeepBookPairConfig {
  poolId: string;
  base: string;  // base token symbol (e.g. "SUI", "DEEP")
  quote: string; // quote token symbol (e.g. "USDC", "SUI")
}

// Returns null if no DeepBook pool is configured for this pair.
// isBid = tokenIn is the quote token.
export function getDeepBookPairConfig(
  tokenIn: string,
  tokenOut: string,
  network: "mainnet" | "testnet",
): DeepBookPairConfig | null
```

**Pair config table:**

| Network | Pair | Base | Quote | `isBid` when |
| ------- | ---- | ---- | ----- | ------------ |
| Mainnet | SUI ↔ USDC | SUI | USDC | tokenIn = USDC |
| Mainnet | DEEP ↔ SUI | DEEP | SUI | tokenIn = SUI |
| Testnet | SUI ↔ DBUSDC | SUI | DBUSDC | tokenIn = DBUSDC |
| Testnet | DEEP ↔ SUI | DEEP | SUI | tokenIn = SUI (if pool exists) |

DEEP decimals: **6** (same as USDC; confirmed from `ESTIMATED_DEEP_FEE = 10_000n // 0.01 DEEP`).

---

### Step 3: `frontend/src/providers/NetworkConfigProvider.tsx`

Add DEEP to the `tokens` map. DEEP's presence is conditional on `deepPoolId` being configured, independent of whether a DeepBook swap pool exists. This allows Shield/Unshield/Transfer to work on testnet even without a swap pool.

```typescript
// Tokens type updated to include optional DEEP
tokens: Record<"SUI" | "USDC", TokenConfig>
      & Partial<Record<"DBUSDC" | "DEEP", TokenConfig>>

// DEEP entry (added when deepPoolId is configured)
DEEP: {
  type: config.deepCoinType!,
  symbol: "DEEP",
  decimals: 6,
  poolId: config.deepPoolId!,
}
```

---

### Step 4: `frontend/src/components/SwapForm.tsx`

Three refactors needed:

#### 4a. Replace hardcoded DeepBook pool selection (3 locations)

**Before:**

```typescript
const deepbookPoolId = network === "mainnet"
  ? NETWORK_CONFIG.mainnet.suiusdcPoolId
  : NETWORK_CONFIG.testnet.suidbusdcPoolId;
```

**After:**

```typescript
const pairConfig = getDeepBookPairConfig(tokenInSymbol, tokenOutSymbol, networkKey);
if (!pairConfig) throw new Error(`No DeepBook pool for ${tokenInSymbol}/${tokenOutSymbol}`);
const deepbookPoolId = pairConfig.poolId;
const isBid = tokenInSymbol === pairConfig.quote;
```

#### 4b. Replace hardcoded `isBid` checks (5+ locations)

**Before:**

```typescript
const isBid = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC";
```

**After:** derive from `pairConfig.quote` (computed once alongside pool selection).

#### 4c. Dynamic token-out filtering

Only show token pairs that have a configured DeepBook pool. When a DEEP/SUI pool is not configured, DEEP is excluded from the swap token selector (but still available for Shield/Unshield/Transfer).

---

## Verification Checklist

| Test | Expected |
| ---- | -------- |
| Shield DEEP (mainnet) | Commitment added to Merkle tree, DEEP deducted from wallet |
| Unshield DEEP (mainnet) | DEEP returned to wallet, nullifier spent |
| Transfer DEEP (mainnet) | New note created, old note nullified |
| Swap DEEP→SUI (mainnet) | DeepBook ask executed, SUI note created |
| Swap SUI→DEEP (mainnet) | DeepBook bid executed (`isBid=true`), DEEP note created |
| Shield DEEP (testnet) | Same as mainnet |
| Testnet no swap pool | DEEP absent from swap selector; Shield/Unshield/Transfer still work |
| Relayer for DEEP swap | Relayer covers DEEP fee; user needs no DEEP in wallet |

---

## File Change Summary

| File | Change |
| ---- | ------ |
| `.env` / `.env.example` | Add `DEEP_POOL_ID` and `DEEPBOOK_DEEP_SUI` vars |
| `frontend/src/lib/constants.ts` | Add `deepPoolId`, `deepSuiPoolId`; add `getDeepBookPairConfig()` |
| `frontend/src/providers/NetworkConfigProvider.tsx` | Add DEEP to token map |
| `frontend/src/components/SwapForm.tsx` | Refactor pool selection + `isBid` + token filtering |
