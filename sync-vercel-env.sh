#!/usr/bin/env bash
# sync-vercel-env.sh
# Deletes all existing Vercel env vars across all environments and re-uploads from a local .env file.
#
# Usage:
#   ./sync-vercel-env.sh              # defaults to .env
#   ./sync-vercel-env.sh frontend/.env

set -euo pipefail

ENV_FILE="${1:-.env}"
ENVIRONMENTS=("production" "preview" "development")

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: env file '$ENV_FILE' not found."
  exit 1
fi

echo ">>> Syncing '$ENV_FILE' to Vercel (all environments)"
echo ""

# ── 1. Delete all existing env vars across all environments ──────────────────
echo "Step 1: Removing existing Vercel env vars from all environments..."

EXISTING=$(vercel env ls 2>/dev/null | tail -n +3 | awk '{print $1}' | sort -u | grep -v '^$' || true)

if [[ -z "$EXISTING" ]]; then
  echo "  (no existing vars found)"
else
  while IFS= read -r key; do
    for env in "${ENVIRONMENTS[@]}"; do
      echo "  Removing: $key ($env)"
      vercel env rm "$key" "$env" -y 2>/dev/null || true
    done
  done <<< "$EXISTING"
fi

echo ""

# ── 2. Upload from .env file to all environments ─────────────────────────────
echo "Step 2: Uploading vars from '$ENV_FILE' to all environments..."

while IFS='=' read -r key value || [[ -n "$key" ]]; do
  # Skip comments and blank lines
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${key// }" ]] && continue

  # Strip inline comments
  value="${value%%#*}"

  # Strip surrounding whitespace
  key="${key// /}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  # Strip surrounding quotes
  value="${value%\"}" && value="${value#\"}"
  value="${value%\'}" && value="${value#\'}"

  for env in "${ENVIRONMENTS[@]}"; do
    # Remove first to avoid "already exists" error
    vercel env rm "$key" "$env" -y 2>/dev/null || true
    echo "  Adding: $key ($env)"
    printf '%s' "$value" | vercel env add "$key" "$env"
  done
done < "$ENV_FILE"

echo ""
echo "Done. All vars from '$ENV_FILE' have been synced to Vercel (production, preview, development)."
