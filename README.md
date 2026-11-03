# SportPredict AI

Moteur personnel d'analyse et de détection de value bets : **football, tennis, NBA**.
Un seul fichier (`dist/index.html`) qui s'ouvre dans un navigateur, sans serveur ni installation.

## Utilisation

1. Ouvrir `dist/index.html` dans Chrome, Edge, Firefox ou Safari (en double-cliquant dessus, ou en l'hébergeant sur GitHub Pages pour l'utiliser sur téléphone).
2. **Réglages** : coller la clé The Odds API (obligatoire) et, si vous le souhaitez, une clé Anthropic.
3. **Tableau de bord** : « LANCER L'ANALYSE COMPLÈTE ».
4. Avant un match : « ACTUALISER ET RÉANALYSER ». Cela crée une nouvelle version horodatée ; l'ancienne reste dans l'historique.

Les clés restent dans le `localStorage` du navigateur. Elles ne sont envoyées qu'au fournisseur concerné.

## Pourquoi ce format plutôt que la pile Next.js / FastAPI / PostgreSQL

* Usage personnel pour l'instant. Une page unique suffit et ne coûte rien à héberger.
* Une page « artefact » claude.ai ne peut pas appeler d'API externe (règle de sécurité CSP). La page s'exécute donc dans un vrai navigateur.
* Le moteur (`src/engine.js`) est en JavaScript pur, sans dépendance. Il peut être réutilisé tel quel côté serveur (Node) si une version SaaS avec abonnement voit le jour.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/engine.js` | Modèles statistiques, Monte-Carlo, valeur, score de qualité (testé dans Node et utilisé dans des Web Workers) |
| `src/data.js` | Connecteurs indépendants : The Odds API, ESPN (résultats, blessures NBA, actualités, compositions), Claude. Cache avec durée de vie, secours sur le cache si un fournisseur tombe, journal des appels |
| `src/pipeline.js` | Analyse en 10 étapes, phase 1 (présélection) puis phase 2 (approfondie), règles de validation |
| `src/store.js` | Historique immuable, résultats, CLV, performance, export/import JSON |
| `src/app.js` | Interface (8 pages) |
| `build.mjs` | Assemble tout dans `dist/index.html` |

## Modèles

**Football**
* Probabilités du marché sans marge (méthode « power », Pinnacle en priorité, sinon médiane des bookmakers), converties en λ de Poisson.
* Dixon-Coles pondéré dans le temps (ξ = 0,0019/jour), ajusté sur environ deux saisons de résultats ESPN.
* Elo avec multiplicateur d'écart de buts, puis régression logistique ordinale (1/N/2).
* Poids Dixon-Coles / Elo : optimisés par minimisation de la log-loss sur une **validation chronologique** (chaque match est prédit uniquement avec les matchs antérieurs).
* Mélange final marché/stats (poids `wMarket`, 0,65 par défaut) sur les λ. Après 50 pronostics réglés, la page Performance propose un poids optimisé sur l'historique. Il n'est jamais appliqué automatiquement.

**NBA**
* Régression ridge pondérée (attaque/défense par équipe, avantage du terrain, effet back-to-back estimé sur les données) et Elo par marge de victoire.
* Poids issus de la validation chronologique. Écarts-types et corrélation marge/total estimés sur les résidus.

**Tennis**
* Probabilité du marché sans marge, traduite en taux de points gagnés au service, puis simulation jeu par jeu (tie-breaks exacts, BO3/BO5).
* Les taux de service moyens du circuit par surface sont une **hypothèse paramétrique**. Pour les totaux et handicaps, le modèle est donc combiné au prix juste du marché, et la règle de divergence s'applique.

**Monte-Carlo** (Web Workers, en parallèle)
* Pour chaque simulation, les paramètres sont d'abord tirés dans leur loi d'incertitude, puis le résultat est tiré.
* Arrêt adaptatif : de 100 000 à 1 000 000 de simulations par événement, jusqu'à ce que la demi-largeur de l'IC95 passe sous 0,15 pt (réglable).
* Mesure locale : 1 000 000 de simulations football en environ 0,3 s.
* Scénarios défavorable / normal / favorable (terciles du tirage de paramètres), avec leurs poids réels.
* Plus de simulations réduisent l'erreur numérique, **pas** les biais du modèle.

**Sélection**
* EV = p × cote − 1 et edge = p − 1/cote.
* Un pari est rejeté s'il remplit l'une de ces conditions : cote < 1,20 ou > plafond ; EV < seuil ; edge < incertitude ; cote de plus de 45 min ; cote isolée (plus de 7 % au-dessus du deuxième bookmaker) ; divergence modèles/marché > 10 pts ; simulations instables ; information majeure non confirmée ; match trop proche du coup d'envoi.
* Score de qualité sur 100 en 8 composantes affichées. Ce score n'est **pas** une probabilité.
* Au plus 1 meilleur pari, 5 values (une par événement) et 5 opportunités à surveiller, chacune avec « ce qui doit changer ». Zéro pari si rien ne passe.
* Combiné étudié seulement si son EV rapportée au risque dépasse celle des paris simples.

## Fournisseurs de données

Les tarifs indiqués sont ceux que je connais. Ils **n'ont pas pu être revérifiés en direct**, car l'environnement de développement bloquait ces sites. Vérifiez-les avant de souscrire.

| Fournisseur | Utilisé | Clé | Coût | Remarque |
|---|---|---|---|---|
| The Odds API | oui : cotes, environ 15 à 25 bookmakers en région `eu` dont Pinnacle | oui | gratuit 500 crédits/mois ; payant à partir d'environ 30 $/mois (20 000 crédits) | coût d'un appel = marchés × régions ; une analyse ≈ 3 crédits par compétition |
| ESPN (API publique du site) | oui : résultats, blessures NBA, actualités, compositions | non | gratuit | non officielle, sans garantie de service ; peut changer sans préavis |
| Anthropic (Claude) | facultatif : résumé des actualités | oui | environ 0,01 à 0,05 $ par analyse (6 appels maximum, modèle `claude-opus-5-5`, effort bas) | n'intervient jamais dans les probabilités ; peut seulement bloquer un pari |
| API-Football, Sportmonks | non (pistes d'amélioration) | oui | gratuit limité puis payant | apporteraient xG, compositions probables et blessures football |
| football-data.org | non | oui | gratuit limité | pas de cotes ni de xG |
| NBA Stats | non | — | — | refuse les appels depuis un navigateur |
| API-Tennis, Sportradar | non | oui | payant | nécessaires pour un vrai Elo tennis par surface |

## Ce qui n'est PAS encore disponible (à dire clairement)

* Football : xG/xGA, tirs, compositions probables, blessures et suspensions (aucune source gratuite structurée et accessible depuis le navigateur). Les compositions officielles sont vérifiées via ESPN pour les matchs à moins de 3 h.
* Marchés football BTTS, corners, cartons, double chance, Draw No Bet : non récupérés (ils coûtent un appel par événement chez The Odds API).
* NBA : pas de props joueurs (points, rebonds…). Les blessures entraînent une pénalité de confiance, pas un ajustement chiffré de la probabilité (l'impact individuel de chaque joueur n'est pas modélisé).
* Tennis : pas d'Elo par surface, pas de statistiques de service réelles, pas de blessures. Le tennis repose sur le marché ; la value vient surtout de la comparaison des bookmakers.
* Conférences de presse : seulement les titres d'actualité ESPN reliés aux équipes (et leur analyse par Claude si une clé est fournie).
* Automatisation et notifications : seulement quand la page est ouverte (il n'y a pas de serveur).
* CLV : calculé avec la dernière cote relevée avant le match, pas la vraie cote de clôture.
* Règlement automatique : football et NBA via ESPN ; tennis à saisir manuellement.

## Tests

```bash
node test/engine.test.mjs        # 31 tests du moteur
node build.mjs                   # construit dist/index.html
node test/e2e.mjs <dossier>      # test navigateur de bout en bout (réseau simulé, captures dans <dossier>)
```

Le test de bout en bout utilise des réponses simulées au format des API pour tester le code. Ce ne sont pas des données réelles.

## Responsabilité

Outil d'aide à la décision, sans placement automatique de paris. Aucun gain n'est garanti. Interdit aux moins de 18 ans. Joueurs Info Service : 09 74 75 13 13.
