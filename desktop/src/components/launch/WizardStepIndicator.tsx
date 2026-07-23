/** Thin step rail for pre-launch (NexaDeck-inspired). */

export type LaunchStepId = "workspace" | "ai" | "ready";

const STEPS: { id: LaunchStepId; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "ai", label: "AI" },
  { id: "ready", label: "Ready" },
];

type Props = {
  active: LaunchStepId;
  completed?: LaunchStepId[];
};

export function WizardStepIndicator({ active, completed = [] }: Props) {
  const activeIdx = STEPS.findIndex((s) => s.id === active);
  return (
    <ol className="launch-steps" aria-label="Setup steps">
      {STEPS.map((s, i) => {
        const done = completed.includes(s.id) || i < activeIdx;
        const current = s.id === active;
        return (
          <li
            key={s.id}
            className="launch-steps__item"
            data-active={current ? "true" : "false"}
            data-done={done && !current ? "true" : "false"}
            aria-current={current ? "step" : undefined}
          >
            <span className="launch-steps__dot" aria-hidden>
              {done && !current ? "✓" : i + 1}
            </span>
            <span className="launch-steps__label">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
