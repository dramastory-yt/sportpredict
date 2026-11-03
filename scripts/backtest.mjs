// Backtest quotidien sur les données réelles collectées (exécuté par GitHub Actions après collect.py).
// Chronologique : chaque match est prédit uniquement avec les matchs antérieurs. Écrit data/backtest.json.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
const SP = createRequire(import.meta.url)('../src/engine.js')();
const dir = process.argv[2] || 'dist/data';
const f = `${dir}/football.json`;
if (!existsSync(f)) { console.log('pas de football.json'); process.exit(0); }
const fd = JSON.parse(readFileSync(f, 'utf8'));
const out = { generatedAt: new Date().toISOString(), leagues: {} };
for (const [lk, rows] of Object.entries(fd.leagues)) {
  const ms = rows.map(SP.fdRow);
  const xi = SP.attachXG(ms);
  const refs = [...new Set(ms.map((m) => m.refSrc).filter(Boolean))];
  const t0 = Date.now();
  const bt = SP.footballBacktest(ms);
  if (!bt) continue;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  out.leagues[lk] = {
    n: bt.n, naive: r4(bt.naive.logLoss), models: Object.fromEntries(Object.entries(bt.models).map(([k, v]) => [k, r4(v.logLoss)])),
    ensemble: r4(bt.ensemble.logLoss), market: bt.market ? r4(bt.market.logLoss) : null, blend: bt.blend ? r4(bt.blend.logLoss) : null,
    weights: bt.weights, wMarket: bt.wMarket ?? null, calibration: bt.calibration, xg: xi.label, refs,
  };
  const L = out.leagues[lk];
  console.log(`${lk.padEnd(34)} n=${L.n} naïf=${L.naive} ${Object.entries(L.models).map(([k, v]) => `${k}=${v}`).join(' ')} ensemble=${L.ensemble} Pinnacle=${L.market} mélange=${L.blend} poidsMarché=${L.wMarket} poids=${JSON.stringify(L.weights)} (${Date.now() - t0} ms) | ${xi.label} | réf. ${refs.join('/')}`);
}
writeFileSync(`${dir}/backtest.json`, JSON.stringify(out));
