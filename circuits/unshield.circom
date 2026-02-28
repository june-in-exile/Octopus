pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "./lib/verify_note.circom";

/// Unshield circuit for Octopus on Sui
/// Implements 1-input, 1-output (change note) private unshield with automatic change handling
///
/// Proves:
/// 1. Knowledge of spending_key and nullifying_key (ownership)
/// 2. Input note exists in Merkle tree
/// 3. Correct nullifier computation
/// 4. Balance conservation: amount = unshield_amount + change_amount
/// 5. Correct change commitment computation
/// 6. Proof is bound to recipient address
///
/// Based on cryptographic formulas:
/// - MPK = Poseidon(spending_key, nullifying_key)
/// - NSK = Poseidon(MPK, random)
/// - Commitment = Poseidon(NSK, token, amount)
/// - Nullifier = Poseidon(nullifying_key, leaf_index)
template Unshield(levels) {
    // ============ Private Inputs ============

    // Keypair
    signal input spending_key;           // User's secret spending key (256-bit)
    signal input nullifying_key;         // Secret key for nullifier generation (256-bit)

    // Input note (note being spent/unshielded)
    signal input input_randoms[2];       // Random blinding factor
    signal input input_amounts[2];       // Note amounts (can be 0 for dummy)
    signal input input_leaf_indices[2];  // Leaf positions in tree
    signal input input_path_elements[2][levels];  // Merkle proof siblings

    // Change note (if input > unshield_amount, return change)
    signal input change_random;          // Random blinding factor for change
    signal input change_amount;          // Change amount

    // Nullifiers (precomputed off-chain, constrained by circuit)
    signal input nullifiers[2];          // Poseidon(nullifying_key, leaf_index) for each input note

    // Recipient address split into two 128-bit halves (private — only the hash is public)
    signal input recipient_addr_lo;      // Private: bytes[0..16] of recipient address as LE u128
    signal input recipient_addr_hi;      // Private: bytes[16..32] of recipient address as LE u128

    // ============ Public Inputs ============
    signal input unshield_amount;        // Amount to unshield to public address
    signal input token;                  // Token identifier (address hash)
    signal input merkle_root;            // Expected Merkle root

    // ============ Public Outputs ============
    signal output nullifiers_hash;       // Poseidon hash of both nullifiers
    signal output change_commitment;     // Commitment for change note (0 if no change)
    signal output recipient_hash;        // Poseidon(addr_lo, addr_hi) — binds proof to recipient

    // ============ Step 1: Range Check ============
    // Unshield amount > 0
    signal valid_unshield <== GreaterThan(120)([unshield_amount, 0]);
    valid_unshield === 1;
    // Change amount >= 0
    signal valid_change <== GreaterEqThan(120)([change_amount, 0]);
    valid_change === 1;

    // ============ Step 2: Balance Conservation ============
    // Verify sum(input_amounts) = sum(output_amounts)
    signal input_sum <== input_amounts[0] + input_amounts[1];
    signal output_sum <== unshield_amount + change_amount;
    input_sum === output_sum;

    // ============ Step 3: Compute MPK ============
    // MPK = Poseidon(spending_key, nullifying_key)
    // Proves sender knows the private keys
    signal mpk <== Poseidon(2)([spending_key, nullifying_key]);

    // ============ Step 4: Verify Input Notes ============
    // Verify commitment inclusion and constrain the provided nullifiers
    signal expected_nullifiers[2] <== VerifyNote(levels, 2)(mpk, nullifying_key, token, input_randoms, input_amounts, input_leaf_indices, input_path_elements, merkle_root);
    for (var i = 0; i < 2; i++) {
        nullifiers[i] === expected_nullifiers[i];
    }
    nullifiers_hash <== Poseidon(2)([nullifiers[0], nullifiers[1]]);

    // ============ Step 5: Compute Change Commitment ============
    signal change_nsk <== Poseidon(2)([mpk, change_random]);
    signal real_change_commitment <== Poseidon(3)([change_nsk, token, change_amount]);
    signal no_change <== IsZero()(change_amount);
    change_commitment <== real_change_commitment * (1 - no_change);

    // ============ Step 6: Commit to Recipient ============
    // Binds this proof to a specific recipient address.
    // A relayer cannot substitute a different recipient without invalidating the proof.
    recipient_hash <== Poseidon(2)([recipient_addr_lo, recipient_addr_hi]);
}

// Main circuit with 16 levels (supports 2^16 = 65,536 notes)
component main {public [unshield_amount, token, merkle_root]} = Unshield(16);
