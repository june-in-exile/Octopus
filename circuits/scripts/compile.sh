#!/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

BUILD_DIR="build"
FRONTEND="../frontend/public/circuits"

# Capitalize first letter (macOS bash 3 compatible)
capitalize() {
    echo "$1" | awk '{print toupper(substr($0,1,1)) substr($0,2)}'
}

# Parse arguments - default to all
CIRCUITS=()
if [ $# -eq 0 ]; then
    CIRCUITS=("unshield" "transfer" "swap")
else
    while [ $# -gt 0 ]; do
        case "$1" in
            --circuit)
                if [ -z "$2" ] || [[ "$2" == --* ]]; then
                    echo "Error: --circuit requires a circuit name"
                    echo "Usage: $0 [--circuit <name>]..."
                    echo "Available circuits: unshield, transfer, swap"
                    echo "Default: compile all three"
                    exit 1
                fi
                case "$2" in
                    unshield|transfer|swap)
                        [[ " ${CIRCUITS[*]} " != *" $2 "* ]] && CIRCUITS+=("$2")
                        shift 2
                        ;;
                    *)
                        echo "Error: Unknown circuit '$2'"
                        echo "Available circuits: unshield, transfer, swap"
                        exit 1
                        ;;
                esac
                ;;
            *)
                echo "Error: Unknown option '$1'"
                echo "Usage: $0 [--circuit <name>]..."
                echo "Available circuits: unshield, transfer, swap"
                echo "Example: $0 --circuit unshield --circuit transfer"
                echo "Default: compile all three"
                exit 1
                ;;
        esac
    done
fi

echo "========================================"
echo "  Compiling Octopus ZK Circuits"
echo "========================================"
echo ""
echo "Targets: ${CIRCUITS[*]}"
echo ""
if [ ${#CIRCUITS[@]} -gt 1 ]; then
    echo "⚠️  This process is computationally intensive and will take significant time."
    echo ""
fi

mkdir -p "$BUILD_DIR"

if [ ! -f "$BUILD_DIR/pot15_final.ptau" ]; then
    echo "Downloading pot15_final.ptau (~400MB)..."
    curl -L https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_15.ptau \
        -o "$BUILD_DIR/pot15_final.ptau" --progress-bar
    echo "✓ pot15 downloaded"
    echo ""
fi

# Map circuit name to PTAU file
ptau_for() {
    echo "pot15_final.ptau"
}

# Compile a single circuit
compile_circuit() {
    local name=$1
    local ptau=$2
    local cap
    cap=$(capitalize "$name")

    echo "[1/7] Compiling $name.circom..."
    circom $name.circom --r1cs --wasm --sym -o $BUILD_DIR

    echo "[2/7] Circuit info:"
    snarkjs r1cs info $BUILD_DIR/${name}.r1cs

    echo "[3/7] Generating zkey (Groth16 setup)..."
    snarkjs groth16 setup \
        $BUILD_DIR/${name}.r1cs \
        $BUILD_DIR/${ptau} \
        $BUILD_DIR/${name}_0000.zkey

    echo "[4/7] Contributing to ceremony..."
    snarkjs zkey contribute \
        $BUILD_DIR/${name}_0000.zkey \
        $BUILD_DIR/${name}_final.zkey \
        --name="Octopus Dev" \
        -v -e="random entropy $(date +%s)"

    echo "[5/7] Exporting verification key..."
    snarkjs zkey export verificationkey \
        $BUILD_DIR/${name}_final.zkey \
        $BUILD_DIR/${name}_vk.json

    echo "[6/7] Constraint count:"
    snarkjs r1cs info $BUILD_DIR/${name}.r1cs | grep "# of Constraints"

    echo "[7/7] Converting VK to Sui format and copying to frontend..."
    node scripts/arkworksConverter.js ${name}
    mkdir -p ${FRONTEND}/${name}_js
    cp ${BUILD_DIR}/${name}_js/${name}.wasm ${FRONTEND}/${name}_js/
    cp ${BUILD_DIR}/${name}_final.zkey ${FRONTEND}
    cp ${BUILD_DIR}/${name}_vk.json ${FRONTEND}

    echo "✅ $name compiled successfully"
}

# Single circuit: inline output; multiple: parallel with logs
if [ ${#CIRCUITS[@]} -eq 1 ]; then
    name="${CIRCUITS[0]}"
    echo "=== Compiling $name ==="
    echo ""
    compile_circuit "$name" "$(ptau_for "$name")"
else
    echo "Starting parallel compilation..."
    echo ""
    PIDS=()
    for name in "${CIRCUITS[@]}"; do
        compile_circuit "$name" "$(ptau_for "$name")" > "$BUILD_DIR/compile_${name}.log" 2>&1 &
        PIDS+=($!)
    done

    ALL_OK=true
    for i in "${!CIRCUITS[@]}"; do
        echo "⏳ Waiting for ${CIRCUITS[$i]} (PID: ${PIDS[$i]})..."
        if wait "${PIDS[$i]}"; then
            echo "  ✓ ${CIRCUITS[$i]} done"
        else
            echo "  ✗ ${CIRCUITS[$i]} failed — see: $BUILD_DIR/compile_${CIRCUITS[$i]}.log"
            ALL_OK=false
        fi
    done

    if [ "$ALL_OK" = "false" ]; then
        echo ""
        echo "❌ Some compilations failed!"
        exit 1
    fi
fi

echo ""
echo "========================================"
echo "  ✅ All Circuits Compiled Successfully!"
echo "========================================"
echo ""
echo "Compiled: ${CIRCUITS[*]}"
echo "Artifacts copied to frontend/public/circuits/"
echo ""
echo "Next steps:"
echo ""
echo "  First-time deployment:"
echo "    cd ../../contracts/scripts"
echo "    ./deploy_package.sh"
echo "    ./create_pool.sh"
echo ""
echo "  Update existing deployment (VK changes only):"
echo "    cd ../../contracts/scripts"
if [ ${#CIRCUITS[@]} -eq 3 ]; then
    echo "    ./update_vk.sh"
else
    for name in "${CIRCUITS[@]}"; do
        echo "    ./update_vk.sh $name"
    done
fi
