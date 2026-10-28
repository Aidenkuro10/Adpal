/* AdPal Agent Terminal — consumes the SSE stream at /api/logs.
 *
 * The page renders the event envelope exactly as the server produced it:
 *
 *   { seq, at, stage, source, level, title, detail, data }
 *
 * Nothing is summarised away. The side rail only indexes the stream into the
 * four things a judge watches during a run: attention, negotiation, L402 and
 * PayPal. Everything displayed is text, never HTML from an event.
 */

(() => {
  'use strict';

  const MAX_EVENTS = 500;
  const MAX_ROWS = 300;

  const $ = (id) => document.getElementById(id);

  const CATEGORY = {
    'agent.reasoning': 'ai',
    'agent.bid': 'ai',
    'agent.attention': 'ai',
    l402: 'l402',
    'l402.challenge': 'l402',
    'l402.issue': 'l402',
    'l402.verify': 'l402',
    'paypal.oauth': 'paypal',
    'paypal.payout': 'paypal',
    'paypal.status': 'paypal',
    payout: 'paypal',
    'solana.anchor': 'solana',
    'solana.verify': 'solana',
    'solana.payout': 'solana',
    'solana.status': 'solana',
    'solana.funding': 'solana',
    attention: 'attention',
    score: 'attention'
  };

  const els = {
    conn: $('conn'),
    connLabel: $('conn-label'),
    stream: $('stream'),
    empty: $('empty'),
    follow: $('follow'),
    filters: Array.from(document.querySelectorAll('.filter')),
    pause: $('pause'),
    clear: $('clear'),
    download: $('download'),
    expandAll: $('expand-all'),
    collapseAll: $('collapse-all'),
    countAll: $('count-all'),
    countAi: $('count-ai'),
    countL402: $('count-l402'),
    countAttention: $('count-attention'),
    countPaypal: $('count-paypal'),
    countSolana: $('count-solana'),
    countNegotiation: $('count-negotiation'),
    statEvents: $('stat-events'),
    statSeq: $('stat-seq'),
    statErrors: $('stat-errors'),
    statTokens: $('stat-tokens'),
    statLast: $('stat-last'),
    statPaused: $('stat-paused'),
    buffer: $('stream-buffer'),
    streamConn: $('stream-conn'),
    attentionValue: $('attention-value'),
    attentionFill: $('attention-fill'),
    attentionPhase: $('attention-phase'),
    attentionSlot: $('attention-slot'),
    attentionActive: $('attention-active'),
    attentionDepth: $('attention-depth'),
    attentionSession: $('attention-session'),
    agentState: $('agent-state'),
    agentOffer: $('agent-offer'),
    agentId: $('agent-id'),
    agentBid: $('agent-bid'),
    agentCreative: $('agent-creative'),
    agentScore: $('agent-score'),
    aiState: $('ai-state'),
    aiProvider: $('ai-provider'),
    aiModel: $('ai-model'),
    aiVerdict: $('ai-verdict'),
    aiRelevance: $('ai-relevance'),
    aiTokens: $('ai-tokens'),
    aiLatency: $('ai-latency'),
    aiThought: $('ai-thought'),
    l402State: $('l402-state'),
    l402Offer: $('l402-offer'),
    l402Context: $('l402-context'),
    l402Id: $('l402-id'),
    l402Caveats: $('l402-caveats'),
    l402Hash: $('l402-hash'),
    l402Expiry: $('l402-expiry'),
    l402Signature: $('l402-signature'),
    l402Note: $('l402-note'),
    paypalMode: $('paypal-mode'),
    paypalBalance: $('paypal-balance'),
    paypalBatch: $('paypal-batch'),
    paypalStatus: $('paypal-status'),
    paypalAmount: $('paypal-amount'),
    paypalRecipient: $('paypal-recipient'),
    paypalOauth: $('paypal-oauth'),
    paypalNote: $('paypal-note'),
    payoutRequest: $('payout-request'),
    payoutRefresh: $('payout-refresh'),
    payoutNote: $('payout-note'),
    paypalPayable: $('paypal-payable'),
    paypalCarry: $('paypal-carry'),
    paypalThreshold: $('paypal-threshold'),
    paypalPublisher: $('paypal-publisher'),
    statReaders: $('stat-readers'),
    statAccounting: $('stat-accounting'),
    paypalDashboard: $('paypal-dashboard'),
    solanaState: $('solana-state'),
    solanaBalance: $('solana-balance'),
    solanaCluster: $('solana-cluster'),
    solanaTreasury: $('solana-treasury'),
    solanaReader: $('solana-reader'),
    solanaPublisher: $('solana-publisher'),
    solanaRate: $('solana-rate'),
    solanaHash: $('solana-hash'),
    solanaAnchor: $('solana-anchor'),
    solanaPayout: $('solana-payout'),
    solanaStatus: $('solana-status'),
    solanaNote: $('solana-note'),
    solanaExplorer: $('solana-explorer'),
    solanaFaucet: $('solana-faucet'),
    solanaFund: $('solana-fund'),
    payoutSolana: $('payout-solana'),
    runbookState: $('runbook-state'),
    runbookNote: $('runbook-note'),
    toolkitState: $('toolkit-state'),
    toolkitVersion: $('toolkit-version'),
    toolkitMcp: $('toolkit-mcp'),
    toolkitTools: $('toolkit-tools'),
    toolkitAuto: $('toolkit-auto'),
    acts: Array.from(document.querySelectorAll('.act')),
    resetRun: $('reset-run')
  };

  // The rich "Act 1 · standing by" panel is the canonical empty state; keep a
  // copy so clearing or filtering the stream can restore it verbatim.
  const emptyTemplate = els.empty ? els.empty.cloneNode(true) : null;

  const state = {
    events: [],
    filter: 'all',
    paused: false,
    pending: [],
    counts: { all: 0, ai: 0, l402: 0, attention: 0, paypal: 0, solana: 0, negotiation: 0 },
    ai: { calls: 0, tokens: 0 },
    errors: 0,
    seq: 0,
    lastAt: null,
    mode: 'connecting',
    // Overwritten from /api/health (rules.payoutThreshold) on connect; this is
    // only the value shown for the instant before the first frame arrives.
    threshold: 0.005,
    balance: 0,
    publisher: 0,
    payable: 0,
    batchId: '',
    payoutBusy: false,
    // Which rail the terminal's primary button targets, and the on-chain
    // signature of the last devnet transfer (used by the refresh button).
    rail: 'paypal_payouts',
    solanaProfile: null,
    solanaSignature: '',
    solanaHash: '',
    // null = unknown, true = treasury holds SOL, false = unfunded
    solanaFunded: null,
    acts: { attention: false, challenge: false, macaroon: false, payout: false }
  };

  /* ------------------------------------------------------------------ */
  /* Stream                                                             */

  function connect() {
    if (!('EventSource' in window)) {
      setConnection('offline', 'no SSE support');
      return;
    }

    // `live=1` tells the simulator to start at the current sequence instead of
    // replaying the previous run. Act 1 must look like Act 1 on every refresh;
    // a reconnecting EventSource still resumes from Last-Event-ID.
    const source = new EventSource('/api/logs?live=1');
    let opened = false;

    source.addEventListener('open', () => {
      opened = true;
      setConnection('live', 'streaming');
    });

    source.addEventListener('hello', (event) => {
      try {
        const hello = JSON.parse(event.data);
        applyHello(hello);
      } catch {
        /* a malformed hello must not break the stream */
      }
    });

    source.addEventListener('log', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      receive(payload);
    });

    source.addEventListener('error', () => {
      // EventSource reconnects by itself; reflect the current state honestly.
      setConnection(opened ? 'offline' : 'connecting', opened ? 'reconnecting…' : 'connecting…');
    });

    window.addEventListener('beforeunload', () => source.close());
  }

  function applyHello(hello) {
    if (hello.paypal) {
      applyPaypalProfile(hello.paypal);
    }
    if (hello.solana) {
      applySolanaProfile(hello.solana);
    }
    if (hello.payoutRail) {
      state.rail = hello.payoutRail === 'solana-devnet' ? 'solana-devnet' : 'paypal_payouts';
      updatePayoutButton();
    }
    if (hello.currency) state.currency = hello.currency;
    if (Number.isFinite(Number(hello.rules?.payoutThreshold))) {
      state.threshold = Number(hello.rules.payoutThreshold);
      updatePayoutButton();
    }
    if (Number.isFinite(Number(hello.seq))) {
      state.seq = Math.max(state.seq, Number(hello.seq));
      els.statSeq.textContent = `seq ${state.seq}`;
    }
    if (hello.toolkit) applyToolkit(hello.toolkit, hello.autoPayout);
    if (hello.cognition) applyCognitionProfile(hello.cognition);
    if (hello.presence) applyPresence(hello.presence);
    setConnection('live', 'streaming');
  }

  /**
   * Agent-toolkit panel: proof the PayPal AI Toolkit checkout was discovered,
   * not hard-coded — version, MCP endpoint and the tools the server wired.
   */
  function applyToolkit(toolkit, autoPayout) {
    const present = toolkit.present === true;
    setText(els.toolkitState, present ? 'loaded' : 'not found');
    els.toolkitState.className = `card-tag ${present ? 'is-live' : 'is-warn'}`;

    setText(els.toolkitVersion, present ? `v${toolkit.version || '?'}` : 'AI-Toolkit not present');
    setText(els.toolkitMcp, toolkit.mcp || 'not declared');

    const tools = Array.isArray(toolkit.tools) ? toolkit.tools : [];
    setText(els.toolkitTools, tools.length ? `${tools.length} · ${tools.join(', ')}` : '—');
    els.toolkitTools.title = tools.join('\n');

    setText(
      els.toolkitAuto,
      autoPayout === false ? 'off · manual only' : 'on · after each settled invoice'
    );
  }

  /**
   * Provider badge from the SSE hello, so the cognition card names the reasoner
   * before the first impression arrives.
   */
  function applyCognitionProfile(profile) {
    if (!profile) return;
    setText(els.aiProvider, profile.provider || '—');
    setText(els.aiModel, profile.model || '—');
    els.aiState.textContent = profile.hosted ? 'hosted model' : 'local reasoner';
    els.aiState.className = `card-tag ${profile.hosted ? 'is-live' : ''}`.trim();
    els.aiState.title = profile.degraded && profile.reason ? profile.reason : '';
    if (profile.localReasoner) els.aiThought.title = profile.localReasoner;
  }

  function setConnection(mode, label) {
    state.mode = mode;
    els.conn.dataset.state = mode;
    els.connLabel.textContent = label;
    els.streamConn.textContent = mode === 'live' ? 'streaming' : mode;
  }

  /* ------------------------------------------------------------------ */
  /* Receiving                                                          */
  /* ------------------------------------------------------------------ */

  function receive(event) {
    if (!event || typeof event !== 'object' || !event.stage) return;

    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events.shift();

    state.counts.all += 1;
    const category = categorize(event);
    state.counts[category] += 1;
    if (event.level === 'error') state.errors += 1;

    state.seq = Math.max(state.seq, Number(event.seq) || 0);
    state.lastAt = event.at || new Date().toISOString();

    index(event, category);
    advanceRunbook(event);
    updateCounters();

    if (state.paused) {
      state.pending.push(event);
      els.statPaused.hidden = false;
      return;
    }

    if (state.filter === 'all' || state.filter === category) {
      appendRow(event, category);
    }
  }

  function categorize(event) {
    const stage = String(event.stage || '');
    if (CATEGORY[stage]) return CATEGORY[stage];
    if (stage.startsWith('l402')) return 'l402';
    if (stage.startsWith('paypal')) return 'paypal';
    if (stage.startsWith('solana')) return 'solana';
    return 'negotiation';
  }

  function updateCounters() {
    els.countAll.textContent = String(state.counts.all);
    if (els.countAi) els.countAi.textContent = String(state.counts.ai);
    els.countL402.textContent = String(state.counts.l402);
    els.countAttention.textContent = String(state.counts.attention);
    els.countPaypal.textContent = String(state.counts.paypal);
    if (els.countSolana) els.countSolana.textContent = String(state.counts.solana);
    els.countNegotiation.textContent = String(state.counts.negotiation);

    els.statEvents.textContent = `${state.counts.all} event${state.counts.all === 1 ? '' : 's'}`;
    els.statSeq.textContent = `seq ${state.seq}`;
    els.statErrors.textContent = `${state.errors} error${state.errors === 1 ? '' : 's'}`;
    if (els.statTokens) {
      els.statTokens.textContent = `${state.ai.tokens} tokens · ${state.ai.calls} agent calls`;
    }
    els.statLast.textContent = state.lastAt ? formatClock(state.lastAt, true) : '—';
    els.buffer.textContent = `${state.events.length} events`;
  }

  /* ------------------------------------------------------------------ */
  /* Rows                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Financial event classifier.
   *
   * The stream mixes protocol steps with money movements. Anything that moves,
   * splits or reports an amount is marked so the terminal can paint it in the
   * payout accent — a judge should never have to read a JSON body to notice
   * that a transaction just happened.
   */
  const MONEY_STAGES = new Set([
    'payout',
    'ledger',
    'paypal.oauth',
    'paypal.payout',
    'paypal.status',
    'paypal.retry',
    'solana.anchor',
    'solana.verify',
    'solana.payout',
    'solana.status',
    'solana.funding',
    'agent.protocol'
  ]);

  function isMoneyEvent(event) {
    const stage = String(event.stage || '');
    if (MONEY_STAGES.has(stage)) return true;
    if (stage.startsWith('paypal.') || stage.startsWith('payout')) return true;
    // Every Solana event is about the money rail: an anchored proof, a verified
    // signature, a 70/30 transfer or its confirmation. Tagging the whole
    // namespace keeps the money accent honest without maintaining a stage list.
    if (stage.startsWith('solana')) return true;
    // A settlement is financial only when it actually acknowledged payment.
    if (stage === 'l402.settle' && event.data?.acknowledged === true) return true;
    return false;
  }

  /** Coin glyph for the money badge: devnet transfers are not euros. */
  function moneyGlyph(event) {
    const rail = String(event.data?.rail || '');
    if (String(event.stage || '').startsWith('solana') || rail === 'solana-devnet') return '◎';
    return '€';
  }

  /** Stages whose payload is agent cognition rather than protocol mechanics. */
  const AI_STAGES = new Set(['agent.reasoning', 'agent.bid', 'agent.attention']);

  function isAiEvent(event) {
    return AI_STAGES.has(String(event.stage || '')) || Boolean(event.data?.cognition);
  }

  function appendRow(event, category) {
    const placeholder = els.stream.querySelector('.empty');
    if (placeholder) placeholder.remove();

    const money = isMoneyEvent(event);
    const ai = isAiEvent(event);

    const row = document.createElement('article');
    row.className = 'entry is-open';
    row.dataset.cat = category;
    row.dataset.level = event.level === 'error' || event.level === 'warn' ? event.level : 'info';
    if (money) row.dataset.money = 'true';
    if (ai) row.dataset.ai = 'true';

    const head = document.createElement('header');
    head.className = 'entry-head';
    head.title = 'Toggle the raw JSON payload';

    const seq = span('entry-seq', `#${String(event.seq ?? 0).padStart(4, '0')}`);
    const time = span('entry-time', formatClock(event.at, true));
    const stage = span('entry-stage', String(event.stage));
    const title = span('entry-title', String(event.title || 'Event'));
    const source = span('entry-source', String(event.source || ''));
    const caret = span('entry-caret', '›');

    head.append(seq, time, stage);
    if (money) head.append(span('entry-money', moneyGlyph(event)));
    if (ai) head.append(span('entry-ai', 'AI'));
    head.append(title, source, caret);
    head.addEventListener('click', () => row.classList.toggle('is-open'));

    const detail = document.createElement('p');
    detail.className = 'entry-detail';
    detail.textContent = String(event.detail || '').slice(0, ai ? 700 : 400);

    const json = document.createElement('pre');
    json.className = 'entry-json';
    json.innerHTML = highlight(event);

    row.append(head);
    if (event.detail) row.append(detail);

    const cognition = event.data && event.data.cognition;
    if (cognition) {
      row.append(buildThoughtBlock(cognition));
    }

    row.append(json);

    els.stream.append(row);

    while (els.stream.querySelectorAll('.entry').length > MAX_ROWS) {
      const first = els.stream.querySelector('.entry');
      if (!first) break;
      first.remove();
    }

    // Follow tail means follow tail: every new row pulls the view to the
    // bottom, whether or not the reader had scrolled up. Unchecking the switch
    // is the only way to stay put.
    scrollToEnd();
  }

  /** Pins the stream to its newest row. */
  function scrollToEnd() {
    if (!els.follow.checked) return;
    els.stream.scrollTop = els.stream.scrollHeight;
  }

  function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  /**
   * The agent's step trace, rendered as a compact ordered list above the JSON.
   *
   * This is the part a judge reads: every line is one decision the agent took,
   * followed by the provider, token cost and latency that produced it.
   */
  function buildThoughtBlock(cognition) {
    const block = document.createElement('div');
    block.className = 'entry-thought';

    const meta = document.createElement('p');
    meta.className = 'thought-meta';
    const usage = cognition.usage || {};
    const parts = [
      `${cognition.provider}/${cognition.model}`,
      `${usage.promptTokens ?? 0} prompt + ${usage.completionTokens ?? 0} completion tok${usage.estimated ? ' (est)' : ''}`,
      `${cognition.latencyMs ?? 0} ms`
    ];
    if (cognition.fallback) {
      parts.push(
        `fallback from ${cognition.fallbackProvider || 'hosted'}${cognition.fallbackModel ? `/${cognition.fallbackModel}` : ''}`
      );
    }
    if (cognition.disagreement) parts.push('model disagreed · heuristic authoritative');
    if (cognition.confidence != null) parts.push(`confidence ${cognition.confidence}`);
    meta.textContent = parts.join(' · ');
    block.append(meta);

    const list = document.createElement('ol');
    list.className = 'thought-steps';
    for (const step of (Array.isArray(cognition.steps) ? cognition.steps : []).slice(0, 8)) {
      const item = document.createElement('li');
      item.textContent = String(step);
      list.append(item);
    }
    if (list.childElementCount > 0) block.append(list);

    return block;
  }

  /**
   * Pretty-prints the full envelope. The source strings are escaped before any
   * markup is added, so a page title containing `<script>` is displayed, not
   * executed. This is the one place innerHTML is used.
   */
  function highlight(event) {
    const full = {
      seq: event.seq,
      at: event.at,
      stage: event.stage,
      source: event.source,
      level: event.level,
      title: event.title,
      detail: event.detail,
      data: event.data
    };

    const text = escapeHtml(JSON.stringify(full, null, 2));

    return text.replace(
      /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"\s*:)|("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")|\b(true|false)\b|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (match, key, string, bool, number) => {
        if (key) return `<span class="t-key">${key}</span>`;
        if (string) return `<span class="t-str">${string}</span>`;
        if (bool) return `<span class="t-bool">${bool}</span>`;
        if (number) return `<span class="t-num">${number}</span>`;
        return '<span class="t-null">null</span>';
      }
    );
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ------------------------------------------------------------------ */
  /* Rail: index events into pipeline state                             */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* Runbook: the four acts, derived from the stream                     */
  /* ------------------------------------------------------------------ */

  const ACT_ORDER = ['attention', 'challenge', 'macaroon', 'payout'];

  const ACT_NOTES = {
    attention: 'Waiting for reader attention… open /demo/ and hold a placement in view for 6 s.',
    challenge: 'Attention proof accepted · the page answers with a 402 contract.',
    macaroon: 'Macaroon minted · verifying caveats and crediting the 70/30 split.',
    payout: 'Reader balance is above threshold · settle it on PayPal or Solana Devnet.',
    done: 'Run complete · the batch is in the Sandbox and the proof hash is on devnet.'
  };

  /**
   * Turns raw stream events into the four-step narrative a judge follows.
   * Every transition is driven by a real event, never by a timer: if the
   * attention proof is refused, act 1 stays open.
   */
  function advanceRunbook(event) {
    const stage = String(event.stage || '');
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    if (stage === 'system' && /reset/i.test(String(event.title || ''))) {
      state.acts = { attention: false, challenge: false, macaroon: false, payout: false };
      renderRunbook();
      return;
    }

    const before = ACT_ORDER.map((key) => state.acts[key]).join('|');

    if (stage === 'attention' || stage === 'request') state.acts.attention = true;
    if (stage === 'l402.challenge' || stage === 'l402.contract') state.acts.challenge = true;
    if (stage === 'l402.issue' || stage === 'l402.verify' || stage === 'l402.settle') {
      state.acts.macaroon = true;
    }

    if (stage === 'payout' && data.batchId) state.acts.payout = true;
    if (stage === 'solana.payout' && (data.signature || data.batchId)) state.acts.payout = true;
    if (stage === 'paypal.payout') {
      const status = Number(data.response?.status);
      if (status >= 200 && status < 300) state.acts.payout = true;
    }

    if (ACT_ORDER.map((key) => state.acts[key]).join('|') !== before) renderRunbook();
  }

  function renderRunbook() {
    const current = ACT_ORDER.find((key) => !state.acts[key]) || null;
    const completed = ACT_ORDER.filter((key) => state.acts[key]).length;

    for (const node of els.acts) {
      const key = node.dataset.act;
      node.classList.toggle('is-done', Boolean(state.acts[key]));
      node.classList.toggle('is-current', key === current);
    }

    if (els.runbookState) {
      els.runbookState.textContent = current
        ? `act ${ACT_ORDER.indexOf(current) + 1} / 4`
        : 'complete';
      els.runbookState.className = `card-tag ${current ? (completed === 0 ? '' : 'is-warn') : 'is-live'}`;
    }

    if (els.runbookNote) {
      els.runbookNote.textContent = current ? ACT_NOTES[current] : ACT_NOTES.done;
    }
  }

  function resetRunbook() {
    state.acts = { attention: false, challenge: false, macaroon: false, payout: false };
    renderRunbook();
  }

  function index(event, category) {
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    if (category === 'ai') {
      indexCognition(event, data);
    }

    if (category === 'attention') {
      indexAttention(event, data);
    }

    if (event.stage === 'decision' || data.agent) {
      indexAgent(data.agent || data, data);
    }

    // Multi-advertiser rotation: the slot switched sponsor, so the agent card
    // follows whoever is buying now.
    if (event.stage === 'rotation' && data.advertiser) {
      indexAgent(
        {
          id: data.advertiser.id,
          name: data.advertiser.name,
          bid: data.advertiser.bid,
          sponsor: data.advertiser.sponsor,
          creativeId: data.advertiser.creativeId
        },
        data
      );
    }

    if (event.stage === 'score' && Number.isFinite(Number(data.score))) {
      els.agentScore.textContent = `${Math.round(Number(data.score))}/100`;
    }

    if (category === 'l402') {
      indexL402(event, data);
    }

    if (category === 'paypal') {
      indexPaypal(event, data);
    }

    if (category === 'solana') {
      indexSolana(event, data);
    }

    if (event.stage === 'ledger' && data.balances) {
      const split = data.split || {};
      renderBalance(data.balances.user, data.balances.publisher);
      if (Number.isFinite(Number(split.user)) && Number.isFinite(Number(split.publisher))) {
        els.agentState.textContent = `${euro(split.user)} / ${euro(split.publisher)}`;
        els.agentState.title = 'Reader 70% / publisher 30% for the last approved impression';
      }
    }
  }

  /**
   * Agent cognition card.
   *
   * Fed only by events that carry a `cognition` envelope, so the panel can never
   * display a thought that no agent actually produced.
   */
  function indexCognition(event, data) {
    const cognition = data.cognition;
    if (!cognition) return;

    state.ai.calls += 1;
    state.ai.tokens += Number(cognition.usage?.totalTokens) || 0;

    setText(els.aiProvider, cognition.provider || '—');
    setText(els.aiModel, cognition.model || '—');
    setText(
      els.aiTokens,
      `${state.ai.tokens} tok · ${state.ai.calls} call${state.ai.calls === 1 ? '' : 's'}`
    );
    setText(
      els.aiLatency,
      Number.isFinite(Number(cognition.latencyMs)) ? `${cognition.latencyMs} ms` : '—'
    );

    const hosted = cognition.hosted === true;
    els.aiState.textContent = cognition.fallback
      ? 'fallback'
      : cognition.degraded
        ? 'degraded'
        : hosted
          ? 'hosted model'
          : 'local reasoner';
    els.aiState.className =
      `card-tag ${cognition.fallback || cognition.degraded ? 'is-warn' : hosted ? 'is-live' : ''}`.trim();
    els.aiState.title = cognition.fallbackReason || '';

    if (event.stage === 'agent.attention') {
      const confidence = Number(data.confidence);
      setText(
        els.aiVerdict,
        `${data.verdict || 'unknown'}${Number.isFinite(confidence) ? ` · ${Math.round(confidence * 100)}%` : ''}`
      );
      els.aiVerdict.className = data.approved ? 'ai-good' : 'ai-bad';
      setText(els.aiThought, String(data.narrative || ''));
      return;
    }

    if (event.stage === 'agent.reasoning') {
      const bids = Array.isArray(data.bids) ? data.bids : [];
      const winner = bids.find((bid) => bid.agentId === data.winnerId);
      // The verdict field belongs to the attention agent; the auction only
      // updates relevance, so "human · 99%" is never overwritten by "5/5 bidding".
      if (winner) {
        setText(els.aiRelevance, `${Number(winner.relevance).toFixed(2)} · ${winner.sponsor}`);
        els.aiRelevance.title = `${bids.filter((b) => b.verdict === 'bid').length}/${bids.length} agents bidding`;
      }
      return;
    }

    if (event.stage === 'agent.bid') {
      setText(els.aiRelevance, `${Number(data.relevance).toFixed(2)} · ${data.sponsor}`);
      setText(els.aiThought, String(data.rationale || ''));
    }
  }

  function indexAttention(event, data) {    const value =
      event.stage === 'attention'
        ? Number(data.attention)
        : event.stage === 'score'
          ? Number(data.score)
          : NaN;

    if (Number.isFinite(value)) {
      const score = clamp(Math.round(value), 0, 100);
      els.attentionValue.textContent = String(score);
      els.attentionFill.style.width = `${score}%`;
      els.attentionFill.classList.toggle('is-low', score < 45);
    }

    if (event.stage === 'attention') {
      setText(els.attentionPhase, data.phase || 'measuring');
      setText(
        els.attentionSlot,
        data.slot ? `${data.slot}/${data.slots ?? '?'} · ${percent(data.slotRatio)}` : percent(data.slotRatio)
      );
      setText(els.attentionActive, percent(data.inViewRatio));
      setText(els.attentionDepth, percent(data.scrollDepth));
      setText(
        els.attentionSession,
        data.session ? `#${data.session} · ${Number(data.elapsedMs || 0) / 1000}s` : '—'
      );

      if (data.impressions != null) {
        els.agentState.textContent = `${data.impressions}/${data.impressionsMax ?? 2} impressions`;
      }
    }

    if (event.stage === 'score') {
      setText(els.attentionPhase, 'scored');
    }
  }

  function indexAgent(agent, data) {
    if (!agent) return;

    if (agent.id) {
      els.agentId.textContent = agent.id;
      els.agentId.title = agent.name || agent.id;
    }
    if (agent.name) els.agentState.textContent = agent.name;
    if (Number.isFinite(Number(agent.bid))) els.agentBid.textContent = euro(agent.bid);
    if (agent.sponsor || agent.creativeId) {
      els.agentCreative.textContent = [agent.sponsor, agent.creativeId].filter(Boolean).join(' · ');
    }
    if (data.offerId) els.agentOffer.textContent = data.offerId;
    else if (agent.offerId) els.agentOffer.textContent = agent.offerId;
  }

  function indexL402(event, data) {
    /*
     * Two entry points feed this card:
     *  - /api/offer  (the extension): challenge → issue → verify
     *  - /api/l402/* (protocol clients): contract → settle → issue → verify → access
     */
    if (event.stage === 'l402.contract') {
      els.l402State.textContent = '402 challenge';
      els.l402State.className = 'card-tag is-warn';
      setText(els.l402Offer, data.selected_offer_id || '—');
      if (data.selected_offer_id) els.l402Offer.title = data.selected_offer_id;
      setText(els.l402Context, `${String(data.paymentContextToken || '').slice(0, 8)}…`);
      if (data.paymentContextToken) els.l402Context.title = data.paymentContextToken;
      setText(els.l402Id, 'pending signature');
      setText(els.l402Caveats, String((data.offers?.[0]?.payment_methods || []).join(', ') || '—'));
      setText(els.l402Hash, truncate(data.paymentHash, 22));
      if (data.paymentHash) els.l402Hash.title = data.paymentHash;
      setText(els.l402Expiry, formatClock(data.expires_at, true));
      setText(els.l402Signature, '—');
      els.l402Note.textContent = data.error
        ? `${data.error.code} · ${data.error.message}`
        : `POST ${new URL(data.payment_request_url || 'http://localhost').pathname} with payment_context_token`;
      return;
    }

    if (event.stage === 'l402.settle') {
      if (data.phase === 'settle' && data.approved === false) {
        els.l402State.textContent = 'refused';
        els.l402State.className = 'card-tag is-bad';
        els.l402Note.textContent = `${data.reason || 'Attention not verified'} · score ${data.score}/100`;
        return;
      }
      els.l402State.textContent = data.acknowledged ? 'settled' : 'proof accepted';
      els.l402State.className = 'card-tag is-live';
      if (data.receipt?.contractOfferId) setText(els.l402Offer, data.receipt.contractOfferId);
      if (data.receipt?.paymentHash) {
        setText(els.l402Hash, truncate(data.receipt.paymentHash, 22));
        els.l402Hash.title = data.receipt.paymentHash;
      }
      els.l402Note.textContent = data.receipt
        ? `Bearer token issued · ${data.receipt.reference} · ${euro(data.receipt.split?.user)} reader`
        : event.detail || 'Payment request accepted.';
      return;
    }

    if (event.stage === 'l402.access') {
      if (event.level === 'warn') {
        els.l402State.textContent = 'access refused';
        els.l402State.className = 'card-tag is-bad';
        els.l402Note.textContent = event.detail || 'The bearer token was rejected.';
        return;
      }
      els.l402State.textContent = 'consumed';
      els.l402State.className = 'card-tag is-live';
      setText(els.l402Signature, `verified via ${data.grant?.via || 'bearer'}`);
      els.l402Note.textContent = data.impression
        ? `${data.impression.reference} · ${euro(data.impression.split?.user)} reader · ${data.impression.agent?.id}`
        : event.detail || 'Paid resource served.';
      return;
    }

    if (event.stage === 'l402.challenge') {
      els.l402State.textContent = 'challenge';
      els.l402State.className = 'card-tag is-warn';
      setText(els.l402Offer, data.offerId || '—');
      setText(els.l402Context, '—');
      setText(els.l402Id, 'pending signature');
      setText(els.l402Caveats, String((data.caveats || []).length || '—'));
      setText(els.l402Hash, truncate(data.paymentHash, 22));
      setText(els.l402Expiry, formatClock(data.expiresAt, true));
      setText(els.l402Signature, '—');
      els.l402Note.textContent = data.header?.['WWW-Authenticate'] || '402 challenge issued.';
      return;
    }

    const macaroon = data.macaroon || {};
    if (event.stage === 'l402.issue') {
      els.l402State.textContent = 'issued';
      els.l402State.className = 'card-tag is-live';
      setText(els.l402Id, macaroon.id || '—');
      setText(els.l402Caveats, String(macaroon.caveats ?? '—'));
      setText(els.l402Hash, truncate(macaroon.paymentHash, 22));
      setText(els.l402Expiry, formatClock(macaroon.expiresAt, true));
      setText(els.l402Signature, macaroon.signature || '—');
      els.l402Note.textContent = 'HMAC-SHA256 caveat chain minted against the 402 challenge.';
      return;
    }

    if (event.stage === 'l402.verify' || event.stage === 'l402') {
      const valid = data.verification?.valid ?? macaroon.valid;
      els.l402State.textContent = data.verification?.status || macaroon.status || 'verified';
      els.l402State.className = `card-tag ${valid ? 'is-live' : 'is-bad'}`;
      setText(els.l402Id, macaroon.id || '—');
      setText(els.l402Caveats, String(macaroon.caveats ?? '—'));
      setText(els.l402Hash, truncate(macaroon.paymentHash, 22));
      setText(els.l402Expiry, formatClock(macaroon.expiresAt, true));
      setText(els.l402Signature, valid ? 'verified' : 'invalid');
      els.l402Note.textContent =
        data.verification?.reason || event.detail || 'Macaroon verified.';
    }
  }

  function indexPaypal(event, data) {
    if (event.stage === 'paypal.oauth') {
      const body = data.response?.body || {};
      els.paypalOauth.textContent = body.access_token
        ? `${body.token_type || 'Bearer'} · ${body.expires_in || '?'}s`
        : 'failed';
      els.paypalOauth.style.color = body.access_token ? '' : 'var(--red)';
      return;
    }

    if (event.stage === 'paypal.payout') {
      const response = data.response?.body || {};
      const header = response.batch_header || {};
      if (header.payout_batch_id) {
        state.batchId = header.payout_batch_id;
        els.paypalBatch.textContent = header.payout_batch_id;
        els.paypalBatch.title = header.payout_batch_id;
        updatePayoutButton();
      }
      if (header.batch_status) setPayoutStatus(header.batch_status);
      if (header.amount?.value) {
        els.paypalAmount.textContent = moneyLabel(header.amount.value, header.amount.currency);
      }
      const item = Array.isArray(response.items) ? response.items[0] : null;
      if (item?.receiver) {
        els.paypalRecipient.textContent = item.receiver;
        els.paypalRecipient.title = item.receiver;
      }
      els.paypalNote.textContent = header.payout_batch_id
        ? `Payouts API ${event.title.toLowerCase()} · HTTP ${data.response?.status}.`
        : event.detail || 'Payout response received.';
      return;
    }

    if (event.stage === 'paypal.status') {
      const response = data.response?.body || {};
      const header = response.batch_header || {};
      if (header.batch_status) setPayoutStatus(header.batch_status);
      if (header.payout_batch_id) els.paypalBatch.textContent = header.payout_batch_id;
      els.paypalNote.textContent = `Batch re-read · HTTP ${data.response?.status}.`;
      return;
    }

    if (event.stage === 'payout') {
      if (data.batchId) {
        state.batchId = data.batchId;
        els.paypalBatch.textContent = data.batchId;
        updatePayoutButton();
      }
      if (data.status) setPayoutStatus(data.status);
      if (Number.isFinite(Number(data.amount))) {
        els.paypalAmount.textContent = moneyLabel(data.amount, data.currency);
      }
      if (data.receiverEmail) els.paypalRecipient.textContent = data.receiverEmail;
      els.paypalNote.textContent = event.detail || 'Payout event.';
    }
  }

  function setPayoutStatus(status) {
    const value = String(status || '').toUpperCase();
    els.paypalStatus.textContent = value || 'unknown';
    els.paypalStatus.className = 'pill';
    if (value === 'SUCCESS') els.paypalStatus.classList.add('is-success');
    else if (value === 'PENDING' || value === 'PROCESSING' || value === 'NEW') {
      els.paypalStatus.classList.add('is-pending');
    } else if (value === 'FAILED' || value === 'DENIED') els.paypalStatus.classList.add('is-failed');
  }
  function applyPaypalProfile(profile) {
    if (!profile) return;
    els.paypalMode.textContent = profile.configured === false ? 'not configured' : profile.mode;
    els.paypalMode.className = 'card-tag';
    if (profile.configured === false) els.paypalMode.classList.add('is-bad');
    else els.paypalMode.classList.add('is-live');

    if (profile.receiverEmail) {
      els.paypalRecipient.textContent = profile.receiverEmail;
      els.paypalRecipient.title = profile.receiverEmail;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Solana Devnet rail                                                 */
  /* ------------------------------------------------------------------ */

  function explorerTx(profile, signature) {
    const base = profile?.explorerBase || 'https://explorer.solana.com';
    const cluster = profile?.cluster || 'devnet';
    return `${base}/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(cluster)}`;
  }

  function explorerAddress(profile, address) {
    const base = profile?.explorerBase || 'https://explorer.solana.com';
    const cluster = profile?.cluster || 'devnet';
    return `${base}/address/${encodeURIComponent(address)}?cluster=${encodeURIComponent(cluster)}`;
  }

  /** Renders a `dd` as a real explorer link, or plain text when there is no tx. */
  function setTxLink(el, url, label) {
    if (!el) return;
    el.textContent = '';
    if (!url) {
      el.textContent = label || '—';
      return;
    }
    const link = document.createElement('a');
    link.className = 'tx-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = label;
    link.title = url;
    el.append(link);
  }

  function setSolanaState(label, tone = 'is-live') {
    if (!els.solanaState) return;
    els.solanaState.textContent = label;
    els.solanaState.className = 'card-tag';
    if (tone) els.solanaState.classList.add(tone);
  }

  function setSolanaStatus(label, tone) {
    if (!els.solanaStatus) return;
    els.solanaStatus.textContent = label || 'no tx';
    els.solanaStatus.className = 'pill';
    if (tone === 'ok') els.solanaStatus.classList.add('is-success');
    if (tone === 'pending') els.solanaStatus.classList.add('is-pending');
    if (tone === 'bad') els.solanaStatus.classList.add('is-failed');
  }

  function applySolanaProfile(profile) {
    if (!profile) return;
    state.solanaProfile = profile;

    const ready = profile.enabled !== false && profile.ready !== false;
    if (!ready) {
      setSolanaState('disabled', 'is-bad');
    } else if (state.solanaFunded === false) {
      setSolanaState('unfunded', 'is-warn');
    } else {
      setSolanaState(profile.cluster || 'devnet', 'is-live');
    }

    setText(els.solanaCluster, `${profile.cluster || 'devnet'} · ${profile.currency || 'SOL'}`);
    setText(els.solanaRate, `${profile.unitsPerEuro ?? '—'} units / €1`);

    for (const [el, value, label] of [
      [els.solanaTreasury, profile.treasury, 'Treasury'],
      [els.solanaReader, profile.reader, 'Reader wallet'],
      [els.solanaPublisher, profile.publisher, 'Publisher wallet']
    ]) {
      if (!el) continue;
      el.textContent = value ? truncate(value, 10) : '—';
      el.title = value || `${label} not configured`;
      if (value) {
        el.classList.add('mono');
      }
    }

    if (els.solanaExplorer) {
      els.solanaExplorer.href = profile.treasury
        ? explorerAddress(profile, profile.treasury)
        : profile.explorerBase || 'https://explorer.solana.com/?cluster=devnet';
    }
    if (els.solanaFaucet) {
      els.solanaFaucet.href = `https://faucet.solana.com?address=${profile.treasury || ''}&network=devnet`;
    }

    if (els.payoutSolana) {
      els.payoutSolana.disabled = !ready || state.payoutBusy;
    }

    // The note is owned by the funding/payout branches: an SSE `hello` arriving
    // after refreshSolana() must not overwrite "treasury unfunded" with the
    // generic explainer.
  }

  /** Reads live balances (the profile endpoint queries the cluster). */
  async function refreshSolana() {
    try {
      const response = await fetch('/api/solana', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      applySolanaProfile(data);

      const balance = data.balances || {};
      const lamports = Number(balance.treasury);
      if (Number.isFinite(lamports)) {
        els.solanaBalance.textContent = `${(lamports / 1e9).toFixed(4)} ${data.currency || 'SOL'}`;
      }
      if (balance.error) {
        els.solanaNote.textContent = `Balance read failed · ${balance.error}`;
        return;
      }
      if (Number.isFinite(lamports) && lamports === 0) {
        state.solanaFunded = false;
        setSolanaState('unfunded', 'is-warn');
        els.solanaNote.textContent =
          `Treasury ${data.treasury || ''} has no devnet SOL. Use Fund devnet, or the faucet link, then retry.`;
        return;
      }
      if (Number.isFinite(lamports)) {
        state.solanaFunded = true;
        setSolanaState(data.cluster || 'devnet', 'is-live');
        if (!state.solanaSignature) {
          els.solanaNote.textContent =
            `${data.currency || 'SOL'} on ${data.cluster || 'devnet'} · one transaction carries the 70/30 legs and the L402 memo.`;
        }
      }
    } catch {
      /* the stream badge already reports connectivity */
    }
  }

  function indexSolana(event, data) {
    if (event.stage === 'solana.anchor') {
      if (data.paymentHash) {
        state.solanaHash = data.paymentHash;
        setText(els.solanaHash, truncate(data.paymentHash, 18));
        els.solanaHash.title = data.paymentHash;
      }
      if (data.signature) {
        setTxLink(els.solanaAnchor, data.explorerUrl || explorerTx(state.solanaProfile, data.signature), truncate(data.signature, 12));
        setSolanaStatus(data.status || 'confirmed', data.status === 'confirmed' || data.status === 'finalized' ? 'ok' : 'pending');
        setSolanaState('anchored', 'is-live');
        els.solanaNote.textContent = `sha256(preimage) is public: ${data.signature}`;
      } else {
        setTxLink(els.solanaAnchor, data.explorerUrl, 'unfunded');
        setSolanaStatus(data.status || 'unfunded', data.status === 'unfunded' ? 'bad' : 'pending');
        if (data.status === 'unfunded') setSolanaState('unfunded', 'is-warn');
        els.solanaNote.textContent = data.reason || event.detail || 'Anchor skipped.';
      }
      return;
    }

    if (event.stage === 'solana.verify') {
      const failed = Array.isArray(data.failed) ? data.failed : [];
      const passed = data.checks?.filter((check) => check.passed).length ?? 0;
      setSolanaState(data.verified === false || failed.length ? 'proof rejected' : 'proof verified',
        failed.length ? 'is-bad' : 'is-live');
      if (data.paymentHash) {
        state.solanaHash = data.paymentHash;
        setText(els.solanaHash, truncate(data.paymentHash, 18));
        els.solanaHash.title = data.paymentHash;
      }
      els.solanaNote.textContent = failed.length
        ? `Rejected · ${failed.join(', ')}`
        : `On-chain proof verified · ${passed} checks · slot ${data.slot}`;
      return;
    }

    if (event.stage === 'solana.payout') {
      if (data.signature) {
        state.solanaSignature = data.signature;
        setTxLink(els.solanaPayout, data.explorerUrl || explorerTx(state.solanaProfile, data.signature), truncate(data.signature, 12));
        setSolanaStatus(data.status || 'processed', data.pending ? 'pending' : 'ok');
        setSolanaState(data.pending ? 'pending' : 'paid', data.pending ? 'is-warn' : 'is-live');

        const units = data.units || {};
        els.solanaNote.textContent =
          `${units.reader ?? '?'} reader + ${units.publisher ?? '?'} publisher base units · ` +
          `${units.aligned === false ? `drift ${units.drift} units · ` : ''}${data.cluster || 'devnet'}`;
        if (els.payoutRefresh) els.payoutRefresh.disabled = false;
      } else if (data.fallbackRail) {
        // The devnet leg could not run and the same 70/30 split went out on
        // PayPal. The card must not say "failed" when the reader was paid.
        const unfunded = data.status === 'unfunded';
        setSolanaStatus(unfunded ? 'unfunded' : 'failed', unfunded ? 'pending' : 'bad');
        setSolanaState('paypal fallback', 'is-warn');
        els.solanaNote.textContent = unfunded
          ? `No devnet SOL, so the same split was sent through PayPal. Fund ${truncate(data.treasury || 'the treasury', 8)} to settle on-chain.`
          : 'The devnet transfer failed; the same split was sent through PayPal.';
        if (unfunded) {
          state.solanaFunded = false;
          if (data.faucetUrl && els.solanaFaucet) els.solanaFaucet.href = data.faucetUrl;
        }
      } else {
        // An unfunded devnet treasury is not a bug in the payout: the split was
        // computed and the legs were built, there is simply no test SOL to move.
        const unfunded = data.status === 'unfunded';
        setSolanaStatus(unfunded ? 'unfunded' : 'failed', unfunded ? 'pending' : 'bad');
        setSolanaState(unfunded ? 'unfunded' : 'failed', unfunded ? 'is-warn' : 'is-bad');
        els.solanaNote.textContent = unfunded
          ? `${event.detail || 'Treasury has no SOL.'} Fund ${truncate(data.treasury || 'the treasury', 8)} at faucet.solana.com.`
          : event.detail || 'Solana payout failed.';
        if (unfunded) {
          state.solanaFunded = false;
          if (data.faucetUrl && els.solanaFaucet) els.solanaFaucet.href = data.faucetUrl;
        }
      }
      return;
    }

    if (event.stage === 'solana.funding') {
      if (event.level === 'error') {
        setSolanaState('funding failed', 'is-bad');
        els.solanaNote.textContent = event.detail || 'Devnet faucet refused the request.';
        return;
      }
      setSolanaState('funded', 'is-live');
      els.solanaNote.textContent = event.detail || 'Treasury funded.';
      refreshSolana();
      return;
    }

    if (event.stage === 'solana.status') {
      setSolanaStatus(data.confirmationStatus || 'unknown',
        data.err ? 'bad' : data.confirmationStatus === 'finalized' || data.confirmationStatus === 'confirmed' ? 'ok' : 'pending');
    }
  }

  function renderBalance(user, publisher) {
    const value = Number(user);
    if (Number.isFinite(value)) {
      state.balance = value;
      els.paypalBalance.textContent = euro(value);
    }

    if (publisher !== undefined) {
      const pub = Number(publisher);
      if (Number.isFinite(pub)) {
        state.publisher = pub;
        els.paypalPublisher.textContent = euro(pub);
      }
    }

    updatePayoutButton();
  }

  /**
   * Reader presence.
   *
   * The server only sells an impression when a visible session is alive, so
   * this is the one number that explains a quiet terminal: no readers means
   * nothing should be happening, and nothing is.
   */
  function applyPresence(presence) {
    if (!presence) return;
    const live = Number(presence.live) || 0;
    if (els.statReaders) {
      els.statReaders.textContent = `${live} reader${live === 1 ? '' : 's'}`;
      els.statReaders.title =
        live > 0
          ? `${live} live /demo/ session${live === 1 ? '' : 's'} (ttl ${presence.ttlMs} ms). No session, no impression, no payout.`
          : 'No live /demo/ session. The simulator will not sell an impression or move money.';
    }
  }

  /**
   * The 1:1 accounting check, from the server's own audit.
   *
   * `splitIsExact` is structural (reader + publisher === gross for every
   * impression); `ratioWithinOneCent` is the cumulative 70/30 test. Both must
   * hold for the badge to read "exact".
   */
  function applyAccounting(accounting) {
    if (!accounting) return;
    const inv = accounting.invariants || {};
    const balanced =
      inv.splitIsExact === true &&
      inv.readerConserved === true &&
      inv.publisherConserved === true &&
      inv.ratioWithinOneCent === true;

    if (els.statAccounting) {
      const paid = Number(accounting.grossPaid) || 0;
      els.statAccounting.textContent = balanced
        ? `70/30 · exact · €${paid.toFixed(2)} settled`
        : `70/30 · drift ${Number(inv.readerDriftCents) || 0}¢`;
      els.statAccounting.title =
        `accrued €${(Number(accounting.grossAccrued) || 0).toFixed(4)} · ` +
        `reader €${(Number(accounting.readerPaid) || 0).toFixed(4)} / ` +
        `publisher €${(Number(accounting.publisherPaid) || 0).toFixed(4)} · ` +
        `carried €${(Number(accounting.grossCarried) || 0).toFixed(4)} · ` +
        `fees ${accounting.fees?.model || 'sender-pays'} (deducted from split: ${accounting.fees?.deductedFromSplit ?? 0})`;
    }
  }

  async function refreshBalance() {
    try {
      const response = await fetch('/api/balance', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();

      if (Number.isFinite(Number(data.threshold))) {
        state.threshold = Number(data.threshold);
      }
      if (data.paypal) {
        applyPaypalProfile(data.paypal);
        if (data.paypal.dashboardUrl && els.paypalDashboard) {
          els.paypalDashboard.href = data.paypal.dashboardUrl;
        }
      }
      renderBalance(data.user?.balance, data.publisher?.balance);
      applyPresence(data.presence);
      applyAccounting(data.accounting);
      if (data.solana) applySolanaProfile(data.solana);
      if (data.payoutRail) {
        state.rail = data.payoutRail === 'solana-devnet' ? 'solana-devnet' : 'paypal_payouts';
      }

      // Restore the last batch after a reload so the card is not blank.
      const last = Array.isArray(data.payouts) ? data.payouts[0] : null;
      if (last?.paypal?.batchId && !state.batchId) {
        state.batchId = last.paypal.batchId;
        els.paypalBatch.textContent = last.paypal.batchId;
        if (last.paypal.status) setPayoutStatus(last.paypal.status);
        if (Number.isFinite(Number(last.userAmount))) {
          els.paypalAmount.textContent = moneyLabel(last.userAmount, last.paypal.currency);
        }
        els.payoutRefresh.disabled = false;
      }

      // The Solana card also survives a reload: re-read the last transfer so
      // its explorer link is one click away instead of being lost.
      if (last?.solana?.signature && !state.solanaSignature) {
        state.solanaSignature = last.solana.signature;
        setTxLink(els.solanaPayout, last.solana.explorerUrl, truncate(last.solana.signature, 12));
        setSolanaStatus(last.solana.status || 'confirmed', last.solana.pending ? 'pending' : 'ok');
        if (last.solana.units) {
          els.solanaNote.textContent =
            `${last.solana.units.reader} reader + ${last.solana.units.publisher} publisher base units · ${last.solana.cluster || 'devnet'}`;
        }
        els.payoutRefresh.disabled = false;
      }
    } catch {
      /* the connection badge already reports the stream state */
    }
  }

  function updatePayoutButton() {
    // PayPal payouts are denominated in whole cents, so the amount that can
    // actually leave the ledger is the balance floored to 2 decimals. Show
    // that number, not the raw 4-decimal balance, or the demo promises money
    // the batch cannot carry.
    const payable = floor2(state.balance);
    state.payable = payable;

    const ready = state.balance + 1e-9 >= state.threshold && payable >= 0.01;
    const missing = Math.max(0, state.threshold - state.balance);
    const onChain = state.rail === 'solana-devnet';

    if (els.paypalPayable) els.paypalPayable.textContent = euro2(payable);
    if (els.paypalThreshold) els.paypalThreshold.textContent = euro(state.threshold);
    // The balance minus what a whole-cent rail can move. With the €1.00 demo
    // baseline this is zero (€0.70/€0.30 are cent-exact); it only becomes
    // non-zero for an odd configured price, where the remainder is shown
    // instead of silently vanishing.
    if (els.paypalCarry) {
      els.paypalCarry.textContent = euro(Math.max(0, state.balance - payable));
      els.paypalCarry.title =
        'Sub-cent remainder held on the ledger: PayPal settles in whole cents, so it moves with the next batch.';
    }

    els.payoutRequest.disabled = !ready || state.payoutBusy;
    els.payoutRequest.textContent = state.payoutBusy
      ? (onChain ? 'Submitting to devnet…' : 'Contacting PayPal…')
      : ready
        ? (onChain ? `Settle ${euro2(payable)} on Solana` : `Settle ${euro2(payable)} to PayPal`)
        // Below the threshold, say how far there is to go. At/above it but
        // with a sub-cent carry, "€0.000 to go" would be a lie: the blocker is
        // the half cent a 2-decimal rail cannot express, not the threshold.
        : missing > 1e-9
          ? `Payout · ${euro(missing)} to go`
          : `Sub-cent carry · ${euro(Math.max(0, state.balance - payable))} held`;

    if (els.payoutSolana) {
      // The devnet rail pays in integer base units, so the payable amount is the
      // full 4-decimal balance rather than the cent-floored one.
      const devnetReady = state.balance + 1e-9 >= state.threshold;
      els.payoutSolana.disabled = !devnetReady || state.payoutBusy;
      els.payoutSolana.textContent = state.payoutBusy
        ? 'Submitting…'
        : devnetReady
          ? `Pay ${euro(state.balance)} on Solana`
          : `Solana · ${euro(missing)} to go`;
    }

    els.payoutRefresh.disabled = !(state.batchId || state.solanaSignature) || state.payoutBusy;
  }

  async function requestPayout(rail = state.rail) {
    if (state.payoutBusy) return;

    state.payoutBusy = true;
    updatePayoutButton();
    els.payoutNote.textContent = rail === 'solana-devnet'
      ? 'Building the devnet transaction (memo + both 70/30 legs)…'
      : 'Requesting an OAuth2 token and creating a payout batch…';

    try {
      const response = await fetch('/api/payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rail })
      });
      const data = await response.json();

      if (!response.ok || data.settled !== true) {
        els.payoutNote.textContent = data.message || 'The payout was not created.';
        if (rail === 'solana-devnet') {
          setSolanaStatus(data.error === 'THRESHOLD_NOT_REACHED' ? 'below threshold' : 'failed', 'bad');
          els.solanaNote.textContent = data.message || 'Solana payout failed.';
        }
      } else if (data.rail === 'solana-devnet' || data.solana?.signature) {
        const chain = data.solana || {};
        state.solanaSignature = chain.signature || '';
        setTxLink(els.solanaPayout, chain.explorerUrl, truncate(chain.signature || '', 12));
        setSolanaStatus(chain.status || 'processed', chain.pending ? 'pending' : 'ok');
        setSolanaState(chain.pending ? 'pending' : 'paid', chain.pending ? 'is-warn' : 'is-live');
        if (chain.units) {
          els.solanaNote.textContent =
            `${chain.units.reader} reader + ${chain.units.publisher} publisher base units ` +
            `(${chain.currency || 'SOL'}) · ${chain.cluster || 'devnet'}`;
        }
        els.payoutNote.textContent =
          `On-chain payout ${chain.status} · ${truncate(chain.signature || '', 16)} · ` +
          `${euro(data.payout?.userAmount)} reader / ${euro(data.payout?.publisherAmount)} publisher`;
        els.payoutRefresh.disabled = false;
      } else {
        // A Solana request that fell back to PayPal returns the PayPal shape.
        if (rail === 'solana-devnet' && data.rail === 'paypal_payouts') {
          els.solanaNote.textContent = 'Devnet transfer failed; the same split was sent through PayPal.';
          setSolanaState('fallback', 'is-warn');
        }
        const batch = data.paypal || {};
        state.batchId = batch.batchId || '';
        if (batch.batchId) els.paypalBatch.textContent = batch.batchId;
        setPayoutStatus(batch.status);
        if (Number.isFinite(Number(batch.amount))) {
          els.paypalAmount.textContent = moneyLabel(batch.amount, batch.currency);
        }
        if (batch.receiverEmail) els.paypalRecipient.textContent = batch.receiverEmail;
        els.payoutNote.textContent =
          `${batch.batchId} · ${batch.status} · ${euro(batch.amount)} → ${batch.receiverEmail}`;
      }
    } catch {
      els.payoutNote.textContent = 'Simulator unreachable.';
    }

    state.payoutBusy = false;
    await refreshBalance();
    updatePayoutButton();
    refreshSolana();
  }

  async function requestSolanaPayout() {
    return requestPayout('solana-devnet');
  }

  async function fundSolana() {
    if (state.payoutBusy) return;
    state.payoutBusy = true;
    updatePayoutButton();
    if (els.solanaFund) els.solanaFund.disabled = true;
    els.solanaNote.textContent = 'Requesting devnet SOL from the faucet…';

    try {
      const response = await fetch('/api/solana/fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sol: 1 })
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        els.solanaNote.textContent =
          data.message || 'The faucet refused the request. Fund the treasury from the faucet link.';
        setSolanaState('unfunded', 'is-warn');
        if (data.faucetUrl && els.solanaFaucet) els.solanaFaucet.href = data.faucetUrl;
      } else {
        setSolanaState('funded', 'is-live');
        els.solanaNote.textContent = `Treasury funded · ${(Number(data.balance) / 1e9).toFixed(4)} SOL`;
      }
    } catch {
      els.solanaNote.textContent = 'Simulator unreachable.';
    }

    state.payoutBusy = false;
    if (els.solanaFund) els.solanaFund.disabled = false;
    await refreshSolana();
    updatePayoutButton();
  }

  async function refreshBatch() {
    if (state.payoutBusy) return;
    if (!state.batchId && !state.solanaSignature) return;

    state.payoutBusy = true;
    updatePayoutButton();

    // The stored identifier decides which rail is re-read: a Solana signature
    // is re-checked against the cluster, a PayPal batch against the Payouts API.
    const identifier = state.batchId || state.solanaSignature;
    const onChain = Boolean(state.solanaSignature) && (!state.batchId || state.solanaSignature === identifier);
    els.payoutNote.textContent = onChain
      ? `Re-reading transaction ${truncate(identifier, 16)}…`
      : `Re-reading batch ${identifier}…`;

    try {
      const response = await fetch(`/api/payout/${encodeURIComponent(identifier)}`, {
        cache: 'no-store'
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        els.payoutNote.textContent = data.message || 'Payout status unavailable.';
      } else if (data.rail === 'solana-devnet') {
        const status = data.status || {};
        setSolanaStatus(status.confirmationStatus || 'unknown',
          status.err ? 'bad' : status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' ? 'ok' : 'pending');
        setTxLink(els.solanaPayout, status.explorerUrl, truncate(status.signature || '', 12));
        els.payoutNote.textContent =
          `Transaction ${status.confirmationStatus || 'unknown'} · slot ${status.slot ?? '—'}` +
          (status.err ? ' · error' : '');
        refreshSolana();
      } else {
        const status = data.status || {};
        setPayoutStatus(status.status);
        if (Number.isFinite(Number(status.amount))) {
          els.paypalAmount.textContent = moneyLabel(status.amount, status.currency);
        }
        els.payoutNote.textContent =
          `Batch ${status.batchId} · ${status.status}` +
          (status.itemStatus ? ` · item ${status.itemStatus}` : '');
      }
    } catch {
      els.payoutNote.textContent = 'Simulator unreachable.';
    }

    state.payoutBusy = false;
    updatePayoutButton();
  }

  /* ------------------------------------------------------------------ */
  /* Controls                                                           */
  /* ------------------------------------------------------------------ */

  function bind() {
    for (const button of els.filters) {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter || 'all';
        for (const other of els.filters) other.classList.toggle('is-active', other === button);
        rebuild();
      });
    }

    els.pause.addEventListener('click', () => {
      state.paused = !state.paused;
      els.pause.setAttribute('aria-pressed', String(state.paused));
      els.pause.textContent = state.paused ? 'Resume' : 'Pause';
      els.statPaused.hidden = !state.paused;
      if (!state.paused) flushPending();
    });

    els.clear.addEventListener('click', () => {
      state.events = [];
      state.pending = [];
      state.counts = { all: 0, ai: 0, l402: 0, attention: 0, paypal: 0, solana: 0, negotiation: 0 };
      state.ai = { calls: 0, tokens: 0 };
      state.errors = 0;
      rebuild();
      updateCounters();
    });

    els.expandAll.addEventListener('click', () => {
      for (const row of els.stream.querySelectorAll('.entry')) row.classList.add('is-open');
    });

    els.collapseAll.addEventListener('click', () => {
      for (const row of els.stream.querySelectorAll('.entry')) row.classList.remove('is-open');
    });

    els.download.addEventListener('click', () => {
      const lines = state.events.map((event) => JSON.stringify(event)).join('\n');
      const blob = new Blob([lines ? `${lines}\n` : ''], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `adpal-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
      link.click();
      URL.revokeObjectURL(url);
    });

    els.follow.addEventListener('change', () => {
      if (els.follow.checked) els.stream.scrollTop = els.stream.scrollHeight;
    });

    els.payoutRequest.addEventListener('click', () => requestPayout());
    if (els.payoutSolana) els.payoutSolana.addEventListener('click', requestSolanaPayout);
    if (els.solanaFund) els.solanaFund.addEventListener('click', fundSolana);
    els.payoutRefresh.addEventListener('click', refreshBatch);
    if (els.resetRun) els.resetRun.addEventListener('click', resetRun);
  }

  /* ------------------------------------------------------------------ */
  /* New run                                                             */
  /* ------------------------------------------------------------------ */

  async function resetRun() {
    const proceed = window.confirm(
      'Start a new demo run?\n\nThis clears the stream and resets the simulator ledger to zero. ' +
        'Payout batches already sent to PayPal are not reversed.'
    );
    if (!proceed) return;

    state.events = [];
    state.pending = [];
    state.counts = { all: 0, ai: 0, l402: 0, attention: 0, paypal: 0, solana: 0, negotiation: 0 };
    state.ai = { calls: 0, tokens: 0 };
    state.errors = 0;
    state.batchId = '';
    state.solanaSignature = '';
    state.solanaHash = '';
    state.payoutBusy = false;
    state.filter = 'all';

    for (const button of els.filters) {
      button.classList.toggle('is-active', button.dataset.filter === 'all');
    }

    resetRunbook();
    resetPanels();
    rebuild();
    updateCounters();

    try {
      await fetch('/api/dev/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
    } catch {
      /* the stream badge already reports whether the simulator is reachable */
    }

    await refreshBalance();
  }

  /** Puts the rail back to its Act 1 state without touching the connection. */
  function resetPanels() {
    setText(els.attentionValue, '0');
    els.attentionFill.style.width = '0%';
    els.attentionFill.classList.remove('is-low');
    els.attentionPhase.textContent = 'idle';
    setText(els.attentionSlot, '—');
    setText(els.attentionActive, '—');
    setText(els.attentionDepth, '—');
    setText(els.attentionSession, '—');

    els.agentState.textContent = 'awaiting offer';
    setText(els.agentOffer, '—');
    setText(els.agentId, '—');
    setText(els.agentBid, '—');
    setText(els.agentCreative, '—');
    setText(els.agentScore, '—');

    els.aiState.textContent = 'awaiting';
    els.aiState.className = 'card-tag';
    setText(els.aiVerdict, '—');
    els.aiVerdict.className = '';
    setText(els.aiRelevance, '—');
    setText(els.aiTokens, '0 tok · 0 calls');
    setText(els.aiLatency, '—');
    setText(els.aiThought, 'No agent thought yet. Hold a placement in view.');

    els.l402State.textContent = 'no token';
    els.l402State.className = 'card-tag';
    setText(els.l402Offer, '—');
    setText(els.l402Context, '—');
    setText(els.l402Id, '—');
    setText(els.l402Caveats, '—');
    setText(els.l402Hash, '—');
    setText(els.l402Expiry, '—');
    setText(els.l402Signature, '—');
    els.l402Note.textContent = 'Waiting for the first 402 challenge.';

    setText(els.paypalBatch, '—');
    setText(els.paypalAmount, '—');
    setText(els.paypalOauth, 'not requested');
    setPayoutStatus('');
    els.paypalNote.textContent = 'Payout bodies are streamed with credentials redacted.';

    state.balance = 0;
    state.publisher = 0;
    setText(els.paypalBalance, euro(0));
    renderBalance(0, 0);
    els.payoutNote.textContent =
      'Payouts are created by the server through the configured rail (PayPal or Solana Devnet).';

    setSolanaState(state.solanaProfile?.cluster || 'devnet', 'is-live');
    setTxLink(els.solanaAnchor, null, '—');
    setTxLink(els.solanaPayout, null, '—');
    setText(els.solanaHash, '—');
    setSolanaStatus('no tx');
    if (els.solanaNote) {
      els.solanaNote.textContent =
        'One devnet transaction carries both 70/30 legs and the L402 memo.';
    }
  }

  function flushPending() {
    const queued = state.pending;
    state.pending = [];
    for (const event of queued) {
      const category = categorize(event);
      if (state.filter === 'all' || state.filter === category) appendRow(event, category);
    }
    if (els.follow.checked) els.stream.scrollTop = els.stream.scrollHeight;
  }

  function rebuild() {
    els.stream.replaceChildren();
    const visible = state.events.filter(
      (event) => state.filter === 'all' || categorize(event) === state.filter
    );

    if (visible.length === 0) {
      els.stream.append(emptyState());
      return;
    }

    for (const event of visible) appendRow(event, categorize(event));
    els.stream.scrollTop = els.stream.scrollHeight;
  }

  /**
   * Act 1 panel. The original markup is cloned so the "Waiting for reader
   * attention…" state comes back exactly as authored, not as a generic string.
   */
  function emptyState() {
    if (state.filter === 'all' && emptyTemplate) return emptyTemplate.cloneNode(true);

    const empty = document.createElement('div');
    empty.className = 'empty';

    const kicker = document.createElement('p');
    kicker.className = 'empty-kicker';
    kicker.textContent = state.events.length ? 'Filtered view' : 'Act 1 · standing by';

    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = state.events.length
      ? 'No events in this category yet.'
      : 'Waiting for reader attention…';

    const body = document.createElement('p');
    body.className = 'empty-body';
    body.textContent = state.events.length
      ? 'Switch the filter back to All to see the rest of the stream.'
      : 'Open /demo/ in a second window. Hold a sponsored placement in view for about six seconds.';

    empty.append(kicker, title, body);
    return empty;
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                         */
  /* ------------------------------------------------------------------ */

  function formatClock(value, withMillis = false) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '—';
    const base = date.toLocaleTimeString('en-GB', { hour12: false });
    if (!withMillis) return base;
    return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  }

  function percent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `${Math.round(clamp(number, 0, 1) * 100)}%`;
  }

  function euro(value) {
    return `€${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3
    }).format(Number(value) || 0)}`;
  }

  /** Two-decimal amount, the precision a PayPal payout batch can carry. */
  function euro2(value) {
    return `€${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(value) || 0)}`;
  }

  function floor2(value) {
    return Math.floor((Number(value) + 1e-9) * 100) / 100;
  }

  /** Payout amounts arrive with two decimals from PayPal; keep that precision. */
  function moneyLabel(value, currency = 'EUR') {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    const code = String(currency || 'EUR').toUpperCase();
    if (code === 'EUR') return `€${amount.toFixed(2)}`;
    return `${code} ${amount.toFixed(2)}`;
  }

  function truncate(value, max) {
    const text = String(value ?? '');
    return text.length <= max ? text || '—' : `${text.slice(0, max)}…`;
  }

  function setText(element, value) {
    if (element) element.textContent = value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  /* Deliberately last: every `const` above (ACT_ORDER in particular) must be
   * initialised before the first render or an incoming event would hit the
   * temporal dead zone and take the whole view down. */

  connect();
  bind();
  renderRunbook();
  refreshBalance();
  refreshSolana();
  window.setInterval(refreshBalance, 5000);
  // Balances are a cluster read, not a counter: poll them less often so the
  // devnet RPC is not hit five times a minute for a demo.
  window.setInterval(refreshSolana, 20000);
})();
