/**
 * Step 11 hero scene: a ~9 s looping SVG story (CSS keyframes only).
 * Highway → scan beam → crash marker → amber slowdown → alert card →
 * blue detour → green "Road clear". Static frame under reduced motion.
 */
export function HeroScene() {
  return (
    <svg
      viewBox="0 0 480 360"
      role="img"
      aria-label="Animation: cars flow past a road camera, a crash is spotted, drivers behind get an alert card, a blue detour draws, and the marker turns green when the road clears."
      className="h-auto w-full"
    >
      {/* Road */}
      <rect x="0" y="150" width="480" height="84" fill="#16263f" />
      <rect x="0" y="150" width="480" height="4" fill="#2c4a7c" />
      <rect x="0" y="230" width="480" height="4" fill="#2c4a7c" />
      <line x1="0" y1="192" x2="480" y2="192" stroke="#3b537f" strokeWidth="3" strokeDasharray="22 18" />
      <text x="14" y="176" fill="#7d90b5" fontSize="11" fontFamily="monospace" letterSpacing="2">
        I-95 S
      </text>

      <g className="scene-motion">
        {/* Flowing cars */}
        <rect className="sc-car" x="0" y="160" width="44" height="20" rx="6" fill="#e2e8f0" />
        <rect className="sc-car sc-car-2" x="0" y="202" width="44" height="20" rx="6" fill="#93c5fd" />
        <rect className="sc-car sc-car-3" x="0" y="160" width="40" height="20" rx="6" fill="#7d90b5" />
        <rect className="sc-car sc-car-4" x="0" y="202" width="48" height="20" rx="6" fill="#e2e8f0" />

        {/* Camera scan beam */}
        <polygon
          className="sc-scan"
          points="176,60 216,60 246,150 146,150"
          fill="#60a5fa"
          opacity="0.28"
        />
        <rect x="186" y="46" width="20" height="12" rx="3" fill="#93c5fd" />
        <text x="150" y="40" fill="#93c5fd" fontSize="11" fontFamily="monospace" letterSpacing="2">
          CAM 12
        </text>

        {/* Amber slowdown glow behind the crash */}
        <ellipse className="sc-slow" cx="300" cy="192" rx="90" ry="44" fill="#f59e0b" opacity="0.22" />

        {/* Crash marker with pulsing rings */}
        <g className="sc-crash">
          <circle className="sc-ring" cx="352" cy="168" r="26" fill="none" stroke="#f87171" strokeWidth="3" />
          <circle className="sc-ring sc-ring-2" cx="352" cy="168" r="26" fill="none" stroke="#f87171" strokeWidth="3" />
          <polygon points="352,142 374,180 330,180" fill="#dc2626" stroke="#fecaca" strokeWidth="2" />
          <text x="352" y="173" textAnchor="middle" fill="#fff" fontSize="20" fontWeight="bold">
            !
          </text>
        </g>

        {/* Blue detour drawing over the top */}
        <path
          className="sc-detour-path"
          d="M 40 192 C 140 190, 170 96, 250 92 S 380 150, 444 192"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="6"
          strokeLinecap="round"
          pathLength={1}
        />
        <text x="250" y="80" textAnchor="middle" fill="#93c5fd" fontSize="11" fontFamily="monospace" letterSpacing="2" className="sc-slow">
          CT-15
        </text>

        {/* Green clear marker + label */}
        <g className="sc-clear">
          <circle cx="352" cy="168" r="16" fill="#16a34a" stroke="#bbf7d0" strokeWidth="2" />
          <text x="352" y="175" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="bold">
            ✓
          </text>
          <text x="352" y="134" textAnchor="middle" fill="#6ee7b7" fontSize="15" fontWeight="bold">
            Road clear
          </text>
        </g>

        {/* Alert card */}
        <g className="sc-card">
          <rect x="70" y="252" width="340" height="78" rx="10" fill="#101e38" stroke="#fcd34d" strokeWidth="2" />
          <text x="90" y="280" fill="#f8fafc" fontSize="15" fontWeight="bold">
            Crash ahead · clears in about 35 min
          </text>
          <text x="90" y="304" fill="#6ee7b7" fontSize="13">
            ✅ Best: Reroute via CT-15
          </text>
        </g>
      </g>

      {/* Static frame for reduced motion: the full story at rest */}
      <g className="scene-static">
        <rect x="60" y="160" width="44" height="20" rx="6" fill="#e2e8f0" />
        <rect x="150" y="202" width="44" height="20" rx="6" fill="#93c5fd" />
        <rect x="230" y="160" width="40" height="20" rx="6" fill="#7d90b5" />
        <path
          d="M 40 192 C 140 190, 170 96, 250 92 S 380 150, 444 192"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <circle cx="352" cy="168" r="16" fill="#16a34a" stroke="#bbf7d0" strokeWidth="2" />
        <text x="352" y="175" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="bold">
          ✓
        </text>
        <text x="352" y="134" textAnchor="middle" fill="#6ee7b7" fontSize="15" fontWeight="bold">
          Road clear
        </text>
        <rect x="70" y="252" width="340" height="78" rx="10" fill="#101e38" stroke="#fcd34d" strokeWidth="2" />
        <text x="90" y="280" fill="#f8fafc" fontSize="15" fontWeight="bold">
          Crash ahead · clears in about 35 min
        </text>
        <text x="90" y="304" fill="#6ee7b7" fontSize="13">
          ✅ Best: Reroute via CT-15
        </text>
      </g>
    </svg>
  );
}
