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
  screenSelf: $('screenSelf'),
  screenCompare: $('screenCompare'),
  newStalkBtn: $('newStalkBtn'),
  monitorBtn: $('monitorBtn'),
  selfBtn: $('selfBtn'),
  compareBtn: $('compareBtn'),
  storiesBtn: $('storiesBtn'),
  screenStories: $('screenStories'),
  storyUser: $('storyUser'),
  storyLoadBtn: $('storyLoadBtn'),
  storyStatus: $('storyStatus'),

  cmpA: $('cmpA'),
  cmpB: $('cmpB'),
  cmpKind: $('cmpKind'),
  cmpMode: $('cmpMode'),
  cmpCounts: $('cmpCounts'),
  cmpNote: $('cmpNote'),
  cmpRescanBtn: $('cmpRescanBtn'),

  selfTitle: $('selfTitle'),
  selfCounts: $('selfCounts'),
  selfFollowingState: $('selfFollowingState'),
  selfFollowersState: $('selfFollowersState'),
  scanFollowingBtn: $('scanFollowingBtn'),
  scanFollowersBtn: $('scanFollowersBtn'),
  selfWarn: $('selfWarn'),
  selfSpeed: $('selfSpeed'),
  selfStopBtn: $('selfStopBtn'),
  selfMode: $('selfMode'),

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

  exportBar: $('exportBar'),
  exportCount: $('exportCount'),
  exportFormat: $('exportFormat'),
  exportBtn: $('exportBtn'),

  ver: $('ver'),
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

// My-account screen: the two sides of my own graph, diffed against each other.
let selfFollowing = null;
let selfFollowers = null;

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
      resolve({ ok: false, error: 'Extension context unavailable. Reload the extension.' });
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
  els.screenSelf.hidden = next !== 'self';
  els.screenCompare.hidden = next !== 'compare';
  els.screenStories.hidden = next !== 'stories';

  els.activity.hidden = next === 'home' || next === 'compare' || next === 'stories';
  els.viewport.hidden = next !== 'new';
  // monList is the generic scrolling results container, shared by every
  // list-rendering screen.
  els.monList.hidden = next === 'home' || next === 'new';
  if (next !== 'monitor') els.monCounts.hidden = true;
  els.empty.hidden = true;

  if (next === 'home') els.doneMsg.hidden = true;
  // Stale until the incoming screen's renderer repopulates it; clearing first
  // stops the bar briefly offering the previous screen's list.
  setExportSet([]);
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
  // No blue-check tag. Instagram's "verified" and this list's "unverified"
  // mean unrelated things — one is the account's badge, the other is whether
  // we trust the arrival date — and a verified account arriving in a short
  // batch rendered both side by side. isVerified is still captured and stored
  // if it's ever wanted again.
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
  setExportSet(view.map((u) => ({ user: u })));
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

/**
 * Surfaces captures that collected accounts but never became a watch, with a
 * button to adopt them. This exists because a capture going in without its
 * watch coming out is otherwise invisible and unrecoverable.
 */
async function showOrphans() {
  const res = await send({ type: 'IGFO_ORPHAN_RUNS' });
  if (!res.ok || !res.orphans.length) return;

  const rows = res.orphans
    .map(
      (o) =>
        `<button class="orphan" data-run="${esc(o.id)}">Save ${esc(
          o.username ? '@' + o.username : o.targetId
        )} · ${o.kind} · ${nf.format(o.total)} accounts</button>`
    )
    .join('');

  els.empty.innerHTML =
    `<p><strong>Nothing being watched yet.</strong></p>` +
    `<p class="fine">But ${res.orphans.length === 1 ? 'a capture' : 'some captures'} finished ` +
    `without being saved. Adopt ${res.orphans.length === 1 ? 'it' : 'them'} as a baseline:</p>` +
    `<div class="orphans">${rows}</div>`;

  for (const b of els.empty.querySelectorAll('.orphan')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Saving…';
      const fixed = await send({ type: 'IGFO_INGEST_RUN', runId: b.dataset.run });
      if (fixed.ok) {
        monKey = fixed.key;
        await loadTracks();
        els.trackSelect.value = monKey;
        await loadMon();
        render();
      } else {
        b.textContent = fixed.error || 'Could not save';
      }
    });
  }
}

// --- my account --------------------------------------------------------------

/** Accounts currently in a list — everyone seen, minus those since departed. */
function members(track) {
  return track ? track.accounts.filter((a) => !a.goneAt) : [];
}

/**
 * Whether a captured side can be trusted for a difference.
 *
 * This matters more here than anywhere else in the app: "doesn't follow you
 * back" is computed by subtracting one list from the other, so anyone MISSING
 * from the followers capture is wrongly accused of not following you. A short
 * followers scan produces a list of false accusations, which is worse than no
 * list at all — hence the loud warning rather than a quiet asterisk.
 */
function sideQuality(track) {
  if (!track || !track.snapshots.length) return { ok: false, reason: 'never scanned' };
  const last = track.snapshots[track.snapshots.length - 1];
  const when = new Date(last.at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Judge the ACCUMULATED membership, not the last run alone. Every capture
  // unions into the same record, so a track can hold more than any single run
  // collected — scoring the last run understated what is actually stored.
  const have = members(track).length;
  const want = last.expectedTotal;
  if (want != null && want > 0) {
    const shortBy = want - have;
    // A small permanent gap is expected: the reported count includes
    // deactivated accounts that are never returned by the list endpoint.
    if (shortBy > Math.max(5, want * 0.02)) {
      return {
        ok: false,
        when,
        short: shortBy,
        reason: `${nf.format(have)} of ${nf.format(want)}, ${when}`,
      };
    }
  }
  return { ok: true, when, reason: `${nf.format(have)} accounts, ${when}` };
}

function renderSelf() {
  const handle =
    (selfFollowing && selfFollowing.summary.username) ||
    (selfFollowers && selfFollowers.summary.username) ||
    null;
  els.selfTitle.textContent = handle ? `@${handle}` : 'My account';

  const followingQ = sideQuality(selfFollowing);
  const followersQ = sideQuality(selfFollowers);
  els.selfFollowingState.textContent = followingQ.reason;
  els.selfFollowersState.textContent = followersQ.reason;
  els.selfFollowingState.classList.toggle('bad', !followingQ.ok);
  els.selfFollowersState.classList.toggle('bad', !followersQ.ok);

  const sum = (selfFollowers && selfFollowers.summary) || (selfFollowing && selfFollowing.summary);
  if (sum && (sum.reportedFollowers != null || sum.reportedFollowing != null)) {
    const part = (n, label) => (n == null ? '' : `<span><b>${nf.format(n)}</b>${label}</span>`);
    els.selfCounts.innerHTML =
      part(sum.reportedFollowers, 'followers') + part(sum.reportedFollowing, 'following');
    els.selfCounts.hidden = false;
  } else {
    els.selfCounts.hidden = true;
  }

  const mode = els.selfMode.value;
  const following = members(selfFollowing);

  // Preferred path: Instagram tags each row of your following list with
  // whether that account follows you back. When present it is authoritative
  // and needs no followers scan at all — which matters because the followers
  // endpoint stops serving pages well before the end on larger accounts, so a
  // subtraction against it invents people who "don't follow you back".
  const tagged = following.filter((a) => a.followsYou != null);
  const coverage = following.length ? tagged.length / following.length : 0;
  const direct = coverage >= 0.9 && following.length > 0;

  if (direct && mode !== 'fans') {
    els.selfWarn.hidden = false;
    els.selfWarn.classList.remove('bad');
    els.selfWarn.textContent =
      'Read directly from your following list. No followers scan needed, and not affected by how far the followers scan gets.';

    const list = (mode === 'notback'
      ? tagged.filter((a) => a.followsYou === false)
      : tagged.filter((a) => a.followsYou === true)
    )
      .slice()
      .sort(byName);
    paintSelfList(list, mode);
    return;
  }

  // Fallback: subtract one captured list from the other.
  if (!selfFollowing || !selfFollowers) {
    els.selfWarn.hidden = false;
    els.selfWarn.classList.remove('bad');
    els.selfWarn.textContent = direct
      ? 'Scan your followers to see who follows you that you do not follow back.'
      : 'Scan both lists to compare them. Following is quick; followers is slower because Instagram only serves 25 per page.';
    els.monList.innerHTML = '';
    els.empty.hidden = false;
    els.empty.innerHTML = '<p class="fine">Nothing to compare yet.</p>';
    return;
  }

  const followers = members(selfFollowers);
  const followerPks = new Set(followers.map((a) => a.pk));
  const followingPks = new Set(following.map((a) => a.pk));

  if (!followingQ.ok || !followersQ.ok) {
    const s = selfFollowers.snapshots[selfFollowers.snapshots.length - 1];
    const got = s ? nf.format(s.count) : '?';
    const want = s && s.expectedTotal != null ? nf.format(s.expectedTotal) : '?';
    els.selfWarn.hidden = false;
    els.selfWarn.classList.add('bad');
    els.selfWarn.textContent =
      `The followers scan reached ${got} of ${want}, so this comparison is a guess. Anyone it ` +
      `never reached is listed below as not following you back, wrongly. Re-scan followers; if it ` +
      `still stops short, re-scan your following list instead, which can report follow-back ` +
      `status directly without needing followers at all.`;
  } else {
    els.selfWarn.hidden = true;
    els.selfWarn.classList.remove('bad');
  }

  let list;
  if (mode === 'notback') list = following.filter((a) => !followerPks.has(a.pk));
  else if (mode === 'fans') list = followers.filter((a) => !followingPks.has(a.pk));
  else list = following.filter((a) => followerPks.has(a.pk));

  list = list.slice().sort(byName);
  paintSelfList(list, mode);
}

/** Shared renderer for any flat, headed list of accounts. */
function paintList(list, label, emptyHtml) {
  setExportSet(list.map((u) => ({ user: u })), label);
  if (!list.length) {
    els.monList.innerHTML = '';
    els.empty.hidden = false;
    els.empty.innerHTML = emptyHtml || '<p><strong>Nobody here.</strong></p>';
    return;
  }
  els.empty.hidden = true;
  els.monList.innerHTML =
    `<div class="ghead"><span class="gtime">${esc(label)}</span></div>` +
    `<div class="gbody">${list.map((u) => userRowHtml(u)).join('')}</div>`;
}

function paintSelfList(list, mode) {
  const label =
    mode === 'notback'
      ? `${nf.format(list.length)} you follow who don't follow you back`
      : mode === 'fans'
      ? `${nf.format(list.length)} who follow you that you don't follow back`
      : `${nf.format(list.length)} mutuals`;
  paintList(list, label);
}

// --- stories -----------------------------------------------------------------

const storyTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function renderStories(p) {
  if (p.type === 'stories:error') {
    els.storyStatus.textContent = p.message;
    els.monList.innerHTML = '';
    els.empty.hidden = true;
    return;
  }

  const who = p.username ? `@${p.username}` : p.targetId;
  if (!p.items.length) {
    els.storyStatus.textContent = '';
    els.monList.innerHTML = '';
    els.empty.hidden = false;
    els.empty.innerHTML = `<p><strong>${esc(who)} has no active story.</strong></p>
      <p class="fine">Stories expire after 24 hours.</p>`;
    return;
  }

  els.empty.hidden = true;
  const expires = p.items.reduce((m, i) => Math.max(m, i.expiringAt || 0), 0);
  els.storyStatus.textContent =
    `${nf.format(p.items.length)} item${p.items.length === 1 ? '' : 's'} from ${who}` +
    (expires ? ` · oldest expires ${storyTime.format(new Date(expires))}` : '');

  const cards = p.items
    .map((it, i) => {
      const when = it.takenAt ? storyTime.format(new Date(it.takenAt)) : '';
      // preload="none" so opening the list does not pull every video at once.
      const media = it.isVideo
        ? `<video class="story-media" controls preload="none"${
            it.image ? ` poster="${esc(it.image)}"` : ''
          } src="${esc(it.video)}"></video>`
        : `<img class="story-media" loading="lazy" src="${esc(it.image)}" alt="">`;
      return (
        `<div class="story">` +
        `<div class="story-head"><span>${i + 1} of ${p.items.length}</span>` +
        `<span>${esc(when)}${it.isVideo ? ' · video' : ''}</span></div>` +
        media +
        `</div>`
      );
    })
    .join('');

  els.monList.innerHTML = cards;
  els.monList.scrollTop = 0;
}

async function loadStories() {
  const name = els.storyUser.value.replace(/^@/, '').trim();
  if (!name) {
    els.storyUser.focus();
    els.storyStatus.textContent = 'Enter a username first.';
    return;
  }
  els.storyLoadBtn.disabled = true;
  els.storyLoadBtn.textContent = 'Loading…';
  els.storyStatus.textContent = `Fetching ${name}'s story…`;
  els.monList.innerHTML = '';
  els.empty.hidden = true;

  const res = await send({ type: 'IGFO_STORIES', username: name });
  if (!res.ok) {
    els.storyStatus.textContent = res.error || 'Could not reach the Instagram tab.';
    els.storyLoadBtn.disabled = false;
    els.storyLoadBtn.textContent = 'Load';
  }
  // The result arrives as IGFO_STORIES.
}

// --- compare two accounts ----------------------------------------------------

const trackCache = new Map();

async function getTrack(key) {
  if (trackCache.has(key)) return trackCache.get(key);
  const res = await send({ type: 'IGFO_GET_TRACK', key });
  const data = res.ok
    ? { summary: res.summary, accounts: res.accounts, snapshots: res.snapshots }
    : null;
  trackCache.set(key, data);
  return data;
}

/** One entry per watched account, regardless of which lists were captured. */
function comparableTargets() {
  const seen = new Map();
  for (const t of tracks) {
    if (!t.targetId) continue;
    if (!seen.has(t.targetId)) {
      seen.set(t.targetId, { targetId: t.targetId, username: t.username, kinds: new Set() });
    }
    seen.get(t.targetId).kinds.add(t.kind);
  }
  return [...seen.values()].sort((a, b) =>
    String(a.username || a.targetId).localeCompare(String(b.username || b.targetId))
  );
}

function fillTargetSelect(sel, targets, keep) {
  const prev = keep || sel.value;
  sel.textContent = '';
  if (!targets.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Nothing captured yet';
    sel.append(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const t of targets) {
    const o = document.createElement('option');
    o.value = t.targetId;
    o.textContent = t.username ? `@${t.username}` : t.targetId;
    sel.append(o);
  }
  if (prev && targets.some((t) => t.targetId === prev)) sel.value = prev;
}

/**
 * Scanning only happens on the stalk screen, and there is no scan button here,
 * which is genuinely confusing. Rather than explain the navigation, offer a
 * button that performs it and pre-fills the target.
 */
function offerRescan(targetId, kind, verb) {
  if (!targetId) {
    els.cmpRescanBtn.hidden = true;
    return;
  }
  const t = comparableTargets().find((x) => x.targetId === targetId);
  const who = t && t.username ? `@${t.username}` : targetId;
  els.cmpRescanBtn.hidden = false;
  els.cmpRescanBtn.textContent = `${verb} ${who} on the stalk page`;
  els.cmpRescanBtn.onclick = () => {
    els.username.value = targetId;
    els.kind.value = kind;
    show('new');
    setStatus(`${who} is filled in. Press Start stalk.`, true);
    els.startBtn.focus();
  };
}

async function renderCompare() {
  const targets = comparableTargets();
  fillTargetSelect(els.cmpA, targets);
  fillTargetSelect(els.cmpB, targets);

  // Default the second picker to something other than the first.
  if (targets.length > 1 && els.cmpB.value === els.cmpA.value) {
    const other = targets.find((t) => t.targetId !== els.cmpA.value);
    if (other) els.cmpB.value = other.targetId;
  }

  const kind = els.cmpKind.value;
  const aId = els.cmpA.value;
  const bId = els.cmpB.value;

  if (!aId || !bId) {
    els.cmpCounts.hidden = true;
    els.cmpRescanBtn.hidden = true;
    els.cmpNote.hidden = false;
    els.cmpNote.textContent =
      'Capture at least two accounts first. Use Start a new stalk on each of them.';
    els.monList.innerHTML = '';
    els.empty.hidden = true;
    return;
  }
  if (aId === bId) {
    els.cmpCounts.hidden = true;
    els.cmpRescanBtn.hidden = true;
    els.cmpNote.hidden = false;
    els.cmpNote.textContent = 'Pick two different accounts.';
    els.monList.innerHTML = '';
    els.empty.hidden = true;
    return;
  }

  const [ta, tb] = await Promise.all([
    getTrack(`${kind}:${aId}`),
    getTrack(`${kind}:${bId}`),
  ]);

  const nameOf = (id) => {
    const t = targets.find((x) => x.targetId === id);
    return t && t.username ? `@${t.username}` : id;
  };

  const missing = [];
  const missingIds = [];
  if (!ta) {
    missing.push(nameOf(aId));
    missingIds.push(aId);
  }
  if (!tb) {
    missing.push(nameOf(bId));
    missingIds.push(bId);
  }
  if (missing.length) {
    els.cmpCounts.hidden = true;
    els.cmpNote.hidden = false;
    els.cmpNote.textContent = `No ${kind} capture for ${missing.join(' or ')} yet.`;
    // Send them straight there rather than describing where to go.
    offerRescan(missing.length === 1 ? missingIds[0] : null, kind, 'Capture it');
    els.monList.innerHTML = '';
    els.empty.hidden = true;
    return;
  }

  const A = members(ta);
  const B = members(tb);
  const bPks = new Set(B.map((u) => u.pk));
  const aPks = new Set(A.map((u) => u.pk));

  const shared = A.filter((u) => bPks.has(u.pk)).sort(byName);
  const onlyA = A.filter((u) => !bPks.has(u.pk)).sort(byName);
  const onlyB = B.filter((u) => !aPks.has(u.pk)).sort(byName);

  const part = (n, label) => `<span><b>${nf.format(n)}</b>${label}</span>`;
  els.cmpCounts.innerHTML =
    part(shared.length, 'in both') + part(A.length, 'first') + part(B.length, 'second');
  els.cmpCounts.hidden = false;

  // Followers captures truncate on larger accounts, so an overlap computed
  // from them understates — say so rather than presenting a clean number.
  const qa = sideQuality(ta);
  const qb = sideQuality(tb);
  if (!qa.ok || !qb.ok) {
    // Everyone shown really is shared; only omissions are possible. Keep this
    // quiet and factual — it is a completeness note, not a failure.
    const shortest = !qa.ok && (qb.ok || (qa.short || 0) >= (qb.short || 0)) ? aId : bId;
    els.cmpNote.hidden = false;
    els.cmpNote.textContent =
      `At least this many. A few may be missing. ${nameOf(aId)} ${qa.reason}, ${nameOf(bId)} ${
        qb.reason
      }.`;
    offerRescan(shortest, kind, 'Re-scan');
  } else {
    els.cmpNote.hidden = true;
    els.cmpRescanBtn.hidden = true;
  }

  const mode = els.cmpMode.value;
  const list = mode === 'onlyA' ? onlyA : mode === 'onlyB' ? onlyB : shared;
  const verb = kind === 'following' ? 'followed by' : 'following';
  const label =
    mode === 'onlyA'
      ? `${nf.format(list.length)} only ${verb} ${nameOf(aId)}`
      : mode === 'onlyB'
      ? `${nf.format(list.length)} only ${verb} ${nameOf(bId)}`
      : `${nf.format(list.length)} ${verb} both`;

  paintList(list, label, '<p><strong>No overlap at all.</strong></p>');
}

async function loadSelf() {
  selfFollowing = null;
  selfFollowers = null;
  if (!selfId) return;
  for (const kind of ['following', 'followers']) {
    const res = await send({ type: 'IGFO_GET_TRACK', key: `${kind}:${selfId}` });
    if (res.ok) {
      const data = { summary: res.summary, accounts: res.accounts, snapshots: res.snapshots };
      if (kind === 'following') selfFollowing = data;
      else selfFollowers = data;
    }
  }
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

  // Arrivals carry the date of the check that first saw them; that is the one
  // column this app can honestly put a timestamp in, so it goes in the export.
  setExportSet(
    groups.flatMap((g) => g.users.map((u) => ({ user: u, at: g.at }))),
    s && s.username ? `@${s.username}` : ''
  );

  if (!monData) {
    els.monList.innerHTML = '';
    els.empty.hidden = false;
    els.empty.innerHTML = '<p><strong>Nothing being watched yet.</strong></p>';
    // A finished capture with no watch behind it is recoverable — offer it
    // rather than leaving a dead end.
    showOrphans();
    return;
  }

  if (!groups.length) {
    els.monList.innerHTML = '';
    els.empty.hidden = false;
    els.empty.innerHTML = `<p><strong>Nobody new yet.</strong></p><p class="fine">${nf.format(
      s.baselineCount
    )} accounts were already there when you started watching on ${esc(
      new Date(s.firstSnapshotAt).toLocaleDateString()
    )}. They are not shown, because there is no way to know what order they were added in.</p>
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
      `<br><span class="gfoot-warn">Accounts under the same date were all found by that one check, so ` +
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

  els.scanFollowingBtn.disabled = busy || !selfId;
  els.scanFollowersBtn.disabled = busy || !selfId;
  els.selfSpeed.disabled = busy;
  els.selfStopBtn.hidden = !busy;

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
        ? `Reading ${active.kind} of ${who}: ${nf.format(active.total)} / ${nf.format(
            active.expectedTotal
          )}`
        : `Reading ${active.kind} of ${who}: ${nf.format(active.total)} so far`) + passNote;
  } else if (!els.status.dataset.sticky) {
    els.status.textContent = '';
  }

  const alerts = [];
  if (active && active.warning) alerts.push(active.warning);
  // Not when the completion panel is already showing the same message.
  if (shown && shown.error && screen === 'new' && els.doneMsg.hidden) alerts.push(shown.error);
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
  } else if (screen === 'self') {
    renderSelf();
  } else if (screen === 'compare') {
    renderCompare();
  }
  // 'stories' paints on demand from its own handler — re-rendering here would
  // tear down a playing video every time the service worker pushes state.
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
      if (screen === 'self') {
        await loadSelf();
        render();
        return;
      }
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
            `${nf.format(message.absorbed)} missed by an earlier scan. Added to the baseline, not counted as new.`
          );
        }
        setStatus(bits.join(' '), true);
      }
    })();
    return;
  }

  if (message.type === 'IGFO_STORIES') {
    els.storyLoadBtn.disabled = false;
    els.storyLoadBtn.textContent = 'Load';
    if (screen === 'stories') renderStories(message.payload);
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
  // A scan started from the My account screen stays there — it is comparing
  // two lists, not opening a watch.
  if (screen === 'self') {
    await loadSelf();
    render();
    return;
  }

  await loadTracks();
  monKey = key;
  await loadMon();

  // Never navigate to Monitor with nothing to show there. If the capture
  // collected rows but no watch was recorded, fold it in now and carry on —
  // the user should not have to redo a capture over bookkeeping.
  if (!monData && run && run.total > 0) {
    const fixed = await send({ type: 'IGFO_INGEST_RUN', runId: run.id });
    if (fixed.ok) {
      await loadTracks();
      monKey = fixed.key;
      await loadMon();
    }
  }

  if (!monData) {
    // The completion panel carries the reason, so suppress the alert strip —
    // otherwise the same sentence appears twice, one above the other.
    els.alert.hidden = true;
    els.doneMsg.hidden = false;
    els.doneMsg.classList.add('bad');
    els.doneMsg.innerHTML =
      `<strong>Nothing was saved.</strong> ` +
      esc(
        (run && run.error) ||
          'The capture returned no accounts. The list may be private or restricted.'
      ) +
      ` <br><span class="fine">Try again; anything already collected is kept.</span>`;
    render();
    return;
  }

  const isBaseline = monData.summary.snapshotCount === 1;

  if (screen === 'new' && isBaseline) {
    els.doneMsg.hidden = false;
    els.doneMsg.classList.remove('bad');

    // A baseline that came up short is the single most misleading state in the
    // app: every account it missed resurfaces on the next check looking like a
    // brand-new follow. Saying only "saved: 900 accounts" hid that completely,
    // so the shortfall is now stated up front, with the fix.
    const want =
      monData.summary.kind === 'followers'
        ? monData.summary.reportedFollowers
        : monData.summary.reportedFollowing;
    const gap = want != null ? want - all.length : null;
    const short = gap != null && gap > Math.max(5, want * 0.02);

    els.doneMsg.innerHTML = short
      ? `<strong>Baseline saved: ${nf.format(all.length)} of ${nf.format(want)}.</strong> ` +
        `Instagram reshuffles this list while it is being read, so a walk can miss people. ` +
        `<br><span class="fine">Run <em>Start stalk</em> on them again before relying on this. ` +
        `Anything a later pass finds is merged in, and accounts recovered that way are folded ` +
        `into the baseline rather than reported as new follows.</span>`
      : `<strong>Baseline saved: ${nf.format(all.length)} accounts.</strong> ` +
        `We'll keep an eye on them from now on. Come back to <em>Monitor a user</em> to see who they add.` +
        `<br><span class="fine">Listed A-Z below. Instagram does not say what order these were followed in, so this list has no chronology. Only what comes next does.</span>`;
    render();
    return;
  }

  // A re-check: the arrivals are what matter, so go straight to them.
  els.doneMsg.hidden = true;
  els.doneMsg.classList.remove('bad');
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
els.selfStopBtn.addEventListener('click', stopCapture);
els.checkBtn.addEventListener('click', checkNow);

els.selfBtn.addEventListener('click', async () => {
  await loadState();
  await loadSelf();
  show('self');
  if (!selfId) {
    els.selfWarn.hidden = false;
    els.selfWarn.textContent =
      'Your account id is not known yet. Open a logged-in instagram.com tab, refresh it, then come back.';
  }
});

els.storiesBtn.addEventListener('click', () => {
  els.storyStatus.textContent = '';
  els.monList.innerHTML = '';
  show('stories');
  els.empty.hidden = false;
  els.empty.innerHTML =
    '<p class="fine">Enter a username and press Load.</p>';
  els.storyUser.focus();
});

els.storyLoadBtn.addEventListener('click', loadStories);
els.storyUser.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadStories();
});

els.compareBtn.addEventListener('click', async () => {
  trackCache.clear(); // captures may have changed since last visit
  await loadTracks();
  show('compare');
});

for (const el of [els.cmpA, els.cmpB, els.cmpKind, els.cmpMode]) {
  el.addEventListener('change', () => {
    els.monList.scrollTop = 0;
    renderCompare();
  });
}

els.selfMode.addEventListener('change', () => {
  els.monList.scrollTop = 0;
  renderSelf();
});

async function scanSelf(kind) {
  if (!selfId) return;
  // beginCapture reads the pacing off the New stalk screen's select, so mirror
  // this screen's choice into it rather than keeping two sources of truth.
  els.speed.value = els.selfSpeed.value;
  pendingCheck = true;
  els.selfWarn.hidden = true;
  await beginCapture(selfId, kind);
}

els.scanFollowingBtn.addEventListener('click', () => scanSelf('following'));
els.scanFollowersBtn.addEventListener('click', () => scanSelf('followers'));

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

// --- export ------------------------------------------------------------------
//
// No libraries. The repo has no build step, and a bundled spreadsheet library
// would be larger than everything else here put together, so the .xlsx path
// writes the OOXML parts and zips them by hand. Roughly 80 lines, versus ~900KB
// of vendored dependency.

const EXPORT_COLUMNS = ['Username', 'Full name', 'Profile URL', 'Private', 'Follows you', 'First seen'];

/** Whatever list is currently painted, in the order it is shown. */
let exportSet = { label: '', items: [] };

function setExportSet(items, label) {
  exportSet = { label: label || '', items: items || [] };
  updateExportBar();
}

function updateExportBar() {
  const n = exportSet.items.length;
  els.exportBar.hidden = n === 0 || screen === 'home' || screen === 'stories';
  els.exportCount.textContent = n ? `${nf.format(n)} rows` : '';
}

function exportRows() {
  return exportSet.items.map(({ user: u, at }) => [
    u.username ? `@${u.username}` : `(id ${u.pk})`,
    u.fullName || '',
    u.username ? `https://www.instagram.com/${u.username}/` : '',
    u.isPrivate ? 'yes' : 'no',
    u.followsYou === true ? 'yes' : u.followsYou === false ? 'no' : '',
    at ? dtfFull.format(new Date(at)) : u.baseline ? 'baseline' : '',
  ]);
}

function exportFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const who = (exportSet.label || screen || 'list')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `instalurk-${who || 'list'}-${stamp}`;
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Excel evaluates a cell starting with = + - @ as a formula, so a crafted
  // full name would execute on open. Prefix it out of harm's way.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCSV(cols, rows) {
  const body = [cols.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
  // Without a BOM Excel reads UTF-8 as ANSI and mangles every accented name.
  const bom = String.fromCharCode(0xfeff);
  return new Blob([bom + body], { type: 'text/csv;charset=utf-8' });
}

function toJSON(cols, rows) {
  const keys = cols.map((c) => c.toLowerCase().replace(/ (.)/g, (_, ch) => ch.toUpperCase()));
  const out = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
  return new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
}

function toTXT(cols, rows) {
  return new Blob([rows.map((r) => r[0]).join('\r\n')], { type: 'text/plain;charset=utf-8' });
}

function xmlEscape(v) {
  const raw = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // XML 1.0 allows only tab, LF and CR below 0x20. The rest have no escape
    // at all, so they must be dropped or Excel refuses to open the file.
    // Written as a loop on purpose: a literal \u escape in a character class
    // does not survive every editing path intact.
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) continue;
    const ch = raw[i];
    out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
  }
  return out;
}

function colRef(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

function sheetXml(cols, rows) {
  // Inline strings rather than a shared-string table: one less part to write,
  // and the duplication costs nothing at these sizes.
  const line = (cells, r) =>
    `<row r="${r}">` +
    cells
      .map(
        (v, i) =>
          `<c r="${colRef(i)}${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`
      )
      .join('') +
    '</row>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' +
    line(cols, 1) +
    rows.map((r, i) => line(r, i + 2)).join('') +
    '</sheetData></worksheet>'
  );
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer, STORED (uncompressed) entries only. Deflating would mean
 * CompressionStream and async plumbing to save a few hundred KB on a file
 * nobody keeps; stored archives open fine in Excel, Numbers and LibreOffice.
 */
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(12, 0x21, true); // 1980-01-01, so archives are reproducible
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function toXLSX(cols, rows) {
  const ns = 'http://schemas.openxmlformats.org/';
  return zipStore([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Types xmlns="${ns}package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${ns}package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships">` +
        '<sheets><sheet name="InstaLurk" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${ns}package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        '</Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(cols, rows) },
  ]);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

els.exportBtn.addEventListener('click', () => {
  const rows = exportRows();
  if (!rows.length) return;
  const base = exportFileName();
  const fmt = els.exportFormat.value;
  const build =
    fmt === 'csv' ? toCSV : fmt === 'json' ? toJSON : fmt === 'txt' ? toTXT : toXLSX;
  saveBlob(build(EXPORT_COLUMNS, rows), `${base}.${fmt}`);
});

try {
  els.ver.textContent = `v${chrome.runtime.getManifest().version}`;
} catch (_) {}


show('home');
loadState();
loadTracks();
