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
  const ms = rows.map((r) => ({ t: r[0], h: r[1], a: r[2], hg: r[3], ag: r[4], hs: r[5], as: r[6], hst: r[7], ast: r[8], pin: r[13] && r[14] && r[15] ? [r[13], r[14], r[15]] : null }));
  // xG estimé par les tirs : conversion estimée sur la phase de chauffe (même logique que l'application)
  const warm = ms.slice(0, Math.max(60, Math.floor(ms.length * 0.35))).flatMap((m) => [[m.hst, m.hs, m.hg], [m.ast, m.as, m.ag]]).filter((x) => x[0] != null && x[1] != null);
  if (warm.length >= 100) {
    let s11 = 0, s12 = 0, s22 = 0, y1 = 0, y2 = 0;
    for (const [on, tot, g] of warm) { const off = Math.max(0, tot - on); s11 += on * on; s12 += on * off; s22 += off * off; y1 += on * g; y2 += off * g; }
    const det = s11 * s22 - s12 * s12;
    let a = (y1 * s22 - y2 * s12) / det, b = (y2 * s11 - y1 * s12) / det;
    if (!(a > 0) || !(b >= 0)) { a = y1 / s11; b = 0; }
    for (const m of ms) if (m.hst != null && m.hs != null && m.ast != null && m.as != null) { m.hxg = a * m.hst + b * Math.max(0, m.hs - m.hst); m.axg = a * m.ast + b * Math.max(0, m.as - m.ast); }
  }
  const t0 = Date.now();
  const bt = SP.footballBacktest(ms);
  if (!bt) continue;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  out.leagues[lk] = {
    n: bt.n, naive: r4(bt.naive.logLoss), models: Object.fromEntries(Object.entries(bt.models).map(([k, v]) => [k, r4(v.logLoss)])),
    ensemble: r4(bt.ensemble.logLoss), market: bt.market ? r4(bt.market.logLoss) : null, blend: bt.blend ? r4(bt.blend.logLoss) : null,
    weights: bt.weights, wMarket: bt.wMarket ?? null, calibration: bt.calibration,
  };
  const L = out.leagues[lk];
  console.log(`${lk.padEnd(34)} n=${L.n} naïf=${L.naive} ${Object.entries(L.models).map(([k, v]) => `${k}=${v}`).join(' ')} ensemble=${L.ensemble} Pinnacle=${L.market} mélange=${L.blend} poidsMarché=${L.wMarket} poids=${JSON.stringify(L.weights)} (${Date.now() - t0} ms)`);
}
writeFileSync(`${dir}/backtest.json`, JSON.stringify(out));
