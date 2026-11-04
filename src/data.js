/* SportPredict AI — connecteurs de données.
 * Chaque connecteur est indépendant et renvoie des objets horodatés avec leur provenance.
 * Aucune donnée manquante n'est inventée : un échec renvoie { ok:false, error }.
 */
const SPData = (() => {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const log = [];
  // nettoyage des anciens caches volumineux (versions précédentes) au démarrage
  try { Object.keys(localStorage).filter((k) => k.startsWith('sp:c:espn')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  const apiStatus = {}; // fournisseur -> {ok, at, msg, remaining}
  function setStatus(provider, ok, msg, extra = {}) {
    apiStatus[provider] = { ok, at: Date.now(), msg, ...extra };
  }
  function meta(source, url, extra = {}) {
    return { source, url, fetchedAt: new Date().toISOString(), status: 'vérifié', ...extra };
  }

  // Cache mémoire + localStorage, avec TTL. La clé n'inclut jamais la clé API.
  const mem = new Map();
  async function cachedJSON(cacheKey, url, ttlMs, provider, { headers, raw } = {}) {
    const now = Date.now();
    const m = mem.get(cacheKey) || LS.get('sp:c:' + cacheKey, null);
    if (m && now - m.at < ttlMs) return { ok: true, data: m.data, at: m.at, cached: true, headers: m.headers || {} };
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      const hdr = {};
      for (const h of ['x-requests-remaining', 'x-requests-used', 'x-requests-last']) {
        const v = res.headers.get(h); if (v != null) hdr[h] = v;
      }
      if (!res.ok) {
        let body = ''; try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
        throw new Error(`HTTP ${res.status} ${body}`);
      }
      const data = await res.json();
      const entry = { at: now, data, headers: hdr };
      mem.set(cacheKey, entry);
      // Persistance limitée : Safari (iPhone) n'accorde qu'environ 5 Mo par site. Les grosses réponses
      // (ESPN notamment) restent en mémoire seulement, pour garder la place aux analyses et aux paris.
      if (!raw && !cacheKey.startsWith('espn:')) { const s = JSON.stringify(entry); if (s.length < 60000) LS.set('sp:c:' + cacheKey, entry); }
      setStatus(provider, true, 'OK', hdr['x-requests-remaining'] ? { remaining: +hdr['x-requests-remaining'] } : {});
      log.push({ at: now, provider, url: cacheKey, ok: true });
      return { ok: true, data, at: now, cached: false, headers: hdr };
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'délai dépassé (25 s)' : (e.message || String(e));
      setStatus(provider, false, msg);
      log.push({ at: now, provider, url: cacheKey, ok: false, msg });
      // stratégie de secours : dernière version en cache, signalée comme périmée
      if (m) return { ok: true, data: m.data, at: m.at, cached: true, stale: true, error: msg, headers: m.headers || {} };
      return { ok: false, error: msg };
    } finally { clearTimeout(to); }
  }
  function purgeCache() {
    try { Object.keys(localStorage).filter((k) => k.startsWith('sp:c:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    mem.clear();
  }

  // ------------------------------------------------------------------ The Odds API
  const ODDS = 'https://api.the-odds-api.com/v4';
  // Correspondance compétitions The Odds API -> ESPN (identifiants publics ESPN).
  const FOOTBALL = {
    soccer_france_ligue_one: { espn: 'fra.1', name: 'Ligue 1', stats: true, on: true },
    soccer_epl: { espn: 'eng.1', name: 'Premier League', stats: true, on: true },
    soccer_spain_la_liga: { espn: 'esp.1', name: 'Liga', stats: true, on: true },
    soccer_italy_serie_a: { espn: 'ita.1', name: 'Serie A', stats: true, on: true },
    soccer_germany_bundesliga: { espn: 'ger.1', name: 'Bundesliga', stats: true, on: true },
    soccer_uefa_champs_league: { espn: 'uefa.champions', name: 'Ligue des champions', stats: false, on: true },
    soccer_uefa_europa_league: { espn: 'uefa.europa', name: 'Europa League', stats: false, on: true },
    soccer_uefa_europa_conference_league: { espn: 'uefa.europa.conf', name: 'Conference League', stats: false, on: false },
    soccer_france_ligue_two: { espn: 'fra.2', name: 'Ligue 2', stats: true, on: false },
    soccer_efl_champ: { espn: 'eng.2', name: 'Championship', stats: true, on: false },
    soccer_netherlands_eredivisie: { espn: 'ned.1', name: 'Eredivisie', stats: true, on: false },
    soccer_portugal_primeira_liga: { espn: 'por.1', name: 'Liga Portugal', stats: true, on: false },
    soccer_spl: { espn: 'sco.1', name: 'Premiership (Écosse)', stats: true, on: false },
    soccer_belgium_first_div: { espn: 'bel.1', name: 'Pro League (Belgique)', stats: true, on: false },
    soccer_turkey_super_league: { espn: 'tur.1', name: 'Süper Lig (Turquie)', stats: true, on: false },
    soccer_greece_super_league: { espn: 'gre.1', name: 'Super League (Grèce)', stats: true, on: false },
    soccer_germany_bundesliga2: { espn: 'ger.2', name: '2. Bundesliga', stats: true, on: false },
    soccer_italy_serie_b: { espn: 'ita.2', name: 'Serie B', stats: true, on: false },
    soccer_spain_segunda_division: { espn: 'esp.2', name: 'Liga 2 (Espagne)', stats: true, on: false },
    soccer_england_league1: { espn: 'eng.3', name: 'League One', stats: true, on: false },
    soccer_england_league2: { espn: 'eng.4', name: 'League Two', stats: true, on: false },
  };

  async function oddsSports(key) {
    // gratuit (ne consomme pas de crédit)
    return cachedJSON('odds:sports', `${ODDS}/sports?apiKey=${encodeURIComponent(key)}`, 30 * 60e3, 'The Odds API');
  }
  function isoNoMs(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  async function oddsFor(key, sportKey, { regions, markets, hours = 48, ttlMin = 10 }) {
    const from = isoNoMs(Date.now()), to = isoNoMs(Date.now() + hours * 3600e3);
    const q = `regions=${regions}&markets=${markets}&oddsFormat=decimal&dateFormat=iso&commenceTimeFrom=${from}&commenceTimeTo=${to}`;
    const ck = `odds:${sportKey}:${regions}:${markets}:${hours}`;
    return cachedJSON(ck, `${ODDS}/sports/${sportKey}/odds?apiKey=${encodeURIComponent(key)}&${q}`, ttlMin * 60e3, 'The Odds API', { raw: true });
  }
  async function oddsEvent(key, sportKey, eventId, { regions, markets }) {
    const q = `regions=${regions}&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;
    return cachedJSON(`odds:ev:${eventId}:${Date.now()}`, `${ODDS}/sports/${sportKey}/events/${eventId}/odds?apiKey=${encodeURIComponent(key)}&${q}`, 0, 'The Odds API', { raw: true });
  }
  // Liste des événements : gratuite (ne consomme pas de crédit). Sert à ne pas interroger les cotes
  // d'une compétition sans match dans la fenêtre.
  async function oddsEventsList(key, sportKey, hours = 48) {
    const from = isoNoMs(Date.now()), to = isoNoMs(Date.now() + hours * 3600e3);
    return cachedJSON(`odds:events:${sportKey}:${hours}`, `${ODDS}/sports/${sportKey}/events?apiKey=${encodeURIComponent(key)}&dateFormat=iso&commenceTimeFrom=${from}&commenceTimeTo=${to}`, 20 * 60e3, 'The Odds API', { raw: true });
  }
  async function oddsScores(key, sportKey, daysFrom = 3) {
    return cachedJSON(`odds:scores:${sportKey}`, `${ODDS}/sports/${sportKey}/scores?apiKey=${encodeURIComponent(key)}&daysFrom=${daysFrom}&dateFormat=iso`, 30 * 60e3, 'The Odds API', { raw: true });
  }

  // ------------------------------------------------------------------ ESPN (public, sans clé)
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
  const ymd = (d) => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');
  function parseEspnEvents(data) {
    const out = [];
    for (const ev of data?.events || []) {
      const c = ev.competitions?.[0]; if (!c) continue;
      const home = c.competitors?.find((x) => x.homeAway === 'home'), away = c.competitors?.find((x) => x.homeAway === 'away');
      if (!home || !away) continue;
      out.push({
        id: ev.id, t: Date.parse(ev.date), completed: !!ev.status?.type?.completed, state: ev.status?.type?.state,
        h: home.team?.displayName, a: away.team?.displayName,
        hs: home.score != null ? +home.score : null, as: away.score != null ? +away.score : null,
        venue: c.venue?.fullName || null,
      });
    }
    return out;
  }
  // Résultats d'une période, découpée en tranches (ESPN limite le volume par requête).
  // Résultats d'une période. Certaines ligues ESPN (NBA) refusent les plages de dates (« HTTP 400 ») :
  // perDay interroge alors jour par jour (dates=AAAAMMJJ), 6 requêtes en parallèle, avec cache long pour le passé.
  async function espnResults(sport, league, fromMs, toMs, chunkDays, perDay = false) {
    const all = []; const errors = [];
    if (perDay) {
      const days = [];
      for (let s = fromMs; s <= toMs; s += 86400e3) days.push(s);
      for (let i = 0; i < days.length; i += 6) {
        const rs = await Promise.all(days.slice(i, i + 6).map((s) => cachedJSON(`espn:${sport}:${league}:d${ymd(s)}`,
          `${ESPN}/${sport}/${league}/scoreboard?dates=${ymd(s)}`, s < Date.now() - 2 * 86400e3 ? 60 * 86400e3 : 3 * 3600e3, 'ESPN')));
        for (const r of rs) { if (!r.ok) errors.push(r.error); else all.push(...parseEspnEvents(r.data)); }
      }
    } else {
      for (let s = fromMs; s < toMs; s += chunkDays * 86400e3) {
        const e = Math.min(toMs, s + (chunkDays - 1) * 86400e3);
        const past = e < Date.now() - 2 * 86400e3;
        const r = await cachedJSON(`espn:${sport}:${league}:${ymd(s)}-${ymd(e)}`,
          `${ESPN}/${sport}/${league}/scoreboard?dates=${ymd(s)}-${ymd(e)}&limit=1000`,
          past ? 30 * 86400e3 : 6 * 3600e3, 'ESPN');
        if (!r.ok) { errors.push(r.error); continue; }
        all.push(...parseEspnEvents(r.data));
      }
    }
    const seen = new Set();
    const games = all.filter((g) => g.completed && g.hs != null && !seen.has(g.id) && seen.add(g.id));
    return { games, errors, meta: meta('ESPN scoreboard', `${ESPN}/${sport}/${league}/scoreboard`) };
  }
  // Tableau des matchs autour d'une date : jour par jour (compatible avec toutes les ligues ESPN).
  async function espnScoreboard(sport, league, fromMs, toMs) {
    const evs = [], errs = [];
    let at = Date.now();
    for (let s = fromMs; s <= toMs + 1; s += 86400e3) {
      const r = await cachedJSON(`espn:sb:${sport}:${league}:d${ymd(s)}`, `${ESPN}/${sport}/${league}/scoreboard?dates=${ymd(s)}`, 15 * 60e3, 'ESPN');
      if (r.ok) { evs.push(...parseEspnEvents(r.data)); at = Math.min(at, r.at); } else errs.push(r.error);
    }
    if (!evs.length && errs.length) return { ok: false, error: errs[0] };
    const seen = new Set();
    return { ok: true, events: evs.filter((e) => !seen.has(e.id) && seen.add(e.id)), at };
  }
  async function espnSummary(sport, league, eventId) {
    return cachedJSON(`espn:sum:${league}:${eventId}`, `${ESPN}/${sport}/${league}/summary?event=${eventId}`, 10 * 60e3, 'ESPN');
  }
  async function espnNews(sport, league) {
    const r = await cachedJSON(`espn:news:${sport}:${league}`, `${ESPN}/${sport}/${league}/news?limit=50`, 30 * 60e3, 'ESPN');
    if (!r.ok) return r;
    return {
      ok: true,
      items: (r.data.articles || []).map((a) => ({
        title: a.headline, desc: a.description || '', published: a.published || a.lastModified || null,
        url: a.links?.web?.href || null, source: 'ESPN',
      })),
      at: r.at,
    };
  }
  async function nbaInjuries() {
    const r = await cachedJSON('espn:nba:injuries', `${ESPN}/basketball/nba/injuries`, 20 * 60e3, 'ESPN');
    if (!r.ok) return r;
    const byTeam = {};
    for (const t of r.data.injuries || []) {
      const name = t.displayName || t.team?.displayName;
      byTeam[name] = (t.injuries || []).map((i) => ({
        player: i.athlete?.displayName || '?', status: i.status || i.type?.description || '?',
        detail: i.shortComment || i.longComment || '', date: i.date || null,
      }));
    }
    return { ok: true, byTeam, at: r.at, meta: meta('ESPN injuries', `${ESPN}/basketball/nba/injuries`) };
  }

  // ------------------------------------------------------------------ données quotidiennes (GitHub Actions)
  // Fichiers publiés à côté de l'application : data/football.json, xg.json, clubelo.json, tennis.json, meta.json
  let local = null;
  async function localData() {
    if (local) return local;
    local = {};
    if (location.protocol === 'file:') { setStatus('Données quotidiennes', false, 'indisponibles en fichier local (ouvrez la version en ligne)'); return local; }
    for (const f of ['meta', 'football', 'xg', 'clubelo', 'tennis', 'nba', 'scorers']) {
      try {
        const r = await fetch(`./data/${f}.json`, { cache: 'no-cache' });
        if (r.ok) local[f] = await r.json();
      } catch { /* fichier local ouvert hors GitHub Pages : données indisponibles */ }
    }
    const m = local.meta;
    if (m) setStatus('Données quotidiennes', true, `générées ${m.generatedAt}`, { at: Date.parse(m.generatedAt) });
    else setStatus('Données quotidiennes', false, 'indisponibles (ouvrez la version en ligne)');
    return local;
  }

  // ------------------------------------------------------------------ appariement des noms
  const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ssc', 'us', 'rc', 'cd', 'ud', 'sd', 'club', 'de', 'the', 'calcio', 'fk', 'sv', 'vfb', 'vfl', 'tsg', 'bv', 'sl', 'ogc', 'losc', 'stade', 'rcd', 'ca', 'sco', 'hsc', 'aj', 'if', '1', '04', '05', '1899', '1846', '1907', '1913', 'and', 'hove']);
  const ALIAS = {
    'inter milan': 'internazionale', 'paris saint germain': 'paris saint-germain', 'psg': 'paris saint-germain',
    'athletic bilbao': 'athletic club', 'la clippers': 'los angeles clippers', 'man utd': 'manchester united',
    'man city': 'manchester city', 'wolves': 'wolverhampton wanderers', 'spurs': 'tottenham hotspur',
    'bayern munchen': 'bayern munich', 'atletico madrid': 'atletico de madrid', 'celta vigo': 'celta',
    'sevilla fc': 'sevilla', 'as roma': 'roma', 'ac milan': 'milan', 'olympique lyonnais': 'lyon',
    'olympique de marseille': 'marseille', 'brest': 'stade brestois', 'rennes': 'stade rennais',
    // noms courts de football-data.co.uk / ClubElo
    'man united': 'manchester united', 'nott m forest': 'nottingham forest', 'newcastle': 'newcastle united',
    'west ham': 'west ham united', 'tottenham': 'tottenham hotspur', 'brighton': 'brighton and hove albion', 'leeds': 'leeds united',
    'paris sg': 'paris saint-germain', 'paris saint germain': 'paris saint-germain', 'st etienne': 'saint etienne',
    'ath madrid': 'atletico de madrid', 'atletico madrid': 'atletico de madrid', 'ath bilbao': 'athletic club', 'bilbao': 'athletic club', 'sociedad': 'real sociedad', 'betis': 'real betis',
    'vallecano': 'rayo vallecano', 'espanol': 'espanyol', 'celta': 'celta', 'ein frankfurt': 'eintracht frankfurt', 'frankfurt': 'eintracht frankfurt',
    'm gladbach': 'borussia monchengladbach', 'gladbach': 'borussia monchengladbach', 'borussia m gladbach': 'borussia monchengladbach', 'leverkusen': 'bayer leverkusen', 'dortmund': 'borussia dortmund',
    'fc koln': 'koln', 'inter': 'internazionale', 'verona': 'hellas verona', 'sheffield united': 'sheffield united', 'qpr': 'queens park rangers',
  };
  function norm(s) {
    let x = (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[&.'’-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (ALIAS[x]) x = ALIAS[x];
    return x;
  }
  function tokens(s) { return norm(s).split(' ').filter((t) => t && !STOP.has(t)); }
  function sim(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb) return 1;
    const A = tokens(a), B = tokens(b);
    if (!A.length || !B.length) return 0;
    let inter = 0;
    for (const t of A) if (B.some((u) => u === t || (t.length > 3 && u.length > 3 && (u.startsWith(t) || t.startsWith(u))))) inter++;
    return inter / Math.max(A.length, B.length);
  }
  function bestMatch(name, candidates) {
    let best = null, score = 0;
    for (const c of candidates) { const s = sim(name, c); if (s > score) { score = s; best = c; } }
    return { name: score >= 0.5 ? best : null, score };
  }

  // ------------------------------------------------------------------ Claude (analyse qualitative)
  let anthropicMod = null;
  async function claudeAnalyze(apiKey, payload) {
    if (!anthropicMod) anthropicMod = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm');
    const Anthropic = anthropicMod.default || anthropicMod.Anthropic;
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const schema = {
      type: 'object', additionalProperties: false,
      required: ['resume', 'facteurs_favorables', 'facteurs_defavorables', 'risques', 'contradictions', 'impact', 'sources_utilisees'],
      properties: {
        resume: { type: 'string' },
        facteurs_favorables: { type: 'array', items: { type: 'string' } },
        facteurs_defavorables: { type: 'array', items: { type: 'string' } },
        risques: { type: 'array', items: { type: 'string' } },
        contradictions: { type: 'array', items: { type: 'string' } },
        impact: { type: 'string', enum: ['aucun', 'mineur', 'majeur'] },
        sources_utilisees: { type: 'array', items: { type: 'string' } },
      },
    };
    const system = `Tu es l'analyste qualitatif de SportPredict AI. Tu reçois une sélection de pari déjà calculée par des modèles statistiques, ainsi que des titres d'actualité et des rapports de blessures horodatés, chacun avec un identifiant de source [S1], [S2]...
Règles :
- N'utilise QUE les informations fournies. N'invente aucune statistique, aucun nom, aucune blessure.
- Ne donne pas de probabilité et ne décide pas du résultat : tu identifies uniquement des facteurs et des risques.
- Chaque facteur ou risque cite l'identifiant de sa source, par exemple « [S3] ».
- Une rumeur ou une information non officielle est signalée comme telle.
- impact = "majeur" seulement si une information fournie peut changer sensiblement la probabilité (ex. absence confirmée ou incertaine d'un joueur clé, changement d'entraîneur, rotation annoncée) ; "aucun" si les sources ne disent rien de pertinent.
- Réponds en français, de façon concise.`;
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
    if (res.stop_reason === 'refusal') throw new Error('analyse refusée par le modèle');
    const txt = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    setStatus('Claude', true, 'OK');
    return JSON.parse(txt);
  }

  return {
    LS, log, apiStatus, setStatus, meta, purgeCache, FOOTBALL,
    oddsSports, oddsFor, oddsEvent, oddsScores, oddsEventsList,
    espnResults, espnScoreboard, espnSummary, espnNews, nbaInjuries,
    norm, sim, bestMatch, claudeAnalyze, localData,
  };
})();
