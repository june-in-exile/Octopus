import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { loadAllConfigs } from "../config/relayer-config.js";
import { Relayer } from "./relayer.js";
import {
  TransferSubmitSchema,
  UnshieldSubmitSchema,
  SwapSubmitSchema,
} from "./validator.js";

const RELAYER_PORT = parseInt("3001", 10);

async function main(): Promise<void> {
  const configs = loadAllConfigs();
  const relayers = {
    mainnet: new Relayer(configs.mainnet),
    testnet: new Relayer(configs.testnet),
  };

  const app = express();
  app.use(express.json());
  app.use(helmet());
  app.use(cors());

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

  // GET /relayer-info
  app.get("/relayer-info", infoLimiter, (_req, res) => {
    res.json({
      mainnet: {
        address: relayers.mainnet.address,
        feePremium: configs.mainnet.feePremium,
        supportedTokens: configs.mainnet.supportedTokens,
        uptime: relayers.mainnet.uptime,
      },
      testnet: {
        address: relayers.testnet.address,
        feePremium: configs.testnet.feePremium,
        supportedTokens: configs.testnet.supportedTokens,
        uptime: relayers.testnet.uptime,
      },
    });
  });

  // GET /fee-quote?network=mainnet|testnet
  app.get("/fee-quote", infoLimiter, (req, res) => {
    const network = req.query.network as string;
    if (network !== "mainnet" && network !== "testnet") {
      res.status(400).json({ error: "Query param network must be 'mainnet' or 'testnet'" });
      return;
    }
    const config = configs[network];
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
    try {
      const txHash = await relayers[parsed.data.network].submitTransfer(parsed.data);
      res.json({ txHash });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Submission failed" });
    }
  });

  // POST /submit/unshield
  app.post("/submit/unshield", submitLimiter, async (req, res) => {
    const parsed = UnshieldSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const txHash = await relayers[parsed.data.network].submitUnshield(parsed.data);
      res.json({ txHash });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Submission failed" });
    }
  });

  // POST /submit/swap
  app.post("/submit/swap", submitLimiter, async (req, res) => {
    const parsed = SwapSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const txHash = await relayers[parsed.data.network].submitSwap(parsed.data);
      res.json({ txHash });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Submission failed" });
    }
  });

  app.listen(RELAYER_PORT, () => {
    console.log(`Relayer running on port ${RELAYER_PORT}`);
    console.log(`Mainnet relayer address: ${relayers.mainnet.address}`);
    console.log(`Testnet relayer address: ${relayers.testnet.address}`);
  });
}

main().catch((err) => {
  console.error("Failed to start relayer:", err);
  process.exit(1);
});
