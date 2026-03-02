function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export type Network = "mainnet" | "testnet";

export interface RelayerConfig {
  url: string;
  network: Network;
}

export interface TransferRelayRequest {
  poolId: string;
  tokenType: string;
  proofBytes: Uint8Array;
  publicInputsBytes: Uint8Array;
  /** BCS-encoded vector<vector<u8>> — returned directly by SDK proof generators */
  nullifiers: Uint8Array;
  encryptedNotes: Uint8Array[];
}

export interface UnshieldRelayRequest extends TransferRelayRequest {
  recipient: string;
}

export interface SwapRelayRequest {
  poolInId: string;
  poolOutId: string;
  deepbookPoolId: string;
  tokenTypeIn: string;
  tokenTypeOut: string;
  /** true = quote→base (swap_bid), false = base→quote (swap) */
  isBid: boolean;
  proofBytes: Uint8Array;
  publicInputsBytes: Uint8Array;
  /** BCS-encoded vector<vector<u8>> */
  nullifiers: Uint8Array;
  encryptedOutputNote: Uint8Array;
  encryptedChangeNote: Uint8Array;
}

export interface FeeQuote {
  network: Network;
  baseFee: number;
  feePremium: number;
  totalFee: number;
  expiresAt: number;
}

export interface RelayerInfo {
  address: string;
  feePremium: number;
  supportedTokens: string[];
  uptime: number;
}

export class RelayerClient {
  constructor(private readonly config: RelayerConfig) { }

  async getRelayerInfo(): Promise<RelayerInfo> {
    const res = await fetch(`${this.config.url}/relayer-info`);
    if (!res.ok) {
      throw new Error(`Relayer info request failed: ${res.statusText}`);
    }
    const data = (await res.json()) as Record<Network, RelayerInfo>;
    const info = data[this.config.network];
    if (!info) {
      throw new Error(`Relayer does not support network: ${this.config.network}`);
    }
    return info;
  }

  async checkHealth(timeoutMs = 5000): Promise<void> {
    let res: Response;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      res = await fetch(`${this.config.url}/relayer-info`, { signal });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Relayer did not respond within ${timeoutMs / 1000}s`);
      }
      throw new Error(`Relayer unreachable at ${this.config.url}`);
    }
    if (!res.ok) {
      throw new Error(`Relayer returned status ${res.status}`);
    }
    const data = (await res.json()) as Record<Network, RelayerInfo>;
    if (!data[this.config.network]) {
      throw new Error(`Relayer does not support network: ${this.config.network}`);
    }
  }

  async getFeeQuote(): Promise<FeeQuote> {
    const params = new URLSearchParams({ network: this.config.network });
    const res = await fetch(`${this.config.url}/fee-quote?${params}`);
    if (!res.ok) {
      throw new Error(`Fee quote request failed: ${res.statusText}`);
    }
    return res.json() as Promise<FeeQuote>;
  }

  async submitTransfer(req: TransferRelayRequest): Promise<string> {
    const { txHash } = await postJson<{ txHash: string }>(
      `${this.config.url}/submit/transfer`,
      {
        network: this.config.network,
        poolId: req.poolId,
        tokenType: req.tokenType,
        proofBytes: bytesToHex(req.proofBytes),
        publicInputsBytes: bytesToHex(req.publicInputsBytes),
        nullifiers: bytesToHex(req.nullifiers),
        encryptedNotes: req.encryptedNotes.map(bytesToHex),
      },
    );
    return txHash;
  }

  async submitUnshield(req: UnshieldRelayRequest): Promise<string> {
    const { txHash } = await postJson<{ txHash: string }>(
      `${this.config.url}/submit/unshield`,
      {
        network: this.config.network,
        poolId: req.poolId,
        tokenType: req.tokenType,
        proofBytes: bytesToHex(req.proofBytes),
        publicInputsBytes: bytesToHex(req.publicInputsBytes),
        nullifiers: bytesToHex(req.nullifiers),
        encryptedNotes: req.encryptedNotes.map(bytesToHex),
        recipient: req.recipient,
      },
    );
    return txHash;
  }

  async submitSwap(req: SwapRelayRequest): Promise<string> {
    const { txHash } = await postJson<{ txHash: string }>(
      `${this.config.url}/submit/swap`,
      {
        network: this.config.network,
        poolInId: req.poolInId,
        poolOutId: req.poolOutId,
        deepbookPoolId: req.deepbookPoolId,
        tokenTypeIn: req.tokenTypeIn,
        tokenTypeOut: req.tokenTypeOut,
        isBid: req.isBid,
        proofBytes: bytesToHex(req.proofBytes),
        publicInputsBytes: bytesToHex(req.publicInputsBytes),
        nullifiers: bytesToHex(req.nullifiers),
        encryptedOutputNote: bytesToHex(req.encryptedOutputNote),
        encryptedChangeNote: bytesToHex(req.encryptedChangeNote),
      },
    );
    return txHash;
  }
}
