/* SportPredict AI — « Mes paris » : paris réellement joués, bankroll et tableau de bord dans le temps. */
const SPMyBets = (() => {
  const D = SPData, P = SPPipeline, S = SPStore;
  const KEY = 'sp:mybets', BKEY = 'sp:bank';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (x) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '' : '−') + Math.abs(x).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €');
  const eurS = (x) => (x == null || isNaN(x) ? '—' : (x > 0 ? '+' : '') + eur(x));
  const pct = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + ' %');
  const sgn = (x) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + ' %');
  const TZ = 'Europe/Paris';
  const dt = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const dayKey = (t) => new Date(t).toLocaleDateString('fr-CA', { timeZone: TZ }); // AAAA-MM-JJ
  const SPORT = { football: 'Football', tennis: 'Tennis', nba: 'NBA', basket: 'Basket', hockey: 'NHL', autre: 'Autre' };
  const SRC = { daily: 'Pronostic du jour', best: 'Meilleur pari', value: 'Value', prono: 'Pronostic', check: 'Vérificateur', manuel: 'Pari perso' };

  const bets = () => D.LS.get(KEY, []);
  const saveBets = (b) => D.LS.set(KEY, b);
  const bank = () => D.LS.get(BKEY, null); // { start, since, moves: [{t, amount, note}] }
  let period = 'tout', draft = null;

  // ISO semaine « 2026-S45 »
  function weekKey(t) {
    const d = new Date(new Date(t).toLocaleDateString('fr-CA', { timeZone: TZ }) + 'T12:00:00Z');
    const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
    const y = d.getUTCFullYear(), first = new Date(Date.UTC(y, 0, 4));
    const w = 1 + Math.round(((d - first) / 86400e3 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
    return `${y}-S${String(w).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------------ ajout depuis un pronostic
  function openAdd(pre) {
    const C = P.cfg(), b = bank();
    const cur = b ? stats().bankroll : C.bankroll;
    const sugg = pre.suggested != null ? pre.suggested : Math.round(cur * 0.01 * 100) / 100;
    draft = pre;
    const dlg = document.getElementById('dlg');
    document.getElementById('dlgc').innerHTML = `<header><h3>J’ai parié</h3><button id="dlgx" class="x" aria-label="Fermer">×</button></header>
      <form id="addbet" class="cfg">
        <p><b>${esc(pre.match || '')}</b>${pre.t ? ` · ${dt(pre.t)}` : ''}<br>${esc(pre.label || '')}</p>
        ${pre.manual ? `<div class="g3">
          <label>Match / description <input id="b-match" required placeholder="ex. PSG – Lyon" value="${esc(pre.match || '')}"></label>
          <label>Pari <input id="b-label" required placeholder="ex. PSG gagne" value="${esc(pre.label || '')}"></label>
          <label>Sport <select id="b-sport">${Object.entries(SPORT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label>Date du match <input id="b-date" type="datetime-local" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)}"></label></div>` : ''}
        <div class="g3">
          <label>Cote obtenue <input id="b-odds" type="number" step="any" min="1.01" inputmode="decimal" required value="${pre.odds ?? ''}"></label>
          <label>Mise (€) <input id="b-stake" type="number" step="any" min="0.1" inputmode="decimal" required value="${sugg}"></label>
          <label>Bookmaker <input id="b-book" value="${esc(pre.book || 'Winamax')}"></label>
        </div>
        <p class="muted">${pre.suggested != null ? `Mise conseillée par le moteur : ${eur(pre.suggested)}.` : 'Pas de value sur ce pari : restez sur une petite mise (1 % de la bankroll au maximum).'}</p>
        <div class="row"><button class="btn-main sm" type="submit">Enregistrer le pari</button></div>
      </form>`;
    dlg.hidden = false;
    document.getElementById('dlgx').onclick = () => { dlg.hidden = true; };
    document.getElementById('addbet').addEventListener('submit', (e) => {
      e.preventDefault();
      const g = (id) => document.getElementById(id);
      const odds = parseFloat(String(g('b-odds').value).replace(',', '.')), stake = parseFloat(String(g('b-stake').value).replace(',', '.'));
      if (!(odds > 1) || !(stake > 0)) return;
      const bet = {
        id: 'B' + Date.now() + Math.floor(Math.random() * 1000), createdAt: Date.now(), source: draft.source || 'manuel',
        eventId: draft.eventId || null, sport: draft.manual ? g('b-sport').value : draft.sport, sportKey: draft.sportKey || null, comp: draft.comp || '',
        match: draft.manual ? g('b-match').value.trim() : draft.match, home: draft.home || null, away: draft.away || null,
        t: draft.manual ? Date.parse(g('b-date').value) || Date.now() : draft.t, label: draft.manual ? g('b-label').value.trim() : draft.label,
        type: draft.type || null, point: draft.point ?? null, market: draft.market || null,
        odds, stake, book: g('b-book').value.trim() || 'Winamax', conf: draft.conf || null, pApp: draft.p ?? null, oddsApp: draft.odds ?? null, value: !!draft.value,
        status: 'en attente', profit: null,
      };
      const all = bets(); all.push(bet); saveBets(all);
      dlg.hidden = true;
      if (window.SPToast) window.SPToast('Pari enregistré dans « Mes paris »');
      if (window.SPRoute) window.SPRoute();
    });
  }

  // ------------------------------------------------------------------ règlement
  function settleOne(b, status, score, source) {
    const win = status === 'gagné' ? 1 : status === 'demi-gagné' ? 0.5 : 0;
    const push = status === 'remboursé' || status === 'annulé' ? 1 : status === 'demi-gagné' || status === 'demi-perdu' ? 0.5 : 0;
    b.status = status;
    b.profit = Math.round((b.stake * win * (b.odds - 1) - b.stake * (1 - win - push)) * 100) / 100;
    b.score = score || null; b.settledAt = Date.now(); b.settleSource = source;
  }
  async function autoSettle() {
    const all = bets();
    const pend = all.filter((b) => b.status === 'en attente' && b.type && b.home && b.t < Date.now() - 2.5 * 3600e3 && (b.sport === 'football' || b.sport === 'nba' || b.sport === 'hockey') && !String(b.type).startsWith('reg_'));
    let n = 0;
    for (const b of pend) {
      const lg = b.sport === 'nba' ? ['basketball', 'nba'] : b.sport === 'hockey' ? ['hockey', 'nhl'] : ['soccer', D.FOOTBALL[b.sportKey]?.espn];
      if (!lg[1]) continue;
      const sb = await D.espnScoreboard(lg[0], lg[1], b.t - 86400e3, b.t + 86400e3);
      if (!sb.ok) continue;
      const ev = sb.events.find((x) => x.completed && D.sim(x.h, b.home) >= 0.5 && D.sim(x.a, b.away) >= 0.5 && Math.abs(x.t - b.t) < 36 * 3600e3);
      if (!ev) continue;
      const r = S.settle({ sport: b.sport, type: b.type, point: b.point, odds: b.odds }, ev.hs, ev.as);
      if (!r) continue;
      settleOne(b, r.status, `${ev.hs}-${ev.as}`, 'ESPN (automatique)'); n++;
    }
    if (n) saveBets(all);
    return n;
  }

  // ------------------------------------------------------------------ statistiques
  function stats(filterFn) {
    const b = bank();
    const all = bets().slice().sort((x, y) => x.t - y.t);
    const list = filterFn ? all.filter(filterFn) : all;
    const done = list.filter((x) => x.status !== 'en attente');
    const pending = list.filter((x) => x.status === 'en attente');
    const staked = done.reduce((s, x) => s + (x.status === 'annulé' ? 0 : x.stake), 0);
    const profit = done.reduce((s, x) => s + (x.profit || 0), 0);
    const wins = done.filter((x) => x.profit > 0).length, losses = done.filter((x) => x.profit < 0).length;
    const moves = (b?.moves || []).reduce((s, m) => s + m.amount, 0);
    const allProfit = all.filter((x) => x.status !== 'en attente').reduce((s, x) => s + (x.profit || 0), 0);
    const bankroll = (b?.start ?? P.cfg().bankroll) + moves + allProfit;
    const atRisk = all.filter((x) => x.status === 'en attente').reduce((s, x) => s + x.stake, 0);
    // courbe de bankroll jour par jour, perte maximale depuis un sommet, séries
    const days = new Map();
    for (const x of all.filter((y) => y.status !== 'en attente')) { const k = dayKey(x.settledAt && x.t > Date.now() ? x.settledAt : x.t); days.set(k, (days.get(k) || 0) + x.profit); }
    for (const m of b?.moves || []) { const k = dayKey(m.t); days.set(k, (days.get(k) || 0) + m.amount); }
    let level = b?.start ?? P.cfg().bankroll, peak = level, maxDD = 0;
    const curve = [...days.entries()].sort().map(([k, v]) => { level += v; peak = Math.max(peak, level); maxDD = Math.max(maxDD, (peak - level) / peak); return { k, v: level }; });
    let streak = 0, streakType = null;
    for (const x of done.slice().reverse()) { const t = x.profit > 0 ? 'V' : x.profit < 0 ? 'D' : null; if (!t) continue; if (!streakType) streakType = t; if (t !== streakType) break; streak++; }
    const group = (f) => {
      const m = {};
      for (const x of done) { const k = f(x); m[k] = m[k] || { n: 0, wins: 0, staked: 0, profit: 0, odds: 0 }; m[k].n++; m[k].wins += x.profit > 0 ? 1 : 0; m[k].staked += x.status === 'annulé' ? 0 : x.stake; m[k].profit += x.profit; m[k].odds += x.odds; }
      return m;
    };
    return {
      list, done, pending, staked, profit, wins, losses, bankroll, atRisk, maxDD, curve, streak, streakType,
      roi: staked ? profit / staked : null, hit: done.length ? wins / done.length : null,
      avgOdds: done.length ? done.reduce((s, x) => s + x.odds, 0) / done.length : null,
      avgStake: list.length ? list.reduce((s, x) => s + x.stake, 0) / list.length : null,
      expected: done.filter((x) => x.pApp != null).reduce((s, x) => s + x.stake * (x.pApp * x.odds - 1), 0),
      byWeek: group((x) => weekKey(x.t)), byDay: group((x) => dayKey(x.t)), bySport: group((x) => SPORT[x.sport] || x.sport),
      bySource: group((x) => SRC[x.source] || x.source), byMarket: group((x) => x.label?.match(/corner/i) ? 'Corners' : x.label?.match(/carton/i) ? 'Cartons' : ({ h2h: 'Vainqueur', totals: 'Total', spreads: 'Handicap' }[x.market] || 'Autre')),
      byValue: group((x) => (x.value ? 'Avec value' : 'Sans value')),
      byOdds: group((x) => S.oddsBand(x.odds)), byConf: group((x) => x.conf || 'non renseignée'),
    };
  }

  // ------------------------------------------------------------------ rendu
  function lineSVG(curve, start) {
    if (curve.length < 2) return '<p class="muted">La courbe apparaît après deux jours de paris réglés.</p>';
    const W = 640, H = 220, pad = 48;
    const ys = curve.map((p) => p.v).concat(start), lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
    const X = (i) => pad + i / (curve.length - 1) * (W - pad - 12), Y = (v) => 12 + (hi - v) / span * (H - 44);
    const d = curve.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const last = curve[curve.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Évolution de la bankroll">
      <line x1="${pad}" x2="${W - 12}" y1="${Y(start)}" y2="${Y(start)}" class="axis dash"/>
      <text x="4" y="${Y(hi) + 4}" class="lbl">${Math.round(hi)} €</text><text x="4" y="${Y(lo) + 4}" class="lbl">${Math.round(lo)} €</text><text x="4" y="${Y(start) - 4}" class="lbl">départ</text>
      <path d="${d} L${X(curve.length - 1)},${H - 32} L${X(0)},${H - 32} Z" class="area"/><path d="${d}" class="line"/>
      <circle cx="${X(curve.length - 1)}" cy="${Y(last.v)}" r="4" class="endpt"/>
      <text x="${X(curve.length - 1) - 6}" y="${Y(last.v) - 9}" text-anchor="end" class="lbl b">${eur(last.v)}</text>
      <text x="${pad}" y="${H - 10}" class="lbl">${curve[0].k}</text><text x="${W - 12}" y="${H - 10}" text-anchor="end" class="lbl">${last.k}</text></svg>`;
  }
  function barsSVG(byWeek) {
    const ks = Object.keys(byWeek).sort().slice(-12);
    if (!ks.length) return '<p class="muted">Pas encore de semaine terminée.</p>';
    const W = 640, H = 200, pad = 40, vals = ks.map((k) => byWeek[k].profit), m = Math.max(1, ...vals.map(Math.abs));
    const bw = (W - pad - 12) / ks.length, zero = H / 2;
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Profit par semaine">
      <line x1="${pad}" x2="${W - 12}" y1="${zero}" y2="${zero}" class="axis"/>
      <text x="4" y="16" class="lbl">+${m.toFixed(0)} €</text><text x="4" y="${H - 22}" class="lbl">−${m.toFixed(0)} €</text>
      ${ks.map((k, i) => { const v = byWeek[k].profit, h = Math.abs(v) / m * (zero - 24); return `<rect x="${pad + i * bw + bw * 0.15}" y="${v >= 0 ? zero - h : zero}" width="${bw * 0.7}" height="${Math.max(1, h)}" rx="3" class="${v >= 0 ? 'barp' : 'barn'}"><title>${k} : ${eurS(v)} (${byWeek[k].n} paris)</title></rect><text x="${pad + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" class="lbl">${k.slice(5)}</text>`; }).join('')}
    </svg>`;
  }
  function table(obj, label, sortKeys) {
    const ks = sortKeys ? Object.keys(obj).sort().reverse() : Object.keys(obj).sort((a, b) => obj[b].n - obj[a].n);
    if (!ks.length) return '<p class="muted">—</p>';
    return `<div class="tw"><table class="t"><thead><tr><th>${label}</th><th>Paris</th><th>Réussite</th><th>Misé</th><th>Profit</th><th>ROI</th><th>Cote moy.</th></tr></thead><tbody>
      ${ks.map((k) => { const v = obj[k]; return `<tr><td>${esc(k)}</td><td class="n">${v.n}</td><td class="n">${pct(v.wins / v.n, 0)}</td><td class="n">${eur(v.staked)}</td><td class="n ${v.profit >= 0 ? 'pos' : 'neg'}">${eurS(v.profit)}</td><td class="n">${v.staked ? sgn(v.profit / v.staked) : '—'}</td><td class="n">${(v.odds / v.n).toFixed(2)}</td></tr>`; }).join('')}
    </tbody></table></div>`;
  }

  function render() {
    const b = bank();
    const now = Date.now();
    const f = period === 'jour' ? (x) => dayKey(x.t) === dayKey(now) : period === 'semaine' ? (x) => weekKey(x.t) === weekKey(now) : period === 'mois' ? (x) => dayKey(x.t).slice(0, 7) === dayKey(now).slice(0, 7) : null;
    const st = stats(f), all = stats();
    const k = (l, v, s, cls = '') => `<div class="kpi"><small>${l}</small><b class="${cls}">${v}</b>${s ? `<span>${s}</span>` : ''}</div>`;
    const setup = !b ? `<section class="card notice"><h3>Votre bankroll de départ</h3><p>Indiquez la somme que vous consacrez aux paris. Elle sert de base au suivi et aux mises conseillées.</p>
      <form id="bankf" class="row"><input id="bk-start" type="number" step="any" min="1" inputmode="decimal" placeholder="ex. 100" required aria-label="Bankroll de départ"><button class="btn-sec" type="submit">Commencer le suivi</button></form></section>` : '';
    const start = b?.start ?? P.cfg().bankroll;
    return `<h2>Mes paris</h2>
      ${setup}
      <div class="row"><div class="seg">${[['jour', 'Aujourd’hui'], ['semaine', 'Cette semaine'], ['mois', 'Ce mois'], ['tout', 'Depuis le début']].map(([v, l]) => `<button data-per="${v}" class="${period === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <button id="addmanual" class="btn-sec">+ Ajouter un pari</button><button id="settlemine" class="btn-sec">Mettre à jour les résultats</button></div>
      <div class="kpirow">
        ${k('Bankroll actuelle', eur(all.bankroll), `mise à jour à chaque pari réglé · départ ${eur(start)}${b?.since ? ' le ' + new Date(b.since).toLocaleDateString('fr-FR') : ''}`, all.bankroll >= start ? 'pos' : 'neg')}
        ${k('Profit', eurS(st.profit), `${st.done.length} pari(s) réglé(s)`, st.profit >= 0 ? 'pos' : 'neg')}
        ${k('ROI', sgn(st.roi), 'profit / mises')}
        ${k('Réussite', pct(st.hit, 0), `${st.wins} gagnés · ${st.losses} perdus`)}
        ${k('En jeu', eur(all.atRisk), `${all.pending.length} pari(s) en attente`)}
        ${k('Cote moyenne', st.avgOdds ? st.avgOdds.toFixed(2) : '—', `mise moyenne ${eur(st.avgStake)}`)}
        ${k('Série en cours', all.streak ? `${all.streak} ${all.streakType === 'V' ? 'gagné' : 'perdu'}${all.streak > 1 ? 's' : ''}` : '—')}
        ${k('Perte max. depuis un sommet', pct(all.maxDD, 0), 'drawdown')}
        ${k('Profit attendu', eurS(st.expected), 'selon les probabilités du moteur')}
      </div>
      ${all.atRisk > 0.05 * all.bankroll ? `<p class="notice">${eur(all.atRisk)} en jeu, soit ${pct(all.atRisk / all.bankroll, 0)} de votre bankroll : au-delà de 5 %, c’est trop (plafond strict : 5 %).</p>` : ''}
      ${all.curve.length && (() => { const peak = Math.max(start, ...all.curve.map((c) => c.v)); return (peak - all.bankroll) / peak >= 0.10; })() ? `<p class="notice">Baisse de 10 % ou plus depuis le dernier sommet de bankroll : faites une revue complète (onglets Stats, Erreurs, Fiabilité) avant de continuer. Ne relevez pas vos mises pour vous refaire.</p>` : ''}
      ${[50, 100, 200, 500].some((n) => all.done.length >= n && all.done.length < n + 5) ? `<p class="notice">Vous avez atteint ${all.done.length} paris réglés : bon moment pour analyser vos performances (Stats, Erreurs).</p>` : ''}
      ${all.streakType === 'D' && all.streak >= 4 ? `<p class="notice">${all.streak} paris perdus d’affilée : c’est normal statistiquement de temps en temps. N’augmentez pas vos mises pour « vous refaire ».</p>` : ''}
      <div class="grid2">
        <section class="card"><h3>Évolution de la bankroll</h3>${lineSVG(all.curve, start)}</section>
        <section class="card"><h3>Profit par semaine</h3>${barsSVG(all.byWeek)}</section>
      </div>
      <section class="card"><h3>Semaine par semaine</h3>${table(st.byWeek, 'Semaine', true)}</section>
      <section class="card"><h3>Jour par jour</h3>${table(st.byDay, 'Jour', true)}</section>
      <div class="grid2">
        <section class="card"><h3>Par sport</h3>${table(st.bySport, 'Sport')}</section>
        <section class="card"><h3>Par type de pari</h3>${table(st.bySource, 'Origine')}</section>
        <section class="card"><h3>Par marché</h3>${table(st.byMarket, 'Marché')}</section>
        <section class="card"><h3>Par tranche de cotes</h3>${table(st.byOdds, 'Cotes')}</section>
        <section class="card"><h3>Par niveau de confiance</h3>${table(st.byConf, 'Confiance')}</section>
        <section class="card"><h3>Avec ou sans value</h3>${table(st.byValue, 'Value')}<p class="muted">Sur la durée, seuls les paris « avec value » devraient être rentables.</p></section>
      </div>
      <section class="card"><h3>Tous mes paris</h3><div class="tw"><table class="t hist"><thead><tr><th>Match</th><th>Pari</th><th>Cote</th><th>Mise</th><th>Origine</th><th>Résultat</th><th>Profit</th><th></th></tr></thead><tbody>
        ${st.list.slice().reverse().map((x) => `<tr><td>${esc(x.match)}<br><small class="muted">${dt(x.t)} · ${esc(SPORT[x.sport] || '')}</small></td><td>${esc(x.label)}</td><td class="n">${x.odds.toFixed(2)}</td><td class="n">${eur(x.stake)}</td><td>${esc(SRC[x.source] || x.source)}${x.value ? ' <span class="tag t-ok">value</span>' : ''}</td>
          <td>${x.status === 'en attente' ? `<span class="manual" data-bid="${esc(x.id)}"><button data-r="gagné" title="Gagné">G</button><button data-r="perdu" title="Perdu">P</button><button data-r="remboursé" title="Remboursé">R</button></span>${x.type ? '<br><small class="muted">réglage auto après le match</small>' : ''}` : `<span class="tag t-${x.profit > 0 ? 'ok' : x.profit < 0 ? 'bad' : 'na'}">${esc(x.status)}</span> <small class="muted">${esc(x.score || '')}</small>`}</td>
          <td class="n ${x.profit > 0 ? 'pos' : x.profit < 0 ? 'neg' : ''}">${x.profit != null ? eurS(x.profit) : '—'}</td><td><button class="linkbtn" data-del="${esc(x.id)}" title="Supprimer">supprimer</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun pari. Appuyez sur « J’ai parié » sous un pronostic, ou sur « + Ajouter un pari ».</td></tr>'}
      </tbody></table></div></section>
      ${b ? `<section class="card"><h3>Dépôts et retraits</h3><form id="movef" class="row"><input id="mv-amt" type="number" step="any" inputmode="decimal" placeholder="+50 ou −20" required aria-label="Montant"><input id="mv-note" placeholder="note (facultatif)" aria-label="Note"><button class="btn-sec" type="submit">Ajouter</button></form>
        <ul class="muted">${(b.moves || []).map((m) => `<li>${new Date(m.t).toLocaleDateString('fr-FR')} : ${eurS(m.amount)} ${esc(m.note || '')}</li>`).join('') || '<li>Aucun mouvement.</li>'}</ul>
        <p><button id="resetbank" class="linkbtn">Changer la bankroll de départ</button></p></section>` : ''}
      <section class="card"><h3>Repartir de zéro</h3><p class="muted">Efface tous vos paris enregistrés, les dépôts et retraits, puis repart d’une nouvelle bankroll. Pensez à faire « Historique → Exporter » avant si vous voulez garder une copie. Les pronostics publiés par le moteur (onglet Historique et Stats) ne sont pas touchés.</p>
        <form id="resetall" class="row"><input id="ra-start" type="number" step="any" min="1" inputmode="decimal" placeholder="nouvelle bankroll (€)" required aria-label="Nouvelle bankroll de départ"><button class="btn-sec" type="submit">Tout remettre à zéro</button></form></section>`;
  }

  function bind(rerender) {
    const $ = (q) => document.querySelector(q);
    $('#bankf')?.addEventListener('submit', (e) => { e.preventDefault(); const v = parseFloat($('#bk-start').value); if (!(v > 0)) return; D.LS.set(BKEY, { start: v, since: Date.now(), moves: [] }); const C = P.cfg(); C.bankroll = v; P.saveCfg(C); rerender(); });
    document.querySelectorAll('[data-per]').forEach((x) => x.addEventListener('click', () => { period = x.dataset.per; rerender(); }));
    $('#addmanual')?.addEventListener('click', () => openAdd({ manual: true, source: 'manuel' }));
    $('#settlemine')?.addEventListener('click', async () => { const n = await autoSettle(); if (window.SPToast) window.SPToast(`${n} résultat(s) mis à jour`); rerender(); });
    document.querySelectorAll('.manual[data-bid] button').forEach((btn) => btn.addEventListener('click', () => {
      const all = bets(), x = all.find((y) => y.id === btn.parentElement.dataset.bid); if (!x) return;
      settleOne(x, btn.dataset.r, null, 'saisie manuelle'); saveBets(all); rerender();
    }));
    document.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => {
      if (!window.confirm('Supprimer ce pari du suivi ?')) return;
      saveBets(bets().filter((y) => y.id !== btn.dataset.del)); rerender();
    }));
    $('#movef')?.addEventListener('submit', (e) => {
      e.preventDefault(); const v = parseFloat(String($('#mv-amt').value).replace(',', '.')); if (!v) return;
      const b = bank(); b.moves = [...(b.moves || []), { t: Date.now(), amount: v, note: $('#mv-note').value.trim() }]; D.LS.set(BKEY, b); rerender();
    });
    $('#resetall')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = parseFloat(String($('#ra-start').value).replace(',', '.'));
      if (!(v > 0)) return;
      if (!window.confirm(`Effacer vos ${bets().length} pari(s) enregistré(s) et repartir avec ${v} € ?`)) return;
      saveBets([]);
      D.LS.set(BKEY, { start: v, since: Date.now(), moves: [] });
      const C = P.cfg(); C.bankroll = v; P.saveCfg(C);
      if (window.SPToast) window.SPToast(`Remis à zéro : bankroll de départ ${v} €`);
      rerender();
    });
    $('#resetbank')?.addEventListener('click', () => {
      const b = bank(); const v = parseFloat(window.prompt('Nouvelle bankroll de départ (€) :', b?.start ?? ''));
      if (v > 0) { D.LS.set(BKEY, { ...b, start: v }); rerender(); }
    });
  }
  return { render, bind, openAdd, autoSettle, stats, bets };
})();
