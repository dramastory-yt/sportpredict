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
    wMarket: 0.65, minEV: 0.02, minOdds: 1.20, maxOdds: 3.5, prefLo: 1.40, prefHi: 2.20,
    bankroll: 100, kellyFrac: 0.25, maxStakePct: 0.02, mode: 'sûr', safeMinP: 0.70, safeMaxOdds: 1.70, safeTolEV: -0.03, safeStakePct: 0.02, maxOddsAgeMin: 45, maxGap: 0.10, maxSims: 1000000, minSims: 100000, tol: 0.0015, phase2Events: 14,
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

  // ------------------------------------------------------------ marchés
  function buildMarkets(ev) {
    const mk = { h2h: new Map(), totals: new Map(), spreads: new Map() };
    let sharp = null;
    for (const b of ev.bookmakers || []) {
      for (const m of b.markets || []) {
        if (!mk[m.key]) continue;
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
          if (!mk[m.key].has(g)) mk[m.key].set(g, { line: g, books: [] });
          mk[m.key].get(g).books.push({ book: b.key, title: b.title, last: Date.parse(m.last_update || b.last_update), outs });
        }
      }
      if (b.key === 'pinnacle' || (b.key === 'betfair_ex_eu' && !sharp)) sharp = b.key;
    }
    // sélections
    const sels = [];
    const label = (mkey, o, g) => {
      if (mkey === 'h2h') return o.name === 'Draw' ? 'Match nul' : `${o.name} gagne`;
      if (mkey === 'totals') return `${o.name === 'Over' ? 'Plus' : 'Moins'} de ${o.point}`;
      return `${o.name} ${o.point > 0 ? '+' : ''}${o.point}`;
    };
    for (const mkey of ['h2h', 'totals', 'spreads']) {
      for (const [g, grp] of mk[mkey]) {
        const names = [...new Set(grp.books.flatMap((b) => b.outs.map((o) => o.name)))];
        const nOut = mkey === 'h2h' ? (names.includes('Draw') ? 3 : 2) : 2;
        // probabilité juste par livre (marge retirée), uniquement si le livre couvre toutes les issues
        const fairByBook = [];
        for (const b of grp.books) {
          if (b.outs.length !== nOut) continue;
          const pr = SP.devig(b.outs.map((o) => o.price));
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
    const r = await D.espnResults('basketball', 'nba', seasonStart, Date.now(), 12);
    if (!r.games.length) return { ok: false, error: r.errors[0] || 'aucun résultat renvoyé par ESPN' };
    const gs = r.games.map((g) => ({ t: g.t, h: g.h, a: g.a, hs: g.hs, as: g.as })).sort((a, b) => a.t - b.t);
    await new Promise((res) => setTimeout(res, 0));
    const bt = gs.length >= 300 ? SP.nbaBacktest(gs) : null;
    const m = SP.fitNBA(gs);
    const elo = bt ? bt.elo : SP.eloRun(gs.map((g) => ({ h: g.h, a: g.a, hg: g.hs, ag: g.as })), { K: 20, home: 70 });
    return { ok: true, n: gs.length, gs, model: m, bt, elo, errors: r.errors, meta: r.meta };
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
    out.dataQuality = ls ? Math.min(1, (out.clubeloOnly ? 0.45 : 0.5) + Math.min(out.st.games[0], out.st.games[1]) / 40 + (stats?.nXG ? 0.1 : 0)) : 0.35;
    out.calib = stats?.bt && !out.clubeloOnly ? Math.max(0, (stats.bt.naive.logLoss - (stats.bt.blend?.logLoss ?? stats.bt.ensemble.logLoss)) / 0.08) : null;
    return out;
  }
  function modelNBA(E, C, stats) {
    const h2h = E.mk.sels.filter((s) => s.mkey === 'h2h');
    const pH = h2h.find((s) => s.type === 'home')?.fairMkt;
    if (pH == null) return { error: 'cotes vainqueur incomplètes' };
    const sdM = stats?.model?.sdMargin || 12.5, sdT = stats?.model?.sdTotal || 18.5;
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
    out.dataQuality = ms != null ? 0.85 : 0.4;
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
  function modelTennis(E, C, T) {
    const h2h = E.mk.sels.filter((s) => s.mkey === 'h2h');
    const sA = h2h.find((s) => s.name === E.home);
    if (!sA || sA.fairMkt == null) return { error: 'cotes vainqueur incomplètes' };
    const ctx = tennisContext(E.sportKey, E.comp);
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
      dataQuality: dq, calib,
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
    if (c.ev <= 0) reasons.push('espérance négative');
    else if (c.ev < C.minEV) reasons.push(`EV ${(c.ev * 100).toFixed(1)}% < seuil ${(C.minEV * 100).toFixed(1)}%`);
    if (c.edge < c.uncert) reasons.push(`value (${(c.edge * 100).toFixed(1)} pts) inférieure à l’incertitude (${(c.uncert * 100).toFixed(1)} pts)`);
    if (C.targetBook && c.second && c.best.price / c.second.price > 1.07) warn.push(`${c.best.title} est ${((c.best.price / c.second.price - 1) * 100).toFixed(0)} % au-dessus du bookmaker suivant : vérifiez la cote sur le site avant de parier`);
    else if (c.second && c.best.book !== 'pinnacle' && c.best.price / c.second.price > 1.07) reasons.push(`cote isolée (${c.best.title} ${c.best.price} vs ${c.second.price} ailleurs) : possible erreur ou cote obsolète`);
    if (c.modelGap != null && c.modelGap > C.maxGap) reasons.push(`divergence modèles/marché de ${(c.modelGap * 100).toFixed(1)} pts non expliquée`);
    if (c.fairMkt == null && c.sport !== 'nba') reasons.push('probabilité de marché indisponible');
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
    const active = sp.data.filter((s) => s.active);
    const keys = [];
    for (const [k, on] of Object.entries(C.leagues)) if (on && active.find((s) => s.key === k)) keys.push(k);
    if (C.nba && active.find((s) => s.key === 'basketball_nba')) keys.push('basketball_nba');
    if (C.tennis) active.filter((s) => s.group === 'Tennis' && !s.has_outrights).slice(0, C.maxTennisTournaments).forEach((s) => keys.push(s.key));
    if (opts.onlyKeys) keys.splice(0, keys.length, ...keys.filter((k) => opts.onlyKeys.has(k)));
    const titles = Object.fromEntries(active.map((s) => [s.key, s.title]));
    const hours = C.extendTo48 ? 48 : C.hours;
    let raw = [], skippedNoEvents = 0;
    for (let i = 0; i < keys.length; i++) {
      S.progress(0, i, keys.length, titles[keys[i]]);
      const evl = await D.oddsEventsList(C.oddsKey, keys[i], hours);
      if (evl.ok && Array.isArray(evl.data) && !evl.data.some((e) => Date.parse(e.commence_time) > Date.now())) { skippedNoEvents++; continue; }
      const r = await D.oddsFor(C.oddsKey, keys[i], { regions: C.regions, markets: keys[i].startsWith('tennis') ? 'h2h,totals,spreads' : C.markets, hours, ttlMin: opts.force ? 0 : 10 });
      if (!r.ok) { A.errors.push(`${titles[keys[i]]}: ${r.error}`); continue; }
      raw.push(...r.data.map((e) => ({ ...e, _fetched: r.at, _stale: !!r.stale })));
    }
    raw = raw.filter((e) => Date.parse(e.commence_time) > Date.now());
    A.counts.available = raw.length;
    A.sources.odds = { provider: 'The Odds API', regions: C.regions, at: Date.now(), remaining: D.apiStatus['The Odds API']?.remaining ?? null };
    S.done(0, `${raw.length} événements à venir (${keys.length - skippedNoEvents} compétitions interrogées, ${skippedNoEvents} sans match ignorées : crédits économisés)`);

    // ---------------- 2. statistiques
    S.start(1);
    const LD = await D.localData();
    A.sources.local = LD.meta ? { generatedAt: LD.meta.generatedAt, sources: LD.meta.sources } : null;
    const fbStats = {};
    const leaguesNeeded = [...new Set(raw.filter((e) => D.FOOTBALL[e.sport_key]?.stats).map((e) => e.sport_key))];
    let k = 0;
    for (const lk of leaguesNeeded) {
      S.progress(1, k++, leaguesNeeded.length + (C.nba ? 1 : 0), D.FOOTBALL[lk].name);
      try { fbStats[lk] = await footballStats(D.FOOTBALL[lk].espn, null, lk); } catch (e) { fbStats[lk] = { ok: false, error: String(e) }; }
      if (!fbStats[lk].ok) A.errors.push(`Stats ${D.FOOTBALL[lk].name}: ${fbStats[lk].error}`);
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
      const sport = e.sport_key.startsWith('soccer') ? 'football' : e.sport_key === 'basketball_nba' ? 'nba' : 'tennis';
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
    const feeds = [...new Set(events.map((E) => E.sport === 'football' ? `soccer|${D.FOOTBALL[E.sportKey]?.espn}` : E.sport === 'nba' ? 'basketball|nba' : (/wta/.test(E.sportKey) ? 'tennis|wta' : 'tennis|atp')))].filter((f) => !f.endsWith('undefined'));
    for (let i = 0; i < feeds.length; i++) {
      S.progress(4, i, feeds.length, feeds[i]);
      const [s, l] = feeds[i].split('|');
      const r = await D.espnNews(s, l);
      newsBy[feeds[i]] = r.ok ? r.items : [];
      if (!r.ok) A.errors.push(`Actualités ${l} : ${r.error}`);
    }
    for (const E of events) {
      const f = E.sport === 'football' ? `soccer|${D.FOOTBALL[E.sportKey]?.espn}` : E.sport === 'nba' ? 'basketball|nba' : (/wta/.test(E.sportKey) ? 'tennis|wta' : 'tennis|atp');
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
      const sel = c.E.sport === 'tennis' ? tennisSel(c.E, c.s) : { type: c.s.type, point: c.s.point };
      return { spec: { ...c.E.model.simSpec, seed: hashSeed(c.E.id + c.s.id), minN: C.minSims, maxN: C.maxSims, tol: C.tol }, sel: SP.normalizeSel(sel) };
    });
    const simRes = await runSims(tasks, (d, n, sims) => S.progress(7, d, n, `${fmtInt(sims)} simulations`));
    let totalSims = 0;
    top.forEach((c, i) => {
      const r = simRes[i]; if (!r || r.error) { c.E.simError = r?.error || 'échec'; return; }
      c.E.sim = r; totalSims += r.n;
      for (const s of c.E.mk.sels) {
        const sel = c.E.sport === 'tennis' ? tennisSel(c.E, s) : { type: s.type, point: s.point };
        if (!sel || !s.p1) continue;
        const e = SP.evalFromSim(r, SP.normalizeSel(sel), s.best.price);
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
        const uncert = Math.sqrt(ci ** 2 + (s.fairSd || 0.01) ** 2 + ((modelGap || 0) / 2) ** 2);
        const sc = E.sim?.scenarios?.map((x) => x.p).filter((x) => x != null) || [];
        const keySel = top.find((c) => c.E === E)?.s === s;
        const mcSpread = keySel && sc.length ? Math.max(...sc) - Math.min(...sc) : 0.05;
        const c = {
          E, s, sport: E.sport, t: E.t, best: s.best, second: s.second, fairMkt: s.fairMkt,
          p: p.pWin, pPush: p.pPush || 0, ev: p.ev, edge: p.pWin - 1 / s.best.price, uncert, modelGap, pStats, pMkt,
          simN: s.p2?.n || 0, simCI: s.p2?.ci ?? null, mcSpread,
          booksAtPrice: s.offers.filter((o) => o.price >= s.best.price - 1e-9).length,
        };
        const riskNote = [...E.warnings, ...(E.sport === 'football' && !E.lineup ? ['compositions non publiées'] : []), ...(E.staleOdds ? ['cotes issues du cache (fournisseur indisponible)'] : [])];
        if (E.staleOdds) c.critical = 'cotes non actualisées (fournisseur indisponible)';
        c.q = SP.qualityScore({
          edge: c.edge, uncert, modelGap, dataQuality: E.model.dataQuality, dataNote: E.model.statsNote, calib: E.model.calib,
          mcSpread, oddsAgeMin: (Date.now() - s.best.last) / 60e3, booksAtPrice: c.booksAtPrice, riskPenalty: E.risk, riskNote: riskNote.join(' ; '), odds: s.best.price,
        });
        c.check = assess(c, C, E);
        scored.push(c);
      }
    }
    A.counts.scored = scored.length;
    // pronostics : pour chaque match, la lecture du moteur, même sans value
    for (const E of events) {
      if (E.skip) continue;
      try { E.forecast = forecast(E, scored.filter((c) => c.E === E), E.sport === 'football' ? fbStats[E.sportKey] : E.sport === 'nba' ? nba : null); } catch (err) { E.forecast = null; }
    }
    const confRank = { forte: 3, moyenne: 2, faible: 1 };
    A.forecasts = events.filter((E) => E.forecast && E.forecast.pick && E.t - Date.now() <= Math.max(C.hours, 24) * 3600e3)
      .sort((a, b) => confRank[b.forecast.confidence] - confRank[a.forecast.confidence] || b.forecast.pick.p - a.forecast.pick.p)
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
        if (c.s.noTarget || c.p == null || c.p < C.safeMinP) continue;
        if (c.best.price < C.minOdds || c.best.price > C.safeMaxOdds) continue;
        if (E.t <= Date.now() + 15 * 60e3 || E.t - Date.now() > Math.max(C.hours, 24) * 3600e3) continue;
        if (c.ev < C.safeTolEV || (c.modelGap != null && c.modelGap > 0.08) || E.risk >= 3 || E.staleOdds) continue;
        const tier = c.ev >= 0 ? 1 : 2;
        const cur = byEv.get(E.id);
        if (!cur || tier < cur.tier || (tier === cur.tier && c.p > cur.c.p)) byEv.set(E.id, { c, tier });
      }
      A.safe = [...byEv.values()].sort((x, y) => x.tier - y.tier || y.c.p - x.c.p).slice(0, 6).map(({ c, tier }) => ({
        tier, eventId: c.E.id, sport: c.E.sport, sportKey: c.E.sportKey, comp: c.E.comp, match: `${c.E.home} – ${c.E.away}`, home: c.E.home, away: c.E.away, t: c.E.t,
        label: c.s.label, type: c.s.type, point: c.s.point, market: c.s.mkey, odds: c.best.price, book: c.best.title, p: c.p, pPush: c.pPush, ev: c.ev, value: c.check.ok, fair: c.fairMkt,
      }));
    }
    // PRONOSTIC DU JOUR : toujours un seul choix.
    //  - mode « sûr » (défaut) : le meilleur pari sûr ; à défaut, le meilleur pari value ;
    //  - mode « value » : le meilleur pari value ; à défaut, le pari le plus probable.
    {
      const rank = { forte: 3, moyenne: 2, faible: 1 };
      const pool = events.filter((E) => E.forecast?.pick && E.t - Date.now() <= Math.max(C.hours, 24) * 3600e3 && E.t > Date.now() + 15 * 60e3 && E.forecast.pick.ev >= -0.06);
      let E = null, pick = null, kind = null;
      const s0 = A.safe[0];
      const fromBest = () => { E = events.find((x) => x.id === A.best.eventId); pick = { label: A.best.label, type: A.best.type, point: A.best.point, market: A.best.market, odds: A.best.odds, book: A.best.book, p: A.best.p, pPush: A.best.pPush, ev: A.best.ev, value: true, fair: A.best.pMkt }; kind = 'value'; };
      if (C.mode !== 'value' && s0) { E = events.find((x) => x.id === s0.eventId); pick = s0; kind = s0.tier === 1 ? 'sûr' : 'sûr-bas'; }
      else if (A.best) fromBest();
      else { E = pool.sort((a, b) => rank[b.forecast.confidence] - rank[a.forecast.confidence] || b.forecast.pick.p - a.forecast.pick.p)[0] || null; pick = E?.forecast.pick; kind = 'probable'; }
      if (E && pick && E.forecast) {
        const f = E.forecast;
        const why = [];
        why.push(`${f.headline} : ${E.sport === 'football' ? `1 ${(f.probs.home * 100).toFixed(0)} % · N ${(f.probs.draw * 100).toFixed(0)} % · 2 ${(f.probs.away * 100).toFixed(0)} %` : `${E.home} ${(f.probs.home * 100).toFixed(0)} % · ${E.away} ${(f.probs.away * 100).toFixed(0)} %`}.`);
        if (E.sport === 'football') why.push(`Buts attendus ${f.expected.home.toFixed(2)} – ${f.expected.away.toFixed(2)}, score le plus probable ${f.score.h}-${f.score.a}.`);
        if (E.sport === 'nba') why.push(`Score projeté ${Math.round(f.expected.home)}-${Math.round(f.expected.away)} (total ${f.expected.total.toFixed(1)}).`);
        if (f.form?.home && f.form?.away) why.push(`Forme récente : ${E.home} ${f.form.home.seq}, ${E.away} ${f.form.away.seq} (du plus ancien au plus récent).`);
        const sc = scored.find((c) => c.E === E && c.s.label === pick.label);
        if (sc?.pStats != null && sc?.pMkt != null) why.push(`Modèles statistiques ${(sc.pStats * 100).toFixed(0)} % contre ${(sc.pMkt * 100).toFixed(0)} % pour le marché sans marge : ${Math.abs(sc.pStats - sc.pMkt) < 0.05 ? 'ils sont d’accord' : 'léger désaccord, prudence'}.`);
        why.push(kind === 'sûr' ? `Pari sûr : ${(pick.p * 100).toFixed(0)} % de chances selon l’analyse, et la cote ${pick.odds.toFixed(2)} est au moins égale à sa vraie valeur (${(1 / pick.p).toFixed(2)}).`
          : kind === 'sûr-bas' ? `Pari sûr : ${(pick.p * 100).toFixed(0)} % de chances, mais la cote ${pick.odds.toFixed(2)} est un peu sous sa vraie valeur (${(1 / pick.p).toFixed(2)}) : mise réduite.`
          : kind === 'value' ? `La cote ${pick.odds.toFixed(2)} est supérieure à la cote juste (${(1 / pick.p).toFixed(2)}) : pari rentable sur la durée selon le modèle.`
          : `La cote ${pick.odds.toFixed(2)} est sous la cote juste (${(1 / pick.p).toFixed(2)}) : pronostic probable mais sans value, mise réduite conseillée.`);
        A.daily = { kind, eventId: E.id, sport: E.sport, sportKey: E.sportKey, comp: E.comp, match: `${E.home} – ${E.away}`, home: E.home, away: E.away, t: E.t, day: E.day, confidence: f.confidence, headline: f.headline, pick, why, warnings: E.warnings, dataNote: f.dataNote };
      } else A.daily = null;
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
      const top = Math.max(ph, pd, pa);
      f.headline = top < 0.42 ? 'Match très ouvert' : ph === top ? `Victoire de ${E.home} probable` : pa === top ? `Victoire de ${E.away} probable` : 'Match nul probable';
      if (stats?.ms && E.model.st?.match) {
        const [mh, ma] = E.model.st.match.map((m) => m.name);
        f.form = { home: recentForm(stats.ms, mh, 5, 'hg', 'ag'), away: recentForm(stats.ms, ma, 5, 'hg', 'ag') };
      }
    } else if (E.sport === 'nba') {
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
    }
    f.facts.push(...E.warnings);
    // pari conseillé : le plus probable parmi ceux proposés par le bookmaker cible, avec une cote ≥ 1,30
    const pool = cands.filter((c) => !c.s.noTarget && c.best.price >= 1.2 && c.best.price <= 3.5 && c.p != null);
    pool.sort((a, b) => b.p - a.p);
    const c = pool[0];
    if (c) f.pick = { label: c.s.label, type: c.s.type, point: c.s.point, market: c.s.mkey, odds: c.best.price, book: c.best.title, p: c.p, pPush: c.pPush, ev: c.ev, value: c.check.ok, fair: c.fairMkt };
    const dq = E.model.dataQuality ?? 0.4;
    const gap = cands.find((x) => x === c)?.modelGap;
    f.confidence = c && c.p >= 0.65 && dq >= 0.6 && (gap == null || gap <= 0.05) ? 'forte' : c && c.p >= 0.55 && dq >= 0.4 ? 'moyenne' : 'faible';
    f.dataNote = E.model.statsNote;
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
      score: c.q.total, scoreParts: c.q.parts, reasons: c.check.reasons, warnings: c.check.warn,
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

  return { run, cfg, saveCfg, DEFAULT_CFG, SP, tennisContext, runSims };
})();
