import type { ReactNode } from "react";
import type { StageId } from "./Cases.js";

/**
 * Shared visual language for the War Room shell: the brand mark, the stage
 * iconography, the Capture → Analyze → Compare → Decide flow figure, and the
 * empty-state illustrations.
 *
 * Everything here is repo-native inline SVG drawn in `currentColor` (plus CSS
 * variables via class hooks) so all six theme skins — and Windows forced-colors
 * mode — recolor the artwork without per-theme assets. Every SVG is decorative:
 * `aria-hidden` with no text nodes, so it never changes an accessible name or
 * a `textContent` assertion. The same geometry is meant to be liftable into the
 * desktop GUI, which shares the token names.
 */

interface DecorativeSvgProps {
  size?: number;
  className?: string;
}

function decorativeProps(props: DecorativeSvgProps, fallbackSize: number, baseClass: string) {
  const size = props.size ?? fallbackSize;
  return {
    width: size,
    height: size,
    "aria-hidden": true as const,
    focusable: "false" as const,
    role: "presentation" as const,
    className: props.className ? `${baseClass} ${props.className}` : baseClass,
  };
}

/**
 * The ContextDesk War Room mark: an operations ring — bearing ticks, a sweep
 * quadrant, and a plotted point. Reads down to 16px, inherits `currentColor`
 * for the ring, and takes the theme accent for the plotted point via CSS.
 */
export function BrandMark(props: DecorativeSvgProps = {}) {
  return (
    <svg viewBox="0 0 24 24" {...decorativeProps(props, 26, "brand-mark")}>
      <circle
        cx="12"
        cy="12"
        r="8.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M12 1.6v2.6" />
        <path d="M12 19.8v2.6" />
        <path d="M1.6 12h2.6" />
        <path d="M19.8 12h2.6" />
      </g>
      <path
        className="brand-mark__sweep"
        d="M12 12 L12 5.6 A6.4 6.4 0 0 1 18.4 12 Z"
        fill="currentColor"
        opacity="0.28"
      />
      <circle className="brand-mark__point" cx="12" cy="12" r="2.5" fill="currentColor" />
    </svg>
  );
}

const STAGE_ICON_PATHS: Record<StageId, ReactNode> = {
  situation: (
    <>
      <circle cx="12" cy="12" r="7" fill="none" />
      <path d="M12 2.8v2.4" />
      <path d="M12 18.8v2.4" />
      <path d="M2.8 12h2.4" />
      <path d="M18.8 12h2.4" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  capture: (
    <>
      <path d="M4.5 14.5v3A1.8 1.8 0 0 0 6.3 19.3h11.4a1.8 1.8 0 0 0 1.8-1.8v-3" fill="none" />
      <path d="M12 4.2v9.2" />
      <path d="m8.4 10.2 3.6 3.6 3.6-3.6" fill="none" />
    </>
  ),
  analyze: (
    <>
      <circle cx="10.6" cy="10.6" r="5.9" fill="none" />
      <path d="m15.1 15.1 4.7 4.7" />
      <path d="M8 10.6h5.2" />
    </>
  ),
  compare: (
    <>
      <rect x="3.6" y="5" width="6.8" height="14" rx="1.6" fill="none" />
      <rect x="13.6" y="5" width="6.8" height="14" rx="1.6" fill="none" />
      <path d="M6.2 9h1.6" />
      <path d="M6.2 12h1.6" />
      <path d="M16.2 9h1.6" />
      <path d="M16.2 15h1.6" />
    </>
  ),
  decide: (
    <>
      <circle cx="12" cy="12" r="8" fill="none" />
      <path d="m8.3 12.4 2.6 2.6 4.9-5.2" fill="none" />
    </>
  ),
};

/** Stage glyphs for the investigation stepper and the flow figure. */
export function StageIcon(props: { stage: StageId } & DecorativeSvgProps) {
  const { stage, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      {...decorativeProps(rest, 18, "stage-icon")}
      data-stage={stage}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {STAGE_ICON_PATHS[stage]}
    </svg>
  );
}

/**
 * The workflow spine, in product language. Situation is deliberately not a
 * step here: it is the shared picture the four working stages orbit, and the
 * figure caption says so.
 */
export const STAGE_FLOW_STEPS: readonly {
  stage: Exclude<StageId, "situation">;
  name: string;
  kicker: string;
  human?: boolean;
}[] = [
  { stage: "capture", name: "Capture", kicker: "evidence in, with provenance" },
  { stage: "analyze", name: "Analyze", kicker: "frozen snapshots & AI lanes" },
  { stage: "compare", name: "Compare", kicker: "lanes on the same evidence" },
  { stage: "decide", name: "Decide", kicker: "a person makes the call", human: true },
];

function FlowArrow() {
  return (
    <span className="stage-flow__arrow" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        aria-hidden="true"
        focusable="false"
        role="presentation"
      >
        <path
          d="M4 12h14m0 0-5-5m5 5-5 5"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * The Capture. Analyze. Compare. Decide. figure used by the Overview
 * onboarding hero. Real list semantics — no text is trapped in artwork — so
 * screen readers, find-in-page, translation, and 200% text all keep working.
 */
export function StageFlowDiagram(props: { caption?: string }) {
  return (
    <figure className="stage-flow" aria-label="How an investigation flows">
      <ol className="stage-flow__steps" aria-label="Capture to Decide stages">
        {STAGE_FLOW_STEPS.map((step, index) => (
          <li className="stage-flow__step" key={step.stage}>
            {index > 0 ? <FlowArrow /> : null}
            <span
              className={
                step.human ? "stage-flow__card stage-flow__card--human" : "stage-flow__card"
              }
              data-stage={step.stage}
            >
              <span className="stage-flow__badge" aria-hidden="true">
                <StageIcon stage={step.stage} size={20} />
              </span>
              <span className="stage-flow__text">
                <span className="stage-flow__name">{step.name}</span>
                <span className="stage-flow__kicker">{step.kicker}</span>
              </span>
            </span>
          </li>
        ))}
      </ol>
      {props.caption ? (
        <figcaption className="stage-flow__caption">{props.caption}</figcaption>
      ) : null}
    </figure>
  );
}

export type EmptyArt = "investigations" | "activity" | "clear" | "search" | "locked" | "shield";

const EMPTY_ART: Record<EmptyArt, ReactNode> = {
  // A dossier: two parked folders behind the active one, accent bookmark.
  investigations: (
    <>
      <path className="empty-art__faint" d="M30 26h14l4 5h24a3 3 0 0 1 3 3v3" fill="none" />
      <path className="empty-art__faint" d="M25 34h14l4 5h28a3 3 0 0 1 3 3v3" fill="none" />
      <path
        d="M20 44a3 3 0 0 1 3-3h15l4.4 5.4H97a3 3 0 0 1 3 3V72a3 3 0 0 1-3 3H23a3 3 0 0 1-3-3Z"
        fill="none"
      />
      <path className="empty-art__accent" d="M84 41v12l5-4 5 4V41" fill="none" />
    </>
  ),
  // A calm activity trace: flat, one gentle heartbeat, then flat to a point.
  activity: (
    <>
      <path
        d="M14 52h24l6-14 8 26 7-12h43"
        fill="none"
      />
      <circle className="empty-art__accent-dot" cx="104" cy="52" r="4" stroke="none" />
    </>
  ),
  // All clear: a check inside a ring with quiet radiating arcs.
  clear: (
    <>
      <circle cx="60" cy="46" r="20" fill="none" />
      <path d="m51.5 46.5 6 6 11.5-12" fill="none" />
      <path className="empty-art__faint" d="M31 30a34 34 0 0 0-5 16" fill="none" />
      <path className="empty-art__faint" d="M89 30a34 34 0 0 1 5 16" fill="none" />
      <circle className="empty-art__accent-dot" cx="60" cy="16" r="3" stroke="none" />
    </>
  ),
  // No match: a magnifier over an empty, dashed record card.
  search: (
    <>
      <rect
        className="empty-art__faint"
        x="20"
        y="26"
        width="60"
        height="40"
        rx="4"
        strokeDasharray="6 5"
        fill="none"
      />
      <path className="empty-art__faint" d="M30 38h28" />
      <path className="empty-art__faint" d="M30 47h20" />
      <circle cx="78" cy="52" r="14" fill="none" />
      <path d="m88.5 62.5 11 11" />
      <path className="empty-art__accent" d="M72 52h12" fill="none" />
    </>
  ),
  // Steady state: a watch shield with a level line, nothing flaring.
  shield: (
    <>
      <path
        d="M60 18l26 9v20c0 15.5-10.4 27-26 33-15.6-6-26-17.5-26-33V27Z"
        fill="none"
      />
      <path className="empty-art__accent" d="M48 47h24" fill="none" />
      <path className="empty-art__faint" d="M48 56h16" />
      <path className="empty-art__faint" d="M48 38h24" />
    </>
  ),
  // Unavailable: a record card, sealed.
  locked: (
    <>
      <rect x="26" y="24" width="68" height="46" rx="4" fill="none" />
      <path className="empty-art__faint" d="M36 36h24" />
      <path className="empty-art__faint" d="M36 45h16" />
      <rect x="66" y="46" width="20" height="16" rx="3" fill="none" />
      <path className="empty-art__accent" d="M70 46v-5a6 6 0 0 1 12 0v5" fill="none" />
    </>
  ),
};

function EmptyStateArt(props: { art: EmptyArt }) {
  return (
    <svg
      viewBox="0 0 120 88"
      width="120"
      height="88"
      aria-hidden="true"
      focusable="false"
      role="presentation"
      className="empty-art"
      data-art={props.art}
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {EMPTY_ART[props.art]}
    </svg>
  );
}

/**
 * A quiet, illustrated empty state. The children carry the exact recorded-state
 * wording the surface already used — the illustration is presentation only and
 * adds nothing a screen reader would announce.
 */
export function EmptyState(props: {
  art: EmptyArt;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={props.className ? `empty-state ${props.className}` : "empty-state"}>
      <EmptyStateArt art={props.art} />
      <div className="empty-state__body">{props.children}</div>
    </div>
  );
}
