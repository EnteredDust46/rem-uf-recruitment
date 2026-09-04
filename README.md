# REM UF Recruitment Dashboard

Live at: https://EnteredDust46.github.io/rem-uf-recruitment/

Single-page review dashboard for REM's Fall 2026 UF chapter recruitment (Application
Screen, First Round, Second Round). Everyone with the link can score applicants; saves
are shared live across all viewers via the GitHub Contents API (see below) rather than
any per-viewer local storage.

## How it saves
The page reads and writes one JSON file, `state.json`, on a separate `data` branch of
this repo (kept off `main` so state writes never trigger a Pages rebuild). All reads and
writes go straight from each viewer's browser to `api.github.com` using a repo-scoped
token embedded in `app.js` (`GH_TOKEN`). There is no push channel from GitHub, so every
viewer polls every 15s and adopts a newer version when it sees one. Writes use the file's
blob `sha` for optimistic concurrency — a losing write refetches the winner, replays its
own not-yet-saved edits on top (see the `pendingOps` queue in `app.js`), and retries.

**The token is visible in the page's JS source to anyone who opens it.** It's scoped to
just this repo with Contents read/write, nothing else. If it ever needs to be rotated,
generate a new fine-grained token (Settings → Developer settings → Personal access
tokens) scoped only to this repo with Contents: Read and write, and swap the `GH_TOKEN`
constant in `app.js`, then commit + push to `main`.

## Rebuilding after new applications come in
Source lives here as plain files, not just inside `index.html`:
- `build.py` — pulls/matches applicant, coffee chat, and info session data, plus rubric
  content, into `bootstrap.json.txt`.
- `app.js` — all SPA logic: rendering, grading math, the GitHub-backed persistence layer.
- `style.css` — styling.
- `assemble_site.py` — inlines `bootstrap.json.txt` + `style.css` + `app.js` into
  `index.html`, which is what GitHub Pages actually serves.

To ship a change: edit the relevant source file(s), run `python3 assemble_site.py`,
commit `index.html` (and whichever source file changed) to `main`, and push. Saved
scores are unaffected by this — they live in `state.json` on the `data` branch, not in
the page itself.
