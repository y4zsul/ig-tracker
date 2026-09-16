# Stalk That Hoe! — iPhone / iPad

Chrome extensions don't exist on iOS, so this is a **userscript**: one file that
runs inside Instagram in Safari. Everything happens on your own device, in your
own Instagram session. No account, no server, nothing uploaded.

Three things:

- **My account** — who you follow that doesn't follow you back
- **Start a new stalk** — record who someone follows right now
- **Monitor a user** — who they've added since, dated to when you checked

## Setup (once, about 3 minutes)

**1. Install the Userscripts app**

App Store → **Userscripts** (by quoid). Free and open source.

**2. Turn it on in Safari**

Settings → Apps → Safari → Extensions → **Userscripts** → turn it on.
(On iOS 16 and older: Settings → Safari → Extensions.)

**3. Give it access to Instagram**

iOS doesn't pre-list websites — you grant access *from the page*:

- Open **instagram.com** in Safari
- Tap **аА** at the left of the address bar → **Userscripts**
- Choose **Always Allow on This Website**

**4. Point the app at a folder**

Open the Userscripts app. If it hasn't got a directory yet, pick one — the
default `Userscripts` folder under *On My iPhone* is fine.

**5. Add the script**

- In Safari, open
  `github.com/y4zsul/ig-tracker/blob/main/mobile/stalk-that-hoe.user.js`
- **Long-press the "Raw" button → Download Linked File**
- Tap the downloads arrow (⬇, right of the address bar) → the magnifying glass
  next to the file → it opens in Files
- **Long-press → Move** → into the folder from step 4

**6. Check it's on**

Open instagram.com, tap **аА** → **Userscripts**. The script should be listed
as **Stalk That Hoe!** and not greyed out — if it is greyed, tap it to enable.

Then **pull down to refresh**. A pink **✌︎** appears near the bottom-right.

## Using it

Tap **✌︎** to open it.

**My account** → Scan. Reads your following list and shows who doesn't follow
you back, plus Mutual and (when available) Fans.

**Start a new stalk** → type a username → Start. That first capture is the
**baseline**: it records who they follow right now. It has no order, because
Instagram never says when a follow happened.

**Monitor a user** → pick someone you've stalked → **Check now**. Anyone they've
added since your last check appears, grouped under the date you found them.
Only the newest group is badged as new.

Accounts under one date were all found by that single check — they're not in
order relative to each other, and the app says so rather than implying a
sequence that doesn't exist.

## Keep the tab open while it scans

**iOS suspends background tabs.** Stay on that Safari tab with the screen awake
while a scan runs. Switching apps will stall it.

A few hundred accounts takes well under a minute. Several thousand takes a few
minutes.

## Things it will tell you

**"unverified"** on a new account means the previous capture came up short, so
that person may have been followed long ago and simply missed rather than
newly added.

**"missed by an earlier scan — added to the baseline"** means the profile's
follow count didn't change, so nobody was actually followed. Those accounts get
folded into the baseline instead of being reported as new.

Both exist because Instagram reshuffles these lists between requests, so a
single pass can skip people. The script re-walks and combines passes to reduce
it, and is honest about what's left.

## If something goes wrong

**No ✌︎** — check you're on instagram.com in *Safari* (not the app), that
Userscripts has permission (step 3), and that the script isn't greyed out.
Reload the page.

**"Not logged in"** — log into Instagram in Safari and reload.

**"Instagram is rate limiting"** — too many requests too quickly. It waits
automatically; leave the tab open. If it keeps happening, come back in an hour.

**"Instagram wants a security check"** — open the Instagram app, clear whatever
it's asking, then retry.

**"Instagram won't show this list"** — the account is private and you don't
follow them, or they've restricted who can see it.

## Worth knowing

Scanning is a burst of requests from your account. It's paced to be gentle, but
repeating it constantly can get you temporarily rate limited. Once or twice a
day is fine.

Results live in Safari's storage for instagram.com. Clearing Safari website data
erases them — including baselines, which can't be recreated retroactively.
