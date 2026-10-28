'use strict';

/**
 * Agent cognition layer.
 *
 * Two reasoning roles behind one interface:
 *
 *  1. `negotiate()` — the *advertiser* agent reads the page context, weighs the
 *     placement against its campaign objective and budget, and writes a
 *     natural-language case for buying it (or for declining).
 *  2. `assessAttention()` — the *verification* agent reads the telemetry as a
 *     behavioural signature and explains, in prose, why it does or does not
 *     look human.
 *
 * Providers
 * ---------
 *  - `AGENT_PROVIDER=local` (default) runs the deterministic reasoner below.
 *    This is a genuine reasoning step — feature extraction, weighted scoring,
 *    ranking, then prose assembled from those numbers — but it is *not* a
 *    neural network. Nothing it says is pre-written: every figure in the
 *    rationale comes from the page context and the signal report.
 *  - `AGENT_PROVIDER=openai|anthropic|gemini` sends the same task to a hosted
 *    model and parses a JSON reply. Any failure (no key, timeout, 4xx, bad
 *    JSON) falls back to the local reasoner and reports `fallback: true` with
 *    the error — a degraded call is never presented as a successful one.
 *
 * Token accounting is real for hosted models (taken from the API `usage`) and
 * estimated for the local reasoner (chars/4), always flagged `estimated`.
 *
 * Authority
 * ---------
 * The attention *verdict* stays with `heuristic.js`: a hosted model can explain
 * a session but cannot approve one. The AI layer is explanatory by design, so
 * the money decision remains deterministic and auditable.
 */

const config = require('./config');

/** Glyph for the configured currency, used by every prose amount below. */
const CUR = config.currencySymbol(config.currency);

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'you', 'your', 'we', 'our', 'they', 'their', 'how',
  'why', 'what', 'when', 'where', 'who', 'not', 'no', 'so', 'if', 'then', 'than',
  'into', 'over', 'after', 'before', 'about', 'more', 'most', 'can', 'will', 'just'
]);

/** Publication mastheads and editorial markers. */
const EDITORIAL_MARKERS = new Set([
  'courier', 'times', 'post', 'journal', 'gazette', 'magazine', 'review', 'press',
  'editorial', 'essay', 'longread', 'dispatch', 'column', 'feature', 'newsletter'
]);

const COMMERCE_MARKERS = new Set([
  'shop', 'store', 'pricing', 'price', 'sale', 'cart', 'checkout', 'deal', 'buy'
]);

/**
 * A deliberately tiny concept graph.
 *
 * Exact keyword overlap is too brittle to sound like understanding: a page
 * titled "The Courier" is obviously publishing inventory to a stationery brand,
 * but the words never coincide. Mapping tokens to a handful of categories lets
 * the agents reason about *category adjacency* while staying explainable — the
 * rationale names the concept it matched, and the graph is this table.
 */
const CONCEPT_VOCAB = Object.freeze({
  publishing: ['courier', 'journal', 'press', 'gazette', 'magazine', 'review', 'editorial', 'print', 'newsletter', 'dispatch', 'column'],
  reading: ['read', 'reader', 'reading', 'essay', 'longread', 'attention', 'focus', 'story', 'book', 'habit'],
  coffee: ['coffee', 'morning', 'brew', 'espresso', 'roast', 'caffeine'],
  audio: ['audio', 'headphone', 'listen', 'sound', 'quiet', 'music', 'battery'],
  home: ['home', 'desk', 'apartment', 'plant', 'garden', 'interior', 'space', 'starter'],
  optics: ['glass', 'lens', 'screen', 'light', 'vision', 'optical', 'eye'],
  stationery: ['note', 'notebook', 'paper', 'write', 'underline', 'stationery', 'culture', 'craft', 'workshop']
});

/** Stemmed concept lookup, built once so scoring stays cheap. */
const CONCEPT_INDEX = (() => {
  const index = new Map();
  for (const [concept, words] of Object.entries(CONCEPT_VOCAB)) {
    for (const word of words) {
      // Keys must be stemmed: `conceptsFor()` looks up already-tokenized text.
      const key = stem(word);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(concept);
    }
  }
  return index;
})();

function conceptsFor(tokens) {
  const found = new Set();
  for (const token of tokens) {
    const hit = CONCEPT_INDEX.get(token);
    if (hit) for (const concept of hit) found.add(concept);
  }
  return found;
}

function articleOf(word) {
  return /^[aeiou]/i.test(String(word)) ? 'an' : 'a';
}

/** "Terrace Greens'" vs "Lumen Audio's". */
function possessive(name) {
  return /s$/i.test(String(name)) ? `${name}'` : `${name}'s`;
}


/**
 * How well each campaign objective suits each page type.
 *
 * This is the part that makes the agents disagree: the same editorial placement
 * is a strong buy for reader-acquisition and a weak one for trial-signup, so
 * two agents legitimately reach different conclusions about identical traffic.
 */
const PAGE_AFFINITY = Object.freeze({
  editorial: Object.freeze({
    'reader-acquisition': 1.0,
    consideration: 0.7,
    'brand-awareness': 0.65,
    'direct-sale': 0.45,
    'trial-signup': 0.4,
    default: 0.6
  }),
  commerce: Object.freeze({
    'reader-acquisition': 0.4,
    consideration: 0.55,
    'brand-awareness': 0.5,
    'direct-sale': 1.0,
    'trial-signup': 0.85,
    default: 0.6
  }),
  general: Object.freeze({
    'reader-acquisition': 0.6,
    consideration: 0.6,
    'brand-awareness': 0.6,
    'direct-sale': 0.6,
    'trial-signup': 0.6,
    default: 0.6
  })
});

/** Vocabulary each objective tries to find on the page. */
const OBJECTIVE_LEXICON = Object.freeze({
  'reader-acquisition': ['read', 'reader', 'reading', 'story', 'essay', 'longform', 'coffee', 'morning', 'habit', 'subscription', 'weekly', 'deliver'],
  consideration: ['focus', 'work', 'deep', 'quiet', 'listen', 'audio', 'battery', 'session', 'headphone', 'screen'],
  'trial-signup': ['home', 'desk', 'apartment', 'plant', 'garden', 'small', 'space', 'trial', 'starter'],
  'direct-sale': ['glass', 'screen', 'light', 'reading', 'afternoon', 'collection', 'shop', 'lens'],
  'brand-awareness': ['note', 'notebook', 'paper', 'write', 'underline', 'press', 'craft', 'workshop', 'culture']
});

const DEFAULT_MODELS = Object.freeze({
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-1.5-flash'
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function pct(value, digits = 0) {
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Light stemmer: enough to match "reading"/"reads"/"read". */
function stem(word) {
  return String(word)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/(ing|ers|er|ies|es|ed|s)$/i, (match) => (match === 'ies' ? 'y' : ''))
    .slice(0, 24);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map(stem)
    .filter(Boolean);
}

/**
 * Token estimate used when no API reports usage. Four characters per token is
 * the standard rough ratio; it is labelled `estimated` everywhere it surfaces.
 */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function usageFrom(prompt, completion, { estimated, raw } = {}) {
  const promptTokens = raw?.promptTokens || estimateTokens(prompt);
  const completionTokens = raw?.completionTokens || estimateTokens(completion);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: Boolean(estimated),
    basis: estimated ? 'chars/4' : 'provider-usage'
  };
}

/* ------------------------------------------------------------------ */
/* Provider resolution                                                */
/* ------------------------------------------------------------------ */

function apiKeyFromEnv() {
  return (
    config.agent.apiKey ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  );
}

/**
 * Resolves the active provider once per call (env can change between boots).
 * A configured hosted provider without a key degrades to the local reasoner
 * and says why, instead of failing the negotiation.
 */
function resolveProvider() {
  const requested = String(config.agent.provider || 'local').toLowerCase();
  const key = apiKeyFromEnv();

  if (requested === 'local') {
    return {
      provider: 'local',
      model: config.agent.model || 'adpal-reasoner-v1',
      hosted: false,
      degraded: false,
      reason: ''
    };
  }

  if (!DEFAULT_MODELS[requested] && requested !== 'openai') {
    return {
      provider: 'local',
      model: 'adpal-reasoner-v1',
      hosted: false,
      degraded: true,
      reason: `Unknown AGENT_PROVIDER "${requested}"; using the local reasoner.`
    };
  }

  if (!key) {
    return {
      provider: 'local',
      model: 'adpal-reasoner-v1',
      hosted: false,
      degraded: true,
      reason: `${requested} selected but no API key found; using the local reasoner.`
    };
  }

  return {
    provider: requested,
    model: config.agent.model || DEFAULT_MODELS[requested],
    hosted: true,
    degraded: false,
    reason: ''
  };
}

/** Public capability profile for /api/health, /api/telemetry and the terminal. */
function publicProfile() {
  const active = resolveProvider();
  return {
    provider: active.provider,
    model: active.model,
    hosted: active.hosted,
    degraded: active.degraded,
    reason: active.reason,
    configured: String(config.agent.provider || 'local'),
    available: ['local', ...Object.keys(DEFAULT_MODELS)],
    minRelevance: config.agent.minRelevance,
    timeoutMs: config.agent.timeoutMs,
    // What the local reasoner is, stated plainly so nobody mistakes it for an LLM.
    localReasoner: 'deterministic feature extraction + weighted scoring + prose synthesis'
  };
}

/* ------------------------------------------------------------------ */
/* Page understanding                                                 */
/* ------------------------------------------------------------------ */

/**
 * Reads a page context into a small, explainable profile.
 *
 * Only what the client actually reports is used — title and host. No fetch, no
 * page scraping: the agent reasons over the context it was handed.
 */
function derivePageProfile(page = {}) {
  const title = String(page.title || 'Untitled page').slice(0, 160);
  const host = String(page.host || page.publisher || 'localhost').slice(0, 120);
  const titleTokens = tokenize(title);
  const hostTokens = tokenize(host.replace(/\.(com|org|net|io|dev|news|co\.uk)$/i, ''));

  const markers = [...new Set([...titleTokens, ...hostTokens].filter((w) => EDITORIAL_MARKERS.has(w)))];
  const commercial = [...new Set([...titleTokens, ...hostTokens].filter((w) => COMMERCE_MARKERS.has(w)))];
  const wordCount = title.split(/\s+/).filter(Boolean).length;

  let pageType = 'general';
  if (markers.length > 0) pageType = 'editorial';
  else if (commercial.length > 0) pageType = 'commerce';
  // A multi-word headline on a publication host is editorial inventory even
  // without a masthead word: it is long-form reading, which is what campaigns buy.
  else if (wordCount >= 4) pageType = 'editorial';

  return {
    title,
    host,
    pageType,
    tokens: [...new Set([...titleTokens, ...hostTokens])],
    markers,
    commercial,
    wordCount
  };
}

function affinityFor(pageType, objective) {
  const table = PAGE_AFFINITY[pageType] || PAGE_AFFINITY.general;
  return asNumber(table[objective], table.default ?? 0.6);
}

/**
 * Scores one advertiser against the page.
 *
 * Three independent components, so the resulting relevance can be explained:
 *   audienceFit — does this objective suit this kind of page?
 *   topicFit    — does the page vocabulary overlap the campaign vocabulary?
 *   novelty     — has this advertiser already been shown here?
 */
function scoreCandidate({ profile, candidate, price, floor }) {
  const creative = candidate.creative || {};
  const campaignCorpus = [
    candidate.sponsor,
    candidate.objective,
    creative.headline,
    creative.body,
    creative.cta,
    ...(OBJECTIVE_LEXICON[candidate.objective] || [])
  ]
    .filter(Boolean)
    .join(' ');

  const campaignTokens = new Set(tokenize(campaignCorpus));
  const matches = profile.tokens.filter((token) => campaignTokens.has(token));

  // Category adjacency: shared concepts count for less than an exact term but
  // let a publishing page read as relevant to a stationery brand.
  const pageConcepts = conceptsFor(profile.tokens);
  const campaignConcepts = conceptsFor([...campaignTokens]);
  const sharedConcepts = [...pageConcepts].filter((concept) => campaignConcepts.has(concept));

  const audienceFit = affinityFor(profile.pageType, candidate.objective);
  const topicFit = clamp((matches.length + sharedConcepts.length * 0.6) / 3, 0, 1);
  const novelty = asNumber(candidate.impressions, 0) === 0 ? 0.05 : 0;

  // Weights: the audience/objective fit is the main signal, topic overlap
  // adjusts it, novelty breaks ties between equally relevant advertisers.
  const relevance = clamp(0.25 + audienceFit * 0.3 + topicFit * 0.35 + novelty, 0.05, 0.99);
  const budgetRemaining = Math.max(0, asNumber(candidate.budgetRemaining, 0));
  const budgetShare = budgetRemaining > 0 ? price / budgetRemaining : 1;
  const affordable = budgetRemaining + 1e-9 >= price;

  const decision = affordable && relevance >= floor ? 'bid' : 'decline';
  const confidence = clamp(0.45 + topicFit * 0.3 + audienceFit * 0.2, 0.3, 0.97);

  return {
    agentId: candidate.agent?.id || candidate.agentId || 'unknown',
    name: candidate.agent?.name || 'Advertiser agent',
    sponsor: candidate.sponsor || 'unknown',
    objective: candidate.objective || 'reach',
    verdict: decision,
    relevance: round(relevance, 3),
    confidence: round(confidence, 2),
    bid: decision === 'bid' ? round(price, 4) : 0,
    budgetRemaining: round(budgetRemaining, 4),
    budgetShare: round(budgetShare, 4),
    affordable,
    components: {
      audienceFit: round(audienceFit, 2),
      topicFit: round(topicFit, 2),
      novelty: round(novelty, 2)
    },
    evidence: [...matches, ...sharedConcepts.map((concept) => `concept:${concept}`)].slice(0, 6),
    rationale: buildBidRationale({
      profile,
      candidate,
      price,
      floor,
      relevance,
      audienceFit,
      topicFit,
      budgetShare,
      matches,
      sharedConcepts,
      decision,
      affordable
    })
  };
}

function describeMatches(matches) {
  if (matches.length === 0) return 'no shared vocabulary';
  if (matches.length === 1) return `the term “${matches[0]}”`;
  return `terms like ${matches.slice(0, 3).map((m) => `“${m}”`).join(', ')}`;
}

function buildBidRationale({
  profile,
  candidate,
  price,
  floor,
  relevance,
  audienceFit,
  topicFit,
  budgetShare,
  matches,
  sharedConcepts,
  decision,
  affordable
}) {
  const sponsor = candidate.sponsor || 'the advertiser';
  const objective = candidate.objective || 'reach';
  const budget = Math.max(0, asNumber(candidate.budgetRemaining, 0));

  const read = matches.length
    ? `“${profile.title}” is ${articleOf(profile.pageType)} ${profile.pageType} surface and shares ${describeMatches(matches)} with ${possessive(sponsor)} creative — on-beat, not adjacent.`
    : sharedConcepts.length
      ? `“${profile.title}” is ${articleOf(profile.pageType)} ${profile.pageType} surface that lands in ${possessive(sponsor)} territory through ${sharedConcepts.map((c) => `“${c}”`).join(', ')} — adjacent demand rather than exact intent.`
      : `“${profile.title}” is ${articleOf(profile.pageType)} ${profile.pageType} surface with no shared vocabulary or category for ${sponsor}, so this would be a reach buy.`;

  const audience = `Objective ${objective} suits ${articleOf(profile.pageType)} ${profile.pageType} audience at ${pct(audienceFit)} affinity.`;

  const money = affordable
    ? `${CUR}${price.toFixed(3)} is ${pct(budgetShare, 1)} of the ${CUR}${budget.toFixed(2)} still authorised, inside the ${CUR}${config.maxOfferPrice.toFixed(2)} cap.`
    : `${CUR}${price.toFixed(3)} exceeds the ${CUR}${budget.toFixed(2)} left in the campaign, so the price cannot be authorised.`;

  const verdict = decision === 'bid'
    ? `Relevance ${relevance.toFixed(2)} clears the ${floor.toFixed(2)} floor — bidding ${CUR}${price.toFixed(3)}.`
    : !affordable
      ? 'Declining: the campaign budget cannot cover this impression.'
      : `Relevance ${relevance.toFixed(2)} is under the ${floor.toFixed(2)} floor — declining rather than paying for a weak match.`;

  // Deterministic phrasing variety: five identical sentence shapes in one log
  // look generated, so each agent opens with a different framing while the
  // content stays strictly derived from its own numbers.
  const openers = ['Page read:', 'Context:', 'Reading the placement:', 'Placement read:'];
  const hash = [...String(candidate.agent?.id || sponsor)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const opener = openers[hash % openers.length];

  return `${opener} ${[read, audience, money, verdict].join(' ')}`;
}

function bidSteps({ profile, candidate, price, floor, scored }) {
  return [
    `Read page context · “${profile.title}” → ${profile.pageType}, ${profile.tokens.length} content tokens${profile.markers.length ? ` (masthead: ${profile.markers.slice(0, 2).join(', ')})` : ''}`,
    `Match objective ${candidate.objective} against ${profile.pageType} inventory → audience affinity ${pct(scored.components.audienceFit)}`,
    scored.evidence.length
      ? `Topical overlap → ${scored.evidence.slice(0, 4).join(', ')}`
      : 'Topical overlap → none; priced as reach inventory',
    `Budget check · ${CUR}${price.toFixed(3)} of ${CUR}${scored.budgetRemaining.toFixed(2)} (${pct(scored.budgetShare, 1)}) → ${scored.affordable ? 'authorised' : 'insufficient'}`,
    `Rank relevance ${scored.relevance.toFixed(3)} against floor ${floor.toFixed(2)} → ${scored.verdict}`
  ];
}

/* ------------------------------------------------------------------ */
/* Advertiser negotiation                                             */
/* ------------------------------------------------------------------ */

function localNegotiation({ page, price, candidates, floor }) {
  const started = Date.now();
  const profile = derivePageProfile(page);

  const bids = candidates.map((candidate) =>
    scoreCandidate({ profile, candidate, price, floor })
  );

  // Highest relevance first; ties break toward the advertiser with more budget
  // left, then toward the one shown least, so the demo keeps rotating.
  const ranked = [...bids].sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (b.budgetRemaining !== a.budgetRemaining) return b.budgetRemaining - a.budgetRemaining;
    return a.agentId.localeCompare(b.agentId);
  });

  const winner = ranked.find((bid) => bid.verdict === 'bid') || null;
  const steps = [];

  steps.push(
    `Ingest placement · ${CUR}${price.toFixed(3)} · ${profile.host} · ${candidates.length} eligible advertiser${candidates.length === 1 ? '' : 's'}`
  );
  steps.push(
    `Classify page · “${profile.title}” → ${profile.pageType} (${profile.wordCount} title words, ${profile.tokens.length} tokens)`
  );
  for (const bid of ranked) {
    steps.push(
      `${bid.sponsor} · relevance ${bid.relevance.toFixed(2)} (audience ${bid.components.audienceFit.toFixed(2)} × topic ${bid.components.topicFit.toFixed(2)}) → ${bid.verdict}`
    );
  }
  steps.push(
    winner
      ? `Award the slot to ${winner.sponsor} · highest relevant bid at ${CUR}${winner.bid.toFixed(3)}`
      : 'No advertiser cleared the floor · recommend withholding the impression'
  );

  const prompt = buildBidPrompt({ profile, price, floor, bids });
  const completion = ranked.map((bid) => bid.rationale).join('\n');

  return {
    ok: true,
    phase: 'negotiate',
    ...resolveProvider(),
    fallback: false,
    latencyMs: Date.now() - started,
    usage: usageFrom(prompt, completion, { estimated: true }),
    pageProfile: profile,
    floor,
    price,
    bids: ranked,
    winnerId: winner ? winner.agentId : null,
    winner: winner || null,
    steps,
    promptPreview: prompt.slice(0, 1400)
  };
}

function buildBidPrompt({ profile, price, floor, bids }) {
  return [
    'You are the advertiser bidding agent for an attention marketplace.',
    `Page: "${profile.title}" on ${profile.host} (${profile.pageType}).`,
    `Placement price: ${config.currency} ${price.toFixed(3)}. Relevance floor: ${floor.toFixed(2)}.`,
    'Candidates:',
    ...bids.map(
      (bid) =>
        `- ${bid.agentId} (${bid.sponsor}, objective ${bid.objective}) budget ${config.currency} ${bid.budgetRemaining.toFixed(2)}`
    ),
    'For each candidate decide bid or decline and justify it in one short paragraph.',
    'Return JSON: {"bids":[{"agentId":"","relevance":0,"verdict":"bid|decline","rationale":""}],"winnerId":""}'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Attention assessment                                               */
/* ------------------------------------------------------------------ */

function movementPhrase(movesPerSecond, reversalsPerMove) {
  if (movesPerSecond <= 0) return 'no pointer motion at all';
  if (movesPerSecond < 0.5) return 'almost no hand-scale motion';
  if (movesPerSecond < 3) return 'a slow, deliberate hand';
  if (movesPerSecond < 12) return 'the micro-jitter of a hand on a trackpad';
  if (movesPerSecond < 30) return 'a brisk scanning sweep';
  return 'motion denser than a human hand produces';
}

function correctionPhrase(reversalsPerMove, mouseMoves) {
  if (mouseMoves === 0) return 'with no path to correct';
  if (reversalsPerMove >= 0.15) return 'with frequent course corrections that follow hand intent';
  if (reversalsPerMove > 0) return 'with few course corrections';
  return 'with the perfectly straight path a script produces';
}

function localAttention({ signals, heuristic, page }) {
  const started = Date.now();
  const durationMs = clamp(asNumber(signals.durationMs), 0, 10 * 60 * 1000);
  const seconds = Math.max(durationMs / 1000, 0.001);
  const mouseMoves = Math.round(clamp(asNumber(signals.mouseMoves), 0, 100000));
  const directionChanges = Math.round(clamp(asNumber(signals.directionChanges), 0, 100000));
  const scrollEvents = Math.round(clamp(asNumber(signals.scrollEvents), 0, 100000));
  const scrollDepth = clamp(asNumber(signals.scrollDepth), 0, 1);
  const visibleRatio = clamp(asNumber(signals.visibleRatio), 0, 1);
  const focusRatio = clamp(asNumber(signals.focusRatio), 0, 1);
  const slotVisibleRatio =
    typeof signals.slotVisibleRatio === 'number' && Number.isFinite(signals.slotVisibleRatio)
      ? clamp(signals.slotVisibleRatio, 0, 1)
      : null;

  const movesPerSecond = mouseMoves / seconds;
  const reversalsPerMove = mouseMoves > 0 ? directionChanges / mouseMoves : 0;
  const scrollsPerSecond = scrollEvents / seconds;
  const clicks = Math.round(asNumber(signals.clicks));
  const keyPresses = Math.round(asNumber(signals.keyPresses));

  const approved = heuristic?.approved === true;
  const score = asNumber(heuristic?.score, 0);
  const threshold = asNumber(heuristic?.threshold, config.humanThreshold);

  const narrative = [
    `${approved ? 'Human attention signature verified' : 'Attention signature rejected'}: ${seconds.toFixed(1)} s of session time against an article depth of ${pct(scrollDepth)}.`,
    `Pointer behaviour: ${mouseMoves} moves (${movesPerSecond.toFixed(1)}/s) and ${directionChanges} direction reversals — ${movementPhrase(movesPerSecond, reversalsPerMove)}, ${correctionPhrase(reversalsPerMove, mouseMoves)}.`,
    `Reading cadence: ${scrollsPerSecond.toFixed(2)} scroll steps/s across ${scrollEvents} events${clicks ? `, ${clicks} click${clicks === 1 ? '' : 's'}` : ''}${keyPresses ? `, ${keyPresses} key press${keyPresses === 1 ? '' : 'es'}` : ''}.`,
    slotVisibleRatio === null
      ? `Viewport: placement visibility not reported; tab visible ${pct(visibleRatio)}, focus held ${pct(focusRatio)}.`
      : `Viewport: placement in view ${pct(slotVisibleRatio)}, tab visible ${pct(visibleRatio)}, focus held ${pct(focusRatio)}.`,
    approved
      ? `Cognitive cadence is consistent with a person reading: score ${score}/100 against a threshold of ${threshold}.`
      : `No credible cognitive cadence to verify — ${String(heuristic?.reason || 'attention too weak').replace(/\.$/, '')}.`
  ].join(' ');

  const steps = [`Extract behavioural features · ${seconds.toFixed(1)} s, ${mouseMoves} moves, ${directionChanges} reversals, ${scrollEvents} scrolls`];
  for (const check of Array.isArray(heuristic?.checks) ? heuristic.checks : []) {
    steps.push(`${check.label} → ${check.status} (${check.detail})`);
  }
  steps.push(
    `Weighted score ${score}/100 against threshold ${threshold} → ${approved ? 'human' : 'script'}`
  );

  const prompt = [
    'You are the attention verification agent for an attention marketplace.',
    `Page: "${String(page?.title || 'unknown')}"`,
    `Signals: ${JSON.stringify(signals)}`,
    'Explain the behavioural signature in at most four sentences and state whether it is human.'
  ].join('\n');

  return {
    ok: true,
    phase: 'attention',
    ...resolveProvider(),
    fallback: false,
    latencyMs: Date.now() - started,
    usage: usageFrom(prompt, narrative, { estimated: true }),
    verdict: approved ? 'human' : 'script',
    approved,
    score,
    threshold,
    confidence: round(clamp(score / 100, 0.05, 0.99), 2),
    disagreement: false,
    narrative,
    signature: {
      seconds: round(seconds, 2),
      movesPerSecond: round(movesPerSecond, 2),
      reversalsPerMove: round(reversalsPerMove, 2),
      scrollsPerSecond: round(scrollsPerSecond, 2),
      scrollDepth: round(scrollDepth, 2),
      slotVisibleRatio: slotVisibleRatio === null ? null : round(slotVisibleRatio, 2),
      visibleRatio: round(visibleRatio, 2),
      focusRatio: round(focusRatio, 2)
    },
    steps,
    promptPreview: prompt.slice(0, 900)
  };
}

/* ------------------------------------------------------------------ */
/* Hosted model transport                                             */
/* ------------------------------------------------------------------ */

async function postJson(url, body, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.agent.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Strips code fences and grabs the outermost JSON object. */
function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(fenced.slice(start, end + 1));
}

async function callHosted({ system, user }) {
  const active = resolveProvider();
  if (!active.hosted) throw new Error(active.reason || 'hosted provider unavailable');
  const key = apiKeyFromEnv();

  if (active.provider === 'openai') {
    const base = config.agent.baseUrl || 'https://api.openai.com/v1';
    const data = await postJson(
      `${base.replace(/\/$/, '')}/chat/completions`,
      {
        model: active.model,
        temperature: config.agent.temperature,
        max_tokens: config.agent.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      },
      { authorization: `Bearer ${key}` }
    );
    return {
      text: data.choices?.[0]?.message?.content || '',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0
      }
    };
  }

  if (active.provider === 'anthropic') {
    const base = config.agent.baseUrl || 'https://api.anthropic.com/v1';
    const data = await postJson(
      `${base.replace(/\/$/, '')}/messages`,
      {
        model: active.model,
        max_tokens: config.agent.maxTokens,
        temperature: config.agent.temperature,
        system,
        messages: [{ role: 'user', content: user }]
      },
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    );
    return {
      text: (data.content || []).map((part) => part.text || '').join(''),
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0
      }
    };
  }

  // Gemini
  const base = config.agent.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const data = await postJson(
    `${base.replace(/\/$/, '')}/models/${encodeURIComponent(active.model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: config.agent.temperature,
        maxOutputTokens: config.agent.maxTokens,
        responseMimeType: 'application/json'
      }
    },
    {}
  );
  return {
    text: (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join(''),
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0
    }
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Advertiser agents evaluate the page and justify their bids.
 *
 * @param {{
 *   page?: { title?: string, host?: string, slot?: string },
 *   price: number,
 *   candidates: Array<object>,
 *   minRelevance?: number
 * }} input
 */
async function negotiate({ page = {}, price = 0, candidates = [], minRelevance } = {}) {
  const floor = clamp(
    typeof minRelevance === 'number' ? minRelevance : config.agent.minRelevance,
    0,
    1
  );
  const local = localNegotiation({ page, price, candidates, floor });

  if (!config.agent.enabled || candidates.length === 0) return local;

  const active = resolveProvider();
  if (!active.hosted) return local;

  const system = 'You are an advertising bid agent. Reply with JSON only.';
  const user = buildBidPrompt({ profile: local.pageProfile, price, floor, bids: local.bids });

  try {
    const started = Date.now();
    const reply = await callHosted({ system, user });
    const parsed = extractJson(reply.text);
    const byId = new Map(local.bids.map((bid) => [bid.agentId, bid]));

    const bids = local.bids.map((bid) => {
      const answer = (parsed.bids || []).find((entry) => entry.agentId === bid.agentId);
      if (!answer) return bid;
      const verdict = answer.verdict === 'decline' || answer.decision === 'decline' ? 'decline' : 'bid';
      const relevance = clamp(asNumber(answer.relevance, bid.relevance), 0, 1);
      return {
        ...bid,
        verdict,
        relevance: round(relevance, 3),
        bid: verdict === 'bid' ? round(price, 4) : 0,
        rationale: String(answer.rationale || bid.rationale).slice(0, 600)
      };
    });

    const ranked = [...bids].sort((a, b) => b.relevance - a.relevance);
    const winner = ranked.find((bid) => bid.verdict === 'bid') || null;
    const winnerId = winner ? winner.agentId : null;
    const steps = [
      `Prompt ${active.model} · ${estimateTokens(user)} estimated prompt tokens, ${candidates.length} candidates`,
      `Model scored ${bids.length} advertiser${bids.length === 1 ? '' : 's'} against “${local.pageProfile.title}”`,
      ...ranked.map((bid) => `${bid.sponsor} → ${bid.verdict} at relevance ${bid.relevance.toFixed(2)}`),
      winnerId ? `Award slot to ${winner.sponsor}` : 'No advertiser cleared the floor'
    ];

    return {
      ...local,
      provider: active.provider,
      model: active.model,
      hosted: true,
      fallback: false,
      latencyMs: Date.now() - started,
      usage: usageFrom(user, reply.text, {
        estimated: !reply.usage.promptTokens,
        raw: reply.usage
      }),
      bids: ranked,
      winnerId,
      winner,
      steps
    };
  } catch (error) {
    return {
      ...local,
      provider: 'local',
      model: 'adpal-reasoner-v1',
      hosted: false,
      fallback: true,
      fallbackProvider: active.provider,
      fallbackModel: active.model,
      fallbackReason: error?.message || String(error),
      steps: [
        ...local.steps,
        `${active.provider}/${active.model} unavailable (${error?.message || error}) → local reasoner answered`
      ]
    };
  }
}

/**
 * Verification agent: explains the telemetry as a behavioural signature.
 *
 * @param {{ signals?: object, heuristic?: object, page?: object }} input
 */
async function assessAttention({ signals = {}, heuristic = {}, page = {} } = {}) {
  const local = localAttention({ signals, heuristic, page });

  if (!config.agent.enabled) return local;

  const active = resolveProvider();
  if (!active.hosted) return local;

  const system =
    'You are the attention verification agent. Explain the behavioural signature. Reply with JSON only.';
  const user = [
    `Page: "${String(page.title || 'Untitled page')}" on ${String(page.host || 'localhost')}.`,
    `Telemetry: ${JSON.stringify(signals)}`,
    `Deterministic guard result: score ${local.score}/100, threshold ${local.threshold}, verdict ${local.verdict}.`,
    `Failing checks: ${(heuristic.flags || []).join('; ') || 'none'}.`,
    'Write at most four sentences explaining the behavioural signature as reading cadence, pointer dynamics and viewport discipline.',
    'Return JSON: {"verdict":"human|script","confidence":0,"narrative":"","steps":[""]}'
  ].join('\n');

  try {
    const started = Date.now();
    const reply = await callHosted({ system, user });
    const parsed = extractJson(reply.text);
    // The heuristic keeps the money decision; the model only explains it.
    const modelVerdict = parsed.verdict === 'script' ? 'script' : 'human';
    return {
      ...local,
      provider: active.provider,
      model: active.model,
      hosted: true,
      fallback: false,
      latencyMs: Date.now() - started,
      usage: usageFrom(user, reply.text, {
        estimated: !reply.usage.promptTokens,
        raw: reply.usage
      }),
      narrative: String(parsed.narrative || local.narrative).slice(0, 800),
      confidence: round(clamp(asNumber(parsed.confidence, local.confidence), 0, 1), 2),
      disagreement: modelVerdict !== local.verdict,
      steps: [
        ...local.steps.slice(0, 2),
        ...(Array.isArray(parsed.steps) ? parsed.steps.slice(0, 5).map(String) : []),
        `Model verdict ${modelVerdict} · heuristic verdict ${local.verdict} · heuristic remains authoritative`
      ]
    };
  } catch (error) {
    return {
      ...local,
      provider: 'local',
      model: 'adpal-reasoner-v1',
      hosted: false,
      fallback: true,
      fallbackProvider: active.provider,
      fallbackModel: active.model,
      fallbackReason: error?.message || String(error),
      steps: [
        ...local.steps,
        `${active.provider}/${active.model} unavailable (${error?.message || error}) → local reasoner answered`
      ]
    };
  }
}

/**
 * Shape shared by both roles, so the terminal can render one component for any
 * agent thought: provider, model, tokens, latency and the step trace.
 */
function cognitionEnvelope(result) {
  if (!result) return null;
  return {
    phase: result.phase,
    provider: result.provider,
    model: result.model,
    hosted: Boolean(result.hosted),
    degraded: Boolean(result.degraded),
    fallback: Boolean(result.fallback),
    fallbackProvider: result.fallbackProvider || '',
    fallbackModel: result.fallbackModel || '',
    fallbackReason: result.fallbackReason || result.reason || '',
    latencyMs: result.latencyMs,
    usage: result.usage,
    confidence: result.confidence ?? null,
    verdict: result.verdict || null,
    signature: result.signature || null,
    steps: Array.isArray(result.steps) ? result.steps : [],
    promptPreview: result.promptPreview || ''
  };
}

module.exports = {
  negotiate,
  assessAttention,
  derivePageProfile,
  publicProfile,
  resolveProvider,
  cognitionEnvelope,
  // Exported for the checks in server/scripts.
  _internals: { tokenize, stem, scoreCandidate, estimateTokens, extractJson }
};
