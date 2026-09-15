/**
 * Side panel UI — three screens: home, new stalk, monitor.
 *
 * Ordering honesty is the organising principle here. Instagram serves these
 * lists in ranked display order and publishes no follow date, so:
 *
 *   - A first capture is shown ALPHABETICALLY. Its true order is unknowable,
 *     and there is deliberately no way to sort it by time, because any such
 *     control would imply a chronology that does not exist.
 *   - Later captures are shown as arrivals GROUPED BY CHECK TIME. Between
 *     groups the order is real. Inside a group it is not — those accounts only
 *     share the same check — so groups are visually banded and say so.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  screenHome: $('screenHome'),
  screenNew: $('screenNew'),
  screenMon: $('screenMon'),
  newStalkBtn: $('newStalkBtn'),
  monitorBtn: $('monitorBtn'),

  username: $('username'),
  kind: $('kind'),
  speed: $('speed'),
  startBtn: $('startBtn'),
  resumeBtn: $('resumeBtn'),
  stopBtn: $('stopBtn'),

  trackSelect: $('trackSelect'),
  checkBtn: $('checkBtn'),
  monCounts: $('monCounts'),
  monStopBtn: $('monStopBtn'),
  monDeleteBtn: $('monDeleteBtn'),

  activity: $('activity'),
  progress: $('progress'),
  progressBar: $('progressBar'),
  status: $('status'),
  alert: $('alert'),
  doneMsg: $('doneMsg'),
  greeting: $('greeting'),
  confetti: $('confetti'),

  viewport: $('viewport'),
  spacer: $('spacer'),
  rows: $('rows'),
  monList: $('monList'),
  empty: $('empty'),
};

const ROW_H =
  parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10) || 52;
const OVERSCAN = 6;

const SPEEDS = {
  safe: { pageSize: 50, delayMs: 2000 },
  fast: { pageSize: 200, delayMs: 600 },
  max: { pageSize: 200, delayMs: 0 },
};

let screen = 'home';
let runs = [];
let tracks = [];
let activeRunId = null;
let selfId = null;

let currentId = null; // selected run (new-stalk screen)
let summary = null;
let all = []; // capture rows
let view = []; // alphabetical, filtered

let monKey = null; // selected watched list
let monData = null; // { summary, accounts, snapshots }
let pendingCheck = null; // trackKey awaiting a finished capture

const nf = new Intl.NumberFormat();
const dtfFull = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { ok: false, error: 'No response from the extension worker.' });
      });
    } catch (_) {
      resolve({ ok: false, error: 'Extension context unavailable — reload the extension.' });
    }
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

const byName = (a, b) =>
  String(a.username || '').localeCompare(String(b.username || ''), undefined, {
    sensitivity: 'base',
  });

// --- screens -----------------------------------------------------------------

function show(next) {
  screen = next;
  els.screenHome.hidden = next !== 'home';
  els.screenNew.hidden = next !== 'new';
  els.screenMon.hidden = next !== 'monitor';

  els.activity.hidden = next === 'home';
  els.viewport.hidden = next !== 'new';
  els.monList.hidden = next !== 'monitor';
  if (next !== 'monitor') els.monCounts.hidden = true;
  els.empty.hidden = true;

  if (next === 'home') els.doneMsg.hidden = true;
  render();
}

// --- flat alphabetical list (virtualised) ------------------------------------

function userRowHtml(u, lead) {
  const tags = [];
  if (u.confirmed === false) {
    tags.push(
      '<span class="tag warn" title="The previous capture was short, so this may have been missed then rather than followed since">unverified</span>'
    );
  }
  if (u.isVerified) tags.push('<span class="tag v">verified</span>');
  if (u.isPrivate) tags.push('<span class="tag">private</span>');
  const handle = esc(u.username || `(id ${u.pk})`);
  const link = u.username
    ? `<a class="uname" href="https://www.instagram.com/${encodeURIComponent(
        u.username
      )}/" target="_blank" rel="noreferrer noopener">${handle}</a>`
    : `<span class="uname">${handle}</span>`;
  return (
    '<div class="item">' +
    (lead || '') +
    `<span class="who">${link}<span class="name">${esc(u.fullName) || '&nbsp;'}</span></span>` +
    `<span class="tags">${tags.join('')}</span>` +
    '</div>'
  );
}

function renderWindow() {
  const total = view.length;
  els.spacer.style.height = `${total * ROW_H}px`;
  if (total === 0) {
    els.rows.textContent = '';
    return;
  }
  const height = els.viewport.clientHeight || 400;
  const start = Math.max(0, Math.floor(els.viewport.scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((els.viewport.scrollTop + height) / ROW_H) + OVERSCAN);
  let html = '';
  for (let i = start; i < end; i++) html += userRowHtml(view[i]);
  els.rows.style.transform = `translateY(${start * ROW_H}px)`;
  els.rows.innerHTML = html;
}

function applyFilter() {
  view = all.slice().sort(byName);
  renderWindow();
}

// --- grouped arrivals --------------------------------------------------------

/** Arrivals bucketed by the capture that first saw them, newest bucket first. */
function arrivalGroups() {
  if (!monData) return [];
  const buckets = new Map();
  for (const a of monData.accounts) {
    if (a.baseline) continue; // present at first capture — arrival time unknown
    const list = buckets.get(a.firstSeenAt) || [];
    list.push(a);
    buckets.set(a.firstSeenAt, list);
  }
  return [...buckets.entries()]
    .sort((x, y) => y[0] - x[0])
    .map(([at, list]) => ({ at, users: list.sort(byName) }));
}

/** Instagram's own displayed counts for the watched account, not our tally. */
function renderCounts() {
  const s = monData && monData.summary;
  if (!s || (s.reportedFollowers == null && s.reportedFollowing == null)) {
    els.monCounts.hidden = true;
    return;
  }
  const part = (n, label) =>
    n == null ? '' : `<span><b>${nf.format(n)}</b>${label}</span>`;
  els.monCounts.innerHTML =
    part(s.reportedFollowers, 'followers') + part(s.reportedFollowing, 'following');
  els.monCounts.hidden = false;
}

function renderGroups() {
  const groups = arrivalGroups();
  const s = monData && monData.summary;

  if (!monData) {
    els.monList.innerHTML = '';
    els.empty.hidden = false;
    els.empty.innerHTML = '<p><strong>Nothing being watched yet.</strong></p>';
    return;
  }

  if (!groups.length) {
    els.monList.innerHTML = '';
    els.empty.hidden = false;
    els.empty.innerHTML = `<p><strong>Nobody new yet.</strong></p><p class="fine">${nf.format(
      s.baselineCount
    )} accounts were already there when you started watching on ${esc(
      new Date(s.firstSnapshotAt).toLocaleDateString()
    )} — they are not shown, because there is no way to know what order they were added in.</p>
      <p class="fine">Hit <em>Check now</em> to look again.</p>`;
    return;
  }

  els.empty.hidden = true;
  const out = [];
  groups.forEach((g, gi) => {
    const shaky = g.users.filter((u) => u.confirmed === false);
    const reason = shaky.length ? shaky[0].confirmReason : null;
    out.push(
      `<div class="ghead"><span class="gtime">${esc(dtfFull.format(new Date(g.at)))}</span>` +
        // Only the newest check gets the badge — on older groups it reads as
        // though those arrivals are new too.
        (gi === 0 ? `<span class="gcount">${nf.format(g.users.length)} new</span>` : '') +
        '</div>' +
        // The generic "no order here" caveat lives in the footer now; this
        // line survives only when there is something specific to warn about.
        (shaky.length
          ? `<div class="gnote"><b>${nf.format(shaky.length)} unverified</b>: ${esc(
              reason || 'the previous capture came up short'
            )}, so they may have been followed long ago and simply missed</div>`
          : '')
    );
    out.push('<div class="gbody">');
    for (const u of g.users) out.push(userRowHtml(u));
    out.push('</div>');
  });
  out.push(
    `<div class="gfoot">${nf.format(s.baselineCount)} accounts predate the watch and are not listed.` +
      `<br><span class="gfoot-warn">Accounts under the same date were all found by that one check — ` +
      `they are not in order relative to each other.</span></div>`
  );
  els.monList.innerHTML = out.join('');
}

// --- controls ----------------------------------------------------------------

function busyRun() {
  const a = runs.find((r) => r.id === activeRunId);
  return a && (a.status === 'running' || a.status === 'starting') ? a : null;
}

function renderControls() {
  const active = busyRun();
  const busy = !!active;

  els.startBtn.hidden = busy;
  els.stopBtn.hidden = !busy;
  els.startBtn.disabled = busy;
  els.username.disabled = busy;
  els.kind.disabled = busy;
  els.speed.disabled = busy;

  const shown = runs.find((r) => r.id === currentId);
  const canResume = !busy && !!shown && shown.resumable;
  els.resumeBtn.hidden = busy || !canResume;
  els.resumeBtn.textContent = `Resume from ${nf.format(shown ? shown.total : 0)}`;

  els.checkBtn.hidden = busy;
  els.monStopBtn.hidden = !busy;
  els.checkBtn.disabled = busy || !monKey;
  els.monDeleteBtn.disabled = busy || !monKey;

  els.progress.hidden = !busy;
  if (busy) {
    const known = active.expectedTotal != null && active.expectedTotal > 0;
    els.progress.classList.toggle('indeterminate', !known);
    els.progressBar.style.width = known
      ? `${Math.min(100, (active.total / active.expectedTotal) * 100).toFixed(1)}%`
      : '';
    const who = active.targetUsername ? `@${active.targetUsername}` : '…';
    // Pass number matters: a second pass re-walks the whole list from the top,
    // so without this the progress bar appears to restart for no reason.
    const passNote = active.pass > 0 ? ` · re-check ${active.pass + 1}` : '';
    els.status.textContent =
      (known
        ? `Reading ${active.kind} of ${who} — ${nf.format(active.total)} / ${nf.format(
            active.expectedTotal
          )}`
        : `Reading ${active.kind} of ${who} — ${nf.format(active.total)} so far`) + passNote;
  } else if (!els.status.dataset.sticky) {
    els.status.textContent = '';
  }

  const alerts = [];
  if (active && active.warning) alerts.push(active.warning);
  if (shown && shown.error && screen === 'new') alerts.push(shown.error);
  els.alert.hidden = alerts.length === 0;
  if (alerts.length) els.alert.textContent = alerts.join(' ');
}

function render() {
  renderControls();
  if (screen === 'new') {
    applyFilter();
    els.empty.hidden = all.length > 0 || !!busyRun();
    if (els.empty.hidden === false && !summary) {
      els.empty.innerHTML =
        '<p><strong>Pick someone to watch.</strong></p><p class="fine">Enter a username and hit Start. The first capture is the baseline.</p>';
    }
  } else if (screen === 'monitor') {
    renderCounts();
    renderGroups();
  }
}

// --- loading -----------------------------------------------------------------

async function loadState() {
  const res = await send({ type: 'IGFO_GET_STATE' });
  runs = res.ok ? res.runs : [];
  activeRunId = res.ok ? res.activeRunId : null;
  if (res.ok && res.selfId) selfId = res.selfId;
  renderControls();
}

async function loadTracks() {
  const res = await send({ type: 'IGFO_LIST_TRACKS' });
  tracks = res.ok ? res.tracks : [];
  tracks.sort((a, b) => (b.lastSnapshotAt || 0) - (a.lastSnapshotAt || 0));

  els.trackSelect.textContent = '';
  if (!tracks.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Nothing watched yet';
    els.trackSelect.append(o);
    els.trackSelect.disabled = true;
    monKey = null;
    monData = null;
    return;
  }
  els.trackSelect.disabled = false;
  for (const t of tracks) {
    const o = document.createElement('option');
    o.value = t.key;
    o.textContent = `${t.username ? '@' + t.username : t.targetId} · ${t.kind} · ${nf.format(
      t.datedCount
    )} new`;
    els.trackSelect.append(o);
  }
  if (!monKey || !tracks.some((t) => t.key === monKey)) monKey = tracks[0].key;
  els.trackSelect.value = monKey;
}

async function loadMon() {
  monData = null;
  if (!monKey) return;
  const res = await send({ type: 'IGFO_GET_TRACK', key: monKey });
  if (res.ok) monData = { summary: res.summary, accounts: res.accounts, snapshots: res.snapshots };
}

async function loadRun(id) {
  currentId = id;
  summary = null;
  all = [];
  if (id) {
    const res = await send({ type: 'IGFO_GET_RUN', runId: id });
    if (res.ok) {
      summary = res.summary;
      all = res.users;
    }
  }
}

// --- live updates ------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return;

  // A capture was folded into the history. This is the authoritative signal
  // that the arrivals view is out of date — no run bookkeeping involved.
  if (message.type === 'IGFO_TRACK_UPDATED') {
    (async () => {
      await loadTracks();
      if (!monKey || monKey === message.key) {
        monKey = message.key;
        els.trackSelect.value = monKey;
        await loadMon();
      }
      if (screen === 'monitor') {
        render();
        const bits = [];
        bits.push(
          message.arrived
            ? `${nf.format(message.arrived)} new since the last check.`
            : 'Nobody new since the last check.'
        );
        // Say it plainly rather than showing them as arrivals with a caveat.
        if (message.absorbed) {
          bits.push(
            `${nf.format(message.absorbed)} missed by an earlier scan — added to the baseline, not counted as new.`
          );
        }
        setStatus(bits.join(' '), true);
      }
    })();
    return;
  }

  if (message.type === 'IGFO_STATE') {
    runs = message.runs;
    activeRunId = message.activeRunId;
    if (message.selfId) selfId = message.selfId;

    const fresh = runs.find((r) => r.id === currentId);
    const finished = fresh && fresh.status !== 'running' && fresh.status !== 'starting';
    if (fresh) summary = fresh;

    // trackKey is only known once the page has resolved the target, so read it
    // off the finished run rather than guessing it at start time.
    if (finished && pendingCheck && fresh && fresh.trackKey) {
      pendingCheck = null;
      onCaptureFinished(fresh.trackKey, fresh);
      return;
    }
    if (finished) pendingCheck = null;
    render();
    return;
  }

  if (message.type !== 'IGFO_APPEND') return;
  const target = runs.find((r) => r.id === message.runId);
  if (target) Object.assign(target, message.summary);
  if (message.runId === currentId) {
    summary = message.summary;
    all = all.concat(message.users);
  }
  if (screen === 'new') render();
  else renderControls();
});

/** A capture just completed: either it was the baseline, or it is a re-check. */
async function onCaptureFinished(key, run) {
  await loadTracks();
  monKey = key;
  await loadMon();

  const isBaseline = monData && monData.summary.snapshotCount === 1;

  if (screen === 'new' && isBaseline) {
    els.doneMsg.hidden = false;
    els.doneMsg.innerHTML =
      `<strong>Baseline saved — ${nf.format(all.length)} accounts.</strong> ` +
      `We'll keep an eye on them from now on. Come back to <em>Monitor a user</em> to see who they add.` +
      `<br><span class="fine">Listed A-Z below. Instagram does not say what order these were followed in, so this list has no chronology — only what comes next does.</span>`;
    render();
    return;
  }

  // A re-check: the arrivals are what matter, so go straight to them.
  els.doneMsg.hidden = true;
  els.trackSelect.value = monKey;
  show('monitor');
}


// --- actions -----------------------------------------------------------------

function setStatus(text, sticky) {
  els.status.textContent = text;
  if (sticky) els.status.dataset.sticky = '1';
  else delete els.status.dataset.sticky;
}

async function beginCapture(usernameOrId, kind) {
  const speed = SPEEDS[els.speed.value] || SPEEDS.safe;
  els.alert.hidden = true;
  els.doneMsg.hidden = true;
  setStatus('Resolving…', true);

  const res = await send({
    type: 'IGFO_START',
    kind,
    username: usernameOrId,
    pageSize: speed.pageSize,
    delayMs: speed.delayMs,
  });

  if (!res.ok) {
    setStatus('', false);
    els.alert.hidden = false;
    els.alert.textContent = res.error || 'Could not start.';
    return false;
  }
  delete els.status.dataset.sticky;
  await loadRun(res.runId);
  await loadState();
  render();
  return true;
}

async function startNew() {
  const name = els.username.value.replace(/^@/, '').trim();
  if (!name) {
    els.username.focus();
    setStatus('Enter a username first.', true);
    return;
  }
  pendingCheck = true;
  if (!(await beginCapture(name, els.kind.value))) pendingCheck = null;
}

async function checkNow() {
  if (!monKey || !monData) return;
  const s = monData.summary;
  pendingCheck = monKey;
  await beginCapture(s.targetId || s.username, s.kind);
}

async function stopCapture() {
  els.stopBtn.disabled = true;
  els.monStopBtn.disabled = true;
  await send({ type: 'IGFO_ABORT' });
  els.stopBtn.disabled = false;
  els.monStopBtn.disabled = false;
}

async function resume() {
  if (!currentId) return;
  const speed = SPEEDS[els.speed.value] || SPEEDS.safe;
  els.resumeBtn.disabled = true;
  const res = await send({
    type: 'IGFO_RESUME',
    runId: currentId,
    pageSize: speed.pageSize,
    delayMs: speed.delayMs,
  });
  if (!res.ok) {
    els.alert.hidden = false;
    els.alert.textContent = res.error || 'Could not resume.';
  }
  await loadState();
  render();
}

// --- greeting ----------------------------------------------------------------

// Saturated enough to read against the light pink ground.
const CONFETTI_COLORS = ['#e0357f', '#c13584', '#ff8fc0', '#fcaf45', '#7a5cf0', '#ff5f8d'];

const GREETED_KEY = 'greetedAt';

/**
 * The greeting is a one-time thing: first ever open of the extension, never
 * again. The flag lives in chrome.storage.local, which survives browser
 * restarts, and is deliberately not touched by "clear all" — wiping captured
 * data should not resurrect the welcome.
 */
async function maybeGreet() {
  let seen = false;
  try {
    const got = await chrome.storage.local.get(GREETED_KEY);
    seen = !!(got && got[GREETED_KEY]);
  } catch (_) {
    // Storage unreadable (shouldn't happen with the storage permission). Fail
    // toward showing it rather than silently swallowing a first run.
    seen = false;
  }
  if (seen) return;

  // Written before the animation, not after, so closing the panel mid-greeting
  // still counts as having seen it.
  try {
    await chrome.storage.local.set({ [GREETED_KEY]: Date.now() });
  } catch (_) {}

  playGreeting();
}

function playGreeting() {
  els.greeting.hidden = false;
  const reduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduced) {
    const frag = document.createDocumentFragment();
    // Staggered across the whole hold so it keeps falling rather than
    // finishing in the first second and leaving a static screen.
    for (let i = 0; i < 90; i++) {
      const bit = document.createElement('span');
      const size = 7 + Math.random() * 9;
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.width = `${size}px`;
      bit.style.height = `${size * (0.5 + Math.random())}px`;
      bit.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      bit.style.animationDelay = `${Math.random() * 4}s`;
      bit.style.animationDuration = `${2.2 + Math.random() * 1.8}s`;
      bit.style.setProperty('--spin', `${Math.random() * 900 - 450}deg`);
      if (Math.random() < 0.35) bit.style.borderRadius = '50%';
      frag.append(bit);
    }
    els.confetti.append(frag);
  }

  setTimeout(() => els.greeting.classList.add('fading'), 5200);
  setTimeout(() => {
    els.greeting.hidden = true;
    els.confetti.textContent = ''; // stop the animations once it is gone
  }, 6400);
}

// --- events ------------------------------------------------------------------

els.newStalkBtn.addEventListener('click', async () => {
  currentId = null;
  summary = null;
  all = [];
  els.doneMsg.hidden = true;
  show('new');
  els.username.focus();
});

els.monitorBtn.addEventListener('click', async () => {
  await loadTracks();
  await loadMon();
  show('monitor');
});

for (const b of document.querySelectorAll('[data-home]')) {
  b.addEventListener('click', () => show('home'));
}

els.startBtn.addEventListener('click', startNew);
els.username.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !els.startBtn.hidden) startNew();
});
els.resumeBtn.addEventListener('click', resume);
els.stopBtn.addEventListener('click', stopCapture);
els.monStopBtn.addEventListener('click', stopCapture);
els.checkBtn.addEventListener('click', checkNow);

els.trackSelect.addEventListener('change', async () => {
  monKey = els.trackSelect.value;
  await loadMon();
  render();
});

els.viewport.addEventListener('scroll', renderWindow, { passive: true });
window.addEventListener('resize', renderWindow);

let deleteArmed = false;
let deleteTimer = null;
els.monDeleteBtn.addEventListener('click', async () => {
  if (!monKey) return;
  if (!deleteArmed) {
    deleteArmed = true;
    els.monDeleteBtn.classList.add('armed');
    els.monDeleteBtn.textContent = 'Sure?';
    deleteTimer = setTimeout(() => {
      deleteArmed = false;
      els.monDeleteBtn.classList.remove('armed');
      els.monDeleteBtn.innerHTML = '&#10005;';
    }, 3000);
    return;
  }
  clearTimeout(deleteTimer);
  deleteArmed = false;
  els.monDeleteBtn.classList.remove('armed');
  els.monDeleteBtn.innerHTML = '&#10005;';
  await send({ type: 'IGFO_DELETE_TRACK', key: monKey });
  monKey = null;
  await loadTracks();
  await loadMon();
  render();
});

maybeGreet();
show('home');
loadState();
loadTracks();
