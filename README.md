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
| `hubctl logs erreurs` | Dernières erreurs du hub (aussi `app`, `tunnel`, `sauvegarde`) |
| `hubctl restart` | Redémarrer le hub |
| `hubctl 2fa-reset` | Téléphone perdu : coupe la double authentification, puis `hubctl admin` |

Sauvegardes : chaque nuit dans `/var/backup/kouziahub`, les 14 plus récentes sont gardées. Chacune contient la base, les fichiers des sites et le fichier `.env` : elle contient donc des secrets, ne la copiez pas n'importe où. Pour une copie hors du CT, activer la sauvegarde Proxmox du CT (Datacenter > Backup).

Le service redémarre seul s'il plante (10 fois par minute au plus, ensuite `hubctl status` l'indique : lire `hubctl logs erreurs`, puis `hubctl restart`).

## Développement (PC)

Prérequis : Node.js 22, GNU make (Windows : `choco install make`).

```sh
make setup   # .env de dev (secrets aléatoires, Access coupé, Cloudflare et ERP simulés), dépendances, base, compte
make dev     # API http://127.0.0.1:3101 et interface http://localhost:5174
```

`make dev-lan` ouvre l'interface au téléphone du réseau local. `make test`, `make typecheck`, `make build`.

Copier le code vers le CT sans passer par GitHub (rsync et ssh nécessaires sur le PC) : `make alpine-deploy HOST=root@<ip-du-ct>` ; état à distance : `make alpine-status HOST=root@<ip-du-ct>`.

Scripts du CT : `scripts/alpine/` (`hubctl`, `install.sh`, `update.sh`, `backup.sh`, `restore.sh`, `status.sh`, `configure.sh`, services OpenRC dans `openrc/`). Variables du `.env` : `.env.example` (sans valeurs).
