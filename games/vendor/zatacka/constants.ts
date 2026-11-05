export const FIELD_W = 960;
export const FIELD_H = 640;
export const BORDER = 10;
export const RADIUS = 2.35;
export const LOOKAHEAD = 3.4;
export const BASE_SPEED = 108;
export const BASE_TURN = 2.85;
export const SPAWN_GRACE = 0.55;
export const COUNTDOWN_S = 3;
export const ROUND_END_S = 1.6;
export const HOLE_DURATION = 0.145;
export const HOLE_MIN = 0.55;
export const HOLE_MAX = 1.25;
export const FIXED_DT = 1 / 60;
export const MAX_PLAYERS = 6;
export const MAX_BARRIERS = 18;

export type PlayerKind = "human" | "bot" | "off" | "remote";

export type PlayerColor = {
  id: string;
  name: string;
  fill: string;
  dim: string;
};

export const PLAYER_COLORS: PlayerColor[] = [
  { id: "blue", name: "Blue", fill: "#5b7cff", dim: "#3a54b8" },
  { id: "red", name: "Red", fill: "#ff4d4d", dim: "#b33535" },
  { id: "gold", name: "Gold", fill: "#e8c547", dim: "#a88a28" },
  { id: "green", name: "Green", fill: "#3dcc6e", dim: "#2a8f4c" },
  { id: "pink", name: "Pink", fill: "#e0569a", dim: "#9c3a6b" },
  { id: "ice", name: "Ice", fill: "#e8e8ed", dim: "#9a9aa3" },
];

export const TITLE_LETTERS: { ch: string; color: string }[] = [
  { ch: "Z", color: PLAYER_COLORS[0].fill },
  { ch: "A", color: PLAYER_COLORS[1].fill },
  { ch: "T", color: PLAYER_COLORS[2].fill },
  { ch: "A", color: PLAYER_COLORS[3].fill },
  { ch: "C", color: PLAYER_COLORS[4].fill },
  { ch: "K", color: PLAYER_COLORS[5].fill },
  { ch: "A", color: PLAYER_COLORS[0].fill },
];

export type KeyBind = { left: string; right: string; label: string };

export const DEFAULT_BINDS: KeyBind[] = [
  { left: "ArrowLeft", right: "ArrowRight", label: "← →" },
  { left: "KeyA", right: "KeyD", label: "A D" },
  { left: "KeyJ", right: "KeyL", label: "J L" },
  { left: "Numpad4", right: "Numpad6", label: "4 6" },
  { left: "KeyC", right: "KeyV", label: "C V" },
  { left: "KeyN", right: "KeyM", label: "N M" },
];

export function codeLabel(code: string): string {
  const map: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Numpad4: "Num4",
    Numpad6: "Num6",
    Space: "Space",
  };
  if (map[code]) return map[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export function genRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
