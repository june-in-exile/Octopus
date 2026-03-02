"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  getRelayerEnabled,
  getRelayerUrl,
  saveRelayerEnabled,
  saveRelayerUrl,
  getDefaultRelayerUrl,
  DEFAULT_LOCAL_RELAYER,
} from "@/lib/relayerConfig";
import { RelayerClient } from "@june_zk/octopus-sdk";

export type RelayerStatus = "idle" | "checking" | "online" | "offline";

interface RelayerSelectorProps {
  network: string;
  disabled?: boolean;
  onToggle: (enabled: boolean, url: string | null, status: RelayerStatus) => void;
}

export function RelayerSelector({
  network,
  disabled,
  onToggle,
}: RelayerSelectorProps) {
  const [enabled, setEnabled] = useState(false);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_LOCAL_RELAYER);
  const [url, setUrl] = useState(DEFAULT_LOCAL_RELAYER);
  const [status, setStatus] = useState<RelayerStatus>("idle");
  const [relayerAddress, setRelayerAddress] = useState<string | null>(null);

  // Load saved preferences on mount
  useEffect(() => {
    const savedEnabled = getRelayerEnabled(network);
    const savedUrl = getRelayerUrl(network) ?? getDefaultRelayerUrl(network) ?? DEFAULT_LOCAL_RELAYER;
    setEnabled(savedEnabled);
    setUrl(savedUrl);
    setDraftUrl(savedUrl);
    if (savedEnabled) {
      onToggle(true, savedUrl, "checking");
    }
  }, [network, onToggle]);

  // Debounce URL changes: save to localStorage and notify parent 500ms after typing stops
  useEffect(() => {
    const timer = setTimeout(() => {
      setUrl(draftUrl);
      saveRelayerUrl(network, draftUrl);
      if (enabled) onToggle(true, draftUrl, "checking");
    }, 500);
    return () => clearTimeout(timer);
  }, [draftUrl, network, enabled, onToggle]);

  const checkRelayerStatus = useCallback(async (relayerUrl: string) => {
    setStatus("checking");
    setRelayerAddress(null);
    try {
      const client = new RelayerClient({ url: relayerUrl, network: network as "mainnet" | "testnet" });
      const info = await client.getRelayerInfo();
      setStatus("online");
      setRelayerAddress(info.address);
    } catch {
      setStatus("offline");
    }
  }, [network]);

  // Check status when enabled or URL changes
  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      setRelayerAddress(null);
      return;
    }
    checkRelayerStatus(url);
  }, [enabled, url, checkRelayerStatus]);

  // Notify parent whenever status changes while enabled
  useEffect(() => {
    if (enabled) {
      onToggle(true, url, status);
    }
  }, [enabled, url, status, onToggle]);

  const handleToggle = (checked: boolean) => {
    setEnabled(checked);
    saveRelayerEnabled(network, checked);
    onToggle(checked, checked ? url : null, checked ? status : "idle");
  };

  const handleUrlChange = (newUrl: string) => setDraftUrl(newUrl);

  return (
    <div className={cn(
      "p-3 border clip-corner",
      enabled ? "border-cyber-blue/40 bg-cyber-blue/5" : "border-gray-700/50 bg-black/20"
    )}>
      {/* Toggle row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
            Via Relayer
          </span>
          <span className={cn(
            "text-[10px] font-mono px-1.5 py-0.5 border",
            status === "online"
              ? "text-green-400 border-green-600/40 bg-green-900/20"
              : status === "checking"
                ? "text-yellow-400 border-yellow-600/40 bg-yellow-900/20"
                : status === "offline"
                  ? "text-red-400 border-red-600/40 bg-red-900/20"
                  : "text-gray-500 border-gray-700/40 bg-transparent"
          )}>
            {status === "online" ? "ONLINE" : status === "checking" ? "CHECKING..." : status === "offline" ? "OFFLINE" : "OFF"}
          </span>
        </div>

        {/* Toggle switch */}
        <button
          type="button"
          onClick={() => handleToggle(!enabled)}
          disabled={disabled}
          className={cn(
            "relative w-9 h-5 rounded-none border transition-colors duration-150 focus:outline-none",
            enabled ? "border-cyber-blue bg-cyber-blue/20" : "border-gray-600 bg-transparent",
            disabled && "opacity-50 cursor-not-allowed"
          )}
          aria-label={enabled ? "Disable relayer" : "Enable relayer"}
        >
          <span className={cn(
            "absolute top-0.5 h-3.5 w-3.5 border transition-all duration-150",
            enabled ? "left-4 border-cyber-blue bg-cyber-blue" : "left-0.5 border-gray-500 bg-gray-500"
          )} />
        </button>
      </div>

      {/* Relayer URL input (visible when enabled) */}
      {enabled && (
        <div className="mt-3 space-y-2">
          <input
            type="url"
            value={draftUrl}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder={DEFAULT_LOCAL_RELAYER}
            className="input w-full text-[11px]"
            disabled={disabled}
          />
          {relayerAddress && (
            <p className="text-[10px] text-gray-500 font-mono">
              <span className="text-gray-600">ADDR:</span>{" "}
              <a
                href={`https://${network === "testnet" ? "testnet." : ""}suivision.xyz/account/${relayerAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyber-blue hover:underline"
              >
                {relayerAddress.slice(0, 10)}...{relayerAddress.slice(-6)}
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
