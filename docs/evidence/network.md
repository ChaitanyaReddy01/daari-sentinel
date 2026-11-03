# Evidence: the network demo (simulation)

> This is a **simulation**: scripted drivers on committed routes reacting
> to one camera report — not a live fleet. Sources: README "Network
> effect", `data/snapshot/network/` (10 corridor trips, 40 seeded
> drivers), `/sim` "Play network demo" ($0, replays the snapshot).

## Setup

You drive New Haven → JFK; as you pass Norwalk your camera's quick look
flags a crash. About 40 drivers on nearby committed trips each get the
same stay / reroute / wait scoring from their own position (seeded
choices: 75% fastest, 15% stay, 10% wait; detour load +0.15 min per
rerouting driver, capped at +8 min).

## Recorded numbers

- **11 drivers alerted: 4 rerouted, 6 stayed, 1 stopped to wait**
- **~3.2 driver-hours saved** (estimated)
- **29 drivers correctly not alerted** — already past, going the other
  way, or arriving after it clears

## Re-running

"Play network demo" on `/sim` — runs at $0 from the committed snapshot.
