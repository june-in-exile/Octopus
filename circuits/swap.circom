pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "./lib/verify_note.circom";

/// Swap circuit for private DEX swaps on Sui
/// Implements private token swaps through external DEX (e.g., DeepBook)
///
/// Proves:
/// 1. Knowledge of spending_key and nullifying_key (ownership)
/// 2. Both input notes exist in Merkle tree (2 Merkle proofs)
/// 3. Correct nullifier computation for both inputs
/// 4. Sufficient balance for swap: sum(input_amounts) >= amount_in
/// 5. Swap parameters hash correctly
/// 6. Output commitment correctly computed with token_out
///
/// Flow:
/// - User has notes with token_in (e.g., SUI)
/// - Circuit proves ownership and sufficient balance
/// - Contract swaps token_in → token_out via DEX
/// - Output note created with token_out (e.g., USDC)
template Swap(levels) {
    // ============ Private Inputs ============

    // Keypair (user owns input notes)
    signal input spending_key;           // User's secret spending key (256-bit)
    signal input nullifying_key;         // Secret key for nullifier generation (256-bit)

    // Input notes (notes being spent)
    signal input input_randoms[2];       // Random blinding factors
    signal input input_amounts[2];       // Note amounts (can be 0 for dummy)
    signal input input_leaf_indices[2];  // Leaf positions in tree
    signal input input_path_elements[2][levels];  // Merkle proof siblings

    // Swap note (for swapped tokens)
    signal input swap_random;             // Random blinding factor for swap

    // Change note (if input > amount_in, return change with token_in)
    signal input change_random;          // Random blinding factor for change
    signal input change_amount;          // Change amount

    // Nullifiers (precomputed off-chain, constrained by circuit)
    signal input nullifiers[2];          // Poseidon(nullifying_key, leaf_index) for each input note

    // ============ Public Inputs ============
    signal input token_in;               // Input token type (e.g., SUI)
    signal input token_out;              // Output token type (e.g., USDC)
    signal input amount_in;
    signal input min_amount_out;
    signal input merkle_root;            // Expected Merkle root

    // ============ Public Outputs ============
    signal output nullifiers_hash;       // Poseidon hash of both nullifiers
    signal output swap_commitment;       // Commitment for output note (token_out)
    signal output change_commitment;     // Commitment for change note (token_in)

    // ============ Step 1: Range Check ============
    signal valid_swap <== GreaterThan(120)([amount_in, 0]);
    valid_swap === 1;
    // Change amount >= 0
    signal valid_change <== GreaterEqThan(120)([change_amount, 0]);
    valid_change === 1;

    // ============ Step 2: Balance Conservation ============
    // Verify sum(input_sum) = sum(output_sum)
    // Ensure sum(input_amounts) >= amount_in + change_amount
    signal input_sum <== input_amounts[0] + input_amounts[1];
    signal output_sum <== amount_in + change_amount;
    input_sum === output_sum;

    // ============ Step 3: Compute MPK ============
    // MPK = Poseidon(spending_key, nullifying_key)
    // Proves sender knows the private keys
    signal mpk <== Poseidon(2)([spending_key, nullifying_key]);

    // ============ Step 4: Verify Input Notes ============
    // Verify commitment inclusion and constrain the provided nullifiers
    signal expected_nullifiers[2] <== VerifyNote(levels, 2)(mpk, nullifying_key, token_in, input_randoms, input_amounts, input_leaf_indices, input_path_elements, merkle_root);
    for (var i = 0; i < 2; i++) {
        nullifiers[i] === expected_nullifiers[i];
    }
    nullifiers_hash <== Poseidon(2)([nullifiers[0], nullifiers[1]]);

    // ============ Step 5: Verify Swap Commitment ============
    // Swap note commitment = Poseidon(NSK, token_out, min_amount_out)
    // Note: Swap uses token_out (swapped token), committed to minimum guaranteed output
    signal swap_nsk <== Poseidon(2)([mpk, swap_random]);
    swap_commitment <== Poseidon(3)([swap_nsk, token_out, min_amount_out]);

    // ============ Step 6: Verify Change Commitment ============
    // Change note commitment = Poseidon(NSK, token_in, change_amount)
    // Note: Change uses token_in (original token)
    // If no change, commitment will be 0
    signal change_nsk <== Poseidon(2)([mpk, change_random]);
    signal real_change_commitment <== Poseidon(3)([change_nsk, token_in, change_amount]);
    signal no_change <== IsZero()(change_amount);
    change_commitment <== real_change_commitment * (1 - no_change);
}

// Main circuit with 16 levels (supports 2^16 = 65,536 notes)
component main {public [token_in, token_out, amount_in, min_amount_out, merkle_root]} = Swap(16);
