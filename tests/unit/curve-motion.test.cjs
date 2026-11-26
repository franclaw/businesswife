const { test } = require('node:test');
const assert = require('node:assert/strict');
const { follow, forecast, project, normalize } = require('../../games/motion');
const field = { speed: 108, turnRate: 2.85 };
const pose = { x: 800, y: 500, yaw: 0, alive: true, turn: 0 };

test('large corrections are bounded at every frame and eventually reach the authoritative crash point', () => {
  for (const effect of [null, { type: 'slow' }, { type: 'haste' }]) {
    const velocity = 108 * (effect?.type === 'slow' ? .65 : effect?.type === 'haste' ? 1.45 : 1);
    const target = { ...pose, x: 850, alive: false, effect };
    let view = { ...pose };
    for (let i = 0; i < 240; i++) {
      const next = follow(view, target, 1 / 60, field);
      assert.ok(Math.hypot(next.x - view.x, next.y - view.y) <= velocity / 60 * 1.35 + 1e-9);
      view = next;
    }
    assert.ok(Math.hypot(view.x - target.x, view.y - target.y) < .01);
  }
});
test('unacknowledged steering cannot build up an unlimited alternate path', () => {
  let view = { ...pose }, maxError = 0;
  for (let tick = 0; tick < 120; tick++) {
    const authority = project(pose, tick / 60, 0, field);
    const target = { ...pose, ...project(authority, .12, -1, field) };
    const next = follow(view, target, 1 / 60, field, -1);
    assert.ok(Math.hypot(next.x - view.x, next.y - view.y) <= 108 / 60 * 1.35 + 1e-9);
    view = next; maxError = Math.max(maxError, Math.hypot(view.x - authority.x, view.y - authority.y));
  }
  assert.ok(maxError < 25, `prediction error ${maxError}`);
});
test('remote extrapolation stops after 100ms and dead players never extrapolate', () => {
  assert.deepEqual(forecast(pose, .1, field), forecast(pose, 10, field));
  assert.equal(forecast({ ...pose, alive: false }, 10, field).y, pose.y);
  assert.equal(forecast(pose, -1, field).y, pose.y);
});
test('a reversed authoritative heading cannot rotate the view in one snap', () => {
  const next = follow(pose, { ...pose, yaw: Math.PI }, 1 / 60, field);
  assert.ok(Math.abs(next.yaw) <= field.turnRate * 2 / 60);
  const wrapped = follow({ ...pose, yaw: Math.PI - .01 }, { ...pose, yaw: -Math.PI + .01 }, 1 / 60, field);
  assert.ok(Math.abs(normalize(wrapped.yaw - Math.PI)) < .02);
});
