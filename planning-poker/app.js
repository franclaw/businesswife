// Roster and thumbnails are shared: /components/bw-roster.js.
const ROSTER = window.BW_ROSTER;
const thumbOf = (r) => (r && r.img ? window.bwThumb(r.img) : null);
const thumbPath = (p) => window.bwThumb(p);
const ROSTER_BY_NAME = Object.fromEntries(ROSTER.map(r => [r.name, r]));
/** YYYY-MM-DD in the browser's own time zone. */
const localDay = () => new Date().toLocaleDateString("sv-SE");
function escapeAttr(x) {
  return String(x).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function isImageIcon(icon) {
  return !!(icon && (
    icon.startsWith("data:image/") ||
    icon.startsWith("/img/")
  ));
}
function picOrIcon(r, cls) {
  const t = thumbOf(r);
  if (t) return `<img class="${cls}" src="${t}" alt="" data-fb="${r.icon}" title="${r.first} — ${r.name}">`;
  return `<span class="ico">${r ? r.icon : "❔"}</span>`;
}
// A roster wife shows her portrait and first name; a custom wife who merely
// shares a roster title keeps her own uploaded picture and name.
function rosterOf(p) {
  const r = ROSTER_BY_NAME[p.name];
  return r && !(isImageIcon(p.icon) && p.icon !== r.img) ? r : null;
}
function playerAvatar(p, cls) {
  if (p.role === "observer") return `<span class="ico">${p.icon || "👁️"}</span>`;
  const r = rosterOf(p);
  if (r) return picOrIcon(r, cls);
  if (isImageIcon(p.icon)) {
    const src = p.icon.startsWith("/img/") ? thumbPath(p.icon) : p.icon;
    const img = `<img class="${cls}" src="${escapeAttr(src)}" alt="" data-fb="👤">`;
    // p.raw: raw upload stored by the picker; the frame is a CSS overlay.
    return p.raw ? `<span class="bw-framed">${img}</span>` : img;
  }
  return `<span class="ico">${escapeHtml(p.icon || "👤")}</span>`;
}
function playerLabel(p) {
  if (p.role === "observer") return p.name;
  const r = rosterOf(p);
  return r ? (r.first + " · " + r.name) : p.name;
}
function bindImgFallback(root) {
  root.querySelectorAll("img.pic").forEach(i => { i.onerror = () => {
    const s = document.createElement("span"); s.className = "ico"; s.textContent = i.dataset.fb || "👤";
    (i.closest(".bw-framed") || i).replaceWith(s);
  }; });
}
const CARDS = ["1","2","3","5","8","13","21","34","55","?","∞","☕"];

let roomId = null;
let myId = null;      // public seat id: drawn on the table, authorises nothing
let mySecret = null;  // private seat secret: sent with every action
let myMeta = null;    // { name, icon, role, subtitle }
let lastState = null;
let es = null;
let heartbeatTimer = null;
let intentionalLeave = false;
let lastPhase = null;
let audioCtx = null;
let checkingSeat = false;

const $ = id => document.getElementById(id);

// A seat is { playerId, secret, name, icon, role, subtitle }. It lives in
// localStorage so closing the tab or the installed app keeps your seat (the
// server frees it after five minutes of silence). Older builds kept only the
// public id, which no longer authorises anything; those sessions are dropped.
function sessionKey(id) { return "sbw_seat_" + id; }
function loadSession(id) {
  try {
    const s = JSON.parse(localStorage.getItem(sessionKey(id)) || "null");
    return s && s.secret ? s : null;
  } catch { return null; }
}
function saveSession(id, data) {
  if (!id || !data) return;
  localStorage.setItem(sessionKey(id), JSON.stringify(data));
}
function clearSession(id) {
  if (!id) return;
  localStorage.removeItem(sessionKey(id));
  localStorage.removeItem("sbw_session_" + id);
  localStorage.removeItem("sbw_id_" + id);
}
function sitDown(data) {
  myId = data.playerId;
  mySecret = data.secret;
  myMeta = data;
  saveSession(roomId, data);
}
function standUp() {
  stopHeartbeat();
  clearSession(roomId);
  myId = null;
  mySecret = null;
}
function soundEnabled() {
  const v = localStorage.getItem("sbw_sound");
  if (v === null) return true; // default on (subtle)
  return v !== "off";
}
function setSoundEnabled(on) {
  localStorage.setItem("sbw_sound", on ? "on" : "off");
}
function playRevealFeedback() {
  if (!soundEnabled()) return;
  try {
    if (navigator.vibrate) navigator.vibrate([18, 40, 18]);
  } catch {}
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, t0);
    o.frequency.exponentialRampToValueAtTime(660, t0 + 0.12);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + 0.2);
  } catch {}
}
(function paintFan() {
  const fan = $("lobbyFan");
  if (!fan) return;
  ROSTER.slice(0, 8).forEach((r, i) => {
    const img = document.createElement("img");
    img.className = "fan-card";
    img.src = thumbOf(r);
    img.alt = "";
    const t = i - 3.5;
    img.style.transform = "rotate(" + (t * 7) + "deg) translateY(" + (Math.abs(t) * 2) + "px)";
    img.style.zIndex = String(10 - Math.abs(t));
    fan.appendChild(img);
  });
})();
function api(path, opts) { return fetch("/planning-poker/api/rooms/" + roomId + path, opts); }

// Every seated action carries the seat secret. A 401 means the seat is gone
// (idle, kicked, server restarted): back to the join screen with a reason.
async function act(path, body) {
  if (!roomId || !mySecret) return null;
  const res = await api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Seat-Secret": mySecret },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) {
    standUp();
    $("joinErr").textContent = "Your seat expired. Pick your wife to rejoin.";
    show("join");
  }
  return res;
}
function roomUrl(id) { return location.origin + "/planning-poker/r/" + id; }
function parseRoomFromPath() {
  const m = location.pathname.match(/^\/planning-poker\/r\/([a-z0-9]{6})\/?$/);
  return m ? m[1] : null;
}
function show(which) {
  $("lobby").classList.toggle("hidden", which !== "lobby");
  $("join").classList.toggle("hidden", which !== "join");
  $("game").classList.toggle("hidden", which !== "game");
  $("shareCard").classList.toggle("hidden", which === "lobby");
  document.documentElement.classList.toggle("in-lobby", which === "lobby");
}
function setShare() {
  if ($("shareUrl") && roomId) $("shareUrl").value = roomUrl(roomId);
  if ($("roomCodeBig") && roomId) $("roomCodeBig").textContent = roomId;
  if (!$('qrPanel').classList.contains('hidden')) drawQr();
}
function drawQr() {
  const qr = qrcode(0, 'M');
  qr.addData(roomUrl(roomId));
  qr.make();
  const count = qr.getModuleCount(), scale = 6, margin = 4;
  const canvas = $('qrCanvas');
  canvas.width = canvas.height = (count + margin * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
    if (qr.isDark(y, x)) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  }
}
$('qrBtn').onclick = () => {
  const opening = $('qrPanel').classList.contains('hidden');
  if (opening) drawQr();
  $('qrPanel').classList.toggle('hidden', !opening);
  $('qrBtn').setAttribute('aria-expanded', String(opening));
};

// --- Join screen: the shared <bw-wife-picker> ---
const picker = $("picker");

function syncJoinBtn() {
  $("joinBtn").disabled = !picker.valid;
}
picker.addEventListener("change", () => { $("joinErr").textContent = ""; syncJoinBtn(); });

function updateTaken(names) {
  picker.setTaken(names);
  syncJoinBtn();
}

$("createBtn").onclick = async () => {
  const btn = $("createBtn");
  btn.disabled = true;
  $("lobbyErr").textContent = "";
  try {
    const res = await fetch("/planning-poker/api/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" },
      // Blank title: the creator's own calendar day, not the server's UTC one.
      body: JSON.stringify({ title: $("boardroomTitle").value.trim() || "Refinement " + localDay() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Could not create the boardroom.");
    await enterRoom(body.id);
  } catch (e) { $("lobbyErr").textContent = e.message; }
  finally { btn.disabled = false; }
};
$("boardroomTitle").addEventListener("keydown", e => { if (e.key === "Enter") $("createBtn").click(); });
// Show today's date in the example title, matching the server's default.
$("boardroomTitle").placeholder = "e.g. Refinement " + localDay();
function setRoomTitle(title) {
  $("roomTitle").textContent = title || "";
  $("roomTitle").classList.toggle("hidden", !title);
  document.title = title ? title + " — Planning Poker · Business Wife" : "Planning Poker — Business Wife";
}
$("joinRoomBtn").onclick = () => {
  const code = ($("roomCode").value || "").trim().toLowerCase();
  if (!/^[a-z0-9]{6}$/.test(code)) { $("lobbyErr").textContent = "Room codes are 6 characters."; return; }
  enterRoom(code);
};
$("roomCode").addEventListener("keydown", e => { if (e.key === "Enter") $("joinRoomBtn").click(); });
$("copyBtn").onclick = async () => {
  const v = $("shareUrl").value;
  try { await navigator.clipboard.writeText(v); $("copyBtn").textContent = "Copied"; setTimeout(() => $("copyBtn").textContent = "Copy", 1200); }
  catch { $("shareUrl").select(); document.execCommand("copy"); }
};
$("shareBtn").onclick = async () => {
  const url = $("shareUrl").value;
  const code = roomId || "";
  if (navigator.share) {
    try {
      await navigator.share({ title: $("roomTitle").textContent || "Business Wife Planning Poker", text: "Join " + ($("roomTitle").textContent || "boardroom " + code.toUpperCase()), url });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  // Fallback: copy
  $("copyBtn").click();
};

function startHeartbeat() {
  stopHeartbeat();
  if (!roomId || !mySecret) return;
  const beat = () => {
    if (!roomId || !mySecret || intentionalLeave) return;
    act("/heartbeat").catch(() => {});
  };
  beat();
  heartbeatTimer = setInterval(beat, 15000);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}
// Timers and EventSource may have been suspended while a phone was asleep.
let reclaiming = false;
async function resumePresence() {
  if (document.visibilityState !== "visible" || !roomId || intentionalLeave) return;
  if (!mySecret && loadSession(roomId) && !reclaiming) {
    reclaiming = true;
    try {
      if (await tryReclaim(roomId)) { show("game"); startHeartbeat(); await refreshState(); }
    } finally { reclaiming = false; }
  }
  if (!mySecret) return;
  act("/heartbeat").then(res => { if (res && res.ok) refreshState(); }).catch(() => {});
  connect();
}
document.addEventListener("visibilitychange", resumePresence);
window.addEventListener("online", resumePresence);
window.addEventListener("pageshow", resumePresence);

// Back after a refresh: the stored secret reclaims the same seat.
async function tryReclaim(id) {
  const sess = loadSession(id);
  if (!sess) { clearSession(id); return false; }
  const res = await api("/join", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Seat-Secret": sess.secret },
    body: JSON.stringify({ name: sess.name, icon: sess.icon, subtitle: sess.subtitle, raw: sess.raw || undefined }),
  }).catch(() => null);
  if (!res) return false; // A transient network failure must not erase the profile.
  if (!res.ok) { if (res.status === 404 || res.status === 401) clearSession(id); return false; }
  const data = await res.json();
  sitDown({ ...sess, playerId: data.id });
  return true;
}

async function enterRoom(id) {
  intentionalLeave = false;
  const check = await fetch("/planning-poker/api/rooms/" + id);
  if (!check.ok) {
    $("lobbyErr").textContent = "That boardroom is gone. Start a new one or enter another code.";
    clearSession(id);
    history.replaceState({}, "", "/planning-poker");
    roomId = null;
    setRoomTitle(null);
    myId = null;
    mySecret = null;
    show("lobby");
    return;
  }
  setRoomTitle((await check.json()).title);
  roomId = id;
  history.replaceState({}, "", "/planning-poker/r/" + id);
  setShare();
  connect();
  picker.refresh();
  show("join");
  if (await tryReclaim(id)) {
    show("game");
    startHeartbeat();
    await refreshState();
  }
}

async function join(payload, role) {
  const res = await api("/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(role === "observer" ? { ...payload, role } : payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || "failed" };
  sitDown({ playerId: body.id, secret: body.secret, role, name: payload.name, icon: payload.icon, subtitle: payload.subtitle || "", raw: payload.raw || undefined });
  show("game");
  setShare();
  startHeartbeat();
  refreshState();
  return {};
}

const JOIN_ERRORS = {
  taken: "That name is taken. Pick another.",
  "room locked": "This boardroom is locked. Ask the host to unlock joining.",
  "bad icon": "Picture was rejected. Try another image.",
  "room full": "This boardroom is full.",
};

$("joinBtn").onclick = async () => {
  const v = picker.value;
  if (!v || !picker.valid) { $("joinErr").textContent = "Pick a Business Wife or add your own."; return; }
  $("joinBtn").disabled = true;
  const payload = { name: v.name, icon: v.icon };
  if (v.subtitle) payload.subtitle = v.subtitle;
  if (v.raw) payload.raw = true;
  const { error } = await join(payload, "player");
  if (error) {
    $("joinErr").textContent = JOIN_ERRORS[error] || "Could not join. Try again.";
    syncJoinBtn();
    refreshState();
    return;
  }
  // Keep a custom wife on this device so she is offered again next visit.
  if (v.kind !== "roster") picker.remember(v);
};

$("obsBtn").onclick = async () => {
  const name = ($("obsName").value || "").trim() || "Observer";
  const { error } = await join({ name, icon: "👁️" }, "observer");
  if (error) $("joinErr").textContent = JOIN_ERRORS[error] || "Could not join as observer.";
};
$("obsName").addEventListener("keydown", e => { if (e.key === "Enter") $("obsBtn").click(); });

$("leaveLink").onclick = async () => {
  intentionalLeave = true;
  if (mySecret) await act("/leave").catch(() => {});
  standUp();
  location.href = "/planning-poker";
};

// Do NOT leave on unload/refresh — heartbeat + idle timeout reclaim seat

$("lockToggle").onchange = async () => {
  const locked = $("lockToggle").checked;
  const res = await act("/lock", { locked });
  if (!res || !res.ok) $("lockToggle").checked = !locked;
};

(function initSoundToggle() {
  const t = $("soundToggle");
  if (!t) return;
  t.checked = soundEnabled();
  t.onchange = () => setSoundEnabled(t.checked);
})();

(function initHostMenu() {
  const btn = $("hostMenuBtn");
  const menu = $("hostMenu");
  if (!btn || !menu) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle("hidden") === false;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  document.addEventListener("click", (e) => {
    if (menu.classList.contains("hidden")) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  });
})();

document.addEventListener("click", (e) => {
  if (e.target.closest(".seat-menu-wrap")) return;
  document.querySelectorAll(".seat-menu").forEach(m => m.classList.add("hidden"));
});

async function kickPlayer(targetId) {
  if (!targetId) return;
  await act("/kick", { targetId });
  refreshState();
}

// --- Cards ---
// The chosen card is remembered per room and round so a refresh can still
// highlight it (the server only says *that* you voted until the reveal).
function rememberVote(v) {
  localStorage.setItem("sbw_myvote", v);
  localStorage.setItem("sbw_myvote_round", String(lastState?.round ?? ""));
  localStorage.setItem("sbw_myvote_room", roomId || "");
}
CARDS.forEach(c => {
  const b = document.createElement("button");
  b.className = "poker-card";
  b.textContent = c;
  b.dataset.v = c;
  b.dataset.testid = "card";
  b.onclick = async () => {
    if (!mySecret) return;
    rememberVote(c);
    await act("/vote", { value: c });
    refreshState();
  };
  $("cards").appendChild(b);
});

function refreshState() {
  if (!roomId) return Promise.resolve();
  return api("/state").then(r => r.json()).then(render);
}
$("revealBtn").onclick = async () => {
  const btn = $("revealBtn");
  if (btn.disabled || btn.classList.contains("busy") || btn.classList.contains("hidden")) return;
  const label = btn.textContent;
  btn.classList.add("busy");
  btn.disabled = true;
  btn.textContent = "Revealing…";
  try {
    await act("/reveal");
    const table = $("table");
    table.classList.remove("pulse");
    void table.offsetWidth;
    table.classList.add("pulse");
    await refreshState();
  } finally {
    setTimeout(() => {
      btn.classList.remove("busy");
      btn.disabled = false;
      btn.textContent = label;
    }, 450);
  }
};
$("revoteBtn").onclick = async () => {
  const btn = $("revoteBtn");
  if (btn.disabled || btn.classList.contains("busy") || btn.classList.contains("hidden")) return;
  btn.classList.add("busy");
  btn.disabled = true;
  btn.textContent = "Resetting votes…";
  try {
    await act("/revote");
    await refreshState();
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
    btn.textContent = "Re-Vote";
  }
};
$("nextBtn").onclick = async () => {
  const btn = $("nextBtn");
  if (btn.disabled || btn.classList.contains("busy")) return;
  const label = btn.textContent;
  btn.classList.add("busy");
  btn.disabled = true;
  btn.textContent = "Starting…";
  $("question").value = "";
  try {
    await act("/next");
    const table = $("table");
    table.classList.remove("pulse");
    void table.offsetWidth;
    table.classList.add("pulse");
    const head = $("stageHead");
    if (head) {
      head.classList.add("round-flash");
      setTimeout(() => head.classList.remove("round-flash"), 450);
    }
    await refreshState();
  } finally {
    setTimeout(() => {
      btn.classList.remove("busy");
      btn.disabled = false;
      btn.textContent = label;
    }, 450);
  }
};
function saveQuestion() {
  if (!roomId) return Promise.resolve();
  if (!mySecret || !lastState || $("question").value === (lastState.question || "")) return Promise.resolve();
  return act("/question", { question: $("question").value }).then(refreshState);
}
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("question").blur(); }
});
$("question").addEventListener("blur", () => { saveQuestion(); });

// --- Live state ---
function formatSummary(sum) {
  if (!sum) return "";
  const median = sum.median != null ? escapeHtml(String(sum.median)) : "—";
  const count = sum.count || 0;
  const specialNote = sum.special && sum.special.length
    ? sum.special.map(x => escapeHtml(String(x))).join(", ")
    : "";
  return `<span class="median-lbl">Median</span>
    <div class="median-hero" data-testid="summary-median">${median}</div>
    <div class="substats">
      <span>Votes <span class="val">${count}</span></span>
    </div>
    ${specialNote ? `<div class="spread">Non-numeric: ${specialNote}</div>` : ""}`;
}

function renderHistory(history) {
  const list = $("historyList");
  const countEl = $("historyCount");
  if (!list) return;
  const items = history || [];
  countEl.textContent = items.length ? `(${items.length})` : "";
  if (!items.length) {
    list.innerHTML = `<div class="history-empty">No past rounds yet this session.</div>`;
    return;
  }
  list.innerHTML = items.map(h => {
    const q = h.question ? escapeHtml(h.question) : '<em style="color:var(--faint)">No question</em>';
    const s = h.summary || {};
    const median = s.median != null ? escapeHtml(String(s.median)) : "—";
    const count = s.count || 0;
    return `<div class="history-item" data-testid="history-item">
      <div class="hq">Round ${h.round}: ${q}</div>
      <div class="hm">median ${median} · ${count} votes</div>
    </div>`;
  }).join("");
}

function render(s) {
  setRoomTitle(s.title);
  // A delayed SSE snapshot may predate our join or resume. Only an
  // authenticated server response can establish that our seat is gone.
  if (myId && !(s.players || []).some(p => p.id === myId)) {
    if (!checkingSeat) {
      checkingSeat = true;
      act("/heartbeat").then(res => { if (res && res.ok) return refreshState(); })
        .catch(() => {}).finally(() => { checkingSeat = false; });
    }
    return;
  }
  const prevPhase = lastPhase;
  lastState = s;
  lastPhase = s.phase;

  updateTaken(s.players.filter(p => p.role !== "observer").map(p => p.name));
  $("round").textContent = s.round;
  $("phaseBadge").textContent = s.phase === "revealed" ? "revealed" : s.phase === "voting" ? "voting" : "lobby";
  if (document.activeElement !== $("question")) $("question").value = s.question || "";

  // Reveal sound once when phase flips to revealed
  if (prevPhase && prevPhase !== "revealed" && s.phase === "revealed") {
    playRevealFeedback();
  }

  const me = s.players.find(p => p.id === myId);
  const amHost = !!(me && (me.isHost || me.id === s.hostId));

  const hostBar = $("hostBar");
  if (hostBar) {
    hostBar.classList.toggle("hidden", !amHost);
    if (!amHost) {
      const hm = $("hostMenu");
      if (hm) hm.classList.add("hidden");
      const hb = $("hostMenuBtn");
      if (hb) hb.setAttribute("aria-expanded", "false");
    }
    if (amHost && document.activeElement !== $("lockToggle")) {
      $("lockToggle").checked = !!s.locked;
    }
  }

  const table = $("table");
  table.innerHTML = "";
  s.players.forEach(p => {
    const d = document.createElement("div");
    d.className = "player";
    if (p.id === myId) d.classList.add("me");
    if (p.isHost || p.id === s.hostId) d.classList.add("host");
    if (p.role === "observer") d.classList.add("observer");
    if (p.stale) d.classList.add("stale");
    const voteText = p.vote === "🔒" ? "🔒" : p.vote ? p.vote : "—";
    if (p.vote && !p.revealed) d.classList.add("voted");

    const chips = [];
    if (p.id === myId) chips.push(`<span class="chip you">you</span>`);
    if (p.isHost || p.id === s.hostId) chips.push(`<span class="chip host" data-testid="host-badge">host</span>`);
    if (p.role === "observer") chips.push(`<span class="chip obs" data-testid="observer-badge">OBSERVER</span>`);
    if (p.stale) chips.push(`<span class="chip stale">away</span>`);

    let seatMenu = "";
    if (amHost && p.id !== myId) {
      seatMenu = `<div class="seat-menu-wrap">
        <button type="button" class="seat-menu-btn" data-testid="seat-menu-btn" aria-label="Seat options">⋯</button>
        <div class="seat-menu hidden" role="menu">
          <button type="button" class="kick" data-testid="kick-btn" data-id="${escapeAttr(p.id)}">Kick</button>
        </div>
      </div>`;
    }

    // Names are clamped to two lines, so carry the full label as a tooltip
    // (hover on desktop, long-press on Android) instead of losing it.
    const subHtml = p.subtitle
      ? `<span class="sub" data-testid="seat-subtitle">${escapeHtml(p.subtitle)}</span>`
      : "";
    d.innerHTML = `<div class="badges">${chips.join("")}</div>${playerAvatar(p, "pic")}<span class="nm" title="${escapeAttr(playerLabel(p))}">${escapeHtml(playerLabel(p))}</span>${subHtml}<div class="vote">${voteText}</div>${seatMenu}`;
    bindImgFallback(d);
    const seatBtn = d.querySelector(".seat-menu-btn");
    const seatPanel = d.querySelector(".seat-menu");
    if (seatBtn && seatPanel) {
      seatBtn.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll(".seat-menu").forEach(m => { if (m !== seatPanel) m.classList.add("hidden"); });
        seatPanel.classList.toggle("hidden");
      };
    }
    const kick = d.querySelector(".kick");
    if (kick) kick.onclick = (e) => { e.stopPropagation(); kickPlayer(kick.dataset.id); };
    d.dataset.id = p.id;
    table.appendChild(d);
  });

  // Vote summary
  const sumEl = $("voteSummary");
  if (sumEl) {
    if (s.phase === "revealed" && s.summary) {
      sumEl.innerHTML = formatSummary(s.summary);
      sumEl.classList.remove("hidden");
    } else {
      sumEl.classList.add("hidden");
      sumEl.innerHTML = "";
    }
  }

  renderHistory(s.history);

  const voters = s.players.filter(p => p.role !== "observer");
  const voted = voters.filter(p => p.hasVoted).length;
  const st = $("status");
  st.classList.remove("hot");
  if (s.phase === "revealed") { st.textContent = "Cards revealed. Discuss, then next round."; st.classList.add("hot"); }
  else if (s.locked) st.textContent = (voted ? `${voted}/${voters.length} have played.` : "Waiting for the first play…") + " · joining locked";
  else if (voters.length === 0) st.textContent = "The boardroom is empty.";
  else if (voted === 0) st.textContent = "Waiting for the first play…";
  else if (voted < voters.length) st.textContent = `${voted}/${voters.length} have played.`;
  else { st.textContent = "All cards are on the table. Reveal them."; st.classList.add("hot"); }

  // Observers: fully hide vote deck
  const isObs = !!(me && me.role === "observer");
  $("playCard").classList.toggle("hidden", isObs);
  // Leave link still available for observers — put a small leave under history if needed
  if (isObs && !$("obsLeave")) {
    // noop — leave stays inside playCard; add leave under history for observers
  }
  let obsLeave = $("obsLeaveWrap");
  if (isObs) {
    if (!obsLeave) {
      obsLeave = document.createElement("div");
      obsLeave.id = "obsLeaveWrap";
      obsLeave.className = "leave";
      obsLeave.innerHTML = `<a id="obsLeave" data-testid="leave-link">leave the boardroom</a>`;
      $("historyCard").after(obsLeave);
      obsLeave.querySelector("a").onclick = () => $("leaveLink").click();
    }
    obsLeave.classList.remove("hidden");
  } else if (obsLeave) {
    obsLeave.classList.add("hidden");
  }

  const revealed = s.phase === "revealed";
  $("revealBtn").classList.toggle("hidden", revealed);
  $("revoteBtn").classList.toggle("hidden", !revealed);
  if (!revealed && !$("revealBtn").classList.contains("busy")) {
    $("revealBtn").disabled = false;
    $("revealBtn").textContent = "Reveal all";
  }
  if (me) {
    const savedVote = localStorage.getItem("sbw_myvote");
    const savedVoteRound = localStorage.getItem("sbw_myvote_round");
    const savedVoteRoom = localStorage.getItem("sbw_myvote_room");
    if (savedVote && (!me.hasVoted || savedVoteRound !== String(s.round) || savedVoteRoom !== roomId)) {
      localStorage.removeItem("sbw_myvote");
      localStorage.removeItem("sbw_myvote_round");
      localStorage.removeItem("sbw_myvote_room");
    }
    document.querySelectorAll(".poker-card").forEach(b =>
      b.classList.toggle("sel", b.dataset.v === (localStorage.getItem("sbw_myvote") || "")));
  }
  syncHand(s, me);
  renderActor(s);
}

// The hand shrinks once you have played or the cards are revealed, so the
// table, the revealed votes and the median always stay in view.
function syncHand(s, me) {
  const hand = $("playCard");
  const revealed = s.phase === "revealed";
  const played = !!(me && me.hasVoted);
  const compact = revealed || played;
  hand.classList.toggle("compact", compact);
  hand.classList.toggle("revealed", revealed);
  hand.classList.toggle("docked", !compact);
  const pick = localStorage.getItem("sbw_myvote") || (revealed && me && me.vote && me.vote !== "🔒" ? me.vote : "");
  $("handPick").textContent = played && pick ? "· " + pick : "";
  document.querySelectorAll(".poker-card").forEach((b) => { b.disabled = revealed; });
}

// --- Who did that ---
// One quiet line in the stage head ("Marc revealed the cards") plus a short
// glow on that seat. It shows only for an action that happens while you watch,
// fades after a few seconds, and the next action simply replaces it.
const ACTOR_SHOW_MS = 4000;
const ACTOR_SEAT_MS = 1600;
let actorSeen = null;
let actorTimer = null;
function actorPhrase(a, s) {
  switch (a.type) {
    case "reveal": return "revealed the cards";
    case "revote": return "started a re-vote";
    case "next": return "started round " + (a.detail || s.round);
    case "question": return "changed the story";
    case "kick": return "removed " + displayName(a.detail);
    case "lock": return "locked joining";
    case "unlock": return "unlocked joining";
    default: return null;
  }
}
function displayName(name) {
  const r = ROSTER_BY_NAME[name];
  return r ? r.first : String(name || "Someone");
}
function renderActor(s) {
  const a = s.lastAction;
  const line = $("actorLine");
  const key = a ? a.type + "|" + a.at + "|" + a.playerId : null;
  if (!renderActor.started) {
    // Opening the page shows the board as it is, not what happened before you came.
    renderActor.started = true;
    actorSeen = key;
    return;
  }
  if (key === actorSeen) {
    // Same action, redrawn table: keep the glow on the seat while it lasts.
    if (line.classList.contains("on") && Date.now() - (renderActor.shownAt || 0) < ACTOR_SEAT_MS) markActorSeat(a);
    return;
  }
  actorSeen = key;
  if (!a) return;
  const phrase = actorPhrase(a, s);
  if (!phrase) return;
  const who = a.playerId === myId ? "You" : displayName(a.playerName);
  line.innerHTML = `<b>${escapeHtml(who)}</b> ${escapeHtml(phrase)}`;
  line.title = line.textContent;
  line.classList.add("on");
  renderActor.shownAt = Date.now();
  markActorSeat(a);
  clearTimeout(actorTimer);
  actorTimer = setTimeout(() => line.classList.remove("on"), ACTOR_SHOW_MS);
}
function markActorSeat(a) {
  const seat = [...document.querySelectorAll("#table .player")].find(el => el.dataset.id === a.playerId);
  if (!seat) return;
  seat.classList.add("actor");
  setTimeout(() => seat.classList.remove("actor"), Math.max(0, ACTOR_SEAT_MS - (Date.now() - renderActor.shownAt)));
}

function escapeHtml(x) { const d = document.createElement("div"); d.textContent = x; return d.innerHTML; }

function connect() {
  if (es) { try { es.close(); } catch {} }
  if (!roomId) return;
  es = new EventSource("/planning-poker/api/rooms/" + roomId + "/events");
  es.onmessage = e => render(JSON.parse(e.data));
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

(async () => {
  const fromPath = parseRoomFromPath();
  if (fromPath) await enterRoom(fromPath);
  else show("lobby");
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/planning-poker/sw.js", { scope: "/planning-poker/" }).catch(() => {});
}
