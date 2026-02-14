pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "./lib/verify_note.circom";

/// Transfer circuit for Octopus on Sui
/// Implements 2-input, 2-output private transfers within the privacy pool
///
/// Proves:
/// 1. Knowledge of spending_key and nullifying_key (ownership)
/// 2. Both input notes exist in Merkle tree (2 Merkle proofs)
/// 3. Correct nullifier computation for both inputs
/// 4. Correct commitment computation for both outputs
/// 5. Balance conservation: sum(input_amounts) = sum(output_amounts)
///
/// Based on cryptographic formulas:
/// - MPK = Poseidon(spending_key, nullifying_key)
/// - NSK = Poseidon(MPK, random)
/// - Commitment = Poseidon(NSK, token, amount)
/// - Nullifier = Poseidon(nullifying_key, leaf_index)
template Transfer(levels) {
    // ============ Private Inputs ============

    // Keypair (shared for both input notes - sender owns both)
    signal input spending_key;           // User's secret spending key (256-bit)
    signal input nullifying_key;         // Secret key for nullifier generation (256-bit)

    // Input notes (notes being spent)
    signal input input_randoms[2];       // Random blinding factors
    signal input input_amounts[2];       // Note amounts (can be 0 for dummy)
    signal input input_leaf_indices[2];  // Leaf positions in tree
    signal input input_path_elements[2][levels];  // Merkle proof siblings

    // Output notes (notes being created)
    signal input recipient_mpk;          // Recipient master public key
    signal input recipient_random;       // Random blinding factor for recipient
    signal input recipient_amount;       // Recipient amount

    // Change note (if input > recipient_amount, return change)
    signal input change_random;          // Random blinding factor for change
    signal input change_amount;          // Change amount

    // Nullifiers (precomputed off-chain, constrained by circuit)
    signal input nullifiers[2];          // Poseidon(nullifying_key, leaf_index) for each input note

    // ============ Public Inputs ============
    signal input token;                  // Token identifier (address hash)
    signal input merkle_root;            // Expected Merkle root

    // ============ Public Outputs ============
    signal output nullifiers_hash;       // Poseidon hash of both nullifiers
    signal output recipient_commitment;  // Commitments for recipient
    signal output change_commitment;     // Commitments for change

    // ============ Step 1: Range Check ============
    // Recipient amount > 0
    signal valid_recipient <== GreaterThan(120)([recipient_amount, 0]);
    valid_recipient === 1;
    // Change amount >= 0
    signal valid_change <== GreaterEqThan(120)([change_amount, 0]);
    valid_change === 1;

    // ============ Step 2: Balance Conservation ============
    // Verify sum(input_amounts) = sum(output_amounts)
    signal input_sum <== input_amounts[0] + input_amounts[1];
    signal output_sum <== recipient_amount + change_amount;
    input_sum === output_sum;

    // ============ Step 3: Compute MPK ============
    // MPK = Poseidon(spending_key, nullifying_key)
    // Proves sender knows the private keys
    signal sender_mpk <== Poseidon(2)([spending_key, nullifying_key]);

    // ============ Step 4: Verify Input Notes ============
    // Verify commitment inclusion and constrain the provided nullifiers
    signal expected_nullifiers[2] <== VerifyNote(levels, 2)(sender_mpk, nullifying_key, token, input_randoms, input_amounts, input_leaf_indices, input_path_elements, merkle_root);
    for (var i = 0; i < 2; i++) {
        nullifiers[i] === expected_nullifiers[i];
    }
    nullifiers_hash <== Poseidon(2)([nullifiers[0], nullifiers[1]]);

    // ============ Step 5: Verify Output Commitments ============
    // Output note commitment = Poseidon(recipient_NSK, token, amount)
    signal recipient_nsk <== Poseidon(2)([recipient_mpk, recipient_random]);
    recipient_commitment <== Poseidon(3)([recipient_nsk, token, recipient_amount]);

    // ============ Step 6: Verify Change Commitment ============
    // Change note commitment = Poseidon(sender_NSK, token, change_amount)
    // If no change, commitment will be 0
    signal change_nsk <== Poseidon(2)([sender_mpk, change_random]);
    signal real_change_commitment <== Poseidon(3)([change_nsk, token, change_amount]);
    signal no_change <== IsZero()(change_amount);
    change_commitment <== real_change_commitment * (1 - no_change);
}

// Main circuit with 16 levels (supports 2^16 = 65,536 notes)
component main {public [token, merkle_root]} = Transfer(16);