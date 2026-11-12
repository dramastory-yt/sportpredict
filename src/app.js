/* SportPredict AI — interface. */
(() => {
  const D = SPData, P = SPPipeline, S = SPStore, SP = P.SP;
  const $ = (q, el = document) => el.querySelector(q);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // probabilités affichées sans fausse précision (entier) ; décimales seulement quand on les demande
  const pct = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + ' %');
  const sgn = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + ' %');
  const num = (x, d = 2) => (x == null || isNaN(x) ? '—' : Number(x).toFixed(d));
  const int = (n) => (n == null ? '—' : new Intl.NumberFormat('fr-FR').format(n));
  const TZ = 'Europe/Paris';
  const dt = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const hm = (t) => new Date(t).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`; };
  const SPORT = { football: 'Football', tennis: 'Tennis', nba: 'NBA', basket: 'Basket', hockey: 'NHL' };
  const MKT = { h2h: 'Vainqueur', h2h_reg: 'Vainqueur 60 min', totals: 'Total', spreads: 'Handicap' };

  const STEPS = ['Récupération des matchs', 'Collecte des statistiques', 'Analyse des blessures', 'Vérification des compositions', 'Analyse des actualités', 'Comparaison des cotes', 'Calcul des modèles', 'Simulations Monte-Carlo', 'Classement des opportunités', 'Validation finale'];
  let running = false;
  const state = { steps: STEPS.map((n) => ({ name: n, st: 'attente', note: '', frac: 0 })) };

  // ------------------------------------------------------------ progression réelle
  const stepsUI = {
    start(i) { state.steps[i].st = 'en cours'; state.steps[i].frac = 0; renderProgress(); },
    progress(i, d, n, note) { state.steps[i].frac = n ? d / n : 0; state.steps[i].note = note ? `${note} (${d}/${n})` : `${d}/${n}`; renderProgress(); },
    done(i, note, warn) { state.steps[i].st = warn ? 'avertissement' : 'terminé'; state.steps[i].frac = 1; state.steps[i].note = note || ''; renderProgress(); },
    fail(i, msg) { state.steps[i].st = 'erreur'; state.steps[i].note = msg; for (let k = i + 1; k < STEPS.length; k++) state.steps[k].st = 'non exécutée'; renderProgress(); },
  };
  function renderProgress() {
    const el = $('#progress'); if (!el) return;
    const done = state.steps.reduce((s, x) => s + (['terminé', 'avertissement', 'erreur', 'non exécutée'].includes(x.st) ? 1 : x.st === 'en cours' ? x.frac : 0), 0);
    el.hidden = false;
    $('#pbar').style.width = (done / STEPS.length * 100).toFixed(1) + '%';
    $('#ptext').textContent = `${Math.round(done / STEPS.length * 100)} % — ${state.steps.filter((x) => x.st === 'terminé' || x.st === 'avertissement').length}/10 étapes terminées`;
    $('#steps').innerHTML = state.steps.map((s, i) => `<li class="step s-${s.st.replace(/\s/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '')}"><span class="dot"></span><span class="sn">${i + 1}. ${esc(s.name)}</span><span class="sst">${esc(s.st)}</span>${s.note ? `<span class="snote">${esc(s.note)}</span>` : ''}</li>`).join('');
  }

  async function launch(opts = {}) {
    if (running) return;
    running = true;
    state.steps.forEach((s) => { s.st = 'attente'; s.note = ''; s.frac = 0; });
    document.body.classList.add('busy');
    renderProgress();
    try {
      const A = await P.run({ steps: stepsUI }, opts);
      afterRun(A, opts);
    } catch (e) {
      console.error(e);
      toast('Analyse interrompue : ' + (e.message || e), 'bad');
    } finally {
      running = false;
      document.body.classList.remove('busy');
      route();
    }
  }
  function afterRun(A, opts) {
    // CLV : dernière cote juste relevée avant le début pour chaque pronostic en attente
    for (const p of S.picks()) {
      if (S.results()[p.pid] || p.t < Date.now()) continue;
      const E = A.events.find((e) => e.id === p.eventId); if (!E) continue;
      const s = E.sels.find((x) => x.id === p.selId); if (!s) continue;
      S.recordCLV(p.pid, { odds: s.best, fair: s.fair, book: s.book });
    }
    if (opts.parentId) {
      const prev = S.analyses().find((a) => a.id === opts.parentId);
      const tracked = prev ? [prev.best, ...prev.values, ...prev.watch].filter(Boolean) : [];
      A.recheck = tracked.map((p) => {
        const E = A.events.find((e) => e.id === p.eventId);
        const s = E?.sels.find((x) => x.id === p.selId);
        if (!E || !s) return { ...p, verdict: 'événement ou marché indisponible', status: 'bad' };
        const keep = (A.best && A.best.selId === p.selId && A.best.eventId === p.eventId) || A.values.some((v) => v.selId === p.selId && v.eventId === p.eventId);
        const newSafe = (A.safe || []).find((x) => x.eventId === p.eventId && x.label === p.label);
        const nc = newSafe?.conf || (A.best && A.best.selId === p.selId ? A.best.conf : A.values.find((v) => v.selId === p.selId)?.conf) || 'faible';
        const R = SP.CONF_RANK;
        const confMsg = p.conf && nc !== p.conf ? (R[nc] > R[p.conf] ? ` · confiance améliorée (${p.conf} → ${nc})` : ` · confiance diminuée (${p.conf} → ${nc})`) : '';
        const rejected = !keep && !newSafe;
        return { match: p.match, label: p.label, oldOdds: p.odds, newOdds: s.best, oldP: p.p, newP: s.p, oldEV: p.ev, newEV: s.ev, verdict: (rejected ? 'pari désormais rejeté' : keep ? 'value confirmée' : (s.ev != null && s.ev > 0 ? 'value réduite' : 'value disparue')) + confMsg, status: keep ? 'good' : 'bad' };
      });
      const list = S.analyses(); list[list.length - 1] = A; D.LS.set('sp:analyses', list);
    }
    if (P.cfg().notif && A.best && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('SportPredict AI — pari validé', { body: `${A.best.match} · ${A.best.label} @ ${A.best.odds}` }); } catch { /* ignore */ }
    }
    if (A.storageOk === false) toast('Stockage du navigateur plein : analyse affichée mais non enregistrée. Faites Historique > Exporter puis videz le cache dans Réglages.', 'bad');
    location.hash = '#dashboard';
  }

  // ------------------------------------------------------------ composants
  function statusPills() {
    const st = D.apiStatus, C = P.cfg();
    const pill = (name, s, extra = '') => `<span class="pill ${s == null ? 'p-idle' : s.ok ? 'p-ok' : 'p-bad'}" title="${esc(s?.msg || 'pas encore appelé')}">${esc(name)}${extra}</span>`;
    return `<div class="pills">
      ${pill('The Odds API', C.oddsKey ? st['The Odds API'] : { ok: false, msg: 'clé manquante' }, st['The Odds API']?.remaining != null ? ` · ${st['The Odds API'].remaining} crédits` : '')}
      ${pill('ESPN', st.ESPN)}
      ${pill('Données quotidiennes', st['Données quotidiennes'], st['Données quotidiennes']?.at ? ` · ${ago(st['Données quotidiennes'].at)}` : '')}
      ${C.claudeKey ? pill('Claude', st.Claude) : '<span class="pill p-idle" title="facultatif">Claude : non configuré</span>'}
      <span class="pill ${running ? 'p-run' : 'p-ok'}">Moteur ${running ? 'en analyse' : 'prêt'} · ${esc(SP.version)}</span></div>`;
  }
  function pickCard(p, big) {
    const parts = (p.scoreParts || []).map((x) => `<div class="sp"><span>${esc(x.name)}</span><span class="bar"><i style="width:${x.pts / x.max * 100}%"></i></span><b>${x.pts.toFixed(0)}/${x.max}</b><small>${esc(x.why)}</small></div>`).join('');
    const models = (p.models || []).map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${m.p1x2 ? m.p1x2.map((x) => pct(x)).join(' · ') : m.pHome != null ? pct(m.pHome) + (m.margin != null ? ` · marge ${num(m.margin, 1)}` : '') + (m.total != null ? ` · total ${num(m.total, 1)}` : '') : m.pA != null ? pct(m.pA) : m.serveA ? `service ${pct(m.serveA)} / ${pct(m.serveB)}` : '—'}${m.lh ? ` · λ ${num(m.lh)}/${num(m.la)}` : ''}</td></tr>`).join('');
    const scen = (p.scenarios || []).map((s) => `<span class="chip">${esc(s.name)} ${pct(s.weight, 0)} → ${pct(s.p)}</span>`).join('');
    const llm = p.llm ? `<div class="llm"><h4>Analyse des actualités (Claude) — impact : ${esc(p.llm.impact)}</h4><p>${esc(p.llm.resume)}</p>
      ${list('Facteurs favorables', p.llm.facteurs_favorables)}${list('Facteurs défavorables', p.llm.facteurs_defavorables)}${list('Risques', p.llm.risques)}${list('Contradictions', p.llm.contradictions)}</div>` : p.llmError ? `<p class="muted">Analyse Claude indisponible : ${esc(p.llmError)}</p>` : '';
    const news = (p.news || []).length ? `<details><summary>${p.news.length} article(s) relié(s)</summary><ul class="news">${p.news.map((n, i) => `<li><b>[S${i + 1}]</b> ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)} <small>${esc(n.source)} · ${n.published ? dt(Date.parse(n.published)) : 'date inconnue'}</small></li>`).join('')}</ul></details>` : '<p class="muted">Aucun article ESPN relié à ce match.</p>';
    const info = (p.info || []).map((i) => i.kind === 'blessures'
      ? `<li><span class="tag t-${i.status === 'vérifié' ? 'ok' : 'warn'}">${esc(i.status)}</span> Blessures ${esc(i.team)} : ${i.out.length ? 'out ' + esc(i.out.map((x) => x.player).join(', ')) : 'aucun out'}${i.unsure.length ? ' · incertains ' + esc(i.unsure.map((x) => `${x.player} (${x.status})`).join(', ')) : ''} <small>${esc(i.source)}</small></li>`
      : `<li><span class="tag t-${i.status === 'vérifié' ? 'ok' : 'na'}">${esc(i.status)}</span> ${esc(i.note)} <small>${esc(i.source)}</small></li>`).join('');
    return `<article class="card pick ${big ? 'big' : ''}">
      <header><div><span class="sport s-${p.sport}">${SPORT[p.sport]}</span> <span class="muted">${esc(p.comp)}</span>${p.day && p.day !== 'aujourd’hui' ? ` <span class="tag t-warn">${esc(p.day)}</span>` : ''}</div><div class="when">${dt(p.t)}</div></header>
      <h3>${esc(p.match)}</h3>
      <div class="sel"><span class="mk">${MKT[p.market] || p.market}</span><b>${esc(p.label)}</b></div>
      <div class="kpis">
        <div><small>Cote</small><b class="odds">${num(p.odds)}</b><span>${esc(p.book)} · ${ago(p.oddsAt)}${p.bestAny && p.bestAny.price > p.odds ? ` · meilleure ailleurs ${num(p.bestAny.price)} (${esc(p.bestAny.title)})` : ''}</span></div>
        <div><small>Probabilité estimée</small><b>${pct(p.p)}</b><span>${p.ci != null ? `IC95 MC ±${pct(p.ci, 2)}` : ''}${p.pPush ? ` · remb. ${pct(p.pPush)}` : ''}</span></div>
        <div><small>Prob. implicite</small><b>${pct(p.pImplied)}</b><span>marché juste ${pct(p.pMkt)}</span></div>
        <div><small>Edge</small><b class="${p.edge > 0 ? 'pos' : 'neg'}">${sgn(p.edge)}</b><span>incertitude ±${pct(p.uncert)}</span></div>
        <div><small>EV</small><b class="${p.ev > 0 ? 'pos' : 'neg'}">${sgn(p.ev)}</b><span>par unité misée</span></div>
        <div><small>Score qualité</small><b>${p.score}/100</b><span>≠ probabilité</span></div>
        <div><small>Simulations</small><b>${int(p.sims)}</b><span>graine ${p.seed ?? '—'}</span></div>
      </div>
      ${p.cat !== 'watch' ? adviceBox(p) + betBtn({ source: p.cat === 'best' ? 'best' : 'value', eventId: p.eventId, sport: p.sport, sportKey: p.sportKey, comp: p.comp, match: p.match, home: p.home, away: p.away, t: p.t, label: p.label, type: p.type, point: p.point, market: p.market, odds: p.odds, book: p.book, p: p.p, value: true, suggested: advice(p).stake }) : ''}
      ${big ? `<div class="why"><h4>Pourquoi cette sélection</h4><p>${esc(whyText(p))}</p></div>` : ''}
      ${p.warnings?.length ? `<div class="risks"><h4>Risques identifiés</h4><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : `<div class="risks"><h4>Risques identifiés</h4><ul><li>Aucun signal spécifique dans les sources consultées. Le résultat reste aléatoire.</li></ul></div>`}
      <details ${big ? 'open' : ''}><summary>Détail du score de qualité</summary><div class="parts">${parts}</div></details>
      <details><summary>Modèles et scénarios</summary><table class="t">${models}</table><div class="chips">${scen}</div><p class="muted">${esc(p.statsNote || '')} · probabilité de marché : ${esc(p.fairSource || '')}</p></details>
      <details><summary>Cotes relevées (${(p.offers || []).length})</summary><table class="t">${(p.offers || []).map((o) => `<tr><td>${esc(o.title)}</td><td class="n">${num(o.price)}</td><td class="n muted">${ago(o.last)}</td></tr>`).join('')}</table></details>
      <details><summary>Informations et sources</summary><ul class="info">${info || '<li class="muted">Aucune information structurée disponible.</li>'}</ul>${news}</details>
      ${llm}
    </article>`;
  }
  // Consigne en clair : cote minimale à accepter et mise indicative (Kelly fractionné, plafonné).
  function advice(p) {
    const C = P.cfg();
    const minOdds = Math.ceil(((1 + C.minEV - (p.pPush || 0)) / Math.max(1e-6, p.p)) * 100) / 100;
    const k = Math.max(0, (p.p * p.odds + (p.pPush || 0) - 1) / (p.odds - 1));
    const frac = Math.min(C.maxStakePct, C.kellyFrac * k);
    const B = curBank();
    const stake = Math.round(B * frac * 100) / 100;
    return { minOdds, stake, frac, bank: B };
  }
  function adviceBox(p) {
    const a = advice(p);
    return `<div class="advice"><b>En clair :</b> sur ${esc(p.book)}, pariez « ${esc(p.label)} » pour ${esc(p.match)} seulement si la cote affichée est <b>au moins ${num(a.minOdds)}</b> (relevée : ${num(p.odds)}).
      Mise indicative : <b>${num(a.stake)} €</b> (${(a.frac * 100).toFixed(1)} % d’une bankroll de ${int(a.bank)} €, quart de Kelly plafonné). Si la cote a baissé ou si le match a commencé, ne pariez pas.</div>`;
  }
  const eur0 = (x) => x.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  // ---- confiance, mises et exposition (cahier des charges §10 et §15)
  const CONF_TAG = { 'très haute': 't-ok', haute: 't-ok', 'intéressante': 't-warn', moyenne: 't-na', faible: 't-bad' };
  const confTag = (c) => `<span class="tag ${CONF_TAG[c] || 't-na'}">confiance ${esc(c || 'faible')}</span>`;
  // bankroll actuelle = départ + dépôts − retraits + gains − pertes des paris réglés (mise à jour automatique)
  const curBank = () => { try { return SPMyBets.stats().bankroll; } catch { return P.cfg().bankroll; } };
  const atRisk = () => { try { return SPMyBets.stats().atRisk; } catch { return 0; } };
  // Mise indicative : très haute 1–2 %, haute ≤ 1 %, value = quart de Kelly plafonné, sans avantage démontré = 0.
  // Réduite si l'incertitude est forte ; plafond strict : 15 % de la bankroll exposée au total.
  // MISES (v3) — très haute + value confirmée : 1 % ; très haute : 0,75 % ; haute : 0,75 % ; intéressante : 0,5 % ;
  // moyenne : aucune ; faible : rejet. Plafond strict 1 % par sélection. Quart de Kelly en indicateur (sans dépasser).
  // EV négative ou insuffisante : 0. Exposition : alerte 5 %, plafond strict 5 %. Un seul pari par match.
  function stakeInfo({ conf, kind, p, odds, pPush, uncert, verify, eventId, fallback }) {
    const C = P.cfg(), B = curBank();
    const ev = odds != null ? p * odds + (pPush || 0) - 1 : null;
    let pct0 = 0, why = '';
    const pend = (() => { try { return SPMyBets.bets().filter((b) => b.status === 'en attente'); } catch { return []; } })();
    if (eventId && pend.some((b) => b.eventId === eventId)) why = 'aucune mise : vous avez déjà un pari en cours sur ce match';
    else if (fallback && (verify || (ev != null && ev > -0.06))) { pct0 = conf === 'faible' ? 0.0015 : 0.0025; why = `meilleur pari disponible (confiance ${conf}) : mise réduite à ${(pct0 * 100).toFixed(2).replace(/\.?0+$/, '')} %${verify ? ', seulement si la cote Winamax atteint le minimum indiqué' : ''}`; }
    else if (conf === 'faible') why = 'rejet : confiance faible';
    else if (conf === 'moyenne') why = 'aucune mise recommandée : confiance moyenne';
    else if (!verify && (ev == null || ev < 0.01)) why = 'aucune mise : espérance de gain négative ou insuffisante à cette cote';
    else {
      pct0 = conf === 'très haute' ? (kind === 'value' ? 0.01 : 0.0075) : conf === 'haute' ? 0.0075 : conf === 'intéressante' ? 0.005 : 0;
      why = `confiance ${conf} : ${(pct0 * 100).toFixed(2).replace(/\.?0+$/, '')} % maximum`;
      if (ev != null && odds > 1) { const kq = C.kellyFrac * ev / (odds - 1); if (kq > 0 && kq < pct0) { pct0 = kq; why += ' · limitée par le quart de Kelly'; } }
      if (verify) why += ', seulement si la cote Winamax atteint le minimum indiqué';
    }
    if (pct0 > 0 && (uncert ?? 0) > 0.04) { pct0 *= 0.5; why += ' · réduite de moitié (incertitude forte)'; }
    pct0 = Math.min(pct0, 0.01);
    let stake = Math.round(B * pct0 * 100) / 100;
    const room = Math.max(0, 0.05 * B - atRisk());
    if (stake > room) { stake = Math.round(room * 100) / 100; why += ' · limitée par le plafond d’exposition de 5 %'; }
    const expo = (atRisk() + stake) / Math.max(1e-9, B);
    return { stake, pct: B ? stake / B : 0, why, gain: odds != null ? stake * (odds - 1) : null, loss: stake, expo, bank: B };
  }
  // cote minimale acceptable : intègre l'incertitude (borne basse de la probabilité) et la marge de sécurité
  const minAcceptable = (p, uncert, pPush) => Math.ceil(((1 + P.cfg().minEV - (pPush || 0)) / Math.max(0.01, p - (uncert || 0))) * 100) / 100;

  function safeList(A) {
    const L = (A.safe || []).filter((s) => (!A.daily || s.eventId !== A.daily.eventId) && SP.CONF_RANK[s.conf] >= 3);
    if (!L.length) return '';
    return `<section class="card"><h3>Autres paris à haute probabilité</h3><p class="muted">Probabilité ≥ ${(P.cfg().safeMinP * 100).toFixed(0)} %. Seuls ceux en confiance haute ou très haute et avec un avantage reçoivent une mise. Ne les combinez pas.</p>
      <div class="tw"><table class="t"><tbody>${L.map((s) => { const si = stakeInfo({ conf: s.conf, kind: 'sûr', p: s.p, odds: s.odds, pPush: s.pPush, uncert: s.uncert, verify: s.toVerify, eventId: s.eventId });
        return `<tr><td><b>${esc(s.match)}</b><br><small class="muted">${dt(s.t)} · ${esc(s.comp)}</small></td><td>${esc(s.label)}</td><td class="n">${s.odds != null ? num(s.odds) : `≥ ${num(minAcceptable(s.p, s.uncert, s.pPush))}`}</td><td class="n">${pct(s.p)}</td><td>${confTag(s.conf)}${s.toVerify ? ' <span class="tag t-warn">cote à vérifier</span>' : s.tier !== 1 ? ' <span class="tag t-na">sans avantage</span>' : ''}</td><td class="n">${num(si.stake)} €</td><td>${si.stake > 0 ? betBtn({ source: 'safe', ...s, conf: s.conf, suggested: si.stake }) : ''}</td></tr>`; }).join('')}</tbody></table></div></section>`;
  }
  function dailyCard(A) {
    const d = A.daily;
    if (!d && !A.counts?.analysed) {
      const cs = SPCredits.state(P.cfg()), cov = A.coverage || {};
      const why = [];
      if (cs.remaining <= 0) why.push(`vos crédits The Odds API du mois sont épuisés (${cs.used} utilisés) : ils se rechargent le 1er du mois`);
      else if (cov.overBudget?.length) why.push(`${cov.overBudget.length} compétition(s) non interrogée(s) faute de crédits (${cs.remaining} restants, réserve ${cs.reserve})`);
      if (cov.scanned === 0) why.push('aucune compétition de football ou de tennis active dans les 48 h');
      for (const e of (A.errors || []).slice(0, 4)) why.push(e);
      return `<section class="card nobet"><h3>AUCUN MATCH N’A PU ÊTRE ANALYSÉ</h3><p>L’analyse n’a récupéré aucune cote, donc aucun pari ne peut être proposé. Raison${why.length > 1 ? 's' : ''} :</p><ul>${why.map((w) => `<li>${esc(w)}</li>`).join('') || '<li>inconnue : ouvrez « Détails de l’analyse » plus bas</li>'}</ul><p><a href="#credits">Voir la gestion des crédits ›</a></p></section>`;
    }
    if (!d) return `<section class="card nobet"><h3>AUCUNE SÉLECTION SUFFISAMMENT FIABLE</h3><p>Tous les matchs et marchés disponibles ont été explorés : aucun ne réunit une confiance suffisante et une cote acceptable. Ne rien parier aujourd’hui est une bonne décision.</p>
      ${A.dailyAlt ? `<p class="muted">Pour information seulement (confiance ${esc(A.dailyAlt.conf)}, non recommandé) : ${esc(A.dailyAlt.match)} · ${esc(A.dailyAlt.label)} · ${pct(A.dailyAlt.p)}</p>` : ''}</section>`;
    const pk = d.pick, u = d.uncert ?? 0.03;
    const si = stakeInfo({ conf: d.confidence, kind: d.kind === 'value' ? 'value' : 'sûr', p: pk.p, odds: pk.odds, pPush: pk.pPush, uncert: u, verify: pk.odds == null, eventId: d.eventId, fallback: d.status === 'meilleur disponible' });
    const minOk = minAcceptable(pk.p, u, pk.pPush);
    const lo = Math.max(0, pk.p - 1.96 * u), hi = Math.min(1, pk.p + 1.96 * u);
    const lvlTag = d.level === 'bon' ? '<span class="tag t-ok">bon pronostic</span>' : d.level === 'correct' ? '<span class="tag t-warn">pronostic correct</span>' : d.level === 'prudent' ? '<span class="tag t-na">pronostic prudent</span>' : '';
    const kindTag = lvlTag + ({ 'sûr-verif': '<span class="tag t-warn">cote à vérifier sur Winamax</span>', 'sûr': '<span class="tag t-ok">haute probabilité · cote correcte</span>', value: '<span class="tag t-ok">VALUE</span>' }[d.kind] || '');
    const up = d.uncParts;
    return `<section class="card pick big daily">
      <div class="eyebrow">PRONOSTIC DU JOUR · ${d.status === 'prioritaire' ? 'PARI PRIORITAIRE' : d.status === 'alternatif' ? 'PARI ALTERNATIF' : 'MEILLEUR PARI DISPONIBLE'}</div>
      <p class="headline"><b>${esc(d.verdict || '')}</b>${d.status === 'alternatif' ? ' <span class="tag t-warn">non recommandé automatiquement à la mise</span>' : d.status === 'meilleur disponible' ? ' <span class="tag t-warn">aucun pari très fiable aujourd’hui : c’est le plus solide trouvé</span>' : ''}</p>
      <header><div><span class="sport s-${d.sport}">${SPORT[d.sport]}</span> <span class="muted">${esc(d.comp)}</span></div><div class="when">${dt(d.t)}</div></header>
      <h3>${esc(d.match)}</h3>
      <div class="sel"><span class="mk">${MKT[pk.market] || 'marché calculé'}</span><b>${esc(pk.label)}</b> ${kindTag} ${confTag(d.confidence)}${pk.nearThreshold ? ' <span class="tag t-warn">proche du seuil</span>' : ''}</div>
      <div class="kpis">
        ${pk.odds == null ? `<div><small>Cote Winamax</small><b class="odds">≥ ${num(minOk)}</b><span>non fournie par l’API : à vérifier</span></div>` : `<div><small>Cote ${esc(pk.book)}</small><b class="odds">${num(pk.odds)}</b><span>relevée ${d.oddsAt ? ago(d.oddsAt) : '—'}</span></div>`}
        <div><small>Probabilité estimée</small><b>${pct(pk.p)}</b><span>intervalle ${pct(lo)} – ${pct(hi)}</span></div>
        <div><small>Cote juste</small><b>${num((1 - (pk.pPush || 0)) / pk.p)}</b><span>minimum acceptable ${num(minOk)}</span></div>
        <div><small>EV</small><b class="${pk.ev > 0 ? 'pos' : 'neg'}">${pk.odds == null ? '—' : sgn(pk.ev)}</b><span>edge vs marché sans marge ${d.edge != null ? sgn(d.edge) : '—'}</span></div>
        <div><small>Score de qualité</small><b>${d.quality ? d.quality.total + '/100' : '—'}</b><span>${d.quality ? '≠ probabilité' : 'calculé quand la cote est connue'}</span></div>
        <div><small>Fiabilité du modèle</small><b>${d.reliability ? d.reliability.total + '/100' : '—'}</b><span>données, historique, stabilité</span></div>
        <div><small>Mise indicative</small><b>${num(si.stake)} €</b><span>${(si.pct * 100).toFixed(1)} % de ${eur0(si.bank)}</span></div>
        <div><small>Gain potentiel / perte max</small><b>${si.gain != null ? '+' + num(si.gain) : '—'} / −${num(si.loss)} €</b><span>exposition totale ${(si.expo * 100).toFixed(0)} %</span></div>
      </div>
      <p class="muted"><small>Mise : ${esc(si.why)}.</small></p>
      ${si.expo > 0.05 ? `<p class="notice">Plus de 5 % de votre bankroll serait exposée en même temps (plafond strict : 5 %).</p>` : ''}
      ${d.opinion ? `<div class="advice"><b>Mon avis :</b> ${esc(d.opinion.verdict)}${d.opinion.pour.length ? `<br><b>Pour :</b> ${d.opinion.pour.map(esc).join(' ')}` : ''}${d.opinion.contre.length ? `<br><b>Contre :</b> ${d.opinion.contre.map(esc).join(' ')}` : ''}<br><b>${esc(d.opinion.conseil)}</b></div>` : ''}
      ${matchSheet(d.card, d.home, d.away)}
      <h4>Explication statistique</h4><ul>${d.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      ${d.warnings?.length ? `<h4>Risques</h4><ul>${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<h4>Risques</h4><ul><li>Aucun signal particulier dans les sources consultées. Le résultat reste aléatoire.</li></ul>'}
      ${up ? `<details><summary>Incertitude détaillée</summary><ul><li>Hasard des simulations : ±${pct(up.hasard, 1)}</li><li>Paramètres du modèle : ±${pct(up.parametres, 1)}</li><li>Qualité des données : ±${pct(up.donnees, 1)}</li><li>Informations sportives : ±${pct(up.informations, 1)}</li></ul></details>` : ''}
      ${d.quality ? `<details><summary>Score de qualité : les 8 composantes</summary><div class="parts">${d.quality.parts.map((x) => `<div class="sp"><span>${esc(x.name)}</span><span class="bar"><i style="width:${x.pts / x.max * 100}%"></i></span><b>${x.pts.toFixed(0)}/${x.max}</b><small>${esc(x.why)}</small></div>`).join('')}</div></details>` : ''}
      <p class="muted"><small>Sources : ${esc(d.dataNote || '')} · cotes The Odds API.</small></p>
      ${si.stake > 0 ? betBtn({ source: 'daily', eventId: d.eventId, sport: d.sport, sportKey: d.sportKey, comp: d.comp, match: d.match, home: d.home, away: d.away, t: d.t, label: pk.label, type: pk.type, point: pk.point, market: pk.market, odds: pk.odds, book: pk.book, p: pk.p, value: pk.value, conf: d.confidence, suggested: si.stake }) : ''}
      ${d.status === 'meilleur disponible' && A.dailyBackups?.length ? `<h4>Si ce pari n’est pas proposé sur Winamax</h4><ul>${A.dailyBackups.map((x) => `<li><b>${esc(x.match)}</b> <small class="muted">${esc(x.comp)} · ${dt(x.t)}</small><br>${esc(x.label)} · ${x.odds != null ? '@ ' + num(x.odds) + ' (cote Winamax relevée)' : 'à jouer si cote ≥ ' + num(x.minOdds)} · ${pct(x.p)} · confiance ${esc(x.conf)}</li>`).join('')}</ul>` : ''}
      <p class="muted"><small>Vérifiez la cote sur Winamax avant de parier ; si elle est sous ${num(minOk)} ou si le match a commencé, abstenez-vous.</small></p>
    </section>`;
  }
  function safeStake(kind, p, odds, pPush) { return stakeInfo({ conf: 'haute', kind: kind === 'value' ? 'value' : 'sûr', p, odds, pPush, uncert: 0.03, verify: odds == null }).stake; }
  const BETDRAFTS = new Map();
  function betBtn(d) {
    const id = 'd' + BETDRAFTS.size;
    BETDRAFTS.set(id, d);
    return `<button class="btn-sec betbtn" data-bet="${id}">J’ai parié</button>`;
  }
  function stakeFor(p, odds, pPush) {
    const C = P.cfg();
    const k = Math.max(0, (p * odds + (pPush || 0) - 1) / (odds - 1));
    return Math.round(C.bankroll * Math.min(C.maxStakePct, C.kellyFrac * k) * 100) / 100;
  }
  function creditsPage() {
    const C = P.cfg(), st = SPCredits.state(C), A = S.lastAnalysis();
    const k = (l, v, s, cls = '') => `<div class="kpi"><small>${l}</small><b class="${cls}">${v}</b>${s ? `<span>${s}</span>` : ''}</div>`;
    const est = (A?.coverage?.queried || 0) * 3;
    return `<h2>Gestion des crédits</h2>
      ${st.alert80 ? '<p class="notice">Plus de 80 % des crédits du mois sont consommés : analyses espacées conseillées.</p>' : ''}
      <div class="kpirow">
        ${k('Budget mensuel', st.budget, 'offre gratuite The Odds API')}
        ${k('Consommés', st.used, st.measured ? 'compteur officiel de l’API' : 'estimation locale', st.alert80 ? 'neg' : '')}
        ${k('Restants', st.remaining, `réserve protégée : ${st.reserve}`)}
        ${k('Prochaine analyse', '≈ ' + est, 'selon la dernière analyse (3 par compétition)')}
        ${k('Appels évités', st.avoided, 'grâce au cache')}
        ${k('Football / tennis', `${st.byGroup.football || 0} / ${st.byGroup.tennis || 0}`, 'crédits ce mois')}
      </div>
      <section class="card"><h3>Règles appliquées</h3><ul>
        <li>La liste des compétitions et des matchs est gratuite ; seules les compétitions ayant au moins un match avec un score de pertinence ≥ ${C.prescanMin} sont interrogées.</li>
        <li>Budget par analyse : ${C.creditBudget} crédits. Un appel est bloqué s’il entamerait la réserve de ${st.reserve} crédits.</li>
        <li>Les cotes déjà récupérées depuis moins de 10 minutes sont réutilisées sans consommer de crédit.</li>
      </ul></section>
      <section class="card"><h3>Historique des appels payants (ce mois)</h3><div class="tw"><table class="t"><thead><tr><th>Date</th><th>Compétition</th><th>Sport</th><th>Coût</th></tr></thead><tbody>
        ${st.calls.slice().reverse().map((c) => `<tr><td>${dt(c.t)}</td><td>${esc(c.title || c.key)}</td><td>${esc(c.group || '')}</td><td class="n">${c.cost}${c.measured ? '' : ' (estimé)'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun appel payant ce mois-ci.</td></tr>'}
      </tbody></table></div></section>
      ${A?.prescan ? `<section class="card"><h3>Présélection gratuite de la dernière analyse</h3><div class="tw"><table class="t"><thead><tr><th>Match</th><th>Score</th><th>Catégorie</th></tr></thead><tbody>${A.prescan.slice(0, 40).map((m) => `<tr><td>${esc(m.home)} – ${esc(m.away)}<br><small class="muted">${esc(m.comp)}${m.note ? ' · ' + esc(m.note) : ''}</small></td><td class="n">${m.score}</td><td>${esc(m.category)}</td></tr>`).join('')}</tbody></table></div><p class="muted">Ce score mesure l’intérêt d’analyser un match (données, potentiel des marchés, stabilité) ; ce n’est jamais une probabilité de réussite.</p></section>` : ''}`;
  }
  function backtestTable(bt) {
    return bt && Object.keys(bt).length ? `<div class="tw"><table class="t"><thead><tr><th>Compétition</th><th>Matchs testés</th><th>Log loss par modèle</th><th>Ensemble</th><th>Naïf</th><th>Poids</th></tr></thead><tbody>${Object.entries(bt).map(([n, b]) => `<tr><td>${esc(n)}</td><td class="n">${b.n}</td><td>${Object.entries(b.models).map(([mm, v]) => `${mm} ${num(v.logLoss, 4)}`).join(' · ')}</td><td class="n">${num(b.ensemble.logLoss, 4)}</td><td class="n">${b.naive ? num(b.naive.logLoss, 4) : '—'}</td><td>${Object.entries(b.weights).map(([mm, w]) => `${mm} ${(+w).toFixed(2)}`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Aucun backtest disponible (lancez une analyse).</p>';
  }
  function formChips(fm) {
    if (!fm) return '<span class="muted">forme indisponible</span>';
    return `<span class="form" title="du plus ancien au plus récent (à droite)">${fm.seq.split('').map((r) => `<i class="r-${r}">${r}</i>`).join('')}</span> <small class="muted">${num(fm.gf, 1)} marqués / ${num(fm.ga, 1)} encaissés${fm.xgf != null ? ` · xG ${num(fm.xgf, 2)} / ${num(fm.xga, 2)}` : ''}</small>`;
  }
  const kOdds = (k) => (k.odds != null ? '@ ' + num(k.odds) : '(jouer si ≥ ' + num(k.minOdds) + ')');
  function exploreBlock(x) {
    const line = (lab, k) => (k ? `<li><b>${lab} :</b> ${esc(k.label)} ${kOdds(k)} · ${pct(k.p)}${k.ev != null ? ' · EV ' + sgn(k.ev) : ''} · ${esc(k.conf)}${k.cat === 'prioritaire' ? ' <span class="tag t-ok">prioritaire</span>' : ''}</li>` : '');
    return `<details open><summary>${x.n} marchés explorés</summary><ul>
      ${line('Probabilité la plus élevée', x.bestProb)}${line('Meilleure value', x.bestValue)}${line('Meilleur équilibre', x.bestBalance)}</ul>
      ${x.alternatives.length ? `<h5>Alternatives</h5><ul>${x.alternatives.map((k) => `<li>${esc(k.label)} ${kOdds(k)} · ${pct(k.p)} · ${esc(k.conf)}</li>`).join('')}</ul>` : ''}
      ${x.avoid.length ? `<h5>À éviter</h5><ul class="muted">${x.avoid.map((k) => `<li>${esc(k.label)} ${kOdds(k)} · ${pct(k.p)} — ${esc(k.why || '')}</li>`).join('')}</ul>` : ''}</details>`;
  }
  let A_DAILY_ID = null;

  // fiche du match : les faits concrets (FotMob, Elo, statistiques de service) derrière le pronostic
  const mval = (v) => (v >= 1e6 ? (v / 1e6).toFixed(v >= 1e8 ? 0 : 1).replace('.', ',') + ' M€' : v >= 1e3 ? Math.round(v / 1e3) + ' k€' : '—');
  function matchSheet(c, home, away) {
    if (!c) return '';
    const rows = [];
    const row = (lab, h, a2) => rows.push(`<tr><th>${lab}</th><td>${h}</td><td>${a2}</td></tr>`);
    if (c.tennis) {
      const A2 = c.a || {}, B = c.b || {};
      row(`Elo ${esc(c.surface)}`, A2.elo ? Math.round(A2.elo) + (A2.eloRank ? ` <small class="muted">(${A2.eloRank}e)</small>` : '') : '—', B.elo ? Math.round(B.elo) + (B.eloRank ? ` <small class="muted">(${B.eloRank}e)</small>` : '') : '—');
      row('Bilan 12 mois', A2.rec ? `${A2.rec[0]}/${A2.rec[1]}` : '—', B.rec ? `${B.rec[0]}/${B.rec[1]}` : '—');
      row(`Bilan ${esc(c.surface)}`, A2.recSurf ? `${A2.recSurf[1]}/${A2.recSurf[0]}` : '—', B.recSurf ? `${B.recSurf[1]}/${B.recSurf[0]}` : '—');
      row('Points gagnés au service', A2.spw ? pct(A2.spw, 0) : '—', B.spw ? pct(B.spw, 0) : '—');
      row('Points gagnés en retour', A2.rpw ? pct(A2.rpw, 0) : '—', B.rpw ? pct(B.rpw, 0) : '—');
      return `<details class="sheet" open><summary>Fiche du match</summary><div class="tw"><table class="t"><thead><tr><th></th><th>${esc(home)}</th><th>${esc(away)}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
        <p class="muted"><small>Moyenne du circuit : ${pct(c.avg?.spw, 0)} au service. Sources : Tennis Abstract (Elo), TennisMyLife (résultats et statistiques).</small></p></details>`;
    }
    if (c.elo?.home && c.elo?.away) row('Elo mondial', `${c.elo.home.elo} <small class="muted">(${c.elo.home.rank}e)</small>`, `${c.elo.away.elo} <small class="muted">(${c.elo.away.rank}e)</small>`);
    if (c.fifaRank) row('Classement FIFA', c.fifaRank[0] || '—', c.fifaRank[1] || '—');
    if (c.form?.home || c.form?.away) { const ch = (s) => (s ? `<span class="form">${s.split('').map((r) => `<i class="r-${r}">${r}</i>`).join('')}</span>` : '—'); row('Forme (ancien → récent)', ch(c.form.home), ch(c.form.away)); }
    if (c.home || c.away) {
      row('Valeur du onze ' + (c.lineupType ? `<small class="muted">(${esc(c.lineupType)})</small>` : ''), c.home?.value ? mval(c.home.value) : '—', c.away?.value ? mval(c.away.value) : '—');
      const abs = (t) => (t?.unavailable?.length ? t.unavailable.slice(0, 5).map((p) => `${esc(p.name)} <small class="muted">${esc(p.type)}${p.value ? ', ' + mval(p.value) : ''}</small>`).join('<br>') + (t.nUnavailable > 5 ? `<br><small class="muted">+${t.nUnavailable - 5}</small>` : '') : 'aucun connu');
      row('Absents', abs(c.home), abs(c.away));
      if (c.home?.formation || c.away?.formation) row('Système', esc(c.home?.formation || '—'), esc(c.away?.formation || '—'));
    }
    if (c.topScorers?.some(Boolean)) row('Meilleur buteur', c.topScorers[0] ? `${esc(c.topScorers[0].name)} <small class="muted">(${c.topScorers[0].goals ?? 0} but(s))</small>` : '—', c.topScorers[1] ? `${esc(c.topScorers[1].name)} <small class="muted">(${c.topScorers[1].goals ?? 0} but(s))</small>` : '—');
    const extra = [];
    if (c.h2h) extra.push(`<li><b>Confrontations directes :</b> ${c.h2h.home} victoire(s) ${esc(home)}, ${c.h2h.draw} nul(s), ${c.h2h.away} victoire(s) ${esc(away)}${c.h2h.last?.length ? ` <small class="muted">(${c.h2h.last.map(esc).join(' · ')})</small>` : ''}</li>`);
    for (const x of c.insights || []) extra.push(`<li>${x.side ? `<b>${esc(x.side === 'home' ? home : away)} :</b> ` : ''}${esc(x.text)}</li>`);
    if (c.weather) extra.push(`<li><b>Météo :</b> ${esc(c.weather.desc || '')} ${c.weather.temp != null ? c.weather.temp + ' °C' : ''} · pluie ${c.weather.rain ?? '—'} % · vent ${c.weather.wind ?? '—'} km/h</li>`);
    if (c.referee || c.stadium) extra.push(`<li>${c.referee ? `<b>Arbitre :</b> ${esc(c.referee)}` : ''}${c.referee && c.stadium ? ' · ' : ''}${c.stadium ? `<b>Stade :</b> ${esc(c.stadium)}` : ''}</li>`);
    if (!rows.length && !extra.length) return '';
    return `<details class="sheet" open><summary>Fiche du match</summary>${rows.length ? `<div class="tw"><table class="t"><thead><tr><th></th><th>${esc(home)}</th><th>${esc(away)}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : ''}${extra.length ? `<ul>${extra.join('')}</ul>` : ''}
      <p class="muted"><small>Sources : FotMob (compositions, absents, forme, tendances), eloratings.net (sélections). ${c.lineupType === 'officielle' ? 'Compositions officielles.' : 'Compositions probables : à revérifier 1 h avant le match.'}</small></p></details>`;
  }
  function pronoCard(f) {
    const pr = f.probs || {};
    const bar = f.sport === 'football'
      ? `<div class="pbar3"><i style="width:${pr.home * 100}%" title="1"></i><i style="width:${pr.draw * 100}%" title="N"></i><i style="width:${pr.away * 100}%" title="2"></i></div><div class="pl3"><span>1 ${pct(pr.home, 0)}</span><span>N ${pct(pr.draw, 0)}</span><span>2 ${pct(pr.away, 0)}</span></div>`
      : `<div class="pbar3"><i style="width:${pr.home * 100}%"></i><i style="width:0"></i><i style="width:${pr.away * 100}%"></i></div><div class="pl3"><span>${pct(pr.home, 0)}</span><span></span><span>${pct(pr.away, 0)}</span></div>`;
    const [hn, an] = f.match.split(' – ');
    return `<article class="card prono">
      <header><div><span class="sport s-${f.sport}">${SPORT[f.sport]}</span> <span class="muted">${esc(f.comp)}</span></div><div class="when">${dt(f.t)}</div></header>
      <h3>${esc(f.match)}</h3>
      <p class="headline"><b>${esc(f.headline)}</b> <span class="tag t-${f.confidence === 'forte' ? 'ok' : f.confidence === 'moyenne' ? 'warn' : 'na'}">confiance ${esc(f.confidence)}</span></p>
      ${bar}
      ${f.sport === 'football' ? `<p class="muted">Score le plus probable <b>${f.score.h}-${f.score.a}</b> (${pct(f.score.p, 0)}) · buts attendus ${num(f.expected.home, 2)} – ${num(f.expected.away, 2)} · +2,5 buts ${pct(f.probs.over25, 0)} · les deux marquent ${pct(f.probs.btts, 0)}</p>` : ''}
      ${f.sport === 'hockey' ? `<p class="muted">Score le plus probable <b>${f.score.h}-${f.score.a}</b> (prolongation incluse) · buts attendus ${num(f.expected.home, 1)} – ${num(f.expected.away, 1)} · prolongation ${pct(f.probs.regDraw)}</p>` : ''}
      ${f.sport === 'nba' ? `<p class="muted">Score projeté <b>${Math.round(f.expected.home)}-${Math.round(f.expected.away)}</b> · total attendu ${num(f.expected.total, 1)} points</p>` : ''}
      ${matchSheet(f.card, hn, an)}
      ${f.form && !f.card?.form ? `<div class="formrow"><div><small>${esc(hn)}</small>${formChips(f.form.home)}</div><div><small>${esc(an)}</small>${formChips(f.form.away)}</div></div>` : ''}
      ${f.explore ? exploreBlock(f.explore) : ''}
      ${f.pick ? `<div class="advice"><b>Pari le plus probable :</b> ${esc(f.pick.label)} @ <b>${num(f.pick.odds)}</b> (${esc(f.pick.book)}) — probabilité ${pct(f.pick.p)}, EV ${sgn(f.pick.ev)} ${f.pick.value ? '<span class="tag t-ok">VALUE</span>' : '<span class="tag t-na">pas de value</span>'}</div>${betBtn({ source: 'prono', eventId: f.eventId, sport: f.sport, sportKey: f.sportKey, comp: f.comp, match: f.match, home: f.home, away: f.away, t: f.t, label: f.pick.label, type: f.pick.type, point: f.pick.point, market: f.pick.market, odds: f.pick.odds, book: f.pick.book, p: f.pick.p, value: f.pick.value, suggested: f.pick.value ? stakeFor(f.pick.p, f.pick.odds, f.pick.pPush) : null })}` : ''}
      ${f.excluded ? `<p class="notice"><small>Pas retenu comme pronostic du jour : ${esc(f.excluded)}.</small></p>` : (A_DAILY_ID === f.eventId ? '<p><span class="tag t-ok">pronostic du jour</span></p>' : '')}
      ${f.facts?.length ? `<ul class="muted">${f.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${f.markets ? `<details><summary>Tous les marchés (${f.markets.length})</summary><div class="tw"><table class="t"><thead><tr><th>Pari</th><th>Prob.</th><th>Cote juste</th><th>Jouer si ≥</th><th>Winamax</th></tr></thead><tbody>
        ${f.markets.map((m) => `<tr><td>${esc(m.label)}${m.risky ? ' <span class="tag t-warn">risqué</span>' : m.p >= P.cfg().safeMinP && m.minSafe >= P.cfg().minOdds ? ' <span class="tag t-ok">sûr</span>' : ''}</td><td class="n">${pct(m.p, 0)}${m.pPush ? ` <small class="muted">(remb. ${pct(m.pPush, 0)})</small>` : ''}</td><td class="n">${num(m.fair)}</td><td class="n">${num(m.p >= P.cfg().safeMinP && !m.risky ? m.minSafe : m.minValue)}</td><td class="n">${m.real ? `${num(m.real.odds)} <span class="${m.ev >= 0 ? 'pos' : 'neg'}">${sgn(m.ev)}</span>` : '<small class="muted">à vérifier</small>'}</td></tr>`).join('')}
        </tbody></table></div><p class="muted"><small>« Jouer si ≥ » : cote minimale à accepter sur Winamax (paris sûrs : jusqu’à ${Math.abs(P.cfg().safeTolEV * 100).toFixed(0)} % sous la cote juste ; autres : ${(P.cfg().minEV * 100).toFixed(0)} % au-dessus). Pour une cote précise, utilisez « Vérifier une cote ».</small></p></details>` : ''}
      ${f.scorers?.length ? `<details><summary>Buteurs (risqué)</summary><div class="tw"><table class="t"><thead><tr><th>Joueur</th><th>Buts saison</th><th>Prob. de marquer</th><th>Cote juste</th></tr></thead><tbody>${f.scorers.map((s) => `<tr><td>${esc(s.name)} <small class="muted">${esc(s.team)}</small></td><td class="n">${s.goals}</td><td class="n">${pct(s.p, 0)}</td><td class="n">${num(1 / s.p)}</td></tr>`).join('')}</tbody></table></div><p class="muted"><small>Estimation à partir des buts de la saison (ESPN) et des buts attendus du match, en supposant que le joueur est titulaire. Jamais proposé en pari sûr : un buteur reste très aléatoire.</small></p></details>` : ''}
      <p class="muted"><small>${esc(f.dataNote || '')}</small></p>
    </article>`;
  }
  function list(t, a) { return a?.length ? `<h5>${esc(t)}</h5><ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''; }
  function whyText(p) {
    const bits = [];
    bits.push(`Le modèle estime ${pct(p.p)} contre ${pct(p.pImplied)} implicite à ${num(p.odds)} chez ${p.book}, soit une EV théorique de ${sgn(p.ev)}.`);
    if (p.pMkt != null) bits.push(`La probabilité « juste » du marché (${p.fairSource}) est ${pct(p.pMkt)} : la cote proposée est donc au-dessus du prix juste.`);
    if (p.pStats != null) bits.push(`Le modèle statistique indépendant donne ${pct(p.pStats)} (écart ${pct(p.modelGap)} avec le marché).`);
    else bits.push('Aucun modèle statistique indépendant n’est disponible ici : la value repose sur la comparaison des bookmakers.');
    bits.push(`Retenue devant les autres pour son score de qualité ${p.score}/100, qui combine value rapportée à l’incertitude, accord des modèles, qualité des données, fraîcheur des cotes et risques.`);
    return bits.join(' ');
  }

  // ------------------------------------------------------------ pages
  const pages = {
    check() { return SPChecker.render(); },
    bets() { return SPMyBets.render(); },
    safe() {
      const A = S.lastAnalysis(); if (!A) return emptyRun();
      const L = A.safe || [];
      return `<h2>Paris haute confiance</h2><p class="muted">Sélections à probabilité élevée (≥ ${(P.cfg().safeMinP * 100).toFixed(0)} %). Seules celles en confiance <b>haute</b> ou <b>très haute</b>, avec un avantage à la cote Winamax, reçoivent une mise. Repères : très haute ≥ 85 %, haute 78–84 %, intéressante 70–77 % (avec données solides et modèles d’accord) ; ce sont des repères, pas des garanties.</p>
        ${L.length ? `<div class="tw"><table class="t"><thead><tr><th>Match</th><th>Pari</th><th>Cote</th><th>Prob.</th><th>Confiance</th><th>Fiabilité</th><th>Mise</th><th></th></tr></thead><tbody>${L.map((s) => { const si = stakeInfo({ conf: s.conf, kind: 'sûr', p: s.p, odds: s.odds, pPush: s.pPush, uncert: s.uncert, verify: s.toVerify, eventId: s.eventId }); return `<tr><td><b>${esc(s.match)}</b><br><small class="muted">${dt(s.t)} · ${esc(s.comp)}</small></td><td>${esc(s.label)}</td><td class="n">${s.odds != null ? num(s.odds) : '≥ ' + num(minAcceptable(s.p, s.uncert, s.pPush))}</td><td class="n">${pct(s.p)}</td><td>${confTag(s.conf)}</td><td class="n">${s.rel ?? '—'}</td><td class="n">${num(si.stake)} €</td><td>${si.stake > 0 ? betBtn({ source: 'safe', ...s, suggested: si.stake }) : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<section class="card empty"><p>Aucune sélection à haute probabilité dans cette analyse.</p></section>'}`;
    },
    backtests() {
      const A = S.lastAnalysis(); const L = D.localCache?.() || {};
      const daily = L.backtest?.leagues;
      return `<h2>Backtests</h2><p class="muted">Validation chronologique : chaque match est prédit uniquement avec les matchs antérieurs, sans aucune donnée future. Log loss : plus bas = meilleur. Les performances passées ne garantissent rien.</p>
        <section class="card"><h3>Dernière analyse</h3>${backtestTable(A?.backtests)}</section>
        ${daily ? `<section class="card"><h3>Backtest quotidien sur données réelles (${esc(new Date(L.backtest.generatedAt).toLocaleDateString('fr-FR'))})</h3><div class="tw"><table class="t"><thead><tr><th>Championnat</th><th>Matchs</th><th>Naïf</th><th>Modèles</th><th>Ensemble</th><th>Marché</th><th>Poids marché</th></tr></thead><tbody>${Object.entries(daily).map(([k, v]) => `<tr><td>${esc(D.FOOTBALL[k]?.name || k)}</td><td class="n">${v.n}</td><td class="n">${num(v.naive, 3)}</td><td>${Object.entries(v.models).map(([m, x]) => `${m} ${num(x, 3)}`).join(' · ')}</td><td class="n">${num(v.ensemble, 3)}</td><td class="n">${v.market != null ? num(v.market, 3) : '—'}</td><td class="n">${v.wMarket ?? '—'}</td></tr>`).join('')}</tbody></table></div></section>` : '<p class="muted">Backtest quotidien indisponible (version hors ligne ou première collecte).</p>'}`;
    },
    models() {
      const A = S.lastAnalysis();
      const rows = Object.entries(A?.backtests || {}).flatMap(([comp, b]) => Object.entries(b.models).map(([m, v]) => {
        const naive = b.naive?.logLoss, gain = naive ? (naive - v.logLoss) / naive : null, w = b.weights?.[m];
        const verdict = gain == null ? 'non mesuré' : gain <= 0 ? 'inutile : ne bat pas le modèle naïf' : w === 0 ? 'battu par les autres modèles (poids 0)' : /march/i.test(m) ? 'référence de marché' : 'utile';
        return `<tr><td>${esc(comp)}</td><td>${esc(m)}</td><td class="n">${b.n}</td><td class="n">${num(v.logLoss, 4)}</td><td class="n">${v.brier != null ? num(v.brier, 4) : '—'}</td><td class="n">${gain != null ? sgn(gain) : '—'}</td><td class="n">${w != null ? w.toFixed(2) : '—'}</td><td>${esc(verdict)}</td></tr>`;
      }));
      const evs = (A?.events || []).filter((e) => !e.skip);
      return `<h2>Fiabilité des modèles</h2><p class="muted">Chaque modèle doit prouver son utilité hors échantillon avant de compter dans les sélections. Un petit échantillon ne prouve rien : regardez le nombre de matchs.</p>
        <section class="card"><div class="tw"><table class="t"><thead><tr><th>Compétition</th><th>Modèle</th><th>Matchs</th><th>Log loss</th><th>Brier</th><th>Gain vs naïf</th><th>Poids</th><th>Verdict</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="8" class="muted">Lancez une analyse.</td></tr>'}</tbody></table></div></section>
        <section class="card"><h3>Données par match (dernière analyse)</h3><div class="tw"><table class="t"><thead><tr><th>Match</th><th>Modèles disponibles</th></tr></thead><tbody>${evs.slice(0, 40).map((e) => `<tr><td>${esc(e.home)} – ${esc(e.away)}<br><small class="muted">${esc(e.comp)}</small></td><td><small>${esc(e.statsNote || '')}</small></td></tr>`).join('')}</tbody></table></div></section>`;
    },
    errors() {
      const E = S.errors();
      const grp = (o, lab) => `<div class="tw"><table class="t"><thead><tr><th>${lab}</th><th>Paris</th><th>Prob. annoncée</th><th>Réussite observée</th><th>Écart</th></tr></thead><tbody>${Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v.n}</td><td class="n">${pct(v.pred)}</td><td class="n">${pct(v.obs)}</td><td>${v.flag ? '<span class="tag t-bad">surestimé (significatif)</span>' : v.n < 15 ? '<span class="tag t-na">échantillon trop petit</span>' : '<span class="tag t-ok">cohérent</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">—</td></tr>'}</tbody></table></div>`;
      return `<h2>Analyse des erreurs</h2><p class="muted">Une défaite isolée ne prouve pas qu’un modèle est mauvais. On cherche les erreurs récurrentes : un groupe est signalé « surestimé » seulement s’il a au moins 15 paris et un écart statistiquement net.</p>
        <p>${E.n} pronostic(s) publié(s) réglé(s).</p>
        <div class="grid2"><section class="card"><h3>Par marché</h3>${grp(E.byMarket, 'Marché')}</section><section class="card"><h3>Par tranche de cotes</h3>${grp(E.byOdds, 'Cotes')}</section>
        <section class="card"><h3>Par niveau de confiance</h3>${grp(E.byConf, 'Confiance')}</section><section class="card"><h3>Par sport</h3>${grp(E.bySport, 'Sport')}</section></div>
        <section class="card"><h3>Pronostics perdus (du plus probable au moins probable)</h3><div class="tw"><table class="t"><thead><tr><th>Match</th><th>Pari</th><th>Prob. annoncée</th><th>Score</th><th>Facteurs connus avant le match</th></tr></thead><tbody>${E.lost.slice(0, 50).map((p) => `<tr><td>${esc(p.match)}<br><small class="muted">${dt(p.t)}</small></td><td>${esc(p.label)} @ ${num(p.odds)}</td><td class="n">${pct(p.p)}</td><td>${esc(p.res.score || '—')}</td><td><small>${esc((p.warnings || []).join(' ; ') || 'aucun signal enregistré')}</small></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun pronostic perdu enregistré.</td></tr>'}</tbody></table></div></section>`;
    },
    health() {
      const A = S.lastAnalysis(), L = D.localCache?.() || {}, st = D.apiStatus;
      const meta = L.meta?.sources || {};
      const row = (n, ok, msg) => `<tr><td>${esc(n)}</td><td>${ok == null ? '<span class="tag t-na">non appelé</span>' : ok ? '<span class="tag t-ok">OK</span>' : '<span class="tag t-bad">erreur</span>'}</td><td><small class="muted">${esc(msg || '')}</small></td></tr>`;
      const evs = (A?.events || []).filter((e) => !e.skip);
      return `<h2>Santé du moteur</h2>
        <div class="kpirow">
          <div class="kpi"><small>Dernière analyse</small><b>${A ? ago(A.finishedAt) : 'jamais'}</b><span>${A ? dt(A.finishedAt) : ''}</span></div>
          <div class="kpi"><small>Données quotidiennes</small><b>${L.meta ? ago(Date.parse(L.meta.generatedAt)) : '—'}</b><span>collecte GitHub</span></div>
          <div class="kpi"><small>Crédits The Odds API</small><b>${st['The Odds API']?.remaining ?? '—'}</b><span>restants ce mois</span></div>
          <div class="kpi"><small>Modèles validés</small><b>${Object.keys(A?.backtests || {}).length}</b><span>backtests disponibles</span></div>
          <div class="kpi"><small>Matchs avec modèle propre</small><b>${evs.filter((e) => !/marché seul|indisponible|non apparié|dérivé du marché/i.test(e.statsNote || '')).length}/${evs.length}</b><span>sinon : marché seul</span></div>
        </div>
        <section class="card"><h3>Sources en direct</h3><table class="t"><tbody>${row('The Odds API', st['The Odds API']?.ok, st['The Odds API']?.msg)}${row('ESPN', st.ESPN?.ok, st.ESPN?.msg)}${row('Données quotidiennes', st['Données quotidiennes']?.ok, st['Données quotidiennes']?.msg)}${row('Claude (facultatif)', st.Claude?.ok, st.Claude?.msg || 'non configuré')}</tbody></table></section>
        <section class="card"><h3>Collecte quotidienne</h3><table class="t"><tbody>${Object.entries(meta).map(([k, v]) => row(k, v.ok, v.msg)).join('') || '<tr><td class="muted">Indisponible.</td></tr>'}</tbody></table></section>
        <section class="card"><h3>Erreurs de la dernière analyse</h3>${A?.errors?.length ? `<ul>${A.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '<p class="muted">Aucune.</p>'}${A?.coverage ? `<p class="muted">Compétitions : ${A.coverage.queried} interrogées, ${A.coverage.noEvents} sans match, ${A.coverage.noTarget} sans Winamax, ${A.coverage.overBudget.length} hors budget · ${A.coverage.spent} crédits.</p>` : ''}</section>`;
    },
    football() { return pages.pronos('football'); },
    tennis() { return pages.pronos('tennis'); },
    credits() { return creditsPage(); },
    pronos(only) {
      const A = S.lastAnalysis(); if (!A) return emptyRun();
      const list = (A.forecasts || []).filter((f) => !only || typeof only !== 'string' || f.sport === only);
      return `<h2>${only === 'football' ? 'Football' : only === 'tennis' ? 'Tennis' : 'Analyse du jour'}</h2>
        <p class="muted">La lecture du moteur pour chaque match : résultat le plus probable et pari le plus probable sur ${esc(P.cfg().targetBook === 'winamax_fr' ? 'Winamax' : 'votre bookmaker')}. Un pronostic probable n’est pas forcément rentable : seuls ceux marqués <span class="tag t-ok">VALUE</span> battent la cote juste.</p>
        ${list.length ? `<div class="grid">${(A_DAILY_ID = A.daily?.eventId || null, list.map(pronoCard).join(''))}</div>` : '<section class="card empty"><p>Aucun pronostic : relancez une analyse.</p></section>'}`;
    },
    dashboard() {
      const A = S.lastAnalysis(), C = P.cfg();
      const today = new Date().toLocaleDateString('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      return `<section class="hero">
        <div class="date">${esc(today)}</div>
        <div class="home-meta">${A ? `<span>Dernière analyse <b>${ago(A.finishedAt)}</b></span><span><b>${int(A.counts?.analysed)}</b> matchs analysés</span><span><b>${int(A.counts?.markets)}</b> sélections étudiées</span>` : '<span>Aucune analyse pour l’instant</span>'}</div>
        ${(() => { const cs = SPCredits.state(C); return cs.alert80 ? `<p class="notice">Crédits The Odds API : ${cs.used} consommés, ${cs.remaining} restants ce mois-ci (≥ 80 %). Voir <a href="#credits">Gestion des crédits</a>.</p>` : ''; })()}
        ${(() => { try { const cv = (SPMyBets.stats().curve || []).map((c) => c.v), peak = Math.max(0, ...cv), last = cv[cv.length - 1]; return cv.length && peak > 0 && (peak - last) / peak >= 0.10 ? '<p class="notice">Bankroll en baisse de 10 % ou plus depuis son sommet : revue complète des performances conseillée avant de continuer (Stats, Erreurs, Fiabilité).</p>' : ''; } catch { return ''; } })()}
        ${!C.oddsKey ? `<form id="quickkey" class="notice onb"><b>Première utilisation, deux étapes :</b>
          <ol><li>Créez une clé gratuite sur <a href="https://the-odds-api.com/#get-access" target="_blank" rel="noopener">the-odds-api.com</a> (offre gratuite, 500 crédits/mois, envoyée par e-mail).</li><li>Collez-la ici :</li></ol>
          <div class="row"><input id="qk" type="password" autocomplete="off" placeholder="clé The Odds API" aria-label="Clé The Odds API"><button class="btn-sec" type="submit">Enregistrer</button></div>
          <small>La clé reste dans ce navigateur. Les autres réglages sont facultatifs.</small></form>` : ''}
        <div class="cta">
          <button id="go" class="btn-main" ${running ? 'disabled' : ''}>LANCER L’ANALYSE COMPLÈTE</button>
          <button id="re" class="btn-sec" ${running || !A ? 'disabled' : ''}>ACTUALISER ET RÉANALYSER</button>
        </div>
        <div id="progress" class="progress" ${running ? '' : 'hidden'}><div class="pb"><i id="pbar"></i></div><div id="ptext" class="muted"></div><ol id="steps" class="steps"></ol></div>
      </section>
      ${A ? dailyCard(A) : ''}
 ${A ? `<p class="more-link"><a href="#pronos">Voir tous les pronostics ›</a></p>
      <details class="fold"><summary>Détails de l’analyse et état des sources</summary>${statusPills()}${summaryBlock(A)}</details>` : `<section class="card empty"><h3>Aucune analyse pour l’instant</h3><p>Le premier lancement télécharge environ deux saisons de résultats ESPN (mis en cache ensuite) puis consomme des crédits The Odds API : environ 3 par compétition scannée.</p></section>`}`;
    },
    best() {
      const A = S.lastAnalysis();
      if (!A) return emptyRun();
      return `<h2>Meilleur pari du jour</h2>${A.best ? pickCard(A.best, true) : noBet(A)}
        ${A.combo ? `<section class="card"><h3>Étude de combiné (exceptionnelle)</h3><p>${A.combo.legs.map((l) => esc(`${l.match} : ${l.label} @ ${num(l.odds)}`)).join('<br>')}</p><p>Probabilité conjointe ${pct(A.combo.p)} · cote ${num(A.combo.odds)} · EV ${sgn(A.combo.ev)}</p><p class="muted">${esc(A.combo.note)}</p></section>` : ''}
        ${!A.combo && A.comboRejected ? `<p class="muted">${esc(A.comboRejected)}</p>` : ''}
        ${A.recheck ? recheckBlock(A) : ''}`;
    },
    values() {
      const A = S.lastAnalysis(); if (!A) return emptyRun();
      return `<h2>Autres values</h2><p class="muted">Classées par score de qualité. Au plus cinq, jamais complétées artificiellement.</p>${A.values.length ? `<div class="grid">${A.values.map((v) => pickCard(v)).join('')}</div>` : '<section class="card empty"><p>Aucune autre value validée lors de cette analyse.</p></section>'}`;
    },
    watch() {
      const A = S.lastAnalysis(); if (!A) return emptyRun();
      return `<h2>Opportunités à surveiller</h2><p class="muted">Non validées aujourd’hui. Pour chacune, ce qui doit changer pour qu’elle le devienne.</p>
      ${A.watch.length ? `<div class="grid">${A.watch.map((w) => `<article class="card"><header><div><span class="sport s-${w.sport}">${SPORT[w.sport]}</span> <span class="muted">${esc(w.comp)}</span></div><div class="when">${dt(w.t)}</div></header>
        <h3>${esc(w.match)}</h3><div class="sel"><span class="mk">${MKT[w.market]}</span><b>${esc(w.label)}</b></div>
        <p>Cote ${num(w.odds)} (${esc(w.book)}) · prob. ${pct(w.p)} · EV ${sgn(w.ev)} · score ${w.score}/100</p>
        <h4>Ce qui doit changer</h4><ul>${w.need.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        <h4>Motifs actuels de rejet</h4><ul class="muted">${w.reasons.map((n) => `<li>${esc(n)}</li>`).join('') || '<li>—</li>'}</ul></article>`).join('')}</div>` : '<section class="card empty"><p>Rien à surveiller pour l’instant.</p></section>'}`;
    },
    calendar() {
      const A = S.lastAnalysis(); if (!A) return emptyRun();
      const f = calFilter;
      const comps = [...new Set(A.events.map((e) => e.comp))].sort();
      const evs = A.events.filter((e) => (!f.sport || e.sport === f.sport) && (!f.comp || e.comp === f.comp) && (!f.day || e.day === f.day))
        .map((e) => ({ ...e, sels: e.sels.filter((s) => (!f.mkt || s.mkey === f.mkt) && (!f.omin || s.best >= f.omin) && (!f.omax || s.best <= f.omax)) }))
        .filter((e) => e.sels.length).sort((a, b) => a.t - b.t);
      const opt = (v, l, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`;
      return `<h2>Calendrier</h2>
      <form id="calf" class="filters">
        <label>Sport <select id="f-sport">${opt('', 'Tous', f.sport)}${opt('football', 'Football', f.sport)}${opt('tennis', 'Tennis', f.sport)}${opt('nba', 'NBA', f.sport)}</select></label>
        <label>Compétition <select id="f-comp">${opt('', 'Toutes', f.comp)}${comps.map((c) => opt(c, c, f.comp)).join('')}</select></label>
        <label>Date <select id="f-day">${opt('', 'Toutes', f.day)}${opt('aujourd’hui', 'Aujourd’hui', f.day)}${opt('demain', 'Demain', f.day)}${opt('J+2', 'J+2', f.day)}</select></label>
        <label>Marché <select id="f-mkt">${opt('', 'Tous', f.mkt)}${opt('h2h', 'Vainqueur', f.mkt)}${opt('totals', 'Total', f.mkt)}${opt('spreads', 'Handicap', f.mkt)}</select></label>
        <label>Cote min <input id="f-omin" type="number" step="0.05" min="1" value="${f.omin || ''}"></label>
        <label>Cote max <input id="f-omax" type="number" step="0.05" min="1" value="${f.omax || ''}"></label>
      </form>
      <p class="muted">${evs.length} événement(s) · analyse du ${dt(A.finishedAt)}</p>
      <div class="cal">${evs.map((e) => `<button class="ev" data-ev="${esc(e.id)}"><span class="when">${dt(e.t)}</span><span class="sport s-${e.sport}">${SPORT[e.sport]}</span><span class="m"><b>${esc(e.home)} – ${esc(e.away)}</b><small>${esc(e.comp)}${e.skip ? ' · écarté : ' + esc(e.skip) : ''}</small></span><span class="n">${e.sims ? int(e.sims.n) + ' sims' : 'phase 1'}</span><span class="n ${Math.max(...e.sels.map((s) => s.ev ?? -1)) > 0 ? 'pos' : ''}">EV max ${sgn(Math.max(...e.sels.map((s) => s.ev ?? -1)))}</span></button>`).join('')}</div>`;
    },
    history() {
      const ps = S.picks().slice().reverse(), R = S.results(), CL = S.clv();
      return `<h2>Historique</h2>
      <div class="row"><button id="settle" class="btn-sec">Mettre à jour les résultats</button><button id="exp" class="btn-sec">Exporter (JSON)</button><label class="btn-sec file">Importer<input id="imp" type="file" accept="application/json"></label></div>
      <p class="muted">Les pronostics publiés ne sont jamais modifiés. Le résultat est enregistré à part (automatiquement via ESPN pour football/NBA, manuellement pour le tennis).</p>
      <div class="tw"><table class="t hist"><thead><tr><th>Publié</th><th>Match</th><th>Sport</th><th>Marché</th><th>Cote</th><th>Prob.</th><th>Bookmaker</th><th>v.</th><th>Résultat</th><th>P/L</th><th>CLV</th></tr></thead><tbody>
      ${ps.map((p) => { const r = R[p.pid]; const c = CL[p.pid]?.last; return `<tr><td>${dt(p.publishedAt)}</td><td>${esc(p.match)}<br><small class="muted">${dt(p.t)} · ${p.cat === 'best' ? 'meilleur pari' : 'value'}</small></td><td>${SPORT[p.sport]}</td><td>${esc(p.label)}</td><td class="n">${num(p.odds)}</td><td class="n">${pct(p.p)}</td><td>${esc(p.book)}</td><td class="n">${p.version}</td>
        <td>${r ? `<span class="tag t-${r.profit > 0 ? 'ok' : r.profit < 0 ? 'bad' : 'na'}">${esc(r.status)}</span> <small>${esc(r.score || '')}</small>` : (p.t < Date.now() ? `<span class="manual" data-pid="${esc(p.pid)}"><button data-r="gagné">G</button><button data-r="perdu">P</button><button data-r="remboursé">R</button><button data-r="annulé">A</button></span>` : '<span class="tag t-na">en attente</span>')}</td>
        <td class="n ${r?.profit > 0 ? 'pos' : r?.profit < 0 ? 'neg' : ''}">${r ? (r.profit >= 0 ? '+' : '') + r.profit.toFixed(2) + ' u' : '—'}</td><td class="n">${c?.fair ? sgn(p.odds * c.fair - 1) : '—'}</td></tr>`; }).join('') || '<tr><td colspan="11" class="muted">Aucun pronostic publié pour l’instant.</td></tr>'}
      </tbody></table></div>
      <h3>Analyses</h3><div class="tw"><table class="t"><thead><tr><th>Date</th><th>Type</th><th>Événements</th><th>Simulations</th><th>Meilleur pari</th><th>Erreurs</th></tr></thead><tbody>
      ${S.analyses().slice().reverse().map((a) => `<tr><td>${dt(a.finishedAt)}</td><td>${esc(a.kind)}</td><td class="n">${int(a.counts?.available)}</td><td class="n">${int(a.counts?.sims)}</td><td>${a.best ? esc(a.best.match + ' · ' + a.best.label) : 'aucun'}</td><td class="muted">${esc((a.errors || []).slice(0, 3).join(' ; '))}</td></tr>`).join('')}
      </tbody></table></div>`;
    },
    perf() {
      const d = perfDays, m = S.perf(d);
      const A = S.lastAnalysis();
      const k = (l, v, s) => `<div class="kpi"><small>${l}</small><b>${v}</b>${s ? `<span>${s}</span>` : ''}</div>`;
      const grp = (o, lab) => Object.entries(o).map(([key, v]) => `<tr><td>${esc(lab ? lab[key] || key : key)}</td><td class="n">${v.n}</td><td class="n">${pct(v.wins / v.n)}</td><td class="n ${v.profit >= 0 ? 'pos' : 'neg'}">${(v.profit >= 0 ? '+' : '') + v.profit.toFixed(2)} u</td><td class="n">${sgn(v.profit / v.n)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">—</td></tr>';
      const head = '<thead><tr><th></th><th>Paris</th><th>Réussite</th><th>Profit</th><th>Yield</th></tr></thead>';
      return `<h2>Performance</h2>
      <div class="seg">${[[7, '7 jours'], [30, '30 jours'], [90, '90 jours'], [0, 'Depuis le lancement']].map(([v, l]) => `<button data-days="${v}" class="${d === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="kpirow">
        ${k('Pronostics', int(m.n), `${m.settled} réglés · ${m.pending} en attente`)}
        ${k('Taux de réussite', pct(m.hit), 'ne mesure pas la rentabilité')}
        ${k('Yield', sgn(m.yield), 'profit / mises (1 u fixe)')}
        ${k('ROI bankroll', sgn(m.roiBank), 'sur 100 u initiales')}
        ${k('Profit théorique', (m.profit >= 0 ? '+' : '') + m.profit.toFixed(2) + ' u')}
        ${k('Cote moyenne', num(m.avgOdds))}
        ${k('CLV moyen', sgn(m.clv), `${m.nClv} relevé(s), dernière cote avant match`)}
        ${k('Brier', num(m.brier, 3), m.brierMkt != null ? `marché : ${num(m.brierMkt, 3)}` : '')}
        ${k('Log loss', num(m.logloss, 3))}
      </div>
      <div class="grid2">
        <section class="card"><h3>Profit cumulé</h3>${lineChart(m.curve)}</section>
        <section class="card"><h3>Calibration des pronostics publiés</h3>${calChart(m.calibration)}</section>
      </div>
      <div class="grid2">
        <section class="card"><h3>Par sport</h3><table class="t">${head}${grp(m.bySport, SPORT)}</table></section>
        <section class="card"><h3>Par marché</h3><table class="t">${head}${grp(m.byMarket, MKT)}</table></section>
        <section class="card"><h3>Par tranche de cotes</h3><table class="t">${head}${grp(m.byOdds)}</table></section>
        <section class="card"><h3>Par niveau de confiance</h3><table class="t">${head}${grp(m.byConf)}</table></section>
      </div>
      <p class="muted">Le taux de réussite ne mesure pas la rentabilité. Taille d’échantillon : ${m.settled} paris réglés${m.settled < 100 ? ' — trop peu pour conclure' : ''}.</p>
      <section class="card"><h3>Par mois</h3><table class="t">${head}${grp(m.byMonth)}</table></section>
      <section class="card"><h3>Recalibrage sur vos résultats réels</h3>
        ${(() => { const R = S.results(); const bin = S.picks().filter((p) => R[p.pid] && R[p.pid].push === 0 && (R[p.pid].win === 0 || R[p.pid].win === 1));
          if (bin.length < 100) return `<p class="muted">Disponible après 100 paris réglés (actuellement ${bin.length}). Il corrige une éventuelle surconfiance ou sous-confiance du moteur.</p>`;
          const pl = SP.fitPlatt(bin.map((p) => p.p), bin.map((p) => R[p.pid].win));
          const cur = P.cfg().platt;
          return `<p>Sur ${bin.length} paris : ${pl.b < 0.9 ? 'le moteur est <b>trop confiant</b>' : pl.b > 1.1 ? 'le moteur est <b>trop prudent</b>' : 'le moteur est <b>bien calibré</b>'} (pente ${pl.b.toFixed(2)}, idéal 1). Exemple : 60 % devient ${pct(SP.applyPlatt(pl, 0.6))}.</p>
            <div class="row"><button id="applyplatt" class="btn-sec" data-a="${pl.a}" data-b="${pl.b}">Appliquer ce recalibrage</button>${cur ? '<button id="resetplatt" class="btn-sec">Retirer le recalibrage actuel</button>' : ''}</div>`; })()}
      </section>
      <section class="card"><h3>Poids du marché dans l’ensemble</h3>
        <p>Valeur utilisée : <b>${P.cfg().wMarket}</b>. ${m.wSuggest ? `L’historique (${m.wSuggest.n} pronostics réglés) suggère <b>${m.wSuggest.w}</b> (log loss minimale). <button id="applyw" data-w="${m.wSuggest.w}" class="btn-sec">Appliquer après vérification</button>` : 'Une suggestion apparaîtra après 50 pronostics réglés disposant des deux probabilités. Elle n’est jamais appliquée automatiquement.'}</p></section>
      <section class="card"><h3>Backtests chronologiques de la dernière analyse</h3>${A?.backtests && Object.keys(A.backtests).length ? `<div class="tw"><table class="t"><thead><tr><th>Compétition</th><th>Matchs testés</th><th>Log loss par modèle</th><th>Ensemble</th><th>Naïf</th><th>Poids</th></tr></thead><tbody>${Object.entries(A.backtests).map(([n, b]) => `<tr><td>${esc(n)}</td><td class="n">${b.n}</td><td>${Object.entries(b.models).map(([mm, v]) => `${mm} ${num(v.logLoss, 4)}`).join(' · ')}</td><td class="n">${num(b.ensemble.logLoss, 4)}</td><td class="n">${b.naive ? num(b.naive.logLoss, 4) : '—'}</td><td>${Object.entries(b.weights).map(([mm, w]) => `${mm} ${w.toFixed(2)}`).join(' · ')}</td></tr>`).join('')}</tbody></table></div><p class="muted">Chaque match est prédit uniquement avec les matchs antérieurs (aucune donnée postérieure). Les performances passées ne garantissent pas les performances futures.</p>` : '<p class="muted">Aucun backtest disponible (lancez une analyse).</p>'}</section>`;
    },
    config() {
      const C = P.cfg();
      const chk = (id, v, l) => `<label class="chk"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${l}</label>`;
      const n = (id, v, l) => `<label>${l}<input id="${id}" type="number" step="any" value="${v}"></label>`;
      return `<h2>Réglages</h2>
      <form id="cfgf" class="cfg">
        <section class="card"><h3>Clés API (stockées uniquement dans ce navigateur)</h3>
          <label>Clé The Odds API <input id="c-odds" type="password" autocomplete="off" value="${esc(C.oddsKey)}" placeholder="obligatoire"></label>
          <p class="muted">Inscription sur the-odds-api.com : 500 crédits/mois gratuits. Une analyse coûte ≈ (nombre de compétitions) × (marchés : 3) × (régions : 1) crédits.</p>
          <label>Clé API Anthropic (facultative) <input id="c-claude" type="password" autocomplete="off" value="${esc(C.claudeKey)}" placeholder="pour l’analyse des actualités"></label>
          <p class="muted">console.anthropic.com. Utilisée seulement pour les 6 meilleures sélections. Elle ne crée jamais de probabilité.</p>
          <label>Régions bookmakers <select id="c-reg">${['eu', 'fr', 'eu,fr', 'eu,uk'].map((r) => `<option ${C.regions === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          <p class="muted">« eu » contient Winamax (FR) et Pinnacle, la référence pour le prix juste. Chaque région ajoutée multiplie le coût en crédits.</p>
          <label>Bookmaker où vous pariez <select id="c-target">${[['winamax_fr', 'Winamax'], ['', 'Aucun : meilleure cote disponible']].map(([v, l]) => `<option value="${v}" ${C.targetBook === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <p class="muted">La value et l’EV sont calculées à la cote de ce bookmaker uniquement.</p>
        </section>
        <section class="card"><h3>Compétitions</h3>
          <div class="g3">
            <label>Football <select id="c-fscope"><option value="toutes" ${C.footballScope !== 'principal' ? 'selected' : ''}>Toutes les compétitions (filtrées par la présélection)</option><option value="principal" ${C.footballScope === 'principal' ? 'selected' : ''}>Compétitions principales seulement</option></select></label>
            ${chk('c-tennis', C.tennis !== false, 'Tennis : tournois ATP/WTA en cours')}</div>
          <div class="g3">${n('c-mbud', C.monthlyCredits, 'Budget mensuel de crédits')}${n('c-res', C.creditReserve, 'Réserve protégée (crédits)')}${n('c-pmin', C.prescanMin, 'Score de présélection minimal (/100)')}</div>
          ${n('c-budget', C.creditBudget, 'Budget de crédits par analyse (≈ 2 à 3 par compétition)')}
          <p class="muted">À chaque analyse, l’application récupère gratuitement la liste de toutes les compétitions actives et ne paie que pour celles qui ont des matchs dans les 24 h. Les compétitions où ${C.targetBook === 'winamax_fr' ? 'Winamax' : 'votre bookmaker'} ne propose aucune cote sont mémorisées et ignorées pendant 7 jours. Priorité aux grands championnats, puis aux compétitions avec le plus de matchs.</p>
          ${(() => {
            const sp = D.LS.get('sp:c:odds:sports', null)?.data;
            if (!sp) return '<p class="muted">La liste détaillée apparaîtra après la première analyse.</p>';
            const wmx = D.LS.get('sp:wmx', {});
            const grp = { Soccer: 'Football', Tennis: 'Tennis' };
            return Object.entries(grp).map(([g, lab]) => {
              const L = sp.filter((s) => s.group === g && s.active && !s.has_outrights).sort((x, y) => x.title.localeCompare(y.title));
              if (!L.length) return '';
              return `<details><summary>${lab} : ${L.length} compétitions actives</summary><div class="chks">${L.map((s) => { const w = wmx[s.key]; const tag = !w ? '' : w.has ? ' <small class="pos">Winamax ✓</small>' : ' <small class="neg">pas de Winamax</small>'; return `<label class="chk"><input type="checkbox" data-comp="${esc(s.key)}" data-def="${P.isDefault(s, C) ? 1 : 0}" ${P.isWanted(s, C) ? 'checked' : ''}> ${esc(s.title)}${tag}</label>`; }).join('')}</div></details>`;
            }).join('');
          })()}
        </section>
        <section class="card"><h3>Type de pronostic du jour</h3><div class="g3">
          <label class="chk"><input type="checkbox" id="c-strong" ${C.requireStrong !== false ? 'checked' : ''}> Pronostic du jour uniquement en confiance forte</label>
          <label>Mode <select id="c-mode"><option value="sûr" ${C.mode !== 'value' ? 'selected' : ''}>Paris sûrs : très probables, petites cotes</option><option value="value" ${C.mode === 'value' ? 'selected' : ''}>Value : rentabilité maximale, cotes plus hautes</option></select></label>
          ${n('c-dminp', C.dailyMinP, 'Probabilité minimale du pronostic principal (0.75 = 75 %)')}${n('c-sminp', C.safeMinP, 'Probabilité minimale d’un pari sûr', 0.01)}${n('c-smaxo', C.safeMaxOdds, 'Cote maximale d’un pari sûr', 0.05)}${n('c-stol', C.safeTolEV, 'Tolérance de cote (−0.03 = 3 % sous la vraie valeur)', 0.005)}${n('c-sst', C.safeStakePct, 'Mise par pari sûr (0.02 = 2 % de la bankroll)', 0.005)}</div>
          <p class="muted">Un pari sûr perd quand même parfois : à 75 %, une fois sur quatre. La bankroll ne grossit que si les cotes jouées ne sont pas en dessous de leur vraie valeur, c’est pourquoi la tolérance est limitée.</p></section>
        <section class="card"><h3>Mise indicative</h3><div class="g3">
          ${n('c-bank', SPData.LS.get('sp:bank', null)?.start ?? C.bankroll, 'Bankroll de départ (€)', 'any')}<label>Bankroll actuelle<input disabled value="${num(curBank())} € (départ + gains − pertes)"></label>${n('c-kf', C.kellyFrac, 'Fraction de Kelly (0.25 = quart)', 0.05)}${n('c-maxst', C.maxStakePct, 'Mise max (0.02 = 2 % de la bankroll)', 0.005)}</div>
          <p class="muted">Ne misez que de l’argent que vous pouvez perdre. La mise indicative ne garantit rien.</p></section>
        <section class="card"><h3>Critères de sélection</h3><div class="g3">
          ${n('c-minodds', C.minOdds, 'Cote minimale (≥ 1.20)')}${n('c-maxodds', C.maxOdds, 'Cote maximale')}${n('c-minev', C.minEV, 'EV minimale (0.02 = 2 %)', 0.005)}
          ${n('c-age', C.maxOddsAgeMin, 'Âge max des cotes (min)', 1)}${n('c-gap', C.maxGap, 'Divergence max modèles/marché', 0.01)}${n('c-wm', C.wMarket, 'Poids du marché (0–1)', 0.05)}
          ${n('c-hours', C.hours, 'Fenêtre prioritaire (h)', 1)}${chk('c-48', C.extendTo48, 'Étendre à 48 h si opportunité exceptionnelle (score ≥ 75)')}</div></section>
        <section class="card"><h3>Simulations</h3><div class="g3">
          ${n('c-mins', C.minSims, 'Minimum par événement', 10000)}${n('c-maxs', C.maxSims, 'Maximum par événement', 100000)}${n('c-tol', C.tol, 'Précision visée (demi-IC95)', 0.0005)}${n('c-p2', C.phase2Events, 'Événements en phase 2', 1)}</div>
          <p class="muted">Arrêt adaptatif : la simulation s’arrête dès que l’erreur d’échantillonnage passe sous la précision visée. Plus de simulations réduisent l’erreur numérique, pas les biais du modèle.</p></section>
        <section class="card"><h3>Automatisation (onglet ouvert)</h3><div class="g3">
          ${chk('c-auto', C.autoOn, 'Analyse quotidienne automatique')}<label>Heure (Europe/Paris)<input id="c-time" type="time" value="${esc(C.autoTime)}"></label>
          ${chk('c-pre', C.preMatchRecheck, 'Réanalyse 60 min avant les paris suivis')}${chk('c-notif', C.notif, 'Notifications du navigateur')}</div>
          <p class="muted">Ces automatismes ne fonctionnent que lorsque la page est ouverte : il n’y a pas de serveur.</p></section>
        <div class="row"><button class="btn-main sm" type="submit">Enregistrer</button><button id="purge" type="button" class="btn-sec">Vider le cache des données</button></div>
      </form>
      <section class="card"><h3>Journal des appels</h3><div class="tw"><table class="t">${D.log.slice(-40).reverse().map((l) => `<tr><td>${hm(l.at)}</td><td>${esc(l.provider)}</td><td class="muted">${esc(l.url)}</td><td>${l.ok ? 'OK' : esc(l.msg)}</td></tr>`).join('') || '<tr><td class="muted">Aucun appel dans cette session.</td></tr>'}</table></div></section>`;
    },
  };
  let calFilter = {}, perfDays = 30;

  function emptyRun() { return `<section class="card empty"><h3>Aucune analyse</h3><p>Lancez une analyse depuis l’<a href="#dashboard">accueil</a>.</p></section>`; }
  function noBet(A) {
    const rej = A.events?.length ? '' : '';
    return `<section class="card nobet"><h3>AUCUN PARI VALIDÉ</h3><p>Les opportunités disponibles ne répondent pas à nos critères statistiques.</p>${A.errors?.length ? `<p class="muted">Incidents : ${esc(A.errors.join(' ; '))}</p>` : ''}${rej}</section>`;
  }
  function summaryBlock(A) {
    return `<section class="card summary"><h3>Résultat de la dernière analyse</h3>
      ${A.best ? adviceBox(A.best) : ''}
      ${A.best ? `<p><span class="tag t-ok">meilleur pari</span> <b>${esc(A.best.match)}</b> — ${esc(A.best.label)} @ ${num(A.best.odds)} (${esc(A.best.book)}) · EV ${sgn(A.best.ev)} · score ${A.best.score}/100 · <a href="#best">voir le détail</a></p>` : '<p><b>AUCUN PARI VALIDÉ</b> : les opportunités disponibles ne répondent pas à nos critères statistiques.</p>'}
      <p>${A.values.length} autre(s) value(s) · ${A.watch.length} opportunité(s) à surveiller</p>
      ${(A.forecasts || []).length ? `<h4>Pronostics les plus solides</h4><ul>${A.forecasts.slice(0, 3).map((f) => `<li><b>${esc(f.match)}</b> : ${esc(f.headline)} (confiance ${esc(f.confidence)})${f.pick ? ` · ${esc(f.pick.label)} @ ${num(f.pick.odds)}, ${pct(f.pick.p, 0)}` : ''}</li>`).join('')}</ul><p><a href="#pronos">Voir tous les pronostics</a></p>` : ''}
      ${A.errors?.length ? `<details><summary>${A.errors.length} incident(s) de collecte</summary><ul>${A.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}</section>`;
  }
  function recheckBlock(A) {
    return `<section class="card"><h3>Réanalyse du ${dt(A.finishedAt)} — comparaison avec la version précédente</h3><div class="tw"><table class="t"><thead><tr><th>Match</th><th>Sélection</th><th>Cote</th><th>Prob.</th><th>EV</th><th>Verdict</th></tr></thead><tbody>${A.recheck.map((r) => `<tr><td>${esc(r.match)}</td><td>${esc(r.label)}</td><td class="n">${num(r.oldOdds)} → ${num(r.newOdds)}</td><td class="n">${pct(r.oldP)} → ${pct(r.newP)}</td><td class="n">${sgn(r.oldEV)} → ${sgn(r.newEV)}</td><td><span class="tag t-${r.status === 'good' ? 'ok' : 'bad'}">${esc(r.verdict)}</span></td></tr>`).join('')}</tbody></table></div><p class="muted">L’ancienne version reste dans l’historique.</p></section>`;
  }
  function eventDetail(id) {
    const A = S.lastAnalysis(); const e = A?.events.find((x) => x.id === id); if (!e) return;
    const dlg = $('#dlg');
    $('#dlgc').innerHTML = `<header><div><span class="sport s-${e.sport}">${SPORT[e.sport]}</span> <span class="muted">${esc(e.comp)}</span></div><button id="dlgx" class="x" aria-label="Fermer">×</button></header>
      <h3>${esc(e.home)} – ${esc(e.away)}</h3><p class="muted">${dt(e.t)} · ${esc(e.statsNote || '')}${e.ctx ? ` · surface ${esc(e.ctx.surface)}${e.ctx.surfaceVerified ? '' : ' (non vérifiée)'}` : ''}</p>
      ${e.skip ? `<p class="notice">Écarté : ${esc(e.skip)}</p>` : ''}
      <table class="t">${(e.models || []).map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${m.p1x2 ? m.p1x2.map((x) => pct(x)).join(' · ') : m.pHome != null ? pct(m.pHome) : m.pA != null ? pct(m.pA) : m.serveA ? `service ${pct(m.serveA)} / ${pct(m.serveB)}` : ''}${m.lh ? ` · λ ${num(m.lh)}/${num(m.la)}` : ''}${m.margin != null ? ` · marge ${num(m.margin, 1)}` : ''}${m.total != null ? ` · total ${num(m.total, 1)}` : ''}</td></tr>`).join('')}</table>
      ${e.sims ? `<p>${int(e.sims.n)} simulations en ${e.sims.ms} ms · scénarios : ${e.sims.scenarios.map((s) => `${s.name} ${pct(s.p)}`).join(' · ')}</p>` : '<p class="muted">Phase 1 seulement (pas de simulation approfondie : potentiel insuffisant).</p>'}
      <div class="tw"><table class="t"><thead><tr><th>Sélection</th><th>Cote cible</th><th>Moyenne</th><th>Pinnacle</th><th>Prob. marché</th><th>Prob. modèle</th><th>EV</th></tr></thead><tbody>
      ${e.sels.map((s) => `<tr><td>${MKT[s.mkey]} · ${esc(s.label)}</td><td class="n">${s.best != null ? num(s.best) : '—'} <small class="muted">${esc(s.book)}</small></td><td class="n">${num(s.mean)}</td><td class="n">${num(s.pin)}</td><td class="n">${pct(s.fair)}</td><td class="n">${pct(s.p)}${s.deep ? '' : ' <small class="muted">p1</small>'}</td><td class="n ${s.ev > 0 ? 'pos' : 'neg'}">${sgn(s.ev)}</td></tr>`).join('')}</tbody></table></div>
      ${e.warnings?.length ? `<h4>Avertissements</h4><ul>${e.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${e.news?.length ? `<h4>Actualités reliées</h4><ul class="news">${e.news.map((n) => `<li>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)} <small>${n.published ? dt(Date.parse(n.published)) : ''}</small></li>`).join('')}</ul>` : ''}`;
    dlg.hidden = false;
    $('#dlgx').onclick = () => { dlg.hidden = true; };
  }

  // ------------------------------------------------------------ graphiques SVG
  function lineChart(pts) {
    if (pts.length < 2) return '<p class="muted">Au moins deux pronostics réglés sont nécessaires.</p>';
    const W = 560, H = 200, pad = 36;
    const ys = pts.map((p) => p.v), lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), span = hi - lo || 1;
    const X = (i) => pad + i / (pts.length - 1) * (W - pad - 10), Y = (v) => 10 + (hi - v) / span * (H - 40);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Profit cumulé">
      <line x1="${pad}" x2="${W - 10}" y1="${Y(0)}" y2="${Y(0)}" class="axis"/>
      <text x="4" y="${Y(hi) + 4}" class="lbl">${hi.toFixed(1)}</text><text x="4" y="${Y(lo) + 4}" class="lbl">${lo.toFixed(1)}</text><text x="4" y="${Y(0) + 4}" class="lbl">0</text>
      <path d="${d} L${X(pts.length - 1)},${Y(0)} L${X(0)},${Y(0)} Z" class="area"/><path d="${d}" class="line"/>
      <circle cx="${X(pts.length - 1)}" cy="${Y(last.v)}" r="4" class="endpt"/><text x="${X(pts.length - 1) - 4}" y="${Y(last.v) - 8}" text-anchor="end" class="lbl b">${last.v >= 0 ? '+' : ''}${last.v.toFixed(2)} u</text></svg>`;
  }
  function calChart(bins) {
    if (!bins.length) return '<p class="muted">Pas encore de pronostics réglés.</p>';
    const W = 300, H = 220, pad = 34, s = (v) => v * (W - pad - 10);
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Calibration">
      <line x1="${pad}" y1="${H - 24}" x2="${pad + s(1)}" y2="${H - 24 - s(1) * (H - 34) / (W - pad - 10)}" class="axis dash"/>
      ${bins.map((b) => `<circle cx="${pad + s(b.pred)}" cy="${H - 24 - b.obs * (H - 34)}" r="${3 + Math.min(8, Math.sqrt(b.n))}" class="dotc"><title>${b.n} paris · prédit ${pct(b.pred)} · observé ${pct(b.obs)}</title></circle>`).join('')}
      <text x="${pad}" y="${H - 6}" class="lbl">0 %</text><text x="${W - 10}" y="${H - 6}" text-anchor="end" class="lbl">prob. prédite 100 %</text><text x="2" y="14" class="lbl">observé</text></svg>`;
  }

  // ------------------------------------------------------------ navigation simplifiée
  const TAB_OF = { dashboard: 'home', pronos: 'pronos', football: 'pronos', tennis: 'pronos', safe: 'pronos', values: 'pronos', bets: 'bets' };
  const CHIPS = [['pronos', 'Tous'], ['football', 'Football'], ['tennis', 'Tennis'], ['safe', 'Haute proba'], ['values', 'Value']];
  const CHIP_PAGES = CHIPS.map((c) => c[0]);
  const chips = (page) => `<div class="filters" role="navigation" aria-label="Filtres">${CHIPS.map(([h, l]) => `<a href="#${h}" class="${h === page ? 'on' : ''}">${l}</a>`).join('')}</div>`;
  const MORE = [
    ['Analyse', [['best', 'Meilleur pari', 'La meilleure value du jour, si elle existe'], ['watch', 'À surveiller', 'Paris pas encore validés']]],
    ['Suivi', [['history', 'Historique', 'Toutes les analyses passées'], ['perf', 'Statistiques', 'Réussite, ROI, calibration'], ['calendar', 'Calendrier', 'Matchs des 48 prochaines heures'], ['check', 'Vérifier une cote', 'Tester un pari vu sur Winamax']]],
    ['Fiabilité', [['backtests', 'Backtests', 'Tests des modèles sur le passé'], ['models', 'Fiabilité des modèles', 'Qualité par compétition'], ['errors', 'Erreurs', 'Ce qui n’a pas marché et pourquoi'], ['health', 'Santé du système', 'Sources de données et état']]],
    ['Compte', [['credits', 'Crédits The Odds API', 'Budget, consommation, historique'], ['config', 'Réglages', 'Clé API, bankroll, compétitions']]],
  ];
  pages.more = () => `<h2>Plus</h2><div class="more">${MORE.map(([g, items]) => `<section><h3>${g}</h3><div class="mlist">${items.map(([h, l, d]) => `<a href="#${h}"><b>${l}</b><small>${d}</small></a>`).join('')}</div></section>`).join('')}</div>`;

  // ------------------------------------------------------------ routage et événements
  function route() {
    const h = (location.hash || '#dashboard').slice(1);
    const page = pages[h] ? h : 'dashboard';
    const tab = TAB_OF[page] || 'more';
    document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    window.scrollTo(0, 0);
    BETDRAFTS.clear();
    $('#main').innerHTML = (CHIP_PAGES.includes(page) ? chips(page) : '') + pages[page]() + disclaimer();
    if (page === 'dashboard' && running) renderProgress();
    bind(page);
  }
  function disclaimer() {
    return `<footer class="disc">Outil d’analyse et d’aide à la décision, sans placement de paris. Aucun gain n’est garanti : une value théorique n’est pas un bénéfice. Les paris sportifs comportent des risques financiers et de dépendance — interdits aux moins de 18 ans. Aide : Joueurs Info Service, 09 74 75 13 13 (appel non surtaxé).</footer>`;
  }
  function bind(page) {
    if (page === 'dashboard') {
      $('#quickkey')?.addEventListener('submit', (e) => { e.preventDefault(); const v = $('#qk').value.trim(); if (!v) return; const C = P.cfg(); C.oddsKey = v; P.saveCfg(C); toast('Clé enregistrée : vous pouvez lancer l’analyse'); route(); });
      $('#go')?.addEventListener('click', () => launch());
      $('#re')?.addEventListener('click', () => {
        const A = S.lastAnalysis(); if (!A) return;
        const tracked = [A.best, ...A.values, ...A.watch].filter((p) => p && p.t > Date.now());
        const keys = new Set(tracked.map((p) => p.sportKey));
        launch({ force: true, parentId: A.id, onlyKeys: keys.size ? keys : null });
      });
    }
    if (page === 'check') SPChecker.bind(route);
    if (page === 'bets') SPMyBets.bind(route);
    document.querySelectorAll('[data-bet]').forEach((b) => b.addEventListener('click', () => { const d = BETDRAFTS.get(b.dataset.bet); if (d) SPMyBets.openAdd(d); }));
    if (page === 'calendar') {
      $('#calf').addEventListener('change', () => {
        calFilter = { sport: $('#f-sport').value, comp: $('#f-comp').value, day: $('#f-day').value, mkt: $('#f-mkt').value, omin: +$('#f-omin').value || 0, omax: +$('#f-omax').value || 0 };
        route();
      });
      document.querySelectorAll('.ev').forEach((b) => b.addEventListener('click', () => eventDetail(b.dataset.ev)));
    }
    if (page === 'history') {
      $('#settle').onclick = async () => { const n = await S.autoSettle(); toast(`${n} résultat(s) enregistré(s)`); route(); };
      $('#exp').onclick = () => {
        const blob = new Blob([S.exportAll()], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `sportpredict-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      };
      $('#imp').onchange = async (e) => { try { S.importAll(await e.target.files[0].text()); toast('Historique importé'); route(); } catch (err) { toast('Import impossible : ' + err.message, 'bad'); } };
      document.querySelectorAll('.manual button').forEach((b) => b.addEventListener('click', () => {
        const pid = b.parentElement.dataset.pid; const p = S.picks().find((x) => x.pid === pid); const r = b.dataset.r;
        const profit = r === 'gagné' ? p.odds - 1 : r === 'perdu' ? -1 : 0;
        S.setResult(pid, { status: r, profit, win: r === 'gagné' ? 1 : 0, push: r === 'remboursé' ? 1 : 0, source: 'saisie manuelle' });
        route();
      }));
    }
    if (page === 'perf') {
      document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { perfDays = +b.dataset.days; route(); }));
      $('#applyplatt')?.addEventListener('click', (e) => { const C = P.cfg(); C.platt = { a: +e.target.dataset.a, b: +e.target.dataset.b }; P.saveCfg(C); toast('Recalibrage appliqué aux prochaines analyses'); route(); });
      $('#resetplatt')?.addEventListener('click', () => { const C = P.cfg(); delete C.platt; P.saveCfg(C); toast('Recalibrage retiré'); route(); });
      $('#applyw')?.addEventListener('click', (e) => { const C = P.cfg(); C.wMarket = +e.target.dataset.w; P.saveCfg(C); toast('Poids du marché mis à jour'); route(); });
    }
    if (page === 'config') {
      $('#cfgf').addEventListener('submit', (e) => {
        e.preventDefault();
        const C = P.cfg(), v = (id) => $('#' + id).value, c = (id) => $('#' + id).checked;
        C.oddsKey = v('c-odds').trim(); C.claudeKey = v('c-claude').trim(); C.regions = v('c-reg'); C.targetBook = v('c-target');
        C.footballScope = v('c-fscope'); C.tennis = c('c-tennis');
        C.monthlyCredits = Math.max(1, parseFloat(v('c-mbud')) || 500); C.creditReserve = Math.max(0, parseFloat(v('c-res')) || 0); C.prescanMin = Math.min(100, Math.max(0, parseFloat(v('c-pmin')) || 60));
        C.creditBudget = Math.max(3, parseFloat(v('c-budget')) || 45);
        const boxes = [...document.querySelectorAll('[data-comp]')];
        // une case cochée hors liste par défaut = ajout ; décochée dans la liste par défaut = exclusion
        if (boxes.length) {
          const sp = D.LS.get('sp:c:odds:sports', null)?.data || [];
          const def = (k) => { const s = sp.find((x) => x.key === k); return s ? P.isDefault(s, C) : false; };
          C.excluded = boxes.filter((b) => !b.checked && def(b.dataset.comp)).map((b) => b.dataset.comp);
          C.included = boxes.filter((b) => b.checked && !def(b.dataset.comp)).map((b) => b.dataset.comp);
        }
        C.minOdds = Math.max(1.2, +v('c-minodds')); C.maxOdds = +v('c-maxodds'); C.minEV = Math.max(0, +v('c-minev'));
        C.maxOddsAgeMin = +v('c-age'); C.maxGap = +v('c-gap'); C.wMarket = Math.min(1, Math.max(0, +v('c-wm'))); C.hours = +v('c-hours'); C.extendTo48 = c('c-48');
        C.minSims = Math.max(10000, +v('c-mins')); C.maxSims = Math.max(C.minSims, +v('c-maxs')); C.tol = Math.max(0.0005, +v('c-tol')); C.phase2Events = Math.max(1, +v('c-p2'));
        C.mode = v('c-mode'); C.dailyMinP = Math.min(0.95, Math.max(0.6, parseFloat(v('c-dminp')) || 0.75)); C.requireStrong = c('c-strong'); C.safeMinP = Math.min(0.95, Math.max(0.55, +v('c-sminp'))); C.safeMaxOdds = Math.max(1.2, +v('c-smaxo')); C.safeTolEV = Math.min(0, Math.max(-0.08, +v('c-stol'))); C.safeStakePct = Math.min(0.05, Math.max(0, +v('c-sst')));
        C.bankroll = Math.max(0, parseFloat(String(v('c-bank')).replace(',', '.')) || 0);
        { const bk = SPData.LS.get('sp:bank', null); SPData.LS.set('sp:bank', bk ? { ...bk, start: C.bankroll } : { start: C.bankroll, since: Date.now(), moves: [] }); } C.kellyFrac = Math.min(1, Math.max(0, +v('c-kf'))); C.maxStakePct = Math.min(0.1, Math.max(0, +v('c-maxst')));
        C.autoOn = c('c-auto'); C.autoTime = v('c-time'); C.preMatchRecheck = c('c-pre'); C.notif = c('c-notif');
        if (C.notif && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        P.saveCfg(C); toast('Réglages enregistrés');
      });
      $('#purge').onclick = () => { D.purgeCache(); toast('Cache vidé'); };
    }
  }
  function toast(msg, kind) {
    const t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
  }

  // automatisation quotidienne / pré-match (page ouverte)
  setInterval(() => {
    const C = P.cfg(); if (running) return;
    const now = new Date();
    const hhmm = now.toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const today = now.toLocaleDateString('fr-FR', { timeZone: TZ });
    if (C.autoOn && hhmm === C.autoTime && D.LS.get('sp:lastAuto', '') !== today) { D.LS.set('sp:lastAuto', today); launch(); return; }
    if (C.preMatchRecheck) {
      const A = S.lastAnalysis();
      const due = A && [A.best, ...A.values].filter(Boolean).find((p) => p.t - Date.now() < 65 * 60e3 && p.t - Date.now() > 50 * 60e3);
      if (due && D.LS.get('sp:pre:' + due.eventId, 0) === 0) { D.LS.set('sp:pre:' + due.eventId, 1); launch({ force: true, parentId: A.id, onlyKeys: new Set([due.sportKey]) }); }
    }
  }, 30e3);

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#dlg').hidden = true; });
  $('#dlg').addEventListener('click', (e) => { if (e.target.id === 'dlg') $('#dlg').hidden = true; });
  route();
  window.SPToast = toast; window.SPRoute = route;
  SPMyBets.autoSettle().then((n) => { if (n) { toast(`${n} de vos paris réglé(s)`); route(); } }).catch(() => {});
  S.autoSettle().then((n) => { if (n) { toast(`${n} résultat(s) mis à jour`); route(); } }).catch(() => {});
})();
