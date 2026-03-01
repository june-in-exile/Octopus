#!/bin/bash
set -e

# Parse arguments
NETWORK="testnet"
while [[ $# -gt 0 ]]; do
    case $1 in
        --network)
            NETWORK="$2"
            shift 2
            ;;
        *)
            echo "Usage: $0 [--network testnet|mainnet]"
            exit 1
            ;;
    esac
done

if [ "$NETWORK" != "testnet" ] && [ "$NETWORK" != "mainnet" ]; then
    echo "Error: --network must be 'testnet' or 'mainnet'"
    exit 1
fi

echo "=== Deploying Octopus Privacy Pool Package ==="
echo "Network: $NETWORK"

# Change to contracts directory (parent of scripts/)
cd "$(dirname "$0")/.."

# Determine frontend .env file path (contains NEXT_PUBLIC_* variables)
ENV_FILE=""
if [ -f "../frontend/.env.local" ]; then
    ENV_FILE="../frontend/.env.local"
elif [ -f "../frontend/.env" ]; then
    ENV_FILE="../frontend/.env"
else
    NETWORK_UPPER=$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')
    echo "Warning: No frontend .env file found. You'll need to manually update NEXT_PUBLIC_${NETWORK_UPPER}_PACKAGE_ID later."
fi

if [ -n "$ENV_FILE" ]; then
    echo "Using frontend .env file: $ENV_FILE"
fi

# Determine relayer .env file path (contains server-side variables without NEXT_PUBLIC_ prefix)
RELAYER_ENV_FILE=""
if [ -f "../relayer/.env" ]; then
    RELAYER_ENV_FILE="../relayer/.env"
fi

if [ -n "$RELAYER_ENV_FILE" ]; then
    echo "Using relayer .env file: $RELAYER_ENV_FILE"
fi

echo ""
echo "Step 1: Switching to $NETWORK..."
sui client switch --env "$NETWORK"

echo ""
echo "Step 2: Building Move package..."
sui move build

echo ""
echo "Step 3: Checking deployment status..."

# Check if package is already published on this network
UPGRADE_CAP=$(awk '/\[published\.'"$NETWORK"'\]/{found=1} found && /upgrade-capability =/{match($0, /0x[a-f0-9]+/); print substr($0, RSTART, RLENGTH); exit}' Published.toml)

if [ -n "$UPGRADE_CAP" ]; then
    echo "Found existing deployment on $NETWORK"
    echo "Upgrade capability: $UPGRADE_CAP"
    echo "Upgrading package..."

    RAW_OUTPUT=$(sui client upgrade --upgrade-capability "$UPGRADE_CAP" --json --no-lint)
    UPGRADE_OUTPUT=$(echo "$RAW_OUTPUT" | sed -n '/{/,$p')

    # Extract package ID from upgrade output
    NEXT_PUBLIC_PACKAGE_ID=$(echo "$UPGRADE_OUTPUT" | jq -r '.objectChanges[]? | select(.type == "published") | .packageId' 2>/dev/null)

    # Fallback: read from Published.toml if jq extraction failed
    if [ -z "$NEXT_PUBLIC_PACKAGE_ID" ]; then
        NEXT_PUBLIC_PACKAGE_ID=$(awk '/\[published\.'"$NETWORK"'\]/{found=1} found && /published-at =/{match($0, /0x[a-f0-9]+/); print substr($0, RSTART, RLENGTH); exit}' Published.toml)
    fi

    if [ -z "$NEXT_PUBLIC_PACKAGE_ID" ]; then
        echo "Error: Failed to extract package ID from upgrade output"
        echo "$UPGRADE_OUTPUT"
        exit 1
    fi

    echo "✅ Package upgraded successfully!"
    echo "Package ID: $NEXT_PUBLIC_PACKAGE_ID"
    echo ""
else
    echo "No existing deployment found on $NETWORK"
    echo "Publishing new package..."

    RAW_OUTPUT=$(sui client publish --json --no-lint)
    PUBLISH_OUTPUT=$(echo "$RAW_OUTPUT" | sed -n '/{/,$p')

    # Extract package ID from publish output
    NEXT_PUBLIC_PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | jq -r '.objectChanges[]? | select(.type == "published") | .packageId' 2>/dev/null)

    # Fallback: read from Published.toml if jq extraction failed
    if [ -z "$NEXT_PUBLIC_PACKAGE_ID" ]; then
        NEXT_PUBLIC_PACKAGE_ID=$(awk '/\[published\.'"$NETWORK"'\]/{found=1} found && /published-at =/{match($0, /0x[a-f0-9]+/); print substr($0, RSTART, RLENGTH); exit}' Published.toml)
    fi

    if [ -z "$NEXT_PUBLIC_PACKAGE_ID" ]; then
        echo "Error: Failed to extract package ID from publish output"
        echo "$PUBLISH_OUTPUT"
        exit 1
    fi

    echo "✅ Package published successfully!"
    echo "Package ID: $NEXT_PUBLIC_PACKAGE_ID"
    echo ""
fi

# Update .env file if it exists
if [ -n "$ENV_FILE" ]; then
    echo "Updating .env file with package ID..."

    # Function to update or append env variable
    update_env_var() {
        local key=$1
        local value=$2
        local file=$3

        if grep -q "^${key}=" "$file"; then
            # Update existing variable (macOS compatible)
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
            else
                sed -i "s|^${key}=.*|${key}=${value}|" "$file"
            fi
        else
            # Append new variable
            echo "${key}=${value}" >> "$file"
        fi
    }

    NETWORK_UPPER=$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')

    # Extract original-id from Published.toml
    ORIGINAL_PACKAGE_ID=$(awk '/\[published\.'"$NETWORK"'\]/{found=1} found && /original-id =/{match($0, /0x[a-f0-9]+/); print substr($0, RSTART, RLENGTH); exit}' Published.toml)

    # Update PACKAGE_ID (published-at) - used for function calls
    ENV_KEY="NEXT_PUBLIC_${NETWORK_UPPER}_PACKAGE_ID"
    update_env_var "$ENV_KEY" "$NEXT_PUBLIC_PACKAGE_ID" "$ENV_FILE"
    echo "✓ Updated $ENV_KEY = $NEXT_PUBLIC_PACKAGE_ID (published-at)"

    # Update or set ORIGINAL_PACKAGE_ID - used for event queries
    ORIGINAL_ENV_KEY="NEXT_PUBLIC_${NETWORK_UPPER}_ORIGINAL_PACKAGE_ID"
    if [ -n "$ORIGINAL_PACKAGE_ID" ]; then
        update_env_var "$ORIGINAL_ENV_KEY" "$ORIGINAL_PACKAGE_ID" "$ENV_FILE"
        echo "✓ Updated $ORIGINAL_ENV_KEY = $ORIGINAL_PACKAGE_ID (original-id)"

        if [ "$ORIGINAL_PACKAGE_ID" != "$NEXT_PUBLIC_PACKAGE_ID" ]; then
            echo ""
            echo "⚠️  NOTICE: This is an upgraded package (v2+)"
            echo "   - Function calls use: $NEXT_PUBLIC_PACKAGE_ID (published-at)"
            echo "   - Event queries use:  $ORIGINAL_PACKAGE_ID (original-id)"
        fi
    else
        echo "⚠️  Warning: Could not extract original-id from Published.toml"
    fi

    # Sync package IDs to relayer .env
    if [ -n "$RELAYER_ENV_FILE" ]; then
        update_env_var "${NETWORK_UPPER}_PACKAGE_ID" "$NEXT_PUBLIC_PACKAGE_ID" "$RELAYER_ENV_FILE"
        echo "✓ Updated ${NETWORK_UPPER}_PACKAGE_ID in relayer .env"
        if [ -n "$ORIGINAL_PACKAGE_ID" ]; then
            update_env_var "${NETWORK_UPPER}_ORIGINAL_PACKAGE_ID" "$ORIGINAL_PACKAGE_ID" "$RELAYER_ENV_FILE"
            echo "✓ Updated ${NETWORK_UPPER}_ORIGINAL_PACKAGE_ID in relayer .env"
        fi
    fi

    echo ""
fi

echo "=== Deployment Complete ==="
echo "Package ID: $NEXT_PUBLIC_PACKAGE_ID"
echo "Network: $NETWORK"
echo ""
echo "=== Next Steps ==="
echo "1. Create privacy pools by running:"
echo "   ./create_pool.sh --network $NETWORK"