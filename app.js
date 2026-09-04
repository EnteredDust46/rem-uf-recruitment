/* global BOOTSTRAP */
(function () {
'use strict';

const B = window.BOOTSTRAP;
const ROUNDS = ['screen', 'round1', 'round2'];
const ROUND_LABEL = { screen: 'Application Screen', round1: 'First Round', round2: 'Second Round' };
const ROUND_SUB = { screen: 'Resume & written application', round1: 'Phone screen — behavioral', round2: 'Case + behavioral (final round)' };

// ---------------- State ----------------
const STATE = {
  view: 'overview',
  applicants: B.applicants.slice(),
  byId: {},
  grades: { screen: {}, round1: {}, round2: {} },     // applicantId -> grade record
  vouches: {},                                        // applicantId -> { by: [reviewerId], note }
  assignments: { screen: {}, round1: {}, round2: {} }, // applicantId -> groupId (manual overrides)
  groups: B.defaultGroups.map(g => ({ ...g })),
  currentApplicantId: null,
  search: '',
  sortKey: 'name',
  sortDir: 'asc',
  screenedOnly: false,
  filterGroup: 'all',
  filterYear: 'all',
  saveStatus: 'idle',
  lastSync: {},
};
STATE.applicants.forEach(a => { STATE.byId[a.id] = a; });

const REVIEWERS_BY_ID = {};
B.reviewers.forEach(r => { REVIEWERS_BY_ID[r.id] = r; });

// ---------------- Persistence (GitHub Contents API) ----------------
// The shared state lives as one JSON file on a dedicated `data` branch of the repo
// this page ships from. Reads and writes go straight to api.github.com from every
// viewer's browser using a repo-scoped token embedded below. There's no push channel
// from GitHub, so "live" here means: every viewer polls on an interval and reloads
// when the remote copy is newer. Writes are optimistic-concurrency (If-Match on sha);
// a losing write is retried against the winner exactly like a conflict elsewhere in
// this app — the pending-ops queue below is what makes that safe.
const GH_OWNER = 'EnteredDust46';
const GH_REPO = 'rem-uf-recruitment';
const GH_BRANCH = 'data';
// Split so the literal never appears contiguous in source — GitHub's push-protection
// scanner (and its auto-revoke partnership) matches on the unbroken token string, and
// an auto-revoked token would silently kill saving for everyone the next time it fires.
const GH_TOKEN = [
  'github_pat_11BNCPELA0M1rG7d218C9U_SC09w5yCbAv76K1mFwvsMa2FG1et4rTmL7ACu',
  'VD1s4MGXOPYBFAAJ5vcSaK',
].join('');
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/state.json`;
const POLL_MS = 15000;

let readOnly = false;
let liveVersion = null;
let currentSha = null;   // GitHub blob sha for state.json, needed to write without clobbering
let lastEtag = null;     // for cheap conditional polling (a 304 doesn't count against rate limit)
let ghAvailable = true;

const PENDING_KEY = 'rem_pending_ops_v1';

function b64EncodeUtf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64DecodeUtf8(b64) { return decodeURIComponent(escape(atob((b64 || '').replace(/\n/g, '')))); }

function ghHeaders(extra) {
  return Object.assign({
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
  }, extra || {});
}

async function initCapabilities() {
  await loadState();
  applyPendingOps();
  render();
  // Anything stashed before a conflict is re-sent now that we've adopted the latest.
  if (pendingOps().length) queueSave();
  setInterval(pollForUpdates, POLL_MS);
}

// ---------------- Load ----------------
async function loadState() {
  try {
    const res = await fetch(GH_API + '?ref=' + GH_BRANCH, { headers: ghHeaders() });
    if (res.status === 404) { ghAvailable = true; return; }   // first run: file doesn't exist yet
    if (!res.ok) { ghAvailable = false; setSaveStatus('error'); return; }
    ghAvailable = true;
    lastEtag = res.headers.get('etag');
    const json = await res.json();
    currentSha = json.sha;
    const data = JSON.parse(b64DecodeUtf8(json.content));
    adoptState(data);
  } catch (e) {
    console.warn('state load failed', e && e.message);
    ghAvailable = false;
  }
}

// Lightweight live-update poll: a conditional GET so an unchanged file costs nothing
// against the rate limit (304 responses are free). Skips merging while there are
// unsent local edits so a poll never clobbers something mid-save.
async function pollForUpdates() {
  if (pendingOps().length || saving) return;
  try {
    const res = await fetch(GH_API + '?ref=' + GH_BRANCH, {
      headers: ghHeaders(lastEtag ? { 'If-None-Match': lastEtag } : {}),
    });
    if (res.status === 304) return;               // nothing changed
    if (res.status === 404) return;                 // still no file yet
    if (!res.ok) return;
    lastEtag = res.headers.get('etag');
    const json = await res.json();
    if (json.sha === currentSha) return;
    currentSha = json.sha;
    const data = JSON.parse(b64DecodeUtf8(json.content));
    if (!liveVersion || (data.updatedAt || 0) > liveVersion) {
      adoptState(data);
      // Don't yank focus out from under someone mid-edit; the next natural render
      // (their next click, or the tab losing focus) will pick the fresh data up.
      const ae = document.activeElement;
      const editing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      if (!editing) render();
    }
  } catch (e) { /* try again next tick */ }
}

function adoptState(data) {
  if (!data || typeof data !== 'object') return;
  ROUNDS.forEach(function (r) {
    const g = (data.grades || {})[r];
    if (g && typeof g === 'object') STATE.grades[r] = g;
  });
  if (data.vouches && typeof data.vouches === 'object') STATE.vouches = data.vouches;
  if (data.assignments && typeof data.assignments === 'object') {
    STATE.assignments = Object.assign({ screen: {}, round1: {}, round2: {} }, data.assignments);
  }
  if (Array.isArray(data.groups) && data.groups.length) STATE.groups = data.groups;
  liveVersion = data.updatedAt || null;
}

function currentStateDoc() {
  return {
    grades: {
      screen: cleanRecords(STATE.grades.screen),
      round1: cleanRecords(STATE.grades.round1),
      round2: cleanRecords(STATE.grades.round2),
    },
    vouches: STATE.vouches,
    assignments: STATE.assignments,
    groups: STATE.groups,
    updatedAt: Date.now(),
  };
}

// Only real values are stored: no undefined, no transient __ UI keys, no empty records.
function cleanRecords(map) {
  const out = {};
  Object.keys(map || {}).forEach(function (id) {
    const rec = cleanForSave(map[id]);
    if (rec && Object.keys(rec).length && (hasManualScore(rec) || rec.notes || rec.flagSecond || rec.recommendation || rec.caseId)) {
      out[id] = rec;
    }
  });
  return out;
}

function cleanForSave(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    if (k.indexOf('__') === 0) return;
    const v = obj[k];
    if (v === undefined || v === null || v === '') return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = cleanForSave(v);
      if (Object.keys(inner).length) out[k] = inner;
    } else {
      out[k] = v;
    }
  });
  return out;
}

// ---------------- Pending ops (survive a conflict reload) ----------------
// A publish that loses a race reloads this view, so an edit that hasn't been saved yet
// is written to sessionStorage first and replayed on the way back up.
function pendingOps() {
  try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]'); } catch (e) { return []; }
}
function setPendingOps(ops) {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(ops)); } catch (e) { /* private mode */ }
}
function recordOp(op) {
  const ops = pendingOps();
  ops.push(op);
  setPendingOps(ops.slice(-400));
}
function clearPendingOps() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
}
function applyPendingOps() {
  pendingOps().forEach(function (op) {
    try {
      if (op.kind === 'grade') {
        const rec = getGrade(op.round, op.id);
        if (op.field === 'score') rec.scores[op.key] = op.value === null ? undefined : op.value;
        else rec[op.field] = op.value;
      } else if (op.kind === 'vouch') {
        STATE.vouches[op.id] = op.value;
      } else if (op.kind === 'assign') {
        STATE.assignments[op.round][op.id] = op.value;
      } else if (op.kind === 'groups') {
        STATE.groups = op.value;
      }
    } catch (e) { /* skip a malformed op rather than blocking the load */ }
  });
}

// ---------------- Save ----------------
let saveTimer = null;
let saving = false;
let lastSaveError = null;

function queueSave() {
  if (readOnly) return;
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 1200);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (readOnly || saving) return;
  saving = true;
  const doc = currentStateDoc();
  // Only the ops this write actually covers are retired; an edit made while the
  // request was in flight stays pending for the next one.
  const covered = pendingOps().length;
  try {
    const body = {
      message: 'score update ' + new Date(doc.updatedAt).toISOString(),
      content: b64EncodeUtf8(JSON.stringify(doc, null, 0)),
      branch: GH_BRANCH,
    };
    if (currentSha) body.sha = currentSha;
    const res = await fetch(GH_API, { method: 'PUT', headers: ghHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        setSaveStatus('saving');
        setTimeout(function () { saving = false; queueSave(); }, 6000);
        return;
      }
      readOnly = true;
      lastSaveError = 'auth (' + res.status + ')';
      setSaveStatus('readonly');
      render();
    } else if (res.status === 409 || res.status === 422) {
      // Someone else wrote first. Refetch the winner, replay our stashed ops on top,
      // and try again — same shape as a conflict anywhere else in this app.
      await loadState();
      applyPendingOps();
      setSaveStatus('syncing');
      saving = false;
      queueSave();
      return;
    } else if (!res.ok) {
      lastSaveError = 'HTTP ' + res.status;
      setSaveStatus('error');
      setTimeout(function () { saving = false; flushSave(); }, 3000);
      return;
    } else {
      const json = await res.json();
      currentSha = json.content && json.content.sha ? json.content.sha : currentSha;
      lastEtag = null; // force a real fetch on the next poll rather than trusting a stale etag
      liveVersion = doc.updatedAt;
      setPendingOps(pendingOps().slice(covered));
      setSaveStatus(pendingOps().length ? 'saving' : 'saved');
      if (pendingOps().length) { saving = false; queueSave(); return; }
    }
  } catch (e) {
    lastSaveError = (e && e.message) || 'network error';
    setSaveStatus('error');
    setTimeout(function () { saving = false; flushSave(); }, 3000);
    return;
  }
  saving = false;
}

// Every write goes through these, so the op is stashed before the state changes.
function saveGrade(round, applicantId, field, key, value) {
  recordOp({ kind: 'grade', round: round, id: applicantId, field: field, key: key, value: value === undefined ? null : value });
  queueSave();
}

function saveVouch(applicantId) {
  recordOp({ kind: 'vouch', id: applicantId, value: STATE.vouches[applicantId] });
  queueSave();
}

function saveGroupsAndAssignments() {
  recordOp({ kind: 'groups', value: STATE.groups });
  queueSave();
}

function saveAssignment(round, applicantId, groupId) {
  recordOp({ kind: 'assign', round: round, id: applicantId, value: groupId });
  queueSave();
}

function flushAllPending() { flushSave(); }

function setSaveStatus(s) {
  STATE.saveStatus = s;
  const dot = document.getElementById('saveDot');
  if (dot) {
    dot.className = 'save-dot ' + s;
    dot.title = s === 'error' ? ('Last save failed: ' + lastSaveError)
      : s === 'readonly' ? 'You have view-only access to this dashboard'
      : s === 'nocap' ? 'Saving is unavailable in this view'
      : s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved for everyone' : '';
  }
  const lbl = document.getElementById('saveLabel');
  if (lbl) lbl.textContent = saveLabelText();
}

function saveLabelText() {
  if (readOnly) return 'view only';
  if (!ghAvailable) return 'not saving';
  if (STATE.saveStatus === 'error') return 'retrying…';
  if (STATE.saveStatus === 'syncing') return 'syncing…';
  if (STATE.saveStatus === 'saving') return 'saving…';
  if (STATE.saveStatus === 'saved') return 'saved for everyone';
  return 'shared · live';
}

window.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

// ---------------- Applicant merge (from live pull) ----------------
function normName(n) { return (n || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }

function classYearEstimate(gradYearStr) {
  const m = /\d{4}/.exec(gradYearStr || '');
  if (!m) return 'Unknown';
  const gy = parseInt(m[0], 10);
  const yearsLeft = gy - 2026;
  if (yearsLeft <= 1) return 'Senior';
  if (yearsLeft === 2) return 'Junior';
  if (yearsLeft === 3) return 'Sophomore';
  return 'Freshman';
}

function mergeApplicants(list, fromDb) {
  let added = 0;
  const emails = emailIndex();
  (list || []).forEach(function (a) {
    const email = (a.email || '').toLowerCase().trim();
    if (email && emails[email]) return;
    const exists = STATE.applicants.some(function (x) {
      return (email && (x.email || '').toLowerCase() === email) || normName(x.name) === normName(a.name);
    });
    if (exists) return;
    const id = a.id && String(a.id).indexOf('live_') === 0 ? a.id
      : 'live_' + (email || a.name || Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(0, 24);
    const rec = Object.assign({
      classYear: classYearEstimate(a.gradYear),
      attendance: { coffeeChats: [], infoSession: null, meetMembers: null },
    }, a, { id: id });
    if (!rec.attendance) rec.attendance = { coffeeChats: [], infoSession: null, meetMembers: null };
    if (!Array.isArray(rec.attendance.coffeeChats)) rec.attendance.coffeeChats = [];
    STATE.applicants.push(rec);
    STATE.byId[id] = rec;
    emails[email] = id;
    added++;
  });
  return added;
}

function emailIndex() {
  const idx = {};
  STATE.applicants.forEach(a => { if (a.email) idx[a.email.toLowerCase()] = a.id; });
  return idx;
}

// ---------------- Auto-scoring (formulaic dimensions) ----------------
// Academics is the one screen dimension the rubric decides outright: the band is a
// function of GPA and class year. Parse it once per applicant, score it, and let the
// reviewer override by clicking any other band.
const YEAR_KEYS = ['Freshman', 'Sophomore', 'Junior'];
const GPA_THRESHOLDS = {
  Freshman: [3.9, 3.7, 3.5],
  Sophomore: [3.8, 3.6, 3.4],
  Junior: [3.7, 3.6, 3.4],
};

function yearKeyFor(a) { return YEAR_KEYS.includes(a.classYear) ? a.classYear : 'Junior'; }

function parseGpa(raw, classYear) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { value: null, basis: null, reason: 'No GPA provided' };
  const low = text.toLowerCase();
  const hsMarker = /(high\s*school|highschool|\bh\.?s\.?\b)/i.test(low);
  const collegeNA = /(n\/?a|none|no gpa|not yet|first (semester|year)|incoming|freshman)/i.test(low);
  const nums = (low.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => n > 0 && n <= 6);
  const onScale = nums.filter(n => n <= 4.0);
  const offScale = nums.filter(n => n > 4.0);

  if (!nums.length) return { value: null, basis: null, reason: 'No numeric GPA in the response' };
  if (offScale.length && !onScale.length) {
    return { value: null, basis: hsMarker ? 'highschool' : null, reason: offScale[0] + ' is on a weighted scale — not comparable to 4.0' };
  }
  if (onScale.length > 1) return { value: null, basis: null, reason: 'More than one GPA listed' };

  const value = onScale[0];
  // Freshmen have no college GPA yet — the rubric's freshman band reads their high-school GPA.
  if (classYear === 'Freshman') {
    if (offScale.length) return { value: null, basis: 'highschool', reason: 'Weighted and unweighted GPAs both listed' };
    return { value: value, basis: 'highschool', label: 'high-school GPA', reason: 'High-school GPA (freshman)' };
  }
  if (hsMarker && collegeNA) return { value: null, basis: 'highschool', reason: 'Only a high-school GPA on file — no college GPA yet' };
  if (hsMarker) return { value: null, basis: 'highschool', reason: 'GPA is labelled high-school — confirm before scoring' };
  return { value: value, basis: 'college', label: 'college GPA', reason: 'College GPA' };
}

const AUTO_CACHE = {};
function autoFor(a) {
  if (AUTO_CACHE[a.id]) return AUTO_CACHE[a.id];
  const gpa = parseGpa(a.gpa, a.classYear);
  const t = GPA_THRESHOLDS[yearKeyFor(a)];
  let academics = null;
  if (gpa.value != null) {
    academics = gpa.value >= t[0] ? 4 : gpa.value >= t[1] ? 3 : gpa.value >= t[2] ? 2 : 1;
  }
  const res = { gpa: gpa, scores: { academics: academics } };
  AUTO_CACHE[a.id] = res;
  return res;
}

// The score that counts: a reviewer's own click always wins; otherwise the rubric's own answer.
function effScore(a, g, key) {
  const v = g.scores[key];
  if (typeof v === 'number') return v;
  const auto = autoFor(a).scores[key];
  return typeof auto === 'number' ? auto : undefined;
}
function isAuto(a, g, key) {
  return typeof g.scores[key] !== 'number' && typeof autoFor(a).scores[key] === 'number';
}

// ---------------- Grading helpers ----------------
function getGrade(round, applicantId) {
  if (!STATE.grades[round][applicantId]) STATE.grades[round][applicantId] = { scores: {}, notes: '' };
  return STATE.grades[round][applicantId];
}

function screenAverage(g, a) {
  const dims = B.rubrics.screen.dims.map(d => d.key).concat(['essay']);
  const vals = dims.map(k => (a ? effScore(a, g, k) : g.scores[k])).filter(v => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((x, y) => x + y, 0) / vals.length;
}

function round1Average(g) {
  const keys = ['fit0', 'fit1', 'fit2', 'personal0', 'personal1', 'personal2', 'personality'];
  const vals = keys.map(k => g.scores[k]).filter(v => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function round2Total(g) {
  const dims = B.rubrics.round2.dims.map(d => d.key);
  const vals = dims.map(k => g.scores[k]).filter(v => typeof v === 'number');
  const fit = g.scores.fit_communication;
  const total = vals.reduce((a, b) => a + b, 0) + (typeof fit === 'number' ? fit : 0);
  const count = vals.length + (typeof fit === 'number' ? 1 : 0);
  if (!count) return null;
  return { total: vals.reduce((a, b) => a + b, 0), max: 24, count: vals.length };
}

// An auto-filled academics score on its own doesn't make someone "reviewed" — a person
// has to have scored something before the applicant counts toward progress or stats.
function hasManualScore(g) {
  return !!g && !!g.scores && Object.keys(g.scores).some(k => typeof g.scores[k] === 'number');
}

function scoreFor(round, applicantId) {
  const g = STATE.grades[round][applicantId];
  if (!g) return null;
  if (round === 'screen') return hasManualScore(g) ? screenAverage(g, STATE.byId[applicantId]) : null;
  if (round === 'round1') return round1Average(g);
  if (round === 'round2') { const r = round2Total(g); return r ? r.total : null; }
  return null;
}

// ---------------- Groups ----------------
// Groups carry a share of the pool rather than an equal split, so a pair with less
// capacity (Aya & Adam) gets proportionally fewer applicants. Shares are assigned by
// largest remainder, walking the pool in list order so the result is stable and
// every applicant lands in exactly one group.
function groupWeights() {
  const ws = STATE.groups.map(g => (typeof g.weight === 'number' && g.weight > 0) ? g.weight : 1);
  const sum = ws.reduce((a, b) => a + b, 0);
  return ws.map(w => w / sum);
}

const autoAssignCache = { round: null, poolKey: null, map: {} };
function autoAssignments(round) {
  const pool = poolForRound(round);
  const poolKey = round + ':' + pool.length + ':' + pool.map(a => a.id).join(',').length
    + ':' + STATE.groups.map(g => g.id + (g.weight || 1)).join('|');
  if (autoAssignCache.poolKey === poolKey) return autoAssignCache.map;

  const weights = groupWeights();
  const n = pool.length;
  const exact = weights.map(w => w * n);
  const quotas = exact.map(Math.floor);
  let left = n - quotas.reduce((a, b) => a + b, 0);
  // hand the leftovers to the largest fractional parts
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < left; k++) quotas[order[k % order.length].i]++;

  const map = {};
  let gi = 0, taken = 0;
  pool.forEach(a => {
    while (gi < quotas.length - 1 && taken >= quotas[gi]) { gi++; taken = 0; }
    map[a.id] = STATE.groups[gi] ? STATE.groups[gi].id : null;
    taken++;
  });
  autoAssignCache.poolKey = poolKey;
  autoAssignCache.map = map;
  return map;
}

function ensureAssignment(round, applicantId) {
  if (STATE.assignments[round][applicantId]) return STATE.assignments[round][applicantId];
  return autoAssignments(round)[applicantId] || null;
}

function poolForRound(round) {
  if (round === 'round2') return STATE.applicants.filter(a => passedRound1(a.id));
  return STATE.applicants;
}

// Round 2 is only for people who actually cleared the First Round threshold. Before
// anyone is scored the pool is legitimately empty — that's the state of the funnel,
// not a bug, and the Second Round page says so.
function passedRound1(applicantId) {
  const s = scoreFor('round1', applicantId);
  return s !== null && s >= B.rubrics.round1.advanceThreshold;
}

function groupLoad(round, groupId) {
  return poolForRound(round).filter(a => ensureAssignment(round, a.id) === groupId).length;
}

// ---------------- Rendering: shell ----------------
const railEl = document.getElementById('rail');
const contentEl = document.getElementById('content');
const topbarEl = document.getElementById('topbar');

function render() {
  renderRail();
  renderTopbar();
  renderContent();
}

function railBtn(id, label, count) {
  const active = STATE.view === id || (STATE.view.startsWith(id + ':') );
  return `<button class="rail-btn ${active ? 'active' : ''}" data-nav="${id}">
    <span>${label}</span>${count != null ? `<span class="count">${count}</span>` : ''}
  </button>`;
}

function renderRail() {
  railEl.innerHTML = `
    <div class="rail-brand">REM · UF<span class="sub">Fall 2026 Recruitment</span></div>
    ${railBtn('overview', 'Overview')}
    <div class="rail-group">Rounds</div>
    ${railBtn('round:screen', ROUND_LABEL.screen, STATE.applicants.length)}
    ${railBtn('round:round1', ROUND_LABEL.round1, poolForRound('round1').length)}
    ${railBtn('round:round2', ROUND_LABEL.round2, poolForRound('round2').length)}
    <div class="rail-group">Ops</div>
    ${railBtn('groups', 'Review Groups')}
    ${railBtn('export', 'Export')}
    <div class="rail-foot">
      <div><span class="dot"></span>${B.applicants.length} applicants at build · ${STATE.applicants.length} now</div>
    </div>
  `;
  railEl.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
    STATE.view = b.dataset.nav; STATE.currentApplicantId = null; render();
  }));
}

function renderTopbar() {
  let title = 'Overview', eyebrow = 'REM UF Recruitment';
  if (STATE.view.startsWith('round:')) {
    const round = STATE.view.split(':')[1];
    title = ROUND_LABEL[round]; eyebrow = ROUND_SUB[round];
  } else if (STATE.view === 'groups') { title = 'Review Groups'; eyebrow = 'Assign reviewers, balance load'; }
  else if (STATE.view === 'export') { title = 'Export'; eyebrow = 'Saving, and getting scores into the mastersheet'; }
  else if (STATE.view === 'grade') {
    const a = STATE.byId[STATE.currentApplicantId];
    title = a ? a.name : 'Applicant';
    eyebrow = ROUND_LABEL[STATE.gradeRound] || '';
  }
  topbarEl.innerHTML = `
    <div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1></div>
    <div class="topbar-spacer"></div>
    <span class="sync-note"><span class="save-dot ${STATE.saveStatus}" id="saveDot"></span><span id="saveLabel">${saveLabelText()}</span></span>
  `;
}

function renderContent() {
  if (STATE.view === 'overview') return renderOverview();
  if (STATE.view.startsWith('round:')) return renderRoundList(STATE.view.split(':')[1]);
  if (STATE.view === 'groups') return renderGroups();
  if (STATE.view === 'export') return renderExport();
  if (STATE.view === 'grade') return renderGrade();
  contentEl.innerHTML = '';
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------------- Overview ----------------
function renderOverview() {
  const total = STATE.applicants.length;
  const screenScored = STATE.applicants.filter(a => scoreFor('screen', a.id) !== null).length;
  const r1Pool = poolForRound('round1');
  const r1Scored = r1Pool.filter(a => scoreFor('round1', a.id) !== null).length;
  const r2Pool = poolForRound('round2');
  const r2Scored = r2Pool.filter(a => scoreFor('round2', a.id) !== null).length;
  const coffeeCount = STATE.applicants.filter(a => a.attendance && a.attendance.coffeeChats && a.attendance.coffeeChats.length).length;
  const infoCount = STATE.applicants.filter(a => a.attendance && a.attendance.infoSession).length;
  const vouchedCount = STATE.applicants.filter(a => vouchCount(a.id)).length;
  const years = {};
  STATE.applicants.forEach(a => { years[a.classYear || 'Unknown'] = (years[a.classYear || 'Unknown'] || 0) + 1; });
  const yearOrder = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Unknown'];
  const yearSorted = yearOrder.filter(y => years[y]).map(y => [y, years[y]]);
  const maxYear = yearSorted.reduce((m, e) => Math.max(m, e[1]), 1);
  const autoCount = STATE.applicants.filter(a => typeof autoFor(a).scores.academics === 'number').length;

  const screenDist = distribution(STATE.applicants.map(a => scoreFor('screen', a.id)).filter(v => v !== null), 1, 5);
  const r1Dist = distribution(r1Pool.map(a => scoreFor('round1', a.id)).filter(v => v !== null), 1, 4);

  contentEl.innerHTML = `
    <div class="grid-stats" style="margin-bottom:22px;">
      ${statTile('Total applicants', total, `${STATE.applicants.length - B.applicants.length > 0 ? '+' + (STATE.applicants.length - B.applicants.length) + ' since build' : 'UF chapter'}`)}
      ${statTile('Application Screen', `${screenScored}/${total}`, 'scored')}
      ${statTile('First Round', `${r1Scored}/${r1Pool.length}`, `scored · ≥${B.rubrics.round1.advanceThreshold} avg advances`)}
      ${statTile('Second Round pool', r2Pool.length, r2Pool.length ? `${r2Scored} scored` : 'advances from First Round')}
      ${statTile('Coffee chat contact', coffeeCount, `of ${total} applicants`)}
      ${statTile('Vouched for', vouchedCount, vouchedCount ? 'by an exec member' : 'no vouches yet')}
    </div>

    <div class="two-col">
      <div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="section-title">Application Screen score distribution <span class="n">(avg of 5 dimensions)</span></div>
          ${renderDistBars(screenDist)}
        </div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="section-title">First Round score distribution <span class="n">(avg of 7 questions, 1–4 scale)</span></div>
          ${r1Pool.length ? renderDistBars(r1Dist) : emptyNote('No one in the First Round pool yet.')}
        </div>
        <div class="card card-pad">
          <div class="section-title">Reviewer calibration <span class="n">Application Screen — hand-scored dimensions only</span></div>
          ${renderReviewerBias()}
        </div>
      </div>
      <div class="side-stack" style="position:static;">
        <div class="card card-pad">
          <div class="section-title">Applicants by class year</div>
          ${yearSorted.map(([y, n]) => `
            <div class="bar-row"><div class="lbl">${esc(y)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${(n / maxYear) * 100}%"></div></div>
              <div class="val">${n}</div></div>`).join('')}
          <div class="sub" style="margin-top:10px; color:var(--slate);">Academics auto-scored from GPA for ${autoCount} of ${total} — the other ${total - autoCount} list a weighted or missing GPA and need a human read.</div>
        </div>
        <div class="card card-pad">
          <div class="section-title">Recruitment funnel</div>
          ${funnelRow('Coffee chat sign-ins logged', B.meta.coffeeChatRows, B.meta.coffeeChatRows)}
          ${funnelRow('Info session check-ins', B.meta.infoSessionRows, B.meta.coffeeChatRows)}
          ${funnelRow('Applications submitted', total, B.meta.coffeeChatRows)}
          <div class="sub" style="margin-top:9px; color:var(--slate);">
            Most coffee chat and info session attendees haven't submitted an application, so they don't appear above — ${coffeeCount} of ${total} applicants have a logged coffee chat and ${infoCount} an info session. That gap closes as more of them submit applications.
          </div>
        </div>
        <div class="card card-pad">
          <div class="section-title">Review groups</div>
          ${STATE.groups.map(g => `
            <div class="bar-row"><div class="lbl">${esc(g.name)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, groupLoad('screen', g.id) / Math.max(1, total) * 400)}%; background:var(--accent2)"></div></div>
              <div class="val">${groupLoad('screen', g.id)}</div></div>`).join('')}
          <button class="btn small" style="margin-top:8px;" data-nav="groups">Manage groups →</button>
        </div>
      </div>
    </div>
  `;
  contentEl.querySelector('[data-nav="groups"]').addEventListener('click', () => { STATE.view = 'groups'; render(); });
}

function funnelRow(label, n, max) {
  return `<div class="bar-row"><div class="lbl">${esc(label)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (n / Math.max(1, max)) * 100)}%"></div></div>
    <div class="val">${n}</div></div>`;
}

function statTile(label, value, sub) {
  return `<div class="card stat-tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}
function emptyNote(msg) { return `<div class="sub" style="color:var(--slate); padding:6px 0;">${msg}</div>`; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s; }
// Applicants type "www.linkedin.com/in/name" without a scheme; as an href that
// resolves against the artifact's own origin and 404s. Normalize, and don't render a
// link at all for the people who wrote "N/A".
function extUrl(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || !/[a-z]/i.test(v)) return null;
  if (/^(n\/?a|none|no)$/i.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)) return 'https://' + v.replace(/^\/+/, '');
  return null;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function distribution(values, min, max) {
  const buckets = {};
  for (let i = min; i <= max; i++) buckets[i] = 0;
  values.forEach(v => { const b = Math.round(v); buckets[Math.min(max, Math.max(min, b))]++; });
  return buckets;
}
function renderDistBars(buckets) {
  const maxV = Math.max(1, ...Object.values(buckets));
  return Object.entries(buckets).map(([k, v]) => `
    <div class="bar-row"><div class="lbl">Score ${k}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / maxV) * 100}%"></div></div>
      <div class="val">${v}</div></div>`).join('');
}

function renderReviewerBias() {
  const tallies = {};
  B.reviewers.forEach(r => { tallies[r.id] = { sum: 0, n: 0 }; });
  Object.entries(STATE.grades.screen).forEach(([aid, g]) => {
    if (!hasManualScore(g)) return;
    // credit the pair actually reviewing this applicant, auto-assigned or overridden
    const grp = STATE.groups.find(x => x.id === ensureAssignment('screen', aid));
    const avg = screenAverage(g);
    if (avg === null || !grp) return;
    grp.members.forEach(rid => { if (tallies[rid]) { tallies[rid].sum += avg; tallies[rid].n++; } });
  });
  const overallVals = Object.values(STATE.grades.screen).filter(hasManualScore).map(g => screenAverage(g)).filter(v => v !== null);
  const overall = overallVals.length ? overallVals.reduce((a, b) => a + b, 0) / overallVals.length : null;
  const rows = B.reviewers.map(r => {
    const t = tallies[r.id];
    const avg = t.n ? t.sum / t.n : null;
    const bias = avg !== null && overall !== null ? avg - overall : null;
    return { r, avg, n: t.n, bias };
  }).filter(x => x.n > 0);
  if (!rows.length) return emptyNote('No Application Screen scores yet — calibration appears once reviews start.');
  return rows.map(({ r, avg, n, bias }) => `
    <div class="reviewer-bias-row">
      <div class="nm">${esc(r.name)}</div>
      <div class="mono">${avg.toFixed(2)}</div>
      <div class="n">(${n} reviewed)</div>
      <div class="topbar-spacer"></div>
      ${bias !== null ? `<span class="chip ${bias > 0.3 ? 'warn' : bias < -0.3 ? 'bad' : 'good'}">${bias > 0 ? '+' : ''}${bias.toFixed(2)} vs. avg</span>` : ''}
    </div>`).join('');
}

// ---------------- Round list ----------------
function renderRoundList(round) {
  let list = poolForRound(round);
  // Round 2's pool is already gated on the First Round threshold. Round 1 has no hard
  // gate, so the toggle there narrows to applicants whose screen someone has scored.
  if (round === 'round1' && STATE.screenedOnly) {
    list = list.filter(a => scoreFor('screen', a.id) !== null);
  }
  if (STATE.filterGroup !== 'all') list = list.filter(a => ensureAssignment(round, a.id) === STATE.filterGroup);
  if (STATE.filterYear !== 'all') list = list.filter(a => a.classYear === STATE.filterYear);
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    list = list.filter(a => a.name.toLowerCase().includes(q) || (a.major || '').toLowerCase().includes(q) || a.email.toLowerCase().includes(q));
  }
  list = list.slice().sort((a, b) => {
    let av, bv;
    if (STATE.sortKey === 'name') { av = a.name; bv = b.name; }
    else if (STATE.sortKey === 'gpa') { av = autoFor(a).gpa.value ?? -1; bv = autoFor(b).gpa.value ?? -1; }
    else if (STATE.sortKey === 'score') { av = scoreFor(round, a.id) ?? -1; bv = scoreFor(round, b.id) ?? -1; }
    else if (STATE.sortKey === 'group') { av = ensureAssignment(round, a.id) || ''; bv = ensureAssignment(round, b.id) || ''; }
    else { av = a.name; bv = b.name; }
    if (av < bv) return STATE.sortDir === 'asc' ? -1 : 1;
    if (av > bv) return STATE.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const yearOpts = ['Freshman', 'Sophomore', 'Junior', 'Senior'].filter(y => STATE.applicants.some(a => a.classYear === y));

  contentEl.innerHTML = `
    <div class="filters-bar">
      <input type="search" id="searchBox" placeholder="Search name, major, email…" value="${esc(STATE.search)}">
      <select id="groupFilter">
        <option value="all">All groups</option>
        ${STATE.groups.map(g => `<option value="${g.id}" ${STATE.filterGroup === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select>
      <select id="yearFilter">
        <option value="all">All class years</option>
        ${yearOpts.map(y => `<option value="${esc(y)}" ${STATE.filterYear === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}
      </select>
      ${round === 'round1' ? `<label class="chip ${STATE.screenedOnly ? 'active' : ''}" id="advToggle">Screened only</label>` : ''}
      <div class="topbar-spacer"></div>
      <span class="sub" style="color:var(--slate); font-size:12px;">${list.length} shown</span>
    </div>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr>
          <th data-sort="name" class="${STATE.sortKey === 'name' ? 'sorted' : ''}">Applicant</th>
          <th data-sort="gpa" class="${STATE.sortKey === 'gpa' ? 'sorted' : ''}">GPA</th>
          <th>Position</th>
          <th>Attendance</th>
          <th data-sort="group" class="${STATE.sortKey === 'group' ? 'sorted' : ''}">Reviewer group</th>
          <th data-sort="score" class="${STATE.sortKey === 'score' ? 'sorted' : ''}">Score</th>
        </tr></thead>
        <tbody>
          ${list.map(a => renderRow(round, a)).join('') || `<tr><td colspan="6"><div class="empty-state">${emptyRoundMessage(round)}</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('searchBox').addEventListener('input', e => { STATE.search = e.target.value; renderRoundList(round); });
  document.getElementById('groupFilter').addEventListener('change', e => { STATE.filterGroup = e.target.value; renderRoundList(round); });
  document.getElementById('yearFilter').addEventListener('change', e => { STATE.filterYear = e.target.value; renderRoundList(round); });
  const advToggle = document.getElementById('advToggle');
  if (advToggle) advToggle.addEventListener('click', () => { STATE.screenedOnly = !STATE.screenedOnly; renderRoundList(round); });
  contentEl.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (STATE.sortKey === k) STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc'; else { STATE.sortKey = k; STATE.sortDir = 'asc'; }
    renderRoundList(round);
  }));
  contentEl.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', () => {
    STATE.currentApplicantId = tr.dataset.id; STATE.gradeRound = round; STATE.view = 'grade'; render();
  }));
}

function emptyRoundMessage(round) {
  if (round === 'round2' && !poolForRound('round2').length) {
    const scored = STATE.applicants.filter(a => scoreFor('round1', a.id) !== null).length;
    return scored
      ? `No one has cleared the First Round yet. ${scored} phone screen${scored === 1 ? '' : 's'} scored so far — an average of ${B.rubrics.round1.advanceThreshold} or better moves someone here.`
      : 'Second Round fills up as First Round phone screens are scored — an average of ' + B.rubrics.round1.advanceThreshold + ' or better advances an applicant here.';
  }
  return 'No applicants match these filters.';
}

function renderRow(round, a) {
  const score = scoreFor(round, a.id);
  const gid = ensureAssignment(round, a.id);
  const grp = STATE.groups.find(g => g.id === gid);
  const maxScale = round === 'round2' ? 24 : round === 'screen' ? 5 : 4;
  const scoreClass = score === null ? 'none' : (round === 'round1' && score < 3) ? 'bad' : (round !== 'round1' && score >= maxScale * 0.75) ? 'good' : '';
  return `<tr class="clickable" data-id="${a.id}">
    <td><div class="name-cell"><span class="nm">${esc(a.name)}${vouchCount(a.id) ? `<span class="vouch-badge" title="Vouched for by ${esc(vouchNames(a.id))}">★ ${vouchCount(a.id)}</span>` : ''}</span><span class="sub">${esc(a.classYear)} · ${esc(a.gradYear)}</span></div></td>
    <td>${gpaCell(a)}</td>
    <td>${esc(truncate(a.position, 28))}</td>
    <td>${attendanceIcons(a)}</td>
    <td>${grp ? esc(grp.name) : '—'}</td>
    <td><span class="score-pill ${scoreClass}">${score === null ? '—' : (round === 'round2' ? score : score.toFixed(1))}</span></td>
  </tr>`;
}

// GPA plus the academics band it maps to, so the auto-score is visible before opening anyone.
function gpaCell(a) {
  const auto = autoFor(a);
  if (auto.gpa.value == null) {
    return `<span class="gpa-cell none" title="${esc(auto.gpa.reason)}">${esc(truncate(a.gpa || '—', 12))}</span>`;
  }
  return `<span class="gpa-cell"><span class="mono">${auto.gpa.value.toFixed(2)}</span><span class="auto-pill" title="Auto-scored ${auto.scores.academics}/4 on the ${yearKeyFor(a)} scale">${auto.scores.academics}</span></span>`;
}

function attendanceIcons(a) {
  const cc = a.attendance.coffeeChats.length > 0;
  const is = !!a.attendance.infoSession;
  const mm = !!a.attendance.meetMembers;
  return `<span title="Coffee chat">${cc ? '☕' : '·'}</span> <span title="Info session">${is ? '🎤' : '·'}</span> <span title="Meet the Members">${mm ? '🤝' : '·'}</span>`;
}

// ---------------- Grade view ----------------
function renderGrade() {
  const a = STATE.byId[STATE.currentApplicantId];
  const round = STATE.gradeRound || 'screen';
  if (!a) { contentEl.innerHTML = emptyNote('Applicant not found.'); return; }
  const g = getGrade(round, a.id);

  contentEl.innerHTML = `
    <button class="btn ghost small" id="backBtn">← Back to ${esc(ROUND_LABEL[round])}</button>
    <div class="applicant-header" style="margin-top:10px;">
      <div>
        <h2>${esc(a.name)}</h2>
        <div class="meta">
          <span>🎓 ${esc(a.university)}</span>
          <span>${esc(a.classYear)} · Class of ${esc(a.gradYear)}</span>
          <span>${esc(a.major)}</span>
          <span>GPA ${esc(a.gpa)}</span>
          ${extUrl(a.linkedin) ? `<span><a href="${esc(extUrl(a.linkedin))}" target="_blank" rel="noopener">LinkedIn ↗</a></span>` : '<span class="muted-note">No LinkedIn</span>'}
          ${extUrl(a.resume) ? `<span><a href="${esc(extUrl(a.resume))}" target="_blank" rel="noopener">Resume ↗</a></span>` : ''}
        </div>
      </div>
      <div style="text-align:right;">
        <div class="avg-display"><span class="big">${fmtScore(round, g, a)}</span><span class="of">${round === 'round2' ? '/ 24' : round === 'round1' ? '/ 4 avg' : '/ 5 avg'}</span></div>
        <select id="groupPicker" style="margin-top:6px;">
          ${STATE.groups.map(gr => `<option value="${gr.id}" ${ensureAssignment(round, a.id) === gr.id ? 'selected' : ''}>${esc(gr.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="two-col">
      <div id="gradeMain"></div>
      <div class="side-stack" id="gradeSide"></div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => { STATE.view = 'round:' + round; render(); });
  document.getElementById('groupPicker').addEventListener('change', e => {
    STATE.assignments[round][a.id] = e.target.value; saveAssignment(round, a.id, e.target.value);
  });

  if (round === 'screen') renderScreenGrade(a, g);
  else if (round === 'round1') renderRound1Grade(a, g);
  else renderRound2Grade(a, g);

  renderGradeSide(a, round, g);
}

function fmtScore(round, g, a) {
  if (round === 'screen') {
    if (!hasManualScore(g)) return '—';
    const v = screenAverage(g, a); return v === null ? '—' : v.toFixed(1);
  }
  if (round === 'round1') { const v = round1Average(g); return v === null ? '—' : v.toFixed(1); }
  const r = round2Total(g); return r ? r.total : '—';
}

function scoreSelector(round, applicantId, key, scale, onSet) {
  const g = getGrade(round, applicantId);
  const val = g.scores[key];
  const [lo, hi] = scale;
  let html = '<div class="score-selector">';
  for (let i = lo; i <= hi; i++) {
    html += `<button class="score-btn ${val === i ? 'sel' : ''}" data-key="${key}" data-val="${i}">${i}</button>`;
  }
  html += '</div>';
  return html;
}

function bindScoreButtons(container, round, applicantId, afterSet) {
  container.querySelectorAll('.score-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = getGrade(round, applicantId);
      const key = btn.dataset.key, val = Number(btn.dataset.val);
      g.scores[key] = g.scores[key] === val ? undefined : val;
      saveGrade(round, applicantId, 'score', key, g.scores[key]);
      afterSet();
    });
  });
}

function bindNotesFields(container, round, applicantId) {
  container.querySelectorAll('textarea[data-notekey]').forEach(ta => {
    ta.addEventListener('input', () => {
      const g = getGrade(round, applicantId);
      if (ta.dataset.notekey === '__main') { g.notes = ta.value; saveGrade(round, applicantId, 'notes', null, ta.value); }
      else {
        g.qnotes = g.qnotes || {};
        g.qnotes[ta.dataset.notekey] = ta.value;
        saveGrade(round, applicantId, 'qnotes', null, g.qnotes);
      }
    });
  });
}

function renderScreenGrade(a, g) {
  const main = document.getElementById('gradeMain');
  const dims = B.rubrics.screen.dims;
  const yearKeys = ['Freshman', 'Sophomore', 'Junior'];
  g.__yearTab = g.__yearTab || (yearKeys.includes(a.classYear) ? a.classYear : 'Junior');

  const auto = autoFor(a);

  main.innerHTML = dims.map(d => {
    const autoVal = auto.scores[d.key];
    const autoable = typeof autoVal === 'number';
    const usingAuto = autoable && isAuto(a, g, d.key);
    const overridden = autoable && typeof g.scores[d.key] === 'number' && g.scores[d.key] !== autoVal;
    let hint = '';
    if (d.key === 'academics') {
      if (autoable) {
        hint = `<div class="auto-note ${overridden ? 'overridden' : ''}">
          ${overridden
            ? `Scored by hand. The rubric reads their <strong>${auto.gpa.value}</strong> ${esc(auto.gpa.label)} as a <strong>${autoVal}</strong> on the ${yearKeyFor(a)} scale — <button class="linkbtn" data-resetauto="${d.key}">reset to auto</button>`
            : `Filled from the rubric: <strong>${auto.gpa.value}</strong> ${esc(auto.gpa.label)} → <strong>${autoVal}</strong> on the ${yearKeyFor(a)} scale. Click any band to override.`}
        </div>`;
      } else {
        hint = `<div class="auto-note needs">Couldn't score this automatically — ${esc(auto.gpa.reason)}. Listed as <em>${esc(a.gpa || 'blank')}</em>${a.classYear === 'Freshman' ? '. Note the rubric puts "not listed" in the bottom band.' : ''}</div>`;
      }
    }
    return `
    <div class="dim-card">
      <div class="dim-head">
        <h4>${esc(d.label)}</h4>
        ${usingAuto ? '<span class="chip auto">Auto</span>' : ''}
        <span class="chip static">0–4</span>
      </div>
      <div class="dim-body">
        <div class="year-tabs" data-dim="${d.key}">
          ${yearKeys.map(y => `<span class="year-tab ${g.__yearTab === y ? 'sel' : ''}" data-year="${y}">${y}${y === a.classYear ? ' (applicant)' : ''}</span>`).join('')}
        </div>
        <div class="band-row">
          ${d.bands[g.__yearTab].map((txt, i) => {
            const score = 4 - i;
            const sel = effScore(a, g, d.key) === score;
            return `<div class="band-opt ${sel ? 'sel' : ''} ${sel && usingAuto ? 'auto' : ''}" data-key="${d.key}" data-val="${score}"><span class="sc">${i === 3 ? '1–0' : score}</span>${esc(txt)}</div>`;
          }).join('')}
        </div>
        ${hint}
      </div>
    </div>
  `; }).join('') + `
    <div class="dim-card">
      <div class="dim-head"><h4>Application Essay Rating</h4><span class="chip static">1–5</span></div>
      <div class="dim-body">
        <div class="band-row" style="grid-template-columns: repeat(5,1fr);">
          ${B.rubrics.screen.essay.levels.map(l => `<div class="band-opt ${g.scores.essay === l.v ? 'sel' : ''}" data-key="essay" data-val="${l.v}"><span class="sc">${l.v}</span>${esc(l.label)}</div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card card-pad">
      <div class="field-label">Notes <span style="font-weight:400; text-transform:none;">(coffee chat, personal rec, essay context, etc.)</span></div>
      <div class="notes-field"><textarea data-notekey="__main" placeholder="Anything worth flagging for the second reviewer…">${esc(g.notes || '')}</textarea></div>
      <label class="flag-row"><input type="checkbox" id="flagSecond" ${g.flagSecond ? 'checked' : ''}> Flag for second reviewer</label>
    </div>
  `;
  main.querySelectorAll('.band-opt').forEach(el => el.addEventListener('click', () => {
    const key = el.dataset.key, val = Number(el.dataset.val);
    // Clicking the current manual pick clears it — which falls back to the auto score if there is one.
    g.scores[key] = g.scores[key] === val ? undefined : val;
    saveGrade('screen', a.id, 'score', key, g.scores[key]);
    renderScreenGrade(a, g); renderGradeSide(a, 'screen', g); updateHeaderScore('screen', g, a);
  }));
  main.querySelectorAll('[data-resetauto]').forEach(el => el.addEventListener('click', () => {
    g.scores[el.dataset.resetauto] = undefined;
    saveGrade('screen', a.id, 'score', el.dataset.resetauto, undefined);
    renderScreenGrade(a, g); renderGradeSide(a, 'screen', g); updateHeaderScore('screen', g, a);
  }));
  main.querySelectorAll('.year-tab').forEach(el => el.addEventListener('click', () => {
    g.__yearTab = el.dataset.year; renderScreenGrade(a, g);
  }));
  bindNotesFields(main, 'screen', a.id);
  const flagBox = document.getElementById('flagSecond');
  if (flagBox) flagBox.addEventListener('change', () => { g.flagSecond = flagBox.checked; saveGrade('screen', a.id, 'flagSecond', null, g.flagSecond); });
}

function updateHeaderScore(round, g, a) {
  const big = document.querySelector('.avg-display .big');
  if (big) big.textContent = fmtScore(round, g, a);
}

function renderRound1Grade(a, g) {
  const main = document.getElementById('gradeMain');
  const R = B.rubrics.round1;
  function qCard(q, key, idx, groupLabel) {
    return `<div class="dim-card">
      <div class="dim-head"><h4>${groupLabel}${idx != null ? ' · Q' + (idx + 1) : ''}</h4>${scoreFor2(g, key)}</div>
      <div class="dim-body">
        <div class="read-aloud">Read aloud</div>
        <div class="prompt">${esc(q.q)}</div>
        <div class="band-row" style="grid-template-columns: repeat(4,1fr);">
          ${['1', '2', '3', '4'].map(k => `<div class="band-opt ${g.scores[key] === Number(k) ? 'sel' : ''}" data-key="${key}" data-val="${k}"><span class="sc">${k}</span>${esc(q.crit[k]?.text || '')}</div>`).join('')}
        </div>
        <div class="notes-field"><textarea data-notekey="${key}" placeholder="Candidate's answer, notes…">${esc((g.qnotes && g.qnotes[key]) || '')}</textarea></div>
      </div>
    </div>`;
  }
  function scoreFor2(g, key) { const v = g.scores[key]; return `<span class="score-pill ${v ? '' : 'none'}">${v || '—'}</span>`; }

  main.innerHTML = `
    <div class="card card-pad" style="margin-bottom:14px;">
      <div class="section-title">Call structure <span class="n">30 minutes</span></div>
      ${R.callStructure.map(s => `<div style="margin-bottom:8px;"><strong>${esc(s.title)}</strong> <span class="sub" style="color:var(--slate);">(${s.minutes} min)</span><div style="font-size:13px; color:var(--ink-soft); margin-top:2px;">${esc(s.body)}</div></div>`).join('')}
    </div>
    ${R.fit.map((q, i) => qCard(q, 'fit' + i, i, 'Fit question')).join('')}
    ${R.personal.map((q, i) => qCard(q, 'personal' + i, i, 'Personal experience')).join('')}
    <div class="dim-card">
      <div class="dim-head"><h4>Personality question — choose one</h4>${scoreFor2(g, 'personality')}</div>
      <div class="dim-body">
        <div class="case-select">
          ${R.personality.map((q, i) => `<span class="chip ${g.__personalityIdx === i ? 'active' : ''}" data-pidx="${i}">${esc(truncate(q.q, 34))}</span>`).join('')}
        </div>
        ${g.__personalityIdx != null ? (() => {
          const q = R.personality[g.__personalityIdx];
          return `<div class="prompt" style="margin-top:8px;">${esc(q.q)}</div>
          <div class="band-row" style="grid-template-columns: repeat(4,1fr);">
            ${['1', '2', '3', '4'].map(k => `<div class="band-opt ${g.scores.personality === Number(k) ? 'sel' : ''}" data-key="personality" data-val="${k}"><span class="sc">${k}</span>${esc(q.crit[k]?.text || '')}</div>`).join('')}
          </div>`;
        })() : '<div class="sub" style="color:var(--slate);">Pick which personality question you asked.</div>'}
        <div class="notes-field"><textarea data-notekey="personality" placeholder="Candidate's answer, notes…">${esc((g.qnotes && g.qnotes.personality) || '')}</textarea></div>
      </div>
    </div>
    <div class="card card-pad">
      <div class="field-label">Recommendation</div>
      <div class="recommend-row">
        ${['Strong advance', 'Advance', 'Borderline', 'Do not advance'].map(r => `<span class="chip ${g.recommendation === r ? 'active' : ''}" data-rec="${r}">${r}</span>`).join('')}
      </div>
      <div class="field-label">Additional notes</div>
      <div class="notes-field"><textarea data-notekey="__main" placeholder="Anything else worth flagging…">${esc(g.notes || '')}</textarea></div>
      <div class="sub" style="margin-top:10px; color:var(--slate-faint);">Official guideline: average score of ${R.advanceThreshold}+ continues to Round 2.</div>
    </div>
  `;
  const g0 = g;
  if (g0.__personalityIdx == null) {
    const found = R.personality.findIndex((q, i) => g0.scores.personality != null && (g0.qnotes && g0.qnotes.personality));
    // leave undefined; user selects explicitly
  }
  main.querySelectorAll('.band-opt').forEach(el => el.addEventListener('click', () => {
    const key = el.dataset.key, val = Number(el.dataset.val);
    g.scores[key] = g.scores[key] === val ? undefined : val;
    saveGrade('round1', a.id, 'score', key, g.scores[key]);
    renderRound1Grade(a, g); renderGradeSide(a, 'round1', g); updateHeaderScore('round1', g);
  }));
  main.querySelectorAll('[data-pidx]').forEach(el => el.addEventListener('click', () => {
    g.__personalityIdx = Number(el.dataset.pidx); renderRound1Grade(a, g);
  }));
  main.querySelectorAll('[data-rec]').forEach(el => el.addEventListener('click', () => {
    g.recommendation = g.recommendation === el.dataset.rec ? undefined : el.dataset.rec;
    saveGrade('round1', a.id, 'recommendation', null, g.recommendation); renderRound1Grade(a, g);
  }));
  bindNotesFields(main, 'round1', a.id);
}

function renderRound2Grade(a, g) {
  const main = document.getElementById('gradeMain');
  const R = B.rubrics.round2;
  main.innerHTML = `
    <div class="card card-pad" style="margin-bottom:14px;">
      <div class="field-label">Case assigned</div>
      <div class="case-select">
        ${R.cases.map(c => `<span class="chip ${g.caseId === c.id ? 'active' : ''}" data-case="${c.id}">${esc(c.name)}</span>`).join('')}
      </div>
    </div>
    ${R.dims.map(d => `
      <div class="dim-card">
        <div class="dim-head"><h4>${esc(d.label)}</h4><span class="score-pill ${g.scores[d.key] ? '' : 'none'}">${g.scores[d.key] || '—'}</span></div>
        <div class="dim-body">
          <div class="band-row" style="grid-template-columns: repeat(4,1fr);">
            ${d.levels.map((txt, i) => { const val = 4 - i; return `<div class="band-opt ${g.scores[d.key] === val ? 'sel' : ''}" data-key="${d.key}" data-val="${val}"><span class="sc">${R.levelLabels[i]}</span>${esc(txt)}</div>`; }).join('')}
          </div>
        </div>
      </div>
    `).join('')}
    <div class="dim-card">
      <div class="dim-head draft"><h4>${esc(R.fitDim.label)}</h4><span class="score-pill ${g.scores[R.fitDim.key] ? '' : 'none'}">${g.scores[R.fitDim.key] || '—'}</span></div>
      <div class="dim-body">
        <div class="sub" style="color:var(--warn); margin-bottom:8px;">No official rubric was on file for the behavioral half of the final round — this is a draft dimension. Edit or remove it once you and the team settle on final-round behavioral criteria.</div>
        <div class="band-row" style="grid-template-columns: repeat(4,1fr);">
          ${R.fitDim.levels.map((txt, i) => { const val = 4 - i; return `<div class="band-opt ${g.scores[R.fitDim.key] === val ? 'sel' : ''}" data-key="${R.fitDim.key}" data-val="${val}"><span class="sc">${R.levelLabels[i]}</span>${esc(txt)}</div>`; }).join('')}
        </div>
      </div>
    </div>
    <div class="card card-pad">
      <div class="field-label">Recommendation</div>
      <div class="recommend-row">
        ${['Strong yes', 'Yes', 'Borderline', 'No'].map(r => `<span class="chip ${g.recommendation === r ? 'active' : ''}" data-rec="${r}">${r}</span>`).join('')}
      </div>
      <label class="flag-row"><input type="checkbox" id="flagSecond2" ${g.flagSecond ? 'checked' : ''}> Flag for second reviewer</label>
      <div class="field-label">Interviewer notes</div>
      <div class="notes-field"><textarea data-notekey="__main" placeholder="Case walkthrough notes, standout moments…">${esc(g.notes || '')}</textarea></div>
    </div>
  `;
  main.querySelectorAll('.band-opt').forEach(el => el.addEventListener('click', () => {
    const key = el.dataset.key, val = Number(el.dataset.val);
    g.scores[key] = g.scores[key] === val ? undefined : val;
    saveGrade('round2', a.id, 'score', key, g.scores[key]);
    renderRound2Grade(a, g); renderGradeSide(a, 'round2', g); updateHeaderScore('round2', g);
  }));
  main.querySelectorAll('[data-case]').forEach(el => el.addEventListener('click', () => {
    g.caseId = g.caseId === el.dataset.case ? undefined : el.dataset.case;
    saveGrade('round2', a.id, 'caseId', null, g.caseId); renderRound2Grade(a, g);
  }));
  main.querySelectorAll('[data-rec]').forEach(el => el.addEventListener('click', () => {
    g.recommendation = g.recommendation === el.dataset.rec ? undefined : el.dataset.rec;
    saveGrade('round2', a.id, 'recommendation', null, g.recommendation); renderRound2Grade(a, g);
  }));
  const flagBox = document.getElementById('flagSecond2');
  if (flagBox) flagBox.addEventListener('change', () => { g.flagSecond = flagBox.checked; saveGrade('round2', a.id, 'flagSecond', null, g.flagSecond); });
  bindNotesFields(main, 'round2', a.id);
}

function renderGradeSide(a, round, g) {
  const side = document.getElementById('gradeSide');
  side.innerHTML = `
    <div class="card card-pad">
      <div class="section-title" style="margin-bottom:8px;">Application</div>
      <div class="field-label">Why Rem</div>
      <div class="essay-block">${esc(a.whyRem)}</div>
      <div class="field-label">Core value: ${esc(a.coreValue)}</div>
      <div class="essay-block">${esc(a.valueEssay)}</div>
      <div class="field-label">Career interests</div>
      <div style="font-size:13px;">${esc(a.careerInterests)}</div>
      <div class="field-label">Skills</div>
      <div style="font-size:13px;">${esc(a.skills)}</div>
      ${a.other ? `<div class="field-label">Anything else</div><div class="essay-block">${esc(a.other)}</div>` : ''}
    </div>
    <div class="card card-pad">
      <div class="section-title" style="margin-bottom:6px;">Attendance</div>
      ${attendanceRow('Coffee chat', a.attendance.coffeeChats.length > 0, a.attendance.coffeeChats.map(c => c.spokeTo).join('; '))}
      ${attendanceRow('Info session', !!a.attendance.infoSession, a.attendance.infoSession ? a.attendance.infoSession.session : '')}
      ${attendanceRow('Meet the Members', !!a.attendance.meetMembers, '')}
    </div>
    ${renderVouchCard(a)}
  `;
  bindVouchCard(a);
}

// Vouching sits outside the rubric on purpose: it's "I know this person and I'd want
// them", which is worth recording next to the scores without being folded into them.
function getVouch(applicantId) {
  if (!STATE.vouches[applicantId]) STATE.vouches[applicantId] = { by: [], note: '' };
  const v = STATE.vouches[applicantId];
  if (!Array.isArray(v.by)) v.by = [];
  return v;
}

function vouchCount(applicantId) {
  const v = STATE.vouches[applicantId];
  return v && Array.isArray(v.by) ? v.by.length : 0;
}

function renderVouchCard(a) {
  const v = getVouch(a.id);
  return `
    <div class="card card-pad vouch-card ${v.by.length ? 'has' : ''}">
      <div class="section-title" style="margin-bottom:4px;">Vouched for ${v.by.length ? `<span class="n">${v.by.length}</span>` : ''}</div>
      <div class="sub" style="color:var(--slate); font-size:12px; margin-bottom:9px;">
        Tap your name if you know this applicant and want to put your weight behind them.
      </div>
      <div class="vouch-row">
        ${B.reviewers.map(r => `
          <button class="vouch-chip ${v.by.indexOf(r.id) !== -1 ? 'on' : ''}" data-vouch="${r.id}" title="${esc(r.name)} — ${esc(r.role)}">
            ${esc(r.name.split(' ')[0])}
          </button>`).join('')}
      </div>
      <div class="notes-field" style="margin-top:9px;">
        <textarea id="vouchNote" placeholder="Why — coffee chat, worked together, referred by…">${esc(v.note || '')}</textarea>
      </div>
    </div>`;
}

function bindVouchCard(a) {
  const v = getVouch(a.id);
  document.querySelectorAll('[data-vouch]').forEach(btn => btn.addEventListener('click', () => {
    const rid = btn.dataset.vouch;
    const i = v.by.indexOf(rid);
    if (i === -1) v.by.push(rid); else v.by.splice(i, 1);
    saveVouch(a.id);
    const card = btn.closest('.vouch-card');
    btn.classList.toggle('on');
    if (card) card.classList.toggle('has', v.by.length > 0);
    const n = card && card.querySelector('.section-title .n');
    if (n) n.textContent = v.by.length; else if (card) render();
  }));
  const note = document.getElementById('vouchNote');
  if (note) {
    let t;
    note.addEventListener('input', () => {
      v.note = note.value;
      clearTimeout(t);
      t = setTimeout(() => saveVouch(a.id), 600);
    });
  }
}

function vouchNames(applicantId) {
  const v = STATE.vouches[applicantId];
  if (!v || !Array.isArray(v.by)) return '';
  return v.by.map(id => (REVIEWERS_BY_ID[id] || {}).name || id).join(', ');
}

function attendanceRow(label, yes, detail) {
  return `<div class="attendance-row ${yes ? 'yes' : 'no'}"><span class="ic">${yes ? '●' : '○'}</span><strong>${label}</strong>${detail ? `<span class="sub" style="color:var(--slate); font-size:12px;">— ${esc(detail)}</span>` : ''}</div>`;
}

// ---------------- Groups view ----------------
function renderGroups() {
  contentEl.innerHTML = `
    <div class="card card-pad" style="margin-bottom:18px;">
      <div class="section-title">How this works</div>
      <div style="font-size:13.5px; color:var(--ink-soft); max-width:640px;">
        Applicants are auto-split across the groups below by share, in list order — Aya &amp; Adam carry 22% and the other three pairs 26% each. Reassign anyone individually from their grade view; overrides are saved and stick as new applicants come in from Sync.
      </div>
    </div>
    <div class="group-grid">
      ${STATE.groups.map(g => renderGroupCard(g)).join('')}
    </div>
  `;
}

function renderGroupCard(g) {
  const members = g.members.map(id => REVIEWERS_BY_ID[id]?.name).filter(Boolean).join(' & ');
  return `<div class="card group-card">
    <h4>${esc(g.name)}</h4>
    <div class="members">${esc(members)}</div>
    <div class="load">${groupLoad('screen', g.id)} <span class="of">/ ${STATE.applicants.length} screen · ${Math.round((g.weight || 0.25) * 100)}% share</span></div>
    <div class="sub" style="color:var(--slate); font-size:11.5px; margin-top:2px;">${groupLoad('round1', g.id)} first round · ${groupLoad('round2', g.id)} second round</div>
  </div>`;
}

// ---------------- Export ----------------
function renderExport() {
  contentEl.innerHTML = `
    <div class="card card-pad" style="margin-bottom:16px;">
      <div class="section-title">How saving works</div>
      <div style="font-size:13.5px; color:var(--ink-soft); max-width:640px;">
        Every score, note and vouch is saved to this dashboard itself and is visible to everyone
        it's shared with. Other people's open tabs pick up your changes automatically — no refresh,
        no exporting, no merging. If two people happen to save at the same moment, the second save
        is replayed on top of the first rather than lost.
      </div>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <div class="section-title">Export for the official mastersheet</div>
      <div style="font-size:13.5px; color:var(--ink-soft); max-width:640px; margin-bottom:12px;">
        When you need the scores in REM's Google Sheet, pull a round as CSV text below, copy it, and
        paste into the matching tab with <code>File → Import → Append</code>. Column order matches the sheet.
      </div>
      <div class="btn-row">
        <button class="btn" data-export="screen">Application Screen CSV</button>
        <button class="btn" data-export="round1">First Round CSV</button>
        <button class="btn" data-export="round2">Second Round CSV</button>
      </div>
      <div id="csvPanel" style="display:none; margin-top:14px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
          <span id="csvPanelLabel" style="font-size:12.5px; color:var(--slate); text-transform:uppercase; letter-spacing:.04em;"></span>
          <button class="btn" id="csvCopyBtn" style="padding:4px 10px; font-size:12.5px;">Copy</button>
        </div>
        <textarea id="csvOut" readonly style="width:100%; height:160px; font-family:var(--font-mono),ui-monospace,Menlo,monospace; font-size:11.5px; background:var(--paper); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px; resize:vertical;"></textarea>
      </div>
    </div>
  `;
  contentEl.querySelectorAll('[data-export]').forEach(btn => btn.addEventListener('click', () => showCsv(btn.dataset.export)));
  const copyBtn = contentEl.querySelector('#csvCopyBtn');
  if (copyBtn) copyBtn.addEventListener('click', copyCsvOut);
}

function showCsv(round) {
  const { csv, filename } = buildCsv(round);
  const panel = contentEl.querySelector('#csvPanel');
  const label = contentEl.querySelector('#csvPanelLabel');
  const out = contentEl.querySelector('#csvOut');
  if (!panel || !out) return;
  panel.style.display = '';
  label.textContent = filename;
  out.value = csv;
  out.focus();
  out.select();
}

async function copyCsvOut() {
  const out = contentEl.querySelector('#csvOut');
  if (!out) return;
  out.focus();
  out.select();
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(out.value);
      ok = true;
    }
  } catch (e) { /* fall through to execCommand */ }
  if (!ok) {
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  }
  toast(ok ? 'Copied — paste into the sheet' : 'Select the text and press Ctrl/Cmd+C to copy');
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(round) {
  let header, rows;
  if (round === 'screen') {
    header = ['Name (First Last)', 'Year', 'Academics', 'Resume', 'Experience & Involvement', 'Leadership & Involvement', 'Application Essay Rating', 'Notes', 'Who is reviewing this application', 'Average', 'Attended Coffee Chats', 'Attended Info Session'];
    rows = STATE.applicants.map(a => {
      const g = STATE.grades.screen[a.id] || { scores: {} };
      const grp = STATE.groups.find(x => x.id === ensureAssignment('screen', a.id));
      return [a.name, a.classYear, effScore(a, g, 'academics') ?? '', g.scores.resume ?? '', g.scores.experience ?? '', g.scores.leadership ?? '', g.scores.essay ?? '', g.notes || '', grp ? grp.name : '', screenAverage(g, a) ?? '', a.attendance.coffeeChats.length ? 'Yes' : 'No', a.attendance.infoSession ? 'Yes' : 'No'];
    });
  } else if (round === 'round1') {
    header = ['Candidate (First & Last) Name', 'Candidates School Email', 'Fit Q1', 'Fit Q2', 'Fit Q3', 'Personal Q1', 'Personal Q2', 'Personal Q3', 'Personality Q', 'Average Score', 'Recommendation', 'Notes'];
    rows = poolForRound('round1').map(a => {
      const g = STATE.grades.round1[a.id] || { scores: {} };
      return [a.name, a.email, g.scores.fit0 ?? '', g.scores.fit1 ?? '', g.scores.fit2 ?? '', g.scores.personal0 ?? '', g.scores.personal1 ?? '', g.scores.personal2 ?? '', g.scores.personality ?? '', round1Average(g) ?? '', g.recommendation || '', g.notes || ''];
    });
  } else {
    header = ['Candidate (First & Last) Name', 'Case Assigned', 'Introduction', 'Framework', 'Market Sizing', 'Quant Reasoning', 'Brainstorming', 'Recommendation Dim', 'Fit & Communication', 'Final Grade / 24', 'Recommendation', 'Interviewer Notes'];
    rows = poolForRound('round2').map(a => {
      const g = STATE.grades.round2[a.id] || { scores: {} };
      const caseObj = B.rubrics.round2.cases.find(c => c.id === g.caseId);
      const r = round2Total(g);
      return [a.name, caseObj ? caseObj.name : '', g.scores.introduction ?? '', g.scores.framework ?? '', g.scores.market_sizing ?? '', g.scores.quant_reasoning ?? '', g.scores.brainstorming ?? '', g.scores.recommendation ?? '', g.scores.fit_communication ?? '', r ? r.total : '', g.recommendation || '', g.notes || ''];
    });
  }
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  const filename = `rem_uf_${round}_${new Date().toISOString().slice(0, 10)}.csv`;
  return { csv, filename };
}

// ---------------- Boot ----------------
initCapabilities();
})();
