/* SportPredict AI — historique immuable, résultats, CLV et performance. */
const SPStore = (() => {
  const D = SPData;
  const K = { analyses: 'sp:analyses', picks: 'sp:picks', results: 'sp:results', clv: 'sp:clv' };
  const get = (k, d) => D.LS.get(k, d);

  function saveAnalysis(A) {
    // conserve les 30 dernières analyses détaillées (l'événementiel complet est volumineux)
    const list = get(K.analyses, []);
    list.push(A);
    while (list.length > 30) list.shift();
    if (!D.LS.set(K.analyses, list)) { // stockage plein : on allège les plus anciennes
      list.forEach((a, i) => { if (i < list.length - 3) a.events = []; });
      D.LS.set(K.analyses, list);
    }
    // publication : les pronostics publiés ne sont jamais modifiés ensuite
    const picks = get(K.picks, []);
    const pub = [A.best, ...A.values].filter(Boolean).map((p) => ({ ...p, analysisId: A.id, parentId: A.parentId, publishedAt: A.finishedAt }));
    for (const p of pub) {
      // version : nombre de publications antérieures sur la même sélection du même événement
      p.version = picks.filter((x) => x.eventId === p.eventId && x.selId === p.selId).length + 1;
      picks.push(p);
    }
    D.LS.set(K.picks, picks);
    return pub;
  }
  const analyses = () => get(K.analyses, []);
  const lastAnalysis = () => { const a = analyses(); return a[a.length - 1] || null; };
  const picks = () => get(K.picks, []);
  const results = () => get(K.results, {});
  const clv = () => get(K.clv, {});

  // Résultat : enregistré à part, le pronostic publié reste intact.
  function setResult(pid, r) {
    const all = results();
    if (all[pid] && !r.overwrite) return false;
    all[pid] = { ...r, at: Date.now() };
    D.LS.set(K.results, all);
    return true;
  }
  function recordCLV(pid, data) {
    const all = clv();
    all[pid] = { ...(all[pid] || {}), last: { ...data, at: Date.now() } };
    D.LS.set(K.clv, all);
  }

  // Règlement d'un pari à partir du score final.
  function settle(p, hs, as) {
    const SP = SPPipeline.SP;
    let sel;
    if (p.sport === 'tennis') return null;
    sel = SP.normalizeSel({ type: p.type, point: p.point });
    const sh = SP.settleShares(SP.selMargin(sel, hs, as), sel.line);
    const profit = sh.win * (p.odds - 1) - (1 - sh.win - sh.push);
    const status = sh.win === 1 ? 'gagné' : sh.push === 1 ? 'remboursé' : sh.win === 0.5 ? 'demi-gagné' : (sh.push === 0.5 ? 'demi-perdu' : 'perdu');
    return { status, profit, score: `${hs}-${as}`, win: sh.win, push: sh.push };
  }
  async function autoSettle() {
    const pend = picks().filter((p) => !results()[p.pid] && p.t < Date.now() - 2.5 * 3600e3 && p.sport !== 'tennis');
    let n = 0;
    const groups = new Map();
    for (const p of pend) {
      const lg = p.sport === 'nba' ? ['basketball', 'nba'] : ['soccer', D.FOOTBALL[p.sportKey]?.espn];
      if (!lg[1]) continue;
      const key = lg.join('|') + '|' + new Date(p.t).toISOString().slice(0, 10);
      if (!groups.has(key)) groups.set(key, { lg, t: p.t, list: [] });
      groups.get(key).list.push(p);
    }
    for (const g of groups.values()) {
      const sb = await D.espnScoreboard(g.lg[0], g.lg[1], g.t - 86400e3, g.t + 86400e3);
      if (!sb.ok) continue;
      for (const p of g.list) {
        const ev = sb.events.find((x) => x.completed && D.sim(x.h, p.home) >= 0.5 && D.sim(x.a, p.away) >= 0.5 && Math.abs(x.t - p.t) < 36 * 3600e3);
        if (!ev) continue;
        const r = settle(p, ev.hs, ev.as);
        if (r && setResult(p.pid, { ...r, source: 'ESPN scoreboard (automatique)', espnId: ev.id })) n++;
      }
    }
    return n;
  }

  // Performance : mise fixe d'une unité par pronostic publié.
  function perf(days) {
    const R = results(), CL = clv();
    const since = days ? Date.now() - days * 86400e3 : 0;
    const ps = picks().filter((p) => p.publishedAt >= since);
    const settled = ps.filter((p) => R[p.pid] && R[p.pid].status !== 'annulé');
    const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
    const profit = sum(settled, (p) => R[p.pid].profit);
    const wins = settled.filter((p) => R[p.pid].win > 0).length;
    const bin = settled.filter((p) => R[p.pid].push === 0 && (R[p.pid].win === 0 || R[p.pid].win === 1));
    const brier = bin.length ? sum(bin, (p) => (p.p - R[p.pid].win) ** 2) / bin.length : null;
    const logloss = bin.length ? sum(bin, (p) => -Math.log(Math.max(1e-9, R[p.pid].win ? p.p : 1 - p.p))) / bin.length : null;
    const brierMkt = bin.filter((p) => p.pMkt != null).length ? sum(bin.filter((p) => p.pMkt != null), (p) => (p.pMkt - R[p.pid].win) ** 2) / bin.filter((p) => p.pMkt != null).length : null;
    const clvs = ps.map((p) => CL[p.pid]?.last).filter((x) => x && x.fair);
    const clvAvg = clvs.length ? sum(ps.filter((p) => CL[p.pid]?.last?.fair), (p) => p.odds * CL[p.pid].last.fair - 1) / clvs.length : null;
    const group = (f) => {
      const m = {};
      for (const p of settled) { const k = f(p); m[k] = m[k] || { n: 0, profit: 0, wins: 0 }; m[k].n++; m[k].profit += R[p.pid].profit; m[k].wins += R[p.pid].win > 0 ? 1 : 0; }
      return m;
    };
    const curve = []; let cum = 0;
    for (const p of [...settled].sort((a, b) => a.t - b.t)) { cum += R[p.pid].profit; curve.push({ t: p.t, v: cum }); }
    // poids du marché suggéré (non appliqué automatiquement) : minimise la log-loss sur l'historique
    const both = bin.filter((p) => p.pMkt != null && p.pStats != null);
    let wSuggest = null;
    if (both.length >= 50) {
      let best = null;
      for (let w = 0; w <= 1.0001; w += 0.05) {
        const ll = sum(both, (p) => { const q = w * p.pMkt + (1 - w) * p.pStats; return -Math.log(Math.max(1e-9, R[p.pid].win ? q : 1 - q)); });
        if (!best || ll < best.ll) best = { ll, w: Math.round(w * 100) / 100 };
      }
      wSuggest = { ...best, n: both.length };
    }
    return {
      n: ps.length, settled: settled.length, pending: ps.length - settled.length, wins, hit: settled.length ? wins / settled.length : null,
      profit, yield: settled.length ? profit / settled.length : null, roiBank: profit / 100, avgOdds: settled.length ? sum(settled, (p) => p.odds) / settled.length : null,
      brier, logloss, brierMkt, clv: clvAvg, nClv: clvs.length,
      bySport: group((p) => p.sport), byMarket: group((p) => p.market), byMonth: group((p) => new Date(p.t).toISOString().slice(0, 7)),
      curve, calibration: SPPipeline.SP.calibrationBins(bin.map((p) => p.p), bin.map((p) => R[p.pid].win)), wSuggest,
    };
  }

  function exportAll() {
    return JSON.stringify({ format: 'sportpredict-v1', exportedAt: new Date().toISOString(), analyses: analyses(), picks: picks(), results: results(), clv: clv(), mybets: D.LS.get('sp:mybets', []), bank: D.LS.get('sp:bank', null) });
  }
  function importAll(txt) {
    const d = JSON.parse(txt);
    if (d.format !== 'sportpredict-v1') throw new Error('format de fichier inconnu');
    // fusion sans écrasement des pronostics existants
    const have = new Set(picks().map((p) => p.pid));
    D.LS.set(K.picks, [...picks(), ...d.picks.filter((p) => !have.has(p.pid))]);
    D.LS.set(K.results, { ...d.results, ...results() });
    D.LS.set(K.clv, { ...d.clv, ...clv() });
    if (d.mybets) { const mine = D.LS.get('sp:mybets', []); const ids = new Set(mine.map((b) => b.id)); D.LS.set('sp:mybets', [...mine, ...d.mybets.filter((b) => !ids.has(b.id))]); }
    if (d.bank && !D.LS.get('sp:bank', null)) D.LS.set('sp:bank', d.bank);
    const ha = new Set(analyses().map((a) => a.id));
    D.LS.set(K.analyses, [...d.analyses.filter((a) => !ha.has(a.id)).map((a) => ({ ...a, events: [] })), ...analyses()].slice(-30));
  }
  return { saveAnalysis, analyses, lastAnalysis, picks, results, clv, setResult, recordCLV, autoSettle, perf, exportAll, importAll, settle };
})();
