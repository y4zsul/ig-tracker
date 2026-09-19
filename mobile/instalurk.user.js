// ==UserScript==
// @name         InstaLurk
// @namespace    https://github.com/y4zsul/ig-tracker
// @version      2.5.0
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
// script-src CSP that blocks exactly that â€” silently, with no error the user
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
 *   1. My account â€” who you follow that doesn't follow you back.
 *   2. New stalk  â€” baseline capture of anyone's following list.
 *   3. Monitor    â€” who they have added since, dated to when you checked.
 *
 * Instagram publishes no follow timestamps and serves these lists in ranked
 * order, so a single capture is NEVER chronological. Chronology only comes
 * from comparing captures over time, and the UI is written to never imply
 * otherwise.
 */

(() => {
  'use strict';

  // These three identifiers keep their old names on purpose, despite the
  // rename to InstaLurk:
  //   - the guard stops TWO copies running if someone still has the old script
  //     installed alongside this one, which the rename makes likely
  //   - STORE_KEY holds saved baselines, and a baseline cannot be recreated
  //     retroactively, so changing it would silently destroy people's history
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
      throw new Halt('Not authorised. Make sure you are logged in, then reload.', 'auth');
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
   * topsearch is the working route. It is FUZZY â€” a query for "jane" happily
   * returns "janedoe123" â€” so only an exact username match counts.
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
  // and never sends that POST â€” there is no "anonymous" flag, just an omitted
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
   * /followers/, so nothing assumes a format â€” the cursor only has to change
   * and not repeat. A SHORT page is normal and must not end the walk.
   */
  /**
   * Same verdict rule as headScanVerdict() in src/interceptor.js. Kept in step
   * by hand, because a userscript cannot import and this file ships alone.
   */
  function headScanVerdict(s) {
    if (s.unknownsFound < s.expectedNew) {
      return s.depth >= s.ceilRows ? 'escalate' : 'continue';
    }
    if (s.depth < s.floorRows) return 'continue';
    return s.depthSinceLastUnknown >= s.quietDepth ? 'satisfied' : 'continue';
  }

  async function walkList(kind, pk, expectedTotal, onProgress, scan) {
    const pageSize = kind === 'followers' ? 25 : 200;
    const baseDelay = kind === 'followers' ? 700 : 900;
    // A backstop, not a target. The loop exits on diminishing returns long
    // before this; recovering the last stragglers is the job of the next
    // check, which sees a properly different shuffle.
    const maxPasses = 6;

    // --- overlapping windows ----------------------------------------------
    //
    // /following/ pages by POSITIONAL OFFSET over a ranking Instagram
    // recomputes for every request. Walking it with back-to-back windows â€”
    // [0,200), [200,400) â€” loses people structurally: an account at position
    // 250 when the first window is served, which drifts to 150 before the
    // second request goes out, was behind the boundary when it passed and in
    // front of it afterwards, so it is never returned. Re-walking cannot fix
    // that, because every re-walk rebuilds the boundaries in the same places.
    //
    // So overlap them. Ask for a full page every STRIDE positions and an
    // account has to move more than (pageSize - stride) places between two
    // consecutive requests to slip through both. The ratio changes per pass so
    // the seams that remain land somewhere different each time.
    const strideFor = (p) => {
      const ratios = [0.5, 0.35, 0.6, 0.4];
      return Math.max(10, Math.round(pageSize * ratios[p % ratios.length]));
    };

    const union = new Map();
    let pass = 0;
    let quiet = 0;
    let lastSize = -1;
    let tokenCursor = false;
    let rateRetries = 0;
    let reachedEnd = false;
    // Once the server shows it won't honour an offset it did not hand out,
    // that holds for the rest of the capture.
    let slidingOff = false;

    // --- head scan -----------------------------------------------------------
    // A re-check of a settled watch reads the top of the list until the
    // profile's own count is accounted for, rather than walking the whole
    // thing. One early exit layered on the ordinary walk: if it never fires, or
    // escalates, this behaves exactly as a full capture.
    const knownPks =
      scan && scan.mode === 'head' && scan.knownPks && scan.knownPks.length
        ? new Set(scan.knownPks)
        : null;
    // No reported count means no oracle to stop against, so nothing to scan
    // against either.
    let headMode = !!(knownPks && expectedTotal != null && scan.prevCount != null);
    const expectedNew = headMode ? Math.max(0, expectedTotal - scan.prevCount) : 0;
    let unknownsFound = 0;
    let deepestNewDepth = 0;

    while (pass < maxPasses) {
      let cursor = null;
      const seen = new Set();
      let emptyStreak = 0;
      let prevPagePks = null;
      let stallStreak = 0;

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
                note: `Rate limited. Waiting ${Math.ceil((until - Date.now()) / 1000)}s. Keep this tab open.`,
              });
              await sleep(1000);
            }
            continue;
          }
          throw e;
        }

        if (json && json.special_empty_state && (!json.users || !json.users.length)) {
          if (union.size) break;
          throw new Halt("Instagram won't show this list. It may be private or restricted.", 'restricted');
        }
        if (!json || !Array.isArray(json.users)) throw new Halt('Unexpected response shape.', 'parse');

        let newHere = 0;
        for (const raw of json.users) {
          const u = shapeUser(raw);
          if (u.pk && !union.has(u.pk)) {
            union.set(u.pk, u);
            if (headMode && !knownPks.has(u.pk)) newHere++;
          }
        }
        onProgress({ count: union.size, pass: pass + 1, expectedTotal, head: headMode });

        if (headMode) {
          if (newHere) {
            unknownsFound += newHere;
            // Depth is distinct accounts seen, not rows served: overlapping
            // windows serve most positions twice.
            deepestNewDepth = union.size;
          }
          const verdict = headScanVerdict({
            depth: union.size,
            depthSinceLastUnknown: union.size - deepestNewDepth,
            unknownsFound,
            expectedNew,
            floorRows: scan.floorRows,
            ceilRows: scan.ceilRows,
            quietDepth: scan.quietDepth,
          });
          if (verdict === 'satisfied') {
            return {
              users: [...union.values()],
              aborted: false,
              reachedEnd: false,
              scope: 'head',
              headDepth: union.size,
              deepestNewDepth,
            };
          }
          if (verdict === 'escalate') headMode = false;
        }

        const next = json.next_max_id != null ? String(json.next_max_id) : null;
        // An empty page is NOT the end. Offset paging over a list Instagram is
        // re-ranking underneath us can return a window where everyone shifted
        // out, while the list continues well past it. Stopping on the first
        // empty page silently truncated the walk.
        emptyStreak = json.users.length ? 0 : emptyStreak + 1;
        if (!next || emptyStreak >= 3) {
          reachedEnd = true;
          // Ran out of list, so this is a whole walk however it started.
          headMode = false;
          break;
        }
        const curOff = Number(cursor || 0);
        // All digits does NOT mean positional offset. /followers/ hands back
        // opaque tokens, some of them long runs of digits, and sliding one of
        // those sends Instagram a cursor it never issued. A real offset is a
        // row position, so it advances by at most the page size just asked
        // for; an opaque token jumps by an arbitrary amount. That is the test.
        const nextNum = Number(next);
        const jump = nextNum - curOff;
        const offsetLike =
          /^\d+$/.test(next) &&
          /^\d*$/.test(String(cursor || '')) &&
          Number.isSafeInteger(nextNum) &&
          jump > 0 &&
          jump <= pageSize;
        let advanceTo = next;

        if (offsetLike && !slidingOff) {
          // Overlap the next window with the one just served, clamped to the
          // server's own next offset so a short list is never overshot. The
          // first step is a HALF stride: sliding gives every position two looks
          // except the first `stride` of them, because there is no earlier
          // window to overlap with, and those are the most recent follows.
          const stride = strideFor(pass);
          const advance = cursor == null ? Math.max(1, Math.round(stride / 2)) : stride;
          advanceTo = String(Math.min(Math.max(curOff + 1, curOff + advance), nextNum));

          // If Instagram ever ignores an offset it did not itself hand out it
          // answers with the window it wanted to send, so the page comes back a
          // near-copy of the one before. Two of those and we stop sliding.
          const pks = json.users.map((r) => String((r && (r.pk != null ? r.pk : r.pk_id != null ? r.pk_id : r.id)) || '')).filter(Boolean);
          if (prevPagePks && pks.length && prevPagePks.length) {
            const before = new Set(prevPagePks);
            let same = 0;
            for (const p of pks) if (before.has(p)) same++;
            const repeat = same >= pks.length * 0.9 && pks.length >= prevPagePks.length * 0.9;
            stallStreak = repeat ? stallStreak + 1 : 0;
            if (stallStreak >= 2) {
              slidingOff = true;
              advanceTo = next;
            }
          }
          prevPagePks = pks;
        } else if (!Number.isFinite(Number(next))) {
          tokenCursor = true;
        }

        if (advanceTo === cursor || seen.has(advanceTo)) break;
        const bothNumeric = Number.isFinite(Number(advanceTo)) && Number.isFinite(Number(cursor || 0));
        if (bothNumeric && Number(advanceTo) <= Number(cursor || 0)) break;

        seen.add(advanceTo);
        cursor = advanceTo;
        await sleep(baseDelay + Math.random() * baseDelay * 0.5);
      }

      pass++;
      const marginal = lastSize < 0 ? Infinity : union.size - lastSize;
      lastSize = union.size;

      const known = expectedTotal != null && expectedTotal > 0;

      // Re-walking has sharply diminishing returns inside one session: the
      // ranking only shuffles a little over a few minutes, so each extra pass
      // recovers less than the last and that tail is most of the wait. A pass
      // that turns up one straggler out of two hundred missing is not worth
      // another full walk. The next check sees a properly different shuffle
      // and folds what it finds into the baseline rather than dating it.
      // The bar scales with what a pass costs: followers is capped at 25 rows
      // a page against 200 for following, so that walk is eight times the
      // requests for the same list and should give up on stragglers sooner.
      //
      // That only holds once the capture is basically there. While it is still
      // MATERIALLY short, "this pass found almost nobody" is not a reason to
      // stop; it is a reason to run the next pass, which uses a different
      // stride and looks between the seams this one could not. So the bar drops
      // to zero while a chunk of the list is still missing.
      const shortfall = known ? (expectedTotal - union.size) / expectedTotal : 0;
      const materiallyShort = shortfall > 0.01;
      const rate = materiallyShort ? 0 : pageSize >= 100 ? 0.002 : 0.01;
      const negligible = rate === 0 ? 0 : known ? Math.max(1, Math.round(expectedTotal * rate)) : 1;
      quiet = marginal <= negligible ? quiet + 1 : 0;

      // This used to sit at 2%, matching the tolerance the diffing side uses to
      // call a capture full â€” which quietly made 2% a TARGET, so a 1,100-follow
      // list reliably finished twenty people short and handed those twenty to
      // the next check as "new". Deactivated accounts are counted in the
      // reported total and never listed, so some slack is unavoidable, but half
      // a per cent covers that.
      //
      // Reaching the reported count is the only self-evident finish. Short of
      // it, a near-complete FIRST pass is one look at a list that moves while
      // you read it, so anything inside the tolerance still earns a second
      // pass â€” and that pass is where the last handful comes from.
      const tolerance = known ? Math.max(1, expectedTotal * 0.005) : 0;
      const effectivelyComplete =
        known && union.size >= expectedTotal - (pass >= 2 ? tolerance : 0);
      if (effectivelyComplete) break;

      // One quiet pass used to be enough for an opaque cursor, on the reasoning
      // that a record-anchored cursor cannot skip anyone. Followers lists come
      // up short the same way following lists do, and an opaque cursor is not
      // evidence of being record-anchored, so a short list earns a second pass
      // whatever the cursor type.
      // With no reported count there is nothing that can call a capture
      // complete, so an unknown total earns the same second pass a known-short
      // one does rather than stopping on a single quiet walk.
      const short = known && !effectivelyComplete;
      if (quiet >= (!known || short ? 2 : 1)) break;
      if (pass < maxPasses) await sleep(1500);
    }

    return {
      users: [...union.values()],
      aborted: false,
      reachedEnd,
      scope: 'full',
      headDepth: null,
      deepestNewDepth: null,
    };
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
      if (d && d.v === 2) {
        // Decide `settled` for watches created before it existed, on the same
        // evidence the live rule uses: a capture that came back essentially
        // complete, or two consecutive captures that agreed on the size of the
        // list. Without this every existing watch would read as unsettled and
        // hide arrival history people have already collected.
        for (const t of Object.values(d.tracks || {})) {
          if (typeof t.settled === 'boolean') continue;
          const s = t.snapshots || [];
          t.settled =
            s.some((x) => x.full === true) ||
            (s.length >= 2 && s[s.length - 1].count === s[s.length - 2].count);
        }
        return d;
      }
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
  /** Did this capture see everything it needed to? Matches src/background.js. */
  function snapshotReliable(s) {
    if (!s) return false;
    if (typeof s.reliable === 'boolean') return s.reliable;
    return s.full === true && s.complete === true;
  }

  function ingest(kind, pk, username, users, expectedTotal, complete, walk) {
    const key = `${kind}:${pk}`;
    const at = Date.now();
    let t = data.tracks[key];
    const isFirst = !t;
    if (!t) {
      t = { kind, pk, username, snapshots: [], accounts: {} };
      data.tracks[key] = t;
    }
    if (username) t.username = username;

    // A head scan read only the top of the list, so it can say nothing about
    // the tail: no departures, and no settling a baseline on it.
    const headScan = !!(walk && walk.scope === 'head');

    const prev = t.snapshots.length ? t.snapshots[t.snapshots.length - 1] : null;
    const arrivalsTrustworthy = snapshotReliable(prev);
    // How far down the previous capture looked. An account above that line
    // that was not recorded then is one that scan read past and did not find.
    const prevDepth = !prev ? 0 : prev.scope === 'head' ? prev.headDepth || 0 : Infinity;

    const seen = new Set();
    const fresh = [];
    const freshRank = Object.create(null);
    let rank = 0;
    for (const u of users) {
      if (!u.pk) continue;
      rank++;
      seen.add(u.pk);
      const acc = t.accounts[u.pk];
      if (!acc) {
        t.accounts[u.pk] = packAccount(u, at, isFirst, isFirst ? null : arrivalsTrustworthy);
        fresh.push(u.pk);
        freshRank[u.pk] = rank;
      } else {
        acc.g = null;
        if (u.username) acc.u = u.username;
        if (u.fullName) acc.n = u.fullName;
      }
    }

    let departed = 0;
    if (complete && !headScan && !isFirst) {
      for (const p of Object.keys(t.accounts)) {
        if (!seen.has(p) && !t.accounts[p].g) {
          t.accounts[p].g = at;
          departed++;
        }
      }
    }

    const drift = expectedTotal != null ? expectedTotal - users.length : null;
    // Half a per cent, not two. Two per cent of a 1,100-follow list is
    // twenty-two people, and calling a capture that missed twenty-two people
    // "full" settles the baseline on it, which dates those twenty-two as new
    // follows the next time they turn up. Must stay in step with the walk's own
    // tolerance in walkList().
    //
    // A head scan did not measure this at all, so it records null rather than a
    // false that the next capture would read as "the last one came up short".
    const full =
      headScan || drift == null ? null : Math.abs(drift) <= Math.max(1, expectedTotal * 0.005);

    let arrived = fresh.length;
    let absorbed = 0;

    const absorb = (pks) => {
      for (const p of pks) {
        const a = t.accounts[p];
        if (!a || a.b) continue;
        a.b = 1;
        a.c = null;
        absorbed++;
        arrived--;
      }
      if (arrived < 0) arrived = 0;
    };
    const absorbAll = () => absorb(fresh);

    // Nothing is dated until the baseline stops growing. Until the walk has
    // demonstrably converged, a first sighting is far more likely to be the
    // collector finally catching someone than a real new follow, and dating
    // those is what produced batches of "new follows" that were never new.
    // Settles when a capture comes back essentially complete, or when a
    // capture that reached the end finds nobody new, which is what
    // convergence looks like on a list that plateaus below its reported count.
    const wasSettled = t.settled === true;

    const prevExpected = prev ? prev.expectedTotal : null;
    const expectedDelta =
      prevExpected != null && expectedTotal != null ? expectedTotal - prevExpected : null;
    const plausibleNew = expectedDelta == null ? null : Math.max(0, expectedDelta + departed);

    if (!isFirst && !wasSettled && fresh.length) {
      absorbAll();
    } else if (wasSettled && headScan && fresh.length) {
      // A head scan never learns `departed`, so the count alone is not enough:
      // an account that follows two and unfollows two shows a flat count every
      // check, and a count-only rule would absorb every real new follow and
      // report "nobody new" forever.
      //
      // Depth is the better evidence. The previous scan read down to
      // `prevDepth`; an account above that line now, absent then, is one that
      // scan looked straight at and did not find. Below it nobody has looked,
      // so a first sighting there is indistinguishable from a recovered miss.
      const dated = [];
      const unseen = [];
      for (const p of fresh) (freshRank[p] <= prevDepth ? dated : unseen).push(p);
      absorb(unseen);
      if (dated.length && plausibleNew != null && dated.length > Math.max(2, plausibleNew * 2)) {
        for (const p of dated) t.accounts[p].c = 0;
      }
    } else if (wasSettled) {
      // The strongest tell that an "arrival" is a recovered miss: the profile's
      // own count did not rise enough to account for it. If they followed
      // nobody, anybody newly visible was there all along.
      if (plausibleNew === 0 && fresh.length) absorbAll();
      else if (plausibleNew != null && arrived > plausibleNew) {
        // Some are real and some are recovered misses, with no way to tell
        // which. When most of the batch cannot be real, dating it is the worse
        // error by a wide margin â€” fifty rows stamped with today, of which at
        // most three happened today. Losing three real dates beats inventing
        // forty-seven, so a majority-recovery batch goes into the baseline.
        if (plausibleNew * 2 < arrived) absorbAll();
        else for (const p of fresh) t.accounts[p].c = 0;
      }
    }

    // Only a walk that reached the end can prove a baseline whole, so a head
    // scan never settles one. It is only ever run against a settled watch, so
    // this never leaves anything stuck.
    if (!t.settled && complete && !headScan && (full === true || (!isFirst && fresh.length === 0))) {
      t.settled = true;
    }

    t.snapshots.push({
      at,
      count: users.length,
      expectedTotal,
      complete: complete && !headScan,
      full,
      scope: headScan ? 'head' : 'full',
      headDepth: headScan && walk ? walk.headDepth : null,
      deepestNewDepth: walk ? walk.deepestNewDepth : null,
      reliable: headScan ? true : complete && full === true,
    });
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

      /* Same token set as the desktop side panel, so the two look like one
         product. Declared after the reset above: an "all: initial" would wipe
         custom properties declared before it.
         (No backticks anywhere in this block: it is a JS template literal.)

         Dark only, like the desktop panel. Frosted glass needs a dark,
         saturated ground to read, so there is no light variant to fall back
         to and the prefers-color-scheme override is gone. */
      :host {
        color-scheme: dark;
        --bg: #241528;
        --bg2: rgba(0,0,0,.24);          /* recessed: inputs */
        --surface: rgba(255,255,255,.10); /* the glass */
        --surface2: rgba(255,255,255,.055);
        --solid: rgba(36,18,42,.55);      /* opaque-ish: list rows */
        --fg: #ffffff;
        --muted: rgba(255,255,255,.66);
        --line: rgba(255,255,255,.30);    /* the rim */
        --line-soft: rgba(255,255,255,.12);
        --accent: #ff7ab8;
        --accent2: #ff9ecb;
        --accent-soft: rgba(255,255,255,.16);
        --r: 16px;
        --r-lg: 22px;
        --pill: 999px;
        --blur: blur(20px) saturate(150%);
        --shadow: 0 4px 12px rgba(10,2,9,.4);
        /* Rounded display face where the platform has one (SF Rounded covers
           every iPhone); Android falls through to its own UI face. */
        --display: ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
      }

      * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }

      .fab {
        position: fixed; right: 14px;
        /* A default only. Browser chrome sits in different places on iOS
           Safari and Firefox Android, and Instagram's own nav moves too, so
           rather than guess at every combination the button is draggable and
           remembers where it was put. */
        bottom: calc(104px + env(safe-area-inset-bottom, 0px));
        z-index: 2147483000;
        width: 58px; height: 58px; border-radius: 50%;
        border: 3px solid rgba(255,255,255,.75);
        background: linear-gradient(135deg, #ffb6dc, #ff7ab8 55%, #ff5fa8);
        color: #fff; font-size: 24px;
        box-shadow: 0 8px 24px rgba(255, 90, 170, .5), 0 2px 8px rgba(10,2,9,.4);
        cursor: pointer;
        touch-action: none; /* a drag must not scroll the page underneath */
      }
      .fab:active { transform: scale(.94); }
      .fab.dragging { opacity: .9; transform: scale(1.06); }

      /* The colour fields the glass feeds on: backdrop-filter blurs what is
         BEHIND an element, so over a flat ground it renders as grey mud.
         Radial gradients rather than blurred divs, which costs nothing. */
      .sheet {
        position: fixed; inset: 0; z-index: 2147483001;
        display: flex; flex-direction: column;
        background-color: var(--bg); color: var(--fg);
        background-image:
          radial-gradient(58% 26% at 6% 2%, rgba(255,95,168,.85) 0%, transparent 60%),
          radial-gradient(52% 22% at 98% 18%, rgba(255,168,212,.6) 0%, transparent 62%),
          radial-gradient(58% 26% at 22% 99%, rgba(255,143,196,.5) 0%, transparent 60%);
        padding-top: env(safe-area-inset-top, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      .sheet[hidden] { display: none; }

      header {
        padding: 18px 58px 14px 16px;
        position: relative;
        /* The close/back buttons are absolutely positioned and out of flow, so
           the header has to reserve their height itself. Without this it
           collapses on views with no subtitle and the first control rides up
           underneath them. */
        min-height: 66px;
      }
      h1 {
        margin: 0 0 4px; font-family: var(--display);
        font-size: 22px; font-weight: 800; letter-spacing: -.025em;
        color: #fff; text-shadow: 0 2px 14px rgba(255,90,170,.55);
      }
      /* Holds a line even when empty, so the header is the same height on
         every view and the content below does not jump around. */
      .sub { font-size: 12px; line-height: 15px; min-height: 15px; color: var(--muted); }
      .x, .bk {
        position: absolute; top: 14px;
        /* Both sit BEFORE <header> in the DOM, and header is position:relative.
           Without a z-index the header paints over them, so they stay visible
           but swallow every tap. */
        z-index: 3;
        width: 38px; height: 38px; border-radius: 50%;
        border: 1px solid var(--line);
        background: var(--accent-soft); color: #fff;
        font-size: 18px; font-weight: 700; cursor: pointer;
      }
      .x { right: 12px; }
      .bk { left: 12px; }
      header.hasback { padding-left: 58px; }

      .pad { padding: 0 14px 12px; }
      .rowf { display: flex; gap: 8px; }
      button.act {
        flex: 1; padding: 14px; font-family: var(--display);
        font-size: 15px; font-weight: 700;
        border-radius: var(--pill); border: none; cursor: pointer;
        background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff;
        box-shadow: 0 6px 18px rgba(255,90,170,.38), var(--shadow);
      }
      button.act.ghost {
        background: var(--surface); color: #fff;
        -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
        border: 1px solid var(--line); font-weight: 700; box-shadow: var(--shadow);
      }
      button.act:disabled { opacity: .5; }

      /* Home menu: chunky glass slabs holding a title and its one-line note. */
      button.big {
        display: flex; align-items: center;
        width: 100%; padding: 16px 18px; margin-bottom: 11px;
        text-align: left;
        border-radius: var(--r-lg); border: 1px solid var(--line); cursor: pointer;
        background: var(--surface2); color: inherit;
        -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        box-shadow: var(--shadow);
      }
      button.big:last-child { margin-bottom: 0; }
      button.big .lab { flex: 1 1 auto; min-width: 0; }
      button.big b { display: block; font-family: var(--display); font-size: 16.5px; font-weight: 800; letter-spacing: -.01em; }
      button.big em { display: block; font-style: normal; font-size: 12px; font-weight: 500; opacity: .72; margin-top: 3px; }
      button.big.p {
        background: linear-gradient(135deg, var(--accent), var(--accent2));
        color: #fff; border: 1px solid rgba(255,255,255,.5);
        box-shadow: 0 10px 26px rgba(255,90,170,.4), var(--shadow);
      }
      button.big.p em { opacity: .88; }

      input, select {
        width: 100%; padding: 13px 15px; font-size: 16px;
        border-radius: var(--pill); border: 1px solid var(--line);
        background: var(--bg2); color: inherit;
      }
      /* Solid, not translucent: the native picker paints its own popup and a
         see-through control is unreadable over a bright field. */
      select { background: #3a2440; }
      input::placeholder { color: var(--muted); }

      .note {
        margin: 0 14px 10px; padding: 10px 13px; font-size: 11.5px; line-height: 1.5;
        border-radius: var(--r); background: var(--surface2);
        -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
        border: 1px solid var(--line-soft); color: rgba(255,255,255,.72);
      }
      .note[hidden] { display: none; }

      .tabs { display: flex; gap: 6px; padding: 0 14px 10px; }
      .tab {
        flex: 1; padding: 10px 6px; font-size: 12px; font-weight: 700;
        border-radius: var(--pill); border: 1px solid var(--line);
        background: var(--surface); color: inherit; cursor: pointer;
        box-shadow: var(--shadow);
      }
      .tab[aria-selected="true"] {
        background: linear-gradient(135deg, var(--accent), var(--accent2));
        border-color: rgba(255,255,255,.5); color: #fff;
      }

      .list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 14px 28px; }
      /* No backdrop-filter here. Mobile renders every row rather than
         virtualising, so a filtered layer per card would be hundreds of them.
         A semi-opaque fill instead, dark enough that the densest text in the
         app stays readable wherever a bright field sits behind it. */
      .card {
        display: flex; align-items: center; gap: 10px; padding: 12px 14px;
        margin-bottom: 8px; border: 1px solid var(--line-soft); border-radius: var(--r);
        background: var(--solid);
      }
      .who { flex: 1; min-width: 0; }
      .u { display: block; font-weight: 700; font-size: 15px; color: inherit; text-decoration: none;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .n { display: block; font-size: 12px; color: var(--muted);
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .go {
        flex: 0 0 auto; font-size: 11.5px; font-weight: 700; text-decoration: none;
        color: #ffd3e8; background: rgba(255,122,184,.24);
        padding: 6px 12px; border-radius: var(--pill);
      }
      /* Neutral, not amber: "unverified" is a caveat about how the list was
         collected, not a warning about the account. */
      .flag { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em;
              padding: 4px 7px; border-radius: var(--pill);
              border: 1px solid var(--line-soft); color: rgba(255,255,255,.78);
              background: rgba(255,255,255,.1); }

      .ghead { display: flex; justify-content: space-between; align-items: center;
               gap: 8px; padding: 16px 4px 6px; }
      .gtime { font-family: var(--display); font-weight: 800; font-size: 13.5px; letter-spacing: -.01em; }
      .gcount { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
                color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent2));
                padding: 5px 10px; border-radius: var(--pill);
                box-shadow: 0 3px 10px rgba(255,90,170,.35); }
      .ghead-note {
        margin: 0 0 8px; padding: 8px 12px; font-size: 10.5px; line-height: 1.45;
        color: rgba(255,255,255,.82); background: rgba(255,255,255,.09);
        border: 1px solid rgba(255,255,255,.24); border-radius: var(--r);
      }
      .gfoot {
        margin: 18px 0 0; padding: 12px 14px; font-size: 11px; line-height: 1.55;
        color: var(--muted); background: var(--surface2);
        -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
        border: 1px solid var(--line-soft); border-radius: var(--r);
      }

      .empty {
        margin: 4px 0; padding: 34px 22px; text-align: center;
        color: var(--muted); font-size: 13.5px; line-height: 1.6;
        background: var(--surface);
        -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
        border: 1px solid var(--line); border-radius: var(--r-lg);
        box-shadow: var(--shadow);
      }
      .empty b { color: #fff; }

      .stat { display: flex; gap: 8px; padding: 0 14px 12px; }
      .stat div {
        flex: 1; text-align: center; padding: 11px 6px;
        border: 1px solid var(--line-soft); border-radius: var(--r);
        background: var(--surface2);
        -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
        font-size: 10.5px; color: var(--muted);
      }
      .stat b {
        display: block; font-family: var(--display);
        font-size: 19px; font-weight: 800; color: #fff;
      }

      .story {
        margin-bottom: 10px; border: 1px solid var(--line); border-radius: var(--r-lg);
        background: var(--surface);
        -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
        box-shadow: var(--shadow); overflow: hidden;
      }
      .story-head {
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
        padding: 9px 13px; font-size: 11px; color: var(--muted);
      }
      .story-media {
        display: block; width: 100%; height: auto;
        max-height: 68vh; object-fit: contain; background: #000;
      }
      .story-acts { padding: 9px 11px 11px; }
      .story-acts button {
        width: 100%; padding: 12px 6px;
        font-family: var(--display); font-size: 13.5px; font-weight: 700;
        border-radius: var(--pill); border: 1px solid rgba(255,255,255,.5); cursor: pointer;
        background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff;
        box-shadow: 0 6px 18px rgba(255,90,170,.38), var(--shadow);
      }
      .story-acts button:active { filter: brightness(.92); }
    </style>

    <button class="fab" aria-label="Open InstaLurk">ðŸ‘€</button>

    <div class="sheet" hidden>
      <button class="x">âœ•</button>
      <button class="bk" hidden>â€¹</button>
      <header>
        <h1 id="title">Let's lurk ðŸ‘€</h1>
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
    ui.title.textContent = "Let's lurk ðŸ‘€";
    ui.sub.textContent = quotaHit ? 'Storage is full. Delete a watch to save more.' : '';
    ui.back.hidden = true;
    ui.header.classList.remove('hasback');
    setNote('', false);
    const watching = Object.keys(data.tracks).length;
    ui.controls.innerHTML = `
      <div class="pad">
        <button class="big p" data-go="self"><span class="lab"><b>My account</b><em>Who doesn't follow you back</em></span></button>
        <button class="big" data-go="stalk"><span class="lab"><b>Start a new stalk</b><em>Record who they follow now, to monitor later</em></span></button>
        <button class="big" data-go="monitor"><span class="lab"><b>Monitor a user</b><em>${
          watching ? `See who they've added Â· ${watching} watched` : 'Nothing watched yet'
        }</em></span></button>
        <button class="big" data-go="compare"><span class="lab"><b>Compare two accounts</b><em>Who they both follow</em></span></button>
        <button class="big" data-go="stories"><span class="lab"><b>Watch stories quietly</b><em>No seen receipt sent</em></span></button>
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
      ? `@${s.info.username || 'â€¦'} Â· ${nf.format(s.info.followers ?? 0)} followers Â· ${nf.format(
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
        'Instagram left out follow-back info this time, so your followers list is needed too. That one is slower (served 25 at a time) and may not finish on a large account.',
        true
      );
      ui.list.innerHTML = '<div class="empty">Tap <b>Scan followers</b> to finish.</div>';
      return;
    }

    let list;
    if (direct) {
      setNote('Read straight from your following list. Nothing is missing.', true);
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
        '<div class="empty"><b>Nothing watched yet.</b><br>Use <b>Start a new stalk</b> first. That first capture is the baseline.</div>';
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
            )} Â· ${data.tracks[k].kind}</option>`
        )
        .join('')}</select></div>
      <div class="pad rowf">
        <button class="act" id="check">Check now</button>
        <button class="act ghost" id="stop" hidden>Stop</button>
        <button class="act ghost" id="del" style="flex:0 0 auto;padding:13px 16px">âœ•</button>
      </div>`;

    const last = t.snapshots[t.snapshots.length - 1];
    const all = members(t);
    ui.sub.textContent = `${nf.format(all.length)} tracked Â· ${t.snapshots.length} check${
      t.snapshots.length === 1 ? '' : 's'
    } Â· since ${dtShort.format(new Date(t.snapshots[0].at))}`;

    const arrivals = all.filter((a) => !a.baseline);
    const baselineCount = all.length - arrivals.length;

    // Nothing is dated until the baseline stops growing, so an unsettled watch
    // must not present as "nobody new" â€” that reads as a finished, trustworthy
    // state when it is the opposite.
    if (!t.settled) {
      const want = last ? last.expectedTotal : null;
      setNote('', false);
      ui.list.innerHTML =
        `<div class="empty"><b>Still building the baseline.</b><br>` +
        `${nf.format(all.length)}${want != null ? ' of ' + nf.format(want) : ''} collected so far. ` +
        `Instagram reshuffles the list while it is being read, so a walk can miss people.` +
        `<br><br>Tap <b>Check now</b> again. Anyone a later pass turns up is added to the baseline, ` +
        `not counted as a new follow. Once two checks agree, dating starts.</div>`;
      return;
    }

    if (!arrivals.length) {
      setNote('', false);
      ui.list.innerHTML = `<div class="empty"><b>Nobody new yet.</b><br>
        ${nf.format(baselineCount)} accounts were already there when you started watching
        on ${esc(dtShort.format(new Date(t.snapshots[0].at)))}. They aren't listed, because
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
              ? `<div class="ghead-note">${nf.format(shaky)} unverified: the previous capture came
                 up short, so they may have been followed long ago and simply missed.</div>`
              : '') +
            list.sort(byName).map(card).join('')
          );
        })
        .join('') +
      `<div class="gfoot">${nf.format(baselineCount)} accounts predate the watch and aren't listed.
       <br>Accounts under one date were all found by that single check, so they aren't in order
       relative to each other.</div>`;
  }

  /**
   * How complete a track is, judged on the ACCUMULATED membership across every
   * capture rather than the last run alone â€” captures union into one record,
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
            )} Â· ${data.tracks[k].kind}</option>`
        )
        .join('');

    ui.sub.textContent = 'Runs on captures you already have. No requests.';
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
      // Only omission is possible here â€” everyone shown really is in both.
      setNote(
        `At least this many. A capture came up short, so a few may be missing. ` +
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
        "Loads their story without sending a seen receipt, so you shouldn't appear in their viewer list. Don't open the same story in Instagram afterwards. That will.",
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
          ? 'Save opens the share sheet. Choose Save Image or Save Video to put it in Photos.'
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
        // iOS offers Add to Photos / Save to Files â€” and long-pressing the
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
          `<span>${esc(when)}${it.isVideo ? ' Â· video' : ''}</span></div>${media}${acts}</div>`
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
    }â€¦<br>pass ${p.pass}<br><br>Keep this tab open.</div>`;
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
      if (!save()) setNote('Ran out of storage. Some results may not be saved.', true);
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
    ui.list.innerHTML = '<div class="empty">Looking them upâ€¦</div>';
    try {
      const t = await resolveTarget(input);
      const expected = t.info && t.info.following;
      // No scan plan: "Start a stalk" always walks the whole list, even for an
      // account already being watched. That is what makes it the way to clear
      // out accounts that have since been unfollowed, which a check cannot see.
      const out = await walkList('following', t.pk, expected, progress);
      if (!out.users.length) throw new Halt('No accounts returned. The list may be hidden.', 'empty');

      const r = ingest(
        'following',
        t.pk,
        t.username,
        out.users,
        expected,
        out.reachedEnd && !out.aborted,
        out
      );
      monKey = `following:${t.pk}`;
      if (r.isFirst) {
        setNote(
          `Baseline saved: ${nf.format(r.total)} accounts. We'll keep an eye on them. Come back to Monitor to see who they add.`,
          true
        );
        go('monitor');
      } else {
        setNote(
          r.arrived
            ? `${nf.format(r.arrived)} new since the last check.`
            : 'Already watching them. Nobody new.',
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
      // `info.following` regardless of kind, as this read for a long time, fed
      // the FOLLOWING count in as a followers watch's expected total. That one
      // number drives the completion tolerance, whether a capture counts as
      // full, whether the baseline settles, and how many arrivals are
      // plausible, so a followers watch had all four wrong at once.
      const expected = info ? (t.kind === 'followers' ? info.followers : info.following) : null;
      if (info && info.username) t.username = info.username;

      // A settled watch does not need the whole list re-read, only the top of
      // it until the profile's own count is accounted for. Same rules as the
      // extension: see scanPlanFor() in src/background.js.
      const prev = t.snapshots.length ? t.snapshots[t.snapshots.length - 1] : null;
      const knownPks =
        t.settled === true && prev && prev.expectedTotal != null
          ? Object.keys(t.accounts).filter((pk) => !t.accounts[pk].g)
          : null;
      const observedDeepest = t.snapshots
        .slice(-5)
        .reduce((m, s) => Math.max(m, s.deepestNewDepth || 0), 0);
      const scan =
        knownPks && knownPks.length
          ? {
              mode: 'head',
              prevCount: prev.expectedTotal,
              knownPks,
              floorRows: Math.max(300, 3 * observedDeepest),
              ceilRows: Math.max(1000, Math.ceil(prev.expectedTotal * 0.25)),
              quietDepth: 150,
            }
          : null;

      const out = await walkList(t.kind, t.pk, expected, progress, scan);
      if (!out.users.length) throw new Halt('No accounts returned. The list may be hidden.', 'empty');

      const r = ingest(
        t.kind,
        t.pk,
        t.username,
        out.users,
        expected,
        out.reachedEnd && !out.aborted,
        out
      );
      const bits = [r.arrived ? `${nf.format(r.arrived)} new.` : 'Nobody new.'];
      if (r.absorbed) {
        bits.push(`${nf.format(r.absorbed)} were missed by an earlier scan. Added to the baseline, not counted as new.`);
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
   * Safari, generally false on Firefox Android â€” which is fine, because that
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
   * the file attached â€” `<a download>` is ignored cross-origin, and opening the
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
        reset('Fetchingâ€¦');
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
    ui.list.innerHTML = '<div class="empty">Looking them upâ€¦</div>';
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
    if (!pos) return; // never dragged â€” leave the CSS default in place
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
        e.target.textContent = 'âœ•';
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
   * treats the keypress as a shortcut and calls preventDefault() â€” which ate
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

