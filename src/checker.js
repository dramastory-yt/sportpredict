/* SportPredict AI — vérificateur de cote (cotes boostées, marchés absents de l'API). */
const SPChecker = (() => {
  const D = SPData, P = SPPipeline, S = SPStore, SP = P.SP;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + ' %');
  const sgn = (x) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + ' %');
  const TZ = 'Europe/Paris';
  const dt = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  // marché -> { libellé, type moteur, ligne requise, validation }
  // « backtest » : probabilité issue du mélange marché/modèles validé contre les cotes de clôture.
  // « modèle » : dérivé des mêmes paramètres mais jamais comparé à un marché réel -> exigence d'EV doublée.
  const MARKETS = {
    football: [
      ['1', 'Victoire domicile', 'home', false, 'backtest'], ['N', 'Match nul', 'draw', false, 'backtest'], ['2', 'Victoire extérieur', 'away', false, 'backtest'],
      ['1N', 'Double chance 1N', 'dc1X', false, 'backtest'], ['N2', 'Double chance N2', 'dcX2', false, 'backtest'], ['12', 'Double chance 12', 'dc12', false, 'backtest'],
      ['dnb1', 'Remboursé si nul : domicile', 'ahHome', false, 'backtest', 0], ['dnb2', 'Remboursé si nul : extérieur', 'ahAway', false, 'backtest', 0],
      ['over', 'Plus de X buts', 'over', true, 'modèle'], ['under', 'Moins de X buts', 'under', true, 'modèle'],
      ['bttsY', 'Les deux équipes marquent : oui', 'bttsYes', false, 'modèle'], ['bttsN', 'Les deux équipes marquent : non', 'bttsNo', false, 'modèle'],
      ['ah1', 'Handicap domicile (ex. -1.5)', 'ahHome', true, 'modèle'], ['ah2', 'Handicap extérieur (ex. +1.5)', 'ahAway', true, 'modèle'],
      ['HS', 'Équipe domicile marque', 'homeTotalOver', false, 'modèle'], ['AS', 'Équipe extérieur marque', 'awayTotalOver', false, 'modèle'],
      ['HCS', 'Domicile ne prend pas de but', 'homeCS', false, 'modèle'], ['ACS', 'Extérieur ne prend pas de but', 'awayCS', false, 'modèle'],
      ['HO15', 'Domicile gagne et +1,5 buts', 'homeAndOver15', false, 'modèle'], ['AO15', 'Extérieur gagne et +1,5 buts', 'awayAndOver15', false, 'modèle'],
    ],
    nba: [
      ['home', 'Victoire domicile', 'home', false, 'backtest'], ['away', 'Victoire extérieur', 'away', false, 'backtest'],
      ['ahH', 'Handicap domicile (ex. -4.5)', 'ahHome', true, 'modèle'], ['ahA', 'Handicap extérieur (ex. +4.5)', 'ahAway', true, 'modèle'],
      ['over', 'Plus de X points', 'over', true, 'modèle'], ['under', 'Moins de X points', 'under', true, 'modèle'],
    ],
    basket: null,
    tennis: [
      ['tA', 'Victoire joueur 1', 'tennisA', false, 'modèle'], ['tB', 'Victoire joueur 2', 'tennisB', false, 'modèle'],
      ['tO', 'Plus de X jeux', 'tOver', true, 'modèle'], ['tU', 'Moins de X jeux', 'tUnder', true, 'modèle'],
      ['spA', 'Handicap jeux joueur 1 (ex. -3.5)', 'spread', true, 'modèle', null, 'A'], ['spB', 'Handicap jeux joueur 2 (ex. +3.5)', 'spread', true, 'modèle', null, 'B'],
    ],
  };
  MARKETS.basket = MARKETS.nba;
  let lastResult = null;

  function render() {
    const A = S.lastAnalysis();
    const evs = (A?.events || []).filter((e) => e.spec && e.t > Date.now()).sort((a, b) => a.t - b.t);
    if (!evs.length) return `<h2>Vérifier une cote</h2><section class="card empty"><p>Lancez d’abord une analyse depuis le <a href="#dashboard">tableau de bord</a> : le vérificateur utilise les modèles calculés pour chaque match à venir.</p></section>`;
    const cur = lastResult?.evId && evs.find((e) => e.id === lastResult.evId) ? lastResult.evId : evs[0].id;
    const ev = evs.find((e) => e.id === cur);
    return `<h2>Vérifier une cote</h2>
      <p class="muted">Pour une cote boostée Winamax ou un marché que l’analyse automatique ne couvre pas : choisissez le match et le pari, saisissez la cote affichée sur Winamax.</p>
      <form id="chk" class="card cfg">
        <label>Match <select id="k-ev">${evs.map((e) => `<option value="${esc(e.id)}" ${e.id === cur ? 'selected' : ''}>${esc(dt(e.t))} · ${esc(e.home)} – ${esc(e.away)} (${esc(e.comp)})</option>`).join('')}</select></label>
        <div class="g3">
          <label>Pari <select id="k-mk">${MARKETS[ev.sport].map((m) => `<option value="${m[0]}" ${lastResult?.mk === m[0] ? 'selected' : ''}>${esc(m[1].replace('joueur 1', ev.home).replace('joueur 2', ev.away))}</option>`).join('')}</select></label>
          <label>Ligne (si demandée) <input id="k-line" type="number" step="any" inputmode="decimal" placeholder="ex. 2.5" value="${lastResult?.line ?? ''}"></label>
          <label>Cote Winamax <input id="k-odds" type="number" step="any" min="1.01" inputmode="decimal" placeholder="ex. 2.10" value="${lastResult?.odds ?? ''}" required></label>
        </div>
        <label class="chk"><input type="checkbox" id="k-boost" ${lastResult?.boost ? 'checked' : ''}> C’est une cote boostée (mise souvent plafonnée par Winamax)</label>
        <div class="row"><button class="btn-main sm" type="submit">Calculer</button><span id="k-wait" class="muted" hidden>Simulation en cours…</span></div>
      </form>
      <div id="k-out">${lastResult?.html || ''}</div>`;
  }

  async function compute(ev, mkId, line, odds, boost) {
    const C = P.cfg();
    const m = MARKETS[ev.sport].find((x) => x[0] === mkId);
    const [, label, type, needLine, validation, fixedPoint, extra] = m;
    if (needLine && !Number.isFinite(line) && fixedPoint == null) throw new Error('Ce pari demande une ligne (par exemple 2.5).');
    const point = fixedPoint != null ? fixedPoint : line;
    let pWin, pPush = 0, ci = null, n = 0, source;
    if (type === 'corners' || type === 'cards') {
      const L = await D.localData();
      const rows = L.football?.leagues?.[ev.sportKey];
      if (!rows) throw new Error('Données corners/cartons indisponibles pour cette compétition (seulement les championnats suivis, en version en ligne).');
      const fit = SP.fitCounts(rows.map(SP.fdRow), type);
      if (!fit) throw new Error('Pas assez de données pour ce modèle.');
      const mh = D.bestMatch(ev.home, fit.teams), ma = D.bestMatch(ev.away, fit.teams);
      if (!mh.name || !ma.name) throw new Error('Équipe(s) introuvable(s) dans les données football-data.');
      const l = SP.dcLambdas(fit, mh.name, ma.name), mu = l.lh + l.la;
      const over = SP.nbOver(mu, fit.phi, point);
      const exact = Number.isInteger(point) ? SP.nbPmf(point, mu, fit.phi) : 0;
      pPush = exact;
      pWin = extra === 'over' ? over : 1 - over - exact;
      source = `${type === 'corners' ? 'Corners' : 'Cartons jaunes'} : modèle attaque/défense par équipe sur ${fit.n} matchs football-data, moyenne attendue ${mu.toFixed(2)} (${mh.name} ${l.lh.toFixed(2)} / ${ma.name} ${l.la.toFixed(2)}), dispersion ${fit.phi.toFixed(2)}`;
    } else {
      const sel = SP.normalizeSel({ type, point, side: extra });
      const res = await P.runSims([{ spec: { ...ev.spec, seed: (Date.now() >>> 0), minN: 200000, maxN: 600000, tol: 0.002 }, sel }]);
      const r = res[0]; if (!r || r.error) throw new Error('Simulation impossible : ' + (r?.error || 'erreur'));
      const e = SP.evalFromSim(r, sel, odds);
      pWin = e.pWin; pPush = e.pPush; ci = e.ci95; n = r.n;
      source = `${n.toLocaleString('fr-FR')} simulations Monte-Carlo à partir des paramètres de l’analyse (${ev.wSource ? 'poids marché : ' + ev.wSource : 'mélange marché/modèles'})`;
    }
    if (C.platt && validation === 'backtest') pWin = SP.applyPlatt(C.platt, pWin);
    const ev_ = pWin * odds + pPush - 1;
    const need = validation === 'backtest' ? C.minEV : Math.max(0.05, 2 * C.minEV);
    // incertitude : erreur Monte-Carlo + incertitude de modèle (marché calculé = plus incertain) + qualité des données
    const dq = ev.spec?.kind === 'football' ? (/football-data/.test(ev.statsNote || '') ? 0.7 : 0.4) : 0.45;
    const uncert = Math.sqrt((ci || 0.005) ** 2 + (validation === 'backtest' ? 0.02 : 0.04) ** 2 + ((1 - dq) * 0.04) ** 2);
    const minOdds = Math.ceil(((1 + need - pPush) / Math.max(0.01, pWin - uncert)) * 100) / 100;
    const edge = pWin + pPush / odds - 1 / odds;
    const k = Math.max(0, ev_ / (odds - 1));
    const frac = Math.min(C.maxStakePct, C.kellyFrac * k);
    const B = (() => { try { return SPMyBets.stats().bankroll; } catch { return C.bankroll; } })();
    const stake = Math.round(B * frac * 100) / 100;
    const age = (Date.now() - (S.lastAnalysis()?.finishedAt || 0)) / 3600e3;
    const insufficient = /marché seul|indisponible|non apparié|dérivé du marché/i.test(ev.statsNote || '') && validation !== 'backtest';
    const ok = ev_ >= need && odds >= C.minOdds && edge > uncert;
    const verdict = insufficient && type !== 'home' && type !== 'away' && type !== 'draw' ? 'DONNÉES INSUFFISANTES'
      : ev_ >= need && odds >= C.minOdds && edge <= uncert ? 'VALUE INSUFFISAMMENT FIABLE'
      : ok ? 'VALUE' : 'PAS DE VALUE';
    const warn = [];
    if (age > 6) warn.push(`L’analyse date de ${Math.round(age)} h : relancez-la pour intégrer les dernières cotes et blessures.`);
    if (validation === 'modèle') warn.push('Marché calculé par le modèle mais jamais comparé à des cotes réelles : exigence d’EV doublée (' + (need * 100).toFixed(0) + ' %).');
    if (boost) warn.push('Cote boostée : vérifiez la mise maximale autorisée par Winamax.');
    if (odds < C.minOdds) warn.push(`Cote inférieure au minimum (${C.minOdds}).`);
    const html = `<section class="card ${verdict === 'VALUE' ? 'pick big' : ''}">
      <h3>${{ VALUE: 'VALUE : ce pari est intéressant', 'PAS DE VALUE': 'PAS DE VALUE : ne pariez pas', 'VALUE INSUFFISAMMENT FIABLE': 'VALUE INSUFFISAMMENT FIABLE : l’avantage disparaît dans l’incertitude', 'DONNÉES INSUFFISANTES': 'DONNÉES INSUFFISANTES : impossible de conclure' }[verdict]}</h3>
      <p><b>${esc(ev.home)} – ${esc(ev.away)}</b> · ${esc(label.replace('joueur 1', ev.home).replace('joueur 2', ev.away))}${needLine && fixedPoint == null ? ` · ligne ${point}` : ''} @ <b>${odds.toFixed(2)}</b>${boost ? ' (boostée)' : ''}</p>
      <div class="kpis">
        <div><small>Probabilité estimée</small><b>${pct(pWin)}</b><span>${ci != null ? 'IC95 ±' + pct(ci, 2) : ''}${pPush ? ' · remb. ' + pct(pPush) : ''}</span></div>
        <div><small>Cote juste</small><b>${((1 - pPush) / Math.max(1e-6, pWin)).toFixed(2)}</b><span>sans marge</span></div>
        <div><small>EV</small><b class="${ev_ > 0 ? 'pos' : 'neg'}">${sgn(ev_)}</b><span>seuil ${(need * 100).toFixed(0)} %</span></div>
        <div><small>Cote minimale acceptable</small><b>${minOdds.toFixed(2)}</b><span>incertitude incluse</span></div>
        <div><small>Edge</small><b class="${edge > 0 ? 'pos' : 'neg'}">${sgn(edge)}</b><span>incertitude ±${pct(uncert, 1)}</span></div>
        <div><small>Mise indicative</small><b>${verdict === 'VALUE' ? stake.toFixed(2) + ' €' : '0 €'}</b><span>${ok ? (frac * 100).toFixed(1) + ' % de ' + B.toFixed(2) + ' €' : 'aucune'}</span></div>
      </div>
      ${warn.length ? `<ul class="muted">${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="muted">Source : ${esc(source)}.</p></section>`;
    return { html, evId: ev.id, mk: mkId, line, odds, boost };
  }

  function bind(rerender) {
    const f = document.getElementById('chk'); if (!f) return;
    document.getElementById('k-ev').addEventListener('change', (e) => { lastResult = { evId: e.target.value }; rerender(); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const A = S.lastAnalysis();
      const ev = A.events.find((x) => x.id === document.getElementById('k-ev').value);
      const odds = parseFloat(String(document.getElementById('k-odds').value).replace(',', '.'));
      const lineRaw = String(document.getElementById('k-line').value).replace(',', '.');
      const line = lineRaw === '' ? NaN : parseFloat(lineRaw);
      if (!(odds > 1)) return;
      document.getElementById('k-wait').hidden = false;
      try {
        lastResult = await compute(ev, document.getElementById('k-mk').value, line, odds, document.getElementById('k-boost').checked);
      } catch (err) {
        lastResult = { evId: ev.id, html: `<section class="card notice">${esc(err.message || err)}</section>` };
      }
      rerender();
    });
  }
  return { render, bind };
})();
