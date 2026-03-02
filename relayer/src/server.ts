import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { loadAllConfigs } from "../config/relayer-config.js";
import type { Network } from "../config/relayer-config.js";
import { Relayer } from "./relayer.js";
import {
  TransferSubmitSchema,
  UnshieldSubmitSchema,
  SwapSubmitSchema,
} from "./validator.js";

// Standard PORT env var for cloud platforms, then PORT, finally default to 8080
const PORT = parseInt(process.env.PORT || "8080", 10)

async function main(): Promise<void> {
  const configs = loadAllConfigs();
  const relayers: Partial<Record<Network, Relayer>> = {};
  for (const [network, config] of Object.entries(configs) as [Network, (typeof configs)[Network]][]) {
    if (config) relayers[network] = new Relayer(config);
  }

  const app = express();
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim());

  app.use(express.json());
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          return callback(null, process.env.NODE_ENV !== "production");
        }
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        callback(new Error(`CORS: origin ${origin} not allowed`));
      },
    })
  );

  // Rate limiters
  const submitLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });

  const infoLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // GET /health
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // GET /relayer-info
  app.get("/relayer-info", infoLimiter, (_req, res) => {
    const info: Record<string, unknown> = {};
    for (const [network, relayer] of Object.entries(relayers) as [Network, Relayer][]) {
      const config = configs[network];
      if (relayer && config) {
        info[network] = {
          address: relayer.address,
          feePremium: config.feePremium,
          supportedTokens: config.supportedTokens,
          uptime: relayer.uptime,
        };
      }
    }
    res.json(info);
  });

  // GET /fee-quote?network=mainnet|testnet
  app.get("/fee-quote", infoLimiter, (req, res) => {
    const network = req.query.network as string;
    if (network !== "mainnet" && network !== "testnet") {
      res.status(400).json({ error: "Query param network must be 'mainnet' or 'testnet'" });
      return;
    }
    const config = configs[network];
    if (!config) {
      res.status(503).json({ error: `${network} is not configured on this relayer` });
      return;
    }
    res.json({
      network,
      baseFee: 0,
      feePremium: config.feePremium,
      totalFee: 0,
      expiresAt: Date.now() + 60_000,
    });
  });

  // POST /submit/transfer
  app.post("/submit/transfer", submitLimiter, async (req, res) => {
    const parsed = TransferSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const relayer = relayers[parsed.data.network];
    if (!relayer) {
      res.status(503).json({ error: `${parsed.data.network} is not configured on this relayer` });
      return;
    }
    try {
      const txHash = await relayer.submitTransfer(parsed.data);
      res.json({ txHash });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Submission failed";
      console.error("[transfer] Submission error:", err);
      res.status(500).json({ error: message });
    }
  });

  // POST /submit/unshield
  app.post("/submit/unshield", submitLimiter, async (req, res) => {
    const parsed = UnshieldSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const relayer = relayers[parsed.data.network];
    if (!relayer) {
      res.status(503).json({ error: `${parsed.data.network} is not configured on this relayer` });
      return;
    }
    try {
      const txHash = await relayer.submitUnshield(parsed.data);
      res.json({ txHash });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Submission failed";
      console.error("[unshield] Submission error:", err);
      res.status(500).json({ error: message });
    }
  });

  // POST /submit/swap
  app.post("/submit/swap", submitLimiter, async (req, res) => {
    const parsed = SwapSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const relayer = relayers[parsed.data.network];
    if (!relayer) {
      res.status(503).json({ error: `${parsed.data.network} is not configured on this relayer` });
      return;
    }
    try {
      const txHash = await relayer.submitSwap(parsed.data);
      res.json({ txHash });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Submission failed";
      console.error("[swap] Submission error:", err);
      res.status(500).json({ error: message });
    }
  });

  const activeNetworks = Object.keys(relayers).join(", ");
  app.listen(PORT, () => {
    console.log(`Relayer running on port ${PORT}`);
    console.log(`Active networks: ${activeNetworks}`);
    for (const [network, relayer] of Object.entries(relayers) as [Network, Relayer][]) {
      console.log(`  ${network} relayer address: ${relayer.address}`);
    }
  });
}

main().catch((err) => {
  console.error("Failed to start relayer:", err);
  process.exit(1);
});