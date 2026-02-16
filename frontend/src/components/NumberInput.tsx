import { cn } from "@/lib/utils";

interface NumberInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
  onMax?: () => void;
}

export function NumberInput({
  id,
  value,
  onChange,
  placeholder = "0.000000000",
  disabled = false,
  step = 0.000000001,
  min = 0,
  max,
  className,
  onMax,
}: NumberInputProps) {
  const handleIncrement = () => {
    const currentValue = parseFloat(value) || 0;
    const currentSteps = Math.round(currentValue / step);
    const newValue = (currentSteps + 1) * step;
    if (max === undefined || newValue <= max) {
      onChange(newValue.toFixed(9));
    }
  };

  const handleDecrement = () => {
    const currentValue = parseFloat(value) || 0;
    const currentSteps = Math.round(currentValue / step);
    const newValue = Math.max(min, (currentSteps - 1) * step);
    onChange(newValue.toFixed(9));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;

    // If empty, allow it
    if (inputValue === '' || inputValue === '-') {
      onChange(inputValue);
      return;
    }

    // If it contains scientific notation (e or E), convert to decimal
    if (inputValue.includes('e') || inputValue.includes('E')) {
      const num = parseFloat(inputValue);
      if (!isNaN(num)) {
        // Convert to decimal notation, remove trailing zeros
        const formatted = num.toFixed(9).replace(/\.?0+$/, '');
        onChange(formatted);
        return;
      }
    }

    onChange(inputValue);
  };

  return (
    <div className="relative">
      <input
        id={id}
        type="number"
        step="any"
        min={min}
        max={max}
        value={value}
        onChange={handleInputChange}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            handleIncrement();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            handleDecrement();
          }
        }}
        placeholder={placeholder}
        className={cn("input", onMax ? "pr-20" : "pr-12", className)}
        disabled={disabled}
        style={{
          // Hide native spin buttons
          MozAppearance: "textfield",
        }}
      />

      {/* MAX button */}
      {onMax && (
        <button
          type="button"
          onClick={onMax}
          disabled={disabled}
          className="absolute right-12 top-1/2 -translate-y-1/2 text-[10px] font-mono font-bold text-cyber-blue/50 hover:text-cyber-blue disabled:opacity-30 transition-colors"
          aria-label="Set max"
        >
          MAX
        </button>
      )}

      {/* Custom increment/decrement buttons */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-0.5">
        {/* Increment button */}
        <button
          type="button"
          onClick={handleIncrement}
          disabled={disabled || (max !== undefined && parseFloat(value) >= max)}
          className={cn(
            "number-input-btn",
            "group relative w-6 h-4 clip-corner-small",
            "bg-gradient-to-b from-cyber-blue/15 via-cyber-blue/8 to-purple-600/15",
            "border border-cyber-blue/40",
            "hover:from-cyber-blue/30 hover:via-cyber-blue/20 hover:to-purple-600/30",
            "hover:border-cyber-blue/70",
            "hover:shadow-[inset_0_0_8px_rgba(0,217,255,0.4),0_0_12px_rgba(0,217,255,0.5)]",
            "active:from-cyber-blue/50 active:via-cyber-blue/40 active:to-purple-600/50",
            "active:border-cyber-blue/90",
            "active:shadow-[inset_0_0_15px_rgba(0,217,255,0.6),0_0_18px_rgba(0,217,255,0.7),0_0_28px_rgba(0,136,255,0.5),0_0_35px_rgba(157,0,255,0.4)]",
            "active:animate-[spin-button-glow_0.3s_ease-out]",
            "disabled:opacity-30 disabled:cursor-not-allowed",
            "transition-all duration-300"
          )}
          aria-label="Increment"
        >
          <svg
            className="w-3 h-3 mx-auto text-cyber-blue group-hover:text-cyber-blue group-active:brightness-150 transition-all"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="3"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>

        {/* Decrement button */}
        <button
          type="button"
          onClick={handleDecrement}
          disabled={disabled || parseFloat(value) <= min}
          className={cn(
            "number-input-btn",
            "group relative w-6 h-4 clip-corner-small",
            "bg-gradient-to-b from-cyber-blue/15 via-cyber-blue/8 to-purple-600/15",
            "border border-cyber-blue/40",
            "hover:from-cyber-blue/30 hover:via-cyber-blue/20 hover:to-purple-600/30",
            "hover:border-cyber-blue/70",
            "hover:shadow-[inset_0_0_8px_rgba(0,217,255,0.4),0_0_12px_rgba(0,217,255,0.5)]",
            "active:from-cyber-blue/50 active:via-cyber-blue/40 active:to-purple-600/50",
            "active:border-cyber-blue/90",
            "active:shadow-[inset_0_0_15px_rgba(0,217,255,0.6),0_0_18px_rgba(0,217,255,0.7),0_0_28px_rgba(0,136,255,0.5),0_0_35px_rgba(157,0,255,0.4)]",
            "active:animate-[spin-button-glow_0.3s_ease-out]",
            "disabled:opacity-30 disabled:cursor-not-allowed",
            "transition-all duration-300"
          )}
          aria-label="Decrement"
        >
          <svg
            className="w-3 h-3 mx-auto text-cyber-blue group-hover:text-cyber-blue group-active:brightness-150 transition-all"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="3"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
