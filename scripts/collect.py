"""SportPredict AI — collecte quotidienne de données gratuites (exécutée par GitHub Actions).

Produit des fichiers JSON publiés avec l'application (même origine : pas de problème CORS) :
  data/football.json  résultats, tirs, corners, cartons et cotes Pinnacle (football-data.co.uk)
  data/xg.json        xG par match des 5 grands championnats (understat.com)
  data/clubelo.json   Elo des clubs européens et probabilités des prochains matchs (clubelo.com)
  data/tennis.json    Elo ATP/WTA global et par surface, calculé sur les résultats tennis-data.co.uk
  data/meta.json      date, source et statut de chaque collecte

Chaque source est indépendante : un échec est consigné dans meta.json et n'empêche pas les autres.
Aucune valeur manquante n'est inventée.
"""
import csv, io, json, math, os, re, sys, time, datetime as dt
import requests

OUT = sys.argv[1] if len(sys.argv) > 1 else "dist/data"
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "SportPredict-AI personal research (GitHub Actions)"}
TODAY = dt.date.today()
META = {"generatedAt": dt.datetime.utcnow().isoformat() + "Z", "sources": {}}


def get(url, tries=2, **kw):
    hdr = kw.pop("headers", {})
    last = None
    for attempt in range(tries):
        try:
            r = requests.get(url, headers={**UA, **hdr}, timeout=20, **kw)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def note(key, ok, msg, **extra):
    META["sources"][key] = {"ok": ok, "msg": msg, "at": dt.datetime.utcnow().isoformat() + "Z", **extra}
    print(("OK  " if ok else "ERR ") + key + " : " + msg, flush=True)


def save(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def fnum(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def pdate(s):
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s.strip(), fmt)
        except (ValueError, AttributeError):
            pass
    return None


# saisons au format football-data : "2526" = 2025/26
def season_codes():
    y = TODAY.year if TODAY.month >= 7 else TODAY.year - 1
    return [f"{(y - 1) % 100:02d}{y % 100:02d}", f"{y % 100:02d}{(y + 1) % 100:02d}"], y


# ---------------------------------------------------------------- football-data.co.uk
FD_LEAGUES = {
    "soccer_epl": "E0", "soccer_france_ligue_one": "F1", "soccer_spain_la_liga": "SP1",
    "soccer_italy_serie_a": "I1", "soccer_germany_bundesliga": "D1", "soccer_france_ligue_two": "F2",
    "soccer_efl_champ": "E1", "soccer_netherlands_eredivisie": "N1", "soccer_portugal_primeira_liga": "P1",
}


def football_data():
    codes, _ = season_codes()
    out = {}
    for key, div in FD_LEAGUES.items():
        rows = []
        for sc in codes:
            url = f"https://www.football-data.co.uk/mmz4281/{sc}/{div}.csv"
            try:
                txt = get(url).content.decode("utf-8-sig", errors="replace")
            except Exception as e:  # noqa: BLE001
                note(f"football-data {div} {sc}", False, str(e)[:160])
                continue
            n0 = len(rows)
            reader = csv.DictReader(io.StringIO(txt))
            for r in reader:
                d = pdate(r.get("Date", ""))
                hg, ag = fnum(r.get("FTHG")), fnum(r.get("FTAG"))
                if not d or hg is None or ag is None or not r.get("HomeTeam"):
                    continue
                t = r.get("Time") or "15:00"
                try:
                    hh, mm = [int(x) for x in t.split(":")[:2]]
                except ValueError:
                    hh, mm = 15, 0
                ts = int(dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=dt.timezone.utc).timestamp() * 1000)
                # cotes Pinnacle : clôture (PSC*) sinon ouverture (PS*) ; moyenne marché (Avg*) en secours
                # cote de clôture de référence : Pinnacle, sinon Betfair Exchange, sinon moyenne du marché
                ph = pd_ = pa = None; ref = None
                for pre, lab in (("PSC", "Pinnacle"), ("BFEC", "Betfair Exchange"), ("AvgC", "moyenne marché")):
                    h_, d_, a_ = fnum(r.get(pre + "H")), fnum(r.get(pre + "D")), fnum(r.get(pre + "A"))
                    if h_ and d_ and a_:
                        ph, pd_, pa, ref = h_, d_, a_, lab
                        break
                o25 = fnum(r.get("PC>2.5")) or fnum(r.get("BFEC>2.5")) or fnum(r.get("AvgC>2.5"))
                u25 = fnum(r.get("PC<2.5")) or fnum(r.get("BFEC<2.5")) or fnum(r.get("AvgC<2.5"))
                rows.append([ts, r["HomeTeam"], r["AwayTeam"], int(hg), int(ag),
                             fnum(r.get("HS")), fnum(r.get("AS")), fnum(r.get("HST")), fnum(r.get("AST")),
                             fnum(r.get("HC")), fnum(r.get("AC")), fnum(r.get("HY")), fnum(r.get("AY")),
                             ph, pd_, pa, o25, u25, fnum(r.get("HxG")), fnum(r.get("AxG")), ref])
            note(f"football-data {div} {sc}", True, f"{len(rows) - n0} matchs")
        if rows:
            rows.sort(key=lambda x: x[0])
            out[key] = rows
    save("football.json", {
        "source": "football-data.co.uk", "fetchedAt": META["generatedAt"],
        "cols": ["t", "h", "a", "hg", "ag", "hs", "as", "hst", "ast", "hc", "ac", "hy", "ay", "refH", "refD", "refA", "refO25", "refU25", "hxg", "axg", "refSource"],
        "leagues": out,
    })


# ---------------------------------------------------------------- understat (xG)
US_LEAGUES = {"soccer_epl": "EPL", "soccer_spain_la_liga": "La_liga", "soccer_germany_bundesliga": "Bundesliga",
              "soccer_italy_serie_a": "Serie_A", "soccer_france_ligue_one": "Ligue_1"}


def understat_matches(league, year):
    # 1) API JSON utilisée par le site ; 2) ancien format : JSON embarqué dans la page
    try:
        r = get(f"https://understat.com/getLeagueData/{league}/{year}", headers={"X-Requested-With": "XMLHttpRequest", "Referer": f"https://understat.com/league/{league}/{year}"})
        j = r.json()
        dates = j.get("dates") or j.get("datesData") or []
        if dates:
            return dates
    except Exception as e:  # noqa: BLE001
        print("understat api:", league, year, str(e)[:120])
    html = get(f"https://understat.com/league/{league}/{year}").text
    m = re.search(r"datesData\s*=\s*JSON\.parse\('(.*?)'\)", html)
    if not m:
        raise RuntimeError("format understat inconnu (ni API ni datesData)")
    return json.loads(m.group(1).encode("utf-8").decode("unicode_escape"))


def understat():
    _, y = season_codes()
    out = {}
    for key, lg in US_LEAGUES.items():
        rows = []
        for year in (y - 1, y):
            try:
                ms = understat_matches(lg, year)
            except Exception as e:  # noqa: BLE001
                note(f"understat {lg} {year}", False, str(e)[:160])
                continue
            n0 = len(rows)
            for m in ms:
                if not m.get("isResult"):
                    continue
                try:
                    t = int(dt.datetime.strptime(m["datetime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
                    rows.append([t, m["h"]["title"], m["a"]["title"], int(m["goals"]["h"]), int(m["goals"]["a"]), round(float(m["xG"]["h"]), 3), round(float(m["xG"]["a"]), 3)])
                except (KeyError, ValueError, TypeError):
                    continue
            note(f"understat {lg} {year}", True, f"{len(rows) - n0} matchs avec xG")
            time.sleep(1.5)
        if rows:
            out[key] = sorted(rows, key=lambda x: x[0])
    save("xg.json", {"source": "understat.com", "fetchedAt": META["generatedAt"], "cols": ["t", "h", "a", "hg", "ag", "hxg", "axg"], "leagues": out})


# ---------------------------------------------------------------- ClubElo
def clubelo():
    res = {"source": "clubelo.com", "fetchedAt": META["generatedAt"], "ratings": {}, "fixtures": []}
    try:
        txt = get(f"http://api.clubelo.com/{TODAY.isoformat()}").text
        for r in csv.DictReader(io.StringIO(txt)):
            e = fnum(r.get("Elo"))
            if e:
                res["ratings"][r["Club"]] = {"elo": round(e, 1), "country": r.get("Country"), "level": r.get("Level")}
        note("clubelo ratings", True, f"{len(res['ratings'])} clubs")
    except Exception as e:  # noqa: BLE001
        note("clubelo ratings", False, str(e)[:160])
    try:
        txt = get("http://api.clubelo.com/Fixtures").text
        for r in csv.DictReader(io.StringIO(txt)):
            ph = pd_ = pa = 0.0
            for k, v in r.items():
                if not k or not k.startswith("GD"):
                    continue
                p = fnum(v) or 0.0
                sign = k[2:]
                if sign.startswith("<"):
                    pa += p
                elif sign.startswith(">"):
                    ph += p
                else:
                    g = int(sign.lstrip("="))
                    ph, pd_, pa = (ph + p, pd_, pa) if g > 0 else ((ph, pd_ + p, pa) if g == 0 else (ph, pd_, pa + p))
            tot = ph + pd_ + pa
            if tot > 0.5:
                res["fixtures"].append({"date": r.get("Date"), "home": r.get("Home"), "away": r.get("Away"), "p": [round(ph / tot, 4), round(pd_ / tot, 4), round(pa / tot, 4)]})
        note("clubelo fixtures", True, f"{len(res['fixtures'])} matchs")
    except Exception as e:  # noqa: BLE001
        note("clubelo fixtures", False, str(e)[:160])
    save("clubelo.json", res)


# ---------------------------------------------------------------- tennis-data.co.uk + Elo surface
def tennis_rows(year, wta):
    import openpyxl  # noqa: PLC0415
    errs = []
    for base in (f"https://www.tennis-data.co.uk/{year}{'w' if wta else ''}/{year}", f"http://www.tennis-data.co.uk/{year}{'w' if wta else ''}/{year}"):
      for ext in (".xlsx", ".xls"):
        try:
            content = get(base + ext, tries=1).content
            if content[:2] not in (b"PK", b"\xd0\xcf"):
                errs.append(f"{base}{ext}: contenu inattendu {content[:40]!r}")
                continue
        except Exception as e:  # noqa: BLE001
            errs.append(f"{base}{ext}: {str(e)[:80]}")
            continue
        if ext == ".xls":
            import xlrd  # noqa: PLC0415
            sh = xlrd.open_workbook(file_contents=content).sheet_by_index(0)
            rows = [sh.row_values(i) for i in range(sh.nrows)]
            hdr = [str(h).strip() for h in rows[0]]
            out = []
            for r in rows[1:]:
                d = dict(zip(hdr, r))
                if isinstance(d.get("Date"), float):
                    d["Date"] = xlrd.xldate_as_datetime(d["Date"], 0)
                out.append(d)
            return out
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.worksheets[0]
        it = ws.iter_rows(values_only=True)
        hdr = [str(h).strip() if h is not None else "" for h in next(it)]
        return [dict(zip(hdr, r)) for r in it]
    raise RuntimeError(" | ".join(errs)[:400])


def k_factor(n):
    return 250.0 / ((n + 5) ** 0.4)  # FiveThirtyEight


def tennis():
    out = {"source": "tennis-data.co.uk (Elo calculé par SportPredict)", "fetchedAt": META["generatedAt"], "tours": {}}
    y = TODAY.year
    for wta in (False, True):
        tour = "WTA" if wta else "ATP"
        matches = []
        for year in (y - 2, y - 1, y):
            try:
                rows = tennis_rows(year, wta)
            except Exception as e:  # noqa: BLE001
                note(f"tennis-data {tour} {year}", False, str(e)[:160])
                continue
            n0 = len(matches)
            for r in rows:
                d = r.get("Date")
                if isinstance(d, str):
                    d = pdate(d)
                if not isinstance(d, (dt.datetime, dt.date)) or not r.get("Winner") or not r.get("Loser"):
                    continue
                if str(r.get("Comment", "Completed")).strip().lower() not in ("completed", ""):
                    continue  # abandons / forfaits exclus de l'Elo
                surf = str(r.get("Surface") or "").strip().lower()
                court = str(r.get("Court") or "").strip().lower()
                s = "clay" if "clay" in surf else "grass" if "grass" in surf else ("hard_indoor" if court == "indoor" else "hard")
                matches.append((d if isinstance(d, dt.datetime) else dt.datetime(d.year, d.month, d.day), str(r["Winner"]).strip(), str(r["Loser"]).strip(), s, fnum(r.get("PSW")), fnum(r.get("PSL")), str(r.get("Tournament") or "")))
            note(f"tennis-data {tour} {year}", True, f"{len(matches) - n0} matchs")
        matches.sort(key=lambda m: m[0])
        if not matches:
            continue
        E, Es, N, Ns, last = {}, {}, {}, {}, {}
        bt = []  # (p_elo, p_pinnacle_devig) avant chaque match de l'année en cours, pour pondérer marché/Elo
        for d, w, l, s, psw, psl, _ in matches:
            ew, el = E.get(w, 1500.0), E.get(l, 1500.0)
            sw, sl = Es.get((w, s), 1500.0), Es.get((l, s), 1500.0)
            cw, cl = (ew + sw) / 2, (el + sl) / 2
            p = 1 / (1 + 10 ** ((cl - cw) / 400))
            if d.year == y - 1 or d.year == y:
                if psw and psl and N.get(w, 0) >= 10 and N.get(l, 0) >= 10:
                    q = (1 / psw) / (1 / psw + 1 / psl)
                    bt.append((p, q))
            pe = 1 / (1 + 10 ** ((el - ew) / 400))
            ps = 1 / (1 + 10 ** ((sl - sw) / 400))
            E[w] = ew + k_factor(N.get(w, 0)) * (1 - pe)
            E[l] = el - k_factor(N.get(l, 0)) * (1 - pe)
            Es[(w, s)] = sw + k_factor(Ns.get((w, s), 0)) * (1 - ps)
            Es[(l, s)] = sl - k_factor(Ns.get((l, s), 0)) * (1 - ps)
            for pl in (w, l):
                N[pl] = N.get(pl, 0) + 1
                Ns[(pl, s)] = Ns.get((pl, s), 0) + 1
                last[pl] = int(d.timestamp() * 1000)
        # backtest : chaque probabilité est calculée AVANT la mise à jour du match (pas de fuite)
        def ll(ps):
            return sum(-math.log(max(1e-9, x)) for x in ps) / max(1, len(ps))
        elo_ll = ll([b[0] for b in bt])  # le vainqueur est toujours le joueur « w »
        mkt_ll = ll([b[1] for b in bt])
        best_w, best_ll = None, None
        for i in range(0, 21):
            wm = i / 20
            v = ll([wm * b[1] + (1 - wm) * b[0] for b in bt])
            if best_ll is None or v < best_ll:
                best_w, best_ll = wm, v
        cutoff = int((dt.datetime.utcnow() - dt.timedelta(days=400)).timestamp() * 1000)
        players = {}
        for pl, e in E.items():
            if last.get(pl, 0) < cutoff:
                continue
            players[pl] = {"elo": round(e, 1), "n": N[pl], "last": last[pl],
                           "surf": {s: [round(Es[(pl, s)], 1), Ns[(pl, s)]] for s in ("hard", "hard_indoor", "clay", "grass") if (pl, s) in Es}}
        out["tours"][tour] = {"players": players, "backtest": {"n": len(bt), "eloLogLoss": round(elo_ll, 4), "pinnacleLogLoss": round(mkt_ll, 4), "wMarket": best_w, "blendLogLoss": round(best_ll or 0, 4)}}
        note(f"tennis Elo {tour}", True, f"{len(players)} joueurs actifs, backtest n={len(bt)} poids marché={best_w}")
    save("tennis.json", out)


# ---------------------------------------------------------------- ESPN tennis (résultats) -> Elo surface
T_CLAY = re.compile(r"(roland|french open|monte|madrid|rome|italian|barcelona|hamburg|geneva|lyon|bastad|gstaad|umag|kitzb|estoril|munich|houston|marrakech|buenos|rio|santiago|cordoba|charleston|bogota|rabat|strasbourg|palermo|prague|warsaw|iasi|parma)", re.I)
T_GRASS = re.compile(r"(wimbledon|queen|halle|eastbourne|hertogenbosch|mallorca|stuttgart|newport|berlin|bad homburg|nottingham|birmingham)", re.I)
T_INDOOR = re.compile(r"(paris masters|rolex paris|atp finals|wta finals|vienna|basel|stockholm|antwerp|metz|sofia|rotterdam|marseille|montpellier|dallas|linz|ostrava|astana|belgrade|next gen|davis cup|billie jean|athens|tokyo|guangzhou|ningbo|jiujiang|seoul)", re.I)


def espn_tennis():
    out = {"source": "résultats ESPN (Elo calculé par SportPredict)", "fetchedAt": META["generatedAt"], "tours": {}}
    for tour, path in (("ATP", "atp"), ("WTA", "wta")):
        seen, matches, calls, errs = set(), [], 0, 0
        day = TODAY - dt.timedelta(days=420)
        while day <= TODAY:
            try:
                j = get(f"https://site.api.espn.com/apis/site/v2/sports/tennis/{path}/scoreboard?dates={day.strftime('%Y%m%d')}", tries=1).json()
            except Exception:  # noqa: BLE001
                errs += 1
                day += dt.timedelta(days=3)
                continue
            calls += 1
            for ev in j.get("events", []):
                tname = ev.get("name") or ev.get("shortName") or ""
                surf = "clay" if T_CLAY.search(tname) else "grass" if T_GRASS.search(tname) else "hard_indoor" if T_INDOOR.search(tname) else "hard"
                for g in ev.get("groupings", []) or [{"competitions": ev.get("competitions", [])}]:
                    gname = ((g.get("grouping") or {}).get("displayName") or (g.get("grouping") or {}).get("slug") or "singles").lower()
                    if "double" in gname or "mixed" in gname:
                        continue
                    for comp in g.get("competitions", []):
                        cid = comp.get("id")
                        st = (comp.get("status") or {}).get("type") or {}
                        if cid in seen or not st.get("completed"):
                            continue
                        if "retired" in str(st.get("description", "")).lower() or "walkover" in str(st.get("description", "")).lower():
                            continue
                        cs = comp.get("competitors", [])
                        if len(cs) != 2:
                            continue
                        names = [((c.get("athlete") or {}).get("displayName") or (c.get("roster") or {}).get("displayName")) for c in cs]
                        win = [bool(c.get("winner")) for c in cs]
                        if not all(names) or sum(win) != 1:
                            continue
                        seen.add(cid)
                        d = comp.get("date") or ev.get("date")
                        try:
                            ts = dt.datetime.fromisoformat(d.replace("Z", "+00:00"))
                        except (AttributeError, ValueError):
                            continue
                        w, l = (names[0], names[1]) if win[0] else (names[1], names[0])
                        matches.append((ts, w, l, surf))
            day += dt.timedelta(days=3)
            time.sleep(0.2)
        note(f"ESPN tennis {tour}", bool(matches), f"{len(matches)} matchs de simple terminés ({calls} requêtes, {errs} échecs)")
        if not matches:
            continue
        matches.sort(key=lambda m: m[0])
        E, Es, N, Ns, last = {}, {}, {}, {}, {}
        ll_elo, ll_n = 0.0, 0
        for d, w, l, s in matches:
            ew, el = E.get(w, 1500.0), E.get(l, 1500.0)
            sw, sl = Es.get((w, s), 1500.0), Es.get((l, s), 1500.0)
            if N.get(w, 0) >= 10 and N.get(l, 0) >= 10:  # backtest : prédiction avant mise à jour
                p = 1 / (1 + 10 ** ((((el + sl) / 2) - ((ew + sw) / 2)) / 400))
                ll_elo += -math.log(max(1e-9, p)); ll_n += 1
            pe = 1 / (1 + 10 ** ((el - ew) / 400)); ps = 1 / (1 + 10 ** ((sl - sw) / 400))
            E[w] = ew + k_factor(N.get(w, 0)) * (1 - pe); E[l] = el - k_factor(N.get(l, 0)) * (1 - pe)
            Es[(w, s)] = sw + k_factor(Ns.get((w, s), 0)) * (1 - ps); Es[(l, s)] = sl - k_factor(Ns.get((l, s), 0)) * (1 - ps)
            for pl in (w, l):
                N[pl] = N.get(pl, 0) + 1; Ns[(pl, s)] = Ns.get((pl, s), 0) + 1; last[pl] = int(d.timestamp() * 1000)
        players = {}
        for pl, e in E.items():
            tok = pl.split()
            if len(tok) < 2:
                continue
            key = " ".join(tok[1:]) + " " + tok[0][0] + "."  # format « Nom P. » attendu par l'application
            players[key] = {"elo": round(e, 1), "n": N[pl], "last": last[pl], "full": pl,
                            "surf": {s: [round(Es[(pl, s)], 1), Ns[(pl, s)]] for s in ("hard", "hard_indoor", "clay", "grass") if (pl, s) in Es}}
        note(f"Elo tennis {tour}", True, f"{len(players)} joueurs ; backtest chronologique log-loss {ll_elo / max(1, ll_n):.4f} sur {ll_n} matchs (pile ou face = 0.6931)")
        out["tours"][tour] = {"players": players, "backtest": {"n": 0, "eloLogLoss": round(ll_elo / max(1, ll_n), 4), "nElo": ll_n, "pinnacleLogLoss": None, "wMarket": None, "blendLogLoss": None}}
    save("tennis.json", out)


# ---------------------------------------------------------------- ESPN NBA (résultats jour par jour)
def espn_nba():
    rows, seen, errs = [], set(), 0
    day = TODAY - dt.timedelta(days=430)
    while day < TODAY:
        try:
            j = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={day.strftime('%Y%m%d')}", tries=1).json()
        except Exception:  # noqa: BLE001
            errs += 1; day += dt.timedelta(days=1); continue
        for ev in j.get("events", []):
            c = (ev.get("competitions") or [{}])[0]
            if not ((c.get("status") or ev.get("status") or {}).get("type") or {}).get("completed") or ev.get("id") in seen:
                continue
            h = next((x for x in c.get("competitors", []) if x.get("homeAway") == "home"), None)
            a = next((x for x in c.get("competitors", []) if x.get("homeAway") == "away"), None)
            if not h or not a:
                continue
            try:
                t = int(dt.datetime.fromisoformat(ev["date"].replace("Z", "+00:00")).timestamp() * 1000)
                rows.append([t, h["team"]["displayName"], a["team"]["displayName"], int(h["score"]), int(a["score"])])
                seen.add(ev.get("id"))
            except (KeyError, ValueError, TypeError):
                continue
        day += dt.timedelta(days=1)
        time.sleep(0.15)
    rows.sort(key=lambda r: r[0])
    note("ESPN NBA", bool(rows), f"{len(rows)} matchs ({errs} jours en échec)")
    save("nba.json", {"source": "ESPN", "fetchedAt": META["generatedAt"], "cols": ["t", "h", "a", "hs", "as"], "games": rows})


# ---------------------------------------------------------------- ESPN football : buteurs de la saison
ESPN_SOCCER = {"soccer_epl": "eng.1", "soccer_france_ligue_one": "fra.1", "soccer_spain_la_liga": "esp.1", "soccer_italy_serie_a": "ita.1",
               "soccer_germany_bundesliga": "ger.1", "soccer_france_ligue_two": "fra.2", "soccer_efl_champ": "eng.2",
               "soccer_netherlands_eredivisie": "ned.1", "soccer_portugal_primeira_liga": "por.1"}


def espn_scorers():
    _, y = season_codes()
    start = dt.date(y, 7, 15)
    out = {"source": "ESPN (feuilles de match)", "fetchedAt": META["generatedAt"], "leagues": {}}
    for key, lg in ESPN_SOCCER.items():
        teams, seen, calls, errs = {}, set(), 0, 0
        day = start
        while day <= TODAY:
            end = min(TODAY, day + dt.timedelta(days=13))
            urls = [f"https://site.api.espn.com/apis/site/v2/sports/soccer/{lg}/scoreboard?dates={day.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}&limit=500"]
            evs = None
            try:
                evs = get(urls[0], tries=1).json().get("events", []); calls += 1
            except Exception:  # noqa: BLE001  plage refusée : jour par jour
                evs = []
                d2 = day
                while d2 <= end:
                    try:
                        evs += get(f"https://site.api.espn.com/apis/site/v2/sports/soccer/{lg}/scoreboard?dates={d2.strftime('%Y%m%d')}", tries=1).json().get("events", []); calls += 1
                    except Exception:  # noqa: BLE001
                        errs += 1
                    d2 += dt.timedelta(days=1)
            for ev in evs:
                c = (ev.get("competitions") or [{}])[0]
                if ev.get("id") in seen or not (((c.get("status") or {}).get("type") or {}).get("completed")):
                    continue
                seen.add(ev.get("id"))
                tid = {}
                for comp in c.get("competitors", []):
                    nm = (comp.get("team") or {}).get("displayName")
                    if not nm:
                        continue
                    tid[str((comp.get("team") or {}).get("id"))] = nm
                    t = teams.setdefault(nm, {"matches": 0, "goals": 0, "players": {}})
                    t["matches"] += 1
                    try:
                        t["goals"] += int(comp.get("score") or 0)
                    except ValueError:
                        pass
                for det in c.get("details", []) or []:
                    if not det.get("scoringPlay") or det.get("ownGoal"):
                        continue
                    team = tid.get(str((det.get("team") or {}).get("id")))
                    ath = (det.get("athletesInvolved") or [{}])[0].get("displayName")
                    if not team or not ath:
                        continue
                    pl = teams[team]["players"].setdefault(ath, {"goals": 0, "pens": 0})
                    pl["goals"] += 1
                    if det.get("penaltyKick"):
                        pl["pens"] += 1
            day = end + dt.timedelta(days=1)
            time.sleep(0.2)
        for t in teams.values():
            t["players"] = sorted([{"name": n, **v} for n, v in t["players"].items()], key=lambda p: -p["goals"])[:8]
        nplayers = sum(len(t["players"]) for t in teams.values())
        note(f"ESPN buteurs {lg}", nplayers > 0, f"{len(seen)} matchs, {len(teams)} équipes, {nplayers} buteurs ({calls} requêtes, {errs} échecs)")
        if teams:
            out["leagues"][key] = {"teams": teams}
    save("scorers.json", out)


if __name__ == "__main__":
    # understat.com et tennis-data.co.uk refusent les serveurs GitHub (délai dépassé / 403) :
    # désactivés par défaut, réactivables avec ENABLE_BLOCKED_SOURCES=1 (par ex. sur un ordinateur personnel).
    fns = [football_data, clubelo, espn_nba, espn_scorers] + ([understat, tennis] if os.environ.get("ENABLE_BLOCKED_SOURCES") == "1" else [espn_tennis])
    for k in ("understat", "tennis-data"):
        if os.environ.get("ENABLE_BLOCKED_SOURCES") != "1":
            note(k, False, "désactivé : la source refuse les serveurs GitHub Actions")
    for fn in fns:
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            note(fn.__name__, False, "échec inattendu : " + str(e)[:200])
    save("meta.json", META)
    print(json.dumps(META, ensure_ascii=False, indent=1)[:3000])
