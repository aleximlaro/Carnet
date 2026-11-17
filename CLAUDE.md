# Carnet

Logiciel en ligne (SaaS) de soumissions, devis et factures pour entrepreneurs. Interface en français ; documents produits en français, anglais ou espagnol. Fonctionne dans plusieurs pays (taxes, devises et numéros officiels par région).

Le propriétaire n'est pas développeur : explique les choses simplement, en français, et dis-lui clairement ce qu'il doit faire lui-même (dans Supabase, Stripe ou Cloudflare).

## Structure

- `public/` : le site, servi tel quel (aucune étape de build).
  - `index.html` : toute l'application (HTML, CSS et JavaScript dans un seul fichier).
  - `privacy.html` : politique de confidentialité (exigée par Google Play). À mettre à jour si on collecte de nouvelles données.
  - `manifest.webmanifest`, `icons/` : application installable (PWA).
  - `sw.js` : fonctionnement hors ligne. **Augmenter `CACHE` (carnet-v2, carnet-v3…) à chaque modification de `sw.js`.**
  - `_redirects` : sert `/.well-known/assetlinks.json` depuis `/assetlinks.json` (vérification Google Play).
- `supabase/schema.sql` : tables `carnet_state` (données de chaque utilisateur, JSON) et `subscriptions` (statut Stripe), avec RLS. À exécuter à la main dans Supabase > SQL Editor.
- `supabase/functions/stripe-webhook/index.ts` : fonction Edge appelée par Stripe ; met à jour `subscriptions`. Verify JWT désactivé. Secrets : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- `supabase/functions/stripe-portal/index.ts` : fonction Edge appelée par « Gérer mon abonnement » (`goPortal`) ; vérifie la session et ouvre directement le portail client Stripe, sans courriel. Avec `{flow:"card"}` (bouton « Mettre à jour ma carte », `goPortal('card')`), ouvre directement la page de changement de carte, retour sur `?card=ok` (si Stripe refuse, portail normal). `payLate()` : paiement refusé (`past_due`/`unpaid`) → avertissement et bouton carte au lieu du bouton de paiement (pour ne pas créer un 2e abonnement). Verify JWT désactivé (la fonction vérifie elle-même). Si elle échoue, le site retombe sur `CFG.portalLink`.
- Déployer une fonction (il faut un jeton `sbp_` du propriétaire) : `SUPABASE_ACCESS_TOKEN=… npx --yes supabase@3.1.0 functions deploy <nom> --remote=ebfjdefiklftqfikffwv --no-verify-jwt --use-api --yes`, puis effacer `supabase/.temp/`.
- `wrangler.jsonc` : déploiement Cloudflare Workers (fichiers statiques de `public/`).

## Déploiement

Pas de build. Le `git push` ne met **pas** le site à jour (aucun lien GitHub → Cloudflare). Après chaque changement, sans demander au propriétaire :

1. Vérifier la syntaxe du script de `public/index.html` et tester dans Edge (400 px et ordinateur, clair et sombre, aucune erreur JavaScript).
2. Commit sur `main`, puis push sur les deux dépôts : `git push origin main` (github.com/aleximlaro/carnet-projet) et `git push https://github.com/aleximlaro/Carnet.git main`.
3. Mettre en ligne : `npx --yes wrangler deploy` depuis la racine (Worker `carnet` ; wrangler est déjà connecté au compte Cloudflare).
4. Vérifier avec `curl` que https://carnet.carnet-0f4.workers.dev contient bien le changement.

## Architecture de `public/index.html`

- Tout le script est dans un bloc `{ ... }`. État global `state` = `{v:3, profile, clients, docs, updatedAt}` ; sauvegardé dans `localStorage` (clé `carnet.v1`) par `save()`, qui déclenche aussi `cloudPush()`.
- `REGIONS` : préréglages par pays (taxes, numéros officiels, devise, mot « Soumission » ou « Devis »).
- Détection du pays à la première visite : `GEO` (fuseau horaire de l'appareil, sinon langue du navigateur ; au Canada, la province vient du fuseau, Toronto + français = Québec), `guessRegion()`, `guessCurrency()` (devise pour « Autre pays »). Un visiteur resté en « Autre pays » sans rien entrer est re-détecté.
- Langue de l'interface (fr, en, es) : bouton de traduction dans la barre du haut (`#lang`, `#langmenu`, `setLang` : enregistre `localStorage` `carnet.ui` puis recharge la page en revenant au même écran via `sessionStorage` `carnet.back`). Par défaut : première langue du navigateur parmi fr/en/es, sinon langue du pays détecté (`GEO_LANG`). `UIL` = langue choisie. Le français est la source ; dictionnaire `I18N` = `"texte français": ["anglais", "espagnol"]`.
  - Textes fixes (HTML ou chaînes simples affichées) : traduits automatiquement à l'affichage (`trNode` + `MutationObserver`, attributs `placeholder`, `title`, `aria-label`, `label`, `alt`, `data-l`) ; il suffit d'ajouter la phrase française exacte dans `I18N`.
  - Phrases avec des valeurs : écrire `_t\`Texte ${valeur}\`` ; la clé est le texte avec `{}` pour chaque valeur (la traduction peut utiliser `{0}`, `{1}`… pour changer l'ordre). Mots « Soumission/Devis » dans l'interface : `uqw()`/`uqwP()` ; statuts : `uiSt()` ; montants et dates de l'interface : `money(x,UIL,…)`, `loc(UIL)`.
  - Jamais traduits : le document (`#paper`, langue du document), la page du client (`?s=`), et tout élément marqué `data-nt`. Les nouveaux documents et les exemples prennent la langue de l'interface ; les conditions par défaut suivent la langue du document (`P.termsDef(lang)`).
  - **Toute nouvelle phrase de l'interface doit être ajoutée dans `I18N` (anglais et espagnol).**
- Valeurs par défaut affichées en gris (placeholder) : un champ vide = valeur par défaut. Fonctions `P.*`, `taxEff`, `idEff`, `lq`, `lp`, `ld`, `titleOf`, `notesOf`.
- Documents d'exemple : marqués `sample:true`, régénérés selon le pays (`sample()`, `cleanSamples()`), jamais envoyés au nuage.
- `migrate()` convertit les anciennes données (v1, v2) au format v3.
- Document : rabais `disc`/`discT` (`%` ou `$`)/`discL`, calculé avant taxes ; paiements reçus `pays` [{id,date,a,n}] sur les factures (`totals()` donne `gross`, `disc`, `sub`, `paid`, `bal`) ; photos `photos` [{id,path,url}] ; lien d'acceptation `share` {id,at,synced,viewed} et acceptation `acc` {name,at,sig}.
- Tableau de bord (, page Documents) : encaissé par mois (6 mois), facturé/dépenses/profit de l'année, liste « À relancer » (factures en retard → rappel ; soumissions envoyées sans réponse depuis 7 jours → relance ,  ; factures créées toutes seules au brouillon → envoyer).
- Dépenses d'un contrat  [{id,date,a,n}] (, ) : jamais sur le document ni dans  ; profit = avant taxes − dépenses ; colonnes Dépenses/Profit dans l'Excel.
- Factures qui reviennent  {every:'w'|'m'|'q'|'y', next, day} :  crée la copie au brouillon () quand Carnet est ouvert à partir de cette date (après connexion et lecture de l'abonnement ; respecte ). Rien ne se fait si Carnet reste fermé (aucun serveur).
- Paiement par les clients :  (lien Stripe/PayPal/Square de l'entrepreneur, affiché sur les factures et courriels seulement avec Pro, ) et  (texte libre, pour tous).
- Avis du navigateur quand un client accepte (, permission demandée à l'envoi du lien), seulement si Carnet est ouvert dans un onglet ; clic géré dans .
- Photos (Pro) : Supabase Storage, bucket public `photos`, dossier `<id utilisateur>/` ; réduites à 1600 px JPEG dans la page (`shrinkPhoto`). Jamais effacées du stockage (une copie de document peut partager la même photo).
- Acceptation en ligne (Pro) : table `shares` (copie du document dans `data`), page du client `?s=<uuid>` (mode `SHARE` : aucune sauvegarde, aucune connexion, `openShare`/`renderShare`), fonctions SQL `share_view` et `share_accept` (seul accès des visiteurs). `syncShares()` met à jour la copie tant que ce n'est pas accepté ; `checkShares()` va chercher les acceptations (au démarrage, chaque minute, au retour sur l'onglet). Une soumission acceptée ne peut plus être modifiée dans `shares` (règle RLS).
- Section « Comptes, sauvegarde en ligne et abonnement » : objet `CFG` (URL et clé publique Supabase, `payLink` et `portalLink` Stripe, prix, `freeLimit`). Supabase JS chargé depuis jsDelivr (version fixée).
  - Forfait gratuit : `CFG.freeLimit` documents créés par mois (`counted:true`). Convertir une soumission en facture ne compte pas.
  - Paiement : lien de paiement Stripe avec `client_reference_id` = id de l'utilisateur ; retour sur `?pay=ok`, puis on relit `subscriptions`.
  - Essai gratuit : `CFG.payLinkTrial` (essai de `CFG.trialDays` jours) pour qui n'a jamais été abonné (`trialOK()` : aucune ligne dans `subscriptions`) ; sinon `CFG.payLink`, sans essai. Les textes (bouton, barre, page Pro, fenêtres) suivent `trialOK()`.
  - Plus de fenêtre d'accueil « Passez à Carnet Pro » : retirée à la demande du propriétaire (16 nov. 2026). Pas de faux prix barré (interdit au Canada).

## Règles

- Ne jamais mettre de clé secrète (`sk_…`, `sb_secret_…`, `service_role`, `whsec_…`) dans `public/` ni dans Git. Seule la clé publique Supabase (`sb_publishable_…`) va dans le site.
- Tester sur téléphone (400 px de large) et ordinateur, en mode clair et sombre.
- Garder les textes de l'interface en français québécois clair, sans jargon.
