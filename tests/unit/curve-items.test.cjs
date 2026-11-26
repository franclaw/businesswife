const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Sim, wormTemplate } = require('../../games/vendor/zatacka/engine.cjs');
const { collectItems } = require('../../lib/curve-items');
function fixture(type) {
  const sim = new Sim({ speed: 1, holes: false, barriers: 0, targetScore: 5 }, 42, [wormTemplate('p', 'Player', 0, 'human')]);
  sim.phase = 'playing'; sim.time = 1;
  const w = sim.worms[0]; Object.assign(w, { x: 400, y: 320, yaw: Math.PI / 2 });
  return { sim, players: [{ id: 'p', effect: null }], items: [{ id: 'item', type, x: 400, y: 320, expires: 10 }], nextItem: 100, trails: [[0, 20, 20]], sent: 1, trailEpoch: 0 };
}
for (const [type, multiplier] of [['slow', .65], ['haste', 1.45]]) test(`${type} changes travel distance and expires after six simulation seconds`, () => {
  const r = fixture(type); collectItems(r); const w = r.sim.worms[0];
  r.sim.step(1 / 60); assert.ok(Math.abs((400 - w.x) - 108 * multiplier / 60) < .001);
  assert.equal(r.items.length, 0); assert.equal(r.players[0].effect.type, type);
  r.sim.time = 7.01; collectItems(r); assert.equal(w.speedMultiplier, 1); assert.equal(r.players[0].effect, null);
});
test('tight-turn pickup increases curvature and expires', () => {
  const r = fixture('turn'); collectItems(r); const w = r.sim.worms[0]; w.left = true;
  r.sim.step(1 / 60); assert.ok(Math.abs(w.yaw - Math.PI / 2 - 2.85 * 1.6 / 60) < .001);
  r.sim.time = 7.01; collectItems(r); assert.equal(w.turnMultiplier, 1);
});
test('shield crosses trails but never grants immunity to walls', () => {
  const r = fixture('shield'); collectItems(r); r.sim.occ.data.fill(1);
  r.sim.step(1 / 60); assert.equal(r.sim.worms[0].alive, true);
  r.sim.worms[0].x = 11; r.sim.step(1 / 60); assert.equal(r.sim.worms[0].alive, false);
});
test('eraser resets collision occupancy and synchronized trail history together', () => {
  const r = fixture('erase'); r.sim.occ.data.fill(1); collectItems(r);
  assert.equal(r.sim.occ.data.some(Boolean), false); assert.deepEqual(r.trails, []);
  assert.equal(r.sent, 0); assert.equal(r.trailEpoch, 1); assert.equal(r.items.length, 0);
});
test('only one player can collect an item and expired items cannot be collected', () => {
  const r = fixture('shield'); r.players.push({ id: 'q', effect: null }); r.sim.worms.push({ ...r.sim.worms[0], id: 'q' });
  collectItems(r); assert.equal(r.players[0].effect.type, 'shield'); assert.equal(r.players[1].effect, null);
  const expired = fixture('haste'); expired.items[0].expires = .5; collectItems(expired); assert.equal(expired.players[0].effect, null);
});

test('larger world keeps collision occupancy and spawns pickups beyond the old boundary', () => {
  const r = fixture('slow');
  assert.equal(r.sim.occ.w, 1600); assert.equal(r.sim.occ.h, 1000);
  assert.equal(r.sim.occ.data.length, 1600000);
  r.items = []; r.nextItem = 0; r.sim.rng = () => .9;
  collectItems(r); assert.equal(r.items.length, 1);
  const item = r.items[0]; assert.ok(item.x > 960 && item.y > 640);
  assert.ok(item.x < 1550 && item.y < 950);
  r.items = []; r.nextItem = 0;
  r.sim.occ.data[item.y * r.sim.occ.w + item.x] = 1;
  collectItems(r); assert.equal(r.items.length, 0, 'new-area trail cells must prevent spawning a pickup');
});


test('erasers occur at 10% for one or two players and never at three or ten, even after eliminations', () => {
  for (const count of [1, 2, 3, 10]) {
    const r = fixture('slow');
    while (r.players.length < count) {
      const id = 'p' + r.players.length;
      r.players.push({ id, effect: null });
      r.sim.worms.push({ ...r.sim.worms[0], id, alive: false });
    }
    const types = [];
    for (let i = 0; i < 100; i++) {
      r.items = []; r.nextItem = 0;
      const draws = [.8, .8, (i + .5) / 100];
      r.sim.rng = () => draws.shift();
      collectItems(r);
      assert.equal(r.items.length, 1);
      types.push(r.items[0].type);
    }
    assert.equal(types.filter(t => t === 'erase').length, count < 3 ? 10 : 0);
    for (const type of ['shield', 'slow', 'haste', 'turn']) assert.ok(types.includes(type));
  }
});
test('a three-player room cannot collect a stale eraser or clear existing trails', () => {
  const r = fixture('erase');
  for (const id of ['q', 's']) {
    r.players.push({ id, effect: null });
    r.sim.worms.push({ ...r.sim.worms[0], id, alive: false });
  }
  r.sim.occ.data[20] = 1;
  collectItems(r);
  assert.equal(r.items.length, 0); assert.equal(r.trailEpoch, 0);
  assert.equal(r.sim.occ.data[20], 1); assert.deepEqual(r.trails, [[0, 20, 20]]);
  assert.equal(r.pickupNotice, undefined);
});
