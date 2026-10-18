# Hub Kouzia

Outil interne d'Alexandre, sur `https://hub.kouzia.com`. Il met en ligne les versions de travail des sites clients sur `<client>.kouzia.com` (Cloudflare Pages) : création en un clic, envoi des fichiers, versions, allumer ou couper un site, catalogue avec vignettes. Les clients sont lus dans l'ERP, sans ressaisie.

Il tourne dans son propre CT Alpine sur le Proxmox, comme l'ERP, derrière Cloudflare Access (votre adresse seule) puis un login (mot de passe et application d'authentification). Tout se pilote avec une seule commande : `hubctl`.

Cadrage complet : `docs/cadrage.md`.

## Installation (une fois)

### 1. Créer le CT dans Proxmox

« Create CT » avec ces réglages :

| Réglage | Valeur conseillée |
|---|---|
| Nom (hostname) | `kouziahub` |
| Modèle | Alpine 3.21 ou plus récent |
| Non privilégié (unprivileged) | oui |
| Processeur | 2 cœurs |
| Mémoire | 2048 Mo (swap 512 Mo) |
| Disque | 16 Go (les sauvegardes gardent tous les fichiers des sites) |
| Réseau | DHCP ou IP fixe, comme l'ERP |
| Démarrer avec l'hôte (Start at boot) | oui |

Démarrer le CT, ouvrir sa « Console » et se connecter en `root`. Si le collage ne marche pas dans cette console, ouvrir le « Shell » du nœud Proxmox puis taper `pct enter <numéro du CT>`.

### 2. Installer le hub

```sh
apk add git
git clone https://github.com/K0uzia/KouziaHub.git /opt/kouziahub
sh /opt/kouziahub/scripts/alpine/hubctl install
```

Répondre aux questions (Entrée = choix conseillé). Si GitHub demande un identifiant (dépôt privé) : votre nom GitHub, et comme mot de passe un jeton GitHub en lecture seule sur ce dépôt.

L'installation propose Chromium (environ 300 Mo) pour les vignettes automatiques. Sans lui, vous enverrez une image par site ; `hubctl chromium` l'ajoute plus tard.

Les étapes 3 et 4 peuvent se faire pendant l'installation (elle les propose) ou après. Le hub ne démarre pas tant que l'étape 4 n'est pas faite : il n'est jamais exposé sans Access.

### 3. Tunnel Cloudflare du hub

Dans Cloudflare : Zero Trust > Networks (Réseaux) > Tunnels > Create a tunnel > Cloudflared.

1. Nom : `kouziahub` (un tunnel à lui, pas celui de l'ERP).
2. Copier la commande d'installation affichée (longue suite qui commence par `eyJ`).
3. Nom d'hôte public : `hub.kouzia.com`, service `HTTP`, adresse `127.0.0.1:3000`.

Dans le CT : `hubctl cloudflare`, puis coller la commande. Rien ne s'affiche pendant le collage, c'est normal.

### 4. Cloudflare Access sur hub.kouzia.com

Dans Cloudflare : Zero Trust > Access > Applications > Add an application > Self-hosted.

1. Nom : `Hub Kouzia`, domaine : `hub.kouzia.com`.
2. Règle : Allow, Include > Emails > votre adresse seule.
3. Connexion : code reçu par e-mail (One-time PIN).
4. Relever deux valeurs :
   - l'AUD : dans l'application, « Application Audience (AUD) Tag » ;
   - le domaine d'équipe : Zero Trust > Settings (Réglages), « Team domain » (`<nom>.cloudflareaccess.com`).

Dans le CT : `hubctl secrets access`, saisir les deux valeurs (invisibles à l'écran). Le hub démarre.

### 5. Votre compte

`hubctl admin` : adresse, mot de passe (12 caractères au moins), puis scanner le code avec l'application d'authentification du téléphone. Noter sur papier les codes de secours affichés.

Ouvrir `https://hub.kouzia.com` : Cloudflare demande le code reçu par e-mail, puis le hub demande mot de passe et code du téléphone.

### 6. Plus tard : jeton API Cloudflare

Tant qu'il n'y a pas de jeton, le hub fonctionne en **mode simulé** (`hubctl status` l'indique) : rien n'est créé chez Cloudflare.

Créer le jeton : Cloudflare > My Profile > API Tokens > Create Token > Custom token, avec **seulement** :

- Account > Cloudflare Pages > Edit (Account Resources : votre compte) ;
- Zone > DNS > Edit (Zone Resources : Specific zone > `kouzia.com`) ;
- rien d'autre ;
- expiration : dans un an ;
- filtrage par adresse IP : oui si l'IP de votre box est fixe.

Relever aussi, sur la page de `kouzia.com` dans Cloudflare (colonne de droite, rubrique « API »), le Zone ID et l'Account ID.

Dans le CT : `hubctl secrets api`. Avant l'expiration, refaire un jeton et relancer la même commande.

### 7. Plus tard : relier l'ERP (lecture des clients)

Tant que ce lien n'est pas posé, le hub montre des clients de démonstration (il le signale).

1. Côté ERP (après sa mise à jour qui ajoute la lecture pour le hub) : l'ERP sert la liste des clients sur un écouteur dédié, **port 3100**, sur l'IP de son CT dans le réseau local.
2. Dans Proxmox, sur le CT de l'ERP : Firewall > Add, règle « IN », ACCEPT, port de destination 3100, source = l'IP du CT du hub ; aucune autre source.
3. Créer un secret partagé une seule fois (`openssl rand -hex 32`) et le poser à l'identique dans le `.env` de l'ERP (`HUB_READ_SECRET`).
4. Dans le CT du hub : `hubctl secrets erp` : IP du CT de l'ERP (le hub en fait `http://<IP du CT ERP>:3100`), puis le secret (invisible), puis l'adresse `https://erp.kouzia.com` pour le lien vers les fiches.

## Surveillance des sites

Le hub contrôle vos sites toutes les 5 minutes. Une « veille » installée chez Cloudflare les contrôle aussi, même quand la box est coupée. Une panne n'est signalée que si les deux la voient ; si le hub se tait plus de 15 minutes, la veille vous prévient et continue seule. Les alertes arrivent en notification sur le téléphone, rien par e-mail.

### a) Les notifications sur le téléphone

1. Dans le CT : `hubctl push-keys`. Une seule fois : ne jamais le refaire, sinon chaque téléphone devrait se réabonner.
2. Sur le téléphone Android, dans Chrome, ouvrir `https://hub.kouzia.com`, aller dans Réglages et toucher « Activer sur ce téléphone », puis accepter les notifications. Pas besoin d'installer l'application.
3. Toujours dans Réglages, envoyer la notification de test : elle doit arriver sur le téléphone.

Sur iPhone, il faudrait d'abord ajouter le hub à l'écran d'accueil.

### b) La veille Cloudflare (jeton de déploiement)

1. Cloudflare > My Profile > API Tokens > Create Token > Custom token.
2. Nom : `Déploiement veille`. Permissions, ces deux lignes **et rien d'autre** :
   - Account > Workers Scripts > Edit ;
   - Account > D1 > Edit.
3. Account Resources : Include > votre compte seulement. Aucune ligne « Zone ».
4. Expiration : courte (une semaine par exemple) : ce jeton ne sert qu'au moment du déploiement.
5. Dans le CT : `hubctl veille deploy`, puis coller le jeton (rien ne s'affiche). Il n'est gardé nulle part : ni dans le `.env`, ni dans les journaux.

Si le message demande de choisir une adresse workers.dev : dans Cloudflare, ouvrir « Workers et Pages » une première fois et accepter le sous-domaine proposé, puis relancer `hubctl veille deploy`.

À refaire avec un nouveau jeton après `hubctl push-keys`, ou quand `hubctl update` annonce que la veille a changé.

### c) Le jeton de lecture des zones (facultatif)

Il permet au hub de vous proposer vos domaines Cloudflare à surveiller ; rien n'est ajouté sans votre accord.

1. Cloudflare > My Profile > API Tokens > Create Token > Custom token.
2. Permissions, une seule ligne : Zone > Zone > Read. Zone Resources : Include > All zones. Rien d'autre.
3. Expiration : dans un an.
4. Dans le CT : `hubctl secrets veille`, puis coller le jeton (invisible).

### d) Les domaines Hostinger

Pas de jeton Hostinger : dans le hub, page Surveillance, ajouter chaque site à la main (son adresse `https://...`, un libellé, et le client de l'ERP si besoin), puis laisser l'interrupteur « Surveillé » allumé.

### e) Chaque mois

Le 1er du mois, le hub prépare le rapport PDF de chaque site surveillé. Le télécharger dans le hub (page Surveillance), puis l'envoyer au client depuis l'ERP avec votre message habituel. Le hub n'envoie rien lui-même.

## Tous les jours

| Commande | Effet |
|---|---|
| `hubctl` | Menu |
| `hubctl status` | État : service, santé, migrations, disque, dernière sauvegarde, tunnel |
| `hubctl update` | Mise à jour : arrêt, sauvegarde automatique, code GitHub, dépendances si besoin, base, interface, redémarrage, contrôle. Si le hub ne répond plus, propose de revenir en arrière |
| `hubctl rollback` | Revenir à la version d'avant la dernière mise à jour (code et données d'alors) |
| `hubctl backup` | Sauvegarder maintenant |
| `hubctl restore` | Remettre une sauvegarde (liste, choix, copie de l'état actuel avant) |
| `hubctl restore --check <sauvegarde>` | Vérifier une sauvegarde sans rien changer |
| `hubctl backup --export` | Archive chiffrée d'une sauvegarde, à copier hors du CT |
| `hubctl logs erreurs` | Dernières erreurs du hub (aussi `app`, `tunnel`, `sauvegarde`) |
| `hubctl restart` | Redémarrer le hub |
| `hubctl 2fa-reset` | Téléphone perdu : coupe la double authentification, puis `hubctl admin` |
| `hubctl push-keys` | Clés des notifications (une seule fois) |
| `hubctl veille deploy` | Déployer ou mettre à jour la veille Cloudflare (jeton demandé, jamais gardé) |
| `hubctl secrets veille` | Jeton de lecture des zones Cloudflare |

Sauvegardes : chaque nuit dans `/var/backup/kouziahub`, les 14 plus récentes sont gardées. Chacune contient la base, les fichiers des sites et le fichier `.env` en clair : elle contient donc des secrets et ne sort jamais du CT telle quelle. Si une mise à jour ou une restauration est en cours à l'heure de la sauvegarde, celle-ci saute son tour (une ligne dans `hubctl logs sauvegarde`).

### Copier une sauvegarde hors du CT (chiffrée)

1. Dans le CT : `hubctl backup --export`. La première fois, choisir une phrase de passe (16 caractères au moins) et la noter dans votre gestionnaire de mots de passe : sans elle, l'archive ne s'ouvre pas, et si le CT est perdu, elle n'existe plus nulle part ailleurs.
2. Le hub crée `/var/backup/kouziahub/export/kouziahub-<date>.tar.gpg`, chiffrée (GPG, AES256). Il en garde les 3 dernières.
3. Dans le « Shell » du nœud Proxmox : `pct pull <numéro du CT> /var/backup/kouziahub/export/<fichier> /root/<fichier>`, puis copier ce fichier sur le NAS ou le PC.
4. Pour la remettre (même CT ou CT neuf, après `hubctl install`) : `pct push <numéro du CT> /root/<fichier> /root/<fichier>`, puis dans le CT `hubctl restore /root/<fichier>` ; la phrase de passe est demandée si le CT ne la connaît pas.

En plus, la sauvegarde Proxmox du CT (Datacenter > Backup) garde une copie de tout le CT.

Le service redémarre seul s'il plante (10 fois par minute au plus, ensuite `hubctl status` l'indique : lire `hubctl logs erreurs`, puis `hubctl restart`).

## Sécurité du CT (exploitation)

### Droits des fichiers

Le compte du service (`kouziahub`, celui qui fait tourner le hub et manipule les fichiers envoyés) ne peut modifier ni le code, ni sa configuration, ni rien de ce que root exécute. `hubctl update` remet ces droits à chaque fois (y compris sur une ancienne installation) et `hubctl status` les contrôle.

| Chemin | Propriétaire | Droits | Qui écrit | Qui exécute ou lit |
|---|---|---|---|---|
| `/opt/kouziahub` (sources, `prisma`, `package*.json`) | root:root | dossiers 755, fichiers 644 (aucune écriture groupe ou autres) | root (git, `hubctl update`) | service : lit et exécute ; root : `npm ci`, build, `prisma generate` |
| `/opt/kouziahub/.git` | root:root | 755 / 644, sans crochets | root, avec `core.hooksPath=/dev/null`, `core.fsmonitor=false` et sans programme de la configuration | personne |
| `/opt/kouziahub/node_modules` | root:root | 755 / 644, exécutables d'origine gardés | root (`npm ci`) | service : lit et exécute |
| `/opt/kouziahub/apps/web/dist` | root:root | 755 / 644 | root (build) | service : lit (sert l'interface) |
| `/opt/kouziahub/.deploy-state` | root:root | 755 / 644 | root | root |
| `/opt/kouziahub/.env` | root:kouziahub | 640 | root (`hubctl`, et `push-keys`, `veille deploy` lancés en root) | service : lit |
| `/opt/kouziahub/data` (HUB_DATA_DIR) | kouziahub:kouziahub | 750 | service (base, fichiers des sites, vignettes) | service ; sauvegarde et restauration y passent par le compte du service, jamais root |
| `/var/lib/kouziahub` | kouziahub | 700 | service (dossier personnel, caches) | service |
| `/var/log/kouziahub` | root:root | 755 ; `app.*` kouziahub 640, `cloudflared.*` nobody 640, `backup.log` root | chaque service le sien | root |
| `/usr/local/lib/kouziahub` | root:root | 755 / 644 ; `hubctl`, `chromium-*` 755 | root (copie à chaque installation et mise à jour) | root (`hubctl`, sauvegarde, OpenRC) ; service : `chromium-launch` |
| `/usr/local/bin/hubctl` | root | lien vers la copie ci-dessus | root | root |
| `/etc/init.d/kouziahub`, `cloudflared`, `kouziahub-firewall`, `/etc/conf.d/kouziahub` | root:root | 755 / 644 | root | OpenRC |
| `/etc/periodic/daily/kouziahub-backup` | root:root | 755 | root | crond, vers la copie root de `backup.sh` |
| `/etc/kouziahub` (`tunnel.token`, `backup-pass`, `nftables.nft`) | root:root | 700 ; secrets 600 | root | root |
| `/var/backup/kouziahub` (et `export/`) | root:root | 700 ; fichiers 600 | root | root |
| `/etc/doas.d/kouziahub-chromium.conf` | root:root | 400 | root | doas |
| `/var/lib/kouziahub-chromium` | kouziahub-chromium | 700 | Chromium (profils jetables) | Chromium |
| `/run/kouziahub-ops.lock` | root | 600 | root (verrou des opérations) | root |

Si `hubctl update` s'arrête sur « configuration git inattendue » : le dépôt a pu être modifié par le compte du service avant cette correction. Le refaire : `mv /opt/kouziahub/.git /root/git-suspect`, puis `git clone --depth 1 https://github.com/K0uzia/KouziaHub.git /root/hub-neuf && mv /root/hub-neuf/.git /opt/kouziahub/.git`, puis `hubctl update`.

### Chromium isolé et son pare-feu

Chromium (vignettes, mesure de vitesse) ne tourne pas sous le compte du service mais sous un compte à lui, `kouziahub-chromium`, sans accès au `.env` ni aux données. Le hub le lance par `/usr/local/lib/kouziahub/chromium-launch`, qui passe par `doas` avec une seule règle autorisée (cette commande, vers ce compte, rien d'autre).

Sa sortie réseau est filtrée par nftables (table `inet kouziahub`, posée par `hubctl chromium`, `hubctl install`, `hubctl update` et au démarrage) : il ne peut joindre ni la box, ni le réseau local, ni l'ERP, ni les autres services du CT. Seuls le serveur local des vignettes et les DNS du CT lui restent ouverts. Le hub, lui, joint toujours l'ERP (port 3100) et Cloudflare. `hubctl status` indique si la règle est posée.

Un CT non privilégié peut refuser nftables. Dans ce cas, `hubctl chromium` le dit et il faut poser la règle dans Proxmox. Elle s'applique alors à tout le CT, d'où les deux exceptions :

1. Datacenter > Firewall > Options : vérifier « Input Policy » avant d'activer « Firewall » (le laisser à ACCEPT si vous n'êtes pas sûr), puis Firewall : Yes.
2. CT `kouziahub` > Network > `net0` > Edit : cocher « Firewall ».
3. CT `kouziahub` > Firewall > Add, dans cet ordre (direction « out ») :
   - ACCEPT, protocole tcp, destination l'IP du CT de l'ERP, port de destination 3100 ;
   - ACCEPT, protocole udp, destination l'IP de la box (ses DNS), port 53 ; puis la même en tcp ;
   - DROP, destination `10.0.0.0/8` ; puis `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16` (une règle chacune).
4. CT `kouziahub` > Firewall > Options : Firewall : Yes. Laisser « Output Policy » à ACCEPT (Cloudflare et Internet restent joignables).
5. Vérifier : `hubctl status` (le hub répond) et, dans le hub, une vignette se crée.

## Développement (PC)

Prérequis : Node.js 22, GNU make (Windows : `choco install make`).

```sh
make setup   # .env de dev (secrets aléatoires, Access coupé, Cloudflare et ERP simulés), dépendances, base, compte
make dev     # API http://127.0.0.1:3101 et interface http://localhost:5174
```

`make dev-lan` ouvre l'interface au téléphone du réseau local. `make test`, `make typecheck`, `make build`.

Veille Cloudflare : code dans `workers/veille/` (Worker, schéma D1 `schema.sql`, tests). `npm run veille:build` produit `workers/veille/dist/index.js` (non versionné) ; `npm run veille:deploy` déploie depuis le PC comme `hubctl veille deploy`.

Copier le code vers le CT sans passer par GitHub (rsync et ssh nécessaires sur le PC) : `make alpine-deploy HOST=root@<ip-du-ct>` ; état à distance : `make alpine-status HOST=root@<ip-du-ct>`.

Scripts du CT : `scripts/alpine/` (`hubctl`, `install.sh`, `update.sh`, `backup.sh`, `restore.sh`, `status.sh`, `configure.sh`, services OpenRC dans `openrc/`). Variables du `.env` : `.env.example` (sans valeurs).
