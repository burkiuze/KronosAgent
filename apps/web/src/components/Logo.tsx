/** The Kronos mark: an hourglass forged in gold. */
export function KronosMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="kronos-mark" aria-label="Kronos">
      <defs>
        <linearGradient id="kg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f7d666" />
          <stop offset="1" stopColor="#b8862b" />
        </linearGradient>
        <radialGradient id="kglow" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0" stopColor="#f7d666" stopOpacity="0.35" />
          <stop offset="1" stopColor="#f7d666" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="31" fill="url(#kglow)" />
      <rect x="6" y="6" width="52" height="52" rx="14" fill="var(--elev)" stroke="url(#kg)" strokeWidth="1.5" />
      <path d="M20 15h24M20 49h24" stroke="url(#kg)" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M22 17c0 9 10 11 10 15s-10 6-10 15M42 17c0 9-10 11-10 15s10 6 10 15" fill="none" stroke="url(#kg)" strokeWidth="3" strokeLinecap="round" />
      <path d="M26.5 44c2.3-3 3.6-4 5.5-5 1.9 1 3.2 2 5.5 5z" fill="url(#kg)">
        <animate attributeName="opacity" values="1;0.55;1" dur="3s" repeatCount="indefinite" />
      </path>
      <circle cx="32" cy="33.5" r="1.2" fill="url(#kg)">
        <animate attributeName="cy" values="30;37;30" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
