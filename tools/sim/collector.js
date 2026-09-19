/**
 * Collector scenarios. Spliced in after mock.js and the real interceptor.
 *
 * Every assertion is numeric on purpose. "Captured 1,100 of 1,100" is a
 * regression test; "looks about right" is not, and is how two releases went out
 * with the capture silently 2% short.
 */
(async () => {
  out.textContent = '';

  // A head-scan plan of the shape background.js's scanPlanFor() produces.
  const headPlan = (knownPks, prevCount, over) =>
    Object.assign(
      {
        mode: 'head',
        maxPasses: 4,
        prevCount,
        knownPks,
        floorRows: 300,
        ceilRows: 1000,
        quietDepth: 150,
      },
      over || {}
    );
  // Everyone in the baseline list, i.e. what a settled watch already knows.
  const knownFor = (n) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push(String(1000000 + i));
    return a;
  };

  // ---------------------------------------------------------------- full walks
  // Regression guard. These are the numbers the overlapping-window release was
  // signed off on; the head-scan work must not move them.
  log('FULL WALKS — coverage must stay at 100%');
  const fullCases = [
    { label: '1,100 following, mild reshuffle', cfg: { n: 1100, sigma: 8 } },
    { label: '1,100 following, heavy reshuffle', cfg: { n: 1100, sigma: 40 } },
    { label: '1,100 following, heavy + 1% withheld', cfg: { n: 1100, sigma: 40, dropRate: 0.01 } },
    { label: '3,000 following, heavy reshuffle', cfg: { n: 3000, sigma: 40 } },
    { label: '250 following, heavy reshuffle', cfg: { n: 250, sigma: 40 } },
  ];
  for (const c of fullCases) {
    let worst = Infinity;
    let reqs = 0;
    for (let t = 0; t < 5; t++) {
      const r = await runCollect(c.cfg, 1 + t * 7919);
      worst = Math.min(worst, r.union);
      reqs = Math.max(reqs, r.requests);
    }
    log('');
    log(c.label);
    check('worst of 5 captures', worst, c.cfg.n);
    log('   .. peak requests ' + reqs);
  }

  // ------------------------------------------------------------- endpoint shapes
  log('');
  log('ENDPOINT SHAPES — must terminate and recover everything servable');
  const shapeCases = [
    {
      label: '40 of 1,100 deactivated (count unreachable)',
      cfg: { n: 1060, reported: 1100, sigma: 40 },
      servable: 1060,
    },
    {
      label: 'followers: numeric opaque tokens, refuses unknown cursors',
      cfg: { n: 600, reported: 600, sigma: 40, bigToken: true, servedPageSize: 25, kind: 'followers' },
      servable: 600,
      tol: 5,
    },
    {
      label: 'server ignores offsets it did not issue',
      cfg: { n: 1100, reported: 1100, sigma: 40, ignoreOffset: true },
      servable: 1100,
      tol: 5,
    },
    {
      label: 'no reported count at all',
      cfg: { n: 800, reported: null, noCount: true, sigma: 40 },
      servable: 800,
    },
    { label: 'tiny list (12 following)', cfg: { n: 12, reported: 12, sigma: 3 }, servable: 12 },
  ];
  for (const c of shapeCases) {
    const r = await runCollect(c.cfg, 1);
    log('');
    log(c.label);
    if (c.tol) atMost('missed', c.servable - r.union, c.tol);
    else check('captured', r.union, c.servable);
    check('terminated cleanly', r.reason, 'complete');
    log('   .. requests ' + r.requests + ', passes ' + r.passes);
  }

  // ---------------------------------------------------------------- head scans
  log('');
  log('HEAD SCANS — the whole point of this change');

  {
    log('');
    log('3 new at the top of 1,100 following');
    const r = await runCollect(
      {
        n: 1100,
        reported: 1103,
        sigma: 40,
        newAt: [0, 2, 5],
        plan: headPlan(knownFor(1100), 1100),
      },
      1
    );
    check('found all the new accounts', r.foundNew, r.totalNew);
    check('stayed a head scan', r.scope, 'head');
    atMost('requests', r.requests, 8);
  }

  {
    log('');
    log('nothing new, 1,100 following');
    const r = await runCollect(
      { n: 1100, reported: 1100, sigma: 40, plan: headPlan(knownFor(1100), 1100) },
      1
    );
    check('stayed a head scan', r.scope, 'head');
    atMost('requests', r.requests, 8);
    log('   .. depth reached ' + r.headDepth);
  }

  {
    log('');
    log('3 new but planted DEEP (position 900) — must escalate');
    const r = await runCollect(
      {
        n: 1100,
        reported: 1103,
        sigma: 40,
        newAt: [900, 902, 905],
        plan: headPlan(knownFor(1100), 1100),
      },
      1
    );
    check('escalated to a full walk', r.scope, 'full');
    check('found all the new accounts anyway', r.foundNew, r.totalNew);
  }

  {
    log('');
    log('600 followers, 25-row pages, 1 new at the top');
    const r = await runCollect(
      {
        n: 600,
        reported: 601,
        sigma: 40,
        bigToken: true,
        servedPageSize: 25,
        kind: 'followers',
        newAt: [1],
        plan: headPlan(knownFor(600), 600),
      },
      1
    );
    check('found the new account', r.foundNew, 1);
    check('stayed a head scan', r.scope, 'head');
    atMost('requests', r.requests, 20);
  }

  {
    log('');
    log('5,000 followers, nothing new — cost must not scale with the list');
    const r = await runCollect(
      {
        n: 5000,
        reported: 5000,
        sigma: 40,
        bigToken: true,
        servedPageSize: 25,
        kind: 'followers',
        plan: headPlan(knownFor(5000), 5000),
      },
      1
    );
    check('stayed a head scan', r.scope, 'head');
    atMost('requests', r.requests, 25);
  }

  {
    log('');
    log('no reported count — must refuse to head-scan and walk properly');
    const r = await runCollect(
      {
        n: 800,
        reported: null,
        noCount: true,
        sigma: 40,
        plan: headPlan(knownFor(800), 800),
      },
      1
    );
    check('downgraded to a full walk', r.scope, 'full');
    check('captured everything', r.union, 800);
  }

  {
    log('');
    log('count FELL (unfollows) with 1 new at the top');
    const r = await runCollect(
      {
        n: 1100,
        reported: 1098,
        sigma: 40,
        newAt: [1],
        plan: headPlan(knownFor(1100), 1100),
      },
      1
    );
    check('found the new account', r.foundNew, 1);
    check('did not escalate on a falling count', r.scope, 'head');
    atMost('requests', r.requests, 8);
  }

  log('');
  log(failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
  log('DONE');
})();
