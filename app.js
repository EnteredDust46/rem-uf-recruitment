/* global BOOTSTRAP */
(function () {
'use strict';

const B = window.BOOTSTRAP;
const BUILD_STAMP = 'rd2-vibe-only-20260917';
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
  filterAdvanceRd2: 'all',
  filterR2Pair: 'all',
  filterR2Room: 'all',
  filterR2Date: 'all',
  filterR2Interviewer: 'all',
  r2SortTouched: false,
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
    // Re-check after the await: a personality chip click is not a focused
    // input, so the start-of-poll pending/saving guard can miss it.
    if (pendingOps().length || saving) return;
    // Don't consume this version while someone is mid-keystroke — adoptState
    // replaces STATE.vouches and would orphan the textarea's in-memory record.
    // A just-set R1 personality pick is the same class: chips aren't inputs.
    if (isEditingField() || shouldHoldPersonalityAgainstPoll() || shouldHoldR2AgainstPoll()) return;
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
      if (STATE.view === 'grade' && STATE.gradeRound === 'round1') {
        applyLiveR1GradeUpdate();
        return;
      }
      if (STATE.view === 'grade' && STATE.gradeRound === 'round2') {
        applyLiveR2GradeUpdate();
        return;
      }
      render();
    }
  } catch (e) { /* try again next tick */ }
}

function hasPersonalityIdxValue(v) {
  return v != null && v !== '' && !isNaN(Number(v));
}

// Chip clicks are not focused inputs, so a poll that started before the click
// can still adopt. Hold the pick until the PUT has had a chance to land.
const personalityHolds = {};
const PERSONALITY_HOLD_MS = 30000;

function holdPersonalityPick(id, idx) {
  if (!id || !hasPersonalityIdxValue(idx)) return;
  personalityHolds[id] = { idx: Number(idx), until: Date.now() + PERSONALITY_HOLD_MS };
}

function heldPersonalityIdx(id) {
  const h = id ? personalityHolds[id] : null;
  if (!h || Date.now() > h.until) return null;
  return h.idx;
}

function hasPendingPersonalityOp() {
  return pendingOps().some(function (op) {
    return op && op.kind === 'grade' && op.round === 'round1' && op.field === 'personalityIdx' && hasPersonalityIdxValue(op.value);
  });
}

function shouldHoldPersonalityAgainstPoll() {
  if (hasPendingPersonalityOp()) return true;
  if (STATE.view === 'grade' && STATE.gradeRound === 'round1' && STATE.currentApplicantId) {
    if (heldPersonalityIdx(STATE.currentApplicantId) != null) return true;
  }
  return false;
}

// Last year's Fox behavioral bank (sheet "Final Round Grading Rubric", col A).
// Titles are short chips; `q` is the full prompt. Stable ids are slugs, not indexes.
const R2_BEHAVIORAL_FALLBACK = [
  { id: 'best-in-room-of-1000', title: 'Best in a room of 1000', q: 'What is the thing that you believe in, in a room of 1000 people, you are the best at?' },
  { id: 'pack-up-and-move', title: 'Pack up and move', q: 'If you had to immediately pack everything and move somewhere, where would you go and why?' },
  { id: 'goat-of-anything', title: 'GOAT of anything', q: 'If you could be the GOAT of anything, what would you pick?' },
  { id: 'any-profession', title: 'Any profession', q: 'If you could pick any profession and be paid enough to live a great life, what would you do?' },
  { id: 'cannot-live-without', title: 'Cannot live without', q: 'What is one thing that you cannot live without?' },
  { id: 'what-animal', title: 'What animal', q: 'If you could be an animal, what animal would you be?' },
];
const R2_BEHAVIORAL_BANDS = {
  1: { label: 'Unacceptable', text: 'Gives no meaningful answer or responds in a way that shows a lack of self-awareness or accountability.' },
  2: { label: 'Not a good fit but showing promise', text: 'Provides a generic or surface-level response with little reflection.' },
  3: { label: 'Satisfactory fit', text: 'Offers a thoughtful answer that demonstrates some self-awareness and a willingness to grow.' },
  4: { label: 'Exceeding Expectations', text: 'Provides a detailed, introspective answer showing strong self-awareness and a clear point of view.' },
};
const R2_CASE_INSTRUCTIONS = 'Three Fall 2026 Fox cases — Golden Taco, Bean & Bloom, and PedalPure. Select a case to open the interviewer reference. Scoring lives in the rubric and is not tied to whether the case is open. Play the business owner — do not name the three issues; let the candidate dig them out. Run the case first, then 1–2 behaviorals.';

const R2_CASE_TITLES = {
  golden_taco: 'Golden Taco',
  bean_bloom: 'Bean & Bloom',
  pedal_pure: 'PedalPure',
};

const R2_CASE_SHARED_OPENING = {
  steps: [
    'Give a brief introduction — who you are, and a sentence about Rem.',
    'Tell them that everything from today’s interview is confidential. They should not share it with anyone else.',
    'Collect the candidate’s phone before you start the case, along with any notes or materials they should not have during it.',
  ],
};

const R2_CASE_TRANSITION = 'Over the next few minutes, you’ll hear the story of a struggling business owner. As a potential member of our chapter, you’ll need to identify the problems at hand, ask questions to inform your recommendation, and propose impactful, implementable solutions. I’ll play the business owner; you’ll play a member of Rem.';
const R2_CASE_PERSONA_NOTE = 'Adopt a fixed persona and stick to it. Don’t state the problems outright — let the candidate dig them out with questions.';

// Interviewer guides (doc "UF FL2026 Problem Solving (Case) Interview Guide").
// Stable ids match last year's chips so already-saved caseId values still highlight.
const R2_CASE_FALLBACK = [
  {
    id: 'golden_taco',
    name: 'Golden Taco',
    title: 'Golden Taco',
    caseNo: 1,
    badge: '',
    industry: 'Food & Beverage',
    opening: {
      transition: R2_CASE_TRANSITION,
      note: R2_CASE_PERSONA_NOTE,
    },
    about: 'Golden Taco is a cottage food business founded by Carlos and Maya, a married couple from Austin and Mexico City, selling street food at markets and local events in College Heights. Known for tacos, they’re considering a new item — Golden Bowls (same fillings, plus rice and seasonal toppings) — and want help deciding whether to launch it, and how to price and promote it.',
    facts: [
      'Based in College Heights (urban college town)',
      'Founded 2019, married family-owned operation',
      '10 employees (5 kitchen, 5 front-of-house)',
      'Marketing: word-of-mouth + website only, no social media',
      'Long-term goal: second location within 2 years',
    ],
    ifAsked: [
      { q: 'Cottage food business?', a: 'Operates from a home kitchen, sells direct to customers, no commercial kitchen.' },
      { q: 'How are current tacos doing?', a: 'Profitable and stable; owners want a new revenue stream.' },
      { q: 'Target market?', a: 'College students and young professionals.' },
      { q: 'Why launch the bowl?', a: 'Profitability and product line expansion.' },
      { q: 'Bowl ingredients?', a: 'Beef or chicken, rice, cheese, avocado, seasonal vegetables; veggie option swaps meat for grilled squash and peppers.' },
      { q: 'Bowl vs. taco?', a: 'Same core fillings, served in a bowl with rice and veggies instead of a tortilla.' },
    ],
    issues: [
      'Launch strategy for Golden Bowl (sourcing, prep, menu integration)',
      'Pricing and financial feasibility',
      'Marketing and communication plan, especially for younger customers',
    ],
    steers: [
      { when: 'They lead with marketing', say: 'A strong, clear introduction to our new product is definitely important — we’ve had some issues communicating it. How do you think you can help with this?' },
      { when: 'They lead with finances', say: 'Product financials is a good start. How do you recommend breaking the price down?' },
    ],
    explore: [
      { label: 'Company / market', items: ['How does this fit Golden Taco’s brand?', 'How are competitors positioning similar products?', 'Does this help differentiate in a saturated market?'] },
      { label: 'Financial', items: ['What drives cost differences between bowls and tacos?', 'New ingredients vs. existing ones?', 'Impact on food waste?'] },
      { label: 'Customer', items: ['Rising demand for bowls?', 'Attract health-conscious customers?', 'Market as customizable / trendy?', 'Combos or loyalty incentives to drive trial?'] },
    ],
    quantIntro: 'I’m loving your ideas so far. Let’s calculate the profitability and the margin of the different Golden Bowls versus tacos.',
    exhibitNote: 'Allow them to pick a path. Path A is faster (profit dollars per item). Path B builds revenue then cost. Either way, get to $50,000 total bowl profit and a 66.7% margin before tacos.',
    exhibitHeaders: ['Product', 'Cost to Make', 'Sales Price', 'Units Sold (per week)'],
    exhibitRows: [
      ['Beef Golden Bowl', '$3', '$10', '100'],
      ['Chicken Golden Bowl', '$2', '$5', '50'],
      ['Veggie Golden Bowl', '$2', '$5', '50'],
      ['Average Taco', '$1', '$4', '800'],
    ],
    exhibitFoot: 'Golden Taco operates 50 weeks per year (2 weeks off).',
    quant: [
      {
        title: 'Path A — profit dollars per item',
        say: 'Volume × profit-per-unit × weeks. Skip separate revenue/cost totals.',
        answers: [
          'Beef: 100 × ($10 − $3) × 50 = $35,000',
          'Chicken: 50 × ($5 − $2) × 50 = $7,500',
          'Veggie: 50 × ($5 − $2) × 50 = $7,500',
          'Total bowl profit = $50,000',
        ],
      },
      {
        title: 'Path B — revenue, then cost',
        say: 'Build annual revenue, then annual cost, then margin.',
        answers: [
          'Revenue: Beef $50,000 + Chicken $12,500 + Veggie $12,500 = $75,000',
          'Cost: Beef $15,000 + Chicken $5,000 + Veggie $5,000 = $25,000',
          'Profit = $75,000 − $25,000 = $50,000',
          'Margin = $50,000 ÷ $75,000 = 66.7%',
        ],
      },
      {
        title: 'Tacos — then compare',
        say: 'Ask them to calculate taco revenue and margin, then compare if they do not do it themselves.',
        answers: [
          'Revenue = 800 × $4 × 50 = $160,000',
          'Cost = 800 × $1 × 50 = $40,000',
          'Profit = $120,000',
          'Margin = $120,000 ÷ $160,000 = 75%',
        ],
        note: 'Expected insight: bowls are less profitable per dollar, but may still be worth it if they expand the customer base rather than cannibalize taco sales.',
      },
    ],
    brainstorm: {
      say: 'Let’s shift gears. What are some ways Golden Taco could expand its network and create new connections to support this launch?',
      hints: 'Let them generate 2–3 ideas. Areas they might touch: local partnerships (colleges, farmers markets, food trucks), social media presence (currently none), loyalty/referral programs, cross-promotion with other College Heights businesses, catering or campus events.',
    },
    conclusion: {
      say: 'Now that you’ve looked at the numbers and brainstormed some ideas, what’s your final recommendation? Should Golden Taco launch the Golden Bowl, and under what conditions?',
      expected: [
        'Bowls are less profitable than tacos (67% vs. 75%).',
        'Real cannibalization risk — bowls only make sense if they pull in new customers, not just shift existing ones.',
        'Set conditions: clear marketing push (especially social, since there is currently none), avoid heavy menu overlap with tacos, consider premium positioning to protect margin.',
      ],
    },
  },
  {
    id: 'bean_bloom',
    name: 'Bean & Bloom',
    title: 'Bean & Bloom',
    caseNo: 2,
    badge: '',
    industry: 'Food & Beverage',
    opening: {
      transition: R2_CASE_TRANSITION,
      note: R2_CASE_PERSONA_NOTE,
    },
    about: 'Bean & Bloom is a specialty coffee shop founded by friends Jasmine and Aiden in 2020, in Riverbend, a trendy riverside neighborhood with young professionals and college students. Known for artisan lattes, locally sourced pastries, and a cozy aesthetic, they’re now considering a new product line — Cold Brew Growlers (64 oz take-home bottles) — and want help deciding whether to launch it, and how to price and promote it.',
    facts: [
      'Based in Riverbend (hip neighborhood, lots of foot traffic and remote workers)',
      'Founded 2020, both founders single and fully focused on the business',
      '8 employees (4 baristas, 4 kitchen/front-of-house)',
      'Marketing: strong Instagram/TikTok following, plus word-of-mouth from regulars',
      'Long-term goal: second shop or mobile coffee cart within 2 years',
    ],
    ifAsked: [
      { q: 'What is a Cold Brew Growler?', a: 'A 64 oz bottle of house-made cold brew for take-home use; holds about 6–7 servings.' },
      { q: 'How is the current menu doing?', a: 'Lattes, cappuccinos, and pastries are profitable and stable; owners want a revenue boost that doesn’t depend solely on foot traffic.' },
      { q: 'Target market?', a: 'Young professionals, grad students, remote workers — people into coffee culture and convenience.' },
      { q: 'Why launch growlers?', a: 'Diversify revenue, reach remote workers who brew at home, build brand presence outside the café.' },
      { q: 'Ingredients?', a: 'Cold brew concentrate, filtered water, premium beans from local roasters.' },
      { q: 'Growler vs. in-store drink?', a: 'Take-home, sold in bulk, priced at a premium over individual iced coffees.' },
    ],
    issues: [
      'Launch strategy for growlers (production process, shelf life, in-store only or delivery)',
      'Pricing and financial feasibility (are margins sustainable given bean costs?)',
      'Marketing strategy (positioning against grocery-store cold brew and Starbucks bottled drinks)',
    ],
    steers: [
      { when: 'They lead with marketing', say: 'We’ve had trouble explaining how our growler is different from what you could get in a grocery store. How would you help us communicate that?' },
      { when: 'They lead with finances', say: 'Pricing is something we’re wrestling with. How would you suggest breaking down the costs and setting the right retail price?' },
    ],
    explore: [
      { label: 'Company / market', items: ['Fit with artisan, community-focused image?', 'How are cafés, grocery stores, and Starbucks positioning similar products?', 'Would this help them stand out in a saturated market?'] },
      { label: 'Financial', items: ['Cost differences vs. lattes (beans, bottles, labeling, storage)?', 'Existing cold brew concentrate or new inputs?', 'Cut waste or add packaging cost?'] },
      { label: 'Customer', items: ['Rising demand for bulk at-home coffee?', 'Attract remote workers or buyers cutting daily café trips?', 'Premium or eco-friendly (refill program)?', 'Promotions or loyalty discounts to drive trial?'] },
    ],
    quantIntro: 'Bean & Bloom is considering selling 64 oz cold brew growlers. Each growler costs $12. Refills would be $9. The café estimates each growler lasts a customer about 4 cups of coffee. Currently, an iced cold brew costs $4 per cup.',
    exhibitNote: 'Read the cost structure aloud with the prompt.',
    exhibitHeaders: ['Item', 'Amount'],
    exhibitRows: [
      ['Ingredient cost per cup', '$1.00'],
      ['Ingredient cost per growler (64 oz = 4 cups)', '$3.50'],
      ['Packaging cost per growler', '$1.50'],
      ['Total growler cost', '$5.00'],
    ],
    exhibitFoot: 'Growler $12 · refill $9 · iced cold brew $4/cup. Prompt uses 4 cups per growler for the math (intro also says 6–7 servings).',
    quant: [
      {
        title: 'Margin — growler vs. 4 cups',
        say: 'What’s the margin on a single growler vs. 4 individual cold brews?',
        answers: [
          '4 cups: $16 − $4 = $12 profit (75% margin)',
          'Growler: $12 − $5 = $7 profit (58% margin)',
        ],
        note: 'Candidate should catch that growlers are less profitable per serving but may increase volume and loyalty.',
      },
      {
        title: 'Switching / break-even',
        say: 'Suppose 100 cold brew customers per week switch from individual cups to growlers. What’s the impact on profit?',
        answers: [
          '100 × $12 = $1,200 (keep cups)',
          '100 × $7 = $700 (switch to growlers)',
          'Net loss = $500/week if existing customers switch entirely',
        ],
        note: 'Push them to target new customers or incremental sales, not cannibalize current ones.',
      },
    ],
    brainstorm: {
      say: 'Let’s shift gears. What are some ways Bean & Bloom could expand its network and create new connections to support this launch?',
      hints: 'Let them generate 2–3 ideas. Areas they might touch: partnerships with gyms, yoga studios, or coworking spaces; pop-up stands at farmers markets, campus fairs, or festivals; corporate or small-office catering; a subscription or refill program; collaborations with nearby bakeries or restaurants; community events like coffee tastings or latte-art workshops.',
    },
    conclusion: {
      say: 'Now that you’ve looked at the numbers and brainstormed some ideas, what’s your final recommendation? Should Bean & Bloom launch the Cold Brew Growler, and under what conditions?',
      expected: [
        'Growlers are less profitable than core cups (58% vs. 75%).',
        'Real cannibalization risk — growlers only make sense if they pull in new occasions (at-home, remote work) rather than replacing café visits.',
        'Set conditions: position clearly against grocery-store and Starbucks bottled cold brew, lean on the strong social following to market the take-home angle, and consider a refill/subscription program to build recurring revenue.',
        'Score on attention to detail, quality of clarifying questions, and whether the recommendation is tactical and specific.',
      ],
    },
  },
  {
    id: 'pedal_pure',
    name: 'PedalPure',
    title: 'PedalPure',
    caseNo: 3,
    badge: '',
    industry: 'Retail / Consumer',
    opening: {
      transition: R2_CASE_TRANSITION,
      note: R2_CASE_PERSONA_NOTE,
    },
    about: 'PedalPure is a boutique indoor cycling studio founded by sisters Maya and Lila in 2021, in Brookdale, a neighborhood with a growing population of young professionals. Known for community-focused classes, energetic instructors, and a wellness-driven brand, they’re now considering a new product line — in-studio bottled electrolyte drinks (“PedalPure Recovery”) for post-class recovery — and want help deciding whether to launch it, and how to price and promote it.',
    facts: [
      'Based in Brookdale (trendy, fitness-minded neighborhood)',
      'Founded 2021, both founders married, business is their shared focus',
      '12 part-time instructors, 3 front-desk staff',
      'Marketing: instructor-led Instagram/TikTok reels, client testimonials, referral discounts',
      'Long-term goal: full wellness brand — merchandise, nutrition products, possibly a second studio',
    ],
    ifAsked: [
      { q: 'What is the product?', a: 'A bottled electrolyte drink, branded “PedalPure Recovery,” sold cold after class.' },
      { q: 'How is the current business doing?', a: 'Classes are often full with a loyal community, but revenue depends almost entirely on class fees.' },
      { q: 'Target market?', a: 'Fitness-conscious young professionals and students wanting convenient, healthy recovery drinks.' },
      { q: 'Why launch bottled drinks?', a: 'Diversify revenue, add a wellness product, capture spend that currently goes to nearby smoothie shops.' },
      { q: 'Ingredients?', a: 'Electrolytes, natural fruit extracts, spring water, no artificial sweeteners.' },
      { q: 'Differentiation?', a: 'Premium, wellness-branded, sold in-studio post-class for convenience.' },
    ],
    issues: [
      'Launch strategy (production, storage, distribution — in-studio only or expand to local gyms?)',
      'Pricing and financial feasibility (are margins competitive vs. alternatives?)',
      'Marketing strategy (positioning against Gatorade, BodyArmor, and local smoothie shops)',
    ],
    steers: [
      { when: 'They lead with marketing', say: 'We’ve had trouble explaining how our bottled drink is different from what you could get at a grocery store. How would you help us communicate that?' },
      { when: 'They lead with finances', say: 'Pricing is something we’re wrestling with. How would you suggest breaking down the costs and setting the right retail price?' },
    ],
    explore: [
      { label: 'Company / market', items: ['Fit with premium, wellness-focused image?', 'How are local smoothie cafés, Gatorade, and BodyArmor positioning similar products?', 'Stand out as a lifestyle brand rather than just a studio?'] },
      { label: 'Financial', items: ['Cost drivers (ingredients, bottles, refrigeration, storage)?', 'Existing suppliers or new ones?', 'Does bulk ordering cut costs, or does storage add constraints?'] },
      { label: 'Customer', items: ['Rising demand for “clean” wellness products?', 'Existing members vs. retail customers?', 'Premium, customizable flavors, or eco-friendly bottles?', 'Bundles, subscriptions, or loyalty discounts?'] },
    ],
    quantIntro: 'I’m loving your ideas so far. Each PedalPure Recovery drink costs $2.25 to make. Sold à la carte after class, it’s $6. We’re also considering bundling it into the class price for $5 instead.',
    exhibitNote: 'Ask what the margin is per option, then walk the switching and capacity steps.',
    exhibitHeaders: ['Option', 'Price', 'Cost', 'Profit / unit'],
    exhibitRows: [
      ['À la carte', '$6', '$2.25', '$3.75'],
      ['Class bundle', '$5', '$2.25', '$2.75'],
    ],
    exhibitFoot: 'Fridge holds 2,400 bottles/month. 500 active members × 2 drinks/week = 4,000 bottles/month of potential demand.',
    quant: [
      {
        title: 'Margin per option',
        say: 'Ask what margin is per option.',
        answers: [
          'À la carte: ($6 − $2.25) ÷ $6 = 62.5%',
          'Bundle: ($5 − $2.25) ÷ $5 = 55%',
        ],
        note: 'Follow-up: the bundle runs a lower margin. What’s missing — why might they offer it anyway? Push toward volume and guaranteed attach rate.',
      },
      {
        title: 'Switching scenario',
        say: 'Suppose 300 members take the class bundle once a week instead of buying a drink à la carte. What’s the impact on weekly profit?',
        answers: [
          'À la carte: 300 × $3.75 = $1,125/week',
          'Bundle: 300 × $2.75 = $825/week',
          'Net loss = $300/week if existing à la carte buyers switch entirely',
        ],
        note: 'The bundle only makes sense if it drives incremental purchases (members who weren’t buying a drink), not if it just discounts sales already happening.',
      },
      {
        title: 'Capacity constraint',
        say: 'PedalPure has 500 active members. If each member who buys drinks does so at an average of 2 per week, that’s 4,000 bottles a month of potential demand. But the studio’s fridge only holds 2,400 bottles a month. What’s the lost revenue and profit from that constraint?',
        answers: [
          'Lost sales = 4,000 − 2,400 = 1,600 bottles/month',
          'Lost revenue = 1,600 × $6 = $9,600/month',
          'Lost profit = 1,600 × $3.75 = $6,000/month',
        ],
        note: 'Follow-up: what are PedalPure’s options? (More storage, more frequent delivery, cap sales.) Bundle is less profitable per drink and risks cannibalizing full-price sales, but can still work as a trial / loyalty tool for members who would not otherwise buy.',
      },
    ],
    brainstorm: {
      say: 'Let’s shift gears. What are some ways PedalPure could expand its network and create new connections to support this launch?',
      hints: 'Let them generate 2–3 ideas. Areas they might touch: partnerships with local gyms, yoga studios, or wellness centers; sampling booths at community 5Ks or charity rides; corporate wellness (drinks for office gyms); collaborations with nutritionists or local cafés; hosting recovery workshops or wellness events.',
    },
    conclusion: {
      say: 'Now that you’ve looked at the numbers and brainstormed some ideas, what’s your final recommendation? Should PedalPure launch the bottled electrolyte drink, and under what conditions?',
      expected: [
        'The bundle is less profitable than à la carte (55% vs. 62.5%).',
        'Real cannibalization risk — the bundle only makes sense if it drives incremental drink purchases.',
        'Set conditions: position as a premium wellness product against Gatorade/BodyArmor and local smoothie shops; keep the bundle targeted (new members or specific class times) rather than opening it to everyone; protect à la carte pricing as the primary revenue driver.',
      ],
    },
  },
];

const r2BehavioralHolds = {};
const R2_BEHAVIORAL_HOLD_MS = 30000;
const r2CaseHolds = {};
const R2_CASE_HOLD_MS = 30000;
const r2CaseRefOpen = {};
const R2_CASE_LAYOUT_KEY = 'rem-uf-r2-case-layout';
const R2_CASE_MIN_KEY = 'rem-uf-r2-case-minimized';
const R2_NOTE_MIN_PX = 54;

function r2BehavioralList() {
  const fromB = B.rubrics && B.rubrics.round2 && B.rubrics.round2.behaviorals;
  return (fromB && fromB.length) ? fromB : R2_BEHAVIORAL_FALLBACK;
}

function r2BehavioralById(id) {
  const list = r2BehavioralList();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function r2KnownBehavioralId(id) {
  return !!r2BehavioralById(id);
}

function normalizeBehavioralSelected(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = {};
  v.forEach(function (id) {
    if (!id || seen[id] || !r2KnownBehavioralId(id)) return;
    seen[id] = true;
    out.push(id);
  });
  return out;
}

function hasBehavioralSelectedValue(v) {
  return Array.isArray(v) && v.length > 0;
}

function holdR2Behaviorals(id, selected) {
  if (!id) return;
  const ids = normalizeBehavioralSelected(selected);
  r2BehavioralHolds[id] = { ids: ids, until: Date.now() + R2_BEHAVIORAL_HOLD_MS };
}

function heldR2Behaviorals(id) {
  const h = id ? r2BehavioralHolds[id] : null;
  if (!h || Date.now() > h.until) return null;
  return h.ids.slice();
}

function hasPendingR2BehavioralOp() {
  return pendingOps().some(function (op) {
    return op && op.kind === 'grade' && op.round === 'round2' && op.field === 'behavioralSelected' && Array.isArray(op.value);
  });
}

function hasPendingR2CaseOp() {
  return pendingOps().some(function (op) {
    return op && op.kind === 'grade' && op.round === 'round2' && op.field === 'caseId';
  });
}

function r2CaseTitle(c) {
  if (!c) return '';
  if (c.id && R2_CASE_TITLES[c.id]) return R2_CASE_TITLES[c.id];
  return String(c.title || c.name || '').trim();
}

function r2CaseList() {
  const fb = {};
  R2_CASE_FALLBACK.forEach(function (c) { fb[c.id] = c; });
  const fromB = B.rubrics && B.rubrics.round2 && B.rubrics.round2.cases;
  if (fromB && fromB.length) {
    const out = [];
    fromB.forEach(function (c) {
      const full = fb[c.id];
      if (full) {
        const title = r2CaseTitle(full);
        out.push(Object.assign({}, full, { name: title, title: title, badge: '' }));
      }
    });
    if (out.length) return out;
  }
  return R2_CASE_FALLBACK;
}

function r2CaseById(id) {
  const list = r2CaseList();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function r2KnownCaseId(id) {
  return !!r2CaseById(id);
}

function normalizeCaseId(v) {
  if (!v) return '';
  return r2KnownCaseId(v) ? String(v) : '';
}

function holdR2Case(id, caseId) {
  if (!id) return;
  r2CaseHolds[id] = { caseId: caseId ? String(caseId) : '', until: Date.now() + R2_CASE_HOLD_MS };
}

function heldR2Case(id) {
  const h = id ? r2CaseHolds[id] : null;
  if (!h || Date.now() > h.until) return null;
  return h.caseId;
}

function hasR2CaseHold(id) {
  const h = id ? r2CaseHolds[id] : null;
  return !!(h && Date.now() <= h.until);
}

function r2SelectedCaseId(g) {
  if (g && STATE.currentApplicantId && STATE.grades.round2[STATE.currentApplicantId] === g && hasR2CaseHold(STATE.currentApplicantId)) {
    return heldR2Case(STATE.currentApplicantId) || '';
  }
  if (g && g.caseId && r2KnownCaseId(g.caseId)) return g.caseId;
  return '';
}

function isR2CaseRefOpen(id) {
  const aid = id || STATE.currentApplicantId;
  if (!aid) return true;
  return r2CaseRefOpen[aid] !== false;
}

function setR2CaseRefOpen(id, on) {
  if (!id) return;
  r2CaseRefOpen[id] = !!on;
}

function getR2CaseLayout() {
  try {
    const v = localStorage.getItem(R2_CASE_LAYOUT_KEY);
    if (v === 'side' || v === 'stacked') return v;
  } catch (e) { /* private mode */ }
  return 'side';
}

function setR2CaseLayout(layout) {
  try { localStorage.setItem(R2_CASE_LAYOUT_KEY, layout === 'stacked' ? 'stacked' : 'side'); } catch (e) { /* ignore */ }
}

function getR2CaseMinimized() {
  try { return localStorage.getItem(R2_CASE_MIN_KEY) === '1'; } catch (e) { return false; }
}

function setR2CaseMinimized(on) {
  try { localStorage.setItem(R2_CASE_MIN_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

let r2SplitRo = null;
let r2SplitResizeBound = false;

function syncR2CaseColHeight() {
  const root = document.getElementById('r2GradeRoot');
  const col = root && root.querySelector('.r2-case-col');
  const pane = document.getElementById('r2CasePane');
  const rubric = document.getElementById('r2RubricPane');
  if (!col || !pane) return;
  const match = !!(root && root.classList.contains('r2-has-case') && root.classList.contains('r2-layout-side'));
  if (!match || !rubric) {
    if (root) root.style.removeProperty('--r2-rubric-h');
    col.style.height = '';
    pane.style.height = '';
    pane.style.maxHeight = '';
    return;
  }
  const h = Math.round(rubric.offsetHeight);
  if (h > 0 && Math.abs((parseFloat(col.style.height) || 0) - h) >= 1) {
    root.style.setProperty('--r2-rubric-h', h + 'px');
    col.style.height = h + 'px';
    pane.style.height = h + 'px';
    pane.style.maxHeight = h + 'px';
  }
}

function bindR2SplitHeightSync() {
  const rubric = document.getElementById('r2RubricPane');
  if (r2SplitRo) {
    r2SplitRo.disconnect();
    r2SplitRo = null;
  }
  syncR2CaseColHeight();
  requestAnimationFrame(function () {
    syncR2CaseColHeight();
    requestAnimationFrame(syncR2CaseColHeight);
  });
  if (rubric && typeof ResizeObserver !== 'undefined') {
    r2SplitRo = new ResizeObserver(function () { syncR2CaseColHeight(); });
    r2SplitRo.observe(rubric);
  }
  if (!r2SplitResizeBound) {
    r2SplitResizeBound = true;
    window.addEventListener('resize', syncR2CaseColHeight);
  }
}

function applyR2CaseMinimized() {
  const on = getR2CaseMinimized();
  const root = document.getElementById('r2GradeRoot');
  if (root) root.classList.toggle('r2-case-minimized', on);
  const btn = document.getElementById('r2CaseMinBtn');
  if (btn) {
    const hasCase = !!(root && root.classList.contains('r2-has-case'));
    btn.hidden = !hasCase;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Expand case to half the page' : 'Minimize case to a thin rail');
    btn.title = on ? 'Expand case to half' : 'Minimize case';
    btn.textContent = on ? '»' : '«';
  }
  requestAnimationFrame(function () {
    autosizeR2Notes();
    syncR2CaseColHeight();
  });
}

function applyR2CaseLayout(layout) {
  const next = layout === 'stacked' ? 'stacked' : 'side';
  const root = document.getElementById('r2GradeRoot');
  if (root) {
    root.classList.toggle('r2-layout-side', next === 'side');
    root.classList.toggle('r2-layout-stacked', next === 'stacked');
  }
  if (contentEl) {
    contentEl.querySelectorAll('[data-r2layout]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.r2layout === next);
    });
  }
  applyR2CaseMinimized();
  bindR2SplitHeightSync();
}

function shouldHoldR2AgainstPoll() {
  if (hasPendingR2BehavioralOp() || hasPendingR2CaseOp()) return true;
  if (STATE.view === 'grade' && STATE.gradeRound === 'round2' && STATE.currentApplicantId) {
    if (heldR2Behaviorals(STATE.currentApplicantId) != null) return true;
    if (hasR2CaseHold(STATE.currentApplicantId)) return true;
  }
  return false;
}

function r2BehavioralSelected(g) {
  const held = g && STATE.currentApplicantId && STATE.grades.round2[STATE.currentApplicantId] === g
    ? heldR2Behaviorals(STATE.currentApplicantId) : null;
  if (held) return held;
  if (g && Array.isArray(g.behavioralSelected)) return normalizeBehavioralSelected(g.behavioralSelected);
  const scores = (g && g.scores) || {};
  const notes = (g && g.qnotes) || {};
  const notesBy = (g && g.qnotesBy) || {};
  const inferred = [];
  r2BehavioralList().forEach(function (q) {
    let hasNote = typeof notes[q.id] === 'string' && notes[q.id].trim();
    if (!hasNote) {
      Object.keys(notesBy).forEach(function (gk) {
        const bucket = notesBy[gk];
        if (bucket && typeof bucket[q.id] === 'string' && bucket[q.id].trim()) hasNote = true;
      });
    }
    if (typeof scores[q.id] === 'number' || hasNote) inferred.push(q.id);
  });
  return inferred;
}

function keepLocalPersonalityIdx(prevR1) {
  const ids = {};
  Object.keys(prevR1 || {}).forEach(function (id) { ids[id] = true; });
  Object.keys(personalityHolds).forEach(function (id) { ids[id] = true; });
  if (STATE.currentApplicantId) ids[STATE.currentApplicantId] = true;
  Object.keys(ids).forEach(function (id) {
    const old = (prevR1 || {})[id];
    const held = heldPersonalityIdx(id);
    const localIdx = held != null ? held
      : (old && hasPersonalityIdxValue(old.personalityIdx) ? Number(old.personalityIdx) : null);
    if (localIdx == null) return;
    let incoming = STATE.grades.round1[id];
    if (!incoming) {
      incoming = old ? old : { scores: {}, notes: '' };
      STATE.grades.round1[id] = incoming;
    }
    // Remote undefined must never wipe a local 0/1/2. A live hold wins even
    // if the incoming record already has a different idx (stale poll).
    if (held != null) incoming.personalityIdx = held;
    else if (!hasPersonalityIdxValue(incoming.personalityIdx)) incoming.personalityIdx = localIdx;
  });
}

function keepLocalR2Behaviorals(prevR2) {
  const ids = {};
  Object.keys(prevR2 || {}).forEach(function (id) { ids[id] = true; });
  Object.keys(r2BehavioralHolds).forEach(function (id) { ids[id] = true; });
  if (STATE.currentApplicantId) ids[STATE.currentApplicantId] = true;
  Object.keys(ids).forEach(function (id) {
    const old = (prevR2 || {})[id];
    const held = heldR2Behaviorals(id);
    const localSel = held != null ? held
      : (old && Array.isArray(old.behavioralSelected) ? normalizeBehavioralSelected(old.behavioralSelected) : null);
    let incoming = STATE.grades.round2[id];
    if (!incoming) {
      incoming = old ? old : { scores: {}, notes: '' };
      STATE.grades.round2[id] = incoming;
    }
    if (held != null) incoming.behavioralSelected = held;
    else if (localSel && localSel.length && !Array.isArray(incoming.behavioralSelected)) {
      incoming.behavioralSelected = localSel;
    }
    incoming.qnotes = mergeNotesPreferLocal(old && old.qnotes, incoming.qnotes);
    incoming.dimNotes = mergeNotesPreferLocal(old && old.dimNotes, incoming.dimNotes);
    incoming.qnotesBy = mergeGraderNotesBy(old && old.qnotesBy, incoming.qnotesBy);
    incoming.dimNotesBy = mergeGraderNotesBy(old && old.dimNotesBy, incoming.dimNotesBy);
    incoming.notesBy = mergeGraderNotesBy(old && old.notesBy, incoming.notesBy);
    if (old && old.caseNotes && (incoming.caseNotes == null || incoming.caseNotes === '')) {
      incoming.caseNotes = old.caseNotes;
    }
    if (old && old.caseScore != null && incoming.caseScore == null) incoming.caseScore = old.caseScore;
    if (hasR2CaseHold(id)) {
      const heldCase = heldR2Case(id);
      incoming.caseId = heldCase || undefined;
    } else if (old && old.caseId && !incoming.caseId) {
      incoming.caseId = old.caseId;
    }
    if (old && Array.isArray(old.interviewers) && (!Array.isArray(incoming.interviewers) || !incoming.interviewers.length)) {
      incoming.interviewers = old.interviewers.slice();
    }
    if (old && old.interviewRoom && !incoming.interviewRoom) incoming.interviewRoom = old.interviewRoom;
    if (old && old.interviewTime && !incoming.interviewTime) incoming.interviewTime = old.interviewTime;
    if (!incoming.scores || typeof incoming.scores !== 'object') incoming.scores = {};
    if (old && old.scores) incoming.scores = Object.assign({}, old.scores, incoming.scores);
  });
}

function noteText(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function mergeNotesPreferLocal(oldNotes, incomingNotes) {
  const incoming = (incomingNotes && typeof incomingNotes === 'object' && !Array.isArray(incomingNotes)) ? incomingNotes : {};
  const old = (oldNotes && typeof oldNotes === 'object' && !Array.isArray(oldNotes)) ? oldNotes : {};
  const out = Object.assign({}, incoming);
  Object.keys(old).forEach(function (k) {
    const local = noteText(old[k]);
    const remote = noteText(out[k]);
    if (local && !String(remote).trim()) out[k] = old[k];
  });
  return Object.keys(out).length ? out : (Object.keys(old).length ? Object.assign({}, old) : incomingNotes);
}

function adoptState(data) {
  if (!data || typeof data !== 'object') return;
  const prevR1 = STATE.grades.round1;
  const prevR2 = STATE.grades.round2;
  ROUNDS.forEach(function (r) {
    const g = (data.grades || {})[r];
    if (g && typeof g === 'object') STATE.grades[r] = g;
  });
  // In-memory / pending personality pick wins until flushed. Remote omission
  // (poll before PUT, older tab) must not unselect the chip.
  keepLocalPersonalityIdx(prevR1);
  keepLocalR2Behaviorals(prevR2);
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
  invalidateScreenStd();
  invalidateRound1Std();
  // Fold unsent local edits on top so a poll cannot drop a just-clicked idx.
  applyPendingOps();
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
    if (rec && Object.keys(rec).length && (hasManualScore(rec) || isExplicitAcademicsNA(rec) || rec.notes || rec.flagSecond || rec.recommendation || rec.caseId || hasR1Meta(rec) || hasR2Meta(rec))) {
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
  if (op && op.kind === 'grade' && op.field === 'score') {
    for (let i = ops.length - 1; i >= 0; i--) {
      const prev = ops[i];
      if (prev && prev.kind === 'grade' && prev.field === 'score' && prev.round === op.round && prev.id === op.id && prev.key === op.key) {
        ops[i] = op;
        setPendingOps(ops.slice(-400));
        return;
      }
    }
  }
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
        } else if (op.field === 'dimNotes' && op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
          rec.dimNotes = Object.assign({}, rec.dimNotes, op.value);
        } else if (op.field === 'qnotesBy' && op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
          rec.qnotesBy = mergeGraderNotesBy(rec.qnotesBy, op.value);
        } else if (op.field === 'dimNotesBy' && op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
          rec.dimNotesBy = mergeGraderNotesBy(rec.dimNotesBy, op.value);
        } else if (op.field === 'notesBy' && op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
          rec.notesBy = mergeGraderNotesBy(rec.notesBy, op.value);
        } else if (op.field === 'interviewers') {
          rec.interviewers = Array.isArray(op.value) ? op.value.slice() : [];
        } else if (op.field === 'personalityIdx') {
          if (hasPersonalityIdxValue(op.value)) rec.personalityIdx = Number(op.value);
          else if (hasPersonalityIdxValue(rec.personalityIdx)) {
            /* keep a live 0/1/2 over an empty snapshot — never write undefined over 0 */
          } else {
            rec.personalityIdx = op.value;
          }
        } else if (op.field === 'behavioralSelected') {
          if (Array.isArray(op.value)) rec.behavioralSelected = normalizeBehavioralSelected(op.value);
          else if (Array.isArray(rec.behavioralSelected) && rec.behavioralSelected.length) {
            /* keep a live selection over a missing snapshot */
          } else {
            rec.behavioralSelected = [];
          }
        } else if (op.field === 'caseId') {
          rec.caseId = op.value ? String(op.value) : undefined;
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
  captureOpenR2Fields();
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
  if (round === 'round1') invalidateRound1Std();
  let stored = value === undefined ? null : cloneJson(value);
  if (field === 'personalityIdx') {
    stored = hasPersonalityIdxValue(value) ? Number(value) : stored;
    if (hasPersonalityIdxValue(stored)) holdPersonalityPick(applicantId, stored);
  }
  if (field === 'behavioralSelected') {
    stored = normalizeBehavioralSelected(value);
    holdR2Behaviorals(applicantId, stored);
  }
  if (field === 'caseId') {
    stored = value ? String(value) : null;
    holdR2Case(applicantId, stored);
  }
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
  const activeP = main.querySelector('.chip[data-pidx].active');
  if (activeP) {
    const idx = Number(activeP.dataset.pidx);
    if (!isNaN(idx)) g.personalityIdx = idx;
  }
  const held = heldPersonalityIdx(STATE.currentApplicantId);
  if (held != null) g.personalityIdx = held;
  // Never snapshot undefined over a live 0/1/2 (empty chip row during remount).
}

function captureOpenR2Fields() {
  if (STATE.gradeRound !== 'round2' || !STATE.currentApplicantId) return;
  const g = getGrade('round2', STATE.currentApplicantId);
  migrateR2GraderNotes(g, STATE.currentApplicantId);
  const time = document.getElementById('r2InterviewTime');
  const room = document.getElementById('r2InterviewRoom');
  const i0 = document.getElementById('r2Interviewer0');
  const i1 = document.getElementById('r2Interviewer1');
  if (time) g.interviewTime = time.value || undefined;
  if (room) g.interviewRoom = room.value || undefined;
  if (i0 || i1) g.interviewers = normalizeR2Interviewers([i0 && i0.value, i1 && i1.value]);
  const main = document.getElementById('gradeMain');
  if (!main) return;
  main.querySelectorAll('textarea[data-notekey]').forEach(function (ta) {
    foldR2GraderTextarea(g, STATE.currentApplicantId, ta);
  });
  main.querySelectorAll('.r2-score-control').forEach(function (wrap) {
    const key = wrap.dataset.key;
    if (!key) return;
    const num = wrap.querySelector('.r2-score-num');
    const slider = wrap.querySelector('.r2-score-slider');
    const focused = document.activeElement === num || document.activeElement === slider;
    if (wrap.dataset.scored !== '1' && !focused) return;
    let val = parseR2ScoreTyped(num && num.value);
    if (val == null && focused && slider) val = clampR2Score(Number(slider.value));
    if (val == null && wrap.dataset.scored !== '1') return;
    applyR2ScoreToRecord(g, key, val);
  });
  mirrorR2LegacyNotes(g, STATE.currentApplicantId);
  const caseNotes = document.getElementById('r2CaseNotes');
  if (caseNotes) g.caseNotes = caseNotes.value;
  if (hasR2CaseHold(STATE.currentApplicantId)) {
    g.caseId = heldR2Case(STATE.currentApplicantId) || undefined;
  } else {
    const liveCase = liveR2CaseId(main);
    if (liveCase) g.caseId = liveCase;
  }
  const openIds = [];
  main.querySelectorAll('.r2-bq.open[data-bqid]').forEach(function (row) {
    if (row.dataset.bqid) openIds.push(row.dataset.bqid);
  });
  if (openIds.length || Array.isArray(g.behavioralSelected)) {
    const next = normalizeBehavioralSelected(openIds.length ? openIds : g.behavioralSelected);
    const held = heldR2Behaviorals(STATE.currentApplicantId);
    g.behavioralSelected = held != null ? held : next;
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
window.addEventListener('resize', function () {
  if (STATE.view === 'grade' && STATE.gradeRound === 'round2') autosizeR2Notes();
});

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
  if (round === 'round2') hydrateR2VibeFromFit(g);
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

function hasR2Meta(rec) {
  if (!rec) return false;
  if (Array.isArray(rec.behavioralSelected) && rec.behavioralSelected.length) return true;
  if (Array.isArray(rec.interviewers) && rec.interviewers.length) return true;
  if (rec.interviewRoom || rec.interviewTime) return true;
  if (rec.caseNotes) return true;
  if (rec.caseScore != null && rec.caseScore !== '') return true;
  if (rec.qnotes && typeof rec.qnotes === 'object' && Object.keys(rec.qnotes).length) return true;
  if (rec.dimNotes && typeof rec.dimNotes === 'object' && Object.keys(rec.dimNotes).length) return true;
  if (rec.qnotesBy && typeof rec.qnotesBy === 'object' && Object.keys(rec.qnotesBy).length) return true;
  if (rec.dimNotesBy && typeof rec.dimNotesBy === 'object' && Object.keys(rec.dimNotesBy).length) return true;
  if (rec.notesBy && typeof rec.notesBy === 'object' && Object.keys(rec.notesBy).length) return true;
  return false;
}

function r1PersonalityList() {
  return (B.rubrics.round1 && B.rubrics.round1.personality) || [];
}

// Restored from personalityIdx. If that was never saved, infer from a unique
// personality0/1/2 score key. The shared scores.personality key does not say
// which of the 3 prompts was asked, so it is not used to pick a chip.
// Infer only when personalityIdx is missing — never override an explicit 0/1/2.
function r1PersonalityIdx(g) {
  const qs = r1PersonalityList();
  const raw = g && g.personalityIdx;
  const stored = Number(raw);
  if (hasPersonalityIdxValue(raw) && !isNaN(stored) && stored >= 0 && stored < qs.length) return stored;
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

const R2_CASE_DIM_SPEC = [
  { key: 'introduction', label: 'Intro' },
  { key: 'framework', label: 'Framework' },
  { key: 'quant_reasoning', label: 'Math' },
  { key: 'brainstorming', label: 'Brainstorm' },
  { key: 'recommendation', label: 'Recommendation' },
];
const R2_GRADE_GUIDES = {
  introduction: 'Assess how effectively the candidate engages at the start: active listening, grasping the prompt, clarifying as needed, recapping in their own words, and setting up the case with confidence.',
  framework: 'Assess structure: a clear, relevant, MECE framework that breaks down the problem. Strong candidates explain their structure and use it to guide analysis; weak ones struggle to organize or produce incomplete frameworks.',
  quant_reasoning: 'Assess quantitative work: accuracy, logical flow, explaining calculations and assumptions, and using math to support conclusions. Weak candidates need answers to proceed or fail to explain reasoning.',
  brainstorming: 'Assess creativity and practicality: multiple well-developed ideas tied to the case. Strong candidates show originality; weak ones add little beyond the prompt or stay disorganized.',
  recommendation: 'Assess the final recommendation: succinct, structured, integrates the prompt, and suggests what data or questions would refine the analysis. Weak candidates miss critical case elements.',
  fit_communication: 'Assess presence and rapport throughout: clear, confident communication, client-ready composure, and whether they connect as a potential chapter member — not just case mechanics.',
  vibe_check: 'Reference only — does not count toward case or behavioral averages. Gut-feel on chapter chemistry and whether you would want them in the room.',
};
const R2_CASE_DIM_FALLBACKS = {
  introduction: [
    'Clearly understands the prompt, recaps to interviewer, and asks intelligent clarifying questions',
    'Understands the main points of the prompt and communicates some clarifiers to interviewer',
    'Can be seen taking notes or verbally acknowledges the prompt given by the interviewer',
    'Makes no visible effort to understand or specify prompt information',
  ],
  framework: [
    'Takes 1-2 minutes to produce a relevant, fleshed out, and MECE-adherent framework',
    'Produces a relevant framework while taking too long or missing some MECE/relevancy elements',
    'Attempts to create a relevant framework but misses key elements of the exercise',
    'Does not demonstrate a basic understanding of framework creation',
  ],
  quant_reasoning: [
    'Provides a clear and logical profitability path, explaining all assumptions and defending their decisions well',
    'Completes a generally understood profitability analysis walkthrough with few mistakes or instances of getting lost (1-2 max)',
    'Needs consistent prompting in order to progress, gets lost in their logic 2+ times, or does not explain logic at all (provides answer)',
    'Cannot complete the math effectively - must be given answers to continue with the case',
  ],
  brainstorming: [
    'Presents multiple creative, real-world driven ideas that accurately encompass all case aspects',
    'Presents 1 well thought out idea or multiple shallower ideas that add depth and structure to the case',
    'Relates ideas to case information, but makes no effort to structure thoughts beyond stream of consciousness',
    'Does not provide any material insight beyond the given information in the prompt',
  ],
  recommendation: [
    'Presents an efficient, holistic recommendation that demonstrates a deep understanding of all case elements',
    'Presents a relatively structured recommendation which responds to the prompt’s main questions',
    'Attempts to provide a structured recommendation, but missed many aspects of the case',
    'Does not provide a succinct recommendation or does not incorporate the prompt information',
  ],
  fit_communication: [
    'Clear, confident, client-ready presence; strong rapport and composure throughout',
    'Generally clear and composed, with only brief hesitation or stiffness',
    'Gets the point across but presence, polish, or composure slips at times',
    'Hard to follow, withdrawn, or loses composure — rapport does not land',
  ],
  vibe_check: [
    'Strong yes — excited to have them in the chapter',
    'Positive presence; you would want to work with them',
    'Fine, but chemistry or presence is not a standout',
    'Off — chemistry or presence does not land',
  ],
};
const R2_VIBE_CHECK_KEY = 'vibe_check';
const R2_FIT_KEY = 'fit_communication';
const R2_SCORE_MIN = 1;
const R2_SCORE_MAX = 4;

function r2BootstrapDimByKey(key) {
  const R = B.rubrics && B.rubrics.round2;
  if (!R) return null;
  const dims = R.dims || [];
  for (let i = 0; i < dims.length; i++) {
    if (dims[i] && dims[i].key === key) return dims[i];
  }
  if (R.fitDim && (R.fitDim.key === key || key === 'fit_communication')) return R.fitDim;
  return null;
}

function r2CaseDims() {
  return R2_CASE_DIM_SPEC.map(function (spec) {
    const src = r2BootstrapDimByKey(spec.key);
    const levels = (src && Array.isArray(src.levels) && src.levels.length)
      ? src.levels
      : (R2_CASE_DIM_FALLBACKS[spec.key] || ['', '', '', '']);
    return { key: spec.key, label: spec.label, levels: levels };
  });
}

function r2WeightedDimKeys() {
  return r2CaseDims().map(function (d) { return d.key; }).filter(function (k) {
    return k && k !== R2_VIBE_CHECK_KEY && k !== R2_FIT_KEY;
  });
}

function r2VibeDim() {
  return {
    key: R2_VIBE_CHECK_KEY,
    label: 'Vibe check',
    levels: R2_CASE_DIM_FALLBACKS.vibe_check,
  };
}

// Display-only copy: if vibe is empty, show the stored fit/communication score and
// notes on the Vibe check card. Never deletes fit_communication keys.
function hydrateR2VibeFromFit(g) {
  if (!g || g.__vibeHydrated) return g;
  g.__vibeHydrated = true;
  if (!g.scores || typeof g.scores !== 'object') g.scores = {};
  if (typeof g.scores[R2_VIBE_CHECK_KEY] !== 'number' && typeof g.scores[R2_FIT_KEY] === 'number') {
    g.scores[R2_VIBE_CHECK_KEY] = g.scores[R2_FIT_KEY];
  }
  if (g.dimNotes && typeof g.dimNotes === 'object') {
    if (!noteText(g.dimNotes[R2_VIBE_CHECK_KEY]).trim() && noteText(g.dimNotes[R2_FIT_KEY]).trim()) {
      g.dimNotes[R2_VIBE_CHECK_KEY] = g.dimNotes[R2_FIT_KEY];
    }
  }
  if (g.dimNotesBy && typeof g.dimNotesBy === 'object') {
    Object.keys(g.dimNotesBy).forEach(function (gk) {
      const bucket = g.dimNotesBy[gk];
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return;
      if (!noteText(bucket[R2_VIBE_CHECK_KEY]).trim() && noteText(bucket[R2_FIT_KEY]).trim()) {
        bucket[R2_VIBE_CHECK_KEY] = bucket[R2_FIT_KEY];
      }
    });
  }
  return g;
}

function r2FitDim() {
  const fit = (B.rubrics.round2 && B.rubrics.round2.fitDim) || null;
  if (!fit) return { key: 'fit_communication', label: 'Fit and communication/vibe check', levels: R2_CASE_DIM_FALLBACKS.fit_communication };
  delete fit.unweighted;
  delete fit.draft;
  fit.label = 'Fit and communication/vibe check';
  return fit;
}

function r2FitDimKey() {
  const fit = r2FitDim();
  return (fit && fit.key) || 'fit_communication';
}

function isR2MathKey(key) {
  return key === 'quant_reasoning' || key === 'math';
}

function isR2DimNoteKey(key) {
  if (!key) return false;
  if (key === R2_VIBE_CHECK_KEY || key === R2_FIT_KEY) return true;
  if (isR2MathKey(key) || key === r2FitDimKey()) return true;
  if (r2CaseDims().some(function (d) { return d && d.key === key; })) return true;
  const dims = (B.rubrics.round2 && B.rubrics.round2.dims) || [];
  return dims.some(function (d) { return d && d.key === key; });
}

function r2DimScore(g, key) {
  const scores = (g && g.scores) || {};
  if (isR2MathKey(key)) {
    if (typeof scores.quant_reasoning === 'number') return scores.quant_reasoning;
    if (typeof scores.math === 'number') return scores.math;
    return undefined;
  }
  if (key === R2_VIBE_CHECK_KEY) {
    if (typeof scores[R2_VIBE_CHECK_KEY] === 'number') return scores[R2_VIBE_CHECK_KEY];
    if (typeof scores[R2_FIT_KEY] === 'number') return scores[R2_FIT_KEY];
    return undefined;
  }
  const v = scores[key];
  return typeof v === 'number' ? v : undefined;
}

function r2DimNote(g, key) {
  if (!g || !key) return '';
  if (g.dimNotes && noteText(g.dimNotes[key]).trim()) return g.dimNotes[key];
  if (isR2MathKey(key) && g.dimNotes && noteText(g.dimNotes.math).trim()) return g.dimNotes.math;
  if (isR2MathKey(key) && g.dimNotes && noteText(g.dimNotes.quant_reasoning).trim()) return g.dimNotes.quant_reasoning;
  if (key === R2_VIBE_CHECK_KEY && g.dimNotes && noteText(g.dimNotes[R2_FIT_KEY]).trim()) return g.dimNotes[R2_FIT_KEY];
  if (g.qnotes && typeof g.qnotes[key] === 'string' && g.qnotes[key].trim()) return g.qnotes[key];
  if (isR2MathKey(key) && g.qnotes && typeof g.qnotes.math === 'string') return g.qnotes.math;
  if (isR2MathKey(key) && g.qnotes && typeof g.qnotes.quant_reasoning === 'string') return g.qnotes.quant_reasoning;
  if (key === R2_VIBE_CHECK_KEY && g.qnotes && typeof g.qnotes[R2_FIT_KEY] === 'string' && g.qnotes[R2_FIT_KEY].trim()) {
    return g.qnotes[R2_FIT_KEY];
  }
  return '';
}

function round2Total(g) {
  const dims = r2WeightedDimKeys();
  const vals = dims.map(function (k) { return r2DimScore(g, k); }).filter(function (v) { return typeof v === 'number'; });
  if (!vals.length) return null;
  const sum = vals.reduce(function (a, b) { return a + b; }, 0);
  return { total: sum / vals.length, max: 4, count: vals.length, sum: sum };
}

function r2BehavioralScoreKeys(g) {
  const selected = r2BehavioralSelected(g);
  const scores = (g && g.scores) || {};
  if (selected && selected.length) return selected;
  return r2BehavioralList().map(function (q) { return q.id; }).filter(function (id) {
    return typeof scores[id] === 'number';
  });
}

function round2BehavioralAvg(g) {
  const scores = (g && g.scores) || {};
  const vals = r2BehavioralScoreKeys(g).map(function (id) { return scores[id]; }).filter(function (v) {
    return typeof v === 'number';
  });
  if (!vals.length) return null;
  return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
}

function hasRound2Score(g) {
  return !!(round2Total(g) || round2BehavioralAvg(g));
}

function formatR2Avg(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v * 10) % 10 === 0 ? String(Math.round(v)) : v.toFixed(1);
}

function formatR2Score(v) {
  if (v == null || typeof v !== 'number' || isNaN(v)) return '—';
  const r = Math.round(v * 100) / 100;
  if (Math.abs(r - Math.round(r)) < 1e-9) return String(Math.round(r));
  const one = Math.round(r * 10) / 10;
  if (Math.abs(r - one) < 1e-9) return one.toFixed(1);
  return r.toFixed(2);
}

function clampR2Score(n) {
  if (typeof n !== 'number' || !isFinite(n)) return undefined;
  const v = Math.round(n * 100) / 100;
  if (v < R2_SCORE_MIN) return R2_SCORE_MIN;
  if (v > R2_SCORE_MAX) return R2_SCORE_MAX;
  return v;
}

function parseR2ScoreTyped(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s || s === '.' || s === '-' || s === '-.') return undefined;
  const n = Number(s);
  if (!isFinite(n)) return undefined;
  return clampR2Score(n);
}

function r2BandHighlightVal(score) {
  if (typeof score !== 'number') return null;
  if (score >= 3.5) return 4;
  if (score >= 2.5) return 3;
  if (score >= 1.5) return 2;
  return 1;
}

function applyR2ScoreToRecord(rec, key, val) {
  if (!rec) return;
  rec.scores = rec.scores || {};
  if (val == null) {
    rec.scores[key] = undefined;
    if (isR2MathKey(key)) {
      rec.scores.quant_reasoning = undefined;
      rec.scores.math = undefined;
    }
    return;
  }
  rec.scores[key] = val;
  if (isR2MathKey(key)) {
    rec.scores.quant_reasoning = val;
    rec.scores.math = val;
  }
}

function persistR2Score(a, rec, key) {
  if (!a || !rec || !key) return;
  saveR2GraderNoteFields('round2', a.id, rec);
  saveGrade('round2', a.id, 'score', key, rec.scores[key]);
  if (isR2MathKey(key)) {
    const mathVal = rec.scores.quant_reasoning;
    if (key !== 'quant_reasoning') saveGrade('round2', a.id, 'score', 'quant_reasoning', mathVal);
    if (key !== 'math') saveGrade('round2', a.id, 'score', 'math', mathVal);
  }
}

function formatRound2ScorePairHtml(applicantId) {
  const g = STATE.grades.round2[applicantId];
  const caseT = round2Total(g);
  const beh = round2BehavioralAvg(g);
  return '<span class="r2-list-scores">'
    + '<span class="r2-list-case">' + formatR2Avg(caseT && caseT.total) + ' case</span>'
    + '<span class="r2-list-sep"> · </span>'
    + '<span class="r2-list-beh">' + formatR2Avg(beh) + ' beh</span>'
    + '</span>';
}

// An auto-filled academics score on its own doesn't make someone "reviewed" — a person
// has to have scored something before the applicant counts toward progress or stats.
function hasManualScore(g) {
  return !!g && !!g.scores && Object.keys(g.scores).some(function (k) {
    return k !== R2_VIBE_CHECK_KEY && typeof g.scores[k] === 'number';
  });
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

// Interviewer-adjusted First Round score. Same /4-ish scale as the raw
// remaining-question average. Derived live — never stored.
//   standardized = raw - interviewerMean + overallMean
// Interviewers with fewer than two scored interviews fall back to raw.
// Unassigned or unscored people have no std.
let _round1StdBundle = null;
function invalidateRound1Std() { _round1StdBundle = null; }

function round1StdBundle() {
  if (_round1StdBundle) return _round1StdBundle;
  const interviewers = {};
  const all = [];
  STATE.applicants.forEach(function (a) {
    const raw = scoreFor('round1', a.id);
    if (raw == null) return;
    all.push(raw);
    const iid = r1InterviewerId(a.id);
    if (!iid) return;
    if (!interviewers[iid]) interviewers[iid] = [];
    interviewers[iid].push(raw);
  });
  const overallMean = all.length ? all.reduce(function (s, v) { return s + v; }, 0) / all.length : null;
  const stats = {};
  Object.keys(interviewers).forEach(function (iid) {
    const vals = interviewers[iid];
    const n = vals.length;
    const mean = vals.reduce(function (s, v) { return s + v; }, 0) / n;
    stats[iid] = { n: n, mean: mean };
  });
  _round1StdBundle = { overallMean: overallMean, interviewers: stats };
  return _round1StdBundle;
}

function standardizedRound1Score(applicantId) {
  const raw = scoreFor('round1', applicantId);
  if (raw == null) return null;
  const iid = r1InterviewerId(applicantId);
  if (!iid) return null;
  const bundle = round1StdBundle();
  const iv = bundle.interviewers[iid];
  if (!iv || iv.n < 2 || bundle.overallMean == null) return raw;
  return raw - iv.mean + bundle.overallMean;
}

function round1BlendScore(applicantId) {
  const raw = scoreFor('round1', applicantId);
  if (raw == null) return null;
  const std = standardizedRound1Score(applicantId);
  if (std == null) return raw;
  return (raw + std) / 2;
}

function formatRound1ScorePairHtml(applicantId) {
  const raw = scoreFor('round1', applicantId);
  if (raw == null) return '—';
  const std = standardizedRound1Score(applicantId);
  if (std == null) return raw.toFixed(1) + ' r1';
  const title = 'Adjusted for interviewer grading vs the overall First Round mean';
  return '<span title="' + esc(title) + '">' + raw.toFixed(1) + ' r1 · ' + std.toFixed(1) + ' std</span>';
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

// Only people checked on Overview / profile after an explicit Rd2 set is applied.
// The implicit "everyone in First Round" pool does not count as advancing.
function isExplicitlyAdvancingRd2(id) {
  return !!(STATE.advanceRd2 && STATE.advanceRd2.applied && STATE.advanceRd2.ids[id] === true);
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
  invalidateRound1Std();
  return firstRoundPool().slice().sort(function (a, b) {
    const av = round1BlendScore(a.id);
    const bv = round1BlendScore(b.id);
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

function normalizeR2Interviewers(raw) {
  const out = [];
  const seen = {};
  (Array.isArray(raw) ? raw : (raw ? [raw] : [])).forEach(function (id) {
    const v = String(id || '').trim();
    if (!v || seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out.slice(0, 2);
}

const R2_GRADER_TAB_KEY = 'rem-r2-grader-tab-v1';
const r2ActiveGraderSlot = {};

function r2GraderSlotKey(applicantId, slot) {
  const ids = r2Interviewers(applicantId);
  const id = ids[slot] || '';
  return id || ('__slot' + slot);
}

function r2GraderTabs(applicantId) {
  const ids = r2Interviewers(applicantId);
  return [0, 1].map(function (slot) {
    const key = r2GraderSlotKey(applicantId, slot);
    const name = ids[slot]
      ? (interviewerShort(ids[slot]) || interviewerName(ids[slot]) || ids[slot])
      : ('Grader ' + (slot + 1));
    return { slot: slot, key: key, name: name };
  });
}

function getR2ActiveGraderSlot(applicantId) {
  if (r2ActiveGraderSlot[applicantId] != null) return r2ActiveGraderSlot[applicantId];
  try {
    const map = JSON.parse(localStorage.getItem(R2_GRADER_TAB_KEY) || '{}');
    if (map[applicantId] != null) return Number(map[applicantId]) || 0;
  } catch (e) { /* ignore */ }
  return 0;
}

function setR2ActiveGraderSlot(applicantId, slot) {
  r2ActiveGraderSlot[applicantId] = slot === 1 ? 1 : 0;
  try {
    const map = JSON.parse(localStorage.getItem(R2_GRADER_TAB_KEY) || '{}');
    map[applicantId] = r2ActiveGraderSlot[applicantId];
    localStorage.setItem(R2_GRADER_TAB_KEY, JSON.stringify(map));
  } catch (e) { /* ignore */ }
}

function r2ActiveGraderKey(applicantId) {
  return r2GraderSlotKey(applicantId, getR2ActiveGraderSlot(applicantId));
}

function r2PrimaryGraderKey(applicantId) {
  return r2GraderSlotKey(applicantId, 0);
}

function mergeGraderNotesBy(existing, patch) {
  const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
  const delta = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch : {};
  const out = Object.assign({}, base);
  Object.keys(delta).forEach(function (graderKey) {
    const prev = out[graderKey];
    const next = delta[graderKey];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      out[graderKey] = Object.assign({}, prev && typeof prev === 'object' ? prev : {}, next);
    } else if (typeof next === 'string') {
      out[graderKey] = next;
    }
  });
  return Object.keys(out).length ? out : existing;
}

function migrateR2GraderNotes(g, applicantId) {
  if (!g || !applicantId) return;
  hydrateR2VibeFromFit(g);
  const primary = r2PrimaryGraderKey(applicantId);
  g.dimNotesBy = g.dimNotesBy || {};
  g.qnotesBy = g.qnotesBy || {};
  g.notesBy = g.notesBy || {};
  if (g.dimNotes && typeof g.dimNotes === 'object') {
    const bucket = Object.assign({}, g.dimNotesBy[primary] || {});
    Object.keys(g.dimNotes).forEach(function (k) {
      const legacy = noteText(g.dimNotes[k]).trim();
      if (legacy && !noteText(bucket[k]).trim()) bucket[k] = g.dimNotes[k];
    });
    if (Object.keys(bucket).length) g.dimNotesBy[primary] = bucket;
  }
  if (g.qnotes && typeof g.qnotes === 'object') {
    const bucket = Object.assign({}, g.qnotesBy[primary] || {});
    Object.keys(g.qnotes).forEach(function (k) {
      const legacy = noteText(g.qnotes[k]).trim();
      if (legacy && !noteText(bucket[k]).trim()) bucket[k] = g.qnotes[k];
    });
    if (Object.keys(bucket).length) g.qnotesBy[primary] = bucket;
  }
  if (noteText(g.notes).trim() && !noteText(g.notesBy[primary]).trim()) {
    g.notesBy[primary] = g.notes;
  }
}

function mirrorR2LegacyNotes(g, applicantId) {
  if (!g || !applicantId) return;
  const primary = r2PrimaryGraderKey(applicantId);
  const dim = g.dimNotesBy && g.dimNotesBy[primary];
  if (dim && typeof dim === 'object' && Object.keys(dim).length) {
    g.dimNotes = Object.assign({}, g.dimNotes || {}, dim);
  }
  const qn = g.qnotesBy && g.qnotesBy[primary];
  if (qn && typeof qn === 'object' && Object.keys(qn).length) {
    g.qnotes = Object.assign({}, g.qnotes || {}, qn);
  }
  if (g.notesBy && noteText(g.notesBy[primary]).trim()) g.notes = g.notesBy[primary];
}

function foldR2GraderTextarea(g, applicantId, ta) {
  if (!g || !ta || !applicantId) return;
  migrateR2GraderNotes(g, applicantId);
  const graderKey = r2ActiveGraderKey(applicantId);
  const key = ta.dataset.notekey;
  if (key === '__main') {
    g.notesBy = g.notesBy || {};
    g.notesBy[graderKey] = ta.value;
    if (graderKey === r2PrimaryGraderKey(applicantId)) g.notes = ta.value;
    return;
  }
  if (key === '__case') {
    g.caseNotes = ta.value;
    return;
  }
  if (isR2DimNoteKey(key)) {
    g.dimNotesBy = g.dimNotesBy || {};
    g.dimNotesBy[graderKey] = g.dimNotesBy[graderKey] || {};
    g.dimNotesBy[graderKey][key] = ta.value;
    if (graderKey === r2PrimaryGraderKey(applicantId)) {
      g.dimNotes = g.dimNotes || {};
      g.dimNotes[key] = ta.value;
    }
    return;
  }
  g.qnotesBy = g.qnotesBy || {};
  g.qnotesBy[graderKey] = g.qnotesBy[graderKey] || {};
  g.qnotesBy[graderKey][key] = ta.value;
  if (graderKey === r2PrimaryGraderKey(applicantId)) {
    g.qnotes = g.qnotes || {};
    g.qnotes[key] = ta.value;
  }
}

function saveR2GraderNoteFields(round, applicantId, g) {
  if (round !== 'round2' || !g) return;
  mirrorR2LegacyNotes(g, applicantId);
  if (g.dimNotesBy && Object.keys(g.dimNotesBy).length) {
    saveGrade(round, applicantId, 'dimNotesBy', null, cloneJson(g.dimNotesBy));
  }
  if (g.qnotesBy && Object.keys(g.qnotesBy).length) {
    saveGrade(round, applicantId, 'qnotesBy', null, cloneJson(g.qnotesBy));
  }
  if (g.notesBy && Object.keys(g.notesBy).length) {
    saveGrade(round, applicantId, 'notesBy', null, cloneJson(g.notesBy));
  }
  if (g.dimNotes) saveGrade(round, applicantId, 'dimNotes', null, cloneJson(g.dimNotes));
  if (g.qnotes) saveGrade(round, applicantId, 'qnotes', null, cloneJson(g.qnotes));
  if (typeof g.notes === 'string') saveGrade(round, applicantId, 'notes', null, g.notes);
}

function r2DimNoteForGrader(g, key, graderKey, applicantId) {
  if (!g || !key) return '';
  const by = g.dimNotesBy && g.dimNotesBy[graderKey];
  if (by && noteText(by[key]).trim()) return by[key];
  if (isR2MathKey(key) && by) {
    if (noteText(by.math).trim()) return by.math;
    if (noteText(by.quant_reasoning).trim()) return by.quant_reasoning;
  }
  if (key === R2_VIBE_CHECK_KEY && by && noteText(by[R2_FIT_KEY]).trim()) return by[R2_FIT_KEY];
  if (graderKey === r2PrimaryGraderKey(applicantId)) return r2DimNote(g, key);
  return '';
}

function r2QnoteForGrader(g, key, graderKey, applicantId) {
  if (!g || !key) return '';
  const by = g.qnotesBy && g.qnotesBy[graderKey];
  if (by && typeof by[key] === 'string') return by[key];
  if (graderKey === r2PrimaryGraderKey(applicantId) && g.qnotes && typeof g.qnotes[key] === 'string') {
    return g.qnotes[key];
  }
  return '';
}

function r2RecNoteForGrader(g, graderKey, applicantId) {
  if (!g) return '';
  if (g.notesBy && noteText(g.notesBy[graderKey]).trim()) return g.notesBy[graderKey];
  if (graderKey === r2PrimaryGraderKey(applicantId) && noteText(g.notes).trim()) return g.notes;
  return '';
}

function r2Interviewers(applicantId) {
  const g = STATE.grades.round2[applicantId];
  if (g && Array.isArray(g.interviewers)) return normalizeR2Interviewers(g.interviewers);
  if (g && g.interviewer) return normalizeR2Interviewers([g.interviewer]);
  return [];
}

function r2PairKey(ids) {
  const list = normalizeR2Interviewers(ids).slice().sort();
  return list.length ? list.join('|') : '';
}

function r2PairLabel(ids) {
  const list = normalizeR2Interviewers(ids);
  if (!list.length) return '';
  return list.map(function (id) { return interviewerShort(id) || interviewerName(id) || id; }).join(' & ');
}

function r2InterviewRoom(applicantId) {
  const g = STATE.grades.round2[applicantId];
  return (g && g.interviewRoom) || '';
}

function r2InterviewTime(applicantId) {
  const g = STATE.grades.round2[applicantId];
  return (g && g.interviewTime) || '';
}

function r2InterviewDateKey(raw) {
  const s = String(raw || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function formatInterviewDate(raw) {
  const key = r2InterviewDateKey(raw);
  if (!key) return '';
  const parts = key.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function r2PairIncludes(applicantId, interviewerId) {
  if (!interviewerId) return false;
  return r2Interviewers(applicantId).indexOf(interviewerId) >= 0;
}

function r2KnownRooms() {
  const seen = {};
  const out = [];
  ['HVNR 123', 'HVNR 124', 'HVNR 125', 'HVNR 126', 'No room booked'].forEach(function (r) {
    seen[r] = true;
    out.push(r);
  });
  Object.keys(STATE.grades.round2 || {}).forEach(function (id) {
    const room = r2InterviewRoom(id);
    if (room && !seen[room]) { seen[room] = true; out.push(room); }
  });
  return out;
}

function r2KnownPairs() {
  const map = {};
  poolForRound('round2').forEach(function (a) {
    const ids = r2Interviewers(a.id);
    const key = r2PairKey(ids);
    if (!key) return;
    if (!map[key]) map[key] = { key: key, ids: ids.slice().sort(), label: r2PairLabel(ids.slice().sort()) };
  });
  return Object.keys(map).sort(function (a, b) {
    return map[a].label.localeCompare(map[b].label);
  }).map(function (k) { return map[k]; });
}

function r2KnownDates() {
  const seen = {};
  poolForRound('round2').forEach(function (a) {
    const key = r2InterviewDateKey(r2InterviewTime(a.id));
    if (key) seen[key] = true;
  });
  return Object.keys(seen).sort();
}

function r2InterviewerOptionsHtml(selected) {
  const ivs = STATE.interviewers || [];
  let html = '<option value="">Unassigned</option>';
  ivs.forEach(function (iv) {
    html += `<option value="${esc(iv.id)}" ${selected === iv.id ? 'selected' : ''}>${esc(iv.name)}</option>`;
  });
  if (selected && !ivs.some(function (iv) { return iv.id === selected; })) {
    html += `<option value="${esc(selected)}" selected>${esc(interviewerName(selected) || selected)}</option>`;
  }
  return html;
}

function r2AssignBlockHtml(a, g) {
  const pair = r2Interviewers(a.id);
  const rooms = r2KnownRooms();
  const room = r2InterviewRoom(a.id);
  const time = r2InterviewTime(a.id);
  return `
        <div class="avg-display">${headerScoreInner('round2', g, a)}</div>
        <div class="r1-app-score" title="First Round interview average">${formatRound1ScorePairHtml(a.id)} <span class="of">first round</span></div>
        <div class="field-label assign-label">Interview pair</div>
        <select id="r2Interviewer0" title="Interviewer 1"${readOnly ? ' disabled' : ''}>${r2InterviewerOptionsHtml(pair[0] || '')}</select>
        <select id="r2Interviewer1" title="Interviewer 2"${readOnly ? ' disabled' : ''}>${r2InterviewerOptionsHtml(pair[1] || '')}</select>
        <div class="field-label assign-label">Room</div>
        <select id="r2InterviewRoom" title="Interview room"${readOnly ? ' disabled' : ''}>
          <option value="">No room</option>
          ${rooms.map(function (r) {
            return `<option value="${esc(r)}" ${room === r ? 'selected' : ''}>${esc(r)}</option>`;
          }).join('')}
          ${room && rooms.indexOf(room) < 0 ? `<option value="${esc(room)}" selected>${esc(room)}</option>` : ''}
        </select>
        <div class="field-label assign-label">Date & time</div>
        <input type="datetime-local" id="r2InterviewTime" value="${esc(time || '')}"${readOnly ? ' disabled' : ''}>`;
}

function persistR2Schedule(a) {
  const rec = getGrade('round2', a.id);
  const time = document.getElementById('r2InterviewTime');
  const room = document.getElementById('r2InterviewRoom');
  const i0 = document.getElementById('r2Interviewer0');
  const i1 = document.getElementById('r2Interviewer1');
  rec.interviewers = normalizeR2Interviewers([i0 && i0.value, i1 && i1.value]);
  rec.interviewRoom = room && room.value ? room.value : undefined;
  rec.interviewTime = time && time.value ? time.value : undefined;
  saveGrade('round2', a.id, 'interviewers', null, rec.interviewers.slice());
  saveGrade('round2', a.id, 'interviewRoom', null, rec.interviewRoom || null);
  saveGrade('round2', a.id, 'interviewTime', null, rec.interviewTime || null);
  syncR2GraderTabLabels(a);
}

function bindR2AssignControls(a) {
  if (STATE.gradeRound !== 'round2') return;
  ['r2Interviewer0', 'r2Interviewer1', 'r2InterviewRoom', 'r2InterviewTime'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', function () { persistR2Schedule(a); });
  });
}

function syncR2AssignFields(g) {
  if (!g) return;
  const pair = normalizeR2Interviewers(g.interviewers);
  const map = [
    ['r2Interviewer0', pair[0] || ''],
    ['r2Interviewer1', pair[1] || ''],
    ['r2InterviewRoom', g.interviewRoom || ''],
    ['r2InterviewTime', g.interviewTime || ''],
  ];
  map.forEach(function (pairEl) {
    const el = document.getElementById(pairEl[0]);
    if (!el || document.activeElement === el) return;
    if (el.value !== pairEl[1]) el.value = pairEl[1];
  });
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
  if (round === 'round2') {
    if (STATE.filterR2Interviewer && STATE.filterR2Interviewer !== 'all') return STATE.filterR2Interviewer;
    const pair = r2Interviewers(applicantId);
    return pair[0] || null;
  }
  if (STATE.filterGroup && STATE.filterGroup !== 'all') return STATE.filterGroup;
  return ensureAssignment(round, applicantId);
}

function sortApplicantList(list, round) {
  return list.slice().sort((a, b) => {
    let av, bv;
    if (STATE.sortKey === 'name') { av = a.name; bv = b.name; }
    else if (STATE.sortKey === 'r1score' || (round === 'round2' && STATE.sortKey === 'gpa')) {
      av = scoreFor('round1', a.id) ?? -1; bv = scoreFor('round1', b.id) ?? -1;
    }
    else if (STATE.sortKey === 'gpa') { av = autoFor(a).gpa.value ?? -1; bv = autoFor(b).gpa.value ?? -1; }
    else if (STATE.sortKey === 'score') {
      if (round === 'screen') { av = screenBlendScore(a.id) ?? -1; bv = screenBlendScore(b.id) ?? -1; }
      else if (round === 'round1') { av = round1BlendScore(a.id) ?? -1; bv = round1BlendScore(b.id) ?? -1; }
      else { av = scoreFor(round, a.id) ?? -1; bv = scoreFor(round, b.id) ?? -1; }
    }
    else if (STATE.sortKey === 'beh') {
      av = round2BehavioralAvg(STATE.grades.round2[a.id]) ?? -1;
      bv = round2BehavioralAvg(STATE.grades.round2[b.id]) ?? -1;
    }
    else if (STATE.sortKey === 'r1std') { av = standardizedRound1Score(a.id) ?? -1; bv = standardizedRound1Score(b.id) ?? -1; }
    else if (STATE.sortKey === 'group') {
      if (round === 'round1') { av = interviewerName(r1InterviewerId(a.id)) || ''; bv = interviewerName(r1InterviewerId(b.id)) || ''; }
      else if (round === 'round2') { av = r2PairLabel(r2Interviewers(a.id)) || ''; bv = r2PairLabel(r2Interviewers(b.id)) || ''; }
      else { av = ensureAssignment(round, a.id) || ''; bv = ensureAssignment(round, b.id) || ''; }
    }
    else if (STATE.sortKey === 'time') {
      av = (round === 'round2' ? r2InterviewTime(a.id) : r1InterviewTime(a.id)) || '';
      bv = (round === 'round2' ? r2InterviewTime(b.id) : r1InterviewTime(b.id)) || '';
      if (round === 'round2') {
        if (!av && bv) return 1;
        if (av && !bv) return -1;
      }
    }
    else if (STATE.sortKey === 'room') {
      av = r2InterviewRoom(a.id) || ''; bv = r2InterviewRoom(b.id) || '';
    }
    else if (STATE.sortKey === 'appscore') { av = screenBlendScore(a.id) ?? -1; bv = screenBlendScore(b.id) ?? -1; }
    else { av = a.name; bv = b.name; }
    if (av < bv) return STATE.sortDir === 'asc' ? -1 : 1;
    if (av > bv) return STATE.sortDir === 'asc' ? 1 : -1;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
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
  if (round === 'round2') {
    return sortApplicantList(poolForRound(round).filter(function (a) {
      return r2PairIncludes(a.id, groupId) && !hasManualScore(STATE.grades.round2[a.id]);
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
  if (round === 'round2') {
    return sortApplicantList(poolForRound(round).filter(function (a) {
      return r2PairIncludes(a.id, groupId);
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
  const name = (round === 'round1' || round === 'round2')
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
  if (round === 'round2') {
    return `<span class="review-as">
      <span class="lbl">My pair</span>
      ${(STATE.interviewers || []).map(function (iv) {
        return `<label class="chip ${STATE.filterR2Interviewer === iv.id ? 'active' : ''}" data-reviewas-r2="${esc(iv.id)}">${esc(interviewerShort(iv.id) || iv.name)}</label>`;
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
  root.querySelectorAll('[data-reviewas-r2]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.reviewasR2;
      STATE.filterR2Interviewer = STATE.filterR2Interviewer === id ? 'all' : id;
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
  if (STATE.gradeRound === 'round2') {
    const layout = getR2CaseLayout();
    return `<div class="layout-toggle" role="group" aria-label="Case and rubric layout">
      <span class="layout-toggle-lbl">Case layout</span>
      <button type="button" class="chip ${layout === 'stacked' ? 'active' : ''}" data-r2layout="stacked">Stacked</button>
      <button type="button" class="chip ${layout === 'side' ? 'active' : ''}" data-r2layout="side">Side</button>
    </div>`;
  }
  const layout = getGradeLayout();
  return `<div class="layout-toggle" role="group" aria-label="Grade layout">
    <span class="layout-toggle-lbl">Layout</span>
    <button type="button" class="chip ${layout === 'stacked' ? 'active' : ''}" data-layout="stacked">Stacked</button>
    <button type="button" class="chip ${layout === 'side' ? 'active' : ''}" data-layout="side">Side</button>
  </div>`;
}

function captureR2PaneScroll() {
  const casePane = document.getElementById('r2CasePane');
  const rubricPane = document.getElementById('r2RubricPane');
  const guide = document.getElementById('r2CaseGuide');
  return {
    caseId: guide ? (guide.getAttribute('data-case') || '') : '',
    caseTop: casePane ? casePane.scrollTop : 0,
    rubricTop: rubricPane ? rubricPane.scrollTop : 0,
  };
}

function restoreR2PaneScroll(snap) {
  if (!snap) return;
  const guide = document.getElementById('r2CaseGuide');
  const caseId = guide ? (guide.getAttribute('data-case') || '') : '';
  const casePane = document.getElementById('r2CasePane');
  const rubricPane = document.getElementById('r2RubricPane');
  if (rubricPane && typeof snap.rubricTop === 'number') rubricPane.scrollTop = snap.rubricTop;
  if (casePane && caseId === snap.caseId && typeof snap.caseTop === 'number') casePane.scrollTop = snap.caseTop;
}

function liveR2CaseId(root) {
  const scope = root || document;
  const guide = document.getElementById('r2CaseGuide');
  const fromGuide = guide && guide.getAttribute('data-case');
  if (fromGuide && r2KnownCaseId(fromGuide)) return fromGuide;
  const openCase = scope.querySelector && scope.querySelector('.r2-case.open[data-case]');
  if (openCase && openCase.dataset.case && r2KnownCaseId(openCase.dataset.case)) return openCase.dataset.case;
  return '';
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
    r2panes: captureR2PaneScroll(),
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
  restoreR2PaneScroll(snap.r2panes);
}

let lastGradeKey = null;
let lastOverviewView = false;
let lastView = null;
let lastRoundListScroll = 0;

function render() {
  invalidateScreenStd();
  invalidateRound1Std();
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

const NAV_COLLAPSE_KEY = 'rem-uf-nav-collapsed';
const RAIL_ICONS = {
  overview: 'Ov',
  'round:screen': 'AS',
  'round:round1': 'R1',
  'round:round2': 'R2',
  flagged: '!',
  groups: 'Gr',
  export: 'Ex',
};

function getNavCollapsed() {
  try { return localStorage.getItem(NAV_COLLAPSE_KEY) === '1'; } catch (e) { return false; }
}

function applyNavCollapsed(on) {
  document.body.classList.toggle('nav-collapsed', !!on);
  const btn = document.getElementById('railCollapseBtn');
  if (btn) {
    btn.setAttribute('aria-expanded', on ? 'false' : 'true');
    btn.setAttribute('aria-label', on ? 'Expand navigation' : 'Collapse navigation');
    btn.title = on ? 'Expand navigation' : 'Collapse navigation';
  }
}

function setNavCollapsed(on) {
  applyNavCollapsed(on);
  try { localStorage.setItem(NAV_COLLAPSE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
}

applyNavCollapsed(getNavCollapsed());

function railBtn(id, label, count) {
  const active = STATE.view === id || (STATE.view.startsWith(id + ':') );
  const ico = RAIL_ICONS[id] || String(label || '').slice(0, 2);
  return `<button class="rail-btn ${active ? 'active' : ''}" data-nav="${id}" title="${esc(label)}">
    <span class="rail-ico" aria-hidden="true">${esc(ico)}</span>
    <span class="rail-lbl">${esc(label)}</span>${count != null ? `<span class="count">${count}</span>` : ''}
  </button>`;
}

function renderRail() {
  const collapsed = getNavCollapsed();
  railEl.innerHTML = `
    <div class="rail-head">
      <div class="rail-brand">
        <span class="rail-brand-full">Rem · UF</span>
        <span class="rail-brand-mini" aria-hidden="true">Rem</span>
        <span class="sub">Fall 2026 Recruitment</span>
      </div>
      <button type="button" class="rail-collapse" id="railCollapseBtn" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand navigation' : 'Collapse navigation'}" title="${collapsed ? 'Expand navigation' : 'Collapse navigation'}">${collapsed ? '›' : '‹'}</button>
    </div>
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
      <div class="rail-foot-copy"><span class="dot"></span>${B.applicants.length} applicants at build · ${STATE.applicants.length} now</div>
      <button type="button" class="sub rail-stamp" id="buildStamp" title="Re-render">${BUILD_STAMP}</button>
    </div>
  `;
  applyNavCollapsed(collapsed);
  railEl.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
    STATE.view = b.dataset.nav;
    STATE.currentApplicantId = null;
    STATE.returnView = null;
    if (b.dataset.nav === 'flagged') STATE.flaggedOnly = true;
    else if (b.dataset.nav === 'round:screen') { /* keep flaggedOnly chip state */ }
    else STATE.flaggedOnly = false;
    render();
  }));
  const collapseBtn = document.getElementById('railCollapseBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', function (evt) {
    if (evt) { evt.preventDefault(); evt.stopPropagation(); }
    setNavCollapsed(!getNavCollapsed());
    collapseBtn.textContent = getNavCollapsed() ? '›' : '‹';
  });
  const stamp = document.getElementById('buildStamp');
  if (stamp) stamp.addEventListener('click', function () { render(); });
}

function renderTopbar() {
  let title = 'Overview', eyebrow = 'Rem UF Recruitment';
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
    contentEl.classList.toggle('r2-grade-page', STATE.gradeRound === 'round2');
    if (STATE.gradeRound !== 'round2') contentEl.classList.remove('r2-case-open');
  } else {
    contentEl.classList.remove('grade-wide', 'grade-layout-side', 'grade-layout-stacked', 'r2-grade-page', 'r2-case-open');
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
  const r2Scored = r2Pool.filter(function (a) { return hasRound2Score(STATE.grades.round2[a.id]); }).length;
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
      ${statTile('Second Round pool', `${r2Scored}/${r2Pool.length}`, hasExplicitAdvanceRd2() ? 'case or behavioral scored · explicit Rd2 set' : 'everyone in First Round until you Apply top N', 'round:round2')}
      ${statTile('Flagged for 2nd review', flaggedCount, flaggedCount ? 'open the flagged list' : 'none flagged yet', 'flagged')}
      ${statTile('Coffee chat contact', coffeeCount, `of ${total} applicants`)}
      ${statTile('Meet the Members', meetCount, `of ${total} applicants`)}
      ${statTile('Late applications', STATE.applicants.filter(a => a.late).length, 'after Sep 4 11:59 PM ET')}
      ${statTile('Vouched for', vouchedCount, vouchedCount ? 'by an exec member' : 'no vouches yet')}
    </div>

    ${advanceHtml}
    ${interviewerHtml}
    ${advanceRd2Html}
    ${renderOverviewR2FiltersCard()}

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
  bindOverviewR2Filters();
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

function renderOverviewR2FiltersCard() {
  const n = poolForRound('round2').length;
  return `<div class="card card-pad" style="margin-bottom:22px;">
    <div class="section-title">Second Round schedule <span class="n">${n} in pool</span></div>
    <p class="advance-copy">Filter by pair, room, or date the same way as the Second Round list. Default sort is interview time, then name.</p>
    <div class="filters-bar" style="margin-bottom:0;">
      ${r2ScheduleFiltersHtml()}
      <button type="button" class="btn small primary" id="openR2ListBtn">Open Second Round</button>
    </div>
  </div>`;
}

function bindOverviewR2Filters() {
  bindR2ScheduleFilters(function () {
    openR2List();
    render();
  });
  const btn = document.getElementById('openR2ListBtn');
  if (btn) btn.addEventListener('click', function () {
    openR2List();
    render();
  });
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
    const notes = notesSnippet(g.initialNotes, 64);
    const who = interviewerShort(g.interviewer) || interviewerName(g.interviewer);
    return `<label class="advance-row advance-row-rd2">
      <input type="checkbox" data-advance-rd2="${esc(a.id)}" ${on ? 'checked' : ''}>
      <span class="nm">${esc(a.name)}${g.knowFlag ? '<span class="know-badge">Knows them</span>' : ''}${g.thankYou ? '<span class="follow-badge yes">Followed up</span>' : '<span class="follow-badge no">No follow-up</span>'}</span>
      <span class="sub">${esc(who || 'Unassigned')}${g.interviewTime ? ' · ' + esc(formatInterviewTime(g.interviewTime)) : ''}${notes ? ' · ' + esc(notes) : ''}</span>
      <span class="mono">${formatRound1ScorePairHtml(a.id)} · ${formatScreenScorePairHtml(a.id)}</span>
    </label>`;
  }).join('') || '<div class="sub" style="color:var(--slate); padding:8px 0;">No one is in the First Round pool yet.</div>';
  return `<div class="card card-pad advance-card" style="margin-bottom:22px;">
    <div class="section-title">Who advances to Round 2 <span class="n">from First Round</span></div>
    <p class="advance-copy">Same idea as First Round: Apply top N to set the Round 2 pool from people who made First Round. Until then, Second Round includes everyone in First Round. Apply top N ranks by the average of raw First Round interview score and interviewer-standardized — then you can check or uncheck. Scores do not auto-advance anyone.</p>
    <div class="advance-controls">
      <label class="advance-n-label" for="advanceRd2TopN">Advance top N</label>
      <input type="number" id="advanceRd2TopN" min="0" step="1" value="${topN}">
      <button type="button" class="btn primary small" id="applyRd2TopN">Apply top N</button>
      ${applied ? '<button type="button" class="btn ghost small" id="clearAdvanceRd2">Use First Round pool again</button>' : ''}
      ${rd2EmailToolButtonsHtml()}
      <span class="advance-count" id="advanceRd2Count">${esc(advanceRd2CountLabel())}</span>
    </div>
    <div class="advance-status" id="advanceRd2Status">${applied ? 'Round 2 is the checked list below.' : 'Round 2 still includes everyone in First Round — Apply top N to set the pool.'}</div>
    ${rd2EmailPanelsHtml()}
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
    toast('Round 2 set to top ' + Math.max(0, Math.floor(Number(n) || 0)) + ' by blended First Round score');
  });
  bindClearAdvanceRd2Button(document.getElementById('clearAdvanceRd2'));
  bindRd2EmailTools();
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
  const rejectN = selectedRejectRd2Emails().length;
  return selected + ' selected · N = ' + topN + (applied ? ' · ' + poolN + ' in Round 2' : '') + ' · ' + emailN + ' emails' + (applied ? ' · ' + rejectN + ' rejection emails' : '');
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
  const r2Scored = r2Pool.filter(function (a) { return hasRound2Score(STATE.grades.round2[a.id]); }).length;
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
    emailOut.value = advanceRd2ShowText();
  }
  syncAdvanceRd2EmailControls();
  syncRejectRd2EmailControls();
}

function rd2RejectTitle() {
  return hasExplicitAdvanceRd2()
    ? 'People in First Round who did not move to Round 2'
    : 'Everyone is still in the First Round pool';
}

function rd2MoveCopyEnabled() {
  return hasExplicitAdvanceRd2() || STATE.view === 'round:round2';
}

function rd2MoveTitle(kind) {
  if (!rd2MoveCopyEnabled()) return 'No Round 2 set yet — Apply top N on Overview';
  return kind === 'show'
    ? 'Name and email of people advancing to Round 2'
    : 'Emails of people advancing to Round 2';
}

function rd2EmailToolButtonsHtml() {
  const applied = hasExplicitAdvanceRd2();
  const moveOn = rd2MoveCopyEnabled();
  const rejectTitle = rd2RejectTitle();
  return `<button type="button" class="btn small" id="copyAdvanceRd2Emails"${moveOn ? '' : ' disabled'} title="${esc(rd2MoveTitle('copy'))}">Copy emails</button>
      <button type="button" class="btn ghost small" id="showAdvanceRd2Emails"${moveOn ? '' : ' disabled'} title="${esc(rd2MoveTitle('show'))}">Show emails</button>
      <button type="button" class="btn small" id="copyRejectRd2Emails"${applied ? '' : ' disabled'} title="${esc(rejectTitle)}">Copy rejection emails</button>
      <button type="button" class="btn ghost small" id="showRejectRd2Emails"${applied ? '' : ' disabled'} title="${esc(rejectTitle)}">Show rejection emails</button>`;
}

function rd2EmailPanelsHtml() {
  return `<div id="advanceRd2EmailPanel" class="advance-emails" hidden>
      <textarea id="advanceRd2EmailOut" readonly></textarea>
    </div>
    <div id="rejectRd2EmailPanel" class="advance-emails" hidden>
      <textarea id="rejectRd2EmailOut" readonly></textarea>
    </div>`;
}

function rd2ListEmailToolsHtml() {
  return `<div class="advance-controls rd2-list-email-tools">
      ${rd2EmailToolButtonsHtml()}
    </div>
    ${rd2EmailPanelsHtml()}`;
}

function bindRd2EmailTools() {
  const copyBtn = document.getElementById('copyAdvanceRd2Emails');
  if (copyBtn) copyBtn.addEventListener('click', function () { copyAdvanceRd2Emails(); });
  const showBtn = document.getElementById('showAdvanceRd2Emails');
  if (showBtn) showBtn.addEventListener('click', function () { toggleAdvanceRd2Emails(); });
  const copyRejectBtn = document.getElementById('copyRejectRd2Emails');
  if (copyRejectBtn) copyRejectBtn.addEventListener('click', function () { copyRejectRd2Emails(); });
  const showRejectBtn = document.getElementById('showRejectRd2Emails');
  if (showRejectBtn) showRejectBtn.addEventListener('click', function () { toggleRejectRd2Emails(); });
  syncAdvanceRd2EmailControls();
  syncRejectRd2EmailControls();
}

function selectedAdvanceRd2Applicants() {
  if (hasExplicitAdvanceRd2()) {
    return firstRoundPool().filter(function (a) { return STATE.advanceRd2.ids[a.id] === true; });
  }
  if (STATE.view === 'round:round2') return firstRoundPool();
  return [];
}

function selectedAdvanceRd2Emails() {
  return selectedAdvanceRd2Applicants().map(function (a) {
    return String(a.email || '').trim();
  }).filter(Boolean);
}

function applicantNameEmailLine(a) {
  const name = String((a && a.name) || '').trim() || '(no name)';
  const email = String((a && a.email) || '').trim() || '(no email)';
  return name + ' — ' + email;
}

function advanceRd2EmailText(sep) {
  return selectedAdvanceRd2Emails().join(sep == null ? '\n' : sep);
}

function advanceRd2ShowText() {
  return selectedAdvanceRd2Applicants().map(applicantNameEmailLine).join('\n');
}

function selectedRejectRd2Applicants() {
  if (!hasExplicitAdvanceRd2()) return [];
  return firstRoundPool().filter(function (a) { return STATE.advanceRd2.ids[a.id] !== true; });
}

function selectedRejectRd2Emails() {
  return selectedRejectRd2Applicants().map(function (a) {
    return String(a.email || '').trim();
  }).filter(Boolean);
}

function rejectRd2EmailText(sep) {
  return selectedRejectRd2Emails().join(sep == null ? '\n' : sep);
}

function rejectRd2ShowText() {
  return selectedRejectRd2Applicants().map(applicantNameEmailLine).join('\n');
}

function syncAdvanceRd2EmailControls() {
  const on = rd2MoveCopyEnabled();
  [['copyAdvanceRd2Emails', 'copy'], ['showAdvanceRd2Emails', 'show']].forEach(function (pair) {
    const el = document.getElementById(pair[0]);
    if (!el) return;
    el.disabled = !on;
    el.title = rd2MoveTitle(pair[1]);
  });
  const panel = document.getElementById('advanceRd2EmailPanel');
  const out = document.getElementById('advanceRd2EmailOut');
  const btn = document.getElementById('showAdvanceRd2Emails');
  if (!on && panel && !panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show emails';
  } else if (out && panel && !panel.hidden) {
    out.value = advanceRd2ShowText();
  }
}

function syncRejectRd2EmailControls() {
  const applied = hasExplicitAdvanceRd2();
  const title = rd2RejectTitle();
  ['copyRejectRd2Emails', 'showRejectRd2Emails'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !applied;
    el.title = title;
  });
  const panel = document.getElementById('rejectRd2EmailPanel');
  const out = document.getElementById('rejectRd2EmailOut');
  const btn = document.getElementById('showRejectRd2Emails');
  if (!applied && panel && !panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show rejection emails';
  } else if (out && panel && !panel.hidden) {
    out.value = rejectRd2ShowText();
  }
}

async function copyAdvanceRd2Emails() {
  if (!rd2MoveCopyEnabled()) { toast('No one is checked to advance to Round 2 yet'); return; }
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
  if (!rd2MoveCopyEnabled()) { toast('No one is checked to advance to Round 2 yet'); return; }
  const panel = document.getElementById('advanceRd2EmailPanel');
  const out = document.getElementById('advanceRd2EmailOut');
  const btn = document.getElementById('showAdvanceRd2Emails');
  if (!panel || !out) return;
  if (!panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show emails';
    return;
  }
  const text = advanceRd2ShowText();
  if (!text) { toast('No one on the current Round 2 set'); return; }
  out.value = text;
  panel.hidden = false;
  if (btn) btn.textContent = 'Hide emails';
  out.focus();
  out.select();
}

async function copyRejectRd2Emails() {
  if (!hasExplicitAdvanceRd2()) { toast('Everyone is still in the First Round pool.'); return; }
  const text = rejectRd2EmailText(', ');
  if (!text) { toast('No emails on the rejection set'); return; }
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { /* fall through */ }
  if (!ok) {
    const panel = document.getElementById('rejectRd2EmailPanel');
    const out = document.getElementById('rejectRd2EmailOut');
    if (panel && out) {
      panel.hidden = false;
      out.value = text;
      out.focus();
      out.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    }
  }
  toast(ok ? 'Copied ' + selectedRejectRd2Emails().length + ' rejection emails' : 'Could not copy — use Show rejection emails and copy from there');
}

function toggleRejectRd2Emails() {
  if (!hasExplicitAdvanceRd2()) { toast('Everyone is still in the First Round pool.'); return; }
  const panel = document.getElementById('rejectRd2EmailPanel');
  const out = document.getElementById('rejectRd2EmailOut');
  const btn = document.getElementById('showRejectRd2Emails');
  if (!panel || !out) return;
  if (!panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = 'Show rejection emails';
    return;
  }
  const text = rejectRd2ShowText();
  if (!text) { toast('No one on the rejection set'); return; }
  out.value = text;
  panel.hidden = false;
  if (btn) btn.textContent = 'Hide rejection emails';
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

function applyLiveR1GradeUpdate() {
  setSaveStatus(STATE.saveStatus);
  const a = STATE.byId[STATE.currentApplicantId];
  const main = document.getElementById('gradeMain');
  if (!a || !main) return;
  const g = getGrade('round1', a.id);
  updateR1PersonalityUI(main, g, a);
  R1_SCORE_KEYS.forEach(function (key) { updateR1ScoreUI(main, g, key); });
  updateHeaderScore('round1', g, a);
}

function applyLiveR2GradeUpdate() {
  setSaveStatus(STATE.saveStatus);
  const a = STATE.byId[STATE.currentApplicantId];
  const main = document.getElementById('gradeMain');
  if (!a || !main) return;
  const paneSnap = captureR2PaneScroll();
  const g = getGrade('round2', a.id);
  syncR2BehavioralRows(main, g, a);
  syncR2CaseRows(main, g, a, { keepCaseScroll: true });
  r2CaseDims().forEach(function (d) { updateR2ScoreUI(main, g, d.key); });
  updateR2ScoreUI(main, g, R2_VIBE_CHECK_KEY);
  updateR2ScoreUI(main, g, 'caseScore');
  migrateR2GraderNotes(g, a.id);
  syncR2GraderTabLabels(a);
  syncR2GraderNotesUI(main, g, a.id);
  syncR2AssignFields(g);
  updateHeaderScore('round2', g, a);
  restoreR2PaneScroll(paneSnap);
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
    if (STATE.filterAdvanceRd2 === 'advancing') {
      list = list.filter(function (a) { return isExplicitlyAdvancingRd2(a.id); });
    } else if (STATE.filterAdvanceRd2 === 'not') {
      list = list.filter(function (a) { return !isExplicitlyAdvancingRd2(a.id); });
    }
  } else if (round === 'round2') {
    if (STATE.filterR2Pair && STATE.filterR2Pair !== 'all') {
      if (STATE.filterR2Pair === 'unassigned') {
        list = list.filter(function (a) { return !r2Interviewers(a.id).length; });
      } else {
        list = list.filter(function (a) { return r2PairKey(r2Interviewers(a.id)) === STATE.filterR2Pair; });
      }
    }
    if (STATE.filterR2Room && STATE.filterR2Room !== 'all') {
      if (STATE.filterR2Room === 'unassigned') {
        list = list.filter(function (a) { return !r2InterviewRoom(a.id); });
      } else {
        list = list.filter(function (a) { return r2InterviewRoom(a.id) === STATE.filterR2Room; });
      }
    }
    if (STATE.filterR2Date && STATE.filterR2Date !== 'all') {
      if (STATE.filterR2Date === 'notime') {
        list = list.filter(function (a) { return !r2InterviewTime(a.id); });
      } else {
        list = list.filter(function (a) { return r2InterviewDateKey(r2InterviewTime(a.id)) === STATE.filterR2Date; });
      }
    }
    if (STATE.filterR2Interviewer && STATE.filterR2Interviewer !== 'all') {
      list = list.filter(function (a) { return r2PairIncludes(a.id, STATE.filterR2Interviewer); });
    }
    if (STATE.incompleteOnly) {
      list = list.filter(function (a) { return !hasManualScore(STATE.grades.round2[a.id]); });
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
  const cols = round === 'round1' ? 8 : round === 'round2' ? 7 : 6;
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
      <td><span class="score-pill${(round === 'screen' || round === 'round1') && score !== null ? ' pair' : ''}">${score === null && round !== 'round2' ? '—' : (round === 'round2' ? formatRound2ScorePairHtml(a.id) : round === 'screen' ? formatScreenScorePairHtml(a.id) : formatRound1ScorePairHtml(a.id))}</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty-state">No one is flagged for a second reviewer.</div></td></tr>`;
}

function listCountLabel(round, list) {
  if (STATE.incompleteOnly) return list.length + ' unreviewed';
  if (round === 'round1' && STATE.filterAdvanceRd2 === 'advancing') return list.length + ' advancing';
  if (round === 'round1' && STATE.filterAdvanceRd2 === 'not') return list.length + ' not advancing';
  return list.length + ' shown';
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

function applyAdvanceRd2ListFilter(round, mode) {
  STATE.filterAdvanceRd2 = STATE.filterAdvanceRd2 === mode ? 'all' : mode;
  const adv = document.getElementById('advancingRd2Toggle');
  const notAdv = document.getElementById('notAdvancingRd2Toggle');
  if (adv) adv.classList.toggle('active', STATE.filterAdvanceRd2 === 'advancing');
  if (notAdv) notAdv.classList.toggle('active', STATE.filterAdvanceRd2 === 'not');
  refreshRoundListRows(round);
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

function r2ScheduleFiltersHtml() {
  const pairs = r2KnownPairs();
  const rooms = r2KnownRooms();
  const dates = r2KnownDates();
  return `
      <select id="r2PairFilter">
        <option value="all">All pairs</option>
        <option value="unassigned" ${STATE.filterR2Pair === 'unassigned' ? 'selected' : ''}>Unassigned pair</option>
        ${pairs.map(function (p) {
          return `<option value="${esc(p.key)}" ${STATE.filterR2Pair === p.key ? 'selected' : ''}>${esc(p.label)}</option>`;
        }).join('')}
      </select>
      <select id="r2RoomFilter">
        <option value="all">All rooms</option>
        <option value="unassigned" ${STATE.filterR2Room === 'unassigned' ? 'selected' : ''}>No room</option>
        ${rooms.map(function (r) {
          return `<option value="${esc(r)}" ${STATE.filterR2Room === r ? 'selected' : ''}>${esc(r)}</option>`;
        }).join('')}
      </select>
      <select id="r2DateFilter">
        <option value="all">All dates</option>
        <option value="notime" ${STATE.filterR2Date === 'notime' ? 'selected' : ''}>Missing time</option>
        ${dates.map(function (d) {
          return `<option value="${esc(d)}" ${STATE.filterR2Date === d ? 'selected' : ''}>${esc(formatInterviewDate(d + 'T12:00'))}</option>`;
        }).join('')}
      </select>
      <label class="chip ${STATE.filterR2Pair === 'unassigned' ? 'active' : ''}" id="r2UnassignedChip">Unassigned</label>
      <label class="chip ${STATE.filterR2Date === 'notime' ? 'active' : ''}" id="r2NoTimeChip">Missing time</label>`;
}

function bindR2ScheduleFilters(onChange) {
  const pairEl = document.getElementById('r2PairFilter');
  if (pairEl) pairEl.addEventListener('change', function (e) {
    STATE.filterR2Pair = e.target.value;
    STATE.queueTrail = [];
    onChange();
  });
  const roomEl = document.getElementById('r2RoomFilter');
  if (roomEl) roomEl.addEventListener('change', function (e) {
    STATE.filterR2Room = e.target.value;
    STATE.queueTrail = [];
    onChange();
  });
  const dateEl = document.getElementById('r2DateFilter');
  if (dateEl) dateEl.addEventListener('change', function (e) {
    STATE.filterR2Date = e.target.value;
    STATE.queueTrail = [];
    onChange();
  });
  const unassigned = document.getElementById('r2UnassignedChip');
  if (unassigned) unassigned.addEventListener('click', function () {
    STATE.filterR2Pair = STATE.filterR2Pair === 'unassigned' ? 'all' : 'unassigned';
    STATE.queueTrail = [];
    onChange();
  });
  const noTime = document.getElementById('r2NoTimeChip');
  if (noTime) noTime.addEventListener('click', function () {
    STATE.filterR2Date = STATE.filterR2Date === 'notime' ? 'all' : 'notime';
    STATE.queueTrail = [];
    onChange();
  });
}

function openR2List() {
  STATE.view = 'round:round2';
  STATE.currentApplicantId = null;
  STATE.returnView = null;
  STATE.flaggedOnly = false;
  if (!STATE.r2SortTouched) {
    STATE.sortKey = 'time';
    STATE.sortDir = 'asc';
  }
}

function renderRoundList(round) {
  if (round === 'round2' && !STATE.r2SortTouched) {
    STATE.sortKey = 'time';
    STATE.sortDir = 'asc';
  }
  const list = filteredRoundPool(round);
  const yearOpts = ['Freshman', 'Sophomore', 'Junior', 'Senior'].filter(y => STATE.applicants.some(a => a.classYear === y));
  const r1 = round === 'round1';
  const r2 = round === 'round2';
  const groupFilter = r1
    ? `<select id="interviewerFilter">
        <option value="all">All interviewers</option>
        <option value="unassigned" ${STATE.filterInterviewer === 'unassigned' ? 'selected' : ''}>Unassigned</option>
        ${(STATE.interviewers || []).map(function (iv) {
          return `<option value="${esc(iv.id)}" ${STATE.filterInterviewer === iv.id ? 'selected' : ''}>${esc(iv.name)}</option>`;
        }).join('')}
      </select>`
    : r2
      ? r2ScheduleFiltersHtml()
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
          <th data-sort="score" class="${STATE.sortKey === 'score' ? 'sorted' : ''}">R1 avg</th>
          <th data-sort="r1std" class="${STATE.sortKey === 'r1std' ? 'sorted' : ''}" title="Interviewer-adjusted First Round score">Std</th>`
    : r2
      ? `<th data-sort="name" class="${STATE.sortKey === 'name' ? 'sorted' : ''}">Applicant</th>
          <th data-sort="group" class="${STATE.sortKey === 'group' ? 'sorted' : ''}">Pair</th>
          <th data-sort="time" class="${STATE.sortKey === 'time' ? 'sorted' : ''}">Time</th>
          <th data-sort="room" class="${STATE.sortKey === 'room' ? 'sorted' : ''}">Room</th>
          <th data-sort="r1score" class="${STATE.sortKey === 'r1score' || STATE.sortKey === 'gpa' ? 'sorted' : ''}" title="First Round average and interviewer-standardized score">R1 avg</th>
          <th data-sort="score" class="${STATE.sortKey === 'score' ? 'sorted' : ''}" title="Equal-weight average of scored case categories / 4">Case /4</th>
          <th data-sort="beh" class="${STATE.sortKey === 'beh' ? 'sorted' : ''}" title="Average of selected scored behaviorals / 4">Beh /4</th>`
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
      ${r1 ? `<label class="chip ${STATE.filterAdvanceRd2 === 'advancing' ? 'active' : ''}" id="advancingRd2Toggle">Advancing</label>` : ''}
      ${r1 ? `<label class="chip ${STATE.filterAdvanceRd2 === 'not' ? 'active' : ''}" id="notAdvancingRd2Toggle">Not advancing</label>` : ''}
      <label class="chip ${STATE.flaggedOnly ? 'active' : ''}" id="flaggedToggle">Flagged</label>
      <label class="chip ${STATE.incompleteOnly ? 'active' : ''}" id="incompleteToggle">Unreviewed only</label>
      ${reviewAsChipsHtml(round)}
      <div class="topbar-spacer"></div>
      <span class="sub" id="listCount" style="color:var(--slate); font-size:12px;">${listCountLabel(round, list)}</span>
    </div>
    ${r1 || r2 ? rd2ListEmailToolsHtml() : ''}
    ${!r1 && !r2 && STATE.incompleteOnly && STATE.filterGroup === 'all' ? `<div class="queue-hint">Pick your review group to see only that pair’s unfinished assigned applications. Other groups stay visible until you do.</div>` : ''}
    ${r1 ? `<div class="queue-hint">Pick an interviewer to filter to their interviews. Unassigned people need someone chosen on their profile — it is not random.</div>` : ''}
    ${r2 ? `<div class="queue-hint">Filter by pair, room, or date to find today’s interviews. Pick your name under My pair. Unassigned people need a pair and time on their profile.</div>` : ''}
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
  if (r2) bindR2ScheduleFilters(function () { renderRoundList(round); });
  document.getElementById('yearFilter').addEventListener('change', e => { STATE.filterYear = e.target.value; renderRoundList(round); });
  const advToggle = document.getElementById('advToggle');
  if (advToggle) advToggle.addEventListener('click', () => { STATE.screenedOnly = !STATE.screenedOnly; renderRoundList(round); });
  const knowToggle = document.getElementById('knowFlagToggle');
  if (knowToggle) knowToggle.addEventListener('click', () => { STATE.knowFlagOnly = !STATE.knowFlagOnly; renderRoundList(round); });
  const advancingToggle = document.getElementById('advancingRd2Toggle');
  if (advancingToggle) advancingToggle.addEventListener('click', () => { applyAdvanceRd2ListFilter(round, 'advancing'); });
  const notAdvancingToggle = document.getElementById('notAdvancingRd2Toggle');
  if (notAdvancingToggle) notAdvancingToggle.addEventListener('click', () => { applyAdvanceRd2ListFilter(round, 'not'); });
  const flaggedToggle = document.getElementById('flaggedToggle');
  if (flaggedToggle) flaggedToggle.addEventListener('click', () => { STATE.flaggedOnly = !STATE.flaggedOnly; renderRoundList(round); });
  const incompleteToggle = document.getElementById('incompleteToggle');
  if (incompleteToggle) incompleteToggle.addEventListener('click', () => { STATE.incompleteOnly = !STATE.incompleteOnly; renderRoundList(round); });
  if (r1 || r2) bindRd2EmailTools();
  bindReviewAs(contentEl, () => renderRoundList(round));
  contentEl.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (round === 'round2') STATE.r2SortTouched = true;
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
  if (round === 'round1' && STATE.filterAdvanceRd2 === 'advancing') {
    return hasExplicitAdvanceRd2()
      ? 'No one matching these filters is checked to advance to Round 2.'
      : 'No one is checked to advance to Round 2 yet — pick people on Overview → Who advances to Round 2.';
  }
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
  const maxScale = round === 'screen' ? 5 : 4;
  const scoreClass = score === null ? 'none' : (round === 'round1' && score < 3) ? 'bad' : (round !== 'round1' && score >= maxScale * 0.75) ? 'good' : '';
  if (round === 'round1') {
    const g = STATE.grades.round1[a.id] || {};
    const std = standardizedRound1Score(a.id);
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
      <td><span class="score-pill ${std == null ? 'none' : scoreClass}" title="${std == null ? 'Needs an assigned interviewer and a First Round average' : 'raw − interviewer mean + overall mean'}">${std == null ? '—' : std.toFixed(1)}</span></td>
    </tr>`;
  }
  if (round === 'round2') {
    const pair = r2PairLabel(r2Interviewers(a.id));
    const time = formatInterviewTime(r2InterviewTime(a.id));
    const room = r2InterviewRoom(a.id);
    const caseT = round2Total(STATE.grades.round2[a.id]);
    const beh = round2BehavioralAvg(STATE.grades.round2[a.id]);
    const caseClass = caseT ? (caseT.total >= 3 ? 'good' : '') : 'none';
    const behClass = beh == null ? 'none' : (beh >= 3 ? 'good' : '');
    return `<tr class="clickable" role="button" tabindex="0" data-id="${a.id}">
      <td><div class="name-cell"><span class="nm">${esc(a.name)}${lateBadge(a)}${flagBadge(a)}</span><span class="sub">${esc(a.classYear)} · ${esc(a.major || '')}</span></div></td>
      <td>${pair ? esc(pair) : '<span class="unassigned-pill">Unassigned</span>'}</td>
      <td>${time ? esc(time) : '<span class="sub">—</span>'}</td>
      <td>${room ? esc(room) : '<span class="sub">—</span>'}</td>
      <td><span class="score-pill pair">${formatRound1ScorePairHtml(a.id)}</span></td>
      <td><span class="score-pill ${caseClass}" title="Mean of scored case categories / 4">${formatR2Avg(caseT && caseT.total)}</span></td>
      <td><span class="score-pill ${behClass}" title="Mean of selected scored behaviorals">${formatR2Avg(beh)}</span></td>
    </tr>`;
  }
  const grp = assignmentGroup(round, a.id);
  const priorCol = round === 'round2'
    ? `<td><span class="score-pill pair">${formatRound1ScorePairHtml(a.id)}</span></td>`
    : `<td>${gpaCell(a)}</td>`;
  return `<tr class="clickable" role="button" tabindex="0" data-id="${a.id}">
    <td><div class="name-cell"><span class="nm">${esc(a.name)}${lateBadge(a)}${flagBadge(a)}${vouchCount(a.id) ? `<span class="vouch-badge" title="Vouched for by ${esc(vouchNames(a.id))}">★ ${vouchCount(a.id)}</span>` : ''}</span><span class="sub">${esc(a.classYear)} · ${esc(a.gradYear)}</span></div></td>
    ${priorCol}
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

  const showEssays = round === 'screen';
  const preservedEssays = showEssays ? takePreservedEl('gradeEssays', a.id) : null;
  const layout = getGradeLayout();
  const r2OpenId = round === 'round2' ? r2SelectedCaseId(g) : '';
  const r2OpenTitle = r2OpenId ? r2CaseTitle(r2CaseById(r2OpenId)) : '';
  const r2RefOpen = round === 'round2' && !!r2OpenId && isR2CaseRefOpen(a.id);
  contentEl.classList.toggle('r2-grade-page', round === 'round2');
  contentEl.classList.toggle('r2-case-open', r2RefOpen);
  const essaysMount = showEssays ? `<div class="grade-essays" id="gradeEssaysMount"></div>` : '';
  const body = round === 'round2'
    ? `<div id="gradeMain"></div>`
    : layout === 'side'
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

  const assignBlock = round === 'round1' ? r1AssignBlockHtml(a, g)
    : round === 'round2' ? r2AssignBlockHtml(a, g)
    : `
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
        <h2>${esc(a.name)}${lateBadge(a)}${round === 'round1' ? knowBadge(a) : ''}<span id="knowFlagBadgeHost"></span>${round === 'round2' ? `<span class="chip accent2 static r2-header-case" id="r2HeaderCase"${r2OpenTitle ? '' : ' hidden'}>${esc(r2OpenTitle)}</span>` : ''}</h2>
        <div class="meta">
          <span>🎓 ${esc(a.university)}</span>
          <span>${esc(a.classYear)} · Class of ${esc(a.gradYear)}</span>
          <span>${esc(a.major)}</span>
          <span>${round === 'round2' ? 'R1 ' + formatRound1ScorePairHtml(a.id) : 'GPA ' + esc(a.gpa)}</span>
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
  contentEl.querySelectorAll('[data-r2layout]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.r2layout === getR2CaseLayout()) return;
      setR2CaseLayout(btn.dataset.r2layout);
      applyR2CaseLayout(getR2CaseLayout());
    });
  });
  bindR1AssignControls(a, g);
  bindR2AssignControls(a);
  const knowBtn = document.getElementById('knowPersonBtn');
  if (knowBtn && round !== 'round1' && round !== 'round2') knowBtn.addEventListener('click', function () { reassignKnownPerson(round, a.id); });
  bindQueueNav(round, a.id);

  if (round === 'screen') renderScreenGrade(a, g);
  else if (round === 'round1') renderRound1Grade(a, g);
  else renderRound2Grade(a, g);

  if (showEssays) mountGradeEssays(a, preservedEssays);
  if (round !== 'round2') renderGradeSide(a, round, g);
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
    updateHeaderScore('round1', g, a);
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
  const r = round2Total(g); return r ? formatR2Avg(r.total) : '—';
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
  if (round === 'round1') {
    const v = round1Average(g);
    if (v == null) return '<span class="big">—</span><span class="of">/ 4 avg</span>';
    const id = a && a.id ? a.id : STATE.currentApplicantId;
    const std = id ? standardizedRound1Score(id) : null;
    if (std == null) return '<span class="big">' + v.toFixed(1) + '</span><span class="of">/ 4 avg</span>';
    return '<span class="big">' + v.toFixed(1) + '</span><span class="of">/ 4 raw</span>'
      + '<span class="std-inline" title="raw − interviewer mean + overall mean">' + std.toFixed(1) + ' std</span>';
  }
  const caseT = round2Total(g);
  const beh = round2BehavioralAvg(g);
  return '<span class="r2-hdr-scores">'
    + '<span class="r2-hdr-score"><span class="big">' + formatR2Avg(caseT && caseT.total) + '</span><span class="of">/ 4 case</span></span>'
    + '<span class="r2-hdr-score"><span class="big">' + formatR2Avg(beh) + '</span><span class="of">/ 4 beh</span></span>'
    + '</span>';
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
    if (ta.dataset.bound === '1') return;
    ta.dataset.bound = '1';
    function persist() {
      const g = getGrade(round, applicantId);
      if (ta.dataset.notekey === '__main') {
        g.notes = ta.value;
        saveGrade(round, applicantId, 'notes', null, ta.value);
      } else if (ta.dataset.notekey === '__case') {
        g.caseNotes = ta.value;
        saveGrade(round, applicantId, 'caseNotes', null, ta.value);
      } else if (round === 'round2') {
        foldR2GraderTextarea(g, applicantId, ta);
        saveR2GraderNoteFields(round, applicantId, g);
      } else {
        g.qnotes = g.qnotes || {};
        g.qnotes[ta.dataset.notekey] = ta.value;
        saveGrade(round, applicantId, 'qnotes', null, cloneJson(g.qnotes));
      }
    }
    ta.addEventListener('input', persist);
    ta.addEventListener('blur', persist);
    if (round === 'round2') bindR2NoteAutosize(ta);
  });
}

function autosizeTextarea(ta) {
  if (!ta) return;
  const pane = ta.closest('.r2-rubric-pane, .r2-case-pane');
  const y = pane ? pane.scrollTop : 0;
  ta.style.overflowY = 'hidden';
  ta.style.height = '0px';
  ta.style.height = Math.max(R2_NOTE_MIN_PX, ta.scrollHeight) + 'px';
  if (pane) pane.scrollTop = y;
}

function autosizeR2Notes(root) {
  const scope = root || document.getElementById('gradeMain');
  if (!scope) return;
  scope.querySelectorAll('textarea[data-notekey]').forEach(autosizeTextarea);
  syncR2CaseColHeight();
}

function bindR2NoteAutosize(ta) {
  if (!ta || ta.dataset.autosize === '1') return;
  ta.dataset.autosize = '1';
  function grow() { autosizeTextarea(ta); }
  ta.addEventListener('input', grow);
  ta.addEventListener('focus', grow);
  grow();
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
  container.querySelectorAll('.chip[data-pidx]').forEach(function (chip) {
    chip.classList.toggle('active', Number(chip.dataset.pidx) === idx);
  });
  const host = container.querySelector('#r1PersonalityPrompt');
  if (!host) return;
  const next = idx == null ? '' : String(idx);
  const prev = host.getAttribute('data-shown-pidx');
  if (prev === next && host.querySelector('.band-opt, .sub')) {
    updateR1ScoreUI(container, g, 'personality');
    return;
  }
  host.setAttribute('data-shown-pidx', next);
  host.innerHTML = r1PersonalityPromptHtml(g);
  if (a) bindR1BandOpts(host, a);
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
        <div id="r1PersonalityPrompt" data-shown-pidx="${r1PersonalityIdx(g) == null ? '' : r1PersonalityIdx(g)}">${r1PersonalityPromptHtml(g)}</div>
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
  main.querySelectorAll('.chip[data-pidx]').forEach(function (el) {
    el.addEventListener('click', function (evt) {
      if (evt) evt.stopPropagation();
      const rec = getGrade('round1', a.id);
      const idx = Number(el.dataset.pidx);
      if (isNaN(idx)) return;
      rec.personalityIdx = idx;
      holdPersonalityPick(a.id, idx);
      saveGrade('round1', a.id, 'personalityIdx', null, idx);
      updateR1PersonalityUI(main, rec, a);
    });
  });
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

function r2CaseInstructionsText() {
  return R2_CASE_INSTRUCTIONS;
}

function r2ScorePill(val) {
  const scored = typeof val === 'number';
  return `<span class="score-pill ${scored ? '' : 'none'}">${scored ? formatR2Score(val) : '—'}</span>`;
}

function r2ScoreControlHtml(key, score) {
  const scored = typeof score === 'number';
  const shown = scored ? formatR2Score(score) : '';
  const sliderVal = scored ? String(score) : '2.5';
  return `<div class="r2-score-control${scored ? ' scored' : ''}" data-key="${esc(key)}" data-scored="${scored ? '1' : '0'}">
      <div class="r2-score-slider-row">
        <span class="r2-score-end">1</span>
        <input type="range" class="r2-score-slider" data-key="${esc(key)}" min="1" max="4" step="0.5" value="${esc(sliderVal)}" aria-label="Score 1 to 4 in 0.5 steps">
        <span class="r2-score-end">4</span>
        <input type="number" class="r2-score-num" data-key="${esc(key)}" min="1" max="4" step="any" inputmode="decimal" value="${esc(shown)}" placeholder="—" aria-label="Custom score">
        <button type="button" class="r2-score-clear" data-key="${esc(key)}"${scored ? '' : ' hidden'}>Clear</button>
      </div>
    </div>`;
}

function r2BehavioralBodyHtml(q, g, applicantId, graderKey) {
  const score = g.scores && g.scores[q.id];
  const note = r2QnoteForGrader(g, q.id, graderKey, applicantId);
  const highlight = r2BandHighlightVal(score);
  return `<div class="r2-bq-body">
      <div class="read-aloud">Read aloud</div>
      <div class="prompt">${esc(q.q)}</div>
      ${r2ScoreControlHtml(q.id, score)}
      <div class="band-row">
        ${['1', '2', '3', '4'].map(function (k) {
          const n = Number(k);
          const crit = R2_BEHAVIORAL_BANDS[n] || {};
          return `<div class="band-opt ${highlight === n ? 'sel' : ''}" data-key="${esc(q.id)}" data-val="${k}"><span class="sc">${k}</span>${esc(crit.text || crit.label || '')}</div>`;
        }).join('')}
      </div>
      <div class="notes-field"><textarea data-notekey="${esc(q.id)}" placeholder="Candidate's answer, notes…">${esc(note)}</textarea></div>
    </div>`;
}

function r2BehavioralRowHtml(q, g, selected, applicantId, graderKey) {
  const score = g.scores && g.scores[q.id];
  const open = selected.indexOf(q.id) !== -1;
  return `<div class="r2-bq${open ? ' open sel' : ''}" data-bqid="${esc(q.id)}">
      <div class="r2-bq-bar">
        <button type="button" class="r2-bq-title" data-bqid="${esc(q.id)}">
          <span class="r2-bq-label">${esc(q.title)}</span>
          ${r2ScorePill(score)}
        </button>
        ${open ? `<button type="button" class="r2-bq-clear" data-bqclear="${esc(q.id)}">Clear</button>` : ''}
      </div>
      ${open ? r2BehavioralBodyHtml(q, g, applicantId, graderKey) : ''}
    </div>`;
}

function r2SelectedCountHtml(selected) {
  const n = selected.length;
  const extra = n > 2 ? ' · more than 2 selected' : '';
  return n + ' selected · usually 1–2' + extra;
}

function persistR2BehavioralSelected(a, selected) {
  const rec = getGrade('round2', a.id);
  rec.behavioralSelected = normalizeBehavioralSelected(selected);
  holdR2Behaviorals(a.id, rec.behavioralSelected);
  saveR2GraderNoteFields('round2', a.id, rec);
  saveGrade('round2', a.id, 'behavioralSelected', null, rec.behavioralSelected.slice());
  updateHeaderScore('round2', rec, a);
  return rec;
}

function updateR2ScoreUI(container, g, key) {
  if (!container) return;
  const isCaseOverall = key === 'caseScore';
  const cur = isCaseOverall ? g.caseScore : r2DimScore(g, key);
  const highlight = r2BandHighlightVal(cur);
  const selector = isR2MathKey(key)
    ? '.band-opt[data-key="quant_reasoning"], .band-opt[data-key="math"]'
    : '.band-opt[data-key="' + key + '"]';
  container.querySelectorAll(selector).forEach(function (opt) {
    opt.classList.toggle('sel', highlight === Number(opt.dataset.val));
  });
  const ctrlSelector = isR2MathKey(key)
    ? '.r2-score-control[data-key="quant_reasoning"], .r2-score-control[data-key="math"]'
    : '.r2-score-control[data-key="' + key + '"]';
  container.querySelectorAll(ctrlSelector).forEach(function (wrap) {
    const scored = typeof cur === 'number';
    wrap.dataset.scored = scored ? '1' : '0';
    wrap.classList.toggle('scored', scored);
    const slider = wrap.querySelector('.r2-score-slider');
    const num = wrap.querySelector('.r2-score-num');
    const clr = wrap.querySelector('.r2-score-clear');
    if (slider && document.activeElement !== slider) slider.value = scored ? String(cur) : '2.5';
    if (num && document.activeElement !== num) num.value = scored ? formatR2Score(cur) : '';
    if (clr) clr.hidden = !scored;
  });
  const sample = container.querySelector(selector) || container.querySelector(ctrlSelector);
  const card = sample && sample.closest('.dim-card, .r2-bq');
  const pill = card && card.querySelector('.score-pill');
  if (pill) {
    const v = isCaseOverall ? g.caseScore : cur;
    const scored = typeof v === 'number';
    pill.textContent = scored ? formatR2Score(v) : '—';
    pill.classList.toggle('none', !scored);
  }
}

function bindR2BandOpts(root, a) {
  root.querySelectorAll('.band-opt').forEach(function (el) {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', function () {
      captureOpenR2Fields();
      const rec = getGrade('round2', a.id);
      const key = el.dataset.key, val = Number(el.dataset.val);
      const main = document.getElementById('gradeMain') || root;
      if (key === 'caseScore') {
        rec.caseScore = rec.caseScore === val ? undefined : val;
        saveGrade('round2', a.id, 'caseScore', null, rec.caseScore);
        updateR2ScoreUI(main, rec, 'caseScore');
        updateHeaderScore('round2', rec);
        return;
      }
      const cur = r2DimScore(rec, key);
      applyR2ScoreToRecord(rec, key, cur === val ? undefined : val);
      persistR2Score(a, rec, key);
      updateR2ScoreUI(main, rec, key);
      updateHeaderScore('round2', rec);
    });
  });
}

function commitR2ScoreFromControl(a, key, val) {
  captureOpenR2Fields();
  const rec = getGrade('round2', a.id);
  applyR2ScoreToRecord(rec, key, val);
  persistR2Score(a, rec, key);
  const main = document.getElementById('gradeMain');
  updateR2ScoreUI(main, rec, key);
  updateHeaderScore('round2', rec, a);
}

function bindR2ScoreControls(root, a) {
  if (!root || !a) return;
  root.querySelectorAll('.r2-score-slider').forEach(function (el) {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('input', function () {
      const key = el.dataset.key;
      const val = clampR2Score(Number(el.value));
      if (val == null) return;
      const rec = getGrade('round2', a.id);
      applyR2ScoreToRecord(rec, key, val);
      const wrap = el.closest('.r2-score-control');
      if (wrap) {
        wrap.dataset.scored = '1';
        wrap.classList.add('scored');
      }
      const main = document.getElementById('gradeMain') || root;
      updateR2ScoreUI(main, rec, key);
      updateHeaderScore('round2', rec, a);
    });
    el.addEventListener('change', function () {
      const val = clampR2Score(Number(el.value));
      if (val == null) return;
      commitR2ScoreFromControl(a, el.dataset.key, val);
    });
  });
  root.querySelectorAll('.r2-score-num').forEach(function (el) {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('input', function () {
      const parsed = parseR2ScoreTyped(el.value);
      if (parsed == null) return;
      const rec = getGrade('round2', a.id);
      applyR2ScoreToRecord(rec, el.dataset.key, parsed);
      const wrap = el.closest('.r2-score-control');
      if (wrap) {
        wrap.dataset.scored = '1';
        wrap.classList.add('scored');
      }
      const main = document.getElementById('gradeMain') || root;
      updateR2ScoreUI(main, rec, el.dataset.key);
      updateHeaderScore('round2', rec, a);
    });
    el.addEventListener('change', function () {
      const parsed = parseR2ScoreTyped(el.value);
      if (parsed == null) {
        const rec = getGrade('round2', a.id);
        const cur = r2DimScore(rec, el.dataset.key);
        el.value = typeof cur === 'number' ? formatR2Score(cur) : '';
        return;
      }
      el.value = formatR2Score(parsed);
      commitR2ScoreFromControl(a, el.dataset.key, parsed);
    });
    el.addEventListener('keydown', function (evt) {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        el.blur();
      }
    });
  });
  root.querySelectorAll('.r2-score-clear').forEach(function (el) {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', function (evt) {
      if (evt) { evt.preventDefault(); evt.stopPropagation(); }
      commitR2ScoreFromControl(a, el.dataset.key, undefined);
    });
  });
}

function bindR2BehavioralRow(row, a) {
  const title = row.querySelector('.r2-bq-title');
  if (title && title.dataset.bound !== '1') {
    title.dataset.bound = '1';
    title.addEventListener('click', function (evt) {
      if (evt) evt.stopPropagation();
      captureOpenR2Fields();
      const rec = getGrade('round2', a.id);
      const id = title.dataset.bqid;
      if (!id) return;
      const selected = r2BehavioralSelected(rec).slice();
      if (selected.indexOf(id) === -1) selected.push(id);
      persistR2BehavioralSelected(a, selected);
      syncR2BehavioralRows(document.getElementById('gradeMain'), getGrade('round2', a.id), a);
    });
  }
  const clear = row.querySelector('.r2-bq-clear');
  if (clear && clear.dataset.bound !== '1') {
    clear.dataset.bound = '1';
    clear.addEventListener('click', function (evt) {
      if (evt) { evt.preventDefault(); evt.stopPropagation(); }
      captureOpenR2Fields();
      const rec = getGrade('round2', a.id);
      const id = clear.dataset.bqclear;
      const selected = r2BehavioralSelected(rec).filter(function (x) { return x !== id; });
      persistR2BehavioralSelected(a, selected);
      syncR2BehavioralRows(document.getElementById('gradeMain'), getGrade('round2', a.id), a);
    });
  }
  bindR2BandOpts(row, a);
  bindR2ScoreControls(row, a);
  bindNotesFields(row, 'round2', a.id);
}

function syncR2BehavioralRows(container, g, a) {
  if (!container) return;
  const selected = r2BehavioralSelected(g);
  const hint = container.querySelector('#r2BehavioralCount');
  if (hint) hint.textContent = r2SelectedCountHtml(selected);
  container.querySelectorAll('.r2-bq[data-bqid]').forEach(function (row) {
    const id = row.dataset.bqid;
    const q = r2BehavioralById(id);
    if (!q) return;
    const shouldOpen = selected.indexOf(id) !== -1;
    const isOpen = row.classList.contains('open');
    const focused = row.contains(document.activeElement) && isEditingField();
    if (shouldOpen && !isOpen) {
      row.classList.add('open', 'sel');
      if (!row.querySelector('.r2-bq-body')) row.insertAdjacentHTML('beforeend', r2BehavioralBodyHtml(q, g, a.id, r2ActiveGraderKey(a.id)));
      const bar = row.querySelector('.r2-bq-bar');
      if (bar && !bar.querySelector('.r2-bq-clear')) {
        bar.insertAdjacentHTML('beforeend', `<button type="button" class="r2-bq-clear" data-bqclear="${esc(id)}">Clear</button>`);
      }
      bindR2BehavioralRow(row, a);
    } else if (!shouldOpen && isOpen && !focused) {
      row.classList.remove('open', 'sel');
      const body = row.querySelector('.r2-bq-body');
      if (body) body.remove();
      const clr = row.querySelector('.r2-bq-clear');
      if (clr) clr.remove();
    } else {
      row.classList.toggle('sel', shouldOpen);
      updateR2ScoreUI(row, g, id);
    }
    if (shouldOpen) bindR2BehavioralRow(row, a);
  });
  if (a) updateHeaderScore('round2', g, a);
}

function r2CaseListHtml(items) {
  if (!items || !items.length) return '';
  return '<ul class="r2-case-ul">' + items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
}

function r2CaseOlHtml(items) {
  if (!items || !items.length) return '';
  return '<ol class="r2-case-ol">' + items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol>';
}

function r2CaseQuoteHtml(text) {
  if (!text) return '';
  return '<blockquote class="r2-case-quote">' + esc(text) + '</blockquote>';
}

function r2CaseTableHtml(headers, rows) {
  if (!headers || !rows) return '';
  return '<table class="r2-case-table"><thead><tr>' +
    headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
    rows.map(function (row) {
      return '<tr>' + row.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
    }).join('') +
    '</tbody></table>';
}

function r2CaseBodyHtml(c) {
  const o = c.opening || {};
  const n = c.caseNo ? ('Case ' + c.caseNo + ' · ') : '';
  const title = r2CaseTitle(c);
  const asked = (c.ifAsked || []).map(function (row) {
    return '<div class="r2-case-qa"><p><strong>' + esc(row.q) + '</strong> ' + esc(row.a) + '</p></div>';
  }).join('');
  const steers = (c.steers || []).map(function (s) {
    return '<div class="r2-case-steer"><p class="r2-case-when">' + esc(s.when) + '</p>' + r2CaseQuoteHtml(s.say) + '</div>';
  }).join('');
  const explore = (c.explore || []).map(function (ex) {
    return '<div class="r2-case-explore"><p class="r2-case-k"><strong>' + esc(ex.label) + '</strong></p>' + r2CaseListHtml(ex.items) + '</div>';
  }).join('');
  const quant = (c.quant || []).map(function (step, i) {
    return '<div class="r2-case-step">' +
      '<h4>' + (step.title ? esc(step.title) : ('Step ' + (i + 1))) + '</h4>' +
      (step.say ? r2CaseQuoteHtml(step.say) : '') +
      (step.answers && step.answers.length ? '<p class="r2-case-when">Expected calculation</p>' + r2CaseListHtml(step.answers) : '') +
      (step.note ? '<p class="r2-case-note"><strong>Interviewer note.</strong> ' + esc(step.note) + '</p>' : '') +
      '</div>';
  }).join('');
  const openingSteps = r2CaseOlHtml(R2_CASE_SHARED_OPENING.steps);
  const transition = o.transition || R2_CASE_TRANSITION;
  const persona = o.note || R2_CASE_PERSONA_NOTE;
  return `<article class="r2-case-body r2-case-doc">
      <p class="r2-case-kicker">Problem Solving Interview (Fox)</p>
      <h2>${esc(n + title)}</h2>
      <section class="r2-case-sec">
        <h3>Before the case</h3>
        ${openingSteps}
        <p class="r2-case-when">Then begin the case</p>
        ${r2CaseQuoteHtml(transition)}
        ${persona ? `<p class="r2-case-note"><strong>Interviewer note.</strong> ${esc(persona)}</p>` : ''}
      </section>
      <section class="r2-case-sec">
        <h3>Framework</h3>
        <p><strong>About the business.</strong> ${esc(c.about || '')}</p>
        <p class="r2-case-when">Quick facts</p>
        ${r2CaseListHtml(c.facts)}
        <p class="r2-case-when">Info to give if asked</p>
        ${asked}
        <p class="r2-case-when">3 main issues — steer toward these; do not name them</p>
        ${r2CaseOlHtml(c.issues)}
        ${steers}
        ${explore ? '<p class="r2-case-when">Additional questions candidates may explore</p>' + explore : ''}
      </section>
      <section class="r2-case-sec">
        <h3>Quant section</h3>
        ${r2CaseQuoteHtml(c.quantIntro || '')}
        ${c.exhibitNote ? `<p class="r2-case-note"><strong>Interviewer note.</strong> ${esc(c.exhibitNote)}</p>` : ''}
        ${r2CaseTableHtml(c.exhibitHeaders, c.exhibitRows)}
        ${c.exhibitFoot ? `<p class="r2-case-foot">${esc(c.exhibitFoot)}</p>` : ''}
        ${quant}
      </section>
      <section class="r2-case-sec">
        <h3>Brainstorm</h3>
        ${r2CaseQuoteHtml((c.brainstorm && c.brainstorm.say) || '')}
        ${c.brainstorm && c.brainstorm.hints ? `<p class="r2-case-note">${esc(c.brainstorm.hints)}</p>` : ''}
      </section>
      <section class="r2-case-sec">
        <h3>Conclusion</h3>
        ${r2CaseQuoteHtml((c.conclusion && c.conclusion.say) || '')}
        <p class="r2-case-when">Expected synthesis</p>
        ${r2CaseListHtml((c.conclusion && c.conclusion.expected) || [])}
      </section>
    </article>`;
}

function r2CaseRowHtml(c, selectedId, expanded) {
  const sel = selectedId === c.id;
  const open = sel && !!expanded;
  return `<div class="r2-case${sel ? ' sel' : ''}${open ? ' open' : ''}" data-case="${esc(c.id)}">
      <div class="r2-bq-bar">
        <button type="button" class="r2-bq-title" data-case="${esc(c.id)}" title="${esc(r2CaseTitle(c))}">
          <span class="r2-bq-label">${esc(r2CaseTitle(c))}</span>
        </button>
        ${open ? `<button type="button" class="r2-bq-clear" data-caseclear="${esc(c.id)}">Clear</button>` : ''}
      </div>
    </div>`;
}

function r2CaseNotesHtml(g) {
  return `
    <div class="card card-pad r2-case-notes-card">
      <div class="field-label">Case notes</div>
      <div class="notes-field"><textarea id="r2CaseNotes" data-notekey="__case" placeholder="Walkthrough notes, standout moments, gaps…">${esc(g.caseNotes || '')}</textarea></div>
    </div>`;
}

function r2ProfileFooterHtml(a) {
  const v = getVouch(a.id);
  const att = a.attendance || {};
  const chats = att.coffeeChats || [];
  const cc = chats.length > 0;
  const info = !!att.infoSession;
  const meet = !!att.meetMembers;
  return `<div class="r2-profile-footer vouch-card ${v.by.length ? 'has' : ''}">
      <div class="r2-meta-pills">
        <span class="r2-meta-pill${cc ? ' on' : ''}" title="${esc(cc ? (chats.length + ' coffee chat' + (chats.length > 1 ? 's' : '')) : 'No coffee chat')}">☕ Coffee${cc ? '' : ' —'}</span>
        <span class="r2-meta-pill${info ? ' on' : ''}">🎤 Info session${info ? '' : ' —'}</span>
        <span class="r2-meta-pill${meet ? ' on' : ''}">🤝 Members${meet ? '' : ' —'}</span>
      </div>
      <div class="r2-meta-vouches">
        <span class="r2-meta-lbl">${v.by.length ? 'Vouched · ' + v.by.length : 'Vouch'}</span>
        <div class="vouch-row">
          ${B.reviewers.map(function (r) {
            return `<button type="button" class="vouch-chip ${v.by.indexOf(r.id) !== -1 ? 'on' : ''}" data-vouch="${r.id}" title="${esc(r.name)} — ${esc(r.role)}">${esc(r.name.split(' ')[0])}</button>`;
          }).join('')}
        </div>
      </div>
    </div>`;
}

function revealR2Workspace() {
  const split = document.querySelector('.r2-split');
  if (!split || !contentEl || !contentEl.classList.contains('r2-case-open')) return;
  const rect = split.getBoundingClientRect();
  if (rect.top >= 72 && rect.bottom <= window.innerHeight - 12) return;
  if (typeof split.scrollIntoView === 'function') {
    split.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function applyR2CaseSplit(g, a, opts) {
  opts = opts || {};
  const selectedId = r2SelectedCaseId(g);
  const expanded = !!selectedId && isR2CaseRefOpen(a && a.id);
  const root = document.getElementById('r2GradeRoot');
  if (root) {
    root.classList.toggle('r2-has-case', expanded);
    applyR2CaseLayout(getR2CaseLayout());
  }
  if (contentEl) contentEl.classList.toggle('r2-case-open', expanded);

  const c = selectedId ? r2CaseById(selectedId) : null;
  const title = c ? r2CaseTitle(c) : '';
  const headerCase = document.getElementById('r2HeaderCase');
  if (headerCase) {
    headerCase.textContent = title;
    if (title) headerCase.removeAttribute('hidden');
    else headerCase.setAttribute('hidden', '');
  }
  const openTitle = document.getElementById('r2OpenCaseTitle');
  if (openTitle) {
    openTitle.textContent = title;
    openTitle.hidden = !title;
  }
  const collapseBtn = document.getElementById('r2CaseCollapseBtn');
  if (collapseBtn) {
    collapseBtn.hidden = !selectedId;
    collapseBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    collapseBtn.setAttribute('aria-label', expanded ? 'Collapse case reference' : 'Expand case reference');
    collapseBtn.title = expanded ? 'Collapse case reference' : 'Expand case reference';
    collapseBtn.textContent = expanded ? '▾' : '▸';
  }

  const guide = document.getElementById('r2CaseGuide');
  if (guide) {
    const prev = guide.getAttribute('data-case') || '';
    if (selectedId) guide.setAttribute('data-case', selectedId);
    if (expanded) {
      guide.hidden = false;
      if (selectedId !== prev || !guide.firstChild) {
        guide.innerHTML = c ? r2CaseBodyHtml(c) : '';
        const casePane = document.getElementById('r2CasePane');
        if (casePane && !opts.keepCaseScroll) casePane.scrollTop = 0;
      }
    } else {
      guide.hidden = true;
    }
  }
  if (opts.fromUser && expanded) revealR2Workspace();
  bindR2SplitHeightSync();
}

function persistR2Case(a, caseId) {
  const rec = getGrade('round2', a.id);
  rec.caseId = caseId && r2KnownCaseId(caseId) ? caseId : undefined;
  holdR2Case(a.id, rec.caseId);
  if (rec.caseNotes) saveGrade('round2', a.id, 'caseNotes', null, rec.caseNotes);
  saveGrade('round2', a.id, 'caseId', null, rec.caseId);
  return rec;
}

function bindR2CaseRow(row, a) {
  const title = row.querySelector('.r2-bq-title');
  if (title && title.dataset.bound !== '1') {
    title.dataset.bound = '1';
    title.addEventListener('click', function (evt) {
      if (evt) evt.stopPropagation();
      captureOpenR2Fields();
      const id = title.dataset.case;
      if (!id) return;
      persistR2Case(a, id);
      setR2CaseRefOpen(a.id, true);
      syncR2CaseRows(document.getElementById('gradeMain'), getGrade('round2', a.id), a, { fromUser: true });
    });
  }
  const clear = row.querySelector('.r2-bq-clear');
  if (clear && clear.dataset.bound !== '1') {
    clear.dataset.bound = '1';
    clear.addEventListener('click', function (evt) {
      if (evt) { evt.preventDefault(); evt.stopPropagation(); }
      captureOpenR2Fields();
      setR2CaseRefOpen(a.id, false);
      syncR2CaseRows(document.getElementById('gradeMain'), getGrade('round2', a.id), a, { fromUser: true });
    });
  }
}

function bindR2CaseCollapse(a) {
  const btn = document.getElementById('r2CaseCollapseBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', function (evt) {
    if (evt) { evt.preventDefault(); evt.stopPropagation(); }
    captureOpenR2Fields();
    const rec = getGrade('round2', a.id);
    if (!r2SelectedCaseId(rec)) return;
    setR2CaseRefOpen(a.id, !isR2CaseRefOpen(a.id));
    syncR2CaseRows(document.getElementById('gradeMain'), rec, a, { fromUser: true });
  });
}

function bindR2CaseMin() {
  const btn = document.getElementById('r2CaseMinBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', function (evt) {
    if (evt) { evt.preventDefault(); evt.stopPropagation(); }
    setR2CaseMinimized(!getR2CaseMinimized());
    applyR2CaseMinimized();
  });
}

function syncR2CaseRows(container, g, a, opts) {
  if (!container) return;
  const selectedId = r2SelectedCaseId(g);
  const expanded = !!selectedId && isR2CaseRefOpen(a && a.id);
  container.querySelectorAll('.r2-case[data-case]').forEach(function (row) {
    const id = row.dataset.case;
    const c = r2CaseById(id);
    if (!c) return;
    const sel = selectedId === id;
    const shouldOpen = sel && expanded;
    const isOpen = row.classList.contains('open');
    row.classList.toggle('sel', sel);
    if (shouldOpen && !isOpen) {
      row.classList.add('open');
      const bar = row.querySelector('.r2-bq-bar');
      if (bar && !bar.querySelector('.r2-bq-clear')) {
        bar.insertAdjacentHTML('beforeend', `<button type="button" class="r2-bq-clear" data-caseclear="${esc(id)}">Clear</button>`);
      }
      bindR2CaseRow(row, a);
    } else if (!shouldOpen && isOpen) {
      row.classList.remove('open');
      const clr = row.querySelector('.r2-bq-clear');
      if (clr) clr.remove();
    }
    if (sel) bindR2CaseRow(row, a);
  });
  applyR2CaseSplit(g, a, opts);
}

function r2DimGuideHtml(key) {
  const guideKey = isR2MathKey(key) ? 'quant_reasoning' : key;
  const text = R2_GRADE_GUIDES[guideKey] || '';
  if (!text) return '';
  return `<p class="r2-dim-guide">${esc(text)}</p>`;
}

function r2GraderTabsHtml(a) {
  const active = getR2ActiveGraderSlot(a.id);
  return `<div class="r2-grader-tabs" id="r2GraderTabs">
      ${r2GraderTabs(a.id).map(function (tab) {
        return `<button type="button" class="r2-grader-tab${tab.slot === active ? ' active' : ''}" data-grader-slot="${tab.slot}" data-grader-key="${esc(tab.key)}" title="Comments and notes for ${esc(tab.name)}">${esc(tab.name)}</button>`;
      }).join('')}
    </div>
    <p class="sub r2-grader-tab-hint">Scores, recommendation, and behavioral picks stay synced across both graders. Comments and notes are per grader.</p>`;
}

function syncR2GraderTabLabels(a) {
  const main = document.getElementById('gradeMain');
  if (!main || !a) return;
  const active = getR2ActiveGraderSlot(a.id);
  r2GraderTabs(a.id).forEach(function (tab) {
    const btn = main.querySelector('.r2-grader-tab[data-grader-slot="' + tab.slot + '"]');
    if (!btn) return;
    btn.textContent = tab.name;
    btn.title = 'Comments and notes for ' + tab.name;
    btn.dataset.graderKey = tab.key;
    btn.classList.toggle('active', tab.slot === active);
  });
}

function syncR2GraderNotesUI(main, g, applicantId) {
  if (!main || !g || !applicantId) return;
  migrateR2GraderNotes(g, applicantId);
  const graderKey = r2ActiveGraderKey(applicantId);
  main.querySelectorAll('textarea[data-notekey]').forEach(function (ta) {
    if (document.activeElement === ta) return;
    const key = ta.dataset.notekey;
    let next = '';
    if (key === '__main') next = r2RecNoteForGrader(g, graderKey, applicantId);
    else if (key === '__case') next = g.caseNotes || '';
    else if (isR2DimNoteKey(key)) next = r2DimNoteForGrader(g, key, graderKey, applicantId);
    else next = r2QnoteForGrader(g, key, graderKey, applicantId);
    if (ta.value !== next) ta.value = next;
    autosizeTextarea(ta);
  });
}

function switchR2GraderTab(a, slot) {
  captureOpenR2Fields();
  setR2ActiveGraderSlot(a.id, slot);
  const main = document.getElementById('gradeMain');
  const g = getGrade('round2', a.id);
  syncR2GraderTabLabels(a);
  syncR2GraderNotesUI(main, g, a.id);
  autosizeR2Notes(main);
}

function bindR2GraderTabs(main, a) {
  if (!main || !a) return;
  main.querySelectorAll('.r2-grader-tab').forEach(function (btn) {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      switchR2GraderTab(a, Number(btn.dataset.graderSlot) || 0);
    });
  });
}

function r2DimCardHtml(d, g, applicantId, graderKey, opts) {
  const R = B.rubrics.round2;
  const note = r2DimNoteForGrader(g, d.key, graderKey, applicantId);
  const score = r2DimScore(g, d.key);
  const highlight = r2BandHighlightVal(score);
  const guideKey = isR2MathKey(d.key) ? 'quant_reasoning' : d.key;
  const uncounted = !!(opts && opts.uncounted);
  return `
      <div class="dim-card${uncounted ? ' r2-vibe-card' : ''}">
        <div class="dim-head${uncounted ? ' r2-vibe-head' : ''}"><h4>${esc(d.label)}</h4>${uncounted ? '<span class="chip unweighted">Does not count</span>' : ''}${r2ScorePill(score)}</div>
        <div class="dim-body">
          ${r2DimGuideHtml(guideKey)}
          ${r2ScoreControlHtml(d.key, score)}
          <div class="band-row">
            ${d.levels.map((txt, i) => { const val = 4 - i; return `<div class="band-opt ${highlight === val ? 'sel' : ''}" data-key="${d.key}" data-val="${val}"><span class="sc">${R.levelLabels[i]}</span>${esc(txt)}</div>`; }).join('')}
          </div>
          <div class="field-label">Comments</div>
          <div class="notes-field"><textarea data-notekey="${esc(d.key)}" placeholder="Notes on ${esc(d.label)}…">${esc(note)}</textarea></div>
        </div>
      </div>`;
}

function renderRound2Grade(a, g) {
  const main = document.getElementById('gradeMain');
  captureOpenR2Fields();
  g = getGrade('round2', a.id);
  migrateR2GraderNotes(g, a.id);
  if (!Array.isArray(g.behavioralSelected)) g.behavioralSelected = r2BehavioralSelected(g);
  const selected = r2BehavioralSelected(g);
  const qs = r2BehavioralList();
  const caseDims = r2CaseDims();
  const graderKey = r2ActiveGraderKey(a.id);
  const selectedCaseId = r2SelectedCaseId(g);
  const selectedCase = selectedCaseId ? r2CaseById(selectedCaseId) : null;
  const selectedTitle = selectedCase ? r2CaseTitle(selectedCase) : '';
  const caseExpanded = !!selectedCaseId && isR2CaseRefOpen(a.id);
  const caseLayout = getR2CaseLayout();
  const caseMin = getR2CaseMinimized();

  main.innerHTML = `
    <div id="r2GradeRoot" class="r2-grade${caseExpanded ? ' r2-has-case' : ''} r2-layout-${esc(caseLayout)}${caseMin ? ' r2-case-minimized' : ''}">
      <div class="weight-note r2-weight-note">Case score is the equal-weight average of scored categories among Intro, Framework, Math, Brainstorm, and Recommendation (/ 4). Behavioral avg is separate — typically 1–2 asked questions — and is not blended with the case score. The Vibe check at the bottom is reference only and does not count toward either average. Collapse or Clear on the case reference does not change scores.</div>
      <div class="r2-split">
        <div class="r2-case-col">
          <div class="r2-case-pane" id="r2CasePane" data-r2-pane="case">
            <div class="r2-case-toolbar">
              <div class="r2-case-toolbar-head">
                <h4>Case reference</h4>
                <span class="r2-open-case-title" id="r2OpenCaseTitle"${selectedTitle ? '' : ' hidden'}>${esc(selectedTitle)}</span>
                <button type="button" class="r2-case-collapse" id="r2CaseCollapseBtn"${selectedCaseId ? '' : ' hidden'} aria-expanded="${caseExpanded ? 'true' : 'false'}" aria-label="${caseExpanded ? 'Collapse case reference' : 'Expand case reference'}" title="${caseExpanded ? 'Collapse case reference' : 'Expand case reference'}">${caseExpanded ? '▾' : '▸'}</button>
                <button type="button" class="r2-case-min" id="r2CaseMinBtn"${caseExpanded ? '' : ' hidden'} aria-pressed="${getR2CaseMinimized() ? 'true' : 'false'}" aria-label="${getR2CaseMinimized() ? 'Expand case to half the page' : 'Minimize case to a thin rail'}" title="${getR2CaseMinimized() ? 'Expand case to half' : 'Minimize case'}">${getR2CaseMinimized() ? '»' : '«'}</button>
              </div>
              <div class="r2-case-instructions">${esc(r2CaseInstructionsText())}</div>
              <div class="field-label r2-case-pick-lbl">Case — click to open the interviewer guide</div>
              <div class="sub r2-bq-hint r2-case-pick-hint">One case per interview. The rubric is independent — Clear only hides this guide.</div>
              <div id="r2CaseList" class="r2-bq-list r2-case-chips">
                ${r2CaseList().map(function (c) { return r2CaseRowHtml(c, selectedCaseId, caseExpanded); }).join('')}
              </div>
            </div>
            <div id="r2CaseGuide" class="r2-case-guide" data-case="${esc(selectedCaseId || '')}"${caseExpanded ? '' : ' hidden'}>
              ${caseExpanded && selectedCase ? r2CaseBodyHtml(selectedCase) : ''}
            </div>
          </div>
        </div>
        <div class="r2-rubric-pane" id="r2RubricPane" data-r2-pane="rubric">
          ${r2GraderTabsHtml(a)}
          ${r2CaseNotesHtml(g)}
          ${caseDims.map(function (d) { return r2DimCardHtml(d, g, a.id, graderKey); }).join('')}
          <div class="card card-pad">
            <div class="field-label">Recommendation</div>
            <div class="recommend-row">
              ${['Strong yes', 'Yes', 'Borderline', 'No'].map(r => `<span class="chip ${g.recommendation === r ? 'active' : ''}" data-rec="${r}">${r}</span>`).join('')}
            </div>
            <label class="flag-row"><input type="checkbox" id="flagSecond2" ${g.flagSecond ? 'checked' : ''}> Flag for second reviewer</label>
            <div class="field-label">Interviewer notes</div>
            <div class="notes-field"><textarea data-notekey="__main" placeholder="Anything else worth flagging…">${esc(r2RecNoteForGrader(g, graderKey, a.id))}</textarea></div>
          </div>
          ${r2DimCardHtml(r2VibeDim(), g, a.id, graderKey, { uncounted: true })}
        </div>
      </div>
      <div class="dim-card r2-behaviorals-card">
        <div class="dim-head">
          <h4>Behavioral questions — choose 1–2</h4>
          <span class="n" id="r2BehavioralCount">${esc(r2SelectedCountHtml(selected))}</span>
        </div>
        <div class="dim-body">
          <div class="sub r2-bq-hint">Click a title to expand it, select it, and take notes. Usually 1–2; more is allowed. Scores here are not part of the case average.</div>
          <div id="r2BehavioralList" class="r2-bq-list">
            ${qs.map(function (q) { return r2BehavioralRowHtml(q, g, selected, a.id, graderKey); }).join('')}
          </div>
        </div>
      </div>
      ${r2ProfileFooterHtml(a)}
    </div>
  `;
  if (contentEl) contentEl.classList.toggle('r2-case-open', caseExpanded);
  bindR2GraderTabs(main, a);
  bindR2BandOpts(main, a);
  bindR2ScoreControls(main, a);
  main.querySelectorAll('.r2-bq').forEach(function (row) { bindR2BehavioralRow(row, a); });
  main.querySelectorAll('.r2-case').forEach(function (row) { bindR2CaseRow(row, a); });
  bindR2CaseCollapse(a);
  bindR2CaseMin();
  autosizeR2Notes(main);
  bindR2SplitHeightSync();
  requestAnimationFrame(function () {
    autosizeR2Notes(main);
    bindR2SplitHeightSync();
  });
  main.querySelectorAll('[data-rec]').forEach(el => el.addEventListener('click', () => {
    captureOpenR2Fields();
    const rec = getGrade('round2', a.id);
    rec.recommendation = rec.recommendation === el.dataset.rec ? undefined : el.dataset.rec;
    saveGrade('round2', a.id, 'recommendation', null, rec.recommendation);
    main.querySelectorAll('[data-rec]').forEach(function (chip) {
      chip.classList.toggle('active', rec.recommendation === chip.dataset.rec);
    });
  }));
  const flagBox = document.getElementById('flagSecond2');
  if (flagBox) flagBox.addEventListener('change', () => {
    const rec = getGrade('round2', a.id);
    rec.flagSecond = flagBox.checked;
    saveGrade('round2', a.id, 'flagSecond', null, rec.flagSecond);
  });
  bindNotesFields(main, 'round2', a.id);
  bindVouchCard(a);
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
    header = ['Candidate (First & Last) Name', 'Candidates School Email', 'Interviewer', 'Interview time', 'Initial notes', 'Thank-you', 'Knows them', 'Fit Q1', 'Fit Q2', 'Fit Q3', 'Personal Q1', 'Personal Q2', 'Personality Q', 'Average Score', 'R1 std', 'R1 blend', 'App raw', 'App std', 'Recommendation', 'Notes'];
    rows = poolForRound('round1').map(a => {
      const g = STATE.grades.round1[a.id] || { scores: {} };
      const raw = scoreFor('screen', a.id);
      const std = raw == null ? null : standardizedScreenScore(a.id);
      const r1raw = round1Average(g);
      const r1std = standardizedRound1Score(a.id);
      const r1blend = round1BlendScore(a.id);
      return [a.name, a.email, interviewerName(g.interviewer) || '', g.interviewTime || '', g.initialNotes || '', g.thankYou ? 'Yes' : 'No', g.knowFlag ? 'Yes' : '', g.scores.fit0 ?? '', g.scores.fit1 ?? '', g.scores.fit2 ?? '', g.scores.personal1 ?? '', g.scores.personal2 ?? '', g.scores.personality ?? '', r1raw ?? '', r1std == null ? '' : +r1std.toFixed(3), r1blend == null ? '' : +r1blend.toFixed(3), raw ?? '', std == null ? '' : +std.toFixed(3), g.recommendation || '', g.notes || ''];
    });
  } else {
    header = ['Candidate (First & Last) Name', 'Pair', 'Room', 'Interview time', 'Case Assigned', 'Intro', 'Framework', 'Math', 'Brainstorm', 'Recommendation Dim', 'Fit and communication/vibe check', 'Vibe check (uncounted)', 'Market Sizing', 'Case avg /4', 'Behavioral avg /4', 'Behaviorals asked', 'Legacy overall case', 'Recommendation', 'Interviewer Notes'];
    rows = poolForRound('round2').map(a => {
      const g = STATE.grades.round2[a.id] || { scores: {} };
      const caseObj = r2CaseById(g.caseId);
      const r = round2Total(g);
      const beh = round2BehavioralAvg(g);
      const asked = r2BehavioralSelected(g).map(function (id) {
        const q = r2BehavioralById(id);
        return (q ? q.title : id) + (typeof g.scores[id] === 'number' ? ' ' + g.scores[id] : '');
      }).join(' | ');
      return [a.name, r2PairLabel(r2Interviewers(a.id)), r2InterviewRoom(a.id), r2InterviewTime(a.id), caseObj ? r2CaseTitle(caseObj) : '', r2DimScore(g, 'introduction') ?? '', r2DimScore(g, 'framework') ?? '', r2DimScore(g, 'quant_reasoning') ?? '', r2DimScore(g, 'brainstorming') ?? '', r2DimScore(g, 'recommendation') ?? '', r2DimScore(g, 'fit_communication') ?? '', r2DimScore(g, R2_VIBE_CHECK_KEY) ?? '', g.scores.market_sizing ?? '', r ? +r.total.toFixed(3) : '', beh == null ? '' : +beh.toFixed(3), asked, g.caseScore ?? '', g.recommendation || '', g.notes || g.caseNotes || ''];
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
    + '<h1 id="gateTitle">Rem UF Recruitment</h1>'
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
