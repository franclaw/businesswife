'use strict';
const $ = id => document.getElementById(id);
const roomId = location.pathname.match(/^\/games\/([a-f0-9]{8})\/?$/)?.[1];
const canvas = $('arena'), ctx = canvas.getContext('2d');
const layer = $('trail-layer');
const ink = layer.getContext('2d', { alpha: false });
const ITEMS = {
  shield: { glyph: '◇', name: 'Trail shield', color: '#84dfec' },
  slow: { glyph: '−', name: 'Slow motion', color: '#65d69b' },
  haste: { glyph: '+', name: 'Speed rush', color: '#ffa66e' },
  turn: { glyph: '↶', name: 'Tight turns', color: '#c6a0ff' },
  erase: { glyph: '×', name: 'Arena eraser', color: '#f4cd70' },
};
let me = null, game = null, source = null, held = 0, inputSeq = 0;
let receivedAt = 0, lastFrame = 0, dirty = true, connected = false, rtt = 0;
let rosterSignature = '', trailCount = 0, joining = false, sending = false;
let previousRects = [];
let fullscreenPending = false;
let localView = null, correction = { x: 0, y: 0, yaw: 0 }, rendered = new Map();
const keys = new Set(), pointers = new Map();

function saved(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
function error(message = '') { $('error').textContent = message; }
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not complete that action. Try again.');
  return data;
}
function clearArena() {
  const w = layer.width, h = layer.height, border = game?.field.border || 10;
  ink.fillStyle = '#151116'; ink.fillRect(0, 0, w, h);
  ink.fillStyle = '#332631';
  for (let x = 24; x < w; x += 24) for (let y = 24; y < h; y += 24) ink.fillRect(x, y, 1, 1);
  ink.strokeStyle = '#685060'; ink.lineWidth = 1; ink.strokeRect(border, border, w - border * 2, h - border * 2);
  dirty = true;
}
function normalize(angle) { return Math.atan2(Math.sin(angle), Math.cos(angle)); }
function project(p, dt, turn = p.turn) {
  const effect = p.effect?.type;
  const speed = game.field.speed * (effect === 'slow' ? .65 : effect === 'haste' ? 1.45 : 1);
  const turnRate = game.field.turnRate * (effect === 'turn' ? 1.6 : 1);
  const result = { x: p.x, y: p.y, yaw: p.yaw };
  const steps = Math.max(1, Math.ceil(dt * 120)), d = dt / steps;
  for (let i = 0; i < steps; i++) {
    result.yaw -= turn * turnRate * d;
    result.x -= Math.sin(result.yaw) * speed * d;
    result.y -= Math.cos(result.yaw) * speed * d;
  }
  return result;
}
function receive(g) {
  if (canvas.width !== g.field.width || canvas.height !== g.field.height) {
    canvas.width = layer.width = g.field.width; canvas.height = layer.height = g.field.height;
    previousRects = []; clearArena();
  }
  const fresh = !game || game.generation !== g.generation;
  const reset = fresh || g.full || game.trailEpoch !== g.trailEpoch;
  if (!reset && g.trailFrom !== trailCount) { connect(); return; }
  if (reset) { clearArena(); trailCount = 0; }
  const colors = new Map(g.players.map(p => [p.slot, p.color]));
  for (const [slot, x, y] of g.trails) {
    ink.fillStyle = colors.get(slot) || '#fff'; ink.beginPath(); ink.arc(x, y, g.field.radius, 0, Math.PI * 2); ink.fill();
  }
  if (!reset && game) { game.trails.push(...g.trails); g.trails = game.trails; }
  trailCount = g.trailTo;
  const previous = game; game = g; receivedAt = performance.now(); connected = true;
  const own = g.players.find(p => p.id === me?.id);
  if (fresh) { rendered.clear(); localView = null; correction = { x: 0, y: 0, yaw: 0 }; }
  if (own) {
    const target = project(own, g.countdown || g.phase !== 'playing' ? 0 : Math.min(rtt / 2000, .12));
    if (!localView || g.countdown || previous?.countdown || !own.alive || g.phase !== 'playing') localView = target;
    else {
      const dx = target.x - localView.x, dy = target.y - localView.y;
      if (Math.hypot(dx, dy) > 45) { localView = target; correction = { x: 0, y: 0, yaw: 0 }; }
      else
      correction = own.inputSeq < inputSeq && own.turn !== held ? { x: 0, y: 0, yaw: 0 } : { x: dx, y: dy, yaw: normalize(target.yaw - localView.yaw) };
    }
  }
  dirty = true; updateUI();
}
function updateUI() {
  if (!game) return;
  updateFullscreenUI();
  updateIdentity();
  const g = game, now = performance.now();
  const elapsed = g.elapsed + (g.phase === 'playing' && !g.countdown && connected ? Math.min((now - receivedAt) / 1000, .15) : 0);
  text('clock', `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`);
  const alive = g.players.filter(p => p.alive).length;
  text('alive-count', g.phase === 'lobby' ? `${g.players.length} on the floor` : `${alive} / ${g.players.length} alive`);
  text('phase-label', g.phase === 'lobby' ? 'LOBBY' : g.countdown ? 'GET READY' : g.phase === 'over' ? 'RESULTS' : 'LIVE');
  const signature = JSON.stringify([g.phase, g.countdown, g.host, g.winner, g.reason, g.players.map(p => [p.id, p.name, p.color, p.score, p.totalScore, p.roundsPlayed, p.alive, p.effect?.type, Math.ceil((p.effect?.until || 0) - elapsed)])]);
  if (signature !== rosterSignature) {
    rosterSignature = signature; text('count', `${g.players.length} / ${g.maxPlayers}`);
    const list = $('players'); list.replaceChildren();
    const players = g.phase === 'over' ? [...g.players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)) : g.players;
    for (const p of players) {
      const li = document.createElement('li'); li.dataset.playerId = p.id; li.className = g.phase === 'playing' && !p.alive ? 'out' : ''; li.classList.toggle('is-you', p.id === me?.id); if (p.id === me?.id) li.style.setProperty('--player-color', p.color);
      const seat = document.createElement('span'); seat.className = 'seat-number'; seat.style.color = p.color; seat.textContent = p.slot + 1;
      const name = document.createElement('span'); name.className = 'player-name'; name.textContent = p.name + (p.id === me?.id ? ' (you)' : '');
      const meta = document.createElement('span'); meta.className = 'player-meta';
      meta.textContent = p.effect && g.phase === 'playing' && p.alive ? `${ITEMS[p.effect.type].name} · ${Math.max(0, Math.ceil(p.effect.until - elapsed))}s` : p.id === g.winner ? 'Round winner' : g.phase === 'over' ? 'Finished' : g.phase === 'playing' && !p.alive ? 'Eliminated' : p.id === g.host ? 'Host' : 'Player';
      if (g.phase === 'over') meta.textContent += ` · +${g.solo ? p.score.toFixed(1) + ' sec' : p.score + ' pts'} this round`;
      name.append(meta);
      const score = document.createElement('span'); score.className = 'player-score'; score.title = 'Total across games in this room'; score.textContent = g.phase === 'lobby' ? 'Ready' : g.solo ? `${((p.totalScore || 0) + (g.phase === 'playing' ? elapsed : 0)).toFixed(1)} sec` : `${(p.totalScore || 0) + (g.phase === 'playing' ? p.score : 0)} pts`;
      li.append(seat, name, score); list.append(li);
    }
    const host = me?.id === g.host;
    $('start').hidden = !host || g.phase === 'playing'; $('start').disabled = sending || !connected;
    $('start').firstChild.textContent = g.phase === 'over' ? 'Play again ' : 'Start game ';
    $('leave').disabled = g.phase === 'playing';
    $('overlay').hidden = g.phase === 'playing' && !g.countdown;
    $('overlay').classList.toggle('countdown', !!g.countdown);
    const winner = g.players.find(p => p.id === g.winner);
    $('overlay').querySelector('strong').textContent = g.countdown ? String(g.countdown) : g.phase === 'over' ? (g.solo ? 'RUN COMPLETE' : winner ? `${winner.name} WINS` : 'IT’S A DRAW') : 'THE FLOOR IS YOURS';
    text('overlay-kicker', g.countdown ? 'FIND YOUR LINE' : g.phase === 'over' ? 'ROUND COMPLETE' : 'READY WHEN YOU ARE');
    text('overlay-detail', g.countdown ? (document.fullscreenElement ? 'Get ready. Keep your eyes on your colour.' : 'Press F for fullscreen. Find your colour.') : g.phase === 'over' ? (g.solo ? `${g.players[0].score.toFixed(1)} seconds on the floor` : 'Final scores are on the board. The host can start a rematch.') : (document.fullscreenElement ? 'Play solo or invite friends.' : 'Press F for the full-size field. Play solo or invite friends.'));
    if (document.fullscreenElement && g.phase === 'over' && !g.solo) text('overlay-detail', [...g.players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)).map(p => `${p.name}: ${p.totalScore || 0} pts (+${p.score})`).join(' · '));
    text('status', g.phase === 'playing' ? (g.solo ? 'Survive as long as you can.' : 'Last curve standing wins.') : g.phase === 'over' ? (g.solo ? 'Survival time shown above.' : 'Final scores shown above.') : host ? 'Your room is ready. Start solo or invite friends.' : 'Waiting for the host to start.');
    $('out-banner').hidden = g.phase !== 'playing' || !!g.countdown || !!g.players.find(p => p.id === me?.id)?.alive;
    if (g.phase !== 'playing') release();
  }
  $('pickup-notice').hidden = !g.pickupNotice || g.phase !== 'playing' || elapsed - g.pickupNotice.at > 2;
  if (g.pickupNotice) text('pickup-notice', `${g.pickupNotice.name} · ${ITEMS[g.pickupNotice.type].name}`);
  const own = g.players.find(p => p.id === me?.id);
  text('effect-status', own?.effect && own.alive && g.phase === 'playing' ? `${ITEMS[own.effect.type].glyph} ${ITEMS[own.effect.type].name} · ${Math.max(0, Math.ceil(own.effect.until - elapsed))}s` : 'Collect a power-up. Change the round.');
  if (!connected) setConnection('Reconnecting…', 'offline');
  else if (g.phase === 'playing' && now - receivedAt > 750) setConnection('Waiting for game…', 'connecting');
  else setConnection(rtt ? `Connected · ${Math.round(rtt)} ms` : 'Connected', 'live');
}
function updateIdentity() {
  const own = game.players.find(p => p.id === me?.id);
  $('your-player').hidden = !own;
  $('your-card').hidden = !own || (game.phase !== 'lobby' && !game.countdown);
  const preview = game.phase === 'lobby' && own?.spawn;
  $('spawn-marker').hidden = !own || (!preview && !game.countdown);
  if (!own) return;
  for (const id of ['your-player', 'your-card', 'spawn-marker']) $(id).style.setProperty('--player-color', own.color);
  text('your-number', `YOU · #${own.slot + 1}`); text('your-name', own.name);
  text('your-card-text', `#${own.slot + 1} · ${own.name} — YOU`);
  $('your-player').setAttribute('aria-label', `Your player: ${own.name}, number ${own.slot + 1}`);
  text('spawn-label', `YOU · #${own.slot + 1}`);
  if (preview || game.countdown) {
    const pose = preview || own;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const px = pose.x / game.field.width * width, py = pose.y / game.field.height * height;
    const arrowScale = Math.min(1, Math.max(.25, (Math.min(px, width - px, py, height - py) - 4) / 56));
    $('spawn-direction').style.transform = `rotate(${-pose.yaw * 180 / Math.PI}deg) scale(${arrowScale})`;
    const marker = $('spawn-marker');
    marker.style.left = `${pose.x / game.field.width * 100}%`;
    marker.style.top = `${pose.y / game.field.height * 100}%`;
    marker.classList.toggle('below', pose.y / game.field.height < .2);
    marker.classList.toggle('edge-left', pose.x / game.field.width < .16);
    marker.classList.toggle('edge-right', pose.x / game.field.width > .84);
  }
}
function setConnection(label, state) { text('connection', label); $('connection').dataset.state = state; }
function paint(now) {
  const dt = Math.min(.04, Math.max(0, (now - (lastFrame || now)) / 1000)); lastFrame = now;
  if (game && !document.hidden && (!$('room').hidden) && (dirty || game.phase === 'playing')) {
    dirty = false;
    for (const [x, y, w, h] of previousRects) ctx.clearRect(x, y, w, h);
    previousRects = [];
    for (const item of game.items || []) {
      const config = ITEMS[item.type];
      ctx.fillStyle = '#211824'; ctx.strokeStyle = config.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(item.x, item.y, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      previousRects.push([item.x - 16, item.y - 16, 32, 32]);
      ctx.font = '700 18px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = config.color; ctx.fillText(config.glyph, item.x, item.y + 1);
    }
    for (const p of game.players) {
      const preview = game.phase === 'lobby' && p.spawn;
      if (!preview && (!p.alive || game.phase !== 'playing')) continue;
      let pose;
      const playing = !game.countdown && connected && now - receivedAt < 250;
      if (preview) pose = preview;
      else if (p.id === me?.id) {
        if (playing) {
          const projected = project({ ...p, ...localView }, dt, held);
          const blend = 1 - Math.exp(-dt * 12);
          localView = { x: projected.x + correction.x * blend, y: projected.y + correction.y * blend, yaw: projected.yaw + correction.yaw * blend };
          correction.x *= 1 - blend; correction.y *= 1 - blend; correction.yaw *= 1 - blend;
        }
        pose = localView || p;
      } else pose = project(p, playing ? Math.min((now - receivedAt) / 1000, .1) : 0);
      rendered.set(p.id, pose);
      previousRects.push([Math.min(pose.x, p.x) - 16, Math.min(pose.y, p.y) - 30, Math.abs(pose.x - p.x) + 32, Math.abs(pose.y - p.y) + 46]);
      ctx.fillStyle = p.color;
      if (p.id === me?.id && playing && !p.inHole && Math.hypot(pose.x - p.x, pose.y - p.y) < 40) {
        ctx.strokeStyle = p.color; ctx.lineWidth = game.field.radius * 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(pose.x, pose.y); ctx.stroke();
      }
      if (p.effect?.type === 'shield' || p.id === me?.id) {
        ctx.strokeStyle = p.effect?.type === 'shield' ? '#84dfec' : '#f7edf0'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(pose.x, pose.y, p.effect?.type === 'shield' ? 10 : 8, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(pose.x, pose.y, 4, 0, Math.PI * 2); ctx.fill();
      if (preview || game.countdown) {
        ctx.font = '700 14px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(String(p.slot + 1), pose.x, pose.y - 12);
      }
    }
  }
  requestAnimationFrame(paint);
}
function connect() {
  source?.close(); connected = false; setConnection('Connecting…', 'connecting');
  source = new EventSource(`/games/api/rooms/${roomId}/events`);
  source.onmessage = event => { try { receive(JSON.parse(event.data)); } catch { error('Could not read the game update. Reconnecting…'); connect(); } };
  source.onerror = () => { connected = false; release(); setConnection('Reconnecting…', 'offline'); if (game) $('start').disabled = true; };
}
async function join() {
  if (joining) return; joining = true; $('create').disabled = true;
  try {
    me = await api(`/games/api/rooms/${roomId}/join`, { name: $('name').value.trim(), token: saved('curve-' + roomId)?.token });
    inputSeq = me.inputSeq || 0; sessionStorage.setItem('curve-' + roomId, JSON.stringify(me));
    $('home').hidden = true; $('room').hidden = false; document.body.classList.add('in-room');
    text('room-code', `ROOM ${roomId.toUpperCase()} · UP TO 10 PLAYERS`); error(); connect();
  } catch (e) { error(e.message); } finally { joining = false; $('create').disabled = false; }
}
$('entry').addEventListener('submit', async event => {
  event.preventDefault();
  if (roomId) return join();
  if (joining) return; joining = true; $('create').disabled = true;
  try {
    const name = $('name').value.trim(); if (!name) throw new Error('Enter your name.');
    const room = await api('/games/api/rooms', {}), player = await api(`/games/api/rooms/${room.id}/join`, { name });
    sessionStorage.setItem('curve-name', JSON.stringify(name)); sessionStorage.setItem('curve-' + room.id, JSON.stringify(player)); location.href = '/games/' + room.id;
  } catch (e) { error(e.message); joining = false; $('create').disabled = false; }
});
if (roomId) {
  $('create').textContent = 'Join room ↗'; text('entry-title', 'Your seat is waiting.');
  text('entry-copy', 'Pick your name and join the room. Your colour is assigned when you arrive.');
  const name = saved('curve-name'); if (typeof name === 'string') $('name').value = name;
  if (saved('curve-' + roomId)) join();
}
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); text('invite', 'Invite link copied. Send it to your rivals.'); }
  catch { text('invite', 'Copy this link: ' + location.href); }
});
async function startGame() {
  if (sending || !connected) return; sending = true; $('start').disabled = true; $('fullscreen-start').disabled = true; release();
  try { await api(`/games/api/rooms/${roomId}/start`, { token: me.token }); error(); }
  catch (e) { error(e.message); }
  finally { sending = false; rosterSignature = ''; updateUI(); }
}
$('start').addEventListener('click', startGame);
$('fullscreen-start').addEventListener('click', startGame);
$('leave').addEventListener('click', async () => {
  try { await api(`/games/api/rooms/${roomId}/leave`, { token: me.token }); source?.close(); sessionStorage.removeItem('curve-' + roomId); location.href = '/games'; }
  catch (e) { error(e.message); }
});
function updateFullscreenUI() {
  const full = document.fullscreenElement === $('play-stage');
  const desktop = matchMedia('(min-width: 851px) and (pointer: fine)').matches;
  $('fullscreen').classList.toggle('fullscreen-nudge', !full && !!game && (game.phase === 'lobby' || !!game.countdown));
  $('fullscreen').setAttribute('aria-label', full ? 'Exit fullscreen' : 'Enter fullscreen');
  $('fullscreen').title = full ? 'Exit fullscreen (F or Esc)' : 'Fullscreen (F)';
  text('fullscreen-label', full ? 'Exit fullscreen' : 'Fullscreen');
  text('view-hint', full ? 'Arrow keys or A / D · F or Esc to exit' : desktop ? 'Windowed overview · Press F for full-size play' : 'Zoomed-out view · Hold the steering buttons');
  $('fullscreen-start').hidden = !full || !game || me?.id !== game.host || game.phase === 'playing';
  $('fullscreen-start').disabled = sending || !connected;
  text('fullscreen-start', game?.phase === 'over' ? 'Play again' : 'Start game');
}
async function toggleFullscreen() {
  if (fullscreenPending || $('room').hidden) return;
  fullscreenPending = true;
  try {
    release();
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('play-stage').requestFullscreen) await $('play-stage').requestFullscreen();
    else throw new Error('Fullscreen is not available in this browser.');
  } catch (e) { error(e.message); }
  finally { fullscreenPending = false; }
}
$('fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => { release(); rosterSignature = ''; updateUI(); dirty = true; });
window.addEventListener('keydown', event => {
  if (event.key.toLowerCase() !== 'f' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || $('room').hidden) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  event.preventDefault(); toggleFullscreen();
});
async function sendTurn() {
  if (!me || !game) return;
  const seq = ++inputSeq, gen = game.generation, start = performance.now();
  try {
    const reply = await api(`/games/api/rooms/${roomId}/turn`, { token: me.token, turn: held, seq, generation: gen });
    if (reply.generation === game?.generation && reply.seq === seq) rtt = rtt ? rtt * .7 + (performance.now() - start) * .3 : performance.now() - start;
  } catch { setConnection('Input delayed. Reconnecting…', 'connecting'); }
}
function steering() {
  const left = keys.has('ArrowLeft') || keys.has('a') || [...pointers.values()].includes(-1);
  const right = keys.has('ArrowRight') || keys.has('d') || [...pointers.values()].includes(1);
  const next = Number(right) - Number(left);
  if (held !== next) { held = next; sendTurn(); }
  $('left').setAttribute('aria-pressed', String(left)); $('right').setAttribute('aria-pressed', String(right));
}
function release() { keys.clear(); pointers.clear(); steering(); }
for (const [id, dir] of [['left', -1], ['right', 1]]) {
  const button = $(id);
  button.addEventListener('pointerdown', event => { event.preventDefault(); if (game?.phase !== 'playing' || !connected) return; button.setPointerCapture(event.pointerId); pointers.set(event.pointerId, dir); steering(); });
  const up = event => { pointers.delete(event.pointerId); steering(); };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, up);
  button.addEventListener('contextmenu', event => event.preventDefault());
}
window.addEventListener('keydown', event => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(key) || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || game?.phase !== 'playing' || !connected) return;
  event.preventDefault(); keys.add(key); steering();
});
window.addEventListener('keyup', event => { const key = event.key.length === 1 ? event.key.toLowerCase() : event.key; if (keys.delete(key)) { event.preventDefault(); steering(); } });
window.addEventListener('blur', release);
document.addEventListener('visibilitychange', () => { release(); dirty = true; lastFrame = 0; });
setInterval(() => { if (game) updateUI(); }, 200);
setInterval(() => { if (connected && game?.phase === 'playing' && !document.hidden) sendTurn(); }, 1000);
clearArena(); requestAnimationFrame(paint);
