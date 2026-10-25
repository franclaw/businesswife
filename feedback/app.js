/* Feedback follows the other sub-apps: plain DOM, local browser identity,
   capability link for the facilitator, and reconnecting EventSource. */
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phases = ['collecting', 'revealed', 'voting', 'results'];
const labels = ['Collecting', 'Revealed', 'Voting', 'Results'];
const hints = ['Only your own feedback is visible. Add as many thoughts as you like.', 'All feedback is revealed. Submissions are closed; voting is not open yet.', 'Choose what matters most. You can change your votes until the facilitator closes voting. Totals stay hidden.', 'Voting is closed. Here are the shared priorities.'];
const match = location.pathname.match(/^\/feedback\/([a-z0-9]{6})(\/facilitator)?\/?$/);
const id = match?.[1];
const managerPath = !!match?.[2];
let participantId, token = '', recent = [], snapshot, stream, busy = false;
const drafts = new Map();
const selected = new Set();
let questions = ['What went well?', "What didn't go well?", 'What could we improve?', 'What did we learn?'];
try {
  participantId = localStorage.getItem('bw-feedback-participant') || crypto.randomUUID();
  localStorage.setItem('bw-feedback-participant', participantId);
  recent = JSON.parse(localStorage.getItem('bw-feedback-sessions') || '[]');
  if (!Array.isArray(recent)) recent = [];
  if (managerPath) {
    token = new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('bw-feedback-token-' + id) || '';
    if (token) localStorage.setItem('bw-feedback-token-' + id, token);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }
} catch { $('error').textContent = 'Browser storage is unavailable. Keep this tab open; your identity cannot be remembered after closing it.'; participantId ||= crypto.randomUUID(); }
const endpoint = '/feedback/api/sessions' + (id ? '/' + id : '');
// The facilitator token never goes into a URL (server logs, proxies, history):
// reads send it as a header, writes in the JSON body. The live stream is the
// plain participant projection, so it needs no token at all.
const query = () => new URLSearchParams({ participantId });
async function call(path = '', body) {
  const res = await fetch(endpoint + path + (body === undefined ? '?' + query() : ''), body === undefined
    ? { cache: 'no-store', headers: token ? { 'X-Facilitator-Token': token } : {} }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ participantId, facilitatorToken: token, ...body }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function action(fn) {
  if (busy) return;
  busy = true; $('error').textContent = ''; $('notice').textContent = '';
  try { await fn(); } catch (e) { $('error').textContent = e.message; }
  finally { busy = false; }
}
function renderQuestions() {
  $('questions').innerHTML = questions.map((q, i) => `<div class="question"><label for="q-${i}">Question ${i + 1}</label><input id="q-${i}" data-question="${i}" value="${esc(q)}" required maxlength="80"><div class="row"><button type="button" data-move="${i}" data-direction="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move question ${i + 1} up">↑ Up</button><button type="button" data-move="${i}" data-direction="1" ${i === questions.length - 1 ? 'disabled' : ''} aria-label="Move question ${i + 1} down">↓ Down</button><button type="button" data-remove="${i}" ${questions.length === 1 ? 'disabled' : ''} aria-label="Remove question ${i + 1}">Remove</button></div></div>`).join('');
  $('add-question').disabled = questions.length >= 8;
}
$('questions').addEventListener('input', (e) => { if (e.target.dataset.question !== undefined) questions[Number(e.target.dataset.question)] = e.target.value; });
$('questions').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.remove !== undefined) questions.splice(Number(b.dataset.remove), 1);
  else { const a = Number(b.dataset.move), z = a + Number(b.dataset.direction); [questions[a], questions[z]] = [questions[z], questions[a]]; }
  renderQuestions();
});
$('add-question').onclick = () => { questions.push(''); renderQuestions(); $('q-' + (questions.length - 1)).focus(); };
$('create-form').onsubmit = (e) => { e.preventDefault(); action(async () => {
  const made = await call('', { title: $('title').value, description: $('desc').value, categories: questions, votesPerParticipant: Number($('votes').value) });
  const link = `/feedback/${made.id}/facilitator#token=${encodeURIComponent(made.facilitatorToken)}`;
  try { localStorage.setItem('bw-feedback-token-' + made.id, made.facilitatorToken); localStorage.setItem('bw-feedback-sessions', JSON.stringify([{ id: made.id, title: $('title').value, link }, ...recent].slice(0, 30))); } catch {}
  location.assign(link);
}); };
function accept(s) {
  if (snapshot && s.rev < snapshot.rev) return;
  snapshot = s;
  render();
}
function render() {
  const s = snapshot, phase = phases.indexOf(s.state), fac = s.facilitator;
  $('heading').textContent = s.title; $('description').textContent = s.description;
  $('phase').textContent = labels[phase]; $('phase-hint').textContent = hints[phase];
  $('remaining').textContent = s.state === 'voting' ? `${s.remainingVotes} of ${s.votesPerParticipant} votes remaining · voting is optional` : '';
  $('controls').hidden = !fac;
  $('back').hidden = phase === 0; $('back').textContent = phase === 3 ? 'Reopen voting' : 'Back to ' + (labels[phase - 1] || 'collecting').toLowerCase();
  $('forward').hidden = phase === 3; $('forward').textContent = ['Reveal feedback', 'Open voting', 'Close voting & show results'][phase] || '';
  $('sharing').hidden = !fac;
  $('results-tools').hidden = s.state !== 'results';
  $('export-tools').hidden = !fac;
  if (fac && !$('participant-link').value) {
    $('participant-link').value = location.origin + '/feedback/' + id;
    $('facilitator-link').value = location.origin + '/feedback/' + id + '/facilitator#token=' + encodeURIComponent(token);
    new QRCode($('qr'), { text: $('participant-link').value, width: 192, height: 192, correctLevel: QRCode.CorrectLevel.M });
  }
  const active = document.activeElement, focusId = active?.id, start = active?.selectionStart, end = active?.selectionEnd;
  const top = Math.max(0, ...s.items.map((i) => i.votes || 0));
  $('categories').innerHTML = s.categories.map((c) => {
    let items = s.items.filter((i) => i.categoryId === c.id);
    if (s.state === 'results' && $('sort').value === 'votes') items = [...items].sort((a, b) => b.votes - a.votes);
    return `<section class="panel" data-category="${esc(c.id)}"><h2>${esc(c.label)}</h2>${s.state === 'collecting' ? `<form data-submit="${esc(c.id)}"><label for="draft-${esc(c.id)}">Your feedback</label><textarea id="draft-${esc(c.id)}" data-draft="${esc(c.id)}" rows="2" maxlength="300" required>${esc(drafts.get(c.id) || '')}</textarea><button class="primary" type="submit">Add feedback</button></form>` : ''}${items.length ? items.map((i) => `<article class="item ${s.state === 'results' && top > 0 && i.votes === top ? 'top' : ''}" data-item="${esc(i.id)}"><p>${esc(i.text)}</p>${i.mergedFrom.length ? `<details><summary>Original texts (${i.mergedFrom.length})</summary><ul>${i.mergedFrom.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}${s.state === 'results' ? `<p class="vote-total">${i.votes} vote${i.votes === 1 ? '' : 's'}${top > 0 && i.votes === top ? ' · Most voted' : ''}</p>` : ''}<div class="row">${s.state === 'voting' ? `<button type="button" data-vote="${esc(i.id)}" class="${s.myVotes.includes(i.id) ? 'voted' : ''}" aria-pressed="${s.myVotes.includes(i.id)}" ${!s.myVotes.includes(i.id) && !s.remainingVotes ? 'disabled' : ''}>${s.myVotes.includes(i.id) ? '✓ Remove vote' : '+ Vote'}</button>` : ''}${fac || (i.mine && s.state === 'collecting') ? `<button type="button" data-edit="${esc(i.id)}">Edit</button><button type="button" data-delete="${esc(i.id)}">Delete</button>` : ''}</div>${fac && s.state !== 'collecting' ? `<label class="merge-label"><input type="checkbox" data-merge-item="${esc(i.id)}" ${selected.has(i.id) ? 'checked' : ''}> Select to merge</label>` : ''}</article>`).join('') : `<p class="hint">${s.state === 'collecting' ? 'Your submitted thoughts will appear here.' : 'No feedback in this category.'}</p>`}${fac && s.state !== 'collecting' && items.length > 1 ? `<button type="button" data-merge="${esc(c.id)}">Merge selected items</button>` : ''}</section>`;
  }).join('');
  if (focusId && $(focusId)) { $(focusId).focus({ preventScroll: true }); if (start != null) $(focusId).setSelectionRange(start, end); }
  if (s.state === 'results' && fac) $('markdown').value = markdown();
}
$('categories').addEventListener('input', (e) => { if (e.target.dataset.draft) drafts.set(e.target.dataset.draft, e.target.value); });
$('categories').addEventListener('change', (e) => { const key = e.target.dataset.mergeItem; if (key) e.target.checked ? selected.add(key) : selected.delete(key); });
$('categories').addEventListener('submit', (e) => {
  const categoryId = e.target.dataset.submit; if (!categoryId) return; e.preventDefault();
  const text = drafts.get(categoryId) || '';
  action(async () => { await call('/items', { categoryId, text }); drafts.set(categoryId, ''); accept(await call()); $('draft-' + categoryId)?.focus(); });
});
$('categories').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.type === 'submit') return;
  action(async () => {
    if (b.dataset.vote) { const itemId = b.dataset.vote; await call('/vote', { itemId, add: !snapshot.myVotes.includes(itemId) }); }
    if (b.dataset.edit) { const itemId = b.dataset.edit, item = snapshot.items.find((i) => i.id === itemId); const text = prompt('Edit feedback', item.text); if (text === null) return; await call('/items/update', { itemId, text }); }
    if (b.dataset.delete) { if (!confirm('Delete this feedback and any votes on it?')) return; await call('/items/delete', { itemId: b.dataset.delete }); }
    if (b.dataset.merge) {
      const items = snapshot.items.filter((i) => i.categoryId === b.dataset.merge && selected.has(i.id));
      if (items.length < 2) throw new Error('Select at least two items in the same category.');
      await call('/merge', { targetId: items[0].id, sourceIds: items.slice(1).map((i) => i.id) }); selected.clear();
    }
    accept(await call());
  });
});
$('back').onclick = () => action(async () => { await call('/state', { state: phases[phases.indexOf(snapshot.state) - 1] }); accept(await call()); });
$('forward').onclick = () => action(async () => { await call('/state', { state: phases[phases.indexOf(snapshot.state) + 1] }); accept(await call()); });
$('sort').onchange = render;
const md = (v) => String(v).replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&').replace(/\r?\n/g, ' ');
function markdown() {
  const s = snapshot;
  const out = [`# ${md(s.title)}`, '', `Date: ${new Date(s.createdAt).toISOString().slice(0, 10)}`, '', md(s.description), ''];
  for (const c of s.categories) {
    out.push(`## ${md(c.label)}`, '');
    const items = s.items.filter((i) => i.categoryId === c.id);
    if ($('sort').value === 'votes') items.sort((a, b) => b.votes - a.votes);
    for (const i of items) {
      out.push(`- **${i.votes} votes** — ${md(i.text)}`);
      for (const text of i.mergedFrom) out.push(`  - Original: ${md(text)}`);
    }
    if (!items.length) out.push('No feedback.');
    out.push('');
  }
  out.push('## Overall ranking', '');
  [...s.items].sort((a, b) => b.votes - a.votes).forEach((i, n) => out.push(`${n + 1}. ${md(i.text)} — ${i.votes} votes (${md(s.categories.find((c) => c.id === i.categoryId).label)})`));
  return out.join('\n');
}
async function copy(text, field) {
  try { await navigator.clipboard.writeText(text); $('notice').textContent = 'Copied to clipboard.'; }
  catch { field.focus(); field.select(); $('notice').textContent = 'Select and copy the text from the highlighted field.'; }
}
$('copy-link').onclick = () => copy($('participant-link').value, $('participant-link'));
$('copy-facilitator').onclick = () => copy($('facilitator-link').value, $('facilitator-link'));
$('copy-results').onclick = () => copy(markdown(), $('markdown'));
$('export-results').onclick = () => {
  const url = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'feedback-' + id + '.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
if (!id) {
  renderQuestions();
  $('recent').hidden = !recent.length;
  $('recent-list').innerHTML = recent.filter((s) => /^[a-z0-9]{6}$/.test(s.id)).map((s) => `<a href="/feedback/${s.id}/facilitator">${esc(s.title)}</a>`).join('');
} else {
  $('create').hidden = true; $('room').hidden = false;
  action(async () => {
    accept(await call());
    const isFacilitator = snapshot.facilitator;
    if (managerPath && !snapshot.facilitator) $('error').textContent = 'This link has no valid facilitator token. Open the original private facilitator link.';
    stream = new EventSource(endpoint + '/events?' + query());
    $('connection').hidden = false; $('connection').textContent = 'Connecting…';
    stream.onopen = () => { $('connection').textContent = 'Live · connected'; };
    stream.onmessage = (e) => accept({ ...JSON.parse(e.data), facilitator: isFacilitator });
    stream.onerror = () => { $('connection').textContent = 'Disconnected · reconnecting automatically. Your drafts are kept in this tab.'; };
  });
}
