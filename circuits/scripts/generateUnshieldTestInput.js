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

    // ============ Generate Random Test Values ============
    // In production, these would be securely generated
    const spending_key = "12345678901234567890123456789012345678901234567890";
    const nullifying_key = "98765432109876543210987654321098765432109876543210";

    // Two input notes: one real note + one dummy note (amount=0)
    const input_randoms = [
        "11111111111111111111111111111111111111111111111111", // Input 0: real note
        "33333333333333333333333333333333333333333333333333"  // Input 1: dummy note
    ];
    const input_amounts = [
        "1000000000", // Input 0: 1 SUI (9 decimals)
        "0"           // Input 1: dummy note (amount=0)
    ];
    const input_leaf_indices = [
        "0", // Input 0: first leaf position
        "1"  // Input 1: second leaf position (dummy)
    ];

    const unshield_amount = "600000000"; // 0.6 SUI to unshield
    const token = "123456789"; // Token identifier (hash of type in production)

    // Change note parameters
    const change_random = "22222222222222222222222222222222222222222222222222";

    // ============ Compute Derived Values for Input Notes ============

    // MPK = Poseidon(spending_key, nullifying_key)
    const mpk = hash([spending_key, nullifying_key]);
    console.log("MPK:", mpk);

    // Compute NSK, Commitment, and Nullifier for both input notes
    const input_nsks = [];
    const input_commitments = [];
    const input_nullifiers = [];

    for (let i = 0; i < 2; i++) {
        // Input NSK = Poseidon(MPK, input_random)
        const nsk = hash([mpk, input_randoms[i]]);
        input_nsks.push(nsk);
        console.log(`Input ${i} NSK:`, nsk);

        // Input Commitment = Poseidon(nsk, token, input_amount)
        const commitment = hash([nsk, token, input_amounts[i]]);
        input_commitments.push(commitment);
        console.log(`Input ${i} Commitment:`, commitment);

        // Nullifier = Poseidon(nullifying_key, input_leaf_index)
        const nullifier = hash([nullifying_key, input_leaf_indices[i]]);
        input_nullifiers.push(nullifier);
        console.log(`Input ${i} Nullifier:`, nullifier);
    }

    // ============ Compute Change Note ============
    const total_input_amount = BigInt(input_amounts[0]) + BigInt(input_amounts[1]);
    const change_amount = total_input_amount - BigInt(unshield_amount);
    console.log("Total Input Amount:", total_input_amount.toString());
    console.log("Change Amount:", change_amount.toString());

    // Change NSK = Poseidon(MPK, change_random)
    // (User sends change to themselves)
    const change_nsk = hash([mpk, change_random]);
    console.log("Change NSK:", change_nsk);

    // Change Commitment = Poseidon(change_nsk, token, change_amount)
    const change_commitment = change_amount > 0n
        ? hash([change_nsk, token, change_amount.toString()])
        : "0";
    console.log("Change Commitment:", change_commitment);

    // ============ Compute Merkle Root ============
    // For testing, we compute the root with the first real note at index 0
    // The dummy note (input 1) has amount=0, so its merkle proof won't be verified by the circuit

    const LEVELS = 16;

    // Compute zero hashes for each level
    // zeros[0] = Poseidon(0, 0) - empty leaf pair
    // zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
    const zeros = [];
    zeros[0] = hash(["0", "0"]);
    for (let i = 1; i < LEVELS; i++) {
        zeros[i] = hash([zeros[i - 1], zeros[i - 1]]);
    }
    console.log("Zero hashes computed");

    // Compute path elements for both inputs
    const input_path_elements = [];

    // Input 0: real note at index 0, all siblings are zero hashes
    const path_elements_0 = zeros.slice(0, LEVELS);
    input_path_elements.push(path_elements_0);

    // Input 1: dummy note (amount=0), merkle proof won't be verified
    // Use zero hashes for simplicity
    const path_elements_1 = zeros.slice(0, LEVELS);
    input_path_elements.push(path_elements_1);

    // Compute merkle root using the first real note
    // At each level, our amount is on the left (index bit = 0), sibling is zero hash
    let current = input_commitments[0];
    for (let i = 0; i < LEVELS; i++) {
        current = hash([current, path_elements_0[i]]);
    }
    const merkle_root = current;
    console.log("Merkle Root:", merkle_root);

    // ============ Create Input JSON ============
    const input = {
        // Private inputs
        spending_key,
        nullifying_key,
        input_randoms,
        input_amounts,
        input_leaf_indices,
        input_path_elements,
        change_amount: change_amount.toString(),
        change_random,

        // Public inputs
        unshield_amount,
        token,
        merkle_root
    };

    // Save to file
    fs.writeFileSync(path.join(__dirname, "../build/unshield_input.json"), JSON.stringify(input, null, 2));
    console.log("\nInput saved to build/unshield_input.json");

    // Print expected public signals for verification
    console.log("\n=== Expected Public Signals (5 elements) ===");
    console.log("Expected order: [input_nullifiers[0], input_nullifiers[1], change_commitment, unshield_amount, token, merkle_root]");
    console.log("1. input_nullifiers[0]:", input_nullifiers[0]);
    console.log("2. input_nullifiers[1]:", input_nullifiers[1], "(should be 0 for dummy note)");
    console.log("3. change_commitment:", change_commitment);
    console.log("4. unshield_amount:", unshield_amount);
    console.log("5. token:", token);
    console.log("6. merkle_root:", merkle_root);

    // Print amounts for verification
    console.log("\n=== Test Scenario ===");
    console.log("Input 0 amount:", input_amounts[0], "(" + (BigInt(input_amounts[0]) / 1000000000n).toString() + " SUI) - Real note");
    console.log("Input 1 amount:", input_amounts[1], "(" + (BigInt(input_amounts[1]) / 1000000000n).toString() + " SUI) - Dummy note");
    console.log("Total input:", total_input_amount.toString(), "(" + (total_input_amount / 1000000000n).toString() + " SUI)");
    console.log("Unshield amount:", unshield_amount, "(" + (BigInt(unshield_amount) / 1000000000n).toString() + " SUI)");
    console.log("Change amount:", change_amount.toString(), "(" + (change_amount / 1000000000n).toString() + " SUI)");
    console.log("Has change:", change_amount > 0n);
}

main().catch(console.error);
