import { useEffect, useState } from "react";

type Props = {
  /** Epoch ms when the wait started. */
  startedAt: number;
  /** Optional model label for context. */
  model?: string | null;
  /** True once the first token has arrived (softer “streaming” mode). */
  hasTokens?: boolean;
};

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function phaseLabel(ms: number, hasTokens: boolean): string {
  if (hasTokens) return "Writing";
  if (ms < 1200) return "Thinking";
  if (ms < 5000) return "Working";
  if (ms < 15000) return "Still working";
  return "Taking longer than usual";
}

export function ThinkingIndicator({
  startedAt,
  model,
  hasTokens = false,
}: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = Math.max(0, now - startedAt);
  const label = phaseLabel(elapsed, hasTokens);

  return (
    <div
      className="thinking-ind"
      data-has-tokens={hasTokens ? "true" : "false"}
      role="status"
      aria-live="polite"
    >
      <span className="thinking-ind__orb" aria-hidden>
        <span className="thinking-ind__orb-core" />
      </span>
      <div className="thinking-ind__copy">
        <span className="thinking-ind__label">{label}</span>
        {model ? (
          <span className="thinking-ind__model" title="Active model">
            {model}
          </span>
        ) : null}
      </div>
      <span className="thinking-ind__time" title="Time waiting for response">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
