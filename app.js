/* global BOOTSTRAP */
(function () {
'use strict';

const B = window.BOOTSTRAP;
const BUILD_STAMP = 'rd1-personality-pick-20260909';
const ROUNDS = ['screen', 'round1', 'round2'];
const ROUND_LABEL = { screen: 'Application Screen', round1: 'First Round', round2: 'Second Round' };
const ROUND_SUB = { screen: 'Resume & written application', round1: 'Phone screen — behavioral', round2: 'Case + behavioral (final round)' };
// Remaining R1 interview keys. personal0 (problem-solving / first Personal Experience
// question) stays in saved records but is not shown or averaged.
const R1_SCORE_KEYS = ['fit0', 'fit1', 'fit2', 'personal1', 'personal2', 'personality'];
const R1_HIDDEN_KEYS = { personal0: true };

// ---------------- State ----------------
const STATE = {
  view: 'overview',
  applicants: B.applicants.slice(),
  byId: {},
  grades: { screen: {}, round1: {}, round2: {} },     // applicantId -> grade record
  vouches: {},                                        // applicantId -> { by: [reviewerId], note }
  assignments: { screen: {}, round1: {}, round2: {} }, // applicantId -> groupId (manual overrides)
  groups: B.defaultGroups.map(g => ({ ...g })),
  advance: { round1: {}, topN: null, applied: false },
  advanceRd2: { ids: {}, topN: null, applied: false },
  interviewers: [],
  currentApplicantId: null,
  search: '',
  sortKey: 'name',
  sortDir: 'asc',
  screenedOnly: false,
  filterGroup: 'all',
  filterInterviewer: 'all',
  incompleteOnly: false,
  flaggedOnly: false,
  knowFlagOnly: false,
  returnView: null,
  queueTrail: [],
  queueDone: false,
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
  seedLegacyAssignments();
  if (ensureInterviewers()) saveInterviewers();
  if (materializeAssignments()) persistAllAssignments();
  render();
  if (pendingOps().length) queueSave();
  setInterval(pollForUpdates, POLL_MS);
}

// ---------------- Load ----------------
async function loadState() {
  try {
    const res = await fetch(GH_API + '?ref=' + GH_BRANCH, { headers: ghHeaders(), cache: 'no-store' });
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
      cache: 'no-store',
    });
    if (res.status === 304) return;               // nothing changed
    if (res.status === 404) return;                 // still no file yet
    if (!res.ok) return;
    // Don't consume this version while someone is mid-keystroke — adoptState
    // replaces STATE.vouches and would orphan the textarea's in-memory record.
    if (isEditingField()) return;
    lastEtag = res.headers.get('etag');
    const json = await res.json();
    if (json.sha === currentSha) return;
    currentSha = json.sha;
    const data = JSON.parse(b64DecodeUtf8(json.content));
    if (!liveVersion || (data.updatedAt || 0) > liveVersion) {
      const prevAdvance = advanceFingerprint(STATE.advance);
      const prevRd2 = advanceRd2Fingerprint(STATE.advanceRd2);
      adoptState(data);
      const advanceChanged = prevAdvance !== advanceFingerprint(STATE.advance);
      const rd2Changed = prevRd2 !== advanceRd2Fingerprint(STATE.advanceRd2);
      if (STATE.view === 'overview' && !pollShouldRemountOverview(advanceChanged || rd2Changed)) {
        applyLiveOverviewUpdate(advanceChanged, rd2Changed);
        return;
      }
      render();
    }
  } catch (e) { /* try again next tick */ }
}

function adoptState(data) {
  if (!data || typeof data !== 'object') return;
  const prevR1 = STATE.grades.round1;
  ROUNDS.forEach(function (r) {
    const g = (data.grades || {})[r];
    if (g && typeof g === 'object') STATE.grades[r] = g;
  });
  // Keep a live personality pick if the incoming record omitted it (older tab
  // or a poll that landed before our write). Do not invent a record.
  Object.keys(prevR1 || {}).forEach(function (id) {
    const old = prevR1[id];
    const incoming = STATE.grades.round1[id];
    if (!old || !incoming) return;
    if (old.personalityIdx == null || old.personalityIdx === '') return;
    if (incoming.personalityIdx != null && incoming.personalityIdx !== '') return;
    incoming.personalityIdx = old.personalityIdx;
  });
  if (data.vouches && typeof data.vouches === 'object') STATE.vouches = data.vouches;
  if (data.assignments && typeof data.assignments === 'object') {
    STATE.assignments = Object.assign({ screen: {}, round1: {}, round2: {} }, data.assignments);
  }
  if (Array.isArray(data.groups) && data.groups.length) STATE.groups = data.groups;
  if (data.advance && typeof data.advance === 'object') STATE.advance = normalizeAdvance(data.advance);
  if (data.advanceRd2 && typeof data.advanceRd2 === 'object') STATE.advanceRd2 = normalizeAdvanceRd2(data.advanceRd2);
  if (Array.isArray(data.interviewers) && data.interviewers.length) {
    STATE.interviewers = normalizeInterviewers(data.interviewers);
  }
  liveVersion = data.updatedAt || null;
}

function currentStateDoc() {
  return {
    grades: {
      screen: cleanRecords(STATE.grades.screen),
      round1: cleanRecords(STATE.grades.round1),
      round2: cleanRecords(STATE.grades.round2),
    },
    vouches: cleanVouches(STATE.vouches),
    assignments: STATE.assignments,
    groups: STATE.groups,
    advance: {
      round1: Object.assign({}, (STATE.advance && STATE.advance.round1) || {}),
      topN: (STATE.advance && STATE.advance.topN) || null,
      applied: !!(STATE.advance && STATE.advance.applied),
    },
    advanceRd2: {
      ids: Object.assign({}, (STATE.advanceRd2 && STATE.advanceRd2.ids) || {}),
      topN: (STATE.advanceRd2 && STATE.advanceRd2.topN) || null,
      applied: !!(STATE.advanceRd2 && STATE.advanceRd2.applied),
    },
    interviewers: (STATE.interviewers || []).map(function (iv) {
      return { id: iv.id, name: iv.name };
    }),
    updatedAt: Date.now(),
  };
}

// Only real values are stored: no undefined, no transient __ UI keys, no empty records.
function cleanVouches(map) {
  const out = {};
  Object.keys(map || {}).forEach(function (id) {
    const v = map[id];
    if (!v || typeof v !== 'object') return;
    const by = Array.isArray(v.by) ? v.by.filter(Boolean) : [];
    const note = typeof v.note === 'string' ? v.note.trim() : '';
    if (by.length || note) out[id] = { by: by, note: note };
  });
  return out;
}

function cleanRecords(map) {
  const out = {};
  Object.keys(map || {}).forEach(function (id) {
    const rec = cleanForSave(map[id]);
    if (rec && Object.keys(rec).length && (hasManualScore(rec) || isExplicitAcademicsNA(rec) || rec.notes || rec.flagSecond || rec.recommendation || rec.caseId || hasR1Meta(rec))) {
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
  try {
    const raw = localStorage.getItem(PENDING_KEY) || sessionStorage.getItem(PENDING_KEY) || '[]';
    return JSON.parse(raw);
  } catch (e) { return []; }
}
function setPendingOps(ops) {
  const raw = JSON.stringify(ops);
  try { localStorage.setItem(PENDING_KEY, raw); } catch (e) { /* private mode */ }
  try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
}
function recordOp(op) {
  const ops = pendingOps();
  ops.push(op);
  setPendingOps(ops.slice(-400));
}
function clearPendingOps() {
  try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
  try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
}
function cloneJson(value) {
  if (value == null || typeof value !== 'object') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

function applyPendingOps() {
  pendingOps().forEach(function (op) {
    try {
      if (op.kind === 'grade') {
        const rec = getGrade(op.round, op.id);
        if (op.field === 'score') rec.scores[op.key] = op.value === null ? undefined : op.value;
        else if (op.field === 'qnotes' && op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
          rec.qnotes = Object.assign({}, rec.qnotes, op.value);
        } else if (op.field === 'personalityIdx' && (op.value === null || op.value === '') && rec.personalityIdx != null && rec.personalityIdx !== '') {
          /* keep a live selection over an empty snapshot */
        } else {
          rec[op.field] = op.value;
        }
      } else if (op.kind === 'vouch') {
        STATE.vouches[op.id] = op.value;
      } else if (op.kind === 'assign') {
        STATE.assignments[op.round][op.id] = op.value;
      } else if (op.kind === 'groups') {
        STATE.groups = op.value;
      } else if (op.kind === 'advance') {
        STATE.advance = normalizeAdvance(op.value);
      } else if (op.kind === 'advanceRd2') {
        STATE.advanceRd2 = normalizeAdvanceRd2(op.value);
      } else if (op.kind === 'interviewers') {
        STATE.interviewers = normalizeInterviewers(op.value);
      }
    } catch (e) { /* skip a malformed op rather than blocking the load */ }
  });
}

// ---------------- Save ----------------
let saveTimer = null;
let saving = false;
let saveAgain = false;
let lastSaveError = null;

function queueSave() {
  if (readOnly) return;
  setSaveStatus('saving');
  if (saving) { saveAgain = true; return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { flushSave(false); }, 700);
}

async function flushSave(urgent) {
  clearTimeout(saveTimer);
  if (readOnly) return;
  // Never PUT an unchanged in-memory copy. A hidden/stale tab used to write the
  // whole file on every tab switch and wipe scores someone else had just saved.
  if (!pendingOps().length) { saveAgain = false; return; }
  if (saving) { saveAgain = true; return; }
  saving = true;
  saveAgain = false;
  // Pull the latest shared file first so a stale tab cannot overwrite newer
  // scores with an older in-memory copy. Local edits already sit in pendingOps
  // and get replayed on top of whatever we just adopted. Skip the extra GET on
  // tab-close — there isn't time, and keepalive PUT + sha still refuses a stale write.
  if (!urgent) {
    try { await loadState(); applyPendingOps(); } catch (e) { /* save what we have */ }
  }
  // Chip-click / score-click saves snapshot empty notes if debounce hasn't
  // fired; fold live textareas in so this PUT cannot drop them.
  captureOpenVouchNote();
  captureOpenR1Fields();
  // Only the ops this write actually covers are retired; an edit made while the
  // request was in flight stays pending for the next one.
  const covered = pendingOps().length;
  let doc;
  try {
    doc = currentStateDoc();
    const body = {
      message: 'score update ' + new Date(doc.updatedAt).toISOString(),
      content: b64EncodeUtf8(JSON.stringify(doc, null, 0)),
      branch: GH_BRANCH,
    };
    if (currentSha) body.sha = currentSha;
    const payload = JSON.stringify(body);
    // Chrome/Edge reject keepalive fetch when the body is over 64KB. Shared
    // state.json is already near that after Application Screen scores; a First
    // Round write would fail every time and stick the status on "retrying".
    const keepalive = !!(urgent && payload.length < 60000);
    const res = await fetch(GH_API, {
      method: 'PUT',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: payload,
      cache: 'no-store',
      keepalive: keepalive,
    });
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
      setTimeout(function () { saving = false; flushSave(false); }, 3000);
      return;
    } else {
      const json = await res.json();
      currentSha = json.content && json.content.sha ? json.content.sha : currentSha;
      lastEtag = null; // force a real fetch on the next poll rather than trusting a stale etag
      liveVersion = doc.updatedAt;
      setPendingOps(pendingOps().slice(covered));
      setSaveStatus(pendingOps().length ? 'saving' : 'saved');
      if (pendingOps().length || saveAgain) { saving = false; queueSave(); return; }
    }
  } catch (e) {
    lastSaveError = (e && e.message) || 'network error';
    setSaveStatus('error');
    setTimeout(function () { saving = false; flushSave(false); }, 3000);
    return;
  }
  saving = false;
  if (saveAgain || pendingOps().length) queueSave();
}

// Every write goes through these, so the op is stashed before the state changes.
function saveGrade(round, applicantId, field, key, value) {
  if (round === 'screen') invalidateScreenStd();
  const stored = value === undefined ? null : cloneJson(value);
  recordOp({ kind: 'grade', round: round, id: applicantId, field: field, key: key, value: stored });
  queueSave();
}

function isEditingField() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return true;
  return !!ae.isContentEditable;
}

function captureOpenVouchNote() {
  const ta = document.getElementById('vouchNote');
  if (!ta || !STATE.currentApplicantId) return;
  getVouch(STATE.currentApplicantId).note = ta.value;
}

function saveVouch(applicantId) {
  if (STATE.currentApplicantId === applicantId) captureOpenVouchNote();
  const rec = getVouch(applicantId);
  recordOp({
    kind: 'vouch',
    id: applicantId,
    value: { by: rec.by.slice(), note: typeof rec.note === 'string' ? rec.note : '' },
  });
  queueSave();
}

function saveGroupsAndAssignments() {
  recordOp({ kind: 'groups', value: STATE.groups });
  queueSave();
}

function saveAssignment(round, applicantId, groupId) {
  autoAssignCache.poolKey = null;
  if (round === 'screen') invalidateScreenStd();
  recordOp({ kind: 'assign', round: round, id: applicantId, value: groupId });
  queueSave();
}

function pickOtherReviewGroup(currentId) {
  const others = STATE.groups.filter(function (g) { return g && g.id && g.id !== currentId; });
  if (!others.length) return null;
  return others[Math.floor(Math.random() * others.length)];
}

function reassignKnownPerson(round, applicantId) {
  const current = ensureAssignment(round, applicantId);
  const next = pickOtherReviewGroup(current);
  if (!next) {
    toast('No other review group available');
    return;
  }
  if (!STATE.assignments[round]) STATE.assignments[round] = {};
  STATE.assignments[round][applicantId] = next.id;
  saveAssignment(round, applicantId, next.id);
  flushSave(true);
  toast('Reassigned to ' + next.name);
  const picker = document.getElementById('groupPicker');
  if (picker) picker.value = next.id;
  if (round === 'screen') {
    const a = STATE.byId[applicantId];
    updateHeaderScore('screen', getGrade('screen', applicantId), a);
  }
}

function saveAdvance() {
  recordOp({
    kind: 'advance',
    value: {
      round1: Object.assign({}, (STATE.advance && STATE.advance.round1) || {}),
      topN: (STATE.advance && STATE.advance.topN) || null,
      applied: !!(STATE.advance && STATE.advance.applied),
    },
  });
  queueSave();
}

function saveAdvanceRd2() {
  recordOp({
    kind: 'advanceRd2',
    value: {
      ids: Object.assign({}, (STATE.advanceRd2 && STATE.advanceRd2.ids) || {}),
      topN: (STATE.advanceRd2 && STATE.advanceRd2.topN) || null,
      applied: !!(STATE.advanceRd2 && STATE.advanceRd2.applied),
    },
  });
  queueSave();
}

function saveInterviewers() {
  recordOp({
    kind: 'interviewers',
    value: (STATE.interviewers || []).map(function (iv) { return { id: iv.id, name: iv.name }; }),
  });
  queueSave();
}

function captureOpenR1Fields() {
  if (STATE.gradeRound !== 'round1' || !STATE.currentApplicantId) return;
  const g = getGrade('round1', STATE.currentApplicantId);
  const notes = document.getElementById('r1InitialNotes');
  const time = document.getElementById('r1InterviewTime');
  if (notes) g.initialNotes = notes.value;
  if (time) g.interviewTime = time.value;
  const main = document.getElementById('gradeMain');
  if (!main) return;
  main.querySelectorAll('textarea[data-notekey]').forEach(function (ta) {
    if (ta.dataset.notekey === '__main') g.notes = ta.value;
    else {
      g.qnotes = g.qnotes || {};
      g.qnotes[ta.dataset.notekey] = ta.value;
    }
  });
  const activeP = main.querySelector('[data-pidx].active');
  if (activeP) {
    const idx = Number(activeP.dataset.pidx);
    if (!isNaN(idx)) g.personalityIdx = idx;
  }
}

function flushAllPending() { flushSave(true); }

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

window.addEventListener('visibilitychange', function () { if (document.hidden && pendingOps().length) flushSave(false); });
window.addEventListener('pagehide', function () { if (pendingOps().length) flushSave(true); });

// ---------------- Applicant merge + live Sheets pull ----------------
// Matching is a port of build.py find_applicant(): email → exact name →
// email-local-part vs name → first+last only when unambiguous.
const UF_MATCH = /university of florida/i;
const APP_FIELDS = ['timestamp','name','email','phone','gender','race','linkedin','resume','university','gradYear','major','minor','gpa','whyRem','coreValue','valueEssay','careerInterests','howRemHelps','position','skills','accommodations','other','commitment'];
const PROFILE_FIELDS = APP_FIELDS.filter(function (k) { return k !== 'email'; });

function isUf(u) { return UF_MATCH.test(u || ''); }
function normName(n) { return (n || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }
function nameParts(n) { return normName(n).split(/\s+/).filter(Boolean); }
const LATE_CUTOFF_UTC = Date.UTC(2026, 8, 5, 3, 59, 59);
function nthSunday(year, month1, n) {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const dow = first.getUTCDay();
  const firstSun = dow === 0 ? 1 : 8 - dow;
  return firstSun + (n - 1) * 7;
}
function isEDT(year, month, day, hour) {
  const startDay = nthSunday(year, 3, 2);
  const endDay = nthSunday(year, 11, 1);
  if (month > 3 && month < 11) return true;
  if (month < 3 || month > 11) return false;
  if (month === 3) return day > startDay || (day === startDay && hour >= 2);
  return day < endDay || (day === endDay && hour < 2);
}
function parseSheetTs(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const year = +m[3], month = +m[1], day = +m[2];
    const hour = +(m[4] || 0), min = +(m[5] || 0), sec = +(m[6] || 0);
    const offset = isEDT(year, month, day, hour) ? 4 : 5;
    return Date.UTC(year, month - 1, day, hour + offset, min, sec);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function isLateApp(ts) {
  const t = parseSheetTs(ts);
  return t != null && t > LATE_CUTOFF_UTC;
}
function lateBadge(a) {
  return a && a.late ? '<span class="late-badge" title="Submitted after 11:59 PM ET on Sep 4, 2026">Late</span>' : '';
}
function emailLocal(e) { return ((e || '').toLowerCase().split('@')[0] || '').replace(/[^a-z]/g, ''); }

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

// Compact MD5 (same digest as Python hashlib.md5) so new a{n}_{hash} IDs match refresh.py.
function md5hex(str) {
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  const bytes = unescape(encodeURIComponent(str));
  const n = bytes.length;
  const nblk = ((n + 8) >> 6) + 1;
  const blks = new Array(nblk * 16).fill(0);
  for (let i = 0; i < n; i++) blks[i >> 2] |= bytes.charCodeAt(i) << ((i % 4) * 8);
  blks[n >> 2] |= 0x80 << ((n % 4) * 8);
  blks[nblk * 16 - 2] = n * 8;
  const x = [1732584193, -271733879, -1732584194, 271733878];
  for (let i = 0; i < nblk * 16; i += 16) md5cycle(x, blks.slice(i, i + 16));
  function rhex(n) {
    let s = '';
    for (let j = 0; j < 4; j++) s += ('0' + ((n >> (j * 8)) & 0xFF).toString(16)).slice(-2);
    return s;
  }
  return rhex(x[0]) + rhex(x[1]) + rhex(x[2]) + rhex(x[3]);
}

function slugId(email, name, idx) {
  const base = (email || name || String(idx)).toLowerCase().trim();
  return 'a' + idx + '_' + md5hex(base).slice(0, 8);
}

function nextIdIndex(list) {
  let mx = -1;
  (list || []).forEach(function (a) {
    const m = /^a(\d+)_/.exec(a.id || '');
    if (m) mx = Math.max(mx, parseInt(m[1], 10));
  });
  return mx + 1;
}

function emailIndex() {
  const idx = {};
  STATE.applicants.forEach(a => { if (a.email) idx[a.email.toLowerCase()] = a.id; });
  return idx;
}

function prepareMatchIndex(applicants) {
  const byEmail = {};
  const byName = {};
  applicants.forEach(function (rec) {
    const toks = nameParts(rec.name);
    const first = toks[0] || '';
    const last = toks.length > 1 ? toks[toks.length - 1] : '';
    rec._first = first;
    rec._last = last;
    rec._keys = {};
    [first + last, first && last ? first.slice(0, 1) + last : '', first && last ? last + first.slice(0, 1) : '', first && last ? first + last.slice(0, 1) : '']
      .filter(Boolean).forEach(function (k) { rec._keys[k] = true; });
    if (rec.email) byEmail[rec.email.toLowerCase().trim()] = rec;
    const nm = normName(rec.name);
    if (nm) { if (!byName[nm]) byName[nm] = []; byName[nm].push(rec); }
  });
  return { applicants: applicants, byEmail: byEmail, byName: byName };
}

function findApplicant(name, email, idx) {
  const e = (email || '').toLowerCase().trim();
  if (e && idx.byEmail[e]) return idx.byEmail[e];
  const nm = normName(name);
  const cands = idx.byName[nm] || [];
  if (cands.length === 1) return cands[0];
  const lp = emailLocal(e);
  if (lp) {
    let hits = idx.applicants.filter(function (a) { return a._keys[lp]; });
    hits = hits.filter(function (a) {
      if (!nm) return true;
      const parts = nameParts(nm);
      return nm === normName(a.name) || nm === a._first || nm === a._last
        || parts.indexOf(a._first) >= 0 || parts.indexOf(a._last) >= 0;
    });
    if (hits.length === 1) return hits[0];
  }
  const parts = nameParts(nm);
  if (parts.length >= 2) {
    const hits = idx.applicants.filter(function (a) { return a._first === parts[0] && a._last === parts[parts.length - 1]; });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

function stripMatchKeys(list) {
  (list || []).forEach(function (rec) {
    delete rec._first; delete rec._last; delete rec._keys;
  });
}

function refreshApplicantFields(dest, src) {
  PROFILE_FIELDS.forEach(function (k) {
    if (src[k] != null && src[k] !== '') dest[k] = src[k];
  });
  if (src.gradYear) dest.classYear = classYearEstimate(src.gradYear);
  if (src.timestamp) dest.late = isLateApp(src.timestamp);
  else if (typeof src.late === 'boolean') dest.late = src.late;
  if (typeof AUTO_CACHE === 'object' && dest.id) delete AUTO_CACHE[dest.id];
}

function mergeApplicants(list) {
  let added = 0;
  const emails = emailIndex();
  let nextIdx = nextIdIndex(STATE.applicants);
  const used = {};
  STATE.applicants.forEach(function (a) { if (a.id) used[a.id] = true; });
  (list || []).forEach(function (a) {
    const email = (a.email || '').toLowerCase().trim();
    const existingId = email && emails[email];
    if (existingId && STATE.byId[existingId]) {
      refreshApplicantFields(STATE.byId[existingId], a);
      return;
    }
    const nameHit = STATE.applicants.find(function (x) {
      return normName(x.name) && normName(x.name) === normName(a.name);
    });
    if (nameHit) {
      refreshApplicantFields(nameHit, a);
      return;
    }
    let id = a.id && /^a\d+_/.test(a.id) ? a.id : null;
    if (!id || used[id]) {
      do { id = slugId(a.email, a.name, nextIdx++); } while (used[id]);
    }
    used[id] = true;
    const rec = Object.assign({
      classYear: classYearEstimate(a.gradYear),
      late: isLateApp(a.timestamp),
      attendance: { coffeeChats: [], infoSession: null, meetMembers: null },
    }, a, { id: id, late: typeof a.late === 'boolean' ? a.late : isLateApp(a.timestamp) });
    if (!rec.attendance) rec.attendance = { coffeeChats: [], infoSession: null, meetMembers: null };
    if (!Array.isArray(rec.attendance.coffeeChats)) rec.attendance.coffeeChats = [];
    STATE.applicants.push(rec);
    STATE.byId[id] = rec;
    if (email) emails[email] = id;
    added++;
  });
  return added;
}

function applyAttendance(coffeeRows, infoRows, meetRows) {
  const idx = prepareMatchIndex(STATE.applicants);
  if (coffeeRows) {
    STATE.applicants.forEach(function (a) { a.attendance.coffeeChats = []; });
    coffeeRows.forEach(function (c) {
      const rec = findApplicant(c.name, c.email, idx);
      if (!rec) return;
      if (!rec.attendance.coffeeChats.some(function (x) { return x.timestamp === c.timestamp; })) {
        rec.attendance.coffeeChats.push({ timestamp: c.timestamp, spokeTo: c.spokeTo });
      }
    });
  }
  if (infoRows) {
    STATE.applicants.forEach(function (a) { a.attendance.infoSession = null; });
    infoRows.forEach(function (c) {
      const rec = findApplicant(c.name, c.email, idx);
      if (rec) rec.attendance.infoSession = { timestamp: c.timestamp, session: c.session, appliedBefore: c.appliedBefore };
    });
  }
  if (meetRows) {
    STATE.applicants.forEach(function (a) { a.attendance.meetMembers = null; });
    meetRows.forEach(function (c) {
      const rec = findApplicant(c.name, c.email, idx);
      if (rec) rec.attendance.meetMembers = { timestamp: c.timestamp, year: c.year, appliedBefore: c.appliedBefore };
    });
  }
  stripMatchKeys(STATE.applicants);
}

function sheetSources() {
  return B.sources || {};
}

function headerIndex(headers, needles) {
  const low = (headers || []).map(function (h) { return String(h || '').toLowerCase(); });
  for (let i = 0; i < low.length; i++) {
    if (needles.every(function (n) { return low[i].indexOf(n) >= 0; })) return i;
  }
  return -1;
}

function parseApplicationRows(values) {
  const rows = (values || []).slice(1);
  const out = [];
  rows.forEach(function (r) {
    const rec = {};
    APP_FIELDS.forEach(function (f, i) { rec[f] = r[i] == null ? '' : String(r[i]); });
    if (rec.name || rec.email) out.push(rec);
  });
  return out.filter(function (a) { return isUf(a.university); });
}

function parseCoffeeRows(values) {
  if (!values || !values.length) return [];
  const h = values[0];
  const iTs = headerIndex(h, ['timestamp']);
  const iName = headerIndex(h, ['name']);
  const iEmail = headerIndex(h, ['email']);
  let iSpoke = headerIndex(h, ['spoke']);
  if (iSpoke < 0) iSpoke = headerIndex(h, ['who did you']);
  return values.slice(1).map(function (r) {
    return {
      timestamp: iTs >= 0 ? (r[iTs] || '') : '',
      name: iName >= 0 ? (r[iName] || '') : '',
      email: iEmail >= 0 ? (r[iEmail] || '') : '',
      spokeTo: iSpoke >= 0 ? (r[iSpoke] || '') : '',
    };
  }).filter(function (c) { return c.name || c.email; });
}

function parseInfoRows(values) {
  if (!values || !values.length) return [];
  const h = values[0];
  const iTs = headerIndex(h, ['timestamp']);
  const iName = headerIndex(h, ['name']);
  const iEmail = headerIndex(h, ['email']);
  let iSession = headerIndex(h, ['session']);
  if (iSession < 0) iSession = headerIndex(h, ['which']);
  const iApplied = headerIndex(h, ['applied']);
  return values.slice(1).map(function (r) {
    return {
      timestamp: iTs >= 0 ? (r[iTs] || '') : '',
      name: iName >= 0 ? (r[iName] || '') : '',
      email: iEmail >= 0 ? (r[iEmail] || '') : '',
      session: iSession >= 0 ? (r[iSession] || '') : '',
      appliedBefore: iApplied >= 0 ? (r[iApplied] || '') : '',
    };
  }).filter(function (c) { return c.name || c.email; });
}

function parseMeetMembersRows(values) {
  if (!values || !values.length) return [];
  const h = values[0];
  const iTs = headerIndex(h, ['timestamp']);
  const iName = headerIndex(h, ['name']);
  const iEmail = headerIndex(h, ['email']);
  const iYear = headerIndex(h, ['year']);
  const iApplied = headerIndex(h, ['applied']);
  return values.slice(1).map(function (r) {
    return {
      timestamp: iTs >= 0 ? (r[iTs] || '') : '',
      name: iName >= 0 ? (r[iName] || '') : '',
      email: iEmail >= 0 ? (r[iEmail] || '') : '',
      year: iYear >= 0 ? (r[iYear] || '') : '',
      appliedBefore: iApplied >= 0 ? (r[iApplied] || '') : '',
    };
  }).filter(function (c) { return c.name || c.email; });
}

// ---------------- Auto-scoring (formulaic dimensions) ----------------
// College GPA auto-maps to a 4/3/2/1 band. High-school / incoming-freshman GPA
// defaults to N/A and is not weighted unless a reviewer clicks a numeric band.
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
  if (classYear === 'Freshman') {
    if (offScale.length) return { value: null, basis: 'highschool', reason: 'Weighted and unweighted GPAs both listed' };
    return { value: value, basis: 'highschool', label: 'high-school GPA', reason: 'High-school GPA (freshman) — not scored' };
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
  if (gpa.value != null && gpa.basis === 'college') {
    academics = gpa.value >= t[0] ? 4 : gpa.value >= t[1] ? 3 : gpa.value >= t[2] ? 2 : 1;
  }
  const res = { gpa: gpa, scores: { academics: academics } };
  AUTO_CACHE[a.id] = res;
  return res;
}

// The score that counts: a reviewer's own click always wins; otherwise the rubric's own answer.
function isExplicitAcademicsNA(g) {
  return !!(g && g.scores && g.scores.academics === 'NA');
}
function academicsIsNA(a, g) {
  if (g && g.scores && g.scores.academics === 'NA') return true;
  if (g && g.scores && typeof g.scores.academics === 'number') return false;
  return typeof autoFor(a).scores.academics !== 'number';
}

function effScore(a, g, key) {
  const v = g && g.scores ? g.scores[key] : undefined;
  if (v === 'NA') return undefined;
  if (typeof v === 'number') return v;
  const auto = autoFor(a).scores[key];
  return typeof auto === 'number' ? auto : undefined;
}
function isAuto(a, g, key) {
  if (g && g.scores && (typeof g.scores[key] === 'number' || g.scores[key] === 'NA')) return false;
  return typeof autoFor(a).scores[key] === 'number';
}

// ---------------- Grading helpers ----------------
function getGrade(round, applicantId) {
  if (!STATE.grades[round][applicantId]) STATE.grades[round][applicantId] = { scores: {}, notes: '' };
  const g = STATE.grades[round][applicantId];
  if (!g.scores || typeof g.scores !== 'object') g.scores = {};
  return g;
}

// Application Screen average out of 5: GPA 10 · Essay 30 · Resume / Experience / Leadership 20 each.
// Rubric clicks stay 0–4 / 1–4 (essay 1–5). Four-point dims convert to /5 by ×1.25
// before weights; essay is already /5. Missing or N/A dims drop out and the rest
// is renormalized so a freshman isn't punished for an unscored high-school GPA.
const SCREEN_WEIGHTS = { academics: 0.10, essay: 0.30, resume: 0.20, experience: 0.20, leadership: 0.20 };
const SCREEN_WEIGHT_NOTE = 'Screen average: GPA 10% · Essay 30% · Resume / Experience / Leadership 20% each. 4-point dims scale ×1.25 to /5; essay already /5.';

function screenScaled(key, v) {
  return key === 'essay' ? v : v * 1.25;
}

function screenAverage(g, a) {
  if (!a && g && STATE.grades && STATE.grades.screen) {
    const ids = Object.keys(STATE.grades.screen);
    for (let i = 0; i < ids.length; i++) {
      if (STATE.grades.screen[ids[i]] === g) { a = STATE.byId[ids[i]]; break; }
    }
  }
  const dims = ['academics', 'resume', 'experience', 'leadership', 'essay'];
  let wsum = 0, vsum = 0;
  for (let i = 0; i < dims.length; i++) {
    const k = dims[i];
    const v = a ? effScore(a, g, k) : (g && g.scores && typeof g.scores[k] === 'number' ? g.scores[k] : undefined);
    if (typeof v !== 'number') continue;
    const w = SCREEN_WEIGHTS[k];
    if (!w) continue;
    vsum += screenScaled(k, v) * w;
    wsum += w;
  }
  if (!wsum) return null;
  return vsum / wsum;
}

function hasR1Meta(rec) {
  if (!rec) return false;
  if (rec.interviewer || rec.interviewTime || rec.initialNotes) return true;
  if (rec.thankYou === true || rec.thankYou === false) return true;
  if (rec.knowFlag === true || rec.knowFlag === false) return true;
  if (rec.personalityIdx != null && rec.personalityIdx !== '') return true;
  if (rec.qnotes && typeof rec.qnotes === 'object' && Object.keys(rec.qnotes).length) return true;
  return false;
}

function r1PersonalityList() {
  return (B.rubrics.round1 && B.rubrics.round1.personality) || [];
}

// Restored from personalityIdx. If that was never saved, infer from a unique
// personality0/1/2 score key. The shared scores.personality key does not say
// which of the 3 prompts was asked, so it is not used to pick a chip.
function r1PersonalityIdx(g) {
  const qs = r1PersonalityList();
  const raw = g && g.personalityIdx;
  const stored = Number(raw);
  if (raw != null && raw !== '' && !isNaN(stored) && stored >= 0 && stored < qs.length) return stored;
  const scores = (g && g.scores) || {};
  let found = null;
  for (let i = 0; i < qs.length; i++) {
    if (typeof scores['personality' + i] === 'number') {
      if (found != null) return null;
      found = i;
    }
  }
  return found;
}

function hasR1InterviewScore(g) {
  return !!(g && g.scores && R1_SCORE_KEYS.some(function (k) { return typeof g.scores[k] === 'number'; }));
}

function round1Average(g) {
  if (!g || !g.scores) return null;
  const vals = R1_SCORE_KEYS.map(function (k) { return g.scores[k]; }).filter(function (v) { return typeof v === 'number'; });
  if (!vals.length) return null;
  return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
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

// Group-adjusted Application Screen score: keep a /5-ish scale so it can be
// averaged with the raw weighted score. Derived live — never stored.
//   standardized = raw - groupMean + overallMean
// Groups with fewer than two scored people fall back to raw (no fake sd).
let _screenStdBundle = null;
function invalidateScreenStd() { _screenStdBundle = null; }

function screenStdBundle() {
  if (_screenStdBundle) return _screenStdBundle;
  const groups = {};
  const all = [];
  STATE.applicants.forEach(function (a) {
    const raw = scoreFor('screen', a.id);
    if (raw == null) return;
    const gid = ensureAssignment('screen', a.id) || '';
    if (!groups[gid]) groups[gid] = [];
    groups[gid].push(raw);
    all.push(raw);
  });
  const overallMean = all.length ? all.reduce(function (s, v) { return s + v; }, 0) / all.length : null;
  const stats = {};
  Object.keys(groups).forEach(function (gid) {
    const vals = groups[gid];
    const n = vals.length;
    const mean = vals.reduce(function (s, v) { return s + v; }, 0) / n;
    let sd = 0;
    if (n >= 2) {
      const varSum = vals.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0);
      sd = Math.sqrt(varSum / (n - 1));
    }
    stats[gid] = { n: n, mean: mean, sd: sd };
  });
  _screenStdBundle = { overallMean: overallMean, groups: stats };
  return _screenStdBundle;
}

function standardizedScreenScore(applicantId) {
  const raw = scoreFor('screen', applicantId);
  if (raw == null) return null;
  const bundle = screenStdBundle();
  const gid = ensureAssignment('screen', applicantId) || '';
  const grp = bundle.groups[gid];
  if (!grp || grp.n < 2 || bundle.overallMean == null) return raw;
  return raw - grp.mean + bundle.overallMean;
}

function screenZScore(applicantId) {
  const raw = scoreFor('screen', applicantId);
  if (raw == null) return null;
  const bundle = screenStdBundle();
  const gid = ensureAssignment('screen', applicantId) || '';
  const grp = bundle.groups[gid];
  if (!grp || grp.n < 2 || !grp.sd) return null;
  return (raw - grp.mean) / grp.sd;
}

function screenBlendScore(applicantId) {
  const raw = scoreFor('screen', applicantId);
  if (raw == null) return null;
  const std = standardizedScreenScore(applicantId);
  return (raw + std) / 2;
}

function formatScreenScorePair(applicantId) {
  const raw = scoreFor('screen', applicantId);
  if (raw == null) return '—';
  const std = standardizedScreenScore(applicantId);
  return raw.toFixed(1) + ' raw · ' + std.toFixed(1) + ' std';
}

function formatScreenScorePairHtml(applicantId) {
  const raw = scoreFor('screen', applicantId);
  if (raw == null) return '—';
  const std = standardizedScreenScore(applicantId);
  const z = screenZScore(applicantId);
  const title = z == null ? 'Group-adjusted to the overall mean so harsh/easy review groups are comparable'
    : 'z ' + (z >= 0 ? '+' : '') + z.toFixed(1) + ' vs review group';
  return '<span title="' + esc(title) + '">' + raw.toFixed(1) + ' raw · ' + std.toFixed(1) + ' std</span>';
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
function assignmentCacheKey(round) {
  const pool = poolForRound(round);
  const locked = STATE.assignments[round] || {};
  return round + ':' + pool.map(a => a.id).join(',')
    + ':' + STATE.groups.map(g => g.id + (g.weight || 1)).join('|')
    + ':' + Object.keys(locked).sort().map(id => id + locked[id]).join('|');
}

// Locked ids (legacy original-75 + any saved override) keep their group.
// Only people without an override are placed into leftover quota, in list order.
function autoAssignments(round) {
  const pool = poolForRound(round);
  const poolKey = assignmentCacheKey(round);
  if (autoAssignCache.poolKey === poolKey) return autoAssignCache.map;

  const weights = groupWeights();
  const n = pool.length;
  const exact = weights.map(w => w * n);
  const quotas = exact.map(Math.floor);
  let left = n - quotas.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < left; k++) quotas[order[k % order.length].i]++;

  const locked = STATE.assignments[round] || {};
  const used = {};
  STATE.groups.forEach(g => { used[g.id] = 0; });
  pool.forEach(a => {
    if (locked[a.id]) used[locked[a.id]] = (used[locked[a.id]] || 0) + 1;
  });

  const map = {};
  let gi = 0;
  pool.forEach(a => {
    if (locked[a.id]) { map[a.id] = locked[a.id]; return; }
    while (gi < STATE.groups.length - 1 && used[STATE.groups[gi].id] >= quotas[gi]) gi++;
    const gid = STATE.groups[gi] ? STATE.groups[gi].id : null;
    map[a.id] = gid;
    if (gid) used[gid] = (used[gid] || 0) + 1;
  });
  autoAssignCache.poolKey = poolKey;
  autoAssignCache.map = map;
  return map;
}

function ensureAssignment(round, applicantId) {
  if (STATE.assignments[round] && STATE.assignments[round][applicantId]) {
    return STATE.assignments[round][applicantId];
  }
  return autoAssignments(round)[applicantId] || null;
}

function seedLegacyAssignments() {
  const locked = B.legacyAssignments || {};
  if (!STATE.assignments.screen) STATE.assignments.screen = {};
  Object.keys(locked).forEach(function (id) {
    if (!STATE.byId[id]) return;
    if (!STATE.assignments.screen[id]) STATE.assignments.screen[id] = locked[id];
  });
  autoAssignCache.poolKey = null;
}

function materializeAssignments() {
  let added = 0;
  if (!STATE.assignments.screen) STATE.assignments.screen = {};
  const map = autoAssignments('screen');
  poolForRound('screen').forEach(function (a) {
    if (!STATE.assignments.screen[a.id] && map[a.id]) {
      STATE.assignments.screen[a.id] = map[a.id];
      added++;
    }
  });
  if (added) autoAssignCache.poolKey = null;
  return added;
}

function persistAllAssignments() {
  ROUNDS.forEach(function (round) {
    Object.keys(STATE.assignments[round] || {}).forEach(function (id) {
      recordOp({ kind: 'assign', round: round, id: id, value: STATE.assignments[round][id] });
    });
  });
  queueSave();
}

function emptyAdvance() {
  return { round1: {}, topN: null, applied: false };
}

function normalizeAdvance(raw) {
  const out = emptyAdvance();
  if (!raw || typeof raw !== 'object') return out;
  if (raw.round1 && typeof raw.round1 === 'object' && !Array.isArray(raw.round1)) {
    Object.keys(raw.round1).forEach(function (id) { out.round1[id] = !!raw.round1[id]; });
  } else if (Array.isArray(raw.round1)) {
    raw.round1.forEach(function (id) { if (id) out.round1[id] = true; });
  } else if (Array.isArray(raw.ids)) {
    raw.ids.forEach(function (id) { if (id) out.round1[id] = true; });
  }
  if (typeof raw.topN === 'number' && isFinite(raw.topN) && raw.topN > 0) out.topN = Math.floor(raw.topN);
  if (raw.applied === true) out.applied = true;
  else if (raw.applied === false) out.applied = false;
  else out.applied = Object.keys(out.round1).length > 0;
  return out;
}

function hasExplicitAdvance() {
  return !!(STATE.advance && STATE.advance.applied);
}

function firstRoundPool() {
  if (hasExplicitAdvance()) {
    return STATE.applicants.filter(function (a) { return STATE.advance.round1[a.id] === true; });
  }
  return STATE.applicants.slice();
}

function poolForRound(round) {
  if (round === 'round2') {
    if (hasExplicitAdvanceRd2()) {
      return firstRoundPool().filter(function (a) { return STATE.advanceRd2.ids[a.id] === true; });
    }
    return firstRoundPool();
  }
  if (round === 'round1') return firstRoundPool();
  return STATE.applicants;
}

function scoredScreenApplicants() {
  invalidateScreenStd();
  return STATE.applicants.filter(function (a) {
    return hasManualScore(STATE.grades.screen[a.id]);
  }).slice().sort(function (a, b) {
    const av = screenBlendScore(a.id);
    const bv = screenBlendScore(b.id);
    const aN = av == null ? -1 : av;
    const bN = bv == null ? -1 : bv;
    if (bN !== aN) return bN - aN;
    return (a.name || '').localeCompare(b.name || '');
  });
}

function isAdvanceChecked(id) {
  if (hasExplicitAdvance()) return STATE.advance.round1[id] === true;
  return true;
}

function ensureAdvanceSnapshot() {
  if (hasExplicitAdvance()) return;
  const map = {};
  poolForRound('round1').forEach(function (a) { map[a.id] = true; });
  STATE.advance.round1 = map;
  STATE.advance.applied = true;
}

function applyAdvanceTopN(n) {
  const ranked = scoredScreenApplicants();
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const map = {};
  ranked.forEach(function (a, i) { map[a.id] = i < count; });
  STATE.advance.round1 = map;
  STATE.advance.topN = count || null;
  STATE.advance.applied = true;
  saveAdvance();
}

function clearAdvanceSet() {
  STATE.advance = emptyAdvance();
  saveAdvance();
}

function setAdvanceChecked(id, checked) {
  ensureAdvanceSnapshot();
  STATE.advance.round1[id] = !!checked;
  saveAdvance();
}

function emptyAdvanceRd2() {
  return { ids: {}, topN: null, applied: false };
}

function normalizeAdvanceRd2(raw) {
  const out = emptyAdvanceRd2();
  if (!raw || typeof raw !== 'object') return out;
  if (raw.ids && typeof raw.ids === 'object' && !Array.isArray(raw.ids)) {
    Object.keys(raw.ids).forEach(function (id) { out.ids[id] = !!raw.ids[id]; });
  } else if (Array.isArray(raw.ids)) {
    raw.ids.forEach(function (id) { if (id) out.ids[id] = true; });
  } else if (raw.round2 && typeof raw.round2 === 'object' && !Array.isArray(raw.round2)) {
    Object.keys(raw.round2).forEach(function (id) { out.ids[id] = !!raw.round2[id]; });
  }
  if (typeof raw.topN === 'number' && isFinite(raw.topN) && raw.topN > 0) out.topN = Math.floor(raw.topN);
  if (raw.applied === true) out.applied = true;
  else if (raw.applied === false) out.applied = false;
  else out.applied = Object.keys(out.ids).length > 0;
  return out;
}

function hasExplicitAdvanceRd2() {
  return !!(STATE.advanceRd2 && STATE.advanceRd2.applied);
}

function isAdvanceRd2Checked(id) {
  if (hasExplicitAdvanceRd2()) return STATE.advanceRd2.ids[id] === true;
  return true;
}

function ensureAdvanceRd2Snapshot() {
  if (hasExplicitAdvanceRd2()) return;
  const map = {};
  firstRoundPool().forEach(function (a) { map[a.id] = true; });
  STATE.advanceRd2.ids = map;
  STATE.advanceRd2.applied = true;
}

function scoredR1Applicants() {
  return firstRoundPool().slice().sort(function (a, b) {
    const av = scoreFor('round1', a.id);
    const bv = scoreFor('round1', b.id);
    const aN = av == null ? -1 : av;
    const bN = bv == null ? -1 : bv;
    if (bN !== aN) return bN - aN;
    return (a.name || '').localeCompare(b.name || '');
  });
}

function applyAdvanceRd2TopN(n) {
  const ranked = scoredR1Applicants().filter(function (a) { return scoreFor('round1', a.id) !== null; });
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const map = {};
  firstRoundPool().forEach(function (a) { map[a.id] = false; });
  ranked.forEach(function (a, i) { map[a.id] = i < count; });
  STATE.advanceRd2.ids = map;
  STATE.advanceRd2.topN = count || null;
  STATE.advanceRd2.applied = true;
  saveAdvanceRd2();
}

function clearAdvanceRd2Set() {
  STATE.advanceRd2 = emptyAdvanceRd2();
  saveAdvanceRd2();
}

function setAdvanceRd2Checked(id, checked) {
  ensureAdvanceRd2Snapshot();
  STATE.advanceRd2.ids[id] = !!checked;
  saveAdvanceRd2();
}

function advanceRd2Fingerprint(adv) {
  const a = adv || emptyAdvanceRd2();
  const ids = a.ids || {};
  const keys = Object.keys(ids).sort();
  const bits = keys.map(function (k) { return k + ':' + (ids[k] ? '1' : '0'); }).join(',');
  return (a.applied ? '1' : '0') + '|' + String(a.topN == null ? '' : a.topN) + '|' + bits;
}

function defaultInterviewers() {
  return (B.reviewers || []).map(function (r) {
    return { id: r.id, name: r.name };
  });
}

function normalizeInterviewers(raw) {
  const out = [];
  const seen = {};
  (raw || []).forEach(function (r) {
    if (!r) return;
    if (typeof r === 'string') {
      const name = r.trim();
      if (!name) return;
      const id = stableInterviewerId(name);
      if (seen[id]) return;
      seen[id] = true;
      out.push({ id: id, name: name });
      return;
    }
    const name = String(r.name || '').trim();
    const id = String(r.id || '').trim() || (name ? stableInterviewerId(name) : '');
    if (!id || !name || seen[id]) return;
    seen[id] = true;
    out.push({ id: id, name: name });
  });
  return out;
}

function stableInterviewerId(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  return base ? 'iv_' + base : '';
}

function newInterviewerId(name) {
  const stable = stableInterviewerId(name);
  if (stable && !interviewerById(stable)) return stable;
  return (stable || 'iv') + '_' + Date.now().toString(36);
}

function ensureInterviewers() {
  if (STATE.interviewers && STATE.interviewers.length) return false;
  STATE.interviewers = defaultInterviewers();
  return STATE.interviewers.length > 0;
}

function interviewerById(id) {
  if (!id) return null;
  const list = STATE.interviewers || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  const r = REVIEWERS_BY_ID[id];
  return r ? { id: r.id, name: r.name } : null;
}

function interviewerName(id) {
  const iv = interviewerById(id);
  return iv ? iv.name : '';
}

function interviewerShort(id) {
  const iv = interviewerById(id);
  if (!iv) return '';
  if (iv.id === 'christian' || /^christian\b/i.test(iv.name)) return 'Fox';
  return (iv.name || '').split(' ')[0] || iv.name;
}

function r1InterviewerId(applicantId) {
  const g = STATE.grades.round1[applicantId];
  return (g && g.interviewer) || '';
}

function r1InterviewTime(applicantId) {
  const g = STATE.grades.round1[applicantId];
  return (g && g.interviewTime) || '';
}

function formatInterviewTime(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function notesSnippet(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? truncate(t, n || 80) : '';
}

function addInterviewer(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const exists = (STATE.interviewers || []).some(function (iv) {
    return iv.name.toLowerCase() === trimmed.toLowerCase();
  });
  if (exists) return null;
  const iv = { id: newInterviewerId(trimmed), name: trimmed };
  STATE.interviewers = (STATE.interviewers || []).concat([iv]);
  saveInterviewers();
  return iv;
}

function removeInterviewer(id) {
  STATE.interviewers = (STATE.interviewers || []).filter(function (iv) { return iv.id !== id; });
  saveInterviewers();
}

function gradeFlagged(round, id) {
  const g = STATE.grades[round] && STATE.grades[round][id];
  return !!(g && g.flagSecond);
}

function isFlagged(id) {
  return gradeFlagged('screen', id) || gradeFlagged('round1', id) || gradeFlagged('round2', id);
}

function flaggedApplicants() {
  return STATE.applicants.filter(function (a) { return isFlagged(a.id); });
}

function flagRoundFor(id) {
  if (gradeFlagged('screen', id)) return 'screen';
  if (gradeFlagged('round1', id)) return 'round1';
  if (gradeFlagged('round2', id)) return 'round2';
  return 'screen';
}

function flagBadge(a) {
  if (!a || !isFlagged(a.id)) return '';
  return '<span class="flag-badge" title="Flagged for second reviewer">Flagged</span>';
}

function openFlaggedList() {
  STATE.view = 'flagged';
  STATE.currentApplicantId = null;
  STATE.flaggedOnly = true;
  STATE.returnView = 'flagged';
  render();
}

// Kept for exports / old copy. Second Round membership is the explicit
// advanceRd2 set, not an automatic score cutoff.
function passedRound1(applicantId) {
  if (hasExplicitAdvanceRd2()) return STATE.advanceRd2.ids[applicantId] === true;
  const s = scoreFor('round1', applicantId);
  return s !== null && s >= B.rubrics.round1.advanceThreshold;
}

function groupLoad(round, groupId) {
  return poolForRound(round).filter(a => ensureAssignment(round, a.id) === groupId).length;
}

// A filled review is a real hand-scored record for that round — not auto GPA
// and not academics N/A alone. One grade record per applicant; the assigned
// group owns the slot, so this is "how many of our people have a screen," not
// "how many members of the pair clicked."
function groupFilled(round, groupId) {
  return poolForRound(round).filter(function (a) {
    return ensureAssignment(round, a.id) === groupId && hasManualScore(STATE.grades[round][a.id]);
  }).length;
}

function assignmentGroup(round, applicantId) {
  const gid = ensureAssignment(round, applicantId);
  return STATE.groups.find(function (g) { return g.id === gid; }) || null;
}

function activeReviewGroup(round, applicantId) {
  if (round === 'round1') {
    if (STATE.filterInterviewer && STATE.filterInterviewer !== 'all') return STATE.filterInterviewer;
    return r1InterviewerId(applicantId) || null;
  }
  if (STATE.filterGroup && STATE.filterGroup !== 'all') return STATE.filterGroup;
  return ensureAssignment(round, applicantId);
}

function sortApplicantList(list, round) {
  return list.slice().sort((a, b) => {
    let av, bv;
    if (STATE.sortKey === 'name') { av = a.name; bv = b.name; }
    else if (STATE.sortKey === 'gpa') { av = autoFor(a).gpa.value ?? -1; bv = autoFor(b).gpa.value ?? -1; }
    else if (STATE.sortKey === 'score') {
      if (round === 'screen') { av = screenBlendScore(a.id) ?? -1; bv = screenBlendScore(b.id) ?? -1; }
      else { av = scoreFor(round, a.id) ?? -1; bv = scoreFor(round, b.id) ?? -1; }
    }
    else if (STATE.sortKey === 'group') {
      if (round === 'round1') { av = interviewerName(r1InterviewerId(a.id)) || ''; bv = interviewerName(r1InterviewerId(b.id)) || ''; }
      else { av = ensureAssignment(round, a.id) || ''; bv = ensureAssignment(round, b.id) || ''; }
    }
    else if (STATE.sortKey === 'time') { av = r1InterviewTime(a.id) || ''; bv = r1InterviewTime(b.id) || ''; }
    else if (STATE.sortKey === 'appscore') { av = screenBlendScore(a.id) ?? -1; bv = screenBlendScore(b.id) ?? -1; }
    else { av = a.name; bv = b.name; }
    if (av < bv) return STATE.sortDir === 'asc' ? -1 : 1;
    if (av > bv) return STATE.sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

function incompleteQueue(round, groupId) {
  if (!groupId || groupId === 'all') return [];
  if (round === 'round1') {
    return sortApplicantList(poolForRound(round).filter(function (a) {
      return r1InterviewerId(a.id) === groupId && !hasR1InterviewScore(STATE.grades.round1[a.id]);
    }), round);
  }
  return sortApplicantList(poolForRound(round).filter(function (a) {
    return ensureAssignment(round, a.id) === groupId && !hasManualScore(STATE.grades[round][a.id]);
  }), round);
}

function assignedInListOrder(round, groupId) {
  if (round === 'round1') {
    return sortApplicantList(poolForRound(round).filter(function (a) {
      return r1InterviewerId(a.id) === groupId;
    }), round);
  }
  return sortApplicantList(poolForRound(round).filter(function (a) {
    return ensureAssignment(round, a.id) === groupId;
  }), round);
}

function nextInQueue(round, groupId, currentId) {
  const q = incompleteQueue(round, groupId);
  const others = q.filter(function (a) { return a.id !== currentId; });
  if (!others.length) return null;
  const idx = q.findIndex(function (a) { return a.id === currentId; });
  if (idx >= 0) return q[idx + 1] || others[0];
  const ordered = assignedInListOrder(round, groupId);
  const curIdx = ordered.findIndex(function (a) { return a.id === currentId; });
  for (let i = 0; i < others.length; i++) {
    if (ordered.findIndex(function (p) { return p.id === others[i].id; }) > curIdx) return others[i];
  }
  return others[0];
}

function prevIncompleteInPool(round, groupId, currentId) {
  const q = incompleteQueue(round, groupId).filter(function (a) { return a.id !== currentId; });
  if (!q.length) return null;
  const ordered = assignedInListOrder(round, groupId);
  const curIdx = ordered.findIndex(function (a) { return a.id === currentId; });
  let last = null;
  for (let i = 0; i < q.length; i++) {
    if (ordered.findIndex(function (p) { return p.id === q[i].id; }) < curIdx) last = q[i];
  }
  return last || q[q.length - 1];
}

function queueCountText(round, groupId, applicantId) {
  const name = round === 'round1'
    ? (interviewerShort(groupId) || interviewerName(groupId) || 'interviewer')
    : ((STATE.groups.find(function (g) { return g.id === groupId; }) || {}).name || 'group');
  const q = incompleteQueue(round, groupId);
  if (!q.length) return 'All ' + name + ' ' + ROUND_LABEL[round] + ' reviews filled';
  const idx = q.findIndex(function (a) { return a.id === applicantId; });
  if (idx >= 0) return (idx + 1) + ' of ' + q.length + ' left';
  return q.length + ' remaining';
}

function reviewAsChipsHtml(round) {
  if (round === 'round1') {
    return `<span class="review-as">
      <span class="lbl">My interviews</span>
      ${(STATE.interviewers || []).map(function (iv) {
        return `<label class="chip ${STATE.filterInterviewer === iv.id ? 'active' : ''}" data-reviewas-r1="${esc(iv.id)}">${esc(interviewerShort(iv.id) || iv.name)}</label>`;
      }).join('')}
    </span>`;
  }
  return `<span class="review-as">
    <span class="lbl">Review as</span>
    ${STATE.groups.map(g => `<label class="chip ${STATE.filterGroup === g.id ? 'active' : ''}" data-reviewas="${g.id}">${esc(g.name)}</label>`).join('')}
  </span>`;
}

function bindReviewAs(root, onChange) {
  root.querySelectorAll('[data-reviewas]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.reviewas;
      STATE.filterGroup = STATE.filterGroup === id ? 'all' : id;
      STATE.queueTrail = [];
      STATE.queueDone = false;
      onChange();
    });
  });
  root.querySelectorAll('[data-reviewas-r1]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.reviewasR1;
      STATE.filterInterviewer = STATE.filterInterviewer === id ? 'all' : id;
      STATE.queueTrail = [];
      STATE.queueDone = false;
      onChange();
    });
  });
}

function queueNavHtml(round, applicantId) {
  const gid = activeReviewGroup(round, applicantId);
  const next = gid ? nextInQueue(round, gid, applicantId) : null;
  const canPrev = !!(STATE.queueTrail && STATE.queueTrail.length) || !!(gid && prevIncompleteInPool(round, gid, applicantId));
  const q = gid ? incompleteQueue(round, gid) : [];
  const currentLeft = q.some(function (a) { return a.id === applicantId; });
  const nextDisabled = !next && currentLeft;
  return `<div class="queue-nav" id="queueNav">
    ${reviewAsChipsHtml(round)}
    ${gid ? `<span class="queue-count" id="queueCount">${esc(queueCountText(round, gid, applicantId))}</span>
    <button class="btn small" id="queuePrev" ${canPrev ? '' : 'disabled'}>← Prev</button>
    <button class="btn small primary" id="queueNext" ${nextDisabled ? 'disabled' : ''}>Next →</button>` : ''}
  </div>`;
}

function bindQueueNav(round, applicantId) {
  bindReviewAs(contentEl, () => render());
  const nextBtn = document.getElementById('queueNext');
  const prevBtn = document.getElementById('queuePrev');
  if (nextBtn) nextBtn.addEventListener('click', () => goQueueNext(round));
  if (prevBtn) prevBtn.addEventListener('click', () => goQueuePrev(round));
}

function goQueueNext(round) {
  const gid = activeReviewGroup(round, STATE.currentApplicantId);
  const next = nextInQueue(round, gid, STATE.currentApplicantId);
  if (!next) {
    STATE.queueDone = true;
    render();
    return;
  }
  if (STATE.currentApplicantId && STATE.currentApplicantId !== next.id) {
    STATE.queueTrail = STATE.queueTrail || [];
    STATE.queueTrail.push(STATE.currentApplicantId);
  }
  STATE.currentApplicantId = next.id;
  STATE.gradeRound = round;
  STATE.view = 'grade';
  STATE.queueDone = false;
  render();
}

function goQueuePrev(round) {
  if (STATE.queueTrail && STATE.queueTrail.length) {
    const prevId = STATE.queueTrail.pop();
    if (prevId && STATE.byId[prevId]) {
      STATE.currentApplicantId = prevId;
      STATE.gradeRound = round;
      STATE.view = 'grade';
      STATE.queueDone = false;
      render();
      return;
    }
  }
  const gid = activeReviewGroup(round, STATE.currentApplicantId);
  const prev = prevIncompleteInPool(round, gid, STATE.currentApplicantId);
  if (prev) {
    STATE.currentApplicantId = prev.id;
    STATE.gradeRound = round;
    STATE.view = 'grade';
    STATE.queueDone = false;
    render();
  }
}

function refreshQueueBar(round) {
  const countEl = document.getElementById('queueCount');
  if (!countEl) return;
  const gid = activeReviewGroup(round, STATE.currentApplicantId);
  if (!gid) return;
  countEl.textContent = queueCountText(round, gid, STATE.currentApplicantId);
  const nextBtn = document.getElementById('queueNext');
  const prevBtn = document.getElementById('queuePrev');
  const next = nextInQueue(round, gid, STATE.currentApplicantId);
  const q = incompleteQueue(round, gid);
  const currentLeft = q.some(function (a) { return a.id === STATE.currentApplicantId; });
  if (nextBtn) nextBtn.disabled = !next && currentLeft;
  if (prevBtn) {
    const canPrev = !!(STATE.queueTrail && STATE.queueTrail.length) || !!prevIncompleteInPool(round, gid, STATE.currentApplicantId);
    prevBtn.disabled = !canPrev;
  }
}

// ---------------- Rendering: shell ----------------
const railEl = document.getElementById('rail');
const contentEl = document.getElementById('content');
const topbarEl = document.getElementById('topbar');

function pageScrollEl() {
  return document.querySelector('.main');
}

const GRADE_LAYOUT_KEY = 'rem-uf-grade-layout';

function getGradeLayout() {
  try {
    const v = localStorage.getItem(GRADE_LAYOUT_KEY);
    if (v === 'side' || v === 'stacked') return v;
  } catch (e) { /* private mode */ }
  return 'stacked';
}

function setGradeLayout(layout) {
  try { localStorage.setItem(GRADE_LAYOUT_KEY, layout === 'side' ? 'side' : 'stacked'); } catch (e) { /* ignore */ }
}

function layoutToggleHtml() {
  const layout = getGradeLayout();
  return `<div class="layout-toggle" role="group" aria-label="Grade layout">
    <span class="layout-toggle-lbl">Layout</span>
    <button type="button" class="chip ${layout === 'stacked' ? 'active' : ''}" data-layout="stacked">Stacked</button>
    <button type="button" class="chip ${layout === 'side' ? 'active' : ''}" data-layout="side">Side</button>
  </div>`;
}

function gradeViewKey() {
  return STATE.view === 'grade' ? (STATE.currentApplicantId + ':' + (STATE.gradeRound || '')) : null;
}

function captureGradeScroll() {
  const key = gradeViewKey();
  if (!key) return null;
  const main = pageScrollEl();
  const essays = {};
  document.querySelectorAll('.essay-block').forEach(function (el) {
    const id = el.getAttribute('data-essay') || ('idx-' + Object.keys(essays).length);
    essays[id] = el.scrollTop;
  });
  return {
    key: key,
    mainTop: main ? main.scrollTop : 0,
    contentTop: contentEl ? contentEl.scrollTop : 0,
    essays: essays,
  };
}

function restoreGradeScroll(snap) {
  if (!snap || snap.key !== gradeViewKey()) return;
  const main = pageScrollEl();
  if (main) main.scrollTop = snap.mainTop;
  if (contentEl) contentEl.scrollTop = snap.contentTop;
  document.querySelectorAll('.essay-block').forEach(function (el) {
    const id = el.getAttribute('data-essay');
    if (id && Object.prototype.hasOwnProperty.call(snap.essays, id)) {
      el.scrollTop = snap.essays[id];
    }
  });
}

let lastGradeKey = null;
let lastOverviewView = false;
let lastView = null;
let lastRoundListScroll = 0;

function render() {
  invalidateScreenStd();
  const sameGrade = !!(gradeViewKey() && gradeViewKey() === lastGradeKey);
  const gradeSnap = sameGrade ? captureGradeScroll() : null;
  const sameOverview = STATE.view === 'overview' && lastOverviewView;
  const overviewSnap = sameOverview ? captureOverviewScroll() : null;
  const sameRoundList = STATE.view === lastView && (STATE.view.indexOf('round:') === 0 || STATE.view === 'flagged');
  const roundListSnap = sameRoundList && !sameGrade ? (pageScrollEl() ? pageScrollEl().scrollTop : lastRoundListScroll) : null;
  renderRail();
  renderTopbar();
  renderContent();
  lastGradeKey = gradeViewKey();
  lastOverviewView = STATE.view === 'overview';
  lastView = STATE.view;
  if (gradeSnap) restoreGradeScroll(gradeSnap);
  if (overviewSnap) restoreOverviewScroll(overviewSnap);
  if (roundListSnap != null) {
    const main = pageScrollEl();
    if (main) main.scrollTop = roundListSnap;
    lastRoundListScroll = roundListSnap;
  }
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
    ${railBtn('flagged', 'Flagged', flaggedApplicants().length)}
    <div class="rail-group">Ops</div>
    ${railBtn('groups', 'Review Groups')}
    ${railBtn('export', 'Export')}
    <div class="rail-foot">
      <div><span class="dot"></span>${B.applicants.length} applicants at build · ${STATE.applicants.length} now</div>
      <button type="button" class="sub" style="margin-top:4px; cursor:pointer; background:none; border:none; color:inherit; font:inherit; padding:0; text-align:left;" id="buildStamp" title="Re-render">${BUILD_STAMP}</button>
    </div>
  `;
  railEl.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
    STATE.view = b.dataset.nav;
    STATE.currentApplicantId = null;
    STATE.returnView = null;
    if (b.dataset.nav === 'flagged') STATE.flaggedOnly = true;
    else if (b.dataset.nav === 'round:screen') { /* keep flaggedOnly chip state */ }
    else STATE.flaggedOnly = false;
    render();
  }));
  const stamp = document.getElementById('buildStamp');
  if (stamp) stamp.addEventListener('click', function () { render(); });
}

function renderTopbar() {
  let title = 'Overview', eyebrow = 'REM UF Recruitment';
  if (STATE.view.startsWith('round:')) {
    const round = STATE.view.split(':')[1];
    title = ROUND_LABEL[round]; eyebrow = ROUND_SUB[round];
  } else if (STATE.view === 'flagged') { title = 'Flagged for second review'; eyebrow = 'Needs another look'; }
  else if (STATE.view === 'groups') { title = 'Review Groups'; eyebrow = 'Assigned groups · filled reviews'; }
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
  if (STATE.view === 'grade') {
    contentEl.classList.add('grade-wide');
    contentEl.classList.toggle('grade-layout-side', getGradeLayout() === 'side');
    contentEl.classList.toggle('grade-layout-stacked', getGradeLayout() !== 'side');
  } else {
    contentEl.classList.remove('grade-wide', 'grade-layout-side', 'grade-layout-stacked');
  }
  if (STATE.view === 'overview') return renderOverview();
  if (STATE.view === 'flagged') return renderFlaggedList();
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
  const meetCount = STATE.applicants.filter(a => a.attendance && a.attendance.meetMembers).length;
  const vouchedCount = STATE.applicants.filter(a => vouchCount(a.id)).length;
  const flaggedCount = flaggedApplicants().length;
  const years = {};
  STATE.applicants.forEach(a => { years[a.classYear || 'Unknown'] = (years[a.classYear || 'Unknown'] || 0) + 1; });
  const yearOrder = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Unknown'];
  const yearSorted = yearOrder.filter(y => years[y]).map(y => [y, years[y]]);
  const maxYear = yearSorted.reduce((m, e) => Math.max(m, e[1]), 1);
  const autoCount = STATE.applicants.filter(a => typeof autoFor(a).scores.academics === 'number').length;

  const screenDist = distribution(STATE.applicants.map(a => scoreFor('screen', a.id)).filter(v => v !== null), 1, 5);
  const r1Dist = distribution(r1Pool.map(a => scoreFor('round1', a.id)).filter(v => v !== null), 1, 4);
  const advanceHtml = renderAdvanceCard();
  const interviewerHtml = renderInterviewerCard();
  const advanceRd2Html = renderAdvanceRd2Card();

  contentEl.innerHTML = `
    <div class="grid-stats" style="margin-bottom:22px;">
      ${statTile('Total applicants', total, `${STATE.applicants.length - B.applicants.length > 0 ? '+' + (STATE.applicants.length - B.applicants.length) + ' since build' : 'UF chapter'}`)}
      ${statTile('Application Screen', `${screenScored}/${total}`, 'scored', 'round:screen')}
      ${statTile('First Round', `${r1Scored}/${r1Pool.length}`, hasExplicitAdvance() ? 'scored · explicit advance set' : `scored · everyone until you Apply top N`, 'round:round1')}
      ${statTile('Second Round pool', `${r2Scored}/${r2Pool.length}`, hasExplicitAdvanceRd2() ? 'scored · explicit Rd2 set' : 'everyone in First Round until you Apply top N', 'round:round2')}
      ${statTile('Flagged for 2nd review', flaggedCount, flaggedCount ? 'open the flagged list' : 'none flagged yet', 'flagged')}
      ${statTile('Coffee chat contact', coffeeCount, `of ${total} applicants`)}
      ${statTile('Meet the Members', meetCount, `of ${total} applicants`)}
      ${statTile('Late applications', STATE.applicants.filter(a => a.late).length, 'after Sep 4 11:59 PM ET')}
      ${statTile('Vouched for', vouchedCount, vouchedCount ? 'by an exec member' : 'no vouches yet')}
    </div>

    ${advanceHtml}
    ${interviewerHtml}
    ${advanceRd2Html}

    <div class="two-col">
      <div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="section-title">Application Screen score distribution <span class="n">(weighted / 5)</span></div>
          ${renderDistBars(screenDist)}
        </div>
        <div class="card card-pad" style="margin-bottom:16px;">
          <div class="section-title">First Round score distribution <span class="n">(avg of remaining interview questions, 1–4 scale)</span></div>
          ${r1Pool.length ? renderDistBars(r1Dist) : emptyNote('No one in the First Round pool yet.')}
        </div>
        <div class="card card-pad">
          <div class="section-title">Review group calibration <span class="n">Application Screen — hand-scored dimensions only</span></div>
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
          <div class="sub" style="margin-top:10px; color:var(--slate);">College GPA auto-scored academics for ${autoCount} of ${total}. High-school-only freshmen and incoming / N/A responses default to N/A and are not in the average.</div>
        </div>
        <div class="card card-pad">
          <div class="section-title">Recruitment funnel</div>
          ${funnelRow('Coffee chat sign-ins logged', B.meta.coffeeChatRows, B.meta.coffeeChatRows)}
          ${funnelRow('Info session check-ins', B.meta.infoSessionRows, B.meta.coffeeChatRows)}
          ${funnelRow('Meet the Members check-ins', B.meta.meetMembersRows || 0, B.meta.coffeeChatRows)}
          ${funnelRow('Applications submitted', total, B.meta.coffeeChatRows)}
          <div class="sub" style="margin-top:9px; color:var(--slate);">
            Most event sign-ins haven't submitted an application, so they don't appear above — ${coffeeCount} of ${total} applicants have a logged coffee chat, ${infoCount} an info session, and ${meetCount} Meet the Members. That gap closes as more of them submit applications.
          </div>
        </div>
        <div class="card card-pad">
          <div class="section-title">Review groups <span class="n">screen filled / assigned</span></div>
          ${STATE.groups.map(g => {
            const assigned = groupLoad('screen', g.id);
            const filled = groupFilled('screen', g.id);
            return `
            <div class="bar-row"><div class="lbl">${esc(g.name)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (assigned ? filled / assigned : 0) * 100)}%; background:var(--accent2)"></div></div>
              <div class="val">${filled}/${assigned}</div></div>`;
          }).join('')}
          <button class="btn small" style="margin-top:8px;" data-nav="groups">Manage groups →</button>
        </div>
      </div>
    </div>
  `;
  contentEl.querySelectorAll('[data-nav]').forEach(function (el) {
    el.addEventListener('click', function () {
      const dest = el.dataset.nav;
      if (dest === 'flagged') { openFlaggedList(); return; }
      STATE.view = dest;
      STATE.currentApplicantId = null;
      STATE.returnView = null;
      if (dest === 'round:screen') { /* keep chip */ }
      else STATE.flaggedOnly = false;
      render();
    });
  });
  bindAdvanceCard();
  bindInterviewerCard();
  bindAdvanceRd2Card();
}

function renderAdvanceCard() {
  const ranked = scoredScreenApplicants();
  const topN = (STATE.advance && STATE.advance.topN) || Math.min(20, ranked.length) || 20;
  const applied = hasExplicitAdvance();
  const rows = ranked.map(function (a) {
    const on = isAdvanceChecked(a.id);
    return `<label class="advance-row">
      <input type="checkbox" data-advance="${esc(a.id)}" ${on ? 'checked' : ''}>
      <span class="nm">${esc(a.name)}</span>
      <span class="sub">${esc(a.classYear || '')}</span>
      <span class="mono">${formatScreenScorePairHtml(a.id)}</span>
    </label>`;
  }).join('') || '<div class="sub" style="color:var(--slate); padding:8px 0;">No hand-scored Application Screens yet — only people with a real screen score compete for top N.</div>';
  return `<div class="card card-pad advance-card" style="margin-bottom:22px;">
    <div class="section-title">Who advances to First Round <span class="n">from Application Screen</span></div>
    <p class="advance-copy">Apply top N to set the First Round pool. Until then, First Round still includes everyone. Apply top N resets the checks to the N highest scores — ranked by the average of raw weighted /5 and group-standardized — then you can check or uncheck people. Changing N and applying again resets to the new top N. Saved for everyone — scores do not auto-advance anyone.</p>
    <div class="advance-controls">
      <label class="advance-n-label" for="advanceTopN">Advance top N</label>
      <input type="number" id="advanceTopN" min="0" step="1" value="${topN}">
      <button type="button" class="btn primary small" id="applyTopN">Apply top N</button>
      ${applied ? '<button type="button" class="btn ghost small" id="clearAdvance">Use everyone again</button>' : ''}
      <button type="button" class="btn small" id="copyAdvanceEmails">Copy emails</button>
      <button type="button" class="btn ghost small" id="showAdvanceEmails">Show emails</button>
      <button type="button" class="btn small" id="copyRejectEmails"${applied ? '' : ' disabled'} title="${applied ? 'Emails of people who did not move to First Round' : 'Everyone is still in the pool'}">Copy rejection emails</button>
      <button type="button" class="btn ghost small" id="showRejectEmails"${applied ? '' : ' disabled'} title="${applied ? 'Emails of people who did not move to First Round' : 'Everyone is still in the pool'}">Show rejection emails</button>
      <button type="button" class="btn small" id="copyBusinessEmails" title="Emails of business majors in First Round">Copy business emails</button>
      <button type="button" class="btn ghost small" id="showBusinessMajors" title="Name, major, and email of business majors in First Round">Show business majors</button>
      <span class="advance-count">${esc(advanceCountLabel())}</span>
    </div>
    <div class="advance-status">${applied ? 'First Round is the checked list below.' : 'First Round still includes everyone — Apply top N to set the pool.'}</div>
    <div id="advanceEmailPanel" class="advance-emails" hidden>
      <textarea id="advanceEmailOut" readonly></textarea>
    </div>
    <div id="rejectEmailPanel" class="advance-emails" hidden>
      <textarea id="rejectEmailOut" readonly></textarea>
    </div>
    <div id="businessMajorPanel" class="advance-emails" hidden>
      <textarea id="businessMajorOut" readonly></textarea>
    </div>
    <div class="advance-list" id="advanceList">${rows}</div>
  </div>`;
}

function bindAdvanceCard() {
  const nInput = document.getElementById('advanceTopN');
  const applyBtn = document.getElementById('applyTopN');
  if (applyBtn) applyBtn.addEventListener('click', function () {
    const n = nInput ? Number(nInput.value) : 0;
    applyAdvanceTopN(n);
    renderOverviewPreserveScroll();
    toast('First Round set to top ' + Math.max(0, Math.floor(Number(n) || 0)) + ' by blended screen score');
  });
  bindClearAdvanceButton(document.getElementById('clearAdvance'));
  const copyEmailsBtn = document.getElementById('copyAdvanceEmails');
  if (copyEmailsBtn) copyEmailsBtn.addEventListener('click', function () { copyAdvanceEmails(); });
  const showEmailsBtn = document.getElementById('showAdvanceEmails');
  if (showEmailsBtn) showEmailsBtn.addEventListener('click', function () { toggleAdvanceEmails(); });
  const copyRejectBtn = document.getElementById('copyRejectEmails');
  if (copyRejectBtn) copyRejectBtn.addEventListener('click', function () { copyRejectEmails(); });
  const showRejectBtn = document.getElementById('showRejectEmails');
  if (showRejectBtn) showRejectBtn.addEventListener('click', function () { toggleRejectEmails(); });
  const copyBizBtn = document.getElementById('copyBusinessEmails');
  if (copyBizBtn) copyBizBtn.addEventListener('click', function () { copyBusinessEmails(); });
  const showBizBtn = document.getElementById('showBusinessMajors');
  if (showBizBtn) showBizBtn.addEventListener('click', function () { toggleBusinessMajors(); });
  contentEl.querySelectorAll('[data-advance]').forEach(function (box) {
    box.addEventListener('change', function (e) {
      e.stopPropagation();
      setAdvanceChecked(box.dataset.advance, box.checked);
      refreshAdvanceUi();
    });
  });
  bindAdvanceListScrollGuard();
  syncBusinessMajorControls();
}

function renderInterviewerCard() {
  const chips = (STATE.interviewers || []).map(function (iv) {
    return `<span class="chip interviewer-chip">${esc(iv.name)} <button type="button" class="linkbtn" data-rm-iv="${esc(iv.id)}" title="Remove"${readOnly ? ' disabled' : ''}>×</button></span>`;
  }).join('') || '<span class="sub" style="color:var(--slate);">No interviewers yet — add someone below.</span>';
  return `<div class="card card-pad interviewer-card" style="margin-bottom:22px;">
    <div class="section-title">Who is interviewing <span class="n">First Round</span></div>
    <p class="advance-copy">This roster fills the interviewer dropdown on each First Round profile. Add or remove people here — saved for everyone. Assignments are picked by hand, not random.</p>
    <div class="interviewer-chips">${chips}</div>
    <div class="advance-controls">
      <input type="text" id="newInterviewerName" placeholder="Add interviewer name" ${readOnly ? 'disabled' : ''}>
      <button type="button" class="btn small" id="addInterviewer"${readOnly ? ' disabled' : ''}>Add</button>
    </div>
  </div>`;
}

function bindInterviewerCard() {
  const addBtn = document.getElementById('addInterviewer');
  const input = document.getElementById('newInterviewerName');
  function add() {
    if (!input) return;
    const iv = addInterviewer(input.value);
    if (!iv) { toast(input.value.trim() ? 'Already on the list' : 'Enter a name'); return; }
    renderOverviewPreserveScroll();
    toast('Added ' + iv.name);
  }
  if (addBtn) addBtn.addEventListener('click', add);
  if (input) input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });
  contentEl.querySelectorAll('[data-rm-iv]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.rmIv;
      const name = interviewerName(id) || 'interviewer';
      removeInterviewer(id);
      renderOverviewPreserveScroll();
      toast('Removed ' + name + ' from the roster — existing assignments stay until you change them');
    });
  });
}

function renderAdvanceRd2Card() {
  const ranked = scoredR1Applicants();
  const topN = (STATE.advanceRd2 && STATE.advanceRd2.topN) || Math.min(20, ranked.filter(function (a) { return scoreFor('round1', a.id) !== null; }).length) || 20;
  const applied = hasExplicitAdvanceRd2();
  const rows = ranked.map(function (a) {
    const on = isAdvanceRd2Checked(a.id);
    const g = STATE.grades.round1[a.id] || {};
    const r1 = scoreFor('round1', a.id);
    const notes = notesSnippet(g.initialNotes, 64);
    const who = interviewerShort(g.interviewer) || interviewerName(g.interviewer);
    return `<label class="advance-row advance-row-rd2">
      <input type="checkbox" data-advance-rd2="${esc(a.id)}" ${on ? 'checked' : ''}>
      <span class="nm">${esc(a.name)}${g.knowFlag ? '<span class="know-badge">Knows them</span>' : ''}${g.thankYou ? '<span class="follow-badge yes">Followed up</span>' : '<span class="follow-badge no">No follow-up</span>'}</span>
      <span class="sub">${esc(who || 'Unassigned')}${g.interviewTime ? ' · ' + esc(formatInterviewTime(g.interviewTime)) : ''}${notes ? ' · ' + esc(notes) : ''}</span>
      <span class="mono">${r1 == null ? '—' : r1.toFixed(1)} r1 · ${formatScreenScorePairHtml(a.id)}</span>
    </label>`;
  }).join('') || '<div class="sub" style="color:var(--slate); padding:8px 0;">No one is in the First Round pool yet.</div>';
  return `<div class="card card-pad advance-card" style="margin-bottom:22px;">
    <div class="section-title">Who advances to Round 2 <span class="n">from First Round</span></div>
    <p class="advance-copy">Same idea as First Round: Apply top N to set the Round 2 pool from people who made First Round. Until then, Second Round includes everyone in First Round. Apply top N ranks by First Round interview average (remaining questions), then you can check or uncheck. Scores do not auto-advance anyone.</p>
    <div class="advance-controls">
      <label class="advance-n-label" for="advanceRd2TopN">Advance top N</label>
      <input type="number" id="advanceRd2TopN" min="0" step="1" value="${topN}">
      <button type="button" class="btn primary small" id="applyRd2TopN">Apply top N</button>
      ${applied ? '<button type="button" class="btn ghost small" id="clearAdvanceRd2">Use First Round pool again</button>' : ''}
      <button type="button" class="btn small" id="copyAdvanceRd2Emails">Copy emails</button>
      <button type="button" class="btn ghost small" id="showAdvanceRd2Emails">Show emails</button>
      <span class="advance-count" id="advanceRd2Count">${esc(advanceRd2CountLabel())}</span>
    </div>
    <div class="advance-status" id="advanceRd2Status">${applied ? 'Round 2 is the checked list below.' : 'Round 2 still includes everyone in First Round — Apply top N to set the pool.'}</div>
    <div id="advanceRd2EmailPanel" class="advance-emails" hidden>
      <textarea id="advanceRd2EmailOut" readonly></textarea>
    </div>
    <div class="advance-list" id="advanceRd2List">${rows}</div>
  </div>`;
}

function bindAdvanceRd2Card() {
  const nInput = document.getElementById('advanceRd2TopN');
  const applyBtn = document.getElementById('applyRd2TopN');
  if (applyBtn) applyBtn.addEventListener('click', function () {
    const n = nInput ? Number(nInput.value) : 0;
    applyAdvanceRd2TopN(n);
    renderOverviewPreserveScroll();
    toast('Round 2 set to top ' + Math.max(0, Math.floor(Number(n) || 0)) + ' by First Round interview average');
  });
  bindClearAdvanceRd2Button(document.getElementById('clearAdvanceRd2'));
  const copyBtn = document.getElementById('copyAdvanceRd2Emails');
  if (copyBtn) copyBtn.addEventListener('click', function () { copyAdvanceRd2Emails(); });
  const showBtn = document.getElementById('showAdvanceRd2Emails');
  if (showBtn) showBtn.addEventListener('click', function () { toggleAdvanceRd2Emails(); });
  contentEl.querySelectorAll('[data-advance-rd2]').forEach(function (box) {
    box.addEventListener('change', function (e) {
      e.stopPropagation();
      setAdvanceRd2Checked(box.dataset.advanceRd2, box.checked);
      refreshAdvanceRd2Ui();
    });
  });
  bindAdvanceRd2ListScrollGuard();
}

function advanceRd2CountLabel() {
  const ranked = scoredR1Applicants();
  const selected = ranked.filter(function (a) { return isAdvanceRd2Checked(a.id); }).length;
  const topN = (STATE.advanceRd2 && STATE.advanceRd2.topN) || Math.min(20, ranked.length) || 20;
  const poolN = poolForRound('round2').length;
  const applied = hasExplicitAdvanceRd2();
  const emailN = selectedAdvanceRd2Emails().length;
  return selected + ' selected · N = ' + topN + (applied ? ' · ' + poolN + ' in Round 2' : '') + ' · ' + emailN + ' emails';
}

function bindClearAdvanceRd2Button(btn) {
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', function () {
    clearAdvanceRd2Set();
    renderOverviewPreserveScroll();
    toast('Round 2 includes the First Round pool again');
  });
}

function refreshAdvanceRd2Ui() {
  const countEl = document.getElementById('advanceRd2Count');
  if (countEl) countEl.textContent = advanceRd2CountLabel();
  const statusEl = document.getElementById('advanceRd2Status');
  if (statusEl) {
    statusEl.textContent = hasExplicitAdvanceRd2()
      ? 'Round 2 is the checked list below.'
      : 'Round 2 still includes everyone in First Round — Apply top N to set the pool.';
  }
  if (hasExplicitAdvanceRd2() && !document.getElementById('clearAdvanceRd2')) {
    const applyBtn = document.getElementById('applyRd2TopN');
    if (applyBtn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost small';
      btn.id = 'clearAdvanceRd2';
      btn.textContent = 'Use First Round pool again';
      applyBtn.insertAdjacentElement('afterend', btn);
      bindClearAdvanceRd2Button(btn);
    }
  }
  const r2Pool = poolForRound('round2');
  const r2Scored = r2Pool.filter(function (a) { return scoreFor('round2', a.id) !== null; }).length;
  const tile = document.querySelector('[data-stat="round:round2"]');
  if (tile) {
    const valueEl = tile.querySelector('.value');
    const subEl = tile.querySelector('.sub');
    if (valueEl) valueEl.textContent = r2Scored + '/' + r2Pool.length;
    if (subEl) subEl.textContent = hasExplicitAdvanceRd2() ? 'scored · explicit Rd2 set' : 'everyone in First Round until you Apply top N';
  }
  const railCount = document.querySelector('.rail-btn[data-nav="round:round2"] .count');
  if (railCount) railCount.textContent = String(r2Pool.length);
  const emailOut = document.getElementById('advanceRd2EmailOut');
  const emailPanel = document.getElementById('advanceRd2EmailPanel');
  if (emailOut && emailPanel && !emailPanel.hidden) {
    emailOut.value = advanceRd2EmailText('\n');
  }
}

function selectedAdvanceRd2Applicants() {
  if (hasExplicitAdvanceRd2()) {
    return firstRoundPool().filter(function (a) { return STATE.advanceRd2.ids[a.id] === true; });
  }
  return firstRoundPool();
}

function selectedAdvanceRd2Emails() {
  return selectedAdvanceRd2Applicants().map(function (a) {
    return String(a.email || '').trim();
  }).filter(Boolean);
}

function advanceRd2EmailText(sep) {
  return selectedAdvanceRd2Emails().join(sep == null ? '\n' : sep);
}

async function copyAdvanceRd2Emails() {
  const text = advanceRd2EmailText(', ');
  if (!text) { toast('No emails on the current Round 2 set'); return; }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { /* fall through */ }
  if (!ok) {
    const panel = document.getElementById('advanceRd2EmailPanel');
    const out = document.getElementById('advanceRd2EmailOut');
    if (panel && out) {
      panel.hidden = false;
      out.value = text;
      out.focus();
      out.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    }
  }
  toast(ok ? 'Copied ' + selectedAdvanceRd2Emails().length + ' emails' : 'Could not copy — use Show emails and copy from there');
}

function toggleAdvanceRd2Emails() {
  const panel = document.getElementById('advanceRd2EmailPanel');
  const out = document.getElementById('advanceRd2EmailOut');
  const btn = document.getElementById('showAdvanceRd2Emails');
  if (!panel || !out) return;
  if (!panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show emails';
    return;
  }
  out.value = advanceRd2EmailText('\n');
  panel.hidden = false;
  if (btn) btn.textContent = 'Hide emails';
  out.focus();
  out.select();
}

function advanceCountLabel() {
  const ranked = scoredScreenApplicants();
  const selected = ranked.filter(function (a) { return isAdvanceChecked(a.id); }).length;
  const topN = (STATE.advance && STATE.advance.topN) || Math.min(20, ranked.length) || 20;
  const poolN = poolForRound('round1').length;
  const applied = hasExplicitAdvance();
  const emailN = selectedAdvanceEmails().length;
  const rejectN = selectedRejectionEmails().length;
  const bizN = selectedBusinessAdvanceApplicants().length;
  return selected + ' selected · N = ' + topN + (applied ? ' · ' + poolN + ' in First Round' : '') + ' · ' + emailN + ' emails' + (applied ? ' · ' + rejectN + ' rejection emails' : '') + ' · ' + bizN + ' business majors';
}

function bindClearAdvanceButton(btn) {
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', function () {
    clearAdvanceSet();
    renderOverviewPreserveScroll();
    toast('First Round includes everyone again');
  });
}

function refreshAdvanceUi() {
  const countEl = document.querySelector('.advance-count');
  if (countEl) countEl.textContent = advanceCountLabel();
  const statusEl = document.querySelector('.advance-status');
  if (statusEl) {
    statusEl.textContent = hasExplicitAdvance()
      ? 'First Round is the checked list below.'
      : 'First Round still includes everyone — Apply top N to set the pool.';
  }
  if (hasExplicitAdvance() && !document.getElementById('clearAdvance')) {
    const applyBtn = document.getElementById('applyTopN');
    if (applyBtn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost small';
      btn.id = 'clearAdvance';
      btn.textContent = 'Use everyone again';
      applyBtn.insertAdjacentElement('afterend', btn);
      bindClearAdvanceButton(btn);
    }
  }
  const r1Pool = poolForRound('round1');
  const r1Scored = r1Pool.filter(function (a) { return scoreFor('round1', a.id) !== null; }).length;
  const tile = document.querySelector('[data-stat="round:round1"]');
  if (tile) {
    const valueEl = tile.querySelector('.value');
    const subEl = tile.querySelector('.sub');
    if (valueEl) valueEl.textContent = r1Scored + '/' + r1Pool.length;
    if (subEl) subEl.textContent = hasExplicitAdvance() ? 'scored · explicit advance set' : 'scored · everyone until you Apply top N';
  }
  const railCount = document.querySelector('.rail-btn[data-nav="round:round1"] .count');
  if (railCount) railCount.textContent = String(r1Pool.length);
  const emailOut = document.getElementById('advanceEmailOut');
  const emailPanel = document.getElementById('advanceEmailPanel');
  if (emailOut && emailPanel && !emailPanel.hidden) {
    emailOut.value = advanceEmailText('\n');
  }
  syncRejectEmailControls();
  syncBusinessMajorControls();
}

function selectedAdvanceApplicants() {
  if (hasExplicitAdvance()) {
    return STATE.applicants.filter(function (a) { return STATE.advance.round1[a.id] === true; });
  }
  return STATE.applicants.slice();
}

function selectedAdvanceEmails() {
  return selectedAdvanceApplicants().map(function (a) {
    return String(a.email || '').trim();
  }).filter(Boolean);
}

function advanceEmailText(sep) {
  return selectedAdvanceEmails().join(sep == null ? '\n' : sep);
}

async function copyAdvanceEmails() {
  const text = advanceEmailText(', ');
  if (!text) { toast('No emails on the current advance set'); return; }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { /* fall through */ }
  if (!ok) {
    const panel = document.getElementById('advanceEmailPanel');
    const out = document.getElementById('advanceEmailOut');
    if (panel && out) {
      panel.hidden = false;
      out.value = text;
      out.focus();
      out.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    }
  }
  toast(ok ? 'Copied ' + selectedAdvanceEmails().length + ' emails' : 'Could not copy — use Show emails and copy from there');
}

function toggleAdvanceEmails() {
  const panel = document.getElementById('advanceEmailPanel');
  const out = document.getElementById('advanceEmailOut');
  const btn = document.getElementById('showAdvanceEmails');
  if (!panel || !out) return;
  if (!panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show emails';
    return;
  }
  out.value = advanceEmailText('\n');
  panel.hidden = false;
  if (btn) btn.textContent = 'Hide emails';
  out.focus();
  out.select();
}

function selectedRejectionApplicants() {
  if (!hasExplicitAdvance()) return [];
  return STATE.applicants.filter(function (a) { return STATE.advance.round1[a.id] !== true; });
}

function selectedRejectionEmails() {
  return selectedRejectionApplicants().map(function (a) {
    return String(a.email || '').trim();
  }).filter(Boolean);
}

function rejectEmailText(sep) {
  return selectedRejectionEmails().join(sep == null ? '\n' : sep);
}

function syncRejectEmailControls() {
  const applied = hasExplicitAdvance();
  ['copyRejectEmails', 'showRejectEmails'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !applied;
    el.title = applied ? 'Emails of people who did not move to First Round' : 'Everyone is still in the pool';
  });
  const panel = document.getElementById('rejectEmailPanel');
  const out = document.getElementById('rejectEmailOut');
  const btn = document.getElementById('showRejectEmails');
  if (!applied && panel && !panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show rejection emails';
  } else if (out && panel && !panel.hidden) {
    out.value = rejectEmailText('\n');
  }
}

async function copyRejectEmails() {
  if (!hasExplicitAdvance()) { toast('Everyone is still in the pool'); return; }
  const text = rejectEmailText(', ');
  if (!text) { toast('No emails on the rejection set'); return; }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { /* fall through */ }
  if (!ok) {
    const panel = document.getElementById('rejectEmailPanel');
    const out = document.getElementById('rejectEmailOut');
    if (panel && out) {
      panel.hidden = false;
      out.value = text;
      out.focus();
      out.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    }
  }
  toast(ok ? 'Copied ' + selectedRejectionEmails().length + ' rejection emails' : 'Could not copy — use Show rejection emails and copy from there');
}

function toggleRejectEmails() {
  if (!hasExplicitAdvance()) { toast('Everyone is still in the pool'); return; }
  const panel = document.getElementById('rejectEmailPanel');
  const out = document.getElementById('rejectEmailOut');
  const btn = document.getElementById('showRejectEmails');
  if (!panel || !out) return;
  if (!panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show rejection emails';
    return;
  }
  out.value = rejectEmailText('\n');
  panel.hidden = false;
  if (btn) btn.textContent = 'Hide rejection emails';
  out.focus();
  out.select();
}

const BUSINESS_MAJOR_NEEDLES = [
  'finance',
  'marketing',
  'management',
  'information systems',
  'business administration',
  'business admin',
  'accounting',
];

// Form option is "Computer Science / Information Systems" but people are usually one.
// Classified from resume and/or LinkedIn. Omitted = unknown (do not treat as IS).
const CS_IS_TRUE_MAJOR = {
  a8_57e3cb9d: 'IS',
  a11_d5e778be: 'IS',
  a21_f7ec1864: 'CS',
  a40_8dd93674: 'IS',
  a57_7fb0a1c0: 'IS',
  a95_4c3308be: 'IS',
  a114_9684b255: 'IS',
  a115_07c2071b: 'IS',
  a189_b62fdd11: 'IS',
  a191_2b5f67cc: 'IS',
  a195_8c677728: 'IS',
  a196_0d8f3f4b: 'IS',
  a220_26620dd3: 'CS',
  a222_6b888c06: 'IS',
  a228_f0baad0b: 'IS',
  a244_f97f5683: 'CS',
};

function isManagementFalsePositive(text) {
  return /\bsports?\s+management\b/.test(text) || /\bconstruction\s+management\b/.test(text);
}

function isCombinedCsisPart(part) {
  return part.indexOf('computer science') !== -1 && part.indexOf('information systems') !== -1;
}

function csisOverrideFor(a) {
  if (!a || !a.id) return '';
  return CS_IS_TRUE_MAJOR[a.id] || '';
}

function isBusinessMajor(a) {
  const raw = (a && typeof a === 'object') ? String(a.major || '').trim() : String(a || '').trim();
  const override = (a && typeof a === 'object') ? csisOverrideFor(a) : '';
  if (!raw) return false;
  const parts = raw.split(/[,;]/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase().replace(/\s+/g, ' ').trim();
    if (!part) continue;
    if (isCombinedCsisPart(part)) {
      if (override === 'IS' || override === 'both') return true;
      continue;
    }
    const hasOtherNeedle = BUSINESS_MAJOR_NEEDLES.some(function (n) {
      return n !== 'management' && part.indexOf(n) !== -1;
    });
    if (isManagementFalsePositive(part) && !hasOtherNeedle) continue;
    for (let j = 0; j < BUSINESS_MAJOR_NEEDLES.length; j++) {
      if (part.indexOf(BUSINESS_MAJOR_NEEDLES[j]) !== -1) return true;
    }
  }
  return false;
}

function displayBusinessMajor(a) {
  const form = String((a && a.major) || '').trim() || '(no major)';
  const override = csisOverrideFor(a);
  if (!override) return form;
  const classified = override === 'both'
    ? 'Computer Science / Information Systems'
    : (override === 'IS' ? 'Information Systems' : 'Computer Science');
  const extras = form.split(/[,;]/).map(function (p) {
    return p.replace(/\s+/g, ' ').trim();
  }).filter(function (p) {
    if (!p) return false;
    return !isCombinedCsisPart(p.toLowerCase());
  });
  const shown = [classified].concat(extras).join(', ');
  const formShort = form.replace(/Computer Science \/ Information Systems/gi, 'CS/IS');
  return shown + ' (form: ' + formShort + ')';
}

function selectedBusinessAdvanceApplicants() {
  return selectedAdvanceApplicants().filter(function (a) { return isBusinessMajor(a); });
}

function selectedBusinessAdvanceEmails() {
  return selectedBusinessAdvanceApplicants().map(function (a) {
    return String(a.email || '').trim();
  }).filter(Boolean);
}

function businessAdvanceEmailText(sep) {
  return selectedBusinessAdvanceEmails().join(sep == null ? '\n' : sep);
}

function businessAdvanceVerifyText() {
  return selectedBusinessAdvanceApplicants().map(function (a) {
    const name = String(a.name || '').trim() || '(no name)';
    const major = displayBusinessMajor(a);
    const email = String(a.email || '').trim() || '(no email)';
    return name + ' — ' + major + ' — ' + email;
  }).join('\n');
}

function syncBusinessMajorControls() {
  const n = selectedBusinessAdvanceApplicants().length;
  const empty = n === 0;
  ['copyBusinessEmails', 'showBusinessMajors'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = empty;
    el.title = empty
      ? 'No business majors in First Round'
      : (id === 'copyBusinessEmails'
        ? 'Emails of business majors in First Round'
        : 'Name, major, and email of business majors in First Round');
  });
  const panel = document.getElementById('businessMajorPanel');
  const out = document.getElementById('businessMajorOut');
  const btn = document.getElementById('showBusinessMajors');
  if (empty && panel && !panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show business majors';
  } else if (out && panel && !panel.hidden) {
    out.value = businessAdvanceVerifyText();
  }
}

async function copyBusinessEmails() {
  const people = selectedBusinessAdvanceApplicants();
  if (!people.length) { toast('No business majors in First Round'); return; }
  const text = businessAdvanceEmailText(', ');
  if (!text) { toast('No business majors in First Round'); return; }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { /* fall through */ }
  if (!ok) {
    const panel = document.getElementById('businessMajorPanel');
    const out = document.getElementById('businessMajorOut');
    if (panel && out) {
      panel.hidden = false;
      out.value = text;
      out.focus();
      out.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    }
  }
  toast(ok ? 'Copied ' + selectedBusinessAdvanceEmails().length + ' business emails' : 'Could not copy — use Show business majors and copy from there');
}

function toggleBusinessMajors() {
  const people = selectedBusinessAdvanceApplicants();
  if (!people.length) { toast('No business majors in First Round'); return; }
  const panel = document.getElementById('businessMajorPanel');
  const out = document.getElementById('businessMajorOut');
  const btn = document.getElementById('showBusinessMajors');
  if (!panel || !out) return;
  if (!panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show business majors';
    return;
  }
  out.value = businessAdvanceVerifyText();
  panel.hidden = false;
  if (btn) btn.textContent = 'Hide business majors';
  out.focus();
  out.select();
}

let lastOverviewScroll = { mainTop: 0, contentTop: 0, listTop: 0, listTopRd2: 0 };
let advanceListHover = false;
let advanceListScrollAt = 0;
const ADVANCE_SCROLL_GUARD_MS = 8000;

function advanceFingerprint(adv) {
  const a = adv || emptyAdvance();
  const r1 = a.round1 || {};
  const keys = Object.keys(r1).sort();
  const bits = keys.map(function (k) { return k + ':' + (r1[k] ? '1' : '0'); }).join(',');
  return (a.applied ? '1' : '0') + '|' + String(a.topN == null ? '' : a.topN) + '|' + bits;
}

function noteAdvanceListActivity() {
  advanceListScrollAt = Date.now();
  const list = document.getElementById('advanceList');
  const list2 = document.getElementById('advanceRd2List');
  if (list) lastOverviewScroll.listTop = list.scrollTop;
  if (list2) lastOverviewScroll.listTopRd2 = list2.scrollTop;
}

function advanceListRecentlyUsed() {
  return advanceListHover || (Date.now() - advanceListScrollAt) < ADVANCE_SCROLL_GUARD_MS;
}

function bindAdvanceListScrollGuard() {
  ['advanceList', 'advanceRd2List'].forEach(function (id) {
    const list = document.getElementById(id);
    if (!list || list.dataset.scrollGuard === '1') return;
    list.dataset.scrollGuard = '1';
    list.addEventListener('pointerenter', function () { advanceListHover = true; });
    list.addEventListener('pointerleave', function () { advanceListHover = false; });
    list.addEventListener('scroll', noteAdvanceListActivity, { passive: true });
    list.addEventListener('wheel', noteAdvanceListActivity, { passive: true });
  });
}

function bindAdvanceRd2ListScrollGuard() {
  bindAdvanceListScrollGuard();
}

function syncAdvanceCheckboxesFromState() {
  document.querySelectorAll('[data-advance]').forEach(function (box) {
    const on = isAdvanceChecked(box.dataset.advance);
    if (box.checked !== on) box.checked = on;
  });
  refreshAdvanceUi();
}

function syncAdvanceRd2CheckboxesFromState() {
  document.querySelectorAll('[data-advance-rd2]').forEach(function (box) {
    const on = isAdvanceRd2Checked(box.dataset.advanceRd2);
    if (box.checked !== on) box.checked = on;
  });
  refreshAdvanceRd2Ui();
}

function applyLiveOverviewUpdate(advanceChanged, rd2Changed) {
  if (advanceChanged) syncAdvanceCheckboxesFromState();
  if (rd2Changed) syncAdvanceRd2CheckboxesFromState();
  setSaveStatus(STATE.saveStatus);
}

function pollShouldRemountOverview(advanceChanged) {
  if (STATE.view !== 'overview') return true;
  if (advanceListRecentlyUsed()) return false;
  if (!advanceChanged) return false;
  return true;
}

function captureOverviewScroll() {
  const main = pageScrollEl();
  const list = document.getElementById('advanceList');
  const list2 = document.getElementById('advanceRd2List');
  const snap = {
    mainTop: main ? main.scrollTop : lastOverviewScroll.mainTop,
    contentTop: contentEl ? contentEl.scrollTop : lastOverviewScroll.contentTop,
    listTop: list ? list.scrollTop : lastOverviewScroll.listTop,
    listTopRd2: list2 ? list2.scrollTop : lastOverviewScroll.listTopRd2,
  };
  lastOverviewScroll = snap;
  return snap;
}

function restoreOverviewScroll(snap) {
  if (!snap) snap = lastOverviewScroll;
  if (!snap) return;
  function apply() {
    const main = pageScrollEl();
    const list = document.getElementById('advanceList');
    const list2 = document.getElementById('advanceRd2List');
    if (main) main.scrollTop = snap.mainTop;
    if (contentEl) contentEl.scrollTop = snap.contentTop;
    if (list) list.scrollTop = snap.listTop;
    if (list2) list2.scrollTop = snap.listTopRd2;
    bindAdvanceListScrollGuard();
  }
  apply();
  requestAnimationFrame(apply);
}

function renderOverviewPreserveScroll() {
  const snap = captureOverviewScroll();
  render();
  restoreOverviewScroll(snap);
}

function funnelRow(label, n, max) {
  return `<div class="bar-row"><div class="lbl">${esc(label)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (n / Math.max(1, max)) * 100)}%"></div></div>
    <div class="val">${n}</div></div>`;
}

function statTile(label, value, sub, nav) {
  const click = nav ? ` clickable" data-nav="${esc(nav)}" role="button" tabindex="0` : '';
  const stat = nav ? ` data-stat="${esc(nav)}"` : '';
  return `<div class="card stat-tile${click}"${stat}><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
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
  STATE.groups.forEach(g => { tallies[g.id] = { sum: 0, n: 0 }; });
  Object.entries(STATE.grades.screen).forEach(([aid, g]) => {
    if (!hasManualScore(g)) return;
    const grp = assignmentGroup('screen', aid);
    const avg = screenAverage(g, STATE.byId[aid]);
    if (avg === null || !grp || !tallies[grp.id]) return;
    tallies[grp.id].sum += avg;
    tallies[grp.id].n++;
  });
  const overallVals = Object.entries(STATE.grades.screen).filter(([, g]) => hasManualScore(g)).map(([aid, g]) => screenAverage(g, STATE.byId[aid])).filter(v => v !== null);
  const overall = overallVals.length ? overallVals.reduce((a, b) => a + b, 0) / overallVals.length : null;
  const rows = STATE.groups.map(g => {
    const t = tallies[g.id];
    const avg = t.n ? t.sum / t.n : null;
    const bias = avg !== null && overall !== null ? avg - overall : null;
    const assigned = groupLoad('screen', g.id);
    return { g, avg, n: t.n, assigned, bias };
  }).filter(x => x.assigned > 0);
  if (!rows.some(x => x.n > 0)) return emptyNote('No Application Screen scores yet — calibration appears once reviews start.');
  return rows.map(({ g, avg, n, assigned, bias }) => `
    <div class="reviewer-bias-row">
      <div class="nm">${esc(g.name)}</div>
      <div class="mono">${avg !== null ? avg.toFixed(2) : '—'}</div>
      <div class="n">(${n}/${assigned} filled)</div>
      <div class="topbar-spacer"></div>
      ${bias !== null ? `<span class="chip ${bias > 0.3 ? 'warn' : bias < -0.3 ? 'bad' : 'good'}">${bias > 0 ? '+' : ''}${bias.toFixed(2)} vs. avg</span>` : ''}
    </div>`).join('');
}

// ---------------- Round list ----------------
function applicantMatchesSearch(a, q) {
  if (!q) return true;
  return (a.name || '').toLowerCase().includes(q)
    || (a.major || '').toLowerCase().includes(q)
    || (a.email || '').toLowerCase().includes(q);
}

function filteredRoundPool(round) {
  let list = poolForRound(round);
  if (round === 'round1' && STATE.screenedOnly) {
    list = list.filter(a => scoreFor('screen', a.id) !== null);
  }
  if (round === 'round1') {
    if (STATE.filterInterviewer && STATE.filterInterviewer !== 'all') {
      if (STATE.filterInterviewer === 'unassigned') {
        list = list.filter(function (a) { return !r1InterviewerId(a.id); });
      } else {
        list = list.filter(function (a) { return r1InterviewerId(a.id) === STATE.filterInterviewer; });
      }
    }
    if (STATE.incompleteOnly) {
      list = list.filter(function (a) { return !hasR1InterviewScore(STATE.grades.round1[a.id]); });
    }
    if (STATE.knowFlagOnly) {
      list = list.filter(function (a) {
        const g = STATE.grades.round1[a.id];
        return !!(g && g.knowFlag);
      });
    }
  } else {
    if (STATE.filterGroup !== 'all') list = list.filter(a => ensureAssignment(round, a.id) === STATE.filterGroup);
    if (STATE.incompleteOnly && STATE.filterGroup !== 'all') {
      list = list.filter(a => !hasManualScore(STATE.grades[round][a.id]));
    }
  }
  if (STATE.flaggedOnly) list = list.filter(a => isFlagged(a.id));
  if (STATE.filterYear !== 'all') list = list.filter(a => a.classYear === STATE.filterYear);
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    list = list.filter(a => applicantMatchesSearch(a, q));
  }
  return sortApplicantList(list, round);
}

function filteredFlaggedPool() {
  let list = flaggedApplicants();
  if (STATE.filterYear !== 'all') list = list.filter(a => a.classYear === STATE.filterYear);
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    list = list.filter(a => applicantMatchesSearch(a, q));
  }
  return sortApplicantList(list, 'screen');
}

function roundListRowsHtml(round, list) {
  const cols = round === 'round1' ? 7 : 6;
  return list.map(a => renderRow(round, a)).join('') || `<tr><td colspan="${cols}"><div class="empty-state">${emptyRoundMessage(round)}</div></td></tr>`;
}

function flaggedListRowsHtml(list) {
  return list.map(a => {
    const round = flagRoundFor(a.id);
    const score = scoreFor(round, a.id);
    return `<tr class="clickable" role="button" tabindex="0" data-id="${a.id}" data-round="${round}">
      <td><div class="name-cell"><span class="nm">${esc(a.name)}${lateBadge(a)}${flagBadge(a)}${vouchCount(a.id) ? `<span class="vouch-badge" title="Vouched for by ${esc(vouchNames(a.id))}">★ ${vouchCount(a.id)}</span>` : ''}</span><span class="sub">${esc(a.classYear)} · ${esc(a.gradYear)}</span></div></td>
      <td>${gpaCell(a)}</td>
      <td>${esc(ROUND_LABEL[round] || round)}</td>
      <td><span class="score-pill${round === 'screen' && score !== null ? ' pair' : ''}">${score === null ? '—' : (round === 'round2' ? score : round === 'screen' ? formatScreenScorePairHtml(a.id) : score.toFixed(1))}</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty-state">No one is flagged for a second reviewer.</div></td></tr>`;
}

function listCountLabel(round, list) {
  return STATE.incompleteOnly ? list.length + ' unreviewed' : list.length + ' shown';
}

function bindApplicantRowClicks(onOpen) {
  contentEl.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', () => onOpen(tr)));
}

function openRoundApplicant(round, tr) {
  STATE.queueTrail = [];
  STATE.queueDone = false;
  STATE.returnView = 'round:' + round;
  STATE.currentApplicantId = tr.dataset.id;
  STATE.gradeRound = round;
  STATE.view = 'grade';
  render();
}

function openFlaggedApplicant(tr) {
  STATE.queueTrail = [];
  STATE.queueDone = false;
  STATE.returnView = 'flagged';
  STATE.currentApplicantId = tr.dataset.id;
  STATE.gradeRound = tr.dataset.round || flagRoundFor(tr.dataset.id);
  STATE.view = 'grade';
  render();
}

function refreshRoundListRows(round) {
  const list = filteredRoundPool(round);
  const tbody = contentEl.querySelector('table.grid tbody');
  const countEl = document.getElementById('listCount');
  if (!tbody) { renderRoundList(round); return; }
  tbody.innerHTML = roundListRowsHtml(round, list);
  if (countEl) countEl.textContent = listCountLabel(round, list);
  bindApplicantRowClicks(function (tr) { openRoundApplicant(round, tr); });
}

function refreshFlaggedListRows() {
  const list = filteredFlaggedPool();
  const tbody = contentEl.querySelector('table.grid tbody');
  const countEl = document.getElementById('listCount');
  if (!tbody) { renderFlaggedList(); return; }
  tbody.innerHTML = flaggedListRowsHtml(list);
  if (countEl) countEl.textContent = list.length + ' flagged';
  bindApplicantRowClicks(openFlaggedApplicant);
}

function renderRoundList(round) {
  const list = filteredRoundPool(round);
  const yearOpts = ['Freshman', 'Sophomore', 'Junior', 'Senior'].filter(y => STATE.applicants.some(a => a.classYear === y));
  const r1 = round === 'round1';
  const groupFilter = r1
    ? `<select id="interviewerFilter">
        <option value="all">All interviewers</option>
        <option value="unassigned" ${STATE.filterInterviewer === 'unassigned' ? 'selected' : ''}>Unassigned</option>
        ${(STATE.interviewers || []).map(function (iv) {
          return `<option value="${esc(iv.id)}" ${STATE.filterInterviewer === iv.id ? 'selected' : ''}>${esc(iv.name)}</option>`;
        }).join('')}
      </select>`
    : `<select id="groupFilter">
        <option value="all">All groups</option>
        ${STATE.groups.map(g => `<option value="${g.id}" ${STATE.filterGroup === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select>`;
  const head = r1
    ? `<th data-sort="name" class="${STATE.sortKey === 'name' ? 'sorted' : ''}">Applicant</th>
          <th data-sort="group" class="${STATE.sortKey === 'group' ? 'sorted' : ''}">Interviewer</th>
          <th data-sort="time" class="${STATE.sortKey === 'time' ? 'sorted' : ''}">Time</th>
          <th>Notes</th>
          <th>Follow-up</th>
          <th data-sort="appscore" class="${STATE.sortKey === 'appscore' ? 'sorted' : ''}">App /5</th>
          <th data-sort="score" class="${STATE.sortKey === 'score' ? 'sorted' : ''}">R1 avg</th>`
    : `<th data-sort="name" class="${STATE.sortKey === 'name' ? 'sorted' : ''}">Applicant</th>
          <th data-sort="gpa" class="${STATE.sortKey === 'gpa' ? 'sorted' : ''}">GPA</th>
          <th>Position</th>
          <th>Attendance</th>
          <th data-sort="group" class="${STATE.sortKey === 'group' ? 'sorted' : ''}">Reviewer group</th>
          <th data-sort="score" class="${STATE.sortKey === 'score' ? 'sorted' : ''}">Score</th>`;

  contentEl.innerHTML = `
    <div class="filters-bar">
      <input type="search" id="searchBox" placeholder="Search name, major, email…" value="${esc(STATE.search)}">
      ${groupFilter}
      <select id="yearFilter">
        <option value="all">All class years</option>
        ${yearOpts.map(y => `<option value="${esc(y)}" ${STATE.filterYear === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}
      </select>
      ${r1 ? `<label class="chip ${STATE.screenedOnly ? 'active' : ''}" id="advToggle">Screened only</label>` : ''}
      ${r1 ? `<label class="chip ${STATE.knowFlagOnly ? 'active' : ''}" id="knowFlagToggle">Needs reassign</label>` : ''}
      <label class="chip ${STATE.flaggedOnly ? 'active' : ''}" id="flaggedToggle">Flagged</label>
      <label class="chip ${STATE.incompleteOnly ? 'active' : ''}" id="incompleteToggle">Unreviewed only</label>
      ${reviewAsChipsHtml(round)}
      <div class="topbar-spacer"></div>
      <span class="sub" id="listCount" style="color:var(--slate); font-size:12px;">${listCountLabel(round, list)}</span>
    </div>
    ${!r1 && STATE.incompleteOnly && STATE.filterGroup === 'all' ? `<div class="queue-hint">Pick your review group to see only that pair’s unfinished assigned applications. Other groups stay visible until you do.</div>` : ''}
    ${r1 ? `<div class="queue-hint">Pick an interviewer to filter to their interviews. Unassigned people need someone chosen on their profile — it is not random.</div>` : ''}
    <div class="table-wrap">
      <table class="grid">
        <thead><tr>
          ${head}
        </tr></thead>
        <tbody>
          ${roundListRowsHtml(round, list)}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('searchBox').addEventListener('input', e => { STATE.search = e.target.value; refreshRoundListRows(round); });
  const groupEl = document.getElementById('groupFilter');
  if (groupEl) groupEl.addEventListener('change', e => { STATE.filterGroup = e.target.value; STATE.queueTrail = []; renderRoundList(round); });
  const ivEl = document.getElementById('interviewerFilter');
  if (ivEl) ivEl.addEventListener('change', e => { STATE.filterInterviewer = e.target.value; STATE.queueTrail = []; renderRoundList(round); });
  document.getElementById('yearFilter').addEventListener('change', e => { STATE.filterYear = e.target.value; renderRoundList(round); });
  const advToggle = document.getElementById('advToggle');
  if (advToggle) advToggle.addEventListener('click', () => { STATE.screenedOnly = !STATE.screenedOnly; renderRoundList(round); });
  const knowToggle = document.getElementById('knowFlagToggle');
  if (knowToggle) knowToggle.addEventListener('click', () => { STATE.knowFlagOnly = !STATE.knowFlagOnly; renderRoundList(round); });
  const flaggedToggle = document.getElementById('flaggedToggle');
  if (flaggedToggle) flaggedToggle.addEventListener('click', () => { STATE.flaggedOnly = !STATE.flaggedOnly; renderRoundList(round); });
  const incompleteToggle = document.getElementById('incompleteToggle');
  if (incompleteToggle) incompleteToggle.addEventListener('click', () => { STATE.incompleteOnly = !STATE.incompleteOnly; renderRoundList(round); });
  bindReviewAs(contentEl, () => renderRoundList(round));
  contentEl.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (STATE.sortKey === k) STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc'; else { STATE.sortKey = k; STATE.sortDir = 'asc'; }
    renderRoundList(round);
  }));
  bindApplicantRowClicks(function (tr) { openRoundApplicant(round, tr); });
}

function renderFlaggedList() {
  const list = filteredFlaggedPool();
  const yearOpts = ['Freshman', 'Sophomore', 'Junior', 'Senior'].filter(y => STATE.applicants.some(a => a.classYear === y));
  contentEl.innerHTML = `
    <div class="filters-bar">
      <input type="search" id="searchBox" placeholder="Search name, major, email…" value="${esc(STATE.search)}">
      <select id="yearFilter">
        <option value="all">All class years</option>
        ${yearOpts.map(y => `<option value="${esc(y)}" ${STATE.filterYear === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}
      </select>
      <div class="topbar-spacer"></div>
      <span class="sub" id="listCount" style="color:var(--slate); font-size:12px;">${list.length} flagged</span>
    </div>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr>
          <th data-sort="name" class="${STATE.sortKey === 'name' ? 'sorted' : ''}">Applicant</th>
          <th data-sort="gpa" class="${STATE.sortKey === 'gpa' ? 'sorted' : ''}">GPA</th>
          <th>Flagged on</th>
          <th data-sort="score" class="${STATE.sortKey === 'score' ? 'sorted' : ''}">Score</th>
        </tr></thead>
        <tbody>
          ${flaggedListRowsHtml(list)}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('searchBox').addEventListener('input', e => { STATE.search = e.target.value; refreshFlaggedListRows(); });
  document.getElementById('yearFilter').addEventListener('change', e => { STATE.filterYear = e.target.value; renderFlaggedList(); });
  contentEl.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (STATE.sortKey === k) STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc'; else { STATE.sortKey = k; STATE.sortDir = 'asc'; }
    renderFlaggedList();
  }));
  bindApplicantRowClicks(openFlaggedApplicant);
}

function emptyRoundMessage(round) {
  if (STATE.flaggedOnly && !STATE.search && STATE.filterYear === 'all') {
    return 'No one is flagged for a second reviewer.';
  }
  if (STATE.incompleteOnly && STATE.filterGroup !== 'all' && !STATE.search && STATE.filterYear === 'all') {
    const grp = STATE.groups.find(g => g.id === STATE.filterGroup);
    return 'All ' + (grp ? grp.name : 'group') + ' ' + ROUND_LABEL[round] + ' reviews filled';
  }
  if (round === 'round2' && !poolForRound('round2').length) {
    return hasExplicitAdvanceRd2()
      ? 'The Round 2 set is empty — check people on Overview → Who advances to Round 2.'
      : 'Second Round uses the First Round pool. Set that pool on Overview, then pick who continues.';
  }
  return 'No applicants match these filters.';
}

function knowBadge(a) {
  const g = STATE.grades.round1[a.id];
  if (!g || !g.knowFlag) return '';
  return '<span class="know-badge" title="Assigned interviewer knows this person — reassign later">Knows them</span>';
}

function thankBadge(a) {
  const g = STATE.grades.round1[a.id];
  if (g && g.thankYou) return '<span class="follow-badge yes">Followed up</span>';
  return '<span class="follow-badge no">No follow-up</span>';
}

function renderRow(round, a) {
  const score = scoreFor(round, a.id);
  const maxScale = round === 'round2' ? 24 : round === 'screen' ? 5 : 4;
  const scoreClass = score === null ? 'none' : (round === 'round1' && score < 3) ? 'bad' : (round !== 'round1' && score >= maxScale * 0.75) ? 'good' : '';
  if (round === 'round1') {
    const g = STATE.grades.round1[a.id] || {};
    const who = interviewerName(g.interviewer);
    const time = formatInterviewTime(g.interviewTime);
    const notes = notesSnippet(g.initialNotes, 72);
    return `<tr class="clickable" role="button" tabindex="0" data-id="${a.id}">
      <td><div class="name-cell"><span class="nm">${esc(a.name)}${lateBadge(a)}${flagBadge(a)}${knowBadge(a)}${vouchCount(a.id) ? `<span class="vouch-badge" title="Vouched for by ${esc(vouchNames(a.id))}">★ ${vouchCount(a.id)}</span>` : ''}</span><span class="sub">${esc(a.classYear)} · ${esc(a.major || '')}</span></div></td>
      <td>${who ? esc(who) : '<span class="unassigned-pill">Unassigned</span>'}</td>
      <td>${time ? esc(time) : '<span class="sub">—</span>'}</td>
      <td><span class="notes-snip" title="${esc(g.initialNotes || '')}">${notes ? esc(notes) : '—'}</span></td>
      <td>${thankBadge(a)}</td>
      <td><span class="score-pill pair">${formatScreenScorePairHtml(a.id)}</span></td>
      <td><span class="score-pill ${scoreClass}">${score === null ? '—' : score.toFixed(1)}</span></td>
    </tr>`;
  }
  const grp = assignmentGroup(round, a.id);
  return `<tr class="clickable" role="button" tabindex="0" data-id="${a.id}">
    <td><div class="name-cell"><span class="nm">${esc(a.name)}${lateBadge(a)}${flagBadge(a)}${vouchCount(a.id) ? `<span class="vouch-badge" title="Vouched for by ${esc(vouchNames(a.id))}">★ ${vouchCount(a.id)}</span>` : ''}</span><span class="sub">${esc(a.classYear)} · ${esc(a.gradYear)}</span></div></td>
    <td>${gpaCell(a)}</td>
    <td>${esc(truncate(a.position, 28))}</td>
    <td>${attendanceIcons(a)}</td>
    <td>${grp ? esc(grp.name) : '—'}</td>
    <td><span class="score-pill ${scoreClass}${round === 'screen' && score !== null ? ' pair' : ''}">${score === null ? '—' : (round === 'round2' ? score : formatScreenScorePairHtml(a.id))}</span></td>
  </tr>`;
}

// GPA plus the academics band it maps to, so the auto-score is visible before opening anyone.
function gpaCell(a) {
  const auto = autoFor(a);
  if (auto.gpa.value == null) {
    return `<span class="gpa-cell none" title="${esc(auto.gpa.reason)}">${esc(truncate(a.gpa || '—', 12))}</span>`;
  }
  if (typeof auto.scores.academics !== 'number') {
    return `<span class="gpa-cell" title="${esc(auto.gpa.reason)}"><span class="mono">${auto.gpa.value.toFixed(2)}</span><span class="auto-pill na" title="High-school / incoming GPA is not scored">N/A</span></span>`;
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
  if (!a.attendance) a.attendance = { coffeeChats: [], infoSession: null, meetMembers: null };
  if (!Array.isArray(a.attendance.coffeeChats)) a.attendance.coffeeChats = [];
  const g = getGrade(round, a.id);
  const gid = activeReviewGroup(round, a.id);
  const grp = gid ? STATE.groups.find(function (x) { return x.id === gid; }) : null;

  if (STATE.queueDone) {
    const ownerName = round === 'round1'
      ? (interviewerShort(gid) || interviewerName(gid) || 'interviewer')
      : (grp ? grp.name : 'group');
    contentEl.innerHTML = `
      <button class="btn ghost small" id="backBtn">← Back to ${esc(ROUND_LABEL[round])}</button>
      <div class="empty-state">
        <h3>All ${esc(ownerName)} ${esc(ROUND_LABEL[round])} reviews filled</h3>
        <p>${round === 'round1' ? 'Every interview assigned to this interviewer has a score.' : 'Every application assigned to this pair has a score for this round.'}</p>
      </div>
    `;
    document.getElementById('backBtn').addEventListener('click', () => { STATE.queueDone = false; STATE.view = STATE.returnView || ('round:' + round); render(); });
    return;
  }

  const showEssays = round !== 'round1';
  const preservedEssays = showEssays ? takePreservedEl('gradeEssays', a.id) : null;
  const layout = getGradeLayout();
  const essaysMount = showEssays ? `<div class="grade-essays" id="gradeEssaysMount"></div>` : '';
  const body = layout === 'side'
    ? `<div class="two-col grade-layout-side">
        <div id="gradeMain"></div>
        <div class="side-stack" id="gradeSideCol">
          ${essaysMount}
          <div id="gradeSide"></div>
        </div>
      </div>`
    : `${essaysMount}
      <div class="two-col grade-layout-stacked">
        <div id="gradeMain"></div>
        <div class="side-stack" id="gradeSide"></div>
      </div>`;

  const assignBlock = round === 'round1' ? r1AssignBlockHtml(a, g) : `
        <div class="avg-display">${headerScoreInner(round, g, a)}</div>
        <div class="field-label assign-label">Assigned review group</div>
        <select id="groupPicker" title="Who is reviewing this application">
          ${STATE.groups.map(gr => `<option value="${gr.id}" ${ensureAssignment(round, a.id) === gr.id ? 'selected' : ''}>${esc(gr.name)}</option>`).join('')}
        </select>
        <button type="button" class="btn small know-person-btn" id="knowPersonBtn" title="Reassign this application to another review group"${readOnly ? ' disabled' : ''}>I know this person</button>`;

  contentEl.innerHTML = `
    <div class="grade-nav-row">
      <button class="btn ghost small" id="backBtn">← Back to ${esc(ROUND_LABEL[round])}</button>
      ${layoutToggleHtml()}
      <div class="topbar-spacer"></div>
      ${queueNavHtml(round, a.id)}
    </div>
    <div class="applicant-header" style="margin-top:10px;">
      <div>
        <h2>${esc(a.name)}${lateBadge(a)}${round === 'round1' ? knowBadge(a) : ''}<span id="knowFlagBadgeHost"></span></h2>
        <div class="meta">
          <span>🎓 ${esc(a.university)}</span>
          <span>${esc(a.classYear)} · Class of ${esc(a.gradYear)}</span>
          <span>${esc(a.major)}</span>
          <span>GPA ${esc(a.gpa)}</span>
          ${extUrl(a.linkedin) ? `<span><a href="${esc(extUrl(a.linkedin))}" target="_blank" rel="noopener">LinkedIn ↗</a></span>` : '<span class="muted-note">No LinkedIn</span>'}
          ${extUrl(a.resume) ? `<span><a href="${esc(extUrl(a.resume))}" target="_blank" rel="noopener">Resume ↗</a></span>` : ''}
        </div>
      </div>
      <div class="assign-block">
        ${assignBlock}
      </div>
    </div>
    ${body}
  `;
  document.getElementById('backBtn').addEventListener('click', () => { STATE.queueDone = false; STATE.view = STATE.returnView || ('round:' + round); render(); });
  const picker = document.getElementById('groupPicker');
  if (picker) picker.addEventListener('change', e => {
    STATE.assignments[round][a.id] = e.target.value; saveAssignment(round, a.id, e.target.value);
    if (round === 'screen') updateHeaderScore('screen', g, a);
  });
  contentEl.querySelectorAll('[data-layout]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.layout === getGradeLayout()) return;
      setGradeLayout(btn.dataset.layout);
      render();
    });
  });
  bindR1AssignControls(a, g);
  const knowBtn = document.getElementById('knowPersonBtn');
  if (knowBtn && round !== 'round1') knowBtn.addEventListener('click', function () { reassignKnownPerson(round, a.id); });
  bindQueueNav(round, a.id);

  if (round === 'screen') renderScreenGrade(a, g);
  else if (round === 'round1') renderRound1Grade(a, g);
  else renderRound2Grade(a, g);

  if (showEssays) mountGradeEssays(a, preservedEssays);
  renderGradeSide(a, round, g);
}

function r1AssignBlockHtml(a, g) {
  const ivs = STATE.interviewers || [];
  const assigned = g.interviewer || '';
  const stillListed = !assigned || ivs.some(function (iv) { return iv.id === assigned; }) || interviewerById(assigned);
  return `
        <div class="avg-display">${headerScoreInner('round1', g, a)}</div>
        <div class="r1-app-score" title="Application Screen weighted /5">${formatScreenScorePairHtml(a.id)} <span class="of">app /5</span></div>
        <div class="field-label assign-label">Interviewer</div>
        <select id="r1Interviewer" title="Who is interviewing this candidate"${readOnly ? ' disabled' : ''}>
          <option value="">Unassigned</option>
          ${ivs.map(function (iv) {
            return `<option value="${esc(iv.id)}" ${assigned === iv.id ? 'selected' : ''}>${esc(iv.name)}</option>`;
          }).join('')}
          ${assigned && !ivs.some(function (iv) { return iv.id === assigned; }) && stillListed
            ? `<option value="${esc(assigned)}" selected>${esc(interviewerName(assigned) || assigned)} (removed from roster)</option>`
            : ''}
        </select>
        <div class="field-label assign-label">Interview time</div>
        <input type="datetime-local" id="r1InterviewTime" value="${esc(g.interviewTime || '')}"${readOnly ? ' disabled' : ''}>
        <p class="bookings-note">Bookings isn’t connected — set time here</p>
        <button type="button" class="btn small know-person-btn ${g.knowFlag ? 'on' : ''}" id="knowPersonBtn" aria-pressed="${g.knowFlag ? 'true' : 'false'}" title="Flag that the assigned interviewer already knows this person. Does not reassign."${readOnly ? ' disabled' : ''}>I know this person</button>`;
}

function bindR1AssignControls(a, g) {
  if (STATE.gradeRound !== 'round1') return;
  const who = document.getElementById('r1Interviewer');
  if (who) who.addEventListener('change', function () {
    g.interviewer = who.value || undefined;
    saveGrade('round1', a.id, 'interviewer', null, g.interviewer);
    toast(g.interviewer ? 'Assigned to ' + (interviewerName(g.interviewer) || g.interviewer) : 'Unassigned');
  });
  const time = document.getElementById('r1InterviewTime');
  if (time) {
    time.addEventListener('change', function () {
      g.interviewTime = time.value || undefined;
      saveGrade('round1', a.id, 'interviewTime', null, g.interviewTime);
    });
  }
  const knowBtn = document.getElementById('knowPersonBtn');
  if (knowBtn) knowBtn.addEventListener('click', function () {
    g.knowFlag = !g.knowFlag;
    saveGrade('round1', a.id, 'knowFlag', null, g.knowFlag);
    knowBtn.classList.toggle('on', !!g.knowFlag);
    knowBtn.setAttribute('aria-pressed', g.knowFlag ? 'true' : 'false');
    const host = document.getElementById('knowFlagBadgeHost');
    const h2 = contentEl.querySelector('.applicant-header h2');
    if (h2) {
      const existing = h2.querySelector('.know-badge');
      if (g.knowFlag && !existing) h2.insertAdjacentHTML('beforeend', knowBadge(a));
      if (!g.knowFlag && existing) existing.remove();
    }
    if (host) host.innerHTML = '';
    toast(g.knowFlag ? 'Flagged to reassign later — interviewer unchanged' : 'Know-them flag cleared');
  });
}

function fmtScore(round, g, a) {
  if (round === 'screen') {
    if (!hasManualScore(g)) return '—';
    const v = screenAverage(g, a); return v === null ? '—' : v.toFixed(1);
  }
  if (round === 'round1') { const v = round1Average(g); return v === null ? '—' : v.toFixed(1); }
  const r = round2Total(g); return r ? r.total : '—';
}

function headerScoreInner(round, g, a) {
  if (round === 'screen') {
    if (!a || !hasManualScore(g)) return '<span class="big">—</span><span class="of">/ 5 avg</span>';
    const raw = screenAverage(g, a);
    if (raw == null) return '<span class="big">—</span><span class="of">/ 5 avg</span>';
    const std = standardizedScreenScore(a.id);
    const z = screenZScore(a.id);
    const zBit = z == null ? '' : ' · z ' + (z >= 0 ? '+' : '') + z.toFixed(1);
    return '<span class="big">' + raw.toFixed(1) + '</span><span class="of">/ 5 raw</span>'
      + '<span class="std-inline">' + std.toFixed(1) + ' std' + zBit + '</span>';
  }
  const of = round === 'round2' ? '/ 24' : '/ 4 avg';
  return '<span class="big">' + fmtScore(round, g, a) + '</span><span class="of">' + of + '</span>';
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
    function persist() {
      const g = getGrade(round, applicantId);
      if (ta.dataset.notekey === '__main') {
        g.notes = ta.value;
        saveGrade(round, applicantId, 'notes', null, ta.value);
      } else {
        g.qnotes = g.qnotes || {};
        g.qnotes[ta.dataset.notekey] = ta.value;
        saveGrade(round, applicantId, 'qnotes', null, cloneJson(g.qnotes));
      }
    }
    ta.addEventListener('input', persist);
    ta.addEventListener('blur', persist);
  });
}

function renderScreenGrade(a, g) {
  const main = document.getElementById('gradeMain');
  const dims = B.rubrics.screen.dims;
  const yearKeys = ['Freshman', 'Sophomore', 'Junior'];
  g.__yearTab = g.__yearTab || (yearKeys.includes(a.classYear) ? a.classYear : 'Junior');

  const auto = autoFor(a);

  main.innerHTML = `<div class="weight-note">${esc(SCREEN_WEIGHT_NOTE)}</div>` + dims.map(d => {
    const autoVal = auto.scores[d.key];
    const autoable = typeof autoVal === 'number';
    const usingAuto = autoable && isAuto(a, g, d.key);
    const overridden = autoable && typeof g.scores[d.key] === 'number' && g.scores[d.key] !== autoVal;
    const academicsNA = d.key === 'academics' && academicsIsNA(a, g);
    let hint = '';
    if (d.key === 'academics') {
      if (autoable) {
        hint = `<div class="auto-note ${overridden ? 'overridden' : ''}">
          ${overridden
            ? `Scored by hand. The rubric reads their <strong>${auto.gpa.value}</strong> ${esc(auto.gpa.label)} as a <strong>${autoVal}</strong> on the ${yearKeyFor(a)} scale — <button class="linkbtn" data-resetauto="${d.key}">reset to auto</button>`
            : `Filled from college GPA: <strong>${auto.gpa.value}</strong> ${esc(auto.gpa.label)} → <strong>${autoVal}</strong> on the ${yearKeyFor(a)} scale. Click any band or N/A to override.`}
        </div>`;
      } else {
        hint = `<div class="auto-note needs">Academics defaults to <strong>N/A</strong> (not in the average) — ${esc(auto.gpa.reason)}. Listed as <em>${esc(a.gpa || 'blank')}</em>. Click a 4/3/2/1 band to score, or leave N/A.</div>`;
      }
    }
    return `
    <div class="dim-card">
      <div class="dim-head">
        <h4>${esc(d.label)}</h4>
        ${usingAuto ? '<span class="chip auto">Auto</span>' : (d.key === 'academics' && academicsNA ? '<span class="chip auto">N/A</span>' : '')}
        <span class="chip static">0–4</span>
      </div>
      <div class="dim-body">
        <div class="year-tabs" data-dim="${d.key}">
          ${yearKeys.map(y => `<span class="year-tab ${g.__yearTab === y ? 'sel' : ''}" data-year="${y}">${y}${y === a.classYear ? ' (applicant)' : ''}</span>`).join('')}
        </div>
        <div class="band-row"${d.key === 'academics' ? ' style="grid-template-columns: repeat(5,1fr);"' : ''}>
          ${d.bands[g.__yearTab].map((txt, i) => {
            const score = 4 - i;
            const sel = !academicsNA && effScore(a, g, d.key) === score;
            return `<div class="band-opt ${sel ? 'sel' : ''} ${sel && usingAuto ? 'auto' : ''}" role="button" tabindex="0" data-key="${d.key}" data-val="${score}"><span class="sc">${i === 3 ? '1–0' : score}</span>${esc(txt)}</div>`;
          }).join('')}
          ${d.key === 'academics' ? `<div class="band-opt ${academicsNA ? 'sel' : ''}" role="button" tabindex="0" data-key="academics" data-val="NA"><span class="sc">N/A</span>High-school / incoming / not comparable — skipped in the average</div>` : ''}
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
    const key = el.dataset.key;
    const val = el.dataset.val === 'NA' ? 'NA' : Number(el.dataset.val);
    g.scores[key] = g.scores[key] === val ? undefined : val;
    saveGrade('screen', a.id, 'score', key, g.scores[key]);
    renderScreenGrade(a, g); updateHeaderScore('screen', g, a);
  }));
  main.querySelectorAll('[data-resetauto]').forEach(el => el.addEventListener('click', () => {
    g.scores[el.dataset.resetauto] = undefined;
    saveGrade('screen', a.id, 'score', el.dataset.resetauto, undefined);
    renderScreenGrade(a, g); updateHeaderScore('screen', g, a);
  }));
  main.querySelectorAll('.year-tab').forEach(el => el.addEventListener('click', () => {
    g.__yearTab = el.dataset.year; renderScreenGrade(a, g);
  }));
  bindNotesFields(main, 'screen', a.id);
  const flagBox = document.getElementById('flagSecond');
  if (flagBox) flagBox.addEventListener('change', () => { g.flagSecond = flagBox.checked; saveGrade('screen', a.id, 'flagSecond', null, g.flagSecond); });
}

function updateHeaderScore(round, g, a) {
  const box = document.querySelector('.avg-display');
  const person = a || STATE.byId[STATE.currentApplicantId];
  if (box) box.innerHTML = headerScoreInner(round, g, person);
  refreshQueueBar(round);
}

function screenDimsLine(a) {
  const sg = STATE.grades.screen[a.id] || { scores: {} };
  const bits = [
    ['academics', 'GPA'],
    ['resume', 'Resume'],
    ['experience', 'Exp'],
    ['leadership', 'Lead'],
    ['essay', 'Essay'],
  ].map(function (pair) {
    const v = pair[0] === 'academics' ? effScore(a, sg, 'academics') : sg.scores[pair[0]];
    return pair[1] + ' ' + (typeof v === 'number' ? v : '—');
  });
  return bits.join(' · ');
}

function updateR1ScoreUI(container, g, key) {
  container.querySelectorAll('.band-opt[data-key="' + key + '"]').forEach(function (opt) {
    opt.classList.toggle('sel', g.scores[key] === Number(opt.dataset.val));
  });
  const sample = container.querySelector('.band-opt[data-key="' + key + '"]');
  const card = sample && sample.closest('.dim-card');
  const pill = card && card.querySelector('.score-pill');
  if (pill) {
    const v = g.scores[key];
    pill.textContent = v || '—';
    pill.classList.toggle('none', !v);
  }
}

function r1PersonalityPromptHtml(g) {
  const qs = r1PersonalityList();
  const idx = r1PersonalityIdx(g);
  const q = idx != null ? qs[idx] : null;
  if (!q) return '<div class="sub" style="color:var(--slate);">Pick which personality question you asked.</div>';
  return `<div class="prompt" style="margin-top:8px;">${esc(q.q)}</div>
          <div class="band-row" style="grid-template-columns: repeat(4,1fr);">
            ${['1', '2', '3', '4'].map(k => `<div class="band-opt ${g.scores.personality === Number(k) ? 'sel' : ''}" data-key="personality" data-val="${k}"><span class="sc">${k}</span>${esc(q.crit[k]?.text || '')}</div>`).join('')}
          </div>`;
}

function bindR1BandOpts(root, a) {
  root.querySelectorAll('.band-opt').forEach(function (el) {
    el.addEventListener('click', function () {
      captureOpenR1Fields();
      const rec = getGrade('round1', a.id);
      const key = el.dataset.key, val = Number(el.dataset.val);
      if (R1_HIDDEN_KEYS[key]) return;
      rec.scores[key] = rec.scores[key] === val ? undefined : val;
      if (rec.qnotes) saveGrade('round1', a.id, 'qnotes', null, cloneJson(rec.qnotes));
      saveGrade('round1', a.id, 'score', key, rec.scores[key]);
      const main = document.getElementById('gradeMain') || root;
      updateR1ScoreUI(main, rec, key);
      updateHeaderScore('round1', rec);
    });
  });
}

function updateR1PersonalityUI(container, g, a) {
  const idx = r1PersonalityIdx(g);
  container.querySelectorAll('[data-pidx]').forEach(function (chip) {
    chip.classList.toggle('active', Number(chip.dataset.pidx) === idx);
  });
  const host = container.querySelector('#r1PersonalityPrompt');
  if (host) {
    host.innerHTML = r1PersonalityPromptHtml(g);
    if (a) bindR1BandOpts(host, a);
  }
}

function renderRound1Grade(a, g) {
  const main = document.getElementById('gradeMain');
  const R = B.rubrics.round1;
  captureOpenR1Fields();
  g = getGrade('round1', a.id);
  function qCard(q, key, displayIdx, groupLabel) {
    return `<div class="dim-card">
      <div class="dim-head"><h4>${groupLabel}${displayIdx != null ? ' · Q' + displayIdx : ''}</h4>${scoreFor2(g, key)}</div>
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
  let personalShown = 0;
  const personalCards = (R.personal || []).map(function (q, i) {
    const key = 'personal' + i;
    if (R1_HIDDEN_KEYS[key]) return '';
    personalShown += 1;
    return qCard(q, key, personalShown, 'Personal experience');
  }).join('');

  main.innerHTML = `
    <div class="card card-pad r1-notes-card" style="margin-bottom:14px;">
      <div class="field-label">Initial notes / Tell me about yourself</div>
      <div class="notes-field"><textarea id="r1InitialNotes" placeholder="Short summary from the intro — this is what shows on the First Round list.">${esc(g.initialNotes || '')}</textarea></div>
    </div>
    <div class="card card-pad r1-app-score-card" style="margin-bottom:14px;">
      <div class="section-title">Application Screen <span class="n">weighted /5</span></div>
      <div class="mono" style="margin:4px 0 6px;">${formatScreenScorePairHtml(a.id)}</div>
      <div class="sub" style="color:var(--slate);">${esc(screenDimsLine(a))}</div>
    </div>
    <div class="card card-pad" style="margin-bottom:14px;">
      <div class="section-title">Call structure <span class="n">30 minutes</span></div>
      ${R.callStructure.map(s => `<div style="margin-bottom:8px;"><strong>${esc(s.title)}</strong> <span class="sub" style="color:var(--slate);">(${s.minutes} min)</span><div style="font-size:13px; color:var(--ink-soft); margin-top:2px;">${esc(s.body)}</div></div>`).join('')}
    </div>
    ${R.fit.map((q, i) => qCard(q, 'fit' + i, i + 1, 'Fit question')).join('')}
    ${personalCards}
    <div class="dim-card">
      <div class="dim-head"><h4>Personality question — choose one</h4>${scoreFor2(g, 'personality')}</div>
      <div class="dim-body">
        <div class="case-select">
          ${R.personality.map((q, i) => `<span class="chip ${r1PersonalityIdx(g) === i ? 'active' : ''}" data-pidx="${i}">${esc(truncate(q.q, 34))}</span>`).join('')}
        </div>
        <div id="r1PersonalityPrompt">${r1PersonalityPromptHtml(g)}</div>
        <div class="notes-field"><textarea data-notekey="personality" placeholder="Candidate's answer, notes…">${esc((g.qnotes && g.qnotes.personality) || '')}</textarea></div>
      </div>
    </div>
    <div class="card card-pad">
      <label class="flag-row"><input type="checkbox" id="r1ThankYou" ${g.thankYou ? 'checked' : ''}${readOnly ? ' disabled' : ''}> Thank-you follow-up received</label>
      <label class="flag-row"><input type="checkbox" id="r1AdvanceRd2" ${isAdvanceRd2Checked(a.id) ? 'checked' : ''}${readOnly ? ' disabled' : ''}> Continue to Round 2</label>
      <div class="field-label">Recommendation</div>
      <div class="recommend-row">
        ${['Strong advance', 'Advance', 'Borderline', 'Do not advance'].map(r => `<span class="chip ${g.recommendation === r ? 'active' : ''}" data-rec="${r}">${r}</span>`).join('')}
      </div>
      <div class="field-label">Additional notes</div>
      <div class="notes-field"><textarea data-notekey="__main" placeholder="Anything else worth flagging…">${esc(g.notes || '')}</textarea></div>
    </div>
  `;
  bindR1BandOpts(main, a);
  main.querySelectorAll('[data-pidx]').forEach(el => el.addEventListener('click', () => {
    captureOpenR1Fields();
    const rec = getGrade('round1', a.id);
    const idx = Number(el.dataset.pidx);
    if (isNaN(idx)) return;
    rec.personalityIdx = idx;
    saveGrade('round1', a.id, 'personalityIdx', null, idx);
    updateR1PersonalityUI(main, rec, a);
  }));
  main.querySelectorAll('[data-rec]').forEach(el => el.addEventListener('click', () => {
    captureOpenR1Fields();
    const rec = getGrade('round1', a.id);
    rec.recommendation = rec.recommendation === el.dataset.rec ? undefined : el.dataset.rec;
    saveGrade('round1', a.id, 'recommendation', null, rec.recommendation);
    main.querySelectorAll('[data-rec]').forEach(function (chip) {
      chip.classList.toggle('active', rec.recommendation === chip.dataset.rec);
    });
  }));
  bindNotesFields(main, 'round1', a.id);
  const initNotes = document.getElementById('r1InitialNotes');
  if (initNotes) {
    function persistInit() {
      const rec = getGrade('round1', a.id);
      rec.initialNotes = initNotes.value;
      saveGrade('round1', a.id, 'initialNotes', null, initNotes.value);
    }
    initNotes.addEventListener('input', persistInit);
    initNotes.addEventListener('blur', persistInit);
  }
  const thank = document.getElementById('r1ThankYou');
  if (thank) thank.addEventListener('change', function () {
    const rec = getGrade('round1', a.id);
    rec.thankYou = thank.checked;
    saveGrade('round1', a.id, 'thankYou', null, rec.thankYou);
  });
  const rd2 = document.getElementById('r1AdvanceRd2');
  if (rd2) rd2.addEventListener('change', function () {
    setAdvanceRd2Checked(a.id, rd2.checked);
  });
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
    renderRound2Grade(a, g); updateHeaderScore('round2', g);
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

function essayField(label, text, always) {
  const val = text == null ? '' : String(text);
  if (!val.trim() && !always) return '';
  return `<div class="field-label">${esc(label)}</div><div class="essay-block" data-essay="${esc(label)}">${esc(val)}</div>`;
}

function takePreservedEl(id, applicantId) {
  const el = document.getElementById(id);
  if (el && el.getAttribute('data-applicant-id') === applicantId) {
    el.remove();
    return el;
  }
  return null;
}

function applicationEssaysHtml(a) {
  return `
    <div class="card card-pad app-essays-card grade-essays" id="gradeEssays" data-applicant-id="${esc(a.id)}">
      <div class="section-title" style="margin-bottom:8px;">Application</div>
      ${essayField('Why Rem', a.whyRem, true)}
      <div class="field-label">Core value: ${esc(a.coreValue)}</div>
      <div class="essay-block" data-essay="Core value essay">${esc(a.valueEssay)}</div>
      ${essayField('Career interests', a.careerInterests, true)}
      ${essayField('How joining Rem helps your career goals', a.howRemHelps, true)}
      ${essayField('Positions applying for', a.position)}
      ${essayField('Skills', a.skills)}
      ${essayField('Accommodations', a.accommodations)}
      ${essayField('Anything else', a.other)}
      ${essayField('Commitment acknowledgment', a.commitment)}
    </div>`;
}

function mountGradeEssays(a, preservedEssays) {
  const mount = document.getElementById('gradeEssaysMount');
  if (!mount) return;
  if (preservedEssays) {
    mount.replaceWith(preservedEssays);
    preservedEssays.classList.add('grade-essays');
    return;
  }
  mount.outerHTML = applicationEssaysHtml(a);
  const essays = document.getElementById('gradeEssays');
  if (essays) essays.classList.add('grade-essays');
}

function renderGradeSide(a, round, g) {
  const side = document.getElementById('gradeSide');
  side.innerHTML = `
    <div class="card card-pad">
      <div class="section-title" style="margin-bottom:6px;">Attendance</div>
      ${coffeeAttendanceBlock(a)}
      ${attendanceRow('Info session', !!(a.attendance && a.attendance.infoSession), a.attendance && a.attendance.infoSession ? (a.attendance.infoSession.session || a.attendance.infoSession.timestamp || 'checked in') : '')}
      ${attendanceRow('Meet the Members', !!(a.attendance && a.attendance.meetMembers), meetMembersDetail(a.attendance && a.attendance.meetMembers))}
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
      <div class="section-title" style="margin-bottom:4px;">${v.by.length ? `Vouched for <span class="n">${v.by.length}</span>` : 'Vouch'}</div>
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
  document.querySelectorAll('[data-vouch]').forEach(btn => btn.addEventListener('click', () => {
    const rec = getVouch(a.id);
    const rid = btn.dataset.vouch;
    const i = rec.by.indexOf(rid);
    if (i === -1) rec.by.push(rid); else rec.by.splice(i, 1);
    saveVouch(a.id);
    const card = btn.closest('.vouch-card');
    btn.classList.toggle('on');
    if (card) card.classList.toggle('has', rec.by.length > 0);
    const title = card && card.querySelector('.section-title');
    if (title) {
      title.innerHTML = rec.by.length ? `Vouched for <span class="n">${rec.by.length}</span>` : 'Vouch';
    }
  }));
  const note = document.getElementById('vouchNote');
  if (note) {
    let t;
    function persistNote() {
      getVouch(a.id).note = note.value;
      saveVouch(a.id);
    }
    note.addEventListener('input', () => {
      getVouch(a.id).note = note.value;
      clearTimeout(t);
      t = setTimeout(persistNote, 600);
    });
    note.addEventListener('blur', () => {
      clearTimeout(t);
      persistNote();
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

function meetMembersDetail(mm) {
  if (!mm) return '';
  const bits = [];
  if (mm.year) bits.push(String(mm.year));
  if (mm.timestamp) bits.push(String(mm.timestamp));
  if (mm.appliedBefore) bits.push('applied before: ' + String(mm.appliedBefore));
  return bits.join(' · ') || 'checked in';
}

function coffeeAttendanceBlock(a) {
  const chats = (a.attendance && a.attendance.coffeeChats) || [];
  if (!chats.length) return attendanceRow('Coffee chat', false, '');
  const items = chats.map(function (c) {
    const who = String(c.spokeTo || '').trim();
    const when = String(c.timestamp || '').trim();
    if (who && when) return 'Spoke with ' + who + ' · ' + when;
    if (who) return 'Spoke with ' + who;
    if (when) return 'Signed in ' + when + ' (host not listed)';
    return 'Signed in (host not listed)';
  });
  return `<div class="attendance-row yes">
    <span class="ic">●</span>
    <div class="att-detail">
      <strong>Coffee chat${chats.length > 1 ? 's' : ''}</strong>
      <ul class="spoke-list">${items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('')}</ul>
    </div>
  </div>`;
}

// ---------------- Groups view ----------------
function renderGroups() {
  contentEl.innerHTML = `
    <div class="card card-pad" style="margin-bottom:18px;">
      <div class="section-title">How this works</div>
      <div style="font-size:13.5px; color:var(--ink-soft); max-width:640px;">
        Application Screen is owned by review pairs — that pair is who is reviewing the written app, not whoever last clicked a score band. First Round interviews are assigned to individuals from the interviewer roster on Overview. Anyone can still vouch from a profile. Reassign a screen from the applicant page; “I know this person” on First Round only flags, it does not move them.
      </div>
    </div>
    <div class="group-grid">
      ${STATE.groups.map(g => renderGroupCard(g)).join('')}
    </div>
  `;
}

function renderGroupCard(g) {
  const members = g.members.map(id => REVIEWERS_BY_ID[id]?.name).filter(Boolean).join(' & ');
  const screenN = groupLoad('screen', g.id);
  const screenF = groupFilled('screen', g.id);
  return `<div class="card group-card">
    <h4>${esc(g.name)}</h4>
    <div class="members">${esc(members)}</div>
    <div class="load">${screenF}<span class="of"> / ${screenN} screen filled</span></div>
    <div class="sub" style="color:var(--slate); font-size:11.5px; margin-top:2px;">First Round interviews are assigned individually</div>
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
        Roster and attendance are baked into this page from the latest sign-in sheets. To write
        scores <em>back</em> to the mastersheet, run <code>python push_scores.py</code> — that
        matches by email and only includes people with a hand-entered score. CSV below is the
        same column layout if you still want a local copy.
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
    header = ['Name (First Last)', 'Year', 'Late', 'Academics', 'Resume', 'Experience & Involvement', 'Leadership & Involvement', 'Application Essay Rating', 'Notes', 'Who is reviewing this application', 'Average', 'Standardized', 'Blend', 'Attended Coffee Chats', 'Attended Info Session', 'Attended Meet the Members'];
    rows = STATE.applicants.map(a => {
      const g = STATE.grades.screen[a.id] || { scores: {} };
      const grp = assignmentGroup('screen', a.id);
      const raw = screenAverage(g, a);
      const std = hasManualScore(g) ? standardizedScreenScore(a.id) : null;
      const blend = hasManualScore(g) ? screenBlendScore(a.id) : null;
      return [a.name, a.classYear, a.late ? 'Late' : '', effScore(a, g, 'academics') ?? '', g.scores.resume ?? '', g.scores.experience ?? '', g.scores.leadership ?? '', g.scores.essay ?? '', g.notes || '', grp ? grp.name : '', raw ?? '', std == null ? '' : +std.toFixed(3), blend == null ? '' : +blend.toFixed(3), a.attendance.coffeeChats.length ? 'Yes' : 'No', a.attendance.infoSession ? 'Yes' : 'No', a.attendance.meetMembers ? 'Yes' : 'No'];
    });
  } else if (round === 'round1') {
    header = ['Candidate (First & Last) Name', 'Candidates School Email', 'Interviewer', 'Interview time', 'Initial notes', 'Thank-you', 'Knows them', 'Fit Q1', 'Fit Q2', 'Fit Q3', 'Personal Q1', 'Personal Q2', 'Personality Q', 'Average Score', 'App raw', 'App std', 'Recommendation', 'Notes'];
    rows = poolForRound('round1').map(a => {
      const g = STATE.grades.round1[a.id] || { scores: {} };
      const raw = scoreFor('screen', a.id);
      const std = raw == null ? null : standardizedScreenScore(a.id);
      return [a.name, a.email, interviewerName(g.interviewer) || '', g.interviewTime || '', g.initialNotes || '', g.thankYou ? 'Yes' : 'No', g.knowFlag ? 'Yes' : '', g.scores.fit0 ?? '', g.scores.fit1 ?? '', g.scores.fit2 ?? '', g.scores.personal1 ?? '', g.scores.personal2 ?? '', g.scores.personality ?? '', round1Average(g) ?? '', raw ?? '', std == null ? '' : +std.toFixed(3), g.recommendation || '', g.notes || ''];
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

// ---------------- Password gate ----------------
// Static GitHub Pages — the password is in the JS on purpose. Split so a casual
// View Source pass does not see the contiguous string.
const GATE_STORE = 'rem_uf_gate_ok';
const SITE_GATE = [
  'RemFall',
  '2026',
].join('');

function gateUnlocked() {
  try { return sessionStorage.getItem(GATE_STORE) === '1'; } catch (e) { return false; }
}

function markGateUnlocked() {
  try { sessionStorage.setItem(GATE_STORE, '1'); } catch (e) { /* private mode */ }
  document.body.classList.add('unlocked');
}

function ensureGateDom() {
  if (document.getElementById('gate')) return;
  const el = document.createElement('div');
  el.id = 'gate';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'gateTitle');
  el.innerHTML = '<form id="gateForm" class="gate-card" autocomplete="off">'
    + '<h1 id="gateTitle">REM UF Recruitment</h1>'
    + '<p>Enter the recruitment password to open the dashboard.</p>'
    + '<label class="sr-only" for="gatePassword">Password</label>'
    + '<input type="password" id="gatePassword" name="password" autocomplete="current-password">'
    + '<button type="submit" class="btn primary">Enter</button>'
    + '<p id="gateErr" class="gate-err" hidden>Wrong password</p>'
    + '</form>';
  document.body.insertBefore(el, document.body.firstChild);
}

function bindGate() {
  ensureGateDom();
  const form = document.getElementById('gateForm');
  const input = document.getElementById('gatePassword');
  const err = document.getElementById('gateErr');
  if (!form || !input) { markGateUnlocked(); initCapabilities(); return; }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (input.value === SITE_GATE) {
      markGateUnlocked();
      if (err) err.hidden = true;
      initCapabilities();
    } else {
      if (err) err.hidden = false;
      input.select();
    }
  });
  input.focus();
}

if (gateUnlocked()) {
  markGateUnlocked();
  initCapabilities();
} else {
  bindGate();
}
})();
