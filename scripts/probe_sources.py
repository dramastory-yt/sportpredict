"""Teste depuis GitHub Actions l'accessibilité et le format des sources gratuites candidates (ne publie rien)."""
import datetime as dt, json, re, requests
HDR = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "*/*"}
d = dt.date.today(); ds, dd = d.strftime("%Y%m%d"), d.isoformat()


def show(name, u, n=1500, **kw):
    try:
        r = requests.get(u, headers={**HDR, **kw.pop("headers", {})}, timeout=30, **kw)
        print(f"\n===== [{r.status_code}] {name} {u} ({len(r.content)} o)\n{r.text[:n]}")
        return r
    except Exception as e:  # noqa: BLE001
        print(f"\n===== [ERR] {name} {e}")


show("pitchapi llms", "https://pitchapi.dev/llms.txt", 6000)
show("eloratings fixtures", "https://www.eloratings.net/fixtures.tsv", 1200)
show("eloratings world", "https://www.eloratings.net/World.tsv", 600)
show("understat api", "https://understat.com/getLeagueData/EPL/2025", 800, headers={"X-Requested-With": "XMLHttpRequest", "Referer": "https://understat.com/league/EPL/2025"})
r = show("understat page", "https://understat.com/league/EPL/2025", 0)
if r is not None: print("datesData" in r.text, re.findall(r"(getLeagueData[^\"']{0,60}|JSON.parse)", r.text)[:5])
r = show("fotmob matches", f"https://www.fotmob.com/api/data/matches?date={ds}", 0)
mid = None
try:
    j = r.json(); lg = j["leagues"]; print([l["name"] for l in lg][:40]); mid = lg[0]["matches"][0]["id"]
except Exception as e: print("parse", e)  # noqa: E701
if mid:
    for path in [f"https://www.fotmob.com/api/data/matchDetails?matchId={mid}", f"https://www.fotmob.com/api/matchDetails?matchId={mid}"]:
        r = show("fotmob details", path, 400)
        try:
            j = r.json(); c = j.get("content", {}); print("keys:", list(c.keys())); print("lineup:", str(c.get("lineup"))[:600]); print("h2h:", str(c.get("h2h"))[:400]); print("stats:", str(c.get("stats"))[:400])
        except Exception as e: print("parse", e)  # noqa: E701
show("fotmob team", "https://www.fotmob.com/api/data/teams?id=9825", 300)
r = show("tennismylife", "https://stats.tennismylife.org/tennis-match-database", 0)
if r is not None: print(sorted(set(re.findall(r'(https?://[^"\'\s]+\.(?:csv|zip|xlsx)|/[^"\'\s]+\.(?:csv|zip|xlsx))', r.text)))[:40])
r = show("tennisabstract atp elo", "https://tennisabstract.com/reports/atp_elo_ratings.html", 0)
if r is not None:
    t = re.sub(r"<[^>]+>", " | ", r.text); t = re.sub(r"\s+", " ", t); i = t.find("Elo"); print(t[i:i + 1500])
show("uts api", "https://www.ultimatetennisstatistics.com/playerProfile?name=Jannik%20Sinner", 300)
show("uts rankings", "https://www.ultimatetennisstatistics.com/rankingsTableTable?current=1&rowCount=5&rankType=ELO_RANK", 800)
show("espn soccer summary", "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.nations/scoreboard", 0)
show("fd fixtures", "https://www.football-data.co.uk/fixtures.csv", 600)
show("fd new list", "https://www.football-data.co.uk/new/ARG.csv", 300)
show("clubelo retry", f"http://api.clubelo.com/{dd}", 200)
show("wta rankings", "https://api.wtatennis.com/tennis/players/ranked?page=0&pageSize=2&type=rankSingles&metric=SINGLES", 1200)
