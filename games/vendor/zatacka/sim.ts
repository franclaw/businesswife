import {
  BORDER,
  BASE_SPEED,
  BASE_TURN,
  COUNTDOWN_S,
  FIELD_H,
  FIELD_W,
  FIXED_DT,
  HOLE_DURATION,
  HOLE_MAX,
  HOLE_MIN,
  LOOKAHEAD,
  PLAYER_COLORS,
  RADIUS,
  ROUND_END_S,
  SPAWN_GRACE,
  mulberry32,
  type PlayerKind,
} from "./constants";

export type Worm = {
  id: string;
  name: string;
  color: string;
  dim: string;
  kind: PlayerKind;
  x: number;
  y: number;
  yaw: number;
  alive: boolean;
  inHole: boolean;
  holeIn: number;
  left: boolean;
  right: boolean;
  score: number;
  botHold: number;
  botDir: number;
};

export type SimEvent =
  | { type: "death"; id: string; x: number; y: number; color: string }
  | { type: "round-end"; winnerId: string | null }
  | { type: "match-end"; winnerId: string }
  | { type: "countdown"; n: number }
  | { type: "go" };

export type Phase = "countdown" | "playing" | "roundend" | "matchend";

export type SimSettings = {
  speed: number;
  holes: boolean;
  barriers: number;
  targetScore: number;
};

export type Occupancy = {
  w: number;
  h: number;
  data: Uint8Array;
};

export function makeOccupancy(w = FIELD_W, h = FIELD_H): Occupancy {
  return { w, h, data: new Uint8Array(w * h) };
}

function stamp(occ: Occupancy, cx: number, cy: number, r: number) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(occ.w - 1, Math.ceil(cx + r));
  const y1 = Math.min(occ.h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const row = y * occ.w;
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy <= r2) occ.data[row + x] = 1;
    }
  }
}

function stampRect(occ: Occupancy, x: number, y: number, w: number, h: number) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(occ.w - 1, Math.ceil(x + w));
  const y1 = Math.min(occ.h - 1, Math.ceil(y + h));
  for (let py = y0; py <= y1; py++) {
    const row = py * occ.w;
    for (let px = x0; px <= x1; px++) occ.data[row + px] = 1;
  }
}

function hits(occ: Occupancy, cx: number, cy: number, r: number): boolean {
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(occ.w - 1, Math.ceil(cx + r));
  const y1 = Math.min(occ.h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const row = y * occ.w;
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy <= r2 && occ.data[row + x]) return true;
    }
  }
  return false;
}

function inArena(x: number, y: number): boolean {
  return x >= BORDER && y >= BORDER && x < FIELD_W - BORDER && y < FIELD_H - BORDER;
}

function rayClear(occ: Occupancy, x: number, y: number, yaw: number, max: number): number {
  const fx = -Math.sin(yaw);
  const fy = -Math.cos(yaw);
  const step = 3;
  for (let d = 4; d <= max; d += step) {
    const px = x + fx * d;
    const py = y + fy * d;
    if (!inArena(px, py) || hits(occ, px, py, 1.1)) return d;
  }
  return max;
}

export type Barrier = { x: number; y: number; w: number; h: number };

export class Sim {
  worms: Worm[] = [];
  occ = makeOccupancy();
  barriers: Barrier[] = [];
  phase: Phase = "countdown";
  phaseT = 0;
  time = 0;
  tick = 0;
  round = 1;
  settings: SimSettings;
  rng: () => number;
  events: SimEvent[] = [];
  speed: number;
  turnRate: number;
  startedAlive = 0;
  lastCountdown = 3;
  paused = false;

  constructor(settings: SimSettings, seed: number, worms: Omit<Worm, "x" | "y" | "yaw" | "alive" | "inHole" | "holeIn" | "left" | "right" | "botHold" | "botDir">[]) {
    this.settings = settings;
    this.rng = mulberry32(seed);
    this.speed = BASE_SPEED * settings.speed;
    this.turnRate = BASE_TURN * (0.7 + settings.speed * 0.3);
    this.worms = worms.map((w) => ({
      ...w,
      x: 0,
      y: 0,
      yaw: 0,
      alive: true,
      inHole: false,
      holeIn: 0,
      left: false,
      right: false,
      botHold: 0,
      botDir: 0,
    }));
    this.spawnAll();
    this.placeBarriers();
    this.startedAlive = this.worms.filter((w) => w.kind !== "off").length;
    this.events.push({ type: "countdown", n: 3 });
  }

  drain(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private spawnAll() {
    const inset = 90;
    for (const w of this.worms) {
      if (w.kind === "off") {
        w.alive = false;
        continue;
      }
      let ok = false;
      for (let tries = 0; tries < 40 && !ok; tries++) {
        w.x = inset + this.rng() * (FIELD_W - inset * 2);
        w.y = inset + this.rng() * (FIELD_H - inset * 2);
        ok = this.worms.every(
          (o) => o === w || o.kind === "off" || Math.hypot(o.x - w.x, o.y - w.y) > 70,
        );
      }
      w.yaw = this.rng() * Math.PI * 2;
      w.alive = true;
      w.inHole = false;
      w.left = false;
      w.right = false;
      w.holeIn = HOLE_MIN + this.rng() * (HOLE_MAX - HOLE_MIN);
      w.botHold = 0;
      w.botDir = 0;
    }
  }

  private placeBarriers() {
    this.barriers = [];
    const n = this.settings.barriers;
    for (let i = 0; i < n; i++) {
      const w = 10 + this.rng() * 22;
      const h = 10 + this.rng() * 18;
      const x = 40 + this.rng() * (FIELD_W - 80 - w);
      const y = 40 + this.rng() * (FIELD_H - 80 - h);
      this.barriers.push({ x, y, w, h });
      stampRect(this.occ, x, y, w, h);
    }
  }

  resetRound(seed: number) {
    this.rng = mulberry32(seed);
    this.occ.data.fill(0);
    this.time = 0;
    this.tick = 0;
    this.phase = "countdown";
    this.phaseT = 0;
    this.lastCountdown = 3;
    this.round += 1;
    this.spawnAll();
    this.placeBarriers();
    this.startedAlive = this.worms.filter((w) => w.kind !== "off").length;
    this.events.push({ type: "countdown", n: 3 });
  }

  setInput(id: string, left: boolean, right: boolean) {
    const w = this.worms.find((x) => x.id === id);
    if (!w || w.kind === "bot") return;
    w.left = left;
    w.right = right;
  }

  step(dt: number) {
    if (this.paused) return;
    if (this.phase === "matchend") return;

    this.phaseT += dt;

    if (this.phase === "countdown") {
      const left = Math.ceil(COUNTDOWN_S - this.phaseT);
      if (left !== this.lastCountdown && left >= 1) {
        this.lastCountdown = left;
        this.events.push({ type: "countdown", n: left });
      }
      if (this.phaseT >= COUNTDOWN_S) {
        this.phase = "playing";
        this.phaseT = 0;
        this.events.push({ type: "go" });
      }
      return;
    }

    if (this.phase === "roundend") {
      if (this.phaseT >= ROUND_END_S) {
        const winner = this.matchWinner();
        if (winner) {
          this.phase = "matchend";
          this.events.push({ type: "match-end", winnerId: winner.id });
        } else {
          this.resetRound((this.rng() * 1e9) | 0);
        }
      }
      return;
    }

    this.time += dt;
    this.tick += 1;

    for (const w of this.worms) {
      if (!w.alive) continue;
      if (w.kind === "bot") this.thinkBot(w, dt);
      this.advance(w, dt);
    }

    const alive = this.worms.filter((w) => w.alive);
    if (alive.length <= 1 && this.startedAlive >= 2) {
      this.phase = "roundend";
      this.phaseT = 0;
      this.events.push({ type: "round-end", winnerId: alive[0]?.id ?? null });
    }
  }

  private matchWinner(): Worm | null {
    const target = this.settings.targetScore;
    let best: Worm | null = null;
    for (const w of this.worms) {
      if (w.kind === "off") continue;
      if (w.score >= target && (!best || w.score > best.score)) best = w;
    }
    return best;
  }

  private thinkBot(w: Worm, dt: number) {
    w.botHold -= dt;
    if (w.botHold > 0) {
      w.left = w.botDir > 0;
      w.right = w.botDir < 0;
      return;
    }
    const max = 72;
    const ahead = rayClear(this.occ, w.x, w.y, w.yaw, max);
    const left = rayClear(this.occ, w.x, w.y, w.yaw + 0.55, max);
    const right = rayClear(this.occ, w.x, w.y, w.yaw - 0.55, max);
    const left2 = rayClear(this.occ, w.x, w.y, w.yaw + 1.05, max * 0.7);
    const right2 = rayClear(this.occ, w.x, w.y, w.yaw - 1.05, max * 0.7);

    let dir = 0;
    if (ahead < 34 || Math.min(left, right) < 18) {
      const L = left + left2 * 0.6;
      const R = right + right2 * 0.6;
      dir = L > R + 2 ? 1 : R > L + 2 ? -1 : this.rng() < 0.5 ? 1 : -1;
      w.botHold = 0.08 + this.rng() * 0.16;
    } else if (this.rng() < 0.04) {
      dir = this.rng() < 0.5 ? 1 : -1;
      w.botHold = 0.04 + this.rng() * 0.08;
    } else {
      w.botHold = 0.05;
    }
    w.botDir = dir;
    w.left = dir > 0;
    w.right = dir < 0;
  }

  private advance(w: Worm, dt: number) {
    let steer = 0;
    if (w.left) steer += 1;
    if (w.right) steer -= 1;
    w.yaw += steer * this.turnRate * dt;

    if (this.settings.holes) {
      w.holeIn -= dt;
      if (w.holeIn <= 0) {
        if (w.inHole) {
          w.inHole = false;
          w.holeIn = HOLE_MIN + this.rng() * (HOLE_MAX - HOLE_MIN);
        } else {
          w.inHole = true;
          w.holeIn = HOLE_DURATION;
        }
      }
    } else {
      w.inHole = false;
    }

    const dist = this.speed * dt;
    const n = Math.max(1, Math.ceil(dist / 0.7));
    const step = dist / n;
    const fx = -Math.sin(w.yaw);
    const fy = -Math.cos(w.yaw);

    for (let i = 0; i < n; i++) {
      w.x += fx * step;
      w.y += fy * step;
      const lx = w.x + fx * LOOKAHEAD;
      const ly = w.y + fy * LOOKAHEAD;
      const grace = this.time < SPAWN_GRACE;
      if (!inArena(lx, ly) || (!grace && hits(this.occ, lx, ly, 1.05))) {
        this.kill(w);
        return;
      }
      if (!w.inHole) stamp(this.occ, w.x, w.y, RADIUS);
    }
  }

  private kill(w: Worm) {
    if (!w.alive) return;
    w.alive = false;
    w.inHole = false;
    for (const o of this.worms) {
      if (o.alive) o.score += 1;
    }
    this.events.push({ type: "death", id: w.id, x: w.x, y: w.y, color: w.color });
  }
}

export function wormTemplate(
  id: string,
  name: string,
  colorIndex: number,
  kind: PlayerKind,
  score = 0,
): Omit<Worm, "x" | "y" | "yaw" | "alive" | "inHole" | "holeIn" | "left" | "right" | "botHold" | "botDir"> {
  const c = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length]!;
  return { id, name, color: c.fill, dim: c.dim, kind, score };
}
