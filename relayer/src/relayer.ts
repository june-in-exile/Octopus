import { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { RelayerConfig } from "../config/relayer-config.js";
import type {
  TransferSubmitRequest,
  UnshieldSubmitRequest,
  SwapSubmitRequest,
} from "./validator.js";

const CLOCK_OBJECT_ID = "0x6";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export class Relayer {
  private readonly client: SuiClient;
  private readonly startTime: number;

  constructor(private readonly config: RelayerConfig) {
    this.client = new SuiClient({ url: config.rpcUrl, network: config.network });
    this.startTime = Date.now();
  }

  get address(): string {
    return this.config.keypair.toSuiAddress();
  }

  get uptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  async submitTransfer(req: TransferSubmitRequest): Promise<string> {
    const tx = new Transaction();

    const encryptedNoteBytes = req.encryptedNotes.map(hexToBytes);

    tx.moveCall({
      target: `${this.config.packageId}::pool::transfer`,
      typeArguments: [req.tokenType],
      arguments: [
        tx.object(req.poolId),
        tx.pure.vector("u8", Array.from(hexToBytes(req.proofBytes))),
        tx.pure.vector("u8", Array.from(hexToBytes(req.publicInputsBytes))),
        // nullifiers is already BCS-encoded vector<vector<u8>> from the SDK prover
        tx.pure(hexToBytes(req.nullifiers)),
        // encrypted notes: re-encode as vector<vector<u8>> using bcs
        tx.pure(buildEncryptedNotesBytes(encryptedNoteBytes)),
      ],
    });

    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.config.keypair,
      options: { showEffects: true },
    });

    assertSuccess(result.effects);
    return result.digest;
  }

  async submitUnshield(req: UnshieldSubmitRequest): Promise<string> {
    const tx = new Transaction();

    // encryptedNotes[0] is the encrypted change note
    const encryptedChangeNoteBytes = hexToBytes(req.encryptedNotes[0]);

    tx.moveCall({
      target: `${this.config.packageId}::pool::unshield`,
      typeArguments: [req.tokenType],
      arguments: [
        tx.object(req.poolId),
        tx.pure.vector("u8", Array.from(hexToBytes(req.proofBytes))),
        tx.pure.vector("u8", Array.from(hexToBytes(req.publicInputsBytes))),
        tx.pure(hexToBytes(req.nullifiers)),
        tx.pure.address(req.recipient),
        tx.pure.vector("u8", Array.from(encryptedChangeNoteBytes)),
      ],
    });

    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.config.keypair,
      options: { showEffects: true },
    });

    assertSuccess(result.effects);
    return result.digest;
  }

  async submitSwap(req: SwapSubmitRequest): Promise<string> {
    const deepCoins = await this.client.getCoins({
      owner: this.address,
      coinType: this.config.deepCoinType,
    });

    if (!deepCoins.data.length) {
      throw new Error(
        "Relayer has no DEEP tokens. Please fund the relayer with DEEP for swap fees.",
      );
    }

    const hasEnoughDeep = deepCoins.data.some(
      (c) => BigInt(c.balance) >= this.config.estimatedDeepFee,
    );
    if (!hasEnoughDeep) {
      throw new Error(
        `Relayer has insufficient DEEP balance. Minimum required: ${this.config.estimatedDeepFee}`,
      );
    }

    const tx = new Transaction();

    // Split the estimated DEEP fee from the relayer's coin
    const [deepCoin] = tx.splitCoins(
      tx.object(deepCoins.data[0].coinObjectId),
      [tx.pure.u64(this.config.estimatedDeepFee)],
    );

    // isBid=false → ask (base→quote): pool::swap<TokenIn, TokenOut>
    // isBid=true  → bid (quote→base): pool::swap_bid<TokenOut, TokenIn> (type args reversed)
    const target = req.isBid
      ? `${this.config.packageId}::pool::swap_bid`
      : `${this.config.packageId}::pool::swap`;
    const typeArguments = req.isBid
      ? [req.tokenTypeOut, req.tokenTypeIn]
      : [req.tokenTypeIn, req.tokenTypeOut];

    tx.moveCall({
      target,
      typeArguments,
      arguments: [
        tx.object(req.poolInId),
        tx.object(req.poolOutId),
        tx.object(req.deepbookPoolId),
        tx.pure.vector("u8", Array.from(hexToBytes(req.proofBytes))),
        tx.pure.vector("u8", Array.from(hexToBytes(req.publicInputsBytes))),
        tx.pure(hexToBytes(req.nullifiers)),
        deepCoin,
        tx.object(CLOCK_OBJECT_ID),
        tx.pure.vector("u8", Array.from(hexToBytes(req.encryptedOutputNote))),
        tx.pure.vector("u8", Array.from(hexToBytes(req.encryptedChangeNote))),
      ],
    });

    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.config.keypair,
      options: { showEffects: true },
    });

    assertSuccess(result.effects);
    return result.digest;
  }
}

// BCS-encode a vector<vector<u8>>:
// [outer_len] ([inner_len] [inner_bytes...])...
function buildEncryptedNotesBytes(notes: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([notes.length])];
  for (const note of notes) {
    parts.push(new Uint8Array([note.length]));
    parts.push(note);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function assertSuccess(effects: { status?: { status: string; error?: string } } | null | undefined): void {
  if (effects?.status?.status !== "success") {
    throw new Error(
      `Transaction failed: ${effects?.status?.error ?? "unknown error"}`,
    );
  }
}
