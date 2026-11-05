// Generated from Zatacka sim.ts and constants.ts; see LICENSE and README.
const FIELD_W = 960;
const FIELD_H = 640;
const BORDER = 10;
const RADIUS = 2.35;
const LOOKAHEAD = 3.4;
const BASE_SPEED = 108;
const BASE_TURN = 2.85;
const SPAWN_GRACE = 0.55;
const COUNTDOWN_S = 3;
const ROUND_END_S = 1.6;
const HOLE_DURATION = 0.2175;
const HOLE_MIN = 0.55;
const HOLE_MAX = 1.25;
const FIXED_DT = 1 / 60;
const MAX_PLAYERS = 6;
const MAX_BARRIERS = 18;
const PLAYER_COLORS = [
    {
        id: "blue",
        name: "Blue",
        fill: "#5b7cff",
        dim: "#3a54b8"
    },
    {
        id: "red",
        name: "Red",
        fill: "#ff4d4d",
        dim: "#b33535"
    },
    {
        id: "gold",
        name: "Gold",
        fill: "#e8c547",
        dim: "#a88a28"
    },
    {
        id: "green",
        name: "Green",
        fill: "#3dcc6e",
        dim: "#2a8f4c"
    },
    {
        id: "pink",
        name: "Pink",
        fill: "#e0569a",
        dim: "#9c3a6b"
    },
    {
        id: "ice",
        name: "Ice",
        fill: "#e8e8ed",
        dim: "#9a9aa3"
    }
];
const TITLE_LETTERS = [
    {
        ch: "Z",
        color: PLAYER_COLORS[0].fill
    },
    {
        ch: "A",
        color: PLAYER_COLORS[1].fill
    },
    {
        ch: "T",
        color: PLAYER_COLORS[2].fill
    },
    {
        ch: "A",
        color: PLAYER_COLORS[3].fill
    },
    {
        ch: "C",
        color: PLAYER_COLORS[4].fill
    },
    {
        ch: "K",
        color: PLAYER_COLORS[5].fill
    },
    {
        ch: "A",
        color: PLAYER_COLORS[0].fill
    }
];
const DEFAULT_BINDS = [
    {
        left: "ArrowLeft",
        right: "ArrowRight",
        label: "← →"
    },
    {
        left: "KeyA",
        right: "KeyD",
        label: "A D"
    },
    {
        left: "KeyJ",
        right: "KeyL",
        label: "J L"
    },
    {
        left: "Numpad4",
        right: "Numpad6",
        label: "4 6"
    },
    {
        left: "KeyC",
        right: "KeyV",
        label: "C V"
    },
    {
        left: "KeyN",
        right: "KeyM",
        label: "N M"
    }
];
function codeLabel(code) {
    const map = {
        ArrowLeft: "←",
        ArrowRight: "→",
        ArrowUp: "↑",
        ArrowDown: "↓",
        Numpad4: "Num4",
        Numpad6: "Num6",
        Space: "Space"
    };
    if (map[code]) return map[code];
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    return code;
}
function genRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for(let i = 0; i < 6; i++)out += alphabet[bytes[i] % alphabet.length];
    return out;
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return ()=>{
        a = a + 0x6d2b79f5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}


function makeOccupancy(w = FIELD_W, h = FIELD_H) {
    return {
        w,
        h,
        data: new Uint8Array(w * h)
    };
}
function stamp(occ, cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(occ.w - 1, Math.ceil(cx + r));
    const y1 = Math.min(occ.h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for(let y = y0; y <= y1; y++){
        const row = y * occ.w;
        const dy = y + 0.5 - cy;
        for(let x = x0; x <= x1; x++){
            const dx = x + 0.5 - cx;
            if (dx * dx + dy * dy <= r2) occ.data[row + x] = 1;
        }
    }
}
function stampRect(occ, x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(occ.w - 1, Math.ceil(x + w));
    const y1 = Math.min(occ.h - 1, Math.ceil(y + h));
    for(let py = y0; py <= y1; py++){
        const row = py * occ.w;
        for(let px = x0; px <= x1; px++)occ.data[row + px] = 1;
    }
}
function hits(occ, cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(occ.w - 1, Math.ceil(cx + r));
    const y1 = Math.min(occ.h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for(let y = y0; y <= y1; y++){
        const row = y * occ.w;
        const dy = y + 0.5 - cy;
        for(let x = x0; x <= x1; x++){
            const dx = x + 0.5 - cx;
            if (dx * dx + dy * dy <= r2 && occ.data[row + x]) return true;
        }
    }
    return false;
}
function inArena(x, y) {
    return x >= BORDER && y >= BORDER && x < FIELD_W - BORDER && y < FIELD_H - BORDER;
}
function rayClear(occ, x, y, yaw, max) {
    const fx = -Math.sin(yaw);
    const fy = -Math.cos(yaw);
    const step = 3;
    for(let d = 4; d <= max; d += step){
        const px = x + fx * d;
        const py = y + fy * d;
        if (!inArena(px, py) || hits(occ, px, py, 1.1)) return d;
    }
    return max;
}
class Sim {
    worms = [];
    occ = makeOccupancy();
    barriers = [];
    phase = "countdown";
    phaseT = 0;
    time = 0;
    tick = 0;
    round = 1;
    settings;
    rng;
    events = [];
    speed;
    turnRate;
    startedAlive = 0;
    lastCountdown = 3;
    paused = false;
    constructor(settings, seed, worms){
        this.settings = settings;
        this.rng = mulberry32(seed);
        this.speed = BASE_SPEED * settings.speed;
        this.turnRate = BASE_TURN * (0.7 + settings.speed * 0.3);
        this.worms = worms.map((w)=>({
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
                botDir: 0
            }));
        this.spawnAll();
        this.placeBarriers();
        this.startedAlive = this.worms.filter((w)=>w.kind !== "off").length;
        this.events.push({
            type: "countdown",
            n: 3
        });
    }
    drain() {
        const e = this.events;
        this.events = [];
        return e;
    }
    spawnAll() {
        const inset = 90;
        for (const w of this.worms){
            if (w.kind === "off") {
                w.alive = false;
                continue;
            }
            let ok = false;
            for(let tries = 0; tries < 40 && !ok; tries++){
                w.x = inset + this.rng() * (FIELD_W - inset * 2);
                w.y = inset + this.rng() * (FIELD_H - inset * 2);
                ok = this.worms.every((o)=>o === w || o.kind === "off" || Math.hypot(o.x - w.x, o.y - w.y) > 70);
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
    placeBarriers() {
        this.barriers = [];
        const n = this.settings.barriers;
        for(let i = 0; i < n; i++){
            const w = 10 + this.rng() * 22;
            const h = 10 + this.rng() * 18;
            const x = 40 + this.rng() * (FIELD_W - 80 - w);
            const y = 40 + this.rng() * (FIELD_H - 80 - h);
            this.barriers.push({
                x,
                y,
                w,
                h
            });
            stampRect(this.occ, x, y, w, h);
        }
    }
    resetRound(seed) {
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
        this.startedAlive = this.worms.filter((w)=>w.kind !== "off").length;
        this.events.push({
            type: "countdown",
            n: 3
        });
    }
    setInput(id, left, right) {
        const w = this.worms.find((x)=>x.id === id);
        if (!w || w.kind === "bot") return;
        w.left = left;
        w.right = right;
    }
    step(dt) {
        if (this.paused) return;
        if (this.phase === "matchend") return;
        this.phaseT += dt;
        if (this.phase === "countdown") {
            const left = Math.ceil(COUNTDOWN_S - this.phaseT);
            if (left !== this.lastCountdown && left >= 1) {
                this.lastCountdown = left;
                this.events.push({
                    type: "countdown",
                    n: left
                });
            }
            if (this.phaseT >= COUNTDOWN_S) {
                this.phase = "playing";
                this.phaseT = 0;
                this.events.push({
                    type: "go"
                });
            }
            return;
        }
        if (this.phase === "roundend") {
            if (this.phaseT >= ROUND_END_S) {
                const winner = this.matchWinner();
                if (winner) {
                    this.phase = "matchend";
                    this.events.push({
                        type: "match-end",
                        winnerId: winner.id
                    });
                } else {
                    this.resetRound(this.rng() * 1e9 | 0);
                }
            }
            return;
        }
        this.time += dt;
        this.tick += 1;
        for (const w of this.worms){
            if (!w.alive) continue;
            if (w.kind === "bot") this.thinkBot(w, dt);
            this.advance(w, dt);
        }
        const alive = this.worms.filter((w)=>w.alive);
        if (alive.length <= 1 && this.startedAlive >= 2) {
            this.phase = "roundend";
            this.phaseT = 0;
            this.events.push({
                type: "round-end",
                winnerId: alive[0]?.id ?? null
            });
        }
    }
    matchWinner() {
        const target = this.settings.targetScore;
        let best = null;
        for (const w of this.worms){
            if (w.kind === "off") continue;
            if (w.score >= target && (!best || w.score > best.score)) best = w;
        }
        return best;
    }
    thinkBot(w, dt) {
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
    advance(w, dt) {
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
        for(let i = 0; i < n; i++){
            w.x += fx * step;
            w.y += fy * step;
            const lx = w.x + fx * LOOKAHEAD;
            const ly = w.y + fy * LOOKAHEAD;
            const grace = this.time < SPAWN_GRACE;
            if (!inArena(lx, ly) || !grace && hits(this.occ, lx, ly, 1.05)) {
                this.kill(w);
                return;
            }
            if (!w.inHole) stamp(this.occ, w.x, w.y, RADIUS);
        }
    }
    kill(w) {
        if (!w.alive) return;
        w.alive = false;
        w.inHole = false;
        for (const o of this.worms){
            if (o.alive) o.score += 1;
        }
        this.events.push({
            type: "death",
            id: w.id,
            x: w.x,
            y: w.y,
            color: w.color
        });
    }
}
function wormTemplate(id, name, colorIndex, kind, score = 0) {
    const c = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
    return {
        id,
        name,
        color: c.fill,
        dim: c.dim,
        kind,
        score
    };
}

module.exports={Sim,wormTemplate,FIELD_W,FIELD_H,PLAYER_COLORS};
