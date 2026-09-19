/**
 * MAIN-world agent. Two jobs:
 *
 * 1. HEADER HARVEST + PASSIVE CAPTURE. Wraps fetch/XHR at document_start so it
 *    can (a) learn the exact API headers Instagram's own client sends, and
 *    (b) record what the follower/following *modal* was served. The modal list
 *    is RANKED, so it is kept only as a comparison set — never as the ordered
 *    result.
 *
 * 2. COLLECTOR. On command, calls the friendships endpoint directly:
 *
 *      /api/v1/friendships/<id>/followers/?count=N[&max_id=<cursor>]
 *
 *    with no `search_surface` and no `rank_token` — the parameters the web UI
 *    adds to get a ranked list. Unranked, this endpoint pages through the
 *    follow-edge index, so the array order is the true follow sequence,
 *    newest first. Running here (page realm, same origin) means the session
 *    cookies and harvested headers apply exactly as they do for Instagram.
 *
 * Requests are deliberately slow and abort on any sign of rate limiting.
 */
(() => {
  'use strict';

  const FLAG = '__igFollowOrder_v2';
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, enumerable: false });

  const OUT = '__igfo_out__'; // MAIN -> bridge
  const IN = '__igfo_in__'; // bridge -> MAIN

  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const FALLBACK_APP_ID = '936619743392459'; // long-standing Instagram web app id

  // --- outbound messaging ----------------------------------------------------

  function post(message) {
    try {
      window.postMessage({ [OUT]: 1, ...message }, window.location.origin);
    } catch (_) {}
  }

  // --- header harvesting -----------------------------------------------------

  const WANTED = [
    'x-ig-app-id',
    'x-asbd-id',
    'x-ig-www-claim',
    'x-csrftoken',
    'x-requested-with',
  ];
  const harvested = Object.create(null);

  function absorb(name, value) {
    const key = String(name || '').toLowerCase();
    if (!WANTED.includes(key)) return;
    if (typeof value !== 'string' || !value) return;
    harvested[key] = value;
  }

  function harvestHeaders(h) {
    try {
      if (!h) return;
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        for (const [k, v] of h.entries()) absorb(k, v);
      } else if (Array.isArray(h)) {
        for (const pair of h) if (pair && pair.length === 2) absorb(pair[0], pair[1]);
      } else if (typeof h === 'object') {
        for (const k of Object.keys(h)) absorb(k, h[k]);
      }
    } catch (_) {}
  }

  function cookie(name) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie || '');
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  }

  /**
   * Second source for the app id. Harvesting only works once Instagram has
   * made an API call of its own, which may not have happened yet — but the id
   * is also embedded in the page's inline bootstrap scripts, so dig it out
   * from there rather than falling straight back to a hardcoded constant.
   * A wrong or missing x-ig-app-id makes the API answer 429.
   */
  let scrapedAppId = null;

  function appIdFromPage() {
    if (scrapedAppId !== null) return scrapedAppId;
    scrapedAppId = '';
    try {
      const patterns = [
        /"X-IG-App-ID"\s*:\s*"(\d{6,})"/,
        /"app_id"\s*:\s*"(\d{6,})"/,
        /appId"\s*:\s*"(\d{6,})"/,
      ];
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const text = s.textContent;
        if (!text || text.length < 20) continue;
        for (const re of patterns) {
          const m = re.exec(text);
          if (m) {
            scrapedAppId = m[1];
            return scrapedAppId;
          }
        }
      }
    } catch (_) {}
    return scrapedAppId;
  }

  /** The logged-in user's own id, straight from a readable cookie. */
  function selfId() {
    const v = cookie('ds_user_id');
    return v && /^\d{3,}$/.test(v) ? v : null;
  }

  /**
   * Last-ditch handle→id: profile pages embed the id in their inline
   * bootstrap JSON. Only trusted when we are actually on that profile, since
   * the generic marker says nothing about which user it belongs to.
   */
  function scrapeUserId(username) {
    const uname = String(username || '').trim().toLowerCase();
    if (!uname) return null;
    const quoted = uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const onTheirPage = new RegExp(`^/${quoted}/?($|\\?)`, 'i').test(window.location.pathname);

    try {
      const paired = [
        new RegExp(`"id"\\s*:\\s*"(\\d{3,})"[^{}]{0,300}?"username"\\s*:\\s*"${quoted}"`, 'i'),
        new RegExp(`"username"\\s*:\\s*"${quoted}"[^{}]{0,300}?"id"\\s*:\\s*"(\\d{3,})"`, 'i'),
      ];
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const t = s.textContent;
        if (!t || t.length < 20) continue;
        for (const re of paired) {
          const m = re.exec(t);
          if (m) return m[1];
        }
        if (onTheirPage) {
          const m = /"profilePage_(\d{3,})"/.exec(t);
          if (m) return m[1];
        }
      }
    } catch (_) {}
    return null;
  }

  let appIdSource = 'none';

  function apiHeaders() {
    let appId = harvested['x-ig-app-id'];
    appIdSource = 'harvested';
    if (!appId) {
      appId = appIdFromPage();
      appIdSource = appId ? 'page-scrape' : 'fallback-constant';
      if (!appId) appId = FALLBACK_APP_ID;
    }

    const h = {
      'x-ig-app-id': appId,
      'x-requested-with': 'XMLHttpRequest',
      accept: '*/*',
    };
    const csrf = harvested['x-csrftoken'] || cookie('csrftoken');
    if (csrf) h['x-csrftoken'] = csrf;
    if (harvested['x-asbd-id']) h['x-asbd-id'] = harvested['x-asbd-id'];
    if (harvested['x-ig-www-claim']) h['x-ig-www-claim'] = harvested['x-ig-www-claim'];
    return h;
  }

  // --- shared response parsing ----------------------------------------------

  /** Keeps the fields the UI needs plus the untouched server object. */
  function normaliseUser(u) {
    const pk = u.pk != null ? u.pk : u.pk_id != null ? u.pk_id : u.id;
    // friendship_status is relative to the logged-in viewer. When the server
    // includes `followed_by`, follow-back status is readable straight off the
    // following list — no followers walk, which matters because the followers
    // endpoint cannot be reliably enumerated to the end.
    const fs = u.friendship_status && typeof u.friendship_status === 'object' ? u.friendship_status : null;
    return {
      pk: pk != null ? String(pk) : '',
      username: typeof u.username === 'string' ? u.username : '',
      fullName: typeof u.full_name === 'string' ? u.full_name : '',
      isPrivate: !!u.is_private,
      isVerified: !!u.is_verified,
      followsYou: fs && typeof fs.followed_by === 'boolean' ? fs.followed_by : null,
      youFollow: fs && typeof fs.following === 'boolean' ? fs.following : null,
      raw: u,
    };
  }

  /** Pulls the ordered user array out of the shapes Instagram serves. */
  function extractUsers(json) {
    if (!json || typeof json !== 'object') return null;

    if (Array.isArray(json.users)) {
      return {
        users: json.users,
        nextCursor: json.next_max_id != null ? String(json.next_max_id) : null,
        kind: null,
      };
    }

    const data = json.data;
    if (!data || typeof data !== 'object') return null;

    for (const key of Object.keys(data)) {
      const node = data[key];
      if (node && typeof node === 'object' && Array.isArray(node.users)) {
        let kind = null;
        if (/followers/i.test(key)) kind = 'followers';
        else if (/following/i.test(key)) kind = 'following';
        return {
          users: node.users,
          nextCursor: node.next_max_id != null ? String(node.next_max_id) : null,
          kind,
        };
      }
    }

    const user = data.user;
    if (user && typeof user === 'object') {
      for (const [key, conn] of Object.entries(user)) {
        if (!conn || typeof conn !== 'object' || !Array.isArray(conn.edges)) continue;
        let kind = null;
        if (key === 'edge_followed_by') kind = 'followers';
        else if (key === 'edge_follow') kind = 'following';
        else continue;
        const page = conn.page_info || {};
        return {
          users: conn.edges.map((e) => (e && e.node) || null).filter(Boolean),
          nextCursor: page.has_next_page && page.end_cursor ? String(page.end_cursor) : null,
          kind,
        };
      }
    }

    return null;
  }

  // --- passive capture (ranked modal, comparison only) ----------------------

  const REST_FRIENDSHIP = /\/api\/v1\/friendships\/(\d+)\/(followers|following)\b/;
  const REST_PROFILE = /\/api\/v1\/users\/web_profile_info\//;
  const RANKED_HINT = /[?&](search_surface|rank_token|enable_groups)=/;
  const MODAL_PATH = /^\/([A-Za-z0-9._]+)\/(followers|following)\/?$/;

  function looksLikeHtml(text) {
    return /^\s*(<!DOCTYPE|<html\b)/i.test(text || '');
  }

  /**
   * Instagram calls web_profile_info itself whenever you open a profile, so
   * simply visiting one teaches us that profile's numeric id — no lookup
   * request of our own required.
   */
  function observeProfile(text) {
    let json;
    try {
      json = JSON.parse(text.replace(/^(\)\]\}'|for\s*\(;;\);)+/, ''));
    } catch (_) {
      return;
    }
    const u = json && json.data && json.data.user;
    if (!u || !u.id || typeof u.username !== 'string') return;
    post({
      type: 'profile',
      id: String(u.id),
      username: u.username,
      isPrivate: !!u.is_private,
      followers: u.edge_followed_by ? u.edge_followed_by.count : null,
      following: u.edge_follow ? u.edge_follow.count : null,
    });
  }

  function observeModal(url, text) {
    const m = REST_FRIENDSHIP.exec(url);
    if (!m) return;
    let json;
    try {
      json = JSON.parse(text.replace(/^(\)\]\}'|for\s*\(;;\);)+/, ''));
    } catch (_) {
      return;
    }
    const parsed = extractUsers(json);
    if (!parsed || !parsed.users.length) return;

    const pathMatch = MODAL_PATH.exec(window.location.pathname);
    post({
      type: 'modal',
      kind: m[2],
      targetId: m[1],
      // The modal rewrites the URL to /<username>/followers/, which pairs the
      // numeric id in the request with a handle.
      pathUsername: pathMatch ? pathMatch[1] : null,
      ranked: RANKED_HINT.test(url),
      users: parsed.users.map(normaliseUser),
      at: Date.now(),
    });
  }

  // --- wrappers --------------------------------------------------------------

  /**
   * Instagram's own GraphQL follower/following query, captured verbatim as it
   * goes past. doc_ids rotate and are not guessable, so replaying the page's
   * own query is the only way to probe that transport.
   */
  const graphqlCaptures = { followers: null, following: null };

  function bodyToString(body) {
    try {
      if (body == null) return '';
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body.entries()) {
          if (typeof v === 'string') parts.push(`${k}=${encodeURIComponent(v)}`);
        }
        return parts.join('&');
      }
    } catch (_) {}
    return '';
  }

  function harvestGraphql(url, bodyStr) {
    if (!/\/(graphql\/query|api\/graphql)\b/.test(url) || !bodyStr) return;
    let decoded = bodyStr;
    try {
      decoded = decodeURIComponent(bodyStr);
    } catch (_) {}

    let kind = null;
    if (/followers|edge_followed_by/i.test(decoded)) kind = 'followers';
    else if (/\bfollowing\b|edge_follow\b/i.test(decoded)) kind = 'following';
    if (!kind) return;

    const docId = ((/(?:^|&)doc_id=(\d+)/.exec(bodyStr) ||
      /"doc_id"\s*:\s*"?(\d+)/.exec(decoded) ||
      [])[1]) || null;
    if (!docId) return;

    graphqlCaptures[kind] = { url, body: bodyStr, docId, at: Date.now() };
  }

  const wrappedFetch = function fetch(input, init) {
    let url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;
      if (init) harvestHeaders(init.headers);
      if (input && input.headers) harvestHeaders(input.headers);
      if (init && init.body != null) harvestGraphql(url, bodyToString(init.body));
    } catch (_) {}

    const promise = nativeFetch(input, init);

    try {
      const isFriendship = REST_FRIENDSHIP.test(url);
      if (isFriendship || REST_PROFILE.test(url)) {
        promise.then(
          (res) => {
            try {
              res
                .clone()
                .text()
                .then((t) => (isFriendship ? observeModal(url, t) : observeProfile(t)))
                .catch(() => {});
            } catch (_) {}
          },
          () => {}
        );
      }
    } catch (_) {}

    return promise;
  };

  try {
    // Must close over `originalFetch`, not `window.fetch` — the latter is this
    // wrapper by the time anyone calls it, which would recurse forever.
    Object.defineProperty(wrappedFetch, 'length', { value: originalFetch.length });
    wrappedFetch.toString = () => originalFetch.toString();
  } catch (_) {}
  window.fetch = wrappedFetch;

  const XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRProto) {
    const nOpen = XHRProto.open;
    const nSend = XHRProto.send;
    const nSet = XHRProto.setRequestHeader;
    const S = '__igfoReq';

    XHRProto.open = function (method, url) {
      try {
        this[S] = { url: typeof url === 'string' ? url : String(url || '') };
      } catch (_) {}
      return nOpen.apply(this, arguments);
    };

    XHRProto.setRequestHeader = function (name, value) {
      absorb(name, value);
      return nSet.apply(this, arguments);
    };

    XHRProto.send = function () {
      try {
        const info = this[S];
        const isFriendship = info && REST_FRIENDSHIP.test(info.url);
        if (info && (isFriendship || REST_PROFILE.test(info.url))) {
          this.addEventListener('load', () => {
            try {
              const rt = this.responseType;
              let text = '';
              if (rt === '' || rt === 'text') text = this.responseText;
              else if (rt === 'json' && this.response) text = JSON.stringify(this.response);
              if (!text) return;
              if (isFriendship) observeModal(info.url, text);
              else observeProfile(text);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return nSend.apply(this, arguments);
    };
  }

  // --- collector -------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Interruptible wait. Long rate-limit backoffs run for minutes, and Stop has
   * to remain responsive throughout, so sleep in short slices.
   */
  async function sleepAbortable(ms, run, onTick) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (run.aborted) return false;
      const left = deadline - Date.now();
      if (onTick) onTick(left);
      await sleep(Math.min(1000, left));
    }
    return !run.aborted;
  }

  /** Aborts hard on anything that smells like a rate limit or a challenge. */
  class Halt extends Error {
    constructor(message, kind, retryAfterMs) {
      super(message);
      this.kind = kind || 'fatal';
      this.retryAfterMs = retryAfterMs || 0;
    }
  }

  // Instagram's throttle window is minutes, not seconds. Being impatient here
  // is what turns a soft throttle into an action block.
  const RATE_BACKOFF_MS = [45000, 180000, 420000, 900000];

  async function apiGet(path) {
    let res;
    try {
      res = await nativeFetch(path, {
        method: 'GET',
        credentials: 'include',
        headers: apiHeaders(),
        referrer: window.location.href,
      });
    } catch (e) {
      throw new Halt(`Network error: ${e && e.message ? e.message : e}`, 'network');
    }

    // Read the body BEFORE branching on status. A 429 carrying an HTML page is
    // a routing failure, not a rate limit, and deciding from the status code
    // alone gets that backwards.
    const text = await res.text();

    if (looksLikeHtml(text)) {
      const title = (/<title>([\s\S]{0,120}?)<\/title>/i.exec(text) || [])[1] || '';
      throw new Halt(
        `Instagram served an HTML page, not JSON (HTTP ${res.status}` +
          (title ? `, "${title.trim().replace(/\s+/g, ' ')}"` : '') +
          '). The request never reached the API. This is not a rate limit.',
        'html'
      );
    }

    if (res.status === 429) {
      // Honour Retry-After when Instagram bothers to send it.
      let after = 0;
      try {
        const raw = res.headers.get('retry-after');
        if (raw) {
          const secs = Number(raw);
          after = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(raw) - Date.now());
        }
      } catch (_) {}
      throw new Halt(
        `Instagram returned HTTP 429 with a JSON body (app id via ${appIdSource}).`,
        'rate',
        after
      );
    }
    if (res.status === 401)
      throw new Halt('Not authorised (HTTP 401). Log in to Instagram and retry.', 'auth');
    if (res.status === 403)
      throw new Halt('Forbidden (HTTP 403). Session may be stale, or this list is not visible to you.', 'auth');
    if (res.status === 404) throw new Halt('Not found (HTTP 404).', 'notfound');

    let json;
    try {
      json = JSON.parse(text.replace(/^(\)\]\}'|for\s*\(;;\);)+/, ''));
    } catch (_) {
      throw new Halt(`Unexpected non-JSON response (HTTP ${res.status}).`, 'parse');
    }

    if (json && (json.require_login || json.checkpoint_required || json.challenge)) {
      throw new Halt('Instagram is asking for a checkpoint/challenge. Stop and resolve it in a tab.', 'challenge');
    }
    if (json && json.spam) throw new Halt('Instagram flagged the request as spam. Stop for a while.', 'rate');
    if (json && json.status === 'fail') {
      throw new Halt(`Instagram refused: ${json.message || 'unknown reason'}`, 'refused');
    }
    if (!res.ok) throw new Halt(`HTTP ${res.status}.`, 'http');

    return json;
  }

  /**
   * Handle -> pk. web_profile_info answers 429 for every logged-in session, so
   * topsearch is the working route. It is FUZZY: a query for "jane" happily
   * returns "janedoe123", so only an exact username match counts.
   */
  async function resolveViaSearch(username) {
    const json = await apiGet(
      `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}`
    );
    const want = String(username).toLowerCase().replace(/^@/, '');
    for (const entry of (json && json.users) || []) {
      const u = (entry && entry.user) || entry;
      if (u && String(u.username || '').toLowerCase() === want) return u;
    }
    return null;
  }

  /**
   * pk -> handle and counts. This is the only endpoint that answers a
   * logged-in session, and it is also the reverse of topsearch: it turns a
   * numeric id (from the Me button, or typed directly) back into a username so
   * lists are labelled with something a human recognises.
   */
  async function fetchUserInfo(pk) {
    for (const host of ['', 'https://i.instagram.com']) {
      try {
        const json = await apiGet(`${host}/api/v1/users/${encodeURIComponent(pk)}/info/`);
        const who = (json && json.user) || {};
        if (who.username || Number.isInteger(who.following_count)) {
          return {
            username: typeof who.username === 'string' ? who.username : null,
            fullName: who.full_name || '',
            isPrivate: !!who.is_private,
            followers: Number.isInteger(who.follower_count) ? who.follower_count : null,
            following: Number.isInteger(who.following_count) ? who.following_count : null,
          };
        }
      } catch (_) {
        // Optional enrichment; never abort the walk over it.
      }
    }
    return null;
  }

  async function resolveProfile(username) {
    const u = await resolveViaSearch(username);
    if (!u) throw new Halt(`No such profile: @${username}`, 'notfound');
    const id = String(u.pk != null ? u.pk : u.id || '');
    if (!id) throw new Halt(`No such profile: @${username}`, 'notfound');

    const fs = u.friendship_status || {};
    const followedByViewer = typeof fs.following === 'boolean' ? fs.following : null;
    const info = await fetchUserInfo(id);
    return {
      id,
      username: u.username || (info && info.username) || username,
      isPrivate: !!u.is_private,
      followedByViewer,
      followers: info ? info.followers : null,
      following: info ? info.following : null,
    };
  }

  /**
   * Single cheap request that reports exactly what was sent and what came
   * back, so a failure can be attributed to headers vs. an actual rate limit
   * without burning a whole run.
   */
  async function diagnose(cmd) {
    const username = String(cmd.username || 'instagram').replace(/^@/, '').trim();
    const headers = apiHeaders();
    const result = {
      type: 'diag',
      at: Date.now(),
      username,
      appId: headers['x-ig-app-id'],
      appIdSource,
      harvestedKeys: Object.keys(harvested),
      sentHeaders: Object.keys(headers),
      hasCsrf: !!headers['x-csrftoken'],
      // sessionid is HttpOnly and unreadable; ds_user_id is the usable
      // "is someone logged in here" signal.
      dsUserId: cookie('ds_user_id') || null,
      status: null,
      ok: false,
      retryAfter: null,
      snippet: '',
      error: null,
    };

    async function probe(label, path) {
      const out = { label, path, status: null, isHtml: false, title: null, snippet: '', error: null };
      try {
        const res = await nativeFetch(path, {
          method: 'GET',
          credentials: 'include',
          headers,
          referrer: window.location.href,
        });
        out.status = res.status;
        try {
          out.retryAfter = res.headers.get('retry-after');
        } catch (_) {}
        const text = await res.text();
        out.isHtml = looksLikeHtml(text);
        if (out.isHtml) {
          const t = (/<title>([\s\S]{0,120}?)<\/title>/i.exec(text) || [])[1];
          out.title = t ? t.trim().replace(/\s+/g, ' ') : null;
        }
        out.snippet = text.slice(0, 220);
        if (!out.isHtml) {
          try {
            out.json = JSON.parse(text.replace(/^(\)\]\}'|for\s*\(;;\);)+/, ''));
          } catch (_) {}
        }
      } catch (e) {
        out.error = String(e && e.message ? e.message : e);
      }
      return out;
    }

    // web_profile_info is only used to turn a handle into an id, and it is the
    // flakier of the two. The friendships endpoint is the one that must work.
    result.profileProbe = await probe(
      'web_profile_info',
      `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
    );

    const pu = result.profileProbe.json && result.profileProbe.json.data && result.profileProbe.json.data.user;
    if (pu && pu.id) {
      result.resolved = {
        id: String(pu.id),
        username: pu.username || username,
        isPrivate: !!pu.is_private,
        followers: pu.edge_followed_by ? pu.edge_followed_by.count : null,
      };
    }

    // Probe friendships with whatever id we can get, cheapest source first.
    result.scrapedId = scrapeUserId(username);
    result.selfId = selfId();
    const probeId =
      (result.resolved && result.resolved.id) || cmd.knownId || result.scrapedId || result.selfId;
    result.knownId = cmd.knownId || null;
    result.probeIdSource =
      result.resolved && result.resolved.id
        ? 'lookup'
        : cmd.knownId
        ? 'learned'
        : result.scrapedId
        ? 'page-scrape'
        : result.selfId
        ? 'your own account (ds_user_id)'
        : null;
    if (probeId) {
      result.friendshipProbe = await probe(
        'friendships/followers',
        `/api/v1/friendships/${encodeURIComponent(probeId)}/followers/?count=1`
      );
      const fj = result.friendshipProbe.json;
      if (fj && Array.isArray(fj.users)) {
        result.friendshipProbe.usersReturned = fj.users.length;
        result.friendshipProbe.hasCursor = fj.next_max_id != null;
      }
    }

    // Keep the flat fields the older renderer reads.
    result.status = result.profileProbe.status;
    result.ok = result.profileProbe.status === 200 && !!result.resolved;
    result.snippet = result.profileProbe.snippet;
    result.error = result.profileProbe.error;

    post(result);
  }

  /**
   * Fires one request per candidate transport and reports the head of each
   * resulting list. Nothing here is known to give follow order — the point is
   * that the orders can be compared against reality side by side, cheaply,
   * instead of reasoning about which one ought to work.
   */
  async function probeOrders(cmd) {
    const id = cmd.targetId;
    const kind = cmd.kind === 'following' ? 'following' : 'followers';
    const base = `/api/v1/friendships/${encodeURIComponent(id)}/${kind}/`;

    async function raw(path, init) {
      const out = { status: null, usernames: [], count: null, note: null };
      try {
        const res = await nativeFetch(
          path,
          init || {
            method: 'GET',
            credentials: 'include',
            headers: apiHeaders(),
            referrer: window.location.href,
          }
        );
        out.status = res.status;
        const text = await res.text();
        if (looksLikeHtml(text)) {
          out.note = 'HTML, not the API';
          return out;
        }
        const json = JSON.parse(text.replace(/^(\)\]\}'|for\s*\(;;\);)+/, ''));
        const parsed = extractUsers(json);
        if (!parsed) {
          out.note = json && json.message ? String(json.message) : 'no user list in response';
          return out;
        }
        out.count = parsed.users.length;
        out.usernames = parsed.users.slice(0, 15).map((u) => u.username || `id:${u.pk || u.id}`);
      } catch (e) {
        out.note = String(e && e.message ? e.message : e);
      }
      return out;
    }

    const variants = [
      { key: 'rest-plain', label: 'REST, no ranking params', path: `${base}?count=50` },
      {
        key: 'rest-modal',
        label: "REST + search_surface (what the app's modal sends)",
        path: `${base}?count=50&search_surface=follow_list_page`,
      },
      // Speculative ordering params. Unverified — included because trying them
      // costs one request each and settles the question.
      { key: 'rest-order-date', label: 'REST + order=date', path: `${base}?count=50&order=date` },
      {
        key: 'rest-sort-followed',
        label: 'REST + sort=date_followed',
        path: `${base}?count=50&sort=date_followed`,
      },
      {
        key: 'rest-no-groups',
        label: 'REST + enable_groups=false',
        path: `${base}?count=50&enable_groups=false`,
      },
    ];

    post({ type: 'probe:started', total: variants.length + 1, kind, targetId: id });

    for (const v of variants) {
      const r = await raw(v.path);
      post({ type: 'probe:result', key: v.key, label: v.label, path: v.path, ...r });
      await sleep(1500 + Math.random() * 800);
    }

    // Replay Instagram's own GraphQL query, if one has been seen go past.
    const cap = graphqlCaptures[kind];
    if (cap) {
      const r = await raw(cap.url, {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign(apiHeaders(), {
          'content-type': 'application/x-www-form-urlencoded',
        }),
        body: cap.body,
        referrer: window.location.href,
      });
      post({
        type: 'probe:result',
        key: 'graphql',
        label: `GraphQL replay (doc_id ${cap.docId})`,
        path: cap.url,
        ...r,
      });
    } else {
      post({
        type: 'probe:result',
        key: 'graphql',
        label: 'GraphQL replay',
        note: `not captured yet: open the ${kind} modal once, then probe again`,
        status: null,
        usernames: [],
        count: null,
      });
    }

    post({ type: 'probe:done' });
  }

  // --- stories -------------------------------------------------------------
  //
  // Viewing a story and MARKING IT SEEN are two different requests. The media
  // arrives from the reels endpoint; the read receipt is a separate
  // /api/v1/media/seen/ POST the app sends afterwards. This code fetches the
  // reel and never sends that POST, which is the whole trick — there is no
  // "anonymous" flag, just an omitted request.
  //
  // Nothing here may ever POST to media/seen, or call the page's own wrapped
  // fetch in a way that lets Instagram's client do it for us.

  function bestUrl(list) {
    if (!Array.isArray(list) || !list.length) return null;
    // Candidates are ordered largest-first in practice; pick by width anyway.
    let best = list[0];
    for (const c of list) {
      if (c && typeof c.width === 'number' && c.width > (best.width || 0)) best = c;
    }
    return best && best.url ? String(best.url) : null;
  }

  function shapeStoryItem(it) {
    const image = bestUrl(it.image_versions2 && it.image_versions2.candidates);
    const video = bestUrl(it.video_versions);
    return {
      id: String(it.pk || it.id || ''),
      takenAt: typeof it.taken_at === 'number' ? it.taken_at * 1000 : null,
      expiringAt: typeof it.expiring_at === 'number' ? it.expiring_at * 1000 : null,
      isVideo: !!video || it.media_type === 2,
      image,
      video,
      duration: typeof it.video_duration === 'number' ? it.video_duration : null,
    };
  }

  function parseReel(json, targetId) {
    let reel = null;
    if (Array.isArray(json.reels_media) && json.reels_media.length) {
      reel = json.reels_media[0];
    } else if (json.reels && typeof json.reels === 'object') {
      reel = json.reels[targetId] || Object.values(json.reels)[0] || null;
    } else if (json.reel) {
      reel = json.reel;
    }
    if (!reel || !Array.isArray(reel.items)) return null;
    return {
      username: reel.user && reel.user.username ? String(reel.user.username) : null,
      items: reel.items.map(shapeStoryItem).filter((i) => i.image || i.video),
    };
  }

  async function loadStories(cmd) {
    try {
      let targetId = cmd.targetId || null;
      let username = cmd.username || null;

      if (!targetId && username) {
        const scraped = scrapeUserId(username);
        if (scraped) targetId = scraped;
      }
      if (!targetId) {
        if (!username) throw new Halt('No target given.', 'input');
        const p = await resolveProfile(String(username).replace(/^@/, '').trim());
        targetId = p.id;
        username = p.username;
        if (p.isPrivate && p.followedByViewer === false && selfId() !== p.id) {
          throw new Halt(
            `@${p.username} is private and you do not follow them. Their stories are not visible.`,
            'private'
          );
        }
      }

      const json = await apiGet(
        `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(targetId)}`
      );
      const reel = parseReel(json, String(targetId));

      if (!reel || !reel.items.length) {
        post({
          type: 'stories:result',
          targetId,
          username: (reel && reel.username) || username,
          items: [],
          at: Date.now(),
        });
        return;
      }

      post({
        type: 'stories:result',
        targetId,
        username: reel.username || username,
        items: reel.items,
        at: Date.now(),
      });
    } catch (e) {
      const halt = e instanceof Halt;
      post({
        type: 'stories:error',
        message: halt ? e.message : `Unexpected error: ${e && e.message ? e.message : e}`,
        kind: halt ? e.kind : 'unknown',
      });
    }
  }

  let activeRun = null; // { id, aborted }

  async function collect(cmd) {
    const run = { id: cmd.runId, aborted: false };
    activeRun = run;

    // Ask for the full page size on both sides and let the server cap it.
    // /followers/ has been measured at 25 regardless, but hard-coding that
    // locally guarantees the slow path even if the cap ever lifts — and the
    // served size is reported back either way.
    const pageSize = Math.min(200, Math.max(10, cmd.pageSize || 50));
    // `|| default` would turn a deliberate 0 delay back into 1500.
    const baseDelay = Math.max(0, cmd.delayMs == null ? 1500 : cmd.delayMs);
    const maxUsers = cmd.maxUsers || 100000;
    // 3, not 5. Each pass is a full re-walk of the whole list, so passes are
    // the dominant cost of a capture; the convergence rule below normally ends
    // it at 2.
    const maxPasses = Math.max(1, cmd.maxPasses || 3);
    // Union across passes, tracked here so a pass boundary needs no round trip
    // to the service worker to know whether it found anyone new.
    const unionSet = new Set();

    try {
      let targetId = cmd.targetId || null;
      let targetUsername = cmd.targetUsername || cmd.username || null;
      let expectedTotal = cmd.expectedTotal != null ? cmd.expectedTotal : null;

      // Resuming: target is already known, so skip the profile lookup and
      // carry on from the cursor the failed run stopped at.
      if (!targetId && targetUsername) {
        // Free sources first — web_profile_info is the flakiest link in the
        // chain and is not worth spending a request on if it can be avoided.
        const scraped = scrapeUserId(targetUsername);
        if (scraped) {
          targetId = scraped;
          post({ type: 'profile', id: scraped, username: targetUsername.replace(/^@/, '').trim() });
        }
      }

      if (!targetId) {
        if (!targetUsername) throw new Halt('No target given.', 'input');
        const p = await resolveProfile(targetUsername.replace(/^@/, '').trim());
        targetId = p.id;
        targetUsername = p.username;
        expectedTotal = cmd.kind === 'followers' ? p.followers : p.following;
        // Refuse ONLY when we are certain. An unknown relationship falls
        // through and lets the list call itself decide.
        if (p.isPrivate && p.followedByViewer === false && selfId() !== p.id) {
          throw new Halt(`@${p.username} is private and you do not follow them. The list is not visible.`, 'private');
        }
        await sleep(baseDelay);
      }

      // Always re-read the profile, even when the target is already known.
      // One request, and it keeps three things honest: the displayed counts,
      // the progress bar, and — most importantly — the expected total, which
      // later checks diff against to tell a real new follow from a recovered
      // miss. A carried-forward count would make that delta permanently zero.
      if (targetId) {
        const info = await fetchUserInfo(targetId);
        if (info) {
          if (info.username) targetUsername = info.username;
          const fresh = cmd.kind === 'followers' ? info.followers : info.following;
          if (fresh != null) expectedTotal = fresh;
          post({
            type: 'profile',
            id: targetId,
            username: info.username,
            isPrivate: info.isPrivate,
            followers: info.followers,
            following: info.following,
          });
        }
      }

      post({
        type: 'collect:started',
        runId: run.id,
        kind: cmd.kind,
        targetId,
        targetUsername,
        expectedTotal,
        pageSize,
        resumed: !!cmd.resumeCursor,
      });

      let cursor = cmd.resumeCursor || null;
      let pageIndex = cmd.startPageIndex || 0;
      let total = 0;
      let rateRetries = 0;
      let pass = 0;
      let quiet = 0;
      let lastUnion = -1;
      let reachedEnd = false;
      // Per-pass, since every pass legitimately revisits the same cursors.
      let seenCursors = new Set();
      let tokenCursor = false;
      let emptyStreak = 0;

      // --- overlapping windows --------------------------------------------
      //
      // /following/ pages by POSITIONAL OFFSET over a ranking Instagram
      // recomputes for every single request. Walking it with back-to-back
      // windows — [0,200), [200,400), [400,600) — loses people structurally:
      // an account sitting at position 250 when the first window is served,
      // which drifts to position 150 before the second request goes out, was
      // behind the boundary when it passed and in front of it afterwards. It
      // is never returned at all. Nobody dropped a page; the boundary ate them.
      //
      // Re-walking cannot fix that, because every re-walk puts the boundaries
      // back in exactly the same places. That is why captures kept landing at
      // 900 of 1,100 no matter how many passes they burned, and why the rest
      // only turned up on a later check, when Instagram's ranking had moved
      // enough to shake a few of them loose.
      //
      // The fix is to stop asking for adjacent windows. Request 200 rows every
      // STRIDE positions instead, so consecutive windows overlap: an account
      // now has to move more than (pageSize - stride) places between two
      // consecutive requests to slip through both. At 200/120 that is 80
      // places, against 1 before. It costs about 1.7x the requests of a pass,
      // and saves far more than that by making the pass actually converge
      // rather than needing four more that each recover a handful.
      //
      // The ratio changes per pass so that even the boundaries that remain
      // land somewhere different each time round.
      const strideFor = (p) => {
        const ratios = [0.5, 0.35, 0.6, 0.4];
        return Math.max(10, Math.round(pageSize * ratios[p % ratios.length]));
      };
      // Only /following/ hands back arithmetic offsets. /followers/ returns an
      // opaque token, which cannot be slid, and this stays false there.
      let slidingOff = false; // set if the server turns out to ignore our offsets
      let stallStreak = 0;
      let prevPagePks = null;

      for (;;) {
        if (run.aborted) {
          post({ type: 'collect:done', runId: run.id, reason: 'aborted', pages: pageIndex, total });
          return;
        }

        let path = `/api/v1/friendships/${encodeURIComponent(targetId)}/${cmd.kind}/?count=${pageSize}`;
        if (cursor) path += `&max_id=${encodeURIComponent(cursor)}`;

        let json;
        try {
          json = await apiGet(path);
          rateRetries = 0;
        } catch (e) {
          if (e instanceof Halt && e.kind === 'rate' && rateRetries < RATE_BACKOFF_MS.length) {
            const backoff =
              Math.max(RATE_BACKOFF_MS[rateRetries], e.retryAfterMs) + Math.random() * 5000;
            rateRetries++;

            let lastShown = -1;
            const ok = await sleepAbortable(backoff, run, (left) => {
              const secs = Math.ceil(left / 1000);
              // Only repost when the displayed value actually changes.
              if (secs === lastShown) return;
              lastShown = secs;
              const shown = secs >= 60 ? `${Math.ceil(secs / 60)}m` : `${secs}s`;
              post({
                type: 'collect:warn',
                runId: run.id,
                message: `Rate-limited (429). Waiting ${shown} before retry ${rateRetries}/${RATE_BACKOFF_MS.length}. Progress is saved. Stop is safe, you can resume later.`,
              });
            });

            if (!ok) {
              post({ type: 'collect:done', runId: run.id, reason: 'aborted', pages: pageIndex, total });
              return;
            }
            continue;
          }
          if (e instanceof Halt) e.lastCursor = cursor;
          throw e;
        }

        const parsed = extractUsers(json);

        // Instagram's "this list is hidden" flag. It must never read as "they
        // follow nobody" — but only treat it as a refusal when the page is
        // genuinely empty, since the flag can ride along with real rows.
        if (json && json.special_empty_state && (!parsed || !parsed.users.length)) {
          if (unionSet.size > 0) {
            // Mid-walk: keep everything already collected rather than throwing
            // the whole capture away. Finish the run here — breaking out of the
            // loop without this would leave it stuck reporting "running".
            post({
              type: 'collect:done',
              runId: run.id,
              reason: 'restricted',
              pages: pageIndex,
              total,
              passes: pass + 1,
              reachedEnd: false,
            });
            return;
          }
          throw new Halt(
            "Instagram won't show this list. That usually means the account is private and you " +
              'do not follow them, or they have restricted who can see it. Following an account ' +
              'you can already see works normally.',
            'restricted'
          );
        }

        if (!parsed) throw new Halt('Response had no user list. The endpoint shape changed.', 'parse');

        const users = parsed.users.map(normaliseUser);
        total += users.length;
        for (const u of users) if (u.pk) unionSet.add(u.pk);

        post({
          type: 'collect:page',
          runId: run.id,
          pageIndex,
          pass,
          cursorIn: cursor,
          nextCursor: parsed.nextCursor,
          users,
          requested: pageSize,
          returned: users.length,
          at: Date.now(),
        });

        pageIndex++;

        // There is no has_more/page_info, and a SHORT page is normal — a
        // 197-row page still advances the offset by the full 200 — so the only
        // terminators are an absent cursor or one that stops moving.
        const next = parsed.nextCursor;
        // An empty page is NOT the end of the list. Offset paging over a list
        // Instagram is re-ranking underneath us can hand back a window where
        // everyone has shifted out, while the list continues well past it.
        // Stopping on the first empty page silently truncated those walks and
        // is a large part of why captures came up short. Only an absent cursor,
        // or a run of empty pages, ends a pass now.
        emptyStreak = users.length === 0 ? emptyStreak + 1 : 0;
        let endOfList = !next || emptyStreak >= 3;

        if (!endOfList) {
          // /following/ returns a numeric offset ("200", "400"); /followers/
          // can return an opaque token. Demanding a number here killed the
          // followers walk after one page. Accept any cursor, and only require
          // that it actually moves and has not been seen before this pass.
          const offsetLike = /^\d+$/.test(String(next)) && /^\d*$/.test(String(cursor || ''));
          const curOff = Number(cursor || 0);
          let advanceTo = next;

          if (offsetLike && !slidingOff) {
            // Overlap the next window with the one just served. Clamped to the
            // server's own next offset so a shorter list is never overshot.
            //
            // The very first step is a HALF stride. Sliding gives every
            // position two looks except the first `stride` of them, because
            // there is no earlier window to overlap with — and those are the
            // most recently followed accounts, the ones the whole app is about.
            // Half-stepping once at the top halves that blind spot for the cost
            // of one extra request per pass.
            const stride = strideFor(pass);
            const step = cursor == null ? Math.max(1, Math.round(stride / 2)) : stride;
            advanceTo = String(Math.min(Math.max(curOff + 1, curOff + step), Number(next)));

            // Sliding assumes the offset means what it says. If Instagram ever
            // ignores an offset it did not itself hand out, it answers with the
            // window it wanted to send instead, and the page comes back as a
            // near-copy of the one before it. Two of those in a row and we stop
            // sliding and follow the server's cursor, which is the old
            // behaviour — lossier, but never a loop.
            const pks = users.map((u) => u.pk).filter(Boolean);
            if (prevPagePks && pks.length && prevPagePks.length) {
              const before = new Set(prevPagePks);
              let same = 0;
              for (const pk of pks) if (before.has(pk)) same++;
              const repeat = same >= pks.length * 0.9 && pks.length >= prevPagePks.length * 0.9;
              stallStreak = repeat ? stallStreak + 1 : 0;
              if (stallStreak >= 2) {
                slidingOff = true;
                advanceTo = next;
                post({
                  type: 'collect:warn',
                  runId: run.id,
                  message: 'Instagram is ignoring page offsets; falling back to plain paging.',
                });
              }
            }
            prevPagePks = pks;
          }

          const looped = advanceTo === cursor || seenCursors.has(advanceTo);
          const bothNumeric =
            Number.isFinite(Number(advanceTo)) && Number.isFinite(Number(cursor || 0));
          const wentBackwards = bothNumeric && Number(advanceTo) <= Number(cursor || 0);

          if (looped || wentBackwards) {
            // As far as the server will page. Not an error — end the pass so
            // the union still counts what was collected.
            endOfList = true;
            post({
              type: 'collect:warn',
              runId: run.id,
              message: `Instagram stopped paging after ${unionSet.size} of ${
                expectedTotal != null ? expectedTotal : '?'
              }.`,
            });
          } else {
            // A non-numeric cursor is anchored to a record rather than to a
            // position, which makes it immune to the re-ranking skip that
            // offset paging suffers. Walks like that converge in one pass, so
            // they need far less re-walking.
            if (!Number.isFinite(Number(advanceTo))) tokenCursor = true;
            seenCursors.add(advanceTo);
            cursor = advanceTo;

            // Unique accounts, not rows served. Overlapping windows serve most
            // positions twice, so `total` is no longer a count of anything.
            if (unionSet.size >= maxUsers) {
              post({ type: 'collect:done', runId: run.id, reason: 'limit', pages: pageIndex, total });
              return;
            }

            let wait = baseDelay + Math.random() * baseDelay * 0.6;
            if (pageIndex % 10 === 0) wait += baseDelay * 3;
            if (!(await sleepAbortable(wait, run))) {
              post({ type: 'collect:done', runId: run.id, reason: 'aborted', pages: pageIndex, total });
              return;
            }
            continue;
          }
        }

        // --- one full walk finished -------------------------------------
        // A single pass lands ~94-99%: Instagram re-ranks between requests, so
        // one walk both repeats and misses people. Repeat the whole walk and
        // let the service worker union the results, until a pass turns up
        // nobody new.
        reachedEnd = true;
        pass++;

        const union = unionSet.size;
        const marginal = lastUnion < 0 ? Infinity : union - lastUnion;
        lastUnion = union;

        const known = expectedTotal != null && expectedTotal > 0;

        // Re-walking has sharply diminishing returns inside one session: the
        // ranking only shuffles a little over a few minutes, so the same people
        // stay hidden and each extra pass recovers less than the last. A pass
        // that turns up one straggler out of two hundred missing is not worth
        // another full walk, and that long tail is most of the wait.
        //
        // A check tomorrow sees a properly different shuffle and recovers far
        // more for far less waiting, and anything it finds folds into the
        // baseline instead of being dated as a new follow. So near-zero counts
        // as zero, and the walk stops instead of grinding.
        // The bar scales with what a pass costs. /followers/ is capped at 25
        // rows a page against 200 for /following/, so a followers walk is
        // roughly eight times the requests and eight times the wait for the
        // same list, and it should give up on stragglers correspondingly
        // sooner.
        //
        // That reasoning only holds once the capture is basically there. While
        // it is still MATERIALLY short — the 900-of-1,100 case people keep
        // reporting — "this pass found almost nobody" is not a reason to stop.
        // It is a reason to run the next pass, which uses a different stride
        // and therefore different window boundaries, and so looks in places
        // this one structurally could not. So the bar drops to literally zero
        // while a large chunk of the list is still missing.
        const shortfall = known ? (expectedTotal - unionSet.size) / expectedTotal : 0;
        const materiallyShort = shortfall > 0.01;
        const rate = materiallyShort ? 0 : pageSize >= 100 ? 0.002 : 0.01;
        const negligible = rate === 0 ? 0 : known ? Math.max(1, Math.round(expectedTotal * rate)) : 1;
        quiet = marginal <= negligible ? quiet + 1 : 0;
        // Never wait for union === expectedTotal: that count includes
        // deactivated accounts which are counted but never returned, so many
        // targets plateau permanently below it and would walk forever.
        //
        // This used to sit at 2%, matching the tolerance the diffing side uses
        // to call a capture full — which quietly made 2% a TARGET. Simulated
        // against a re-ranking list the walk stopped the instant it crossed
        // 98%, every time, so a 1,100-following account reliably finished 20
        // people short and handed those 20 to the next check as "new". Two per
        // cent of a list is not a rounding error, it is twenty accounts.
        //
        // The gap that genuinely cannot be closed is deactivated and deleted
        // accounts: Instagram counts them in the profile total and never
        // returns them in the list, so an exact match is impossible and
        // demanding one would walk forever. Half a per cent covers that; the
        // quiet-pass rule below is what stops the walk on anything larger.
        const tolerance = known ? Math.max(1, expectedTotal * 0.005) : 0;
        // Reaching the reported count is the only self-evident finish; there is
        // nobody left to find. Short of that, a near-complete FIRST pass is not
        // proof of anything — it is one look at a list that moves while you
        // read it. Anything inside the tolerance still earns a second pass,
        // which walks with a different stride and so looks between the seams
        // the first one left. That second pass is where the last handful comes
        // from, and it is the difference between "1,095 of 1,100" and "1,100".
        const effectivelyComplete =
          known && union >= expectedTotal - (pass >= 2 ? tolerance : 0);
        // Otherwise be stubborn: a pass that finds nobody new is NOT proof the
        // list is whole — measured runs go 746, 766, 771, 774, 774, and two
        // identical walks have agreed on 252 of 253 while a third found the
        // straggler. Stopping at the first quiet pass is what produces phantom
        // "new follows" on the next check.
        const short = known && !effectivelyComplete;
        // Re-walking exists to recover people that offset paging skipped, and
        // a record-anchored cursor supposedly cannot skip anyone, so this used
        // to accept a single quiet pass on /followers/ to save the wait at 25
        // rows a page.
        //
        // Reports say otherwise: followers lists come up short the same way
        // following lists do. The cursor being opaque is not evidence that it
        // is record-anchored, and one quiet pass is thin proof either way, so
        // a short list now earns a second pass regardless of cursor type.
        //
        // With no reported count to check against there is nothing that can
        // call a capture complete, so an unknown total earns the same second
        // pass a known-short one does rather than stopping on one quiet walk.
        const quietNeeded = !known || short ? 2 : 1;
        const done = pass >= maxPasses || effectivelyComplete || quiet >= quietNeeded;

        if (!done) {
          post({
            type: 'collect:warn',
            runId: run.id,
            message: `Pass ${pass} done: ${union} unique so far. Re-walking; one pass misses people.`,
          });
        }

        if (done) {
          // Zero accounts is NOT a successful capture. Instagram answers with
          // an empty list — no error, no cursor — for lists it will not serve,
          // and reporting that as "complete" silently produced a finished run
          // with nothing recorded and no explanation.
          if (union === 0) {
            throw new Halt(
              'Instagram returned no accounts for this list. It may be private, ' +
                'restricted, or not visible to your account.',
              'empty'
            );
          }
          post({
            type: 'collect:done',
            runId: run.id,
            reason: 'complete',
            pages: pageIndex,
            total,
            passes: pass,
            reachedEnd,
          });
          return;
        }

        cursor = null;
        seenCursors = new Set();
        emptyStreak = 0;
        // Per-pass: the next pass starts at offset 0 again, so the first page
        // legitimately repeats this pass's first page and must not read as the
        // server ignoring us. `slidingOff` is deliberately NOT reset — once the
        // server has shown it won't honour our offsets, that holds for the run.
        prevPagePks = null;
        stallStreak = 0;
        if (!(await sleepAbortable(2000 + Math.random() * 2000, run))) {
          post({ type: 'collect:done', runId: run.id, reason: 'aborted', pages: pageIndex, total });
          return;
        }
      }
    } catch (e) {
      const halt = e instanceof Halt;
      post({
        type: 'collect:error',
        runId: run.id,
        message: halt ? e.message : `Unexpected error: ${e && e.message ? e.message : e}`,
        kind: halt ? e.kind : 'unknown',
        lastCursor: halt && e.lastCursor ? e.lastCursor : null,
      });
    } finally {
      if (activeRun === run) activeRun = null;
    }
  }

  // --- inbound commands ------------------------------------------------------

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data[IN] !== 1) return;

      const cmd = data.command;
      if (!cmd || typeof cmd !== 'object') return;

      if (cmd.type === 'collect') {
        if (activeRun) {
          post({ type: 'collect:error', runId: cmd.runId, message: 'A collection is already running.', kind: 'busy' });
          return;
        }
        collect(cmd);
      } else if (cmd.type === 'stories') {
        loadStories(cmd);
      } else if (cmd.type === 'diag') {
        diagnose(cmd);
      } else if (cmd.type === 'probe') {
        probeOrders(cmd);
      } else if (cmd.type === 'abort') {
        if (activeRun) activeRun.aborted = true;
      } else if (cmd.type === 'ping') {
        post({ type: 'pong', href: window.location.href, busy: !!activeRun });
      }
    },
    false
  );

  // Posted twice: the bridge lives in another world and its listener may not
  // be registered yet at document_start.
  const announce = () => post({ type: 'ready', href: window.location.href, selfId: selfId() });
  announce();
  setTimeout(announce, 0);
})();
