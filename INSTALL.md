# Stalk That Hoe! — install

Chrome only (or Edge/Brave/Opera — anything Chromium). Takes about a minute.

## 1. Unzip it

Unzip `stalk-that-hoe.zip` somewhere **permanent** — Documents is fine, Downloads
is not. Chrome loads the extension from this folder every time it starts, so if
the folder moves or gets deleted, the extension breaks.

You should end up with a folder containing `manifest.json`, `src/` and `icons/`.

## 2. Load it into Chrome

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the folder you unzipped (the one with `manifest.json` in it)

It should appear as **Stalk That Hoe!**

## 3. Pin it

Click the puzzle-piece icon in the toolbar, then the pin next to Stalk That Hoe!
so it's always one click away.

## 4. Use it

1. Open **instagram.com** in a tab and make sure you're logged in. Leave that
   tab open — the extension reads through your own session, from your own
   browser.
2. Click the extension icon to open the side panel.
3. **Start a new stalk** → type a username → **Start stalk**.

The first capture is a baseline: it records who they follow right now, listed
A–Z. Come back later, choose **Monitor a user**, and hit **Check now** — anyone
they've added since shows up, dated to when you checked.

## Things worth knowing

**The first capture takes a while.** It walks the whole list several times over,
because Instagram reshuffles between requests and a single pass misses people.
A few thousand accounts can take several minutes. Let it run.

**Instagram doesn't publish follow dates.** Nobody can tell you the order
someone followed people in — not this, not any other tool. What this does is
compare captures over time, so anything added *after* your first capture gets a
real date. Everything from before is listed as baseline, unordered, because
there is genuinely no way to know.

**It only sees lists you can already see.** Public accounts, and private ones you
follow. A private account you don't follow is refused up front.

**Go easy.** Each capture is a burst of requests against Instagram, and hammering
it can get an account temporarily rate-limited. Stick to **Safe** unless you have
a reason not to, and don't re-check the same person over and over in one sitting.
If you get a rate-limit message, wait 15 minutes.

## If something breaks

- **"Open a tab on instagram.com first"** — you need a logged-in Instagram tab
  open in the same window.
- **Nothing happens when you click** — go to `chrome://extensions`, click the
  reload arrow on the extension card, then refresh your Instagram tab.
- **Chrome nags about developer mode on startup** — normal for extensions
  installed this way. Dismissing it is safe.
- **It disappeared after restarting Chrome** — the folder moved or was deleted.
  Put it back and load it again.

## Privacy

Everything stays in your browser. No account, no server, no sign-in. It reads
Instagram using the session you're already logged into and stores what it finds
in Chrome's local storage on your own machine. Nothing is uploaded anywhere.
