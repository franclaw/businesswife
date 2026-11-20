'use strict';
const $ = id => document.getElementById(id);
const roomId = location.pathname.match(/^\/meeting-room\/([a-z0-9]{6})\/?$/)?.[1];
const key = 'bw_meeting_' + roomId;
let saved;
try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { saved = {}; }
let credential = saved, state, stream, viewing = null, selected = new Map();
const remember = () => localStorage.setItem(key, JSON.stringify(credential));
const error = e => { $('error').textContent = e.message || String(e); };
function node(tag, content, className) { const el = document.createElement(tag); if (content != null) el.textContent = content; if (className) el.className = className; return el; }
function button(label, handler, className = 'secondary') { const el = node('button', label, className); el.type = 'button'; el.onclick = () => run(handler); return el; }
async function api(action = '', body) {
  const response = await fetch('/meeting-room/api/rooms' + (roomId ? '/' + roomId : '') + (action ? '/' + action : ''), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, secret: credential.secret }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not reach the room.');
  return data;
}
async function run(fn) { $('error').textContent = ''; try { await fn(); } catch (e) { error(e); } }
async function act(action, body = {}) { await api(action, body); state = await api(); render(); }
function connect() {
  stream?.close(); stream = new EventSource('/meeting-room/api/rooms/' + roomId + '/events');
  stream.onmessage = event => { state = JSON.parse(event.data); $('connection').textContent = 'Live room'; render(); };
  stream.onerror = () => { $('connection').textContent = 'Connection lost · reconnecting…'; };
}
$('create-form').onsubmit = e => { e.preventDefault(); run(async () => {
  const made = await api('', { title: $('title').value });
  localStorage.setItem('bw_meeting_' + made.id, JSON.stringify({ ownerToken: made.ownerToken }));
  location.href = '/meeting-room/' + made.id;
}); };
$('join-form').onsubmit = e => { e.preventDefault(); const code = $('code').value.trim().match(/(?:^|\/)([a-z0-9]{6})\/?$/i)?.[1]; if (code) location.href = '/meeting-room/' + code.toLowerCase(); else error('Enter a six-character code or room link.'); };
$('picker').addEventListener('change', () => { $('join').disabled = !$('picker').valid; });
$('join').onclick = () => run(async () => {
  if (!$('picker').valid) return;
  const value = $('picker').value;
  const joined = await api('join', { ...value, ownerToken: credential.ownerToken });
  credential = { ...credential, ...joined }; remember();
  if (value.kind !== 'roster') $('picker').remember(value);
  state = await api(); render();
});
$('share').onclick = () => run(async () => { await navigator.clipboard.writeText(location.origin + '/meeting-room/' + roomId); $('share').textContent = 'Link copied'; });
$('type').onchange = () => { $('poll-options').hidden = $('type').value !== 'poll'; };
$('activity-form').onsubmit = e => { e.preventDefault(); run(async () => {
  await act('activity', { type: $('type').value, title: $('question').value, options: $('options').value.split('\n').map(s => s.trim()).filter(Boolean) });
  viewing = null; $('question').value = ''; render();
}); };
$('end').onclick = () => run(() => act('end'));
$('new-meeting').onclick = () => run(() => act('session'));
function render() {
  if (!state) return;
  $('room-title').textContent = state.title; document.title = state.title + ' · Meeting Room';
  const member = state.members.find(m => m.id === credential.id);
  $('landing').hidden = true; $('identity').hidden = !!member; $('room').hidden = !member;
  if (!member) { $('picker').setTaken(state.members.map(m => m.name)); return; }
  const host = member.id === state.hostId, current = state.sessions.at(-1);
  $('expiry').textContent = 'Reusable until ' + new Date(state.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' }) + ' · joins and actions renew for one month';
  $('facilitator').hidden = !host;
  $('activity-form').hidden = !!current.endedAt; $('end').hidden = !!current.endedAt; $('new-meeting').hidden = !current.endedAt;
  $('members').replaceChildren(...state.members.map(m => {
    const li = node('li');
    if (m.icon?.startsWith('/img/')) { const wrap = node('span', null, 'member-picture' + (m.raw ? ' bw-framed' : '')); const img = node('img'); img.src = m.icon; img.alt = ''; wrap.append(img); li.append(wrap); }
    li.append(node('span', m.name + (m.id === state.hostId ? ' · facilitator' : '') + (m.id === member.id ? ' · you' : '')));
    if (host && m.id !== member.id) li.append(button('Make facilitator', () => act('handover', { memberId: m.id })));
    return li;
  }));
  const all = state.sessions.flatMap(s => s.activities), live = all.find(a => a.id === state.activeId);
  if (viewing === state.activeId) viewing = null;
  const activity = all.find(a => a.id === viewing) || live;
  $('activity').replaceChildren();
  if (viewing) $('activity').append(button('Back to live activity', () => { viewing = null; render(); }));
  if (!activity) $('activity').append(node('h2', current.endedAt ? 'Meeting complete' : 'Ready when you are'), node('p', current.endedAt ? 'The room link stays the same for your next meeting. Results are saved in the history.' : host ? 'Start planning poker or a poll above.' : 'Your facilitator will start the first activity.'));
  else renderActivity(activity, member, host, !!viewing);
  $('history').replaceChildren(...[...state.sessions].reverse().map((s, reverseIndex) => {
    const block = node('section', null, 'history-item');
    block.append(node('h3', 'Meeting ' + (state.sessions.length - reverseIndex) + (s.endedAt ? ' · ended' : ' · current')), node('p', new Date(s.startedAt).toLocaleString(), 'muted'));
    if (!s.activities.length) block.append(node('p', 'No activities yet.', 'muted'));
    for (const a of s.activities) {
      block.append(button((a.type === 'poker' ? '♠ ' : '▥ ') + a.title + (a.id === state.activeId ? ' · live' : '') + (a.phase === 'closed' ? ' · results' : ' · open'), () => { viewing = a.id; render(); }));
      if (host && s === current && !s.endedAt && a.id !== state.activeId) block.append(button('Resume ' + a.title, async () => { viewing = null; await act('switch', { activityId: a.id }); }));
    }
    return block;
  }));
}
function renderActivity(a, member, host, historical) {
  const target = $('activity');
  target.append(node('p', (a.type === 'poker' ? 'Planning poker' : 'Poll') + (historical ? ' · history view' : ' · live activity'), 'badge'), node('h2', a.title), node('p', a.responseIds.length + ' response' + (a.responseIds.length === 1 ? '' : 's')));
  if (a.phase === 'closed') {
    if (a.type === 'poker') {
      target.append(node('p', 'Median: ' + (a.results.median ?? '—'), 'result'));
      for (const v of a.results.votes) target.append(node('p', v.name + ': ' + v.vote));
    } else for (const o of a.results) target.append(node('p', o.label + ': ' + o.count, 'result'));
  } else if (!historical) {
    const voted = a.responseIds.includes(member.id), cards = node('div', null, 'cards');
    const options = a.type === 'poker' ? ['0','1','2','3','5','8','13','20','40','100','?','☕','∞'].map(v => ({ id: v, label: v })) : a.options;
    for (const option of options) {
      const choice = button(option.label, async () => { await act('respond', { activityId: a.id, value: option.id }); selected.set(a.id, option.id); render(); });
      choice.disabled = a.type === 'poll' && voted;
      choice.classList.toggle('selected', selected.get(a.id) === option.id); cards.append(choice);
    }
    target.append(cards, node('p', voted ? a.type === 'poll' ? 'Vote saved. Waiting for the facilitator to close the poll.' : 'Card saved. You can change it until reveal.' : 'Responses stay hidden until the facilitator reveals or closes.', 'muted'));
  } else target.append(node('p', 'This activity is paused. The facilitator can resume it from the history.', 'muted'));
  if (host && !historical) {
    const controls = node('div', null, 'actions');
    if (a.phase === 'open') controls.append(button(a.type === 'poker' ? 'Reveal cards' : 'Close poll', () => act('close', { activityId: a.id })));
    if (a.type === 'poker' && a.phase === 'closed') controls.append(button('Re-vote', () => act('revote', { activityId: a.id })));
    target.append(controls);
  }
}
if (roomId) run(async () => {
  $('landing').hidden = true;
  state = await api();
  if (credential.secret) {
    try { await api('join', { ownerToken: credential.ownerToken }); }
    catch { delete credential.secret; delete credential.id; remember(); }
  }
  render(); connect();
});
