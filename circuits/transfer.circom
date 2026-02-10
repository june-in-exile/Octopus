pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "./lib/merkle_proof.circom";

/// Transfer circuit for Octopus on Sui
/// Implements 2-input, 2-output private transfers within the privacy pool
///
/// Proves:
/// 1. Knowledge of spending_key and nullifying_key (ownership)
/// 2. Both input notes exist in Merkle tree (2 Merkle proofs)
/// 3. Correct nullifier computation for both inputs
/// 4. Correct commitment computation for both outputs
/// 5. Balance conservation: sum(input_values) = sum(output_values)
///
/// Based on cryptographic formulas:
/// - MPK = Poseidon(spending_key, nullifying_key)
/// - NSK = Poseidon(MPK, random)
/// - Commitment = Poseidon(NSK, token, value)
/// - Nullifier = Poseidon(nullifying_key, leaf_index)
template Transfer(levels) {
    // ============ Private Inputs ============

    // Keypair (shared for both input notes - sender owns both)
    signal input spending_key;           // User's secret spending key (256-bit)
    signal input nullifying_key;         // Secret key for nullifier generation (256-bit)

    // Input notes (notes being spent)
    signal input input_randoms[2];       // Random blinding factors
    signal input input_values[2];        // Note amounts (can be 0 for dummy)
    signal input input_leaf_indices[2];  // Leaf positions in tree
    signal input input_path_elements[2][levels];  // Merkle proof siblings

    // Output notes (notes being created)
    signal input recipient_mpk;          // Recipient master public key
    signal input transfer_value;         // Transfer amount
    signal input transfer_random;        // Random blinding factor for transfer

    // Change note (if input > transfer_value, return change)
    signal input change_value;           // Change amount
    signal input change_random;          // Random blinding factor for change

    // ============ Public Inputs ============
    signal input token;                  // Token identifier (address hash)
    signal input merkle_root;            // Expected Merkle root

    // ============ Public Outputs ============
    signal output input_nullifiers[2];   // Nullifiers for input notes
    signal output transfer_commitment;   // Commitments for transferred amount
    signal output change_commitment;     // Commitments for change

    // ============ Step 1: Range Check ============
    // Transfer amount > 0
    signal valid_transfer <== GreaterThan(120)([transfer_value, 0]);
    valid_transfer === 1;
    // Change amount >= 0
    signal valid_change <== GreaterEqThan(120)([change_value, 0]);
    valid_change === 1;

    // ============ Step 2: Balance Conservation ============
    // Verify sum(input_values) = sum(output_values)
    signal input_sum <== input_values[0] + input_values[1];
    signal output_sum <== transfer_value + change_value;
    input_sum === output_sum;

    // ============ Step 3: Compute MPK ============
    // MPK = Poseidon(spending_key, nullifying_key)
    // Proves sender knows the private keys
    signal sender_mpk <== Poseidon(2)([spending_key, nullifying_key]);

    // ============ Step 4: Verify Input Notes ============
    // For each input note:
    // 1. Verify NSK = Poseidon(MPK, random)
    // 2. Compute commitment = Poseidon(NSK, token, value)
    // 3. Verify nullifier = Poseidon(nullifying_key, leaf_index)
    // 4. Verify commitment exists in Merkle tree (skip for dummy notes with value=0)

    signal input_nsks[2];             // Note secret keys
    signal input_commitments[2];      // Input note commitments
    signal isValueZero[2];            // Detect dummy notes (value == 0)
    signal calculated_nullifiers[2];  // Temporary nullifiers
    signal calculated_roots[2];       // Temporary merkle roots

    for (var i = 0; i < 2; i++) {
        // Verify note ownership: NSK = Poseidon(MPK, random)
        input_nsks[i] <== Poseidon(2)([sender_mpk, input_randoms[i]]);

        // Compute commitment = Poseidon(NSK, token, value)
        input_commitments[i] <== Poseidon(3)([input_nsks[i], token, input_values[i]]);

        // Verify Merkle proof (commitment exists in tree at leaf_index)
        calculated_roots[i] <== MerkleProof(levels)(input_commitments[i], input_leaf_indices[i], input_path_elements[i]);

        // Check if this input is a dummy note (value == 0)
        isValueZero[i] <== IsZero()(input_values[i]);

        // Conditionally generate nullifier = Poseidon(nullifying_key, leaf_index)
        // - For real notes (value != 0): use real nullifier
        // - For dummy notes (value == 0): set nullifier to 0
        calculated_nullifiers[i] <== Poseidon(2)([nullifying_key, input_leaf_indices[i]]);
        input_nullifiers[i] <== (1 - isValueZero[i]) * calculated_nullifiers[i];

        // Conditionally verify Merkle root:
        // - For real notes (value != 0): MUST match merkle_root
        // - For dummy notes (value == 0): root check is bypassed
        (1 - isValueZero[i]) * (calculated_roots[i] - merkle_root) === 0;
    }

    // ============ Step 5: Verify Output Commitments ============
    // Output note commitment = Poseidon(recipient_NSK, token, value)
    signal transfer_nsk <== Poseidon(2)([recipient_mpk, transfer_random]);
    transfer_commitment <== Poseidon(3)([transfer_nsk, token, transfer_value]);

    // ============ Step 6: Verify Change Commitment ============
    // Change note commitment = Poseidon(sender_NSK, token, change_value)
    // If no change, commitment will be 0
    signal change_nsk <== Poseidon(2)([sender_mpk, change_random]);
    signal real_change_commitment <== Poseidon(3)([change_nsk, token, change_value]);
    signal no_change <== IsZero()(change_value);
    change_commitment <== real_change_commitment * (1 - no_change);
}

// Main circuit with 16 levels (supports 2^16 = 65,536 notes)
component main {public [token, merkle_root]} = Transfer(16);