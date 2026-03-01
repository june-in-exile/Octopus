import { formatTokenAmount } from "@/lib/utils";

interface NoteBalanceDisplayProps {
  loading: boolean;
  noteCount: number;
  total: bigint;
  decimals: number;
  tokenSymbol?: string;
}

export function NoteBalanceDisplay({
  loading,
  noteCount,
  total,
  decimals,
  tokenSymbol = "tokens",
}: NoteBalanceDisplayProps) {
  return (
    <p className="mt-2 text-[10px] text-gray-500 font-mono">
      {loading ? (
        <>LOADING NOTES...</>
      ) : noteCount > 0 ? (
        <>
          TOTAL: {formatTokenAmount(total, decimals)} {tokenSymbol}
          {noteCount > 1 && (
            <span className="text-gray-600"> // {noteCount} NOTES</span>
          )}
        </>
      ) : (
        <>NO NOTES // Shield {tokenSymbol} first</>
      )}
    </p>
  );
}
