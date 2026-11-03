import { createRequire } from 'module';
// Test de bout en bout (Chromium headless) avec réseau intercepté.
// Les réponses simulées reproduisent le FORMAT des API (The Odds API v4, ESPN site API)
// pour tester le code ; elles ne sont jamais utilisées comme données réelles.
const { chromium } = createRequire(import.meta.url)('playwright');
const require = createRequire(import.meta.url);
const SP = require('../src/engine.js')();
const R = SP.rng(1);
const now = Date.now();
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

const EPL = ['Arsenal', 'Chelsea', 'Liverpool', 'Manchester City', 'Manchester United', 'Tottenham Hotspur', 'Newcastle United', 'Aston Villa', 'Brighton and Hove Albion', 'West Ham United', 'Everton', 'Fulham', 'Brentford', 'Crystal Palace', 'Wolverhampton Wanderers', 'Nottingham Forest', 'AFC Bournemouth', 'Leeds United', 'Burnley', 'Sunderland'];
const ESPN_NAME = (n) => n.replace('Brighton and Hove Albion', 'Brighton & Hove Albion');
const NBA = ['Boston Celtics', 'New York Knicks', 'Los Angeles Lakers', 'LA Clippers', 'Denver Nuggets', 'Miami Heat', 'Golden State Warriors', 'Phoenix Suns', 'Dallas Mavericks', 'Milwaukee Bucks', 'Oklahoma City Thunder', 'Cleveland Cavaliers'];
const oddsName = (n) => n.replace('LA Clippers', 'Los Angeles Clippers');

function espnScoreboard(url) {
  const m = url.match(/sports\/(\w+)\/([\w.]+)\/scoreboard\?dates=(\d{8})-(\d{8})/);
  const [, sport, , a, b] = m;
  const p = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const from = p(a), to = p(b) + 86400e3;
  const teams = sport === 'soccer' ? EPL : NBA;
  const events = [];
  for (let t = from; t < Math.min(to, now - 3 * 3600e3); t += sport === 'soccer' ? 86400e3 * 1.1 : 86400e3 * 0.33) {
    const h = teams[Math.floor(R() * teams.length)]; let w = h; while (w === h) w = teams[Math.floor(R() * teams.length)];
    const hi = teams.indexOf(h), wi = teams.indexOf(w);
    let hs, as;
    if (sport === 'soccer') { hs = SP.poissonDraw(R, 1.6 - hi * 0.03); as = SP.poissonDraw(R, 1.2 - wi * 0.025); }
    else { const z = SP.normalPair(R); const mar = 3 + (wi - hi) * 0.8 + 12 * z[0]; const tot = 228 + 18 * z[1]; hs = Math.round((tot + mar) / 2); as = Math.round((tot - mar) / 2); if (hs === as) hs++; }
    events.push({ id: String(Math.floor(t / 1000) + hi), date: new Date(t).toISOString(), status: { type: { completed: true, state: 'post' } },
      competitions: [{ competitors: [{ homeAway: 'home', team: { displayName: ESPN_NAME(h) }, score: String(hs) }, { homeAway: 'away', team: { displayName: ESPN_NAME(w) }, score: String(as) }] }] });
  }
  return { events };
}
function book(key, title, outs, mk = 'h2h') { return { key, title, last_update: iso(now - 4 * 60e3), markets: [{ key: mk, last_update: iso(now - 4 * 60e3), outcomes: outs }] }; }
function oddsEvents(sport) {
  if (sport === 'soccer_epl') {
    return [[0, 1], [2, 3], [4, 5]].map(([i, j], k) => {
      const h = EPL[i], a = EPL[j];
      const base = [[2.10, 3.40, 3.60], [1.75, 3.90, 4.60], [2.60, 3.30, 2.80]][k];
      const bk = (key, title, f) => ({ key, title, last_update: iso(now - 3 * 60e3), markets: [
        { key: 'h2h', last_update: iso(now - 3 * 60e3), outcomes: [{ name: h, price: +(base[0] * f[0]).toFixed(2) }, { name: 'Draw', price: +(base[1] * f[1]).toFixed(2) }, { name: a, price: +(base[2] * f[2]).toFixed(2) }] },
        { key: 'totals', last_update: iso(now - 3 * 60e3), outcomes: [{ name: 'Over', price: +(1.95 * f[0]).toFixed(2), point: 2.5 }, { name: 'Under', price: +(1.87 * f[2]).toFixed(2), point: 2.5 }] },
        { key: 'spreads', last_update: iso(now - 3 * 60e3), outcomes: [{ name: h, price: 1.93, point: -0.25 }, { name: a, price: 1.89, point: 0.25 }] }] });
      return { id: 'epl' + k, sport_key: 'soccer_epl', sport_title: 'EPL', commence_time: iso(now + (3 + k * 4) * 3600e3), home_team: h, away_team: a,
        bookmakers: [bk('pinnacle', 'Pinnacle', [1, 1, 1]), bk('unibet_eu', 'Unibet', [1.03, 0.97, 0.98]), bk('betclic', 'Betclic', [0.98, 1.0, 1.04]), bk('williamhill', 'William Hill', [0.99, 0.98, 1.0]), bk('winamax_fr', 'Winamax (FR)', [1.05, 0.95, 0.96])] };
    });
  }
  if (sport === 'basketball_nba') {
    return [[0, 1], [2, 3]].map(([i, j], k) => {
      const h = oddsName(NBA[i]), a = oddsName(NBA[j]);
      const bk = (key, title, f) => ({ key, title, last_update: iso(now - 2 * 60e3), markets: [
        { key: 'h2h', last_update: iso(now - 2 * 60e3), outcomes: [{ name: h, price: +(1.65 * f).toFixed(2) }, { name: a, price: +(2.30 / f).toFixed(2) }] },
        { key: 'spreads', last_update: iso(now - 2 * 60e3), outcomes: [{ name: h, price: 1.91, point: -3.5 }, { name: a, price: 1.91, point: 3.5 }] },
        { key: 'totals', last_update: iso(now - 2 * 60e3), outcomes: [{ name: 'Over', price: 1.90, point: 226.5 }, { name: 'Under', price: 1.92, point: 226.5 }] }] });
      return { id: 'nba' + k, sport_key: 'basketball_nba', sport_title: 'NBA', commence_time: iso(now + (5 + k) * 3600e3), home_team: h, away_team: a,
        bookmakers: [bk('pinnacle', 'Pinnacle', 1), bk('unibet_eu', 'Unibet', 1.04), bk('betsson', 'Betsson', 0.99), bk('winamax_fr', 'Winamax (FR)', 1.05)] };
    });
  }
  if (sport === 'tennis_atp_paris_masters') {
    const h = 'Player One', a = 'Player Two';
    const bk = (key, title, f) => ({ key, title, last_update: iso(now - 2 * 60e3), markets: [
      { key: 'h2h', last_update: iso(now - 2 * 60e3), outcomes: [{ name: h, price: +(1.55 * f).toFixed(2) }, { name: a, price: +(2.55 / f).toFixed(2) }] },
      { key: 'totals', last_update: iso(now - 2 * 60e3), outcomes: [{ name: 'Over', price: 1.88, point: 22.5 }, { name: 'Under', price: 1.92, point: 22.5 }] }] });
    return [{ id: 'ten0', sport_key: sport, sport_title: 'ATP Paris Masters', commence_time: iso(now + 4 * 3600e3), home_team: h, away_team: a, bookmakers: [bk('pinnacle', 'Pinnacle', 1), bk('unibet_eu', 'Unibet', 1.05), bk('winamax_fr', 'Winamax (FR)', 1.02)] }];
  }
  return [];
}

const http = require('http'), fs = require('fs');
const html = fs.readFileSync(new URL('../dist/index.html', import.meta.url));
const srv = http.createServer((q, s) => { s.writeHead(q.url.startsWith('/data/') ? 404 : 200, { 'content-type': 'text/html' }); s.end(q.url.startsWith('/data/') ? '' : html); }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}/index.html`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let oddsCalls = 0;
await page.route('**/*', async (route) => {
  const url = route.request().url();
  const json = (o, h = {}) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...h }, body: JSON.stringify(o) });
  if (url.includes('fonts.g')) return route.fulfill({ status: 200, body: '' });
  if (url.includes('the-odds-api.com/v4/sports?')) return json([
    { key: 'soccer_epl', group: 'Soccer', title: 'EPL', active: true, has_outrights: false },
    { key: 'basketball_nba', group: 'Basketball', title: 'NBA', active: true, has_outrights: false },
    { key: 'tennis_atp_paris_masters', group: 'Tennis', title: 'ATP Paris Masters', active: true, has_outrights: false }]);
  const m = url.match(/v4\/sports\/(\w+)\/odds/);
  if (m) { oddsCalls++; return json(oddsEvents(m[1]), { 'x-requests-remaining': '480', 'access-control-expose-headers': 'x-requests-remaining' }); }
  if (url.includes('/scoreboard?dates=')) return json(espnScoreboard(url));
  if (url.includes('/nba/injuries')) return json({ injuries: [{ displayName: 'Boston Celtics', injuries: [{ athlete: { displayName: 'Test Player' }, status: 'Questionable', shortComment: 'ankle' }] }] });
  if (url.includes('/news')) return json({ articles: [{ headline: 'Arsenal boss gives team news update', description: 'Press conference', published: new Date(now - 3600e3).toISOString(), links: { web: { href: 'https://www.espn.com/x' } } }] });
  if (url.includes('/summary?event=')) return json({ rosters: [] });
  if (url.includes('/data/football.json')) {
    const ev = espnScoreboard('sports/soccer/eng.1/scoreboard?dates=20250801-20261102').events;
    return json({ fetchedAt: new Date().toISOString(), leagues: { soccer_epl: ev.map((e) => { const c = e.competitions[0].competitors; const hs = +c[0].score, as = +c[1].score; return [Date.parse(e.date), c[0].team.displayName, c[1].team.displayName, hs, as, 8 + hs * 2, 7 + as * 2, 3 + hs, 2 + as, 5, 4, 1, 2, 2.2, 3.4, 3.3, 1.9, 1.95]; }) } });
  }
  if (url.includes('/data/tennis.json')) return json({ tours: { ATP: { players: { 'One P.': { elo: 1900, n: 60, surf: { hard_indoor: [1880, 12] } }, 'Two P.': { elo: 1820, n: 55, surf: { hard_indoor: [1850, 9] } } }, backtest: { n: 1200, eloLogLoss: 0.62, pinnacleLogLoss: 0.6, wMarket: 0.75, blendLogLoss: 0.598 } } } });
  if (url.includes('/data/meta.json')) return json({ generatedAt: new Date().toISOString(), sources: {} });
  if (url.startsWith('http://127.0.0.1')) return route.continue();
  return route.fulfill({ status: 404, body: 'blocked in test' });
});
await page.goto(BASE);
await page.evaluate(() => localStorage.setItem('sp:cfg', JSON.stringify({ oddsKey: 'TEST', leagues: { soccer_epl: true, soccer_france_ligue_one: false, soccer_spain_la_liga: false, soccer_italy_serie_a: false, soccer_germany_bundesliga: false, soccer_uefa_champs_league: false, soccer_uefa_europa_league: false }, maxSims: 300000, minSims: 100000 })));
await page.reload();
await page.screenshot({ path: process.argv[2] + '/dash-empty.png' });
const t0 = Date.now();
await page.click('#go');
await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 180000 });
console.log('analyse terminée en', ((Date.now() - t0) / 1000).toFixed(1), 's ; appels odds :', oddsCalls);
const A = await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('sp:analyses')).pop(); return { counts: a.counts, errors: a.errors, best: a.best && { book: a.best.book, any: a.best.bestAny, m: a.best.match, l: a.best.label, o: a.best.odds, ev: a.best.ev, s: a.best.score, sims: a.best.sims }, values: a.values.length, watch: a.watch.map((w) => w.match + ' ' + w.label + ' | ' + w.need.join('; ')), backtests: Object.keys(a.backtests || {}), tennisNote: a.events.find((e) => e.sport === 'tennis')?.statsNote, eplNote: a.events.find((e) => e.sport === 'football')?.statsNote, skips: a.events.filter((e) => e.skip).map((e) => e.skip) }; });
console.log(JSON.stringify(A, null, 1));
for (const h of ['#best', '#values', '#watch', '#calendar', '#history', '#perf', '#config', '#dashboard']) {
  await page.evaluate((x) => { location.hash = x; }, h);
  await page.waitForTimeout(150);
  if (h === '#calendar') { await page.click('.ev'); await page.waitForTimeout(100); await page.screenshot({ path: process.argv[2] + '/detail.png' }); await page.keyboard.press('Escape'); }
  await page.screenshot({ path: process.argv[2] + '/' + h.slice(1) + '.png', fullPage: h === '#best' });
}
// réanalyse
await page.click('#re');
await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 180000 });
const re = await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('sp:analyses')).pop(); return { kind: a.kind, parent: a.parentId, recheck: a.recheck?.length, picks: JSON.parse(localStorage.getItem('sp:picks')).length }; });
console.log('réanalyse :', JSON.stringify(re));
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto(BASE);
const ov = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
await mobile.screenshot({ path: process.argv[2] + '/mobile.png' });
console.log('débordement horizontal mobile :', ov);
console.log('erreurs JS :', errors.length ? errors : 'aucune');
await browser.close();
srv.close();
