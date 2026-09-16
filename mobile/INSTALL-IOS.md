# Who doesn't follow you back — iPhone / iPad

Chrome extensions don't exist on iOS, so this is a **userscript**: one file that
runs inside Instagram in Safari. Same idea as the desktop extension, one
feature, built for a phone.

It answers one question — **which accounts you follow don't follow you back** —
and it runs entirely on your own device, in your own Instagram session. No
account, no server, nothing uploaded.

## Setup (once, about 3 minutes)

**1. Install the Userscripts app**

Search the App Store for **Userscripts** (by quoid). It's free and open source.

**2. Turn it on in Safari**

Settings → Apps → Safari → Extensions → **Userscripts** → turn it on.
Tap it, then set **instagram.com** to **Allow**. Choose *Always Allow* when
Safari asks, or you'll be re-approving it constantly.

**3. Point the app at a folder**

Open the Userscripts app. The first time, it asks you to choose a folder for
your scripts — anywhere in Files or iCloud Drive is fine. Remember where.

**4. Add the script**

Either:

- **Sent the file?** Save `stalk-that-hoe.user.js` into the folder from step 3.
- **Or paste it:** in the Userscripts app, tap **+** → **New Script**, delete
  the placeholder, and paste the whole file in. Save.

**5. Check it's running**

Open **instagram.com in Safari** (the website, not the app) and log in. Tap the
**aA** on the left of the address bar → **Userscripts** → the script should be
listed as running on this page.

You'll see a small pink **✌︎** button near the bottom-right of Instagram.

## Using it

1. Tap the pink **✌︎** button.
2. Tap **Scan**.
3. Wait. It reads your following list a page at a time and shows progress.

Then you get a list of everyone you follow who doesn't follow you back, each
tappable to open their profile. Two other tabs show **Mutual**, and **Fans**
(people who follow you that you don't follow back) when that's available.

Results are saved on your device, so re-opening it is instant. Tap **Re-scan**
when you want fresh numbers.

## Important: keep the tab open

**iOS suspends background tabs.** While a scan is running, stay on that Safari
tab and keep the screen awake. If you switch apps, the scan pauses and may not
resume.

A few hundred accounts takes well under a minute. Several thousand takes a few
minutes — start it when you can leave the phone alone for a moment.

## How it decides

Instagram often tags each row of your following list with whether that person
follows you back. When it does, the answer comes straight from your following
scan and **nothing is missing** — the script says so.

When Instagram leaves that tag out, the script needs your followers list too
and subtracts one from the other. It'll prompt you. That path is slower and
less reliable, because followers are served **25 at a time** and Instagram
stops paging early on larger accounts — so anyone it never reached would look
like they don't follow you back when they do. The script warns you rather than
pretending the list is complete.

## If something goes wrong

**No ✌︎ button** — make sure you're on instagram.com in *Safari*, not the
Instagram app, and that Userscripts has permission for the site (step 2).
Reload the page.

**"Not logged in"** — log into Instagram in Safari and reload.

**"Instagram is rate limiting"** — you've made too many requests too quickly.
The script waits automatically; leave the tab open. If it keeps happening, stop
and come back in an hour.

**"Instagram wants a security check"** — open the Instagram app and clear
whatever it's asking for, then try again.

## Worth knowing

Scanning means a burst of requests to Instagram from your account. It's paced
to be gentle, but doing it repeatedly in one sitting can get you temporarily
rate limited. Once or twice a day is fine; every five minutes isn't.

Your data lives in Safari's storage for instagram.com. Clearing Safari website
data will erase saved results — the script just re-scans.
