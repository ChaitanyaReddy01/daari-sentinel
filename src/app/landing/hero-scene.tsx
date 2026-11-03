/**
 * Hero scene: a ~10 s looping top-down road story (CSS keyframes only).
 * I-95 S (2 lanes) with CT-15 parallel above, joined by Exit 38 and an
 * entrance ramp. Cars flow → a dashcam scans → crash → an amber queue of
 * separate cars forms → the blue "You" car detours via CT-15 and rejoins
 * past the crash → green "Road clear". Static frame under reduced motion.
 *
 * Timeline (10 s loop): crash pops ~18%, queue amber one-by-one 22-34%,
 * You car exits ~31% and rejoins ~74%, all clear 78-88%.
 */
export function HeroScene() {
  return (
    <svg
      viewBox="0 0 480 400"
      role="img"
      aria-label="Animation: cars drive east on I-95, a dashcam scans ahead, a crash blocks the right lane, queued cars turn amber, the blue You car detours via CT-15 past the crash, and the road clears."
      className="h-auto w-full"
    >
      {/* CT-15: thinner parallel road above */}
      <rect x="64" y="60" width="380" height="26" rx="4" fill="#1b2c4a" />
      <rect x="64" y="60" width="380" height="2" fill="#2c4a7c" />
      <rect x="64" y="84" width="380" height="2" fill="#2c4a7c" />
      <line x1="64" y1="73" x2="444" y2="73" stroke="#3b537f" strokeWidth="2" strokeDasharray="10 8" />
      <text x="8" y="81" fill="#7d90b5" fontSize="11" fontFamily="monospace" letterSpacing="1">
        CT-15
      </text>

      {/* Exit 38 ramp (I-95 up to CT-15) */}
      <path d="M144 182 C144 150 146 120 150 88" stroke="#16263f" strokeWidth="12" strokeLinecap="round" fill="none" />
      <path d="M144 182 C144 150 146 120 150 88" stroke="#3b537f" strokeWidth="2" strokeDasharray="6 6" fill="none" />
      <text x="134" y="148" textAnchor="end" fill="#93c5fd" fontSize="11" fontFamily="monospace">
        Exit 38
      </text>

      {/* Entrance ramp (CT-15 back down to I-95) */}
      <path d="M404 88 C406 120 410 150 412 182" stroke="#16263f" strokeWidth="12" strokeLinecap="round" fill="none" />
      <path d="M404 88 C406 120 410 150 412 182" stroke="#3b537f" strokeWidth="2" strokeDasharray="6 6" fill="none" />

      {/* I-95 S: straight 2-lane highway */}
      <rect x="0" y="180" width="480" height="64" fill="#16263f" />
      <rect x="0" y="180" width="480" height="3" fill="#2c4a7c" />
      <rect x="0" y="241" width="480" height="3" fill="#2c4a7c" />
      <line x1="0" y1="212" x2="480" y2="212" stroke="#3b537f" strokeWidth="3" strokeDasharray="22 18" />
      <text x="14" y="206" fill="#7d90b5" fontSize="11" fontFamily="monospace" letterSpacing="2">
        I-95 S
      </text>

      <g className="scene-motion">
        {/* Blue detour highlight: draws progressively as the You car travels it */}
        <path
          className="sc2-detour"
          d="M128 196 C136 150 138 120 140 73 L400 73 C404 120 406 150 408 196"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="5"
          strokeLinecap="round"
          pathLength={1}
        />

        {/* Crash marker with pulsing rings (right lane, ~65% width) */}
        <g className="sc2-crash">
          <circle className="sc2-ring" cx="312" cy="196" r="20" fill="none" stroke="#f87171" strokeWidth="3" />
          <circle className="sc2-ring sc2-ring-2" cx="312" cy="196" r="20" fill="none" stroke="#f87171" strokeWidth="3" />
          <polygon points="312,182 328,208 296,208" fill="#dc2626" stroke="#fecaca" strokeWidth="2" />
          <text x="312" y="204" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="bold">
            !
          </text>
        </g>

        {/* Green clear marker */}
        <g className="sc2-clear">
          <circle cx="312" cy="196" r="15" fill="#16a34a" stroke="#bbf7d0" strokeWidth="2" />
          <text x="312" y="202" textAnchor="middle" fill="#fff" fontSize="15" fontWeight="bold">
            ✓
          </text>
          <text x="312" y="158" textAnchor="middle" fill="#6ee7b7" fontSize="13" fontWeight="bold">
            Road clear
          </text>
        </g>

        {/* Queue car 1 (front): carries the dashcam */}
        <g className="sc2-q1">
          <rect x="268" y="190" width="26" height="12" rx="4" />
          <rect x="280" y="185" width="9" height="5" rx="1.5" fill="#60a5fa" />
          <circle cx="286" cy="187.5" r="1.5" fill="#dbeafe" />
          <text x="264" y="182" fill="#93c5fd" fontSize="11" fontFamily="monospace">
            cam
          </text>
          <polygon className="sc2-beam" points="294,191 294,201 311,187 311,205" fill="#60a5fa" />
        </g>

        {/* Queue cars 2-3 */}
        <g className="sc2-q2">
          <rect x="232" y="190" width="26" height="12" rx="4" />
        </g>
        <g className="sc2-q3">
          <rect x="196" y="190" width="26" height="12" rx="4" />
        </g>

        {/* Through traffic (bottom lane, steady loops) */}
        <rect className="sc2-flow sc2-flow-1" x="0" y="222" width="26" height="12" rx="4" fill="#94a3b8" />
        <rect className="sc2-flow sc2-flow-2" x="0" y="222" width="26" height="12" rx="4" fill="#7d90b5" />
        <rect className="sc2-flow sc2-flow-3" x="0" y="222" width="26" height="12" rx="4" fill="#94a3b8" />

        {/* The blue "You" car: exits, detours via CT-15, rejoins past the crash */}
        <g className="sc2-you">
          <rect x="0" y="189" width="30" height="14" rx="5" fill="#3b82f6" stroke="#dbeafe" strokeWidth="1.5" />
          <text x="4" y="200" fill="#fff" fontSize="11" fontWeight="bold">
            You
          </text>
        </g>

        {/* Alert card */}
        <g className="sc2-cardbg">
          <rect x="70" y="292" width="340" height="76" rx="10" fill="#101e38" stroke="#fcd34d" strokeWidth="2" />
        </g>
        <text className="sc2-l1" x="90" y="318" fill="#f8fafc" fontSize="15" fontWeight="bold">
          Crash ahead · clears in about 35 min
        </text>
        <text className="sc2-l2a" x="90" y="342" fill="#6ee7b7" fontSize="13">
          ✅ Best: Reroute via CT-15
        </text>
        <text className="sc2-l2b" x="90" y="342" fill="#fcd34d" fontSize="13" fontWeight="600">
          → Rerouting via Exit 38
        </text>
        <text className="sc2-lclear" x="90" y="334" fill="#6ee7b7" fontSize="15" fontWeight="bold">
          ✓ Road clear
        </text>
      </g>

      {/* Static frame for reduced motion: queue, crash, detour, alert card */}
      <g className="scene-static">
        <path
          d="M128 196 C136 150 138 120 140 73 L400 73 C404 120 406 150 408 196"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <rect x="60" y="222" width="26" height="12" rx="4" fill="#94a3b8" />
        <rect x="150" y="222" width="26" height="12" rx="4" fill="#7d90b5" />
        <rect x="268" y="190" width="26" height="12" rx="4" fill="#f59e0b" />
        <rect x="280" y="185" width="9" height="5" rx="1.5" fill="#60a5fa" />
        <text x="264" y="182" fill="#93c5fd" fontSize="11" fontFamily="monospace">
          cam
        </text>
        <rect x="232" y="190" width="26" height="12" rx="4" fill="#f59e0b" />
        <rect x="196" y="190" width="26" height="12" rx="4" fill="#f59e0b" />
        <rect x="260" y="66" width="30" height="14" rx="5" fill="#3b82f6" stroke="#dbeafe" strokeWidth="1.5" />
        <text x="264" y="77" fill="#fff" fontSize="11" fontWeight="bold">
          You
        </text>
        <circle cx="312" cy="196" r="26" fill="none" stroke="#f87171" strokeWidth="3" opacity="0.5" />
        <polygon points="312,182 328,208 296,208" fill="#dc2626" stroke="#fecaca" strokeWidth="2" />
        <text x="312" y="204" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="bold">
          !
        </text>
        <rect x="70" y="292" width="340" height="76" rx="10" fill="#101e38" stroke="#fcd34d" strokeWidth="2" />
        <text x="90" y="318" fill="#f8fafc" fontSize="15" fontWeight="bold">
          Crash ahead · clears in about 35 min
        </text>
        <text x="90" y="342" fill="#6ee7b7" fontSize="13">
          ✅ Best: Reroute via CT-15
        </text>
      </g>
    </svg>
  );
}
