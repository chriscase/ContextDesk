/**
 * Origin badge: glyph + text label together, never colour alone.
 *
 * The text label is the primary signal, so the badge is fully legible in
 * grayscale and to a colourblind reader; the glyph is a redundant second
 * signal and the stylesheet's colour a redundant third. `data-work` carries
 * the deterministic / nondeterministic split for styling and for tests.
 */
import { originMeta } from "../../lib/activity/originMeta";
import type { ActivityOrigin } from "../../lib/activity/types";

export function ActivityOriginBadge({
  origin,
  showWorkClass = false,
}: {
  origin: ActivityOrigin;
  /**
   * Also spell out "Deterministic work" / "Model / external work". Used in
   * detail views where the coarse split matters more than the exact origin.
   */
  showWorkClass?: boolean;
}) {
  const meta = originMeta(origin);
  return (
    <span
      className="activity-badge"
      data-origin={origin}
      data-work={meta.work}
      data-testid={`activity-badge-${origin}`}
      title={`${meta.description} (${meta.workLabel})`}
    >
      <span className="activity-badge__glyph" aria-hidden="true">
        {meta.glyph}
      </span>
      <span className="activity-badge__label">{meta.label}</span>
      {showWorkClass ? (
        <span className="activity-badge__work">{meta.workLabel}</span>
      ) : null}
    </span>
  );
}
