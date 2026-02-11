const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");
const path = require("path");

// Field modulus for BN254 curve
const FIELD_SIZE = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

async function main() {
    const poseidon = await buildPoseidon();
    const F = poseidon.F;

    // Convert poseidon output to BigInt string
    const hash = (inputs) => {
        const h = poseidon(inputs.map(x => BigInt(x)));
        return F.toString(h);
    };

    console.log("=== Generating Swap Test Input ===\n");

    // ============ User's Keypair ============
    const spending_key = "12345678901234567890123456789012345678901234567890";
    const nullifying_key = "98765432109876543210987654321098765432109876543210";

    // MPK = Poseidon(spending_key, nullifying_key)
    const mpk = hash([spending_key, nullifying_key]);
    console.log("User MPK:", mpk);

    // ============ Token Identifiers ============
    const token_in = "123456789";   // SUI token hash
    const token_out = "987654321";  // USDC token hash
    console.log("\nToken In (SUI):", token_in);
    console.log("Token Out (USDC):", token_out);

    // ============ Input Note 1 (SUI) ============
    const input1_random = "11111111111111111111111111111111111111111111111111";
    const input1_amount = "5000000000"; // 5 SUI (9 decimals)
    const input1_leaf_index = "0"; // First leaf position

    const input1_nsk = hash([mpk, input1_random]);
    const input1_commitment = hash([input1_nsk, token_in, input1_amount]);
    const input1_nullifier = hash([nullifying_key, input1_leaf_index]);

    console.log("\nInput Note 1 (SUI):");
    console.log("  NSK:", input1_nsk);
    console.log("  Amount:", input1_amount, "(5 SUI)");
    console.log("  Commitment:", input1_commitment);
    console.log("  Nullifier:", input1_nullifier);

    // ============ Input Note 2 (SUI) ============
    const input2_random = "22222222222222222222222222222222222222222222222222";
    const input2_amount = "3000000000"; // 3 SUI (9 decimals)
    const input2_leaf_index = "1"; // Second leaf position

    const input2_nsk = hash([mpk, input2_random]);
    const input2_commitment = hash([input2_nsk, token_in, input2_amount]);
    const input2_nullifier = hash([nullifying_key, input2_leaf_index]);

    console.log("\nInput Note 2 (SUI):");
    console.log("  NSK:", input2_nsk);
    console.log("  Amount:", input2_amount, "(3 SUI)");
    console.log("  Commitment:", input2_commitment);
    console.log("  Nullifier:", input2_nullifier);

    const total_input = BigInt(input1_amount) + BigInt(input2_amount);
    console.log("\nTotal Input Amount:", total_input.toString(), "(8 SUI)");

    // ============ Swap Parameters ============
    const amount_in = "6000000000";        // Swap 6 SUI
    const min_amount_out = "5500000";      // Expect at least 5.5 USDC (6 decimals)
    const dex_pool_id = "55555555555555555555555555555555555555555555555555"; // Mock DEX pool ID

    console.log("\nSwap Parameters:");
    console.log("  Amount In:", amount_in, "(6 SUI)");
    console.log("  Min Amount Out:", min_amount_out, "(5.5 USDC)");
    console.log("  DEX Pool ID:", dex_pool_id);

    // Compute swap_data_hash
    const swap_data_hash = hash([token_in, token_out, amount_in, min_amount_out, dex_pool_id]);
    console.log("  Swap Data Hash:", swap_data_hash);

    // ============ Output Note (USDC from swap) ============
    const output_random = "33333333333333333333333333333333333333333333333333";
    const output_amount = "6000000";        // Actual swap result: 6 USDC (6 decimals)

    const output_nsk = hash([mpk, output_random]); // Send to self (or recipient's MPK)
    const output_commitment = hash([output_nsk, token_out, output_amount]);

    console.log("\nOutput Note (USDC):");
    console.log("  NSK:", output_nsk);
    console.log("  Amount:", output_amount, "(6 USDC)");
    console.log("  Commitment:", output_commitment);

    // ============ Change Note (Remaining SUI) ============
    const change_amount = (total_input - BigInt(amount_in)).toString(); // 8 - 6 = 2 SUI
    const change_random = "44444444444444444444444444444444444444444444444444";

    const change_nsk = hash([mpk, change_random]);
    const change_commitment = hash([change_nsk, token_in, change_amount]);

    console.log("\nChange Note (SUI):");
    console.log("  NSK:", change_nsk);
    console.log("  Amount:", change_amount, "(2 SUI)");
    console.log("  Commitment:", change_commitment);

    // Verify balance
    const required_sum = BigInt(amount_in) + BigInt(change_amount);
    console.log("\nBalance Check:");
    console.log("  Input Sum:", total_input.toString(), "SUI");
    console.log("  Required (amount_in + change):", required_sum.toString(), "SUI");
    console.log("  Status:", total_input === required_sum ? "✓ PASS" : "✗ FAIL");

    // ============ Compute Merkle Root ============
    // For testing, we assume a tree with 2 commitments at indices 0 and 1
    const LEVELS = 16;

    // Compute zero hashes for each level
    const zeros = [];
    zeros[0] = hash(["0", "0"]);
    for (let i = 1; i < LEVELS; i++) {
        zeros[i] = hash([zeros[i - 1], zeros[i - 1]]);
    }
    console.log("\nZero hashes computed");

    // Build initial tree with both input commitments
    const input1_path_elements = [];
    const input2_path_elements = [];

    // Level 0 siblings
    input1_path_elements[0] = input2_commitment; // Input 1 (left) sibling is Input 2 (right)
    input2_path_elements[0] = input1_commitment; // Input 2 (right) sibling is Input 1 (left)

    // Remaining levels use zero hashes
    for (let i = 1; i < LEVELS; i++) {
        input1_path_elements[i] = zeros[i];
        input2_path_elements[i] = zeros[i];
    }

    // Compute root
    let current = hash([input1_commitment, input2_commitment]);
    for (let level = 1; level < LEVELS; level++) {
        current = hash([current, zeros[level]]);
    }

    const merkle_root = current;
    console.log("Merkle Root:", merkle_root);

    // ============ Create Input JSON ============
    // Note: input_nsks, output_nsk, change_nsk are computed internally by the circuit.
    // input_nullifiers, output_commitment, change_commitment, swap_data_hash are public OUTPUTS.
    const input = {
        // Private inputs - Keypair
        spending_key,
        nullifying_key,

        // Input notes (private)
        input_amounts: [input1_amount, input2_amount],
        input_randoms: [input1_random, input2_random],
        input_leaf_indices: [input1_leaf_index, input2_leaf_index],
        input_path_elements: [input1_path_elements, input2_path_elements],

        // Swap parameters (private)
        amount_in,
        min_amount_out,
        dex_pool_id,

        // Output note (private)
        output_amount,
        output_random,

        // Change note (private)
        change_amount,
        change_random,

        // Public inputs
        token_in,
        token_out,
        merkle_root,
    };

    // Save to file
    fs.writeFileSync(path.join(__dirname, "../build/swap_input.json"), JSON.stringify(input, null, 2));
    console.log("\n✓ Input saved to build/swap_input.json");

    // Print public inputs/outputs for reference
    console.log("\n=== Public Inputs ===");
    console.log("token_in:             ", token_in);
    console.log("token_out:            ", token_out);
    console.log("merkle_root:          ", merkle_root);

    console.log("\n=== Expected Public Outputs ===");
    console.log("input_nullifiers[0]:  ", input1_nullifier);
    console.log("input_nullifiers[1]:  ", input2_nullifier);
    console.log("swap_data_hash:       ", swap_data_hash);
    console.log("output_commitment:    ", output_commitment);
    console.log("change_commitment:    ", change_commitment);

    console.log("\n=== Test Scenario ===");
    console.log("User has 2 notes: 5 SUI + 3 SUI = 8 SUI");
    console.log("User swaps 6 SUI → 6 USDC via DEX");
    console.log("User receives 6 USDC (output note)");
    console.log("User receives 2 SUI as change (change note)");
    console.log("Balance: 8 SUI = 6 SUI (swapped) + 2 SUI (change) ✓");
}

main().catch(console.error);
