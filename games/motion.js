// Shared, deterministic rendering math. The server still owns collisions.
(function (root) {
  'use strict';
  const normalize = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
  function speed(p, field) { return field.speed * (p.effect?.type === 'slow' ? .65 : p.effect?.type === 'haste' ? 1.45 : 1); }
  function project(p, dt, turn, field) {
    const result = { x: p.x, y: p.y, yaw: p.yaw };
    const steps = Math.max(1, Math.ceil(dt * 60)), d = dt / steps;
    const turnRate = field.turnRate * (p.effect?.type === 'turn' ? 1.6 : 1);
    for (let i = 0; i < steps; i++) {
      result.yaw -= turn * turnRate * d;
      result.x -= Math.sin(result.yaw) * speed(p, field) * d;
      result.y -= Math.cos(result.yaw) * speed(p, field) * d;
    }
    return result;
  }
  function limit(dx, dy, max) {
    const distance = Math.hypot(dx, dy), scale = distance > max ? max / distance : 1;
    return { x: dx * scale, y: dy * scale };
  }
  // Never teleport within a round, even after a long stall or input correction.
  function follow(current, target, dt, field, turn = null) {
    if (!current) return { x: target.x, y: target.y, yaw: target.yaw };
    const velocity = speed(target, field);
    const next = turn === null ? current : project({ ...target, ...current }, dt, turn, field);
    const blend = 1 - Math.exp(-dt * 20);
    const correction = limit((target.x - next.x) * blend, (target.y - next.y) * blend, velocity * dt);
    const movement = limit(next.x + correction.x - current.x, next.y + correction.y - current.y, velocity * dt * 1.35);
    const yawCorrection = normalize(target.yaw - next.yaw) * blend;
    const maxYaw = field.turnRate * (target.effect?.type === 'turn' ? 1.6 : 1) * dt * 2;
    return { x: current.x + movement.x, y: current.y + movement.y, yaw: next.yaw + Math.max(-maxYaw, Math.min(maxYaw, yawCorrection)) };
  }
  function forecast(p, age, field) {
    return { ...p, ...project(p, p.alive ? Math.min(.1, Math.max(0, age)) : 0, p.turn, field) };
  }
  const api = { normalize, project, follow, forecast };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CurveMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
