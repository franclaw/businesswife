# Zatacka engine

`sim.ts` and `constants.ts` are from [Mani-QA/zatacka](https://github.com/Mani-QA/zatacka), commit `b21fccf9393deec348c106e21c0a83f547cdba80`, MIT licensed (see LICENSE). `engine.cjs` is a generated CommonJS conversion of these files. Business Wife provides its own room transport and presentation around the upstream simulation.

Business Wife modification: hole duration is 50% longer than upstream.

Additional Business Wife modifications: optional per-worm speed/turn multipliers and trail-only shield immunity support authoritative pickups. The server supplies ten colours independently of the upstream palette. Regenerate the CommonJS engine with `node scripts/build-curve-engine.cjs` using Node 24; no compiler is needed at runtime. See `docs/curve-club.md` for rules and network protocol.

Trail radius is now 1.5 arena pixels (3 px diameter), shared by the simulation and rendered trail.
