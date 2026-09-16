// ==UserScript==
// @name         Stalk That Hoe! — who doesn't follow you back
// @namespace    https://github.com/y4zsul/ig-tracker
// @version      1.0.1
// @description  Shows which accounts you follow that don't follow you back. Runs entirely on your own device, in your own Instagram session.
// @author       y4zsul
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// NOTE ON INJECTION CONTEXT
// `@inject-into page` is deliberately NOT set. Managers implement page-context
// injection by appending a <script> element, and instagram.com sends a strict
// script-src CSP that blocks exactly that — silently, with no error the user
// can see. Left unset, the manager picks a context that works.
//
// Running in the content context costs us nothing here: DOM access is the
// same, and same-origin requests to /api/v1/... still carry the session
// cookies, which is all the collector needs.

/**
 * iOS/mobile companion to the desktop extension in ../src.
 *
 * DUPLICATION IS DELIBERATE. A userscript must be one self-contained file, and
 * the extension deliberately has no build step, so the collector logic exists
 * in both places. Fixes to pagination, cursor handling or rate limiting need
 * applying to ../src/interceptor.js as well.
 *
 * Scope is one question only: who do you follow that doesn't follow you back.
 *
 * Two ways to answer it, in order of preference:
 *   1. Each row of your FOLLOWING list can carry friendship_status.followed_by,
 *      which answers it outright with no second scan. Preferred, and immune to
 *      the followers endpoint's limits.
 *   2. Otherwise, scan followers too and subtract. Slower and less reliable,
 *      because /followers/ is served 25 at a time and stops paging early on
 *      larger accounts — so anyone it never reached would be wrongly accused.
 *      Offered as an explicit extra step, never silently.
 */

(() => {
  'use strict';

  if (window.__stalkThatHoeMobile) return;
  Object.defineProperty(window, '__stalkThatHoeMobile', { value: true });

  const STORE_KEY = 'sth.mobile.v1';
  const FALLBACK_APP_ID = '936619743392459';
  const RATE_BACKOFF_MS = [45000, 180000, 420000, 900000];

  // --- tiny helpers ----------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nf = new Intl.NumberFormat();
  const nativeFetch = window.fetch.bind(window);

  function cookie(name) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie || '');
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  }

  function selfId() {
    const v = cookie('ds_user_id');
    return v && /^\d{3,}$/.test(v) ? v : null;
  }

  // --- API headers -----------------------------------------------------------

  // A wrong or missing x-ig-app-id makes the API answer HTTP 429, so it is
  // worth three separate ways of getting it.
  const harvested = Object.create(null);
  const WANTED = ['x-ig-app-id', 'x-asbd-id', 'x-ig-www-claim', 'x-csrftoken'];

  function absorb(h) {
    try {
      if (!h) return;
      const take = (k, v) => {
        const key = String(k).toLowerCase();
        if (WANTED.includes(key) && typeof v === 'string' && v) harvested[key] = v;
      };
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        for (const [k, v] of h.entries()) take(k, v);
      } else if (Array.isArray(h)) {
        for (const pair of h) if (pair && pair.length === 2) take(pair[0], pair[1]);
      } else if (typeof h === 'object') {
        for (const k of Object.keys(h)) take(k, h[k]);
      }
    } catch (_) {}
  }

  // Passive: learn the real headers from Instagram's own calls.
  try {
    const wrapped = function fetch(input, init) {
      try {
        if (init) absorb(init.headers);
        if (input && input.headers) absorb(input.headers);
      } catch (_) {}
      return nativeFetch(input, init);
    };
    wrapped.toString = () => window.fetch.toString();
    window.fetch = wrapped;
  } catch (_) {}

  let scrapedAppId = null;
  function appIdFromPage() {
    if (scrapedAppId !== null) return scrapedAppId;
    scrapedAppId = '';
    try {
      const pats = [
        /"X-IG-App-ID"\s*:\s*"(\d{6,})"/,
        /"app_id"\s*:\s*"(\d{6,})"/,
        /appId"\s*:\s*"(\d{6,})"/,
      ];
      for (const s of document.querySelectorAll('script:not([src])')) {
        const t = s.textContent;
        if (!t || t.length < 20) continue;
        for (const re of pats) {
          const m = re.exec(t);
          if (m) return (scrapedAppId = m[1]);
        }
      }
    } catch (_) {}
    return scrapedAppId;
  }

  function apiHeaders() {
    const h = {
      'x-ig-app-id': harvested['x-ig-app-id'] || appIdFromPage() || FALLBACK_APP_ID,
      'x-requested-with': 'XMLHttpRequest',
      accept: '*/*',
    };
    const csrf = harvested['x-csrftoken'] || cookie('csrftoken');
    if (csrf) h['x-csrftoken'] = csrf;
    if (harvested['x-asbd-id']) h['x-asbd-id'] = harvested['x-asbd-id'];
    if (harvested['x-ig-www-claim']) h['x-ig-www-claim'] = harvested['x-ig-www-claim'];
    return h;
  }

  // --- API -------------------------------------------------------------------

  class Halt extends Error {
    constructor(message, kind, retryAfterMs) {
      super(message);
      this.kind = kind || 'fatal';
      this.retryAfterMs = retryAfterMs || 0;
    }
  }

  async function apiGet(path) {
    let res;
    try {
      res = await nativeFetch(path, {
        method: 'GET',
        credentials: 'include',
        headers: apiHeaders(),
      });
    } catch (e) {
      throw new Halt(`Network error: ${e && e.message ? e.message : e}`, 'network');
    }

    // Read the body BEFORE branching on status: a 429 carrying an HTML page is
    // a routing failure, not a rate limit, and the status alone misleads.
    const text = await res.text();
    if (/^\s*(<!DOCTYPE|<html\b)/i.test(text)) {
      throw new Halt(
        `Instagram served a web page instead of data (HTTP ${res.status}). Reload Instagram and try again.`,
        'html'
      );
    }

    if (res.status === 429) {
      let after = 0;
      try {
        const raw = res.headers.get('retry-after');
        if (raw) {
          const secs = Number(raw);
          after = Number.isFinite(secs) ? secs * 1000 : 0;
        }
      } catch (_) {}
      throw new Halt('Instagram is rate limiting (HTTP 429).', 'rate', after);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Halt('Not authorised — make sure you are logged in, then reload.', 'auth');
    }

    let json;
    try {
      json = JSON.parse(text.replace(/^(\)\]\}'|for\s*\(;;\);)+/, ''));
    } catch (_) {
      throw new Halt(`Unexpected response (HTTP ${res.status}).`, 'parse');
    }
    if (json && (json.require_login || json.checkpoint_required || json.challenge)) {
      throw new Halt('Instagram wants a security check. Open the app and clear it first.', 'challenge');
    }
    if (json && json.spam) throw new Halt('Instagram flagged this as spam. Wait a while.', 'rate');
    if (!res.ok) throw new Halt(`HTTP ${res.status}.`, 'http');
    return json;
  }

  async function fetchUserInfo(pk) {
    try {
      const json = await apiGet(`/api/v1/users/${encodeURIComponent(pk)}/info/`);
      const u = (json && json.user) || {};
      return {
        username: typeof u.username === 'string' ? u.username : null,
        followers: Number.isInteger(u.follower_count) ? u.follower_count : null,
        following: Number.isInteger(u.following_count) ? u.following_count : null,
      };
    } catch (_) {
      return null;
    }
  }

  function shapeUser(u) {
    const pk = u.pk != null ? u.pk : u.pk_id != null ? u.pk_id : u.id;
    const fs = u.friendship_status && typeof u.friendship_status === 'object' ? u.friendship_status : null;
    return {
      pk: pk != null ? String(pk) : '',
      username: typeof u.username === 'string' ? u.username : '',
      fullName: typeof u.full_name === 'string' ? u.full_name : '',
      isPrivate: !!u.is_private,
      isVerified: !!u.is_verified,
      followsYou: fs && typeof fs.followed_by === 'boolean' ? fs.followed_by : null,
    };
  }

  // --- the walk --------------------------------------------------------------

  const state = {
    running: false,
    aborted: false,
  };

  /**
   * Pages through a friendships list and unions repeated passes.
   *
   * next_max_id is a positional offset on /following/ but an opaque token on
   * /followers/, so no assumption is made about its format — it only has to
   * change and not repeat. A SHORT page is normal and must not end the walk.
   */
  async function walkList(kind, pk, expectedTotal, onProgress) {
    const pageSize = kind === 'followers' ? 25 : 200;
    const baseDelay = kind === 'followers' ? 700 : 900;
    const maxPasses = 3;

    const union = new Map();
    let pass = 0;
    let quiet = 0;
    let lastSize = -1;
    let tokenCursor = false;
    let rateRetries = 0;

    while (pass < maxPasses) {
      let cursor = null;
      const seen = new Set();
      let pages = 0;

      for (;;) {
        if (state.aborted) return { users: [...union.values()], aborted: true };

        let path = `/api/v1/friendships/${encodeURIComponent(pk)}/${kind}/?count=${pageSize}`;
        if (cursor) path += `&max_id=${encodeURIComponent(cursor)}`;

        let json;
        try {
          json = await apiGet(path);
          rateRetries = 0;
        } catch (e) {
          if (e instanceof Halt && e.kind === 'rate' && rateRetries < RATE_BACKOFF_MS.length) {
            const wait = Math.max(RATE_BACKOFF_MS[rateRetries], e.retryAfterMs);
            rateRetries++;
            onProgress({
              note: `Rate limited — waiting ${Math.ceil(wait / 1000)}s. Keep this tab open.`,
            });
            const until = Date.now() + wait;
            while (Date.now() < until) {
              if (state.aborted) return { users: [...union.values()], aborted: true };
              await sleep(1000);
            }
            continue;
          }
          throw e;
        }

        if (json && json.special_empty_state && (!json.users || !json.users.length)) {
          if (union.size) break;
          throw new Halt("Instagram won't show this list.", 'restricted');
        }
        if (!json || !Array.isArray(json.users)) {
          throw new Halt('Unexpected response shape.', 'parse');
        }

        for (const raw of json.users) {
          const u = shapeUser(raw);
          if (u.pk && !union.has(u.pk)) union.set(u.pk, u);
        }
        pages++;
        onProgress({ count: union.size, pass: pass + 1, expectedTotal });

        const next = json.next_max_id != null ? String(json.next_max_id) : null;
        if (!next || !json.users.length) break;
        if (next === cursor || seen.has(next)) break;

        const bothNumeric =
          Number.isFinite(Number(next)) && Number.isFinite(Number(cursor || 0));
        if (bothNumeric && Number(next) <= Number(cursor || 0)) break;
        if (!Number.isFinite(Number(next))) tokenCursor = true;

        seen.add(next);
        cursor = next;
        await sleep(baseDelay + Math.random() * baseDelay * 0.5);
      }

      pass++;
      const marginal = lastSize < 0 ? Infinity : union.size - lastSize;
      lastSize = union.size;
      quiet = marginal === 0 ? quiet + 1 : 0;

      const known = expectedTotal != null && expectedTotal > 0;
      if (known && union.size >= expectedTotal) break;
      // A record-anchored cursor cannot skip anyone, so one quiet pass is
      // enough. Numeric offsets can skip, so be stubborn while still short.
      if (quiet >= (known && !tokenCursor ? 2 : 1)) break;
      if (pass < maxPasses) await sleep(1500);
    }

    return { users: [...union.values()], aborted: false };
  }

  // --- storage ---------------------------------------------------------------

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function save(data) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (_) {
      // Quota or private browsing — results just won't survive a reload.
    }
  }

  let data = load() || { following: null, followers: null, info: null, at: null };

  // --- UI --------------------------------------------------------------------

  const host = document.createElement('div');
  host.id = 'sth-host';
  // Shadow DOM so Instagram's global CSS cannot reach in and wreck the layout.
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }

      .fab {
        position: fixed;
        right: 14px;
        /* Clear of Instagram's bottom nav, which is taller on some devices. */
        bottom: calc(104px + env(safe-area-inset-bottom, 0px));
        z-index: 2147483000;
        width: 56px; height: 56px;
        border-radius: 50%;
        border: none;
        background: linear-gradient(135deg, #e0357f, #a34ae0);
        color: #fff; font-size: 23px;
        box-shadow: 0 6px 20px rgba(0,0,0,.3);
        cursor: pointer;
      }
      .fab:active { transform: scale(.94); }

      .sheet {
        position: fixed; inset: 0;
        z-index: 2147483001;
        display: flex; flex-direction: column;
        background: #fff8fb;
        color: #2b1b25;
        padding-top: env(safe-area-inset-top, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      .sheet[hidden] { display: none; }
      @media (prefers-color-scheme: dark) {
        .sheet { background: #15111a; color: #f3eaf1; }
        .row, .card { border-color: #322838 !important; }
        .sub { color: #a1919e !important; }
        .note { background: #1f1926 !important; border-color: #322838 !important; color: #a1919e !important; }
      }

      header { padding: 14px 16px 10px; }
      h1 { margin: 0 0 2px; font-size: 19px; font-weight: 800; letter-spacing: -.02em; }
      .sub { font-size: 12px; color: #8d7683; }

      .bar { display: flex; gap: 8px; padding: 0 16px 10px; }
      button.act {
        flex: 1; padding: 13px; font-size: 15px; font-weight: 700;
        border-radius: 12px; border: none; cursor: pointer;
        background: linear-gradient(135deg, #e0357f, #a34ae0); color: #fff;
      }
      button.act.ghost {
        background: transparent; color: #e0357f;
        border: 1px solid #e0357f; font-weight: 600;
      }
      button.act:disabled { opacity: .5; }
      button.x {
        position: absolute; top: calc(10px + env(safe-area-inset-top, 0px)); right: 12px;
        width: 34px; height: 34px; border-radius: 50%;
        border: none; background: rgba(128,128,128,.18); color: inherit;
        font-size: 17px; cursor: pointer;
      }

      .note {
        margin: 0 16px 10px; padding: 9px 11px;
        font-size: 11.5px; line-height: 1.5;
        border-radius: 10px; background: #fdeaf3; border: 1px solid #f4dde9; color: #8d7683;
      }
      .note[hidden] { display: none; }

      .tabs { display: flex; gap: 6px; padding: 0 16px 10px; }
      .tab {
        flex: 1; padding: 9px 6px; font-size: 12px; font-weight: 700;
        border-radius: 9px; border: 1px solid #f4dde9; background: transparent;
        color: inherit; cursor: pointer;
      }
      .tab[aria-selected="true"] { background: #e0357f; border-color: #e0357f; color: #fff; }

      .list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 12px 24px; }
      .card {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 12px; margin-bottom: 8px;
        border: 1px solid #f4dde9; border-radius: 12px; background: rgba(127,127,127,.05);
      }
      .who { flex: 1; min-width: 0; }
      .u { display: block; font-weight: 700; font-size: 15px; color: inherit; text-decoration: none;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .n { display: block; font-size: 12px; color: #8d7683;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .go { flex: 0 0 auto; font-size: 12px; font-weight: 700; color: #e0357f; text-decoration: none; }
      .empty { padding: 40px 20px; text-align: center; color: #8d7683; font-size: 14px; line-height: 1.6; }
    </style>

    <button class="fab" part="fab" title="Who doesn't follow you back">✌︎</button>

    <div class="sheet" hidden>
      <button class="x">✕</button>
      <header>
        <h1>Who doesn't follow back</h1>
        <div class="sub" id="sub">Tap Scan to start.</div>
      </header>
      <div class="bar">
        <button class="act" id="scan">Scan</button>
        <button class="act ghost" id="stop" hidden>Stop</button>
      </div>
      <div class="note" id="note" hidden></div>
      <div class="tabs" id="tabs" hidden>
        <button class="tab" data-mode="notback" aria-selected="true">Not back</button>
        <button class="tab" data-mode="fans" aria-selected="false">Fans</button>
        <button class="tab" data-mode="mutual" aria-selected="false">Mutual</button>
      </div>
      <div class="list" id="list"></div>
    </div>
  `;

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    fab: $('.fab'),
    sheet: $('.sheet'),
    close: $('.x'),
    sub: $('#sub'),
    scan: $('#scan'),
    stop: $('#stop'),
    note: $('#note'),
    tabs: $('#tabs'),
    list: $('#list'),
  };

  let mode = 'notback';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    );
  }

  function rows(list) {
    if (!list.length) return '<div class="empty"><b>Nobody here.</b></div>';
    return list
      .map(
        (u) =>
          `<div class="card"><span class="who">` +
          `<a class="u" href="https://www.instagram.com/${encodeURIComponent(u.username)}/">@${esc(u.username)}</a>` +
          `<span class="n">${esc(u.fullName) || '&nbsp;'}</span></span>` +
          `<a class="go" href="https://www.instagram.com/${encodeURIComponent(u.username)}/">Open</a></div>`
      )
      .join('');
  }

  function compute() {
    const following = data.following || [];
    const tagged = following.filter((u) => u.followsYou != null);
    const coverage = following.length ? tagged.length / following.length : 0;

    // Preferred: Instagram already told us, per row, who follows back.
    if (coverage >= 0.9 && following.length) {
      return {
        direct: true,
        notback: tagged.filter((u) => u.followsYou === false),
        mutual: tagged.filter((u) => u.followsYou === true),
        fans: null, // needs the followers list; not knowable from this side
      };
    }

    const followers = data.followers;
    if (!followers) return { direct: false, needFollowers: true };

    const fPks = new Set(followers.map((u) => u.pk));
    const gPks = new Set(following.map((u) => u.pk));
    return {
      direct: false,
      notback: following.filter((u) => !fPks.has(u.pk)),
      mutual: following.filter((u) => fPks.has(u.pk)),
      fans: followers.filter((u) => !gPks.has(u.pk)),
    };
  }

  function render() {
    const info = data.info;
    if (info) {
      ui.sub.textContent =
        `@${info.username || '…'} · ${nf.format(info.followers ?? 0)} followers · ` +
        `${nf.format(info.following ?? 0)} following` +
        (data.at ? ` · scanned ${new Date(data.at).toLocaleDateString()}` : '');
    }

    if (!data.following) {
      ui.tabs.hidden = true;
      ui.list.innerHTML =
        '<div class="empty">Tap <b>Scan</b> to read your following list.<br>Keep this tab open while it runs.</div>';
      return;
    }

    const r = compute();

    if (r.needFollowers) {
      ui.tabs.hidden = true;
      ui.note.hidden = false;
      ui.note.textContent =
        'Instagram did not include follow-back info this time, so your followers list is needed too. ' +
        'That one is slower — it is served 25 at a time — and may not finish on a large account.';
      ui.list.innerHTML =
        '<div class="empty">Tap <b>Scan followers</b> to finish the comparison.</div>';
      ui.scan.textContent = 'Scan followers';
      ui.scan.dataset.kind = 'followers';
      return;
    }

    ui.scan.textContent = 'Re-scan';
    delete ui.scan.dataset.kind;
    ui.tabs.hidden = false;
    // "Fans" is unknowable from the following list alone.
    root.querySelector('[data-mode="fans"]').style.display = r.fans ? '' : 'none';
    if (mode === 'fans' && !r.fans) mode = 'notback';

    ui.note.hidden = !r.direct;
    if (r.direct) {
      ui.note.textContent =
        'Read straight from your following list — no followers scan needed, so nothing is missing.';
    }

    for (const t of root.querySelectorAll('.tab')) {
      t.setAttribute('aria-selected', String(t.dataset.mode === mode));
    }

    const list = (mode === 'fans' ? r.fans : mode === 'mutual' ? r.mutual : r.notback) || [];
    list.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }));
    ui.list.innerHTML =
      `<div class="empty" style="padding:8px 4px 12px;text-align:left"><b>${nf.format(
        list.length
      )}</b> ${
        mode === 'fans'
          ? 'follow you that you don\'t follow back'
          : mode === 'mutual'
          ? 'mutuals'
          : 'you follow who don\'t follow you back'
      }</div>` + rows(list);
  }

  async function runScan(kind) {
    const pk = selfId();
    if (!pk) {
      ui.note.hidden = false;
      ui.note.textContent = 'Not logged in. Open Instagram, log in, reload, then try again.';
      return;
    }

    state.running = true;
    state.aborted = false;
    ui.scan.disabled = true;
    ui.stop.hidden = false;
    ui.note.hidden = true;

    try {
      const info = (await fetchUserInfo(pk)) || data.info;
      if (info) data.info = info;
      const expected = kind === 'followers' ? info && info.followers : info && info.following;

      ui.list.innerHTML = '<div class="empty">Starting…</div>';
      const out = await walkList(kind, pk, expected, (p) => {
        if (p.note) {
          ui.note.hidden = false;
          ui.note.textContent = p.note;
          return;
        }
        ui.list.innerHTML = `<div class="empty">Read <b>${nf.format(p.count)}</b>${
          p.expectedTotal ? ` of ${nf.format(p.expectedTotal)}` : ''
        }…<br>pass ${p.pass}<br><br>Keep this tab open.</div>`;
      });

      data[kind] = out.users;
      data.at = Date.now();
      save(data);
      mode = 'notback';
    } catch (e) {
      ui.note.hidden = false;
      ui.note.textContent = e && e.message ? e.message : String(e);
    } finally {
      state.running = false;
      ui.scan.disabled = false;
      ui.stop.hidden = true;
      render();
    }
  }

  ui.fab.addEventListener('click', () => {
    ui.sheet.hidden = false;
    render();
  });
  ui.close.addEventListener('click', () => {
    ui.sheet.hidden = true;
  });
  ui.scan.addEventListener('click', () => runScan(ui.scan.dataset.kind || 'following'));
  ui.stop.addEventListener('click', () => {
    state.aborted = true;
    ui.stop.disabled = true;
    setTimeout(() => (ui.stop.disabled = false), 1500);
  });
  ui.tabs.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    mode = t.dataset.mode;
    ui.list.scrollTop = 0;
    render();
  });

  // Warn before a reload throws away a scan in progress.
  window.addEventListener('beforeunload', (e) => {
    if (!state.running) return;
    e.preventDefault();
    e.returnValue = '';
  });

  function mount() {
    if (!document.body || document.getElementById('sth-host')) return;
    document.body.appendChild(host);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
  // Instagram is a single-page app and re-renders the body on navigation, so
  // re-attach if our host gets swept away.
  setInterval(mount, 3000);
})();
