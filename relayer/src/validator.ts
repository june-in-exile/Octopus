import { z } from "zod";

const hexString = z
  .string()
  .min(2)
  .regex(/^[0-9a-fA-F]+$/, "Must be a non-empty hex string")
  .refine((s) => s.length % 2 === 0, "Hex string must have even length");

const network = z.enum(["mainnet", "testnet"]);

// Transfer: proofBytes, publicInputsBytes, nullifiers (BCS-encoded vec<vec<u8>>),
// and encryptedNotes are all hex-encoded byte arrays.
export const TransferSubmitSchema = z.object({
  network,
  poolId: z.string().min(1),
  tokenType: z.string().min(1),
  proofBytes: hexString,
  publicInputsBytes: hexString,
  // BCS-encoded vector<vector<u8>> — pre-encoded by the SDK prover
  nullifiers: hexString,
  encryptedNotes: z.array(hexString).min(1).max(2),
});

// Unshield extends transfer with a recipient address
export const UnshieldSubmitSchema = TransferSubmitSchema.extend({
  recipient: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  // For unshield, encryptedNotes[0] is the encrypted change note
});

// Swap requires separate pool IDs for in/out tokens plus a DeepBook pool
export const SwapSubmitSchema = z.object({
  network,
  poolInId: z.string().min(1),
  poolOutId: z.string().min(1),
  deepbookPoolId: z.string().min(1),
  tokenTypeIn: z.string().min(1),
  tokenTypeOut: z.string().min(1),
  // isBid=true: quote→base (swap_bid), isBid=false: base→quote (swap)
  isBid: z.boolean(),
  proofBytes: hexString,
  publicInputsBytes: hexString,
  nullifiers: hexString,
  encryptedOutputNote: hexString,
  encryptedChangeNote: hexString,
});

export type TransferSubmitRequest = z.infer<typeof TransferSubmitSchema>;
export type UnshieldSubmitRequest = z.infer<typeof UnshieldSubmitSchema>;
export type SwapSubmitRequest = z.infer<typeof SwapSubmitSchema>;
