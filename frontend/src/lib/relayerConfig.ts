export const RELAYER_URLS: Record<string, string | null> = {
  testnet: process.env.NEXT_PUBLIC_TESTNET_RELAYER_URL || null,
  mainnet: process.env.NEXT_PUBLIC_MAINNET_RELAYER_URL || null,
};

const DEFAULT_LOCAL_RELAYER = "http://localhost:8080";

export function getDefaultRelayerUrl(network: string): string | null {
  return RELAYER_URLS[network] ?? null;
}

export function getRelayerUrl(network: string): string | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(`relayer_url_${network}`);
  if (stored) return stored;
  return getDefaultRelayerUrl(network);
}

export function saveRelayerUrl(network: string, url: string): void {
  localStorage.setItem(`relayer_url_${network}`, url);
}

export function getRelayerEnabled(network: string): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(`relayer_enabled_${network}`) === "true";
}

export function saveRelayerEnabled(network: string, enabled: boolean): void {
  localStorage.setItem(`relayer_enabled_${network}`, String(enabled));
}

export { DEFAULT_LOCAL_RELAYER };
