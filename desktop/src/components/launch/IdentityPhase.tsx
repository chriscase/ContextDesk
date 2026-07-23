/**
 * Identity phase stub (#397): local desk only.
 * Collab (org/account) plugs into onSelected later without reshuffling launch.
 */
import { useEffect } from "react";

export type DeskContext = {
  kind: "local";
  label: string;
};

type Props = {
  onSelected: (ctx: DeskContext) => void;
  /** When true, auto-select immediately (v1 default). */
  auto?: boolean;
};

export function IdentityPhase({ onSelected, auto = true }: Props) {
  useEffect(() => {
    if (auto) {
      onSelected({ kind: "local", label: "Local desk" });
    }
  }, [auto, onSelected]);

  if (auto) {
    return null;
  }

  return (
    <div className="launch-identity">
      <h2 className="launch-identity__title">Choose desk</h2>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => onSelected({ kind: "local", label: "Local desk" })}
      >
        Local desk
      </button>
      <p className="launch-identity__hint">
        Team / org desks will appear here when collaborative features land.
      </p>
    </div>
  );
}
