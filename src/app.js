/* SportPredict AI — interface. */
(() => {
  const D = SPData, P = SPPipeline, S = SPStore, SP = P.SP;
  const $ = (q, el = document) => el.querySelector(q);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + ' %');
  const sgn = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + ' %');
  const num = (x, d = 2) => (x == null || isNaN(x) ? '—' : Number(x).toFixed(d));
  const int = (n) => (n == null ? '—' : new Intl.NumberFormat('fr-FR').format(n));
  const TZ = 'Europe/Paris';
  const dt = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const hm = (t) => new Date(t).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`; };
  const SPORT = { football: 'Football', tennis: 'Tennis', nba: 'NBA' };
  const MKT = { h2h: 'Vainqueur', totals: 'Total', spreads: 'Handicap' };

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
        return { match: p.match, label: p.label, oldOdds: p.odds, newOdds: s.best, oldP: p.p, newP: s.p, oldEV: p.ev, newEV: s.ev, verdict: keep ? 'value confirmée' : (s.ev != null && s.ev > 0 ? 'value réduite : ne passe plus tous les critères' : 'value disparue — pari plus intéressant'), status: keep ? 'good' : 'bad' };
      });
      const list = S.analyses(); list[list.length - 1] = A; D.LS.set('sp:analyses', list);
    }
    if (P.cfg().notif && A.best && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('SportPredict AI — pari validé', { body: `${A.best.match} · ${A.best.label} @ ${A.best.odds}` }); } catch { /* ignore */ }
    }
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
  const eur0 = (x) => Math.round(x).toLocaleString('fr-FR') + ' €';
  function safeList(A) {
    const L = (A.safe || []).filter((s) => !A.daily || s.eventId !== A.daily.eventId);
    if (!L.length) return '';
    return `<section class="card"><h3>Autres paris sûrs du jour</h3><p class="muted">Très probables (≥ ${(P.cfg().safeMinP * 100).toFixed(0)} %) et cote Winamax pas en dessous de leur vraie valeur. Ne les combinez pas : jouez-les séparément, avec une petite mise chacun.</p>
      <div class="tw"><table class="t"><tbody>${L.map((s) => `<tr><td><b>${esc(s.match)}</b><br><small class="muted">${dt(s.t)} · ${esc(s.comp)}</small></td><td>${esc(s.label)}</td><td class="n">${num(s.odds)}</td><td class="n">${pct(s.p, 0)}</td><td>${s.tier === 1 ? '<span class="tag t-ok">cote correcte</span>' : '<span class="tag t-warn">cote un peu basse</span>'}</td><td class="n">${num(safeStake(s.tier === 1 ? 'sûr' : 'sûr-bas', s.p, s.odds, s.pPush))} €</td><td>${betBtn({ source: 'safe', ...s, suggested: safeStake(s.tier === 1 ? 'sûr' : 'sûr-bas', s.p, s.odds, s.pPush) })}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  function dailyCard(A) {
    const d = A.daily;
    if (!d) return `<section class="card nobet"><h3>Pas de pronostic du jour</h3><p>Aucun match des prochaines 24 h n’a assez de données ou une cote Winamax acceptable.</p></section>`;
    const C = P.cfg(), pk = d.pick;
    const minOdds = Math.ceil(((1 + C.minEV - (pk.pPush || 0)) / pk.p) * 100) / 100;
    const stake = safeStake(d.kind, pk.p, pk.odds, pk.pPush);
    const kindTag = { 'sûr': '<span class="tag t-ok">PARI SÛR · cote correcte</span>', 'sûr-bas': '<span class="tag t-warn">PARI SÛR · cote un peu basse</span>', value: '<span class="tag t-ok">VALUE</span>', probable: '<span class="tag t-na">probable, sans value</span>' }[d.kind] || '';
    const stakeNote = { 'sûr': `${(C.safeStakePct * 100).toFixed(0)} % de votre bankroll (${eur0(curBank())})`, 'sûr-bas': `${(C.safeStakePct * 50).toFixed(0)} % de la bankroll : cote un peu basse`, value: 'quart de Kelly plafonné', probable: '1 % de la bankroll : pas de value' }[d.kind];
    return `<section class="card pick big daily">
      <div class="eyebrow">PRONOSTIC DU JOUR${d.kind && d.kind.startsWith('sûr') ? ' · MODE PARIS SÛRS' : ''}</div>
      <header><div><span class="sport s-${d.sport}">${SPORT[d.sport]}</span> <span class="muted">${esc(d.comp)}</span></div><div class="when">${dt(d.t)}</div></header>
      <h3>${esc(d.match)}</h3>
      <div class="sel"><span class="mk">${MKT[pk.market] || ''}</span><b>${esc(pk.label)}</b> ${kindTag} <span class="tag t-${d.confidence === 'forte' ? 'ok' : d.confidence === 'moyenne' ? 'warn' : 'na'}">confiance ${esc(d.confidence)}</span></div>
      <div class="kpis">
        <div><small>Cote ${esc(pk.book)}</small><b class="odds">${num(pk.odds)}</b><span>minimum pour une value : ${num(minOdds)}</span></div>
        <div><small>Probabilité</small><b>${pct(pk.p)}</b><span>cote juste ${num(1 / pk.p)}</span></div>
        <div><small>EV</small><b class="${pk.ev > 0 ? 'pos' : 'neg'}">${sgn(pk.ev)}</b><span>par unité misée</span></div>
        <div><small>Mise conseillée</small><b>${num(stake)} €</b><span>${esc(stakeNote)}</span></div>
      </div>
      <h4>L’analyse</h4><ul>${d.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      ${d.warnings?.length ? `<h4>Points de vigilance</h4><ul>${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${betBtn({ source: 'daily', eventId: d.eventId, sport: d.sport, sportKey: d.sportKey, comp: d.comp, match: d.match, home: d.home, away: d.away, t: d.t, label: pk.label, type: pk.type, point: pk.point, market: pk.market, odds: pk.odds, book: pk.book, p: pk.p, value: pk.value, suggested: stake })}
      <p class="muted"><small>Vérifiez la cote sur Winamax avant de parier ; si le match a commencé ou si la cote a beaucoup baissé, abstenez-vous. ${esc(d.dataNote || '')}</small></p>
    </section>`;
  }
  const curBank = () => { try { return SPData.LS.get('sp:bank', null) ? SPMyBets.stats().bankroll : P.cfg().bankroll; } catch { return P.cfg().bankroll; } };
  function safeStake(kind, p, odds, pPush) {
    const C = P.cfg(), B = curBank();
    if (kind === 'sûr') return Math.round(B * C.safeStakePct * 100) / 100;
    if (kind === 'sûr-bas') return Math.round(B * C.safeStakePct * 0.5 * 100) / 100;
    if (kind === 'value') return Math.round(B * Math.min(C.maxStakePct, C.kellyFrac * Math.max(0, (p * odds + (pPush || 0) - 1) / (odds - 1))) * 100) / 100;
    return Math.round(B * 0.01 * 100) / 100;
  }
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
  function formChips(fm) {
    if (!fm) return '<span class="muted">forme indisponible</span>';
    return `<span class="form" title="du plus ancien au plus récent (à droite)">${fm.seq.split('').map((r) => `<i class="r-${r}">${r}</i>`).join('')}</span> <small class="muted">${num(fm.gf, 1)} marqués / ${num(fm.ga, 1)} encaissés${fm.xgf != null ? ` · xG ${num(fm.xgf, 2)} / ${num(fm.xga, 2)}` : ''}</small>`;
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
      ${f.sport === 'nba' ? `<p class="muted">Score projeté <b>${Math.round(f.expected.home)}-${Math.round(f.expected.away)}</b> · total attendu ${num(f.expected.total, 1)} points</p>` : ''}
      ${f.form ? `<div class="formrow"><div><small>${esc(hn)}</small>${formChips(f.form.home)}</div><div><small>${esc(an)}</small>${formChips(f.form.away)}</div></div>` : ''}
      ${f.pick ? `<div class="advice"><b>Pari le plus probable :</b> ${esc(f.pick.label)} @ <b>${num(f.pick.odds)}</b> (${esc(f.pick.book)}) — probabilité ${pct(f.pick.p)}, EV ${sgn(f.pick.ev)} ${f.pick.value ? '<span class="tag t-ok">VALUE</span>' : '<span class="tag t-na">pas de value</span>'}</div>${betBtn({ source: 'prono', eventId: f.eventId, sport: f.sport, sportKey: f.sportKey, comp: f.comp, match: f.match, home: f.home, away: f.away, t: f.t, label: f.pick.label, type: f.pick.type, point: f.pick.point, market: f.pick.market, odds: f.pick.odds, book: f.pick.book, p: f.pick.p, value: f.pick.value, suggested: f.pick.value ? stakeFor(f.pick.p, f.pick.odds, f.pick.pPush) : null })}` : ''}
      ${f.facts?.length ? `<ul class="muted">${f.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
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
    pronos() {
      const A = S.lastAnalysis(); if (!A) return emptyRun();
      const list = A.forecasts || [];
      return `<h2>Pronostics du jour</h2>
        <p class="muted">La lecture du moteur pour chaque match : résultat le plus probable et pari le plus probable sur ${esc(P.cfg().targetBook === 'winamax_fr' ? 'Winamax' : 'votre bookmaker')}. Un pronostic probable n’est pas forcément rentable : seuls ceux marqués <span class="tag t-ok">VALUE</span> battent la cote juste.</p>
        ${list.length ? `<div class="grid">${list.map(pronoCard).join('')}</div>` : '<section class="card empty"><p>Aucun pronostic : relancez une analyse.</p></section>'}`;
    },
    dashboard() {
      const A = S.lastAnalysis(), C = P.cfg();
      const today = new Date().toLocaleDateString('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const kpi = (l, v, s) => `<div class="kpi"><small>${l}</small><b>${v}</b>${s ? `<span>${s}</span>` : ''}</div>`;
      return `<section class="hero">
        <div class="date">${esc(today)}</div>
        ${statusPills()}
        <div class="kpirow">
          ${kpi('Événements disponibles', int(A?.counts?.available), '48 h, compétitions actives')}
          ${kpi('Matchs analysés', int(A?.counts?.analysed))}
          ${kpi('Sélections étudiées', int(A?.counts?.markets))}
          ${kpi('Simulations', int(A?.counts?.sims))}
          ${kpi('Dernière actualisation', A ? ago(A.finishedAt) : 'jamais', A ? dt(A.finishedAt) : '')}
        </div>
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
      ${A ? safeList(A) : ''}
      ${A ? summaryBlock(A) : `<section class="card empty"><h3>Aucune analyse pour l’instant</h3><p>Le premier lancement télécharge environ deux saisons de résultats ESPN (mis en cache ensuite) puis consomme des crédits The Odds API : environ 3 par compétition scannée.</p></section>`}`;
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
      </div>
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
      const n = (id, v, l, step = 0.01) => `<label>${l}<input id="${id}" type="number" step="${step}" value="${v}"></label>`;
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
        <section class="card"><h3>Compétitions</h3><div class="chks">${Object.entries(D.FOOTBALL).map(([k2, v]) => chk('L-' + k2, C.leagues[k2], v.name + (v.stats ? '' : ' <small>(marché seul)</small>'))).join('')}
          ${chk('c-nba', C.nba, 'NBA')}${chk('c-tennis', C.tennis, 'Tennis ATP/WTA (tournois actifs)')}</div>
          ${n('c-tt', C.maxTennisTournaments, 'Tournois de tennis max', 1)}</section>
        <section class="card"><h3>Type de pronostic du jour</h3><div class="g3">
          <label>Mode <select id="c-mode"><option value="sûr" ${C.mode !== 'value' ? 'selected' : ''}>Paris sûrs : très probables, petites cotes</option><option value="value" ${C.mode === 'value' ? 'selected' : ''}>Value : rentabilité maximale, cotes plus hautes</option></select></label>
          ${n('c-sminp', C.safeMinP, 'Probabilité minimale d’un pari sûr', 0.01)}${n('c-smaxo', C.safeMaxOdds, 'Cote maximale d’un pari sûr', 0.05)}${n('c-stol', C.safeTolEV, 'Tolérance de cote (−0.03 = 3 % sous la vraie valeur)', 0.005)}${n('c-sst', C.safeStakePct, 'Mise par pari sûr (0.02 = 2 % de la bankroll)', 0.005)}</div>
          <p class="muted">Un pari sûr perd quand même parfois : à 75 %, une fois sur quatre. La bankroll ne grossit que si les cotes jouées ne sont pas en dessous de leur vraie valeur, c’est pourquoi la tolérance est limitée.</p></section>
        <section class="card"><h3>Mise indicative</h3><div class="g3">
          ${n('c-bank', C.bankroll, 'Bankroll (€)', 1)}${n('c-kf', C.kellyFrac, 'Fraction de Kelly (0.25 = quart)', 0.05)}${n('c-maxst', C.maxStakePct, 'Mise max (0.02 = 2 % de la bankroll)', 0.005)}</div>
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

  function emptyRun() { return `<section class="card empty"><h3>Aucune analyse</h3><p>Lancez une analyse depuis le <a href="#dashboard">tableau de bord</a>.</p></section>`; }
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

  // ------------------------------------------------------------ routage et événements
  function route() {
    const h = (location.hash || '#dashboard').slice(1);
    const page = pages[h] ? h : 'dashboard';
    document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + page));
    BETDRAFTS.clear();
    $('#main').innerHTML = pages[page]() + disclaimer();
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
        for (const k of Object.keys(D.FOOTBALL)) C.leagues[k] = c('L-' + k);
        C.nba = c('c-nba'); C.tennis = c('c-tennis'); C.maxTennisTournaments = Math.max(0, +v('c-tt'));
        C.minOdds = Math.max(1.2, +v('c-minodds')); C.maxOdds = +v('c-maxodds'); C.minEV = Math.max(0, +v('c-minev'));
        C.maxOddsAgeMin = +v('c-age'); C.maxGap = +v('c-gap'); C.wMarket = Math.min(1, Math.max(0, +v('c-wm'))); C.hours = +v('c-hours'); C.extendTo48 = c('c-48');
        C.minSims = Math.max(10000, +v('c-mins')); C.maxSims = Math.max(C.minSims, +v('c-maxs')); C.tol = Math.max(0.0005, +v('c-tol')); C.phase2Events = Math.max(1, +v('c-p2'));
        C.mode = v('c-mode'); C.safeMinP = Math.min(0.95, Math.max(0.55, +v('c-sminp'))); C.safeMaxOdds = Math.max(1.2, +v('c-smaxo')); C.safeTolEV = Math.min(0, Math.max(-0.08, +v('c-stol'))); C.safeStakePct = Math.min(0.05, Math.max(0, +v('c-sst')));
        C.bankroll = Math.max(0, +v('c-bank')); C.kellyFrac = Math.min(1, Math.max(0, +v('c-kf'))); C.maxStakePct = Math.min(0.1, Math.max(0, +v('c-maxst')));
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
