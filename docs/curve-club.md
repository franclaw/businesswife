# Curve Club

`/games` is a self-hosted Zatacka fork with 1–10 players, one private room per link. Rooms and scores are ephemeral, expiring after one hour without connected viewers or requests. A round ends on collision (last survivor wins, solo survival time) or after two minutes. No automatic rematches.

## Simulation and transport

- `lib/games.js` owns rooms, credentials, 60 Hz fixed-step scheduling, scoring and a 20 Hz SSE stream. Node's monotonic clock drives an accumulator: physics is no longer batched three steps every 50 ms.
- The MIT-licensed upstream engine remains authoritative for movement/collisions. Trails are 3 arena pixels wide (collision occupancy and rendering use the same 1.5 px radius). Ten numbered slots have distinct colours; player count and palette are independent of upstream's six-colour defaults.
- `/games/api/rooms/:id/{join,start,turn,leave}` accept JSON POSTs. Rejoining needs the seat token; a participant cannot start another host's round. Leaving outside play frees a seat and transfers host if necessary.
- Steering carries `seq` and `generation`. Older, duplicated, or previous-round inputs cannot overwrite a newer release. Every second the client refreshes the held state; the server releases steering after 2.5 seconds without a refresh. Blur, hidden tabs and pointer cancellation release locally too.
- Streams contain compact trail triples `[slot,x,y]`, a cursor (`trailFrom`, `trailTo`), a round `generation` and a separate `trailEpoch` for erasers. Reconnects send a full snapshot. A cursor mismatch reopens the stream. Slow consumers are disconnected rather than buffering old gameplay indefinitely.
- Browser prediction reacts immediately to the local held direction, with bounded server reconciliation. It does not decide collisions. Remote positions extrapolate at most 100 ms; local prediction freezes when the stream is stale. High real network latency still matters.
- A static trail canvas is updated only for new authoritative points. The transparent animation canvas clears small dirty regions for heads/pickups, not the whole arena. The roster DOM changes only when its displayed content changes.

## Pickups

`lib/curve-items.js` spawns a pickup after one playing second, then every three seconds while fewer than three are present. Pickups expire after 18 playing seconds and avoid nearby heads, other items, and occupied trail pixels. The first alive player within 16 arena units collects one; clients cannot grant themselves effects.

| Item | Effect |
| --- | --- |
| Shield ◇ | Ignore trails for 6 seconds. Walls remain lethal. |
| Slow − | 65% speed for 6 seconds. |
| Rush + | 145% speed for 6 seconds. |
| Tight turn ↶ | 160% turn rate for 6 seconds. |
| Eraser × | Immediately clears all trail pixels, collision occupancy, and synchronized trail history. |

One timed effect per player: a new timed pickup replaces the old one. Erasing does not cancel a timed effect. Simulation time controls both effect and pickup expiry. A player sees their effect and remaining time; the roster shows other players' effects, and pickup notices are shared.

## Engine provenance and generation

`games/vendor/zatacka/README.md` records upstream and modifications. After editing the TypeScript source, use Node 24:

```sh
node scripts/build-curve-engine.cjs
```

Ship the generated CommonJS file too; production does not invoke TypeScript stripping or need a build dependency.

## Checks

```sh
node --test tests/unit/curve-items.test.cjs
npm test
npm run lint:ui
```

Baseline before this upgrade: **339 passing** end-to-end checks. Game coverage adds ten independent browser seats, refusal of an eleventh, unique colours/slots, full-snapshot reconnect, delayed-input prediction, and sequence/generation handling; existing solo/countdown/stable-result coverage remains. Unit tests exercise pickup mechanics, expiry, shield/wall collision, exclusive collection and eraser collision/history reset.

Local samples on 2026-11-26 (not public-internet performance guarantees):

- One browser rendering a ten-player room: median / p95 animation-frame intervals **16.7 / 16.7 ms**.
- Ten simultaneously rendering Chromium contexts on the same host: **66.6 / 99.9 ms**. This shared-renderer stress case is not equivalent to ten separate devices and is not claimed to run at 60 fps.
- Ten-player stream updates averaged **2.4 KB** in that stress sample (~48 KB/sec per connected viewer at 20 Hz).
- With steering requests deliberately delayed **500 ms**, the local player changed heading by **0.33 radians within 121 ms**, before the server received that input.

Mobile layout was checked at 390 px: no horizontal overflow, ten visible roster entries, and 64 px minimum-height steering controls. Fullscreen and reduced-motion preferences do not change gameplay.

Desktop rooms fit the available viewport with a compact header and a large arena; 1440×900 and 1512×982 are the primary laptop checks. The sidebar can scroll independently. Fullscreen provides the largest 16:10 arena that fits, without stretching the game coordinates.


## Fullscreen-first arena (2026-11-26 follow-up)

The shared world is now **1600×1000**, about **2.6× the old 960×640 area**. Speed and trail thickness remain in world coordinates; windowed mode shows the entire same field at a smaller scale, not a different game or a cropped camera. Field metadata drives canvas sizing; pickup spawning and collision lookup use the actual occupancy dimensions.

Desktop fullscreen reserves only a slim top HUD and hides steering buttons and the lower hint rows. Touch devices keep their steering controls. **F** toggles fullscreen in the room, including during countdown; it ignores text editing, browser modifier shortcuts, and repeated keydown events. The host has a start/rematch action inside fullscreen, and final score text is visible there too.

The fullscreen button pulses in the lobby and countdown, never during active play or while already fullscreen. Reduced-motion users get a static highlighted outline instead. The shortcut appears on the control and in the windowed-mode hint. On laptop checks, fullscreen must increase arena width at least 20% over windowed mode, use over 90% of the 982 px viewport height, and keep the complete field on screen.


Isolated follow-up measurement (one rendering client, ten active players throughout, 1512×982 viewport): the 1600×1000 world rendered at **16.7 ms median and p95** over 1400 ms. Visible arena geometry was **1473×921 fullscreen** versus **1147×717 windowed**. The fullscreen sample is local, not an internet-latency guarantee. Follow-up checks: **349 end-to-end passes**, **6 platform-inapplicable skips**, **7 unit passes**, and clean UI lint.

## Player identity, heading and room totals

Your coloured, numbered identity stays in the arena HUD, with a matching highlighted roster row. Before the first start and throughout countdown, a prominent YOU marker and arrow identify your spawn and initial travel direction. The lobby preview uses a server-generated seed; starting reconstructs that same deterministic simulation, so the displayed position and heading are the actual start. Joining or leaving updates everyone's lobby preview. A fresh seed is prepared after each completed round for the next rematch.

Scores now have separate per-round and cumulative fields. `score` is the current/latest round; `totalScore` and `roundsPlayed` are credited exactly once at the end of a round. Rematches reset the round score only, and seat-token reconnects preserve totals. The roster shows room totals and the result shows the latest round's contribution. These totals belong to the in-memory room/seat, not a permanent account; leaving a seat or server restart does not preserve them.

Verification for identity/heading/totals: **352 end-to-end passes**, **7 explicit platform/duplicate skips**, **7 unit passes**, and clean UI lint. Independent desktop and touch contexts verify each user's own identity and a lobby spawn/heading that matches countdown. A two-round room test verifies additive scores, reconnect retention, round resets, and no second credit after the result has settled.
