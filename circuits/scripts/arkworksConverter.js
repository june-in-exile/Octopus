// Unified converter: snarkjs output to Sui's Arkworks compressed format
// BN254 curve: G1 = 32 bytes compressed, G2 = 64 bytes compressed, Fr = 32 bytes LE

const fs = require("fs");
const path = require("path");

// BN254 field modulus
const FIELD_MODULUS = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");
const SCALAR_MODULUS = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

// Circuit-specific configuration
const CIRCUIT_CONFIG = {
    unshield: {
        expectedIcPoints: 7,
        hasProof: true,
        publicInputNames: ["input_nullifier1", "input_nullifier2", "change_commitment", "unshield_value", "token", "merkle_root"]
    },
    transfer: {
        expectedIcPoints: 7,
        hasProof: true,
        publicInputNames: ["input_nullifier1", "input_nullifier2", "transfer_commitment", "change_commitment", "token", "merkle_root"]
    },
    swap: {
        expectedIcPoints: 9,
        hasProof: false,
        publicInputNames: ["input_nullifier1", "input_nullifier2", "swap_data_hash", "output_commitment", "change_commitment", "token_in", "token_out", "merkle_root"]
    }
};

// Convert a BigInt to 32-byte little-endian buffer
function bigIntToLE32(n) {
    const buf = Buffer.alloc(32);
    let val = BigInt(n);
    for (let i = 0; i < 32; i++) {
        buf[i] = Number(val & 0xFFn);
        val >>= 8n;
    }
    return buf;
}

// Compress G1 point (Arkworks format): x-coordinate with sign bit in most significant bit of last byte
function compressG1(point) {
    const x = BigInt(point[0]);
    const y = BigInt(point[1]);

    // Convert x to 32-byte little-endian
    const buf = bigIntToLE32(x);

    // Set the sign bit (y > p/2 means negative, set bit in last byte)
    const yNeg = y > (FIELD_MODULUS / 2n);
    if (yNeg) {
        buf[31] |= 0x80;
    }

    return buf;
}

// Compress G2 point: similar but 64 bytes (two Fq elements for x)
function compressG2(point) {
    const x0 = BigInt(point[0][0]);
    const x1 = BigInt(point[0][1]);
    const y0 = BigInt(point[1][0]);
    const y1 = BigInt(point[1][1]);

    const buf = Buffer.alloc(64);

    // Write x0 (c0) in little-endian
    let val = x0;
    for (let i = 0; i < 32; i++) {
        buf[i] = Number(val & 0xFFn);
        val >>= 8n;
    }

    // Write x1 (c1) in little-endian
    val = x1;
    for (let i = 32; i < 64; i++) {
        buf[i] = Number(val & 0xFFn);
        val >>= 8n;
    }

    // Determine sign
    const negY0 = y0 === 0n ? 0n : FIELD_MODULUS - y0;
    const negY1 = y1 === 0n ? 0n : FIELD_MODULUS - y1;

    let yIsLarger = false;
    if (y1 > negY1) {
        yIsLarger = true;
    } else if (y1 === negY1 && y0 > negY0) {
        yIsLarger = true;
    }

    if (yIsLarger) {
        buf[63] |= 0x80;
    }

    return buf;
}

// Convert public input (scalar in Fr) to 32-byte little-endian
function convertPublicInput(input) {
    return bigIntToLE32(BigInt(input));
}

// Main conversion function
function convertCircuit(circuitName) {
    const config = CIRCUIT_CONFIG[circuitName];
    if (!config) {
        console.error(`Unknown circuit: ${circuitName}`);
        console.error(`Available circuits: ${Object.keys(CIRCUIT_CONFIG).join(", ")}`);
        process.exit(1);
    }

    const baseDir = path.dirname(__filename);
    const buildDir = path.join(baseDir, "../build");

    // Load verification key
    const vkPath = path.join(buildDir, `${circuitName}_vk.json`);
    if (!fs.existsSync(vkPath)) {
        console.error(`Verification key not found: ${vkPath}`);
        process.exit(1);
    }
    const vk = JSON.parse(fs.readFileSync(vkPath));

    console.log(`=== Converting ${circuitName} circuit to Sui format ===\n`);

    // === Verification Key ===
    const alpha_g1 = compressG1(vk.vk_alpha_1);
    const beta_g2 = compressG2(vk.vk_beta_2);
    const gamma_g2 = compressG2(vk.vk_gamma_2);
    const delta_g2 = compressG2(vk.vk_delta_2);

    // IC points (gamma_abc_g1)
    const ic_points = vk.IC.map(p => compressG1(p));

    // Arkworks format: alpha || beta || gamma || delta || len(IC) as u64 LE || IC points
    const icLenBuf = Buffer.alloc(8);
    icLenBuf.writeUInt32LE(ic_points.length, 0);

    const vkBytes = Buffer.concat([
        alpha_g1,          // 32 bytes
        beta_g2,           // 64 bytes
        gamma_g2,          // 64 bytes
        delta_g2,          // 64 bytes
        icLenBuf,          // 8 bytes (length of IC array)
        ...ic_points       // 32 bytes each
    ]);

    console.log("Verification Key (hex):");
    console.log(vkBytes.toString("hex"));
    console.log(`\nVK length: ${vkBytes.length} bytes`);
    console.log(`IC points: ${ic_points.length} (expected: ${config.expectedIcPoints} for ${config.publicInputNames.length} public inputs)`);

    // Write VK output
    fs.writeFileSync(path.join(buildDir, `${circuitName}_vk_bytes.hex`), vkBytes.toString("hex"));

    // === Proof and Public Inputs (if available) ===
    if (config.hasProof) {
        const proofPath = path.join(buildDir, `${circuitName}_proof.json`);
        const publicPath = path.join(buildDir, `${circuitName}_public.json`);

        if (fs.existsSync(proofPath) && fs.existsSync(publicPath)) {
            const proof = JSON.parse(fs.readFileSync(proofPath));
            const publicInputs = JSON.parse(fs.readFileSync(publicPath));

            // === Proof ===
            const pi_a = compressG1(proof.pi_a);
            const pi_b = compressG2(proof.pi_b);
            const pi_c = compressG1(proof.pi_c);

            const proofBytes = Buffer.concat([pi_a, pi_b, pi_c]);

            console.log("\nProof Points (hex):");
            console.log(proofBytes.toString("hex"));
            console.log(`\nProof length: ${proofBytes.length} bytes`);

            // === Public Inputs ===
            const publicInputsBytes = Buffer.concat(publicInputs.map(p => convertPublicInput(p)));

            console.log("\nPublic Inputs (hex):");
            console.log(publicInputsBytes.toString("hex"));
            console.log(`\nPublic inputs length: ${publicInputsBytes.length} bytes (${publicInputs.length} inputs)`);

            // Write proof and public inputs
            fs.writeFileSync(path.join(buildDir, `${circuitName}_proof_bytes.hex`), proofBytes.toString("hex"));
            fs.writeFileSync(path.join(buildDir, `${circuitName}_public_inputs_bytes.hex`), publicInputsBytes.toString("hex"));

            console.log("\n=== Files written to build/ ===");
            console.log(`- ${circuitName}_vk_bytes.hex`);
            console.log(`- ${circuitName}_proof_bytes.hex`);
            console.log(`- ${circuitName}_public_inputs_bytes.hex`);

            // Output as Move vector literals
            console.log("\n=== Move literals (for tests) ===");
            console.log(`\nconst ${circuitName.toUpperCase()}_VK: vector<u8> = x"${vkBytes.toString("hex")}";`);
            console.log(`\nconst ${circuitName.toUpperCase()}_PROOF: vector<u8> = x"${proofBytes.toString("hex")}";`);
            console.log(`\nconst ${circuitName.toUpperCase()}_PUBLIC_INPUTS: vector<u8> = x"${publicInputsBytes.toString("hex")}";`);

            // Show individual public inputs
            console.log("\n=== Individual Public Inputs ===");
            config.publicInputNames.forEach((name, i) => {
                console.log(`${name}: ${publicInputs[i]}`);
            });
        } else {
            console.log("\n=== Files written to build/ ===");
            console.log(`- ${circuitName}_vk_bytes.hex`);

            console.log("\n=== Move literal (for pool creation) ===");
            console.log(`\nconst ${circuitName.toUpperCase()}_VK: vector<u8> = x"${vkBytes.toString("hex")}";`);

            console.log("\nNote: Proof and public inputs not found (run circuit test to generate them)");
        }
    } else {
        console.log("\n=== Files written to build/ ===");
        console.log(`- ${circuitName}_vk_bytes.hex`);

        console.log("\n=== Move literal (for pool creation) ===");
        console.log(`\nconst ${circuitName.toUpperCase()}_VK: vector<u8> = x"${vkBytes.toString("hex")}";`);
    }

    // Show public inputs order
    console.log("\n=== Public Inputs Order (for reference) ===");
    config.publicInputNames.forEach((name, i) => {
        console.log(`${i + 1}. ${name}`);
    });
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: node arkworksConverter.js <circuit_name>");
    console.error(`Available circuits: ${Object.keys(CIRCUIT_CONFIG).join(", ")}`);
    process.exit(1);
}

const circuitName = args[0].toLowerCase();
convertCircuit(circuitName);
