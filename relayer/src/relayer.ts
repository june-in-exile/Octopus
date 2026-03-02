import { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import type { RelayerConfig } from "../config/relayer-config.js";
import type {
  TransferSubmitRequest,
  UnshieldSubmitRequest,
  SwapSubmitRequest,
} from "./validator.js";

const CLOCK_OBJECT_ID = "0x6";

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string: odd length (${hex.length})`);
  }
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

  private requireInSet(set: Set<string>, value: string, label: string): void {
    if (set.size > 0 && !set.has(value)) {
      throw new Error(`${label} is not in the allowed list`);
    }
  }

  private validatePool(poolId: string): void {
    this.requireInSet(this.config.allowedPools, poolId, "Pool ID");
  }

  private validateTokenType(tokenType: string): void {
    this.requireInSet(new Set(this.config.supportedTokens), tokenType, "Token type");
  }

  private validateDeepbookPool(deepbookPoolId: string): void {
    this.requireInSet(this.config.allowedDeepbookPools, deepbookPoolId, "DeepBook pool ID");
  }

  async submitTransfer(req: TransferSubmitRequest): Promise<string> {
    this.validatePool(req.poolId);
    this.validateTokenType(req.tokenType);

    const tx = new Transaction();

    tx.moveCall({
      target: `${this.config.packageId}::pool::transfer`,
      typeArguments: [req.tokenType],
      arguments: [
        tx.object(req.poolId),
        tx.pure.vector("u8", Array.from(hexToBytes(req.proofBytes))),
        tx.pure.vector("u8", Array.from(hexToBytes(req.publicInputsBytes))),
        tx.pure(hexToBytes(req.nullifiers)),
        tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(req.encryptedNotes.map(hexToBytes)).toBytes()),
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
    this.validatePool(req.poolId);
    this.validateTokenType(req.tokenType);

    const tx = new Transaction();

    tx.moveCall({
      target: `${this.config.packageId}::pool::unshield`,
      typeArguments: [req.tokenType],
      arguments: [
        tx.object(req.poolId),
        tx.pure.vector("u8", Array.from(hexToBytes(req.proofBytes))),
        tx.pure.vector("u8", Array.from(hexToBytes(req.publicInputsBytes))),
        tx.pure(hexToBytes(req.nullifiers)),
        tx.pure.address(req.recipient),
        tx.pure.vector("u8", Array.from(hexToBytes(req.encryptedNotes[0]))),
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
    this.validatePool(req.poolInId);
    this.validatePool(req.poolOutId);
    this.validateDeepbookPool(req.deepbookPoolId);
    this.validateTokenType(req.tokenTypeIn);
    this.validateTokenType(req.tokenTypeOut);

    const deepCoins = await this.client.getCoins({
      owner: this.address,
      coinType: this.config.deepCoinType,
    });

    if (!deepCoins.data.length) {
      throw new Error(
        "Relayer has no DEEP tokens. Please fund the relayer with DEEP for swap fees.",
      );
    }

    const tx = new Transaction();

    // Pass the full DEEP coin so DeepBook has enough to cover the actual fee.
    // Unused DEEP is returned to the relayer by the contract after the swap.
    const bestCoin = deepCoins.data.reduce((max, coin) =>
      BigInt(coin.balance) > BigInt(max.balance) ? coin : max
    );
    if (BigInt(bestCoin.balance) < this.config.estimatedDeepFee) {
      throw new Error(
        `Relayer DEEP balance (${bestCoin.balance}) is below estimated fee (${this.config.estimatedDeepFee}). Please fund the relayer with more DEEP.`,
      );
    }
    const deepCoinId = bestCoin.coinObjectId;

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
        tx.object(deepCoinId),
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


function assertSuccess(effects: { status?: { status: string; error?: string } } | null | undefined): void {
  if (effects?.status?.status !== "success") {
    throw new Error(
      `Transaction failed: ${effects?.status?.error ?? "unknown error"}`,
    );
  }
}
