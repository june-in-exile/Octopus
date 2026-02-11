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

    console.log("=== Generating Transfer Test Input ===\n");

    // ============ Sender's Keypair ============
    const spending_key = "12345678901234567890123456789012345678901234567890";
    const nullifying_key = "98765432109876543210987654321098765432109876543210";

    // MPK = Poseidon(spending_key, nullifying_key)
    const mpk = hash([spending_key, nullifying_key]);
    console.log("Sender MPK:", mpk);

    // ============ Input Note 1 ============
    const input1_random = "11111111111111111111111111111111111111111111111111";
    const input1_amount = "5000000000"; // 5 SUI (9 decimals)
    const input1_leaf_index = "0"; // First leaf position
    const token = "123456789"; // Token identifier (same for all notes)

    const input1_nsk = hash([mpk, input1_random]);
    const input1_commitment = hash([input1_nsk, token, input1_amount]);
    const input1_nullifier = hash([nullifying_key, input1_leaf_index]);

    console.log("\nInput Note 1:");
    console.log("  NSK:", input1_nsk);
    console.log("  Amount:", input1_amount, "(5 SUI)");
    console.log("  Commitment:", input1_commitment);
    console.log("  Nullifier:", input1_nullifier);

    // ============ Input Note 2 ============
    const input2_random = "22222222222222222222222222222222222222222222222222";
    const input2_amount = "3000000000"; // 3 SUI (9 decimals)
    const input2_leaf_index = "1"; // Second leaf position

    const input2_nsk = hash([mpk, input2_random]);
    const input2_commitment = hash([input2_nsk, token, input2_amount]);
    const input2_nullifier = hash([nullifying_key, input2_leaf_index]);

    console.log("\nInput Note 2:");
    console.log("  NSK:", input2_nsk);
    console.log("  Amount:", input2_amount, "(3 SUI)");
    console.log("  Commitment:", input2_commitment);
    console.log("  Nullifier:", input2_nullifier);

    console.log("\nTotal Input Amount:", (BigInt(input1_amount) + BigInt(input2_amount)).toString(), "(8 SUI)");

    // ============ Output Note 1 (Recipient) ============
    const recipient_mpk = "99999999999999999999999999999999999999999999999999"; // Recipient's MPK
    const output1_random = "33333333333333333333333333333333333333333333333333";
    const output1_amount = "6000000000"; // 6 SUI to recipient

    const output1_nsk = hash([recipient_mpk, output1_random]);
    const output1_commitment = hash([output1_nsk, token, output1_amount]);

    console.log("\nOutput Note 1 (Recipient):");
    console.log("  NSK:", output1_nsk);
    console.log("  Amount:", output1_amount, "(6 SUI)");
    console.log("  Commitment:", output1_commitment);

    // ============ Output Note 2 (Change) ============
    const output2_random = "44444444444444444444444444444444444444444444444444";
    const output2_amount = "2000000000"; // 2 SUI change back to sender

    const output2_nsk = hash([mpk, output2_random]); // Change note uses sender's MPK
    const output2_commitment = hash([output2_nsk, token, output2_amount]);

    console.log("\nOutput Note 2 (Change):");
    console.log("  NSK:", output2_nsk);
    console.log("  Amount:", output2_amount, "(2 SUI)");
    console.log("  Commitment:", output2_commitment);

    console.log("\nTotal Output Amount:", (BigInt(output1_amount) + BigInt(output2_amount)).toString(), "(8 SUI)");

    // Verify balance conservation
    const inputTotal = BigInt(input1_amount) + BigInt(input2_amount);
    const outputTotal = BigInt(output1_amount) + BigInt(output2_amount);
    console.log("\nBalance Check:", inputTotal === outputTotal ? "✓ PASS" : "✗ FAIL");

    // ============ Compute Merkle Root ============
    // For testing, we assume a tree with 2 commitments at indices 0 and 1
    // We'll compute the root and path elements for both

    const LEVELS = 16;

    // Compute zero hashes for each level
    const zeros = [];
    zeros[0] = hash(["0", "0"]);
    for (let i = 1; i < LEVELS; i++) {
        zeros[i] = hash([zeros[i - 1], zeros[i - 1]]);
    }
    console.log("\nZero hashes computed");

    // Build initial tree with both input commitments
    // Level 0: [input1_commitment, input2_commitment, 0, 0, ...]
    let currentLevel = [input1_commitment, input2_commitment];

    // Path elements for input1 (index 0, bits all 0)
    const input1_path_elements = [];
    input1_path_elements[0] = input2_commitment; // Sibling at level 0

    // Path elements for input2 (index 1, first bit = 1, rest = 0)
    const input2_path_elements = [];
    input2_path_elements[0] = input1_commitment; // Sibling at level 0

    // Compute root by hashing up the tree
    for (let level = 0; level < LEVELS; level++) {
        if (level === 0) {
            // Level 0: hash the two commitments
            const parent = hash([currentLevel[0], currentLevel[1]]);
            currentLevel = [parent];

            // For subsequent levels, siblings are zero hashes
            for (let i = 1; i < LEVELS; i++) {
                input1_path_elements[i] = zeros[i];
                input2_path_elements[i] = zeros[i];
            }
        } else {
            // Hash current with zero sibling
            currentLevel[0] = hash([currentLevel[0], zeros[level]]);
        }
    }

    const merkle_root = currentLevel[0];
    console.log("Merkle Root:", merkle_root);

    // ============ Create Input JSON ============
    // NEW CIRCUIT INTERFACE: Uses recipient_mpk instead of output_nsks
    const input = {
        // Private inputs
        spending_key,
        nullifying_key,

        // Input notes (circuit computes NSKs internally from MPK + randoms)
        input_randoms: [input1_random, input2_random],
        input_amounts: [input1_amount, input2_amount],
        input_leaf_indices: [input1_leaf_index, input2_leaf_index],
        input_path_elements: [input1_path_elements, input2_path_elements],

        // NEW: Separate transfer and change outputs
        recipient_mpk,
        transfer_amount: output1_amount,
        transfer_random: output1_random,
        change_amount: output2_amount,
        change_random: output2_random,

        // Public inputs
        token,
        merkle_root
    };

    // Save to file
    fs.writeFileSync(path.join(__dirname, "../build/transfer_input.json"), JSON.stringify(input, null, 2));
    console.log("\n✓ Input saved to build/transfer_input.json");

    // Also print public inputs for reference (NEW FORMAT)
    console.log("\n=== Public Inputs (192 bytes total) ===");
    console.log("token:                ", token);
    console.log("merkle_root:          ", merkle_root);
    console.log("input_nullifiers[0]:  ", input1_nullifier);
    console.log("input_nullifiers[1]:  ", input2_nullifier);
    console.log("transfer_commitment:  ", output1_commitment);
    console.log("change_commitment:    ", output2_commitment);

    console.log("\n=== Test Scenario ===");
    console.log("Alice (sender) has 2 notes: 5 SUI + 3 SUI = 8 SUI");
    console.log("Alice transfers 6 SUI to Bob (recipient)");
    console.log("Alice receives 2 SUI as change");
    console.log("Balance: 8 SUI in = 8 SUI out ✓");
}

main().catch(console.error);
