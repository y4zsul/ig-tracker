# tools/sim — collector and diff simulation

Runs the **shipped** code against a fake Instagram, in headless Chrome. No npm,
no build step, no test framework: the repo has none of those and this does not
introduce any.

Two bugs got through to users because the logic that decides "have we read
enough?" was inline in a 500-line function and could only be exercised by
pointing it at the real Instagram. It now lives in named, pure, top-level
functions, and this lifts them out of the source and runs them.

## Running

```powershell
powershell -File tools\sim\run.ps1 collector   # paging, coverage, head scans
powershell -File tools\sim\run.ps1 ingest      # snapshot diffing
powershell -File tools\sim\run.ps1 parse       # parses + stray control bytes
powershell -File tools\sim\run.ps1 all
```

Exit code is non-zero if any check fails, so this works in a hook or CI.

## How it works

`build.ps1` reads the real `src/interceptor.js` and `src/background.js`, makes
two surgical substitutions, and splices the result into an HTML shell:

- `post()` is redirected from `window.postMessage` to a local sink. Messages
  posted under a `file://` origin never get delivered under `--virtual-time-budget`,
  and this avoids the whole problem.
- `collect` is exposed on `window` so the runner can call it directly.

Everything else — paging, cursor arithmetic, overlap striding, convergence,
head-scan stopping — is the code that ships. If a substitution fails to match,
`build.ps1` throws rather than silently testing something that is not the
product. **If you rename `post()` or `collect()`, this breaks loudly. That is
the point.**

`ingest.ps1` brace-matches named functions out of `background.js` and evals
them against stubbed `state` / `broadcast` / `scheduleSave`.

## The mock

`currentOrder()` re-ranks the list on **every single request** by perturbing a
stable order with gaussian noise. That is the one behaviour that matters: it is
why adjacent paging windows lose people, and why a capture that looks fine
against a static fixture is worthless as evidence.

Configurable per scenario:

| Option | Models |
|---|---|
| `sigma` | How hard Instagram reshuffles between requests |
| `reported` vs `n` | Deactivated accounts: counted by the profile, never listed |
| `tokenCursor` | `/followers/` opaque cursors |
| `bigToken` | Numeric-looking opaque tokens that refuse a cursor they did not issue |
| `ignoreOffset` | A server that discards an offset it did not hand out |
| `dropRate` | Rows withheld from a window at random |
| `newAt` | Accounts added since the last capture, planted at given positions |

## Adding a scenario

Add a row to the `cases` array in the relevant shell and re-run. Keep the
assertion numeric — "captured 1,100 of 1,100" is a regression test, "looks
about right" is not.
