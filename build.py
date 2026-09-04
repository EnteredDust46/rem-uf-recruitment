import json, re, hashlib

# ---------- Load raw data ----------
applicants_raw = json.load(open('applicants_raw.json'))
coffee_raw = json.load(open('coffee_raw.json'))
info_raw = json.load(open('info_raw.json'))
round1_q = json.load(open('round1_questions.json'))

# ---------- Helpers ----------
def slug_id(email, name, idx):
    base = (email or name or str(idx)).lower().strip()
    h = hashlib.md5(base.encode()).hexdigest()[:8]
    return f"a{idx}_{h}"

def norm_name(n):
    n = re.sub(r'[^a-z ]', '', (n or '').lower())
    n = re.sub(r'\s+', ' ', n).strip()
    return n

def class_year_estimate(grad_year_str):
    try:
        gy = int(re.search(r'\d{4}', grad_year_str).group())
    except Exception:
        return 'Unknown'
    years_left = gy - 2026
    if years_left <= 1:
        return 'Senior'
    if years_left == 2:
        return 'Junior'
    if years_left == 3:
        return 'Sophomore'
    return 'Freshman'

# ---------- Build applicant records ----------
# This dashboard covers the UF chapter only.
UF_MATCH = re.compile(r'university of florida', re.I)
def is_uf(u):
    return bool(UF_MATCH.search(u or ''))

skipped_non_uf = sum(1 for a in applicants_raw if not is_uf(a['university']))
applicants_raw = [a for a in applicants_raw if is_uf(a['university'])]

applicants = []
by_email = {}
by_name = {}
for i, a in enumerate(applicants_raw):
    aid = slug_id(a['email'], a['name'], i)
    rec = {
        'id': aid,
        'timestamp': a['timestamp'],
        'name': a['name'],
        'email': a['email'],
        'phone': a['phone'],
        'gender': a['gender'],
        'race': a['race'],
        'linkedin': a['linkedin'],
        'resume': a['resume'],
        'university': a['university'],
        'gradYear': a['gradYear'],
        'classYear': class_year_estimate(a['gradYear']),
        'major': a['major'],
        'minor': a['minor'],
        'gpa': a['gpa'],
        'whyRem': a['whyRem'],
        'coreValue': a['coreValue'],
        'valueEssay': a['valueEssay'],
        'careerInterests': a['careerInterests'],
        'howRemHelps': a['howRemHelps'],
        'position': a['position'],
        'skills': a['skills'],
        'accommodations': a['accommodations'],
        'other': a['other'],
        'commitment': a['commitment'],
        'attendance': {
            'coffeeChats': [],
            'infoSession': None,
            'meetMembers': None,
        },
    }
    applicants.append(rec)
    if rec['email']:
        by_email[rec['email']] = rec
    nm = norm_name(rec['name'])
    by_name.setdefault(nm, []).append(rec)

# ---------- Attendance matching ----------
# Sign-in sheets are free-text: people type a first name only, or use a different
# email than they applied with. Match on email, then exact name, then the email's
# local part (czou1@ufl.edu -> Calvin Zou), and only when the result is unambiguous.
def email_local(e):
    return re.sub(r'[^a-z]', '', (e or '').lower().split('@')[0])

for rec in applicants:
    toks = norm_name(rec['name']).split()
    first = toks[0] if toks else ''
    last = toks[-1] if len(toks) > 1 else ''
    keys = {k for k in [first + last, (first[:1] + last) if first and last else '',
                        (last + first[:1]) if first and last else '',
                        (first + last[:1]) if first and last else ''] if k}
    rec['_first'], rec['_last'], rec['_keys'] = first, last, keys

def find_applicant(name, email):
    e = (email or '').lower().strip()
    rec = by_email.get(e)
    if rec:
        return rec, 'email'
    nm = norm_name(name)
    cands = by_name.get(nm) or []
    if len(cands) == 1:
        return cands[0], 'name'
    lp = email_local(e)
    if lp:
        hits = [a for a in applicants if lp in a['_keys']]
        # the typed name must be consistent with the person the email points at
        hits = [a for a in hits if not nm or nm in (norm_name(a['name']), a['_first'], a['_last'])
                or a['_first'] in nm.split() or a['_last'] in nm.split()]
        if len(hits) == 1:
            return hits[0], 'email-local'
    parts = nm.split()
    if len(parts) >= 2:
        hits = [a for a in applicants if a['_first'] == parts[0] and a['_last'] == parts[-1]]
        if len(hits) == 1:
            return hits[0], 'fullname'
    return None, None

match_how = {'email': 0, 'name': 0, 'email-local': 0, 'fullname': 0}
unmatched_coffee = 0
for c in coffee_raw:
    rec, how = find_applicant(c.get('name'), c.get('email'))
    if rec:
        match_how[how] += 1
        # the same person can sign in more than once; keep each chat, dedup by timestamp
        if not any(x['timestamp'] == c['timestamp'] for x in rec['attendance']['coffeeChats']):
            rec['attendance']['coffeeChats'].append({'timestamp': c['timestamp'], 'spokeTo': c['spokeTo']})
    else:
        unmatched_coffee += 1

unmatched_info = 0
for c in info_raw:
    rec, how = find_applicant(c.get('name'), c.get('email'))
    if rec:
        rec['attendance']['infoSession'] = {
            'timestamp': c['timestamp'], 'session': c['session'], 'appliedBefore': c['appliedBefore'],
        }
    else:
        unmatched_info += 1

for rec in applicants:
    for k in ('_first', '_last', '_keys'):
        rec.pop(k, None)

print('coffee match methods:', match_how)
print(f"applicants (UF only): {len(applicants)}  [skipped {skipped_non_uf} non-UF]")
print(f"coffee chat rows: {len(coffee_raw)}, unmatched: {unmatched_coffee}")
print(f"info session rows: {len(info_raw)}, unmatched: {unmatched_info}")
matched_coffee = sum(1 for a in applicants if a['attendance']['coffeeChats'])
matched_info = sum(1 for a in applicants if a['attendance']['infoSession'])
print(f"applicants w/ coffee chat match: {matched_coffee}")
print(f"applicants w/ info session match: {matched_info}")

# ---------- Reviewers & default groups ----------
reviewers = [
    {'id': 'aya', 'name': 'Aya Aldorri', 'email': 'aya.aldorri@ufl.edu', 'role': 'Co-President'},
    {'id': 'max', 'name': 'Max Kaplan', 'email': 'kaplanmax@ufl.edu', 'role': 'Co-President'},
    {'id': 'eli', 'name': 'Eli Koon', 'email': 'elikoon@ufl.edu', 'role': 'VP of Membership'},
    {'id': 'adam', 'name': 'Adam Kamenetsky', 'email': 'adam.kamenetsky24@gmail.com', 'role': 'VP of Consulting'},
    {'id': 'maria', 'name': 'Maria Lopez', 'email': 'maria.lopez3@ufl.edu', 'role': 'VP of Communications'},
    {'id': 'christian', 'name': 'Christian Fox', 'email': 'ca.fox@ufl.edu', 'role': 'VP of Alumni Engagement'},
    {'id': 'hannah', 'name': 'Hannah Lockwood', 'email': 'h.lockwood@ufl.edu', 'role': 'Recruitment Chair'},
    {'id': 'terrence', 'name': 'Terrence Smith', 'email': 'terrence.smith@ufl.edu', 'role': 'Recruitment Chair'},
]

# weight = share of the applicant pool this pair reviews. Aya & Adam carry a lighter
# load (22%) because they're running the process; the other three split the rest.
default_pairs = [
    {'id': 'grp_foxmaria', 'name': 'Fox & Maria', 'members': ['christian', 'maria'], 'weight': 0.26},
    {'id': 'grp_maxterrence', 'name': 'Max & Terrence', 'members': ['max', 'terrence'], 'weight': 0.26},
    {'id': 'grp_ayaadam', 'name': 'Aya & Adam', 'members': ['aya', 'adam'], 'weight': 0.22},
    {'id': 'grp_hannaheli', 'name': 'Hannah & Eli', 'members': ['hannah', 'eli'], 'weight': 0.26},
]

# ---------- Rubrics ----------
RUBRIC_SCREEN = {
    'dims': [
        {
            'key': 'academics', 'label': 'Academics', 'scale': [0, 4],
            'bands': {
                'Freshman': ['GPA ≥ 3.9 or strong upward trend', 'GPA 3.7–3.89', 'GPA 3.5–3.69', 'GPA < 3.5 or not listed'],
                'Sophomore': ['GPA ≥ 3.8 or strong upward trend', 'GPA 3.6–3.79', 'GPA 3.4–3.59', 'GPA < 3.4 or not listed'],
                'Junior': ['GPA ≥ 3.7 or strong upward trend', 'GPA 3.6–3.69', 'GPA 3.4–3.59', 'GPA < 3.4 or not listed'],
            },
        },
        {
            'key': 'resume', 'label': 'Resume', 'scale': [0, 4],
            'bands': {
                'Freshman': ['Consulting-ready formatting, strong bullets', 'Mostly polished with minor issues', 'Inconsistent structure or vague bullets', 'Below professional standard'],
                'Sophomore': ['Consulting-ready formatting, strong bullets', 'Mostly polished with minor issues', 'Inconsistent structure or vague bullets', 'Below professional standard'],
                'Junior': ['Fully consulting-ready, no errors', 'Minor issues only', 'Below consulting standard', 'Unprofessional'],
            },
        },
        {
            'key': 'experience', 'label': 'Experience & Involvement', 'scale': [0, 4],
            'bands': {
                'Freshman': ['Relevant internships or involvements clearly showing passion and commitment', 'Transferable roles (work, service, athletics) well articulated', 'Limited experience or weak descriptions', 'No meaningful experience listed'],
                'Sophomore': ['Consulting, strategy, research, or analytical internships or extracurriculars', 'Business-relevant internships or projects', 'Experience present but poorly explained', 'Experience not relevant or absent'],
                'Junior': ['Relevant internship or strong professional extracurricular roles', 'At least one strong professional experience', 'Experience present but limited scope', 'Weak professional background'],
            },
        },
        {
            'key': 'leadership', 'label': 'Leadership & Involvement', 'scale': [0, 4],
            'bands': {
                'Freshman': ['Active involvement in campus organizations with early leadership or clear initiative', 'Consistent campus involvement or strong high school leadership', 'High school involvement only or limited campus engagement', 'No meaningful involvement listed'],
                'Sophomore': ['Leadership roles with ownership or measurable impact', 'Clear involvement with upward progression', 'Participation without leadership', 'Minimal involvement'],
                'Junior': ['Led teams or projects with client-facing or professional readiness', 'Leadership roles with real responsibility', 'Participation only', 'No leadership evidence'],
            },
        },
    ],
    'essay': {
        'key': 'essay', 'label': 'Application Essay Rating', 'scale': [1, 5],
        'levels': [
            {'v': 5, 'label': 'Very STRONG compelling story, personal anecdotes, shows passion and would be a good culture fit'},
            {'v': 4, 'label': 'Shows strong desire for being in Rem with a personal compelling reason'},
            {'v': 3, 'label': 'Shows only consulting interest, no culture or passion'},
            {'v': 2, 'label': 'Weak, seems AI generated, not personal at all'},
            {'v': 1, 'label': "Does not embody what we're looking for"},
        ],
    },
}

RUBRIC_ROUND1 = {
    'callStructure': [
        {'title': '1. Candidate Background & Brief Introduction', 'minutes': 5, 'body': "Start by getting to know the candidate—ask about their background, leadership experience, and motivation for wanting to be a part of Rem on Campus. Then, introduce yourself and provide a brief overview of Rem on Campus to set the stage for the interview."},
        {'title': '2. Behavioral Questions', 'minutes': 20, 'body': "Ask targeted behavioral and situational questions that assess the candidate’s leadership style, experiences, and alignment with Rem’s values. Focus on how they’ve handled challenges, motivated team members, driven growth, and sustained impact within their current or past roles."},
        {'title': '3. Q&A and Next Steps', 'minutes': 5, 'body': "Invite the candidate to ask questions about REM, chapter operations, expectations, or anything else. Wrap up by outlining the next steps, providing encouragement, and explaining how you’ll follow up."},
    ],
    'fit': round1_q['fit'],
    'personal': round1_q['personal'],
    'personality': round1_q['personality'],
    'scoringGuidelines': {1: 'Unacceptable', 2: 'Not a good fit but showing promise', 3: 'Satisfactory fit', 4: 'Exceeding Expectations (Excellent fit)'},
    'advanceThreshold': 3,
}

RUBRIC_ROUND2 = {
    'cases': [
        {'id': 'golden_taco', 'name': 'Golden Taco', 'industry': 'Food & Beverage'},
        {'id': 'bean_bloom', 'name': 'Bean & Bloom', 'industry': 'Food & Beverage'},
        {'id': 'pedal_pure', 'name': 'Pedal Pure', 'industry': 'Retail / Consumer'},
    ],
    'dims': [
        {'key': 'introduction', 'label': 'Introduction', 'levels': [
            'Clearly understands the prompt, recaps to interviewer, and asks intelligent clarifying questions',
            'Understands the main points of the prompt and communicates some clarifiers to interviewer',
            'Can be seen taking notes or verbally acknowledges the prompt given by the interviewer',
            'Makes no visible effort to understand or specify prompt information',
        ]},
        {'key': 'framework', 'label': 'Framework', 'levels': [
            'Takes 1-2 minutes to produce a relevant, fleshed out, and MECE-adherent framework',
            'Produces a relevant framework while taking too long or missing some MECE/relevancy elements',
            'Attempts to create a relevant framework but misses key elements of the exercise',
            'Does not demonstrate a basic understanding of framework creation',
        ]},
        {'key': 'market_sizing', 'label': 'Market Sizing', 'levels': [
            'Provides a clear and logical sizing path, explaining all assumptions and defending their size decisions well',
            'Completes a generally understood sizing walkthrough with few mistakes or instances of getting lost (1-2 max)',
            'Needs consistent prompting in order to progress, gets lost in their logic 2+ times, or does not explain logic at all (provides answer)',
            'Cannot complete the sizing portion effectively - must be given answers to continue with the case',
        ]},
        {'key': 'quant_reasoning', 'label': 'Quant Reasoning', 'levels': [
            'Clearly structures, navigates, and communicates through quantitative operations with minimal mistakes',
            'Follows a logical path towards solutions with a few mistakes, may get lost and need guidance once or twice',
            'Demonstrates basic quant abilities, but noticeably lacks in structuring and/or needs major guidance throughout',
            'Cannot progress through one or more sections of quantitative analysis and must be given the answers to proceed',
        ]},
        {'key': 'brainstorming', 'label': 'Brainstorming', 'levels': [
            'Presents multiple creative, real-world driven ideas that accurately encompass all case aspects',
            'Presents 1 well thought out idea or multiple shallower ideas that add depth and structure to the case',
            'Relates ideas to case information, but makes no effort to structure thoughts beyond stream of consciousness',
            'Does not provide any material insight beyond the given information in the prompt',
        ]},
        {'key': 'recommendation', 'label': 'Recommendation', 'levels': [
            'Presents an efficient, holistic recommendation that demonstrates a deep understanding of all case elements',
            'Presents a relatively structured recommendation which responds to the prompt’s main questions',
            'Attempts to provide a structured recommendation, but missed many aspects of the case',
            'Does not provide a succinct recommendation or does not incorporate the prompt information',
        ]},
    ],
    # Adam asked us to draft something here since round 2 is "case AND behaviorals" but only an
    # official case rubric was found on file -- flagged as editable/draft in the UI.
    'fitDim': {
        'key': 'fit_communication', 'label': 'Fit & Communication (draft — edit me)', 'draft': True, 'levels': [
            'Confident, clear, client-ready communication; strong rapport and composure throughout',
            'Generally clear and composed, minor moments of hesitation',
            'Communicates adequately but lacks polish or confidence at times',
            'Difficulty communicating clearly or building rapport',
        ],
    },
    'levelLabels': ['Exceeds Expectations', 'Achieves Expectations', 'Meets Some Expectations', "Doesn't Meet Expectations"],
    'maxScore': 24,
}

# ---------- Live-pull source file IDs (Google Drive) ----------
SOURCES = {
    'applicationsSheetId': '1M03BJpDREoNr_p_1QfZXzs4xU1fIh6DeDz_VErgqN6g',
    'applicationsSheetTitle': 'FL2026 Rem Applications - UF',
    'coffeeChatResponsesSheetId': '1sIhs4I2i53mmH2cUObWarBDnJ06-nDl53nVflkZAnBo',
    'mastersheetId': '1AamE6ob5DW5LhvAVodZsocQiyNz7_P_SLXhFeSmgbkQ',
    'mastersheetTitle': 'Copy of Recruitment Master 2026',
    # Meet the Members responses sheet doesn't exist yet (event is Sep 18) -- the page
    # discovers it at runtime via search_files(title contains 'Meet the Members').
}

bootstrap = {
    'meta': {
        'builtAt': '2026-09-04',
        'applicantCount': len(applicants),
        'coffeeChatRows': len(coffee_raw),
        'infoSessionRows': len(info_raw),
    },
    'applicants': applicants,
    'reviewers': reviewers,
    'defaultGroups': default_pairs,
    'rubrics': {
        'screen': RUBRIC_SCREEN,
        'round1': RUBRIC_ROUND1,
        'round2': RUBRIC_ROUND2,
    },
    'sources': SOURCES,
}

with open('bootstrap.json.txt', 'w') as f:
    json.dump(bootstrap, f)

print('bootstrap.json.txt bytes:', len(json.dumps(bootstrap)))
