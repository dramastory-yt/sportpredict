"""Exécute à blanc les nouveaux collecteurs sur GitHub Actions et affiche un résumé (ne publie rien)."""
import json, sys
sys.argv = ["collect", "/tmp/probe-data"]
src = open("scripts/collect.py", encoding="utf-8").read().split('if __name__ == "__main__":')[0]
exec(compile(src, "collect.py", "exec"))  # noqa: S102
for fn in (intl_football, tml_tennis):  # noqa: F821
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        print("ÉCHEC", fn.__name__, e)
print(json.dumps(META, ensure_ascii=False, indent=1)[:6000])  # noqa: F821
it = json.load(open("/tmp/probe-data/intl.json"))
print("intl rows", len(it["rows"]), "elo", len(it["elo"]), list(it["elo"].items())[:8])
t = json.load(open("/tmp/probe-data/tennis.json"))
for tour, v in t["tours"].items():
    ps = v["players"]
    print(tour, len(ps), v["avg"], v["backtest"])
    for k in list(ps)[:2] + [k for k in ps if k.startswith(("Sinner", "Sabalenka", "Alcaraz", "Andreeva"))][:4]:
        print(" ", k, json.dumps(ps[k])[:400])
