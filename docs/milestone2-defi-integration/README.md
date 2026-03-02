# Milestone 2: DeFi Integration - Private Swaps

**Status:** ✅ Complete
**Last Updated:** 2026-02-17

---

## Overview

This milestone adds private token swap functionality to Octopus, enabling users to exchange tokens while maintaining full privacy through ZK-SNARK proofs. Swaps are executed through **DeepBook V3**, Sui's native Central Limit Order Book (CLOB).

> **Note:** DBUSDC test pools are only available on Testnet. Mainnet uses real SUI ↔ USDC via DeepBook.

**Privacy Guarantee:** Swap amounts, token types, and user identities remain hidden on-chain. Only ZK proofs are verified publicly.

---

## Current Implementation Status

### ✅ Completed Components

1. **Swap Circuit** ([circuits/swap.circom](../../circuits/swap.circom))
   - 22,553 constraints (efficient, well optimized)
   - 2 input notes → 2 output notes (swapped token + change)
   - Full ZK proof generation working in browser

2. **Move Contract** ([contracts/sources/pool.move](../../contracts/sources/pool.move))
   - `pool::swap<TokenIn, TokenOut>()` — full DeepBook V3 integration
   - `pool::swap_for_testing()` — mock 1:1 swap for unit tests
   - Full proof verification, nullifier tracking, event emission
   - Bid/ask routing for optimal pricing

3. **TypeScript SDK** ([sdk/src/](../../sdk/src/))
   - Proof generation: `generateSwapProof()`
   - DeepBook price estimation: `estimateDeepBookSwap()`
   - Real pool book params: `getPoolBookParams()`
   - Min lot size enforcement and slippage protection via `min_amount_out`

4. **Frontend UI** ([frontend/src/components/SwapForm.tsx](../../frontend/src/components/SwapForm.tsx))
   - Token pair selection (SUI ↔ USDC / SUI ↔ DBUSDC on testnet)
   - Real-time bi-directional price estimation from DeepBook order book
   - Slippage tolerance setting
   - Max amount button
   - Liquidity error handling with user feedback

---

## How to Use (Frontend)

1. **Navigate to the app** and connect your Sui wallet
2. **Generate a keypair** (or select an existing one)
3. **Shield tokens** into the privacy pool first
4. **Click the SWAP tab** in the main interface
5. **Select token pair** (SUI ↔ USDC)
6. **Enter amount** to swap
7. **Set slippage tolerance** (default 0.5%)
8. **Generate proof and execute** (takes 30-60 seconds)

---

## Architecture

```txt
User (private notes in pool_in)
    ↓
Submit ZK Proof (proves ownership + swap parameters)
    ↓
pool::swap<TokenIn, TokenOut>() verifies proof
    ↓
Extract tokens from pool_in
    ↓
DeepBook place_market_order() → real market execution
    ↓
Shield swapped tokens into pool_out
    ↓
User receives encrypted output note
```

### DeepBook Integration Flow

```txt
Privacy Pool Contract
    ↓ (coin_in)
DeepBook place_market_order()
    ↓ (coin_out)
Privacy Pool Contract (shield)
    ↓ (encrypted note)
User Wallet Scanner
```

---

## Technical Details

### Swap Circuit ([circuits/swap.circom](../../circuits/swap.circom))

**Public Inputs (256 bytes, 8 field elements):**

1. `token_in`, `token_out` (64 bytes) - Token type identifiers
2. `merkle_root` (32 bytes) - Root of input note Merkle tree
3. `nullifier1`, `nullifier2` (64 bytes) - Input note nullifiers
4. `swap_data_hash` (32 bytes) - Hash of swap parameters
5. `output_commitment` (32 bytes) - Output note commitment
6. `change_commitment` (32 bytes) - Change note commitment

**Private Inputs:**

- Input notes (NSK, value, token)
- Spending key (for nullifier generation)
- Merkle proofs (path elements, indices)
- Output randomness
- Swap parameters (tokenIn, tokenOut, amounts)

**Circuit Guarantees:**

- ✅ User owns input notes (spending key check)
- ✅ Input notes exist in Merkle tree
- ✅ Balance conservation enforced
- ✅ Swap parameters validated
- ✅ Output notes properly committed

### Move Contract Functions

**Production Function (DeepBook V3):**

```move
public entry fun swap<TokenIn, TokenOut>(
    pool_in: &mut PrivacyPool<TokenIn>,
    pool_out: &mut PrivacyPool<TokenOut>,
    deepbook_pool: &mut Pool<TokenIn, TokenOut>,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
    amount_in: u64,
    min_amount_out: u64,
    encrypted_output_note: vector<u8>,
    encrypted_change_note: vector<u8>,
    ctx: &mut TxContext,
)
```

**Test Function (Mock Swap):**

```move
public entry fun swap_for_testing<TokenIn, TokenOut>(...)
```

- Skips proof verification
- Uses 1:1 mock exchange rate
- Used exclusively in Move unit tests

---

## Deployments

### Mainnet

```txt
Package:     0x76c4ce9b941bc9d2988b07a38d8a72147c8275b95007ebb84c97b762c5a5d37e
SUI Pool:    0x375608b40591a0c2ab275dcc1f6b9341a16e1c3b04603d44515535d41ccfdd06
USDC Pool:   0x1cc65740f79fa1dace7d7b11b8c29a37b7c1750ac840ad17d36c3794e5165313
Swap pair:   SUI ↔ USDC via DeepBook V3
```

### Testnet

```txt
Package:     0x13bde5f943246578a98ce1da85350b2a8bc2304a2581ec8cf1eea9fb266724ce
SUI Pool:    0x33d00746b1053c4bb94d4513003ade8b82a9790b486246b7628d56a8600baf25
DBUSDC Pool: 0x3b74a9b4850ea59e9dc5f75ea4138731ce6cab275cd7bfc1b36fc1bef0d38e28
Swap pair:   SUI ↔ DBUSDC via DeepBook V3
```

---

## Testing

### Completed ✅

- **Circuit Tests**: All proof generation tests passing
- **Contract Tests**: 28 Move tests passing (including swap tests)
- **SDK Tests**: Proof serialization and transaction building verified
- **Integration**: Real DeepBook pool interaction on testnet and mainnet
- **Price Tests**: Bi-directional estimation from DeepBook order book
- **Slippage Tests**: `min_amount_out` enforcement active

---

## Key Differences: DeepBook vs Mock

| Aspect | Mock (`swap_for_testing`) | DeepBook (`swap`) |
| ------ | ------------------------- | ----------------- |
| **Price** | Fixed 1:1 | Real market rate from order book |
| **Liquidity** | Unlimited | Based on DeepBook pool depth |
| **Slippage** | None | Real slippage, protected by `min_amount_out` |
| **Fees** | None | 0.25% taker fee (or 0.2% with DEEP) |
| **Usage** | Unit tests only | Production (testnet + mainnet) |

---

## DEEP Token Expansion Plan

**Status:** Planned
**Prerequisites:** On-chain `PrivacyPool<DEEP>` deployment + DeepBook DEEP/SUI pool IDs

### Can existing code support DEEP swaps?

The ZK circuit, Move contracts, and SDK are fully token-agnostic — adding DEEP requires **no changes** to circuits or contracts. Only configuration and frontend logic need updating.

What's missing:

| Item | Mainnet | Testnet |
| ---- | ------- | ------- |
| Octopus `PrivacyPool<DEEP>` | Not deployed | Not deployed |
| DeepBook DEEP/SUI pool ID | Unknown (exists on-chain) | Unknown (may not exist) |
| Frontend token config | Not included | Not included |

### Required New Data

1. **Octopus `PrivacyPool<DEEP>` Object ID** (mainnet + testnet)
   - Must be created via `create_pool<DEEP>(...)` on-chain
   - Will become `NEXT_PUBLIC_MAINNET_DEEP_POOL_ID` in `.env`

2. **DeepBook DEEP/SUI pool ID** (mainnet + testnet)
   - Mainnet pool exists; ID must be looked up via SuiScan or DeepBook docs
   - Testnet availability is uncertain; may need to skip or mock

3. **DEEP token decimals** — 9 (same as SUI), add to `NetworkConfigProvider.tsx`

### Architecture Changes Required

**`constants.ts`** — Add DEEP pool IDs

```ts
mainnet: {
  // existing...
  deepSuiPoolId: "...",   // DeepBook DEEP/SUI pool
  deepPoolId: "...",      // Octopus PrivacyPool<DEEP>
}
```

**`NetworkConfigProvider.tsx`** — Add DEEP token config

```ts
DEEP: {
  type: deepCoinType,
  symbol: "DEEP",
  decimals: 9,
  poolId: deepPoolId,   // Octopus PrivacyPool<DEEP>
}
```

**`SwapForm.tsx`** — Three changes needed:

*1. Expand available token list:*

```ts
// Before: ["SUI", "USDC"]
// After:  ["SUI", "USDC", "DEEP"]   // mainnet
//         ["SUI", "DEEP"]           // testnet (if DeepBook pool exists)
```

*2. Refactor `isBid` logic* (currently assumes SUI is always base):

```ts
// Before: hardcoded per stablecoin name
const isBid = tokenInSymbol === "USDC" || tokenInSymbol === "DBUSDC"

// After: derive from pair config
const pairConfig = getDeepBookPairConfig(tokenInSymbol, tokenOutSymbol)
const isBid = pairConfig.tokenIn === pairConfig.quote
```

*3. Refactor DeepBook pool selection* (currently one pool per network):

```ts
// Before: single hardcoded pool per network
// After: map by token pair
function getDeepBookPoolId(tokenA: string, tokenB: string, network: Network): string {
  const key = [tokenA, tokenB].sort().join("_")
  return DEEPBOOK_POOLS[network][key]
}
```

**Relayer** — No changes needed. It accepts `tokenTypeIn/Out` and `isBid` as parameters and is fully token-agnostic.

### Mainnet vs Testnet Differences

| Aspect | Mainnet | Testnet |
| ------ | ------- | ------- |
| DEEP coin type | `0xdeeb7a...::deep::DEEP` | `0x36dbef...::deep::DEEP` |
| DeepBook DEEP/SUI liquidity | Real, active market | Uncertain |
| Octopus DEEP pool | Needs deployment | Needs deployment (or skip) |
| Recommended priority | High | Low — mock with `swap_for_testing` if needed |

### Implementation Steps

1. Deploy `PrivacyPool<DEEP>` on mainnet (and optionally testnet) via Sui CLI
2. Record pool Object ID; add to `.env` and `constants.ts`
3. Look up DeepBook DEEP/SUI pool ID on mainnet (SuiScan / DeepBook registry)
4. Update `NetworkConfigProvider.tsx` to include DEEP token config
5. Refactor `SwapForm.tsx` — pool selection map and `isBid` logic
6. Test on mainnet with a small amount before full release

---

## Resources

- [DeepBook V3 Documentation](https://docs.sui.io/standards/deepbook)
- [Swap Circuit Source](../../circuits/swap.circom)
- [Contract Source](../../contracts/sources/pool.move)
- [SDK DeepBook Module](../../sdk/src/deepbook.ts)

---

**Last Updated**: 2026-02-17
**Status**: ✅ Complete — Active on Testnet & Mainnet
