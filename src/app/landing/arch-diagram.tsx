/**
 * Step 11 pipeline diagram (static inline SVG, vertical: readable at 390 px
 * and desktop). Mirrors the README "How it works" mermaid chart.
 */
const NODES = [
  { name: 'Road camera clip', sub: 'dashcam · traffic cam' },
  { name: 'Quick check', sub: 'Muse Spark' },
  { name: 'Full check', sub: 'SAM 3.1 + Muse Spark, cross-checked' },
  { name: 'Incident agent', sub: 'Muse Wonder' },
  { name: 'Guard', sub: 'evidence rules' },
  { name: 'Map + route decision', sub: 'stay · reroute · wait' },
  { name: 'Drivers behind', sub: 'warned before the scene' },
];

const NODE_H = 58;
const GAP = 30;
const W = 400;

export function ArchDiagram() {
  const h = NODES.length * NODE_H + (NODES.length - 1) * GAP + 16;
  return (
    <svg
      viewBox={`0 0 ${W} ${h}`}
      role="img"
      aria-label="Pipeline diagram: road camera clip, quick check by Muse Spark, full check by SAM 3.1 plus Muse Spark, incident agent by Muse Wonder, guard, map and route decision, drivers behind."
      className="mx-auto h-auto w-full max-w-md"
    >
      <defs>
        <marker id="rd-arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" fill="#fcd34d" />
        </marker>
      </defs>
      {NODES.map((n, i) => {
        const y = 8 + i * (NODE_H + GAP);
        return (
          <g key={n.name}>
            <rect
              x="8"
              y={y}
              width={W - 16}
              height={NODE_H}
              rx="10"
              fill="#101e38"
              stroke={i === 0 || i === NODES.length - 1 ? '#fcd34d' : '#3b537f'}
              strokeWidth={i === 0 || i === NODES.length - 1 ? 2 : 1.5}
            />
            <text x="24" y={y + 25} fill="#f8fafc" fontSize="14" fontWeight="700">
              {n.name}
            </text>
            <text x="24" y={y + 44} fill="#93c5fd" fontSize="12" fontFamily="monospace">
              {n.sub}
            </text>
            {i < NODES.length - 1 && (
              <line
                x1={W / 2}
                y1={y + NODE_H + 4}
                x2={W / 2}
                y2={y + NODE_H + GAP - 4}
                stroke="#fcd34d"
                strokeWidth="2"
                markerEnd="url(#rd-arrow)"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
