# InstaLurk

A Manifest V3 Chrome extension that tracks **who an Instagram account starts
following over time**, and dates each new follow to when it was spotted.

## How to use

[**Download the zip**](https://github.com/y4zsul/ig-tracker/releases/latest/download/instalurk.zip),
then follow [INSTALL.md](INSTALL.md) — about a minute, no tools needed.

Use that link rather than the green **Code → Download ZIP** button. The green
button hands you the whole repository — source, docs, the phone script — when
all you want is the packaged extension.

<!-- The download link resolves to the newest release's asset, so it never
     needs updating, and GitHub counts every hit on it.

     Two other routes exist and neither is counted: the copy still in
     download/, kept only so links already shared elsewhere keep working, and
     the green Code -> Download ZIP button, which cannot be turned off on a
     public repo. Treat the release number as a floor, not an exact count. -->

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
- **Adjacent windows lose people, and re-walking does not fix it.** Instagram
  re-ranks between requests, so an account sitting at position 250 when
  `[0,200)` is served, which drifts to 150 before `[200,400)` goes out, was
  behind the boundary when it passed and in front of it afterwards — it is
  never returned at all. Every re-walk rebuilds the boundaries in the same
  places, which is why extra passes recovered so little.

  The collector therefore **overlaps its windows**: it asks for `count=200`
  every `stride` positions (50% of a page on the first pass, 35/60/40% after),
  by setting `max_id` itself rather than following `next_max_id`. An account now
  has to move more than `pageSize - stride` places between two consecutive
  requests to escape both windows. The first step is a half stride, because the
  top of the list has no earlier window to overlap with. Simulated against a
  list that re-ranks between every request, adjacent windows captured 98.0-99.6%
  and overlapping ones captured 100% in 25 of 25 runs.

  If the server ever ignores an offset it did not hand out, it answers with the
  window it wanted to send, so the page comes back a near-copy of the previous
  one. Two of those in a row and the walk stops sliding and follows
  `next_max_id` — lossier, but never a loop. `/followers/` returns an opaque
  token rather than an offset, so it cannot be slid and still relies on passes.
- **A completion tolerance is a completion target.** The walk used to stop once
  it was within 2% of the reported count, so a 1,100-following account reliably
  finished ~22 people short and handed those 22 to the next check as "new
  follows". The tolerance is now 0.5%, and it only applies from the second pass
  — reaching the reported count exactly is the only finish a single pass can
  claim. `captureTolerance()` in `background.js` must stay in step with it: too
  strict there and the walk stops at a point the differ calls short, too loose
  and the baseline settles on a capture that was missing people.
- **Passes converge on their own; the cap should not bite.** Measured
  convergence: `746 → 766 → 771 → 774 → 774`. `/followers/` was capped at 3
  passes to save time and was still finding people when it hit the cap, ending
  3-4% short; given six it converged at five and lost nothing.
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

### Nothing is dated until the baseline settles

That check only works once the baseline is trustworthy, so **no account is
dated until the walk has demonstrably converged**. Until then every first
sighting is folded into the baseline, because it is far more likely to be the
collector finally catching someone than a real new follow.

A watch settles on either of two signals:

- a capture came back essentially complete against the reported count, or
- a capture that reached the end of the list found nobody new — which is what
  convergence looks like on a list that permanently plateaus below its reported
  count, since deactivated accounts are counted but never listed.

This is deliberately conservative. Dating arrivals off a baseline that was
still filling in is what produced batches of "new follows" that were never new,
and a delayed first date is a far smaller problem than a confidently wrong one.

## On your phone

Chrome extensions don't exist on mobile, so the phone version is a **userscript**
— one file (`mobile/instalurk.user.js`) that a script manager runs inside
Instagram. Same engine, one self-contained file, no extension needed.

It works because the script runs *inside* the instagram.com page, so the browser
attaches your session itself. Nothing is uploaded and there's no account.

It does five things: **My account** (who doesn't follow you back), **Start a new
stalk**, **Monitor a user**, **Compare two accounts**, and **Watch stories
quietly**.

> Your phone data is separate from your desktop data. Nothing syncs between them.

---

### iPhone and iPad

**Step 1 — install the script manager**

App Store → search **Userscripts** (by quoid) → install. It's free and open
source.
✅ *Check:* a grey **Userscripts** icon is on your home screen.

**Step 2 — enable it in Safari**

Settings → Apps → Safari → Extensions → **Userscripts** → turn the switch on.
(On iOS 16 and older: Settings → Safari → Extensions.)
✅ *Check:* the switch is green.

**Step 3 — give it a folder**

Open the **Userscripts app**. On first run it asks you to choose a directory —
accept the default `Userscripts` folder under *On My iPhone*, or pick your own.
✅ *Check:* the app shows a file list instead of the "choose a directory" prompt.

> The app itself is only a folder picker. Don't look for a **+** in it — the
> editor lives in the Safari popup, and you won't need either.

**Step 4 — allow it on Instagram**

iOS grants site access *from the page*, not from Settings, so instagram.com
won't be listed until you do this:

- Open **instagram.com in Safari** and log in
- Tap **аА** at the **left end of the address bar**
- Tap **Userscripts** → choose **Always Allow on This Website**

✅ *Check:* tapping **аА** → **Userscripts** again no longer asks for permission.

**Step 5 — download the script**

In Safari, open:

```
github.com/y4zsul/ig-tracker/blob/main/mobile/instalurk.user.js
```

- **Long-press the "Raw" button** → **Download Linked File**
- Tap the **⬇ downloads arrow** right of the address bar
- Tap the **magnifying glass** next to `instalurk.user.js` — it opens in Files

✅ *Check:* you can see `instalurk.user.js` in the Files app.

**Step 6 — move it into the folder**

**Long-press the file → Move** → navigate to the folder from step 3
(`On My iPhone → Userscripts`) → **Move**.
✅ *Check:* opening the Userscripts app now lists the file.

**Step 7 — turn the script on**

Back on instagram.com, tap **аА** → **Userscripts**. You should see
**InstaLurk** listed. **If it's greyed out, tap it** — greyed means
disabled.
✅ *Check:* it shows the full name (not the filename) and isn't greyed.

**Step 8 — reload**

**Pull down to refresh** Instagram. Scripts only inject on page load.
✅ *Check:* a pink **👀** button appears near the bottom-right.

---

### Android

Easier than iOS — installing is a single tap.

**Step 1 — install Firefox**

Play Store → **Firefox** (Chrome on Android can't run extensions).
✅ *Check:* Firefox opens.

**Step 2 — install Violentmonkey**

In Firefox, open `addons.mozilla.org/firefox/addon/violentmonkey/` → **Add to
Firefox** → **Add**. (Tampermonkey works too.)
✅ *Check:* Firefox menu (⋮) → **Extensions** lists Violentmonkey.

**Step 3 — install the script**

In Firefox, open:

```
raw.githubusercontent.com/y4zsul/ig-tracker/main/mobile/instalurk.user.js
```

Violentmonkey intercepts it and shows an install page → tap **Install**.
✅ *Check:* the confirmation says **InstaLurk** with a version number.

**Step 4 — open Instagram**

Go to **instagram.com** in Firefox and log in. Use the website, not the app.
✅ *Check:* a pink **👀** button appears near the bottom-right.

---

### Using it

Tap **👀** to open. **You can drag the button anywhere** — it remembers where
you put it, which matters because browser toolbars sit in different places.

| Screen | What it does |
| --- | --- |
| **My account** | Scan → who you follow that doesn't follow you back, plus Mutuals and Fans |
| **Start a new stalk** | Enter a username → records who they follow now, as a baseline |
| **Monitor a user** | Pick someone stalked → **Check now** → who they've added since, grouped by check |
| **Compare two accounts** | Overlap between two captures. Costs no requests |
| **Watch stories quietly** | Loads a story without sending a seen receipt. **Save story** keeps the photo or video |

**Keep the tab open while scanning.** Phones suspend background tabs — switch
apps mid-scan and it stalls. A few hundred accounts takes under a minute.

**The first capture has no order.** Instagram never says when a follow happened,
so a baseline is just a set. Only accounts appearing *after* it can be dated,
which is what Monitor shows.

### Updating the phone version

**Android:** open the raw link again and Violentmonkey offers to update.

**iPhone:** delete the old `instalurk.user.js` from `On My iPhone →
Userscripts` **first**, then repeat steps 5 and 6. Two files sharing a name will
confuse it. Check the version in the Userscripts popup to confirm it took.

### If something goes wrong

| Symptom | Cause |
| --- | --- |
| No 👀 button | Not on instagram.com in the right browser, script disabled, or the page wasn't reloaded |
| "Not logged in" | Log into Instagram in that browser and reload |
| "Instagram is rate limiting" | Too many requests. It waits automatically — leave the tab open |
| "Instagram wants a security check" | Clear it in the Instagram app, then retry |
| "Instagram won't show this list" | The account is private and you don't follow them |

## Layout

```
manifest.json
INSTALL.md             end-user install guide
icons/
src/interceptor.js     MAIN world: header harvest, collector, pagination
src/bridge.js          two-way relay
src/background.js      run state, history diffing, persistence
src/sidepanel.{html,css,js}
mobile/instalurk.user.js   the phone version, one self-contained file
```

`mobile/` is not referenced by `manifest.json` and is not in the downloadable
zip, so it has no effect on the extension even if you load the whole repo
unpacked.

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
hammer this endpoint. All three speeds request **200 rows a page**; they differ
only in the pause between requests (Safe ~2s, Fast ~0.6s, Max none).

Page size is a correctness setting, not a speed one. Every page boundary is a
chance for Instagram to re-rank underneath the walk and hide somebody behind
the read head, so 1,100 accounts at 50 a page gives 22 opportunities to lose
people where 200 a page gives 6. Smaller pages also mean *more* requests, which
is what rate limiting actually counts. Safe used to mean 50 a page, which made
the option everyone is told to use both the most lossy and the most
throttle-prone. It stops on 401/403, a checkpoint, or a `spam` flag, and backs off
45s → 3m → 7m → 15m on a 429, honouring `Retry-After`. A throttled run keeps
what it collected and can be resumed from its last offset.

Automated collection can conflict with Instagram's terms of service, and a
temporary action block is a real possibility. That's your call to make.

## Contributing

There's no build step and no toolchain. Edit the files, hit reload on
`chrome://extensions`, and refresh your Instagram tab — the content scripts
inject at `document_start`, so the tab must reload for changes to take effect.

## Releases

Each version is published as a [release](https://github.com/y4zsul/ig-tracker/releases)
with `instalurk.zip` attached. Cutting one per version is what makes the
download numbers work, and it shows which versions people are actually on.

```
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Then attach `download/instalurk.zip` to the release on GitHub. Counts are on
the releases page, or run `tools/downloads.ps1`.
