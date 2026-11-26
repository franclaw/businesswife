// Server-owned pickups. Simulation time, not wall time, controls expiry.
const crypto = require('node:crypto');
const id = () => crypto.randomBytes(4).toString('hex');
const ITEM_TYPES = ['shield', 'slow', 'haste', 'turn'];
// Erasers have half their old 20% chance, and only in one-/two-seat rooms.
function itemType(room, roll) {
  if (room.players.length >= 3) return ITEM_TYPES[Math.floor(roll * ITEM_TYPES.length)];
  return roll < .1 ? 'erase' : ITEM_TYPES[Math.floor((roll - .1) / .9 * ITEM_TYPES.length)];
}

function spawnItem(room) {
  const sim = room.sim;
  for (let tries = 0; tries < 40; tries++) {
    const x = Math.round(50 + sim.rng() * (sim.occ.w - 100)), y = Math.round(50 + sim.rng() * (sim.occ.h - 100));
    // Keep pickups clear of trails, heads, walls, and other pickups.
    if (sim.worms.some(w => Math.hypot(w.x - x, w.y - y) < 65) || room.items.some(i => Math.hypot(i.x - x, i.y - y) < 65)) continue;
    let occupied = false;
    for (let dy = -16; dy <= 16; dy += 4) for (let dx = -16; dx <= 16; dx += 4) if (sim.occ.data[(y + dy) * sim.occ.w + x + dx]) occupied = true;
    if (occupied) continue;
    room.items.push({ id: id(), type: itemType(room, sim.rng()), x, y, expires: sim.time + 18 });
    return;
  }
}

function collectItems(room) {
  const sim = room.sim;
  room.items = room.items.filter(item => item.expires > sim.time && (item.type !== 'erase' || room.players.length < 3));
  if (sim.time >= room.nextItem && room.items.length < 3) { spawnItem(room); room.nextItem = sim.time + 3; }
  for (const p of room.players) {
    const w = sim.worms.find(w => w.id === p.id);
    if (!w.alive) continue;
    const item = room.items.find(i => Math.hypot(w.x - i.x, w.y - i.y) < 16);
    if (item) {
      room.items = room.items.filter(i => i !== item);
      room.pickupNotice = { id: item.id, name: p.name || w.name, type: item.type, at: sim.time };
      if (item.type === 'erase') { sim.occ.data.fill(0); room.trails = []; room.sent = 0; room.trailEpoch++; }
      else p.effect = { type: item.type, until: sim.time + 6 };
    }
    if (p.effect && sim.time >= p.effect.until) p.effect = null;
    w.speedMultiplier = p.effect?.type === 'slow' ? .65 : p.effect?.type === 'haste' ? 1.45 : 1;
    w.turnMultiplier = p.effect?.type === 'turn' ? 1.6 : 1;
    w.shield = p.effect?.type === 'shield';
  }
}

module.exports = { collectItems };
