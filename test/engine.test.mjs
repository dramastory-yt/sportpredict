// Tests du moteur : node test/engine.test.mjs
// Les données synthétiques ci-dessous servent UNIQUEMENT à vérifier que les algorithmes
// retrouvent des paramètres connus. Elles ne sont jamais affichées dans l'application.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SP = require('../src/engine.js')();
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; } else { fails++; console.error('ÉCHEC:', msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (obtenu ${a}, attendu ${b} ± ${tol})`);

// --- cotes
near(SP.ev(0.65, 1.80), 0.17, 1e-9, 'EV exemple du cahier des charges');
const dv = SP.devig([1.9, 3.6, 4.2]);
near(dv.reduce((a, b) => a + b, 0), 1, 1e-9, 'devig somme à 1');
ok(dv[0] > 1 / 1.9 / (1 / 1.9 + 1 / 3.6 + 1 / 4.2) - 0.02, 'devig power cohérent');
const sh = SP.devigShin([1.9, 3.6, 4.2]);
near(sh.reduce((a, b) => a + b, 0), 1, 1e-9, 'Shin somme à 1');
ok(sh[0] > 1 / 1.9 / (1 / 1.9 + 1 / 3.6 + 1 / 4.2), 'Shin favorise le favori (biais favori/outsider)');
near(SP.devigShin([2, 2])[0], 0.5, 1e-9, 'Shin symétrique');
// lignes asiatiques
near(SP.settleLine(1, -0.5, 2), 2, 1e-9, 'AH -0.5 gagné');
near(SP.settleLine(0, -0.5, 2), 0, 1e-9, 'AH -0.5 perdu');
near(SP.settleLine(0, 0, 2), 1, 1e-9, 'AH 0 remboursé');
near(SP.settleLine(0, -0.25, 2), 0.5, 1e-9, 'AH -0.25 demi-perdu');
near(SP.settleLine(1, -0.75, 2), 1.5, 1e-9, 'AH -0.75 demi-gagné');
near(SP.settleLine(3 - 2.5, 0, 1.9), 1.9, 1e-9, 'Over 2.5 avec 3 buts');

// --- Poisson / DC
const m = SP.scoreMatrix(1.5, 1.1, -0.05);
const r = SP.matrix1x2(m);
near(r[0] + r[1] + r[2], 1, 1e-9, 'matrice normalisée');
const imp = SP.impliedLambdas(r, { line: 2.5, p: SP.matrixOver(m, 2.5) });
near(imp.lh, 1.5, 0.05, 'lambdas implicites λh');
near(imp.la, 1.1, 0.05, 'lambdas implicites λa');

// génère une ligue synthétique avec forces connues
const R = SP.rng(42);
const teams = Array.from({ length: 20 }, (_, i) => 'T' + i);
const trueAtt = Object.fromEntries(teams.map((t, i) => [t, (i - 9.5) / 30]));
const trueDef = Object.fromEntries(teams.map((t, i) => [t, -(i - 9.5) / 40]));
const matches = [];
let t = Date.UTC(2025, 7, 1);
for (let season = 0; season < 2; season++) for (const h of teams) for (const a of teams) {
  if (h === a) continue;
  const lh = Math.exp(Math.log(1.35) + 0.25 + trueAtt[h] + trueDef[a]);
  const la = Math.exp(Math.log(1.35) + trueAtt[a] + trueDef[h]);
  matches.push({ t: (t += 3600e3 * 11), h, a, hg: SP.poissonDraw(R, lh), ag: SP.poissonDraw(R, la) });
}
const dc = SP.fitDixonColes(matches, { xi: 0 });
near(dc.home, 0.25, 0.08, 'DC avantage domicile');
const corr = (() => {
  const xs = teams.map((x) => trueAtt[x]), ys = teams.map((x) => dc.att[x]);
  const mx = xs.reduce((a, b) => a + b) / 20, my = ys.reduce((a, b) => a + b) / 20;
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  return sxy / Math.sqrt(sxx * syy);
})();
ok(corr > 0.8, 'DC retrouve les attaques (corr=' + corr.toFixed(2) + ')');
// xG synthétique (bruité autour des λ) et cotes « marché » synthétiques pour tester les chemins xG/marché
matches.forEach((m) => { m.hxg = Math.max(0.05, m.hg * 0.5 + 0.7 + (R() - 0.5) * 0.4); m.axg = Math.max(0.05, m.ag * 0.5 + 0.5 + (R() - 0.5) * 0.4); m.pin = [2.4, 3.4, 3.1]; });
const bt = SP.footballBacktest(matches);
ok(bt.hasXG && 'xg' in bt.weights, 'backtest inclut le modèle xG');
ok(bt.wMarket != null && bt.market.n > 80, 'poids marché estimé par backtest (' + bt.wMarket + ')');
ok(bt && bt.n > 100, 'backtest football exécuté');
ok(bt.ensemble.logLoss < bt.naive.logLoss, `ensemble bat le modèle naïf (${bt.ensemble.logLoss.toFixed(4)} < ${bt.naive.logLoss.toFixed(4)})`);
near(Object.values(bt.weights).reduce((a, b) => a + b, 0), 1, 1e-6, 'poids somme à 1');

// calendrier réaliste : 2 saisons, 3 équipes remplacées (promues) en saison 2, ordre aléatoire des matchs
{
  const R2 = SP.rng(77);
  const T1 = Array.from({ length: 20 }, (_, i) => 'R' + i), T2 = [...T1.slice(0, 17), 'P1', 'P2', 'P3'];
  const st = Object.fromEntries([...T1, 'P1', 'P2', 'P3'].map((x, i) => [x, { a: (R2() - 0.5) * 0.8, d: (R2() - 0.5) * 0.6 }]));
  ['P1', 'P2', 'P3'].forEach((x) => { st[x] = { a: -0.3, d: 0.2 }; });
  const games = []; let tt = Date.UTC(2025, 7, 10);
  for (const T of [T1, T2]) {
    const fx = []; for (const h of T) for (const a of T) if (h !== a) fx.push([h, a]);
    fx.sort(() => R2() - 0.5);
    for (const [h, a] of fx) { tt += 3600e3 * 18; games.push({ t: tt, h, a, hg: SP.poissonDraw(R2, Math.exp(0.3 + 0.25 + st[h].a + st[a].d)), ag: SP.poissonDraw(R2, Math.exp(0.3 + st[a].a + st[h].d)) }); }
    tt += 60 * 86400e3;
  }
  const b2 = SP.footballBacktest(games.slice(0, 520));
  ok(b2.models.dc.logLoss < b2.naive.logLoss, `DC bat le naïf sur calendrier réaliste (${b2.models.dc.logLoss.toFixed(4)} < ${b2.naive.logLoss.toFixed(4)})`);
}

// --- Monte-Carlo football vs analytique
const key = (x, y) => x > y;
const sim = SP.simulate({ kind: 'football', lh: 1.5, la: 1.1, rho: -0.05, sigma: 0.0001, seed: 7, minN: 400000, maxN: 400000, keyEvent: key });
near(sim.key.p, r[0], 0.004, 'MC P(domicile) ≈ analytique');
const evo = SP.evalFromSim(sim, SP.normalizeSel({ type: 'over', point: 2.5 }), 2.0);
near(evo.pWin, SP.matrixOver(m, 2.5), 0.004, 'MC over 2.5 ≈ analytique');
const ah = SP.evalFromSim(sim, SP.normalizeSel({ type: 'ahHome', point: 0 }), 2.0);
near(ah.pPush, r[1], 0.004, 'AH 0 : remboursement = P(nul)');
// performance : 1M simulations
const t1 = Date.now();
const big = SP.simulate({ kind: 'football', lh: 1.4, la: 1.2, rho: -0.05, sigma: 0.1, seed: 9, minN: 1000000, maxN: 1000000, keyEvent: key });
console.log(`1 000 000 simulations football : ${Date.now() - t1} ms (scénarios: ${big.scenarios.map((s) => s.name + ' ' + (s.p * 100).toFixed(1) + '%').join(', ')})`);
// arrêt adaptatif
const ad = SP.simulate({ kind: 'football', lh: 1.4, la: 1.2, rho: 0, sigma: 0.1, seed: 3, minN: 100000, maxN: 2000000, tol: 0.002, keyEvent: key });
ok(ad.n < 2000000 && ad.key.ci95 < 0.002, `arrêt adaptatif à n=${ad.n}, IC95=±${ad.key.ci95.toFixed(4)}`);

// --- tennis
near(SP.tennisMatchProb(0.64, 0.64, 3), 0.5, 1e-6, 'tennis symétrique');
near(SP.holdProb(0.5), 0.5, 1e-9, 'hold 50%');
const sv = SP.tennisSolveServe(0.7, 0.64, 3);
near(SP.tennisMatchProb(sv.pa, sv.pb, 3), 0.7, 1e-4, 'résolution service');
const ts = SP.simulate({ kind: 'tennis', pa: sv.pa, pb: sv.pb, sigmaD: 0.0001, bestOf: 3, seed: 5, minN: 200000, maxN: 200000, keyEvent: (a, b, w) => w === 1 });
near(ts.key.p, 0.7, 0.01, 'MC tennis ≈ analytique (écart toléré : ordre de service)');
const tot = SP.evalFromSim(ts, SP.normalizeSel({ type: 'tOver', point: 21.5 }), 1.9);
const tm = SP.tennisMarkets(ts, { pa: sv.pa, pb: sv.pb, bestOf: 3 }, 'A', 'B');
near(tm.find((m) => m.key === 'TO21.5').p, tot.pWin, 1e-9, 'marchés tennis : total de jeux cohérent');
near(tm.find((m) => m.key === 'A20').p + tm.find((m) => m.key === 'B20').p + tm.find((m) => m.key === 'BOTHSET').p, 1, 1e-9, 'marchés tennis : sets cohérents');
ok(Math.abs(tm.find((m) => m.key === 'SET1A').p - 0.5) < 0.2 && tm.find((m) => m.key === 'SET1A').p > 0.5, 'tennis : favori du 1er set');
ok(tot.pWin > 0.2 && tot.pWin < 0.8, 'total de jeux plausible ' + tot.pWin.toFixed(3));
ok(!tm.some((m) => m.type === 'spread' && m.side === 'A' && m.point > 0) && !tm.some((m) => m.key === 'AWINSET'), 'tennis : pas de « favori +X jeux » ni « favori gagne un set » (non proposés par Winamax)');

// --- NBA
const nt = Array.from({ length: 30 }, (_, i) => 'N' + i);
const str = Object.fromEntries(nt.map((x, i) => [x, (i - 14.5) / 2.5]));
const games = []; let tt = Date.UTC(2025, 9, 21);
for (let k = 0; k < 1100; k++) {
  const h = nt[Math.floor(R() * 30)]; let a = h; while (a === h) a = nt[Math.floor(R() * 30)];
  const [z1, z2] = SP.normalPair(R);
  const mar = 2.5 + str[h] - str[a] + 12.5 * z1, totp = 228 + 18 * z2;
  games.push({ t: (tt += 3600e3 * 5), h, a, hs: Math.round((totp + mar) / 2), as: Math.round((totp - mar) / 2) });
}
const nb = SP.fitNBA(games, { xi: 0 });
near(nb.hca, 2.5, 1.2, 'NBA avantage terrain');
near(nb.sdMargin, 12.5, 1.5, 'NBA écart-type marge');
const nbt = SP.nbaBacktest(games);
ok(nbt && nbt.ensemble.logLoss < Math.log(2), 'NBA ensemble bat pile-ou-face');
const ns = SP.simulate({ kind: 'nba', ph: 115, pa: 110, sdM: 12.5, sdT: 18, corr: 0, sigmaM: 0.5, seed: 1, minN: 200000, maxN: 200000, keyEvent: (h, a) => h > a });
near(ns.key.p, SP.normCdf(5 / 12.5), 0.015, 'MC NBA ≈ Φ(marge/σ)');

// --- comptages (corners) et recalibrage
{
  let s = 0; for (let k = 0; k < 80; k++) s += SP.nbPmf(k, 10, 1.6);
  near(s, 1, 1e-6, 'binomiale négative normalisée');
  near(SP.nbOver(10, 1, 9.5), 1 - Array.from({ length: 10 }, (_, k) => SP.pois(k, 10)).reduce((a, b) => a + b), 1e-9, 'NB φ=1 = Poisson');
  const cm = matches.map((m) => ({ ...m, cornersH: SP.poissonDraw(R, 5.5), cornersA: SP.poissonDraw(R, 4.5) }));
  const cf = SP.fitCounts(cm, 'corners');
  const l = SP.dcLambdas(cf, 'T0', 'T1');
  near(l.lh + l.la, 10, 0.8, 'modèle corners : moyenne totale');
  const ps = [], ys = []; for (let i = 0; i < 3000; i++) { const p = 0.2 + 0.6 * R(); ps.push(p); ys.push(R() < 0.5 + (p - 0.5) * 0.6 ? 1 : 0); }
  const pl = SP.fitPlatt(ps, ys);
  ok(pl.b < 0.85 && pl.b > 0.4, 'Platt détecte la surconfiance (b=' + pl.b.toFixed(2) + ')');
  const btts = SP.evalFromSim({ kind: 'football', M: 11, hist: SP.scoreMatrix(1.5, 1.1, 0).flat() }, SP.normalizeSel({ type: 'bttsYes' }), 2);
  const ex = SP.evalFromSim({ kind: 'football', M: 11, hist: SP.scoreMatrix(1.5, 1.1, 0).flat() }, { ...SP.normalizeSel({ type: 'exact' }), h: 1, a: 0 }, 2);
  near(ex.pWin, SP.pois(1, 1.5) * SP.pois(0, 1.1) / SP.scoreMatrix(1.5, 1.1, 0).flat().reduce((x, y) => x + y, 0) * SP.scoreMatrix(1.5,1.1,0).flat().reduce((x,y)=>x+y,0), 1e-3, 'score exact 1-0');
  near(btts.pWin, (1 - Math.exp(-1.5)) * (1 - Math.exp(-1.1)), 1e-6, 'BTTS analytique');
}

// --- hockey
{
  const reg = SP.scoreMatrix(3.1, 2.7, 0, 12);
  const F = SP.hockeyFinal(reg, 0.55);
  let draw = 0, tot = 0, pH = 0; F.forEach((r, i) => r.forEach((v, j) => { tot += v; if (i === j) draw += v; if (i > j) pH += v; }));
  near(tot, 1, 1e-9, 'hockey : distribution finale normalisée');
  near(draw, 0, 1e-12, 'hockey : aucun nul au score final');
  const regH = SP.matrix1x2(reg);
  near(pH, regH[0] + regH[1] * 0.55, 1e-9, 'hockey : victoire finale = victoire TR + nul × prolongation');
  const R3 = SP.rng(5), teams = Array.from({ length: 16 }, (_, i) => 'H' + i), gs = []; let tt = Date.UTC(2025, 9, 1);
  for (let k = 0; k < 900; k++) { const h = teams[Math.floor(R3() * 16)]; let a = h; while (a === h) a = teams[Math.floor(R3() * 16)];
    let hs = SP.poissonDraw(R3, 3.2 + teams.indexOf(h) * 0.04), as = SP.poissonDraw(R3, 2.9 + teams.indexOf(a) * 0.04); if (hs === as) { if (R3() < 0.5) hs++; else as++; }
    gs.push({ t: (tt += 3600e3 * 9), h, a, hs, as }); }
  const hb = SP.hockeyBacktest(gs);
  ok(hb && hb.n > 300, 'backtest hockey exécuté (' + (hb && hb.n) + ' matchs)');
  const otg = gs.map((g, i) => ({ ...g, ot: i % 4 === 0 ? 1 : 0 }));
  const dk = SP.hockeyDrawK(otg);
  const m2 = SP.inflateDraws(SP.scoreMatrix(2.9, 2.9, 0, 12), dk.k); let d2 = 0; m2.forEach((r, i) => { d2 += r[i]; });
  near(d2, 0.25, 0.03, 'nuls au temps réglementaire calés sur le taux de prolongations (25 %)');
}

// --- score qualité
const q = SP.qualityScore({ edge: 0.04, priceEdge: 0.04, p: 0.6, fairMkt: 0.58, uncert: 0.015, modelGap: 0.02, dataQuality: 0.8, calib: 0.5, mcSpread: 0.05, simCI: 0.002, oddsAgeMin: 5, booksAtPrice: 2, riskPenalty: 0, odds: 1.85 });
ok(SP.confidence({ p: 0.86, dataQuality: 0.7, gap: 0.02, risk: 0, uncert: 0.03 }) === 'très haute', 'confiance très haute');
ok(SP.confidence({ p: 0.65, dataQuality: 0.7, gap: 0.02, risk: 0, uncert: 0.03 }) === 'moyenne', 'confiance moyenne 60-69 %');
ok(SP.confidence({ p: 0.55, dataQuality: 0.7, gap: 0.02, risk: 0, uncert: 0.03 }) === 'faible', 'confiance faible < 60 %');
ok(!SP.isStrong(SP.confidence({ p: 0.86, dataQuality: 0.3, gap: null, risk: 0, uncert: 0.03 })), 'pas de confiance haute sans modèle indépendant');
ok(SP.confidence({ p: 0.80, dataQuality: 0.7, gap: 0.09, risk: 0, uncert: 0.03 }) === 'intéressante', 'désaccord des modèles : confiance réduite');
ok(SP.confidence({ p: 0.90, dataQuality: 0.7, gap: 0.15, risk: 0, uncert: 0.03 }) === 'moyenne', 'fort désaccord : moyenne au mieux');
ok(SP.reliability({ dataQuality: 0.8, nHist: 600, calib: 0.6, mcSpread: 0.03, paramSd: 0.02 }).total > 60, 'fiabilité modèle');
ok(q.total > 50 && q.total <= 100 && q.parts.length === 8, 'score qualité ' + q.total);

console.log(`\n${passes} tests réussis, ${fails} échec(s)`);
process.exit(fails ? 1 : 0);
