/**
 * Service worker: owns run state, ordering and verification.
 *
 * A "run" is one complete unranked pass over one list. Users are appended in
 * arrival order and given a 1-based `followRank` that is assigned once and
 * never recomputed — rank 1 is the most recent follow.
 *
 * Nothing here trusts the ordering claim. `verifyOrder` compares two runs of
 * the same list: if the endpoint really returns follow order, everyone present
 * in both runs must appear in the *same relative order*, and anyone new can
 * only appear above them. A ranked list would fail that test.
 */

const RUN_PREFIX = 'run:';
const TRACK_PREFIX = 'track:';
const RANKED_PREFIX = 'ranked:';
const META_KEY = '__meta';
const MAX_USERS_PER_RUN = 100000;
const SAVE_DEBOUNCE_MS = 1000;

const state = {
  runs: new Map(), // runId -> run
  ranked: new Map(), // "kind:targetId" -> { pks: [], at, ranked: bool }
  // username(lowercased) -> numeric id, learned passively from browsing.
  // web_profile_info is unreliable, so a known id lets us skip it entirely.
  ids: {},
  profiles: {}, // id -> { username, followers, following, isPrivate }
  selfId: null, // the logged-in account's own id, from the ds_user_id cookie
  // "kind:targetId" -> longitudinal record. This is where chronology comes
  // from: Instagram never says when a follow happened, but if an account is
  // absent from one complete capture and present in the next, it arrived in
  // between. Everything in the first capture is baseline — order unknown.
  tracked: new Map(),
  activeRunId: null,
};

let loadPromise = null;

function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const all = await chrome.storage.local.get(null);
      const meta = all[META_KEY] || {};
      state.ids = meta.ids || {};
      state.selfId = meta.selfId || null;
      state.profiles = meta.profiles || {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(RUN_PREFIX) && value && value.id) {
          // A run that was mid-flight when the worker died cannot be resumed.
          if (value.status === 'running' || value.status === 'starting') {
            value.status = 'interrupted';
          }
          state.runs.set(value.id, value);
        } else if (key.startsWith(RANKED_PREFIX) && value) {
          state.ranked.set(key.slice(RANKED_PREFIX.length), value);
        } else if (key.startsWith(TRACK_PREFIX) && value && value.key) {
          state.tracked.set(value.key, value);
          migrateAbsorbed(value);
          migrateSettled(value);
        }
      }
    })().catch((err) => console.error('[igfo] restore failed', err));
  }
  return loadPromise;
}

/**
 * One-off repair for histories written before recovered misses were absorbed.
 * Those entries were recorded as arrivals carrying "the profile's following
 * count did not change" — which is precisely the evidence that they were never
 * arrivals at all. Move them into the baseline.
 */
function migrateAbsorbed(t) {
  let changed = 0;
  for (const acc of Object.values(t.accounts || {})) {
    if (acc.baseline || acc.confirmed !== false) continue;
    if (typeof acc.confirmReason === 'string' && acc.confirmReason.includes('did not change')) {
      acc.baseline = true;
      acc.absorbed = true;
      acc.confirmed = null;
      acc.confirmReason = null;
      changed++;
    }
  }
  if (changed) {
    pendingTracks.add(t.key);
    scheduleSave(null);
  }
}

/**
 * Decide `settled` for watches created before it existed. Without this every
 * existing watch would read as unsettled, hiding arrival history that people
 * have been collecting for weeks.
 *
 * Settled retroactively on the same evidence the live rule uses: a capture
 * that came back essentially complete, or two consecutive captures that agreed
 * on the size of the list. A watch with neither genuinely does have an
 * unreliable baseline, and is better off saying so.
 */
function migrateSettled(t) {
  if (typeof t.settled === 'boolean') return;
  const snaps = t.snapshots || [];
  const everFull = snaps.some((s) => s.full === true);
  const lastTwoAgree =
    snaps.length >= 2 && snaps[snaps.length - 1].count === snaps[snaps.length - 2].count;
  t.settled = everFull || lastTwoAgree;
  if (t.settled) t.settledAt = snaps.length ? snaps[snaps.length - 1].at : Date.now();
  pendingTracks.add(t.key);
  scheduleSave(null);
}

// --- persistence -------------------------------------------------------------

const pending = new Set();
let saveTimer = null;

function scheduleSave(runId) {
  if (runId) pending.add(runId);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush().catch((err) => console.error('[igfo] save failed', err));
  }, SAVE_DEBOUNCE_MS);
}

async function flush() {
  const items = {
    [META_KEY]: { version: 2, ids: state.ids, profiles: state.profiles, selfId: state.selfId },
  };
  for (const id of pending) {
    const run = state.runs.get(id);
    if (run) items[RUN_PREFIX + id] = run;
  }
  pending.clear();
  for (const [key, snap] of state.ranked) items[RANKED_PREFIX + key] = snap;
  for (const key of pendingTracks) {
    const t = state.tracked.get(key);
    if (t) items[TRACK_PREFIX + key] = t;
  }
  pendingTracks.clear();
  await chrome.storage.local.set(items);
}

const pendingTracks = new Set();

/**
 * Folds a finished capture into the longitudinal record.
 *
 * The capture's own order is Instagram's ranked display order and carries no
 * chronological meaning. What does carry meaning is *when an account first
 * showed up*: absent from capture N, present in capture N+1 means it arrived
 * between the two. That is the only chronology available, and it only works
 * forward from the first capture.
 */
function ingestSnapshot(run) {
  if (!run.targetId || !run.users.length) return;

  const key = `${run.kind}:${run.targetId}`;
  const at = run.finishedAt || Date.now();
  let t = state.tracked.get(key);
  const isFirst = !t;

  if (!t) {
    t = {
      key,
      kind: run.kind,
      targetId: run.targetId,
      username: run.targetUsername || null,
      snapshots: [],
      accounts: {},
    };
    state.tracked.set(key, t);
  }
  if (run.targetUsername) t.username = run.targetUsername;

  // Removal detection needs a capture that actually reached the end of the
  // list; a truncated one would read every unseen account as departed.
  const trustworthy = run.status === 'complete';

  // Did this capture get essentially everything? Never require an exact match
  // with the reported count: that count includes deactivated and deleted
  // accounts which are counted but never listed, so lists plateau below it.
  const drift = run.expectedTotal != null ? run.expectedTotal - run.users.length : null;
  const full =
    drift == null ? null : Math.abs(drift) <= Math.max(5, run.expectedTotal * 0.02);

  // An account "arriving" is only believable if the PREVIOUS capture was good
  // enough to have seen it. After a short capture, a first sighting is just as
  // likely to be a miss being corrected as a real new follow.
  const prev = t.snapshots.length ? t.snapshots[t.snapshots.length - 1] : null;
  const arrivalsTrustworthy = prev ? prev.full === true && prev.complete === true : false;

  const seen = new Set();
  const freshPks = [];
  let arrived = 0;
  for (const u of run.users) {
    if (!u.pk) continue;
    seen.add(u.pk);
    const acc = t.accounts[u.pk];
    if (!acc) {
      freshPks.push(u.pk);
      t.accounts[u.pk] = {
        pk: u.pk,
        username: u.username,
        fullName: u.fullName,
        isPrivate: u.isPrivate,
        isVerified: u.isVerified,
        followsYou: u.followsYou != null ? u.followsYou : null,
        youFollow: u.youFollow != null ? u.youFollow : null,
        // baseline = present in the very first capture, so its arrival time is
        // unknown, not "now". Conflating the two would invent a timeline.
        baseline: isFirst,
        // Provisional; downgraded below once arrivals/departures are counted.
        confirmed: isFirst ? null : arrivalsTrustworthy,
        confirmReason: isFirst || arrivalsTrustworthy ? null : 'the previous capture came up short',
        firstSeenAt: at,
        lastSeenAt: at,
        goneAt: null,
      };
      if (!isFirst) arrived++;
    } else {
      acc.lastSeenAt = at;
      acc.goneAt = null;
      if (u.username) acc.username = u.username;
      if (u.fullName) acc.fullName = u.fullName;
      acc.isPrivate = u.isPrivate;
      acc.isVerified = u.isVerified;
      if (u.followsYou != null) acc.followsYou = u.followsYou;
      if (u.youFollow != null) acc.youFollow = u.youFollow;
    }
  }

  let departed = 0;
  if (trustworthy && !isFirst) {
    for (const pk of Object.keys(t.accounts)) {
      const acc = t.accounts[pk];
      if (!seen.has(pk) && !acc.goneAt) {
        acc.goneAt = at;
        departed++;
      }
    }
  }

  let absorbed = 0;

  /** Fold accounts into the baseline instead of dating them as arrivals. */
  const absorbAll = () => {
    for (const pk of freshPks) {
      const acc = t.accounts[pk];
      if (!acc) continue;
      acc.baseline = true;
      acc.absorbed = true;
      acc.confirmed = null;
      acc.confirmReason = null;
      absorbed++;
    }
    arrived = 0;
  };

  // --- is the baseline settled? ----------------------------------------------
  //
  // Dating an arrival is only meaningful if the capture before it was good
  // enough to have seen that account. Until the walk has demonstrably
  // converged, a first sighting is far more likely to be the collector finally
  // catching someone than a real new follow — and dating those is precisely
  // what produced batches of "new follows" that were never new, which is the
  // single most damaging thing this app can do.
  //
  // So nothing is dated until the baseline settles, on either of two
  // independent signals:
  //   - a capture came back essentially complete against the reported count, or
  //   - a capture that reached the end of the list found nobody new. That is
  //     what convergence looks like on a list which permanently plateaus below
  //     its reported count because deactivated accounts are counted but never
  //     listed, and without it such a list would never settle at all.
  const wasSettled = t.settled === true;

  if (!isFirst && !wasSettled && freshPks.length) {
    // Still filling in. These are recovered misses, not news.
    absorbAll();
  } else if (wasSettled) {
    // The baseline is trusted, so the profile's own count is the arbiter. The
    // strongest tell that an "arrival" is really a recovered miss is that the
    // reported following count did not rise enough to account for it.
    const prevExpected = prev ? prev.expectedTotal : null;
    const curExpected = run.expectedTotal != null ? run.expectedTotal : null;
    const expectedDelta =
      prevExpected != null && curExpected != null ? curExpected - prevExpected : null;
    // Departures free up slots, so a real arrival can hide behind one.
    const plausibleNew = expectedDelta == null ? null : Math.max(0, expectedDelta + departed);

    if (plausibleNew === 0 && freshPks.length) {
      // The count did not move, so nobody was followed. Anybody newly visible
      // was there all along.
      absorbAll();
    } else if (plausibleNew != null && arrived > plausibleNew) {
      // Some are real and some are misses, with no way to tell which, so the
      // whole batch carries the caveat.
      const reason = `only ${plausibleNew} of these are accounted for by the profile's count`;
      for (const pk of freshPks) {
        const acc = t.accounts[pk];
        if (acc) {
          acc.confirmed = false;
          acc.confirmReason = reason;
        }
      }
    }
  }

  if (!t.settled && trustworthy && (full === true || (!isFirst && freshPks.length === 0))) {
    t.settled = true;
    t.settledAt = at;
  }

  t.snapshots.push({
    at,
    runId: run.id,
    count: run.users.length,
    expectedTotal: curExpected,
    complete: trustworthy,
    full,
    arrived,
    departed,
    absorbed,
    expectedDelta,
    plausibleNew,
  });
  if (t.snapshots.length > 200) t.snapshots.splice(0, t.snapshots.length - 200);

  pendingTracks.add(key);
  scheduleSave(null);

  // Announce the history change directly. The panel used to infer this from
  // run bookkeeping, which meant a finished check could leave the arrivals
  // view stale until it was navigated away from and back.
  broadcast({
    type: 'IGFO_TRACK_UPDATED',
    key,
    summary: trackSummary(t),
    arrived,
    departed,
    absorbed,
  });
}

const looksNumeric = (s) => !s || /^\d+$/.test(String(s));

/**
 * An all-digit stored name is an id that never got resolved to a handle.
 * Prefer any real handle learned since, so old records stop showing digits
 * once the username is known.
 */
function displayName(targetId, stored) {
  if (!looksNumeric(stored)) return stored;
  const prof = state.profiles[targetId];
  if (prof && !looksNumeric(prof.username)) return prof.username;
  return stored || null;
}

function trackSummary(t) {
  const accounts = Object.values(t.accounts);
  // The counts Instagram itself displays, as of the last capture — deliberately
  // not the number of rows collected, which plateaus below it because
  // deactivated accounts are counted but never listed.
  const prof = state.profiles[t.targetId] || {};
  return {
    reportedFollowers: prof.followers != null ? prof.followers : null,
    reportedFollowing: prof.following != null ? prof.following : null,
    key: t.key,
    kind: t.kind,
    targetId: t.targetId,
    username: displayName(t.targetId, t.username),
    snapshotCount: t.snapshots.length,
    // Until this is true nothing is being dated, so the UI has to say so
    // rather than show an empty arrivals list that looks like "no changes".
    settled: t.settled === true,
    firstSnapshotAt: t.snapshots.length ? t.snapshots[0].at : null,
    lastSnapshotAt: t.snapshots.length ? t.snapshots[t.snapshots.length - 1].at : null,
    total: accounts.length,
    baselineCount: accounts.filter((a) => a.baseline).length,
    datedCount: accounts.filter((a) => !a.baseline).length,
    unconfirmedCount: accounts.filter((a) => !a.baseline && a.confirmed === false).length,
    presentCount: accounts.filter((a) => !a.goneAt).length,
    goneCount: accounts.filter((a) => a.goneAt).length,
  };
}

// --- shaping -----------------------------------------------------------------

function slimUser(rec) {
  return {
    followRank: rec.followRank,
    pageIndex: rec.pageIndex,
    indexInPage: rec.indexInPage,
    pk: rec.pk,
    username: rec.username,
    fullName: rec.fullName,
    isPrivate: rec.isPrivate,
    isVerified: rec.isVerified,
    followsYou: rec.followsYou != null ? rec.followsYou : null,
    youFollow: rec.youFollow != null ? rec.youFollow : null,
  };
}

function runSummary(run) {
  return {
    id: run.id,
    kind: run.kind,
    targetId: run.targetId,
    targetUsername: displayName(run.targetId, run.targetUsername),
    status: run.status,
    error: run.error || null,
    warning: run.warning || null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    pageCount: run.pageCount,
    pageSize: run.pageSize || null,
    delayMs: run.delayMs != null ? run.delayMs : null,
    maxServed: run.maxServed || null,
    duplicates: run.duplicates,
    expectedTotal: run.expectedTotal != null ? run.expectedTotal : null,
    total: run.users.length,
    complete: run.status === 'complete',
    verification: run.verification || null,
    lastErrorKind: run.lastErrorKind || null,
    rateLimitedAt: run.rateLimitedAt || null,
    resumable: isResumable(run),
    passes: run.passes || null,
    pass: run.pass || 0,
    trackKey: run.targetId ? `${run.kind}:${run.targetId}` : null,
    hasHistory: run.targetId ? state.tracked.has(`${run.kind}:${run.targetId}`) : false,
  };
}

const RESUMABLE_STATES = ['partial', 'aborted', 'error', 'interrupted'];

function isResumable(run) {
  if (state.activeRunId === run.id) return false;
  if (!RESUMABLE_STATES.includes(run.status)) return false;
  // Either we know where to continue, or we know who to start over on.
  return !!(run.lastCursor || run.targetId || run.targetUsername);
}

function listSummaries() {
  return [...state.runs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(runSummary);
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function pushState() {
  broadcast({
    type: 'IGFO_STATE',
    runs: listSummaries(),
    activeRunId: state.activeRunId,
    // Without this the panel only learns the id from a Test, so the Me button
    // stays dead after a reload even once the page has announced itself.
    selfId: state.selfId,
  });
}

// --- collection control ------------------------------------------------------

async function findInstagramTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.instagram.com/*', 'https://instagram.com/*'],
  });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

/**
 * `tabId` matters: a capture runs in one specific tab, and an abort sent to a
 * different Instagram tab is silently ignored. Picking "the active tab" for
 * both is why Stop did nothing whenever more than one tab was open.
 */
async function sendToPage(command, tabId) {
  let id = tabId;
  if (id == null) {
    const tab = await findInstagramTab();
    if (!tab) return { ok: false, error: 'Open a tab on instagram.com (logged in) first.' };
    id = tab.id;
  }
  try {
    await chrome.tabs.sendMessage(id, { type: 'IGFO_COMMAND', command });
    return { ok: true, tabId: id };
  } catch (e) {
    return { ok: false, error: 'Could not reach the Instagram tab. Reload it and try again.' };
  }
}

async function startRun(req) {
  if (state.activeRunId) {
    const active = state.runs.get(state.activeRunId);
    if (active && (active.status === 'running' || active.status === 'starting')) {
      return { ok: false, error: 'A collection is already running.' };
    }
    state.activeRunId = null;
  }

  // Note `== null` rather than `||`: a deliberate 0ms delay must survive.
  const delayMs = req.delayMs == null ? 1500 : req.delayMs;
  const kind = req.kind === 'following' ? 'following' : 'followers';
  const username = String(req.username || '').replace(/^@/, '').trim();
  if (!username) return { ok: false, error: 'Enter a username.' };

  // A bare numeric input is a user id; otherwise see if browsing already
  // taught us the id, so the unreliable username lookup can be skipped.
  const typedId = /^\d{3,}$/.test(username) ? username : null;
  const knownId = typedId || state.ids[username.toLowerCase()] || null;
  const knownProfile = knownId ? state.profiles[knownId] : null;

  const runId = `${kind}-${username}-${Date.now()}`;
  const run = {
    id: runId,
    kind,
    targetId: knownId,
    targetUsername: knownProfile && knownProfile.username ? knownProfile.username : username,
    source: 'direct-unranked',
    status: 'starting',
    startedAt: Date.now(),
    finishedAt: null,
    pageCount: 0,
    pageSize: req.pageSize || 50,
    delayMs,
    maxServed: 0,
    duplicates: 0,
    expectedTotal: null,
    cursors: [],
    lastCursor: null,
    users: [],
    seen: {},
    error: null,
    warning: null,
    lastErrorKind: null,
    rateLimitedAt: null,
    verification: null,
  };

  state.runs.set(runId, run);
  state.activeRunId = runId;
  scheduleSave(runId);

  // A baseline is the foundation for every later diff: anyone missed here
  // resurfaces as a phantom "new follow" on the next check. Spend more passes
  // on it than on routine re-checks.
  const isBaseline = !knownId || !state.tracked.has(`${kind}:${knownId}`);

  const command = {
    type: 'collect',
    runId,
    kind,
    pageSize: run.pageSize,
    delayMs: run.delayMs,
    maxUsers: MAX_USERS_PER_RUN,
    // A backstop, not a target. The walk exits on diminishing returns long
    // before this, so raising it further only lengthens the tail on the lists
    // that are hardest to finish. Recovering the last stragglers is the job of
    // the next check, which sees a properly different shuffle and folds what
    // it finds into the baseline rather than dating it.
    //
    // Followers gets fewer: it is capped at 25 rows a page against 200 for
    // following, so the same list costs eight times the requests and eight
    // times the wait, and an extra pass there is minutes rather than seconds.
    maxPasses: kind === 'followers' ? (isBaseline ? 3 : 2) : isBaseline ? 6 : 4,
  };
  if (knownId) {
    command.targetId = knownId;
    command.targetUsername = run.targetUsername;
    if (knownProfile) {
      command.expectedTotal = kind === 'followers' ? knownProfile.followers : knownProfile.following;
    }
  } else {
    command.username = username;
  }

  const sent = await sendToPage(command);
  run.tabId = sent.tabId != null ? sent.tabId : null;

  if (!sent.ok) {
    run.status = 'error';
    run.error = sent.error;
    run.finishedAt = Date.now();
    state.activeRunId = null;
    scheduleSave(runId);
    pushState();
    return { ok: false, error: sent.error, runId };
  }

  updateBadge();
  pushState();
  return { ok: true, runId };
}

/**
 * Picks a stalled run back up from its last cursor, appending into the same
 * run so ranks stay continuous. Re-walking from page 1 after a throttle is the
 * worst thing you can do, so this exists to make that unnecessary.
 */
async function resumeRun(req) {
  const run = state.runs.get(req.runId);
  if (!run) return { ok: false, error: 'Run not found.' };
  if (!isResumable(run)) return { ok: false, error: 'That run cannot be resumed.' };
  if (state.activeRunId) {
    const active = state.runs.get(state.activeRunId);
    if (active && (active.status === 'running' || active.status === 'starting')) {
      return { ok: false, error: 'A collection is already running.' };
    }
  }

  if (req.pageSize) run.pageSize = req.pageSize;
  if (req.delayMs != null) run.delayMs = req.delayMs; // 0 is a valid choice
  run.status = 'starting';
  run.error = null;
  run.warning = null;
  run.finishedAt = null;
  state.activeRunId = run.id;
  scheduleSave(run.id);

  const command = {
    type: 'collect',
    runId: run.id,
    kind: run.kind,
    pageSize: run.pageSize,
    delayMs: run.delayMs,
    maxUsers: MAX_USERS_PER_RUN,
    resumeCursor: run.lastCursor || null,
    startPageIndex: run.pageCount || 0,
  };
  // Prefer the id (no extra lookup request); fall back to the username if the
  // original run died before it resolved one.
  if (run.targetId) command.targetId = run.targetId;
  else command.username = run.targetUsername;

  const sent = await sendToPage(command);
  run.tabId = sent.tabId != null ? sent.tabId : null;
  if (!sent.ok) {
    run.status = run.users.length > 0 ? 'partial' : 'error';
    run.error = sent.error;
    run.finishedAt = Date.now();
    state.activeRunId = null;
    scheduleSave(run.id);
    pushState();
    return { ok: false, error: sent.error };
  }

  updateBadge();
  pushState();
  return { ok: true, runId: run.id, resumedFrom: run.users.length };
}

function updateBadge() {
  const run = state.activeRunId ? state.runs.get(state.activeRunId) : null;
  if (run && (run.status === 'running' || run.status === 'starting')) {
    const n = run.users.length;
    chrome.action.setBadgeBackgroundColor({ color: '#c13584' }).catch(() => {});
    chrome.action.setBadgeText({ text: n > 9999 ? `${Math.floor(n / 1000)}k` : String(n) }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

// --- inbound page events -----------------------------------------------------

function onCollectStarted(p) {
  const run = state.runs.get(p.runId);
  if (!run) return;
  run.status = 'running';
  run.targetId = p.targetId || run.targetId;
  run.targetUsername = p.targetUsername || run.targetUsername;
  // A resumed run skips the profile lookup, so don't wipe the known total.
  if (p.expectedTotal != null) run.expectedTotal = p.expectedTotal;
  run.pageSize = p.pageSize || run.pageSize;
  run.error = null;
  run.warning = null;
  scheduleSave(run.id);
  pushState();
}

function onCollectPage(p) {
  const run = state.runs.get(p.runId);
  if (!run || !Array.isArray(p.users)) return;

  run.cursors.push({ in: p.cursorIn || null, next: p.nextCursor || null });
  // Where a resume would pick up from.
  run.lastCursor = p.nextCursor || null;
  // Largest page Instagram actually served, ignoring the short final page.
  if (p.returned != null && p.nextCursor) {
    run.maxServed = Math.max(run.maxServed || 0, p.returned);
  }

  const appended = [];
  for (let i = 0; i < p.users.length; i++) {
    const u = p.users[i];
    if (!u || !u.pk) continue;
    if (Object.prototype.hasOwnProperty.call(run.seen, u.pk)) {
      run.duplicates++;
      continue;
    }
    if (run.users.length >= MAX_USERS_PER_RUN) break;

    const rec = {
      followRank: run.users.length + 1, // 1 = most recent follow
      pageIndex: p.pageIndex,
      indexInPage: i,
      pk: u.pk,
      username: u.username,
      fullName: u.fullName,
      isPrivate: u.isPrivate,
      isVerified: u.isVerified,
      followsYou: u.followsYou != null ? u.followsYou : null,
      youFollow: u.youFollow != null ? u.youFollow : null,
      raw: u.raw,
    };
    run.seen[u.pk] = rec.followRank;
    run.users.push(rec);
    appended.push(slimUser(rec));
  }

  run.pageCount = p.pageIndex + 1;
  if (p.pass != null) run.pass = p.pass;
  scheduleSave(run.id);
  updateBadge();

  broadcast({
    type: 'IGFO_APPEND',
    runId: run.id,
    summary: runSummary(run),
    users: appended,
  });
}

function onCollectDone(p) {
  const run = state.runs.get(p.runId);
  if (!run) return;
  // Belt and braces: a finished run holding nothing is a failure, whatever the
  // page called it. Otherwise it saves no watch and says nothing went wrong.
  if (!run.users.length) {
    run.status = 'error';
    run.error =
      run.error ||
      'Instagram returned no accounts for this list. It may be private, restricted, or not visible to your account.';
    run.finishedAt = Date.now();
    if (state.activeRunId === run.id) state.activeRunId = null;
    scheduleSave(run.id);
    updateBadge();
    pushState();
    return;
  }
  run.status = p.reason === 'complete' ? 'complete' : p.reason === 'aborted' ? 'aborted' : 'partial';
  run.finishedAt = Date.now();
  if (run.status === 'complete' && run.expectedTotal != null) {
    const drift = run.expectedTotal - run.users.length;
    // A small gap is normal (deleted/deactivated accounts are counted but not
    // listed); a large one means pages were lost.
    if (Math.abs(drift) > Math.max(5, run.expectedTotal * 0.02)) {
      run.warning = `Collected ${run.users.length} but the profile reports ${run.expectedTotal}. Some pages may be missing.`;
    }
  }
  if (p.passes) run.passes = p.passes;
  if (state.activeRunId === run.id) state.activeRunId = null;
  ingestSnapshot(run);
  scheduleSave(run.id);
  updateBadge();
  pushState();
}

function onCollectError(p) {
  const run = state.runs.get(p.runId);
  if (!run) return;
  // Keep whatever was collected; partial data is still ordered correctly.
  run.status = run.users.length > 0 ? 'partial' : 'error';
  if (p.lastCursor) run.lastCursor = p.lastCursor;
  run.error = p.message || 'Unknown error';
  run.lastErrorKind = p.kind || 'unknown';
  if (p.kind === 'rate') run.rateLimitedAt = Date.now();
  run.finishedAt = Date.now();
  if (state.activeRunId === run.id) state.activeRunId = null;
  // A capture that died partway still collected real accounts. Record them:
  // the snapshot is marked incomplete, so removals are not inferred from it
  // and the next check's arrivals stay flagged. Dropping it entirely left the
  // user with rows on screen but no watch at all.
  ingestSnapshot(run);
  scheduleSave(run.id);
  updateBadge();
  pushState();
}

function onCollectWarn(p) {
  const run = state.runs.get(p.runId);
  if (!run) return;
  run.warning = p.message || null;
  pushState();
}

function learnId(username, id, extra) {
  if (!username || !id) return;
  const key = String(username).trim().toLowerCase();
  if (!key) return;
  state.ids[key] = String(id);

  const merged = Object.assign(
    { username, seenAt: Date.now() },
    state.profiles[String(id)] || {}
  );
  // A missing value must not erase a known one — i.instagram.com sometimes
  // answers without counts, and that should leave the last good figures alone.
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null) merged[k] = v;
  }
  state.profiles[String(id)] = merged;
  scheduleSave(null);
}

/** Instagram's own profile fetch, observed as you browse. Free id resolution. */
function onProfile(p) {
  if (!p.username || !p.id) return;
  learnId(p.username, p.id, {
    username: p.username,
    isPrivate: !!p.isPrivate,
    followers: p.followers != null ? p.followers : null,
    following: p.following != null ? p.following : null,
    seenAt: Date.now(),
  });

  // Repair anything already stored under the bare id.
  let touched = false;
  for (const t of state.tracked.values()) {
    if (t.targetId === p.id && looksNumeric(t.username)) {
      t.username = p.username;
      pendingTracks.add(t.key);
      touched = true;
    }
  }
  for (const r of state.runs.values()) {
    if (r.targetId === p.id && looksNumeric(r.targetUsername)) {
      r.targetUsername = p.username;
      scheduleSave(r.id);
      touched = true;
    }
  }
  if (touched) pushState();
}

/** The ranked modal list, kept purely so the UI can show that it differs. */
function onModal(p) {
  if (!p.targetId || !Array.isArray(p.users)) return;
  // The modal pairs a numeric id with the handle in the URL.
  if (p.pathUsername) learnId(p.pathUsername, p.targetId);
  const key = `${p.kind}:${p.targetId}`;
  const prev = state.ranked.get(key);
  const pks = p.users.map((u) => u.pk).filter(Boolean);
  if (prev && prev.at > Date.now() - 60000) {
    // Same modal scroll session: keep extending it.
    const seen = new Set(prev.pks);
    for (const pk of pks) if (!seen.has(pk)) prev.pks.push(pk);
    prev.at = Date.now();
    prev.ranked = prev.ranked || p.ranked;
  } else {
    state.ranked.set(key, { pks, at: Date.now(), ranked: !!p.ranked });
  }
  scheduleSave(null);
}

// --- verification ------------------------------------------------------------

/**
 * Compares two runs of the same list. The question is not "are the lists
 * equal" — followers change — but "did the shared members keep their relative
 * order, and did new members only appear at the top".
 */
/**
 * Longest strictly-increasing subsequence, returned as indices. Used to find
 * the *smallest set of accounts that would have to move* to make the order
 * agree between runs — far more informative than counting adjacent
 * inversions, where one displaced account can register as several breaks.
 */
function longestIncreasingRun(values) {
  const n = values.length;
  if (!n) return [];
  const tails = [];
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const out = [];
  let k = tails[tails.length - 1];
  while (k >= 0) {
    out.push(k);
    k = prev[k];
  }
  return out.reverse();
}

function verifyOrder(olderRun, newerRun) {
  const posOld = new Map();
  for (const u of olderRun.users) posOld.set(u.pk, u.followRank);

  const common = [];
  for (const u of newerRun.users) {
    const oldPos = posOld.get(u.pk);
    if (oldPos != null) common.push({ pk: u.pk, username: u.username, newPos: u.followRank, oldPos });
  }

  let inversions = 0;
  let firstViolation = null;
  for (let i = 1; i < common.length; i++) {
    if (common[i].oldPos <= common[i - 1].oldPos) {
      inversions++;
      if (!firstViolation) firstViolation = { before: common[i - 1], after: common[i] };
    }
  }

  // The accounts that actually moved, and by how far.
  const keep = new Set(longestIncreasingRun(common.map((c) => c.oldPos)));
  const movers = [];
  for (let i = 0; i < common.length; i++) {
    if (keep.has(i)) continue;
    const c = common[i];
    movers.push({
      username: c.username,
      pk: c.pk,
      oldPos: c.oldPos,
      newPos: c.newPos,
      shift: c.newPos - c.oldPos,
    });
  }
  movers.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
  const maxShift = movers.length ? Math.abs(movers[0].shift) : 0;
  const stableFraction = common.length ? (common.length - movers.length) / common.length : 0;

  const commonPks = new Set(common.map((c) => c.pk));
  const fresh = newerRun.users.filter((u) => !commonPks.has(u.pk));
  const newerPks = new Set(newerRun.users.map((u) => u.pk));
  const removed = olderRun.users.filter((u) => !newerPks.has(u.pk));

  let newAllAtTop = null;
  if (fresh.length && common.length) {
    const lowestNew = Math.max(...fresh.map((u) => u.followRank));
    const highestCommon = Math.min(...common.map((c) => c.newPos));
    newAllAtTop = lowestNew < highestCommon;
  }

  const orderStable = movers.length === 0;

  // Graded, because "not perfect" and "ranked" are wildly different findings.
  // Affinity ranking reshuffles a large fraction of the list between runs; a
  // handful of movers is ordinary follow/unfollow churn, or a page boundary
  // shifting under a live list mid-run.
  let verdict;
  if (common.length < 5) verdict = 'inconclusive';
  else if (orderStable && newAllAtTop !== false) verdict = 'exact';
  else if (stableFraction >= 0.98) verdict = 'near-exact';
  else if (stableFraction >= 0.9) verdict = 'mostly-stable';
  else verdict = 'unstable';

  return {
    olderRunId: olderRun.id,
    newerRunId: newerRun.id,
    checkedAt: Date.now(),
    commonCount: common.length,
    inversions,
    orderStable,
    moverCount: movers.length,
    movers: movers.slice(0, 8),
    maxShift,
    stableFraction,
    newCount: fresh.length,
    newAllAtTop,
    removedCount: removed.length,
    firstViolation,
    verdict,
  };
}

/** How far the ranked modal order departs from the collected follow order. */
function compareRanked(run) {
  const key = `${run.kind}:${run.targetId}`;
  const snap = state.ranked.get(key);
  if (!snap || snap.pks.length < 5) return null;

  const pos = new Map();
  for (const u of run.users) pos.set(u.pk, u.followRank);

  const seq = [];
  for (const pk of snap.pks) {
    const p = pos.get(pk);
    if (p != null) seq.push(p);
  }
  if (seq.length < 5) return null;

  let inversions = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] <= seq[i - 1]) inversions++;

  return {
    comparedCount: seq.length,
    inversions,
    identicalOrder: inversions === 0,
    modalWasRanked: !!snap.ranked,
    capturedAt: snap.at,
  };
}

// --- messaging ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  (async () => {
    await ensureLoaded();

    switch (message.type) {
      case 'IGFO_EVENT': {
        const p = message.payload || {};
        switch (p.type) {
          case 'collect:started':
            onCollectStarted(p);
            break;
          case 'collect:page':
            onCollectPage(p);
            break;
          case 'collect:done':
            onCollectDone(p);
            break;
          case 'collect:error':
            onCollectError(p);
            break;
          case 'collect:warn':
            onCollectWarn(p);
            break;
          case 'modal':
            onModal(p);
            break;
          case 'profile':
            onProfile(p);
            break;
          case 'stories:result':
          case 'stories:error':
            broadcast({ type: 'IGFO_STORIES', payload: p });
            break;
          case 'ready':
            if (p.selfId && state.selfId !== p.selfId) {
              state.selfId = p.selfId;
              scheduleSave(null);
              pushState();
            }
            break;
          case 'diag':
            if (p.selfId && state.selfId !== p.selfId) {
              state.selfId = p.selfId;
              scheduleSave(null);
            }
            broadcast({ type: 'IGFO_DIAG', diag: p });
            break;
          case 'probe:started':
          case 'probe:result':
          case 'probe:done':
            broadcast({ type: 'IGFO_PROBE', probe: p });
            break;
          default:
            break;
        }
        sendResponse({ ok: true });
        return;
      }

      case 'IGFO_STORIES': {
        const u = String(message.username || '').replace(/^@/, '').trim();
        const targetId = /^\d{3,}$/.test(u) ? u : state.ids[u.toLowerCase()] || null;
        sendResponse(
          await sendToPage({ type: 'stories', username: u || null, targetId })
        );
        return;
      }

      case 'IGFO_GET_STATE':
        sendResponse({
          ok: true,
          runs: listSummaries(),
          activeRunId: state.activeRunId,
          selfId: state.selfId,
        });
        return;

      case 'IGFO_START':
        sendResponse(await startRun(message));
        return;

      case 'IGFO_RESUME':
        sendResponse(await resumeRun(message));
        return;

      case 'IGFO_GET_TRACK': {
        const t = state.tracked.get(message.key);
        if (!t) {
          sendResponse({ ok: false, error: 'no_history' });
          return;
        }
        const accounts = Object.values(t.accounts).sort((a, b) => {
          // Dated arrivals newest-first; baseline (unknown arrival) last.
          if (a.baseline !== b.baseline) return a.baseline ? 1 : -1;
          if (b.firstSeenAt !== a.firstSeenAt) return b.firstSeenAt - a.firstSeenAt;
          return (a.username || '').localeCompare(b.username || '');
        });
        sendResponse({ ok: true, summary: trackSummary(t), snapshots: t.snapshots, accounts });
        return;
      }

      // Repair hatch: a finished run has rows but no watch record. Rather than
      // strand the user on an empty Monitor screen, the panel asks for the run
      // to be folded in after the fact.
      case 'IGFO_INGEST_RUN': {
        const run = state.runs.get(message.runId);
        if (!run || !run.targetId || !run.users.length) {
          sendResponse({ ok: false, error: 'That capture has nothing to save.' });
          return;
        }
        const key = `${run.kind}:${run.targetId}`;
        if (!state.tracked.has(key)) ingestSnapshot(run);
        sendResponse({ ok: true, key });
        return;
      }

      case 'IGFO_DELETE_TRACK': {
        if (state.tracked.has(message.key)) {
          state.tracked.delete(message.key);
          pendingTracks.delete(message.key);
          await chrome.storage.local.remove(TRACK_PREFIX + message.key);
        }
        sendResponse({ ok: true });
        pushState();
        return;
      }

      // Captures that hold real rows but have no watch record. Whatever caused
      // the gap, the data is still here and can be adopted.
      case 'IGFO_ORPHAN_RUNS': {
        const orphans = [...state.runs.values()]
          .filter((r) => r.targetId && r.users.length && !state.tracked.has(`${r.kind}:${r.targetId}`))
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((r) => ({
            id: r.id,
            kind: r.kind,
            username: displayName(r.targetId, r.targetUsername),
            targetId: r.targetId,
            total: r.users.length,
            startedAt: r.startedAt,
            status: r.status,
          }));
        sendResponse({ ok: true, orphans });
        return;
      }

      case 'IGFO_LIST_TRACKS':
        sendResponse({ ok: true, tracks: [...state.tracked.values()].map(trackSummary) });
        return;

      case 'IGFO_PROBE': {
        const u = String(message.username || '').replace(/^@/, '').trim();
        const targetId = /^\d{3,}$/.test(u) ? u : state.ids[u.toLowerCase()] || state.selfId;
        if (!targetId) {
          sendResponse({ ok: false, error: 'No id for that target. Use Me, or a numeric id.' });
          return;
        }
        sendResponse(await sendToPage({ type: 'probe', targetId, kind: message.kind }));
        return;
      }

      case 'IGFO_DIAG': {
        const u = String(message.username || '').replace(/^@/, '').trim();
        const knownId = /^\d{3,}$/.test(u) ? u : state.ids[u.toLowerCase()] || null;
        sendResponse(await sendToPage({ type: 'diag', username: u, knownId }));
        return;
      }

      case 'IGFO_ABORT': {
        const run = state.activeRunId ? state.runs.get(state.activeRunId) : null;
        const res = await sendToPage({ type: 'abort' }, run && run.tabId);

        // Safety net: if the page never acknowledges — tab closed, reloaded
        // mid-run, content script gone — the UI must not stay wedged in
        // "running" forever with Stop as the only control.
        if (run) {
          const id = run.id;
          setTimeout(() => {
            const r = state.runs.get(id);
            if (!r || (r.status !== 'running' && r.status !== 'starting')) return;
            r.status = r.users.length > 0 ? 'partial' : 'aborted';
            r.finishedAt = Date.now();
            r.warning = 'Stopped locally. The Instagram tab did not respond.';
            if (state.activeRunId === r.id) state.activeRunId = null;
            ingestSnapshot(r);
            scheduleSave(r.id);
            updateBadge();
            pushState();
          }, 5000);
        }
        sendResponse(res);
        return;
      }

      case 'IGFO_GET_RUN': {
        const run = state.runs.get(message.runId);
        if (!run) {
          sendResponse({ ok: false, error: 'not_found' });
          return;
        }
        sendResponse({
          ok: true,
          summary: runSummary(run),
          users: run.users.map(slimUser),
          rankedComparison: compareRanked(run),
          siblings: [...state.runs.values()]
            .filter((r) => r.id !== run.id && r.kind === run.kind && r.targetId === run.targetId)
            .sort((a, b) => b.startedAt - a.startedAt)
            .map((r) => ({ id: r.id, startedAt: r.startedAt, total: r.users.length, status: r.status })),
        });
        return;
      }

      case 'IGFO_VERIFY': {
        const a = state.runs.get(message.runId);
        const b = state.runs.get(message.againstRunId);
        if (!a || !b) {
          sendResponse({ ok: false, error: 'not_found' });
          return;
        }
        const [older, newer] = a.startedAt <= b.startedAt ? [a, b] : [b, a];
        const report = verifyOrder(older, newer);
        newer.verification = report;
        older.verification = report;
        scheduleSave(newer.id);
        scheduleSave(older.id);
        sendResponse({ ok: true, report });
        pushState();
        return;
      }

      case 'IGFO_GET_RAW': {
        const run = state.runs.get(message.runId);
        if (!run) {
          sendResponse({ ok: false, error: 'not_found' });
          return;
        }
        sendResponse({
          ok: true,
          export: {
            tool: 'IG Follow Order',
            note:
              'followRank 1 = most recent follow. Order is the unranked ' +
              '/api/v1/friendships/<id>/<kind>/ pagination order, unmodified.',
            exportedAt: new Date().toISOString(),
            run: runSummary(run),
            cursors: run.cursors,
            rankedComparison: compareRanked(run),
            users: run.users.map((rec) => ({
              follow_rank: rec.followRank,
              page_index: rec.pageIndex,
              index_in_page: rec.indexInPage,
              user: rec.raw,
            })),
          },
        });
        return;
      }

      case 'IGFO_DELETE': {
        const run = state.runs.get(message.runId);
        if (run) {
          state.runs.delete(run.id);
          pending.delete(run.id);
          if (state.activeRunId === run.id) state.activeRunId = null;
          await chrome.storage.local.remove(RUN_PREFIX + run.id);
        }
        sendResponse({ ok: true });
        pushState();
        return;
      }

      case 'IGFO_DELETE_ALL': {
        const keys = [...state.runs.keys()].map((id) => RUN_PREFIX + id);
        state.runs.clear();
        state.ranked.clear();
        state.tracked.clear();
        pending.clear();
        pendingTracks.clear();
        state.activeRunId = null;
        const all = await chrome.storage.local.get(null);
        const extra = Object.keys(all).filter(
          (k) => k.startsWith(RANKED_PREFIX) || k.startsWith(TRACK_PREFIX)
        );
        if (keys.length || extra.length) {
          await chrome.storage.local.remove([...keys, ...extra]);
        }
        sendResponse({ ok: true });
        pushState();
        return;
      }

      default:
        sendResponse({ ok: false, error: 'unknown_message' });
    }
  })().catch((err) => {
    console.error('[igfo] handler failed', err);
    try {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    } catch (_) {}
  });

  return true;
});

// --- lifecycle ---------------------------------------------------------------

function enablePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onStartup.addListener(() => {
  enablePanel();
  ensureLoaded();
});
enablePanel();
ensureLoaded();
