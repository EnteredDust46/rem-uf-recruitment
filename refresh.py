"""Pull applications + attendance from Google Sheets, rebuild bootstrap, assemble the site.

Does not touch state.json or the `data` branch.

  python refresh.py
  python refresh.py --apps-csv path --coffee-csv path --info-csv path
  python refresh.py --commit
  python refresh.py --commit --push
"""
import argparse
import csv
import json
import os
import subprocess
import sys
from datetime import date

from build import SOURCES, build_bootstrap, is_uf, load_existing_ids, write_bootstrap
from sheets_client import (
    a1_range,
    find_info_session_sheet,
    read_values,
    resolve_form_response_sheet,
)

# Applications columns (exact order on FL2026 Rem Applications - UF / Sheet1).
APP_FIELDS = [
    'timestamp', 'name', 'email', 'phone', 'gender', 'race', 'linkedin', 'resume',
    'university', 'gradYear', 'major', 'minor', 'gpa', 'whyRem', 'coreValue',
    'valueEssay', 'careerInterests', 'howRemHelps', 'position', 'skills',
    'accommodations', 'other', 'commitment',
]


def cell(row, i):
    return row[i] if i < len(row) else ''


def parse_applications(values):
    if not values:
        return []
    rows = values[1:]
    out = []
    for r in rows:
        rec = {field: cell(r, i).strip() if isinstance(cell(r, i), str) else cell(r, i)
               for i, field in enumerate(APP_FIELDS)}
        if rec['name'] or rec['email']:
            out.append(rec)
    return out


def _header_index(headers, *needles):
    low = [(h or '').lower() for h in headers]
    for i, h in enumerate(low):
        if all(n in h for n in needles):
            return i
    return -1


def parse_coffee(values):
    """Headers: Timestamp, Name, UF Email, Grade, If you went to a Coffee Chat, who did you speak to?"""
    if not values:
        return []
    headers = values[0]
    i_ts = _header_index(headers, 'timestamp')
    i_name = _header_index(headers, 'name')
    i_email = _header_index(headers, 'email')
    i_spoke = _header_index(headers, 'spoke')
    if i_spoke < 0:
        i_spoke = _header_index(headers, 'who did you')
    out = []
    for r in values[1:]:
        rec = {
            'timestamp': cell(r, i_ts) if i_ts >= 0 else '',
            'name': cell(r, i_name) if i_name >= 0 else '',
            'email': cell(r, i_email) if i_email >= 0 else '',
            'spokeTo': cell(r, i_spoke) if i_spoke >= 0 else '',
        }
        if rec['name'] or rec['email']:
            out.append(rec)
    return out


def parse_meet(values):
    if not values:
        return []
    headers = values[0]
    i_ts = _header_index(headers, 'timestamp')
    i_name = _header_index(headers, 'name')
    i_email = _header_index(headers, 'email')
    i_year = _header_index(headers, 'year')
    i_applied = _header_index(headers, 'applied')
    out = []
    for r in values[1:]:
        rec = {
            'timestamp': cell(r, i_ts) if i_ts >= 0 else '',
            'name': cell(r, i_name) if i_name >= 0 else '',
            'email': cell(r, i_email) if i_email >= 0 else '',
            'year': cell(r, i_year) if i_year >= 0 else '',
            'appliedBefore': cell(r, i_applied) if i_applied >= 0 else '',
        }
        if rec['name'] or rec['email']:
            out.append(rec)
    return out


def parse_info(values):
    if not values:
        return []
    headers = values[0]
    i_ts = _header_index(headers, 'timestamp')
    i_name = _header_index(headers, 'name')
    i_email = _header_index(headers, 'email')
    i_session = _header_index(headers, 'session')
    if i_session < 0:
        i_session = _header_index(headers, 'which')
    i_applied = _header_index(headers, 'applied')
    out = []
    for r in values[1:]:
        rec = {
            'timestamp': cell(r, i_ts) if i_ts >= 0 else '',
            'name': cell(r, i_name) if i_name >= 0 else '',
            'email': cell(r, i_email) if i_email >= 0 else '',
            'session': cell(r, i_session) if i_session >= 0 else '',
            'appliedBefore': cell(r, i_applied) if i_applied >= 0 else '',
        }
        if rec['name'] or rec['email']:
            out.append(rec)
    return out


def resolve_info_sheet():
    sid = SOURCES.get('infoSessionResponsesSheetId') or ''
    if sid:
        return sid
    form_title = SOURCES.get('infoSessionFormTitle') or 'Rem Information Session Fall 2026'
    found_id, found_name = find_info_session_sheet(form_title)
    if found_id:
        print(f'info session sheet discovered: {found_name}')
        return found_id
    return ''


def values_from_csv(path):
    with open(path, newline='', encoding='utf-8-sig') as f:
        return [list(row) for row in csv.reader(f)]


def attendance_from_bootstrap(path='bootstrap.json.txt'):
    """Last-known coffee/info rows so a failed attendance download does not wipe matches."""
    if not os.path.exists(path):
        return [], []
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    coffee, info = [], []
    for a in data.get('applicants') or []:
        att = a.get('attendance') or {}
        name, email = a.get('name') or '', a.get('email') or ''
        for c in att.get('coffeeChats') or []:
            coffee.append({
                'timestamp': c.get('timestamp') or '',
                'name': name,
                'email': email,
                'spokeTo': c.get('spokeTo') or '',
            })
        inf = att.get('infoSession')
        if inf:
            info.append({
                'timestamp': inf.get('timestamp') or '',
                'name': name,
                'email': email,
                'session': inf.get('session') or '',
                'appliedBefore': inf.get('appliedBefore') or '',
            })
    return coffee, info


def pull_rows():
    apps_id = SOURCES['applicationsSheetId']
    apps_tab = SOURCES.get('applicationsTab') or 'Sheet1'
    coffee_id = SOURCES['coffeeChatResponsesSheetId']
    coffee_tab = SOURCES.get('coffeeChatTab') or 'Form Responses 1'

    # Prefer the explicit coffee tab (mastersheet is richer than the dedicated form sheet).

    info_id = resolve_info_sheet()
    info_tab = SOURCES.get('infoSessionTab') or 'Form Responses 1'

    print('pulling applications…')
    app_values = read_values(apps_id, a1_range(apps_tab))
    print('pulling coffee chats…')
    coffee_values = read_values(coffee_id, a1_range(coffee_tab))
    info_values = []
    if info_id:
        print('pulling info session…')
        info_values = read_values(info_id, a1_range(info_tab))
    else:
        print('info session sheet not found — attendance stays as last baked into bootstrap.')
        print('  Share the responses sheet and set sources.infoSessionResponsesSheetId.')

    meet_id = SOURCES.get('meetMembersSheetId') or ''
    meet_tab = SOURCES.get('meetMembersTab') or 'Form Responses 1'
    meet_values = []
    if meet_id:
        print('pulling Meet the Members…')
        meet_values = read_values(meet_id, a1_range(meet_tab))

    return parse_applications(app_values), parse_coffee(coffee_values), parse_info(info_values), parse_meet(meet_values)


def assemble_site():
    if os.path.exists('assemble_site.py'):
        subprocess.check_call([sys.executable, 'assemble_site.py'])
    else:
        raise SystemExit('assemble_site.py is missing')


def git(*args):
    return subprocess.check_call(['git'] + list(args))


def load_from_csvs(apps_csv, coffee_csv, info_csv):
    if not apps_csv or not os.path.exists(apps_csv):
        raise SystemExit('applications CSV is required')
    applicants_raw = parse_applications(values_from_csv(apps_csv))
    boot_coffee, boot_info = attendance_from_bootstrap()
    if coffee_csv and os.path.exists(coffee_csv):
        coffee_raw = parse_coffee(values_from_csv(coffee_csv))
        print(f'coffee from CSV ({len(coffee_raw)} rows)')
    else:
        coffee_raw = boot_coffee
        print(f'coffee CSV missing — keeping last-known attendance ({len(coffee_raw)} rows)')
    if info_csv and os.path.exists(info_csv):
        info_raw = parse_info(values_from_csv(info_csv))
        print(f'info from CSV ({len(info_raw)} rows)')
    else:
        info_raw = boot_info
        print(f'info CSV missing — keeping last-known attendance ({len(info_raw)} rows)')
    return applicants_raw, coffee_raw, info_raw


def main():
    p = argparse.ArgumentParser(description='Rebuild the dashboard roster from Google Sheets.')
    p.add_argument('--commit', action='store_true', help='git add + commit assembled files on the current branch')
    p.add_argument('--push', action='store_true', help='git push (requires --commit; never force-push, never touches data)')
    p.add_argument('--apps-csv', help='applications Form Responses CSV (PII; do not commit)')
    p.add_argument('--coffee-csv', help='coffee chat Form Responses CSV')
    p.add_argument('--info-csv', help='info session attendances CSV')
    p.add_argument('--meet-csv', help='Meet the Members Form Responses CSV')
    args = p.parse_args()
    if args.push and not args.commit:
        raise SystemExit('--push requires --commit')

    if args.apps_csv:
        applicants_raw, coffee_raw, info_raw = load_from_csvs(
            args.apps_csv, args.coffee_csv, args.info_csv,
        )
        meet_raw = parse_meet(values_from_csv(args.meet_csv)) if getattr(args, 'meet_csv', None) and os.path.exists(args.meet_csv) else []
    else:
        applicants_raw, coffee_raw, info_raw, meet_raw = pull_rows()
    print(f'pulled applications={len(applicants_raw)} coffee={len(coffee_raw)} info={len(info_raw)} meet={len(meet_raw)}')

    existing = load_existing_ids()
    uf_emails = {
        (a.get('email') or '').lower().strip()
        for a in applicants_raw
        if is_uf(a.get('university')) and (a.get('email') or '').strip()
    }
    new_emails = len(uf_emails - set(existing))
    print(f'existing ids={len(existing)} new UF emails vs bootstrap={new_emails}')

    bootstrap, stats = build_bootstrap(
        applicants_raw, coffee_raw, info_raw, built_at=date.today().isoformat(),
        meet_raw=meet_raw,
    )
    nbytes = write_bootstrap(bootstrap)
    print('coffee match methods:', stats['match_how'])
    print(f"applicants (UF only): {stats['applicant_count']}  [skipped {stats['skipped_non_uf']} non-UF]")
    print(f"coffee unmatched: {stats['unmatched_coffee']}  info unmatched: {stats['unmatched_info']}")
    print(f'bootstrap.json.txt bytes: {nbytes}')

    assemble_site()

    if args.commit:
        git('add', 'bootstrap.json.txt', 'index.html', 'build.py')
        git('commit', '-m', f"Refresh UF roster from Sheets ({stats['applicant_count']} applicants)")
        print('committed')
        if args.push:
            git('push', 'origin', 'HEAD')
            print('pushed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
