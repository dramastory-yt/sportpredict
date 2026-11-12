"""Teste depuis GitHub Actions l'accessibilité de toutes les sources gratuites candidates (ne publie rien)."""
import datetime as dt, re, requests
HDR = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "*/*"}
d = dt.date.today(); ds, dd = d.strftime("%Y%m%d"), d.isoformat()
URLS = [
  # football
  ("fd-uk extra leagues", "https://www.football-data.co.uk/new/BRA.csv"),
  ("fd-uk fixtures", "https://www.football-data.co.uk/fixtures.csv"),
  ("clubelo", f"http://api.clubelo.com/{dd}"),
  ("eloratings World.tsv", "https://www.eloratings.net/World.tsv"),
  ("eloratings teams", "https://www.eloratings.net/en.teams.tsv"),
  ("eloratings fixtures", "https://www.eloratings.net/fixtures.tsv"),
  ("intl results martj42", "https://raw.githubusercontent.com/martj42/international_results/master/results.csv"),
  ("understat", "https://understat.com/league/EPL/2025"),
  ("fbref", "https://fbref.com/en/comps/9/Premier-League-Stats"),
  ("fotmob matches", f"https://www.fotmob.com/api/data/matches?date={ds}"),
  ("fotmob matches old", f"https://www.fotmob.com/api/matches?date={ds}"),
  ("sofascore", f"https://api.sofascore.com/api/v1/sport/football/scheduled-events/{dd}"),
  ("sofascore www", f"https://www.sofascore.com/api/v1/sport/football/scheduled-events/{dd}"),
  ("espn nations scoreboard", "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.nations/scoreboard"),
  ("espn soccer standings", "https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings"),
  ("espn eng injuries", "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/injuries"),
  ("thesportsdb", f"https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d={dd}&s=Soccer"),
  ("pitchapi llms", "https://pitchapi.dev/llms.txt"),
  ("pitchapi root", "https://pitchapi.dev/"),
  ("bzzoiro", "https://sports.bzzoiro.com/api/"),
  ("openligadb", "https://api.openligadb.de/getmatchdata/bl1"),
  ("open-meteo", "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&hourly=precipitation,wind_speed_10m&forecast_days=2"),
  ("transfermarkt", "https://www.transfermarkt.com/premier-league/verletztespieler/wettbewerb/GB1"),
  ("statsbomb open", "https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json"),
  ("sgodds", "https://sgodds.com/football/current-odds"),
  ("oddsportal", "https://www.oddsportal.com/football/"),
  ("betexplorer", "https://www.betexplorer.com/football/"),
  ("worldfootball", "https://www.worldfootball.net/"),
  ("soccerstats", "https://www.soccerstats.com/"),
  ("footystats", "https://footystats.org/"),
  ("fivethirtyeight spi", "https://projects.fivethirtyeight.com/soccer-api/club/spi_global_rankings.csv"),
  # tennis
  ("tennis-data 2026 https", "https://www.tennis-data.co.uk/2026/2026.xlsx"),
  ("tennis-data 2026 http", "http://www.tennis-data.co.uk/2026/2026.xlsx"),
  ("tennis-data 2026w", "http://www.tennis-data.co.uk/2026w/2026.xlsx"),
  ("sackmann atp", "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_2024.csv"),
  ("sackmann wta", "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_2024.csv"),
  ("sackmann charting", "https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/charting-m-matches.csv"),
  ("tennisabstract atp elo", "https://tennisabstract.com/reports/atp_elo_ratings.html"),
  ("tennisabstract wta elo", "https://tennisabstract.com/reports/wta_elo_ratings.html"),
  ("tennisabstract www", "https://www.tennisabstract.com/reports/atp_elo_ratings.html"),
  ("tennismylife", "https://stats.tennismylife.org/tennis-match-database"),
  ("tennisdata.app", "https://tennisdata.app/downloads/"),
  ("ultimatetennisstatistics", "https://www.ultimatetennisstatistics.com/"),
  ("espn tennis atp", f"https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates={ds}"),
  ("espn tennis rankings", "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings"),
  ("sofascore tennis", f"https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/{dd}"),
  ("atptour rankings", "https://www.atptour.com/en/rankings/singles"),
  ("wta api", "https://api.wtatennis.com/tennis/players/ranked?page=0&pageSize=20&type=rankSingles&metric=SINGLES"),
  ("flashscore", "https://www.flashscore.com/tennis/"),
]
for name, u in URLS:
    try:
        r = requests.get(u, headers=HDR, timeout=25)
        body = "" if "xlsx" in u else re.sub(r"\s+", " ", r.text[:220])
        print(f"[{r.status_code}] {name:28s} {len(r.content):>9} o  {r.headers.get('content-type', '')[:40]:40s} | {body}")
    except Exception as e:  # noqa: BLE001
        print(f"[ERR] {name:28s} {str(e)[:150]}")
