# Octopus Privacy Pool Contracts

Move contracts for the Octopus privacy protocol on Sui blockchain.

## Architecture

### Core Modules

- **`pool`** - Main privacy pool: shield / unshield / transfer / swap
- **`merkle_tree`** - Incremental Merkle tree (depth 16, Poseidon hashing)
- **`nullifier`** - Nullifier registry to prevent double-spending

### Admin Capability

`PoolAdminCap` lets the holder update circuit verification keys after a circuit change:

- `update_unshield_vk()` / `update_transfer_vk()` / `update_swap_vk()`

### Entry Points

**Shield** — deposit tokens, no proof required:

```text
pool::shield<T>(pool, coin, commitment, encrypted_note, ctx)
```

**Unshield** — withdraw with ZK proof; recipient is cryptographically bound to the proof (prevents relayer substitution):

```text
pool::unshield<T>(pool, proof_bytes, public_inputs_bytes, nullifiers, recipient, encrypted_change_note, ctx)
```

- Public inputs (6 field elements): `nullifiers_hash`, `change_commitment`, `recipient_hash`, `unshield_amount`, `token`, `merkle_root`
- Change note created automatically if input > withdrawal amount

**Transfer** — private pool-to-pool transfer:

```text
pool::transfer<T>(pool, proof_bytes, public_inputs_bytes, nullifiers, encrypted_notes, ctx)
```

- Public inputs (5 field elements): `nullifiers_hash`, `recipient_commitment`, `change_commitment`, `token`, `merkle_root`

**Swap** — private swap via DeepBook V3:

```text
# Ask: base → quote (e.g. SUI → USDC)
pool::swap<TokenIn, TokenOut>(pool_in, pool_out, deepbook_pool, proof_bytes, public_inputs_bytes, nullifiers, deep_in, clock, encrypted_output_note, encrypted_change_note, ctx)

# Bid: quote → base (e.g. USDC → SUI)
pool::swap_bid<Base, Quote>(pool_in, pool_out, deepbook_pool, ...)
```

- Public inputs (8 field elements): `nullifiers_hash`, `swap_commitment`, `change_commitment`, `token_in`, `token_out`, `amount_in`, `min_amount_out`, `merkle_root`
- `deep_in` covers DeepBook fees; unused DEEP is returned to sender
- `pool::swap_for_testing` — skips proof verification, 1:1 mock swap (test only)

> ⚠️ **DeepBook V3 is only available on Mainnet.**

### Key Concepts

- **Nullifiers** are private circuit inputs. The circuit outputs `nullifiers_hash = Poseidon(nullifier1, nullifier2)`; the contract re-derives the hash from the explicitly-passed nullifiers to verify they match the proof, then marks them spent.
- A second nullifier of all-zeros is a dummy (single-input note); the contract skips registering it.
- The pool keeps the last **100 Merkle roots**, so proofs remain valid even if new deposits arrive before your transaction lands.
- **View helpers**: `get_merkle_root`, `get_note_count`, `get_balance`, `is_nullifier_spent`

## Deployment

### Initial Deployment

```bash
# 1. Compile circuits
cd circuits/scripts && ./compile.sh

# 2. Deploy package (testnet by default)
cd ../../contracts/scripts
./deploy_package.sh
./deploy_package.sh --network mainnet

# 3. Create pools
./create_pool.sh                               # SUI + USDC, testnet
./create_pool.sh --coin usdc --network mainnet # USDC, mainnet
```

All scripts auto-update the relevant `NEXT_PUBLIC_*` vars in `frontend/.env` and the corresponding unprefixed vars in `relayer/.env` (if present).

### Scripts Reference

| Script              | Purpose                  | Usage                                                           |
| ------------------- | ------------------------ | --------------------------------------------------------------- |
| `deploy_package.sh` | Publish Move package     | `./deploy_package.sh [--network testnet\|mainnet]`              |
| `create_pool.sh`    | Create privacy pool(s)   | `./create_pool.sh [--coin sui\|usdc\|both] [--network ...]`     |
| `update_vk.sh`      | Update verification keys | `./update_vk.sh [unshield\|transfer\|swap] [sui\|usdc\|both]`   |

## Updating Verification Keys

```bash
# After editing and recompiling a circuit:
cd circuits && ./scripts/compile.sh transfer
cd ../contracts/scripts && ./update_vk.sh transfer

# Update all VKs at once:
cd circuits && ./scripts/compile.sh
cd ../contracts/scripts && ./update_vk.sh
```

## Testing

```bash
sui move build
sui move test
sui move test -f test_shield_and_unshield
```
