# Stalk That Hoe!

A Manifest V3 Chrome extension that tracks **who an Instagram account starts
following over time**, and dates each new follow to when it was spotted.

No build step, no dependencies, no account, no server. Load the folder into
Chrome and it works.

> **Install instructions for non-developers are in [INSTALL.md](INSTALL.md).**

## What it can and cannot do

Read this part before deciding whether it's useful to you, because most tools in
this space imply more than they deliver.

**Instagram publishes no follow timestamps.** There is no field, in any
endpoint, saying when one account followed another.

**The list order is not chronological.** `/api/v1/friendships/<id>/following/`
returns Instagram's ranked display order. Stripping `search_surface` and
`rank_token` does not change it, invented parameters (`order=date`,
`sort=date_followed`) are ignored, and the GraphQL transport returns the same
order. This was tested, not assumed. The order isn't even stable between two
consecutive requests.

**So a single capture cannot be chronological**, and anything claiming otherwise
is showing you a ranked list with a date-shaped label on it.

**What this does instead** is compare captures over time. An account absent from
one capture and present in the next arrived in between. That's real chronology,
it works on any account you can view, and it only goes forward from your first
capture — nothing before that can ever be dated.

## How it works

```
instagram.com tab
  │
src/interceptor.js   MAIN world, document_start
  ·  harvests Instagram's own API headers from its traffic
  ·  walks /api/v1/friendships/<id>/<kind>/ in your session
  │
src/bridge.js        relays page realm <-> service worker
  │
src/background.js    diffs each capture against the stored history
  │
src/sidepanel.*      home / new stalk / monitor
```

Requests run in a `world: "MAIN"` content script so they are same-origin and
carry your session. API headers (`x-ig-app-id`, `x-asbd-id`, `x-ig-www-claim`,
`x-csrftoken`) are harvested from Instagram's own requests rather than
hardcoded, which is the usual reason tools like this rot.

### Collection quirks worth knowing

These cost real time to discover:

- **`next_max_id` is a positional offset** (`"200"`, `"400"`), not a cursor, and
  there's no `has_more`. A **short page is normal** — a 197-row page still
  advances the offset by 200 — so the only valid terminator is an absent cursor.
- **One pass is not enough.** Instagram re-ranks between requests, so a walk
  skips people who drift behind the read head and repeats people who drift
  forward. The collector re-walks and unions until passes stop finding anyone
  new. Measured convergence: `746 → 766 → 771 → 774 → 774`.
- **`/following/` serves 200 per page; `/followers/` is capped at 25.** Followers
  lists therefore have ~8× more page boundaries and are structurally more
  miss-prone.
- **`web_profile_info` is dead** — HTTP 429 with an HTML body for every
  logged-in session. Handles resolve via
  `/api/v1/web/search/topsearch/?context=blended&query=<name>`, taking the exact
  username match (topsearch is fuzzy). Counts and reverse id→handle lookups come
  from `/api/v1/users/<pk>/info/`.
- **The reported follower count includes deactivated accounts** that are never
  returned, so captures plateau below it. Never treat an exact match as the
  completion condition.

### Telling a real follow from a missed one

Because captures can miss people, an account appearing for the first time might
be a new follow *or* a straggler an earlier walk skipped. The profile's own
following count decides:

```
plausibleNew = max(0, countDelta + departed)
```

If the count didn't move, nobody was followed — anyone newly visible was always
there, and gets folded into the baseline silently rather than reported as new.
If some arrivals are accounted for and some aren't, there's no way to tell which
is which, so the whole batch is flagged **unverified** rather than guessed at.

## Layout

```
manifest.json
INSTALL.md             end-user install guide
icons/
src/interceptor.js     MAIN world: header harvest, collector, pagination
src/bridge.js          two-way relay
src/background.js      run state, history diffing, persistence
src/sidepanel.{html,css,js}
```

## Requirements

Chrome 114+ (side panel, plus `world: "MAIN"` content scripts). Any Chromium
browser at that version or later should work.

## Permissions

- `sidePanel` — the UI
- `storage` + `unlimitedStorage` — captures persist across restarts
- host access to `instagram.com` — the only site it touches

Everything stays local. No account, no backend, no telemetry.

## Rate limiting

Each capture is a burst of requests, and Instagram does throttle accounts that
hammer this endpoint. Pacing is **Safe** (50/page, ~2s) by default, with Fast and
Max available; page size matters more than delay, since requests are what gets
counted. It stops on 401/403, a checkpoint, or a `spam` flag, and backs off
45s → 3m → 7m → 15m on a 429, honouring `Retry-After`. A throttled run keeps
what it collected and can be resumed from its last offset.

Automated collection can conflict with Instagram's terms of service, and a
temporary action block is a real possibility. That's your call to make.

## Contributing

There's no build step and no toolchain. Edit the files, hit reload on
`chrome://extensions`, and refresh your Instagram tab — the content scripts
inject at `document_start`, so the tab must reload for changes to take effect.
