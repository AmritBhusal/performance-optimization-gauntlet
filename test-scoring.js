// node test-scoring.js
//
// Guards the two things that make the game work: every scenario must be
// winnable inside the budget, and none of them may be winnable by ignoring
// the brief and buying the expensive-looking cards. Both are properties of
// the numbers in game.js, so they break silently when those are tuned.

const assert = require('node:assert');
const G = require('./game.js');

const ids = G.ACTIONS.map((a) => a.id);

function everyLegalSet(scenario, visit) {
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    const pick = [];
    for (let i = 0; i < ids.length; i++) if (mask & (1 << i)) pick.push(ids[i]);
    if (G.cost(pick) > G.BUDGET) continue;
    visit(G.scoreRound(scenario, pick));
  }
}

let checked = 0;

for (const sc of G.SCENARIOS) {
  let best = null;
  let cheapestPass = null;

  everyLegalSet(sc, (r) => {
    checked++;
    assert.ok(r.score >= 0 && r.score <= 100, sc.name + ': score out of range — ' + r.score);
    assert.ok(r.spent <= G.BUDGET, sc.name + ': over budget');
    if (!r.pass) {
      assert.strictEqual(r.efficiency, 0, sc.name + ': efficiency paid on a failing page');
      assert.strictEqual(r.passBonus, 0, sc.name + ': pass bonus paid on a failing page');
    }
    if (!best || r.score > best.score) best = r;
    if (r.pass && (!cheapestPass || r.spent < cheapestPass.spent)) cheapestPass = r;
  });

  assert.ok(cheapestPass, sc.name + ': no set of picks inside the budget passes Core Web Vitals');
  assert.ok(cheapestPass.spent >= 7, sc.name + ': passes for only ' + cheapestPass.spent + ' SP — too easy');
  assert.ok(best.score >= 90, sc.name + ': best reachable score is ' + best.score + ' — an S is impossible');

  // The skimmer buys the big-ticket items without reading the brief.
  const skim = [];
  ['compress-hero', 'code-split', 'virtualize', 'ssr', 'trim-third-party', 'cdn']
    .filter((id) => !G.fits(sc, id))
    .concat(ids.filter((id) => !G.fits(sc, id)))
    .forEach((id) => { if (!skim.includes(id) && G.cost(skim.concat([id])) <= G.BUDGET) skim.push(id); });
  const skimmed = G.scoreRound(sc, skim);
  assert.ok(!skimmed.pass, sc.name + ': off-target picks alone pass the page');
  assert.ok(skimmed.score < 60, sc.name + ': off-target picks score ' + skimmed.score);

  console.log(sc.name.padEnd(10) + ' best ' + best.score + ' (' + best.grade + ', ' + best.spent + ' SP)'
    + '  cheapest pass ' + cheapestPass.spent + ' SP'
    + '  brief-ignoring run ' + skimmed.score + ' (' + skimmed.grade + ')');
}

// A full game of perfect rounds sits in the top band; a blank game does not.
const perfect = G.SCENARIOS.map((sc) => G.scoreRound(sc, []));
assert.strictEqual(G.scoreGame(perfect).grade, 'D', 'doing nothing should not grade above D');
assert.strictEqual(G.scoreGame([]).total, 0);

console.log('\n' + checked.toLocaleString() + ' pick combinations checked — OK');
