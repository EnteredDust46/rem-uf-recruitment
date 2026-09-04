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

## Live roster (Google Sheets)

The dashboard is supposed to read the application + attendance sheets **in the
browser** so new UF applicants show up without anyone downloading a CSV. Scores
still save only to `state.json` on the `data` branch — a sheet pull never writes
that file.

**This is not pulling yet.** There is no Google API key in the page. The top bar
will say `not pulling — add GOOGLE_API_KEY` until Adam finishes the setup below.
The baked-in roster in `bootstrap.json.txt` stays visible in the meantime.

Preferred read auth (public dashboard): a Google Cloud **API key** restricted to
the Sheets API and, if the console lets you, those spreadsheet IDs. The three
source sheets must be **Anyone with the link can view** (or the key cannot read
them). Paste the key into `app.js` as `GOOGLE_API_KEY`, split across the two
string literals the same way `GH_TOKEN` is split, then `python assemble_site.py`
and push `main`.

If the sheets must stay private, use the CLI below (service account) or a
service-account GitHub Action as a fallback refresh — that updates `index.html`
on a schedule, which is not the same as live-in-the-product.

### Adam setup (credentials do not exist in this repo)

Do these once. Nothing below is already created for you.

1. [Google Cloud Console](https://console.cloud.google.com/) → new project
   (e.g. `rem-uf-recruitment`).
2. **APIs & Services → Library** → enable **Google Sheets API**, **Google Drive
   API**, and **Google Forms API**.
3. **For the live dashboard (browser reads):**
   - APIs & Services → Credentials → Create credentials → **API key**.
   - Restrict the key to the Sheets API. Optionally restrict it to the
     spreadsheet IDs listed under Sources below.
   - Open each of the three sheets → Share → **Anyone with the link → Viewer**.
   - Split the key into the two `GOOGLE_API_KEY` string literals in `app.js`
     (so GitHub push-protection does not match the unbroken key), assemble,
     commit, push `main`.
4. **For the CLI (pull + push scores):**
   - Credentials → Create → **Service account** (or an OAuth Desktop client if
     you would rather sign in as yourself).
   - Download the JSON. Put it at `secrets/service-account.json` (or set
     `GOOGLE_APPLICATION_CREDENTIALS`). For OAuth, put the client at
     `secrets/client_secret.json` — the first run writes `secrets/token.json`.
   - Copy the service-account email (`…@….iam.gserviceaccount.com`).
   - Share the applications sheet, coffee-chat responses sheet, info-session
     responses sheet, the mastersheet, and the F26 Rem Recruitment Drive folder
     with that email: **Viewer** is enough to pull; **Editor** is required to
     push scores.
5. Install Python 3, then:

```
pip install -r requirements.txt
python refresh.py              # pull → bootstrap.json.txt → assemble_site.py
python refresh.py --commit --push   # only when you intend to ship index.html
python push_scores.py --dry-run
python push_scores.py          # writes UF Screen / First Round / Second Round tabs
python make_csv.py state.json  # same column layouts as the dashboard export
```

`refresh.py` and `push_scores.py` never touch the `data` branch.

### Sources

| What | Sheet / form |
|---|---|
| Applications (UF filter of the national form) | `1M03BJpDREoNr_p_1QfZXzs4xU1fIh6DeDz_VErgqN6g` tab `Sheet1` |
| National form (IMPORTRANGE source) | `1gu164myetDxGxQzZwlecYdauuEHiPpOekfOlYCUiPyQ` tab `Form Responses 1` |
| Coffee chats | `1sIhs4I2i53mmH2cUObWarBDnJ06-nDl53nVflkZAnBo` tab `Form Responses 1` (form `1fXER_btmr2azoT5SbZmY3vzrX3HrNEVaHb2FnOvKNoU`) |
| Info session | Form `1LQ2ca64DFcLUuCMoc3WLSJ4KSwjelWMk2H2LaHyGbBE` writes to the mastersheet tab `Info Session Attendances` |
| Mastersheet (optional push dest) | `1AamE6ob5DW5LhvAVodZsocQiyNz7_P_SLXhFeSmgbkQ` |

Coffee-chat columns: `Timestamp`, `Name`, `UF Email`, `Grade`, `If you went to a Coffee Chat, who did you speak to?`

UF filter: regex `university of florida` (case insensitive). That correctly
keeps "University of Florida" and drops "Florida Atlantic University".

Applicant IDs are preserved by email from the existing `bootstrap.json.txt` so
scores already on the `data` branch stay attached. New people get a new
`a{n}_{hash}` that does not reshuffle older rows.

## Rebuilding after new applications come in
Source lives here as plain files, not just inside `index.html`:
- `build.py` — matching (`find_applicant`), stable IDs, rubrics → `bootstrap.json.txt`.
- `refresh.py` — Sheets API pull, then `build_bootstrap` + `assemble_site.py`.
- `push_scores.py` — write scored rows back to the sheet (match by email).
- `make_csv.py` — same column layouts as the dashboard Export page.
- `sheets_client.py` — service-account / OAuth helper.
- `app.js` — SPA: rendering, grading, GitHub persistence, live Sheets pull.
- `style.css` — styling.
- `assemble_site.py` — inlines `bootstrap.json.txt` + `style.css` + `app.js` into
  `index.html`, which is what GitHub Pages actually serves.

To ship a change: edit the relevant source file(s), run `python assemble_site.py`,
commit `index.html` (and whichever source file changed) to `main`, and push. Saved
scores are unaffected by this — they live in `state.json` on the `data` branch, not in
the page itself. Never commit `secrets/`, `token.json`, or downloaded CSVs.
