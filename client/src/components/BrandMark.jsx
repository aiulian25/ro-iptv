// Neon play + soundwave brand mark (matches the login mockup). Pure SVG so it
// scales crisply and needs no extra asset.
export default function BrandMark({ className = '' }) {
  return (
    <svg viewBox="0 0 160 160" className={className} role="img" aria-label="RO-IPTV">
      <defs>
        <linearGradient id="ro-neon" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#c026d3" />
          <stop offset="55%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <filter id="ro-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect x="14" y="14" width="132" height="132" rx="34" fill="url(#ro-neon)" opacity="0.06" />
      <rect x="14" y="14" width="132" height="132" rx="34" fill="none" stroke="url(#ro-neon)" strokeWidth="1.5" opacity="0.4" />
      <g filter="url(#ro-glow)" fill="none" stroke="url(#ro-neon)" strokeWidth="7" strokeLinejoin="round" strokeLinecap="round">
        <polygon points="58,50 58,110 104,80" />
        <path d="M116 58a26 26 0 0 1 0 44" />
        <path d="M128 46a44 44 0 0 1 0 68" opacity="0.7" />
      </g>
    </svg>
  );
}
