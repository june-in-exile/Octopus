#!/usr/bin/env bash
# sync-vercel-env.sh
# Deletes all existing Vercel env vars across specified environments and re-uploads from a local .env file.
#
# Usage:
#   ./sync-vercel-env.sh                              # defaults to frontend/.env, all environments
#   ./sync-vercel-env.sh frontend/.env.local          # custom env file, all environments
#   ./sync-vercel-env.sh --env prod                   # production only
#   ./sync-vercel-env.sh --env preview frontend/.env  # preview only, custom file
#   ./sync-vercel-env.sh --remove                     # remove all vars from all environments
#   ./sync-vercel-env.sh --env dev --remove           # remove all vars from development only
#
# --env options:
#   prod | production   → production only
#   pre  | preview      → preview only
#   dev  | development  → development only
#   (omit)              → all three environments
#
# --remove: only remove vars, skip uploading

set -euo pipefail

# ── Parse arguments ───────────────────────────────────────────────────────────
ENV_FILTER=""
ENV_FILE=""
REMOVE_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      shift
      case "${1:-}" in
        prod|production)  ENV_FILTER="production" ;;
        pre|preview)      ENV_FILTER="preview" ;;
        dev|development)  ENV_FILTER="development" ;;
        *)
          echo "Error: unknown --env value '${1:-}'. Valid: prod, production, pre, preview, dev, development"
          exit 1
          ;;
      esac
      shift
      ;;
    --remove)
      REMOVE_ONLY=true
      shift
      ;;
    -*)
      echo "Error: unknown option '$1'"
      exit 1
      ;;
    *)
      ENV_FILE="$1"
      shift
      ;;
  esac
done

if [[ "$REMOVE_ONLY" == false ]]; then
  ENV_FILE="${ENV_FILE:-frontend/.env}"
fi

if [[ -n "$ENV_FILTER" ]]; then
  ENVIRONMENTS=("$ENV_FILTER")
else
  ENVIRONMENTS=("production" "preview" "development")
fi

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ "$REMOVE_ONLY" == false && ! -f "$ENV_FILE" ]]; then
  echo "Error: env file '$ENV_FILE' not found."
  exit 1
fi

ENV_LABEL=$(IFS=', '; echo "${ENVIRONMENTS[*]}")
if [[ "$REMOVE_ONLY" == true ]]; then
  echo ">>> Removing all Vercel env vars ($ENV_LABEL)"
else
  echo ">>> Syncing '$ENV_FILE' to Vercel ($ENV_LABEL)"
fi
echo ""

# ── 1. Delete existing env vars from specified environments ───────────────────
echo "Step 1: Removing existing Vercel env vars from: $ENV_LABEL..."

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

if [[ "$REMOVE_ONLY" == true ]]; then
  echo "Done. All vars have been removed from Vercel ($ENV_LABEL)."
  exit 0
fi

# ── 2. Upload from .env file to specified environments ────────────────────────
echo "Step 2: Uploading vars from '$ENV_FILE' to: $ENV_LABEL..."

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
echo "Done. All vars from '$ENV_FILE' have been synced to Vercel ($ENV_LABEL)."
