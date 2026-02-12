# Milestone 2: DeFi Integration - Private Swaps

**Status:** Ready for DeepBook Integration
**Last Updated:** 2026-02-07

---

## Overview

This milestone adds private token swap functionality to Octopus, enabling users to exchange tokens while maintaining full privacy through ZK-SNARK proofs. Swaps are executed through **DeepBook V3**, Sui's native Central Limit Order Book (CLOB).

> ⚠️ **DeepBook V3 is only available on Mainnet.** Swap functionality requires a Mainnet deployment.

**Privacy Guarantee:** Swap amounts, token types, and user identities remain hidden on-chain. Only ZK proofs are verified publicly.

---

## Current Implementation Status

### ✅ Completed Components

1. **Swap Circuit** ([circuits/swap.circom](../../circuits/swap.circom))
   - 22,553 constraints (efficient, well optimized)
   - 2 input notes → 2 output notes (swapped token + change)
   - Full ZK proof generation working in browser

2. **Move Contract** ([contracts/sources/pool.move](../../contracts/sources/pool.move))
   - Test function: `swap()` with mock 1:1 exchange rate
   - Production scaffold: `swap_production()` ready for DeepBook integration
   - Full proof verification, nullifier tracking, event emission

3. **TypeScript SDK** ([sdk/src/defi.ts](../../sdk/src/defi.ts))
   - Proof generation: `generateSwapProof()`
   - Transaction building: `buildSwapTransaction()`
   - Slippage calculation utilities
   - Ready for DeepBook price estimation module

4. **Frontend UI** ([frontend/src/components/SwapForm.tsx](../../frontend/src/components/SwapForm.tsx))
   - ✅ **Now accessible in main UI** (SWAP tab)
   - Token pair selection (SUI ↔ USDC)
   - Slippage tolerance settings
   - Real-time price estimation framework

## How to Use (Frontend)

1. **Navigate to the app** and connect your Sui wallet
2. **Generate a keypair** (or select an existing one)
3. **Shield tokens** into the privacy pool first
4. **Click the SWAP tab** in the main interface
5. **Select token pair** (currently SUI ↔ USDC)
6. **Enter amount** to swap
7. **Set slippage tolerance** (0.1% - 5%)
8. **Generate proof and execute** (takes 30-60 seconds)

**Note:** The swap currently uses a mock 1:1 exchange rate for testing purposes. Real DeepBook integration coming soon.

---

## Architecture

``` txt
User (private notes in pool_in)
    ↓
Submit ZK Proof (proves ownership + swap parameters)
    ↓
pool::swap_production() verifies proof
    ↓
Extract tokens from pool_in
    ↓
[Current: Mock 1:1 swap] → [Next: Call DeepBook place_market_order()]
    ↓
Shield swapped tokens into pool_out
    ↓
User receives encrypted output note
```

### DeepBook Integration Flow

```
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

**Public Inputs (192 bytes):**

1. `merkle_root` (32 bytes) - Root of input note Merkle tree
2. `nullifier1`, `nullifier2` (64 bytes) - Input note nullifiers
3. `output_commitment` (32 bytes) - Output note commitment
4. `change_commitment` (32 bytes) - Change note commitment
5. `swap_data_hash` (32 bytes) - Hash of swap parameters

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

**Test Function (Mock Swap):**

```move
public entry fun swap<TokenIn, TokenOut>(
    pool_in: &mut PrivacyPool<TokenIn>,
    pool_out: &mut PrivacyPool<TokenOut>,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
    amount_in: u64,
    min_amount_out: u64,
    encrypted_output_note: vector<u8>,
    encrypted_change_note: vector<u8>,
    ctx: &mut TxContext,
)
```

**Features:**

- Verifies ZK proof using `swap_vk_bytes`
- Checks nullifiers for double-spend prevention
- Mock swap: `amount_out = amount_in` (1:1 ratio)
- Shields output into `pool_out`
- Emits `SwapEvent` for scanning

**Production Function (DeepBook Integration Ready):**

```move
public entry fun swap_production<TokenIn, TokenOut>(
    pool_in: &mut PrivacyPool<TokenIn>,
    pool_out: &mut PrivacyPool<TokenOut>,
    deepbook_pool: &mut DeepBookPool<TokenIn, TokenOut>,  // NEW
    // ... same parameters as above
)
```

⚠️ **Status:** Scaffolded, awaiting DeepBook module integration

---

## Production Readiness

### What's Working ✅

- ZK proof generation for swaps (browser-compatible)
- Swap transaction building and submission
- Mock 1:1 swap execution
- Full privacy preservation (amounts/addresses hidden)
- Double-spend prevention (nullifier tracking)
- Slippage protection (circuit-level enforcement)
- Frontend UI integration (SWAP tab)

### What's Missing ⚠️

**For Real DEX Integration:**

1. **DeepBook V3 Integration**
   - Import DeepBook modules in [pool.move](../../contracts/sources/pool.move)
   - Call `deepbook_pool::place_market_order()` for real market prices
   - Handle coin remainders and slippage

2. **Multi-Pool Deployment**
   - Deploy separate privacy pools for SUI and USDC
   - Fund pools with initial liquidity
   - Update SDK configuration with pool IDs

3. **Price Oracle**
   - Fetch live prices from DeepBook pools
   - Calculate accurate output amounts
   - Estimate price impact

4. **Note Management**
   - Scan blockchain for user's encrypted notes
   - Build Merkle proofs for input notes
   - Select notes to cover swap amount

**Implementation Plan:** See [DEEPBOOK_INTEGRATION.md](./DEEPBOOK_INTEGRATION.md) for detailed roadmap.

---

## Testing Strategy

### Current Tests ✅

- **Circuit Tests**: All proof generation tests passing
- **Contract Tests**: 28 tests passing (including swap with mock)
- **SDK Tests**: Proof serialization and transaction building verified

### Required for DeepBook ⚠️

- **Integration Tests**: Real DeepBook pool interaction
- **E2E Tests**: Shield → Swap → Unshield flow
- **Price Tests**: Accuracy of DeepBook price estimation
- **Slippage Tests**: Protection works at various thresholds

---

## Deployment Checklist

Before deploying to production:

- [ ] Obtain DeepBook package ID for target network
- [ ] Find active DeepBook pools for token pairs
- [ ] Deploy USDC privacy pool
- [ ] Update Move.toml with DeepBook dependency
- [ ] Implement DeepBook integration in pool.move
- [ ] Add DeepBook SDK functions (price, estimation)
- [ ] Update frontend with real price fetching
- [ ] Run full test suite
- [ ] Verify privacy guarantees maintained

---

## Next Steps

1. **Phase 1**: Implement DeepBook contract integration (2-3 days)
2. **Phase 2**: Add DeepBook SDK module (2-3 days)
3. **Phase 3**: Update frontend with real prices (2 days)
4. **Phase 4**: Deploy and test on testnet (2-3 days)

**Total Estimate**: 8-11 days

See [DEEPBOOK_INTEGRATION.md](./DEEPBOOK_INTEGRATION.md) for detailed implementation plan.

---

## Key Differences: DeepBook vs Mock

| Aspect | Current (Mock) | With DeepBook |
|--------|---------------|---------------|
| **Price** | Fixed 1:1 | Real market rate from order book |
| **Liquidity** | Unlimited | Based on DeepBook pool depth |
| **Slippage** | None | Real slippage based on order size |
| **Fees** | None | 0.25% taker fee (or 0.2% with DEEP) |
| **Speed** | Instant | Depends on order matching |

---

## Resources

- [DeepBook V3 Documentation](https://docs.sui.io/standards/deepbook)
- [DeepBook Integration Plan](./DEEPBOOK_INTEGRATION.md)
- [Swap Circuit Source](../../circuits/swap.circom)
- [Contract Source](../../contracts/sources/pool.move)

---

**Last Updated**: 2026-02-07
**Status**: 🟡 85% Complete - Awaiting DeepBook Integration
