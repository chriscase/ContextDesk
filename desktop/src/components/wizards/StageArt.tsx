/**
 * Themeable SVG stage art for session wizards (#442).
 * Uses currentColor; no external assets.
 */

type Props = {
  id: string;
  className?: string;
  title?: string;
};

export function StageArt({ id, className, title }: Props) {
  const label = title ?? id;
  return (
    <div className={["wizard-stage", className].filter(Boolean).join(" ")} aria-hidden>
      <svg
        viewBox="0 0 320 180"
        width="100%"
        height="100%"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        {renderArt(id)}
      </svg>
    </div>
  );
}

function renderArt(id: string) {
  switch (id) {
    case "pipeline":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          {[
            ["Scan", 28],
            ["Parse", 78],
            ["Template", 128],
            ["Store", 178],
            ["Embed", 228],
            ["Tools", 278],
          ].map(([label, x], i) => (
            <g key={label}>
              <rect x={Number(x) - 18} y={70} width="36" height="36" rx="6" />
              <text
                x={x}
                y={130}
                textAnchor="middle"
                fill="currentColor"
                stroke="none"
                fontSize="9"
              >
                {label}
              </text>
              {i < 5 ? (
                <path d={`M ${Number(x) + 20} 88 H ${Number(x) + 30}`} markerEnd="url(#arrow)" />
              ) : null}
            </g>
          ))}
          <defs>
            <marker
              id="arrow"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
            </marker>
          </defs>
          <text x="160" y="40" textAnchor="middle" fill="currentColor" stroke="none" fontSize="12">
            Log analysis pipeline
          </text>
        </g>
      );
    case "folder":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M40 60 h70 l16 16 h154 v80 H40 Z" />
          <path d="M80 100 h160 M80 120 h120" opacity="0.6" />
          <text x="160" y="40" textAnchor="middle" fill="currentColor" stroke="none" fontSize="12">
            Choose a log dump
          </text>
        </g>
      );
    case "mode":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="40" y="50" width="100" height="90" rx="8" />
          <rect x="180" y="50" width="100" height="90" rx="8" />
          <text x="90" y="100" textAnchor="middle" fill="currentColor" stroke="none" fontSize="11">
            Corpus
          </text>
          <text x="230" y="100" textAnchor="middle" fill="currentColor" stroke="none" fontSize="11">
            Context
          </text>
        </g>
      );
    case "confirm":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="90" y="45" width="140" height="100" rx="10" />
          <path d="M120 95 l20 20 l50 -45" />
          <text x="160" y="165" textAnchor="middle" fill="currentColor" stroke="none" fontSize="11">
            SoftWrite confirm
          </text>
        </g>
      );
    case "memory":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          <ellipse cx="160" cy="90" rx="70" ry="50" />
          <path d="M120 90 h80 M140 70 v40 M180 70 v40" opacity="0.7" />
          <text x="160" y="160" textAnchor="middle" fill="currentColor" stroke="none" fontSize="11">
            Durable memory
          </text>
        </g>
      );
    case "ready":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="160" cy="90" r="48" />
          <path d="M135 90 l18 18 l35 -40" />
          <text x="160" y="160" textAnchor="middle" fill="currentColor" stroke="none" fontSize="11">
            Ready to chat
          </text>
        </g>
      );
    default:
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="160" cy="90" r="40" />
          <text x="160" y="95" textAnchor="middle" fill="currentColor" stroke="none" fontSize="14">
            ?
          </text>
        </g>
      );
  }
}
