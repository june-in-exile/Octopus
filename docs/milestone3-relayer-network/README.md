# Milestone 3: Relayer/Broadcaster Network

**Priority:** 🟠 Medium-High
**Status:** Planning
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

## Fee Mechanism (Future)

On-chain fee payment requires circuit modification to support a 3rd output note (fee note to relayer's NSK). This means:

1. Modifying `transfer.circom` / `unshield.circom` / `swap.circom` for 3-output support
2. Regenerating all `_final.zkey` proving keys (hours of computation)
3. Redeploying verifier contracts

Until then, the relayer is subsidized. Add this to Milestone 3.5 or Milestone 4.

---

## Implementation

### Phase 1: Relayer Server

**New directory:** `relayer/`

```
relayer/
├── src/
│   ├── server.ts           # Express app (port 3001)
│   ├── relayer.ts          # Transaction building + Sui submission
│   ├── validator.ts        # Zod request schemas
│   └── fee-calculator.ts   # Gas estimation (for fee-quote endpoint)
├── config/
│   └── relayer-config.ts   # RPC URL, keypair path, fee premium
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
| GET | `/relayer-info` | Address, supported tokens, fee premium |
| GET | `/fee-quote` | Gas estimate for an operation type |
| POST | `/submit/transfer` | Submit private transfer |
| POST | `/submit/unshield` | Submit unshield |
| POST | `/submit/swap` | Submit private swap |

**Request schemas (Zod):**

```typescript
// Transfer
const TransferSubmitRequest = z.object({
  poolId: z.string(),
  tokenType: z.string(),
  proofBytes: z.string(),              // hex
  publicInputsBytes: z.string(),       // hex
  nullifiers: z.array(z.string()),     // hex[]
  encryptedNotes: z.array(z.string()), // hex[]
})

// Unshield
const UnshieldSubmitRequest = TransferSubmitRequest.extend({
  recipient: z.string(),
})

// Swap
const SwapSubmitRequest = z.object({
  poolInId: z.string(),
  poolOutId: z.string(),
  deepbookPoolId: z.string(),
  tokenTypeIn: z.string(),
  tokenTypeOut: z.string(),
  isBid: z.boolean(),                  // true = quote→base (swap_bid), false = base→quote (swap)
  proofBytes: z.string(),
  publicInputsBytes: z.string(),       // contains amount_in and min_amount_out
  nullifiers: z.array(z.string()),
  encryptedOutputNote: z.string(),     // hex
  encryptedChangeNote: z.string(),     // hex
})
```

**Transaction building in `relayer.ts`** — uses `@mysten/sui` v2.4 API (not deprecated `TransactionBlock`):

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
    tx.pure.vector("u8", hexToBytes(proofBytes)),
    tx.pure.vector("u8", hexToBytes(publicInputsBytes)),
    tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(nullifierBytes).toBytes()),
    tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(encryptedNotes).toBytes()),
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
  ? [tokenTypeOut, tokenTypeIn]  // [Base, Quote] reversed for swap_bid
  : [tokenTypeIn, tokenTypeOut]
```

**DEEP token management** — swap functions require `deep_in: Coin<DEEP>` for DeepBook fees. The relayer must hold DEEP tokens and split the correct amount within the transaction:

```typescript
// Fetch relayer's DEEP coins and split for fee
const deepCoins = await client.getCoins({ owner: relayerKeypair.toSuiAddress(), coinType: DEEP_COIN_TYPE })
const [deepCoin] = tx.splitCoins(tx.object(deepCoins.data[0].coinObjectId), [tx.pure.u64(ESTIMATED_DEEP_FEE)])
// pass deepCoin as the deep_in argument
```

**Security:**

- Rate limiting per IP: 10 req/min on `/submit/*`, 60 req/min on GET endpoints
- Helmet for HTTP headers
- Input validation via Zod before any processing
- No logging of request IP by default

### Phase 2: SDK — RelayerClient

**New file:** `sdk/src/relayer.ts`

```typescript
export interface RelayerConfig {
  url: string
}

export interface TransferRelayRequest {
  poolId: string
  tokenType: string
  proofBytes: Uint8Array
  publicInputsBytes: Uint8Array
  nullifiers: Uint8Array[]
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
  isBid: boolean               // true = quote→base (swap_bid), false = base→quote (swap)
  proofBytes: Uint8Array
  publicInputsBytes: Uint8Array  // contains amount_in and min_amount_out
  nullifiers: Uint8Array[]
  encryptedOutputNote: Uint8Array
  encryptedChangeNote: Uint8Array
}

export interface FeeQuote {
  baseFee: number
  feePremium: number
  totalFee: number
  expiresAt: number
}

export interface RelayerInfo {
  address: string
  feePremium: number
  supportedTokens: string[]
  uptime: number
}

export class RelayerClient {
  constructor(private config: RelayerConfig) {}

  async getFeeQuote(type: "transfer" | "unshield" | "swap", tokenType: string): Promise<FeeQuote>
  async submitTransfer(req: TransferRelayRequest): Promise<string>  // txHash
  async submitUnshield(req: UnshieldRelayRequest): Promise<string>
  async submitSwap(req: SwapRelayRequest): Promise<string>
  async getRelayerInfo(): Promise<RelayerInfo>
}
```

**Export from `sdk/src/index.ts`:**

```typescript
export { RelayerClient } from "./relayer.js"
export type {
  RelayerConfig,
  TransferRelayRequest,
  UnshieldRelayRequest,
  SwapRelayRequest,
  FeeQuote,
  RelayerInfo,
} from "./relayer.js"
```

### Phase 3: Frontend Integration

**New file:** `frontend/src/lib/relayerConfig.ts`

```typescript
export const DEFAULT_RELAYER_URLS: Record<string, string[]> = {
  testnet: [process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:3001"],
  mainnet: [],
}

export function getDefaultRelayerUrl(network: string): string | null {
  return DEFAULT_RELAYER_URLS[network]?.[0] ?? null
}
```

**New component:** `frontend/src/components/RelayerSelector.tsx`

- Toggle: "Direct Submission" vs "Via Relayer"
- Shows relayer URL and status indicator (pings `/relayer-info`)
- Saves preference to localStorage

**Modify `frontend/src/components/TransferForm.tsx`:**

```typescript
// Add state
const [useRelayer, setUseRelayer] = useState(false)
const [relayerUrl, setRelayerUrl] = useState<string | null>(getDefaultRelayerUrl(NETWORK))

// In submit handler, after proof generation:
if (useRelayer && relayerUrl) {
  const relayerClient = new RelayerClient({ url: relayerUrl })
  const txHash = await relayerClient.submitTransfer({
    poolId, tokenType, proofBytes, publicInputsBytes, nullifiers, encryptedNotes
  })
  // show success with txHash
} else {
  // existing signAndExecute path (unchanged)
  await signAndExecute({ transaction: tx })
}
```

**Modify `frontend/src/components/UnshieldForm.tsx`** — same pattern.

**Modify `frontend/src/components/SwapForm.tsx`** — same pattern with `submitSwap`.

**Modify `frontend/src/lib/constants.ts`:**

```typescript
export const RELAYER_URLS = {
  testnet: process.env.NEXT_PUBLIC_TESTNET_RELAYER_URL ?? null,
  mainnet: process.env.NEXT_PUBLIC_MAINNET_RELAYER_URL ?? null,
}
```

---

## Files to Create / Modify

### New Files

| File | Purpose |
|------|---------|
| `relayer/src/server.ts` | Express server entry point |
| `relayer/src/relayer.ts` | Sui transaction building and submission |
| `relayer/src/validator.ts` | Zod schemas for all request types |
| `relayer/src/fee-calculator.ts` | Gas estimation |
| `relayer/config/relayer-config.ts` | RPC URL, keypair, fee config, DEEP coin type |
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

- [ ] `GET /relayer-info` returns valid JSON with relayer address
- [ ] `POST /submit/transfer` succeeds — returns txHash within 10 seconds
- [ ] `POST /submit/unshield` succeeds — funds arrive at recipient
- [ ] `POST /submit/swap` succeeds — tokens swapped via DeepBook
- [ ] Transaction sender on-chain = relayer address, NOT user's wallet
- [ ] Rate limiting rejects >10 req/min per IP on submit endpoints
- [ ] Frontend relayer toggle visible in Transfer, Unshield, Swap forms
- [ ] Direct submission path still works when relayer is disabled

## Verification Steps

1. Start relayer: `cd relayer && npm run dev` (port 3001)
2. Check `curl http://localhost:3001/relayer-info`
3. Enable relayer toggle in frontend Transfer form
4. Execute a private transfer — verify txHash returned
5. Check Sui explorer: tx sender = relayer address
6. Verify shielded balance updates correctly
7. Run `cd relayer && npm test`
