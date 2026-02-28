# Circuits

This directory contains the Zero-Knowledge Succinct Non-Interactive Argument of Knowledge (ZK-SNARK) circuits for the Octopus project, implemented using `circom` and `snarkjs`.

## Circuits Overview

All Octopus circuits share a common foundation:

- **Merkle Tree**: Used for membership proofs (depth: 16).
- **Poseidon Hash**: Used for commitments and nullifiers.
- **UTXO Model**: All circuits support a 2-input model (where one or both can be dummy notes with zero value).

### Unshield Circuit (`unshield.circom`)

| Property       | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Public Inputs  | `unshield_amount`, `token`, `merkle_root`                              |
| Public Outputs | `nullifiers_hash`, `change_commitment`, `recipient_hash`               |
| Private Inputs | Keys, 2 input notes, Merkle paths, change amount/random, recipient address |
| Input Model    | 2-input (1 real + 1 dummy, or 2 real notes)                            |
| Merkle Depth   | 16 levels                                                              |

The circuit proves:

1. Knowledge of spending_key and nullifying_key (ownership)
2. Input notes exist in Merkle tree
3. Correct nullifier derivation (prevents double-spend)
4. Balance conservation: `sum(inputs) = unshield_amount + change_amount`
5. Correct change commitment computation
6. Integrity of the recipient address (bound by `recipient_hash`)

### Transfer Circuit (`transfer.circom`)

| Property          | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Public Inputs     | `token`, `merkle_root`                                                                            |
| Public Outputs    | `nullifiers_hash`, `recipient_commitment`, `change_commitment`                                    |
| Private Inputs    | Keys, 2 input notes, Merkle paths, recipient MPK/amount/random, change amount/random              |
| Transaction Model | 2-input, 2-output UTXO                                                                            |

The circuit proves:

1. Ownership of 2 input notes (or 1 note + 1 dummy)
2. Input notes exist in Merkle tree
3. Correct nullifier derivation for spent notes
4. Balance conservation: `sum(inputs) = recipient_amount + change_amount`
5. Valid output commitments for recipient and change notes

### Swap Circuit (`swap.circom`)

> ⚠️ **DeepBook V3 is only available on Mainnet.** Swap functionality is currently limited to Mainnet deployments.

| Property       | Value                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| Public Inputs  | `token_in`, `token_out`, `amount_in`, `min_amount_out`, `merkle_root`             |
| Public Outputs | `nullifiers_hash`, `swap_commitment`, `change_commitment`                         |
| Private Inputs | Keys, 2 input notes, Merkle paths, swap random, change amount/random              |
| Input Model    | 2-input (same token type as `token_in`)                                         |

The circuit proves:

1. Ownership and validity of input notes
2. Correct swap execution with slippage protection (`min_amount_out`)
3. Valid output notes (swapped tokens in `token_out` + change in `token_in`)

## Scripts Usage

The following scripts, located in the `circuits/scripts/` directory, are used for compiling circuits, generating test inputs, and converting outputs to the Sui Arkworks format. These scripts are typically executed from the `circuits/` directory.

### Compilation Scripts

Use `scripts/compile.sh` to compile one or more circuits:

```bash
./scripts/compile.sh                    # compile all three (default)
./scripts/compile.sh unshield           # compile only unshield
./scripts/compile.sh transfer swap      # compile transfer and swap
```

Multiple circuits are compiled in parallel. Single circuit shows inline output.

| Script               | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `scripts/compile.sh` | Compile any combination of unshield / transfer / swap |

### Test Input Generation Scripts

| Script                                  | Purpose                                      | When to Use                                                                |
| --------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| `scripts/generateUnshieldTestInput.js`  | Generates a test input for `unshield.circom`.  | Before generating a proof, to create `build/unshield_input.json` for testing. |
| `scripts/generateTransferTestInput.js`  | Generates a test input for `transfer.circom`.  | Before generating a proof, to create `build/transfer_input.json` for testing. |

### Arkworks Converter Scripts

| Script                                 | Purpose                                                                | When to Use                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `scripts/arkworksConverterUnshield.js`         | Converts `unshield` outputs to Sui's Arkworks format.                  | After generating a proof for the unshield circuit to prepare it for on-chain verification.     |
| `scripts/arkworksConverterSwap.js`     | Converts the `swap` verification key to Sui's Arkworks format.         | After compiling the swap circuit to prepare its verification key for the smart contract.         |
| `scripts/arkworksConverterTransfer.js` | Converts `transfer` outputs to Sui's Arkworks format.                  | After generating a proof for the transfer circuit to prepare it for on-chain verification.     |
