"""Canonical CSV column layouts — same as app.js buildCsv()."""
import csv
import io
import json
import os
import sys
from datetime import date

# Screen headers match the dashboard export. Sheets writes add Email as a match key.
SCREEN_HEADERS = [
    'Name (First Last)', 'Year', 'Academics', 'Resume',
    'Experience & Involvement', 'Leadership & Involvement',
    'Application Essay Rating', 'Notes', 'Who is reviewing this application',
    'Average', 'Attended Coffee Chats', 'Attended Info Session',
]
SCREEN_SHEET_HEADERS = ['Email'] + SCREEN_HEADERS

ROUND1_HEADERS = [
    'Candidate (First & Last) Name', 'Candidates School Email',
    'Fit Q1', 'Fit Q2', 'Fit Q3',
    'Personal Q1', 'Personal Q2', 'Personal Q3',
    'Personality Q', 'Average Score', 'Recommendation', 'Notes',
]

ROUND2_HEADERS = [
    'Candidate (First & Last) Name', 'Case Assigned',
    'Introduction', 'Framework', 'Market Sizing', 'Quant Reasoning',
    'Brainstorming', 'Recommendation Dim', 'Fit & Communication',
    'Final Grade / 24', 'Recommendation', 'Interviewer Notes',
]
ROUND2_SHEET_HEADERS = ['Email'] + ROUND2_HEADERS


def csv_escape_row(row):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(row)
    return buf.getvalue().rstrip('\n')


def screen_row(a, g, group_name, eff, average):
    scores = (g or {}).get('scores') or {}
    att = a.get('attendance') or {}
    return [
        a.get('name') or '',
        a.get('classYear') or '',
        '' if eff('academics') is None else eff('academics'),
        scores.get('resume', ''),
        scores.get('experience', ''),
        scores.get('leadership', ''),
        scores.get('essay', ''),
        (g or {}).get('notes') or '',
        group_name or '',
        '' if average is None else average,
        'Yes' if (att.get('coffeeChats') or []) else 'No',
        'Yes' if att.get('infoSession') else 'No',
    ]


def round1_row(a, g, average):
    scores = (g or {}).get('scores') or {}
    return [
        a.get('name') or '',
        a.get('email') or '',
        scores.get('fit0', ''),
        scores.get('fit1', ''),
        scores.get('fit2', ''),
        scores.get('personal0', ''),
        scores.get('personal1', ''),
        scores.get('personal2', ''),
        scores.get('personality', ''),
        '' if average is None else average,
        (g or {}).get('recommendation') or '',
        (g or {}).get('notes') or '',
    ]


def round2_row(a, g, case_name, total):
    scores = (g or {}).get('scores') or {}
    return [
        a.get('name') or '',
        case_name or '',
        scores.get('introduction', ''),
        scores.get('framework', ''),
        scores.get('market_sizing', ''),
        scores.get('quant_reasoning', ''),
        scores.get('brainstorming', ''),
        scores.get('recommendation', ''),
        scores.get('fit_communication', ''),
        '' if total is None else total,
        (g or {}).get('recommendation') or '',
        (g or {}).get('notes') or '',
    ]


def write_csv(path, header, rows):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main():
    """Optional local dump from bootstrap.json.txt + a state.json file path."""
    if len(sys.argv) < 2:
        print('usage: python make_csv.py <state.json> [outdir]')
        print('Layouts live here for push_scores.py / the dashboard export.')
        return 0
    state_path = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else '.'
    from scoring import attach_scoring

    bootstrap = json.load(open('bootstrap.json.txt', encoding='utf-8'))
    state = json.load(open(state_path, encoding='utf-8'))
    scoring = attach_scoring(bootstrap)
    applicants = bootstrap['applicants']
    grades = state.get('grades') or {}
    groups = state.get('groups') or bootstrap.get('defaultGroups') or []
    assignments = (state.get('assignments') or {}).get('screen') or {}

    stamp = date.today().isoformat()
    os.makedirs(outdir, exist_ok=True)

    screen_rows = []
    for a in applicants:
        g = (grades.get('screen') or {}).get(a['id']) or {'scores': {}}
        if not scoring.has_manual_score(g):
            continue
        grp = next((x for x in groups if x.get('id') == assignments.get(a['id'])), None)
        eff = lambda k, _a=a, _g=g: scoring.eff_score(_a, _g, k)
        avg = scoring.screen_average(g, a)
        screen_rows.append(screen_row(a, g, (grp or {}).get('name'), eff, avg))
    write_csv(os.path.join(outdir, f'rem_uf_screen_{stamp}.csv'), SCREEN_HEADERS, screen_rows)

    r1_rows = []
    for a in applicants:
        g = (grades.get('round1') or {}).get(a['id']) or {'scores': {}}
        if not scoring.has_manual_score(g):
            continue
        r1_rows.append(round1_row(a, g, scoring.round1_average(g)))
    write_csv(os.path.join(outdir, f'rem_uf_round1_{stamp}.csv'), ROUND1_HEADERS, r1_rows)

    cases = {c['id']: c['name'] for c in bootstrap['rubrics']['round2']['cases']}
    r2_rows = []
    for a in applicants:
        g = (grades.get('round2') or {}).get(a['id']) or {'scores': {}}
        if not scoring.has_manual_score(g):
            continue
        tot = scoring.round2_total(g)
        r2_rows.append(round2_row(a, g, cases.get(g.get('caseId')), tot['total'] if tot else None))
    write_csv(os.path.join(outdir, f'rem_uf_round2_{stamp}.csv'), ROUND2_HEADERS, r2_rows)

    print(f'wrote screen={len(screen_rows)} round1={len(r1_rows)} round2={len(r2_rows)} to {outdir}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
