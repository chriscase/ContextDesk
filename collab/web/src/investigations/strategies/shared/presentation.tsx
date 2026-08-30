import type { ReactNode, Ref } from "react";

function classes(...values: readonly (string | undefined | false)[]): string {
  return values.filter(Boolean).join(" ");
}

interface StrategySurfaceProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly labelledBy?: string;
}

/** A strategy-owned page surface with no data, navigation, or focus policy. */
export function StrategySurface({ children, className, labelledBy }: StrategySurfaceProps) {
  return (
    <div className={classes("strategy-kit", className)} aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}

interface StrategyHeroProps {
  readonly eyebrow?: string;
  readonly title: string;
  readonly titleId: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly headingTabIndex?: number;
}

/** The stable orientation header shared by strategy collection and detail views. */
export function StrategyHero({
  eyebrow,
  title,
  titleId,
  description,
  actions,
  headingRef,
  headingTabIndex,
}: StrategyHeroProps) {
  return (
    <header className="strategy-kit__hero">
      <div className="strategy-kit__hero-copy">
        {eyebrow ? <p className="strategy-kit__eyebrow">{eyebrow}</p> : null}
        <h2 id={titleId} ref={headingRef} tabIndex={headingTabIndex}>{title}</h2>
        {description ? <div className="strategy-kit__description">{description}</div> : null}
      </div>
      {actions ? <div className="strategy-kit__hero-actions">{actions}</div> : null}
    </header>
  );
}

interface StrategyPanelProps {
  readonly children: ReactNode;
  readonly title: string;
  readonly titleId: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly busy?: boolean;
}

/** A labelled visual region. Callers retain all domain and interaction ownership. */
export function StrategyPanel({
  children,
  title,
  titleId,
  description,
  actions,
  className,
  busy,
}: StrategyPanelProps) {
  return (
    <section
      className={classes("strategy-kit__panel", className)}
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <div className="strategy-kit__panel-heading">
        <div>
          <h3 id={titleId}>{title}</h3>
          {description ? <div className="strategy-kit__panel-description">{description}</div> : null}
        </div>
        {actions ? <div className="strategy-kit__panel-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

type NoticeTone = "neutral" | "warning" | "danger" | "success";

interface StrategyStateNoticeProps {
  readonly children: ReactNode;
  readonly title?: string;
  readonly tone?: NoticeTone;
  readonly role?: "status" | "alert";
  readonly busy?: boolean;
  readonly action?: ReactNode;
}

/** A truthful loading, empty, stale, denied, or error message. */
export function StrategyStateNotice({
  children,
  title,
  tone = "neutral",
  role = "status",
  busy,
  action,
}: StrategyStateNoticeProps) {
  return (
    <div
      className={`strategy-kit__notice strategy-kit__notice--${tone}`}
      aria-busy={busy}
    >
      <div role={role}>
        {title ? <strong className="strategy-kit__notice-title">{title}</strong> : null}
        <div className="strategy-kit__notice-copy">{children}</div>
      </div>
      {action ? <div className="strategy-kit__notice-action">{action}</div> : null}
    </div>
  );
}

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

interface StrategyBadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
}

/** A compact recorded-value label; it never derives or judges a workflow state. */
export function StrategyBadge({ children, tone = "neutral" }: StrategyBadgeProps) {
  return <span className={`strategy-kit__badge strategy-kit__badge--${tone}`}>{children}</span>;
}

interface StrategyActionRowProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/** A wrapping layout for caller-owned native controls. */
export function StrategyActionRow({ children, className }: StrategyActionRowProps) {
  return <div className={classes("strategy-kit__actions", className)}>{children}</div>;
}
