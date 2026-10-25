'use strict';

/**
 * Creative library served by the simulated ad server.
 *
 * Every entry is a distinct advertiser profile: a sponsor, its creative, and
 * the autonomous buying agent that negotiates the placement. The extension
 * never hard-codes advertising content — it asks for an offer and renders
 * whatever creative the ad server assigns.
 *
 * The server rotates across these profiles (see `rotation.js`) instead of
 * pinning one sponsor to one placement, so a page that declares several slots
 * shows several advertisers, and a long-running slot can rotate to a new one.
 * Each profile carries its own campaign budget, which the advertiser agent
 * authorizes before an offer is credited.
 */

const CREATIVES = Object.freeze([
  Object.freeze({
    id: 'northbound-coffee',
    sponsor: 'Northbound Coffee',
    headline: 'Coffee that wakes up your ideas.',
    body: 'Small-batch roasting, delivered to your door every week.',
    cta: 'Discover Northbound',
    theme: 'coffee',
    // Identity of the autonomous buyer that negotiates this placement. The
    // terminal shows these verbatim, so a judge can match a creative to the
    // agent that bid for it.
    agent: Object.freeze({
      id: 'agt_northbound_01',
      name: 'Northbound Media Agent',
      bid: 0.02
    }),
    campaign: Object.freeze({
      budget: 18.0,
      objective: 'reader-acquisition',
      markets: Object.freeze(['NL', 'DE', 'BE'])
    })
  }),
  Object.freeze({
    id: 'lumen-audio',
    sponsor: 'Lumen Audio',
    headline: 'Quiet headphones for deep work.',
    body: 'Forty hours of battery, tuned for long reading sessions.',
    cta: 'Explore Lumen',
    theme: 'audio',
    agent: Object.freeze({
      id: 'agt_lumen_02',
      name: 'Lumen Demand Agent',
      bid: 0.02
    }),
    campaign: Object.freeze({
      budget: 14.0,
      objective: 'consideration',
      markets: Object.freeze(['FR', 'NL'])
    })
  }),
  Object.freeze({
    id: 'terrace-greens',
    sponsor: 'Terrace Greens',
    headline: 'A desk garden that keeps up.',
    body: 'Self-watering planters made for small apartments.',
    cta: 'Meet Terrace Greens',
    theme: 'plants',
    agent: Object.freeze({
      id: 'agt_terrace_03',
      name: 'Terrace Growth Agent',
      bid: 0.02
    }),
    campaign: Object.freeze({
      budget: 10.0,
      objective: 'trial-signup',
      markets: Object.freeze(['NL'])
    })
  }),
  Object.freeze({
    id: 'halden-optics',
    sponsor: 'Halden Optics',
    headline: 'Reading glasses for screen light.',
    body: 'Amber-tinted lenses that take the edge off a long afternoon.',
    cta: 'See the collection',
    theme: 'neutral',
    agent: Object.freeze({
      id: 'agt_halden_04',
      name: 'Halden Retail Agent',
      bid: 0.02
    }),
    campaign: Object.freeze({
      budget: 12.0,
      objective: 'direct-sale',
      markets: Object.freeze(['DE', 'AT'])
    })
  }),
  Object.freeze({
    id: 'field-notes-press',
    sponsor: 'Field Notes Press',
    headline: 'Notebooks for people who still underline.',
    body: 'Lay-flat binding, dot grid, made in a small workshop.',
    cta: 'Browse the press',
    theme: 'neutral',
    agent: Object.freeze({
      id: 'agt_fieldnotes_05',
      name: 'Field Notes Culture Agent',
      bid: 0.02
    }),
    campaign: Object.freeze({
      budget: 8.0,
      objective: 'brand-awareness',
      markets: Object.freeze(['NL', 'FR'])
    })
  })
]);

function pickCreative(index) {
  const safeIndex = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return CREATIVES[safeIndex % CREATIVES.length];
}

/** Creative as the extension consumes it — campaign data stays server-side. */
function creativePayload(creative) {
  return {
    id: creative.id,
    sponsor: creative.sponsor,
    headline: creative.headline,
    body: creative.body,
    cta: creative.cta,
    theme: creative.theme
  };
}

module.exports = { CREATIVES, pickCreative, creativePayload };
