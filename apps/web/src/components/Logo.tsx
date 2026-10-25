/** The Kronos mark: a monochrome hourglass tile that follows the theme. */
export function KronosMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="kronos-mark" aria-label="Kronos">
      <rect x="2" y="2" width="60" height="60" rx="15" fill="var(--text)" />
      <path d="M21 16h22M21 48h22" stroke="var(--panel)" strokeWidth="4" strokeLinecap="round" />
      <path d="M23.5 18c0 8.5 8.5 10.5 8.5 14s-8.5 5.5-8.5 14M40.5 18c0 8.5-8.5 10.5-8.5 14s8.5 5.5 8.5 14" fill="none" stroke="var(--panel)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M27 44.5c2-2.7 3.3-3.7 5-4.6 1.7.9 3 1.9 5 4.6z" fill="var(--panel)">
        <animate attributeName="opacity" values="1;0.55;1" dur="3s" repeatCount="indefinite" />
      </path>
      <circle cx="32" cy="33.5" r="1.3" fill="var(--panel)">
        <animate attributeName="cy" values="30.5;37;30.5" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
