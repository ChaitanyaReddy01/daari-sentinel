/**
 * Hero scene: a ~12 s looping top-down road story (CSS keyframes only).
 * I-95 S (2 lanes + shoulder) with CT-15 parallel above, joined by Exit 38
 * and an entrance ramp. Cars flow → a dashcam scans → crash + alert →
 * amber queue with brake lights → You detours via CT-15 → police arrives →
 * tow truck arrives → You rejoins past the crash → green "Road clear".
 * Static frame under reduced motion.
 *
 * Timeline (12 s loop): crash pops ~15%, queue amber one-by-one 20-28%,
 * You exits ~27% and rejoins ~72%, police stops ~50%, tow stops ~63%,
 * all clear 82-90%.
 */
import type { CSSProperties } from "react";

export function HeroScene() {
  return (
    <svg
      viewBox="0 0 480 400"
      role="img"
      aria-label="Animation: cars drive east on I-95, a dashcam scans ahead, a crash blocks the right lane, queued cars brake and turn amber, the blue You car detours via CT-15 past the crash, a police car then a tow truck arrive on the shoulder, and the road clears."
      className="h-auto w-full"
    >
      <defs>
        {/* Top-down car, pointing right. Body color via --car-body so each
            instance (gray, amber queue, blue You, police) reuses one sprite. */}
        <symbol id="hs-car" viewBox="0 0 38 20">
          <rect x="3" y="4" width="32" height="13" rx="4" fill="#000" opacity="0.3" />
          <rect x="6" y="0.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="26" y="0.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="6" y="14.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="26" y="14.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect
            x="2"
            y="2"
            width="34"
            height="16"
            rx="5"
            fill="var(--car-body, #94a3b8)"
            stroke="var(--car-line, #475569)"
            strokeWidth="1.5"
          />
          <rect x="12" y="4.5" width="12" height="11" rx="2" fill="var(--car-roof, #64748b)" />
          <polygon points="24,5 30.5,7.5 30.5,12.5 24,15" fill="#bae6fd" opacity="0.9" />
          <polygon points="8,6.5 12,5.5 12,14.5 8,13.5" fill="#bae6fd" opacity="0.7" />
          <rect x="23" y="0.5" width="3" height="3" rx="1" fill="var(--car-line, #475569)" />
          <rect x="23" y="16.5" width="3" height="3" rx="1" fill="var(--car-line, #475569)" />
          <rect x="34.5" y="5" width="2" height="3" rx="1" fill="#fef9c3" />
          <rect x="34.5" y="12" width="2" height="3" rx="1" fill="#fef9c3" />
          <rect x="1.5" y="5" width="2" height="3" rx="1" fill="var(--car-tail, #7f1d1d)" />
          <rect x="1.5" y="12" width="2" height="3" rx="1" fill="var(--car-tail, #7f1d1d)" />
        </symbol>
        {/* Tow truck: cab plus flatbed, pointing right. */}
        <symbol id="hs-tow" viewBox="0 0 56 20">
          <rect x="3" y="4" width="50" height="13" rx="3" fill="#000" opacity="0.3" />
          <rect x="6" y="0.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="20" y="0.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="44" y="0.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="6" y="14.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="20" y="14.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect x="44" y="14.5" width="6" height="5" rx="1.5" fill="#111c2e" />
          <rect
            x="2"
            y="4"
            width="36"
            height="12"
            rx="2"
            fill="var(--tow-bed, #334155)"
            stroke="#0f172a"
            strokeWidth="1.5"
          />
          <rect
            x="38"
            y="2"
            width="16"
            height="16"
            rx="4"
            fill="var(--car-body, #e2e8f0)"
            stroke="var(--car-line, #475569)"
            strokeWidth="1.5"
          />
          <polygon points="46,5 51.5,7.5 51.5,12.5 46,15" fill="#bae6fd" opacity="0.9" />
          <rect x="52.5" y="5" width="2" height="3" rx="1" fill="#fef9c3" />
          <rect x="52.5" y="12" width="2" height="3" rx="1" fill="#fef9c3" />
          <rect x="1.5" y="7" width="2" height="6" rx="1" fill="var(--car-tail, #7f1d1d)" />
        </symbol>
      </defs>

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

      {/* I-95 S: straight 2-lane highway with a shoulder below */}
      <rect x="0" y="180" width="480" height="64" fill="#16263f" />
      <rect x="0" y="180" width="480" height="3" fill="#2c4a7c" />
      <rect x="0" y="241" width="480" height="3" fill="#2c4a7c" />
      <line x1="0" y1="212" x2="480" y2="212" stroke="#3b537f" strokeWidth="3" strokeDasharray="22 18" />
      <rect x="0" y="244" width="480" height="14" fill="#101d33" />
      <rect x="0" y="256" width="480" height="2" fill="#2c4a7c" />
      <text x="14" y="206" fill="#7d90b5" fontSize="11" fontFamily="monospace" letterSpacing="2">
        I-95 S
      </text>

      <g className="scene-motion">
        {/* Blue detour highlight: draws progressively as the You car travels it */}
        <path
          className="sc3-detour"
          d="M128 196 C136 150 138 120 140 73 L400 73 C404 120 406 150 408 196"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="5"
          strokeLinecap="round"
          pathLength={1}
        />

        {/* Crash marker with pulsing rings (right lane, ~65% width) */}
        <g className="sc3-crash">
          <circle className="sc2-ring" cx="312" cy="196" r="20" fill="none" stroke="#f87171" strokeWidth="3" />
          <circle className="sc2-ring sc2-ring-2" cx="312" cy="196" r="20" fill="none" stroke="#f87171" strokeWidth="3" />
          <polygon points="312,182 328,208 296,208" fill="#dc2626" stroke="#fecaca" strokeWidth="2" />
          <text x="312" y="204" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="bold">
            !
          </text>
        </g>

        {/* Green clear marker */}
        <g className="sc3-clear">
          <circle cx="312" cy="196" r="15" fill="#16a34a" stroke="#bbf7d0" strokeWidth="2" />
          <text x="312" y="202" textAnchor="middle" fill="#fff" fontSize="15" fontWeight="bold">
            ✓
          </text>
          <text x="312" y="158" textAnchor="middle" fill="#6ee7b7" fontSize="13" fontWeight="bold">
            Road clear
          </text>
        </g>

        {/* Queue car 1 (front): carries the dashcam */}
        <g className="sc3-q1">
          <use href="#hs-car" x="258" y="187" width="38" height="20" />
          <circle cx="276" cy="185" r="3" fill="#60a5fa" />
          <circle cx="276" cy="185" r="1.2" fill="#dbeafe" />
          <text x="254" y="182" fill="#93c5fd" fontSize="11" fontFamily="monospace">
            cam
          </text>
          <polygon className="sc3-beam" points="294,191 294,201 311,187 311,205" fill="#60a5fa" />
        </g>

        {/* Queue cars 2-3 */}
        <g className="sc3-q2">
          <use href="#hs-car" x="216" y="187" width="38" height="20" />
        </g>
        <g className="sc3-q3">
          <use href="#hs-car" x="174" y="187" width="38" height="20" />
        </g>

        {/* Through traffic (bottom lane, steady loops) */}
        <use className="sc2-flow sc2-flow-1" href="#hs-car" x="0" y="219" width="38" height="20" />
        <use className="sc2-flow sc2-flow-2" href="#hs-car" x="0" y="219" width="38" height="20" />
        <use className="sc2-flow sc2-flow-3" href="#hs-car" x="0" y="219" width="38" height="20" />

        {/* Police car: white sprite + alternating light bar, stops on the shoulder */}
        <g
          className="sc3-police"
          style={{ '--car-body': '#f1f5f9', '--car-roof': '#0f172a', '--car-line': '#0f172a' } as CSSProperties}
        >
          <use href="#hs-car" x="0" y="241" width="38" height="20" />
          <rect x="13" y="237" width="12" height="6" rx="2" fill="#1e293b" />
          <circle className="sc3-pl-r" cx="17" cy="240" r="2.2" fill="#ef4444" />
          <circle className="sc3-pl-b" cx="22" cy="240" r="2.2" fill="#3b82f6" />
        </g>

        {/* Tow truck: arrives after the police, stops behind it on the shoulder */}
        <g className="sc3-tow" style={{ '--car-body': '#e2e8f0' } as CSSProperties}>
          <use href="#hs-tow" x="0" y="241" width="56" height="20" />
          <circle className="sc3-beacon" cx="44" cy="240" r="2.6" fill="#f59e0b" />
        </g>

        {/* The blue "You" car: exits, detours via CT-15, rejoins past the crash */}
        <g
          className="sc3-you"
          style={{ '--car-body': '#3b82f6', '--car-roof': '#1d4ed8', '--car-line': '#dbeafe' } as CSSProperties}
        >
          <use href="#hs-car" x="0" y="185" width="42" height="22" />
          <text x="7" y="199" fill="#fff" fontSize="11" fontWeight="bold">
            You
          </text>
        </g>

        {/* Alert card */}
        <g className="sc3-cardbg">
          <rect x="70" y="292" width="340" height="76" rx="10" fill="#101e38" stroke="#fcd34d" strokeWidth="2" />
        </g>
        <text className="sc3-l1a" x="90" y="318" fill="#f8fafc" fontSize="15" fontWeight="bold">
          Crash ahead · clears in about 35 min
        </text>
        <text className="sc3-l1b" x="90" y="318" fill="#f8fafc" fontSize="15" fontWeight="bold">
          Crash ahead · clears in about 10 min
        </text>
        <text className="sc3-l2a" x="90" y="342" fill="#6ee7b7" fontSize="13">
          ✅ Best: Reroute via CT-15
        </text>
        <text className="sc3-l2b" x="90" y="342" fill="#fcd34d" fontSize="13" fontWeight="600">
          → Rerouting via Exit 38
        </text>
        <text className="sc3-l2c" x="90" y="342" fill="#93c5fd" fontSize="13" fontWeight="600">
          🚔 police on scene
        </text>
        <text className="sc3-l2d" x="90" y="342" fill="#fcd34d" fontSize="13" fontWeight="600">
          🚓 tow truck working
        </text>
        <text className="sc3-lclear" x="90" y="334" fill="#6ee7b7" fontSize="15" fontWeight="bold">
          ✓ Road clear
        </text>
      </g>

      {/* Static frame for reduced motion: queue, crash, police, detour, alert card */}
      <g className="scene-static">
        <path
          d="M128 196 C136 150 138 120 140 73 L400 73 C404 120 406 150 408 196"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <use href="#hs-car" x="60" y="219" width="38" height="20" />
        <use href="#hs-car" x="150" y="219" width="38" height="20" />
        <g style={{ '--car-body': '#f59e0b', '--car-roof': '#b45309', '--car-tail': '#ef4444' } as CSSProperties}>
          <use href="#hs-car" x="258" y="187" width="38" height="20" />
          <use href="#hs-car" x="216" y="187" width="38" height="20" />
          <use href="#hs-car" x="174" y="187" width="38" height="20" />
        </g>
        <circle cx="276" cy="185" r="3" fill="#60a5fa" />
        <text x="254" y="182" fill="#93c5fd" fontSize="11" fontFamily="monospace">
          cam
        </text>
        <g style={{ '--car-body': '#f1f5f9', '--car-roof': '#0f172a', '--car-line': '#0f172a' } as CSSProperties}>
          <use href="#hs-car" x="326" y="241" width="38" height="20" />
        </g>
        <rect x="339" y="237" width="12" height="6" rx="2" fill="#1e293b" />
        <circle cx="343" cy="240" r="2.2" fill="#ef4444" />
        <circle cx="348" cy="240" r="2.2" fill="#3b82f6" />
        <g style={{ '--car-body': '#3b82f6', '--car-roof': '#1d4ed8', '--car-line': '#dbeafe' } as CSSProperties}>
          <use href="#hs-car" x="269" y="62" width="42" height="22" />
        </g>
        <text x="276" y="76" fill="#fff" fontSize="11" fontWeight="bold">
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
