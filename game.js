// The content of the game and every rule that turns a set of picks into a
// score. No DOM in here: the browser loads it as a plain script, and
// test-scoring.js requires it in node to prove each scenario is winnable.
//
// Scoring, in one paragraph, because the players are told it up front:
// each scenario is worth 100 points. LCP, INP and CLS are worth 25 each,
// awarded in proportion to how much of the gap between the broken value and
// Google's "good" threshold the player closed. Landing all three under the
// threshold ("this page now passes Core Web Vitals") adds 15. Only a page
// that passes earns the last 10, scaled by the sprint points left unspent —
// a fix nobody can afford is not a fix. Page weight is shown because it
// explains the other three, but it is not scored: Google does not score it
// either.

var GAME = (function () {
  const BUDGET = 12;
  const ROUND_SECONDS = 90;

  // Google's "good" thresholds — the same numbers CrUX and PageSpeed use.
  const TARGET = { lcp: 2500, inp: 200, cls: 0.1 };

  // Nothing is infinitely fast: a real page still has to connect, parse and
  // paint. Without a floor, stacking every card drives LCP to zero.
  const FLOOR = { lcp: 800, inp: 30, cls: 0, weight: 280 };

  // An optimization that has nothing to do with this site's problem still
  // does something — just not much. Virtualizing a table on a news article
  // is not free and not useless, it is beside the point.
  const OFF_TARGET = 0.4;

  const POINTS = { perVital: 25, pass: 15, efficiency: 10 };
  const BANDS = [
    { min: 90, grade: 'S', label: 'SPEED DEMON' },
    { min: 75, grade: 'A', label: 'FAST BY DEFAULT' },
    { min: 60, grade: 'B', label: 'PASSING GRADE' },
    { min: 40, grade: 'C', label: 'NEEDS WORK' },
    { min: 0, grade: 'D', label: 'STILL MOLASSES' },
  ];

  const ACTIONS = [
    { id: 'compress-hero', tag: 'IMAGES', name: 'Compress & resize the hero image', cost: 2,
      note: 'A full-resolution photo shipped into a small container. Resizing and compressing it cuts the biggest single asset on the page.',
      fx: { lcp: -900, weight: -600 } },
    { id: 'webp', tag: 'IMAGES', name: 'Convert images to WebP/AVIF', cost: 1,
      note: 'Modern formats give the same visual quality at a much smaller file size than JPG or PNG.',
      fx: { lcp: -400, weight: -350 } },
    { id: 'lazy-images', tag: 'IMAGES', name: 'Lazy load offscreen images', cost: 1,
      note: 'Images below the fold stop competing for bandwidth with what the user can actually see.',
      fx: { lcp: -300, weight: -150 } },
    { id: 'code-split', tag: 'BUNDLES', name: 'Code-split routes & features', cost: 2,
      note: 'Breaks one giant bundle into route-sized chunks, so the browser downloads only what this page needs.',
      fx: { lcp: -400, inp: -70, weight: -450 } },
    { id: 'tree-shake', tag: 'BUNDLES', name: 'Tree-shake unused JavaScript', cost: 1,
      note: 'Removes imported-but-never-used code from the production bundle.',
      fx: { lcp: -100, inp: -30, weight: -300 } },
    { id: 'brotli', tag: 'BUNDLES', name: 'Enable Brotli compression', cost: 1,
      note: 'Compresses text assets at the CDN before they ever hit the network.',
      fx: { lcp: -200, weight: -400 } },
    { id: 'preload', tag: 'LOADING', name: 'Preload the hero image & critical font', cost: 1,
      note: 'The browser starts fetching the most important asset immediately instead of discovering it late.',
      fx: { lcp: -350 } },
    { id: 'preconnect', tag: 'LOADING', name: 'Preconnect to font & CDN origins', cost: 1,
      note: 'DNS and TLS for third-party domains finish ahead of time, so the real request goes straight to downloading.',
      fx: { lcp: -200 } },
    { id: 'defer-js', tag: 'LOADING', name: 'Defer non-critical JavaScript', cost: 1,
      note: 'Scripts the page does not need immediately stop blocking HTML parsing and first render.',
      fx: { lcp: -350, inp: -40 } },
    { id: 'trim-third-party', tag: 'REQUESTS', name: 'Trim third-party scripts', cost: 2,
      note: 'Every analytics, ad and widget script costs a request and main-thread time. Fewer of them, less to block on.',
      fx: { lcp: -300, inp: -110, weight: -250 } },
    { id: 'cdn', tag: 'CACHING', name: 'Put static assets on a CDN', cost: 2,
      note: 'Files come from a server near the visitor instead of one origin far away.',
      fx: { lcp: -450 } },
    { id: 'cache-headers', tag: 'CACHING', name: 'Add proper cache headers', cost: 1,
      note: 'Cache-Control and ETag let repeat visits skip re-downloading files that have not changed.',
      fx: { lcp: -150, weight: -100 } },
    { id: 'reserve-space', tag: 'LAYOUT', name: 'Reserve space for images & embeds', cost: 1,
      note: 'Width and height set up front stop the page jumping as content loads in.',
      fx: { cls: -0.16 } },
    { id: 'font-swap', tag: 'LAYOUT', name: 'Load fonts with font-display: swap', cost: 1,
      note: 'Avoids the invisible-text flash and the reflow when a custom font finally arrives.',
      fx: { cls: -0.06, lcp: -100 } },
    { id: 'no-late-inject', tag: 'LAYOUT', name: 'Stop late-injected content shifting the page', cost: 1,
      note: 'Banners and embeds that appear after first render push everything else around.',
      fx: { cls: -0.12 } },
    { id: 'virtualize', tag: 'RUNTIME', name: 'Virtualize the long list or table', cost: 2,
      note: 'Renders only the rows in the viewport instead of the whole dataset.',
      fx: { inp: -120, weight: -120 } },
    { id: 'debounce', tag: 'RUNTIME', name: 'Debounce search & filter inputs', cost: 1,
      note: 'Waits for typing to pause before filtering, instead of firing on every keystroke.',
      fx: { inp: -60 } },
    { id: 'ssr', tag: 'RENDERING', name: 'Server-render the page (SSR/SSG)', cost: 2,
      note: 'Ships HTML that already has content, instead of an empty shell the browser fills in with JavaScript.',
      fx: { lcp: -500, inp: -30 } },
  ];

  // `fits` is the diagnosis: the optimizations that actually address what the
  // brief describes. Everything else still helps a little (OFF_TARGET), so a
  // player who skims the brief and buys the expensive-looking cards finishes
  // the round with a red metric and no budget left.
  const SCENARIOS = [
    {
      id: 'slowmart', name: 'SlowMart',
      problem: 'E-commerce product page. The hero product photo is a 4000px original squeezed into a 600px box, and a third-party reviews widget pops in late and shoves the "Buy Now" button down the page.',
      start: { lcp: 4800, inp: 320, cls: 0.32, weight: 4200 },
      fits: ['compress-hero', 'webp', 'lazy-images', 'preload', 'cdn', 'cache-headers',
        'reserve-space', 'no-late-inject', 'font-swap', 'trim-third-party', 'defer-js', 'brotli'],
    },
    {
      id: 'dailybyte', name: 'DailyByte',
      problem: 'News article page. Six ad and analytics scripts run above the fold before any text paints, and the comments section drops in as one chunky block after everything else has rendered.',
      start: { lcp: 4400, inp: 330, cls: 0.26, weight: 3600 },
      fits: ['trim-third-party', 'defer-js', 'preconnect', 'lazy-images', 'brotli', 'cdn',
        'cache-headers', 'reserve-space', 'no-late-inject', 'ssr', 'tree-shake', 'font-swap'],
    },
    {
      id: 'pulsecrm', name: 'PulseCRM',
      problem: 'Internal SaaS dashboard. One 5 MB JavaScript bundle loads for every screen, and typing in the filter box re-renders all 5,000 customer rows on each keystroke, freezing the tab.',
      start: { lcp: 3600, inp: 520, cls: 0.08, weight: 5100 },
      fits: ['code-split', 'tree-shake', 'brotli', 'virtualize', 'debounce', 'defer-js',
        'cdn', 'cache-headers', 'preload', 'trim-third-party'],
    },
    {
      id: 'wanderly', name: 'Wanderly',
      problem: 'Travel booking site. Destination photos ship as uncompressed 3 MB JPGs, and the booking widget has no reserved height, so the whole layout jumps down once it finishes loading.',
      start: { lcp: 4700, inp: 280, cls: 0.28, weight: 4800 },
      fits: ['compress-hero', 'webp', 'lazy-images', 'preload', 'cdn', 'brotli', 'cache-headers',
        'reserve-space', 'no-late-inject', 'font-swap', 'trim-third-party', 'preconnect'],
    },
    {
      id: 'fittrack', name: 'FitTrack',
      problem: 'Fitness app landing page. An autoplaying background video sits behind the hero text, three separate social embeds animate themselves in, and the whole page is client-rendered from an empty shell.',
      start: { lcp: 5200, inp: 340, cls: 0.24, weight: 5500 },
      fits: ['ssr', 'trim-third-party', 'defer-js', 'preload', 'compress-hero', 'lazy-images',
        'cdn', 'preconnect', 'no-late-inject', 'reserve-space', 'code-split', 'webp'],
    },
  ];

  const byId = {};
  ACTIONS.forEach((a) => { byId[a.id] = a; });

  function cost(ids) {
    return ids.reduce((sum, id) => sum + (byId[id] ? byId[id].cost : 0), 0);
  }

  function fits(scenario, id) {
    return scenario.fits.indexOf(id) !== -1;
  }

  function metrics(scenario, ids) {
    const m = Object.assign({}, scenario.start);
    ids.forEach((id) => {
      const a = byId[id];
      if (!a) return;
      const mult = fits(scenario, id) ? 1 : OFF_TARGET;
      ['lcp', 'inp', 'cls', 'weight'].forEach((k) => {
        if (a.fx[k]) m[k] += a.fx[k] * mult;
      });
    });
    m.lcp = Math.max(FLOOR.lcp, Math.round(m.lcp));
    m.inp = Math.max(FLOOR.inp, Math.round(m.inp));
    m.cls = Math.max(FLOOR.cls, Math.round(m.cls * 100) / 100);
    m.weight = Math.max(FLOOR.weight, Math.round(m.weight));
    return m;
  }

  // How much of the distance from broken to "good" this player closed.
  // Overshooting the threshold is not worth extra: a 0.9s LCP scores the
  // same 25 as a 2.4s one, because both are green in the field data.
  function progress(startV, value, targetV) {
    if (startV <= targetV) return 1;
    return Math.max(0, Math.min(1, (startV - value) / (startV - targetV)));
  }

  function band(score) {
    return BANDS.find((b) => score >= b.min);
  }

  // The one function everything else in the app reports on.
  function scoreRound(scenario, ids) {
    const picks = ids.filter((id) => byId[id]);
    const m = metrics(scenario, picks);
    const spent = cost(picks);
    const unspent = BUDGET - spent;

    const vitals = ['lcp', 'inp', 'cls'].map((k) => ({
      key: k,
      before: scenario.start[k],
      after: m[k],
      target: TARGET[k],
      green: m[k] <= TARGET[k],
      points: Math.round(POINTS.perVital * progress(scenario.start[k], m[k], TARGET[k])),
      max: POINTS.perVital,
    }));

    const green = vitals.filter((v) => v.green).length;
    const pass = green === 3;
    const passBonus = pass ? POINTS.pass : 0;
    const efficiency = pass ? Math.round((POINTS.efficiency * unspent) / BUDGET) : 0;
    const score = vitals.reduce((s, v) => s + v.points, 0) + passBonus + efficiency;
    const b = band(score);

    return {
      scenarioId: scenario.id,
      picks: picks,
      metrics: m,
      spent: spent,
      unspent: unspent,
      vitals: vitals,
      green: green,
      pass: pass,
      passBonus: passBonus,
      efficiency: efficiency,
      onTarget: picks.filter((id) => fits(scenario, id)).length,
      score: score,
      grade: b.grade,
      label: b.label,
    };
  }

  // Five rounds of 100. The final grade is read off the same bands as a
  // round, so "A" means the same thing at the end as it did in round 2.
  function scoreGame(rounds) {
    const total = rounds.reduce((s, r) => s + (r ? r.score : 0), 0);
    const max = SCENARIOS.length * 100;
    const pct = max ? (total / max) * 100 : 0;
    const b = band(pct);
    return {
      total: total, max: max, pct: Math.round(pct),
      grade: b.grade, label: b.label,
      passed: rounds.filter((r) => r && r.pass).length,
    };
  }

  function statusFor(key, value) {
    if (key === 'lcp') return value <= 2500 ? 'good' : value <= 4000 ? 'mid' : 'bad';
    if (key === 'inp') return value <= 200 ? 'good' : value <= 500 ? 'mid' : 'bad';
    if (key === 'cls') return value <= 0.1 ? 'good' : value <= 0.25 ? 'mid' : 'bad';
    return value <= 1500 ? 'good' : value <= 3000 ? 'mid' : 'bad';
  }

  function format(key, value) {
    if (key === 'lcp') return (value / 1000).toFixed(1) + 's';
    if (key === 'inp') return Math.round(value) + 'ms';
    if (key === 'cls') return value.toFixed(2);
    return (value / 1000).toFixed(1) + 'MB';
  }

  return {
    BUDGET: BUDGET, ROUND_SECONDS: ROUND_SECONDS, TARGET: TARGET, POINTS: POINTS, BANDS: BANDS,
    OFF_TARGET: OFF_TARGET, ACTIONS: ACTIONS, SCENARIOS: SCENARIOS, byId: byId,
    cost: cost, fits: fits, metrics: metrics, scoreRound: scoreRound, scoreGame: scoreGame,
    statusFor: statusFor, format: format,
  };
})();

if (typeof module !== 'undefined') module.exports = GAME;
