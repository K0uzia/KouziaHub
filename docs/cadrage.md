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

Option « Indexation » par site (cinquième série, 22/10/2026), désactivée par défaut : activée, le Worker ne pose plus `X-Robots-Tag` sur le sous-domaine et sert le `robots.txt` du site s'il existe, sinon `Allow: /` avec la ligne `Sitemap:` quand le site contient `sitemap-index.xml` ou `sitemap.xml`. Les réponses `pages.dev` (301) gardent `noindex`. La couche 2 (règle de transformation sur la zone) l'emporterait : ne pas la créer, ou en exclure les sous-domaines indexables.

### 1.6 Accès à `hub.kouzia.com` : comme l'ERP, sans Cloudflare Access

**Décision d'Alexandre du 19/10/2026** (relayée par le superviseur) : ni Cloudflare Access ni Zero Trust devant le hub. Le hub fonctionne comme l'ERP : tunnel Cloudflare à jeton (même procédure que `kouziactl cloudflare`), protection par le login du hub seul, mot de passe et code TOTP obligatoires.

- Par le tunnel (requête de cloudflared en boucle locale avec `CF-Connecting-IP`), seul `hub.kouzia.com` (`HUB_PUBLIC_ORIGIN`) est servi ; tout autre nom d'hôte reçoit la 404 d'une route inconnue (`lib/tunnel-host.ts`, repris de l'ERP).
- Double authentification exigée par le tunnel et en production, quelle que soit la provenance ; cookies `Secure`, `HttpOnly`, `SameSite=Strict` ; CSRF par contrôle d'origine ; en-têtes de la règle `web-security`.
- Durcissement en l'absence de filtre amont : 5 essais par quart d'heure et par IP sur la connexion et le code ; verrouillage du compte après 5 échecs, progressif (15 min, 1 h, 4 h, puis 24 h selon les verrouillages des dernières 24 h) ; journal des connexions (IP, provenance, appareil, succès ou échec, jamais le mot de passe ni le code) ; notification Web Push à chaque connexion réussie depuis un nouvel appareil (appareils reconnus par un cookie aléatoire dont seule l'empreinte est gardée).
- Access reste possible en option : si `CF_ACCESS_TEAM_DOMAIN` et `CF_ACCESS_AUD` sont posés, le hub vérifie en plus l'en-tête `Cf-Access-Jwt-Assertion` (signature, `iss`, `aud`) [CF-JWT].

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
hub.kouzia.com (login du hub : mot de passe et code TOTP, sans Access depuis le 19/10/2026)
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

Le hub contient déjà le client de lecture (`apps/api/src/lib/erp/http.ts`), testé contre un faux serveur. Il n'est actif que si `ERP_BASE_URL` est posée ; sinon une liste de clients d'exemple est proposée. Si `ERP_BASE_URL` est posée sans `HUB_READ_SECRET`, le hub refuse de démarrer.

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
- **Filtres du catalogue (retour d'Alexandre, 18/10/2026)** : un filtre par dimension du contenu plutôt qu'une seule rangée de puces mêlant les dimensions [NNG-FACETS] : un contrôle segmenté Type (Tous, Clients, Perso), une liste État qui affiche le nombre de sites par état, et la recherche. Les sites en erreur ne sont pas cachés derrière un filtre : un bandeau en tête les signale (« 1 site en erreur ») avec un lien qui filtre. Filtres gardés dans l'URL.
- **Explorateur de fichiers** : fil d'Ariane des dossiers qui montre la hiérarchie et non l'historique, dernier élément non cliquable et distinct, pas de retour à la ligne sur mobile (au besoin seul le dossier parent) [NNG-BREADCRUMBS] ; liste plutôt que cartes pour parcourir et comparer des fichiers [NNG-CARDS] ; envoi par bouton toujours présent et glisser-déposer en plus [GOVUK-UPLOAD] [NNG-DND] ; suppression confirmée en nommant le nombre d'éléments [NNG-CONFIRM].
- **Identité et primitives** : celles de l'ERP (thème sombre, nuit et ambre, Exo 2 pour les titres, tokens de `index.css`, `PageHeader`, `StatStrip`, `DataTable`, `FilterChips`, `Tabs`, `Card`, `Modal`, `ConfirmDialog`, `sonner`), copiées dans le hub puis maintenues à l'identique.

### 5.2 Catalogue (accueil)

- `PageHeader` « Sites » avec le bouton principal « Nouveau site ».
- `StatStrip` : actifs, en pause, projets utilisés sur 100.
- Filtres : Type segmenté (Tous, Clients, Perso), liste État avec les nombres, recherche par nom, client ou sous-domaine (voir 5.1) ; bandeau des sites en erreur.
- Grille de cartes en `auto-fit` : une colonne sur un Samsung en portrait (360 à 412 px), deux dès qu'il y a la place, plus sur grand écran. Chaque carte : vignette 16:10 (`aspect-ratio`, chargement différé), libellé, client, état en texte et icône (jamais la couleur seule), date de la dernière version. La carte entière est un lien vers la fiche ; aucune action destructrice sur la carte.
- Bascule « Liste » : `DataTable` avec les colonnes essentielles (site, client, état, dernière version).
- État vide : « Aucun site pour l'instant » avec le bouton de création. État d'erreur ERP : bandeau, catalogue toujours affiché.
- Le style « catalogue de streaming » se traduit par de grandes vignettes ; tri par défaut : dernière modification d'abord.

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
- **Contrôle de la version (19/10/2026, après l'envoi réel des sources Astro de KouziaWebsite sans `dist/`)** : le hub reconnaît un projet non construit (fichier de configuration à la racine : Astro, Vite, Next.js, Nuxt, SvelteKit, Gatsby, Eleventy, Hugo, Jekyll ; ou `package.json` avec un script `build`), sans sortie construite (`index.html` à la racine, ou `dist/`, `build/`, `out/`, `_site/`, `public/` pour Hugo et Gatsby, `.output/public/` pour Nuxt). Il annonce le framework, la commande à lancer sur le PC (script de `package.json` et gestionnaire de paquets d'après le verrou) et le dossier à envoyer. Même avertissement pour un site construit envoyé avec ses sources (`dist/index.html` sans `index.html` à la racine) et pour un site statique sans `index.html` à la racine. La publication est alors refusée par le serveur (409 `version_check`), sauf confirmation explicite « Publier quand même », notée au journal (`version.force`). **Le hub ne construit jamais rien** : aucune commande `npm` n'est lancée sur le serveur (code tiers). Pour plus tard, l'option « source GitHub, artefact `dist` » du lot 7 (ci-dessus) évitera ce pas à la main : la construction se fait dans GitHub Actions, le hub ne récupère que l'artefact construit.

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
| **Exposition du hub** | Sans Cloudflare Access (décision du 19/10/2026, voir 1.6) : par le tunnel, seul `hub.kouzia.com` est servi, tout autre hôte reçoit 404 ; login avec TOTP obligatoire ; limite de 5 essais par quart d'heure et par IP ; verrouillage progressif du compte ; journal des connexions ; notification à chaque connexion depuis un nouvel appareil. Access reste possible en option, avec vérification de son jeton [CF-JWT]. En-têtes de la règle `web-security` (CSP stricte, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP), `noindex` et `robots.txt` en `Disallow: /`, CSRF sur les actions, cookies `Secure`, `HttpOnly`, `SameSite=Strict`. |
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
11. **Connexion Access à `hub.kouzia.com`** : *sans objet depuis le 19/10/2026* (Access retiré, voir 1.6).
12. **Source GitHub** : utile dès le départ, ou le zip suffit-il ? *Recommandation : zip d'abord, GitHub en lot optionnel.*
13. **Afficher l'adresse de la version de travail dans l'ERP** (fiche client) ? *Recommandation : plus tard, par le champ « liens » du projet qui existe déjà, sans migration.*

---

## 10. Surveillance des sites (offre maintenance, cadrage du 18/10/2026, en attente d'accord)

Décisions d'Alexandre du 18/10/2026 (troisième série, transmises par le superviseur) : contrôles depuis deux points (le hub et un Worker Cloudflare planifié), alertes uniquement par notification Web Push sur le téléphone, rapport mensuel en PDF envoyé par Alexandre depuis l'ERP, détection des domaines Cloudflare par un jeton séparé en lecture seule, domaines Hostinger ajoutés à la main, interrupteur « Surveillé » par site. Aucun code n'est écrit avant l'accord du superviseur sur cette section.

### 10.1 Architecture

```
            hub (CT Proxmox)                              Worker « kouzia-veille » (Cloudflare, gratuit)
  contrôles HTTP toutes les 5 min ──── rapport signé ───►  POST /report  (résultats + battement de cœur)
  contrôles quotidiens et hebdo   ◄─── état signé ──────   GET  /state   (observations du Worker)
  historique 13 mois (SQLite)     ──── config signée ───►  POST /sync    (cibles, abonnements push)
  notifications non urgentes                              tâche planifiée chaque minute : 1/5 des cibles
                                                          D1 : dernier état, incidents ouverts, abonnements
                                                          notifications urgentes (panne, retour, hub muet)
```

- **Le hub n'ouvre aucune porte entrante** : il appelle le Worker en sortie (comme il appelle déjà l'API Cloudflare). Le hub n'offre aucune route au Worker ; c'est donc l'absence de battement de cœur qui signale « hub ou box hors ligne ».
- **Points d'entrée du Worker** : `POST /sync`, `POST /report`, `GET /state`, sur son adresse `*.workers.dev`. Chaque requête porte une signature HMAC-SHA256 horodatée (même schéma que le lien ERP, section 3.4), secret partagé `MONITOR_SHARED_SECRET` ; tout le reste répond 404.
- **Qui décide d'une panne** : la règle de comparaison est un module pur, partagé par les deux côtés. Elle est appliquée par le **Worker** pour les alertes urgentes, parce qu'il est le seul point toujours joignable quand la box tombe. Le hub applique la même règle pour l'affichage et l'historique. Écart assumé à « le hub compare » : sinon, une box coupée empêcherait toute alerte. Un seul émetteur par type d'alerte, pour éviter les doublons.

| Hub | Worker | Décision |
|---|---|---|
| 2 échecs consécutifs | 2 échecs consécutifs | **Panne** : notification, incident ouvert |
| échec | succès | Problème local (box, DNS du FAI) : visible dans le hub, pas de notification |
| succès | échec | Vu par Cloudflare seulement : visible dans le hub, pas de notification |
| muet depuis 15 min | (seul) | Notification « hub ou box hors ligne » ; le Worker décide seul sur 2 échecs, en le précisant |
| (seul) | muet depuis 15 min | Notification non urgente du hub « surveillance Cloudflare interrompue » ; le hub décide seul |

- **Anti-rafale** : une notification à l'ouverture d'un incident, une au retour (avec la durée), un rappel à 24 h si l'incident dure. Plus de 3 cibles en panne dans le même cycle : une seule notification groupée. Les alertes d'échéance (certificat, domaine) ne partent qu'aux seuils de 30, 14 et 7 jours, une fois chacun.

### 10.2 Stockage partagé : D1 plutôt que KV

| Critère (offre gratuite) | KV | D1 |
|---|---|---|
| Écritures | 1 000 par jour [CF-KV-LIMITS] | 100 000 lignes par jour [CF-D1-PRICING] |
| Lectures | 100 000 par jour | 5 millions de lignes par jour |
| Requêtes par invocation | | 50 [CF-D1-LIMITS] |
| Modèle | clé-valeur, cohérence à terme | SQL, transactions, index |

Une cible contrôlée toutes les 5 minutes, c'est 288 cycles par jour : avec KV, 4 cibles suffiraient à épuiser les 1 000 écritures. **D1 est retenu.** Il ne reçoit que les changements d'état et une ligne par cycle (environ 1 700 écritures par jour pour 100 cibles), donc loin des plafonds. L'historique long (13 mois) reste dans le SQLite du hub, jamais dans D1.

### 10.3 Limites du Worker gratuit et découpage

D'après [CF-WK-LIMITS] : 100 000 requêtes par jour, 10 ms de CPU par invocation (l'attente réseau ne compte pas), 50 sous-requêtes par invocation, 6 connexions sortantes simultanées, 5 tâches planifiées par compte.

- **Tâche planifiée chaque minute** (`* * * * *`, réglée par `PUT .../workers/scripts/{nom}/schedules` [CF-WK-SCHEDULES]) : à chaque passage, elle contrôle le cinquième des cibles qui correspond à la minute. Chaque cible est ainsi vue toutes les 5 minutes, avec 40 sous-requêtes au plus par passage, soit jusqu'à 200 cibles.
- **Notifications** : chiffrement Web Push (ECDH P-256, HKDF, AES-GCM) et signature VAPID (ECDSA P-256) faits par WebCrypto, disponible dans les Workers [CF-WEBCRYPTO]. C'est la même bibliothèque que l'ERP (`@block65/webcrypto-web-push`, faite pour WebCrypto), regroupée dans le script.
- **À valider en réel** :
  - le coût CPU d'un envoi Web Push au regard des 10 ms ;
  - une requête du Worker vers un site servi par une zone du même compte ;
  - le délai réel des tâches planifiées (pas de garantie d'horaire dans la doc).

### 10.4 Contrôles (proposition à valider)

| Contrôle | Fréquence | Par | Méthode | Alerte |
|---|---|---|---|---|
| Disponibilité HTTP | 5 min | hub et Worker | GET sur l'URL, redirections suivies (5 au plus), délai 10 s ; statut 2xx ou 3xx final, temps de réponse, mot-clé facultatif dans le HTML | panne sur 2 échecs consécutifs des deux points (10.1) |
| Certificat | 1 par jour | hub | poignée de main TLS (`node:tls`) : échéance, émetteur, nom couvert | 30, 14 et 7 jours ; certificat invalide : immédiat |
| Échéance du domaine | 1 par jour | hub | RDAP public sans jeton, serveur trouvé par l'amorce IANA [IANA-RDAP] (ex. `.fr` : rdap.nic.fr ; `.com` : rdap.verisign.com) ; événement `expiration` | 30, 14 et 7 jours ; échéance absente : « inconnue », sans alerte |
| DNS | 1 par jour | hub | A, AAAA, CNAME, NS, MX comparés à une référence validée par Alexandre (« accepter comme référence ») | écart : notification non urgente |
| Contenu de l'accueil | 1 par jour | hub | empreinte du HTML normalisé (sans nonces, jetons ni dates) ; recalée à chaque publication par le hub | changement inattendu : notification non urgente |
| Vitesse | 1 par semaine | hub | Chromium du CT en profil mobile : TTFB, LCP, CLS, poids et nombre de requêtes de l'accueil ; aucun service tiers | aucune (affichée et reprise dans le rapport) |

- Historique : contrôles bruts gardés 7 jours, agrégats par heure (disponibilité, temps moyen et p95) et contrôles quotidiens et hebdomadaires gardés 13 mois.
- Sans Chromium sur le CT, la vitesse est indisponible et le rapport le dit.

### 10.5 Cibles surveillées

- **Site du hub** : sa version de travail `<slug>.kouzia.com` et, une fois connu, son domaine final (profil serveur, section 5). Interrupteur « Surveillé » par cible.
- **Domaines Cloudflare** : jeton **séparé**, en lecture seule (Zone > Zone > Read, sur toutes les zones, rien d'autre), posé par `hubctl secrets veille`. Il sert uniquement à lister les zones pour proposer des cibles ; rien n'est ajouté sans accord.
- **Domaines Hostinger** : ajoutés à la main (URL, libellé, client ERP facultatif). Pas de jeton Hostinger.
- **Contrat de maintenance (plus tard)** : l'annuaire ERP du hub prévoit un champ facultatif `maintenance` (contrat actif, dates), ignoré tant que la route ERP ne le fournit pas. Ce champ ajouté à la route ERP sera soumis à Alexandre ; rien n'est écrit dans KouziaCRM.

### 10.6 Notifications Web Push

Implémentation reprise de l'ERP (lecture seule : `lib/push/*`, `routes/push.ts`, `web/src/lib/push.ts`, `scripts/push-keys.ts`, migration `20261017090000_web_push`) :

- clés VAPID générées par `hubctl push-keys` ; la clé privée va dans le `.env` du hub et en secret du Worker ;
- abonnement par appareil dans Réglages ; un petit service worker limité aux notifications, sans mode hors ligne ;
- les abonnements sont recopiés vers D1 par `/sync`, pour que le Worker puisse envoyer seul ;
- notification de test depuis Réglages ;
- un abonnement expiré (410) est retiré.

Android et Chrome reçoivent les notifications sans installer l'application ; sur iPhone, il faudrait l'ajouter à l'écran d'accueil.

### 10.7 Rapport mensuel (PDF)

Le rapport est lu par le client (commerçant, association), pas par un technicien : une page A4 (deux au plus), en langage clair, sans aucun terme technique. Code : `apps/api/src/lib/monitor/report-text.ts` (règles et phrases) et `report.tsx` (données et mise en page).

**Références de langage clair** (consultées le 18/10/2026) : GOV.UK, « Use clear language » [GOVUK-CLEAR] (mots courants plutôt que mots longs ou soutenus, phrases de 25 mots au plus) ; Nielsen Norman Group, Hoa Loranger, « Plain Language Is for Everyone, Even Experts » [NNG-PLAIN] (connaître son lecteur, mots familiers, phrases de 15 à 20 mots, l'essentiel en premier). Seuils de vitesse : web.dev [WEBDEV-LCP] [WEBDEV-CLS]. Frise des jours : barres de disponibilité d'Atlassian Statuspage [ATL-UPTIME] (une barre par jour, couleur selon la durée de panne), reprises avec une forme en plus de la couleur. Typographie : Matthew Butterick, « Butterick's Practical Typography » [BUTTERICK] (corps de texte lisible, hiérarchie par la taille et la graisse plutôt que par les majuscules, espaces insécables).

- **Ouverture** : une phrase-verdict (« Votre site a bien fonctionné ce mois-ci : il était accessible 99,9 % du temps. ») et un état écrit en toutes lettres avec son icône (forme vectorielle), jamais la couleur seule.
- **Règle de l'état**, du plus grave au plus doux :
  - « À surveiller » : coupure encore en cours à la fin du rapport, ou disponibilité sous 99 %, ou aucune mesure dans le mois, ou cadenas en défaut, ou cadenas qui expire dans 14 jours ou moins, ou nom de domaine qui expire dans 30 jours ou moins, ou site « Lent » ;
  - « Problème réglé » : au moins une coupure dans le mois, toutes terminées ;
  - « Tout va bien » : sinon.
- **Disponibilité** : temps hors panne (au sens de 10.1) sur le temps observé du mois, au fuseau de Paris ; jamais arrondie vers le haut (99,996 % s'écrit 99,99 %).
- **Coupures en phrases** : « Le 12 octobre, le site a été inaccessible 14 minutes, entre 3 h 02 et 3 h 16. Il est revenu tout seul. » Heures de Paris. « Revenu tout seul » seulement si la cible est un site du hub et qu'aucune action n'a été journalisée sur ce site pendant la coupure ; « Il a été rétabli » s'il y en a eu une ; « Il est de nouveau accessible » quand le hub ne peut pas le savoir (domaine ajouté à la main). Ces phrases restent dans la vue détaillée du hub. Dans le PDF : une phrase de synthèse (« 3 coupures ce mois-ci, 1 h 21 au total ; toutes réglées. »), puis un tableau Date, Heures (« de 3 h 02 à 3 h 16 »), Durée. Au-delà de 8 lignes, les coupures les plus courtes sont résumées sous le tableau (nombre, durée la plus longue, durée totale). Une coupure en cours est en tête de sélection et marquée « en cours » dans la colonne Durée.
- **Vitesse** (dernière mesure du mois, profil téléphone), seuils officiels de web.dev : « Rapide » si l'affichage du contenu principal prend 2,5 s ou moins et que la page bouge peu (décalage 0,1 ou moins) ; « Lent » au-delà de 4 s ou de 0,25 ; « Correct » entre les deux. Un seul chiffre affiché : le temps d'ouverture de la page en secondes. Comparaison à la dernière mesure du mois précédent : « comme le mois dernier » si l'écart est sous 0,3 s, sinon « plus rapide » ou « plus lent qu'en septembre » ; « première mesure » sans mesure précédente. Stabilité de l'affichage : bonne, moyenne ou à améliorer, selon les mêmes seuils.
- **Mots du rapport** : « certificat de sécurité (le cadenas) valable jusqu'au … », « nom de domaine réservé jusqu'au … », « réglages techniques de l'adresse inchangés », « temps d'ouverture de la page », « stabilité de l'affichage ». Aucun sigle ni code d'erreur : un test cherche chaque terme interdit dans le texte du PDF.
- **Frise du mois** : une barre par jour (heures de Paris), calculée depuis les agrégats horaires et les coupures. Jour accessible : barre pleine verte ; jour avec coupure : barre pleine encre nuit surmontée d'un triangle ; jour sans mesure (avant le début de la surveillance, jour à venir) : barre basse en contour gris. La forme distingue les trois cas sans la couleur ; une légende écrite les nomme (« Pas de mesure » seulement s'il y a de tels jours).
- **« Ce que Kouzia a fait pour vous ce mois-ci »** : un seul grand chiffre, le rythme des vérifications d'ouverture (« toutes les 5 min », tiré de l'intervalle réel), avec le libellé « vérification que le site s'ouvre, jour et nuit, depuis N endroits (T au total) ». N compte les points de contrôle qui ont vraiment vérifié ce site ce mois-ci (hub, veille Cloudflare) ; le total ne compte que les contrôles de ce site, donc depuis son ajout s'il arrive en cours de mois. Le total seul (31 jours × 288 × 2 = 17 856) impressionnait sans rien dire. Puis, en ligne, les autres comptes tirés des données (nombre en gras, libellé court) : contrôles du cadenas et du nom de domaine, mesures de vitesse, coupures suivies, alertes reçues. Une valeur à zéro est masquée, la tuile entière s'il n'y a rien.
- **En-tête et pied de page** : bande ambre, monogramme, nom du client (lu dans l'ERP à la génération, jamais stocké ; site perso : son libellé ; domaine ajouté à la main : son libellé, sinon le nom d'hôte), adresse du site et période exacte (« du 1ᵉʳ au 31 octobre 2026 »). Pied : « Rapport préparé par » suivi du nom affiché des réglages (Kouzia par défaut), coordonnées des réglages (Réglages > Rapports : nom, e-mail, téléphone français affiché par paires, site en https://), date de génération et « Page 1 sur 1 ». Un champ vide n'imprime rien ; aucune coordonnée n'est écrite dans le code.
- **Détails techniques : supprimés du PDF client.** Alexandre a tout le détail dans le hub (écran Surveillance, fiche de la cible). Une annexe technique rallongerait le rapport sans servir le client, et deux versions à tenir à jour seraient deux sources de vérité.
- **Mise en page** : grille de tuiles (verdict en grande tuile, puis disponibilité, vitesse, sécurité, nom de domaine, coupures, ce que Kouzia a fait), charte Kouzia de l'ERP (encre nuit #0b1020, bande ambre #fe9a00, monogramme), polices embarquées depuis le dépôt (`apps/api/assets/fonts`, licence OFL, sources et versions dans son README) : Exo 2 (600, 700) pour les titres, Source Sans 3 (400, 600) pour le texte, les dates et les nombres (chiffres tabulaires, espace fine insécable et « ᵉʳ » présents ; Exo 2 ne les a pas). TTF statiques : le woff2 variable de l'interface fait planter le moteur de PDF. Typographie française par une fonction testée : espace fine insécable avant % : ; ? !, entre les milliers, insécable entre un nombre et son unité ou son mois, « 1er » en exposant. Couleurs d'état de la charte : vert #15803d (Tout va bien), ambre #fe9a00 bordé d'encre (À surveiller), encre nuit #0b1020 (Problème réglé), chacune avec son pictogramme vectoriel et son mot. Fond clair pour l'impression ; contrastes calculés par un test, en couleur et en niveaux de gris : texte 4,5:1 au moins sur chaque fond, pictogramme et contour 3:1, marques d'état 2:1 au moins entre elles. Une page pour un mois calme ; marges resserrées quand il y a des coupures, deux pages au plus.
- Fabriqué par `@react-pdf/renderer`, comme les PDF de l'ERP. Généré le 1er du mois et à la demande ; téléchargé depuis le hub, Alexandre l'envoie lui-même depuis l'ERP. Le hub n'envoie rien et ne publie aucune page.

### 10.8 Modèle de données (migration à valider, rien n'est écrit)

Nouvelle migration additive, sans toucher aux tables existantes :

- `PushSubscription` : comme dans l'ERP (endpoint unique, p256dh, auth, libellé, derniers succès et échec), liée à `User`.
- `MonitorTarget` : siteId facultatif, libellé, url, hostname, source (site, cloudflare, manuel), erpClientId facultatif, enabled, mot-clé facultatif, référence DNS (JSON), empreinte de contenu et date, createdAt.
- `MonitorCheck` : targetId, kind (http, tls, domain, dns, content, speed), observer (hub, edge), at, ok, statut, durée en ms, detail (JSON sans secret). HTTP brut gardé 7 jours, le reste 13 mois.
- `MonitorHourly` : targetId, heure, contrôles, échecs, temps moyen et p95, par observateur (13 mois).
- `MonitorIncident` : targetId, startedAt, endedAt, cause, observateurs, notifiedAt, recoveredNotifiedAt, reminderAt.
- `MonitorAlert` : targetId, kind (seuil d'échéance, écart DNS, contenu), clé de déduplication, sentAt.
- `MonitorReport` : targetId, mois, chemin du PDF, createdAt.
- `HubSetting` (migration additive séparée, validée par Alexandre le 18/10/2026) : clé, valeur, updatedAt ; coordonnées du pied de page des rapports (`report.displayName`, `report.email`, `report.phone`, `report.website`).

Côté Worker, un schéma D1 de 4 tables, versionné dans le dépôt et appliqué au déploiement : `targets`, `state`, `incidents`, `subscriptions`.

### 10.9 Sécurité

- **Jeton de déploiement du Worker** : Account > Workers Scripts > Edit et Account > D1 > Edit [CF-PERMS]. Il est saisi au moment de `hubctl veille deploy` et n'est **jamais enregistré**.
- **Le jeton API du hub reste inchangé** (Pages et DNS). Le jeton de lecture des zones est le troisième, séparé.
- **Secrets du Worker**, posés par l'API au déploiement : clé privée VAPID et `MONITOR_SHARED_SECRET`. Ils ne sont jamais renvoyés au navigateur ni journalisés.
- **Requêtes signées** : signature horodatée (5 min) sur la méthode, le chemin, la chaîne de requête et le corps, comparaison en temps constant, 404 identique pour tout refus. Anti-rejeu : horodatage strictement supérieur au dernier accepté pour la route (table `meta` de D1). Seuls `/sync`, `/report` et `/state` existent, avec une limite de taille de corps. `/state` renvoie aussi l'état courant de chaque cible (`current`, avec le nombre d'échecs consécutifs).
- **Abonnements push** : services connus seulement (Google, Mozilla, Apple, Microsoft), en https, à l'abonnement dans le hub comme dans `/sync`.
- **Données envoyées à D1** : URL des cibles, états et abonnements push (adresse de service du navigateur et clés publiques). Aucune donnée de client de l'ERP.
- **Contrôles sortants du hub** : délais courts, taille de réponse plafonnée (2 Mio), aucune exécution de script. Chaque connexion (HTTP à chaque saut de redirection, TLS) se fait sur l'adresse résolue une seule fois et vérifiée : loopback, RFC 1918, lien local, CGNAT, ULA, multicast, IPv4 mappée vers une plage privée sont refusés ; les noms en .local, .lan, .internal, .home.arpa, .localhost sont refusés à l'ajout.
- **Mesure de vitesse par Chromium** : bac à sable obligatoire, jamais de repli sans ; en production sous l'utilisateur dédié `HUB_CHROMIUM_USER` (lanceur de `HUB_CHROMIUM_PATH`), sinon désactivée avec la raison. Requêtes de la page interceptées et abandonnées si l'hôte se résout vers une adresse privée ; Chromium refaisant sa propre résolution, un pare-feu du CT (sorties RFC 1918 interdites à cet utilisateur) complète.
- **Mentions légales** : la surveillance ne porte que sur des pages publiques. Les rapports ne contiennent aucune donnée personnelle ; ajouter la mention « surveillance technique par Cloudflare (sous-traitant) » au contrat de maintenance (section 7).

### 10.10 Ce qu'Alexandre fera lui-même

1. `hubctl push-keys`, puis, dans le hub, Réglages > Notifications > « Activer sur ce téléphone » et la notification de test.
2. Créer le jeton de déploiement (Workers Scripts Edit et D1 Edit), lancer `hubctl veille deploy` et le coller (il n'est pas gardé).
3. Facultatif : créer le jeton de lecture des zones (Zone Read, toutes les zones) et le poser avec `hubctl secrets veille`.
4. Ajouter à la main les domaines Hostinger à surveiller.
5. Chaque mois : télécharger le rapport PDF et l'envoyer au client depuis l'ERP.

### 10.11 Points à valider par le superviseur

1. Les contrôles et fréquences du tableau 10.4.
2. La décision des pannes urgentes par le Worker, le hub n'ayant que la vue (10.1).
3. D1 plutôt que KV (10.2).
4. La migration 10.8.
5. `@react-pdf/renderer` pour le rapport (10.7).
6. Le jeton de déploiement non enregistré, avec les nouvelles commandes `hubctl veille deploy`, `hubctl secrets veille` et `hubctl push-keys`.

---

## 11. Sites dynamiques en PHP (cadrage du 24/10/2026, validé le 24/10/2026)

Demande d'Alexandre : le hub héberge aussi les versions de travail des sites PHP, MyTakumi d'abord (PHP 8.2 ou plus, MySQL en production, SQLite en développement, une tâche planifiée toutes les 15 minutes). Tout reste sur le seul Proxmox d'Alexandre, aucune autre machine. Validé le 24/10/2026, avec les décisions de 11.10.

### 11.1 Principe

```
Navigateur ──► Cloudflare ──► tunnel « sites PHP » ──► CT « kouziaphp » (Alpine)
                                                         nginx ─► PHP-FPM (un pool par site)
                                                         MariaDB (une base par site)
                                                         agent kouziaphp (port local, appelé par le hub seul)
CT « kouziahub » (hub) ── réseau du Proxmox, port de l'agent ──┘
```

- Un CT dédié, **kouziaphp**, distinct du hub et de l'ERP. Le CT du hub garde seul le jeton Cloudflare, les clés de licence et la base du hub : le code des clients ne tourne jamais à côté.
- Le hub pilote ce CT par un **agent** : petit service sur le CT PHP, qui n'accepte qu'une liste fermée d'opérations (créer un site, déposer une version, basculer, couper, lire les journaux...), signées par un secret partagé, sur le réseau du Proxmox, port ouvert au seul CT du hub par le pare-feu Proxmox. Même modèle que le lien hub vers ERP (section 3). Pas de SSH, pas de commande libre.
- L'agent ne reçoit jamais le jeton Cloudflare. Le DNS des sites reste créé par le hub, comme aujourd'hui.

### 11.2 Isolation

- **CT non privilégié**, sans imbrication, avec des limites globales posées dans Proxmox (cœurs, mémoire, disque). Une évasion du conteneur reste le risque le plus grave (11.8) ; le non-privilégié la rend nettement plus difficile.
- **Aucun accès au réseau d'Alexandre.** Deux couches, parce que le code client tourne dans ce CT :
  1. **Pare-feu Proxmox sur l'interface du CT** (le root du CT ne peut pas le retirer) : sortie refusée vers `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, sauf la passerelle pour le DNS ; sortie SMTP (25, 465, 587) refusée ; entrée seulement depuis l'IP du CT du hub, vers le port de l'agent.
  2. **nftables dans le CT**, par compte : les comptes des sites ne peuvent joindre ni l'agent, ni MariaDB par le réseau (socket local seulement), ni le LAN.
  - Un **VLAN dédié** (pont Proxmox séparé) est plus propre si la box et le switch le permettent. *Recommandation : pare-feu Proxmox d'abord (rien à acheter), VLAN plus tard si Alexandre en a l'usage.*
  - Sortie Internet en HTTPS ouverte par défaut (API de paiement en mode test, API de suivi des colis, webhooks), fermable site par site.
  - **IMAP (993) fermé par défaut** : une recette ne relève jamais la vraie boîte d'une boutique. Il s'ouvre seulement sur demande explicite, site par site, pour le compte de ce site.
- **Par site** :
  - un compte système `php-<slug>`, sans shell ni mot de passe ;
  - un dossier `/srv/sites/<slug>/` (versions, `shared/`, `tmp/`, sessions, journaux), illisible des autres sites ;
  - un pool PHP-FPM à lui, sous ce compte, avec `open_basedir` limité à son dossier, `sys_temp_dir` et `session.save_path` à lui, `allow_url_include` coupé et `expose_php` coupé ;
  - `disable_functions` : `exec`, `passthru`, `shell_exec`, `system`, `proc_open`, `popen`, `pcntl_exec`, `dl`. `putenv` reste permis, car des bibliothèques de `.env` s'en servent.
- **Limites par site** :
  - **mémoire PHP** : `memory_limit` 256 Mo par requête ;
  - **nombre de processus** : 4 au plus (`pm = ondemand`), arrêtés à l'inactivité ;
  - **durée d'une requête** : 30 s au plus (`request_terminate_timeout`) ;
  - **envois de fichiers** : taille plafonnée.
  - **CPU et mémoire au niveau du système** : un service OpenRC par site (un PHP-FPM par site plutôt qu'un seul maître à plusieurs pools) permet un groupe de contrôle par site (`rc_cgroup_settings`). Cela suppose que le CT non privilégié laisse écrire ses cgroups : **à vérifier sur le Proxmox au lot 1**. À défaut, on reste aux limites PHP ci-dessus et aux limites globales du CT.
  - **Disque** : pas de quota système fiable dans un CT. Le hub plafonne la taille à l'envoi et mesure chaque nuit les fichiers et la base de chaque site, avec une alerte au-delà d'un seuil. Le disque du CT reste la limite dure.

### 11.3 Pile

- **Serveur web : nginx** (paquet apk `nginx`).
  - Caddy apporte surtout des certificats automatiques, inutiles derrière le tunnel Cloudflare.
  - nginx est léger, éprouvé avec PHP-FPM, et produit une configuration par site simple à générer et à vérifier (`nginx -t` avant chaque rechargement).
  - Un bloc `server` par site, dont la racine est le dossier public choisi (`public/` pour MyTakumi), jamais la racine du projet.
  - Règles de base :
    - fichiers cachés, `.env`, `composer.*`, `vendor/`, journaux et sauvegardes refusés (403), comme le `_worker.js` des sites statiques ;
    - seuls les `.php` du dossier public sont exécutés ;
    - un site absent répond 404.
- **PHP** : paquets apk de la branche installée. Alpine 3.22 (dépôt community) fournit `php82`, `php83` et `php84`, chacun avec son `-fpm`.
  - La version se choisit par site parmi celles installées.
  - MyTakumi : **8.3**. Vérifié dans le projet le 24/10/2026 : minimum 8.2.0 (`scripts/dev.php`), pas de `composer.json` ni de `vendor/`, rien qui exige 8.2 exactement. Extensions utilisées : `mbstring`, `gd` (dont WebP), `sodium`, `pdo_mysql`, `pdo_sqlite`, `ctype`, `exif`, `session`, `openssl` (client IMAP et HTTPS sans extension `imap`).
  - Les extensions sont installées à la demande, sur une liste connue : `pdo_mysql`, `mbstring`, `intl`, `gd`, `zip`, `opcache`...
- **MariaDB** (paquets `mariadb`, `mariadb-client`), dans le même CT, écoute sur le socket local seulement.
  - Une base et un compte par site, droits limités à sa base, nombre de connexions plafonné.
  - Le mot de passe est généré par l'agent, transmis au hub et chiffré au repos comme les autres secrets, puis écrit dans le `.env` du site.
- **Sauvegardes** :
  - un `mariadb-dump` par site chaque nuit, chiffré avec la phrase de passe des sauvegardes du hub, 14 jours gardés ;
  - les fichiers des versions sont déjà gardés par le hub ;
  - en plus, la sauvegarde Proxmox du CT entier (Datacenter > Backup).

### 11.4 Exposition

- **Un tunnel Cloudflare propre au CT PHP**, distinct de celui du hub et de celui de l'ERP. Son entrée accepte `*.kouzia.com` vers nginx ; c'est le DNS qui décide quels noms arrivent à ce tunnel.
- Le hub crée `<client>.kouzia.com` en CNAME vers ce tunnel (`<id>.cfargotunnel.com`), avec le jeton qu'il a déjà (DNS Edit). Pas de nouveau droit Cloudflare.
- **noindex** comme les sites statiques : `X-Robots-Tag: noindex, nofollow` et `robots.txt` en `Disallow: /` servis par nginx, l'option « Autoriser l'indexation » restant possible par site (cinquième série).
- **Interrupteur on/off** comme aujourd'hui : « couper » retire le CNAME (l'adresse ne répond plus), puis désactive le bloc nginx et arrête le pool. « Rallumer » fait l'inverse, sans délai de certificat (le certificat est celui de Cloudflare sur `kouzia.com`).
- La surveillance (section 10) s'applique telle quelle : c'est une adresse HTTPS.

### 11.5 Pilotage depuis le hub

- **Création** : « Nouveau site », avec un choix « Statique (Cloudflare Pages) » ou « PHP (serveur Kouzia) ». Pour PHP : version de PHP, dossier public (`public/` proposé si présent), base de données oui ou non.
- **Fichiers** : mêmes outils qu'aujourd'hui (zip, explorateur, envoi par morceaux).
  - Les règles d'envoi changent pour un site PHP : les `.php`, `composer.json` et `vendor/` sont acceptés. `.env`, `.git`, `.claude/`, `node_modules/` et les README restent refusés.
  - La détection de l'envoi dira alors « Site dynamique : à publier comme site PHP » et proposera de changer le type du site.
  - Composer n'est jamais lancé sur le serveur : Alexandre envoie le projet avec son `vendor/`, construit sur son PC.
  - **Dossiers persistants** déclarés par site (MyTakumi : `data/`, qui contient sa base SQLite de développement, les originaux envoyés, son journal et `app.key`) : gardés dans `shared/` et reliés dans chaque version, jamais écrasés par une publication ni servis par nginx. Le contenu envoyé de ces dossiers sert seulement à les initialiser la première fois.
- **Variables d'environnement** : écran « Variables » par site (clé et valeur, valeurs masquées), chiffrées dans la base du hub.
  - L'agent écrit `/srv/sites/<slug>/shared/.env` (lisible du seul compte du site), hors du dossier public, jamais publié ni téléchargeable.
  - `DB_*` est rempli d'office.
  - Garde-fou : une valeur qui ressemble à une clé de paiement réelle (`sk_live_`, `pk_live_`, `rk_live_`...) est refusée (11.6).
- **Base de données** :
  - « Importer un fichier SQL » (`.sql` ou `.sql.gz`), exécuté avec le compte du site ;
  - « Exporter » (téléchargement d'un dump) ;
  - « Réinitialiser » (vider la base, avec double confirmation).
  - Pas de console SQL libre dans le hub.
- **Journaux** : erreurs PHP, journal lent et erreurs nginx du site, les dernières centaines de lignes, consultables et téléchargeables. Rotation chaque nuit.
- **Tâche planifiée** : une ligne par site, faite d'un script du projet (chemin relatif, ex. `bin/cron.php`) et d'une fréquence choisie dans une liste (5, 15, 30, 60 minutes, quotidienne).
  - Elle est lancée par crond sous le compte du site, avec durée maximale et verrou anti-chevauchement.
  - Dernière exécution et code de sortie visibles.
  - Coupée quand le site est coupé.
- **Versions et retour arrière** :
  - Chaque publication devient un dossier `releases/<n>/` ; un lien `current` bascule de façon atomique, puis PHP-FPM est rechargé sans coupure.
  - Retour arrière : basculer `current` sur une version précédente, en un clic.
  - Limite : la base ne revient pas en arrière avec le code. Le hub propose un dump automatique de la base avant chaque publication, qu'on peut restaurer avec la version, après confirmation. Les 5 dernières versions sont gardées sur le CT PHP ; le hub garde les autres comme aujourd'hui.

### 11.6 E-mails et paiements

- **Jamais de vrai envoi d'e-mail** depuis une version de travail :
  - `sendmail_path` de chaque pool pointe vers un capteur de l'agent, qui range le message dans le dossier du site (100 derniers gardés) ;
  - pour les applications qui parlent SMTP, le capteur écoute aussi sur `127.0.0.1:1025`, et le `.env` reçoit `MAIL_HOST`/`MAIL_PORT` vers lui ;
  - le pare-feu bloque de toute façon le SMTP sortant ;
  - écran « E-mails capturés » dans la fiche, pour vérifier les envois sans les envoyer.
  - Mailpit n'existe pas dans les paquets Alpine (vérifié le 24/10/2026) : le capteur fait partie de l'agent.
- **Paiements en mode test seulement** : clés `live` refusées à la saisie des variables, bandeau « mode test » rappelé dans la fiche. Les webhooks de test arrivent par l'adresse du site comme une requête normale.

### 11.7 Ressources (estimation par site, à mesurer sur MyTakumi)

| Poste | Au repos | En usage (recette) |
|---|---|---|
| PHP-FPM (ondemand, 4 processus au plus) | 0 à 30 Mo | 150 à 250 Mo |
| MariaDB (part du site) | quelques Mo | 20 à 50 Mo |
| Disque (code, 5 versions, base, journaux) | 0,5 à 3 Go | |
| CPU | nul | pointes courtes, 1 cœur |

CT de départ : 2 cœurs, 2 Go de RAM (dont environ 256 Mo pour le tampon de MariaDB), 30 Go de disque. Cela suffit pour 3 à 5 sites en recette, peu fréquentés. À revoir avec la mesure réelle de MyTakumi au lot 5.

### 11.8 Risques et mesures

| Risque | Mesure |
|---|---|
| Faille dans le code d'un client (exécution de code, envoi de fichier piégé) | Compte et pool propres au site, `open_basedir`, fonctions de commande coupées, seuls les `.php` du dossier public exécutés, pas d'écriture dans `releases/` (lecture seule pour le site, écriture seulement dans `shared/` et `tmp/`) |
| Un site lit un autre site ou sa base | Comptes séparés, droits des dossiers, sessions et fichiers temporaires séparés, un compte MariaDB par base |
| Rebond vers le réseau d'Alexandre (box, NAS, ERP, hub) | Pare-feu Proxmox sur l'interface du CT, que le CT ne peut pas modifier ; nftables par compte dans le CT ; VLAN en option |
| Évasion du conteneur (faille du noyau) | CT non privilégié, mises à jour du noyau Proxmox par Alexandre, rien de sensible dans le CT PHP (ni jeton Cloudflare, ni clés de licence, ni base du hub) |
| CT détourné pour envoyer du spam ou attaquer d'autres sites | SMTP sortant bloqué, sortie vers le LAN bloquée, sortie HTTPS fermable par site, journal des requêtes sortantes à étudier si besoin |
| Saturation du Proxmox | Limites du CT dans Proxmox, limites PHP par site, groupes de contrôle par site si possible (11.2), alerte disque |
| Agent détourné (il agit en root sur le CT PHP) | Liste fermée d'opérations, chaque paramètre validé (slug, chemins, versions de PHP connues), requêtes signées et horodatées, port ouvert au seul hub, journal de chaque opération dans le hub |
| Code source ou `.env` téléchargeable | Racine web limitée au dossier public, `.env` dans `shared/`, règles nginx de refus, contrôle automatique après chaque publication (demande de `/.env`, `/composer.json`, `/vendor/` : 403 ou 404 attendu, sinon alerte et site coupé) |
| Vrais e-mails ou vrais paiements depuis une recette | Capteur d'e-mails, SMTP bloqué, clés `live` refusées |
| Versions de PHP ou paquets non corrigés | `kouziaphpctl upgrade` (apk upgrade dans la branche installée, comme `system_upgrade` du hub), signalé dans le hub ; alerte si une version de PHP utilisée sort du support de sécurité ; changement de branche Alpine à la main, une fois par an |
| Indexation d'une recette | noindex par défaut, comme les sites statiques |

**Mises à jour de sécurité** : un outil `kouziaphpctl` sur le CT PHP, copié de `hubctl` (install, update, status, upgrade, backup). `upgrade` lance `apk update` puis `apk upgrade` dans la branche installée, vérifie `nginx -t` et `php-fpm -t`, redémarre nginx, les pools et MariaDB, et écrit le résultat. Le hub affiche la date de la dernière mise à jour et une alerte au-delà de 14 jours.

### 11.9 Découpage en lots

| Lot | Contenu | Ce qu'Alexandre fait lui-même |
|---|---|---|
| **P0. Décisions** | Valider ce cadrage et les questions de 11.10 ; sixième série ajoutée aux règles du dépôt | Répondre aux questions |
| **P1. CT PHP** | Scripts Alpine de `kouziaphpctl` (installation, nginx, PHP, MariaDB, nftables, tunnel, mises à jour, état), vérification des cgroups dans le CT | Créer le CT non privilégié, le pare-feu Proxmox sur son interface, le tunnel « sites PHP » et coller son jeton |
| **P2. Agent et lien avec le hub** | Agent (opérations fermées, signature, journal), client dans le hub, secret partagé, contrôle de l'état | Poser le secret dans les deux `.env`, ouvrir le port de l'agent au seul hub dans le pare-feu Proxmox |
| **P3. Site PHP dans le hub** | Type de site « PHP », création, DNS vers le tunnel, on/off, noindex, fichiers (règles d'envoi propres au PHP), dossier public, publication par versions et retour arrière, contrôle anti-fuite après publication | Rien |
| **P4. Variables et base** | Écran des variables (chiffrées, clés `live` refusées), création de la base, import, export, réinitialisation, dump avant publication, sauvegarde de nuit | Rien |
| **P5. Exploitation et MyTakumi** | Journaux, tâche planifiée, e-mails capturés, mesure disque et alertes, mesure des ressources ; mise en ligne de MyTakumi en recette | Envoyer MyTakumi avec son `vendor/`, son dump SQL et ses variables de test |

### 11.10 Décisions (24/10/2026)

1. **Réseau** : pare-feu Proxmox sur l'interface du CT d'abord, VLAN plus tard.
2. **Sortie Internet** : HTTPS ouvert par défaut, fermable par site. IMAP (993) fermé par défaut, ouvert sur demande explicite par site.
3. **PHP de MyTakumi** : 8.3 (vérifié, voir 11.3).
4. **Appels sortants de MyTakumi** : Stripe en mode test ; API Suivi de La Poste (HTTPS, clé dans ses réglages) ; relève IMAP de la boîte de la boutique, désactivée en recette sauf demande ; SMTP de l'hébergeur en production, capturé ici ; tâche `scripts/cron.php` toutes les 15 minutes.
5. **Retour arrière de la base** : dump automatique avant chaque publication.
6. **Taille du CT** : 2 cœurs, 2 Go de RAM, 30 Go de disque proposés, à confirmer par Alexandre.

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
- [CF-WK-LIMITS] Workers, Limits (offre gratuite) : https://developers.cloudflare.com/workers/platform/limits/
- [CF-D1-PRICING] D1, Pricing (usage inclus de l'offre gratuite) : https://developers.cloudflare.com/d1/platform/pricing/
- [CF-D1-LIMITS] D1, Limits : https://developers.cloudflare.com/d1/platform/limits/
- [CF-KV-LIMITS] Workers KV, Limits : https://developers.cloudflare.com/kv/platform/limits/
- [CF-WK-SCHEDULES] API, Update Worker schedules : https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/
- [CF-WEBCRYPTO] Workers, Web Crypto : https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- [IANA-RDAP] IANA, amorce RDAP des domaines (consultée le 18/10/2026) : https://data.iana.org/rdap/dns.json

Autres :

- [GOVUK-CLEAR] GOV.UK, Use clear language : https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/
- [NNG-PLAIN] Nielsen Norman Group, Plain Language Is for Everyone, Even Experts (Hoa Loranger, 2017) : https://www.nngroup.com/articles/plain-language-experts/
- [WEBDEV-LCP] web.dev, Largest Contentful Paint : https://web.dev/articles/lcp
- [WEBDEV-CLS] web.dev, Cumulative Layout Shift : https://web.dev/articles/cls
- [ATL-UPTIME] Atlassian Statuspage, Display historical uptime of components (consultée le 18/10/2026) : https://support.atlassian.com/statuspage/docs/display-historical-uptime-of-components/
- [BUTTERICK] Matthew Butterick, Butterick's Practical Typography (consultée le 18/10/2026) : https://practicaltypography.com/
- [DEV-PY] Deploying to Cloudflare Pages from pure Python, no Node, no wrangler (dev.to) : https://dev.to/orix/deploying-to-cloudflare-pages-from-pure-python-no-node-no-wrangler-2ea1
- [PULUMI-DOM] Pulumi, cloudflare.PagesDomain (DNS non créé par l'API) : https://www.pulumi.com/registry/packages/cloudflare/api-docs/pagesdomain/
- [SCOUT-DANGLING] ScoutDNS, Dangling DNS records and subdomain takeover : https://www.scoutdns.com/library/dangling-dns-records-how-subdomain-takeover-becomes-possible
- [GH-ARTIFACTS] GitHub REST API, Artifacts : https://docs.github.com/en/rest/actions/artifacts
- [VERCEL-PWD] Vercel, Password Protection : https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/password-protection
- [VERCEL-ROLLBACK] Vercel, Instant Rollback : https://vercel.com/docs/instant-rollback
- [NETLIFY-DEPLOY] Netlify, Create deploys : https://docs.netlify.com/deploy/create-deploys/
- [NNG-CARDS] Nielsen Norman Group, Cards: UI-Component Definition : https://www.nngroup.com/articles/cards-component/
- [NNG-DND] Nielsen Norman Group, Drag and Drop: How to Design for Ease of Use : https://www.nngroup.com/articles/drag-drop/
- [NNG-FACETS] Nielsen Norman Group, Kathryn Whitenton, Filters vs. Facets: Definitions (16/03/2014) : https://www.nngroup.com/articles/filters-vs-facets/
- [NNG-BREADCRUMBS] Nielsen Norman Group, Breadcrumbs: 11 Design Guidelines for Desktop and Mobile : https://www.nngroup.com/articles/breadcrumbs/
- [NNG-CONFIRM] Nielsen Norman Group, Confirmation Dialogs Can Prevent User Errors : https://www.nngroup.com/articles/confirmation-dialog/
- [GOVUK-UPLOAD] GOV.UK Design System, File upload : https://design-system.service.gov.uk/components/file-upload/
- [LCEN-DSA] Définitions de l'hébergeur (LCEN art. 6-I-2 et DSA art. 6), synthèse : https://www.labase-lextenso.fr/ouvrages/droit-du-numerique-9782275153209/section-1-l-exemption-conditionnelle-de-responsabilite-des-fournisseurs-de-services-d-hebergement-9782275153209-145
