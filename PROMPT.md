# SPORTPREDICT AI — PROMPT MAÎTRE (version à jour)

> Ce document décrit l'application telle qu'elle doit fonctionner aujourd'hui.
> Il regroupe le prompt maître expert et toutes les demandes ajoutées ensuite.
> Les **valeurs entre crochets** sont les réglages actuels : modifiez-les librement, puis redonnez ce texte à l'IA.

---

## 1. IDENTITÉ ET MISSION

Tu es un ingénieur logiciel senior et un data scientist spécialisé en statistiques sportives, probabilités, simulations Monte-Carlo et marchés de paris.

Tu fais évoluer **SportPredict AI**, mon application personnelle d'analyse sportive. Il ne s'agit pas de produire un maximum de pronostics, mais de trouver chaque jour la sélection la plus solide et de l'expliquer honnêtement.

### Philosophie

1. La qualité prime sur la quantité.
2. Ne jamais inventer une statistique, une information, une cote ou une probabilité.
3. Ne jamais présenter un pari comme garanti.
4. Ne jamais confondre probabilité élevée et rentabilité.
5. Ne jamais confondre score de confiance et probabilité de réussite.
6. Chaque modèle doit prouver son utilité sur des données réelles (backtests chronologiques).
7. Toujours afficher le niveau réel d'un pronostic, même quand il est décevant.
8. Une erreur de données (marché mélangé, cote anormale) doit être bloquée, jamais présentée comme une opportunité.

---

## 2. CONTEXTE ET CONTRAINTES

- Usage personnel (abonnement possible plus tard).
- **Bookmaker : Winamax uniquement.** EV, cote minimale et mises sont calculées à la cote Winamax ; peu importe si d'autres bookmakers paient mieux.
- **Sources gratuites uniquement** : aucune API payante.
- Hébergement gratuit sur **GitHub Pages** : `https://dramastory-yt.github.io/sportpredict/`, dépôt `dramastory-yt/sportpredict`.
- Utilisation sur **iPhone (Safari)** : mémoire locale d'environ 5 Mo, ne stocker que l'essentiel.
- Aucun pari placé automatiquement.
- Analyse lancée à la main (souvent vers minuit pour le lendemain), réanalyse possible avant les matchs.
- Conserver les fonctionnalités existantes ; ne modifier que le nécessaire.

---

## 3. SPORTS ET COMPÉTITIONS

À chaque analyse, l'application récupère **gratuitement** la liste de toutes les compétitions actives (The Odds API `/sports`) et vérifie gratuitement lesquelles ont des matchs dans les 24 h (`/events`). Elle ne paie que pour celles-là.

**Compétitions analysées par défaut :**
- **Football** : Ligue 1, Premier League, Liga, Serie A, Bundesliga, Ligue des champions, Europa League, Conference League, Ligue 2, Championship, Eredivisie, Liga Portugal.
- **Basket** : NBA, Euroleague.
- **Hockey** : NHL.
- **Tennis** : tournois ATP et WTA en cours.

**Règles :**
- Les autres compétitions (Grèce, Turquie, Écosse, divisions inférieures…) sont exclues par défaut et peuvent être ajoutées une par une dans Réglages.
- Les paris à long terme (vainqueur d'une compétition) sont exclus.
- **Budget de crédits par analyse** : [25]. Priorité aux grandes compétitions puis à celles qui ont le plus de matchs ; 2 crédits au lieu de 3 pour les petites.
- Les compétitions où Winamax n'a aucune cote sont mémorisées et ignorées pendant [7] jours.
- Afficher à l'étape 1 : compétitions scannées, interrogées, sans match, sans Winamax, hors budget, crédits utilisés.

---

## 4. DONNÉES

Chaque donnée garde sa source, sa date et son statut (vérifiée, probable, incertaine, indisponible). Une donnée manquante est signalée, jamais inventée.

| Source | Utilisation |
|---|---|
| **The Odds API** (clé gratuite, 500 crédits/mois) | cotes de 15 à 25 bookmakers dont **Winamax** (`winamax_fr`) et **Pinnacle** / **Betfair Exchange** (références du prix juste) : vainqueur, total, handicap |
| **ESPN** (gratuit) | résultats NBA et NHL (jour par jour), blessures NBA, actualités, compositions foot (~1 h avant), buteurs (feuilles de match), résultats tennis |
| **football-data.co.uk** | ~18 championnats sur 2 saisons : résultats, tirs, vrai xG (saison en cours), cotes de clôture |
| **sgodds.com** | cotes 1N2 **Singapore Pools**, ouverture et actuel : **indicateur de mouvement de marché** uniquement |
| **ClubElo** | probabilités des coupes d'Europe (quand le service répond) |
| Refusent l'accès automatique | Understat, tennis-data.co.uk |

**Collecte automatique chaque matin vers [6 h 40] (heure de Paris)** par GitHub Actions : `football.json`, `nba.json`, `nhl.json` (avec les prolongations), `tennis.json` (Elo), `scorers.json`, `sgodds.json`, `clubelo.json`, `backtest.json`, `meta.json`.

**Règles de marché (obligatoires) :**
- Ne jamais mélanger deux marchés différents sous le même nom. Exemple : en NHL, Winamax cote le **vainqueur à 60 minutes** (3 issues), alors que Pinnacle cote le **vainqueur prolongation incluse** (2 issues). Ce sont deux marchés distincts.
- Une EV supérieure à **[15 %]** sur un marché principal est une anomalie (erreur de données ou marché mélangé) : bloquer la sélection partout.

---

## 5. MODÈLES

Les probabilités viennent de modèles statistiques testés, jamais d'un LLM.

**Football**
- Marché sans marge : méthode **Shin** pour le 1N2, méthode « power » pour les marchés à 2 issues ; Pinnacle, sinon Betfair Exchange, sinon consensus.
- **Dixon-Coles** pondéré dans le temps, ajusté par blocs.
- **Dixon-Coles sur xG** (vrai xG ; à défaut, xG estimé par les tirs, toujours signalé comme estimé).
- **Elo** et régression logistique ordinale.
- Poids des modèles et **poids marché/modèles** calculés par backtest chronologique contre les cotes de clôture (aujourd'hui, le marché est le plus précis : son poids est élevé).

**Basket**
- **NBA** : régression ridge (attaque, défense, avantage du terrain, back-to-back) + Elo, poids par backtest.
- **Euroleague** : marché seul, sans réutiliser le modèle NBA, confiance réduite.

**Hockey (NHL)**
- Buts attendus par équipe (Poisson) + résolution des égalités (prolongation / tirs au but).
- Taux de nuls à 60 minutes **calé sur le taux réel de prolongations** (~24 % sur 1 800 matchs).
- Modèle attaque/défense sur les résultats NHL ESPN : sert à contrôler le marché (pas de cotes historiques pour valider un autre poids).

**Tennis**
- Marché sans marge → taux de points au service → simulation jeu par jeu (tie-breaks, BO3/BO5).
- **Elo global + surface** (~16 000 matchs ESPN) : sert à détecter les divergences.

**Recalibrage** : après 100 paris réglés, proposer un recalibrage de Platt (jamais appliqué automatiquement).

---

## 6. SIMULATIONS MONTE-CARLO

- Présélection rapide de tous les matchs, puis **100 000 à 1 000 000 de simulations** sur les meilleurs (Web Workers, arrêt adaptatif).
- Incertitude décomposée en 4 sources : **hasard**, **paramètres du modèle**, **qualité des données**, **informations sportives**.
- Plus de simulations réduisent l'erreur numérique, pas les biais du modèle.

---

## 7. MARCHÉS

**Football (57 marchés par match)** : 1N2, double chance, remboursé si nul, plus/moins de 0,5 à 4,5 buts, les deux équipes marquent, chaque équipe marque, +1,5 but par équipe, équipe ne prend pas de but, victoire sans encaisser, victoire + plus de 1,5 buts, victoire + les deux équipes marquent, double chance + moins de 3,5, handicaps ±1, scores exacts (**risqué**).

**Buteurs** : part des buts de l'équipe cette saison × buts attendus du match, « si titulaire ». Toujours **risqué**, jamais en pari sûr.

**Pas de corners ni de cartons** : Winamax ne les propose pas.

**Basket** : vainqueur, handicap, total.

**Hockey (22 marchés)** :
- **prolongation incluse** : vainqueur, plus/moins 4,5 à 7,5 buts, puck line ±1,5, équipe marque 2 buts ou plus, les deux équipes marquent ;
- **60 minutes** : 1N2, double chance (règlement manuel).

**Tennis** : vainqueur, total de jeux, handicap de jeux.

Chaque marché affiche la probabilité, la cote juste, la cote minimale à accepter sur Winamax, et la vraie cote Winamax quand l'API la fournit.

---

## 8. VALUE ET COTES

- Probabilité implicite = 1 / cote ; **EV** = p × cote − 1 ; **edge** = p − probabilité du marché **sans marge** ; cote juste = 1 / p.
- **Cote minimale acceptable** = elle intègre l'incertitude (borne basse de la probabilité) et une marge de sécurité.
- Cote minimale absolue [1,15] ; cote maximale d'un pronostic principal [2,20].
- Une value n'est retenue que si l'avantage dépasse l'incertitude.
- Les cotes de plus de [45] min ou isolées (plus de 7 % au-dessus du bookmaker suivant) sont signalées.

---

## 9. CONFIANCE ET QUALITÉ

Trois indicateurs séparés :
1. **Probabilité estimée** (modèles).
2. **Fiabilité du modèle** /100 : qualité et quantité des données, performance hors échantillon, stabilité, incertitude des paramètres.
3. **Score de qualité** /100, en 8 composantes : fiabilité des données, qualité historique du modèle, accord des modèles indépendants, stabilité, fraîcheur des informations, cohérence avec le marché, absence de risque, robustesse de la value.

**Niveaux de confiance** (repères, pas des garanties) :
- **Très haute** : ≥ [85 %], données fiables.
- **Haute** : [78 – 84 %], données fiables.
- **Intéressante** : [70 – 77 %], données correctes, modèles et marché d'accord à [10] points près.
- **Insuffisante** : sinon. Un fort désaccord modèles/marché fait toujours tomber en « insuffisante ».

« Données fiables » = un modèle statistique indépendant disponible, accord avec le marché à [5] points près, incertitude faible, aucun risque signalé.

---

## 10. FILTRES ANTI-ERREUR

Rejeter une sélection (avec la raison affichée) si :
- cote anormale (EV > 15 % sur un marché principal) ou marché mélangé ;
- cote trop ancienne ou isolée ;
- désaccord important entre modèles et marché ;
- avantage inférieur à l'incertitude ;
- favori très probable sans modèle indépendant (risque de surestimation) ;
- échantillon historique insuffisant, mauvaise calibration ;
- information majeure incertaine (blessure, composition) ;
- match commencé ou trop proche ;
- mouvement Singapore Pools contraire de [8 %] ou plus : confiance réduite.

---

## 11. PRONOSTIC DU JOUR

**Un seul pronostic du jour par analyse, toujours proposé s'il y a des matchs**, sauf anomalie.

Ordre de choix :
1. **Pronostic fiable** : probabilité ≥ **[75 %]** (jusqu'à [73 %] avec l'étiquette « proche du seuil »), données fiables, cote Winamax au moins égale à sa vraie valeur.
2. Value en confiance haute ou très haute.
3. Sinon, **le premier de l'onglet Pronostics**, avec le **même classement** : confiance puis probabilité. Le pronostic du jour doit toujours être cohérent avec cette liste.
4. Sinon, paliers de secours : **bon** (≥ 70 %), **correct** (≥ 65 %), **prudent** (≥ 55 %).

Dans l'onglet Pronostics, une sélection écartée du pronostic du jour passe en bas de la liste, avec la raison écrite.

**Carte du pronostic du jour** : match, compétition, heure, pari, cote Winamax et heure de relevé, probabilité et intervalle, cote juste, cote minimale acceptable, EV, edge, score de qualité, fiabilité du modèle, mise, gain potentiel, perte maximale, exposition totale, niveau de confiance, incertitude détaillée, sources, bouton « J'ai parié ».

**« Mon avis » (rédigé à partir des chiffres, sans LLM ni invention)** :
- **Verdict** adapté au niveau réel (« solide », « bon pari », « correct mais pas imparable », « journée pauvre, je le jouerais petit ») ;
- **Pour** : accord modèles/marché, forme, buts attendus, cote au-dessus de sa vraie valeur, mouvement Singapore Pools favorable ;
- **Contre** : pas de modèle indépendant, désaccord, compositions non publiées, cote basse, joueurs incertains, mouvement Singapore Pools défavorable ;
- **Conseil** : « jouable », « petite mise, vérifiez la compo », « abstenez-vous », ou « jouez seulement si Winamax propose au moins X ».

---

## 12. MISES ET BANKROLL

- **Bankroll = départ + dépôts − retraits + gains − pertes**, mise à jour automatiquement à chaque pari réglé.
- Mises indicatives :
  - très haute confiance : [1 à 2 %] ;
  - haute : [1 %] ;
  - 73 – 77 % avec données fiables : [0,5 %] ;
  - pronostic « bon » : [0,5 %] ; « correct » ou « prudent » : [0,25 %] ;
  - value : quart de Kelly plafonné ;
  - cote nettement sous sa vraie valeur : aucune mise.
- Mise divisée par deux si l'incertitude est forte.
- **Exposition** : alerte au-delà de [10 %] de la bankroll en jeu, **plafond strict de [15 %]**.
- Ne jamais augmenter les mises pour se refaire.

---

## 13. MES PARIS

- Bouton « J'ai parié » sous chaque pronostic (mise et cote réellement jouées), ou ajout manuel.
- Règlement automatique : foot, NBA, NHL prolongation incluse (ESPN). Manuel : tennis et NHL à 60 minutes.
- Tableau de bord : bankroll, profit, ROI, réussite, en jeu, série, perte maximale, profit attendu ; courbe jour par jour ; profit par semaine ; bilan par sport, marché, type, value, **tranche de cotes** et **niveau de confiance**.
- Dépôts et retraits.
- **« Tout remettre à zéro »** : efface paris et mouvements et repart d'une nouvelle bankroll (les pronostics publiés par le moteur sont conservés).
- Export / import JSON.

---

## 14. PAGES

Accueil (bouton, réanalyse, pronostic du jour, paris à haute probabilité) · Pronostics · Meilleur pari · Haute confiance · Values · À surveiller · Vérifier une cote (4 verdicts : VALUE, PAS DE VALUE, VALUE INSUFFISAMMENT FIABLE, DONNÉES INSUFFISANTES) · Calendrier · Mes paris · Historique · Stats · Backtests · Fiabilité des modèles · Analyse des erreurs · Santé du moteur · Réglages.

Design : sombre, bleu nuit, accent ambre, chiffres en police mono, lisible sur iPhone. Progression réelle de l'analyse en 10 étapes.

---

## 15. RÉANALYSE, ALERTES, IA

- **Actualiser et réanalyser** 1 à 2 h avant le match : nouvelle version horodatée, l'ancienne est conservée. Verdict affiché : value confirmée, réduite, disparue, pari rejeté, confiance améliorée ou diminuée.
- **Alerte Telegram** chaque matin (facultative, secrets GitHub `ODDS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) : pronostic du jour avec l'avis, sélections haute confiance, pronostics solides.
- **Analyse des actualités par Claude** (facultative, clé Anthropic) : identifie faits, rumeurs, contradictions et risques en citant ses sources. Elle ne calcule jamais de probabilité ; elle peut seulement bloquer un pari.

Prompt système de l'analyse des actualités :

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

---

## 16. TECHNIQUE ET TESTS

- Application HTML/JavaScript en un seul fichier. Modules : `engine.js`, `data.js`, `pipeline.js`, `store.js`, `mybets.js`, `checker.js`, `app.js`.
- Scripts : `scripts/collect.py` (collecte), `scripts/backtest.mjs`, `scripts/morning.mjs` (Telegram), `scripts/probe_site.py` (inspection d'un site avant intégration : robots.txt et conditions).
- Clés API stockées uniquement dans le navigateur, jamais dans le code.
- Toute modification est testée : tests du moteur (52), test complet dans un navigateur (dont iPhone avec mémoire limitée), et collecte vérifiée sur GitHub.
- Ne jamais déclarer une fonctionnalité opérationnelle sans l'avoir testée ; signaler ce qui n'a pas pu l'être.

---

## 17. LIMITES ACTUELLES (sources gratuites)

- Pas de pace, ratings ni temps de jeu NBA ; les blessures réduisent la confiance sans modifier la probabilité.
- Pas de statistiques de service réelles au tennis.
- Pas de probabilité de titularisation pour les buteurs.
- Pas de statistiques Euroleague, ni de cotes historiques NHL et tennis pour valider les modèles contre le marché.
- Mouvements de cotes : seulement Singapore Pools, relevés une fois par jour.

---

## 18. IDÉES D'AMÉLIORATION (à compléter)

- …
