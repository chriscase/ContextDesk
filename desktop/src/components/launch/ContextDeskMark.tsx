/** Custom ContextDesk mark — desk + citation bars (not NexaDeck waveform). */

type Props = {
  size?: number;
  className?: string;
};

export function ContextDeskMark({ size = 120, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect
        x="8"
        y="8"
        width="104"
        height="104"
        rx="28"
        fill="#12141a"
        stroke="url(#cd-grad)"
        strokeWidth="2"
      />
      {/* desk surface */}
      <path
        d="M28 72h64"
        stroke="url(#cd-grad)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path
        d="M36 72v18M84 72v18"
        stroke="#3a4050"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* stacked knowledge / citations */}
      <rect x="34" y="34" width="40" height="8" rx="2" fill="#4a9eff" opacity="0.95" />
      <rect x="34" y="46" width="52" height="6" rx="2" fill="#6bb0ff" opacity="0.55" />
      <rect x="34" y="56" width="28" height="6" rx="2" fill="#6bb0ff" opacity="0.35" />
      {/* pin / memory spark */}
      <circle cx="86" cy="38" r="6" fill="#4a9eff" />
      <circle cx="86" cy="38" r="2.5" fill="#0a0a0a" />
      <defs>
        <linearGradient id="cd-grad" x1="20" y1="16" x2="100" y2="104">
          <stop stopColor="#6bb0ff" />
          <stop offset="1" stopColor="#3d7dd6" />
        </linearGradient>
      </defs>
    </svg>
  );
}
