"""Port of app.js autoFor / effScore / hasManualScore / averages for CLI push."""
import re

YEAR_KEYS = ['Freshman', 'Sophomore', 'Junior']
GPA_THRESHOLDS = {
    'Freshman': [3.9, 3.7, 3.5],
    'Sophomore': [3.8, 3.6, 3.4],
    'Junior': [3.7, 3.6, 3.4],
}


def year_key_for(a):
    return a.get('classYear') if a.get('classYear') in YEAR_KEYS else 'Junior'


def parse_gpa(raw, class_year):
    text = '' if raw is None else str(raw).strip()
    if not text:
        return {'value': None, 'basis': None, 'reason': 'No GPA provided'}
    low = text.lower()
    hs_marker = bool(re.search(r'(high\s*school|highschool|\bh\.?s\.?\b)', low, re.I))
    college_na = bool(re.search(r'(n/?a|none|no gpa|not yet|first (semester|year)|incoming|freshman)', low, re.I))
    nums = [float(n) for n in re.findall(r'\d+(?:\.\d+)?', low)]
    nums = [n for n in nums if 0 < n <= 6]
    on_scale = [n for n in nums if n <= 4.0]
    off_scale = [n for n in nums if n > 4.0]
    if not nums:
        return {'value': None, 'basis': None, 'reason': 'No numeric GPA in the response'}
    if off_scale and not on_scale:
        return {'value': None, 'basis': 'highschool' if hs_marker else None,
                'reason': f'{off_scale[0]} is on a weighted scale — not comparable to 4.0'}
    if len(on_scale) > 1:
        return {'value': None, 'basis': None, 'reason': 'More than one GPA listed'}
    value = on_scale[0]
    if class_year == 'Freshman':
        if off_scale:
            return {'value': None, 'basis': 'highschool', 'reason': 'Weighted and unweighted GPAs both listed'}
        return {'value': value, 'basis': 'highschool', 'label': 'high-school GPA', 'reason': 'High-school GPA (freshman)'}
    if hs_marker and college_na:
        return {'value': None, 'basis': 'highschool', 'reason': 'Only a high-school GPA on file — no college GPA yet'}
    if hs_marker:
        return {'value': None, 'basis': 'highschool', 'reason': 'GPA is labelled high-school — confirm before scoring'}
    return {'value': value, 'basis': 'college', 'label': 'college GPA', 'reason': 'College GPA'}


def auto_for(a, cache=None):
    if cache is not None and a.get('id') in cache:
        return cache[a['id']]
    gpa = parse_gpa(a.get('gpa'), a.get('classYear'))
    t = GPA_THRESHOLDS[year_key_for(a)]
    academics = None
    if gpa.get('value') is not None and gpa.get('basis') == 'college':
        v = gpa['value']
        academics = 4 if v >= t[0] else 3 if v >= t[1] else 2 if v >= t[2] else 1
    res = {'gpa': gpa, 'scores': {'academics': academics}}
    if cache is not None:
        cache[a['id']] = res
    return res


def eff_score(a, g, key, cache=None):
    scores = (g or {}).get('scores') or {}
    v = scores.get(key)
    if v in ('NA', 'N/A'):
        return None
    if isinstance(v, (int, float)):
        return v
    auto = auto_for(a, cache)['scores'].get(key)
    return auto if isinstance(auto, (int, float)) else None


def has_manual_score(g):
    scores = (g or {}).get('scores') or {}
    return any(isinstance(scores.get(k), (int, float)) for k in scores)


def screen_average(g, a, cache=None, dim_keys=None):
    keys = dim_keys or ['academics', 'resume', 'experience', 'leadership', 'essay']
    vals = [eff_score(a, g, k, cache) for k in keys]
    vals = [v for v in vals if isinstance(v, (int, float))]
    if not vals:
        return None
    return sum(vals) / len(vals)


def round1_average(g):
    keys = ['fit0', 'fit1', 'fit2', 'personal0', 'personal1', 'personal2', 'personality']
    scores = (g or {}).get('scores') or {}
    vals = [scores[k] for k in keys if isinstance(scores.get(k), (int, float))]
    if not vals:
        return None
    return sum(vals) / len(vals)


def round2_total(g):
    dim_keys = ['introduction', 'framework', 'market_sizing', 'quant_reasoning', 'brainstorming', 'recommendation']
    scores = (g or {}).get('scores') or {}
    vals = [scores[k] for k in dim_keys if isinstance(scores.get(k), (int, float))]
    if not vals:
        return None
    return {'total': sum(vals), 'max': 24, 'count': len(vals)}


class Scoring:
    def __init__(self, bootstrap):
        self.cache = {}
        dims = (((bootstrap or {}).get('rubrics') or {}).get('screen') or {}).get('dims') or []
        self.screen_keys = [d['key'] for d in dims] + ['essay']

    def auto_for(self, a):
        return auto_for(a, self.cache)

    def eff_score(self, a, g, key):
        return eff_score(a, g, key, self.cache)

    def has_manual_score(self, g):
        return has_manual_score(g)

    def screen_average(self, g, a):
        return screen_average(g, a, self.cache, self.screen_keys)

    def round1_average(self, g):
        return round1_average(g)

    def round2_total(self, g):
        return round2_total(g)


def attach_scoring(bootstrap):
    return Scoring(bootstrap)
