// ==UserScript==
// @name         Stalk That Hoe!
// @namespace    https://github.com/y4zsul/ig-tracker
// @version      1.5.1
// @description  See who doesn't follow you back, track who an account starts following, compare two accounts, and watch stories without sending a seen receipt. Runs entirely on your own device, in your own Instagram session.
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
// can see. Left unset, the manager picks a context that works. (Confirmed on a
// device: with `page` set, nothing ran at all.)
//
// Running in the content context costs us nothing: DOM access is the same, and
// same-origin requests to /api/v1/... still carry the session cookies.

/**
 * iOS/mobile companion to the desktop extension in ../src.
 *
 * DUPLICATION IS DELIBERATE. A userscript must be one self-contained file, and
 * the extension has no build step, so the collector logic exists in both
 * places. Fixes to pagination, cursor handling, rate limiting or the
 * arrival/absorption rules need applying to ../src/ as well.
 *
 * Three things it does:
 *   1. My account — who you follow that doesn't follow you back.
 *   2. New stalk  — baseline capture of anyone's following list.
 *   3. Monitor    — who they have added since, dated to when you checked.
 *
 * Instagram publishes no follow timestamps and serves these lists in ranked
 * order, so a single capture is NEVER chronological. Chronology only comes
 * from comparing captures over time, and the UI is written to never imply
 * otherwise.
 */

(() => {
  'use strict';

  if (window.__stalkThatHoeMobile) return;
  Object.defineProperty(window, '__stalkThatHoeMobile', { value: true });

  const STORE_KEY = 'sth.mobile.v1';
  const FALLBACK_APP_ID = '936619743392459';
  const RATE_BACKOFF_MS = [45000, 180000, 420000, 900000];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nf = new Intl.NumberFormat();
  const nativeFetch = window.fetch.bind(window);

  const dtGroup = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const dtShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

  // --- session ---------------------------------------------------------------

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
        const secs = raw ? Number(raw) : NaN;
        if (Number.isFinite(secs)) after = secs * 1000;
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
        isPrivate: !!u.is_private,
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Handle -> pk. web_profile_info answers 429 for every logged-in session, so
   * topsearch is the working route. It is FUZZY — a query for "jane" happily
   * returns "janedoe123" — so only an exact username match counts.
   */
  async function resolveTarget(input) {
    const raw = String(input || '').replace(/^@/, '').trim();
    if (!raw) throw new Halt('Enter a username.', 'input');

    if (/^\d{3,}$/.test(raw)) {
      const info = await fetchUserInfo(raw);
      return { pk: raw, username: (info && info.username) || raw, info };
    }

    const json = await apiGet(
      `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(raw)}`
    );
    const want = raw.toLowerCase();
    let hit = null;
    for (const entry of (json && json.users) || []) {
      const u = (entry && entry.user) || entry;
      if (u && String(u.username || '').toLowerCase() === want) {
        hit = u;
        break;
      }
    }
    if (!hit) throw new Halt(`No account called @${raw}.`, 'notfound');

    const pk = String(hit.pk != null ? hit.pk : hit.id || '');
    if (!pk) throw new Halt(`No account called @${raw}.`, 'notfound');

    const fs = hit.friendship_status || {};
    const follows = typeof fs.following === 'boolean' ? fs.following : null;
    // Refuse only when certain; an unknown relationship lets the list call decide.
    if (hit.is_private && follows === false && selfId() !== pk) {
      throw new Halt(`@${hit.username} is private and you don't follow them.`, 'private');
    }

    const info = await fetchUserInfo(pk);
    return { pk, username: (info && info.username) || hit.username || raw, info };
  }

  // --- stories ---------------------------------------------------------------
  //
  // Viewing a story and MARKING IT SEEN are two different requests. The media
  // arrives from the reels endpoint; the read receipt is a separate
  // /api/v1/media/seen/ POST the app sends afterwards. This fetches the reel
  // and never sends that POST — there is no "anonymous" flag, just an omitted
  // request. Nothing here may ever post to that endpoint.

  function bestUrl(list) {
    if (!Array.isArray(list) || !list.length) return null;
    let best = list[0];
    for (const c of list) {
      if (c && typeof c.width === 'number' && c.width > (best.width || 0)) best = c;
    }
    return best && best.url ? String(best.url) : null;
  }

  function parseReel(json, pk) {
    let reel = null;
    if (Array.isArray(json.reels_media) && json.reels_media.length) reel = json.reels_media[0];
    else if (json.reels && typeof json.reels === 'object') {
      reel = json.reels[pk] || Object.values(json.reels)[0] || null;
    } else if (json.reel) reel = json.reel;
    if (!reel || !Array.isArray(reel.items)) return null;

    return {
      username: reel.user && reel.user.username ? String(reel.user.username) : null,
      items: reel.items
        .map((it) => {
          const image = bestUrl(it.image_versions2 && it.image_versions2.candidates);
          const video = bestUrl(it.video_versions);
          return {
            takenAt: typeof it.taken_at === 'number' ? it.taken_at * 1000 : null,
            isVideo: !!video || it.media_type === 2,
            image,
            video,
          };
        })
        .filter((i) => i.image || i.video),
    };
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

  const run = { busy: false, aborted: false };

  /**
   * Pages a friendships list and unions repeated passes.
   *
   * next_max_id is a positional offset on /following/ but an opaque token on
   * /followers/, so nothing assumes a format — the cursor only has to change
   * and not repeat. A SHORT page is normal and must not end the walk.
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
    let reachedEnd = false;

    while (pass < maxPasses) {
      let cursor = null;
      const seen = new Set();

      for (;;) {
        if (run.aborted) return { users: [...union.values()], aborted: true, reachedEnd };

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
            const until = Date.now() + wait;
            while (Date.now() < until) {
              if (run.aborted) return { users: [...union.values()], aborted: true, reachedEnd };
              onProgress({
                note: `Rate limited. Waiting ${Math.ceil((until - Date.now()) / 1000)}s — keep this tab open.`,
              });
              await sleep(1000);
            }
            continue;
          }
          throw e;
        }

        if (json && json.special_empty_state && (!json.users || !json.users.length)) {
          if (union.size) break;
          throw new Halt("Instagram won't show this list — it may be private or restricted.", 'restricted');
        }
        if (!json || !Array.isArray(json.users)) throw new Halt('Unexpected response shape.', 'parse');

        for (const raw of json.users) {
          const u = shapeUser(raw);
          if (u.pk && !union.has(u.pk)) union.set(u.pk, u);
        }
        onProgress({ count: union.size, pass: pass + 1, expectedTotal });

        const next = json.next_max_id != null ? String(json.next_max_id) : null;
        if (!next || !json.users.length) {
          reachedEnd = true;
          break;
        }
        if (next === cursor || seen.has(next)) break;
        const bothNumeric = Number.isFinite(Number(next)) && Number.isFinite(Number(cursor || 0));
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
      // A record-anchored cursor cannot skip anyone, so one quiet pass suffices.
      // Numeric offsets can skip, so stay stubborn while still short.
      if (quiet >= (known && !tokenCursor ? 2 : 1)) break;
      if (pass < maxPasses) await sleep(1500);
    }

    return { users: [...union.values()], aborted: false, reachedEnd };
  }

  // --- storage ---------------------------------------------------------------

  let quotaHit = false;

  function blank() {
    return { v: 2, self: { info: null, following: null, followers: null, at: null }, tracks: {} };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return blank();
      const d = JSON.parse(raw);
      if (d && d.v === 2) return d;
      // v1 stored only the my-account lists at the top level.
      return {
        v: 2,
        self: { info: d.info || null, following: d.following || null, followers: d.followers || null, at: d.at || null },
        tracks: {},
      };
    } catch (_) {
      return blank();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      quotaHit = false;
      return true;
    } catch (_) {
      // Silent loss would cost someone their baseline, so surface it.
      quotaHit = true;
      return false;
    }
  }

  let data = load();

  // Records are stored with short keys purely to fit more in localStorage.
  const packAccount = (u, at, baseline, confirmed) => ({
    u: u.username,
    n: u.fullName,
    p: u.isPrivate ? 1 : 0,
    vf: u.isVerified ? 1 : 0,
    f: at,
    b: baseline ? 1 : 0,
    c: confirmed === null ? null : confirmed ? 1 : 0,
    g: null,
  });

  const unpack = (pk, a) => ({
    pk,
    username: a.u,
    fullName: a.n,
    isPrivate: !!a.p,
    isVerified: !!a.vf,
    firstSeenAt: a.f,
    baseline: !!a.b,
    confirmed: a.c === null ? null : !!a.c,
    goneAt: a.g,
  });

  /**
   * Folds a finished capture into the longitudinal record.
   *
   * The capture's own order is Instagram's ranked display order and means
   * nothing. What means something is WHEN an account first showed up: absent
   * from capture N, present in N+1, so it arrived between the two.
   */
  function ingest(kind, pk, username, users, expectedTotal, complete) {
    const key = `${kind}:${pk}`;
    const at = Date.now();
    let t = data.tracks[key];
    const isFirst = !t;
    if (!t) {
      t = { kind, pk, username, snapshots: [], accounts: {} };
      data.tracks[key] = t;
    }
    if (username) t.username = username;

    const prev = t.snapshots.length ? t.snapshots[t.snapshots.length - 1] : null;
    const arrivalsTrustworthy = prev ? prev.full === true && prev.complete === true : false;

    const seen = new Set();
    const fresh = [];
    for (const u of users) {
      if (!u.pk) continue;
      seen.add(u.pk);
      const acc = t.accounts[u.pk];
      if (!acc) {
        t.accounts[u.pk] = packAccount(u, at, isFirst, isFirst ? null : arrivalsTrustworthy);
        fresh.push(u.pk);
      } else {
        acc.g = null;
        if (u.username) acc.u = u.username;
        if (u.fullName) acc.n = u.fullName;
      }
    }

    let departed = 0;
    if (complete && !isFirst) {
      for (const p of Object.keys(t.accounts)) {
        if (!seen.has(p) && !t.accounts[p].g) {
          t.accounts[p].g = at;
          departed++;
        }
      }
    }

    const drift = expectedTotal != null ? expectedTotal - users.length : null;
    const full = drift == null ? null : Math.abs(drift) <= Math.max(5, expectedTotal * 0.02);

    // The strongest tell that an "arrival" is a recovered miss: the profile's
    // own count did not rise enough to account for it. If they followed
    // nobody, anybody newly visible was there all along.
    const prevExpected = prev ? prev.expectedTotal : null;
    const expectedDelta =
      prevExpected != null && expectedTotal != null ? expectedTotal - prevExpected : null;
    const plausibleNew = expectedDelta == null ? null : Math.max(0, expectedDelta + departed);

    let arrived = fresh.length;
    let absorbed = 0;
    if (plausibleNew === 0 && fresh.length) {
      // Not news. Fold them into the baseline rather than parading them as
      // arrivals with a disclaimer nobody can act on.
      for (const p of fresh) {
        const a = t.accounts[p];
        a.b = 1;
        a.c = null;
        absorbed++;
      }
      arrived = 0;
    } else if (plausibleNew != null && arrived > plausibleNew) {
      for (const p of fresh) t.accounts[p].c = 0;
    }

    t.snapshots.push({ at, count: users.length, expectedTotal, complete, full });
    if (t.snapshots.length > 100) t.snapshots.splice(0, t.snapshots.length - 100);

    save();
    return { arrived, absorbed, departed, isFirst, total: users.length };
  }

  const members = (t) =>
    Object.entries(t.accounts)
      .map(([pk, a]) => unpack(pk, a))
      .filter((a) => !a.goneAt);

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
        position: fixed; right: 14px;
        /* A default only. Browser chrome sits in different places on iOS
           Safari and Firefox Android, and Instagram's own nav moves too, so
           rather than guess at every combination the button is draggable and
           remembers where it was put. */
        bottom: calc(104px + env(safe-area-inset-bottom, 0px));
        z-index: 2147483000;
        width: 56px; height: 56px; border-radius: 50%; border: none;
        background: linear-gradient(135deg, #e0357f, #a34ae0);
        color: #fff; font-size: 23px;
        box-shadow: 0 6px 20px rgba(0,0,0,.3); cursor: pointer;
        touch-action: none; /* a drag must not scroll the page underneath */
      }
      .fab:active { transform: scale(.94); }
      .fab.dragging { opacity: .9; transform: scale(1.06); }

      .sheet {
        position: fixed; inset: 0; z-index: 2147483001;
        display: flex; flex-direction: column;
        background: #fff8fb; color: #2b1b25;
        padding-top: env(safe-area-inset-top, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      .sheet[hidden] { display: none; }
      @media (prefers-color-scheme: dark) {
        .sheet { background: #15111a; color: #f3eaf1; }
        .card, .tab, select, input { border-color: #322838 !important; }
        .sub, .n, .ghead-note { color: #a1919e !important; }
        .note { background: #1f1926 !important; border-color: #322838 !important; color: #a1919e !important; }
        select, input { background: #1f1926 !important; color: #f3eaf1 !important; }
      }

      header {
        padding: 18px 58px 14px 16px;
        position: relative;
        /* The close/back buttons are absolutely positioned and out of flow, so
           the header has to reserve their height itself. Without this it
           collapses on views with no subtitle and the first control rides up
           underneath them. */
        min-height: 66px;
      }
      h1 { margin: 0 0 3px; font-size: 19px; font-weight: 800; letter-spacing: -.02em; }
      /* Holds a line even when empty, so the header is the same height on
         every view and the content below does not jump around. */
      .sub { font-size: 12px; line-height: 15px; min-height: 15px; color: #8d7683; }
      .x, .bk {
        position: absolute; top: 14px;
        /* Both sit BEFORE <header> in the DOM, and header is position:relative.
           Without a z-index the header paints over them, so they stay visible
           but swallow every tap. */
        z-index: 3;
        width: 38px; height: 38px; border-radius: 50%; border: none;
        background: rgba(128,128,128,.18); color: inherit; font-size: 18px; cursor: pointer;
      }
      .x { right: 12px; }
      .bk { left: 12px; }
      header.hasback { padding-left: 58px; }

      .pad { padding: 0 16px 12px; }
      .rowf { display: flex; gap: 8px; }
      button.act {
        flex: 1; padding: 13px; font-size: 15px; font-weight: 700;
        border-radius: 12px; border: none; cursor: pointer;
        background: linear-gradient(135deg, #e0357f, #a34ae0); color: #fff;
      }
      button.act.ghost { background: transparent; color: #e0357f; border: 1px solid #e0357f; font-weight: 600; }
      button.act:disabled { opacity: .5; }
      button.big {
        width: 100%; padding: 18px; margin-bottom: 12px;
        font-size: 16px; font-weight: 700; text-align: left;
        border-radius: 14px; border: 1px solid #f4dde9; cursor: pointer;
        background: rgba(127,127,127,.06); color: inherit;
      }
      button.big:last-child { margin-bottom: 0; }
      button.big b { display: block; font-size: 16px; }
      button.big span { display: block; font-size: 12px; font-weight: 500; opacity: .7; margin-top: 3px; }
      button.big.p { background: linear-gradient(135deg, #e0357f, #a34ae0); color: #fff; border: none; }
      button.big.p span { opacity: .85; }

      input, select {
        width: 100%; padding: 13px; font-size: 16px;
        border-radius: 12px; border: 1px solid #f4dde9; background: #fff; color: inherit;
      }

      .note {
        margin: 0 16px 10px; padding: 9px 11px; font-size: 11.5px; line-height: 1.5;
        border-radius: 10px; background: #fdeaf3; border: 1px solid #f4dde9; color: #8d7683;
      }
      .note[hidden] { display: none; }

      .tabs { display: flex; gap: 6px; padding: 0 16px 10px; }
      .tab {
        flex: 1; padding: 9px 6px; font-size: 12px; font-weight: 700;
        border-radius: 9px; border: 1px solid #f4dde9; background: transparent; color: inherit; cursor: pointer;
      }
      .tab[aria-selected="true"] { background: #e0357f; border-color: #e0357f; color: #fff; }

      .list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 12px 28px; }
      .card {
        display: flex; align-items: center; gap: 10px; padding: 12px;
        margin-bottom: 8px; border: 1px solid #f4dde9; border-radius: 12px;
        background: rgba(127,127,127,.05);
      }
      .who { flex: 1; min-width: 0; }
      .u { display: block; font-weight: 700; font-size: 15px; color: inherit; text-decoration: none;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .n { display: block; font-size: 12px; color: #8d7683;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .go { flex: 0 0 auto; font-size: 12px; font-weight: 700; color: #e0357f; text-decoration: none; }
      .flag { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em;
              padding: 3px 5px; border-radius: 5px; border: 1px solid #f3d9ab; color: #9a5b00; background: #fff5e6; }

      .ghead { display: flex; justify-content: space-between; align-items: center;
               gap: 8px; padding: 16px 4px 4px; }
      .gtime { font-weight: 800; font-size: 13px; }
      .gcount { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
                color: #fff; background: linear-gradient(135deg,#e0357f,#a34ae0);
                padding: 4px 8px; border-radius: 99px; }
      .ghead-note { padding: 0 4px 8px; font-size: 10.5px; color: #9a5b00; }
      .gfoot { margin: 18px 4px 0; padding-top: 12px; font-size: 11px; line-height: 1.55;
               color: #8d7683; border-top: 1px dashed #f4dde9; }

      .empty { padding: 40px 20px; text-align: center; color: #8d7683; font-size: 14px; line-height: 1.6; }

      .stat { display: flex; gap: 8px; padding: 0 16px 12px; }
      .stat div {
        flex: 1; text-align: center; padding: 10px 6px;
        border: 1px solid #f4dde9; border-radius: 12px; background: rgba(127,127,127,.05);
        font-size: 11px; color: #8d7683;
      }
      .stat b { display: block; font-size: 18px; font-weight: 800; color: inherit; }

      .story { margin-bottom: 10px; border: 1px solid #f4dde9; border-radius: 12px; overflow: hidden; }
      .story-head {
        display: flex; justify-content: space-between; gap: 8px;
        padding: 8px 10px; font-size: 11px; color: #8d7683;
      }
      .story-media {
        display: block; width: 100%; height: auto;
        max-height: 68vh; object-fit: contain; background: #000;
      }
      .story-acts { padding: 8px 10px; }
      .story-acts button {
        width: 100%; padding: 11px 6px;
        font-size: 13px; font-weight: 700; font-family: inherit;
        border-radius: 10px; border: none; cursor: pointer;
        background: linear-gradient(135deg,#e0357f,#a34ae0); color: #fff;
      }
      .story-acts button:active { filter: brightness(.92); }
    </style>

    <button class="fab">✌︎</button>

    <div class="sheet" hidden>
      <button class="x">✕</button>
      <button class="bk" hidden>‹</button>
      <header>
        <h1 id="title">Stalk That Hoe!</h1>
        <div class="sub" id="sub"></div>
      </header>
      <div id="controls"></div>
      <div class="note" id="note" hidden></div>
      <div class="list" id="list"></div>
    </div>
  `;

  const $ = (s) => root.querySelector(s);
  const ui = {
    fab: $('.fab'),
    sheet: $('.sheet'),
    close: $('.x'),
    back: $('.bk'),
    header: $('header'),
    title: $('#title'),
    sub: $('#sub'),
    controls: $('#controls'),
    note: $('#note'),
    list: $('#list'),
  };

  let view = 'home';
  let selfMode = 'notback';
  let monKey = null;
  let cmpA = null;
  let cmpB = null;
  let cmpMode = 'both';
  let stories = null; // last loaded reel, kept in memory only

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    );
  }

  const byName = (a, b) =>
    String(a.username || '').localeCompare(String(b.username || ''), undefined, { sensitivity: 'base' });

  function card(u) {
    const flag = u.confirmed === false ? '<span class="flag">unverified</span>' : '';
    const href = `https://www.instagram.com/${encodeURIComponent(u.username)}/`;
    return (
      `<div class="card"><span class="who">` +
      `<a class="u" href="${href}">@${esc(u.username)}</a>` +
      `<span class="n">${esc(u.fullName) || '&nbsp;'}</span></span>` +
      flag +
      `<a class="go" href="${href}">Open</a></div>`
    );
  }

  function setNote(text, show) {
    ui.note.hidden = !show;
    if (show) ui.note.textContent = text;
  }

  // --- views -----------------------------------------------------------------

  function renderHome() {
    ui.title.textContent = 'Stalk That Hoe!';
    ui.sub.textContent = quotaHit ? 'Storage is full — delete a watch to save more.' : '';
    ui.back.hidden = true;
    ui.header.classList.remove('hasback');
    setNote('', false);
    const watching = Object.keys(data.tracks).length;
    ui.controls.innerHTML = `
      <div class="pad">
        <button class="big p" data-go="self"><b>My account</b><span>Who doesn't follow you back</span></button>
        <button class="big" data-go="stalk"><b>Start a new stalk</b><span>Record who they follow now, to monitor later</span></button>
        <button class="big" data-go="monitor"><b>Monitor a user</b><span>${
          watching ? `See who they've added · ${watching} watched` : 'Nothing watched yet'
        }</span></button>
        <button class="big" data-go="compare"><b>Compare two accounts</b><span>Who they both follow</span></button>
        <button class="big" data-go="stories"><b>Watch stories quietly</b><span>No seen receipt sent</span></button>
      </div>`;
    ui.list.innerHTML = `<div class="empty">Instagram never says when a follow happened, so a first
      capture has no order. Only what shows up <i>after</i> it can be dated.</div>`;
  }

  function renderSelf() {
    ui.title.textContent = 'My account';
    ui.back.hidden = false;
    ui.header.classList.add('hasback');
    const s = data.self;
    ui.sub.textContent = s.info
      ? `@${s.info.username || '…'} · ${nf.format(s.info.followers ?? 0)} followers · ${nf.format(
          s.info.following ?? 0
        )} following`
      : 'Tap Scan to start.';

    const following = s.following || [];
    const tagged = following.filter((u) => u.followsYou != null);
    const direct = following.length && tagged.length / following.length >= 0.9;
    const needFollowers = following.length && !direct && !s.followers;

    ui.controls.innerHTML = `
      <div class="pad rowf">
        <button class="act" id="scan">${
          !following.length ? 'Scan' : needFollowers ? 'Scan followers' : 'Re-scan'
        }</button>
        <button class="act ghost" id="stop" hidden>Stop</button>
      </div>` +
      (following.length && !needFollowers
        ? `<div class="tabs">
             <button class="tab" data-m="notback" aria-selected="${selfMode === 'notback'}">Traitors</button>
             ${s.followers ? `<button class="tab" data-m="fans" aria-selected="${selfMode === 'fans'}">Fans</button>` : ''}
             <button class="tab" data-m="mutual" aria-selected="${selfMode === 'mutual'}">Mutuals</button>
           </div>`
        : '');

    if (!following.length) {
      setNote('', false);
      ui.list.innerHTML = '<div class="empty">Tap <b>Scan</b> to read your following list.<br>Keep this tab open.</div>';
      return;
    }
    if (needFollowers) {
      setNote(
        'Instagram left out follow-back info this time, so your followers list is needed too. That one is slower — served 25 at a time — and may not finish on a large account.',
        true
      );
      ui.list.innerHTML = '<div class="empty">Tap <b>Scan followers</b> to finish.</div>';
      return;
    }

    let list;
    if (direct) {
      setNote('Read straight from your following list — nothing is missing.', true);
      list =
        selfMode === 'mutual'
          ? tagged.filter((u) => u.followsYou === true)
          : tagged.filter((u) => u.followsYou === false);
      if (selfMode === 'fans') list = [];
    } else {
      const fPks = new Set((s.followers || []).map((u) => u.pk));
      const gPks = new Set(following.map((u) => u.pk));
      setNote(
        'Compared against your followers scan. If that came up short, some people here may actually follow you.',
        true
      );
      list =
        selfMode === 'fans'
          ? (s.followers || []).filter((u) => !gPks.has(u.pk))
          : selfMode === 'mutual'
          ? following.filter((u) => fPks.has(u.pk))
          : following.filter((u) => !fPks.has(u.pk));
    }

    list = list.slice().sort(byName);
    const label =
      selfMode === 'fans'
        ? "follow you that you don't follow back"
        : selfMode === 'mutual'
        ? 'mutuals'
        : "you follow who don't follow you back";
    ui.list.innerHTML =
      `<div class="ghead"><span class="gtime">${nf.format(list.length)} ${esc(label)}</span></div>` +
      (list.length ? list.map(card).join('') : '<div class="empty"><b>Nobody here.</b></div>');
  }

  function renderStalk() {
    ui.title.textContent = 'Start a new stalk';
    ui.back.hidden = false;
    ui.header.classList.add('hasback');
    ui.sub.textContent = 'Records who they follow now, so Monitor can show what changes.';
    ui.controls.innerHTML = `
      <div class="pad"><input id="target" type="text" placeholder="username" autocapitalize="off"
        autocorrect="off" spellcheck="false" inputmode="text"></div>
      <div class="pad rowf">
        <button class="act" id="start">Start stalk</button>
        <button class="act ghost" id="stop" hidden>Stop</button>
      </div>`;
    setNote('', false);
    ui.list.innerHTML = '<div class="empty">Enter a username and tap <b>Start stalk</b>.</div>';
  }

  function renderMonitor() {
    ui.title.textContent = 'Monitor a user';
    ui.back.hidden = false;
    ui.header.classList.add('hasback');

    const keys = Object.keys(data.tracks);
    if (!keys.length) {
      ui.sub.textContent = '';
      ui.controls.innerHTML = '';
      setNote('', false);
      ui.list.innerHTML =
        '<div class="empty"><b>Nothing watched yet.</b><br>Use <b>Start a new stalk</b> first — that first capture is the baseline.</div>';
      return;
    }
    if (!monKey || !data.tracks[monKey]) monKey = keys[0];
    const t = data.tracks[monKey];

    ui.controls.innerHTML = `
      <div class="pad"><select id="pick">${keys
        .map(
          (k) =>
            `<option value="${esc(k)}" ${k === monKey ? 'selected' : ''}>@${esc(
              data.tracks[k].username || data.tracks[k].pk
            )} · ${data.tracks[k].kind}</option>`
        )
        .join('')}</select></div>
      <div class="pad rowf">
        <button class="act" id="check">Check now</button>
        <button class="act ghost" id="stop" hidden>Stop</button>
        <button class="act ghost" id="del" style="flex:0 0 auto;padding:13px 16px">✕</button>
      </div>`;

    const last = t.snapshots[t.snapshots.length - 1];
    const all = members(t);
    ui.sub.textContent = `${nf.format(all.length)} tracked · ${t.snapshots.length} check${
      t.snapshots.length === 1 ? '' : 's'
    } · since ${dtShort.format(new Date(t.snapshots[0].at))}`;

    const arrivals = all.filter((a) => !a.baseline);
    const baselineCount = all.length - arrivals.length;

    if (!arrivals.length) {
      setNote('', false);
      ui.list.innerHTML = `<div class="empty"><b>Nobody new yet.</b><br>
        ${nf.format(baselineCount)} accounts were already there when you started watching
        on ${esc(dtShort.format(new Date(t.snapshots[0].at)))} — they aren't listed, because
        there's no way to know what order they were added in.<br><br>Tap <b>Check now</b> to look again.</div>`;
      return;
    }

    const buckets = new Map();
    for (const a of arrivals) {
      const l = buckets.get(a.firstSeenAt) || [];
      l.push(a);
      buckets.set(a.firstSeenAt, l);
    }
    const groups = [...buckets.entries()].sort((x, y) => y[0] - x[0]);

    setNote('', false);
    ui.list.innerHTML =
      groups
        .map(([at, list], i) => {
          const shaky = list.filter((u) => u.confirmed === false).length;
          return (
            `<div class="ghead"><span class="gtime">${esc(dtGroup.format(new Date(at)))}</span>` +
            // Only the newest check is badged; on older groups it reads as
            // though those arrivals are new too.
            (i === 0 ? `<span class="gcount">${nf.format(list.length)} new</span>` : '') +
            `</div>` +
            (shaky
              ? `<div class="ghead-note">${nf.format(shaky)} unverified — the previous capture came
                 up short, so they may have been followed long ago and simply missed.</div>`
              : '') +
            list.sort(byName).map(card).join('')
          );
        })
        .join('') +
      `<div class="gfoot">${nf.format(baselineCount)} accounts predate the watch and aren't listed.
       <br>Accounts under one date were all found by that single check — they aren't in order
       relative to each other.</div>`;
  }

  /**
   * How complete a track is, judged on the ACCUMULATED membership across every
   * capture rather than the last run alone — captures union into one record,
   * so a track can hold more than any single run collected.
   */
  function quality(t) {
    const last = t.snapshots[t.snapshots.length - 1];
    const have = members(t).length;
    const want = last ? last.expectedTotal : null;
    if (want != null && want > 0 && want - have > Math.max(5, want * 0.02)) {
      return { ok: false, text: `${nf.format(have)} of ${nf.format(want)}` };
    }
    return { ok: true, text: `${nf.format(have)}` };
  }

  function renderCompare() {
    ui.title.textContent = 'Compare';
    ui.back.hidden = false;
    ui.header.classList.add('hasback');

    const keys = Object.keys(data.tracks);
    if (keys.length < 2) {
      ui.sub.textContent = '';
      ui.controls.innerHTML = '';
      setNote('', false);
      ui.list.innerHTML = `<div class="empty"><b>Stalk two accounts first.</b><br>
        This compares lists you've already captured, so it needs at least two.</div>`;
      return;
    }
    if (!cmpA || !data.tracks[cmpA]) cmpA = keys[0];
    if (!cmpB || !data.tracks[cmpB] || cmpB === cmpA) cmpB = keys.find((k) => k !== cmpA) || keys[1];

    const opts = (sel) =>
      keys
        .map(
          (k) =>
            `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>@${esc(
              data.tracks[k].username || data.tracks[k].pk
            )} · ${data.tracks[k].kind}</option>`
        )
        .join('');

    ui.sub.textContent = 'Runs on captures you already have — no requests.';
    ui.controls.innerHTML = `
      <div class="pad"><select id="cA">${opts(cmpA)}</select></div>
      <div class="pad"><select id="cB">${opts(cmpB)}</select></div>`;

    const ta = data.tracks[cmpA];
    const tb = data.tracks[cmpB];
    const A = members(ta);
    const B = members(tb);
    const bPks = new Set(B.map((u) => u.pk));
    const aPks = new Set(A.map((u) => u.pk));
    const both = A.filter((u) => bPks.has(u.pk));
    const onlyA = A.filter((u) => !bPks.has(u.pk));
    const onlyB = B.filter((u) => !aPks.has(u.pk));

    ui.controls.innerHTML += `
      <div class="stat">
        <div><b>${nf.format(both.length)}</b>in both</div>
        <div><b>${nf.format(A.length)}</b>first</div>
        <div><b>${nf.format(B.length)}</b>second</div>
      </div>
      <div class="tabs">
        <button class="tab" data-c="both" aria-selected="${cmpMode === 'both'}">In both</button>
        <button class="tab" data-c="onlyA" aria-selected="${cmpMode === 'onlyA'}">Only 1st</button>
        <button class="tab" data-c="onlyB" aria-selected="${cmpMode === 'onlyB'}">Only 2nd</button>
      </div>`;

    const qa = quality(ta);
    const qb = quality(tb);
    if (ta.kind !== tb.kind) {
      setNote(`You're comparing a ${ta.kind} list against a ${tb.kind} list.`, true);
    } else if (!qa.ok || !qb.ok) {
      // Only omission is possible here — everyone shown really is in both.
      setNote(
        `At least this many — a capture came up short, so a few may be missing. ` +
          `@${ta.username} ${qa.text}, @${tb.username} ${qb.text}. Re-check them from Monitor.`,
        true
      );
    } else {
      setNote('', false);
    }

    const list = (cmpMode === 'onlyA' ? onlyA : cmpMode === 'onlyB' ? onlyB : both)
      .slice()
      .sort(byName);
    const verb = ta.kind === 'following' ? 'followed by' : 'following';
    const label =
      cmpMode === 'onlyA'
        ? `only ${verb} @${ta.username}`
        : cmpMode === 'onlyB'
        ? `only ${verb} @${tb.username}`
        : `${verb} both`;

    ui.list.innerHTML =
      `<div class="ghead"><span class="gtime">${nf.format(list.length)} ${esc(label)}</span></div>` +
      (list.length ? list.map(card).join('') : '<div class="empty"><b>No overlap at all.</b></div>');
  }

  function renderStories() {
    ui.title.textContent = 'Stories';
    ui.back.hidden = false;
    ui.header.classList.add('hasback');
    ui.sub.textContent = stories ? `@${stories.username}` : 'Watch without being seen.';

    ui.controls.innerHTML = `
      <div class="pad"><input id="storyUser" type="text" placeholder="username"
        autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div class="pad rowf"><button class="act" id="loadStory">Load story</button></div>`;

    if (!stories) {
      setNote(
        "Loads their story without sending a seen receipt, so you shouldn't appear in their viewer list. Don't open the same story in Instagram afterwards — that will.",
        true
      );
      ui.list.innerHTML = '<div class="empty">Enter a username and tap <b>Load story</b>.</div>';
      return;
    }

    if (!stories.items.length) {
      setNote('', false);
      ui.list.innerHTML = `<div class="empty"><b>@${esc(stories.username)} has no active story.</b>
        <br>Stories expire after 24 hours.</div>`;
      return;
    }

    setNote(
      'Loaded without a seen receipt. ' +
        (canShareFiles()
          ? 'Save opens the share sheet — choose Save Image or Save Video to put it in Photos.'
          : 'Save downloads the file to your device.'),
      true
    );

    const stamp = (ms) => {
      const d = new Date(ms || Date.now());
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    };

    ui.list.innerHTML = stories.items
      .map((it, i) => {
        const when = it.takenAt
          ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
              new Date(it.takenAt)
            )
          : '';
        // preload="none" so opening the list does not pull every video at once.
        const media = it.isVideo
          ? `<video class="story-media" controls playsinline preload="none"${
              it.image ? ` poster="${esc(it.image)}"` : ''
            } src="${esc(it.video)}"></video>`
          : `<img class="story-media" loading="lazy" src="${esc(it.image)}" alt="">`;

        const url = it.isVideo ? it.video : it.image;
        const name = `${stories.username || 'story'}-${i + 1}-${stamp(it.takenAt)}.${
          it.isVideo ? 'mp4' : 'jpg'
        }`;
        // A plain link, not a scripted download. `download` is ignored for
        // cross-origin URLs, but the link still opens the raw media, where
        // iOS offers Add to Photos / Save to Files — and long-pressing the
        // link itself offers Download Linked File.
        const acts =
          `<div class="story-acts">` +
          `<button class="fill" data-save="${esc(url)}" data-name="${esc(name)}" data-type="${
            it.isVideo ? 'video/mp4' : 'image/jpeg'
          }">Save story</button>` +
          `</div>`;

        return (
          `<div class="story"><div class="story-head">` +
          `<span>${i + 1} of ${stories.items.length}</span>` +
          `<span>${esc(when)}${it.isVideo ? ' · video' : ''}</span></div>${media}${acts}</div>`
        );
      })
      .join('');
  }

  function render() {
    if (view === 'home') renderHome();
    else if (view === 'self') renderSelf();
    else if (view === 'stalk') renderStalk();
    else if (view === 'compare') renderCompare();
    else if (view === 'stories') renderStories();
    else renderMonitor();
  }

  function go(v) {
    view = v;
    ui.list.scrollTop = 0;
    render();
  }

  // --- actions ---------------------------------------------------------------

  function busy(on, stopId) {
    run.busy = on;
    const stop = root.querySelector('#stop');
    const others = root.querySelectorAll('.act:not(#stop), .big, #pick, #target');
    if (stop) stop.hidden = !on;
    for (const el of others) el.disabled = on;
    if (on) run.aborted = false;
  }

  function progress(p) {
    if (p.note) {
      setNote(p.note, true);
      return;
    }
    ui.list.innerHTML = `<div class="empty">Read <b>${nf.format(p.count)}</b>${
      p.expectedTotal ? ` of ${nf.format(p.expectedTotal)}` : ''
    }…<br>pass ${p.pass}<br><br>Keep this tab open.</div>`;
  }

  async function scanSelf(kind) {
    const pk = selfId();
    if (!pk) return setNote('Not logged in. Log into Instagram, reload, and try again.', true);
    busy(true);
    setNote('', false);
    try {
      const info = (await fetchUserInfo(pk)) || data.self.info;
      if (info) data.self.info = info;
      const expected = kind === 'followers' ? info && info.followers : info && info.following;
      const out = await walkList(kind, pk, expected, progress);
      data.self[kind] = out.users;
      data.self.at = Date.now();
      if (!save()) setNote('Ran out of storage — some results may not be saved.', true);
      selfMode = 'notback';
    } catch (e) {
      setNote(e && e.message ? e.message : String(e), true);
    } finally {
      busy(false);
      render();
    }
  }

  async function startStalk(input) {
    busy(true);
    setNote('', false);
    ui.list.innerHTML = '<div class="empty">Looking them up…</div>';
    try {
      const t = await resolveTarget(input);
      const expected = t.info && t.info.following;
      const out = await walkList('following', t.pk, expected, progress);
      if (!out.users.length) throw new Halt('No accounts returned — the list may be hidden.', 'empty');

      const r = ingest('following', t.pk, t.username, out.users, expected, out.reachedEnd && !out.aborted);
      monKey = `following:${t.pk}`;
      if (r.isFirst) {
        setNote(
          `Baseline saved — ${nf.format(r.total)} accounts. We'll keep an eye on them. Come back to Monitor to see who they add.`,
          true
        );
        go('monitor');
      } else {
        setNote(
          r.arrived
            ? `${nf.format(r.arrived)} new since the last check.`
            : 'Already watching them — nobody new.',
          true
        );
        go('monitor');
      }
    } catch (e) {
      setNote(e && e.message ? e.message : String(e), true);
      ui.list.innerHTML = '<div class="empty">Nothing saved.</div>';
    } finally {
      busy(false);
    }
  }

  async function checkNow() {
    const t = data.tracks[monKey];
    if (!t) return;
    busy(true);
    setNote('', false);
    try {
      const info = await fetchUserInfo(t.pk);
      const expected = info && info.following;
      if (info && info.username) t.username = info.username;
      const out = await walkList(t.kind, t.pk, expected, progress);
      if (!out.users.length) throw new Halt('No accounts returned — the list may be hidden.', 'empty');

      const r = ingest(t.kind, t.pk, t.username, out.users, expected, out.reachedEnd && !out.aborted);
      const bits = [r.arrived ? `${nf.format(r.arrived)} new.` : 'Nobody new.'];
      if (r.absorbed) {
        bits.push(`${nf.format(r.absorbed)} were missed by an earlier scan — added to the baseline, not counted as new.`);
      }
      if (r.departed) bits.push(`${nf.format(r.departed)} no longer followed.`);
      render();
      setNote(bits.join(' '), true);
    } catch (e) {
      setNote(e && e.message ? e.message : String(e), true);
      render();
    } finally {
      busy(false);
    }
  }

  // Fetched media, kept so a retry does not re-download it.
  const blobCache = new Map();

  /**
   * Whether the browser can hand a file to the OS share sheet. True on iOS
   * Safari, generally false on Firefox Android — which is fine, because that
   * falls back to a plain download. Only the wording needs to differ.
   */
  let shareFilesSupported = null;
  function canShareFiles() {
    if (shareFilesSupported !== null) return shareFilesSupported;
    try {
      const probe = new File([new Blob(['x'])], 'x.jpg', { type: 'image/jpeg' });
      shareFilesSupported = !!(navigator.canShare && navigator.canShare({ files: [probe] }));
    } catch (_) {
      shareFilesSupported = false;
    }
    return shareFilesSupported;
  }

  /**
   * Saves a story photo or video to the device.
   *
   * The only route on iOS that reaches Photos is the native share sheet with
   * the file attached — `<a download>` is ignored cross-origin, and opening the
   * raw URL just plays the video with no way to keep it.
   *
   * navigator.share() must be called inside a user gesture, and awaiting the
   * fetch spends it. So when the gesture has expired the blob is kept and the
   * button asks for a second tap, which shares immediately with a fresh one.
   */
  async function saveMedia(btn, url, name, type) {
    const reset = (t, ms) => {
      btn.textContent = t;
      if (ms) setTimeout(() => (btn.textContent = 'Save story'), ms);
    };

    // A previous attempt could not fetch the media, so this tap opens it
    // instead. Done synchronously, inside the gesture, or iOS blocks it.
    if (btn.dataset.fallback) {
      window.open(url, '_blank', 'noopener');
      return;
    }

    try {
      let blob = blobCache.get(url);
      if (!blob) {
        reset('Fetching…');
        // Signed CDN URLs need no cookies, and omitting them avoids a
        // credentialed cross-origin request being rejected outright.
        const res = await nativeFetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error('http ' + res.status);
        blob = await res.blob();
        blobCache.set(url, blob);
      }

      const file = new File([blob], name, { type: blob.type || type });
      if (canShareFiles() && navigator.canShare({ files: [file] })) {
        reset('Save');
        await navigator.share({ files: [file] });
        reset('Saved', 1600);
        return;
      }

      // Desktop and anything without file sharing: a blob URL is same-origin,
      // so the download attribute works here even though it would not on the
      // CDN URL.
      const obj = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = obj;
      a.download = name;
      root.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 30000);
      reset('Saved', 1600);
    } catch (e) {
      const n = e && e.name;
      if (n === 'AbortError') return reset('Save story'); // share sheet dismissed
      if (blobCache.has(url)) return reset('Tap again'); // gesture expired, file is ready
      // Usually CORS on the CDN. Arm the fallback so the next tap opens the
      // media directly, where iOS can still save it by hand.
      btn.dataset.fallback = '1';
      reset('Open it instead');
    }
  }

  async function loadStory(input) {
    busy(true);
    setNote('', false);
    ui.list.innerHTML = '<div class="empty">Looking them up…</div>';
    try {
      const t = await resolveTarget(input);
      const json = await apiGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(t.pk)}`);
      const reel = parseReel(json, String(t.pk));
      stories = { username: (reel && reel.username) || t.username, items: (reel && reel.items) || [] };
    } catch (e) {
      stories = null;
      setNote(e && e.message ? e.message : String(e), true);
      ui.list.innerHTML = '<div class="empty">Nothing loaded.</div>';
      busy(false);
      return;
    }
    busy(false);
    render();
  }

  // --- events ----------------------------------------------------------------

  // --- draggable button ------------------------------------------------------

  const FAB_KEY = 'sth.mobile.fab';
  const FAB_SIZE = 56;
  let fabMoved = false;

  function placeFab() {
    let pos = null;
    try {
      pos = JSON.parse(localStorage.getItem(FAB_KEY) || 'null');
    } catch (_) {}
    if (!pos) return; // never dragged — leave the CSS default in place
    // Clamp on every placement, so rotating the device or a browser chrome
    // change cannot strand the button off-screen.
    const m = 6;
    const x = Math.min(Math.max(pos.x, m), Math.max(m, innerWidth - FAB_SIZE - m));
    const y = Math.min(Math.max(pos.y, m), Math.max(m, innerHeight - FAB_SIZE - m));
    ui.fab.style.left = `${x}px`;
    ui.fab.style.top = `${y}px`;
    ui.fab.style.right = 'auto';
    ui.fab.style.bottom = 'auto';
  }

  let drag = null;
  ui.fab.addEventListener('pointerdown', (e) => {
    const r = ui.fab.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY };
    fabMoved = false;
    try {
      ui.fab.setPointerCapture(e.pointerId);
    } catch (_) {}
  });

  ui.fab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // A few pixels of slop, so a normal tap is never read as a drag.
    if (!fabMoved && Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 8) return;
    fabMoved = true;
    ui.fab.classList.add('dragging');
    const m = 6;
    const x = Math.min(Math.max(e.clientX - drag.dx, m), innerWidth - FAB_SIZE - m);
    const y = Math.min(Math.max(e.clientY - drag.dy, m), innerHeight - FAB_SIZE - m);
    ui.fab.style.left = `${x}px`;
    ui.fab.style.top = `${y}px`;
    ui.fab.style.right = 'auto';
    ui.fab.style.bottom = 'auto';
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    ui.fab.classList.remove('dragging');
    if (!fabMoved) return;
    try {
      const r = ui.fab.getBoundingClientRect();
      localStorage.setItem(FAB_KEY, JSON.stringify({ x: r.left, y: r.top }));
    } catch (_) {}
  };
  ui.fab.addEventListener('pointerup', endDrag);
  ui.fab.addEventListener('pointercancel', endDrag);

  ui.fab.addEventListener('click', (e) => {
    // A drag ends with a click too; that one must not open the sheet.
    if (fabMoved) {
      fabMoved = false;
      e.stopPropagation();
      return;
    }
    ui.sheet.hidden = false;
    render();
  });

  addEventListener('resize', placeFab);
  addEventListener('orientationchange', placeFab);
  ui.close.addEventListener('click', () => {
    ui.sheet.hidden = true;
  });
  ui.back.addEventListener('click', () => go('home'));

  root.addEventListener('click', (e) => {
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) return go(goBtn.dataset.go);

    const tab = e.target.closest('.tab');
    if (tab) {
      if (tab.dataset.c) cmpMode = tab.dataset.c;
      else selfMode = tab.dataset.m;
      ui.list.scrollTop = 0;
      return render();
    }

    const sv = e.target.closest('[data-save]');
    if (sv) return saveMedia(sv, sv.dataset.save, sv.dataset.name, sv.dataset.type);

    const id = e.target.id;
    if (id === 'scan') {
      const s = data.self;
      const following = s.following || [];
      const tagged = following.filter((u) => u.followsYou != null);
      const direct = following.length && tagged.length / following.length >= 0.9;
      return scanSelf(following.length && !direct && !s.followers ? 'followers' : 'following');
    }
    if (id === 'start') return startStalk(root.querySelector('#target').value);
    if (id === 'loadStory') return loadStory(root.querySelector('#storyUser').value);
    if (id === 'check') return checkNow();
    if (id === 'stop') {
      run.aborted = true;
      return;
    }
    if (id === 'del') {
      const t = data.tracks[monKey];
      if (!t) return;
      if (e.target.dataset.armed) {
        delete data.tracks[monKey];
        monKey = null;
        save();
        return render();
      }
      e.target.dataset.armed = '1';
      e.target.textContent = 'Sure?';
      setTimeout(() => {
        delete e.target.dataset.armed;
        e.target.textContent = '✕';
      }, 3000);
    }
  });

  root.addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'pick') monKey = e.target.value;
    else if (id === 'cA') cmpA = e.target.value;
    else if (id === 'cB') cmpB = e.target.value;
    else return;
    ui.list.scrollTop = 0;
    render();
  });

  /**
   * Keep our keystrokes inside the panel.
   *
   * Instagram binds single letters to page shortcuts, and such handlers decide
   * "is the user typing?" by looking at document.activeElement. Shadow DOM
   * retargets that to the host element, so the page sees focus on a plain div,
   * treats the keypress as a shortcut and calls preventDefault() — which ate
   * specific letters as they were typed into our inputs.
   *
   * stopPropagation does not affect other listeners on this same node, so the
   * Enter handler below still runs.
   */
  for (const type of ['keydown', 'keypress', 'keyup']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'target') startStalk(e.target.value);
    else if (e.target.id === 'storyUser') loadStory(e.target.value);
  });

  // A scan lost to a reload means starting over, so make it deliberate.
  window.addEventListener('beforeunload', (e) => {
    if (!run.busy) return;
    e.preventDefault();
    e.returnValue = '';
  });

  function mount() {
    if (!document.body || document.getElementById('sth-host')) return;
    document.body.appendChild(host);
    placeFab();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
  // Instagram is a single-page app and re-renders the body on navigation.
  setInterval(mount, 3000);
})();

