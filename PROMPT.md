# PROMPT COMPLET — SPORTPREDICT AI

> Version regroupée du cahier des charges initial et de toutes les demandes ajoutées ensuite.
> Elle décrit l'application telle qu'elle doit fonctionner. Modifiez-la librement, puis redonnez-la à l'IA pour faire évoluer l'outil.

---

## 1. RÔLE

Tu es un ingénieur logiciel senior et un expert en data science, en statistiques sportives, en modélisation probabiliste, en simulations Monte-Carlo et en analyse des marchés de paris sportifs.

Ta mission : faire évoluer **SportPredict AI**, mon outil personnel d'analyse et de prédiction sportive. Ce n'est pas un site de « pronostics IA » : c'est un moteur d'analyse fondé sur des **données réelles**, des **modèles statistiques**, des **simulations** et une **sélection rigoureuse**.

Règle fondamentale : **mieux vaut ne rien parier que proposer un mauvais pari.** Ne jamais présenter un pari comme garanti.

---

## 2. CONTEXTE D'UTILISATION

- Usage **personnel** pour l'instant (abonnement possible plus tard).
- Je parie **uniquement sur Winamax**. La value et les mises sont calculées **à la cote Winamax**. Peu importe si d'autres bookmakers proposent mieux.
- Je veux rester **100 % gratuit** : pas d'API payante pour l'instant.
- Je l'utilise surtout **sur iPhone (Safari)** : tout doit marcher sur téléphone, avec une mémoire de navigateur limitée (~5 Mo).
- Utilisation simple : j'ouvre l'appli, j'appuie sur **« LANCER L'ANALYSE COMPLÈTE »**, je lis le **pronostic du jour**.
- Je lance souvent l'analyse **vers minuit pour le lendemain**, puis je réanalyse avant le match.
- Ma bankroll de départ est petite (ex. 25 €) et je veux la faire **grossir petit à petit** avec des paris **sûrs**, pas forcément des « values » à 1,80.

---

## 3. SPORTS ET COMPÉTITIONS

Trois sports : **football, basket, tennis**.

À chaque analyse, l'application récupère **gratuitement** la liste de toutes les compétitions actives (The Odds API, `/sports`) et ne paie que pour celles qui ont des matchs dans les 24 h (vérifié gratuitement via `/events`).

**Par défaut, uniquement les compétitions principales et régulières :**
- **Football** : Ligue 1, Premier League, Liga, Serie A, Bundesliga, Ligue des champions, Europa League, Conference League, Ligue 2, Championship, Eredivisie, Liga Portugal.
- **Basket** : NBA, Euroleague.
- **Tennis** : tournois ATP et WTA en cours.
- **Exclues par défaut** (irrégulières ou peu couvertes) : Grèce, Turquie, Écosse, Belgique, divisions inférieures, etc. Je peux en ajouter une à la main dans Réglages.
- **Exclure les paris à long terme** (vainqueur de compétition).

**Économie de crédits (offre gratuite The Odds API : 500 crédits/mois) :**
- budget de crédits par analyse, réglable (actuellement **25**) ;
- priorité aux grands championnats et à la NBA, puis aux compétitions avec le plus de matchs ;
- compétitions secondaires avec moins de marchés (2 crédits au lieu de 3) ;
- **mémoriser pendant 7 jours** les compétitions où Winamax n'a aucune cote, pour ne plus y dépenser de crédits ;
- afficher à l'étape 1 : compétitions scannées, interrogées, sans match, sans Winamax, hors budget, crédits utilisés.

---

## 4. DONNÉES (GRATUITES UNIQUEMENT)

Chaque donnée doit garder sa **source**, sa **date de récupération** et son **statut** (vérifiée, probable, incertaine, indisponible). **Ne jamais inventer** une donnée manquante : le signaler.

| Source | Utilisation |
|---|---|
| **The Odds API** (clé gratuite) | cotes de ~15 à 25 bookmakers dont **Winamax** (`winamax_fr`) et **Pinnacle** (référence du « prix juste »), région `eu`. Marchés : vainqueur, total, handicap |
| **ESPN** (API publique) | résultats NBA (jour par jour : ESPN refuse les plages de dates pour la NBA), blessures NBA, actualités, compositions officielles foot (~1 h avant), buteurs de la saison (feuilles de match), résultats tennis |
| **football-data.co.uk** | 2 saisons de résultats, tirs, tirs cadrés, **vrai xG** (saison en cours), cotes de clôture (Pinnacle / Betfair Exchange / moyenne) pour ~18 championnats |
| **ClubElo** | probabilités des matchs de coupes d'Europe (quand le service répond) |
| Refusent les serveurs GitHub (désactivés) | Understat (xG), tennis-data.co.uk |

**Collecte automatique chaque matin (~6 h 40, heure de Paris)** par un robot GitHub Actions gratuit, qui publie les données avec le site :
`football.json`, `nba.json`, `tennis.json` (Elo), `scorers.json` (buteurs), `clubelo.json`, `backtest.json`, `meta.json`.

---

## 5. MODÈLES STATISTIQUES

Les probabilités viennent **de modèles statistiques**, jamais d'un LLM.

**Football**
- probabilités du marché sans marge (méthode « power »), converties en buts attendus (λ de Poisson) ;
- **Dixon-Coles** pondéré dans le temps, ajusté par blocs (stable) ;
- **Dixon-Coles sur xG** (vrai xG, sinon xG estimé à partir des tirs cadrés et non cadrés) ;
- **Elo** + régression logistique ordinale (1/N/2) ;
- **poids des modèles** déterminés par **backtest chronologique** (chaque match prédit seulement avec les matchs antérieurs), jamais arbitraires ;
- **poids marché/modèles** estimé en comparant aux cotes de clôture (aujourd'hui : le marché est le meilleur, d'où un poids marché élevé) ;
- coupes d'Europe : marché + ClubElo.

**Basket**
- **NBA** : régression ridge pondérée (attaque/défense, avantage du terrain, effet back-to-back) + Elo, poids par backtest ;
- autres compétitions (Euroleague…) : marché seul.

**Tennis**
- marché sans marge → taux de points gagnés au service → simulation jeu par jeu, tie-breaks, BO3/BO5 ;
- **Elo par surface** (global + surface) calculé sur ~16 000 matchs ESPN : sert à **détecter les divergences** avec le marché (il n'est pas validé contre des cotes historiques, donc il ne modifie pas la probabilité).

**Recalibrage** : après 100 paris réglés, proposer un recalibrage de Platt (sans l'appliquer automatiquement).

---

## 6. SIMULATIONS MONTE-CARLO

- de **100 000 à 1 000 000 de simulations** par événement approfondi, en parallèle (Web Workers) ;
- **arrêt adaptatif** dès que l'erreur d'échantillonnage passe sous la précision visée ;
- tirage de l'incertitude des paramètres, puis du résultat ; scénarios défavorable / normal / favorable ;
- **phase 1** : présélection rapide de tous les matchs ; **phase 2** : simulations massives sur les meilleurs ;
- rappeler que plus de simulations réduisent l'erreur numérique, **pas** les biais du modèle.

---

## 7. MARCHÉS ANALYSÉS

**Football — 57 marchés calculés pour chaque match**, avec probabilité, cote juste, cote minimale à accepter sur Winamax, et la cote Winamax réelle quand l'API la fournit :
1N2, double chance (1N, N2, 12), remboursé si nul, plus de 0,5 / 1,5 / 2,5 / 3,5 buts, moins de 1,5 / 2,5 / 3,5 / 4,5, les deux équipes marquent (oui/non), chaque équipe marque (plus de 0,5), chaque équipe plus de 1,5 buts, équipe ne prend pas de but, victoire sans encaisser, victoire + plus de 1,5 buts, victoire + les deux équipes marquent, double chance + moins de 3,5, handicaps -1 / +1, scores exacts (risqué).

**Buteurs** : probabilité de marquer = part des buts de l'équipe cette saison × buts attendus du match (si titulaire). Toujours marqués **« risqué »**, **jamais** en pari sûr.

**Pas de corners ni de cartons** : Winamax ne les propose pas.

**Basket** : vainqueur, handicap, total. **Tennis** : vainqueur, total de jeux, handicap de jeux.

---

## 8. SÉLECTION DES PARIS

Calculs : probabilité implicite = 1/cote ; **EV = p × cote − 1** ; edge = p − probabilité implicite ; marge du bookmaker retirée.

**Rejet automatique si :** cote < 1,20 ; EV insuffisante ; value inférieure à l'incertitude ; cote de plus de 45 min ; cote isolée suspecte ; divergence modèles/marché > 10 points ; simulations instables ; information majeure non confirmée ; match commencé ou trop proche.

**Score de qualité sur 100** (expliqué en 8 composantes), à ne jamais confondre avec une probabilité.

### Mode « Paris sûrs » (par défaut)
Un pari sûr : probabilité **≥ 70 %**, cote Winamax entre **1,20 et 1,70**, cote **pas plus de 3 % sous sa vraie valeur**, modèles d'accord avec le marché, aucun risque majeur. Les marchés calculés sans cote API (ex. « +1,5 buts ») peuvent être des paris sûrs **« cote à vérifier »**, avec la cote minimale à accepter sur Winamax.

### Confiance
- **Forte** : probabilité ≥ 70 %, données solides (un modèle statistique indépendant en plus du marché), modèles et marché d'accord à 5 points près, aucun risque signalé.
- **Moyenne** / **faible** sinon.

### PRONOSTIC DU JOUR
- **Un seul** choix par analyse, affiché en grand sur l'accueil, **uniquement en confiance forte**.
- Priorité : pari sûr en confiance forte → value en confiance forte → pronostic le plus probable en confiance forte.
- S'il n'y en a aucun : afficher **« Pas de pronostic à confiance forte aujourd'hui »** et montrer l'alternative à part.
- Carte : match, pari, cote Winamax ou cote minimale, probabilité, cote juste, EV, mise conseillée, explication en clair (favori, buts ou score attendus, forme récente, accord modèles/marché), points de vigilance, bouton **« J'ai parié »**.

### Autres catégories
- **Autres paris sûrs** (liste) ;
- **Values** : jusqu'à 5, une par match, jamais pour remplir ;
- **À surveiller** : avec ce qui doit changer pour devenir intéressant ;
- **Pronostics** : la lecture du moteur pour chaque match (résultat et score les plus probables, buts attendus, forme V/N/D, pari le plus probable, tous les marchés, buteurs) ;
- **Combiné** : seulement si son EV rapportée au risque dépasse celle des paris simples (rare).

---

## 9. MISES ET BANKROLL

- **Bankroll mise à jour automatiquement** = départ + dépôts − retraits + gains − pertes des paris réglés.
  Exemple : 25 € de départ, 5 € à 1,22 gagné → **26,10 €**, et la mise suivante se calcule sur 26,10 €.
- Mises conseillées : **2 %** de la bankroll pour un pari sûr (1 % si la cote est un peu basse), quart de Kelly plafonné pour une value, 1 % pour un pari sans value.
- Alerter si trop d'argent est en jeu (> 15 %) ou en cas de série de défaites (ne pas « se refaire »).

---

## 10. MES PARIS (SUIVI)

- Bouton **« J'ai parié »** sur chaque pronostic (mise et cote réellement jouées), ou ajout manuel.
- **Règlement automatique** des résultats foot et NBA (ESPN), manuel pour le tennis (G/P/R).
- Tableau de bord : bankroll actuelle, profit, ROI, réussite, sommes en jeu, série en cours, perte maximale depuis un sommet, profit attendu ; courbe de bankroll jour par jour ; profit par semaine ; tableaux jour par jour et semaine par semaine ; bilan par sport, marché, type de pari, avec/sans value ; dépôts et retraits.
- Filtres : aujourd'hui, semaine, mois, depuis le début.

---

## 11. PAGES DE L'APPLICATION

Accueil (bouton principal, réanalyse, pastilles d'état, pronostic du jour, paris sûrs) · Pronostics · Meilleur pari · Values · À surveiller · Vérifier une cote (je saisis une cote Winamax, boostée ou non, et l'outil dit « VALUE » ou « PAS DE VALUE ») · Calendrier · Mes paris · Historique (non modifiable, export/import) · Stats (performance, CLV, Brier, log loss, calibration, backtests) · Réglages.

Design : mode sombre, bleu nuit, accent ambre, chiffres en police mono, sobre, lisible sur iPhone.

Progression de l'analyse en **10 étapes réelles** : récupération des matchs, statistiques, blessures, compositions, actualités, comparaison des cotes, modèles, Monte-Carlo, classement, validation finale.

---

## 12. RÉANALYSE ET AUTOMATISATION

- **« ACTUALISER ET RÉANALYSER »** 1 à 2 h avant le match : nouvelles cotes, compositions, blessures. Nouvelle version horodatée, l'ancienne est conservée, verdict « value confirmée / disparue ».
- **Alerte Telegram chaque matin** (facultative, secrets GitHub `ODDS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) : pronostic du jour, paris sûrs, pronostics solides.

---

## 13. ANALYSE DES ACTUALITÉS PAR IA (FACULTATIVE)

Active seulement si une clé API Anthropic est saisie. L'IA **ne crée jamais de probabilité** : elle peut seulement **bloquer** un pari si une information majeure est incertaine.

**Prompt système utilisé :**

```
Tu es l'analyste qualitatif de SportPredict AI. Tu reçois une sélection de pari déjà calculée par des modèles statistiques, ainsi que des titres d'actualité et des rapports de blessures horodatés, chacun avec un identifiant de source [S1], [S2]...
Règles :
- N'utilise QUE les informations fournies. N'invente aucune statistique, aucun nom, aucune blessure.
- Ne donne pas de probabilité et ne décide pas du résultat : tu identifies uniquement des facteurs et des risques.
- Chaque facteur ou risque cite l'identifiant de sa source, par exemple « [S3] ».
- Une rumeur ou une information non officielle est signalée comme telle.
- impact = "majeur" seulement si une information fournie peut changer sensiblement la probabilité (ex. absence confirmée ou incertaine d'un joueur clé, changement d'entraîneur, rotation annoncée) ; "aucun" si les sources ne disent rien de pertinent.
- Réponds en français, de façon concise.
```

**Données envoyées** : match, compétition, heure, pari, cote, probabilité du modèle, probabilité du marché, qualité des données, avertissements, et sources numérotées (actualités ESPN, rapport de blessures, statut des compositions).

**Réponse imposée** : `resume`, `facteurs_favorables`, `facteurs_defavorables`, `risques`, `contradictions`, `impact` (aucun / mineur / majeur), `sources_utilisees`.

---

## 14. TECHNIQUE (ÉTAT ACTUEL)

- Application en **un seul fichier HTML** (JavaScript, sans serveur), hébergée gratuitement sur **GitHub Pages** : `https://dramastory-yt.github.io/sportpredict/`.
- Dépôt : `dramastory-yt/sportpredict`. Modules : `engine.js` (modèles, Monte-Carlo), `data.js` (connecteurs), `pipeline.js` (analyse), `store.js` (historique), `mybets.js` (suivi), `checker.js` (vérificateur), `app.js` (interface).
- Collecte et backtest quotidiens : `scripts/collect.py`, `scripts/backtest.mjs` ; alerte : `scripts/morning.mjs`.
- Les clés API restent dans le navigateur, jamais dans le code.
- Mémoire Safari limitée : ne pas stocker les grosses réponses ESPN, enregistrer en priorité analyses, paris et bankroll.
- Tests automatiques : moteur (40 tests) + test complet dans un navigateur (y compris iPhone avec mémoire limitée).

---

## 15. RÈGLES DE TRAVAIL POUR L'IA

1. Ne jamais inventer de statistiques ou de données ; dire clairement ce qui n'est pas disponible.
2. Tester chaque modification (tests du moteur + test navigateur) avant de la mettre en ligne.
3. Expliquer simplement, en français, ce qui a changé et ce que je dois faire.
4. Rester honnête : un pari probable n'est pas forcément rentable ; aucun gain n'est garanti.
5. Pas de placement automatique de paris.
6. Rappeler les risques : 18 ans et plus, Joueurs Info Service 09 74 75 13 13.

---

## 16. IDÉES D'AMÉLIORATION (À COMPLÉTER)

- Ajouter des sources gratuites de blessures et suspensions football.
- Statistiques propres pour l'Euroleague et le basket européen.
- Suivi des mouvements de cotes Winamax dans la journée (nécessite plus de crédits).
- …
