/**
 * Animated splash (vendored NexaCore pattern) — ContextDesk branding.
 * enter → hold → exit; always completes (timeout safety).
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  markSplashCompleted,
  resolveSplashDuration,
  SPLASH_STORAGE_KEY,
} from "./splashDuration";
import "./SplashScreen.css";

export type SplashScreenProps = {
  onComplete: () => void;
  duration?: number;
  icon: ReactNode;
  title: ReactNode;
  tagline: string;
  company?: string;
  storageKey?: string;
  accentColor?: string;
};

type Phase = "enter" | "hold" | "exit";

export function SplashScreen({
  onComplete,
  duration,
  icon,
  title,
  tagline,
  company = "Open source",
  storageKey = SPLASH_STORAGE_KEY,
  accentColor = "#4a9eff",
}: SplashScreenProps) {
  const effectiveDuration = resolveSplashDuration(storageKey, localStorage, duration);
  const [phase, setPhase] = useState<Phase>("enter");
  const done = useRef(false);

  useEffect(() => {
    const finish = () => {
      if (done.current) return;
      done.current = true;
      markSplashCompleted(storageKey);
      onComplete();
    };

    const fadeTime = Math.min(900, Math.max(200, effectiveDuration / 4));
    const holdDuration = Math.max(200, effectiveDuration - fadeTime * 2);

    const enterTimer = window.setTimeout(() => setPhase("hold"), fadeTime);
    const exitTimer = window.setTimeout(
      () => setPhase("exit"),
      fadeTime + holdDuration,
    );
    const completeTimer = window.setTimeout(finish, effectiveDuration);
    // Hard ceiling so launch cannot hang forever if timers misbehave.
    const safety = window.setTimeout(finish, effectiveDuration + 2000);

    return () => {
      window.clearTimeout(enterTimer);
      window.clearTimeout(exitTimer);
      window.clearTimeout(completeTimer);
      window.clearTimeout(safety);
    };
  }, [onComplete, effectiveDuration, storageKey]);

  const style = { "--splash-accent": accentColor } as CSSProperties;

  return (
    <div
      className={`splash-screen splash-screen--${phase}`}
      style={style}
      role="status"
      aria-live="polite"
      aria-label="Starting ContextDesk"
    >
      <div className="splash-content">
        <div className="splash-icon">{icon}</div>
        <div className="splash-title">{title}</div>
        {company ? <div className="splash-company">{company}</div> : null}
        <div className="splash-tagline">{tagline}</div>
      </div>
    </div>
  );
}

export default SplashScreen;
