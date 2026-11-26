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

Desktop rooms fit the available viewport with a compact header and a large arena; 1440×900 and 1512×982 are the primary laptop checks. The sidebar can scroll independently. Fullscreen provides the largest 3:2 arena that fits, without stretching the game coordinates.
