/* SportPredict AI — gestion des crédits The Odds API (budget mensuel, coût réel, cache, alertes). */
const SPCredits = (() => {
  const KEY = 'sp:credits';
  const month = () => new Date().toISOString().slice(0, 7);
  const LSget = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); return v && v.month === month() ? v : { month: month(), calls: [], avoided: 0, remaining: null, used: null }; } catch { return { month: month(), calls: [], avoided: 0, remaining: null, used: null }; } };
  const LSset = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* stockage plein : sans conséquence */ } };

  // Les en-têtes de The Odds API (x-requests-remaining / -used / -last) font foi : ce sont les vrais compteurs.
  function record({ key, title, group, estimated, headers, cached, ok }) {
    const s = LSget();
    if (cached) { s.avoided++; LSset(s); return; }
    const last = headers['x-requests-last'] != null ? +headers['x-requests-last'] : null;
    if (headers['x-requests-remaining'] != null) s.remaining = +headers['x-requests-remaining'];
    if (headers['x-requests-used'] != null) s.used = +headers['x-requests-used'];
    s.calls.push({ t: Date.now(), key, title, group, cost: last ?? estimated, measured: last != null, ok });
    while (s.calls.length > 150) s.calls.shift();
    LSset(s);
  }
  function noteRemaining(headers) {
    if (!headers || headers['x-requests-remaining'] == null) return;
    const s = LSget(); s.remaining = +headers['x-requests-remaining']; if (headers['x-requests-used'] != null) s.used = +headers['x-requests-used']; LSset(s);
  }
  function state(C) {
    const s = LSget();
    const spentLocal = s.calls.reduce((a, c) => a + (c.cost || 0), 0);
    const budget = C.monthlyCredits || 500;
    const used = s.used ?? spentLocal;
    const remaining = s.remaining ?? Math.max(0, budget - used);
    const byGroup = {};
    for (const c of s.calls) byGroup[c.group || 'autre'] = (byGroup[c.group || 'autre'] || 0) + (c.cost || 0);
    return { budget, used, remaining, pct: used / Math.max(1, used + remaining), alert80: used / Math.max(1, used + remaining) >= 0.8, reserve: C.creditReserve ?? 50, avoided: s.avoided, calls: s.calls, byGroup, measured: s.remaining != null };
  }
  // Un appel payant n'est autorisé que s'il laisse intacte la réserve exceptionnelle.
  function canSpend(C, cost) {
    const st = state(C);
    return st.remaining - cost >= st.reserve;
  }
  return { record, noteRemaining, state, canSpend };
})();
