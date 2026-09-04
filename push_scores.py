"""Write dashboard scores back to Google Sheets. Match by email.

Only applicants with at least one hand-entered score (not just auto GPA).
Reads state.json from the GitHub `data` branch. Never writes that file.

  python push_scores.py --dry-run
  python push_scores.py
  python push_scores.py --dest mastersheet
"""
import argparse
import base64
import json
import urllib.request

from build import SOURCES
from make_csv import (
    ROUND1_HEADERS,
    ROUND2_SHEET_HEADERS,
    SCREEN_SHEET_HEADERS,
    round1_row,
    round2_row,
    screen_row,
)
from scoring import attach_scoring
from sheets_client import clear_values, ensure_tab, write_values

GH_OWNER = 'EnteredDust46'
GH_REPO = 'rem-uf-recruitment'
GH_STATE_URL = f'https://api.github.com/repos/{GH_OWNER}/{GH_REPO}/contents/state.json?ref=data'

TABS = {
    'screen': 'UF Screen',
    'round1': 'First Round',
    'round2': 'Second Round',
}


def fetch_state():
    req = urllib.request.Request(
        GH_STATE_URL,
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'rem-uf-push-scores'},
    )
    with urllib.request.urlopen(req) as res:
        payload = json.load(res)
    raw = payload.get('content') or ''
    return json.loads(base64.b64decode(raw.replace('\n', '')).decode('utf-8'))


def dest_sheet_id(dest):
    if dest == 'mastersheet':
        return SOURCES['mastersheetId']
    return SOURCES['applicationsSheetId']


def group_name_for(a, state, bootstrap, round_key='screen'):
    groups = state.get('groups') or bootstrap.get('defaultGroups') or []
    assignments = ((state.get('assignments') or {}).get(round_key)) or {}
    gid = assignments.get(a['id'])
    if not gid:
        return ''
    for g in groups:
        if g.get('id') == gid:
            return g.get('name') or ''
    return ''


def build_tab_rows(round_key, applicants, state, bootstrap, scoring):
    grades = (state.get('grades') or {}).get(round_key) or {}
    cases = {c['id']: c['name'] for c in bootstrap['rubrics']['round2']['cases']}
    rows = []
    for a in applicants:
        email = (a.get('email') or '').strip()
        if not email:
            continue
        g = grades.get(a['id']) or {'scores': {}}
        if not scoring.has_manual_score(g):
            continue
        if round_key == 'screen':
            eff = lambda k, _a=a, _g=g: scoring.eff_score(_a, _g, k)
            avg = scoring.screen_average(g, a)
            rows.append([email] + screen_row(a, g, group_name_for(a, state, bootstrap), eff, avg))
        elif round_key == 'round1':
            rows.append(round1_row(a, g, scoring.round1_average(g)))
        else:
            tot = scoring.round2_total(g)
            rows.append([email] + round2_row(a, g, cases.get(g.get('caseId')), tot['total'] if tot else None))
    return rows


def headers_for(round_key):
    if round_key == 'screen':
        return SCREEN_SHEET_HEADERS
    if round_key == 'round1':
        return ROUND1_HEADERS  # already includes Candidates School Email
    return ROUND2_SHEET_HEADERS


def main():
    p = argparse.ArgumentParser(description='Push scores to Google Sheets (match by email).')
    p.add_argument('--dry-run', action='store_true', help='print counts only; do not write')
    p.add_argument('--dest', choices=['applications', 'mastersheet'], default='applications')
    args = p.parse_args()

    bootstrap = json.load(open('bootstrap.json.txt', encoding='utf-8'))
    state = fetch_state()
    scoring = attach_scoring(bootstrap)
    applicants = bootstrap['applicants']
    sheet_id = dest_sheet_id(args.dest)

    planned = {}
    for key, tab in TABS.items():
        rows = build_tab_rows(key, applicants, state, bootstrap, scoring)
        planned[tab] = (headers_for(key), rows)
        print(f'{tab}: {len(rows)} scored rows')

    if args.dry_run:
        print(f'dry-run — would write to {args.dest} sheet (not writing).')
        return 0

    for tab, (header, rows) in planned.items():
        ensure_tab(sheet_id, tab)
        values = [header] + rows
        end_col = chr(ord('A') + len(header) - 1)
        clear_values(sheet_id, f"'{tab}'!A:{end_col}")
        write_values(sheet_id, f"'{tab}'!A1", values)
        print(f'wrote {len(rows)} rows → {tab}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
