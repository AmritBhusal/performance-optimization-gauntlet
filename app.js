// Player and host client for the Performance Gauntlet. The room lives on the
// server (api/room.js); this file polls it, draws whichever screen the room's
// phase calls for, and posts the one thing a player can do: ship a round.
//
// Everything about scoring lives in game.js — this file only reports it.

(function () {
  const API = '/api/room';
  const POLL_MS = 1500;
  const G = GAME;

  const $ = (id) => document.getElementById(id);
  const isAdmin = location.hash.toLowerCase().indexOf('admin') !== -1;
  const joinLink = location.origin + location.pathname + '#join';

  let S = null;            // shared room state
  let players = [];        // every seat in the room
  let me = null;           // my seat
  let pid = null;          // my seat id
  let clockSkew = 0;       // server clock minus this device's clock
  let picks = new Set();   // what I have selected this round
  let roundKey = '';       // the round the DOM below was built for
  let shipping = false;    // one ship write at a time
  let shipRefused = '';    // a round the server would not take — do not retry it
  let adminToken = '';

  const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }
  // A failed write (a host with the wrong token, say) has to stay on screen.
  // Without this the next successful poll, a second later, wipes it and the
  // host is left pressing a button that silently does nothing.
  let errSticky = false;
  function showErr(msg, sticky) {
    errSticky = !!msg && !!sticky;
    ['qrErr', 'joinErr', 'admErr'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.hidden = !msg;
      el.textContent = msg || '';
    });
  }

  /* ---------- room ---------- */
  // The round clock is the server's, so measure against its stamp.
  function serverNow() { return Date.now() + clockSkew; }

  function roundOver() {
    if (!S || S.phase !== 'round') return false;
    if (S.ended) return true;
    return !!S.startedAt && serverNow() - S.startedAt >= G.ROUND_SECONDS * 1000;
  }
  function remainingSeconds() {
    if (!S || !S.startedAt) return G.ROUND_SECONDS;
    return G.ROUND_SECONDS - (serverNow() - S.startedAt) / 1000;
  }

  async function room(body) {
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' };
    if (adminToken) {
      opts.headers = Object.assign({}, opts.headers, { 'x-admin-token': adminToken });
    }
    const res = await fetch(API + (pid ? '?pid=' + encodeURIComponent(pid) : ''), opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Room error ' + res.status);
    if (typeof data.now === 'number') clockSkew = data.now - Date.now();
    if (data.state) S = data.state;
    if (data.players) players = data.players;
    me = pid ? players.find((p) => p.id === pid) || null : null;
    render();
    return data;
  }

  async function refresh() {
    if (document.hidden) return;
    try { await room(null); if (!errSticky) showErr(''); } catch (e) { showErr(e.message); }
  }

  async function writeState(patch) {
    try { await room({ op: 'state', patch: patch }); showErr(''); } catch (e) { showErr(e.message, true); }
  }

  /* ---------- QR ---------- */
  function renderQR(boxId, urlId) {
    $(urlId).textContent = joinLink;
    const box = $(boxId);
    box.textContent = '';
    if (typeof QRCode === 'undefined') {
      // ponytail: no QR library — the typed-in link still works.
      box.innerHTML = '<span style="font-family:monospace;font-size:.72rem;color:#333;padding:1rem;text-align:center;">QR unavailable — use the link below</span>';
      return;
    }
    new QRCode(box, { text: joinLink, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  }

  /* ---------- the scoring rules, printed wherever a score is ---------- */
  function rulesHtml() {
    const t = G.TARGET;
    return '<ul>'
      + '<li><b>' + G.POINTS.perVital + ' points each</b> for LCP, INP and CLS — awarded in proportion to how much of the gap'
      + ' between the broken value and Google&rsquo;s &ldquo;good&rdquo; threshold you closed'
      + ' (LCP &le; ' + (t.lcp / 1000).toFixed(1) + 's, INP &le; ' + t.inp + 'ms, CLS &le; ' + t.cls.toFixed(2) + ').</li>'
      + '<li><b>+' + G.POINTS.pass + '</b> when all three land in the green: the page now passes Core Web Vitals.</li>'
      + '<li><b>+' + G.POINTS.efficiency + ' &times; unspent SP / ' + G.BUDGET + '</b> for efficiency — paid only if the page passes.'
      + ' A fix nobody can afford is not a fix.</li>'
      + '<li>An optimization that does not address <i>this</i> site&rsquo;s problem still helps, at <b>'
      + Math.round(G.OFF_TARGET * 100) + '% strength</b>. Read the brief before you spend.</li>'
      + '<li>Page weight is shown because it explains the other three. It is not scored.</li>'
      + '</ul>'
      + '<div class="bands">100 per scenario &middot; ' + G.SCENARIOS.length * 100 + ' total &nbsp;|&nbsp; '
      + G.BANDS.map((b) => b.grade + ' ' + (b.min ? b.min + '+' : 'below 40')).join(' &middot; ') + '</div>';
  }

  function bandHint(score) {
    const above = G.BANDS.filter((b) => score < b.min).pop();
    const at = G.BANDS.find((b) => score >= b.min);
    return above
      ? Math.round(score) + ' points — ' + (above.min - Math.round(score)) + ' more for ' + above.grade + ' (' + above.min + '+)'
      : Math.round(score) + ' points — top band (' + at.grade + ', ' + at.min + '+)';
  }

  /* ---------- boot ---------- */
  function boot() {
    adminToken = ls.get('gauntlet:token');
    pid = ls.get('gauntlet:pid') || null;

    $('qrRounds').textContent = G.SCENARIOS.length;
    $('qrBudget').textContent = G.BUDGET;
    $('qrSeconds').textContent = G.ROUND_SECONDS;
    ['rulesBox', 'rulesBoxGame', 'rulesBoxEnd'].forEach((id) => { $(id).innerHTML = rulesHtml(); });
    $('statPassed').textContent = '0/' + G.SCENARIOS.length;
    renderQR('qrBox', 'joinUrl');

    if (isAdmin) {
      $('app').classList.add('wide');
      $('tokenInput').value = adminToken;
      buildPicker();
      renderQR('qrBoxAdm', 'joinUrlAdm');
      showScreen('screen-admin');
    } else if (location.hash.toLowerCase().indexOf('join') !== -1) {
      showScreen('screen-join');
      $('nameInput').value = ls.get('gauntlet:name');
      $('nameInput').focus();
    }

    refresh();
    setInterval(refresh, POLL_MS);
    setInterval(tick, 200);
  }

  /* ---------- render dispatch ---------- */
  function render() {
    if (isAdmin) return renderAdmin();
    if (!S) return;
    // The host reset the room — every seat from the old session is gone.
    if (me && S.session && me.session !== S.session) {
      me = null; pid = null; ls.set('gauntlet:pid', '');
    }
    if (!me) {
      if (!$('screen-join').classList.contains('active')) renderLanding();
      return;
    }
    if (S.phase === 'results') return renderEnd();
    if (S.phase === 'round') return renderRound();
    return renderLobby();
  }

  function renderLanding() {
    $('qrPlayers').textContent = players.length;
    if (!$('screen-qr').classList.contains('active')) showScreen('screen-qr');
  }

  function renderLobby() {
    showScreen('screen-wait');
    $('waitName').textContent = me.name;
    $('waitPlayers').textContent = players.length;
    $('waitList').innerHTML = players.length
      ? players.map((p) => '<div class="lb-row' + (p.id === pid ? ' me' : '') + '"><span class="nm">'
        + escapeHtml(p.name) + '</span><span class="sc">' + (p.score || 0) + '</span></div>').join('')
      : '<div class="lb-empty">Nobody else yet.</div>';
  }

  /* ---------- the round ---------- */
  function myRound(i) {
    return me && me.rounds ? me.rounds[String(i)] : null;
  }

  function renderRound() {
    const sc = G.SCENARIOS[S.index];
    if (!sc) return;
    const key = S.session + ':' + S.index;
    if (roundKey !== key) {
      roundKey = key;
      const done = myRound(S.index);
      picks = new Set(done ? done.picks : []);
      buildRound(sc);
    }
    const done = myRound(S.index);
    if (done) return renderResult(sc, G.scoreRound(sc, done.picks));
    showScreen('screen-game');
    paintRound(sc);
  }

  function buildRound(sc) {
    $('roundLabel').textContent = 'SCENARIO ' + (S.index + 1) + ' / ' + G.SCENARIOS.length;
    $('siteName').textContent = sc.name;
    $('siteProblem').textContent = sc.problem;
    const wrap = $('actionsWrap');
    wrap.innerHTML = '';
    wrap.scrollTop = 0;
    G.ACTIONS.forEach((a) => {
      const div = document.createElement('div');
      div.className = 'action';
      div.dataset.id = a.id;
      div.innerHTML = '<div class="a-toggle">+</div>'
        + '<div class="a-body">'
        + '<div class="a-top"><span class="a-name">' + escapeHtml(a.name) + '</span>'
        + '<span class="a-cost">' + a.cost + ' SP</span></div>'
        + '<div class="a-tag">' + a.tag + '</div>'
        + '<div class="a-note">' + escapeHtml(a.note) + '</div></div>';
      div.addEventListener('click', () => toggle(a));
      wrap.appendChild(div);
    });
  }

  function toggle(a) {
    if (roundOver() || myRound(S.index)) return;
    if (picks.has(a.id)) picks.delete(a.id);
    else if (G.cost([...picks]) + a.cost <= G.BUDGET) picks.add(a.id);
    else return;
    paintRound(G.SCENARIOS[S.index]);
  }

  function paintRound(sc) {
    const ids = [...picks];
    const spent = G.cost(ids);
    const m = G.metrics(sc, ids);
    const locked = roundOver() || !!myRound(S.index);

    $('scoreVal').textContent = (me && me.score) || 0;
    $('budgetText').textContent = spent + ' / ' + G.BUDGET + ' SP';
    $('budgetFill').style.width = (spent / G.BUDGET) * 100 + '%';
    // Shipping nothing is a wasted round, so it takes at least one pick —
    // but the clock running out still ships whatever is on screen.
    $('shipBtn').disabled = locked || spent === 0;

    const cells = [
      { key: 'lcp', label: 'LCP', goal: '&le; ' + (G.TARGET.lcp / 1000).toFixed(1) + 's' },
      { key: 'inp', label: 'INP', goal: '&le; ' + G.TARGET.inp + 'ms' },
      { key: 'cls', label: 'CLS', goal: '&le; ' + G.TARGET.cls.toFixed(2) },
      { key: 'weight', label: 'PAGE WEIGHT', goal: 'not scored', info: true },
    ];
    $('dashboard').innerHTML = cells.map((c) => {
      const status = G.statusFor(c.key, m[c.key]);
      const cls = 'metric ' + status + (c.info ? ' info' : '');
      const badge = c.info ? 'CONTEXT' : status === 'good' ? 'GOOD' : status === 'mid' ? 'NEEDS WORK' : 'POOR';
      return '<div class="' + cls + '"><div class="val">' + G.format(c.key, m[c.key]) + '</div>'
        + '<div class="lbl">' + c.label + '</div><div class="goal">' + c.goal + '</div>'
        + '<div class="status">' + badge + '</div></div>';
    }).join('');

    Array.from(document.querySelectorAll('.action')).forEach((el) => {
      const a = G.byId[el.dataset.id];
      const on = picks.has(a.id);
      const unaffordable = !on && spent + a.cost > G.BUDGET;
      el.classList.toggle('on', on);
      el.classList.toggle('locked', locked || unaffordable);
      el.querySelector('.a-toggle').textContent = on ? '✓' : '+';
    });

    const sb = $('gameStandby');
    if (locked) {
      sb.hidden = false;
      sb.className = 'standby';
      sb.textContent = 'Time. Scoring this round…';
    } else {
      sb.hidden = true;
    }
  }

  async function ship() {
    if (shipping || !S || S.phase !== 'round' || myRound(S.index)) return;
    if (shipRefused === roundKey) return;
    shipping = true;
    const sc = G.SCENARIOS[S.index];
    const r = G.scoreRound(sc, [...picks]);
    const entry = {
      picks: r.picks, score: r.score, spent: r.spent, grade: r.grade,
      pass: r.pass, green: r.green, onTarget: r.onTarget,
    };
    // Paint the result straight away; the write below only has to catch up.
    const rounds = Object.assign({}, me.rounds);
    rounds[String(S.index)] = entry;
    me = Object.assign({}, me, { rounds: rounds });
    renderResult(sc, r);
    try {
      await room({ op: 'ship', playerId: pid, index: S.index, round: entry });
      showErr('');
    } catch (e) {
      // One refusal is final: the round closed before this reached the room.
      // Retrying every tick would only spam the room and the player.
      shipRefused = roundKey;
      $('gameStandby').hidden = false;
      $('gameStandby').textContent = 'This round closed before your picks reached the room: ' + e.message;
    }
    shipping = false;
  }

  function renderResult(sc, r) {
    showScreen('screen-result');
    $('resultTag').textContent = 'SCENARIO ' + (S.index + 1) + ' — ' + sc.name.toUpperCase();
    $('rGrade').textContent = r.grade;
    $('rLabel').textContent = r.label;
    $('rWhy').textContent = bandHint(r.score);

    $('rCompare').innerHTML = r.vitals.map((v) =>
      '<div class="compare-row"><span class="lbl">' + v.key.toUpperCase() + '</span>'
      + '<span class="before">' + G.format(v.key, v.before) + '</span>'
      + '<span class="arrow">&rarr;</span>'
      + '<span class="after' + (v.green ? ' green' : '') + '">' + G.format(v.key, v.after)
      + (v.green ? ' ✓' : ' (goal ' + G.format(v.key, v.target) + ')') + '</span>'
      + '<span class="pts">' + v.points + '/' + v.max + '</span></div>').join('')
      + '<div class="compare-row"><span class="lbl">WEIGHT</span>'
      + '<span class="before">' + G.format('weight', sc.start.weight) + '</span>'
      + '<span class="arrow">&rarr;</span>'
      + '<span class="after">' + G.format('weight', r.metrics.weight) + '</span>'
      + '<span class="pts">&mdash;</span></div>';

    const vitalPoints = r.vitals.reduce((s, v) => s + v.points, 0);
    const rows = [
      ['Core Web Vitals progress', vitalPoints + ' / ' + G.POINTS.perVital * 3, false],
      [r.pass ? 'All three green — page passes' : 'Page does not pass yet (' + r.green + '/3 green)',
        (r.pass ? '+' + r.passBonus : '0'), !r.pass],
      [r.pass ? 'Efficiency — ' + r.unspent + ' SP left unspent' : 'Efficiency (only paid on a passing page)',
        (r.efficiency ? '+' + r.efficiency : '0'), !r.efficiency],
    ];
    $('rBreakdown').innerHTML = rows.map((row) =>
      '<div class="bd-row' + (row[2] ? ' muted' : '') + '"><span>' + row[0] + '</span><span class="v">' + row[1] + '</span></div>').join('')
      + '<div class="bd-row total"><span>Round score</span><span class="v">' + r.score + ' / 100</span></div>';

    const off = r.picks.length - r.onTarget;
    $('rNote').textContent = 'You spent ' + r.spent + ' of ' + G.BUDGET + ' SP on ' + r.picks.length
      + ' optimization' + (r.picks.length === 1 ? '' : 's') + ' — ' + r.onTarget + ' of them addressed this brief'
      + (off ? ', ' + off + ' worked at ' + Math.round(G.OFF_TARGET * 100) + '% because they fix a problem this site does not have.' : '.');
    $('resultStandby').textContent = 'Waiting for the host to open the next site…';
  }

  /* ---------- final ---------- */
  function myRounds(p) {
    return G.SCENARIOS.map((sc, i) => {
      const stored = p && p.rounds ? p.rounds[String(i)] : null;
      return stored ? G.scoreRound(sc, stored.picks) : null;
    });
  }

  function renderEnd() {
    showScreen('screen-end');
    const rounds = myRounds(me);
    const g = G.scoreGame(rounds);
    $('fGrade').textContent = g.grade;
    $('fLabel').textContent = g.label;
    $('fWhy').textContent = g.total + ' of ' + g.max + ' points (' + g.pct + '%) — grades use the same bands as a single round.';
    $('finalScore').textContent = g.total;
    $('finalName').textContent = me.name + ' · points';
    $('statPassed').textContent = g.passed + '/' + G.SCENARIOS.length;
    $('statSpent').textContent = rounds.reduce((s, r) => s + (r ? r.spent : 0), 0)
      + ' / ' + G.BUDGET * G.SCENARIOS.length;

    $('roundSummary').innerHTML = G.SCENARIOS.map((sc, i) => {
      const r = rounds[i];
      return '<div class="lb-row"><span class="gr">' + (r ? r.grade : '—') + '</span>'
        + '<span class="nm">' + escapeHtml(sc.name) + '</span>'
        + '<span class="tick">' + (r ? r.green + '/3 green · ' + r.spent + ' SP' : 'not played') + '</span>'
        + '<span class="sc">' + (r ? r.score : 0) + '</span></div>';
    }).join('');
    $('lbList').innerHTML = leaderboardHtml(pid);
  }

  function ranked() {
    return players.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (a.joinedAt || 0) - (b.joinedAt || 0));
  }

  function leaderboardHtml(highlightId) {
    const rows = ranked();
    if (!rows.length) return '<div class="lb-empty">No players yet.</div>';
    return rows.map((p, i) => {
      const passed = myRounds(p).filter((r) => r && r.pass).length;
      return '<div class="lb-row' + (p.id === highlightId ? ' me' : '') + '">'
        + '<span class="rank">#' + (i + 1) + '</span>'
        + '<span class="nm">' + escapeHtml(p.name) + '</span>'
        + '<span class="tick">' + passed + '/' + G.SCENARIOS.length + ' passing</span>'
        + '<span class="sc">' + (p.score || 0) + '</span></div>';
    }).join('');
  }

  /* ---------- clock ---------- */
  function tick() {
    if (!S) return;
    const live = S.phase === 'round' && !!S.startedAt;
    const remaining = live ? remainingSeconds() : G.ROUND_SECONDS;
    const label = live && !S.ended ? Math.max(0, Math.ceil(remaining)) + 's' : S.ended ? 'ended' : G.ROUND_SECONDS + 's';

    if (isAdmin) {
      $('admClock').textContent = S.phase === 'round' ? label : '—';
      return;
    }
    if (!me || S.phase !== 'round') return;
    const pill = $('clockPill');
    pill.textContent = label;
    pill.classList.toggle('low', live && !S.ended && remaining <= 15);
    $('timerFill').style.width = Math.max(0, Math.min(1, live ? remaining / G.ROUND_SECONDS : 1)) * 100 + '%';

    // Out of time: whatever is selected ships as it stands. Nobody loses a
    // round to a slow tap, and nobody stalls the room either.
    if (roundOver() && !myRound(S.index)) ship();
  }

  /* ---------- join ---------- */
  $('joinHereBtn').addEventListener('click', () => {
    showScreen('screen-join');
    $('nameInput').value = ls.get('gauntlet:name');
    $('nameInput').focus();
  });
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('joinBtn').addEventListener('click', async () => {
    const name = $('nameInput').value.trim();
    const err = $('joinErr');
    if (!name) { err.hidden = false; err.textContent = 'Enter a name so the leaderboard can find you.'; return; }
    err.hidden = true;
    $('joinBtn').disabled = true;
    try {
      const res = await room({ op: 'join', name: name, playerId: pid });
      pid = res.playerId;
      ls.set('gauntlet:pid', pid);
      ls.set('gauntlet:name', name);
      me = players.find((p) => p.id === pid) || null;
      roundKey = '';
      showErr('');
      await refresh();
    } catch (e) {
      err.hidden = false; err.textContent = 'Could not join: ' + e.message;
    }
    $('joinBtn').disabled = false;
  });
  $('shipBtn').addEventListener('click', () => { if (!$('shipBtn').disabled) ship(); });

  /* ---------- host console ---------- */
  function buildPicker() {
    $('sPicker').innerHTML = G.SCENARIOS.map((sc, i) =>
      '<option value="' + i + '">' + (i + 1) + ' — ' + escapeHtml(sc.name) + '</option>').join('');
  }

  function renderAdmin() {
    if (!S) return;
    const sc = G.SCENARIOS[S.index] || G.SCENARIOS[0];
    const live = S.phase === 'round' && !!S.startedAt;
    const over = roundOver();

    $('admPhase').textContent = S.phase === 'round' ? (over ? 'round ended' : 'round live') : S.phase;
    $('admRound').textContent = S.phase === 'round' ? S.index + 1 + ' / ' + G.SCENARIOS.length : '—';
    $('admPlayers').textContent = players.length;

    const shipped = players.filter((p) => p.rounds && p.rounds[String(S.index)]);
    $('admShipped').textContent = shipped.length + ' / ' + players.length;

    if (document.activeElement !== $('sPicker')) $('sPicker').value = String(S.index);
    $('admProblem').textContent = sc.problem;
    // The console gets projected, so the answer key stays hidden until the
    // round is over — otherwise the room reads the fix off the wall.
    $('admFix').textContent = over || S.phase !== 'round'
      ? 'On-target here: ' + sc.fits.map((id) => G.byId[id].name).join(' · ')
      : 'Answer key hidden until the round ends';

    const last = S.index >= G.SCENARIOS.length - 1;
    $('startBtn').textContent = S.phase !== 'round' ? 'Start scenario 1' : last ? 'Show final results' : 'Next scenario →';
    $('prevBtn').disabled = S.phase !== 'round' || S.index === 0;
    $('endBtn').disabled = !live || !!S.ended;

    const counts = {};
    shipped.forEach((p) => (p.rounds[String(S.index)].picks || []).forEach((id) => { counts[id] = (counts[id] || 0) + 1; }));
    const rows = Object.keys(counts).map((id) => ({ id: id, n: counts[id] })).sort((a, b) => b.n - a.n).slice(0, 10);
    const max = Math.max(1, ...rows.map((r) => r.n));
    $('admTally').innerHTML = rows.length
      ? rows.map((r) => '<div class="tally-row' + (G.fits(sc, r.id) ? ' is-fit' : '') + '">'
        + '<span class="k">' + escapeHtml(G.byId[r.id].name) + '</span>'
        + '<span class="bar"><i style="width:' + (r.n / max) * 100 + '%"></i></span>'
        + '<span class="n">' + r.n + '</span></div>').join('')
      : '<div class="lb-empty">Nothing shipped yet.</div>';

    $('admList').innerHTML = leaderboardHtml(null);
  }

  // Opening a scenario starts its clock, so the host never starts one twice.
  function gotoIndex(i) {
    const next = Math.max(0, Math.min(G.SCENARIOS.length - 1, i));
    writeState({ phase: 'round', index: next, startedAt: 'now', ended: false });
  }

  if (isAdmin) {
    $('tokenInput').addEventListener('input', (e) => {
      adminToken = e.target.value.trim();
      ls.set('gauntlet:token', adminToken);
    });
    $('sPicker').addEventListener('change', (e) => gotoIndex(parseInt(e.target.value, 10)));
    $('prevBtn').addEventListener('click', () => gotoIndex((S ? S.index : 0) - 1));
    // One button runs the whole game: start, advance, finish.
    $('startBtn').addEventListener('click', () => {
      if (!S || S.phase !== 'round') return gotoIndex(0);
      if (S.index >= G.SCENARIOS.length - 1) return writeState({ phase: 'results', startedAt: null, ended: true });
      gotoIndex(S.index + 1);
    });
    $('endBtn').addEventListener('click', () => writeState({ ended: true }));
    $('lobbyBtn').addEventListener('click', () => writeState({ phase: 'lobby', startedAt: null, ended: false }));
    $('resetBtn').addEventListener('click', async () => {
      if (!confirm('Clear every player and score, and send everyone back to check-in?')) return;
      $('resetBtn').disabled = true;
      try { await room({ op: 'reset' }); showErr(''); } catch (e) { showErr('Reset failed: ' + e.message, true); }
      $('resetBtn').disabled = false;
    });
  }

  boot();
})();
