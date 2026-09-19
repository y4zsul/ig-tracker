/**
 * Fake Instagram. Spliced into the harness page BEFORE the real interceptor,
 * so that `originalFetch` inside the interceptor closes over this instead of
 * the browser's.
 *
 * The one behaviour that matters is in `currentOrder`: the list is re-ranked on
 * every single request. That is why adjacent paging windows lose people, and a
 * capture measured against a static fixture proves nothing at all.
 */

let seed = 1;
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
function gauss(s) {
  let u = 0;
  let v = 0;
  while (!u) u = rnd();
  while (!v) v = rnd();
  return s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let server = null;

function makeServer(cfg) {
  const accounts = [];
  for (let i = 0; i < cfg.n; i++) {
    accounts.push({
      pk: String(1000000 + i),
      username: 'u' + i,
      full_name: '',
      is_private: false,
      is_verified: false,
      friendship_status: {},
    });
  }
  // Accounts followed since the last capture, planted at given positions.
  // `newAt: [0, 2, 900]` puts two at the top and one deep, which is how the
  // head scan's escalation gets exercised.
  const fresh = [];
  for (const pos of cfg.newAt || []) {
    const a = {
      pk: 'NEW' + pos,
      username: 'new' + pos,
      full_name: '',
      is_private: false,
      is_verified: false,
      friendship_status: {},
    };
    accounts.splice(Math.min(pos, accounts.length), 0, a);
    fresh.push(a.pk);
  }
  return Object.assign({ accounts, fresh, requests: 0, seq: 0, tokens: {} }, cfg);
}

function currentOrder(sv) {
  return sv.accounts
    .map((a, i) => ({ a, k: i + gauss(sv.sigma) }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.a);
}

function reply(body) {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

window.fetch = async function (url) {
  const u = String(url);

  if (/\/users\/\d+\/info\//.test(u)) {
    const user = { username: 'target', full_name: '', is_private: false };
    if (!server.noCount) {
      // `reported` above `accounts.length` models deactivated accounts: counted
      // by the profile, never served in the list.
      const n = server.reported != null ? server.reported : server.accounts.length;
      user.follower_count = n;
      user.following_count = n;
    }
    return reply(JSON.stringify({ user }));
  }

  if (!/\/friendships\/\d+\/(following|followers)\//.test(u)) {
    return reply(JSON.stringify({ status: 'ok', users: [] }));
  }

  server.requests++;
  const q = new URL(u, 'https://www.instagram.com').searchParams;
  const requested = Math.max(1, Math.min(200, Number(q.get('count')) || 50));
  // /followers/ caps pages at 25 rows however many were asked for.
  const count = server.servedPageSize ? Math.min(requested, server.servedPageSize) : requested;
  const raw = q.get('max_id');
  const order = currentOrder(server);

  let offset;
  if (server.bigToken) {
    // Numeric-looking opaque tokens. A cursor it never issued is refused.
    if (raw == null) offset = 0;
    else if (server.tokens[raw] != null) offset = server.tokens[raw];
    else return reply(JSON.stringify({ status: 'fail', message: 'invalid max_id' }));
  } else if (server.ignoreOffset) {
    offset = raw == null ? 0 : server.tokens[raw] != null ? server.tokens[raw] : 0;
  } else if (server.tokenCursor) {
    offset = raw == null ? 0 : server.tokens[raw] || 0;
  } else {
    offset = Number(raw || 0) || 0;
  }

  const slice = order
    .slice(offset, offset + count)
    .filter(() => !server.dropRate || rnd() >= server.dropRate);
  const atEnd = offset + count >= order.length;
  const payload = { users: slice, status: 'ok' };
  if (!atEnd) {
    if (server.bigToken) {
      const tok = String(17841400000000000 + server.seq++ * 7919);
      server.tokens[tok] = offset + count;
      payload.next_max_id = tok;
    } else if (server.tokenCursor || server.ignoreOffset) {
      const tok = 'TKN' + server.seq++;
      server.tokens[tok] = offset + count;
      payload.next_max_id = tok;
    } else {
      payload.next_max_id = String(offset + count);
    }
  }
  return reply(JSON.stringify(payload));
};

// Collects exactly what the service worker would: the users on each page.
const sink = { union: new Set(), pages: 0, done: null, warns: [] };
window.__sink = function (m) {
  if (m.type === 'collect:page') {
    sink.pages++;
    for (const u of m.users) if (u.pk) sink.union.add(u.pk);
  } else if (m.type === 'collect:done' || m.type === 'collect:error') {
    sink.done = m;
  } else if (m.type === 'collect:warn') {
    sink.warns.push(m.message);
  }
};

// --- assertions --------------------------------------------------------------

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
function atMost(label, got, limit) {
  const ok = got <= limit;
  if (!ok) failures++;
  log('   ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + ' = ' + got + (ok ? '' : '  (wanted <= ' + limit + ')'));
}

async function runCollect(cfg, s) {
  seed = s;
  server = makeServer(cfg);
  sink.union = new Set();
  sink.pages = 0;
  sink.done = null;
  sink.warns = [];
  await window.__collect({
    type: 'collect',
    runId: 'r' + s,
    kind: cfg.kind || 'following',
    targetId: '999',
    pageSize: 200,
    delayMs: 0,
    maxUsers: 100000,
    maxPasses: cfg.maxPasses || 6,
    plan: cfg.plan || { mode: 'full' },
  });
  return {
    union: sink.union.size,
    requests: server.requests,
    passes: (sink.done && sink.done.passes) || 0,
    reason: sink.done ? sink.done.reason || sink.done.kind : 'none',
    scope: sink.done ? sink.done.scope || '-' : '-',
    headDepth: sink.done ? sink.done.headDepth : null,
    foundNew: server.fresh.filter((pk) => sink.union.has(pk)).length,
    totalNew: server.fresh.length,
  };
}
