"use client";

import type { OwnedNote } from "@/hooks/useNotes";
import type { TokenConfig } from "@/lib/constants";
import { formatTokenAmount } from "@/lib/utils";

interface AvailableNotesListProps {
  notes: OwnedNote[];
  loading: boolean;
  error: string | null;
  tokenConfig: TokenConfig;
  lastScanStats?: {
    eventsScanned: number;
    notesDecrypted: number;
    timestamp: number;
  } | null;
}

export function AvailableNotesList({ notes, loading, error, tokenConfig, lastScanStats }: AvailableNotesListProps) {
  const unspentNotes = notes.filter((n) => !n.spent);

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
          <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
            Available Notes (UTXO)
          </h2>
        </div>
        <div className="p-4 border border-cyber-blue/30 bg-cyber-blue/10 clip-corner">
          <div className="flex items-center gap-3">
            <svg
              className="h-4 w-4 animate-spin text-cyber-blue"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <p className="text-[10px] text-gray-400 font-mono">Loading notes from pool...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
          <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
            Available Notes (UTXO)
          </h2>
        </div>
        <div className="p-4 border border-red-600/30 bg-red-900/20 clip-corner">
          <p className="text-xs font-bold uppercase tracking-wider text-red-400 mb-2 font-mono">
            Error Loading Notes
          </p>
          <p className="text-[10px] text-red-400 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  if (unspentNotes.length === 0) {
    return (
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
          <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
            Available Notes (UTXO)
          </h2>
        </div>
        <div className="p-4 border border-gray-800 bg-black/30 clip-corner">
          <p className="text-xs font-bold uppercase tracking-wider text-yellow-500 mb-2 font-mono">
            No Notes Available
          </p>
          <p className="text-[10px] text-gray-400 font-mono mb-3">
            Shield some tokens first to create notes.
          </p>
          {lastScanStats && lastScanStats.eventsScanned > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-800">
              <p className="text-[10px] text-gray-500 font-mono mb-1">
                🔍 Scan Results:
              </p>
              <p className="text-[10px] text-gray-400 font-mono">
                • Found {lastScanStats.eventsScanned} event{lastScanStats.eventsScanned !== 1 ? 's' : ''} on blockchain
              </p>
              <p className="text-[10px] text-gray-400 font-mono">
                • Decrypted {lastScanStats.notesDecrypted} note{lastScanStats.notesDecrypted !== 1 ? 's' : ''} with your keypair
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Sort notes by value (largest first) and show ALL notes
  const sortedNotes = [...unspentNotes].sort((a, b) => {
    return Number(b.note.amount - a.note.amount);
  });

  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-1 h-6 bg-gradient-to-b from-cyber-blue to-transparent" />
        <h2 className="text-xl font-black uppercase tracking-wider text-cyber-blue">
          Available Notes (UTXO)
        </h2>
        <span className="ml-auto text-xs text-gray-500 font-mono">
          {sortedNotes.length} NOTE{sortedNotes.length !== 1 ? 'S' : ''}
        </span>
      </div>
      <div className="p-4 border border-cyber-blue/30 bg-cyber-blue/10 clip-corner">
        <div className="space-y-1.5 text-[10px] text-gray-300 max-h-64 overflow-y-auto">
          {sortedNotes.map((note, i) => (
            <div key={i} className="flex justify-between font-mono p-1.5 bg-black/30 clip-corner">
              <span className="text-gray-500">NOTE #{(i + 1).toString().padStart(2, '0')}:</span>
              <span className="text-cyber-blue">{formatTokenAmount(note.displayAmount ?? note.note.amount, tokenConfig.decimals)} {tokenConfig.symbol}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-cyber-blue/20">
          <p className="text-[10px] text-gray-400 font-mono flex items-start gap-2">
            <span className="text-cyber-blue">ℹ</span>
            <span>Notes are automatically selected to cover transaction amounts.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
