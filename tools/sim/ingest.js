/**
 * Snapshot-diffing scenarios. Runs the real `ingestSnapshot` and friends,
 * lifted out of background.js by name and evalled against stubs.
 *
 * This is where the damaging bugs live: reporting accounts as new follows when
 * they were only just found, or silently absorbing real new follows into the
 * baseline so a watch reports "nobody new" forever.
 */
const state = { tracked: new Map(), profiles: {} };
const pendingTracks = new Set();
const scheduleSave = () => {};
const broadcast = () => {};
window.eval(dec(window.__CODE__));

const out = document.getElementById('out');
const log = (s) => {
  out.textContent += s + '\n';
};
let failures = 0;

function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  log('   ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + ' = ' + got + (ok ? '' : '  (wanted ' + want + ')'));
}

let uid = 0;
function usersFor(n, offset) {
  const a = [];
  for (let i = 0; i < n; i++) {
    a.push({
      pk: String(100000 + (offset || 0) + i),
      username: 'u' + i,
      fullName: '',
      isPrivate: false,
      isVerified: false,
    });
  }
  return a;
}
/** `scope` defaults to a full walk, which is what every pre-existing run was. */
function capture(users, expectedTotal, over) {
  return Object.assign(
    {
      id: 'run' + ++uid,
      kind: 'following',
      targetId: '9',
      targetUsername: 'target',
      users: users.map((u, i) => Object.assign({ followRank: i + 1 }, u)),
      expectedTotal,
      status: 'complete',
      scope: 'full',
      headDepth: null,
      deepestNewDepth: null,
      finishedAt: Date.now() + uid * 1000,
    },
    over || {}
  );
}

const K = 'following:9';
function counts() {
  const t = state.tracked.get(K);
  const acc = Object.values(t.accounts);
  return {
    settled: t.settled === true,
    total: acc.length,
    baseline: acc.filter((a) => a.baseline).length,
    dated: acc.filter((a) => !a.baseline).length,
    unverified: acc.filter((a) => !a.baseline && a.confirmed === false).length,
    gone: acc.filter((a) => a.goneAt).length,
    snap: t.snapshots[t.snapshots.length - 1],
  };
}
function scenario(name, fn) {
  state.tracked = new Map();
  state.profiles = {};
  log('');
  log(name);
  try {
    fn();
  } catch (e) {
    failures++;
    log('   THREW: ' + e.name + ': ' + e.message);
  }
}

// --------------------------------------------------- full walks, unchanged
scenario('lossy baseline 900/1100, then a check that finds the other 200', () => {
  ingestSnapshot(capture(usersFor(900), 1100));
  check('settled after baseline', counts().settled, false);
  ingestSnapshot(capture(usersFor(1100), 1100));
  const c = counts();
  check('dated as new follows', c.dated, 0);
  check('absorbed into the baseline', c.snap.absorbed, 200);
  check('settled now', c.settled, true);
});

scenario('clean baseline, then 3 real new follows', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  ingestSnapshot(capture(usersFor(1100).concat(usersFor(3, 900000)), 1103));
  const c = counts();
  check('dated as new follows', c.dated, 3);
  check('flagged unverified', c.unverified, 0);
});

scenario('settled, 50 appear but the count only rose by 2', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  ingestSnapshot(capture(usersFor(1100).concat(usersFor(50, 900000)), 1102));
  const c = counts();
  check('dated as new follows', c.dated, 0);
  check('absorbed instead', c.snap.absorbed, 50);
});

scenario('baseline 1078/1100 must NOT settle (the old 2% rule would have)', () => {
  ingestSnapshot(capture(usersFor(1078), 1100));
  check('settled', counts().settled, false);
});

scenario('departures still register on a full walk', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  ingestSnapshot(capture(usersFor(1090), 1090));
  check('departed', counts().snap.departed, 10);
});

// ------------------------------------------------------------- head scans
const head = (users, expected, depth) =>
  capture(users, expected, { scope: 'head', headDepth: depth });

scenario('head scan on a settled watch, 3 new at the top', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  // The newcomers read first, so they occupy the top ranks.
  ingestSnapshot(head(usersFor(3, 900000).concat(usersFor(400)), 1103, 400));
  const c = counts();
  check('dated as new follows', c.dated, 3);
  check('still settled', c.settled, true);
  check('nobody marked as gone', c.gone, 0);
  check('snapshot is reliable', c.snap.reliable, true);
  check('snapshot scope', c.snap.scope, 'head');
  check('full is not measured', c.snap.full, null);
});

scenario('head scan must never mark anyone departed', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  ingestSnapshot(head(usersFor(400), 1100, 400));
  const c = counts();
  check('gone', c.gone, 0);
  check('total kept', c.total, 1100);
});

scenario('churn: follows 2, unfollows 2, count is flat — must still date them', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  // Count unchanged at 1100, so plausibleNew is 0. The count-only rule would
  // absorb these and report "nobody new" forever.
  ingestSnapshot(head(usersFor(2, 900000).concat(usersFor(400)), 1100, 400));
  const c = counts();
  check('dated as new follows', c.dated, 2);
  check('not absorbed', c.snap.absorbed, 0);
});

scenario('head scan surfacing accounts from BELOW the last depth absorbs them', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  ingestSnapshot(head(usersFor(400), 1100, 400));
  // 5 newcomers, but they read after 400 known ones, so they sit past the
  // depth the previous scan reached. Nobody has looked there before.
  ingestSnapshot(head(usersFor(400).concat(usersFor(5, 900000)), 1100, 405));
  const c = counts();
  check('dated as new follows', c.dated, 0);
  check('absorbed instead', c.snap.absorbed, 5);
});

scenario('two head scans in a row: the second must not distrust its arrivals', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  ingestSnapshot(head(usersFor(400), 1100, 400));
  ingestSnapshot(head(usersFor(1, 900000).concat(usersFor(400)), 1101, 400));
  check('flagged unverified', counts().unverified, 0);
});

scenario('a full walk after a head scan trusts its own arrivals', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  ingestSnapshot(head(usersFor(400), 1100, 400));
  ingestSnapshot(capture(usersFor(1100).concat(usersFor(2, 900000)), 1102));
  const c = counts();
  check('dated as new follows', c.dated, 2);
  check('flagged unverified', c.unverified, 0);
});

// ------------------------------------------------------------- migration
scenario('a snapshot written before `reliable` existed is judged the old way', () => {
  check('complete + full', snapshotReliable({ complete: true, full: true }), true);
  check('complete but short', snapshotReliable({ complete: true, full: false }), false);
  check('full but truncated', snapshotReliable({ complete: false, full: true }), false);
  check('no previous snapshot', snapshotReliable(null), false);
  check('explicit reliable wins', snapshotReliable({ reliable: true, full: false }), true);
});

scenario('a run with no scope recorded is treated as a head scan, not a full walk', () => {
  ingestSnapshot(capture(usersFor(1100), 1100));
  // scope deliberately absent: an old run record, or one that never got the
  // field set. It must not be allowed to mark 700 accounts departed.
  const r = capture(usersFor(400), 1100);
  delete r.scope;
  ingestSnapshot(r);
  check('nobody marked as gone', counts().gone, 0);
});

log('');
log(failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
log('DONE');
