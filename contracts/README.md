# Octopus Privacy Pool Contracts

Move contracts for the Octopus privacy protocol on Sui blockchain.

## Table of Contents

- [Contract Architecture](#contract-architecture)
- [Deployment Workflow](#deployment-workflow)
- [Updating Verification Keys](#updating-verification-keys)
- [Scripts Reference](#scripts-reference)

## Contract Architecture

### Core Modules

- **`pool`** - Main privacy pool with shield/unshield/transfer/swap operations
- **`merkle_tree`** - Incremental Merkle tree (depth 16) with Poseidon hashing
- **`nullifier`** - Nullifier registry to prevent double-spending

### Admin Capability

The pool includes an admin capability system (`PoolAdminCap`) that allows updating verification keys when circuits are modified during development.

**Admin Functions:**

- `update_unshield_vk()` - Update unshield circuit verification key
- `update_transfer_vk()` - Update transfer circuit verification key
- `update_swap_vk()` - Update swap circuit verification key

### Entry Points

**Shield** (deposit): `pool::shield<T>(pool, coin, commitment, encrypted_note, ctx)`

- No ZK proof required, adds commitment to Merkle tree

**Unshield** (withdraw): `pool::unshield<T>(pool, proof_bytes, public_inputs_bytes, nullifiers, recipient, encrypted_change_note, ctx)`

- Requires 128-byte Groth16 proof + public inputs bytes
- `nullifiers`: `vector<vector<u8>>` (BCS-encoded, passed separately from proof)
- Public inputs: `unshield_amount`, `token`, `merkle_root` + outputs `nullifiers_hash`, `change_commitment`
- Supports 1 or 2 input notes; automatic change note creation if needed

**Transfer** (private transfer): `pool::transfer<T>(pool, proof_bytes, public_inputs_bytes, nullifiers, encrypted_notes, ctx)`

- Requires Groth16 proof for a 2-input, 2-output private transfer
- `nullifiers`: `vector<vector<u8>>` (BCS-encoded, passed separately from proof)
- Public inputs: `token`, `merkle_root` + outputs `nullifiers_hash`, `recipient_commitment`, `change_commitment`

**Swap** (private swap): `pool::swap<TokenIn, TokenOut>(pool_in, pool_out, deepbook_pool, proof_bytes, public_inputs_bytes, nullifiers, deep_in, clock, encrypted_output_note, encrypted_change_note, ctx)`

- Requires Groth16 proof for a private swap
- `nullifiers`: `vector<vector<u8>>` (BCS-encoded, passed separately from proof)
- Public inputs: `token_in`, `token_out`, `amount_in`, `min_amount_out`, `merkle_root` + outputs `nullifiers_hash`, `swap_commitment`, `change_commitment`
- Executes swap via DeepBook V3; enforces `min_amount_out` slippage protection
- For testing without a real DeepBook pool, use `pool::swap_for_testing` (skips proof verification, uses 1:1 mock swap)

> ⚠️ **DeepBook V3 is only available on Mainnet.** Swap functionality requires a Mainnet deployment.

### Nullifier Handling

Nullifiers are **private inputs** to the ZK circuit. The circuit outputs `nullifiers_hash = Poseidon(nullifier1, nullifier2)` as a public output. The actual nullifiers must be provided separately so the contract can:

1. Verify `Poseidon(nullifier1, nullifier2) === nullifiers_hash` from the proof
2. Mark each nullifier as spent in the on-chain registry

## Deployment Workflow

### Initial Deployment

```bash
# 1. Compile circuits and generate verification keys
cd circuits/scripts
./compile.sh

# 2. Update .env with VK hex strings
cd ../../contracts/scripts
# Copy VK values from circuits/build/*_vk_bytes.hex to .env
# UNSHIELD_VK=<hex from circuits/build/unshield_vk_bytes.hex>
# TRANSFER_VK=<hex from circuits/build/transfer_vk_bytes.hex>
# SWAP_VK=<hex from circuits/build/swap_vk_bytes.hex>

# 3. Deploy package (default: testnet)
./deploy_package.sh
# Or deploy to mainnet:
./deploy_package.sh --network mainnet
# Auto-updates NEXT_PUBLIC_TESTNET_PACKAGE_ID or NEXT_PUBLIC_MAINNET_PACKAGE_ID in .env

# 4. Create SUI pool (default: SUI pool on testnet)
./create_pool.sh
# Or create USDC pool on mainnet:
./create_pool.sh --coin usdc --network mainnet
# Auto-updates NEXT_PUBLIC_TESTNET_SUI_POOL_ID / NEXT_PUBLIC_MAINNET_USDC_POOL_ID etc. in .env
```

### When to Use Each Script

#### `deploy_package.sh`

**Use when:**

- Initial deployment
- Contract code changes (Move source files modified)
- Adding new functions or changing contract logic

**Options:**

- `--network testnet|mainnet` — target network (default: `testnet`)

**What it does:**

1. Switches active Sui client env to the target network
2. Builds Move package (`sui move build`)
3. Publishes package (`sui client publish`)
4. Updates `NEXT_PUBLIC_TESTNET_PACKAGE_ID` or `NEXT_PUBLIC_MAINNET_PACKAGE_ID` in `.env`

**Note:** Publishing creates a new immutable package. To upgrade an existing package, use `sui client upgrade` instead.

#### `create_pool.sh`

**Use when:**

- After deploying a new package
- Creating pool instances for SUI and/or USDC tokens

**Usage:**

```bash
./create_pool.sh                              # SUI + USDC pools, testnet (default)
./create_pool.sh --coin usdc                  # USDC pool, testnet
./create_pool.sh --coin both                  # SUI + USDC pools, testnet
./create_pool.sh --network mainnet            # SUI pool, mainnet
./create_pool.sh --coin usdc --network mainnet # USDC pool, mainnet
```

**What it does:**

1. Reads `NEXT_PUBLIC_TESTNET_PACKAGE_ID` / `NEXT_PUBLIC_MAINNET_PACKAGE_ID` from `.env`
2. Calls `pool::create_shared_pool<T>()` with verification keys from circuit build output
3. Creates shared `PrivacyPool<T>` object(s) and transfers `PoolAdminCap` to caller
4. Updates the following network-specific vars in `.env` automatically:
   - `NEXT_PUBLIC_{NETWORK}_SUI_POOL_ID` / `NEXT_PUBLIC_{NETWORK}_USDC_POOL_ID`
   - `{NETWORK}_UNSHIELD_VK`, `{NETWORK}_TRANSFER_VK`, `{NETWORK}_SWAP_VK`
   - `NEXT_PUBLIC_{NETWORK}_USDC_TYPE`

**Note:** Each pool instance has its own Merkle tree and nullifier registry. USDC pool enables private swaps via DeepBook.

> ⚠️ **DeepBook V3 is only available on Mainnet.** Swap functionality requires a Mainnet deployment.

## Updating Verification Keys

When you modify a circuit (e.g., fixing bugs or adding features), you need to update the verification key in the deployed pool.

```bash
cd circuits

# Edit the circuit file (e.g., transfer.circom)
# Make your changes...

# Recompile the circuit
./compile.sh transfer

# This generates new files in build/:
# - transfer_js/transfer.wasm (circuit logic)
# - transfer_final.zkey (proving key)
# - transfer_vk_bytes.hex (verification key hex)
# - transfer_vk.json (verification key JSON)

# And copied artifacts to frontend
# cp circuits/build/transfer_js/transfer.wasm ../frontend/public/circuits/transfer_js/
# cp circuits/build/transfer_final.zkey ../frontend/public/circuits/
# cp circuits/build/transfer_vk.json ../frontend/public/circuits/

cd ../contracts/scripts

# Update transfer VK for both pools (default)
./update_vk.sh transfer

# Update for specific pool only
./update_vk.sh transfer sui
./update_vk.sh transfer usdc
```

### Update Script Usage

`update_vk.sh` accepts an optional VK type and pool type:

```bash
./update_vk.sh                    # all VKs, both pools (default)
./update_vk.sh unshield           # unshield VK, both pools
./update_vk.sh transfer sui       # transfer VK, SUI pool only
./update_vk.sh swap usdc          # swap VK, USDC pool only
```

**What the script does:**

1. Loads environment variables from `.env`
2. Reads new VK from circuit build output
3. Compares with old VK to check if update is needed
4. Finds your `PoolAdminCap` object ID automatically
5. Calls the appropriate update function on-chain
6. Updates the VK in `.env`

### Finding Your AdminCap

```bash
# List all objects you own
sui client objects

# Find AdminCap object ID
sui client objects --json | jq -r '.[] | select(.data.type | contains("PoolAdminCap")) | .data.objectId'

# View AdminCap details
sui client object <ADMIN_CAP_ID>
```

### Quick Update Examples

```bash
# Example 1: Update transfer VK after circuit modification
cd circuits && ./scripts/compile.sh transfer
cd ../contracts/scripts && ./update_vk.sh transfer

# Example 2: Update all VKs after major circuit refactor
cd circuits && ./scripts/compile.sh
cd ../contracts/scripts && ./update_vk.sh
```

## Scripts Reference

All scripts are located in the `scripts/` directory.

| Script              | Purpose                  | Usage                                                                           | When to Use                        |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------- |
| `deploy_package.sh` | Publish Move package     | `./deploy_package.sh [--network testnet\|mainnet]`                              | Initial deploy, contract changes   |
| `create_pool.sh`    | Create privacy pool(s)   | `./create_pool.sh [--coin sui\|usdc\|both] [--network testnet\|mainnet]`        | After package deploy               |
| `update_vk.sh`      | Update verification keys | `./update_vk.sh [vk] [pool]`                                                    | After modifying any circuit        |

**`update_vk.sh` arguments:** `vk` = `unshield` \| `transfer` \| `swap` \| `all` (default), `pool` = `sui` \| `usdc` \| `both` (default).

## Testing

```bash
# Build contracts
sui move build

# Run tests
sui move test

# Run specific test
sui move test -f test_shield_and_unshield
```
