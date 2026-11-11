/* SportPredict AI — moteur statistique (pur JS, sans dépendance).
 * Ce fichier est utilisé tel quel dans le navigateur (thread principal + Web Worker)
 * et dans Node pour les tests. Toute la logique est dans SPEngineFactory pour
 * pouvoir être sérialisée vers le worker via Function.prototype.toString().
 */
function SPEngineFactory() {
  'use strict';
  const SP = { version: 'engine-1.0.0' };

  // ---------------------------------------------------------------- RNG
  // mulberry32 : rapide, 32 bits, reproductible avec la graine enregistrée dans le snapshot.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  SP.rng = rng;
  function normalPair(r) {
    let u = r(); while (u < 1e-12) u = r();
    const v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    return [m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)];
  }
  SP.normalPair = normalPair;
  function poissonDraw(r, lam) {
    // inversion (λ < ~15 en football) ; approximation normale au-delà
    if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normalPair(r)[0]));
    const u = r();
    let p = Math.exp(-lam), s = p, k = 0;
    while (u > s && k < 60) { k++; p *= lam / k; s += p; }
    return k;
  }
  SP.poissonDraw = poissonDraw;

  // ---------------------------------------------------------------- cotes
  SP.implied = (o) => 1 / o;
  SP.ev = (p, o) => p * o - 1;
  SP.overround = (odds) => odds.reduce((s, o) => s + 1 / o, 0) - 1;
  // Méthode « power » : trouve k tel que Σ (1/o_i)^k = 1. Corrige mieux le biais favori/outsider
  // que la normalisation proportionnelle. Retombe sur la normalisation si non convergé.
  SP.devig = function (odds) {
    const q = odds.map((o) => 1 / o);
    const sum = q.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return null;
    if (Math.abs(sum - 1) < 1e-9) return q;
    let lo = 0.5, hi = 3;
    const f = (k) => q.reduce((s, x) => s + Math.pow(x, k), 0) - 1;
    if (f(lo) * f(hi) > 0) return q.map((x) => x / sum);
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid; else hi = mid;
    }
    const k = (lo + hi) / 2;
    const p = q.map((x) => Math.pow(x, k));
    const s2 = p.reduce((a, b) => a + b, 0);
    return p.map((x) => x / s2);
  };
  // Méthode de Shin (1992/1993) : modélise une part z de parieurs « informés » ; corrige le biais
  // favori/outsider des marchés à 3 issues (1N2) mieux qu'une normalisation proportionnelle.
  SP.devigShin = function (odds) {
    const q = odds.map((o) => 1 / o), B = q.reduce((a, b) => a + b, 0);
    if (!(B > 1)) return q.map((x) => x / (B || 1));
    const probs = (z) => q.map((x) => (Math.sqrt(z * z + 4 * (1 - z) * x * x / B) - z) / (2 * (1 - z)));
    let lo = 0, hi = 0.4;
    for (let i = 0; i < 80; i++) { const z = (lo + hi) / 2; const s = probs(z).reduce((a, b) => a + b, 0); if (s > 1) lo = z; else hi = z; }
    const p = probs((lo + hi) / 2), s = p.reduce((a, b) => a + b, 0);
    return p.map((x) => x / s);
  };
  SP.median = function (a) {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  SP.sd = function (a) {
    if (a.length < 2) return 0;
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  };

  // Règlement générique d'une ligne (handicap asiatique / total) : x = marge ajustée.
  // Renvoie le rendement par unité misée (cote incluse) : gain=o, remboursé=1, perdu=0.
  // Les lignes en quart (.25/.75) sont scindées en deux demi-mises.
  function half(x) { return x > 1e-9 ? [1, 0] : (x < -1e-9 ? [0, 0] : [0, 1]); }
  // Renvoie {win, push} : parts de la mise gagnées / remboursées (0, 0.5 ou 1).
  SP.settleShares = function (margin, line) {
    if (line == null) return margin > 0 ? { win: 1, push: 0 } : { win: 0, push: 0 };
    const frac = Math.abs((line * 4) % 2);
    if (Math.abs(frac - 1) < 1e-9) {
      const a = half(margin + line - 0.25), b = half(margin + line + 0.25);
      return { win: (a[0] + b[0]) / 2, push: (a[1] + b[1]) / 2 };
    }
    const a = half(margin + line);
    return { win: a[0], push: a[1] };
  };
  SP.settleLine = function (margin, line, o) {
    const s = SP.settleShares(margin, line);
    return s.win * o + s.push;
  };

  // ---------------------------------------------------------------- Poisson / Dixon-Coles
  function pois(k, lam) {
    let p = Math.exp(-lam);
    for (let i = 1; i <= k; i++) p *= lam / i;
    return p;
  }
  SP.pois = pois;
  function tau(x, y, lh, la, rho) {
    if (x === 0 && y === 0) return 1 - lh * la * rho;
    if (x === 0 && y === 1) return 1 + lh * rho;
    if (x === 1 && y === 0) return 1 + la * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
  }
  SP.scoreMatrix = function (lh, la, rho = 0, max = 10) {
    const m = [];
    let tot = 0;
    for (let i = 0; i <= max; i++) {
      m.push([]);
      for (let j = 0; j <= max; j++) {
        const v = Math.max(0, pois(i, lh) * pois(j, la) * tau(i, j, lh, la, rho));
        m[i].push(v); tot += v;
      }
    }
    for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) m[i][j] /= tot;
    return m;
  };
  SP.matrix1x2 = function (m) {
    let h = 0, d = 0, a = 0;
    for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) {
      if (i > j) h += m[i][j]; else if (i === j) d += m[i][j]; else a += m[i][j];
    }
    return [h, d, a];
  };
  SP.matrixOver = function (m, line) {
    let o = 0;
    for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) if (i + j > line) o += m[i][j];
    return o;
  };

  // Lambdas implicites du marché : (pH,pD,pA[,pOver@line]) -> (λh, λa) par moindres carrés.
  SP.impliedLambdas = function (p1x2, over) {
    let best = null;
    const loss = (lh, la) => {
      const m = SP.scoreMatrix(lh, la, -0.05, 10);
      const r = SP.matrix1x2(m);
      let e = (r[0] - p1x2[0]) ** 2 + (r[1] - p1x2[1]) ** 2 + (r[2] - p1x2[2]) ** 2;
      if (over) e += (SP.matrixOver(m, over.line) - over.p) ** 2;
      return e;
    };
    for (let lh = 0.2; lh <= 4.01; lh += 0.1) for (let la = 0.2; la <= 4.01; la += 0.1) {
      const e = loss(lh, la);
      if (!best || e < best.e) best = { lh, la, e };
    }
    // raffinement local
    let step = 0.05;
    for (let it = 0; it < 40 && step > 0.002; it++) {
      let improved = false;
      for (const [dh, da] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const lh = best.lh + dh, la = best.la + da;
        if (lh <= 0.05 || la <= 0.05) continue;
        const e = loss(lh, la);
        if (e < best.e) { best = { lh, la, e }; improved = true; }
      }
      if (!improved) step /= 2;
    }
    return best;
  };

  // Ajustement Dixon-Coles pondéré dans le temps (Dixon & Coles 1997, ξ par jour).
  // matches : [{t (ms), h, a, hg, ag}] ; renvoie attaques/défenses, avantage domicile, rho.
  SP.fitDixonColes = function (matches, opts = {}) {
    const xi = opts.xi ?? 0.0019; // demi-vie ≈ 1 an
    const ridge = opts.ridge ?? 2.0; // rétrécissement vers la moyenne (petits échantillons)
    const now = opts.asOf ?? Math.max(...matches.map((m) => m.t));
    const teams = [...new Set(matches.flatMap((m) => [m.h, m.a]))];
    const idx = new Map(teams.map((t, i) => [t, i]));
    const n = teams.length;
    const att = new Float64Array(n), def = new Float64Array(n);
    let home = 0.25, mu = Math.log(1.3);
    const data = matches.filter((m) => m.t <= now).map((m) => ({
      h: idx.get(m.h), a: idx.get(m.a), hg: m.hg, ag: m.ag,
      w: Math.exp(-xi * (now - m.t) / 86400000),
    }));
    if (data.length < 20) return null;
    const W = data.reduce((s, d) => s + d.w, 0);
    // Descente par blocs (attaques, puis défenses, puis domicile/moyenne), pas de Newton diagonal.
    // Mettre à jour tous les paramètres en même temps fait osciller l'ajustement, car ils absorbent
    // le même résidu : c'est ce que le backtest sur données réelles a montré.
    const pass = (block) => {
      const g = new Float64Array(n), h = new Float64Array(n);
      let gH = 0, hH = 0, gM = 0, hM = 0;
      for (const d of data) {
        const lh = Math.exp(mu + home + att[d.h] + def[d.a]);
        const la = Math.exp(mu + att[d.a] + def[d.h]);
        const rh = d.w * (d.hg - lh), ra = d.w * (d.ag - la);
        if (block === 0) { g[d.h] += rh; h[d.h] += d.w * lh; g[d.a] += ra; h[d.a] += d.w * la; }
        else if (block === 1) { g[d.a] += rh; h[d.a] += d.w * lh; g[d.h] += ra; h[d.h] += d.w * la; }
        else { gH += rh; hH += d.w * lh; gM += rh + ra; hM += d.w * (lh + la); }
      }
      if (block === 0) for (let i = 0; i < n; i++) att[i] += (g[i] - ridge * att[i]) / (h[i] + ridge);
      else if (block === 1) for (let i = 0; i < n; i++) def[i] += (g[i] - ridge * def[i]) / (h[i] + ridge);
      else { mu += gM / (hM + 1e-9); }
      if (block === 3) home += gH / (hH + 1e-9);
    };
    for (let it = 0; it < 40; it++) {
      pass(0); pass(1); pass(2); pass(3);
      const ma = att.reduce((s, x) => s + x, 0) / n, md = def.reduce((s, x) => s + x, 0) / n;
      for (let i = 0; i < n; i++) { att[i] -= ma; def[i] -= md; }
      mu += ma + md;
    }
    // rho par recherche 1D (sans objet pour un ajustement sur xG non entiers)
    let bestRho = 0, bestLL = -Infinity;
    for (let rho = -0.2; rho <= 0.1001 && !opts.skipRho; rho += 0.01) {
      let ll = 0;
      for (const d of data) {
        if (d.hg > 1 || d.ag > 1) continue;
        const lh = Math.exp(mu + home + att[d.h] + def[d.a]);
        const la = Math.exp(mu + att[d.a] + def[d.h]);
        const t = tau(d.hg, d.ag, lh, la, rho);
        if (t <= 0) { ll = -Infinity; break; }
        ll += d.w * Math.log(t);
      }
      if (ll > bestLL) { bestLL = ll; bestRho = rho; }
    }
    const games = new Map();
    for (const d of data) { games.set(d.h, (games.get(d.h) || 0) + 1); games.set(d.a, (games.get(d.a) || 0) + 1); }
    const model = {
      teams, mu, home, rho: Math.round(bestRho * 100) / 100, nMatches: data.length, effN: W,
      att: Object.fromEntries(teams.map((t, i) => [t, att[i]])),
      def: Object.fromEntries(teams.map((t, i) => [t, def[i]])),
      games: Object.fromEntries(teams.map((t, i) => [t, games.get(i) || 0])),
    };
    return model;
  };
  SP.dcLambdas = function (model, h, a) {
    if (!model || !(h in model.att) || !(a in model.att)) return null;
    return {
      lh: Math.exp(model.mu + model.home + model.att[h] + model.def[a]),
      la: Math.exp(model.mu + model.att[a] + model.def[h]),
    };
  };

  // ---------------------------------------------------------------- Elo générique
  SP.eloRun = function (matches, opts = {}) {
    const K = opts.K ?? 20, H = opts.home ?? 60, init = 1500;
    const R = new Map();
    const get = (t) => (R.has(t) ? R.get(t) : init);
    const pre = [];
    for (const m of matches) {
      const rh = get(m.h), ra = get(m.a);
      const dr = rh + H - ra;
      pre.push(dr);
      const e = 1 / (1 + Math.pow(10, -dr / 400));
      const s = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
      const gd = Math.abs(m.hg - m.ag);
      const mult = opts.marginMult ? opts.marginMult(gd, dr) : (gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8);
      R.set(m.h, rh + K * mult * (s - e));
      R.set(m.a, ra - K * mult * (s - e));
    }
    return { ratings: R, preDiff: pre, get, H };
  };

  // Régression logistique ordinale (H > D > A) sur la différence Elo, ajustée par gradient.
  // P(A) = σ(c1 − b·x), P(A ou D) = σ(c2 − b·x)   (x = diff/100)
  SP.fitOrdinal = function (xs, ys) {
    let b = 0.3, c1 = -0.4, c2 = 0.6;
    const sig = (z) => 1 / (1 + Math.exp(-z));
    const lr = 0.05;
    for (let it = 0; it < 400; it++) {
      let gb = 0, g1 = 0, g2 = 0;
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i], y = ys[i];
        const s1 = sig(c1 - b * x), s2 = sig(c2 - b * x);
        // log-vraisemblance et gradients
        if (y === 2) { // extérieur
          g1 += (1 - s1); gb += -(1 - s1) * x;
        } else if (y === 1) { // nul
          const pd = Math.max(1e-9, s2 - s1);
          const d2 = s2 * (1 - s2), d1 = s1 * (1 - s1);
          g2 += d2 / pd; g1 += -d1 / pd; gb += (-d2 * x + d1 * x) / pd;
        } else { // domicile
          g2 += -s2; gb += s2 * x;
        }
      }
      const n = xs.length || 1;
      b += lr * gb / n; c1 += lr * g1 / n * 4; c2 += lr * g2 / n * 4;
      if (c2 < c1 + 0.05) c2 = c1 + 0.05;
    }
    return { b, c1, c2 };
  };
  SP.ordinalProbs = function (p, diff) {
    const sig = (z) => 1 / (1 + Math.exp(-z));
    const x = diff / 100;
    const pa = sig(p.c1 - p.b * x), pad = sig(p.c2 - p.b * x);
    return [1 - pad, Math.max(0.01, pad - pa), pa];
  };

  SP.logLoss3 = (p, y) => -Math.log(Math.max(1e-9, p[y]));
  SP.brier3 = (p, y) => p.reduce((s, v, i) => s + (v - (i === y ? 1 : 0)) ** 2, 0);

  // Pondération d'ensemble : minimise la log-loss du mélange sur les prédictions
  // hors-échantillon (chronologiques). Grille sur le simplexe (pas 0.05).
  SP.stackWeights = function (predsByModel, ys) {
    const names = Object.keys(predsByModel);
    if (names.length === 1) return { [names[0]]: 1 };
    let best = null;
    const step = 0.05;
    const rec = (k, left, w) => {
      if (k === names.length - 1) {
        const ww = [...w, left];
        let ll = 0;
        for (let i = 0; i < ys.length; i++) {
          const mix = [0, 0, 0].map((_, c) => names.reduce((s, nm, j) => s + ww[j] * predsByModel[nm][i][c], 0));
          ll += SP.logLoss3(mix, ys[i]);
        }
        if (!best || ll < best.ll) best = { ll, w: ww };
        return;
      }
      for (let x = 0; x <= left + 1e-9; x += step) rec(k + 1, Math.round((left - x) * 100) / 100, [...w, x]);
    };
    rec(0, 1, []);
    return Object.fromEntries(names.map((n, i) => [n, best.w[i]]));
  };

  // Validation chronologique football : chaque match est prédit uniquement avec les
  // matchs antérieurs (Elo séquentiel ; Dixon-Coles réajusté tous les `refitDays` jours).
  SP.footballBacktest = function (matches, opts = {}) {
    const ms = [...matches].sort((a, b) => a.t - b.t);
    const warm = opts.warmup ?? Math.max(60, Math.floor(ms.length * 0.35));
    const refit = (opts.refitDays ?? 14) * 86400000;
    const elo = SP.eloRun(ms, { K: 20, home: 60 });
    const ys = ms.map((m) => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2));
    // ordinal Elo ajusté sur la phase de chauffe seulement (pas de fuite)
    const ord = SP.fitOrdinal(elo.preDiff.slice(0, warm).map((d) => d / 100), ys.slice(0, warm));
    const hasXG = ms.filter((m) => m.hxg != null).length >= 0.7 * ms.length;
    const preds = hasXG ? { elo: [], dc: [], xg: [] } : { elo: [], dc: [] }, yy = [], mkt = [];
    let dc = null, dcx = null, lastFit = -Infinity;
    for (let i = warm; i < ms.length; i++) {
      const m = ms[i];
      if (m.t - lastFit > refit || !dc) {
        dc = SP.fitDixonColes(ms.slice(0, i), { asOf: m.t });
        if (hasXG) dcx = SP.fitDixonColes(ms.slice(0, i).filter((x) => x.hxg != null).map((x) => ({ ...x, hg: x.hxg, ag: x.axg })), { asOf: m.t, skipRho: true });
        lastFit = m.t;
      }
      const lam = SP.dcLambdas(dc, m.h, m.a);
      if (!lam) continue;
      let px = null;
      if (hasXG) { const lx = SP.dcLambdas(dcx, m.h, m.a); if (!lx) continue; px = SP.matrix1x2(SP.scoreMatrix(lx.lh, lx.la, dc.rho, 10)); }
      preds.dc.push(SP.matrix1x2(SP.scoreMatrix(lam.lh, lam.la, dc.rho, 10)));
      preds.elo.push(SP.ordinalProbs(ord, elo.preDiff[i]));
      if (hasXG) preds.xg.push(px);
      mkt.push(m.pin ? SP.devig(m.pin) : null);
      yy.push(ys[i]);
    }
    if (yy.length < 30) return null;
    // référence naïve : fréquences de la phase de chauffe
    const fq = [0, 0, 0]; ys.slice(0, warm).forEach((y) => fq[y]++);
    const tot = fq[0] + fq[1] + fq[2];
    const naive = fq.map((x) => x / tot);
    const res = { n: yy.length, models: {} };
    for (const k of Object.keys(preds)) {
      res.models[k] = {
        logLoss: preds[k].reduce((s, p, i) => s + SP.logLoss3(p, yy[i]), 0) / yy.length,
        brier: preds[k].reduce((s, p, i) => s + SP.brier3(p, yy[i]), 0) / yy.length,
      };
    }
    res.naive = { logLoss: yy.reduce((s, y) => s + SP.logLoss3(naive, y), 0) / yy.length };
    res.weights = SP.stackWeights(preds, yy);
    const mix = yy.map((_, i) => [0, 1, 2].map((c) => Object.keys(preds).reduce((s, k) => s + res.weights[k] * preds[k][i][c], 0)));
    res.ensemble = {
      logLoss: mix.reduce((s, p, i) => s + SP.logLoss3(p, yy[i]), 0) / yy.length,
      brier: mix.reduce((s, p, i) => s + SP.brier3(p, yy[i]), 0) / yy.length,
    };
    res.calibration = SP.calibrationBins(mix.map((p) => p[0]), yy.map((y) => (y === 0 ? 1 : 0)));
    // comparaison au marché (cotes Pinnacle de clôture) et poids optimal marché/stats
    const idx = mkt.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    if (idx.length >= 80) {
      res.market = { n: idx.length, logLoss: idx.reduce((s, i) => s + SP.logLoss3(mkt[i], yy[i]), 0) / idx.length };
      let best = null;
      for (let w = 0; w <= 1.0001; w += 0.05) {
        const ll = idx.reduce((s, i) => s + SP.logLoss3([0, 1, 2].map((c) => w * mkt[i][c] + (1 - w) * mix[i][c]), yy[i]), 0) / idx.length;
        if (!best || ll < best.ll) best = { ll, w: Math.round(w * 100) / 100 };
      }
      res.wMarket = best.w; res.blend = { logLoss: best.ll };
    }
    res.hasXG = hasXG;
    // ordinal final ajusté sur tout l'historique pour la prédiction du jour
    res.ordinal = SP.fitOrdinal(elo.preDiff.map((d) => d / 100), ys);
    res.elo = elo;
    return res;
  };


  // xG : vrai xG football-data quand présent, sinon estimation par les tirs (conversion estimée
  // sur la phase de chauffe seulement, donc sans fuite dans le backtest).
  SP.attachXG = function (ms) {
    const warm = ms.slice(0, Math.max(60, Math.floor(ms.length * 0.35))).flatMap((m) => [[m.hst, m.hs, m.hg], [m.ast, m.as, m.ag]]).filter((x) => x[0] != null && x[1] != null);
    let a = null, b = 0, nReal = 0, nProxy = 0;
    if (warm.length >= 100) {
      let s11 = 0, s12 = 0, s22 = 0, y1 = 0, y2 = 0;
      for (const [on, tot, g] of warm) { const off = Math.max(0, tot - on); s11 += on * on; s12 += on * off; s22 += off * off; y1 += on * g; y2 += off * g; }
      const det = s11 * s22 - s12 * s12;
      a = (y1 * s22 - y2 * s12) / det; b = (y2 * s11 - y1 * s12) / det;
      if (!(a > 0) || !(b >= 0)) { a = y1 / s11; b = 0; }
    }
    for (const m of ms) {
      if (m.rxh != null && m.rxa != null) { m.hxg = m.rxh; m.axg = m.rxa; nReal++; }
      else if (a != null && m.hst != null && m.hs != null && m.ast != null && m.as != null) { m.hxg = a * m.hst + b * Math.max(0, m.hs - m.hst); m.axg = a * m.ast + b * Math.max(0, m.as - m.ast); nProxy++; }
    }
    return { nReal, nProxy, a, b, label: [nReal ? `xG réel football-data (${nReal})` : '', nProxy ? `xG estimé par les tirs (${nProxy}, ${a.toFixed(3)} but/tir cadré)` : ''].filter(Boolean).join(' + ') };
  };
  SP.fdRow = (r) => ({ t: r[0], h: r[1], a: r[2], hg: r[3], ag: r[4], hs: r[5], as: r[6], hst: r[7], ast: r[8], pin: r[13] && r[14] && r[15] ? [r[13], r[14], r[15]] : null, rxh: r[18] ?? null, rxa: r[19] ?? null, refSrc: r[20] || null, cornersH: r[9], cornersA: r[10], cardsH: r[11], cardsA: r[12] });

  // Comptages surdispersés (corners, cartons) : loi binomiale négative de moyenne μ et variance φ·μ.
  SP.nbPmf = function (k, mu, phi) {
    if (phi <= 1.0001) return pois(k, mu);
    const r = mu / (phi - 1), p = r / (r + mu);
    let lg = 0; for (let i = 0; i < k; i++) lg += Math.log(r + i) - Math.log(i + 1);
    return Math.exp(lg + r * Math.log(p) + k * Math.log(1 - p));
  };
  SP.nbOver = function (mu, phi, line) {
    let cdf = 0; for (let k = 0; k <= Math.floor(line); k++) cdf += SP.nbPmf(k, mu, phi);
    return Math.max(0, 1 - cdf);
  };
  // Modèle de comptage par équipe (attaque/défense, avantage domicile) + dispersion estimée sur les résidus.
  SP.fitCounts = function (ms, key) {
    const data = ms.filter((m) => m[key + 'H'] != null && m[key + 'A'] != null).map((m) => ({ t: m.t, h: m.h, a: m.a, hg: m[key + 'H'], ag: m[key + 'A'] }));
    if (data.length < 100) return null;
    const fit = SP.fitDixonColes(data, { skipRho: true, xi: 0.0025, ridge: 4 });
    if (!fit) return null;
    let num = 0, den = 0;
    for (const d of data) { const l = SP.dcLambdas(fit, d.h, d.a); if (!l) continue; const mu = l.lh + l.la; num += (d.hg + d.ag - mu) ** 2; den += mu; }
    fit.phi = Math.max(1, num / den);
    fit.n = data.length;
    return fit;
  };
  // Recalibrage de Platt : p' = σ(a + b·logit p), ajusté sur les résultats réels.
  SP.fitPlatt = function (ps, ys) {
    let a = 0, b = 1;
    const lg = (p) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
    for (let it = 0; it < 500; it++) {
      let ga = 0, gb = 0;
      for (let i = 0; i < ps.length; i++) { const x = lg(ps[i]); const q = 1 / (1 + Math.exp(-(a + b * x))); ga += ys[i] - q; gb += (ys[i] - q) * x; }
      a += 0.5 * ga / ps.length; b += 0.5 * gb / ps.length;
    }
    return { a, b };
  };
  SP.applyPlatt = (c, p) => { const x = Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p)); return 1 / (1 + Math.exp(-(c.a + c.b * x))); };

  // ---------------------------------------------------------------- Hockey (NHL)
  // Matrice des scores au temps réglementaire -> score final : une égalité devient une victoire d'un but
  // (prolongation ou tirs au but, qui comptent pour un but dans les marchés de paris). pOT = probabilité que
  // l'équipe à domicile gagne la prolongation / les tirs au but.
  SP.hockeyFinal = function (mat, pOT) {
    const M = mat.length, F = Array.from({ length: M + 1 }, () => new Array(M + 1).fill(0));
    for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) {
      const v = mat[i][j];
      if (i !== j) F[i][j] += v; else { F[i + 1][j] += v * pOT; F[i][j + 1] += v * (1 - pOT); }
    }
    return F;
  };
  // Le Poisson indépendant sous-estime les nuls au temps réglementaire en NHL : on gonfle la diagonale d'un
  // facteur k estimé sur le taux réel de prolongations (puis renormalisation).
  SP.inflateDraws = function (mat, k) {
    if (!k || Math.abs(k - 1) < 1e-6) return mat;
    let s = 0; const out = mat.map((r, i) => r.map((v, j) => { const x = i === j ? v * k : v; s += x; return x; }));
    return out.map((r) => r.map((v) => v / s));
  };
  SP.hockeyDrawK = function (games) {
    const g = games.filter((x) => x.ot != null); if (g.length < 200) return null;
    const rate = g.reduce((s, x) => s + x.ot, 0) / g.length;
    const lam = g.reduce((s, x) => s + x.hs + x.as - x.ot, 0) / g.length / 2; // buts au temps réglementaire
    const m = SP.scoreMatrix(lam, lam, 0, 12); let d = 0; m.forEach((r, i) => { d += r[i]; });
    // k tel que k·d / (1 − d + k·d) = rate
    const k = rate * (1 - d) / (d * (1 - rate));
    return { k: Math.min(2, Math.max(1, k)), rate, n: g.length };
  };
  SP.hockeyPOT = (lh, la) => Math.min(0.62, Math.max(0.38, 0.5 + 0.5 * (lh - la) / (lh + la)));
  // Histogramme Monte-Carlo (temps réglementaire, format football) -> pseudo-simulation au score final
  SP.hockeyRegSim = function (sim, k) {
    const M = sim.M, mat = [];
    for (let i = 0; i < M; i++) { mat.push([]); for (let j = 0; j < M; j++) mat[i].push(sim.hist[i * M + j]); }
    const tot = sim.hist.reduce((a, b) => a + b, 0);
    const R = SP.inflateDraws(mat.map((r) => r.map((v) => v / tot)), k || 1);
    return { ...sim, hist: R.flat().map((v) => v * tot) };
  };
  SP.hockeyFinalSim = function (sim, pOT, k) {
    const reg = SP.hockeyRegSim(sim, k);
    const M = reg.M, mat = [];
    for (let i = 0; i < M; i++) { mat.push([]); for (let j = 0; j < M; j++) mat[i].push(reg.hist[i * M + j]); }
    const F = SP.hockeyFinal(mat, pOT);
    return { ...sim, M: M + 1, hist: F.flat() };
  };
  // Backtest chronologique NHL : probabilité de victoire (prolongation incluse) d'un modèle de Poisson
  // attaque/défense pondéré dans le temps, contre le modèle naïf (taux de victoire à domicile).
  SP.hockeyBacktest = function (games) {
    const gs = [...games].sort((a, b) => a.t - b.t);
    const warm = Math.max(150, Math.floor(gs.length * 0.4));
    const ys = gs.map((g) => (g.hs > g.as ? 1 : 0));
    const base = ys.slice(0, warm).reduce((s, y) => s + y, 0) / warm;
    let m = null, last = -Infinity, ll = 0, llN = 0, br = 0, n = 0;
    const cal = [], obs = [];
    for (let i = warm; i < gs.length; i++) {
      const g = gs[i];
      if (!m || g.t - last > 10 * 86400e3) { m = SP.fitDixonColes(gs.slice(0, i).map((x) => ({ t: x.t, h: x.h, a: x.a, hg: x.hs, ag: x.as })), { asOf: g.t, skipRho: true, xi: 0.004, ridge: 3 }); last = g.t; }
      const l = SP.dcLambdas(m, g.h, g.a); if (!l) continue;
      const F = SP.hockeyFinal(SP.scoreMatrix(l.lh, l.la, 0, 12), SP.hockeyPOT(l.lh, l.la));
      let p = 0; F.forEach((r, a) => r.forEach((v, b) => { if (a > b) p += v; }));
      const y = ys[i];
      ll += -Math.log(Math.max(1e-9, y ? p : 1 - p)); llN += -Math.log(Math.max(1e-9, y ? base : 1 - base)); br += (p - y) ** 2; n++;
      cal.push(p); obs.push(y);
    }
    if (n < 50) return null;
    return { n, models: { poisson: { logLoss: ll / n, brier: br / n } }, naive: { logLoss: llN / n }, ensemble: { logLoss: ll / n }, weights: { poisson: 1 }, calibration: SP.calibrationBins(cal, obs) };
  };

  SP.calibrationBins = function (ps, ys, nb = 10) {
    const bins = Array.from({ length: nb }, () => ({ n: 0, p: 0, y: 0 }));
    ps.forEach((p, i) => {
      const b = Math.min(nb - 1, Math.floor(p * nb));
      bins[b].n++; bins[b].p += p; bins[b].y += ys[i];
    });
    return bins.filter((b) => b.n).map((b) => ({ n: b.n, pred: b.p / b.n, obs: b.y / b.n }));
  };

  // ---------------------------------------------------------------- NBA
  // Régression ridge pondérée : marge = HCA + r_h − r_a + β_rest·(repos) ; points = μ + off + def adverse.
  SP.fitNBA = function (games, opts = {}) {
    const xi = opts.xi ?? 0.006; // demi-vie ≈ 115 jours
    const lambda = opts.ridge ?? 8;
    const asOf = opts.asOf ?? Math.max(...games.map((g) => g.t));
    const gs = games.filter((g) => g.t < asOf + 1).map((g) => ({ ...g, w: Math.exp(-xi * (asOf - g.t) / 86400000) }));
    if (gs.length < 50) return null;
    const teams = [...new Set(gs.flatMap((g) => [g.h, g.a]))];
    const id = new Map(teams.map((t, i) => [t, i]));
    const n = teams.length;
    // jours de repos par équipe (calculés chronologiquement)
    const last = new Map();
    const sorted = [...gs].sort((a, b) => a.t - b.t);
    for (const g of sorted) {
      const rh = last.has(g.h) ? (g.t - last.get(g.h)) / 86400000 : 3;
      const ra = last.has(g.a) ? (g.t - last.get(g.a)) / 86400000 : 3;
      g.b2bH = rh < 1.6 ? 1 : 0; g.b2bA = ra < 1.6 ? 1 : 0;
      last.set(g.h, g.t); last.set(g.a, g.t);
    }
    // descente de coordonnées sur les points marqués : pts_h = μ + hca/2 + off_h − dfn_a + β·b2b_h
    const off = new Float64Array(n), dfn = new Float64Array(n);
    let mu = 112, hca = 2.5, bb = -1;
    for (let it = 0; it < 200; it++) {
      const nO = new Float64Array(n), dO = new Float64Array(n), nD = new Float64Array(n), dD = new Float64Array(n);
      let sMu = 0, wMu = 0, sH = 0, wH = 0, sB = 0, wB = 0;
      for (const g of sorted) {
        const i = id.get(g.h), j = id.get(g.a);
        const ph = mu + hca / 2 + off[i] - dfn[j] + bb * g.b2bH;
        const pa = mu - hca / 2 + off[j] - dfn[i] + bb * g.b2bA;
        const eh = g.hs - ph, ea = g.as - pa;
        nO[i] += g.w * (eh + off[i]); dO[i] += g.w; nO[j] += g.w * (ea + off[j]); dO[j] += g.w;
        nD[j] += g.w * (-eh + dfn[j]); dD[j] += g.w; nD[i] += g.w * (-ea + dfn[i]); dD[i] += g.w;
        sMu += g.w * (eh + ea); wMu += 2 * g.w;
        sH += g.w * (eh - ea); wH += g.w;
        if (g.b2bH || g.b2bA) { sB += g.w * (eh * g.b2bH + ea * g.b2bA); wB += g.w * (g.b2bH + g.b2bA); }
      }
      // Jacobi amorti : off, dfn et μ absorbent le même résidu -> pas de 1/3 pour converger
      for (let k = 0; k < n; k++) {
        off[k] += 0.35 * (nO[k] / (dO[k] + lambda) - off[k]);
        dfn[k] += 0.35 * (nD[k] / (dD[k] + lambda) - dfn[k]);
      }
      mu += 0.35 * sMu / wMu; hca += 0.5 * sH / wH; if (wB > 5) bb += 0.35 * sB / (wB + 20);
      const mo = off.reduce((s, x) => s + x, 0) / n, md = dfn.reduce((s, x) => s + x, 0) / n;
      for (let k = 0; k < n; k++) { off[k] -= mo; dfn[k] -= md; }
      mu += mo - md;
    }
    // résidus -> écarts-types et corrélation marge/total
    const em = [], et = [];
    for (const g of sorted) {
      const i = id.get(g.h), j = id.get(g.a);
      const ph = mu + hca / 2 + off[i] - dfn[j] + bb * g.b2bH;
      const pa = mu - hca / 2 + off[j] - dfn[i] + bb * g.b2bA;
      em.push((g.hs - g.as) - (ph - pa)); et.push((g.hs + g.as) - (ph + pa));
    }
    const sdM = SP.sd(em), sdT = SP.sd(et);
    const mM = em.reduce((s, x) => s + x, 0) / em.length, mT = et.reduce((s, x) => s + x, 0) / et.length;
    const cov = em.reduce((s, x, k) => s + (x - mM) * (et[k] - mT), 0) / (em.length - 1);
    return {
      teams, mu, hca, b2b: bb, sdMargin: sdM, sdTotal: sdT, corr: cov / (sdM * sdT), n: gs.length,
      off: Object.fromEntries(teams.map((t, k) => [t, off[k]])),
      dfn: Object.fromEntries(teams.map((t, k) => [t, dfn[k]])),
      lastPlayed: Object.fromEntries([...last.entries()]),
    };
  };
  SP.nbaPredict = function (m, h, a, t) {
    if (!m || !(h in m.off) || !(a in m.off)) return null;
    const b2bH = m.lastPlayed[h] && (t - m.lastPlayed[h]) / 86400000 < 1.6 ? 1 : 0;
    const b2bA = m.lastPlayed[a] && (t - m.lastPlayed[a]) / 86400000 < 1.6 ? 1 : 0;
    const ph = m.mu + m.hca / 2 + m.off[h] - m.dfn[a] + m.b2b * b2bH;
    const pa = m.mu - m.hca / 2 + m.off[a] - m.dfn[h] + m.b2b * b2bA;
    return { ph, pa, margin: ph - pa, total: ph + pa, b2bH, b2bA };
  };
  SP.normCdf = function (x) {
    // Abramowitz-Stegun 7.1.26
    const s = x < 0 ? -1 : 1; const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * y);
  };
  // Validation chronologique NBA : Elo (marge) vs ridge, sur la probabilité de victoire.
  SP.nbaBacktest = function (games, opts = {}) {
    const gs = [...games].sort((a, b) => a.t - b.t);
    const warm = opts.warmup ?? Math.max(150, Math.floor(gs.length * 0.4));
    const elo = SP.eloRun(gs.map((g) => ({ h: g.h, a: g.a, hg: g.hs, ag: g.as })), {
      K: 20, home: 70,
      marginMult: (mov, dr) => Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * Math.abs(dr)),
    });
    const ys = gs.map((g) => (g.hs > g.as ? 1 : 0));
    const preds = { elo: [], ridge: [] }, yy = [];
    let m = null, lastFit = -Infinity;
    for (let i = warm; i < gs.length; i++) {
      const g = gs[i];
      if (!m || g.t - lastFit > 7 * 86400000) { m = SP.fitNBA(gs.slice(0, i), { asOf: g.t - 1 }); lastFit = g.t; }
      const pr = SP.nbaPredict(m, g.h, g.a, g.t);
      if (!pr) continue;
      const pe = 1 / (1 + Math.pow(10, -elo.preDiff[i] / 400));
      const prr = SP.normCdf(pr.margin / m.sdMargin);
      preds.elo.push([pe, 0, 1 - pe]); preds.ridge.push([prr, 0, 1 - prr]);
      yy.push(ys[i] ? 0 : 2);
    }
    if (yy.length < 50) return null;
    const res = { n: yy.length, models: {} };
    for (const k of Object.keys(preds)) res.models[k] = {
      logLoss: preds[k].reduce((s, p, i) => s + SP.logLoss3(p, yy[i]), 0) / yy.length,
      brier: preds[k].reduce((s, p, i) => s + (p[0] - (yy[i] === 0 ? 1 : 0)) ** 2, 0) / yy.length,
    };
    res.weights = SP.stackWeights(preds, yy);
    const mix = yy.map((_, i) => res.weights.elo * preds.elo[i][0] + res.weights.ridge * preds.ridge[i][0]);
    res.ensemble = {
      logLoss: mix.reduce((s, p, i) => s - Math.log(Math.max(1e-9, yy[i] === 0 ? p : 1 - p)), 0) / yy.length,
      brier: mix.reduce((s, p, i) => s + (p - (yy[i] === 0 ? 1 : 0)) ** 2, 0) / yy.length,
    };
    res.calibration = SP.calibrationBins(mix, yy.map((y) => (y === 0 ? 1 : 0)));
    res.elo = elo;
    return res;
  };
  // Convertit une probabilité de victoire en marge attendue (inverse de Φ(m/σ)).
  SP.probToMargin = function (p, sd) {
    let lo = -40, hi = 40;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (SP.normCdf(mid / sd) < p) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };

  // ---------------------------------------------------------------- Tennis
  // Probabilité de gagner un jeu de service avec probabilité p de gagner le point.
  SP.holdProb = function (p) {
    const q = 1 - p;
    const deuce = (p * p) / (p * p + q * q);
    return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * deuce;
  };
  // Tie-break (7 points, 2 d'écart) : programmation dynamique exacte.
  SP.tiebreakProb = function (pa, pb) {
    // A sert le 1er point, puis alternance par 2.
    const memo = new Map();
    const f = (a, b) => {
      if (a >= 7 && a - b >= 2) return 1;
      if (b >= 7 && b - a >= 2) return 0;
      if (a >= 6 && b >= 6 && a === b) {
        // à égalité tardive : deux points (un service chacun)
        const w = pa * (1 - pb), l = (1 - pa) * pb;
        return w / (w + l);
      }
      const key = a * 100 + b;
      if (memo.has(key)) return memo.get(key);
      const k = a + b;
      const aServes = k === 0 || Math.floor((k - 1) / 2) % 2 === 1;
      const pw = aServes ? pa : 1 - pb;
      const v = pw * f(a + 1, b) + (1 - pw) * f(a, b + 1);
      memo.set(key, v);
      return v;
    };
    return f(0, 0);
  };
  // Probabilité analytique de gain du match (sets indépendants, alternance du service ignorée
  // au niveau du set via moyenne des deux ordres de service).
  SP.tennisMatchProb = function (pa, pb, bestOf = 3) {
    const ha = SP.holdProb(pa), hb = SP.holdProb(pb), tb = SP.tiebreakProb(pa, pb);
    const setP = (aFirst) => {
      const memo = new Map();
      const g = (x, y) => {
        if (x === 6 && y <= 4) return 1; if (y === 6 && x <= 4) return 0;
        if (x === 7) return 1; if (y === 7) return 0;
        if (x === 6 && y === 6) return tb;
        const key = x * 10 + y; if (memo.has(key)) return memo.get(key);
        const aServe = ((x + y) % 2 === 0) === aFirst;
        const pw = aServe ? ha : 1 - hb;
        const v = pw * g(x + 1, y) + (1 - pw) * g(x, y + 1);
        memo.set(key, v); return v;
      };
      return g(0, 0);
    };
    const s = (setP(true) + setP(false)) / 2;
    const need = (bestOf + 1) / 2;
    const memo = new Map();
    const m = (x, y) => {
      if (x === need) return 1; if (y === need) return 0;
      const k = x * 10 + y; if (memo.has(k)) return memo.get(k);
      const v = s * m(x + 1, y) + (1 - s) * m(x, y + 1); memo.set(k, v); return v;
    };
    return m(0, 0);
  };
  // Résout l'écart de service d tel que P(match) = p cible, autour de la moyenne du circuit.
  SP.tennisSolveServe = function (pTarget, base, bestOf = 3) {
    let lo = -0.2, hi = 0.2;
    for (let i = 0; i < 50; i++) {
      const d = (lo + hi) / 2;
      if (SP.tennisMatchProb(base + d, base - d, bestOf) < pTarget) lo = d; else hi = d;
    }
    const d = (lo + hi) / 2;
    return { pa: base + d, pb: base - d, d };
  };

  // ---------------------------------------------------------------- Monte-Carlo
  // Simulation par lots avec arrêt adaptatif. Chaque simulation tire d'abord les paramètres
  // dans leur loi d'incertitude (incertitude épistémique), puis le résultat (aléa sportif).
  // Le résultat est un histogramme ; tous les marchés en sont dérivés.
  SP.simulate = function (spec, onProgress) {
    const seed = spec.seed >>> 0;
    const r = rng(seed);
    const batch = spec.batch ?? 50000;
    const maxN = spec.maxN ?? 1000000;
    const minN = spec.minN ?? 100000;
    const tol = spec.tol ?? 0.0015; // demi-largeur IC95 visée sur la probabilité clé
    let n = 0;
    const t0 = Date.now();
    let hist, stat;
    // terciles de scénario (défavorable / normal / favorable) selon le tirage de paramètre
    const scen = [{ n: 0, k: 0 }, { n: 0, k: 0 }, { n: 0, k: 0 }];
    const key = spec.keyEvent; // fonction(échantillon) -> bool, pour l'arrêt adaptatif
    let kHits = 0;
    if (spec.kind === 'football') {
      const M = 16; hist = new Float64Array(M * M);
      const { lh, la, sigma, rho } = spec;
      // corrélation des faibles scores (Dixon-Coles) : rééchantillonnage par acceptation
      const tauMax = Math.max(tau(0, 0, lh, la, rho), tau(0, 1, lh, la, rho), tau(1, 0, lh, la, rho), tau(1, 1, lh, la, rho), 1);
      while (n < maxN) {
        for (let b = 0; b < batch; b++) {
          const [z1, z2] = normalPair(r);
          const zc = spec.corrZ ?? 0.5; // part commune de l'incertitude (ex. tempo du match)
          const e1 = Math.sqrt(1 - zc) * z1 + Math.sqrt(zc) * z2;
          const e2 = Math.sqrt(1 - zc) * normalPair(r)[0] + Math.sqrt(zc) * z2;
          const L1 = lh * Math.exp(sigma * e1 - sigma * sigma / 2);
          const L2 = la * Math.exp(sigma * e2 - sigma * sigma / 2);
          let x, y;
          for (let tries = 0; tries < 20; tries++) {
            x = poissonDraw(r, L1); y = poissonDraw(r, L2);
            if (r() * tauMax <= tau(x, y, L1, L2, rho)) break;
          }
          x = Math.min(M - 1, x); y = Math.min(M - 1, y);
          hist[x * M + y]++;
          const hit = key(x, y) ? 1 : 0; kHits += hit;
          const zs = e1 - e2; const si = zs < -0.6 ? 0 : zs > 0.6 ? 2 : 1;
          scen[si].n++; scen[si].k += hit;
        }
        n += batch;
        const p = kHits / n, hw = 1.96 * Math.sqrt(p * (1 - p) / n);
        if (onProgress) onProgress(n, hw);
        if (n >= minN && hw < tol) break;
      }
      stat = { M };
    } else if (spec.kind === 'nba') {
      const LO = 50, HI = 200, W = HI - LO + 1; hist = new Float64Array(W * W);
      const { ph, pa, sdM, sdT, corr, sigmaM } = spec; const sigmaT = spec.sigmaT || 0;
      while (n < maxN) {
        for (let b = 0; b < batch; b++) {
          const [z0] = normalPair(r);
          const mShift = sigmaM * z0; // incertitude sur la force relative
          const [a1, a2] = normalPair(r);
          const em = a1, et = corr * a1 + Math.sqrt(1 - corr * corr) * a2;
          const margin = (ph - pa) + mShift + sdM * em;
          const total = (ph + pa) + sigmaT * normalPair(r)[0] + sdT * et;
          let hs = Math.round((total + margin) / 2), as = Math.round((total - margin) / 2);
          let guard = 0;
          while (hs === as && guard++ < 5) { // prolongation : ~ N(10.5, 3) par équipe
            const [o1, o2] = normalPair(r);
            hs += Math.round(10.5 + 3 * o1); as += Math.round(10.5 + 3 * o2);
          }
          if (hs === as) hs += r() < 0.5 ? 1 : -1;
          hs = Math.min(HI, Math.max(LO, hs)); as = Math.min(HI, Math.max(LO, as));
          hist[(hs - LO) * W + (as - LO)]++;
          const hit = key(hs, as) ? 1 : 0; kHits += hit;
          const si = z0 < -0.6 ? 0 : z0 > 0.6 ? 2 : 1;
          scen[si].n++; scen[si].k += hit;
        }
        n += batch;
        const p = kHits / n, hw = 1.96 * Math.sqrt(p * (1 - p) / n);
        if (onProgress) onProgress(n, hw);
        if (n >= minN && hw < tol) break;
      }
      stat = { LO, W };
    } else if (spec.kind === 'tennis') {
      // simulation jeu par jeu (probabilités de jeu de service exactes), sets et tie-breaks.
      const bestOf = spec.bestOf || 3, need = (bestOf + 1) / 2;
      const G = 80; hist = new Float64Array(G * 2 * 6); // [jeuxTotal][vainqueur][sets perdant]
      const marginHist = new Float64Array(81); // jeux A − jeux B, décalé de 40
      const { pa: pa0, pb: pb0, sigmaD } = spec;
      while (n < maxN) {
        for (let b = 0; b < batch; b++) {
          const z = normalPair(r)[0];
          const d = sigmaD * z;
          const pa = Math.min(0.95, Math.max(0.3, pa0 + d)), pb = Math.min(0.95, Math.max(0.3, pb0 - d));
          const ha = SP.holdProb(pa), hb = SP.holdProb(pb);
          const tbp = SP.tiebreakProb(pa, pb);
          let sa = 0, sb = 0, ga = 0, gb = 0, aServe = r() < 0.5;
          while (sa < need && sb < need) {
            let x = 0, y = 0;
            for (;;) {
              if (x === 6 && y === 6) { if (r() < tbp) x++; else y++; aServe = !aServe; break; }
              const win = aServe ? r() < ha : r() >= hb;
              if (win) x++; else y++;
              aServe = !aServe;
              if ((x >= 6 || y >= 6) && Math.abs(x - y) >= 2) break;
              if (x === 7 || y === 7) break;
            }
            ga += x; gb += y; if (x > y) sa++; else sb++;
          }
          const tot = Math.min(G - 1, ga + gb), wA = sa > sb ? 1 : 0, lostSets = wA ? sb : sa;
          hist[(tot * 2 + wA) * 6 + lostSets]++;
          marginHist[Math.max(0, Math.min(80, ga - gb + 40))]++;
          const hit = key(ga, gb, wA) ? 1 : 0; kHits += hit;
          const si = z < -0.6 ? 0 : z > 0.6 ? 2 : 1;
          scen[si].n++; scen[si].k += hit;
        }
        n += batch;
        const p = kHits / n, hw = 1.96 * Math.sqrt(p * (1 - p) / n);
        if (onProgress) onProgress(n, hw);
        if (n >= minN && hw < tol) break;
      }
      stat = { G, marginHist: Array.from(marginHist) };
    }
    const p = kHits / n;
    return {
      kind: spec.kind, n, seed, ms: Date.now() - t0, hist: Array.from(hist), ...stat,
      key: { p, ci95: 1.96 * Math.sqrt(p * (1 - p) / n) },
      scenarios: scen.map((s, i) => ({ name: ['défavorable', 'normal', 'favorable'][i], weight: s.n / n, p: s.n ? s.k / s.n : null })),
    };
  };

  // Évalue un marché à partir de l'histogramme simulé. Renvoie P(gain), P(rembours.), rendement espéré.
  SP.evalFromSim = function (sim, sel, odds) {
    let w = 0, push = 0, ret = 0, tot = 0;
    const acc = (cnt, margin) => {
      if (!cnt) return;
      tot += cnt;
      const sh = SP.settleShares(margin, sel.line);
      w += cnt * sh.win; push += cnt * sh.push; ret += cnt * (sh.win * odds + sh.push);
    };
    if (sim.kind === 'football') {
      const M = sim.M;
      for (let x = 0; x < M; x++) for (let y = 0; y < M; y++) {
        const c = sim.hist[x * M + y]; if (!c) continue;
        acc(c, SP.selMargin(sel, x, y));
      }
    } else if (sim.kind === 'nba') {
      const { LO, W } = sim;
      for (let i = 0; i < W; i++) for (let j = 0; j < W; j++) {
        const c = sim.hist[i * W + j]; if (!c) continue;
        acc(c, SP.selMargin(sel, i + LO, j + LO));
      }
    } else if (sim.kind === 'tennis') {
      if (sel.type === 'spread') {
        sim.marginHist.forEach((c, k) => acc(c, SP.selMargin(sel, k - 40, 0, null)));
      } else {
        const G = sim.G;
        for (let t = 0; t < G; t++) for (let wA = 0; wA < 2; wA++) for (let ls = 0; ls < 6; ls++) {
          const c = sim.hist[(t * 2 + wA) * 6 + ls]; if (!c) continue;
          acc(c, SP.selMargin(sel, t, 0, wA));
        }
      }
    }
    const pWin = w / tot, pPush = push / tot;
    return { pWin, pPush, ev: ret / tot - 1, ci95: 1.96 * Math.sqrt(pWin * (1 - pWin) / tot) };
  };
  // « Marge » d'une sélection pour un résultat simulé : >0 gagné, 0 nul, <0 perdu (avant ligne).
  SP.selMargin = function (sel, x, y, wA) {
    switch (sel.type) {
      case 'home': return x - y;          // h2h domicile (football : nul = perdu)
      case 'away': return y - x;
      case 'draw': return x === y ? 1 : -1;
      case 'over': return x + y;           // avec sel.line négative : x+y + (−line)
      case 'under': return -(x + y);
      case 'ahHome': return x - y;
      case 'ahAway': return y - x;
      case 'tennisA': return wA === 1 ? 1 : -1;
      case 'tennisB': return wA === 0 ? 1 : -1;
      case 'tOver': return x;             // tennis : x = total de jeux
      case 'tUnder': return -x;
      case 'spread': return sel.side === 'A' ? x : -x; // x = jeux A − jeux B
      case 'bttsYes': return x > 0 && y > 0 ? 1 : -1;
      case 'bttsNo': return x > 0 && y > 0 ? -1 : 1;
      case 'dc1X': return x >= y ? 1 : -1;
      case 'dcX2': return y >= x ? 1 : -1;
      case 'dc12': return x !== y ? 1 : -1;
      case 'homeTotalOver': return x;
      case 'homeOver15': return x >= 2 ? 1 : -1;
      case 'awayOver15': return y >= 2 ? 1 : -1;
      case 'homeCS': return y === 0 ? 1 : -1;
      case 'awayCS': return x === 0 ? 1 : -1;
      case 'homeWinToNil': return x > y && y === 0 ? 1 : -1;
      case 'awayWinToNil': return y > x && x === 0 ? 1 : -1;
      case 'homeAndOver15': return x > y && x + y >= 2 ? 1 : -1;
      case 'awayAndOver15': return y > x && x + y >= 2 ? 1 : -1;
      case 'homeAndBtts': return x > y && y > 0 ? 1 : -1;
      case 'awayAndBtts': return y > x && x > 0 ? 1 : -1;
      case 'dc1XAndUnder35': return x >= y && x + y <= 3 ? 1 : -1;
      case 'dcX2AndUnder35': return y >= x && x + y <= 3 ? 1 : -1;
      case 'exact': return x === sel.h && y === sel.a ? 1 : -1;
      case 'awayTotalOver': return y;
      default: return 0;
    }
  };
  // Convertit une sélection de cote en {type, line} pour selMargin/settleLine.
  SP.normalizeSel = function (sel) {
    if (sel.type === 'over' || sel.type === 'tOver') return { ...sel, line: -sel.point };
    if (sel.type === 'under' || sel.type === 'tUnder') return { ...sel, line: sel.point };
    if (sel.type === 'ahHome' || sel.type === 'ahAway' || sel.type === 'spread') return { ...sel, line: sel.point };
    return { ...sel, line: null };
  };

  // ---------------------------------------------------------------- Score de qualité
  // Score explicable sur 100 (≠ probabilité de réussite). Chaque composante est renvoyée.
  // SCORE DE QUALITÉ DE SÉLECTION (/100, 8 composantes du cahier des charges). Ce n'est PAS une probabilité.
  SP.qualityScore = function (c) {
    const parts = [];
    const add = (name, pts, max, why) => parts.push({ name, pts: Math.max(0, Math.min(max, pts)), max, why });
    add('1. Fiabilité des données', 15 * (c.dataQuality ?? 0.3), 15, c.dataNote || '');
    add('2. Qualité historique du modèle', c.calib == null ? 3 : 10 * Math.max(0, Math.min(1, c.calib)), 10,
      c.calib == null ? 'pas de backtest disponible' : `gain de log-loss vs modèle naïf : ${(c.calib * 100).toFixed(0)} %`);
    add('3. Accord entre modèles indépendants', c.modelGap == null ? 3 : 15 * Math.max(0, 1 - c.modelGap / 0.08), 15,
      c.modelGap == null ? 'aucun modèle indépendant du marché' : `écart ${(c.modelGap * 100).toFixed(1)} pts`);
    add('4. Stabilité statistique', 10 * Math.max(0, 1 - c.mcSpread / 0.15) * (c.simCI != null && c.simCI < 0.005 ? 1 : 0.7), 10, `écart entre scénarios ${(c.mcSpread * 100).toFixed(1)} pts`);
    add('5. Fraîcheur des informations', 10 * Math.max(0, 1 - c.oddsAgeMin / 60) - (c.lineupUnknown ? 3 : 0), 10, `cote relevée il y a ${Math.round(c.oddsAgeMin)} min${c.lineupUnknown ? ', compositions non publiées' : ''}`);
    add('6. Cohérence avec le marché', c.fairMkt == null ? 5 : 10 * Math.max(0, 1 - Math.abs(c.p - c.fairMkt) / 0.08), 10,
      c.fairMkt == null ? 'pas de référence de marché' : `écart avec le marché sans marge ${((c.p - c.fairMkt) * 100).toFixed(1)} pts`);
    add('7. Absence de risque contextuel', 10 - (c.riskPenalty || 0) * 2, 10, c.riskNote || 'aucun signal');
    const z = (c.priceEdge ?? 0) / Math.max(0.005, c.uncert);
    add('8. Robustesse de la value et de la cote', 20 * (0.75 * Math.min(1, Math.max(0, z) / 2) + 0.25 * Math.min(1, (c.booksAtPrice || 1) / 2)), 20,
      `avantage de prix ${((c.priceEdge ?? 0) * 100).toFixed(1)} pts / incertitude ${(c.uncert * 100).toFixed(1)} pts`);
    const total = parts.reduce((s, p) => s + p.pts, 0);
    return { total: Math.round(total), parts };
  };
  // FIABILITÉ DU MODÈLE (/100) pour un match : données, quantité, performance historique, calibration, stabilité.
  SP.reliability = function (r) {
    const parts = [];
    const add = (name, pts, max, why) => parts.push({ name, pts: Math.max(0, Math.min(max, pts)), max, why });
    add('Qualité des données', 25 * (r.dataQuality ?? 0.3), 25, r.dataNote || '');
    add('Quantité de données', r.nHist ? 20 * Math.min(1, r.nHist / 600) : 0, 20, r.nHist ? `${r.nHist} matchs historiques` : 'aucun historique propre');
    add('Performance hors échantillon', r.calib == null ? 0 : 25 * Math.max(0, Math.min(1, r.calib)), 25, r.calib == null ? 'non mesurée' : 'backtest chronologique');
    add('Stabilité des prédictions', 15 * Math.max(0, 1 - (r.mcSpread ?? 0.1) / 0.15), 15, '');
    add('Incertitude des paramètres', 15 * Math.max(0, 1 - (r.paramSd ?? 0.05) / 0.08), 15, `±${((r.paramSd ?? 0.05) * 100).toFixed(1)} pts`);
    return { total: Math.round(parts.reduce((s, p) => s + p.pts, 0)), parts };
  };
  // NIVEAU DE CONFIANCE : seuils de probabilité + conditions de fiabilité (jamais la probabilité seule).
  // NIVEAU DE CONFIANCE (v3) : très haute ≥ 85 %, haute 78–84, intéressante 70–77, moyenne 60–69, faible < 60.
  // La probabilité ne suffit pas : sans données fiables (modèle indépendant d'accord avec le marché, incertitude
  // faible, aucun risque), on plafonne à « intéressante » ; fort désaccord ou données pauvres : « moyenne » au mieux.
  SP.confidence = function (x) {
    const base = x.p >= 0.85 ? 4 : x.p >= 0.78 ? 3 : x.p >= 0.70 ? 2 : x.p >= 0.60 ? 1 : 0;
    const reliable = x.dataQuality >= 0.55 && x.gap != null && x.gap <= 0.05 && (x.risk || 0) < 2 && x.uncert <= 0.06 && !x.badCalib;
    const weak = x.dataQuality < 0.35 || (x.gap != null && x.gap > 0.10) || (x.risk || 0) >= 3;
    let lvl = base;
    if (!reliable) lvl = Math.min(lvl, 2);
    if (weak) lvl = Math.min(lvl, 1);
    return ['faible', 'moyenne', 'intéressante', 'haute', 'très haute'][lvl];
  };
  SP.CONF_RANK = { 'très haute': 5, haute: 4, 'intéressante': 3, moyenne: 2, faible: 1, insuffisante: 1 };
  // Marchés tennis calculés à partir de l'histogramme simulé (jeux totaux, vainqueur, sets perdus par le vainqueur)
  SP.tennisSetProb = function (pa, pb) {
    const ha = SP.holdProb(pa), hb = SP.holdProb(pb), tb = SP.tiebreakProb(pa, pb);
    const setP = (aFirst) => {
      const memo = new Map();
      const g = (x, y) => {
        if (x === 6 && y <= 4) return 1; if (y === 6 && x <= 4) return 0; if (x === 7) return 1; if (y === 7) return 0;
        if (x === 6 && y === 6) return tb;
        const k = x * 10 + y; if (memo.has(k)) return memo.get(k);
        const aServe = ((x + y) % 2 === 0) === aFirst, pw = aServe ? ha : 1 - hb;
        const v = pw * g(x + 1, y) + (1 - pw) * g(x, y + 1); memo.set(k, v); return v;
      };
      return g(0, 0);
    };
    return (setP(true) + setP(false)) / 2;
  };
  SP.tennisMarkets = function (sim, spec, A, B) {
    const G = sim.G, H = sim.hist, tot = H.reduce((s, v) => s + v, 0);
    const P = (f) => { let s = 0; for (let t = 0; t < G; t++) for (let w = 0; w < 2; w++) for (let l = 0; l < 6; l++) { const c = H[(t * 2 + w) * 6 + l]; if (c && f(t, w, l)) s += c; } return s / tot; };
    const PM = (f) => { let s = 0, n = 0; sim.marginHist.forEach((c, k) => { n += c; if (f(k - 40)) s += c; }); return s / n; };
    const bo5 = spec.bestOf === 5, out = [];
    const lines = bo5 ? [32.5, 34.5, 36.5, 38.5, 40.5] : [18.5, 19.5, 20.5, 21.5, 22.5, 23.5, 24.5, 25.5];
    for (const L of lines) { const po = P((t) => t > L); out.push({ key: 'TO' + L, label: `Plus de ${String(L).replace('.', ',')} jeux`, type: 'tOver', point: L, p: po }, { key: 'TU' + L, label: `Moins de ${String(L).replace('.', ',')} jeux`, type: 'tUnder', point: L, p: 1 - po }); }
    for (const h of [2.5, 3.5, 4.5, 5.5]) {
      out.push({ key: 'HA+' + h, label: `${A} +${String(h).replace('.', ',')} jeux`, type: 'spread', side: 'A', point: h, p: PM((m) => m + h > 0) });
      out.push({ key: 'HB+' + h, label: `${B} +${String(h).replace('.', ',')} jeux`, type: 'spread', side: 'B', point: h, p: PM((m) => -m + h > 0) });
      out.push({ key: 'HA-' + h, label: `${A} -${String(h).replace('.', ',')} jeux`, type: 'spread', side: 'A', point: -h, p: PM((m) => m - h > 0) });
      out.push({ key: 'HB-' + h, label: `${B} -${String(h).replace('.', ',')} jeux`, type: 'spread', side: 'B', point: -h, p: PM((m) => -m - h > 0) });
    }
    const need = bo5 ? 3 : 2;
    out.push({ key: 'BOTHSET', label: 'Chaque joueur gagne au moins un set', type: 'bothSets', p: P((t, w, l) => l >= 1) });
    out.push({ key: 'SETS2', label: bo5 ? 'Match en 3 sets' : 'Match en 2 sets', type: 'straight', p: P((t, w, l) => l === 0) });
    out.push({ key: 'A' + need + '0', label: `${A} gagne ${need}-0`, type: 'exactSetsA0', p: P((t, w, l) => w === 1 && l === 0) });
    out.push({ key: 'B' + need + '0', label: `${B} gagne ${need}-0`, type: 'exactSetsB0', p: P((t, w, l) => w === 0 && l === 0) });
    out.push({ key: 'AWINSET', label: `${A} gagne au moins un set`, type: 'aWinSet', p: P((t, w, l) => w === 1 || l >= 1) });
    out.push({ key: 'BWINSET', label: `${B} gagne au moins un set`, type: 'bWinSet', p: P((t, w, l) => w === 0 || l >= 1) });
    const s1 = SP.tennisSetProb(spec.pa, spec.pb);
    out.push({ key: 'SET1A', label: `${A} gagne le 1er set`, type: 'set1A', p: s1 }, { key: 'SET1B', label: `${B} gagne le 1er set`, type: 'set1B', p: 1 - s1 });
    // Ne garder que ce que Winamax propose réellement : handicap négatif pour le favori / positif pour l'outsider,
    // lignes proches de l'équilibre (pas de « favori +5,5 jeux »), totaux autour de la ligne principale,
    // et pas de « le favori gagne au moins un set » (marché non proposé).
    const favA = P((t, w) => w === 1) >= 0.5;
    return out.filter((m) => {
      if (m.type === 'spread') return (m.side === 'A') === favA ? m.point < 0 && m.p >= 0.3 && m.p <= 0.8 : m.point > 0 && m.p >= 0.3 && m.p <= 0.8;
      if (m.type === 'tOver' || m.type === 'tUnder') return m.p >= 0.3 && m.p <= 0.8;
      if (m.type === 'aWinSet') return !favA;
      if (m.type === 'bWinSet') return favA;
      return true;
    });
  };

  SP.isStrong = (conf) => conf === 'très haute' || conf === 'haute';
  // fiabilité suffisante (indépendamment du seuil de probabilité)
  SP.isReliable = (x) => x.dataQuality >= 0.55 && x.gap != null && x.gap <= 0.05 && (x.risk || 0) < 2 && x.uncert <= 0.06 && !x.badCalib;

  return SP;
}
if (typeof module !== 'undefined' && module.exports) module.exports = SPEngineFactory;
