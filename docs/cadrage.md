# Hub Kouzia : cadrage

Document de cadrage du hub interne de l'EI Kouzia (`hub.kouzia.com`). Document écrit avant le code ; le code suit désormais ses sections 2 à 6, avec les mises à jour ci-dessous. Les décisions verrouillées d'Alexandre (`.claude/rules/kouzia.md`, 17/10/2026) sont prises comme cadre et ne sont pas rediscutées ici.

> **Mise à jour du 17/10/2026 (deuxième série)** : les décisions de `.claude/rules/kouzia.md` remplacent ce document là où ils divergent. Pas de code d'accès (la section 1.4 ne s'applique plus : le `_worker.js` injecté ne fait que rediriger `pages.dev`, servir `robots.txt` en `Disallow` et poser `X-Robots-Tag: noindex, nofollow`) ; « couper » un site retire le CNAME puis le domaine (méthode B de 1.3) ; sites « Perso » sans client ; explorateur de fichiers en plus du zip.

Sources consultées le 17/10/2026 (liste complète en fin de document). Quand la documentation officielle ne tranche pas un point, le document le dit et le classe « à vérifier au lot X ».

## En bref

- **Faisable avec l'offre gratuite de Cloudflare**, avec trois réserves à connaître dès maintenant.
- **Réserve 1 : wrangler n'est pas pris en charge sur Alpine.** La doc officielle limite wrangler aux Linux à glibc 2.35 ou plus ; Alpine utilise musl. L'envoi des fichiers par l'API « pure » existe, mais trois de ses quatre appels ne sont pas documentés. Un essai sur un CT de test est donc le premier travail du lot 2.
- **Réserve 2 : une version de travail est visible ailleurs que sur `<client>.kouzia.com`.** Chaque projet Pages répond aussi sur `<projet>.pages.dev` et chaque déploiement sur `<hash>.<projet>.pages.dev`. La protection doit couvrir ces adresses, sinon elle ne sert à rien.
- **Réserve 3 : sous-domaine orphelin.** Supprimer un projet sans supprimer l'enregistrement DNS laisse une porte ouverte à une prise de contrôle. Le hub doit toujours supprimer le DNS en premier, et un contrôle quotidien doit vérifier qu'aucun enregistrement n'est orphelin.
- **Recommandation de protection : un code partagé vérifié par un petit programme Cloudflare (Pages Functions) injecté par le hub dans chaque déploiement**, en mode « fail closed ». Cloudflare Access avec un code reçu par e-mail reste possible en option, site par site, mais il consomme une place sur 50 par personne connectée.
- **Lien avec l'ERP : une route en lecture seule, joignable seulement sur le réseau local, signée comme le webhook de déploiement existant. Pas de migration Prisma.**

---

## 1. Faisabilité technique (doc Cloudflare, octobre 2026)

### 1.1 Créer un projet Pages et le déployer par API

**Création du projet : documentée.** `POST /accounts/{account_id}/pages/projects`, avec `name` (minuscules, chiffres et tirets, commence par une lettre ou un chiffre) et `production_branch`. Permission : Pages Write [CF-API-PROJ]. Le nom de projet détermine l'adresse `<projet>.pages.dev`, qui ne peut plus être changée ensuite [CF-KNOWN].

**Déploiement en « direct upload » : deux voies.**

| Voie | État dans la doc | Avantages | Limites |
|---|---|---|---|
| `wrangler pages deploy <dossier>` en ligne de commande, avec `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` | Documentée [CF-DU] [CF-CI] | Voie officielle, gère le hachage, l'envoi des seuls fichiers nouveaux, les Functions | Pas de zip (un dossier seulement) [CF-DU] ; **non pris en charge sur Alpine (musl)** [CF-WR-INSTALL] |
| API HTTP directe : jeton d'envoi, envoi des fichiers, enregistrement des empreintes, puis création du déploiement | Seule la dernière étape (`POST .../deployments`, multipart avec `manifest`) est documentée [CF-API-DEPLOY] | Pas de dépendance Node lourde, fonctionne partout | Les trois premiers appels ne sont pas documentés, ont été reconstitués par la communauté [DEV-PY] et peuvent changer sans préavis |

Limites du direct upload : 20 000 fichiers et 25 Mio par fichier avec wrangler ; 1 000 fichiers par glisser-déposer dans le tableau de bord [CF-DU]. Un projet en direct upload ne peut jamais passer en intégration Git [CF-DU], ce qui convient ici (les sources GitHub sont lues par le hub, voir 5.5).

**Recommandation :**

1. Lot 2 : essai de `wrangler pages deploy` dans un CT Alpine de test avec la couche de compatibilité `gcompat`. Le déploiement n'exécute pas le moteur local `workerd` (utilisé pour `wrangler dev`), l'essai a donc de bonnes chances de passer, mais cela reste hors du périmètre pris en charge par Cloudflare.
2. Si l'essai échoue ou paraît fragile : appeler l'API directe depuis le hub, en isolant ces appels dans un seul module couvert par un test de bout en bout lancé avant chaque mise à jour (`hubctl update`), pour détecter un changement de l'API au plus tôt.
3. Dernier repli, à éviter : un CT Debian pour le seul hub. Voir la section 2.3.

Le protecteur par code (section 1.4) est envoyé sous forme d'un fichier `_worker.js` déjà prêt, que la création de déploiement accepte directement [CF-API-DEPLOY]. Aucune compilation n'est alors nécessaire sur le serveur, quelle que soit la voie retenue.

### 1.2 Ajouter `<client>.kouzia.com` au projet et créer le DNS

- Ajout du domaine au projet : `POST /accounts/{account_id}/pages/projects/{project_name}/domains` avec `{"name": "<client>.kouzia.com"}`. Permission : Pages Write [CF-API-DOM].
- **Par l'API, l'enregistrement DNS n'est pas créé automatiquement** (il ne l'est que dans le tableau de bord) [CF-DOMAINS] [PULUMI-DOM]. Le hub crée donc lui-même un CNAME `<client>` vers `<projet>.pages.dev`, proxifié : `POST /zones/{zone_id}/dns_records`, permission DNS Write [CF-API-DNS]. Le champ `comment` sert à marquer l'enregistrement (`kouzia-hub:<id du site>`) pour le contrôle des orphelins.
- Ordre imposé : domaine ajouté au projet, CNAME créé, attente du statut actif (certificat émis), et seulement ensuite une éventuelle règle Access, car Cloudflare refuse d'ajouter un domaine personnalisé déjà couvert par une règle Access [CF-KNOWN].
- Retrait : `DELETE .../domains/{domain_name}` [CF-API-DOM-DEL]. La doc ne dit pas que le CNAME est supprimé avec ; le hub le supprime explicitement.

### 1.3 Couper ou réactiver un site

| Méthode | Comment | Effet | Verdict |
|---|---|---|---|
| A. Page « site en pause » | Le hub publie un déploiement qui ne contient qu'une page « Ce site est en pause » (statut 503, `noindex`) | Immédiat, aucun changement DNS, couvre aussi `pages.dev` | **Recommandée** pour « couper » |
| B. Retrait du domaine | Suppression du CNAME puis du domaine du projet | Le sous-domaine ne répond plus du tout | Pour la fin de vie seulement : remettre le domaine demande une nouvelle validation et un nouveau certificat (quelques minutes) |
| C. Access en blocage total | Application Access avec une règle Block sur Everyone [CF-ACCESS-POL] | Coupure nette | Ajoute une application Access par site, complique la réactivation (ordre domaine puis Access, [CF-KNOWN]), et ne couvre pas `pages.dev` sans réglage supplémentaire |
| D. Suppression du projet | `DELETE` du projet | Libère une place sur 100 | Fin de vie seulement, DNS supprimé avant (risque d'orphelin, section 6) |

**Réactiver** (méthode A) : le hub republie la dernière version de contenu active. Il ne passe pas par l'API de retour arrière de Cloudflare [CF-API-ROLLBACK], parce que la doc ne précise pas si un déploiement restauré reprend les variables d'environnement de son époque (donc un ancien code d'accès). Republier une version archivée avec la configuration du moment évite ce doute. À vérifier au lot 3.

Point important : **Cloudflare continue de servir chaque ancien déploiement sur son adresse `<hash>.<projet>.pages.dev`** ; seule la suppression du déploiement les retire, et le dernier déploiement d'une branche ne peut pas être supprimé [CF-API-REST]. Les parades sont en 1.4 (le protecteur redirige toute adresse autre que le domaine du client) et au lot 3 (purge des anciennes versions). La doc signale aussi qu'un projet de plus de 100 déploiements peut devenir impossible à supprimer [CF-KNOWN] : la purge régulière le prévient.

### 1.4 Protéger chaque version de travail par un code

**Option 1 : Cloudflare Access avec code reçu par e-mail (One-time PIN).**

- Le client saisit son adresse ; si une règle l'autorise, Cloudflare envoie un code valable 10 minutes, à usage unique, depuis `noreply@notify.cloudflare.com` [CF-OTP].
- Gestion par API : création d'applications et de règles avec la permission « Access: Apps and Policies Edit » [CF-API-ACCESS] [CF-PERMS]. 500 applications et 500 règles réutilisables par compte, 1 000 adresses par règle [CF-ZT-LIMITS].
- **Places limitées** : chaque connexion par Access consomme une place [CF-SEATS] ; l'offre gratuite Zero Trust couvre 50 utilisateurs [CF-BLOG-PLANS]. Une fois les places épuisées, les nouvelles connexions sont bloquées [CF-SEATS]. Les places se libèrent en retirant l'utilisateur dans le tableau de bord ou par expiration automatique, réglable d'un mois à un an [CF-SEATS]. La doc consultée ne décrit pas de retrait par API. Le 51e utilisateur fait passer tout le compte en offre payante (7 dollars par utilisateur et par mois selon la page de tarifs citée par la communauté [CF-COMMUNITY-PRICING], à reconfirmer au moment voulu).
- L'adresse d'Alexandre consomme déjà une place pour `hub.kouzia.com`.
- Avantages : identité vérifiée par e-mail, journal des connexions, aucun code à communiquer. Inconvénients : chaque collaborateur du client doit être ajouté nommément, page de connexion aux couleurs de Cloudflare, plafond de 50 personnes au total, et `pages.dev` à protéger séparément (réglage « Enable access policy » du projet) [CF-PREVIEW].

**Option 2 : code partagé vérifié par un programme Pages Functions injecté par le hub.**

- Le hub ajoute à chaque déploiement un fichier `_worker.js` (mode avancé des Functions) qui, avant de servir un fichier :
  1. redirige en 301 toute adresse autre que `<client>.kouzia.com` (`<projet>.pages.dev`, `<hash>.<projet>.pages.dev`) vers le domaine du client ;
  2. sert `robots.txt` (`Disallow: /`) et ajoute `X-Robots-Tag: noindex, nofollow` ainsi que les en-têtes de sécurité à toutes les réponses ;
  3. sans cookie valide, renvoie une page de saisie du code (statut 401, aux couleurs de Kouzia) ;
  4. à la saisie, compare l'empreinte du code à la valeur stockée en variable chiffrée du projet (`secret_text` [CF-API-PROJ-EDIT]) et pose un cookie `__Host-` `HttpOnly`, `Secure`, `SameSite=Lax`, signé (HMAC), lié au site et à la version du code, valable 30 jours.
- Changer le code = changer la variable et republier la version (les fichiers ne sont pas renvoyés, ils sont déjà connus de Cloudflare). Les anciens cookies deviennent invalides.
- Coût : chaque requête passe par le programme et compte dans le quota gratuit de 100 000 requêtes par jour pour tout le compte [CF-FN-PRICING]. Pour des versions de travail visitées par quelques personnes, c'est largement suffisant (environ 3 000 pages vues par jour à 30 requêtes par page).
- **Réglage obligatoire « fail closed »** : sans lui, une fois le quota du jour épuisé, Cloudflare sert les fichiers sans passer par le programme, donc sans protection [CF-FN-ROUTING]. Le hub règle ce point à la création du projet (ou Alexandre le vérifie dans Settings, Runtime, Fail open / closed ; le nom du champ d'API est à confirmer au lot 4).
- Force brute : un code de 10 caractères tirés parmi 32 (environ 50 bits) rend l'essai systématique hors de portée, et une règle de limitation de débit de la zone (une seule règle gratuite, comptage par IP sur 10 secondes, filtre sur le chemin [CF-RATE]) bloque les rafales sur `/__kouzia/acces`.
- C'est le modèle retenu par Vercel pour sa protection par mot de passe (mot de passe unique par projet, cookie limité à l'adresse, invalidé au changement de mot de passe) [VERCEL-PWD], qu'il facture 20 dollars par mois et par projet ; ici, le coût est nul.
- Avantages : aucune limite de places, fonctionne pour un nombre quelconque de personnes chez le client, page à l'identité Kouzia, couvre toutes les adresses du projet, pause et code gérés au même endroit. Inconvénients : un code partagé peut être retransmis par le client ; pas d'identité nominative ; le hub doit écrire et tester ce programme (environ 100 lignes).

**Recommandation : option 2 par défaut.** Elle respecte la décision « code reçu par e-mail ou communiqué » sans plafond de 50 personnes. Option 1 proposée en lot optionnel, site par site, pour un client qui exigerait des accès nominatifs.

### 1.5 Empêcher l'indexation

Trois couches, de la plus proche du contenu à la plus large :

1. Le protecteur (1.4) ajoute `X-Robots-Tag: noindex, nofollow` à toute réponse, y compris la page de code et la page de pause, et sert `robots.txt` en `Disallow: /`. Le fichier `_headers` ne suffit pas seul : ses règles ne s'appliquent pas aux réponses produites par les Functions [CF-HEADERS].
2. Règle de transformation des en-têtes de réponse sur la zone `kouzia.com`, qui pose `X-Robots-Tag` pour tout nom d'hôte en `.kouzia.com` sauf `kouzia.com` et `www.kouzia.com` [CF-TRANSFORM]. L'offre gratuite autorise 10 règles de transformation actives [CF-TRANSFORM-AVAIL]. Filet de sécurité indépendant des fichiers envoyés.
3. Les déploiements de prévisualisation portent déjà `X-Robots-Tag: noindex` par défaut [CF-PREVIEW], et les adresses `pages.dev` sont redirigées par le protecteur.

Note : `Disallow` empêche l'exploration, donc le robot ne voit pas l'en-tête `noindex`. Ce n'est pas gênant ici, puisque rien n'est lisible sans le code.

### 1.6 Cloudflare Access devant `hub.kouzia.com`

- Application Access « self-hosted » sur `hub.kouzia.com`, règle Allow avec le sélecteur Emails réduit à l'adresse d'Alexandre [CF-ACCESS-POL]. Fournisseur d'identité : code par e-mail (rien à configurer) ou Google.
- Créée une fois à la main par Alexandre (le jeton du hub n'a pas besoin de ce droit).
- Le hub vérifie lui-même l'en-tête `Cf-Access-Jwt-Assertion` (signature avec les clés publiques de `https://<équipe>.cloudflareaccess.com/cdn-cgi/access/certs`, contrôle de `iss` et de `aud`), comme le recommande Cloudflare [CF-JWT]. Une requête qui contournerait Access est ainsi refusée.
- Puis login propre à l'outil (mot de passe et code TOTP, repris de l'ERP).

### 1.7 Droits minimaux du jeton API Cloudflare

Jeton personnalisé créé par Alexandre, placé par lui dans `.env` du CT du hub.

| Portée | Permission | Pourquoi | Lot |
|---|---|---|---|
| Compte (le compte d'Alexandre seulement) | Cloudflare Pages : Edit | Créer, déployer, domaines, variables, purge, suppression [CF-PERMS] [CF-CI] | 2 |
| Zone `kouzia.com` seulement | DNS : Edit | Créer et supprimer les CNAME `<client>` [CF-PERMS] | 2 |
| Zone `kouzia.com` seulement | DNS : Read | Contrôle quotidien des orphelins (inclus dans Edit, à ne pas ajouter à part) | 5 |
| Compte | Access: Apps and Policies : Edit | **Seulement si** l'option Access par e-mail est retenue | optionnel |

Volontairement absents : Zone Read (l'identifiant de zone et de compte sont mis dans `.env`, `CLOUDFLARE_ACCOUNT_ID` évite aussi à wrangler de chercher le compte), Transform Rules et WAF (réglés une fois à la main), Access Organizations (réglé une fois à la main), tout droit utilisateur ou facturation.

Restrictions supplémentaires du jeton : filtrage par adresse IP de sortie de la box si elle est fixe, date d'expiration (un an, avec rappel dans le hub un mois avant). Le jeton du tunnel reste un secret distinct.

### 1.8 Limites de l'offre gratuite

| Élément | Limite | Source |
|---|---|---|
| Projets Pages | 100 par compte | [CF-LIMITS] |
| Fichiers par site | 20 000 | [CF-LIMITS] |
| Taille d'un fichier | 25 Mio | [CF-LIMITS] |
| Builds | 500 par mois, 1 à la fois, 20 min (sans objet : le hub n'utilise pas les builds Cloudflare) | [CF-LIMITS] |
| Domaines personnalisés | 100 par projet | [CF-LIMITS] |
| `_headers` | 100 règles, 2 000 caractères par ligne | [CF-HEADERS] |
| Redirections | 2 000 statiques et 100 dynamiques | [CF-LIMITS] |
| Requêtes Functions | 100 000 par jour pour tout le compte, partagées avec les Workers | [CF-FN-PRICING] |
| Utilisateurs Zero Trust | 50 | [CF-BLOG-PLANS] |
| Applications Access | 500 | [CF-ZT-LIMITS] |
| Limitation de débit | 1 règle, 10 s, comptage par IP | [CF-RATE] |
| Règles de transformation | 10 actives | [CF-TRANSFORM-AVAIL] |
| Capture d'écran Browser Rendering | 10 min de navigateur par jour, 1 requête toutes les 10 s | [CF-BR] |
| Nouveau compte | Restriction temporaire de création de projets les 48 premières heures | [CF-LIMITS] |

Conséquence : avec un projet par client, le plafond de 100 projets impose de supprimer le projet d'un client quelque temps après la mise en ligne sur son domaine final (décision ouverte n° 6). Le hub affiche le compteur « projets utilisés / 100 ».

---

## 2. Architecture proposée

### 2.1 Vue d'ensemble

```
Téléphone ou PC d'Alexandre
   │ HTTPS
   ▼
Cloudflare Access (hub.kouzia.com, adresse d'Alexandre seule)
   │ tunnel Cloudflare (cloudflared dans le CT du hub)
   ▼
CT Alpine « kouziahub » (Proxmox)            CT Alpine « kouziacrm » (ERP)
  API Fastify + SPA React  ── réseau local ──►  GET /api/hub/clients (lecture seule,
  SQLite (Prisma)                                signée, hors tunnel)
  archives des versions
   │ HTTPS sortant, jeton API Cloudflare
   ▼
API Cloudflare : Pages, DNS kouzia.com
   ▼
<client>.kouzia.com  ← client, avec le code
```

### 2.2 Choix alignés sur l'ERP

- **Même stack** : API Fastify, Prisma et SQLite ; SPA Vite, React, TypeScript, Tailwind 4, Font Awesome ; `zod`, `argon2`, `sonner`, `cmdk`, `vitest`. Mêmes conventions (`requireAuth` sur chaque route, entrées validées par `zod`, imports en `.js`, migrations Prisma versionnées).
- **Même hébergement** : CT Alpine dédié sur le Proxmox, services OpenRC sous `supervise-daemon` (relance automatique, comme `scripts/alpine/openrc/kouziacrm` de l'ERP), journaux dans `/var/log/kouziahub`, sauvegarde SQLite et archives par le même principe que `backup.sh`.
- **Même outil de maintenance** : `hubctl`, copie adaptée de `kouziactl` (menu et commandes directes : `install`, `update` avec sauvegarde préalable, `npm ci` seulement si le verrou change, `migrate deploy`, redémarrage et contrôle de santé, `status`, `logs`, `backup`, `restore`, `cloudflare` pour le jeton du tunnel). Mêmes noms de commandes, pour qu'Alexandre n'ait qu'une seule façon de faire.
- **Tunnel** : un tunnel distinct pour le CT du hub (même procédure que `kouziactl cloudflare`), plutôt qu'un nom d'hôte de plus dans le tunnel de l'ERP. Chaque CT reste isolé : une compromission de l'un ne donne pas de route vers l'autre, et le filtre d'hôte de l'ERP (`tunnel-hosts.ts`) n'est pas touché.
- **Login** : mot de passe (`argon2`) puis TOTP obligatoire, codes de secours, limite de débit et verrouillage, repris de l'ERP. Mono-utilisateur, comme l'ERP.
- **Secrets** : `.env` seulement, `.env.example` sans valeurs, droits 600.

### 2.3 Points où l'alignement serait un mauvais choix

1. **wrangler sur Alpine** (voir 1.1). Si l'essai échoue, préférer l'API directe à un CT Debian : un second système (systemd au lieu d'OpenRC) casserait l'unicité de fonctionnement voulue.
2. **Capture des vignettes** : Chromium et Playwright ne sont pas non plus officiellement pris en charge sur musl. Le paquet `chromium` d'Alpine piloté par `playwright-core` fonctionne en général, mais pèse environ 300 Mo et doit rester hors du chemin critique. Repli : image envoyée à la main (voir 5.1).
3. **Même CT que l'ERP : non.** Le jeton Cloudflare (Pages et DNS en écriture) ne doit pas côtoyer la clé de chiffrement des données clients de l'ERP, et inversement.
4. **Copier les scripts Alpine** crée une duplication. C'est acceptable au départ ; une bibliothèque shell commune aux deux dépôts pourra venir ensuite, sur décision (n° 10).

---

## 3. Lien avec l'ERP (proposition, rien n'est écrit dans KouziaCRM)

### 3.1 Constat dans l'ERP

- Les données personnelles des clients sont chiffrées au repos (`emailEncrypted`, `phoneEncrypted`, `siretEncrypted`, recherche par `emailHash`, AES-256-GCM dans `apps/api/src/lib/crypto.ts`).
- Il n'existe pas aujourd'hui d'authentification machine à machine, hormis la signature HMAC horodatée du webhook de déploiement du site (`routes/webhooks-site.ts`, en-tête `x-kouzia-signature`).
- Par le tunnel, `erp.kouzia.com` sert toute l'API après login, et `api.kouzia.com` seulement `/api/public/*`, `/api/webhooks/*`, le retour Google et `/api/health` (`lib/tunnel-hosts.ts`).

### 3.2 Point d'accès proposé

- **Routes** : `GET /api/hub/clients` (liste) et `GET /api/hub/clients/:id` (un client). Lecture seule, aucune autre méthode.
- **Joignable seulement hors tunnel** : la route répond 404 si `request.viaTunnel` est vrai, quel que soit l'hôte. Le hub appelle l'ERP par le réseau local du Proxmox (`http://<ip du CT ERP>:<port>`), avec une règle du pare-feu Proxmox qui n'ouvre ce port qu'au CT du hub, et une liste d'IP autorisées dans l'ERP (`HUB_ALLOWED_IPS`), comparée à `request.ip`.
- **Authentification machine à machine** : même schéma que le webhook existant, pour ne pas inventer un second mécanisme. Le hub signe `horodatage.méthode.chemin` en HMAC-SHA256 avec un secret partagé (`HUB_READ_SECRET`, 32 octets aléatoires, posé par Alexandre dans les deux `.env`). L'ERP refuse un horodatage de plus de 5 minutes, compare en temps constant et répond 404 identique en cas d'échec. Limite de débit.
- **Champs minimaux** (liste) : `id`, `clientNumber`, `displayName`, `type` (particulier ou professionnel), `updatedAt`, et, pour aider au rattachement, les projets de type site (`ClientProject` avec `kind = SITE` : `id`, `name`, `status`). Pas d'adresse, de téléphone, de SIRET, de notes.
- **Adresse e-mail** : non exposée en V1 (décision ouverte n° 2). Si le hub doit un jour envoyer le code lui-même, une route distincte `GET /api/hub/clients/:id/contact` renverrait l'adresse déchiffrée à la demande, sans mise en cache côté hub.
- **Rien de journalisé en clair** : la réponse n'est jamais journalisée (Fastify ne journalise que la méthode, l'URL et le statut) ; l'en-tête de signature n'est pas journalisé ; un test vérifie que le journal d'une requête `/api/hub/*` ne contient ni nom ni adresse.
- **Migration Prisma : aucune.** Tous les champs existent déjà. Seules des variables d'environnement s'ajoutent (`HUB_READ_SECRET`, `HUB_ALLOWED_IPS`) et `.env.example` est complété. Un lien inverse (afficher l'adresse de la version de travail dans la fiche client de l'ERP) peut passer par le champ JSON existant `ClientProject.links`, saisi à la main, sans migration.

Ce changement se fait dans le dépôt KouziaCRM, annoncé au superviseur et validé avant écriture (garde-fou de `kouzia.md`).

### 3.3 Côté hub

- Le hub ne stocke que l'identifiant ERP du client (`erpClientId`), jamais son nom ni son adresse. Le nom est lu à l'affichage, avec un cache en mémoire de quelques minutes.
- Si l'ERP ne répond pas, le catalogue reste utilisable : il affiche le libellé du site (non personnel) et un avertissement « Clients de l'ERP indisponibles ».

### 3.4 Spécification exacte attendue par le hub (côté hub écrit le 17/10/2026, côté ERP à faire après validation)

Le hub contient déjà le client de lecture (`apps/api/src/lib/erp/http.ts`), testé contre un faux serveur. Il n'est actif que si `ERP_BASE_URL` est posée ; sinon une liste de démonstration sert en dev. Si `ERP_BASE_URL` est posée sans `HUB_READ_SECRET`, le hub refuse de démarrer.

- **Écouteur dédié côté ERP** : la route n'est servie que sur un écouteur à part, port 3100, sur l'IP du CT ERP dans le réseau local du Proxmox (jamais par le tunnel ni sur le port de l'interface). Une règle du pare-feu Proxmox, côté CT ERP, n'ouvre le port 3100 qu'à l'IP du CT du hub. Côté hub : `ERP_BASE_URL=http://<IP du CT ERP>:3100`.
- **Requêtes** : `GET {ERP_BASE_URL}/api/hub/clients` (liste complète) et `GET {ERP_BASE_URL}/api/hub/clients/:id` (identifiant encodé dans l'URL, accepté seulement s'il respecte `^[A-Za-z0-9_-]{1,64}$`, sinon le hub n'appelle pas). Aucune autre méthode, aucun paramètre de requête : la recherche se fait côté hub.
- **En-têtes** :
  - `x-kouzia-hub-timestamp` : horodatage en secondes Unix ;
  - `x-kouzia-hub-signature` : `sha256=` suivi du HMAC-SHA256 en hexadécimal de `<horodatage>.GET.<chemin>`, avec la clé `HUB_READ_SECRET` ; le chemin signé est le pathname exact, sans requête (même format `sha256=` que le webhook existant de l'ERP).
- **Contrôles côté ERP** : horodatage à plus ou moins 5 minutes, comparaison en temps constant, `request.viaTunnel` faux, IP dans `HUB_ALLOWED_IPS`, limite de débit ; tout refus répond la même 404.
- **Réponses** :
  - liste : `{ "clients": [ { "id": string, "clientNumber": string | null, "displayName": string, "type": "B2B" | "B2C" | "ASSOCIATION" } ] }` ;
  - un client : `{ "client": { mêmes champs } }` ; 404 = client inconnu ;
  - aucun autre champ (ni adresse, ni téléphone, ni SIRET, ni notes) ;
  - chaque client est validé à part : `displayName` de 1 à 300 caractères, `clientNumber` de 64 caractères au plus ou null, `type` parmi les trois valeurs, `id` conforme au motif ci-dessus. Un client invalide est écarté seul et le hub ne journalise que le nombre d'écartés, jamais un nom. Seuls un JSON illisible, une enveloppe absente (`clients` ou `client`) ou une réponse non 2xx valent « ERP indisponible ». Un client invalide lu seul vaut « inconnu ».
- **Comportement du hub** : délai de 3 s ; liste gardée 5 minutes en mémoire ; toute erreur réseau, réponse non 2xx ou JSON invalide vaut « ERP indisponible » (catalogue toujours servi, bandeau affiché, création d'un site client refusée en 503). Le hub ne stocke que `erpClientId`.
- **Lien vers la fiche** : `ERP_PUBLIC_ORIGIN` + `/clients/:id` (route de l'interface de l'ERP).
- **Variables** : hub `ERP_BASE_URL` (`http://<IP du CT ERP>:3100`), `HUB_READ_SECRET`, `ERP_PUBLIC_ORIGIN` ; ERP `HUB_READ_SECRET` (même valeur), `HUB_ALLOWED_IPS` (IP du CT du hub).

---

## 4. Modèle de données du hub

Prisma et SQLite, comme l'ERP. Noms indicatifs.

**Site**
- `id`, `label` (nom du site affiché, non personnel), `slug` (sous-domaine, unique, liste de noms réservés refusés : `www`, `erp`, `api`, `hub`, `mail`, `admin`, etc.)
- `erpClientId`, `erpProjectId` (facultatif)
- `pagesProject` (nom du projet Cloudflare, unique), `pagesSubdomain` (adresse `pages.dev` renvoyée par Cloudflare)
- `dnsRecordId`, `domainStatus` (en attente, actif, erreur)
- `state` : brouillon, en création, actif, en pause, erreur, archivé
- `protection` : code (défaut) ou e-mail Access (option)
- `currentVersionId` (version servie), `lastContentVersionId` (dernière version de contenu, pour réactiver après une pause)
- `thumbnailPath`, `thumbnailSource` (capture ou image envoyée), `thumbnailAt`
- `pausedAt`, `finalLaunchAt` (date de mise en ligne sur le domaine final, saisie à la main), `createdAt`, `updatedAt`

**Version** (une par envoi)
- `id`, `siteId`, `number` (1, 2, 3 par site), `note` (« retours du 12/11 »)
- `kind` : contenu ou page de pause
- `source` : dossier, zip ou GitHub ; `sourceRef` (dépôt, branche, commit, identifiant d'artefact)
- `fileCount`, `totalBytes`, `archivePath` (zip conservé sur le CT), `archiveSha256`
- `cfDeploymentId`, `cfDeploymentUrl`, `status` (envoi, publié, échec), `error`
- `publishedAt`, `purgedAt` (déploiement supprimé chez Cloudflare)

**AccessCode**
- `id`, `siteId`, `version` (incrémentée à chaque changement), `codeEncrypted` (pour pouvoir le réafficher à Alexandre, chiffré AES-256-GCM avec la clé du hub), `createdAt`, `revokedAt`, `sentAt` (coché à la main quand le code a été transmis)
- L'empreinte envoyée à Cloudflare est calculée à la publication, jamais stockée en clair.

**GithubSource** (lot optionnel) : `siteId`, `repo`, `branch`, `workflow`, `artifactName`.

**AuditEvent** : `id`, `siteId`, `action` (création, envoi, pause, réactivation, changement de code, suppression), `result`, `at`, `detail` sans secret.

**Admin, Session, TotpSecret, RecoveryCode** : repris de l'ERP.

Rétention : 10 versions de contenu par site sur le CT et chez Cloudflare ; au-delà, l'archive locale et le déploiement Cloudflare sont supprimés (le dernier ne peut pas l'être [CF-API-REST]).

---

## 5. Parcours et interface

### 5.1 Références UX retenues

- **Cartes pour parcourir, liste pour comparer** : les cartes conviennent à la navigation libre mais sont moins lisibles qu'une liste pour chercher ou comparer [NNG-CARDS]. Le catalogue propose donc les deux vues, cartes par défaut.
- **Glisser-déposer** : zone de dépôt clairement signalée pendant le survol, zone active plus large que le cadre visible, alternative au clavier et sur mobile par un bouton classique [NNG-DND].
- **Envoi de fichiers** : zone de dépôt large et toujours visible, bouton « Choisir » toujours présent, messages d'erreur précis par cas (vide, trop gros, mauvais type, échec) [GOVUK-UPLOAD].
- **Confirmation** : texte précis sur la conséquence, bouton qui nomme l'action (« Mettre en pause » et non « Oui »), réservée aux actions graves, saisie du nom pour l'action la plus destructrice, et annulation possible plutôt que confirmation quand c'est faisable [NNG-CONFIRM].
- **Retour arrière** : Vercel affiche la version actuelle et la version choisie côte à côte, rappelle les domaines touchés, puis confirme [VERCEL-ROLLBACK] ; Cloudflare propose « Rollback to this deployment » dans le menu de chaque ligne de la liste des déploiements [CF-ROLLBACKS].
- **Mise à jour par dépôt** : Netlify place la zone de dépôt en bas de la page des déploiements d'un site, à côté de l'historique [NETLIFY-DEPLOY]. Le hub fait de même dans la fiche.
- **Rangée « Modifiés récemment » (motif « catalogue de streaming »)** : jamais de défilement automatique sur mobile, une partie de l'élément suivant visible pour signaler la suite, peu d'éléments, et tout contenu de la rangée présent aussi ailleurs (ici dans la grille), car une rangée défilante est souvent ignorée [NNG-CAROUSEL]. Si un défilement automatique existait, il s'arrêterait dès qu'un élément reçoit le focus ; les commandes ne déplacent pas le focus [WAI-CAROUSEL]. Le hub retient une rangée à défilement manuel (scroll-snap), sans rotation ni points indicateurs, chaque carte étant un lien atteignable au clavier.
- **Explorateur de fichiers** : fil d'Ariane des dossiers qui montre la hiérarchie et non l'historique, dernier élément non cliquable et distinct, pas de retour à la ligne sur mobile (au besoin seul le dossier parent) [NNG-BREADCRUMBS] ; liste plutôt que cartes pour parcourir et comparer des fichiers [NNG-CARDS] ; envoi par bouton toujours présent et glisser-déposer en plus [GOVUK-UPLOAD] [NNG-DND] ; suppression confirmée en nommant le nombre d'éléments [NNG-CONFIRM].
- **Identité et primitives** : celles de l'ERP (thème sombre, nuit et ambre, Exo 2 pour les titres, tokens de `index.css`, `PageHeader`, `StatStrip`, `DataTable`, `FilterChips`, `Tabs`, `Card`, `Modal`, `ConfirmDialog`, `sonner`), copiées dans le hub puis maintenues à l'identique.

### 5.2 Catalogue (accueil)

- `PageHeader` « Sites » avec le bouton principal « Nouveau site ».
- `StatStrip` : actifs, en pause, projets utilisés sur 100.
- `FilterChips` : Tous, Actifs, En pause, Brouillons ; recherche par client ou sous-domaine.
- Grille de cartes en `auto-fit` : une colonne sur un Samsung en portrait (360 à 412 px), deux dès qu'il y a la place, plus sur grand écran. Chaque carte : vignette 16:10 (`aspect-ratio`, chargement différé), libellé, client, état en texte et icône (jamais la couleur seule), date de la dernière version. La carte entière est un lien vers la fiche ; aucune action destructrice sur la carte.
- Bascule « Liste » : `DataTable` avec les colonnes essentielles (site, client, état, dernière version).
- État vide : « Aucun site pour l'instant » avec le bouton de création. État d'erreur ERP : bandeau, catalogue toujours affiché.
- Le style « catalogue de streaming » se traduit par de grandes vignettes et une rangée « Modifiés récemment » en tête ; pas de carrousel automatique ni de défilement détourné (règle `web-design`).

### 5.3 Création en un clic

1. « Nouveau site » ouvre un `Modal` : choix du client par recherche (`cmdk`, liste lue dans l'ERP), sous-domaine proposé à partir du nom du client (minuscules, sans accent), modifiable, avec contrôle immédiat (format, nom réservé, déjà pris).
2. Un seul bouton « Créer `<slug>.kouzia.com` ».
3. Écran de progression par étapes, chacune avec son état : projet créé, domaine ajouté, DNS créé, certificat en cours (peut prendre quelques minutes), protection réglée, page d'attente publiée, code généré. En cas d'échec, l'étape fautive est nommée et un bouton « Reprendre » relance à partir d'elle (chaque étape est rejouable sans doublon).
4. À la fin : fiche du site, avec le code affiché et un bouton « Copier ».

### 5.4 Fiche d'un site

- `PageHeader` avec retour au catalogue, état et lien « Ouvrir le site ».
- Onglets (`?tab=`) : **Versions** (zone d'envoi en tête, puis historique : numéro, note, date, source, taille ; menu par ligne « Republier cette version »), **Accès** (code masqué avec « Afficher » et « Copier », « Changer le code », case « code transmis »), **Vignette** (capture automatique avec « Reprendre la capture », ou image envoyée), **Réglages** (libellé, client lié, mise en ligne finale, suppression).
- Panneau de synthèse (sous le contenu sur mobile) : adresse, client avec lien vers sa fiche dans l'ERP, version servie, interrupteur « Actif / En pause ».
- **Pause** : `ConfirmDialog` « Mettre `<slug>.kouzia.com` en pause ? Les visiteurs verront une page "site en pause". Vous pourrez le réactiver à tout moment. » ; après l'action, un toast `sonner` avec « Annuler ».
- **Suppression** : saisie du sous-domaine exigée ; texte qui rappelle que l'adresse cessera de répondre et que les versions archivées seront supprimées.

### 5.5 Envoi des fichiers

- **Zip glissé-déposé ou choisi** : voie principale, y compris sur téléphone.
- **Dossier glissé-déposé ou choisi** (sélection de dossier du navigateur) : sur ordinateur. Sur Android, la sélection de dossier n'est pas fiable ; l'interface n'y propose que le zip et GitHub.
- **Depuis un dépôt GitHub** (lot optionnel) : le hub ne compile rien sur le serveur (exécuter `npm ci` sur du code tiers serait un risque). Le dépôt construit `dist` dans GitHub Actions et le publie comme artefact ; le hub liste les artefacts du dépôt et télécharge le zip choisi (`GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip`) [GH-ARTIFACTS], avec un jeton GitHub à grain fin limité aux dépôts choisis et au droit de lecture Actions (droit exact à confirmer au lot 7).
- **Avant publication** : résumé (nombre de fichiers, taille, présence de `index.html`, fichiers écartés et pourquoi), champ « note de version », bouton « Publier la version N ». Progression pendant l'envoi ; à la fin, toast et vignette rafraîchie.

### 5.6 Vignettes

- Capture automatique après chaque publication : navigateur sans interface dans le CT, qui visite le site avec un cookie d'accès fabriqué par le hub (il connaît le secret), à 1280 × 800, convertie en WebP. Vignettes servies par le hub uniquement, jamais publiques.
- Alternative Cloudflare Browser Rendering : possible mais limitée à 10 minutes par jour sur l'offre gratuite [CF-BR], et demanderait un droit de plus sur le jeton. Non retenue.
- Si la capture échoue ou si Alexandre préfère, image envoyée à la main (redimensionnée et convertie par le hub).

---

## 6. Sécurité

| Menace | Parades |
|---|---|
| **Fuite du jeton API Cloudflare** | Droits minimaux (1.7), limité au compte et à la zone `kouzia.com`, filtré par IP si possible, date d'expiration. Seulement dans `.env` (600, propriétaire du service), jamais envoyé au navigateur, jamais journalisé (masquage des en-têtes `Authorization` et de la variable dans les journaux, y compris la sortie de wrangler). Procédure de rotation dans `hubctl`. En cas de fuite : révocation immédiate dans Cloudflare, nouveau jeton, lecture du journal d'audit du compte. Le jeton n'a aucun droit sur les autres zones, donc sur les domaines finaux des clients. |
| **Fichiers malveillants ou piégés** | Contrôles du zip avant décompression : chemins normalisés, refus de `..`, des chemins absolus, des liens symboliques et des noms en double ; plafonds de taille décompressée totale, de taille par fichier (25 Mio) et de nombre de fichiers (20 000) contre les bombes zip ; décompression dans un dossier temporaire neuf hors de l'application. Refus des fichiers de développement (`.env`, `.git`, `node_modules`, `.map`, sauvegardes) avec message. **Refus de `_worker.js`, `functions/` et `_routes.json` envoyés** : seul le hub injecte du code exécuté par Cloudflare, sinon un fichier envoyé pourrait exécuter du code sur le compte. `_headers` et `_redirects` envoyés sont fusionnés avec ceux du hub, qui gardent la priorité. Seul Alexandre envoie des fichiers. |
| **Sous-domaine orphelin et prise de contrôle** | Un CNAME qui pointe vers un projet `pages.dev` supprimé peut être repris par un tiers qui recrée ce nom [SCOUT-DANGLING]. Le hub supprime toujours dans cet ordre : CNAME, domaine du projet, puis projet. Contrôle quotidien : chaque CNAME de `kouzia.com` marqué `kouzia-hub:` doit correspondre à un projet existant du compte, sinon alerte dans le hub. Les noms de projet portent un préfixe propre (`kz-<slug>`). |
| **Exposition du hub** | Access en amont (adresse d'Alexandre seule) ; vérification du jeton Access par le hub [CF-JWT] ; login avec TOTP obligatoire ; aucune route publique (contrairement à l'ERP) : par le tunnel, toute requête sans jeton Access valide reçoit 404. En-têtes de la règle `web-security` (CSP stricte, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP), `noindex` et `robots.txt` en `Disallow: /`, CSRF sur les actions, cookies `Secure`, `HttpOnly`, `SameSite=Strict`. |
| **Accès au code d'une version de travail** | Code de 50 bits environ, limitation de débit de la zone, cookie signé et lié à la version du code, mode « fail closed » obligatoire, redirection des adresses `pages.dev` vers le domaine protégé, purge des anciennes versions. |
| **Lien ERP détourné** | Route joignable seulement en local, pare-feu Proxmox, IP autorisée, signature horodatée, lecture seule, champs minimaux, 404 identique. |
| **Perte de données du hub** | Sauvegarde quotidienne SQLite et archives des versions, même principe que l'ERP ; restauration testée au lot 0. |

Dépendances : minimum vital, `npm audit` avant mise en production, `package-lock.json` versionné, version de wrangler (si retenue) figée.

---

## 7. Points légaux à vérifier

Pistes à valider avec un juriste ou les ressources officielles (CNIL, service-public.fr) ; ce n'est pas un avis juridique.

- **Statut d'hébergeur (LCEN art. 6, désormais lu avec le règlement européen DSA)** : l'hébergeur y est défini par le stockage d'informations fournies par des tiers pour une mise à disposition du public [LCEN-DSA]. Une version de travail protégée par un code et non indexée n'est pas mise à disposition du public, et Kouzia y héberge son propre travail de prestataire. Le statut d'hébergeur ne devrait donc pas s'appliquer à Kouzia, l'hébergeur technique étant Cloudflare. À confirmer, en particulier si une version de travail devenait un jour publique.
- **Mentions légales** : la version de travail n'est pas un site public. Les mentions du site final (dont l'hébergeur) relèvent de la mise en ligne finale, faite hors de l'outil.
- **Données des clients** : le hub ne stocke aucune donnée personnelle du client en dehors de l'identifiant ERP. Si le contenu d'un site contient des données personnelles (photos d'équipe, noms, avis), Kouzia les traite pour le compte du client : clause de sous-traitance (RGPD art. 28) à vérifier dans le contrat ou les conditions générales, et durée de conservation des versions après la mise en ligne finale à fixer (décision n° 6).
- **Transfert hors UE** : les fichiers sont stockés par Cloudflare (société américaine). Vérifier que le registre des traitements et la politique de confidentialité de `kouzia.com` mentionnent Cloudflare comme sous-traitant.
- **Code par e-mail via Access (option)** : l'adresse du client serait alors traitée par Cloudflare ; même mention.
- **Domaine final acheté au nom du client** : hors outil, mais vérifier que le titulaire déclaré est bien le client et qu'un mandat écrit couvre l'achat.

---

## 8. Découpage en lots

Chaque lot est livré vérifié (tests, build, contrôle mobile, accessibilité, aucun tiret long), commité en local ; le push reste du ressort de la session superviseur.

| Lot | Contenu | Ce qu'Alexandre fait lui-même |
|---|---|---|
| **0. Squelette et accès sécurisé** | Dépôt sur la stack de l'ERP, login mot de passe et TOTP, vérification du jeton Access, en-têtes de sécurité, `noindex`, page « Sites » vide, scripts Alpine (`install`, `update`, `status`, `backup`, `restore`, OpenRC), `hubctl` | Créer le CT Alpine ; créer le tunnel et le nom d'hôte `hub.kouzia.com` ; créer l'application Access et sa règle (son adresse seule) ; choisir le fournisseur d'identité ; lancer `hubctl install` et saisir les secrets du `.env` |
| **1. Clients de l'ERP** | Route `/api/hub/clients` dans KouziaCRM (après validation), client signé dans le hub, choix du client | Valider le changement de l'ERP ; générer le secret partagé et le poser dans les deux `.env` ; règle du pare-feu Proxmox ; mettre à jour l'ERP |
| **2. Création de site** | Essai wrangler sur Alpine, puis choix de la voie d'envoi ; création du projet, du domaine, du CNAME, suivi du certificat, page d'attente ; noms réservés ; reprise d'une étape | Créer le jeton API (1.7) et le poser dans `.env` avec les identifiants de compte et de zone |
| **3. Envoi et versions** | Zip et dossier, contrôles de sécurité, résumé, publication, historique, republier une version, purge au-delà de 10 | Rien |
| **4. Protection par code** | `_worker.js` injecté (code, cookie, redirection `pages.dev`, `noindex`, en-têtes), « fail closed », changement de code, page de code à l'identité Kouzia | Créer la règle de limitation de débit et la règle de transformation `X-Robots-Tag` sur `kouzia.com` (pas à pas fourni) ; vérifier « fail closed » sur un premier projet |
| **5. Coupure, réactivation, suppression** | Pause et réactivation, suppression dans le bon ordre, contrôle quotidien des orphelins, compteur sur 100 | Rien |
| **6. Catalogue** | Grille de vignettes, vue liste, filtres, capture automatique, image envoyée | Rien (ou accepter l'installation de Chromium dans le CT) |
| **7. Source GitHub (option)** | Liste et téléchargement des artefacts `dist` | Créer le jeton GitHub à grain fin ; ajouter l'étape d'artefact aux dépôts de sites |
| **8. Accès nominatif par e-mail (option)** | Mode Access par site, gestion des adresses, compteur de places | Activer le code par e-mail dans Zero Trust ; ajouter le droit Access au jeton |

---

## 9. Décisions ouvertes pour Alexandre

1. **Comment le client entre-t-il dans sa version de travail ?** Un code partagé que vous lui transmettez, ou une connexion par code reçu par e-mail avec son adresse ? *Recommandation : code partagé par défaut (pas de limite de personnes, page aux couleurs de Kouzia), e-mail nominatif en option pour un client qui le demande.*
2. **Qui envoie le code au client ?** Vous, depuis la messagerie de l'ERP (le hub affiche le code à copier), ou le hub lui-même par e-mail ? *Recommandation : vous, depuis l'ERP, en V1 : l'échange reste dans l'historique du client et le hub n'a besoin ni de son adresse ni d'un accès SMTP.*
3. **Si wrangler ne marche pas sur Alpine**, on passe par l'API directe (moins officielle) ou par un CT Debian (moins aligné sur l'ERP) ? *Recommandation : l'API directe, couverte par un test de bout en bout.*
4. **Un tunnel pour le hub ou le même que l'ERP ?** *Recommandation : un tunnel à lui, pour isoler les deux outils.*
5. **« Couper » un site, c'est quoi ?** Une page « site en pause » (réversible en un clic), ou l'adresse qui ne répond plus du tout ? *Recommandation : la page de pause ; le retrait de l'adresse seulement à la suppression.*
6. **Combien de temps garder une version de travail après la mise en ligne finale ?** Le plafond est de 100 sites. *Recommandation : mise en pause automatique proposée à la mise en ligne finale, puis suppression proposée 3 mois après ; 10 versions gardées par site.*
7. **Sous-domaine** : tiré du nom du client, du nom du projet, ou saisi librement ? *Recommandation : proposé à partir du nom du client, modifiable, avec une liste de noms interdits (`www`, `erp`, `api`, `hub`, `mail`...).*
8. **Votre adresse IP de sortie est-elle fixe ?** Si oui, le jeton Cloudflare peut être limité à elle. *Recommandation : le faire si l'IP est fixe ; sinon, s'en tenir aux droits minimaux et à l'expiration annuelle.*
9. **Vignettes** : capture automatique (Chromium dans le CT, environ 300 Mo) ou image envoyée à la main ? *Recommandation : capture automatique avec repli sur l'image envoyée.*
10. **Outil de mise à jour** : un `hubctl` copié de `kouziactl`, ou un seul outil commun aux deux CT ? *Recommandation : `hubctl` copié pour démarrer, mutualisation plus tard si la duplication gêne.*
11. **Connexion Access à `hub.kouzia.com`** : code par e-mail ou compte Google ? *Recommandation : code par e-mail (rien à configurer), Google si vous préférez ne pas attendre un e-mail.*
12. **Source GitHub** : utile dès le départ, ou le zip suffit-il ? *Recommandation : zip d'abord, GitHub en lot optionnel.*
13. **Afficher l'adresse de la version de travail dans l'ERP** (fiche client) ? *Recommandation : plus tard, par le champ « liens » du projet qui existe déjà, sans migration.*

---

## Sources (consultées le 17/10/2026)

Cloudflare (documentation officielle) :

- [CF-LIMITS] Pages, Limits : https://developers.cloudflare.com/pages/platform/limits/
- [CF-DU] Pages, Direct Upload : https://developers.cloudflare.com/pages/get-started/direct-upload/
- [CF-CI] Pages, Use Direct Upload with continuous integration : https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- [CF-WR-INSTALL] Wrangler, Install and update (plateformes prises en charge) : https://developers.cloudflare.com/workers/wrangler/install-and-update/
- [CF-API-PROJ] API, Create project : https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/
- [CF-API-PROJ-EDIT] API, Edit project (`deployment_configs`, `env_vars`) : https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/
- [CF-API-DEPLOY] API, Create deployment : https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/
- [CF-API-ROLLBACK] API, Rollback deployment : https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/
- [CF-API-DOM] API, Add a Pages custom domain : https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/
- [CF-API-DOM-DEL] API, Delete a Pages custom domain : https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/delete/
- [CF-API-DNS] API, Create DNS record : https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/
- [CF-API-REST] Pages, REST API (suppression des anciens déploiements) : https://developers.cloudflare.com/pages/configuration/api/
- [CF-DOMAINS] Pages, Custom domains : https://developers.cloudflare.com/pages/configuration/custom-domains/
- [CF-KNOWN] Pages, Known issues : https://developers.cloudflare.com/pages/platform/known-issues/
- [CF-PREVIEW] Pages, Preview deployments : https://developers.cloudflare.com/pages/configuration/preview-deployments/
- [CF-ROLLBACKS] Pages, Rollbacks : https://developers.cloudflare.com/pages/configuration/rollbacks/
- [CF-HEADERS] Pages, Headers : https://developers.cloudflare.com/pages/configuration/headers/
- [CF-FN-PRICING] Pages Functions, Pricing : https://developers.cloudflare.com/pages/functions/pricing/
- [CF-FN-ROUTING] Pages Functions, Routing (Fail open / closed) : https://developers.cloudflare.com/pages/functions/routing/
- [CF-OTP] Zero Trust, One-time PIN : https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/
- [CF-SEATS] Zero Trust, Seat management : https://developers.cloudflare.com/cloudflare-one/identity/users/seat-management/
- [CF-ZT-LIMITS] Zero Trust, Account limits : https://developers.cloudflare.com/cloudflare-one/account-limits/
- [CF-ACCESS-POL] Access, Policies : https://developers.cloudflare.com/cloudflare-one/policies/access/
- [CF-API-ACCESS] API, Create Access application : https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/
- [CF-JWT] Access, Validate JWTs : https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- [CF-PERMS] API token permissions : https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- [CF-TRANSFORM] Response header transform rules : https://developers.cloudflare.com/rules/transform/response-header-modification/
- [CF-TRANSFORM-AVAIL] Transform Rules (disponibilité par offre) : https://developers.cloudflare.com/rules/transform/
- [CF-RATE] WAF, Rate limiting rules : https://developers.cloudflare.com/waf/rate-limiting-rules/
- [CF-BR] Browser Rendering, Limits : https://developers.cloudflare.com/browser-rendering/platform/limits/
- [CF-BLOG-PLANS] Blog Cloudflare, Zero Trust for everyone (offre gratuite jusqu'à 50 utilisateurs) : https://blog.cloudflare.com/teams-plans/
- [CF-COMMUNITY-PRICING] Communauté Cloudflare, What happens when you go over the free plan : https://community.cloudflare.com/t/what-happens-when-you-go-over-the-free-plan/806187

Autres :

- [DEV-PY] Deploying to Cloudflare Pages from pure Python, no Node, no wrangler (dev.to) : https://dev.to/orix/deploying-to-cloudflare-pages-from-pure-python-no-node-no-wrangler-2ea1
- [PULUMI-DOM] Pulumi, cloudflare.PagesDomain (DNS non créé par l'API) : https://www.pulumi.com/registry/packages/cloudflare/api-docs/pagesdomain/
- [SCOUT-DANGLING] ScoutDNS, Dangling DNS records and subdomain takeover : https://www.scoutdns.com/library/dangling-dns-records-how-subdomain-takeover-becomes-possible
- [GH-ARTIFACTS] GitHub REST API, Artifacts : https://docs.github.com/en/rest/actions/artifacts
- [VERCEL-PWD] Vercel, Password Protection : https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/password-protection
- [VERCEL-ROLLBACK] Vercel, Instant Rollback : https://vercel.com/docs/instant-rollback
- [NETLIFY-DEPLOY] Netlify, Create deploys : https://docs.netlify.com/deploy/create-deploys/
- [NNG-CARDS] Nielsen Norman Group, Cards: UI-Component Definition : https://www.nngroup.com/articles/cards-component/
- [NNG-DND] Nielsen Norman Group, Drag and Drop: How to Design for Ease of Use : https://www.nngroup.com/articles/drag-drop/
- [NNG-CAROUSEL] Nielsen Norman Group, Carousel Usability: Designing an Effective UI for Websites with Content Overload : https://www.nngroup.com/articles/designing-effective-carousels/
- [WAI-CAROUSEL] W3C WAI-ARIA Authoring Practices, Carousel Pattern : https://www.w3.org/WAI/ARIA/apg/patterns/carousel/
- [NNG-BREADCRUMBS] Nielsen Norman Group, Breadcrumbs: 11 Design Guidelines for Desktop and Mobile : https://www.nngroup.com/articles/breadcrumbs/
- [NNG-CONFIRM] Nielsen Norman Group, Confirmation Dialogs Can Prevent User Errors : https://www.nngroup.com/articles/confirmation-dialog/
- [GOVUK-UPLOAD] GOV.UK Design System, File upload : https://design-system.service.gov.uk/components/file-upload/
- [LCEN-DSA] Définitions de l'hébergeur (LCEN art. 6-I-2 et DSA art. 6), synthèse : https://www.labase-lextenso.fr/ouvrages/droit-du-numerique-9782275153209/section-1-l-exemption-conditionnelle-de-responsabilite-des-fournisseurs-de-services-d-hebergement-9782275153209-145
