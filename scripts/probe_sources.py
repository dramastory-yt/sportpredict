"""Teste depuis GitHub Actions l'accessibilité et le format des sources gratuites candidates (ne publie rien)."""
import datetime as dt, json, re, requests
HDR = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "*/*", "Origin": "https://dramastory-yt.github.io"}
d = dt.date.today(); ds = d.strftime("%Y%m%d")


def get(u, **kw):
    r = requests.get(u, headers=HDR, timeout=30, **kw)
    print(f"\n===== [{r.status_code}] {u} ({len(r.content)} o) CORS={r.headers.get('access-control-allow-origin')}")
    return r


r = get(f"https://www.fotmob.com/api/data/matches?date={ds}")
lg = r.json()["leagues"]
m = next(x for l in lg if "Nations League A" in l["name"] for x in l["matches"])
print(json.dumps(m)[:600])
r = get(f"https://www.fotmob.com/api/data/matchDetails?matchId={m['id']}")
j = r.json(); c = j["content"]
print("general:", json.dumps(j["general"])[:500])
print("header:", json.dumps(j.get("header"))[:500])
mf = c.get("matchFacts") or {}
print("matchFacts keys:", list(mf.keys()))
for k in mf: print(" -", k, json.dumps(mf[k])[:700])
lu = c.get("lineup") or {}
print("lineup keys:", list(lu.keys()), "home keys:", list((lu.get("homeTeam") or {}).keys()))
print("unavailable:", json.dumps((lu.get("homeTeam") or {}).get("unavailable"))[:800])
print("table:", json.dumps(c.get("table"))[:500])
print("weather:", json.dumps(c.get("weather"))[:300])
print("h2h:", json.dumps(c.get("h2h"))[:300])
# un match de club terminé avec xG
r = get(f"https://www.fotmob.com/api/data/matches?date={(d - dt.timedelta(days=4)).strftime('%Y%m%d')}")
lg = r.json()["leagues"]
pl = next((l for l in lg if l.get("primaryId") == 47 or l["name"] == "Premier League"), lg[0])
fm = pl["matches"][0]; print(pl["name"], json.dumps(fm)[:300])
j = get(f"https://www.fotmob.com/api/data/matchDetails?matchId={fm['id']}").json()
st = (j["content"].get("stats") or {})
print("stats sample:", json.dumps(st)[:1500])
for u in ["https://stats.tennismylife.org/data/2026.csv", "https://stats.tennismylife.org/data/ongoing_tourneys.csv", "https://stats.tennismylife.org/data/2026_challenger.csv"]:
    r = get(u); print(r.text[:900])
r = get("https://stats.tennismylife.org/tennis-match-database")
print(sorted(set(re.findall(r'https://stats.tennismylife.org/data/[^"\'\s]*(?:202[56]|wta|ongoing)[^"\'\s]*', r.text))))
r = get("https://www.eloratings.net/fixtures.tsv")
r = get("https://www.eloratings.net/en.tournaments.tsv"); print(r.text[:600])
r = get("https://tennisabstract.com/reports/wta_elo_ratings.html")
t = r.text; i = t.find("<table id=\"reportable\""); print(t[i:i + 2500])
