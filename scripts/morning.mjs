// Alerte du matin (facultative) : exécute la VRAIE application dans un navigateur headless sur GitHub Actions,
// lance l'analyse complète puis envoie le résultat sur Telegram.
// Secrets GitHub nécessaires : ODDS_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (facultatif : BANKROLL).
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ODDS_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BANKROLL } = process.env;
if (!ODDS_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log('Alerte non configurée (secrets absents) : rien à faire.'); process.exit(0); }
const root = process.argv[2] || 'dist';
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const srv = http.createServer((q, s) => {
  const p = join(root, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !existsSync(p)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p));
}).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/index.html`;
const { chromium } = require('playwright');
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error('Telegram : HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(([k, b]) => { localStorage.setItem('sp:cfg', JSON.stringify({ oddsKey: k, ...(b ? { bankroll: +b } : {}) })); }, [ODDS_API_KEY, BANKROLL]);
  await page.reload();
  await page.click('#go');
  await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 15 * 60e3 });
  const A = await page.evaluate(() => JSON.parse(localStorage.getItem('sp:analyses') || '[]').pop());
  if (!A) throw new Error('aucune analyse produite');
  const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem('sp:cfg')));
  const C = { minEV: 0.02, kellyFrac: 0.25, maxStakePct: 0.02, bankroll: 100, ...cfg };
  const line = (p) => {
    const minOdds = Math.ceil(((1 + C.minEV - (p.pPush || 0)) / p.p) * 100) / 100;
    const k = Math.max(0, (p.p * p.odds + (p.pPush || 0) - 1) / (p.odds - 1));
    const stake = Math.round(C.bankroll * Math.min(C.maxStakePct, C.kellyFrac * k) * 100) / 100;
    const when = new Date(p.t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return `<b>${esc(p.match)}</b> (${esc(when)})\n${esc(p.label)} @ <b>${p.odds.toFixed(2)}</b> ${esc(p.book)}\nCote mini ${minOdds.toFixed(2)} · EV ${(p.ev * 100).toFixed(1)} % · mise ${stake.toFixed(2)} € · score ${p.score}/100`;
  };
  const parts = [`<b>SportPredict AI</b> — analyse du ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' })}`];
  parts.push(`${A.counts?.available ?? 0} matchs, ${(A.counts?.sims ?? 0).toLocaleString('fr-FR')} simulations`);
  if (A.daily) {
    const d = A.daily, pk = d.pick;
    parts.push(`🎯 <b>PRONOSTIC DU JOUR</b>${{ 'sûr-verif': ' (PARI SÛR, cote à vérifier)', 'sûr': ' (PARI SÛR)', 'sûr-bas': ' (PARI SÛR, cote un peu basse)', value: ' (VALUE)' }[d.kind] || ' (sans value)'} · confiance ${esc(d.confidence)}\n<b>${esc(d.match)}</b>\n${esc(pk.label)} @ <b>${pk.odds != null ? pk.odds.toFixed(2) : '≥ ' + pk.minOdds.toFixed(2) + ' (à vérifier)'}</b> ${esc(pk.book)} · ${(pk.p * 100).toFixed(0)} %\n${d.why.map((w) => '• ' + esc(w)).join('\n')}`);
  }
  if (!A.daily) parts.push('Pas de pronostic à confiance forte aujourd’hui' + (A.dailyAlt ? ` (alternative en confiance ${esc(A.dailyAlt.conf)} : ${esc(A.dailyAlt.match)} — ${esc(A.dailyAlt.label)})` : '') + '.');
  if (A.best && (!A.daily || A.daily.eventId !== A.best.eventId)) parts.push('<b>Meilleur pari value</b>\n' + line(A.best));
  if (!A.best) parts.push('Aucune value validée aujourd’hui.');
  if (A.values?.length) parts.push('<b>Autres values</b>\n' + A.values.map(line).join('\n\n'));
  if (A.safe?.length > 1) parts.push('<b>Sélections haute confiance</b>\n' + A.safe.filter((s) => s.eventId !== A.daily?.eventId).map((s) => `${esc(s.match)} : ${esc(s.label)} @ ${s.odds != null ? s.odds.toFixed(2) : '≥ ' + s.minOdds.toFixed(2) + ' (à vérifier)'} · ${(s.p * 100).toFixed(0)} %`).join('\n'));
  if (A.forecasts?.length) parts.push('<b>Pronostics les plus solides</b>\n' + A.forecasts.slice(0, 5).map((f) => `${esc(f.match)} : ${esc(f.headline)} (confiance ${esc(f.confidence)})${f.pick ? `\n  ${esc(f.pick.label)} @ ${f.pick.odds.toFixed(2)} · ${(f.pick.p * 100).toFixed(0)} %${f.pick.value ? ' · VALUE' : ''}` : ''}`).join('\n'));
  if (A.watch?.length) parts.push('<b>À surveiller</b>\n' + A.watch.slice(0, 3).map((w) => `${esc(w.match)} — ${esc(w.label)} : ${esc(w.need[0] || '')}`).join('\n'));
  if (A.errors?.length) parts.push('⚠️ ' + esc(A.errors.slice(0, 3).join(' ; ')));
  parts.push('Vérifiez la cote sur Winamax avant de parier. Aucun gain garanti. 18+');
  await send(parts.join('\n\n'));
  console.log('Alerte envoyée :', A.best ? A.best.match : 'aucun pari');
} catch (e) {
  console.error('Alerte du matin en échec :', e.message);
  try { await send('⚠️ SportPredict AI : l’analyse du matin a échoué (' + esc(e.message).slice(0, 200) + ').'); } catch { /* ignore */ }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  srv.close();
}
