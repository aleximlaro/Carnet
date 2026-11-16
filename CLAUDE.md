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
- `supabase/functions/stripe-portal/index.ts` : fonction Edge appelée par « Gérer mon abonnement » (`goPortal`) ; vérifie la session et ouvre directement le portail client Stripe, sans courriel. Verify JWT désactivé (la fonction vérifie elle-même). Si elle échoue, le site retombe sur `CFG.portalLink`.
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
- Valeurs par défaut affichées en gris (placeholder) : un champ vide = valeur par défaut. Fonctions `P.*`, `taxEff`, `idEff`, `lq`, `lp`, `ld`, `titleOf`, `notesOf`.
- Documents d'exemple : marqués `sample:true`, régénérés selon le pays (`sample()`, `cleanSamples()`), jamais envoyés au nuage.
- `migrate()` convertit les anciennes données (v1, v2) au format v3.
- Section « Comptes, sauvegarde en ligne et abonnement » : objet `CFG` (URL et clé publique Supabase, `payLink` et `portalLink` Stripe, prix, `freeLimit`). Supabase JS chargé depuis jsDelivr (version fixée).
  - Forfait gratuit : `CFG.freeLimit` documents créés par mois (`counted:true`). Convertir une soumission en facture ne compte pas.
  - Paiement : lien de paiement Stripe avec `client_reference_id` = id de l'utilisateur ; retour sur `?pay=ok`, puis on relit `subscriptions`.
  - Essai gratuit : `CFG.payLinkTrial` (essai de `CFG.trialDays` jours) pour qui n'a jamais été abonné (`trialOK()` : aucune ligne dans `subscriptions`) ; sinon `CFG.payLink`, sans essai. Les textes (bouton, barre, page Pro, fenêtres) suivent `trialOK()`.
  - Fenêtre d'accueil `#wdlg` (`maybePromo`) : à chaque visite (demande du propriétaire), jamais pour les abonnés Pro, ni au retour du paiement. `localStorage` `carnet.promo` = `off` la cache (tests automatiques seulement). Pas de faux prix barré (interdit au Canada).

## Règles

- Ne jamais mettre de clé secrète (`sk_…`, `sb_secret_…`, `service_role`, `whsec_…`) dans `public/` ni dans Git. Seule la clé publique Supabase (`sb_publishable_…`) va dans le site.
- Tester sur téléphone (400 px de large) et ordinateur, en mode clair et sombre.
- Garder les textes de l'interface en français québécois clair, sans jargon.
