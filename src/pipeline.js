/* SportPredict AI — pipeline d'analyse (phase 1 présélection, phase 2 approfondie). */
const SPPipeline = (() => {
  const SP = SPEngineFactory();
  const D = SPData;
  const DAY = 86400e3;

  // ------------------------------------------------------------ configuration
  const DEFAULT_CFG = {
    oddsKey: '', claudeKey: '', regions: 'eu', markets: 'h2h,totals,spreads',
    leagues: Object.fromEntries(Object.entries(D.FOOTBALL).map(([k, v]) => [k, v.on])),
    tennis: true, nba: true, maxTennisTournaments: 4,
    wMarket: 0.65, minEV: 0.02, minOdds: 1.20, maxOdds: 3.5, prefLo: 1.40, prefHi: 2.20,
    maxOddsAgeMin: 45, maxGap: 0.10, maxSims: 1000000, minSims: 100000, tol: 0.0015, phase2Events: 14,
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
      if (b.key === 'pinnacle') sharp = 'pinnacle';
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
          const pin = fairByBook.find((f) => f.book === 'pinnacle');
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
            fairMkt: fair, fairSource: pin ? 'Pinnacle (marge retirée)' : (fps.length ? `consensus de ${fps.length} bookmakers (médiane, marge retirée)` : 'indisponible'),
            fairSd: SP.sd(fps), nBooks: offers.length,
            pinnacle: offers.find((x) => x.book === 'pinnacle')?.price || null,
          });
        }
      }
    }
    return { sels, sharp, nBooks: (ev.bookmakers || []).length };
  }

  // ------------------------------------------------------------ données statistiques
  async function footballStats(espnLeague, step) {
    const seasonStart = Date.UTC(new Date().getUTCFullYear() - (new Date().getUTCMonth() < 6 ? 2 : 1), 6, 15);
    const r = await D.espnResults('soccer', espnLeague, seasonStart, Date.now(), 45);
    if (!r.games.length) return { ok: false, error: r.errors[0] || 'aucun résultat renvoyé par ESPN' };
    const ms = r.games.map((g) => ({ t: g.t, h: g.h, a: g.a, hg: g.hs, ag: g.as })).sort((a, b) => a.t - b.t);
    await new Promise((res) => setTimeout(res, 0));
    const bt = ms.length >= 120 ? SP.footballBacktest(ms) : null;
    const dc = SP.fitDixonColes(ms);
    step && step.note(`${espnLeague}: ${ms.length} matchs`);
    return { ok: true, n: ms.length, ms, dc, bt, errors: r.errors, meta: r.meta, last: ms[ms.length - 1]?.t };
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
  function modelFootball(E, C, stats) {
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
          const w = stats.bt.weights;
          pst = [0, 1, 2].map((i) => w.dc * pdc[i] + w.elo * pel[i]);
          out.models.push({ name: `Ensemble stats (poids backtest DC ${w.dc.toFixed(2)} / Elo ${w.elo.toFixed(2)})`, p1x2: pst });
        }
        // λ stats : cohérents avec l'ensemble 1X2 et le total de Dixon-Coles
        const mDC = SP.scoreMatrix(lam.lh, lam.la, stats.dc.rho);
        ls = SP.impliedLambdas(pst, { line: 2.5, p: SP.matrixOver(mDC, 2.5) });
        out.st = { ...ls, p1x2: pst, match: [mh, ma], games: [stats.dc.games[mh.name], stats.dc.games[ma.name]] };
        statsNote = `${stats.n} matchs ESPN, appariement ${(Math.min(mh.score, ma.score) * 100).toFixed(0)}%`;
      } else statsNote = `équipe(s) non appariée(s) dans les données ESPN (${E.home} / ${E.away})`;
    }
    out.statsNote = statsNote;
    const w = C.wMarket;
    const lh = ls ? Math.exp(w * Math.log(lm.lh) + (1 - w) * Math.log(ls.lh)) : lm.lh;
    const la = ls ? Math.exp(w * Math.log(lm.la) + (1 - w) * Math.log(ls.la)) : lm.la;
    const gap = ls ? (Math.abs(Math.log(ls.lh / lm.lh)) + Math.abs(Math.log(ls.la / lm.la))) / 2 : 0;
    const sigma = Math.sqrt(0.06 ** 2 + (gap / 2) ** 2) + (ls ? 0 : 0.03);
    out.final = { lh, la, rho: stats?.dc?.rho ?? -0.05, sigma };
    const matF = SP.scoreMatrix(lh, la, out.final.rho), matM = SP.scoreMatrix(lm.lh, lm.la, -0.05), matS = ls ? SP.scoreMatrix(ls.lh, ls.la, stats.dc.rho) : null;
    out.models.push({ name: `Final (marché ${w} / stats ${(1 - w).toFixed(2)})`, p1x2: SP.matrix1x2(matF), lh, la });
    out.phase1 = (sel) => {
      const pf = selProbFromMatrix(matF, sel);
      const pm = sel.fairMkt != null && sel.mkey !== 'spreads' ? sel.fairMkt : selProbFromMatrix(matM, sel).pWin;
      const ps = matS ? selProbFromMatrix(matS, sel).pWin : null;
      return { pWin: pf.pWin, pPush: pf.pPush, ev: pf.ev, pMkt: pm, pStats: ps };
    };
    out.simSpec = { kind: 'football', lh, la, rho: out.final.rho, sigma };
    out.dataQuality = ls ? Math.min(1, 0.5 + Math.min(out.st.games[0], out.st.games[1]) / 40) : 0.35;
    out.calib = stats?.bt ? Math.max(0, (stats.bt.naive.logLoss - stats.bt.ensemble.logLoss) / 0.08) : null;
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
        out.statsNote = `${stats.n} matchs ESPN, appariement ${(Math.min(mh.score, ma.score) * 100).toFixed(0)}%`;
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
  function modelTennis(E) {
    const h2h = E.mk.sels.filter((s) => s.mkey === 'h2h');
    const sA = h2h.find((s) => s.name === E.home);
    if (!sA || sA.fairMkt == null) return { error: 'cotes vainqueur incomplètes' };
    const ctx = tennisContext(E.sportKey, E.comp);
    const sv = SP.tennisSolveServe(sA.fairMkt, ctx.base, ctx.bestOf);
    const sigmaD = Math.max(0.004, (sA.fairSd || 0.01) / 9);
    const out = {
      ctx, models: [{ name: 'Marché (marge retirée)', pA: sA.fairMkt }, { name: `Service implicite (${ctx.tour}, ${ctx.surface}, BO${ctx.bestOf})`, serveA: sv.pa, serveB: sv.pb }],
      statsNote: 'modèle unique dérivé du marché : Elo surface et statistiques de service non disponibles via une source gratuite accessible',
      simSpec: { kind: 'tennis', pa: sv.pa, pb: sv.pb, sigmaD, bestOf: ctx.bestOf },
      dataQuality: ctx.surfaceVerified ? 0.4 : 0.3, calib: null,
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
    if (c.second && c.best.book !== 'pinnacle' && c.best.price / c.second.price > 1.07) reasons.push(`cote isolée (${c.best.title} ${c.best.price} vs ${c.second.price} ailleurs) : possible erreur ou cote obsolète`);
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
    let raw = [];
    for (let i = 0; i < keys.length; i++) {
      S.progress(0, i, keys.length, titles[keys[i]]);
      const r = await D.oddsFor(C.oddsKey, keys[i], { regions: C.regions, markets: keys[i].startsWith('tennis') ? 'h2h,totals,spreads' : C.markets, hours, ttlMin: opts.force ? 0 : 10 });
      if (!r.ok) { A.errors.push(`${titles[keys[i]]}: ${r.error}`); continue; }
      raw.push(...r.data.map((e) => ({ ...e, _fetched: r.at, _stale: !!r.stale })));
    }
    raw = raw.filter((e) => Date.parse(e.commence_time) > Date.now());
    A.counts.available = raw.length;
    A.sources.odds = { provider: 'The Odds API', regions: C.regions, at: Date.now(), remaining: D.apiStatus['The Odds API']?.remaining ?? null };
    S.done(0, `${raw.length} événements à venir (${keys.length} compétitions)`);

    // ---------------- 2. statistiques
    S.start(1);
    const fbStats = {};
    const leaguesNeeded = [...new Set(raw.filter((e) => D.FOOTBALL[e.sport_key]?.stats).map((e) => e.sport_key))];
    let k = 0;
    for (const lk of leaguesNeeded) {
      S.progress(1, k++, leaguesNeeded.length + (C.nba ? 1 : 0), D.FOOTBALL[lk].name);
      try { fbStats[lk] = await footballStats(D.FOOTBALL[lk].espn); } catch (e) { fbStats[lk] = { ok: false, error: String(e) }; }
      if (!fbStats[lk].ok) A.errors.push(`Stats ${D.FOOTBALL[lk].name}: ${fbStats[lk].error}`);
    }
    let nba = null;
    if (raw.some((e) => e.sport_key === 'basketball_nba')) {
      S.progress(1, k, leaguesNeeded.length + 1, 'NBA');
      try { nba = await nbaStats(); } catch (e) { nba = { ok: false, error: String(e) }; }
      if (!nba.ok) A.errors.push('Stats NBA : ' + nba.error);
    }
    A.backtests = {
      ...Object.fromEntries(Object.entries(fbStats).filter(([, v]) => v.ok && v.bt).map(([kk, v]) => [D.FOOTBALL[kk].name, { n: v.bt.n, models: v.bt.models, ensemble: v.bt.ensemble, naive: v.bt.naive, weights: v.bt.weights, calibration: v.bt.calibration }])),
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
        mk: buildMarkets(e), info: [], warnings: [], risk: 0,
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
    S.done(5, `${nMarkets} sélections comparées sur ${events.reduce((s, E) => s + E.mk.nBooks, 0)} offres bookmakers ; Pinnacle présent sur ${withSharp}/${events.length} événements`);

    // ---------------- 7. modèles (phase 1 : présélection)
    S.start(6);
    const cands = [];
    const quickTennis = [];
    for (const E of events) {
      let M;
      try {
        if (E.sport === 'football') M = modelFootball(E, C, fbStats[E.sportKey]);
        else if (E.sport === 'nba') M = modelNBA(E, C, nba);
        else M = modelTennis(E);
      } catch (err) { M = { error: String(err) }; }
      E.model = M;
      if (M.error) { E.skip = M.error; continue; }
      if (E.sport === 'tennis') quickTennis.push(E);
      else {
        for (const s of E.mk.sels) {
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
          const sel = tennisSel(E, s); if (!sel) continue;
          const r = SP.evalFromSim(simr, SP.normalizeSel(sel), s.best.price);
          s.p1 = tennisBlend(s, r, C);
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
        s.p2 = c.E.sport === 'tennis' ? { ...tennisBlend(s, e, C), ci: e.ci95, n: r.n } : { pWin: e.pWin, pPush: e.pPush, ev: e.ev, ci: e.ci95, n: r.n };
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
        const p = s.p2 || s.p1; if (!p) continue;
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
    A.events = events.map(slimEvent);
    A.finishedAt = Date.now();
    S.done(9, A.best ? `meilleur pari : ${A.best.match} — ${A.best.label}` : 'aucun pari validé', false);
    return finish(A, ui);
  }

  // Tennis : le modèle jeu par jeu repose sur une hypothèse de taux de service moyen du circuit.
  // Pour les totaux/handicaps, il est combiné au prix juste du marché et l'écart est soumis à la règle de divergence.
  function tennisBlend(s, r, C) {
    const pm = r.pWin;
    const useMkt = s.mkey !== 'h2h' && s.fairMkt != null;
    const p = useMkt ? C.wMarket * s.fairMkt + (1 - C.wMarket) * pm : pm;
    return { pWin: p, pPush: r.pPush, ev: p * s.best.price + r.pPush - 1, pMkt: s.fairMkt, pStats: s.mkey !== 'h2h' ? pm : null };
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
      offers: c.s.offers.slice(0, 8).map((o) => ({ title: o.title, price: o.price, last: o.last })),
      seed: E.sim?.seed ?? null, engine: SP.version, wMarket: cfg().wMarket,
    };
  }
  function slimEvent(E) {
    return {
      id: E.id, sport: E.sport, sportKey: E.sportKey, comp: E.comp, home: E.home, away: E.away, t: E.t, day: E.day, skip: E.skip || null,
      statsNote: E.model?.statsNote || null, models: E.model?.models || null, ctx: E.model?.ctx || null, warnings: E.warnings, info: E.info, news: E.news || [],
      sims: E.sim ? { n: E.sim.n, ms: E.sim.ms, scenarios: E.sim.scenarios, key: E.sim.key } : null,
      sels: E.mk.sels.map((s) => ({
        id: s.id, mkey: s.mkey, label: s.label, best: s.best.price, book: s.best.title, last: s.best.last, nBooks: s.nBooks, mean: s.mean, pin: s.pinnacle,
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

  return { run, cfg, saveCfg, DEFAULT_CFG, SP, tennisContext };
})();
