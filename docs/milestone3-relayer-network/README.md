# Milestone 3: Relayer/Broadcaster Network

**Priority:** 🟠 Medium-High
**Status:** ✅ Implemented
**Dependencies:** Private Transfers (Milestone 1) ✅

## Overview

Create a relayer server that submits transactions on behalf of users, so the user's public wallet address never appears on-chain. The ZK proof already authorizes every operation — the relayer is a pure transaction broadcaster, not a trusted party.

## Why This Feature?

**Current Privacy Leak:**

- Users submit transactions directly from their wallets
- Blockchain explorer links the user's address to shield/unshield/transfer operations
- Transaction timing and gas source reveal behavioral patterns

**With Relayer:**

- Transactions appear to originate from the relayer's address
- User's public address never touches the privacy pool
- Gas paid by the relayer (subsidized for MVP; fee mechanism is future work)
- Stronger privacy guarantees for all operations

## Architecture

```
User (Browser)
  → { proofBytes, publicInputs, encryptedNotes, nullifiers, ... }
  → Relayer Server
       ↓ validates pool/token whitelist
       ↓ builds Transaction (relayer is tx sender)
       ↓ signs with relayer keypair
       ↓ submits to Sui
       ← returns txHash
User ← txHash
```

**Key insight:** The ZK proof cryptographically authorizes the operation. The relayer just broadcasts; user's wallet never touches the pool contract.

## Scope & Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Fee mechanism | Deferred (free relay) | Would require a 3rd circuit output note; circuits currently support 2-in/2-out only |
| Storage | In-memory | MVP doesn't need Redis/PostgreSQL |
| Operations | Transfer + Unshield + Swap | All 3 core operations supported |
| Tech stack | Express + TypeScript + `@mysten/sui` ^2.4 | Consistent with SDK |
| Multi-network | Graceful degradation | Missing private key → skip that network, not crash |

## Fee Mechanism (Future)

On-chain fee payment requires circuit modification to support a 3rd output note (fee note to relayer's NSK). This means:

1. Modifying `transfer.circom` / `unshield.circom` / `swap.circom` for 3-output support
2. Regenerating all `_final.zkey` proving keys (hours of computation)
3. Redeploying verifier contracts

Until then, the relayer is subsidized. Add this to Milestone 3.5 or Milestone 4.

---

## Implementation

### Phase 1: Relayer Server

**Directory:** `relayer/`

```
relayer/
├── src/
│   ├── server.ts           # Express app (default 8080)
│   ├── relayer.ts          # Transaction building + Sui submission + whitelist validation
│   ├── validator.ts        # Zod request schemas
│   └── fee-calculator.ts   # Gas estimation (for fee-quote endpoint)
├── config/
│   └── relayer-config.ts   # RPC URL, keypair, whitelist, DEEP coin type
├── package.json
└── tsconfig.json
```

**Dependencies:**

```json
{
  "express": "^4.18",
  "zod": "^3.22",
  "@mysten/sui": "^2.4.0",
  "cors": "^2.8",
  "helmet": "^7.0",
  "express-rate-limit": "^7.0"
}
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/relayer-info` | Address, supported tokens, fee premium, uptime (per configured network) |
| GET | `/fee-quote?network=` | Gas estimate for an operation type |
| POST | `/submit/transfer` | Submit private transfer |
| POST | `/submit/unshield` | Submit unshield |
| POST | `/submit/swap` | Submit private swap |

Returns `503` if the requested network is not configured on this relayer instance.

**Request schemas (Zod):**

```typescript
// Transfer
const TransferSubmitSchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
  poolId: z.string().min(1),
  tokenType: z.string().min(1),
  proofBytes: hexString,
  publicInputsBytes: hexString,
  nullifiers: hexString,              // BCS-encoded vector<vector<u8>>, NOT hex[]
  encryptedNotes: z.array(hexString).min(1).max(2),
})

// Unshield extends transfer with recipient address
const UnshieldSubmitSchema = TransferSubmitSchema.extend({
  recipient: z.string().startsWith("0x"),
})

// Swap
const SwapSubmitSchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
  poolInId: z.string().min(1),
  poolOutId: z.string().min(1),
  deepbookPoolId: z.string().min(1),
  tokenTypeIn: z.string().min(1),
  tokenTypeOut: z.string().min(1),
  isBid: z.boolean(),
  proofBytes: hexString,
  publicInputsBytes: hexString,       // contains amount_in and min_amount_out
  nullifiers: hexString,              // BCS-encoded vector<vector<u8>>
  encryptedOutputNote: hexString,
  encryptedChangeNote: hexString,
})

// hexString: non-empty, valid hex chars, even length
const hexString = z.string().min(2).regex(/^[0-9a-fA-F]+$/).refine(s => s.length % 2 === 0)
```

> **Note:** `nullifiers` is a single hex string containing BCS-encoded `vector<vector<u8>>`, pre-encoded by the SDK. This avoids double-encoding when passed to the Move contract.

**Transaction building in `relayer.ts`:**

```typescript
import { Transaction } from "@mysten/sui/transactions"
import { bcs } from "@mysten/sui/bcs"

// Transfer
const tx = new Transaction()
tx.moveCall({
  target: `${packageId}::pool::transfer`,
  typeArguments: [tokenType],
  arguments: [
    tx.object(poolId),
    tx.pure.vector("u8", Array.from(hexToBytes(proofBytes))),
    tx.pure.vector("u8", Array.from(hexToBytes(publicInputsBytes))),
    tx.pure(hexToBytes(nullifiers)),  // BCS-encoded nullifiers passed as raw bytes
    tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(encryptedNotes.map(hexToBytes)).toBytes()),
  ]
})
const result = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: relayerKeypair,
  options: { showEffects: true },
})
```

**Swap direction** — `pool::swap` (ask: base→quote) vs `pool::swap_bid` (bid: quote→base) are distinct entry points with reversed type arguments. The `isBid` field in the request selects between them:

```typescript
// isBid = false → ask (e.g. SUI → USDC): pool::swap<TokenIn, TokenOut>
// isBid = true  → bid (e.g. USDC → SUI): pool::swap_bid<TokenOut, TokenIn>
const target = isBid ? `${packageId}::pool::swap_bid` : `${packageId}::pool::swap`
const typeArguments = isBid
  ? [tokenTypeOut, tokenTypeIn]  // type args reversed for swap_bid
  : [tokenTypeIn, tokenTypeOut]
```

**DEEP token management** — swap functions require `deep_in: Coin<DEEP>` for DeepBook fees. The relayer selects the DEEP coin with the largest balance and passes it whole; the contract returns any unused DEEP after the swap:

```typescript
const deepCoins = await client.getCoins({ owner: relayerAddress, coinType: DEEP_COIN_TYPE })
const deepCoinId = deepCoins.data.reduce((max, coin) =>
  BigInt(coin.balance) > BigInt(max.balance) ? coin : max
).coinObjectId
// deepCoinId is passed as tx.object(deepCoinId) — no splitCoins needed
```

**Security:**

- Rate limiting per IP: 10 req/min on `/submit/*`, 60 req/min on GET endpoints
- Helmet for HTTP headers
- Input validation via Zod (format, length, hex encoding) before any processing
- **Pool/token whitelist**: each submit endpoint validates `poolId`, `deepbookPoolId`, and `tokenType` against allowed sets before building a transaction; rejects unknown IDs outright

**Whitelist configuration:**

The whitelist is derived automatically from existing `NEXT_PUBLIC_*` env vars — no additional config required. In `relayer-config.ts`, `NETWORK_DEFAULTS` maps each network to the env var names for its pool IDs and token types:

```typescript
// Mainnet
poolEnvVars:         ["NEXT_PUBLIC_MAINNET_SUI_POOL_ID", "NEXT_PUBLIC_MAINNET_USDC_POOL_ID"]
deepbookPoolEnvVars: ["NEXT_PUBLIC_MAINNET_DEEPBOOK_SUI_USDC"]
tokenTypeEnvVars:    ["NEXT_PUBLIC_MAINNET_USDC_TYPE", "NEXT_PUBLIC_MAINNET_DEEP_TYPE"]
nativeTokenTypes:    ["0x2::sui::SUI"]  // always allowed

// Testnet
poolEnvVars:         ["NEXT_PUBLIC_TESTNET_SUI_POOL_ID", "NEXT_PUBLIC_TESTNET_USDC_POOL_ID",
                      "NEXT_PUBLIC_TESTNET_DBUSDC_POOL_ID"]
deepbookPoolEnvVars: ["NEXT_PUBLIC_TESTNET_DEEPBOOK_SUI_DBUSDC"]
tokenTypeEnvVars:    ["NEXT_PUBLIC_TESTNET_USDC_TYPE", "NEXT_PUBLIC_TESTNET_DBUSDC_TYPE",
                      "NEXT_PUBLIC_TESTNET_DEEP_TYPE"]
```

If a whitelist set is empty (env vars not set), the check is skipped (open mode). In production, ensure all `NEXT_PUBLIC_*` pool and type env vars are set.

**Multi-network graceful degradation:**

`loadAllConfigs()` returns `Partial<Record<Network, RelayerConfig>>`. If a network's private key or package ID is missing, it is skipped with a warning — the relayer still starts on the remaining networks.

```text
[relayer] Skipping mainnet: MAINNET_RELAYER_PRIVATE_KEY environment variable is not set
Relayer running on port 8080
Active networks: testnet
```

### Phase 2: SDK — RelayerClient

**File:** `sdk/src/relayer.ts`

```typescript
export interface RelayerConfig {
  url: string
  network: "mainnet" | "testnet"
}

export interface TransferRelayRequest {
  poolId: string
  tokenType: string
  proofBytes: Uint8Array
  publicInputsBytes: Uint8Array
  nullifiers: Uint8Array          // BCS-encoded vector<vector<u8>>
  encryptedNotes: Uint8Array[]
}

export interface UnshieldRelayRequest extends TransferRelayRequest {
  recipient: string
}

export interface SwapRelayRequest {
  poolInId: string
  poolOutId: string
  deepbookPoolId: string
  tokenTypeIn: string
  tokenTypeOut: string
  isBid: boolean
  proofBytes: Uint8Array
  publicInputsBytes: Uint8Array
  nullifiers: Uint8Array          // BCS-encoded vector<vector<u8>>
  encryptedOutputNote: Uint8Array
  encryptedChangeNote: Uint8Array
}

export interface RelayerInfo {
  address: string
  feePremium: number
  supportedTokens: string[]
  uptime: number
}

export class RelayerClient {
  constructor(private config: RelayerConfig) {}

  async getRelayerInfo(): Promise<RelayerInfo>
  async getFeeQuote(): Promise<FeeQuote>
  async submitTransfer(req: TransferRelayRequest): Promise<string>   // returns txHash
  async submitUnshield(req: UnshieldRelayRequest): Promise<string>
  async submitSwap(req: SwapRelayRequest): Promise<string>
}
```

**Exported from `sdk/src/index.ts`:**

```typescript
export { RelayerClient } from "./relayer.js"
export type { RelayerConfig, TransferRelayRequest, UnshieldRelayRequest,
              SwapRelayRequest, FeeQuote, RelayerInfo } from "./relayer.js"
```

### Phase 3: Frontend Integration

**`frontend/src/lib/relayerConfig.ts`:**

```typescript
export const RELAYER_URLS: Record<string, string | null> = {
  testnet: process.env.NEXT_PUBLIC_TESTNET_RELAYER_URL || null,
  mainnet: process.env.NEXT_PUBLIC_MAINNET_RELAYER_URL || null,
}
```

**`frontend/src/components/RelayerSelector.tsx`:**

- Toggle: "Direct Submission" vs "Via Relayer"
- Pings `/relayer-info` to check liveness and display relayer address
- Saves preference + custom URL to localStorage

**`TransferForm.tsx`, `UnshieldForm.tsx`, `SwapForm.tsx`:** After proof generation, branch on relayer toggle:

```typescript
if (useRelayer && relayerUrl) {
  const client = new RelayerClient({ url: relayerUrl, network })
  txDigest = await client.submitSwap({ poolInId, poolOutId, deepbookPoolId, ... })
} else {
  // existing signAndExecute path (unchanged)
  await signAndExecute({ transaction: tx })
}
```

---

## Files Created / Modified

### New Files

| File | Purpose |
|------|---------|
| `relayer/src/server.ts` | Express server entry point |
| `relayer/src/relayer.ts` | Sui transaction building, submission, and whitelist validation |
| `relayer/src/validator.ts` | Zod schemas for all request types |
| `relayer/src/fee-calculator.ts` | Gas estimation |
| `relayer/config/relayer-config.ts` | RPC URL, keypair, whitelist derivation from env vars |
| `relayer/package.json` | Package definition |
| `relayer/tsconfig.json` | TypeScript compiler config (ESM, node18) |
| `sdk/src/relayer.ts` | RelayerClient class |
| `frontend/src/lib/relayerConfig.ts` | Relayer URL helpers |
| `frontend/src/components/RelayerSelector.tsx` | Relayer toggle UI |

### Modified Files

| File | Change |
|------|--------|
| `sdk/src/index.ts` | Export RelayerClient and types |
| `frontend/src/components/TransferForm.tsx` | Add relayer branch in submit |
| `frontend/src/components/UnshieldForm.tsx` | Add relayer branch in submit |
| `frontend/src/components/SwapForm.tsx` | Add relayer branch in submit |
| `frontend/src/lib/constants.ts` | Add RELAYER_URLS config |

### No Contract Changes

The existing pool entry functions (`transfer`, `unshield`, `swap`) remain unchanged. The relayer simply calls them with the relayer's own Sui address as the transaction sender.

---

## Future Work (Post-MVP)

### Phase 4: On-Chain Fee Mechanism

Requires circuit changes:

1. Modify `transfer.circom` to support 3 output commitments (recipient + change + relayer fee)
2. Regenerate `transfer_final.zkey` proving key
3. Update verifier contract's expected public input size
4. Add fee verification in `relayer.ts` — confirm fee note commitment appears in submitted tx

### Phase 5: Relayer Registry Contract

`contracts/sources/relayer_registry.move`:

- On-chain registry of relayers with stake, NSK, fee rate
- Reputation system based on uptime / failed txs
- Minimum stake: 100 SUI
- Frontend fetches available relayers from registry

### Phase 6: Production Hardening

- PostgreSQL for transaction audit logs
- Redis for request queue and deduplication
- Load balancing across multiple relayer instances
- Tor support for IP privacy

---

## Success Criteria

- [x] `GET /relayer-info` returns valid JSON with relayer address and supported tokens
- [x] `POST /submit/transfer` succeeds — returns txHash within 10 seconds
- [x] `POST /submit/unshield` succeeds — funds arrive at recipient
- [x] `POST /submit/swap` succeeds — tokens swapped via DeepBook
- [x] Transaction sender on-chain = relayer address, NOT user's wallet
- [x] Rate limiting rejects >10 req/min per IP on submit endpoints
- [x] Frontend relayer toggle visible in Transfer, Unshield, Swap forms
- [x] Direct submission path still works when relayer is disabled
- [x] Pool ID and token type whitelist rejects unknown IDs before tx submission
- [x] Relayer starts gracefully when only one network is configured

## Verification Steps

1. Copy `.env.example` to `.env` and fill in `TESTNET_RELAYER_PRIVATE_KEY` and `NEXT_PUBLIC_TESTNET_PACKAGE_ID`
2. Start relayer: `cd relayer && npm run dev` (listens on `PORT`, default 8080)
3. Check `curl http://localhost:8080/relayer-info` — should return `{ testnet: { address, supportedTokens, ... } }`
4. Enable relayer toggle in frontend Transfer form, set URL to `http://localhost:8080`
5. Execute a private transfer — verify txHash returned
6. Check Sui explorer: tx sender = relayer address, not user's wallet
7. Verify shielded balance updates correctly
8. Test whitelist rejection: send a request with an invalid `poolId` — relayer should return `{ error: "Submission failed" }` (500) without submitting any transaction
