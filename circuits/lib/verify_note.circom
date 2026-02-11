pragma circom 2.1.9;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "./merkle_proof.circom";

/**
 * VerifyNote - Verifies ownership and existence of a note in the Merkle tree
 *
 * For each input note:
 * 1. Verify NSK = Poseidon(MPK, random)
 * 2. Compute commitment = Poseidon(NSK, token, amount)
 * 3. Calculate nullifier = Poseidon(nullifying_key, leaf_index) (0 for dummy notes)
 * 4. Verify commitment exists in Merkle tree (skip for dummy notes with amount=0)
 *
 * @param levels - Merkle tree depth
 * @param note_count - Number of notes to be verified
 * @input mpk - Master Public Key of the note owner
 * @input nullifying_key - Key used to generate nullifiers
 * @input token - Token identifier
 * @input amounts[note_count] - Note amount (0 for dummy notes)
 * @input randoms[note_count] - Random value used in NSK derivation
 * @input leaf_indeices[note_count] - Position of the commitment in the Merkle tree
 * @input path_elements[note_count][levels] - Merkle proof path
 * @input merkle_root - Expected Merkle root
 * @output commitments[note_count] - Computed note commitment
 * @output nullifiers[note_count] - Computed nullifier (0 for dummy notes)
 */
template VerifyNote(levels, note_count) {
    // Inputs
    signal input mpk;
    signal input nullifying_key;
    signal input token;
    signal input randoms[note_count];
    signal input amounts[note_count];
    signal input leaf_indeices[note_count];
    signal input path_elements[note_count][levels];
    signal input merkle_root;

    // Outputs
    signal output nullifiers[note_count];

    // Internal signals
    signal nsks[note_count];                    // Note Secret Key
    signal commitments[note_count];             // Note commitments
    signal isAmountZeros[note_count];           // Detect dummy notes (amount == 0)
    signal calculated_nullifiers[note_count];   // Temporary nullifier
    signal calculated_roots[note_count];        // Temporary merkle root

    for (var i = 0; i < note_count; i++) {
        // Verify note ownership: NSK = Poseidon(MPK, random)
        nsks[i] <== Poseidon(2)([mpk, randoms[i]]);

        // Compute commitment = Poseidon(NSK, token, amount)
        commitments[i] <== Poseidon(3)([nsks[i], token, amounts[i]]);

        // Verify Merkle proof (commitment exists in tree at leaf_index)
        calculated_roots[i] <== MerkleProof(levels)(commitments[i], leaf_indeices[i], path_elements[i]);

        // Check if this input is a dummy note (amount == 0)
        isAmountZeros[i] <== IsZero()(amounts[i]);

        // Conditionally generate nullifier = Poseidon(nullifying_key, leaf_index)
        // - For real notes (amount != 0): use real nullifier
        // - For dummy notes (amount == 0): set nullifier to 0
        calculated_nullifiers[i] <== Poseidon(2)([nullifying_key, leaf_indeices[i]]);
        nullifiers[i] <== (1 - isAmountZeros[i]) * calculated_nullifiers[i];

        // Conditionally verify Merkle root:
        // - For real notes (amount != 0): MUST match merkle_root
        // - For dummy notes (amount == 0): root check is bypassed
        (1 - isAmountZeros[i]) * (calculated_roots[i] - merkle_root) === 0;
    }
}
