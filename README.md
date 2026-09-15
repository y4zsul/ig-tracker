# IG Follow Order

A Manifest V3 Chrome extension that recovers Instagram follower/following lists
in **true follow order** — newest follow first — and shows them in a Chrome Side
Panel with search, order verification, and CSV/JSON export.

No timestamps are involved. There is no timestamp to be had. What makes the
order chronological is *where the list comes from*.

## What Instagram does and does not give you

**Tested, not assumed:**

- Instagram publishes **no follow timestamp**, anywhere, for anyone.
- `/api/v1/friendships/<pk>/<kind>/` returns the **ranked display order**, with
  or without `search_surface`/`rank_token`, and ignores invented ordering
  params (`order=date`, `sort=date_followed`, `enable_groups=false`). The
  GraphQL transport gives the same order.
- The order is not even stable between consecutive requests — Instagram
  re-ranks mid-walk, so one pass both repeats and misses people.

So **a single capture cannot be chronological**, and no endpoint tuning changes
that. Extensions that do show correct chronological order get it by
**comparing captures over time** — an account absent from one capture and
present in the next arrived in between. That is the only chronology available,
and this extension builds it locally.

### Timeline

Capture a list once to lay down a **baseline** (everyone already there; arrival
order genuinely unknown, and shown as `base` rather than given a fake date).
Capture it again later and anyone new is **dated to when they appeared**.
Accounts that vanish from a complete capture are marked `gone`.

Resolution equals how often you capture. Nothing before your first capture can
ever be dated — not by this tool, and not by any other.

## Collection mechanics

Getting a *complete* list is its own problem, separate from ordering. These
behaviours were verified against a working implementation and cost real time to
rediscover:

```
GET /api/v1/friendships/<user_id>/<followers|following>/?count=N[&max_id=<offset>]
```

- **`next_max_id` is a positional offset** (`"200"`, `"400"`), not an opaque
  cursor. There is no `has_more` or `page_info`.
- **Short pages are normal.** A 197-row page still advances the offset by the
  full 200. Terminating on a short page truncates the list; the only valid
  terminator is an *absent* cursor.
- **`/following/` honours `count=200`; `/followers/` is pinned to 25**
  server-side no matter what you ask for.
- **One pass is not enough.** Because Instagram re-ranks between requests, a
  single walk lands ~94-99%. The collector re-walks and unions until a pass
  finds nobody new.
- **`web_profile_info` is dead** — HTTP 429 with an HTML body for every
  logged-in session. Handles resolve through
  `/api/v1/web/search/topsearch/?context=blended&query=<name>` instead, taking
  the *exact* username match (topsearch is fuzzy: "jane" returns "janedoe123").
- **Counts** come from `/api/v1/users/<pk>/info/`.
- `special_empty_state` means Instagram refuses that list to everyone — never
  render it as "follows nobody".

Requests run in a `world: "MAIN"` content script so they are same-origin and
carry your session, with API headers harvested from Instagram's own traffic
rather than hardcoded.

### Resolving a handle to an id

The collector needs the target's numeric id. `web_profile_info` is the obvious
way to get one and it is **unreliable** — it frequently answers with Instagram's
HTML "Page Not Found" shell under an HTTP 429, which is a routing failure
dressed as a rate limit. So it is now the last resort, not the first step:

1. A **numeric id typed directly** into the username box.
2. An id **learned passively from browsing**. Instagram calls
   `web_profile_info` itself whenever you open a profile, and the followers
   modal pairs a numeric id with the handle in the URL — the interceptor reads
   both as you browse and remembers them. Visiting a profile once is enough.
3. `web_profile_info`, called by us, only if the first two came up empty.

So if a handle won't resolve: **open that profile on instagram.com once**, then
try again.

### Reading a failure correctly

An HTTP status alone is not enough to classify a failure on this API, so the
body is read *before* the status is branched on. An HTML body means the request
never reached the API at all — reported as such, never as a rate limit. Only a
429 carrying JSON is treated as genuine throttling.

The **Test** button makes one request against each endpoint and prints what was
sent and what came back:

```
x-ig-app-id   936619743392459  (harvested)
x-csrftoken   present
ds_user_id    72763411747
known id      50269821
lookup  @someone
  HTTP 429 — HTML "Page Not Found" (not the API)
friendships (the endpoint that matters)
  HTTP 200 — 1 user(s), cursor yes
```

That example is a working setup: the lookup is broken but irrelevant, because
the id is already known. The friendships probe is the one that decides whether
collection can run.

### Why it runs in the page

The collector executes in a `world: "MAIN"` content script rather than in the
service worker, so that requests are same-origin and carry your session
cookies, the right `Referer`, and the exact API headers Instagram's own client
uses. Those headers (`x-ig-app-id`, `x-asbd-id`, `x-ig-www-claim`,
`x-csrftoken`) are *harvested* from Instagram's own traffic by wrapping
`fetch`/`XMLHttpRequest` at `document_start`, rather than hardcoded — hardcoded
app ids are the usual reason these tools break.

## Don't trust the ordering — verify it

The claim "unranked means chronological" is load-bearing, so the extension
tests it instead of assuming it. Collect the same list twice, some time apart,
and hit **Verify order**.

If the order really is the follow sequence, then between two runs:

- everyone present in **both** runs must appear in the **same relative order** —
  zero inversions; and
- anyone **new** can only appear **above** them, never in the middle.

A ranked list cannot survive that test: affinity ranking reshuffles the stable
set between runs. The panel reports the shared count, the inversion count, the
first place the sequence breaks, and one of three verdicts:

| Verdict | Meaning |
| --- | --- |
| **consistent** | 0 inversions, new entries all at top — order behaved exactly as a follow sequence must |
| **unstable** | the shared set reshuffled — the order is *not* chronological, don't rely on it |
| **inconclusive** | fewer than 5 accounts shared between runs |

Separately, whenever you have also opened the Instagram modal for the same
list, the panel shows how far the **ranked** modal order departs from the
collected order. That is the mechanism made visible: a high inversion count
there is the ranking you're bypassing.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Chrome 114+ required (side panel + `world: "MAIN"` content scripts).

## Use

1. Open a tab on `instagram.com` and be logged in. Leave it open — the
   collector runs inside it.
2. Click the toolbar icon to open the side panel.
3. Type a username, pick **Followers** or **Following**, pick a pacing, **Fetch**.
4. Rank 1 is the most recent follow. Search, flip to oldest-first, export.

Works on any profile whose list you can already see: public accounts, and
private accounts you follow. A private account you don't follow is refused
up front rather than failing halfway.

## Rate limiting

Walking a follower list means one request per page, and Instagram does take
action against accounts that hammer this endpoint. The collector is
deliberately conservative:

| Pacing | Page size | Delay between pages |
| --- | --- | --- |
| Glacial | 25 | ~9s + jitter |
| Very safe | 25 | ~4s + jitter |
| Safe (default) | 50 | ~2s + jitter |
| Normal | 100 | ~1.2s + jitter |
| Fast | 200 | ~0.6s + jitter |
| Max | 200 | none |

**Page size matters more than delay.** Requests are what gets throttled, not
elapsed time, so a honoured `count=200` costs a quarter of the requests of
`count=50` for the same list. Instagram silently caps `count`, though — so
after a run the panel reports the largest page actually served
(`served 50/page (asked 200)`), which is the number to tune against. Find the
real cap first, then back the delay off.

Plus a 3× longer pause every 10 pages, and randomised jitter on every delay so
the traffic isn't metronomic. It **stops immediately** on HTTP 401/403, a
checkpoint/challenge response, or a `spam` flag.

A 10,000-follower account is ~200 pages, so roughly 7–10 minutes on Safe. Let
it run. Partial results are kept and remain correctly ordered — a run that
stopped early is still an exact prefix of the sequence.

### When you hit HTTP 429

Instagram's throttle window on this endpoint is **minutes, not seconds**, so
the collector waits accordingly: **45s → 3m → 7m → 15m**, honouring a
`Retry-After` header when one is sent, and picking whichever is longer. Stop
stays responsive throughout a long backoff (the wait runs in 1s slices) and the
panel counts down.

If all four attempts are exhausted the run is kept as **partial** and becomes
**resumable**:

1. Ideally leave it 15+ minutes — resuming inside the throttle window usually
   just re-trips it. The panel warns when you're still inside that window but
   does not stop you.
2. Consider a slower pacing, or a larger page size if the cap allows it.
3. Hit **Resume from N**.

Resume continues from the stored `next_max_id` and appends into the *same* run,
so `followRank` stays continuous and you never re-walk pages you already have.
Re-walking from page 1 after a throttle is the single worst thing you can do to
an already-throttled account, which is exactly why this exists.

If you get a 429 on the *first* request, run **Test** before concluding
anything. A first-request 429 is more often the `web_profile_info` HTML
failure above than a real throttle, and the fix for that one is to visit the
profile rather than to wait.

**This is your call to make.** Automated collection can conflict with
Instagram's terms of service, and the risk of a temporary action block is real
even when paced. Nothing here hides what it is doing, and nothing blocks you
from going fast — the guard rails are advisory, not enforced.

## Exports

**CSV** exports the rows currently on screen, in the order shown, while
`follow_rank` always holds the true sequence position:

```
follow_rank,page_index,index_in_page,pk,username,full_name,is_private,is_verified,profile_url,target,kind,collected_at
```

UTF-8 with BOM for Excel; values starting `=`, `+`, `-`, `@` get a `'` prefix to
defuse formula injection.

**JSON** exports every user object exactly as the server returned it, plus the
full cursor chain (`max_id` in / `next_max_id` out for every page) so the
pagination is auditable after the fact.

## Files

```
manifest.json
icons/                 generated gradient list-mark, 16/32/48/128
src/interceptor.js     MAIN world: header harvest, collector engine, ranked-modal capture
src/bridge.js          two-way relay, page realm <-> service worker
src/background.js      run state, rank assignment, verification, persistence
src/sidepanel.html     panel markup
src/sidepanel.css      panel styling, light + dark
src/sidepanel.js       virtual list, search, export, verification UI
```

## Design notes

- **`followRank` is assigned once** and never recomputed, so no sort in the UI
  can corrupt the captured sequence. Search and oldest-first are pure views.
- **Duplicates** keep their original rank and are counted, not re-appended.
  Instagram occasionally repeats an entry across a page boundary.
- **Completeness check.** After a run finishes, the collected count is compared
  against the follower count the profile reports. A small shortfall is normal
  (deactivated accounts are counted but not listed); a large one raises a
  warning that pages were lost.
- **The virtual list** renders only the visible window at a fixed 52px row
  height, so a 100k-row run scrolls without lag.
- Avatars are deliberately not rendered — that would mean the panel making its
  own requests to Instagram's CDN for every row.
- Runs cap at 100,000 users.

## Limits

- **Not retroactive beyond what the endpoint holds.** The order comes from the
  live endpoint; there is no history before your first run.
- **Deleted/deactivated accounts** occupy a follow slot but aren't returned, so
  ranks are dense over *visible* accounts, not over all historical follows.
- **A run is a snapshot.** Follows landing mid-run can shift the pagination
  window. If the completeness check warns, or Verify reports instability,
  re-run it.
- The private API is undocumented and changes without notice. If collection
  breaks, the response shape moved — `extractUsers()` in
  `src/interceptor.js` is the one place to update.
- After editing any file: **Reload** on `chrome://extensions`, then refresh the
  Instagram tab (the agent must be injected before the page's JS runs).
