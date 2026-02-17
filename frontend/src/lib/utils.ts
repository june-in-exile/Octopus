import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { poseidonHash } from "@june_zk/octopus-sdk";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format SUI amount from MIST (1 SUI = 10^9 MIST)
 */
export function formatSui(mist: bigint | number): string {
  // Handle invalid inputs gracefully
  if (mist === undefined || mist === null) {
    return "0";
  }

  // Convert to number safely
  const num = typeof mist === 'bigint' ? Number(mist) : mist;

  // Check for NaN or invalid numbers
  if (isNaN(num) || !isFinite(num)) {
    return "0";
  }

  const sui = num / 1e9;
  return sui.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 9,
  });
}

/**
 * Truncate address for display
 */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

/**
 * Format token amount from base units (e.g. MIST → SUI, base → USDC)
 */
export function formatTokenAmount(amount: bigint | number, decimals: number): string {
  if (amount === undefined || amount === null) return "0";
  const num = typeof amount === "bigint" ? Number(amount) : amount;
  if (isNaN(num) || !isFinite(num)) return "0";
  return (num / 10 ** decimals).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/**
 * Parse token amount string to base units
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error("Invalid token amount");
  }
  return BigInt(Math.floor(parsed * 10 ** decimals));
}

/**
 * Convert BigInt to hex string
 */
export function bigIntToHex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

/**
 * Convert hex string to BigInt
 */
export function hexToBigInt(hex: string): bigint {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  return BigInt("0x" + cleanHex);
}


/**
 * Compute token ID from coin type string
 * Token ID = Poseidon(package_address)
 *
 * Examples:
 * - "0x2::sui::SUI" → Poseidon([0x2])
 * - "0xcde7::usdc::USDC" → Poseidon([0xcde7])
 *
 * @param coinType - Full coin type (e.g., "0x2::sui::SUI")
 * @returns Token ID as bigint
 */
export function getTokenIdFromCoinType(coinType: string): bigint {
  const packageAddr = coinType.split("::")[0];
  return poseidonHash([BigInt(packageAddr)]);
}