#!/bin/bash
set -e

# Parse arguments
VK_TYPE="all"
POOL_TYPE="both"
NETWORK="testnet"
while [[ $# -gt 0 ]]; do
    case $1 in
        --network)
            NETWORK="$2"
            shift 2
            ;;
        --pool)
            POOL_TYPE="$2"
            shift 2
            ;;
        unshield|transfer|swap|all)
            VK_TYPE="$1"
            shift
            ;;
        *)
            echo "Usage: $0 [unshield|transfer|swap|all] [--pool sui|usdc|both] [--network testnet|mainnet]"
            echo "Default: update all VKs for both pools on testnet"
            exit 1
            ;;
    esac
done

if [ "$VK_TYPE" != "unshield" ] && [ "$VK_TYPE" != "transfer" ] && [ "$VK_TYPE" != "swap" ] && [ "$VK_TYPE" != "all" ]; then
    echo "Error: Invalid VK type '$VK_TYPE'"
    echo "Usage: $0 [unshield|transfer|swap|all] [--pool sui|usdc|both] [--network testnet|mainnet]"
    exit 1
fi

if [ "$POOL_TYPE" != "sui" ] && [ "$POOL_TYPE" != "usdc" ] && [ "$POOL_TYPE" != "both" ]; then
    echo "Error: Invalid pool type '$POOL_TYPE'"
    echo "Usage: $0 [unshield|transfer|swap|all] [--pool sui|usdc|both] [--network testnet|mainnet]"
    exit 1
fi

if [ "$NETWORK" != "testnet" ] && [ "$NETWORK" != "mainnet" ]; then
    echo "Error: --network must be 'testnet' or 'mainnet'"
    exit 1
fi

NETWORK_UPPER=$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')

# Determine .env file path (frontend env — contains NEXT_PUBLIC_* variables)
ENV_FILE=""
if [ -f "../../frontend/.env.local" ]; then
    ENV_FILE="../../frontend/.env.local"
elif [ -f "../../frontend/.env" ]; then
    ENV_FILE="../../frontend/.env"
else
    echo "Error: No frontend .env file found (expected frontend/.env.local or frontend/.env)"
    exit 1
fi

echo "Using .env file: $ENV_FILE"
echo "Network: $NETWORK"

# Load environment variables from .env file
export $(cat "$ENV_FILE" | grep -v '^#' | xargs)

PACKAGE_ID_VAR="NEXT_PUBLIC_${NETWORK_UPPER}_PACKAGE_ID"
PACKAGE_ID="${!PACKAGE_ID_VAR}"

if [ -z "$PACKAGE_ID" ]; then
    echo "Error: ${PACKAGE_ID_VAR} not set in .env file"
    exit 1
fi

echo "Package ID: $PACKAGE_ID"
echo ""

# Update a single pool's VK
update_pool_vk() {
    local vk=$1
    local pool=$2
    local pool_id=$3
    local type_arg=$4
    local pool_upper=$(echo "$pool" | tr '[:lower:]' '[:upper:]')
    local vk_upper=$(echo "$vk" | tr '[:lower:]' '[:upper:]')

    echo "--- Updating $vk_upper VK for $pool_upper pool ---"

    if [ -z "$pool_id" ]; then
        echo "Error: NEXT_PUBLIC_${NETWORK_UPPER}_${pool_upper}_POOL_ID not set in .env file"
        return 1
    fi
    if [ -z "$type_arg" ]; then
        echo "Error: Type argument not configured for $pool"
        [ "$pool" = "usdc" ] && echo "Please set NEXT_PUBLIC_${NETWORK_UPPER}_USDC_TYPE in .env"
        return 1
    fi

    echo "Looking for PoolAdminCap..."
    local original_pkg_var="NEXT_PUBLIC_${NETWORK_UPPER}_ORIGINAL_PACKAGE_ID"
    local original_pkg="${!original_pkg_var:-$PACKAGE_ID}"
    local admin_cap_id
    admin_cap_id=$(sui client objects --json 2>/dev/null | jq -r --arg pkg "$original_pkg" --arg pid "$pool_id" '.[] | select(.data.type == ($pkg + "::pool::PoolAdminCap") and .data.content.fields.pool_id == $pid) | .data.objectId' | head -1)

    if [ -z "$admin_cap_id" ]; then
        echo "Error: PoolAdminCap not found for $pool_upper pool"
        return 1
    fi

    echo "Pool ID:    $pool_id"
    echo "Type Arg:   $type_arg"
    echo "AdminCap:   $admin_cap_id"
    echo ""

    sui client call \
        --package "$PACKAGE_ID" \
        --module pool \
        --function "update_${vk}_vk" \
        --type-args "$type_arg" \
        --args "$pool_id" "$admin_cap_id" "0x$NEW_VK" \
        --gas-budget 10000000

    echo "✅ ${vk_upper} VK updated for $pool_upper pool"
    echo ""
}

# Update a single VK type across requested pools
update_vk() {
    local vk=$1
    local vk_upper=$(echo "$vk" | tr '[:lower:]' '[:upper:]')
    local expected_bytes=""
    case "$vk" in
        unshield) expected_bytes=720 ;;
        transfer) expected_bytes=848 ;;
        swap)     expected_bytes=912 ;;
    esac

    echo "=== Updating ${vk_upper} Verification Key ==="

    NEW_VK=$(cat "../../circuits/build/${vk}_vk_bytes.hex" | tr -d '\n')
    if [ -z "$NEW_VK" ]; then
        echo "Error: Could not read new VK from ../../circuits/build/${vk}_vk_bytes.hex"
        echo "Please run circuits/scripts/compile.sh $vk first"
        return 1
    fi
    echo "New VK: ${#NEW_VK} bytes (expected: $expected_bytes)"

    # Get old VK env var name dynamically (network-prefixed)
    local old_vk_var="${NETWORK_UPPER}_${vk_upper}_VK"
    local OLD_VK
    OLD_VK=$(eval echo "\$$old_vk_var" | tr -d '\n')

    if [ "$NEW_VK" = "$OLD_VK" ]; then
        echo "✓ VK unchanged - no contract update needed"
        echo "  Frontend circuit files are already up to date"
        echo ""
        return 0
    fi

    echo "✗ VK changed - updating on-chain..."
    echo ""

    SUI_POOL_ID_VAR="NEXT_PUBLIC_${NETWORK_UPPER}_SUI_POOL_ID"
    USDC_POOL_ID_VAR="NEXT_PUBLIC_${NETWORK_UPPER}_USDC_POOL_ID"
    USDC_TYPE_VAR="NEXT_PUBLIC_${NETWORK_UPPER}_USDC_TYPE"

    case "$POOL_TYPE" in
        sui)  update_pool_vk "$vk" sui "${!SUI_POOL_ID_VAR}" "0x2::sui::SUI" ;;
        usdc) update_pool_vk "$vk" usdc "${!USDC_POOL_ID_VAR}" "${!USDC_TYPE_VAR}" ;;
        both)
            update_pool_vk "$vk" sui "${!SUI_POOL_ID_VAR}" "0x2::sui::SUI"
            update_pool_vk "$vk" usdc "${!USDC_POOL_ID_VAR}" "${!USDC_TYPE_VAR}"
            ;;
    esac
}

# Determine which VKs to update
case "$VK_TYPE" in
    all)
        update_vk unshield
        update_vk transfer
        update_vk swap
        ;;
    *)
        update_vk "$VK_TYPE"
        ;;
esac

echo "=== Done ==="
