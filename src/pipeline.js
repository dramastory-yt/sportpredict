/* SportPredict AI — pipeline d'analyse (phase 1 présélection, phase 2 approfondie). */
const SPPipeline = (() => {
  const SP = SPEngineFactory();
  const D = SPData;
  const DAY = 86400e3;

  // ------------------------------------------------------------ configuration
  const DEFAULT_CFG = {
    oddsKey: '', claudeKey: '', regions: 'eu', markets: 'h2h,totals,spreads', targetBook: 'winamax_fr',
    leagues: Object.fromEntries(Object.entries(D.FOOTBALL).map(([k, v]) => [k, v.on])),
    tennis: true, nba: true, maxTennisTournaments: 4,
    footballScope: 'toutes', basketScope: 'principal', creditBudget: 30, monthlyCredits: 500, creditReserve: 50, prescanMin: 60, excluded: [], included: [],
    wMarket: 0.65, minEV: 0.02, minOdds: 1.15, maxOdds: 2.5, prefLo: 1.40, prefHi: 2.20,
    bankroll: 100, kellyFrac: 0.25, maxStakePct: 0.02, mode: 'sûr', dailyMinP: 0.75, safeMinP: 0.70, safeMaxOdds: 1.50, safeTolEV: -0.03, safeStakePct: 0.02, maxOddsAgeMin: 45, maxGap: 0.10, maxSims: 1000000, minSims: 100000, tol: 0.0015, phase2Events: 14,
    hours: 24, extendTo48: true, autoOn: false, autoTime: '09:00', notif: false, preMatchRecheck: false,
  };
  function cfg() {
    const c = { ...DEFAULT_CFG, ...D.LS.get('sp:cfg', {}) };
    c.leagues = { ...DEFAULT_CFG.leagues, ...(c.leagues || {}) };
    return c;
  }
  function saveCfg(c) { D.LS.set('sp:cfg', c); }

  // ------------------------------------------------------------ workers Monte-Carlo
  let pool = null;
  function makePool() {
    const src = `${SPEngineFactory.toString()}
const SP = SPEngineFactory();
onmessage = (e) => {
  const { id, spec, sel } = e.data;
  const key = (x, y, w) => {
    const m = sel.type === 'spread' ? SP.selMargin(sel, x - y, 0, w) : SP.selMargin(sel, x, y, w);
    return SP.settleShares(m, sel.line).win > 0.5;
  };
  try {
    const out = SP.simulate({ ...spec, keyEvent: key }, (n) => postMessage({ id, progress: n }));
    postMessage({ id, done: out });
  } catch (err) { postMessage({ id, error: String(err) }); }
};`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    const workers = Array.from({ length: n }, () => new Worker(url));
    return { workers, n };
  }
  function runSims(tasks, onProgress) {
    if (!pool) pool = makePool();
    return new Promise((resolve) => {
      const results = new Array(tasks.length);
      let next = 0, done = 0, simsDone = 0;
      const live = new Map();
      if (!tasks.length) return resolve(results);
      const start = (w) => {
        if (next >= tasks.length) return;
        const i = next++;
        live.set(i, 0);
        w.onmessage = (e) => {
          const m = e.data;
          if (m.progress != null) { live.set(i, m.progress); onProgress && onProgress(done, tasks.length, simsDone + [...live.values()].reduce((a, b) => a + b, 0)); return; }
          live.delete(i);
          results[i] = m.done || { error: m.error };
          if (m.done) simsDone += m.done.n;
          done++;
          onProgress && onProgress(done, tasks.length, simsDone);
          if (done === tasks.length) resolve(results); else start(w);
        };
        w.postMessage({ id: i, spec: tasks[i].spec, sel: tasks[i].sel });
      };
      pool.workers.forEach(start);
    });
  }

  // Compétitions principales (régulières, bien couvertes) : les seules interrogées par défaut.
  const FOOT_MAIN = new Set(['soccer_france_ligue_one', 'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga',
    'soccer_uefa_champs_league', 'soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league',
    'soccer_france_ligue_two', 'soccer_efl_champ', 'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga']);
  const BASKET_MAIN = new Set(['basketball_nba', 'basketball_euroleague']);
  const groupOfSport = (s) => (s.group === 'Soccer' ? 'football' : s.group === 'Basketball' ? 'basket' : s.group === 'Tennis' ? 'tennis' : s.group === 'Ice Hockey' ? 'hockey' : null);
  function isDefault(s, C) {
    const g = groupOfSport(s);
    if (g === 'football') return C.footballScope !== 'principal' || FOOT_MAIN.has(s.key);
    if (g === 'tennis') return C.tennis !== false;
    // v3 : football et tennis uniquement (basket et hockey en sommeil, réactivables à la main dans Réglages)
    return false;
  }
  function isWanted(s, C) {
    if (!groupOfSport(s) || !s.active || s.has_outrights) return false;
    if ((C.excluded || []).includes(s.key)) return false;
    if ((C.included || []).includes(s.key)) return true;
    return isDefault(s, C);
  }

  // ------------------------------------------------------------ présélection gratuite (score de pertinence /100)
  const fitCache = {};
  function prescan(withCount, evLists, LD, titles) {
    const out = [];
    const T = LD.tennis?.tours || {};
    for (const x of withCount) {
      for (const ev of evLists[x.key] || []) {
        if (!(Date.parse(ev.commence_time) > Date.now())) continue;
        const m = { id: ev.id, key: x.key, comp: D.FOOTBALL[x.key]?.name || titles[x.key] || x.key, home: ev.home_team, away: ev.away_team, t: Date.parse(ev.commence_time), parts: {}, sport: x.group };
        const P = m.parts;
        if (x.group === 'football') {
          const rows = LD.football?.leagues?.[x.key];
          let fit = null, ms = null;
          if (rows) { ms = rows.map(SP.fdRow); fit = fitCache[x.key] || (fitCache[x.key] = SP.fitDixonColes(ms)); }
          const mh = fit && D.bestMatch(m.home, fit.teams), ma = fit && D.bestMatch(m.away, fit.teams);
          if (fit && mh.name && ma.name) {
            const gh = fit.games[mh.name] || 0, ga = fit.games[ma.name] || 0;
            P.stats = 25 * Math.min(1, Math.min(gh, ga) / 20);
            const l = SP.dcLambdas(fit, mh.name, ma.name), mat = SP.scoreMatrix(l.lh, l.la, fit.rho);
            const [ph, pd, pa] = SP.matrix1x2(mat);
            const probs = [ph + pd, pd + pa, SP.matrixOver(mat, 1.5), 1 - SP.matrixOver(mat, 3.5), ph, pa];
            const maxP = Math.max(...probs);
            P.interet = 20 * Math.max(0, Math.min(1, (maxP - 0.6) / 0.3));
            P.potentiel = Math.min(15, 5 * probs.filter((q) => q >= 0.7).length);
            const last = ms.filter((g) => g.h === mh.name || g.a === mh.name || g.h === ma.name || g.a === ma.name).slice(-1)[0];
            P.fiabilite = last && Date.now() - last.t < 21 * 86400e3 ? 15 : 8;
            const gd = (team) => ms.filter((g) => g.h === team || g.a === team).slice(-10).map((g) => (g.h === team ? g.hg - g.ag : g.ag - g.hg));
            const sd = (SP.sd(gd(mh.name)) + SP.sd(gd(ma.name))) / 2;
            P.stabilite = 15 * Math.max(0, Math.min(1, 1 - (sd - 0.8) / 1.7));
            m.maxP = maxP;
            m.opts = [{ label: `Double chance ${m.home} ou nul`, type: 'dc1X', p: ph + pd }, { label: `Double chance nul ou ${m.away}`, type: 'dcX2', p: pd + pa },
              { label: 'Plus de 1,5 buts', type: 'over', point: 1.5, p: probs[2] }, { label: 'Moins de 3,5 buts', type: 'under', point: 3.5, p: probs[3] },
              { label: `${m.home} gagne`, type: 'home', p: ph, market: 'h2h' }, { label: `${m.away} gagne`, type: 'away', p: pa, market: 'h2h' }];
          } else { P.stats = 0; P.interet = 5; P.potentiel = 3; P.fiabilite = 5; P.stabilite = 5; m.note = 'pas de statistiques gratuites pour cette compétition'; }
          P.competition = FOOT_MAIN.has(x.key) ? 10 : rows ? 8 : 4;
        } else if (x.group === 'tennis') {
          const tour = /wta/i.test(x.key) ? 'WTA' : 'ATP';
          const a = T[tour] && findPlayer(LD.tennis, tour, m.home), b = T[tour] && findPlayer(LD.tennis, tour, m.away);
          const ctx = tennisContext(x.key, titles[x.key] || '');
          if (a && b) {
            P.stats = 25 * Math.min(1, Math.min(a.n, b.n) / 30);
            const pA = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
            const maxP = Math.max(pA, 1 - pA);
            P.interet = 20 * Math.max(0, Math.min(1, (maxP - 0.55) / 0.3));
            P.potentiel = 15 * Math.max(0, Math.min(1, (maxP - 0.55) / 0.25));
            P.stabilite = 15 * Math.min(1, Math.min(a.n, b.n) / 40);
            m.maxP = maxP;
            m.opts = [{ label: `${m.home} gagne`, type: 'home', p: pA, market: 'h2h' }, { label: `${m.away} gagne`, type: 'away', p: 1 - pA, market: 'h2h' }];
          } else { P.stats = a || b ? 10 : 4; P.interet = 10; P.potentiel = 8; P.stabilite = 6; m.note = 'joueur(s) absent(s) des données Elo : cotes du marché utilisées'; }
          P.fiabilite = ctx.surfaceVerified ? 15 : 9;
          P.competition = /aus_open|french_open|wimbledon|us_open|masters|finals|1000/i.test(x.key + (titles[x.key] || '')) ? 10 : 7;
        }
        m.score = Math.round(Object.values(P).reduce((s2, v) => s2 + v, 0));
        m.category = m.score >= 80 ? 'priorité maximale' : m.score >= 70 ? 'priorité élevée' : m.score >= 60 ? 'à surveiller' : 'exclu par défaut';
        out.push(m);
      }
    }
    out.sort((a, b) => b.score - a.score);
    const byComp = {};
    for (const m of out) byComp[m.key] = Math.max(byComp[m.key] ?? 0, m.score);
    return { matches: out, byComp };
  }

  // ------------------------------------------------------------ marchés
  function buildMarkets(ev) {
    const mk = { h2h: new Map(), h2h_reg: new Map(), totals: new Map(), spreads: new Map() };
    const isHockey = String(ev.sport_key || '').startsWith('icehockey');
    let sharp = null;
    for (const b of ev.bookmakers || []) {
      for (const m of b.markets || []) {
        if (!mk[m.key]) continue;
        // NHL : un vainqueur avec « nul » est un marché 60 minutes, distinct du vainqueur prolongation incluse
        const mkKey = isHockey && m.key === 'h2h' && m.outcomes.some((o) => o.name === 'Draw') ? 'h2h_reg' : m.key;
        // regroupe par ligne : h2h -> 'main' ; totals -> point ; spreads -> point du domicile/joueur A
        const groups = new Map();
        for (const o of m.outcomes) {
          let g = 'main';
          if (m.key === 'totals') g = String(o.point);
          if (m.key === 'spreads') g = String(o.name === ev.home_team ? o.point : -o.point);
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(o);
        }
        for (const [g, outs] of groups) {
          if (!mk[mkKey].has(g)) mk[mkKey].set(g, { line: g, books: [] });
          mk[mkKey].get(g).books.push({ book: b.key, title: b.title, last: Date.parse(m.last_update || b.last_update), outs });
        }
      }
      if (b.key === 'pinnacle' || (b.key === 'betfair_ex_eu' && !sharp)) sharp = b.key;
    }
    // sélections
    const sels = [];
    const label = (mkey, o, g) => {
      if (mkey === 'h2h') return o.name === 'Draw' ? 'Match nul' : `${o.name} gagne${isHockey ? ' (prolongation incluse)' : ''}`;
      if (mkey === 'h2h_reg') return o.name === 'Draw' ? 'Nul à 60 minutes' : `${o.name} gagne à 60 minutes`;
      if (mkey === 'totals') return `${o.name === 'Over' ? 'Plus' : 'Moins'} de ${o.point}`;
      return `${o.name} ${o.point > 0 ? '+' : ''}${o.point}`;
    };
    for (const mkey of ['h2h', 'h2h_reg', 'totals', 'spreads']) {
      for (const [g, grp] of mk[mkey]) {
        const names = [...new Set(grp.books.flatMap((b) => b.outs.map((o) => o.name)))];
        const nOut = mkey === 'h2h_reg' ? 3 : mkey === 'h2h' ? (names.includes('Draw') ? 3 : 2) : 2;
        // probabilité juste par livre (marge retirée), uniquement si le livre couvre toutes les issues
        const fairByBook = [];
        for (const b of grp.books) {
          if (b.outs.length !== nOut) continue;
          // 1N2 (3 issues) : méthode de Shin ; marchés à 2 issues : méthode « power »
          const pr = b.outs.length >= 3 ? SP.devigShin(b.outs.map((o) => o.price)) : SP.devig(b.outs.map((o) => o.price));
          if (!pr) continue;
          fairByBook.push({ book: b.book, p: Object.fromEntries(b.outs.map((o, i) => [o.name, pr[i]])), margin: SP.overround(b.outs.map((o) => o.price)) });
        }
        for (const name of names) {
          const offers = [];
          for (const b of grp.books) {
            const o = b.outs.find((x) => x.name === name); if (!o) continue;
            offers.push({ book: b.book, title: b.title, price: o.price, point: o.point, last: b.last });
          }
          if (!offers.length) continue;
          offers.sort((x, y) => y.price - x.price);
          // référence « sharp » : Pinnacle, sinon Betfair Exchange (marge très faible), sinon consensus
          const pin = fairByBook.find((f) => f.book === 'pinnacle') || fairByBook.find((f) => f.book === 'betfair_ex_eu');
          const fps = fairByBook.map((f) => f.p[name]).filter((x) => x != null);
          const fair = pin ? pin.p[name] : (fps.length ? SP.median(fps) : null);
          const o0 = offers[0];
          let type;
          if (mkey === 'h2h') type = name === 'Draw' ? 'draw' : (name === ev.home_team ? 'home' : 'away');
          if (mkey === 'h2h_reg') type = 'reg_' + (name === 'Draw' ? 'draw' : (name === ev.home_team ? 'home' : 'away'));
          if (mkey === 'totals') type = name === 'Over' ? 'over' : 'under';
          if (mkey === 'spreads') type = name === ev.home_team ? 'ahHome' : 'ahAway';
          sels.push({
            id: `${mkey}|${g}|${name}`, mkey, line: g, name, type, point: o0.point ?? null,
            label: label(mkey, { name, point: o0.point }, g), offers, best: o0, second: offers[1] || null,
            mean: offers.reduce((s, x) => s + x.price, 0) / offers.length,
            fairMkt: fair, fairSource: pin ? `${pin.book === 'pinnacle' ? 'Pinnacle' : 'Betfair Exchange'} (marge retirée)` : (fps.length ? `consensus de ${fps.length} bookmakers (médiane, marge retirée)` : 'indisponible'),
            fairSd: SP.sd(fps), nBooks: offers.length,
            pinnacle: offers.find((x) => x.book === 'pinnacle')?.price || null,
          });
        }
      }
    }
    return { sels, sharp, nBooks: (ev.bookmakers || []).length };
  }

  // Bookmaker cible (Winamax par défaut) : la value est calculée à SA cote. Le prix juste reste
  // estimé sur tout le marché (Pinnacle en priorité) ; la meilleure cote ailleurs est conservée pour information.
  function applyTarget(mk, target) {
    if (!target) return mk;
    for (const s of mk.sels) {
      const t = s.offers.find((o) => o.book === target);
      if (!t) { s.noTarget = true; continue; }
      s.bestAny = s.best;
      s.best = t;
      s.second = s.offers.find((o) => o.book !== target) || null;
      mk.hasTarget = true;
    }
    return mk;
  }

  // ------------------------------------------------------------ données statistiques
  async function footballStats(espnLeague, step, oddsKey) {
    const L = await D.localData();
    const fd = L.football?.leagues?.[oddsKey];
    if (fd && fd.length >= 120) {
      const ms = fd.map(SP.fdRow);
      const xgInfo = SP.attachXG(ms);
      let nx = xgInfo.nReal + xgInfo.nProxy;
      const xgSource = xgInfo.label || null;
      const refs = [...new Set(ms.map((m) => m.refSrc).filter(Boolean))].join(' / ');
      await new Promise((res) => setTimeout(res, 0));
      const bt = SP.footballBacktest(ms);
      const dc = SP.fitDixonColes(ms);
      const xms = ms.filter((m) => m.hxg != null);
      const dcx = xms.length >= 100 ? SP.fitDixonColes(xms.map((m) => ({ ...m, hg: m.hxg, ag: m.axg })), { skipRho: true }) : null;
      return { ok: true, n: ms.length, nXG: nx, xgSource, refs, ms, dc, dcx, bt, errors: [], source: `football-data.co.uk${nx ? ` + ${xgSource} (${nx} matchs)` : ''}`, fetchedAt: L.football.fetchedAt };
    }
    const seasonStart = Date.UTC(new Date().getUTCFullYear() - (new Date().getUTCMonth() < 6 ? 2 : 1), 6, 15);
    const r = await D.espnResults('soccer', espnLeague, seasonStart, Date.now(), 45);
    if (!r.games.length) return { ok: false, error: r.errors[0] || 'aucun résultat renvoyé par ESPN' };
    const ms = r.games.map((g) => ({ t: g.t, h: g.h, a: g.a, hg: g.hs, ag: g.as })).sort((a, b) => a.t - b.t);
    await new Promise((res) => setTimeout(res, 0));
    const bt = ms.length >= 120 ? SP.footballBacktest(ms) : null;
    const dc = SP.fitDixonColes(ms);
    step && step.note(`${espnLeague}: ${ms.length} matchs`);
    return { ok: true, n: ms.length, ms, dc, bt, errors: r.errors, meta: r.meta, last: ms[ms.length - 1]?.t, source: 'ESPN' };
  }
  async function nbaStats() {
    const y = new Date().getUTCFullYear(), mo = new Date().getUTCMonth();
    const seasonStart = Date.UTC(mo >= 9 ? y - 1 : y - 2, 9, 15); // saison précédente + saison en cours
    // 1) résultats publiés chaque matin par le robot GitHub ; 2) secours : ESPN jour par jour sur 150 jours
    const L = await D.localData();
    let gs, source;
    if (L.nba?.games?.length >= 300) {
      gs = L.nba.games.map((r) => ({ t: r[0], h: r[1], a: r[2], hs: r[3], as: r[4] }));
      source = `ESPN via collecte quotidienne (${gs.length} matchs)`;
    } else {
      const r = await D.espnResults('basketball', 'nba', Math.max(seasonStart, Date.now() - 150 * 86400e3), Date.now(), 1, true);
      if (!r.games.length) return { ok: false, error: r.errors[0] || 'aucun résultat renvoyé par ESPN' };
      gs = r.games.map((g) => ({ t: g.t, h: g.h, a: g.a, hs: g.hs, as: g.as }));
      source = `ESPN jour par jour (${gs.length} matchs)`;
    }
    gs.sort((a, b) => a.t - b.t);
    await new Promise((res) => setTimeout(res, 0));
    const bt = gs.length >= 300 ? SP.nbaBacktest(gs) : null;
    const m = SP.fitNBA(gs);
    const elo = bt ? bt.elo : SP.eloRun(gs.map((g) => ({ h: g.h, a: g.a, hg: g.hs, ag: g.as })), { K: 20, home: 70 });
    return { ok: true, n: gs.length, gs, model: m, bt, elo, errors: [], source };
  }

  // ------------------------------------------------------------ tennis
  const CLAY = /(roland|french open|monte|madrid|rome|italian|barcelona|hamburg|geneva|lyon|bastad|gstaad|umag|kitzb|estoril|munich|houston|marrakech|buenos|rio|santiago|cordoba|charleston|bogota|rabat|strasbourg|palermo|prague|warsaw|iasi|parma)/i;
  const GRASS = /(wimbledon|queen|halle|eastbourne|hertogenbosch|mallorca|stuttgart open|newport|berlin|bad homburg|nottingham|birmingham)/i;
  const INDOOR = /(paris masters|atp finals|wta finals|vienna|basel|stockholm|antwerp|metz|sofia|rotterdam|marseille|montpellier|dallas|linz|ostrava|moscow|st\.? petersburg|astana|belgrade|next gen|davis cup|billie jean)/i;
  function tennisContext(sportKey, title) {
    const s = `${sportKey} ${title}`;
    const surface = CLAY.test(s) ? 'terre battue' : GRASS.test(s) ? 'gazon' : INDOOR.test(s) ? 'dur indoor' : 'dur outdoor';
    const surfaceVerified = CLAY.test(s) || GRASS.test(s) || INDOOR.test(s);
    const wta = /wta/i.test(sportKey);
    const slam = /(aus_open|french_open|wimbledon|us_open)/i.test(sportKey);
    // moyennes circuit de points gagnés au service (ordre de grandeur public ATP/WTA) — hypothèse paramétrique
    const base = wta ? { 'terre battue': 0.555, gazon: 0.585, 'dur indoor': 0.575, 'dur outdoor': 0.565 }[surface]
      : { 'terre battue': 0.625, gazon: 0.665, 'dur indoor': 0.655, 'dur outdoor': 0.645 }[surface];
    return { surface, surfaceVerified, tour: wta ? 'WTA' : 'ATP', bestOf: slam && !wta ? 5 : 3, base };
  }

  // ------------------------------------------------------------ évaluation d'un événement
  function selProbFromMatrix(mat, sel) {
    const pseudo = { kind: 'football', M: mat.length, hist: mat.flat() };
    return SP.evalFromSim(pseudo, SP.normalizeSel(sel), sel.best.price);
  }
  function modelFootball(E, C, stats, clubelo) {
    const h2h = E.mk.sels.filter((s) => s.mkey === 'h2h');
    const get = (t) => h2h.find((s) => s.type === t)?.fairMkt;
    const p1x2 = [get('home'), get('draw'), get('away')];
    if (p1x2.some((x) => x == null)) return { error: 'cotes 1X2 incomplètes' };
    const tots = E.mk.sels.filter((s) => s.mkey === 'totals' && s.type === 'over' && s.fairMkt != null);
    tots.sort((a, b) => Math.abs(a.point - 2.5) - Math.abs(b.point - 2.5));
    const over = tots[0] ? { line: tots[0].point, p: tots[0].fairMkt } : null;
    const lm = SP.impliedLambdas(p1x2, over);
    const out = { models: [{ name: 'Marché (marge retirée)', p1x2, lh: lm.lh, la: lm.la }], mkt: lm };
    let ls = null, statsNote = 'statistiques indisponibles pour cette compétition';
    if (stats && stats.ok && stats.dc) {
      const mh = D.bestMatch(E.home, stats.dc.teams), ma = D.bestMatch(E.away, stats.dc.teams);
      if (mh.name && ma.name) {
        const lam = SP.dcLambdas(stats.dc, mh.name, ma.name);
        const pdc = SP.matrix1x2(SP.scoreMatrix(lam.lh, lam.la, stats.dc.rho));
        out.models.push({ name: 'Dixon-Coles (pondéré temps)', p1x2: pdc, lh: lam.lh, la: lam.la });
        let pst = pdc;
        if (stats.bt) {
          const R = stats.bt.elo.ratings;
          const diff = (R.get(mh.name) ?? 1500) + stats.bt.elo.H - (R.get(ma.name) ?? 1500);
          const pel = SP.ordinalProbs(stats.bt.ordinal, diff);
          out.models.push({ name: 'Elo + régression logistique ordinale', p1x2: pel });
          let pxg = null;
          if (stats.dcx && stats.bt.weights.xg != null) {
            const lx = SP.dcLambdas(stats.dcx, mh.name, ma.name);
            if (lx) { pxg = SP.matrix1x2(SP.scoreMatrix(lx.lh, lx.la, stats.dc.rho)); out.models.push({ name: `Dixon-Coles sur xG (${stats.xgSource || 'xG'})`, p1x2: pxg, lh: lx.lh, la: lx.la }); }
          }
          const w = { ...stats.bt.weights };
          if (!pxg && w.xg) { const k = 1 - w.xg; w.dc /= k || 1; w.elo /= k || 1; w.xg = 0; }
          pst = [0, 1, 2].map((i) => w.dc * pdc[i] + w.elo * pel[i] + (pxg ? (w.xg || 0) * pxg[i] : 0));
          out.models.push({ name: `Ensemble stats (poids backtest : ${Object.entries(w).filter(([, v]) => v > 0).map(([k2, v]) => `${k2} ${v.toFixed(2)}`).join(' / ')})`, p1x2: pst });
        }
        // λ stats : cohérents avec l'ensemble 1X2 et le total de Dixon-Coles
        const mDC = SP.scoreMatrix(lam.lh, lam.la, stats.dc.rho);
        ls = SP.impliedLambdas(pst, { line: 2.5, p: SP.matrixOver(mDC, 2.5) });
        out.st = { ...ls, p1x2: pst, match: [mh, ma], games: [stats.dc.games[mh.name], stats.dc.games[ma.name]] };
        statsNote = `${stats.n} matchs, appariement ${(Math.min(mh.score, ma.score) * 100).toFixed(0)}%`;
      } else statsNote = `équipe(s) non appariée(s) dans les données ESPN (${E.home} / ${E.away})`;
    }
    // compétitions sans modèle propre (coupes d'Europe) : probabilités ClubElo publiées
    if (!ls && clubelo) {
      const names = clubelo.fixtures.flatMap((f) => [f.home, f.away]);
      const mh = D.bestMatch(E.home, names), ma = D.bestMatch(E.away, names);
      const fx = mh.name && ma.name && clubelo.fixtures.find((f) => f.home === mh.name && f.away === ma.name);
      if (fx) {
        out.models.push({ name: 'ClubElo (probabilités publiées)', p1x2: fx.p });
        ls = SP.impliedLambdas(fx.p, over);
        out.st = { ...ls, p1x2: fx.p, games: [30, 30] };
        statsNote = `ClubElo (clubelo.com), appariement ${(Math.min(mh.score, ma.score) * 100).toFixed(0)}%`;
        out.clubeloOnly = true;
      }
    }
    out.statsNote = statsNote + (stats?.source ? ` · source ${stats.source}` : '');
    const wBt = stats?.bt?.wMarket;
    const w = wBt != null && !out.clubeloOnly ? wBt : C.wMarket;
    out.wSource = wBt != null && !out.clubeloOnly ? `backtest vs cotes de clôture ${stats.refs || ''} (${stats.bt.market.n} matchs)` : 'réglage';
    const lh = ls ? Math.exp(w * Math.log(lm.lh) + (1 - w) * Math.log(ls.lh)) : lm.lh;
    const la = ls ? Math.exp(w * Math.log(lm.la) + (1 - w) * Math.log(ls.la)) : lm.la;
    const gap = ls ? (Math.abs(Math.log(ls.lh / lm.lh)) + Math.abs(Math.log(ls.la / lm.la))) / 2 : 0;
    const sigma = Math.sqrt(0.06 ** 2 + (gap / 2) ** 2) + (ls ? 0 : 0.03);
    out.final = { lh, la, rho: stats?.dc?.rho ?? -0.05, sigma };
    const matF = SP.scoreMatrix(lh, la, out.final.rho), matM = SP.scoreMatrix(lm.lh, lm.la, -0.05), matS = ls ? SP.scoreMatrix(ls.lh, ls.la, stats?.dc?.rho ?? -0.05) : null;
    out.models.push({ name: `Final (marché ${w} / stats ${(1 - w).toFixed(2)}, poids : ${out.wSource})`, p1x2: SP.matrix1x2(matF), lh, la });
    out.phase1 = (sel) => {
      const pf = selProbFromMatrix(matF, sel);
      const pm = sel.fairMkt != null && sel.mkey !== 'spreads' ? sel.fairMkt : selProbFromMatrix(matM, sel).pWin;
      const ps = matS ? selProbFromMatrix(matS, sel).pWin : null;
      return { pWin: pf.pWin, pPush: pf.pPush, ev: pf.ev, pMkt: pm, pStats: ps };
    };
    out.simSpec = { kind: 'football', lh, la, rho: out.final.rho, sigma };
    out.nHist = stats?.n ?? 0;
    out.dataQuality = ls ? Math.min(1, (out.clubeloOnly ? 0.45 : 0.5) + Math.min(out.st.games[0], out.st.games[1]) / 40 + (stats?.nXG ? 0.1 : 0)) : 0.35;
    out.calib = stats?.bt && !out.clubeloOnly ? Math.max(0, (stats.bt.naive.logLoss - (stats.bt.blend?.logLoss ?? stats.bt.ensemble.logLoss)) / 0.08) : null;
    return out;
  }
  function modelNBA(E, C, stats) {
    const h2h = E.mk.sels.filter((s) => s.mkey === 'h2h');
    const pH = h2h.find((s) => s.type === 'home')?.fairMkt;
    if (pH == null) return { error: 'cotes vainqueur incomplètes' };
    // Hors NBA (Euroleague…), pas de modèle NBA : écarts-types mis à l'échelle du total du marché (hypothèse signalée)
    const totLine = E.mk.sels.find((s) => s.mkey === 'totals' && s.type === 'over')?.point;
    const scale = E.sport === 'basket' && totLine ? totLine / 225 : 1;
    const sdM = stats?.model?.sdMargin || 12.5 * scale, sdT = stats?.model?.sdTotal || 18.5 * scale;
    let mm = SP.probToMargin(pH, sdM);
    const sp = E.mk.sels.filter((s) => s.mkey === 'spreads' && s.type === 'ahHome' && s.fairMkt != null).sort((a, b) => Math.abs(a.fairMkt - 0.5) - Math.abs(b.fairMkt - 0.5))[0];
    if (sp) mm = -sp.point + SP.probToMargin(sp.fairMkt, sdM);
    const to = E.mk.sels.filter((s) => s.mkey === 'totals' && s.type === 'over' && s.fairMkt != null).sort((a, b) => Math.abs(a.fairMkt - 0.5) - Math.abs(b.fairMkt - 0.5))[0];
    const tm = to ? to.point + SP.probToMargin(to.fairMkt, sdT) : null;
    const out = { models: [{ name: 'Marché (marge retirée)', pHome: pH, margin: mm, total: tm }], statsNote: 'statistiques indisponibles' };
    let ms = null, ts = null;
    if (stats && stats.ok && stats.model) {
      const mh = D.bestMatch(E.home, stats.model.teams), ma = D.bestMatch(E.away, stats.model.teams);
      if (mh.name && ma.name) {
        const pr = SP.nbaPredict(stats.model, mh.name, ma.name, E.t);
        out.models.push({ name: `Régression ridge (repos/back-to-back β=${stats.model.b2b.toFixed(1)})`, pHome: SP.normCdf(pr.margin / sdM), margin: pr.margin, total: pr.total });
        ms = pr.margin; ts = pr.total; out.b2b = { home: pr.b2bH, away: pr.b2bA };
        if (stats.bt) {
          const R = stats.elo.ratings;
          const pe = 1 / (1 + Math.pow(10, -((R.get(mh.name) ?? 1500) + 70 - (R.get(ma.name) ?? 1500)) / 400));
          const me = SP.probToMargin(pe, sdM);
          out.models.push({ name: 'Elo (marge de victoire)', pHome: pe, margin: me });
          const w = stats.bt.weights;
          ms = w.ridge * pr.margin + w.elo * me;
          out.models.push({ name: `Ensemble stats (ridge ${w.ridge.toFixed(2)} / Elo ${w.elo.toFixed(2)})`, pHome: SP.normCdf(ms / sdM), margin: ms, total: ts });
        }
        out.statsNote = `${stats.n} matchs, appariement ${(Math.min(mh.score, ma.score) * 100).toFixed(0)}%`;
        out.matched = [mh.name, ma.name];
      } else out.statsNote = `équipe(s) non appariée(s) (${E.home} / ${E.away})`;
    }
    const w = C.wMarket;
    const fM = ms != null ? w * mm + (1 - w) * ms : mm;
    const fT = tm != null ? (ts != null ? w * tm + (1 - w) * ts : tm) : ts;
    if (fT == null) return { error: 'aucun total disponible (ni marché ni modèle)' };
    out.models.push({ name: `Final (marché ${w} / stats ${(1 - w).toFixed(2)})`, pHome: SP.normCdf(fM / sdM), margin: fM, total: fT });
    const sigmaM = Math.sqrt(1 + (ms != null ? ((ms - mm) / 2) ** 2 : 4));
    const sigmaT = Math.sqrt(2 + (ts != null && tm != null ? ((ts - tm) / 2) ** 2 : 9));
    const corr = stats?.model?.corr ?? 0;
    out.simSpec = { kind: 'nba', ph: (fT + fM) / 2, pa: (fT - fM) / 2, sdM, sdT, corr: Math.max(-0.5, Math.min(0.5, corr)), sigmaM, sigmaT };
    const pNorm = (mu, sd, sel, line) => {
      // probabilité analytique (loi normale) d'une sélection
      if (sel.mkey === 'h2h') return sel.type === 'home' ? SP.normCdf(mu.m / sd.m) : 1 - SP.normCdf(mu.m / sd.m);
      if (sel.mkey === 'spreads') return sel.type === 'ahHome' ? SP.normCdf((mu.m + sel.point) / sd.m) : 1 - SP.normCdf((mu.m - sel.point) / sd.m);
      if (mu.t == null) return null;
      return sel.type === 'over' ? 1 - SP.normCdf((sel.point - mu.t) / sd.t) : SP.normCdf((sel.point - mu.t) / sd.t);
    };
    const sdF = { m: Math.sqrt(sdM ** 2 + sigmaM ** 2), t: Math.sqrt(sdT ** 2 + sigmaT ** 2) };
    out.phase1 = (sel) => {
      const p = pNorm({ m: fM, t: fT }, sdF, sel);
      return {
        pWin: p, pPush: 0, ev: p * sel.best.price - 1,
        pMkt: sel.fairMkt ?? pNorm({ m: mm, t: tm }, { m: sdM, t: sdT }, sel),
        pStats: ms != null ? pNorm({ m: ms, t: ts }, { m: sdM, t: sdT }, sel) : null,
      };
    };
    out.dataQuality = ms != null ? 0.85 : E.sport === 'basket' ? 0.3 : 0.4;
    out.nHist = stats?.n ?? 0;
    if (E.sport === 'basket') out.statsNote = 'marché seul (pas de statistiques publiques gratuites fiables) ; écarts-types mis à l’échelle du total du marché : confiance réduite';
    out.calib = stats?.bt ? Math.max(0, (Math.log(2) - stats.bt.ensemble.logLoss) / 0.1) : null;
    return out;
  }
  // Index des joueurs tennis-data (« Sinner J. ») -> clé « nom|initiale »
  let tIndex = null;
  function tennisIndex(T) {
    if (tIndex && tIndex.src === T) return tIndex;
    const map = {};
    for (const [tour, t] of Object.entries(T?.tours || {})) {
      map[tour] = new Map();
      for (const [name, v] of Object.entries(t.players)) {
        const tok = D.norm(name).replace(/\./g, '').split(' ').filter(Boolean);
        if (tok.length < 2) continue;
        const ini = tok[tok.length - 1][0];
        map[tour].set(tok.slice(0, -1).join(' ') + '|' + ini, { name, ...v });
      }
    }
    tIndex = { src: T, map };
    return tIndex;
  }
  function findPlayer(T, tour, oddsName) {
    const m = tennisIndex(T).map[tour]; if (!m) return null;
    const tok = D.norm(oddsName).split(' ').filter(Boolean);
    for (let k = 1; k < tok.length; k++) { const hit = m.get(tok.slice(k).join(' ') + '|' + tok[0][0]); if (hit) return hit; }
    return null;
  }
  // HOCKEY (NHL) : buts attendus par équipe (Poisson), résolution des égalités par la prolongation / tirs au but.
  // Marché : victoire (prolongation incluse) et total ; statistiques : modèle attaque/défense sur les résultats NHL ESPN.
  // Sans backtest contre des cotes historiques, le modèle statistique sert à détecter les divergences (poids marché 1).
  function modelHockey(E, C, stats) {
    const sH = E.mk.sels.find((s) => s.mkey === 'h2h' && s.type === 'home');
    if (!sH || sH.fairMkt == null) return { error: 'cotes vainqueur incomplètes' };
    const tot = E.mk.sels.filter((s) => s.mkey === 'totals' && s.type === 'over' && s.fairMkt != null).sort((a, b) => Math.abs(a.fairMkt - 0.5) - Math.abs(b.fairMkt - 0.5))[0];
    const K = stats?.drawK?.k || 1;
    const regOf = (lh, la) => SP.inflateDraws(SP.scoreMatrix(lh, la, 0, 12), K);
    const finalOf = (lh, la) => SP.hockeyFinal(regOf(lh, la), SP.hockeyPOT(lh, la));
    const stat = (F, line) => { let ph = 0, po = 0; F.forEach((r, i) => r.forEach((v, j) => { if (i > j) ph += v; if (line != null && i + j > line) po += v; })); return [ph, po]; };
    // λ implicites du marché : moindres carrés sur P(victoire) et P(plus de la ligne)
    let best = null;
    for (let lh = 1.5; lh <= 5.01; lh += 0.1) for (let la = 1.5; la <= 5.01; la += 0.1) {
      const [ph, po] = stat(finalOf(lh, la), tot?.point);
      const err = (ph - sH.fairMkt) ** 2 + (tot ? (po - tot.fairMkt) ** 2 : 0) + (tot ? 0 : ((lh + la) - 6.1) ** 2 * 0.001);
      if (!best || err < best.err) best = { lh, la, err };
    }
    const out = { models: [{ name: 'Marché (marge retirée)', pHome: sH.fairMkt, lh: best.lh, la: best.la }], statsNote: 'marché seul : résultats NHL indisponibles', nHist: stats?.n ?? 0 };
    let gap = null;
    if (stats?.ok && stats.fit) {
      const mh = D.bestMatch(E.home, stats.fit.teams), ma = D.bestMatch(E.away, stats.fit.teams);
      if (mh.name && ma.name) {
        const l = SP.dcLambdas(stats.fit, mh.name, ma.name);
        const [ps] = stat(finalOf(l.lh, l.la), null);
        out.models.push({ name: 'Poisson attaque/défense (NHL, pondéré dans le temps)', pHome: ps, lh: l.lh, la: l.la });
        gap = Math.abs(ps - sH.fairMkt);
        out.st = { lh: l.lh, la: l.la, pHome: ps, match: [mh, ma] };
        out.matched = [mh.name, ma.name];
        out.statsNote = `${stats.n} matchs NHL ESPN, appariement ${(Math.min(mh.score, ma.score) * 100).toFixed(0)} % · modèle statistique utilisé pour repérer les divergences`;
      } else out.statsNote = `équipe(s) non appariée(s) dans les résultats NHL (${E.home} / ${E.away})`;
    }
    const lh = best.lh, la = best.la, pOT = SP.hockeyPOT(lh, la);
    out.final = { lh, la, rho: 0 }; out.pOT = pOT; out.drawK = K;
    if (stats?.drawK) out.statsNote += ` · nuls au temps réglementaire calés sur le taux réel de prolongations (${Math.round(stats.drawK.rate * 100)} % sur ${stats.drawK.n} matchs)`;
    const sigma = Math.sqrt(0.05 ** 2 + ((gap || 0) / 2) ** 2) + (out.st ? 0 : 0.03);
    out.models.push({ name: 'Final (marché ; modèle stats en contrôle)', pHome: stat(finalOf(lh, la), null)[0], lh, la });
    const F = finalOf(lh, la);
    const pseudo = { kind: 'football', M: F.length, hist: F.flat() };
    const Fs = out.st ? finalOf(out.st.lh, out.st.la) : null;
    const R = regOf(lh, la), pseudoR = { kind: 'football', M: R.length, hist: R.flat() };
    const Rs = out.st ? regOf(out.st.lh, out.st.la) : null;
    out.phase1 = (sel) => {
      const isReg = sel.mkey === 'h2h_reg';
      const ns = SP.normalizeSel({ type: String(sel.type).replace(/^reg_/, ''), point: sel.point });
      const r = SP.evalFromSim(isReg ? pseudoR : pseudo, ns, sel.best.price);
      const rs = (isReg ? Rs : Fs) ? SP.evalFromSim({ kind: 'football', M: (isReg ? Rs : Fs).length, hist: (isReg ? Rs : Fs).flat() }, ns, 2).pWin : null;
      return { pWin: r.pWin, pPush: r.pPush, ev: r.ev, pMkt: sel.fairMkt ?? r.pWin, pStats: rs };
    };
    out.simSpec = { kind: 'football', lh, la, rho: 0, sigma };
    out.dataQuality = out.st ? 0.7 : 0.35;
    out.calib = stats?.bt ? Math.max(0, (stats.bt.naive.logLoss - stats.bt.ensemble.logLoss) / 0.06) : null;
    out.wSource = 'marché (pas de cotes historiques NHL pour valider un autre poids)';
    return out;
  }
  function modelTennis(E, C, T) {
    const h2h = E.mk.sels.filter((s) => s.mkey === 'h2h');
    const sA = h2h.find((s) => s.name === E.home);
    if (!sA || sA.fairMkt == null) return { error: 'cotes vainqueur incomplètes' };
    const ctx = tennisContext(E.sportKey, E.comp);
    let nHistT = 0;
    let pFinal = sA.fairMkt, pEloA = null, eloNote = null, wT = null, dq = ctx.surfaceVerified ? 0.4 : 0.3, calib = null;
    if (T?.tours?.[ctx.tour]) {
      const a = findPlayer(T, ctx.tour, E.home), b = findPlayer(T, ctx.tour, E.away);
      if (a && b) {
        const sk = { 'terre battue': 'clay', gazon: 'grass', 'dur indoor': 'hard_indoor', 'dur outdoor': 'hard' }[ctx.surface];
        const r = (pl) => { const s = pl.surf?.[sk]; return s && s[1] >= 5 ? (pl.elo + s[0]) / 2 : pl.elo; };
        pEloA = 1 / (1 + Math.pow(10, (r(b) - r(a)) / 400));
        const bt = T.tours[ctx.tour].backtest;
        // sans backtest contre le marché (source ESPN sans cotes), l'Elo ne modifie pas la probabilité : il sert à détecter les divergences
        wT = bt.n >= 300 ? bt.wMarket : 1;
        pFinal = wT * sA.fairMkt + (1 - wT) * pEloA;
        dq = Math.min(a.n, b.n) >= 20 ? 0.65 : 0.45;
        nHistT = Math.min(a.n, b.n);
        calib = bt.n >= 300 ? Math.max(0, (Math.log(2) - bt.blendLogLoss) / 0.15) : null;
        eloNote = `Elo ${ctx.tour} global+${ctx.surface} (${T.source || 'tennis'}) : ${a.name} ${r(a).toFixed(0)} (${a.n} matchs) vs ${b.name} ${r(b).toFixed(0)} (${b.n}) · poids marché ${wT}${bt.n >= 300 ? ` (backtest ${bt.n} matchs)` : ' (Elo non validé contre le marché : sert seulement à repérer les divergences)'}`;
      } else eloNote = `joueur(s) introuvable(s) dans les données Elo (${a ? '' : E.home}${!a && !b ? ', ' : ''}${b ? '' : E.away})`;
    }
    const sv = SP.tennisSolveServe(pFinal, ctx.base, ctx.bestOf);
    const sigmaD = Math.max(0.004, (sA.fairSd || 0.01) / 9);
    const out = {
      ctx, pEloA, models: [{ name: 'Marché (marge retirée)', pA: sA.fairMkt }, ...(pEloA != null ? [{ name: 'Elo surface', pA: pEloA }, { name: `Final (marché ${wT})`, pA: pFinal }] : []), { name: `Service implicite (${ctx.tour}, ${ctx.surface}, BO${ctx.bestOf})`, serveA: sv.pa, serveB: sv.pb }],
      statsNote: eloNote || 'modèle dérivé du marché : données Elo tennis indisponibles (version hors ligne)',
      simSpec: { kind: 'tennis', pa: sv.pa, pb: sv.pb, sigmaD, bestOf: ctx.bestOf },
      dataQuality: dq, calib, nHist: nHistT,
    };
    out.phase1 = null; // phase 1 tennis : simulation rapide
    return out;
  }

  // ------------------------------------------------------------ validation
  function assess(c, C, ctx) {
    const reasons = [], warn = [];
    const o = c.best.price;
    if (o < C.minOdds) reasons.push(`cote ${o.toFixed(2)} < minimum ${C.minOdds.toFixed(2)}`);
    if (o > C.maxOdds) reasons.push(`cote ${o.toFixed(2)} > plafond ${C.maxOdds.toFixed(2)}`);
    if (c.t <= Date.now() + 15 * 60e3) reasons.push('événement commencé ou trop proche du coup d’envoi');
    const ageMin = (Date.now() - c.best.last) / 60e3;
    if (!(ageMin <= C.maxOddsAgeMin)) reasons.push(`cote trop ancienne (${Math.round(ageMin)} min)`);
    if (c.ev > 0.15 && ['h2h', 'h2h_reg', 'totals', 'spreads'].includes(c.s.mkey)) reasons.push(`écart anormal avec le marché (EV ${Math.round(c.ev * 100)} %) : probable erreur de données ou marché différent, à vérifier`);
    if (c.ev <= 0) reasons.push('espérance négative');
    else if (c.ev < C.minEV) reasons.push(`EV ${(c.ev * 100).toFixed(1)}% < seuil ${(C.minEV * 100).toFixed(1)}%`);
    if (c.priceEdge < c.uncert) reasons.push(`avantage (${(c.priceEdge * 100).toFixed(1)} pts) inférieur à l’incertitude (${(c.uncert * 100).toFixed(1)} pts)`);
    if (c.p >= 0.85 && (c.E.model.dataQuality ?? 0) < 0.55) reasons.push('risque de surestimation du favori : probabilité très élevée sans modèle indépendant');
    if (c.E.model.nHist != null && c.E.model.nHist < 100 && c.E.model.nHist > 0) reasons.push(`échantillon historique insuffisant (${c.E.model.nHist} matchs)`);
    if (C.platt && C.platt.b < 0.8) warn.push('calibration historique médiocre : probabilités du moteur trop confiantes');
    if (C.targetBook && c.second && c.best.price / c.second.price > 1.07) warn.push(`${c.best.title} est ${((c.best.price / c.second.price - 1) * 100).toFixed(0)} % au-dessus du bookmaker suivant : vérifiez la cote sur le site avant de parier`);
    else if (c.second && c.best.book !== 'pinnacle' && c.best.price / c.second.price > 1.07) reasons.push(`cote isolée (${c.best.title} ${c.best.price} vs ${c.second.price} ailleurs) : possible erreur ou cote obsolète`);
    if (c.modelGap != null && c.modelGap > C.maxGap) reasons.push(`divergence modèles/marché de ${(c.modelGap * 100).toFixed(1)} pts non expliquée`);
    if (c.fairMkt == null && c.sport !== 'nba' && c.sport !== 'basket') reasons.push('probabilité de marché indisponible');
    if (c.simN && c.simCI > 0.01) reasons.push('simulations insuffisamment stables');
    if (c.mcSpread > 0.2) reasons.push('résultat trop sensible aux hypothèses (scénarios)');
    if (c.llm?.impact === 'majeur') reasons.push('information majeure à confirmer (analyse des actualités)');
    if (c.critical) reasons.push(c.critical);
    for (const w of ctx.warnings || []) warn.push(w);
    return { ok: reasons.length === 0, reasons, warn };
  }

  // ------------------------------------------------------------ analyse complète
  async function run(ui, opts = {}) {
    const C = cfg();
    const t0 = Date.now();
    const A = {
      id: 'A' + t0, startedAt: t0, parentId: opts.parentId || null, kind: opts.parentId ? 'réanalyse' : 'analyse complète',
      cfg: { ...C, oddsKey: undefined, claudeKey: undefined }, engine: SP.version,
      events: [], errors: [], counts: {}, best: null, values: [], watch: [], combo: null, sources: {},
    };
    const S = ui.steps;
    if (!C.oddsKey) {
      S.fail(0, 'Clé The Odds API manquante : ajoutez-la dans Réglages.');
      A.errors.push('Clé The Odds API manquante');
      return finish(A, ui);
    }
    // ---------------- 1. matchs
    S.start(0);
    const sp = await D.oddsSports(C.oddsKey);
    if (!sp.ok) { S.fail(0, 'The Odds API : ' + sp.error); A.errors.push(sp.error); return finish(A, ui); }
    const active = sp.data.filter((s) => s.active && !s.has_outrights);
    const titles = Object.fromEntries(sp.data.map((s) => [s.key, s.title]));
    const hours = 48; // v3 : recherche sur les 48 prochaines heures
    // TOUTES les compétitions actives de foot, basket et tennis (liste gratuite), sauf celles exclues dans Réglages.
    const groupOf = groupOfSport;
    const wanted = active.filter((s) => isWanted(s, C));
    const MAJOR = new Set([...Object.entries(D.FOOTBALL).filter(([, v]) => v.on).map(([k2]) => k2), 'basketball_nba', 'basketball_euroleague', 'icehockey_nhl']);
    const wmx = D.LS.get('sp:wmx', {}); // compétitions sans cotes chez le bookmaker cible (mémorisé 7 jours)
    // 1) liste des matchs : gratuite, en parallèle par 6
    const withCount = [], evLists = {};
    for (let i = 0; i < wanted.length; i += 6) {
      S.progress(0, i, wanted.length, 'recherche des matchs (gratuit)');
      const rs = await Promise.all(wanted.slice(i, i + 6).map((s) => D.oddsEventsList(C.oddsKey, s.key, hours)));
      rs.forEach((r, j) => {
        const s = wanted[i + j];
        evLists[s.key] = r.ok && Array.isArray(r.data) ? r.data : [];
        if (r.ok && !r.cached) SPCredits.noteRemaining(r.headers);
        const n = r.ok && Array.isArray(r.data) ? r.data.filter((e) => Date.parse(e.commence_time) > Date.now()).length : null;
        withCount.push({ key: s.key, n, group: groupOf(s) });
      });
    }
    const nRegions = C.regions.split(',').length;
    let skippedNoEvents = 0, skippedNoTarget = 0, skippedBudget = [], spent = 0, skippedLowScore = [];
    // PRÉSÉLECTION GRATUITE : score de pertinence /100 de chaque match (données gratuites uniquement)
    const LD0 = await D.localData();
    const pre = prescan(withCount, evLists, LD0, titles);
    A.prescan = pre.matches.slice(0, 60);
    // garantie : on interroge toujours au moins les 3 meilleures compétitions de football et les 2 meilleures de tennis,
    // même sous le seuil (sinon un joueur absent des données Elo suffit à écarter tout un tournoi).
    const guaranteed = new Set();
    for (const [g, n] of [['football', 3], ['tennis', 2]]) {
      withCount.filter((x) => x.group === g && x.n > 0).sort((a2, b2) => (pre.byComp[b2.key] ?? 0) - (pre.byComp[a2.key] ?? 0)).slice(0, n).forEach((x) => guaranteed.add(x.key));
    }
    const plan = withCount.filter((x) => {
      if (x.n === 0) { skippedNoEvents++; return false; }
      const w = wmx[x.key];
      if (C.targetBook && w && w.has === false && Date.now() - w.at < 7 * 86400e3) { skippedNoTarget++; return false; }
      const best = pre.byComp[x.key] ?? 0;
      x.best = best;
      if (best < C.prescanMin && !guaranteed.has(x.key) && !(C.included || []).includes(x.key)) { skippedLowScore.push(titles[x.key] || x.key); return false; }
      return true;
    }).sort((a, b) => (b.best - a.best) || ((b.n ?? 1) - (a.n ?? 1)));
    // budget mensuel : on ne dépasse jamais budget − réserve
    const cr = SPCredits.state(C);
    const keys = [];
    let raw = [];
    for (let i = 0; i < plan.length; i++) {
      const x = plan[i];
      // marchés : complets pour les majeures, vainqueur + total pour les autres (2 crédits au lieu de 3)
      // crédits bas : on passe au seul marché vainqueur (1 crédit) et on peut entamer la réserve pour les compétitions garanties
      const low = !SPCredits.canSpend(C, C.markets.split(',').length * nRegions);
      const markets = low ? 'h2h' : C.markets;
      const cost = markets.split(',').length * nRegions;
      if (spent + cost > C.creditBudget) { skippedBudget.push(titles[x.key] || x.key); continue; }
      if (low) {
        const rem = SPCredits.state(C).remaining;
        if (!guaranteed.has(x.key) || rem - cost < 0) { skippedBudget.push((titles[x.key] || x.key) + (rem - cost < 0 ? ' (crédits épuisés)' : ' (réserve de crédits protégée)')); continue; }
        if (!A.lowCredits) { A.lowCredits = rem; A.errors.push(`Crédits presque épuisés (${rem} restants) : analyse minimale, marché vainqueur seulement, réserve entamée.`); }
      }
      if (opts.onlyKeys && !opts.onlyKeys.has(x.key)) continue;
      S.progress(0, i, plan.length, titles[x.key]);
      const r = await D.oddsFor(C.oddsKey, x.key, { regions: C.regions, markets, hours, ttlMin: opts.force ? 0 : 10 });
      SPCredits.record({ key: x.key, title: titles[x.key], group: x.group, estimated: cost, headers: r.headers || {}, cached: !!r.cached, ok: r.ok });
      if (!r.ok) { A.errors.push(`${titles[x.key]}: ${r.error}`); continue; }
      if (!r.cached) spent += +(r.headers?.['x-requests-last'] ?? cost);
      keys.push(x.key);
      if (C.targetBook && r.data.length) wmx[x.key] = { has: r.data.some((e) => (e.bookmakers || []).some((b) => b.key === C.targetBook)), at: Date.now() };
      raw.push(...r.data.map((e) => ({ ...e, _fetched: r.at, _stale: !!r.stale })));
    }
    D.LS.set('sp:wmx', wmx);
    A.coverage = { scanned: withCount.length, queried: keys.length, noEvents: skippedNoEvents, noTarget: skippedNoTarget, lowScore: skippedLowScore, overBudget: skippedBudget, spent, credits: SPCredits.state(C), competitions: keys.map((k2) => titles[k2] || k2) };
    A.counts.available = raw.length;
    A.sources.odds = { provider: 'The Odds API', regions: C.regions, at: Date.now(), remaining: D.apiStatus['The Odds API']?.remaining ?? null };
    S.done(0, `${pre.matches.length} matchs scannés gratuitement (${pre.matches.filter((m) => m.score >= C.prescanMin).length} avec un score ≥ ${C.prescanMin}) · ${keys.length} compétitions interrogées, ${skippedLowScore.length} écartées (score trop bas), ${skippedNoTarget} sans Winamax, ${skippedBudget.length} hors budget · ${spent} crédits utilisés`, skippedBudget.length > 0);

    // ---------------- 2. statistiques
    S.start(1);
    const LD = await D.localData();
    scorersData = LD.scorers || null; localFootball = LD.football || null;
    A.sources.local = LD.meta ? { generatedAt: LD.meta.generatedAt, sources: LD.meta.sources } : null;
    const fbStats = {};
    const leaguesNeeded = [...new Set(raw.filter((e) => D.FOOTBALL[e.sport_key]?.stats).map((e) => e.sport_key))];
    let k = 0;
    for (const lk of leaguesNeeded) {
      S.progress(1, k++, leaguesNeeded.length + (C.nba ? 1 : 0), D.FOOTBALL[lk].name);
      try { fbStats[lk] = await footballStats(D.FOOTBALL[lk].espn, null, lk); } catch (e) { fbStats[lk] = { ok: false, error: String(e) }; }
      if (!fbStats[lk].ok) A.errors.push(`Stats ${D.FOOTBALL[lk].name}: ${fbStats[lk].error}`);
    }
    let nhl = null;
    if (raw.some((e) => e.sport_key.startsWith('icehockey'))) {
      const gsH = (LD.nhl?.games || []).map((r) => ({ t: r[0], h: r[1], a: r[2], hs: r[3], as: r[4], ot: r[5] ?? null }));
      if (gsH.length >= 200) {
        await new Promise((res) => setTimeout(res, 0));
        const fit = SP.fitDixonColes(gsH.map((x) => ({ t: x.t, h: x.h, a: x.a, hg: x.hs, ag: x.as })), { skipRho: true, xi: 0.004, ridge: 3 });
        nhl = { ok: true, n: gsH.length, gs: gsH, fit, drawK: SP.hockeyDrawK(gsH), bt: SP.hockeyBacktest(gsH), source: `ESPN via collecte quotidienne (${gsH.length} matchs)` };
      } else { nhl = { ok: false, error: 'résultats NHL indisponibles (collecte quotidienne)' }; A.errors.push('Stats NHL : ' + nhl.error); }
    }
    let nba = null;
    if (raw.some((e) => e.sport_key === 'basketball_nba')) {
      S.progress(1, k, leaguesNeeded.length + 1, 'NBA');
      try { nba = await nbaStats(); } catch (e) { nba = { ok: false, error: String(e) }; }
      if (!nba.ok) A.errors.push('Stats NBA : ' + nba.error);
    }
    A.backtests = {
      ...Object.fromEntries(Object.entries(fbStats).filter(([, v]) => v.ok && v.bt).map(([kk, v]) => [D.FOOTBALL[kk].name + ` (${v.source})`, { n: v.bt.n, models: { ...v.bt.models, ...(v.bt.market ? { [`marché (${v.refs || 'clôture'})`]: v.bt.market } : {}) }, ensemble: v.bt.blend || v.bt.ensemble, naive: v.bt.naive, weights: { ...v.bt.weights, ...(v.bt.wMarket != null ? { 'poids marché': v.bt.wMarket } : {}) }, calibration: v.bt.calibration }])),
      ...Object.fromEntries(Object.entries(LD.tennis?.tours || {}).map(([tour, t]) => [`Tennis ${tour} (Elo surface, ${LD.tennis.source || ''})`, { n: t.backtest.n || t.backtest.nElo || 0, models: { elo: { logLoss: t.backtest.eloLogLoss }, ...(t.backtest.pinnacleLogLoss != null ? { 'marché Pinnacle': { logLoss: t.backtest.pinnacleLogLoss } } : {}) }, ensemble: { logLoss: t.backtest.blendLogLoss ?? t.backtest.eloLogLoss }, naive: { logLoss: Math.log(2) }, weights: t.backtest.wMarket != null ? { 'poids marché': t.backtest.wMarket } : { 'poids marché': 1 } }])),
      ...(nhl?.bt ? { 'NHL (Poisson, prolongation incluse)': nhl.bt } : {}),
      ...(nba?.bt ? { NBA: { n: nba.bt.n, models: nba.bt.models, ensemble: nba.bt.ensemble, weights: nba.bt.weights, calibration: nba.bt.calibration } } : {}),
    };
    const okStats = Object.values(fbStats).filter((v) => v.ok).length + (nba?.ok ? 1 : 0);
    S.done(1, `${okStats} jeu(x) de données chargé(s) ; backtests : ${Object.keys(A.backtests).join(', ') || 'aucun'}`, okStats < leaguesNeeded.length + (nba ? 1 : 0));

    // ---------------- 3. blessures
    S.start(2);
    let inj = null;
    if (nba) { inj = await D.nbaInjuries(); if (!inj.ok) A.errors.push('Blessures NBA : ' + inj.error); }
    S.done(2, `NBA : ${inj?.ok ? 'rapport ESPN chargé' : 'indisponible'} · Football et tennis : pas de source gratuite structurée (signalé comme indisponible)`, !inj?.ok && !!nba);

    // préparation des événements
    const events = raw.map((e) => {
      const sport = e.sport_key.startsWith('soccer') ? 'football' : e.sport_key === 'basketball_nba' ? 'nba' : e.sport_key.startsWith('basketball') ? 'basket' : e.sport_key.startsWith('icehockey') ? 'hockey' : 'tennis';
      const E = {
        id: e.id, sport, sportKey: e.sport_key, comp: D.FOOTBALL[e.sport_key]?.name || titles[e.sport_key] || e.sport_title,
        home: e.home_team, away: e.away_team, t: Date.parse(e.commence_time), fetched: e._fetched, staleOdds: e._stale,
        mk: applyTarget(buildMarkets(e), C.targetBook), info: [], warnings: [], risk: 0,
      };
      E.day = new Date(E.t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) === new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) ? 'aujourd’hui' : 'demain';
      if (E.t - Date.now() > 24 * 3600e3) E.day = 'J+2';
      return E;
    });
    // blessures NBA par équipe
    if (inj?.ok) for (const E of events.filter((x) => x.sport === 'nba')) {
      for (const side of ['home', 'away']) {
        const m = D.bestMatch(E[side], Object.keys(inj.byTeam));
        const list = m.name ? inj.byTeam[m.name] : [];
        const unsure = list.filter((p) => /question|doubt|day-to-day|game time/i.test(p.status));
        const out = list.filter((p) => /^out/i.test(p.status));
        E.info.push({ kind: 'blessures', team: E[side], out, unsure, status: 'vérifié', source: 'ESPN NBA injuries', at: inj.at });
        if (unsure.length) { E.risk += Math.min(4, unsure.length * 1.5); E.warnings.push(`${E[side]} : ${unsure.length} joueur(s) incertain(s) (${unsure.map((p) => p.player).join(', ')}) — jamais considérés comme disponibles`); }
      }
    }

    // Mouvements de cotes Singapore Pools (sgodds.com, collecte du matin) : indicateur, sans effet sur la probabilité
    const SG = LD.sgodds?.matches || [];
    if (SG.length) for (const E of events.filter((x) => x.sport === 'football')) {
      const hit = SG.map((m) => ({ m, s: Math.min(D.sim(m.home, E.home), D.sim(m.away, E.away)) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s)[0];
      if (!hit) continue;
      E.sg = hit.m.odds; // [1, X, 2] : { open, cur, chg }
      const lab = ['1', 'N', '2'];
      E.info.push({ kind: 'composition', status: 'probable', note: `Singapore Pools (sgodds.com, ${LD.sgodds.fetchedAt ? 'relevé du ' + new Date(LD.sgodds.fetchedAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}) : ${E.sg.map((o, i) => `${lab[i]} ${o.open.toFixed(2)} → ${o.cur.toFixed(2)}${o.chg ? ` (${o.chg > 0 ? '+' : ''}${Math.round(o.chg * 100)} %)` : ''}`).join(' · ')}`, source: 'sgodds.com' });
    }

    // ---------------- 4. compositions
    S.start(3);
    let lineupsChecked = 0;
    const soon = events.filter((E) => E.sport === 'football' && E.t - Date.now() < 3 * 3600e3);
    for (const E of soon.slice(0, 12)) {
      const lg = D.FOOTBALL[E.sportKey]?.espn; if (!lg) continue;
      const sb = await D.espnScoreboard('soccer', lg, Date.now() - DAY, Date.now() + DAY);
      if (!sb.ok) continue;
      const ev = sb.events.find((x) => D.sim(x.h, E.home) >= 0.5 && D.sim(x.a, E.away) >= 0.5);
      if (!ev) continue;
      const sum = await D.espnSummary('soccer', lg, ev.id);
      lineupsChecked++;
      const rosters = sum.ok ? (sum.data.rosters || []) : [];
      const pub = rosters.some((r) => (r.roster || []).some((p) => p.starter));
      E.lineup = { status: pub ? 'vérifié' : 'indisponible', source: 'ESPN summary', at: Date.now(), espnId: ev.id };
      E.info.push({ kind: 'composition', status: pub ? 'vérifié' : 'indisponible', note: pub ? 'compositions officielles publiées' : 'compositions non publiées', source: 'ESPN', at: Date.now() });
    }
    for (const E of events.filter((x) => x.sport === 'football' && !x.lineup)) {
      E.info.push({ kind: 'composition', status: 'indisponible', note: 'compositions non encore publiées (habituellement ~1 h avant le match)', source: '—' });
      E.risk += 1.5;
    }
    S.done(3, `${lineupsChecked} match(s) proches vérifiés ; les autres : compositions non publiées`);

    // ---------------- 5. actualités
    S.start(4);
    const newsBy = {};
    const feeds = [...new Set(events.map((E) => E.sport === 'football' ? `soccer|${D.FOOTBALL[E.sportKey]?.espn}` : E.sport === 'nba' ? 'basketball|nba' : E.sport === 'hockey' ? 'hockey|nhl' : E.sport === 'basket' ? 'basketball|nba' : (/wta/.test(E.sportKey) ? 'tennis|wta' : 'tennis|atp')))].filter((f) => !f.endsWith('undefined'));
    for (let i = 0; i < feeds.length; i++) {
      S.progress(4, i, feeds.length, feeds[i]);
      const [s, l] = feeds[i].split('|');
      const r = await D.espnNews(s, l);
      newsBy[feeds[i]] = r.ok ? r.items : [];
      if (!r.ok) A.errors.push(`Actualités ${l} : ${r.error}`);
    }
    for (const E of events) {
      const f = E.sport === 'football' ? `soccer|${D.FOOTBALL[E.sportKey]?.espn}` : E.sport === 'nba' ? 'basketball|nba' : E.sport === 'hockey' ? 'hockey|nhl' : E.sport === 'basket' ? 'basketball|nba' : (/wta/.test(E.sportKey) ? 'tennis|wta' : 'tennis|atp');
      const items = newsBy[f] || [];
      const keyTok = (n) => D.norm(n).split(' ').filter((x) => x.length > 3).sort((a, b) => b.length - a.length)[0] || D.norm(n);
      const kh = keyTok(E.home), ka = keyTok(E.away);
      E.news = items.filter((it) => { const tx = D.norm(it.title + ' ' + it.desc); return tx.includes(kh) || tx.includes(ka); }).slice(0, 8);
    }
    S.done(4, `${feeds.length} flux ESPN ; ${events.reduce((s, E) => s + (E.news?.length || 0), 0)} articles reliés à des matchs`);

    // ---------------- 6. cotes
    S.start(5);
    let nMarkets = 0;
    for (const E of events) nMarkets += E.mk.sels.length;
    A.counts.markets = nMarkets;
    const withSharp = events.filter((E) => E.mk.sharp).length;
    const tgt = C.targetBook ? events.filter((E) => E.mk.hasTarget).length : null;
    if (C.targetBook && events.length && !tgt) A.errors.push(`Aucune cote ${C.targetBook} reçue : vérifiez la région (« eu » ou « fr ») dans Réglages`);
    S.done(5, `${tgt != null ? `${C.targetBook === 'winamax_fr' ? 'Winamax' : C.targetBook} présent sur ${tgt}/${events.length} événements · ` : ''}${nMarkets} sélections comparées sur ${events.reduce((s, E) => s + E.mk.nBooks, 0)} offres bookmakers ; Pinnacle présent sur ${withSharp}/${events.length} événements`);

    // ---------------- 7. modèles (phase 1 : présélection)
    S.start(6);
    const cands = [];
    const quickTennis = [];
    for (const E of events) {
      let M;
      try {
        if (E.sport === 'football') M = modelFootball(E, C, fbStats[E.sportKey], LD.clubelo);
        else if (E.sport === 'nba') M = modelNBA(E, C, nba);
        else if (E.sport === 'basket') M = modelNBA(E, C, null);
        else if (E.sport === 'hockey') M = modelHockey(E, C, nhl);
        else M = modelTennis(E, C, LD.tennis);
      } catch (err) { M = { error: String(err) }; }
      E.model = M;
      if (M.error) { E.skip = M.error; continue; }
      if (E.sport === 'tennis') quickTennis.push(E);
      else {
        for (const s of E.mk.sels) {
          if (s.noTarget) continue;
          const r = M.phase1(s);
          if (r.pWin == null) continue;
          Object.assign(s, { p1: r });
        }
      }
    }
    // tennis : simulation rapide 20 000 pour la présélection
    if (quickTennis.length) {
      const res = await runSims(quickTennis.map((E) => ({ spec: { ...E.model.simSpec, seed: hashSeed(E.id), minN: 20000, maxN: 20000, batch: 20000 }, sel: { type: 'tennisA', line: null } })));
      quickTennis.forEach((E, i) => {
        const simr = res[i]; if (!simr || simr.error) { E.skip = 'simulation échouée'; return; }
        E.qsim = simr;
        for (const s of E.mk.sels) {
          const sel = tennisSel(E, s); if (!sel || s.noTarget) continue;
          const r = SP.evalFromSim(simr, SP.normalizeSel(sel), s.best.price);
          s.p1 = tennisBlend(s, r, C, E);
        }
      });
    }
    for (const E of events) for (const s of E.mk.sels) if (s.p1) cands.push({ E, s, ev1: s.p1.ev });
    A.counts.analysed = events.filter((E) => !E.skip).length;
    S.done(6, `${A.counts.analysed} événements modélisés (phase 1) ; ${events.filter((E) => E.skip).length} écartés faute de données`);

    // ---------------- 8. Monte-Carlo (phase 2 : approfondie)
    S.start(7);
    const byEvent = new Map();
    for (const c of cands) {
      if (c.s.best.price < C.minOdds || c.s.best.price > C.maxOdds) continue;
      const cur = byEvent.get(c.E.id);
      if (!cur || c.ev1 > cur.ev1) byEvent.set(c.E.id, c);
    }
    const top = [...byEvent.values()].filter((c) => c.ev1 > -0.04).sort((a, b) => b.ev1 - a.ev1).slice(0, C.phase2Events);
    const tasks = top.map((c) => {
      const sel = c.E.sport === 'tennis' ? tennisSel(c.E, c.s) : { type: String(c.s.type).replace(/^reg_/, ''), point: c.s.point };
      return { spec: { ...c.E.model.simSpec, seed: hashSeed(c.E.id + c.s.id), minN: C.minSims, maxN: C.maxSims, tol: C.tol }, sel: SP.normalizeSel(sel) };
    });
    const simRes = await runSims(tasks, (d, n, sims) => S.progress(7, d, n, `${fmtInt(sims)} simulations`));
    let totalSims = 0;
    top.forEach((c, i) => {
      const r = simRes[i]; if (!r || r.error) { c.E.simError = r?.error || 'échec'; return; }
      c.E.sim = r; totalSims += r.n;
      const rEval = c.E.sport === 'hockey' ? SP.hockeyFinalSim(r, c.E.model.pOT, c.E.model.drawK) : r;
      const rReg = c.E.sport === 'hockey' ? SP.hockeyRegSim(r, c.E.model.drawK) : r;
      for (const s of c.E.mk.sels) {
        const sel = c.E.sport === 'tennis' ? tennisSel(c.E, s) : { type: String(s.type).replace(/^reg_/, ''), point: s.point };
        if (!sel || !s.p1) continue;
        const e = SP.evalFromSim(s.mkey === 'h2h_reg' ? rReg : rEval, SP.normalizeSel(sel), s.best.price);
        s.p2 = c.E.sport === 'tennis' ? { ...tennisBlend(s, e, C, c.E), ci: e.ci95, n: r.n } : { pWin: e.pWin, pPush: e.pPush, ev: e.ev, ci: e.ci95, n: r.n };
      }
    });
    A.counts.sims = totalSims;
    S.done(7, `${top.length} événements approfondis · ${fmtInt(totalSims)} simulations (arrêt adaptatif, IC95 visé ±${(C.tol * 100).toFixed(2)} pt)`);

    // ---------------- 9. classement
    S.start(8);
    const scored = [];
    for (const E of events) {
      if (E.skip) continue;
      for (const s of E.mk.sels) {
        let p = s.p2 || s.p1; if (!p) continue;
        if (C.platt && p.pWin != null) { const q = SP.applyPlatt(C.platt, p.pWin); p = { ...p, pWin: q, ev: q * s.best.price + (p.pPush || 0) - 1 }; }
        const pStats = s.p1.pStats, pMkt = s.p1.pMkt;
        const modelGap = pStats != null && pMkt != null ? Math.abs(pStats - pMkt) : null;
        const ci = s.p2 ? s.p2.ci : 0.01;
        // incertitude décomposée en 4 sources (cahier des charges §7)
        const uncParts = {
          hasard: ci,                                                     // erreur Monte-Carlo
          parametres: Math.sqrt((s.fairSd || 0.01) ** 2 + ((modelGap || 0) / 2) ** 2), // dispersion marché + désaccord des modèles
          donnees: (1 - (E.model.dataQuality ?? 0.3)) * 0.04,            // données faibles = estimation moins sûre
          informations: Math.min(0.05, (E.risk || 0) * 0.01),           // blessures, compositions inconnues
        };
        const uncert = Math.sqrt(Object.values(uncParts).reduce((a, x) => a + x * x, 0));
        const sc = E.sim?.scenarios?.map((x) => x.p).filter((x) => x != null) || [];
        const keySel = top.find((c) => c.E === E)?.s === s;
        const mcSpread = keySel && sc.length ? Math.max(...sc) - Math.min(...sc) : 0.05;
        const c = {
          E, s, sport: E.sport, t: E.t, best: s.best, second: s.second, fairMkt: s.fairMkt,
          p: p.pWin, pPush: p.pPush || 0, ev: p.ev,
          // edge : par rapport au marché SANS marge ; avantage de prix : par rapport à la cote Winamax brute
          edge: s.fairMkt != null ? p.pWin - s.fairMkt : p.pWin - 1 / s.best.price, priceEdge: p.pWin + (p.pPush || 0) / s.best.price - 1 / s.best.price,
          uncert, uncParts, modelGap, pStats, pMkt,
          simN: s.p2?.n || 0, simCI: s.p2?.ci ?? null, mcSpread,
          booksAtPrice: s.offers.filter((o) => o.price >= s.best.price - 1e-9).length,
        };
        const riskNote = [...E.warnings, ...(E.sport === 'football' && !E.lineup ? ['compositions non publiées'] : []), ...(E.staleOdds ? ['cotes issues du cache (fournisseur indisponible)'] : [])];
        if (E.staleOdds) c.critical = 'cotes non actualisées (fournisseur indisponible)';
        c.conf = SP.confidence({ p: c.p, dataQuality: E.model.dataQuality ?? 0.3, gap: modelGap, risk: E.risk, uncert, badCalib: C.platt && C.platt.b < 0.8 });
        c.reliable = SP.isReliable({ dataQuality: E.model.dataQuality ?? 0.3, gap: modelGap, risk: E.risk, uncert, badCalib: C.platt && C.platt.b < 0.8 });
        c.rel = SP.reliability({ dataQuality: E.model.dataQuality, dataNote: E.model.statsNote, nHist: E.model.nHist, calib: E.model.calib, mcSpread, paramSd: uncParts.parametres });
        c.q = SP.qualityScore({
          p: c.p, fairMkt: s.fairMkt, priceEdge: c.priceEdge, simCI: c.simCI, lineupUnknown: E.sport === 'football' && !E.lineup,
          edge: c.edge, uncert, modelGap, dataQuality: E.model.dataQuality, dataNote: E.model.statsNote, calib: E.model.calib,
          mcSpread, oddsAgeMin: (Date.now() - s.best.last) / 60e3, booksAtPrice: c.booksAtPrice, riskPenalty: E.risk, riskNote: riskNote.join(' ; '), odds: s.best.price,
        });
        c.check = assess(c, C, E);
        c.anomaly = c.ev > 0.15 && ['h2h', 'h2h_reg', 'totals', 'spreads'].includes(s.mkey);
        const sgIdx = { home: 0, draw: 1, away: 2 }[s.type] ?? (s.type === 'ahHome' && s.point === 0 ? 0 : s.type === 'ahAway' && s.point === 0 ? 2 : null);
        if (E.sg && sgIdx != null) {
          const ch = E.sg[sgIdx].chg;
          c.sgMove = ch;
          if (ch >= 0.08) { c.check.warn.push(`Singapore Pools : cote de cette issue en hausse de ${Math.round(ch * 100)} % depuis l'ouverture (le marché s'en éloigne)`); c.uncParts.informations += 0.02; c.uncert = Math.sqrt(Object.values(c.uncParts).reduce((a2, x) => a2 + x * x, 0)); c.reliable = false; }
        }
        scored.push(c);
      }
    }
    A.counts.scored = scored.length;
    // pronostics : pour chaque match, la lecture du moteur, même sans value
    for (const E of events) {
      if (E.skip) continue;
      try { E.forecast = forecast(E, scored.filter((c) => c.E === E), E.sport === 'football' ? fbStats[E.sportKey] : E.sport === 'nba' ? nba : E.sport === 'hockey' ? nhl : null); } catch (err) { E.forecast = null; }
    }
    const confRank = SP.CONF_RANK;
    A.forecasts = events.filter((E) => E.forecast && E.forecast.pick && E.t - Date.now() <= Math.max(C.hours, 24) * 3600e3)
      .sort((a, b) => (!!a.forecast.excluded - !!b.forecast.excluded) || confRank[b.forecast.confidence] - confRank[a.forecast.confidence] || b.forecast.pick.p - a.forecast.pick.p)
      .slice(0, 20).map((E) => ({ eventId: E.id, sport: E.sport, sportKey: E.sportKey, home: E.home, away: E.away, comp: E.comp, match: `${E.home} – ${E.away}`, t: E.t, day: E.day, ...E.forecast }));
    S.done(8, `${scored.length} sélections notées ; ${scored.filter((c) => c.check.ok).length} passent les filtres`);

    // ---------------- 10. validation finale
    S.start(9);
    let valid = scored.filter((c) => c.check.ok && c.simN > 0);
    // une sélection par événement (la mieux notée), 48 h seulement si exceptionnelle
    const perEvent = new Map();
    for (const c of valid.sort((a, b) => b.q.total - a.q.total || b.ev - a.ev)) if (!perEvent.has(c.E.id)) perEvent.set(c.E.id, c);
    valid = [...perEvent.values()].filter((c) => c.E.t - Date.now() <= C.hours * 3600e3 || c.q.total >= 75);
    // analyse qualitative (facultative) des meilleures sélections
    if (C.claudeKey && valid.length) {
      const top6 = valid.slice(0, 6);
      for (let i = 0; i < top6.length; i++) {
        S.progress(9, i, top6.length, 'analyse des actualités (Claude)');
        const c = top6[i];
        try { c.llm = await D.claudeAnalyze(C.claudeKey, llmPayload(c)); } catch (e) { c.llmError = String(e.message || e); D.setStatus('Claude', false, c.llmError); }
        c.check = assess(c, C, c.E);
      }
      valid = valid.filter((c) => c.check.ok);
    }
    // re-vérification : l'événement n'a pas commencé, la cote est toujours fraîche
    valid = valid.filter((c) => c.E.t > Date.now() + 15 * 60e3);
    valid.sort((a, b) => b.q.total - a.q.total || b.ev - a.ev);
    A.best = valid[0] ? pack(valid[0], 'best') : null;
    A.values = valid.slice(1, 6).map((c) => pack(c, 'value'));
    // opportunités à surveiller
    const watch = [];
    const usedEv = new Set(valid.slice(0, 6).map((c) => c.E.id));
    for (const c of scored.sort((a, b) => b.ev - a.ev)) {
      if (usedEv.has(c.E.id) || watch.length >= 5) continue;
      if (c.best.price < C.minOdds || c.best.price > C.maxOdds || c.E.t <= Date.now() + 15 * 60e3) continue;
      const need = [];
      const reqOdds = (1 + C.minEV) / c.p;
      if (c.ev < C.minEV && c.ev > -0.04) need.push(`cote ≥ ${reqOdds.toFixed(2)} (actuellement ${c.best.price.toFixed(2)} chez ${c.best.title})`);
      if (c.E.sport === 'football' && !c.E.lineup) need.push('composition officielle (~1 h avant) confirmant les titulaires');
      if (c.E.warnings.length) need.push('statut des joueurs incertains confirmé');
      if (c.check.reasons.some((r) => r.startsWith('divergence'))) need.push('explication de l’écart entre modèles et marché (blessure, rotation…)');
      if (c.llm?.impact === 'majeur') need.push('confirmation de l’information signalée dans les actualités');
      if (!need.length || c.ev < -0.04 || c.check.reasons.some((r) => /isolée|ancienne|commencé/.test(r))) continue;
      usedEv.add(c.E.id);
      watch.push({ ...pack(c, 'watch'), need });
    }
    A.watch = watch;
    // combiné : uniquement s'il bat chaque simple (sélections d'événements différents)
    if (valid.length >= 2) {
      const [a, b] = valid;
      const pj = a.p * b.p, oj = a.best.price * b.best.price, evj = pj * oj - 1;
      // rémunération du risque : EV / écart-type du rendement (un combiné augmente toujours l'EV brute)
      const ratio = (p, o) => (p * o - 1) / (o * Math.sqrt(p * (1 - p)));
      const rj = ratio(pj, oj), rs = Math.max(ratio(a.p, a.best.price), ratio(b.p, b.best.price));
      if (rj > rs && pj >= 0.3 && a.E.id !== b.E.id) A.combo = { legs: [pack(a), pack(b)], p: pj, odds: oj, ev: evj, ratio: rj, ratioSingles: rs, note: 'Événements distincts supposés indépendants (matchs différents). Retenu car son EV rapportée au risque dépasse celle des paris simples.' };
      else A.comboRejected = `combiné étudié (${a.E.home}/${b.E.home}) : EV ${(evj * 100).toFixed(1)} % mais rapport EV/risque ${rj.toFixed(3)} ≤ ${rs.toFixed(3)} pour le meilleur simple — non retenu`;
    }
    // PARIS SÛRS : très probables (≥ safeMinP), cote modérée, et cote Winamax pas en dessous de sa vraie valeur
    // (EV ≥ 0 = « cote correcte » ; légèrement négative jusqu'à safeTolEV = « cote un peu basse »).
    {
      const byEv = new Map();
      for (const c of scored) {
        const E = c.E;
        if (c.s.noTarget || c.anomaly || c.p == null || c.p < C.safeMinP) continue;
        if (c.best.price < C.minOdds || c.best.price > C.safeMaxOdds) continue;
        if (E.t <= Date.now() + 15 * 60e3 || E.t - Date.now() > Math.max(C.hours, 24) * 3600e3) continue;
        if (c.ev < C.safeTolEV || (c.modelGap != null && c.modelGap > 0.08) || E.risk >= 3 || E.staleOdds) continue;
        const tier = c.ev >= 0 ? 1 : 2;
        const cur = byEv.get(E.id);
        if (!cur || tier < cur.tier || (tier === cur.tier && c.p > cur.c.p)) byEv.set(E.id, { c, tier });
      }
      const realSafe = [...byEv.values()].map(({ c, tier }) => ({
        tier, conf: c.conf, reliable: c.reliable, rel: c.rel.total, uncert: c.uncert, eventId: c.E.id, sport: c.E.sport, sportKey: c.E.sportKey, comp: c.E.comp, match: `${c.E.home} – ${c.E.away}`, home: c.E.home, away: c.E.away, t: c.E.t,
        label: c.s.label, type: c.s.type, point: c.s.point, market: c.s.mkey, odds: c.best.price, book: c.best.title, p: c.p, pPush: c.pPush, ev: c.ev, value: c.check.ok, fair: 1 / c.p,
      }));
      // marchés football calculés (sans cote API) : pari sûr « à vérifier » si la probabilité est haute,
      // la cote juste ≥ cote minimale, les données du match fiables (équipes appariées) et sans risque majeur.
      const derived = [];
      for (const E of events) {
        if ((E.sport !== 'football' && E.sport !== 'hockey') || !E.forecast?.markets || !E.model?.st || E.risk >= 3 || E.staleOdds) continue;
        if (E.t <= Date.now() + 15 * 60e3 || E.t - Date.now() > Math.max(C.hours, 24) * 3600e3) continue;
        if (realSafe.some((s) => s.eventId === E.id && s.tier === 1)) continue;
        const gap = E.sport === 'hockey' ? Math.abs((E.model.st.pHome ?? 0) - (E.model.models[0].pHome ?? 0)) : Math.abs((E.model.st.p1x2?.[0] ?? 0) - (E.model.models[0].p1x2?.[0] ?? 0));
        if (gap > 0.08) continue;
        const m = E.forecast.markets.filter((x) => !x.real && !x.risky && x.p >= C.safeMinP && x.minSafe >= C.minOdds).sort((a, b) => b.p - a.p)[0];
        if (!m) continue;
        derived.push({ tier: 1.5, conf: confOf(E, m.p, gap, 0.03), reliable: SP.isReliable({ dataQuality: E.model?.dataQuality ?? 0.3, gap, risk: E.risk, uncert: 0.03 }), uncert: 0.03, eventId: E.id, sport: E.sport, sportKey: E.sportKey, comp: E.comp, match: `${E.home} – ${E.away}`, home: E.home, away: E.away, t: E.t,
          label: m.label, type: m.type, point: m.point, market: 'calculé', odds: null, book: 'Winamax', p: m.p, pPush: m.pPush, ev: null, value: false, fair: m.fair, minOdds: m.minSafe, toVerify: true });
      }
      const cr = SP.CONF_RANK;
      A.safe = [...realSafe, ...derived].sort((x, y) => cr[y.conf] - cr[x.conf] || x.tier - y.tier || y.p - x.p).slice(0, 8);
    }
    // PRONOSTIC DU JOUR (v3) : exploration de TOUS les marchés de chaque match (cotes Winamax réelles et marchés
    // calculés), classement prioritaire / alternatif / à éviter, puis un seul choix avec un verdict explicite.
    {
      const R = SP.CONF_RANK;
      const eventGap = (E) => E.sport === 'football' ? (E.model?.st?.p1x2 && E.model.models?.[0]?.p1x2 ? Math.abs(E.model.st.p1x2[0] - E.model.models[0].p1x2[0]) : null)
        : E.sport === 'tennis' ? (E.model?.pEloA != null ? Math.abs(E.model.pEloA - (E.model.models?.[0]?.pA ?? 0.5)) : null) : null;
      const plain = (k) => ({ label: k.label, odds: k.odds, minOdds: k.minOdds ?? null, p: k.p, ev: k.ev, conf: k.conf, cat: k.cat, why: k.why || null, src: k.src });
      const allOk = [], allCands = [];
      for (const E of events) {
        if (E.skip || !E.forecast || E.t <= Date.now() + 15 * 60e3) continue;
        const cands = [];
        for (const c of scored.filter((x) => x.E === E && !x.s.noTarget && x.p != null && x.best.price >= C.minOdds && x.best.price <= Math.max(C.maxOdds, 3))) {
          cands.push({ E, src: 'api', c, label: c.s.label, type: c.s.type, point: c.s.point, market: c.s.mkey, odds: c.best.price, book: c.best.title, oddsAt: c.best.last, p: c.p, pPush: c.pPush, ev: c.ev, priceEdge: c.priceEdge, edge: c.edge, uncert: c.uncert, uncParts: c.uncParts, conf: c.conf, rel: c.rel, q: c.q, anomaly: c.anomaly, valueOk: c.check.ok, modelGap: c.modelGap });
        }
        const g = eventGap(E);
        for (const m of (E.forecast.markets || []).filter((x) => !x.real && !x.risky)) {
          const u = 0.03 + (1 - (E.model.dataQuality ?? 0.3)) * 0.02;
          const minOk = Math.ceil(((1 + C.minEV - (m.pPush || 0)) / Math.max(0.01, m.p - u)) * 100) / 100;
          if (minOk < C.minOdds || minOk > C.maxOdds) { if (minOk >= 1.15 && minOk <= 3) allCands.push({ E, src: 'calc', label: m.label, type: m.type, point: m.point, side: m.side, market: 'calculé', odds: null, minOdds: minOk, fair: m.fair, p: m.p, pPush: m.pPush || 0, ev: null, uncert: u, conf: confOf(E, m.p, g, u), toVerify: true, modelGap: g }); continue; }
          cands.push({ E, src: 'calc', label: m.label, type: m.type, point: m.point, side: m.side, market: 'calculé', odds: null, minOdds: minOk, fair: m.fair, p: m.p, pPush: m.pPush || 0, ev: null, uncert: u, conf: confOf(E, m.p, g, u), toVerify: true, modelGap: g });
        }
        for (const k of cands) {
          if (k.anomaly) { k.cat = 'à éviter'; k.why = 'cote anormale (erreur de données probable)'; continue; }
          const strong = SP.isStrong(k.conf);
          const valueRobust = k.src === 'api' ? (k.ev >= C.minEV && k.priceEdge > k.uncert) : true;
          if (strong && valueRobust) k.cat = 'prioritaire';
          else if (R[k.conf] >= 3 && (k.src === 'calc' || k.ev >= -0.02)) k.cat = 'alternatif';
          else { k.cat = 'à éviter'; k.why = R[k.conf] < 3 ? `confiance ${k.conf}` : 'cote trop basse par rapport à la vraie valeur'; }
        }
        allCands.push(...cands.filter((k) => !k.anomaly));
        const api = cands.filter((k) => k.src === 'api' && !k.anomaly);
        const ok = cands.filter((k) => k.cat !== 'à éviter');
        const bal = (k) => k.p + 2 * Math.min(0.1, k.ev ?? 0);
        E.explore = {
          n: cands.length,
          bestProb: [...ok].sort((x, y) => y.p - x.p)[0] || null,
          bestValue: [...api].sort((x, y) => y.ev - x.ev)[0] || null,
          bestBalance: [...ok].sort((x, y) => bal(y) - bal(x))[0] || null,
          alternatives: [...ok].sort((x, y) => R[y.conf] - R[x.conf] || y.p - x.p).slice(0, 4),
          avoid: cands.filter((k) => k.cat === 'à éviter').sort((x, y) => y.p - x.p).slice(0, 3),
        };
        E.forecast.explore = { n: cands.length, bestProb: E.explore.bestProb && plain(E.explore.bestProb), bestValue: E.explore.bestValue && plain(E.explore.bestValue), bestBalance: E.explore.bestBalance && plain(E.explore.bestBalance), alternatives: E.explore.alternatives.map(plain), avoid: E.explore.avoid.map(plain) };
        allOk.push(...ok);
      }
      const order = (x, y) => R[y.conf] - R[x.conf] || ((y.ev ?? 0) - (x.ev ?? 0)) || y.p - x.p;
      const prio = allOk.filter((k) => k.cat === 'prioritaire').sort(order)[0];
      const alt = allOk.filter((k) => k.cat === 'alternatif').sort(order)[0];
      // dernier recours : l'utilisateur veut toujours un pari. On prend la sélection la plus sûre parmi tout ce qui
      // a été exploré (probabilité d'abord, en écartant les cotes négligeables), étiquetée clairement.
      const fbScore = (x) => x.p * (x.src === 'api' ? 1 : 0.97) + Math.min(0.05, Math.max(-0.05, x.ev ?? 0));
      const fallback = !prio && !alt ? allCands.filter((x) => (x.odds ?? x.minOdds) >= 1.15).sort((x, y) => fbScore(y) - fbScore(x))[0] : null;
      const k = prio || alt || fallback;
      if (!k) {
        // aucune cote exploitable (crédits épuisés, API en erreur…) : pronostic tiré des données gratuites de la présélection
        const opts = [];
        for (const m of pre.matches) for (const o of m.opts || []) if (m.t > Date.now() + 15 * 60e3 && o.p >= 0.55 && o.p <= 0.9) opts.push({ m, o });
        opts.sort((x, y) => (y.o.p + 0.002 * y.m.score) - (x.o.p + 0.002 * x.m.score));
        const best = opts[0];
        if (best) {
          const { m, o } = best, u = 0.05;
          const minOdds = Math.ceil(((1 + C.minEV) / Math.max(0.01, o.p - u)) * 100) / 100;
          const conf = o.p >= 0.6 ? 'moyenne' : 'faible';
          A.daily = { status: 'meilleur disponible', level: 'meilleur disponible', kind: 'sûr-verif', verdict: 'Meilleur pari disponible, sans cote vérifiée', eventId: m.id, sport: m.sport, sportKey: m.key, comp: m.comp,
            match: `${m.home} – ${m.away}`, home: m.home, away: m.away, t: m.t, quality: null, reliability: null, uncert: u, confidence: conf, headline: 'Estimation à partir des données gratuites',
            pick: { label: o.label, type: o.type, point: o.point ?? null, market: o.market || 'calculé', odds: null, book: 'Winamax', p: o.p, pPush: 0, ev: null, value: false, uncert: u, minOdds, fair: 1 / o.p, reliable: false, toVerify: true, level: 'meilleur disponible' },
            why: [`Probabilité estimée ${(o.p * 100).toFixed(0)} % par ${m.sport === 'tennis' ? 'le classement Elo des joueurs' : 'le modèle Dixon-Coles sur les résultats de la saison'}.`, `Score de pertinence du match : ${m.score}/100.`, `Aucune cote n'a pu être récupérée pour cette analyse : jouez ce pari seulement si Winamax propose au moins ${minOdds.toFixed(2)}.`],
            warnings: ['Pronostic sans cote de marché : il n’a pas été confronté aux cotes des bookmakers, prudence.'], dataNote: 'données gratuites (football-data.co.uk, Elo tennis)' };
        }
      }
      // la liste « Analyse du jour » suit le même classement
      const bestOf = (E) => (E.explore ? [E.explore.bestBalance].filter(Boolean)[0] : null);
      const evOrder = new Map(events.filter((E) => E.explore?.bestBalance).sort((x, y) => order(bestOf(x), bestOf(y))).map((E, i) => [E.id, i]));
      A.forecasts = (A.forecasts || []).map((f) => ({ ...f, explore: events.find((E) => E.id === f.eventId)?.forecast?.explore || null }))
        .sort((x, y) => (evOrder.get(x.eventId) ?? 999) - (evOrder.get(y.eventId) ?? 999));
      if (k) {
        const E = k.E, f = E.forecast;
        const status = prio ? 'prioritaire' : alt ? 'alternatif' : 'meilleur disponible';
        if (k.E.id) A.forecasts.sort((x, y) => (y.eventId === E.id) - (x.eventId === E.id));
        const verdict = !prio && !alt ? 'Meilleur pari disponible, mise réduite' : prio ? (k.conf === 'très haute' && k.src === 'api' && k.ev >= C.minEV ? 'Très bon profil statistique' : 'Sélection intéressante')
          : (k.p >= 0.78 && k.src === 'api' && (k.ev ?? 0) < C.minEV) ? 'Probabilité élevée mais value insuffisante'
          : (k.src === 'api' && k.ev >= C.minEV) ? 'Value intéressante mais risque important' : 'Mise réduite conseillée';
        const kind = k.toVerify ? 'sûr-verif' : (k.src === 'api' && k.ev >= C.minEV && k.valueOk ? 'value' : 'sûr');
        const pick = { label: k.label, type: k.type, point: k.point, market: k.market, odds: k.odds, book: k.book || 'Winamax', p: k.p, pPush: k.pPush, ev: k.ev, value: !!k.valueOk, uncert: k.uncert, minOdds: k.minOdds, fair: k.fair ?? (1 - (k.pPush || 0)) / k.p, reliable: SP.isStrong(k.conf), toVerify: !!k.toVerify, level: status };
        const why = [];
        why.push(`${f.headline} : ${E.sport === 'football' ? `1 ${(f.probs.home * 100).toFixed(0)} % · N ${(f.probs.draw * 100).toFixed(0)} % · 2 ${(f.probs.away * 100).toFixed(0)} %` : `${E.home} ${(f.probs.home * 100).toFixed(0)} % · ${E.away} ${(f.probs.away * 100).toFixed(0)} %`}.`);
        if (E.sport === 'football') why.push(`Buts attendus ${f.expected.home.toFixed(2)} – ${f.expected.away.toFixed(2)}, score le plus probable ${f.score.h}-${f.score.a}.`);
        if (f.form?.home && f.form?.away) why.push(`Forme récente : ${E.home} ${f.form.home.seq}, ${E.away} ${f.form.away.seq} (du plus ancien au plus récent).`);
        why.push(`${E.explore.n} marchés explorés sur ce match ; retenu car c'est le meilleur compromis confiance / probabilité / cote parmi tous les matchs analysés.`);
        if (k.src === 'api' && k.c?.pStats != null && k.c?.pMkt != null) why.push(`Modèles statistiques ${(k.c.pStats * 100).toFixed(0)} % contre ${(k.c.pMkt * 100).toFixed(0)} % pour le marché sans marge : ${Math.abs(k.c.pStats - k.c.pMkt) < 0.05 ? 'ils sont d’accord' : 'léger désaccord, prudence'}.`);
        why.push(k.toVerify ? `Marché calculé : la cote Winamax n'est pas fournie par l'API ; jouez-le seulement si Winamax propose au moins ${k.minOdds.toFixed(2)}.`
          : k.ev >= 0 ? `La cote ${k.odds.toFixed(2)} est au moins égale à sa vraie valeur (${pick.fair.toFixed(2)}).` : `La cote ${k.odds.toFixed(2)} est sous la vraie valeur (${pick.fair.toFixed(2)}) : rentabilité insuffisante.`);
        const opinion = analystOpinion(E, pick, kind, k.c || null);
        const rel = k.rel || SP.reliability({ dataQuality: E.model.dataQuality, dataNote: E.model.statsNote, nHist: E.model.nHist, calib: E.model.calib, mcSpread: 0.05, paramSd: k.uncert });
        A.daily = { status, verdict, opinion, level: status, kind, eventId: E.id, sport: E.sport, sportKey: E.sportKey, comp: E.comp, match: `${E.home} – ${E.away}`, home: E.home, away: E.away, t: E.t, day: E.day,
          quality: k.q || null, reliability: rel, uncert: k.uncert, uncParts: k.uncParts || null, edge: k.edge ?? null, oddsAt: k.oddsAt ?? null, confidence: k.conf, headline: f.headline, pick, why, warnings: E.warnings, dataNote: f.dataNote };
      } else if (!A.daily) { A.daily = null; A.dailyVerdict = 'Aucune sélection suffisamment fiable'; }
    }
    A.events = events.map(slimEvent);
    A.finishedAt = Date.now();
    S.done(9, A.best ? `meilleur pari : ${A.best.match} — ${A.best.label}` : 'aucun pari validé', false);
    return finish(A, ui);
  }

  // Tennis : le modèle jeu par jeu repose sur une hypothèse de taux de service moyen du circuit.
  // Pour les totaux/handicaps, il est combiné au prix juste du marché et l'écart est soumis à la règle de divergence.
  function tennisBlend(s, r, C, E) {
    const pm = r.pWin;
    if (s.mkey === 'h2h') {
      const pe = E?.model?.pEloA;
      return { pWin: pm, pPush: r.pPush, ev: pm * s.best.price + r.pPush - 1, pMkt: s.fairMkt, pStats: pe == null ? null : (s.name === E.home ? pe : 1 - pe) };
    }
    const useMkt = s.mkey !== 'h2h' && s.fairMkt != null;
    const p = useMkt ? C.wMarket * s.fairMkt + (1 - C.wMarket) * pm : pm;
    return { pWin: p, pPush: r.pPush, ev: p * s.best.price + r.pPush - 1, pMkt: s.fairMkt, pStats: s.mkey !== 'h2h' ? pm : null };
  }
  // Tous les marchés football dérivés de la matrice de scores finale (probabilité exacte, cote juste,
  // cote minimale conseillée) ; la cote Winamax réelle est jointe quand l'API la fournit.
  function footballMarkets(mat, E) {
    const C = cfg();
    const pseudo = { kind: 'football', M: mat.length, hist: mat.flat() };
    const defs = [
      ['1', `${E.home} gagne`, 'home', null, 'h2h'], ['N', 'Match nul', 'draw', null, 'h2h'], ['2', `${E.away} gagne`, 'away', null, 'h2h'],
      ['1N', `Double chance ${E.home} ou nul`, 'dc1X', null], ['N2', `Double chance nul ou ${E.away}`, 'dcX2', null], ['12', 'Double chance : pas de nul', 'dc12', null],
      ['DNB1', `Remboursé si nul : ${E.home}`, 'ahHome', 0], ['DNB2', `Remboursé si nul : ${E.away}`, 'ahAway', 0],
      ['O05', 'Plus de 0,5 but', 'over', 0.5], ['O15', 'Plus de 1,5 buts', 'over', 1.5], ['O25', 'Plus de 2,5 buts', 'over', 2.5, 'totals'], ['O35', 'Plus de 3,5 buts', 'over', 3.5],
      ['U15', 'Moins de 1,5 buts', 'under', 1.5], ['U25', 'Moins de 2,5 buts', 'under', 2.5, 'totals'], ['U35', 'Moins de 3,5 buts', 'under', 3.5], ['U45', 'Moins de 4,5 buts', 'under', 4.5],
      ['BTTSY', 'Les deux équipes marquent : oui', 'bttsYes', null], ['BTTSN', 'Les deux équipes marquent : non', 'bttsNo', null],
      ['HS', `${E.home} marque (plus de 0,5 but)`, 'homeTotalOver', null], ['AS', `${E.away} marque (plus de 0,5 but)`, 'awayTotalOver', null],
      ['H15', `${E.home} plus de 1,5 buts`, 'homeOver15', null], ['A15', `${E.away} plus de 1,5 buts`, 'awayOver15', null],
      ['HCS', `${E.home} ne prend pas de but`, 'homeCS', null], ['ACS', `${E.away} ne prend pas de but`, 'awayCS', null],
      ['HWN', `${E.home} gagne sans encaisser`, 'homeWinToNil', null], ['AWN', `${E.away} gagne sans encaisser`, 'awayWinToNil', null],
      ['HO15', `${E.home} gagne et plus de 1,5 buts`, 'homeAndOver15', null], ['AO15', `${E.away} gagne et plus de 1,5 buts`, 'awayAndOver15', null],
      ['HBT', `${E.home} gagne et les deux équipes marquent`, 'homeAndBtts', null], ['ABT', `${E.away} gagne et les deux équipes marquent`, 'awayAndBtts', null],
      ['1NU35', `${E.home} ou nul et moins de 3,5 buts`, 'dc1XAndUnder35', null], ['N2U35', `Nul ou ${E.away} et moins de 3,5 buts`, 'dcX2AndUnder35', null],
      ['AH1-1', `Handicap ${E.home} -1 (remboursé si 1 but d’écart)`, 'ahHome', -1], ['AH2-1', `Handicap ${E.away} -1 (remboursé si 1 but d’écart)`, 'ahAway', -1],
      ['AH1+1', `Handicap ${E.home} +1`, 'ahHome', 1], ['AH2+1', `Handicap ${E.away} +1`, 'ahAway', 1],
    ];
    // trois scores exacts les plus probables (jamais en pari sûr)
    const sc = [];
    mat.forEach((row, i) => row.forEach((v, j) => sc.push([i, j, v])));
    sc.sort((a, b) => b[2] - a[2]);
    for (const [i, j] of sc.slice(0, 3)) defs.push([`S${i}${j}`, `Score exact ${i}-${j}`, 'exact', null, null, { h: i, a: j, risky: true }]);
    const out = defs.map(([key, label, type, point, mkey, extra]) => {
      const sel = { ...SP.normalizeSel({ type, point }), ...(extra || {}) };
      const r = SP.evalFromSim(pseudo, sel, 2);
      const fair = (1 - r.pPush) / Math.max(1e-6, r.pWin);
      // cote Winamax réelle si l'API la fournit pour ce marché
      let real = null;
      if (mkey) {
        const s = E.mk.sels.find((x) => !x.noTarget && x.mkey === mkey && x.type === type && (point == null || x.point === point));
        if (s) real = { odds: s.best.price, book: s.best.title, last: s.best.last };
      }
      return { key, label, type, point, h: extra?.h, a: extra?.a, risky: !!extra?.risky, p: r.pWin, pPush: r.pPush, fair, minSafe: Math.ceil(fair * (1 + C.safeTolEV) * 100) / 100, minValue: Math.ceil(fair * (1 + C.minEV) * 100) / 100, real, ev: real ? r.pWin * real.odds + r.pPush - 1 : null };
    });
    // corners et cartons : non proposés par Winamax, volontairement absents.
    return out;
  }
  const countFits = {};
  // Marchés hockey calculés : prolongation incluse (score final) ou temps réglementaire (60 min)
  function hockeyMarkets(reg, F, E) {
    const C = cfg();
    const evalOn = (mat, type, point) => SP.evalFromSim({ kind: 'football', M: mat.length, hist: mat.flat() }, SP.normalizeSel({ type, point }), 2);
    const defs = [
      [F, 'home', null, `${E.home} gagne (prolongation incluse)`, 'h2h'], [F, 'away', null, `${E.away} gagne (prolongation incluse)`, 'h2h'],
      [reg, 'home', null, `${E.home} gagne dans le temps réglementaire`, 'h2h_reg'], [reg, 'draw', null, 'Nul à la fin du temps réglementaire', 'h2h_reg'], [reg, 'away', null, `${E.away} gagne dans le temps réglementaire`, 'h2h_reg'],
      [reg, 'dc1X', null, `${E.home} ou nul (temps réglementaire)`], [reg, 'dcX2', null, `Nul ou ${E.away} (temps réglementaire)`],
      ...[4.5, 5.5, 6.5, 7.5].flatMap((l) => [[F, 'over', l, `Plus de ${String(l).replace('.', ',')} buts (prol. incluse)`, 'totals'], [F, 'under', l, `Moins de ${String(l).replace('.', ',')} buts (prol. incluse)`, 'totals']]),
      [F, 'ahHome', -1.5, `${E.home} -1,5 (puck line)`, 'spreads'], [F, 'ahAway', 1.5, `${E.away} +1,5 (puck line)`, 'spreads'],
      [F, 'ahAway', -1.5, `${E.away} -1,5 (puck line)`, 'spreads'], [F, 'ahHome', 1.5, `${E.home} +1,5 (puck line)`, 'spreads'],
      [F, 'homeOver15', null, `${E.home} marque au moins 2 buts`], [F, 'awayOver15', null, `${E.away} marque au moins 2 buts`],
      [F, 'bttsYes', null, 'Les deux équipes marquent'],
    ];
    return defs.map(([mat, type, point, label, mkey]) => {
      const r = evalOn(mat, type, point), fair = (1 - r.pPush) / Math.max(1e-6, r.pWin);
      let real = null;
      if (mkey) { const s = E.mk.sels.find((x) => !x.noTarget && x.mkey === mkey && String(x.type).replace(/^reg_/, '') === type && (point == null || x.point === point)); if (s) real = { odds: s.best.price, book: s.best.title, last: s.best.last }; }
      const regulation = mat === reg;
      return { key: type + (point ?? '') + (regulation ? 'TR' : ''), label, type: regulation ? 'reg_' + type : type, point, regulation, p: r.pWin, pPush: r.pPush, fair, minSafe: Math.ceil(fair * (1 + C.safeTolEV) * 100) / 100, minValue: Math.ceil(fair * (1 + C.minEV) * 100) / 100, real, ev: real ? r.pWin * real.odds + r.pPush - 1 : null };
    });
  }
  // Confiance d'un pari donné : « forte » seulement si très probable, données solides (modèle statistique
  // indépendant disponible), modèles d'accord avec le marché et aucun risque signalé sur le match.
  function confOf(E, p, gap, uncert) {
    return SP.confidence({ p, dataQuality: E.model?.dataQuality ?? 0.3, gap, risk: E.risk, uncert: uncert ?? 0.03, badCalib: false }) ;
  }
  // AVIS DE L'ANALYSTE : texte rédigé à partir des chiffres de l'analyse (aucune invention, aucun LLM).
  function analystOpinion(E, pick, kind, c) {
    const f = E.forecast || {}, out = { verdict: '', pour: [], contre: [], conseil: '' };
    const pc = Math.round(pick.p * 100), fair = (1 - (pick.pPush || 0)) / pick.p;
    const gapC = c?.modelGap ?? null, lvl = pick.level;
    const weak = lvl === 'prudent' || (gapC != null && gapC > 0.08);
    out.verdict = weak ? `Journée pauvre en paris solides : c'est le meilleur choix disponible (${pc} % de chances), mais les signaux ne sont pas tous au vert. Je le jouerais petit.`
      : lvl === 'correct' ? `Pari correct mais pas imparable : ${pc} % de chances, soit environ une défaite sur ${Math.max(2, Math.round(1 / (1 - pick.p)))}.`
      : pick.p >= 0.8 ? `Je trouve ce pari solide : ${pc} % de chances selon l'analyse.`
      : pick.p >= 0.72 ? `Bon pari à mon avis : ${pc} % de chances, c'est le plus fiable des matchs du jour.`
      : pick.p >= 0.65 ? `Pari correct mais pas imparable : ${pc} % de chances, soit environ une défaite sur ${Math.max(2, Math.round(1 / (1 - pick.p)))}.`
      : `Journée pauvre en bons paris : c'est le meilleur choix disponible, mais avec ${pc} % de chances, je le jouerais petit ou pas du tout.`;
    if (!c && E.model?.st?.p1x2 && E.model.models?.[0]?.p1x2) {
      const g = Math.abs(E.model.st.p1x2[0] - E.model.models[0].p1x2[0]);
      (g <= 0.05 ? out.pour : out.contre).push(`Modèles statistiques et marché ${g <= 0.05 ? 'd’accord' : 'pas tout à fait d’accord'} sur le rapport de force (${Math.round(E.model.st.p1x2[0] * 100)} % contre ${Math.round(E.model.models[0].p1x2[0] * 100)} % pour la victoire à domicile).`);
    } else if (c?.pStats != null && c?.pMkt != null) (Math.abs(c.pStats - c.pMkt) <= 0.05 ? out.pour : out.contre).push(`Modèles statistiques (${Math.round(c.pStats * 100)} %) et marché (${Math.round(c.pMkt * 100)} %) ${Math.abs(c.pStats - c.pMkt) <= 0.05 ? 'sont d’accord' : 'ne sont pas tout à fait d’accord'}.`);
    else out.contre.push('Aucun modèle statistique indépendant pour confirmer : l’estimation repose surtout sur le marché.');
    if (f.form?.home && f.form?.away) {
      const w = (s) => (s.match(/V/g) || []).length;
      const [h, a] = [f.form.home.seq, f.form.away.seq];
      if (w(h) - w(a) >= 2) out.pour.push(`${E.home} est en meilleure forme (${h} contre ${a}).`);
      else if (w(a) - w(h) >= 2) out.pour.push(`${E.away} est en meilleure forme (${a} contre ${h}).`);
    }
    if ((E.sport === 'football' || E.sport === 'hockey') && f.expected) out.pour.push(`Buts attendus ${f.expected.home.toFixed(1)} – ${f.expected.away.toFixed(1)}.`);
    if (pick.odds != null) (pick.odds >= fair ? out.pour : out.contre).push(pick.odds >= fair ? `La cote ${pick.odds.toFixed(2)} est au-dessus de sa vraie valeur (${fair.toFixed(2)}).` : `La cote ${pick.odds.toFixed(2)} est un peu sous sa vraie valeur (${fair.toFixed(2)}) : rentabilité faible sur la durée.`);
    const sgI = { home: 0, draw: 1, away: 2 }[pick.type] ?? (pick.type === 'ahHome' && pick.point === 0 ? 0 : pick.type === 'ahAway' && pick.point === 0 ? 2 : pick.type === 'dc1X' ? 0 : pick.type === 'dcX2' ? 2 : null);
    if (E.sg && sgI != null) {
      const o = E.sg[sgI];
      if (o.chg <= -0.05) out.pour.push(`Singapore Pools : cote passée de ${o.open.toFixed(2)} à ${o.cur.toFixed(2)} (${Math.round(o.chg * 100)} %) : l’argent va dans ce sens.`);
      else if (o.chg >= 0.05) out.contre.push(`Singapore Pools : cote passée de ${o.open.toFixed(2)} à ${o.cur.toFixed(2)} (+${Math.round(o.chg * 100)} %) : le marché s’éloigne de ce pari.`);
    }
    for (const w of E.warnings || []) out.contre.push(w);
    if (E.sport === 'football' && !E.lineup) out.contre.push('Compositions pas encore publiées.');
    const minOk = Math.ceil(((1 + cfg().minEV - (pick.pPush || 0)) / Math.max(0.01, pick.p - (pick.uncert ?? 0.03))) * 100) / 100;
    out.conseil = pick.odds == null ? `Jouez-le seulement si Winamax propose au moins ${minOk.toFixed(2)}.`
      : !weak && lvl !== 'correct' && pick.p >= 0.72 && (pick.ev ?? 0) >= -0.02 ? 'Mon conseil : jouable, avec la mise indiquée. Revérifiez 1 h avant le match avec « Actualiser et réanalyser ».'
      : !weak && pick.p >= 0.65 ? 'Mon conseil : petite mise seulement, et vérifiez la composition ou les blessures avant de jouer.'
      : 'Mon conseil : abstenez-vous ou mise symbolique ; rien de vraiment solide aujourd’hui.';
    return out;
  }
  // Forme récente à partir des résultats déjà chargés (V/N/D, buts ou points marqués/encaissés)
  function recentForm(games, team, n, hk, ak) {
    const gs = games.filter((g) => g.h === team || g.a === team).slice(-n);
    if (!gs.length) return null;
    let gf = 0, ga = 0, xf = 0, xa = 0, nx = 0;
    const seq = gs.map((g) => {
      const home = g.h === team, f = home ? g[hk] : g[ak], a = home ? g[ak] : g[hk];
      gf += f; ga += a;
      if (g.hxg != null) { xf += home ? g.hxg : g.axg; xa += home ? g.axg : g.hxg; nx++; }
      return f > a ? 'V' : f === a ? 'N' : 'D';
    }).join('');
    return { seq, gf: gf / gs.length, ga: ga / gs.length, xgf: nx ? xf / nx : null, xga: nx ? xa / nx : null, n: gs.length };
  }
  let scorersData = null, localFootball = null;
  function forecast(E, cands, stats) {
    const f = { facts: [] };
    if (E.sport === 'football') {
      const { lh, la, rho } = E.model.final;
      const mat = SP.scoreMatrix(lh, la, rho);
      const [ph, pd, pa] = SP.matrix1x2(mat);
      let best = [0, 0, 0];
      mat.forEach((row, i) => row.forEach((v, j) => { if (v > best[2]) best = [i, j, v]; }));
      let btts = 0; mat.forEach((row, i) => row.forEach((v, j) => { if (i > 0 && j > 0) btts += v; }));
      f.probs = { home: ph, draw: pd, away: pa, over25: SP.matrixOver(mat, 2.5), btts };
      f.expected = { home: lh, away: la };
      f.score = { h: best[0], a: best[1], p: best[2] };
      f.markets = footballMarkets(mat, E);
      // buteurs : part des buts de l'équipe cette saison × buts attendus de l'équipe dans ce match (si titulaire)
      const SC = scorersData?.leagues?.[E.sportKey]?.teams;
      if (SC) {
        const names = Object.keys(SC), out = [];
        for (const [side, lam] of [[E.home, lh], [E.away, la]]) {
          const m = D.bestMatch(side, names); if (!m.name) continue;
          const T = SC[m.name];
          for (const pl of T.players.filter((x) => x.goals >= 2)) {
            const share = pl.goals / (T.goals + 2);
            out.push({ name: pl.name, team: m.name, goals: pl.goals, pens: pl.pens, p: 1 - Math.exp(-lam * share * 1.1) });
          }
        }
        f.scorers = out.sort((a, b) => b.p - a.p).slice(0, 6);
      }
      const top = Math.max(ph, pd, pa);
      f.headline = top < 0.42 ? 'Match très ouvert' : ph === top ? `Victoire de ${E.home} probable` : pa === top ? `Victoire de ${E.away} probable` : 'Match nul probable';
      if (stats?.ms && E.model.st?.match) {
        const [mh, ma] = E.model.st.match.map((m) => m.name);
        f.form = { home: recentForm(stats.ms, mh, 5, 'hg', 'ag'), away: recentForm(stats.ms, ma, 5, 'hg', 'ag') };
      }
    } else if (E.sport === 'hockey') {
      const { lh, la } = E.model.final;
      const reg = SP.inflateDraws(SP.scoreMatrix(lh, la, 0, 12), E.model.drawK || 1), F = SP.hockeyFinal(reg, E.model.pOT);
      let ph = 0, best = [0, 0, 0]; F.forEach((r, i) => r.forEach((v, j) => { if (i > j) ph += v; if (v > best[2]) best = [i, j, v]; }));
      const [rh, rd, ra] = SP.matrix1x2(reg);
      f.probs = { home: ph, away: 1 - ph, regHome: rh, regDraw: rd, regAway: ra };
      f.expected = { home: lh, away: la, total: lh + la };
      f.score = { h: best[0], a: best[1], p: best[2] };
      f.headline = Math.abs(ph - 0.5) < 0.07 ? 'Match serré' : ph > 0.5 ? `Victoire de ${E.home} probable` : `Victoire de ${E.away} probable`;
      f.markets = hockeyMarkets(reg, F, E);
      if (stats?.gs && E.model.matched) f.form = { home: recentForm(stats.gs, E.model.matched[0], 10, 'hs', 'as'), away: recentForm(stats.gs, E.model.matched[1], 10, 'hs', 'as') };
      f.facts.push(`Prolongation / tirs au but en cas d'égalité : ${Math.round(rd * 100)} % de chances après 60 min`);
    } else if (E.sport === 'nba' || E.sport === 'basket') {
      const sp = E.model.simSpec;
      const pH = SP.normCdf((sp.ph - sp.pa) / Math.sqrt(sp.sdM ** 2 + sp.sigmaM ** 2));
      f.probs = { home: pH, away: 1 - pH };
      f.expected = { home: sp.ph, away: sp.pa, total: sp.ph + sp.pa };
      f.headline = Math.abs(pH - 0.5) < 0.08 ? 'Match serré' : pH > 0.5 ? `Victoire de ${E.home} probable` : `Victoire de ${E.away} probable`;
      if (E.model.b2b?.home) f.facts.push(`${E.home} joue en back-to-back`);
      if (E.model.b2b?.away) f.facts.push(`${E.away} joue en back-to-back`);
      if (stats?.gs && E.model.matched) f.form = { home: recentForm(stats.gs, E.model.matched[0], 10, 'hs', 'as'), away: recentForm(stats.gs, E.model.matched[1], 10, 'hs', 'as') };
    } else {
      const fin = E.model.models.find((m) => m.name.startsWith('Final'))?.pA ?? E.model.models[0].pA;
      f.probs = { home: fin, away: 1 - fin };
      f.headline = Math.abs(fin - 0.5) < 0.08 ? 'Match serré' : fin > 0.5 ? `Victoire de ${E.home} probable` : `Victoire de ${E.away} probable`;
      if (E.model.pEloA != null) f.facts.push(`Elo surface : ${E.home} ${(E.model.pEloA * 100).toFixed(0)} % contre ${(fin * 100).toFixed(0)} % pour le pronostic final`);
      f.facts.push(`Surface : ${E.model.ctx.surface}${E.model.ctx.surfaceVerified ? '' : ' (non vérifiée)'}`);
      const sim = E.sim?.marginHist ? E.sim : E.qsim;
      if (sim?.marginHist) {
        const C = cfg();
        f.markets = SP.tennisMarkets(sim, E.model.simSpec, E.home, E.away).map((m) => {
          const fair = 1 / Math.max(1e-6, m.p);
          let real = null;
          const s = E.mk.sels.find((x) => !x.noTarget && ((m.type === 'tOver' && x.mkey === 'totals' && x.type === 'over' && x.point === m.point) || (m.type === 'tUnder' && x.mkey === 'totals' && x.type === 'under' && x.point === m.point)
            || (m.type === 'spread' && x.mkey === 'spreads' && x.point === m.point && ((m.side === 'A') === (x.name === E.home)))));
          if (s) real = { odds: s.best.price, book: s.best.title, last: s.best.last };
          return { ...m, pPush: 0, fair, minSafe: Math.ceil(fair * (1 + C.safeTolEV) * 100) / 100, minValue: Math.ceil(fair * (1 + C.minEV) * 100) / 100, real, ev: real ? m.p * real.odds - 1 : null, tennisCalc: true };
        });
      }
    }
    f.facts.push(...E.warnings);
    // pari conseillé : le plus probable parmi ceux proposés par le bookmaker cible, avec une cote ≥ 1,30
    const pool = cands.filter((c) => !c.s.noTarget && !c.anomaly && c.best.price >= 1.2 && c.best.price <= 3.5 && c.p != null);
    pool.sort((a, b) => b.p - a.p);
    const c = pool[0];
    if (c) f.pick = { label: c.s.label, type: c.s.type, point: c.s.point, market: c.s.mkey, odds: c.best.price, book: c.best.title, p: c.p, pPush: c.pPush, ev: c.ev, value: c.check.ok, fair: c.fairMkt };
    const dq = E.model.dataQuality ?? 0.4;
    const gap = cands.find((x) => x === c)?.modelGap;
    f.confidence = c ? (c.conf || confOf(E, c.p, gap, c.uncert)) : 'faible';
    f.dataNote = E.model.statsNote;
    // raison pour laquelle ce pronostic ne peut pas devenir le pronostic du jour (affichée dans la liste)
    if (c) f.excluded = gap != null && gap > 0.12 ? 'désaccord important entre modèles et marché'
      : c.ev < -0.08 ? 'cote Winamax trop basse par rapport à la vraie valeur'
      : c.best.price > 2.2 ? 'cote trop haute pour un pronostic principal'
      : E.staleOdds ? 'cotes non actualisées' : null;
    return f;
  }
  function tennisSel(E, s) {
    if (s.mkey === 'h2h') return { type: s.name === E.home ? 'tennisA' : 'tennisB' };
    if (s.mkey === 'totals') return { type: s.type === 'over' ? 'tOver' : 'tUnder', point: s.point };
    if (s.mkey === 'spreads') return { type: 'spread', side: s.name === E.home ? 'A' : 'B', point: s.point };
    return null;
  }
  function llmPayload(c) {
    const src = [];
    (c.E.news || []).forEach((n) => src.push({ id: `S${src.length + 1}`, type: 'actualité', titre: n.title, resume: n.desc, publie: n.published, source: n.source }));
    for (const i of c.E.info) {
      if (i.kind === 'blessures') src.push({ id: `S${src.length + 1}`, type: 'rapport blessures officiel', equipe: i.team, out: i.out.map((p) => `${p.player} (${p.detail})`), incertains: i.unsure.map((p) => `${p.player} : ${p.status}`), source: i.source });
      if (i.kind === 'composition') src.push({ id: `S${src.length + 1}`, type: 'composition', statut: i.note, source: i.source });
    }
    return {
      match: `${c.E.home} vs ${c.E.away}`, competition: c.E.comp, debut: new Date(c.E.t).toISOString(), sport: c.E.sport,
      selection: c.s.label, cote: c.best.price, probabilite_modele: +c.p.toFixed(4), probabilite_marche: c.pMkt != null ? +c.pMkt.toFixed(4) : null,
      facteurs_statistiques: c.E.model.statsNote, avertissements: c.E.warnings, sources: src,
    };
  }
  function pack(c, cat) {
    const E = c.E;
    return {
      pid: `${E.id}|${c.s.id}|${Date.now()}`, cat, sport: E.sport, comp: E.comp, match: `${E.home} – ${E.away}`, home: E.home, away: E.away,
      eventId: E.id, sportKey: E.sportKey, t: E.t, day: E.day, market: c.s.mkey, selId: c.s.id, label: c.s.label, type: c.s.type, point: c.s.point, side: c.s.name,
      odds: c.best.price, book: c.best.title, bookKey: c.best.book, oddsAt: c.best.last, second: c.second?.price || null,
      p: c.p, pPush: c.pPush, pImplied: 1 / c.best.price, pMkt: c.pMkt, pStats: c.pStats, fairSource: c.s.fairSource,
      ev: c.ev, edge: c.edge, uncert: c.uncert, modelGap: c.modelGap, sims: c.simN, ci: c.simCI,
      score: c.q.total, scoreParts: c.q.parts, conf: c.conf, reliability: c.rel, uncParts: c.uncParts, priceEdge: c.priceEdge, reasons: c.check.reasons, warnings: c.check.warn,
      scenarios: E.sim?.scenarios || null, models: E.model.models, statsNote: E.model.statsNote, ctx: E.model.ctx || null,
      info: E.info, news: E.news || [], llm: c.llm || null, llmError: c.llmError || null,
      offers: c.s.offers.slice(0, 8).map((o) => ({ title: o.title, price: o.price, last: o.last })), bestAny: c.s.bestAny ? { title: c.s.bestAny.title, price: c.s.bestAny.price } : null,
      seed: E.sim?.seed ?? null, engine: SP.version, wMarket: cfg().wMarket,
    };
  }
  function slimEvent(E) {
    return {
      id: E.id, sport: E.sport, sportKey: E.sportKey, comp: E.comp, home: E.home, away: E.away, t: E.t, day: E.day, skip: E.skip || null,
      statsNote: E.model?.statsNote || null, models: E.model?.models || null, ctx: E.model?.ctx || null, warnings: E.warnings, info: E.info, news: E.news || [],
      sims: E.sim ? { n: E.sim.n, ms: E.sim.ms, scenarios: E.sim.scenarios, key: E.sim.key } : null, spec: E.model?.simSpec || null, wSource: E.model?.wSource || null, forecast: E.forecast || null,
      sels: E.mk.sels.map((s) => ({
        id: s.id, mkey: s.mkey, label: s.label, best: s.noTarget ? null : s.best.price, book: s.noTarget ? 'non proposé par le bookmaker cible' : s.best.title, anyBest: s.bestAny?.price ?? s.best.price, last: s.best.last, nBooks: s.nBooks, mean: s.mean, pin: s.pinnacle,
        fair: s.fairMkt, p: (s.p2 || s.p1)?.pWin ?? null, ev: (s.p2 || s.p1)?.ev ?? null, deep: !!s.p2,
      })),
    };
  }
  function finish(A, ui) {
    A.finishedAt = A.finishedAt || Date.now();
    SPStore.saveAnalysis(A);
    ui.onDone && ui.onDone(A);
    return A;
  }
  function hashSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const fmtInt = (n) => new Intl.NumberFormat('fr-FR').format(n);

  return { run, cfg, saveCfg, DEFAULT_CFG, SP, tennisContext, runSims, isDefault, isWanted };
})();
