"""Inspection ponctuelle d'un site avant intégration : robots.txt, conditions, structure de la page."""
import re, sys, requests
UA = {"User-Agent": "SportPredict-AI personal research (GitHub Actions)"}
base = sys.argv[1].rstrip("/")
path = sys.argv[2] if len(sys.argv) > 2 else "/"
for u in [base + "/robots.txt", base + path, base + "/terms", base + "/terms-of-use", base + "/about", base + "/disclaimer"]:
    try:
        r = requests.get(u, headers=UA, timeout=25)
        print(f"\n===== {u} -> HTTP {r.status_code} ({len(r.text)} car., {r.headers.get('content-type')})")
        t = r.text
        if u.endswith("robots.txt"):
            print(t[:2000]); continue
        print("liens :", sorted(set(re.findall(r'href="(/[^"#?]{1,80})"', t)))[:60])
        print("scripts/API :", sorted(set(re.findall(r'["\'](/(?:api|_next|data|json)[^"\']{0,120})["\']', t)))[:30])
        print("mots clés :", {k: t.lower().count(k) for k in ["singapore pools", "1x2", "handicap", "over", "under", "total goals", "odds", "scrap", "copyright", "prohibit", "automated"]})
        txt = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
        txt = re.sub(r"<[^>]+>", " ", txt); txt = re.sub(r"\s+", " ", txt)
        print("texte :", txt[:2500])
    except Exception as e:  # noqa: BLE001
        print(f"\n===== {u} -> ERREUR {e}")
