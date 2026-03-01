#!/bin/bash
set -e

cd ..

# Parse arguments
COIN_TYPE="all"
NETWORK="testnet"
while [[ $# -gt 0 ]]; do
    case $1 in
        --network)
            NETWORK="$2"
            shift 2
            ;;
        --coin)
            COIN_TYPE="$2"
            shift 2
            ;;
        *)
            echo "Usage: $0 [--coin sui|usdc|dbusdc|both|all] [--network testnet|mainnet]"
            echo "Default: create all three pools (SUI, USDC, DBUSDC) on testnet"
            exit 1
            ;;
    esac
done

if [ "$NETWORK" != "testnet" ] && [ "$NETWORK" != "mainnet" ]; then
    echo "Error: --network must be 'testnet' or 'mainnet'"
    exit 1
fi

if [ "$COIN_TYPE" != "sui" ] && [ "$COIN_TYPE" != "usdc" ] && [ "$COIN_TYPE" != "dbusdc" ] && [ "$COIN_TYPE" != "both" ] && [ "$COIN_TYPE" != "all" ]; then
    echo "Error: --coin must be 'sui', 'usdc', 'dbusdc', 'both' (sui+usdc), or 'all' (sui+usdc+dbusdc, testnet only)"
    exit 1
fi

if [ "$COIN_TYPE" = "dbusdc" ]; then
    if [ "$NETWORK" != "testnet" ]; then
        echo "Error: DBUSDC pool is only supported on testnet"
        exit 1
    fi
fi

# Determine frontend .env file path (contains NEXT_PUBLIC_* variables)
ENV_FILE=""
if [ -f "../frontend/.env.local" ]; then
    ENV_FILE="../frontend/.env.local"
elif [ -f "../frontend/.env" ]; then
    ENV_FILE="../frontend/.env"
else
    echo "Error: No frontend .env file found (expected frontend/.env.local or frontend/.env)"
    echo "Please copy frontend/.env.example to frontend/.env.local and configure it."
    exit 1
fi

echo "Using frontend .env file: $ENV_FILE"

# Determine relayer .env file path (contains server-side variables without NEXT_PUBLIC_ prefix)
RELAYER_ENV_FILE=""
if [ -f "../relayer/.env" ]; then
    RELAYER_ENV_FILE="../relayer/.env"
    echo "Using relayer .env file: $RELAYER_ENV_FILE"
fi
echo "Network: $NETWORK"
echo "Coin: $COIN_TYPE"

# Switch to target network
sui client switch --env "$NETWORK"

# Load environment variables from .env file (strip inline comments)
export $(cat "$ENV_FILE" | sed 's/#.*//' | sed '/^$/d' | xargs)

NETWORK_UPPER=$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')
PACKAGE_ID_VAR="NEXT_PUBLIC_${NETWORK_UPPER}_PACKAGE_ID"
PACKAGE_ID="${!PACKAGE_ID_VAR}"

if [ -z "$PACKAGE_ID" ]; then
    echo "Error: $PACKAGE_ID_VAR not set in .env file"
    echo "Please run scripts/deploy_package.sh --network $NETWORK first"
    exit 1
fi

echo "Package ID: $PACKAGE_ID"
echo ""

# Read verification keys from circuit build output
echo "Reading verification keys from circuit build output..."

UNSHIELD_VK=$(cat ../circuits/build/unshield_vk_bytes.hex | tr -d '\n')
if [ -z "$UNSHIELD_VK" ]; then
    echo "Error: Could not read unshield VK from ../circuits/build/unshield_vk_bytes.hex"
    echo "Please run circuits/scripts/compile.sh unshield first"
    exit 1
fi
echo "✓ Unshield VK: ${#UNSHIELD_VK} bytes (expected: 720)"

TRANSFER_VK=$(cat ../circuits/build/transfer_vk_bytes.hex | tr -d '\n')
if [ -z "$TRANSFER_VK" ]; then
    echo "Error: Could not read transfer VK from ../circuits/build/transfer_vk_bytes.hex"
    echo "Please run circuits/scripts/compile.sh transfer first"
    exit 1
fi
echo "✓ Transfer VK: ${#TRANSFER_VK} bytes (expected: 848)"

SWAP_VK=$(cat ../circuits/build/swap_vk_bytes.hex | tr -d '\n')
if [ -z "$SWAP_VK" ]; then
    echo "Error: Could not read swap VK from ../circuits/build/swap_vk_bytes.hex"
    echo "Please run circuits/scripts/compile.sh swap first"
    exit 1
fi
echo "✓ Swap VK: ${#SWAP_VK} bytes (expected: 912)"
echo ""

# Update or append an env variable in a file
update_env_var() {
    local key=$1
    local value=$2
    local file=$3

    if grep -q "^${key}=" "$file"; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
        else
            sed -i "s|^${key}=.*|${key}=${value}|" "$file"
        fi
    else
        echo "${key}=${value}" >> "$file"
    fi
}

# Create a single pool by coin type
create_pool() {
    local coin=$1
    local type_args=$2
    local coin_upper=$(echo "$coin" | tr '[:lower:]' '[:upper:]')

    echo "=== Creating $coin_upper Privacy Pool ($NETWORK) ==="
    [ "$coin" = "usdc" ] && echo "Token Type: $type_args"
    echo ""

    echo "Creating $coin_upper privacy pool..."
    echo "Command: sui client call --function create_shared_pool --type-args \"$type_args\""
    echo ""

    set +e
    RAW_OUTPUT=$(sui client call \
        --package "$PACKAGE_ID" \
        --module pool \
        --function create_shared_pool \
        --type-args "$type_args" \
        --args "0x$UNSHIELD_VK" "0x$TRANSFER_VK" "0x$SWAP_VK" \
        --json 2>&1)
    EXIT_CODE=$?
    POOL_OUTPUT=$(echo "$RAW_OUTPUT" | grep -v '^\[warning\]')
    set -e

    if [ $EXIT_CODE -ne 0 ]; then
        echo "❌ Transaction failed with exit code: $EXIT_CODE"
        echo "$POOL_OUTPUT"
        return 1
    fi

    if ! echo "$POOL_OUTPUT" | jq empty 2>/dev/null; then
        echo "❌ Transaction output is not valid JSON!"
        echo "$POOL_OUTPUT"
        return 1
    fi

    local tx_status
    tx_status=$(echo "$POOL_OUTPUT" | jq -r '.effects.V2.status // .effects.status.status // "unknown"' 2>/dev/null)

    if [ "$tx_status" != "success" ] && [ "$tx_status" != "Success" ]; then
        echo "❌ Transaction executed but failed! (status: $tx_status)"
        echo "$POOL_OUTPUT" | jq '.effects.V2.status // .effects.status // .clever_error'
        return 1
    fi

    local pool_id
    # Extract PrivacyPool shared object from top-level changed_objects
    pool_id=$(echo "$POOL_OUTPUT" | jq -r '
        .changed_objects[]?
        | select(.objectType? | strings | contains("PrivacyPool"))
        | .objectId' 2>/dev/null)

    if [ -z "$pool_id" ] || [ "$pool_id" = "null" ]; then
        echo "❌ Failed to extract pool ID from transaction output"
        echo "$POOL_OUTPUT" | jq '.objectChanges // .changed_objects'
        return 1
    fi

    echo "✅ $coin_upper Privacy Pool created: $pool_id"
    echo ""

    # Update frontend .env with network-specific variable names
    if [ "$coin" = "sui" ]; then
        update_env_var "NEXT_PUBLIC_${NETWORK_UPPER}_SUI_POOL_ID" "$pool_id" "$ENV_FILE"
        echo "✓ Updated NEXT_PUBLIC_${NETWORK_UPPER}_SUI_POOL_ID"
        [ -n "$RELAYER_ENV_FILE" ] && update_env_var "${NETWORK_UPPER}_SUI_POOL_ID" "$pool_id" "$RELAYER_ENV_FILE" && echo "✓ Updated ${NETWORK_UPPER}_SUI_POOL_ID in relayer .env"
    elif [ "$coin" = "dbusdc" ]; then
        update_env_var "NEXT_PUBLIC_${NETWORK_UPPER}_DBUSDC_POOL_ID" "$pool_id" "$ENV_FILE"
        update_env_var "NEXT_PUBLIC_${NETWORK_UPPER}_DBUSDC_TYPE" "$type_args" "$ENV_FILE"
        echo "✓ Updated NEXT_PUBLIC_${NETWORK_UPPER}_DBUSDC_POOL_ID, NEXT_PUBLIC_${NETWORK_UPPER}_DBUSDC_TYPE"
        if [ -n "$RELAYER_ENV_FILE" ]; then
            update_env_var "${NETWORK_UPPER}_DBUSDC_POOL_ID" "$pool_id" "$RELAYER_ENV_FILE"
            update_env_var "${NETWORK_UPPER}_DBUSDC_TYPE" "$type_args" "$RELAYER_ENV_FILE"
            echo "✓ Updated ${NETWORK_UPPER}_DBUSDC_POOL_ID, ${NETWORK_UPPER}_DBUSDC_TYPE in relayer .env"
        fi
    else
        update_env_var "NEXT_PUBLIC_${NETWORK_UPPER}_USDC_POOL_ID" "$pool_id" "$ENV_FILE"
        update_env_var "NEXT_PUBLIC_${NETWORK_UPPER}_USDC_TYPE" "$type_args" "$ENV_FILE"
        echo "✓ Updated NEXT_PUBLIC_${NETWORK_UPPER}_USDC_POOL_ID, NEXT_PUBLIC_${NETWORK_UPPER}_USDC_TYPE"
        if [ -n "$RELAYER_ENV_FILE" ]; then
            update_env_var "${NETWORK_UPPER}_USDC_POOL_ID" "$pool_id" "$RELAYER_ENV_FILE"
            update_env_var "${NETWORK_UPPER}_USDC_TYPE" "$type_args" "$RELAYER_ENV_FILE"
            echo "✓ Updated ${NETWORK_UPPER}_USDC_POOL_ID, ${NETWORK_UPPER}_USDC_TYPE in relayer .env"
        fi
    fi
    echo ""

    # Export pool ID for summary
    if [ "$coin" = "sui" ]; then
        SUI_POOL_RESULT="$pool_id"
    elif [ "$coin" = "dbusdc" ]; then
        DBUSDC_POOL_RESULT="$pool_id"
    else
        USDC_POOL_RESULT="$pool_id"
    fi
}

SUI_TYPE="0x2::sui::SUI"
if [ "$NETWORK" = "mainnet" ]; then
    USDC_TYPE="0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"
else
    USDC_TYPE="0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC"
    DBUSDC_TYPE="0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC"
fi

case "$COIN_TYPE" in
    sui)    create_pool sui "$SUI_TYPE" ;;
    usdc)   create_pool usdc "$USDC_TYPE" ;;
    dbusdc) create_pool dbusdc "$DBUSDC_TYPE" ;;
    both)
        create_pool sui "$SUI_TYPE"
        create_pool usdc "$USDC_TYPE"
        ;;
    all)
        create_pool sui "$SUI_TYPE"
        create_pool usdc "$USDC_TYPE"
        if [ "$NETWORK" = "testnet" ]; then
            create_pool dbusdc "$DBUSDC_TYPE"
        fi
        ;;
esac

echo "=== Summary ==="
echo "Package ID: $PACKAGE_ID"
[ -n "$SUI_POOL_RESULT" ]    && echo "SUI Pool ID:    $SUI_POOL_RESULT"
[ -n "$USDC_POOL_RESULT" ]   && echo "USDC Pool ID:   $USDC_POOL_RESULT"
[ -n "$DBUSDC_POOL_RESULT" ] && echo "DBUSDC Pool ID: $DBUSDC_POOL_RESULT"
echo "Network: $NETWORK"
echo "Unshield VK: ${#UNSHIELD_VK} bytes"
echo "Transfer VK: ${#TRANSFER_VK} bytes"
echo "Swap VK: ${#SWAP_VK} bytes"
