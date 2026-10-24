# Hub Kouzia

Outil interne d'Alexandre, sur `https://hub.kouzia.com`. Il met en ligne les **versions de travail** des sites clients sur `<client>.kouzia.com` (hébergées gratuitement chez Cloudflare Pages), puis il les **surveille** et prépare le **paquet final** pour l'hébergeur du client.

En bref : créer un site en un clic, y déposer les fichiers comme dans un FTP, publier des versions (toutes gardées et republiables), allumer ou couper l'adresse, voir tous les sites en catalogue, recevoir une alerte sur le téléphone si un site tombe, télécharger un rapport mensuel en PDF. Les clients sont lus dans l'ERP, rien n'est ressaisi.

Le hub tourne dans son propre conteneur (CT) Alpine sur le Proxmox, comme l'ERP. On y entre comme dans l'ERP : par le tunnel Cloudflare, puis par le login du hub, avec mot de passe et code à 6 chiffres du téléphone (sans Cloudflare Access ni Zero Trust). Tout se pilote sur le CT avec une seule commande : `hubctl` (sans rien après, elle ouvre un menu).

Cadrage technique complet : `docs/cadrage.md`.

## Sommaire

1. [Installation (une fois)](#1-installation-une-fois)
2. [Les jetons Cloudflare et le lien avec l'ERP](#2-les-jetons-cloudflare-et-le-lien-avec-lerp)
3. [Notifications sur le téléphone](#3-notifications-sur-le-téléphone)
4. [Mises à jour, sauvegardes, restauration](#4-mises-à-jour-sauvegardes-restauration)
5. [Guide d'utilisation, écran par écran](#5-guide-dutilisation-écran-par-écran)
6. [Limites de l'offre gratuite de Cloudflare](#6-limites-de-loffre-gratuite-de-cloudflare)
7. [Sécurité du CT](#7-sécurité-du-ct)
8. [Points encore à valider en réel](#8-points-encore-à-valider-en-réel)
9. [Développement (PC)](#9-développement-pc)
10. [Toutes les commandes hubctl](#10-toutes-les-commandes-hubctl)
11. [CT des sites PHP (lot P1)](#11-ct-des-sites-php-lot-p1)

---

## 1. Installation (une fois)

### 1.1 Créer le CT dans Proxmox

« Create CT » avec ces réglages :

| Réglage | Valeur conseillée |
|---|---|
| Nom (hostname) | `kouziahub` |
| Modèle | Alpine 3.21 ou plus récent |
| Non privilégié (unprivileged) | oui |
| Processeur | 2 cœurs |
| Mémoire | 2048 Mo (swap 512 Mo) |
| Disque | 16 Go (les sauvegardes gardent tous les fichiers des sites) |
| Réseau | **IP fixe** (IP statique, ou réservation DHCP sur la box) : le lien avec l'ERP (2.d) en dépend, comme l'IP du CT de l'ERP |
| Démarrer avec l'hôte (Start at boot) | oui |

Démarrer le CT, ouvrir sa « Console » et se connecter en `root`. Si le collage ne marche pas dans cette console, ouvrir le « Shell » du nœud Proxmox puis taper `pct enter <numéro du CT>`.

### 1.2 Installer le hub

```sh
apk add git
git clone https://github.com/K0uzia/KouziaHub.git /opt/kouziahub
sh /opt/kouziahub/scripts/alpine/hubctl install
```

Répondre aux questions (Entrée = choix conseillé).

Le dépôt est privé : `git clone` demande un identifiant. Répondre votre nom GitHub (`K0uzia`) et, comme mot de passe, un **jeton GitHub en lecture seule**, jamais votre vrai mot de passe :

1. GitHub > Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate new token.
2. Nom : `Lecture KouziaHub (CT hub)`. Expiration : un an.
3. Repository access : **Only select repositories** > `K0uzia/KouziaHub`, et lui seul.
4. Permissions > Repository permissions : **Contents : Read-only** (« Metadata : Read-only » s'ajoute seul). Rien d'autre.
5. Generate token, copier le jeton (il ne sera plus affiché) et le coller à la question du mot de passe.

`git clone` ne garde pas ce jeton. Or `hubctl update` en a besoin pour chaque mise à jour : **après `hubctl install`, lancer `hubctl secrets github`** et coller le même jeton (l'installation le propose d'elle-même à l'étape « Réglages »). Le hub l'essaie aussitôt auprès de GitHub, puis le garde dans `/etc/kouziahub/github-token`, lisible par root seulement, jamais dans le `.env` ni dans la configuration du dépôt. Il demande aussi sa date d'expiration (facultative) : `hubctl status` prévient alors 30 jours avant. Avant l'expiration, refaire un jeton de la même façon et relancer `hubctl secrets github`. Seuls les jetons fine-grained (`github_pat_...`) sont acceptés : un jeton classique ouvrirait tous les dépôts du compte.

L'installation propose Chromium (environ 300 Mo). C'est le navigateur sans écran qui fabrique les vignettes et mesure la vitesse des sites. Sans lui, vous enverrez une image par site et la vitesse ne sera pas mesurée ; `hubctl chromium` l'ajoute plus tard.

L'étape 1.3 peut se faire pendant l'installation (elle la propose) ou après. Le hub démarre dès la fin de l'installation ; par Internet, il ne laisse entrer qu'avec le mot de passe **et** le code à 6 chiffres (1.5).

### 1.3 Tunnel Cloudflare du hub

Le tunnel relie `hub.kouzia.com` au CT sans ouvrir aucun port de la box. **Il se fait comme pour l'ERP** (`kouziactl cloudflare`) : un tunnel à jeton, avec la même suite d'écrans.

Dans Cloudflare : Zero Trust > Networks (Réseaux) > Tunnels > Create a tunnel > Cloudflared. Le menu s'appelle Zero Trust, mais le tunnel est gratuit et n'utilise ni Access ni aucune option payante.

1. Nom : `kouziahub` (un tunnel à lui, pas celui de l'ERP).
2. Copier la commande d'installation affichée (longue suite qui commence par `eyJ`).
3. Nom d'hôte public : `hub.kouzia.com`, service `HTTP`, adresse `127.0.0.1:3000`.

Dans le CT : `hubctl cloudflare`, puis coller la commande. Rien ne s'affiche pendant le collage, c'est normal.

### 1.4 Cloudflare Access : facultatif

Le hub n'en a pas besoin : il est protégé comme l'ERP, par son login (1.5). Par le tunnel, il ne sert que `hub.kouzia.com` (tout autre nom reçoit une page introuvable) et ajoute ces protections :

- 5 essais de connexion au plus par quart d'heure et par adresse IP ;
- après 5 échecs, le compte se verrouille 15 min, puis 1 h, 4 h et 24 h si cela se répète dans la journée (`hubctl admin` sur le CT le déverrouille) ;
- chaque connexion, réussie ou refusée, est notée dans Réglages > Journal (adresse IP, date, appareil ; jamais le mot de passe ni le code). Exception : les essais bloqués par la limite de débit (réponse 429 « Trop de demandes : réessayez dans quelques minutes. ») ne sont pas notés, seuls les essais traités le sont ;
- une notification arrive sur le téléphone à chaque connexion réussie depuis un nouvel appareil.

Si vous voulez un jour une porte de plus devant le hub, Cloudflare Access reste possible : application « Self-hosted » sur `hub.kouzia.com` (Zero Trust > Access > Applications), règle Allow sur votre adresse seule, puis `hubctl secrets access` (domaine d'équipe et AUD). Le hub vérifie alors aussi le jeton d'Access.

### 1.5 Votre compte et le code du téléphone

`hubctl admin` : adresse, mot de passe (12 caractères au moins), puis scanner le code avec l'application d'authentification du téléphone (Google Authenticator, Aegis...). **Noter sur papier les codes de secours** affichés : chacun ouvre une fois la connexion si le téléphone est perdu.

Ouvrir `https://hub.kouzia.com` : le hub demande le mot de passe, puis le code à 6 chiffres. Sans double authentification activée, la connexion par Internet est refusée.

Ensuite, dans le hub, Réglages > Sécurité : « Régénérer les codes de secours » en refait une série (les anciens ne marchent plus). Téléphone perdu et plus de code de secours : `hubctl 2fa-reset` sur le CT, puis `hubctl admin`.

---

## 2. Les jetons Cloudflare et le lien avec l'ERP

Un **jeton** est une clé d'accès à votre compte Cloudflare, limitée à certains droits. Le hub en utilise trois, chacun avec le strict nécessaire. Tous se créent au même endroit : Cloudflare > My Profile > API Tokens > Create Token > **Custom token**. Toute saisie sur le CT est invisible et jamais affichée ensuite.

| Jeton | Droits, et rien d'autre | Expiration conseillée | Posé par |
|---|---|---|---|
| a) Jeton API du hub | Account > Cloudflare Pages > Edit (votre compte) ; Zone > DNS > Edit (zone `kouzia.com`) ; Zone > Cache Purge > Purge (zone `kouzia.com`) | un an | `hubctl secrets api` |
| b) Jeton de déploiement de la veille | Account > Workers Scripts > Edit ; Account > D1 > Edit (votre compte seulement, aucune ligne « Zone ») | courte (une semaine) | `hubctl veille deploy`, **jamais enregistré** |
| c) Jeton de lecture des zones | Zone > Zone > Read, Zone Resources : All zones | un an | `hubctl secrets veille` |

### a) Jeton API du hub

Sans ce jeton, le hub fonctionne en **mode démonstration** : le catalogue affiche « Mode démonstration » et rien n'est créé chez Cloudflare. C'est le seul cas où ce bandeau apparaît.

1. Custom token, permissions :
   - Account > Cloudflare Pages > Edit ; Account Resources : Include > votre compte ;
   - Zone > DNS > Edit ; Zone Resources : Specific zone > `kouzia.com` ;
   - Zone > Cache Purge > Purge, même zone. Il sert au bouton « Vider le cache Cloudflare » d'un site. Sans lui, tout le reste marche et le hub explique quoi ajouter.
2. Filtrage par adresse IP : oui si l'IP de votre box est fixe. Expiration : dans un an.
3. Relever aussi, sur la page de `kouzia.com` dans Cloudflare (colonne de droite, rubrique « API »), le Zone ID et l'Account ID (32 caractères chacun).
4. Dans le CT : `hubctl secrets api` (jeton, Account ID, Zone ID). Avant l'expiration, refaire un jeton et relancer la même commande.

### b) Jeton de déploiement de la veille

La **veille** est un petit programme chez Cloudflare (un « Worker » nommé `kouzia-veille`, avec une petite base « D1 ») qui contrôle vos sites même quand la box est coupée et envoie les alertes urgentes. Ce jeton sert seulement à l'installer ou à le mettre à jour.

1. Custom token, nom `Déploiement veille`, permissions Account > Workers Scripts > Edit et Account > D1 > Edit, sur votre compte seulement. Expiration courte.
2. Avant : les clés des notifications doivent exister (chapitre 3, `hubctl push-keys`).
3. Dans le CT : `hubctl veille deploy`, puis coller le jeton. Il n'est gardé nulle part : ni dans le `.env`, ni dans les journaux. Le hub écrit seulement l'adresse de la veille et son secret partagé (`MONITOR_WORKER_URL`, `MONITOR_SHARED_SECRET`).

Si le message demande de choisir une adresse workers.dev : dans Cloudflare, ouvrir « Workers et Pages » une première fois et accepter le sous-domaine proposé, puis relancer `hubctl veille deploy`. Sans veille, le hub surveille seul (et envoie aussi les alertes urgentes), mais plus rien ne vous prévient si la box est coupée.

### c) Jeton de lecture des zones (facultatif)

Il permet au hub de vous **proposer** vos domaines Cloudflare à surveiller ; rien n'est ajouté sans votre accord. Custom token, une seule ligne : Zone > Zone > Read, Zone Resources : Include > All zones. Expiration : un an. Dans le CT : `hubctl secrets veille`.

### d) Lien avec l'ERP (lecture des clients)

Tant que ce lien n'est pas posé, le hub propose des clients d'exemple (« Exemple 01 : boulangerie »...) et le catalogue affiche un bandeau d'information distinct : « Clients de l'ERP pas encore reliés ». Tout le reste du hub fonctionne en vrai. Le hub lit seulement le nom, le numéro et le type de chaque client, jamais son adresse ni ses coordonnées.

L'ERP sert la liste des clients sur un **écouteur dédié, port 3100**, sur l'IP de son CT dans le réseau local, jamais par Internet. Cet écouteur ne s'ouvre que si les trois réglages de l'étape 3 sont posés. Le détail côté ERP est dans `docs/hub-lecture.md` du dépôt KouziaCRM.

1. **Les deux CT ont une IP fixe** (IP statique dans Proxmox, ou réservation DHCP sur la box). Si l'IP de l'un change, le lien s'arrête (l'ERP, lui, continue de fonctionner). Relever les deux IP avec `ip -4 addr` dans chaque CT (côté ERP, aussi `kouziactl summary`, ligne IP LAN). Exemple dans la suite : ERP `192.168.1.20`, hub `192.168.1.30`.
2. Créer une seule fois le secret partagé : `openssl rand -hex 32`, sur l'un des deux CT. La même valeur va dans les deux `.env`, et nulle part ailleurs.
3. Dans le CT de l'ERP, ajouter à `/opt/kouziacrm/.env` :

   ```sh
   HUB_READ_SECRET="le secret de l'étape 2"
   HUB_ALLOWED_IPS="192.168.1.30"
   HUB_LISTEN="192.168.1.20:3100"
   ```

   `HUB_ALLOWED_IPS` : l'IP du CT du hub, seule autorisée à lire. `HUB_LISTEN` : l'IP du CT de l'ERP suivie de `:3100` (`0.0.0.0` est refusé exprès). Sans ces deux lignes, aucun écouteur ne s'ouvre, même avec le secret.
4. **Redémarrer l'ERP** pour qu'il relise son `.env` : `kouziactl restart`, puis `grep "\[hub\]" /var/log/kouzia/app.log | tail -n 3`. La dernière ligne doit dire `lecture par le hub sur 192.168.1.20:3100`. Si elle dit `écouteur non démarré`, la suite de la ligne donne la raison (IP mal recopiée, par exemple).
5. Pare-feu Proxmox, pour que le port 3100 ne soit ouvert qu'au hub :
   1. **Avant tout : Centre de données > Pare-feu > Options.** Si « Pare-feu » est sur « Non », vérifier d'abord que « Politique d'entrée » est sur **ACCEPT**, puis seulement passer « Pare-feu » sur « Oui ». Dans l'autre ordre, l'hôte Proxmox lui-même peut devenir injoignable.
   2. CT de l'ERP > Réseau : modifier la carte `net0` et cocher « Pare-feu ».
   3. CT de l'ERP > Pare-feu > Options : « Politique d'entrée » sur ACCEPT (l'ERP reste joignable comme aujourd'hui), puis « Pare-feu » sur « Oui ».
   4. CT de l'ERP > Pare-feu, deux règles dans cet ordre (la première en haut), « Activer » coché sur les deux : `in`, ACCEPT, source `192.168.1.30`, tcp, port de destination 3100 ; puis `in`, DROP, source vide, tcp, port de destination 3100.
6. Dans le CT du hub : `hubctl secrets erp` : IP du CT de l'ERP (le hub en fait `http://<IP du CT ERP>:3100`), puis le secret (invisible), puis `https://erp.kouzia.com` pour les liens « fiche client ». Le hub redémarre seul.
7. Vérifier : dans le hub, le bandeau « ERP indisponible » disparaît et les clients s'affichent. Depuis le CT du hub, `curl -s -o /dev/null -w "%{http_code}\n" http://192.168.1.20:3100/api/hub/clients` répond `404` (normal : la requête n'est pas signée) ; depuis un autre poste du réseau, la même commande n'obtient aucune réponse.

---

## 3. Notifications sur le téléphone

Les alertes (site en panne, retour en ligne, certificat ou domaine bientôt expiré, hub ou box hors ligne) arrivent en **notification** sur le téléphone, rien par e-mail.

1. Dans le CT : `hubctl push-keys`. **Une seule fois** : ne jamais le refaire, sinon chaque téléphone devrait se réabonner. Si la veille est déjà installée, relancer ensuite `hubctl veille deploy` pour lui donner les clés.
2. Sur le téléphone Android, dans Chrome, ouvrir `https://hub.kouzia.com`, puis Réglages > Notifications > **« Activer sur cet appareil »**, et accepter. Pas besoin d'installer l'application. Sur iPhone, il faut d'abord ajouter le hub à l'écran d'accueil.
3. Même endroit : **« Envoyer une notification de test »** ; elle doit arriver.

Bon à savoir :

- Les notifications demandent une adresse sécurisée (HTTPS). Elles marchent sur `https://hub.kouzia.com` et sur `http://localhost` (ordinateur du développeur), **pas** sur l'adresse du réseau local (`make dev-lan`). Le hub l'explique dans la section dans ce cas.
- Sans clés, la section Notifications le dit et n'affiche pas le bouton. En développement, l'équivalent de `hubctl push-keys` est `npm run push:keys` (options : `-- --env-file .env --subject mailto:contact@kouzia.com`), puis relancer `make dev`.
- Tant qu'aucun appareil n'est abonné, la page Surveillance affiche un bandeau rouge : une panne ne vous serait pas signalée.

---

## 4. Mises à jour, sauvegardes, restauration

### 4.1 Mettre à jour

`hubctl update` (jeton GitHub posé, voir 1.2) fait tout, dans l'ordre : arrêt du hub, **sauvegarde automatique**, récupération du code sur GitHub, **mise à jour du système** (`apk update` puis `apk upgrade` complet, dans la version d'Alpine installée, jamais vers une autre ; paquets listés à l'écran et dans `/var/log/kouziahub/system-upgrade.log`, tunnel relancé, pare-feu reposé si nftables a changé ; `hubctl update --no-system` saute cette étape, que le retour arrière ne défait pas), dépendances seulement si elles ont changé, base de données, interface, redémarrage et contrôle que le hub répond. Si le hub ne répond plus, il propose de revenir en arrière. Plus tard, `hubctl rollback` remet la version d'avant la dernière mise à jour (code et données d'alors).

**Quand la veille Cloudflare change, `hubctl update` le signale : relancer `hubctl veille deploy` avec un nouveau jeton (chapitre 2 b). C'est le cas de cette version** (les requêtes du hub vers la veille sont désormais signées avec leurs paramètres et protégées contre le rejeu ; sans redéploiement, le hub décide seul).

### 4.2 Sauvegardes

- **Chaque nuit**, une sauvegarde complète va dans `/var/backup/kouziahub` : base, fichiers des sites, et fichier `.env` (qui contient les secrets, donc la sauvegarde ne sort jamais du CT telle quelle). Les 14 plus récentes sont gardées.
- `hubctl backup` en fait une tout de suite.
- **Une seule opération à la fois** : mise à jour, restauration, installation et sauvegarde ne se chevauchent jamais. Une commande lancée pendant une autre refuse avec un message ; la sauvegarde de la nuit saute son tour (ligne dans `hubctl logs sauvegarde`).

### 4.3 Copier une sauvegarde hors du CT (chiffrée)

1. Dans le CT : `hubctl backup --export`. La première fois, choisir une phrase de passe (16 caractères au moins) et **la noter dans votre gestionnaire de mots de passe** : sans elle, l'archive ne s'ouvre pas, et si le CT est perdu, elle n'existe plus nulle part ailleurs.
2. Le hub crée `/var/backup/kouziahub/export/kouziahub-<date>.tar.gpg`, chiffrée (GPG, AES256). Il en garde les 3 dernières.
3. Dans le « Shell » du nœud Proxmox : `pct pull <numéro du CT> /var/backup/kouziahub/export/<fichier> /root/<fichier>`, puis copier ce fichier sur le NAS ou le PC.

En plus, la sauvegarde Proxmox du CT (Datacenter > Backup) garde une copie de tout le CT.

### 4.4 Restaurer

| Commande | Effet |
|---|---|
| `hubctl restore` | Liste des sauvegardes, choix par numéro, puis remise en place |
| `hubctl restore <sauvegarde>` | Remet cette sauvegarde (nom du dossier ou chemin) |
| `hubctl restore --check <sauvegarde>` | Vérifie qu'elle est lisible et intacte, sans rien changer |
| `hubctl restore /root/<fichier>.tar.gpg` | Remet une archive exportée (phrase de passe demandée si le CT ne la connaît pas) |

Avant de remplacer quoi que ce soit, la restauration fait une copie de l'état actuel. Si la base remise ne passe pas les migrations, le hub revient seul à l'état d'avant. Sur un CT neuf : `hubctl install`, puis `pct push <numéro du CT> /root/<fichier> /root/<fichier>` depuis le nœud, puis `hubctl restore /root/<fichier>`.

### 4.5 Au quotidien

- `hubctl status` : état du service, santé, migrations, droits des fichiers, réglages (renseigné ou vide, jamais les valeurs), surveillance, disque, dernière sauvegarde, tunnel.
- Dates et montants en français : `hubctl install` et `hubctl update` posent `icu-data-full` (avec `icu-data-en` seul, Node formate en anglais, « € » avant le montant). Au démarrage, le hub vérifie Intl fr-FR et le fuseau Europe/Paris ; un écart sort dans `hubctl logs erreurs`, dans `/api/health` (champ `intl`) et dans `hubctl status`. Les rapports PDF et les notifications n'en dépendent pas : leurs dates, heures de Paris et nombres sont calculés sans Intl (`apps/api/src/lib/fr-format.ts`).
- `hubctl logs erreurs` : dernières erreurs du hub (aussi `app`, `tunnel`, `sauvegarde`).
- Le hub redémarre seul s'il plante (10 fois par minute au plus). Au-delà, `hubctl status` l'indique : lire `hubctl logs erreurs`, puis `hubctl restart`.

---

## 5. Guide d'utilisation, écran par écran

Trois entrées dans le menu : **Sites**, **Surveillance**, **Réglages** (en haut sur ordinateur, en bas sur téléphone).

### 5.1 Sites : le catalogue

- **Compteurs** en tête : En ligne, Hors ligne, En création, En erreur, et « Projets Cloudflare utilisés » (sur 100, la limite gratuite).
- **Bandeau des erreurs** : « 1 site en erreur : une opération a échoué, elle peut être reprise depuis la fiche. », avec un lien qui n'affiche que ces sites.
- **Filtres** : « Type de site » (Tous, Clients, Perso) et « État » (Tous les états, En ligne, Hors ligne, En création, Erreur), chacun avec son nombre ; **recherche** par site ou client.
- **Affichage** : « Cartes » (grandes vignettes) ou « Liste » (tableau Site, Client, État, Surveillance, Version servie, Modifié). Le choix est retenu.
- **Ordre** : toujours la dernière modification d'abord (pas de choix de tri).

### 5.2 Créer un site

Bouton « Nouveau site », une seule fenêtre :

1. « Pour qui ? » : **Client de l'ERP** (recherche par nom ou numéro) ou **Perso** (site sans client, avec l'étiquette « Perso »).
2. **Sous-domaine** : proposé depuis le nom, modifiable (minuscules, chiffres et tirets, 40 caractères au plus). Les noms réservés (`www`, `erp`, `api`, `hub`, `mail`, `admin`...) et ceux déjà pris sont refusés aussitôt.
3. « Créer `<slug>.kouzia.com` ». La fiche s'ouvre et montre les étapes : projet Cloudflare, page d'attente, adresse, DNS, certificat HTTPS. **Le certificat prend quelques minutes** ; l'adresse répond ensuite. Si une étape échoue, « Reprendre » repart d'elle, sans doublon.

La version de travail n'est jamais indexée par les moteurs de recherche, et l'adresse `pages.dev` du projet renvoie vers `<slug>.kouzia.com`.

**Site dynamique (PHP)** : quand le serveur des sites PHP est relié (section 11), la fenêtre propose aussi l'hébergement « PHP ». Voir 11.9.

### 5.3 Fiche d'un site

À droite (en dessous sur téléphone), le panneau **Synthèse** : adresse, client (lien vers sa fiche dans l'ERP), version servie, fichiers de travail, l'interrupteur **« Site accessible »** et, juste dessous, l'interrupteur **« Indexation par les moteurs »**. Puis six onglets : Fichiers, Versions, Surveillance, Vignette, Serveur, Réglages.

**Indexation par les moteurs** (désactivée par défaut, confirmation avant tout changement) : désactivée, le site demande aux moteurs de ne pas l'indexer (en-tête `X-Robots-Tag: noindex, nofollow`, `robots.txt` en `Disallow: /`). Activée, plus d'en-tête `noindex` sur `<client>.kouzia.com` ; le `robots.txt` du site est servi tel quel, sinon un `robots.txt` qui autorise tout, avec la ligne `Sitemap:` si le site contient `sitemap-index.xml` ou `sitemap.xml`. Les adresses `pages.dev` restent redirigées et `noindex`. Le réglage vit dans le déploiement : la version en ligne est republiée aussitôt (une nouvelle version apparaît dans l'onglet Versions). Attention : une règle de transformation Cloudflare qui ajoute `X-Robots-Tag` sur `*.kouzia.com` l'emporterait ; la retirer ou en exclure ce sous-domaine.

**En ligne ou hors ligne.** Couper le site retire son adresse : elle ne répond plus du tout, mais fichiers et versions sont gardés. La remise en ligne prend quelques minutes (nouveau certificat).

### 5.4 Onglet Fichiers : envoyer les fichiers

Les **fichiers de travail** sont votre brouillon, comme sur un FTP : rien ne change en ligne avant « Publier ».

- **Explorateur** : parcourir les dossiers, « Ajouter des fichiers », « Ajouter un dossier » (sur ordinateur), glisser-déposer, et pour chaque ligne Télécharger, Renommer, Supprimer. Un fichier du même nom est remplacé.
- **Zip** : « Envoyer le site entier (zip) », 500 Mio au plus, en mode « Remplacer tout » ou « Fusionner ». Un zip qui contient un seul dossier est remis à la racine.
- **Écartés d'office**, avec la raison affichée et sans exception possible : dossiers de développement (`node_modules`, `.git`, `.next`, `.vscode`, `.idea`, `.claude`, `.cursor`...), fichiers `.env`, fichiers du dépôt (`.gitignore`, `.gitattributes`, `.gitmodules`, `README` sous toutes ses formes : `README`, `README.md`, `readme.txt`...), cartes de sources `.map`, sauvegardes, et `_worker.js`, `_routes.json`, `functions/` (seul le hub place du code chez Cloudflare). Plus de 25 Mio par fichier : refusé (limite de Cloudflare).
- **Fichiers utilisés mais refusés** : après l'envoi, le hub relit les pages HTML et les feuilles de style reçues. Si l'une d'elles utilise un fichier refusé (une image sous `src/` pour un site en HTML simple), le compte rendu le dit en tête : « index.html utilise src/branding/Logo-blanc.png, refusé : le site sera cassé ». Pour `src/` et l'outillage, ajouter le chemin exact de chaque fichier en exception dans l'onglet Serveur, ou envoyer le site construit ; `.env`, `.git` et les dossiers de développement ne sont jamais servis, même par exception.
- **Code serveur (PHP, Python, Ruby...)** : la version de travail est statique, ce code n'y tourne pas. Les fichiers restent dans les fichiers de travail (un `contact.php` sert pour la version de production, chez un hébergeur PHP), mais ne sont jamais publiés sur Cloudflare (leur code source serait lisible) et répondent 403. Une application entière (un `index.php` sans `index.html` à la racine, `composer.json`...) est signalée en tête du compte rendu : « Site dynamique (PHP) : il ne peut pas fonctionner sur l'hébergement statique du hub ». `composer.json` et `composer.lock` comptent parmi les fichiers de développement.
- **Dossier de projet reconnu** : si vous déposez les sources d'un site avec son résultat construit (`dist/`, `build/` ou `out/`), le hub propose « Envoyer seulement dist/ ».
- **Envoi par morceaux** : les gros envois partent en morceaux de 8 Mio. Si la connexion coupe, un bandeau propose « Reprendre cet envoi » : choisir à nouveau exactement les mêmes fichiers, seuls les morceaux manquants repartent.
- **Publier** : la barre « Modifications non publiées » propose une note de version puis « Publier la version N ». Il faut un `index.html` à la racine.
- **Envoyer le site construit, pas le projet** : pour un site Astro, Vite, Next.js, Hugo... le hub n'envoie que des fichiers et ne construit rien. Lancez la construction sur votre PC (`npm run build` le plus souvent) et envoyez le **contenu** du dossier produit (`dist/` pour Astro et Vite, `out/` pour Next.js, `public/` pour Hugo). Si vous envoyez le projet entier, le hub le reconnaît, affiche la commande et le dossier à envoyer, et bloque la publication. « Publier quand même » reste possible après confirmation, pour un site statique dont l'accueil n'est volontairement pas à la racine.
- **Envoyer un site complet sur des fichiers existants** : quand un dossier entier (ou un zip) arrive à la racine et que la version de travail contient déjà des fichiers, le hub demande « Remplacer tout le contenu » (proposé par défaut : rien de l'ancien ne reste, le contenu du dossier devient la racine du site) ou « Ajouter et remplacer les fichiers en double » (les anciens fichiers restent, le dossier garde son nom). Il dit avant combien de fichiers actuels seront retirés. Le `.htaccess` généré par le hub est gardé. L'ajout fichier par fichier dans l'explorateur ne change pas.
- **Fichiers de développement** : `package.json`, verrous (`package-lock.json`, `yarn.lock`...), `tsconfig*.json`, configuration de build (`vite.config.*`, `astro.config.*`, `*.config.js` à la racine...), `Dockerfile`, `Makefile`, `.npmrc`, `.nvmrc`, `.editorconfig` et le dossier `src/` à la racine ne sont jamais envoyés, jamais déployés et refusés (403) par la version de travail. Si un projet non construit est choisi, le hub le dit avant l'envoi. Un reste d'un ancien envoi est signalé dans l'onglet Fichiers, avec « Nettoyer » (après confirmation). Un site qui sert vraiment l'un de ces fichiers l'autorise dans l'onglet Serveur (Règles du site).

### 5.5 Onglet Versions

Chaque publication crée une version, gardée et republiable (les 10 dernières par site ; au-delà, les plus anciennes sont purgées). Menu de chaque version :

- **« Republier cette version »** : l'adresse la sert de nouveau, dans une minute environ ; les fichiers de travail ne changent pas ;
- **« Restaurer dans les fichiers de travail »** : vos fichiers de travail redeviennent ceux de cette version ; rien ne change en ligne avant de publier ;
- **« Télécharger la version de production »** : voir 5.9.

### 5.6 Onglets Vignette et Serveur

- **Vignette** : capture automatique de l'accueil à chaque publication (si Chromium est installé, au format du cadre 16:10, donc jamais recadrée), « Reprendre la capture », ou « Envoyer une image » (PNG, JPEG ou WebP, 10 Mo au plus, gardée entière). **Point d'intérêt** : neuf positions, de « En haut à gauche » à « En bas à droite » (« En haut au centre » par défaut) ; le cadre de la carte montre la partie de l'image autour de ce point. L'aperçu suit le choix, « Enregistrer le cadrage » l'applique au catalogue.
- **Serveur** : le **profil** du site, qui prépare l'hébergement final : domaine final (celui acheté pour le client), adresse principale avec ou sans `www`, page 404. Le hub en tire :
  - le fichier `.htaccess` (HTTPS obligatoire, une seule adresse, sécurité, cache, page 404) ; s'il a été **modifié à la main**, le hub ne l'écrase plus, et « Régénérer » le remplace après confirmation ;
  - **le `.htaccess` ne s'applique pas sur la version de travail** : Cloudflare Pages l'ignore. `<client>.kouzia.com` est protégé par le `_worker.js` et le `_headers` du hub (noindex, en-têtes de sécurité, 403 sur les fichiers cachés et de développement, redirection des adresses `pages.dev`). Le `.htaccess` sert à l'hébergement final chez Hostinger, dans la version de production (onglet Versions) ;
  - généré par le hub, il **suit le contenu publié** : il est régénéré à chaque publication d'après les fichiers présents (page 404, dossiers de fichiers hashés comme `_astro/` ou `assets/`, sitemap). Ce qui dépend d'une donnée absente (domaine final, page 404) y est commenté « À compléter », jamais écrit faux. Modifié à la main, il n'est pas touché, et l'onglet signale « la configuration générée a changé : régénérer ? » ;
  - la configuration de Cloudflare Pages (aperçu en lecture seule) ;
  - **Règles du site** : exceptions aux fichiers de développement refusés (chemins exacts, 50 au plus, ni dossier ni joker), et « CSP du site » facultative, sur une ligne. Sans elle, la version de travail reçoit une CSP minimale qui ne casse rien (`frame-ancestors 'self'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests`) et l'export la CSP par défaut du hub. Renseignée, chacune de ses directives s'y ajoute ou remplace la même directive, sauf `frame-ancestors` et `object-src`, toujours imposées. S'applique à la prochaine publication ;
  - **« Vider le cache Cloudflare »** : en temps normal inutile (une publication sert déjà les nouveaux fichiers). Utile si un ancien fichier reste affiché. Limite Cloudflare : 5 vidages par minute.

### 5.7 Surveillance

**Ce qui est contrôlé** : chaque adresse toutes les 5 minutes, par le hub et par la veille Cloudflare ; une fois par jour le certificat, l'échéance du domaine, le DNS et le contenu de l'accueil ; une fois par semaine la vitesse sur téléphone (si Chromium est installé).

**Ce qui est surveillé** : chaque site du hub une fois en ligne (sa version de travail, et son domaine final dès qu'il est renseigné dans l'onglet Serveur), les domaines ajoutés à la main, les domaines Cloudflare acceptés.

**Page Surveillance** (vue de tout) : compteurs, état des points de contrôle et des notifications (avec une « Marche à suivre »), « Adresses surveillées » (les plus graves d'abord), « Domaines Cloudflare proposés » (« Surveiller <domaine> »), « Incidents récents ».

- **Domaine hébergé ailleurs (Hostinger)** : « Ajouter un domaine » : adresse (`https://...`), nom affiché, client de l'ERP (facultatif), mot-clé à trouver dans la page (facultatif : une panne est signalée s'il disparaît). Pas de jeton Hostinger.
- **Onglet Surveillance d'un site** : une carte par adresse, avec l'interrupteur **« Surveillé »**, le dernier contrôle du hub et de Cloudflare, la disponibilité sur 24 h et 30 jours, le certificat, le domaine, la vitesse, le DNS, le contenu, l'historique sur 30 jours, les incidents et les rapports.
- **« Contrôler maintenant »** relance tout de suite les contrôles d'une adresse.
- **Références DNS et contenu** : le hub compare le DNS et la page d'accueil à une référence. Après un changement voulu, « Accepter comme nouvelle référence ». Une publication par le hub recale la référence du contenu toute seule.

**Ce que veulent dire les états :**

| Affiché | Signification | Alerte |
|---|---|---|
| En ligne | Le site répond | non |
| En panne | Le hub **et** Cloudflare échouent deux fois de suite | oui, puis au retour (avec la durée), rappel à 24 h ; au-delà de 3 sites en même temps, une seule alerte groupée |
| Problème local | Le hub n'arrive pas à joindre le site, Cloudflare oui : box ou DNS local | non |
| Vu par Cloudflare seulement | Le hub joint le site, Cloudflare non : à surveiller | non |
| Pas encore contrôlé | Aucun contrôle n'a encore répondu | non |
| « vu par le hub seul » / « vu par Cloudflare seul » | Précision du verdict quand l'autre point de contrôle se tait | selon le verdict |

Autres alertes : certificat ou domaine qui expire (à 30, 14 et 7 jours), certificat invalide, DNS ou accueil modifié, « Hub hors ligne » si le hub (ou la box) se tait plus de 15 minutes, puis son retour, et « Surveillance Cloudflare interrompue » si c'est la veille qui se tait.

### 5.8 Rapport mensuel (PDF)

Dans l'onglet Surveillance d'un site (ou la page d'une adresse), rubrique « Rapports mensuels » : un lien par mois, par exemple « Octobre 2026 » (« en cours » pour le mois actuel). Le PDF reprend disponibilité, incidents, certificat et domaine, vitesse, DNS et contenu, sans aucune donnée personnelle. **Le télécharger, puis l'envoyer au client depuis l'ERP** avec votre message habituel : le hub n'envoie rien lui-même.

### 5.9 Version de production (mise en ligne chez l'hébergeur final)

Onglet Versions > « Télécharger la version de production ». La mise en ligne sur le domaine du client reste faite par vous, à la main.

1. Choisir l'hébergement final : **Hostinger** (avec le `.htaccess`) ou **Cloudflare Pages** (avec `_headers` et `_redirects`).
2. Lire le **résumé** : nombre de fichiers, taille, adresse principale, puis les écarts rangés en « À corriger avant la mise en ligne », « À vérifier », « Pour information » (par exemple un `robots.txt` qui bloquerait tout, une balise `noindex` restée, un titre ou une description absents).
3. « Télécharger le zip ». Il contient les fichiers de la version, sans rien de développement (notes Markdown, fichiers de projet, fichiers cachés), plus :
   - le `.htaccess` (Hostinger) ou `_headers` et `_redirects` (Pages) ;
   - une page 404 si elle manquait ;
   - `robots.txt` qui autorise les moteurs de recherche, avec la ligne du sitemap ;
   - `sitemap.xml` (la liste des pages pour Google), seulement si le domaine final est renseigné dans l'onglet Serveur ;
   - `LISEZMOI.txt` : où déposer les fichiers, ce que fait le `.htaccess`, et la liste à vérifier après la mise en ligne (HTTPS, redirection www, page 404, sitemap à déclarer dans la Google Search Console).

### 5.10 Onglet Réglages du site, et suppression

- Libellé du site, client lié (changer, ou lier un site perso à un client).
- **Vider les fichiers de travail** : retire tous les fichiers de l'onglet Fichiers ; le site en ligne et les versions restent. Case « Supprimer aussi les anciennes versions » (la version en ligne est toujours gardée ; saisie du sous-domaine demandée). Le `.htaccess` part aussi : le recréer dans l'onglet Serveur.
- **Supprimer le site** : saisir le sous-domaine pour confirmer. L'adresse cesse de répondre, le projet Cloudflare est retiré, fichiers et versions sont supprimés. Définitif.

### 5.11 Logiciels : clés de licence

Menu **Logiciels** : le catalogue des logiciels vendus sous licence, présenté comme celui des sites (cartes avec vignette, état, licences en cours et prochaine expiration ; recherche, filtre d'état, vue Cartes ou Liste). Le hub signe les clés de licence (Ed25519) ; chaque logiciel les vérifie hors ligne avec sa clé publique. Tracebay garde son format TB1 ; un logiciel ajouté signe au format générique KZ1, avec son propre préfixe et son identifiant signé. Détail du format et des règles : `docs/licences-logiciels.md`.

- **Nouveau logiciel** : nom, identifiant (proposé depuis le nom, il ne change plus), préfixe des clés (proposé, `TB1` réservé, il ne change plus), description, lien de démo ou de site et page des versions publiées, facultatifs. Ensuite, sur le serveur : `hubctl licence-keygen <identifiant>` crée sa clé de signature (jamais depuis l'interface).
- **Fiche** : onglets **Licences** (ci-dessous), **Vignette** (image envoyée, gardée entière ; « Logo ou icône (entier, centré) » par défaut, sur fond neutre ou sur la couleur du logo assombrie, ou « Capture d'écran (remplit le cadre) », avec un aperçu en direct ; une image envoyée avant ce réglage, déjà recadrée, est à renvoyer) et **Réglages** (nom, description, liens ; suppression seulement si aucune clé n'a été émise, jamais Tracebay). La synthèse montre l'identifiant, le format, l'état de la clé de signature, les liens et la clé publique à copier dans le logiciel.

- **Liste** : entreprise, client de l'ERP, émission, expiration et état (valide, expire bientôt à 30 jours ou moins, expirée), filtres par état et recherche sans accents.
- **Nouvelle clé** : client de l'ERP facultatif (il propose le nom), nom de l'entreprise (écrit dans la clé et imposé sur les documents : il ne se modifie plus), durée de 1 à 36 mois (12 par défaut) ou une date de fin, contact et notes facultatifs (chiffrés sur le hub, jamais dans la clé), aperçu, puis la clé avec « Copier la clé ».
- **Détail d'une clé** : la clé à copier, le client, le contact et les notes (modifiables), l'historique des clés du même client ou de la même entreprise, le lien vers le journal des clés. Pour changer le nom ou la date : **Renouveler** (nouvelle clé préremplie) ; l'ancienne reste valable jusqu'à son expiration. Il n'y a ni révocation ni suppression.
- Sans clé de signature sur le serveur, la liste reste lisible et l'émission est refusée : lancer `hubctl licence-keygen <identifiant>` (section 10).

### 5.12 Réglages (du hub)

| Section | Contenu |
|---|---|
| Sécurité | Double authentification, codes de secours restants, « Régénérer les codes de secours » |
| Notifications | « Activer sur cet appareil », notification de test, appareils abonnés (« Retirer ») |
| Contrôles | Cloudflare réel ou simulé, projets utilisés, ERP joignable, vignettes ; **orphelins** (enregistrement DNS, projet ou site sans correspondance) avec « Vérifier maintenant » |
| Stockage | Place utilisée (par site et en tout) ; « Libérer de la place » : envois en cours, fichiers temporaires, vignettes capturées, fichiers orphelins. Les fichiers des sites et leurs versions n'y sont jamais touchés (voir 5.10) |
| Journal | Toutes les actions, avec date, site, résultat et détail |

---

## 6. Limites de l'offre gratuite de Cloudflare

| Élément | Limite | Effet dans le hub |
|---|---|---|
| Projets Pages | 100 par compte | Compteur dans le catalogue ; supprimer d'anciens sites avant d'en créer d'autres |
| Fichiers par site | 20 000 | Au-delà, l'envoi est refusé |
| Taille d'un fichier | 25 Mio | Fichier refusé avec la raison |
| Taille d'une version | 500 Mio (zip compris) | Limite du hub |
| Requête par le tunnel | 100 Mo | D'où l'envoi par morceaux de 8 Mio |
| Purges du cache | 5 par minute | « réessayez dans une minute » |
| Requêtes Workers et Pages Functions | 100 000 par jour pour tout le compte | Partagées entre la veille et les sites |
| Worker | 10 ms de calcul par passage, 50 requêtes sortantes, 6 à la fois | La veille contrôle un cinquième des adresses chaque minute (200 au plus), 4 notifications par passage, le reste à la minute suivante |
| D1 | 100 000 lignes écrites et 5 millions lues par jour | La veille n'écrit que les changements |
| Nouveau compte | Création de projets restreinte les 48 premières heures | |

---

## 7. Sécurité du CT

### 7.1 Droits des fichiers

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
| `/etc/kouziahub` (`tunnel.token`, `backup-pass`, `github-token`, `nftables.nft`) | root:kouziahub | 710 (le service traverse sans lister) ; fichiers root 600 | root | root |
| `/etc/kouziahub/<identifiant>-ed25519.pem` (Tracebay : `tracebay-ed25519.pem`) | root:kouziahub | 640 | root (`hubctl licence-keygen <identifiant>`, une fois par logiciel, jamais remplacée) | service : lit (signe les licences de ce logiciel). Hors des sauvegardes du hub : copie chiffrée à faire à part |
| `/var/backup/kouziahub` (et `export/`) | root:root | 700 ; fichiers 600 | root | root |
| `/etc/doas.d/kouziahub-chromium.conf` | root:root | 400 | root | doas |
| `/var/lib/kouziahub-chromium` | kouziahub-chromium | 700 | Chromium (profils jetables) | Chromium |
| `/run/kouziahub-ops.lock` | root | 600 | root (verrou des opérations) | root |

Si `hubctl update` s'arrête sur « configuration git inattendue » : le dépôt a pu être modifié par le compte du service avant cette protection. Le refaire : `mv /opt/kouziahub/.git /root/git-suspect`, puis `git clone --depth 1 https://github.com/K0uzia/KouziaHub.git /root/hub-neuf && mv /root/hub-neuf/.git /opt/kouziahub/.git`, puis `hubctl update`.

Si une commande s'arrête sur « Une autre opération du hub est en cours » alors que rien ne tourne : le message (et `hubctl status`, ligne « Verrou des opérations ») donne le processus qui tient `/run/kouziahub-ops.lock`. Une opération `hubctl` : attendre la fin. Un service (avant ce correctif, un service démarré pendant une opération héritait du verrou) : le relancer depuis un shell neuf, par exemple `rc-service kouziahub restart`, puis relancer la commande. Ne jamais supprimer le fichier du verrou : le processus le garderait quand même.

### 7.2 Chromium isolé et son pare-feu

Chromium (vignettes, mesure de vitesse) ne tourne pas sous le compte du service mais sous un compte à lui, `kouziahub-chromium`, sans accès au `.env` ni aux données. Le hub le lance par `/usr/local/lib/kouziahub/chromium-launch`, qui passe par `doas` (outil qui permet de lancer une commande sous un autre compte) avec une seule règle : cette commande, vers ce compte, rien d'autre. Sans ce compte dédié, la mesure de vitesse reste désactivée.

Sa sortie réseau est filtrée par le pare-feu du CT (nftables, table `inet kouziahub`, posée par `hubctl chromium`, `hubctl install`, `hubctl update` et au démarrage) : il ne peut joindre ni la box, ni le réseau local, ni l'ERP, ni les autres services du CT. Seuls le serveur local des vignettes et les DNS du CT lui restent ouverts. Le hub, lui, joint toujours l'ERP (port 3100) et Cloudflare. `hubctl status` indique si la règle est posée.

**Repli si le CT refuse ce pare-feu** (possible sur un CT non privilégié ; `hubctl chromium` le dit) : poser la règle dans Proxmox. Elle s'applique alors à tout le CT, d'où les exceptions :

1. Datacenter > Firewall > Options : vérifier « Input Policy » avant d'activer « Firewall » (le laisser à ACCEPT si vous n'êtes pas sûr), puis Firewall : Yes.
2. CT `kouziahub` > Network > `net0` > Edit : cocher « Firewall ».
3. CT `kouziahub` > Firewall > Add, dans cet ordre (direction « out ») :
   - ACCEPT, protocole tcp, destination l'IP du CT de l'ERP, port de destination 3100 ;
   - ACCEPT, protocole udp, destination l'IP de la box (ses DNS), port 53 ; puis la même en tcp ;
   - DROP, destination `10.0.0.0/8` ; puis `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16` (une règle chacune).
4. CT `kouziahub` > Firewall > Options : Firewall : Yes. Laisser « Output Policy » à ACCEPT (Cloudflare et Internet restent joignables).
5. Vérifier : `hubctl status` (le hub répond) et, dans le hub, une vignette se crée.

---

## 8. Points encore à valider en réel

Testés contre des simulations, pas encore sur le vrai compte ni le vrai CT :

| Point | À vérifier |
|---|---|
| Envoi direct à Cloudflare Pages et `_worker.js` | Publication d'une vraie version (une partie de l'API n'est pas documentée par Cloudflare) |
| Réglage « fail closed » des projets | Le champ `fail_open` est bien refusé à `false` ; le hub l'indique sinon (« réglage fail closed non appliqué ») |
| Vidage du cache | Purge de la zone pour une adresse servie par Pages (un refus « code 1092 » est possible) |
| Veille Cloudflare | Calcul consommé par passage (sous 10 ms), format exact du déploiement (script, secrets, D1, workers.dev), délai réel de la tâche de chaque minute, contrôle d'un site du même compte |
| Pare-feu de Chromium | nftables et le filtre par compte dans un CT non privilégié (sinon repli Proxmox, 7.2) |
| Chromium par doas | Lancement par Playwright à travers doas (communication par descripteurs) |
| Notifications | Réception sur un vrai téléphone Android, par le hub et par la veille |
| Version de production | Mise en ligne réelle chez Hostinger (`.htaccess`), et sitemap accepté dans la Google Search Console |
| Exploitation | Première migration des droits par `hubctl update`, export et restauration GPG |
| CT des sites PHP | Scripts `kouziaphpctl` jamais lancés sur une vraie Alpine (contrôlés par shellcheck) ; limites par site par cgroups dans un CT non privilégié (`kouziaphpctl cgroups`) ; nom d'hôte `*` accepté par le tableau de bord du tunnel ; pare-feu nftables par compte dans ce CT |

---

## 9. Développement (PC)

Prérequis : Node.js 22.23.4, 24.22.1 ou 26.12.1 au moins (correctif de sécurité du 21/10/2026 ; `hubctl status` alerte sur le CT si Node est en retard, `hubctl update` le met à jour par apk), GNU make (Windows : `choco install make`).

```sh
make setup   # .env de dev (secrets aléatoires, Access coupé, Cloudflare et ERP simulés), dépendances, base, compte
make dev     # API http://127.0.0.1:3101 et interface http://localhost:5174
```

- `make dev-lan` : ouvre l'interface au téléphone du réseau local (sans notifications, faute de HTTPS).
- `make test` (tests de l'API et de la veille), `make typecheck`, `make build`.
- Veille : code dans `workers/veille/` ; `npm run veille:build` produit `workers/veille/dist/index.js` (non versionné), `npm run veille:deploy` déploie depuis le PC comme `hubctl veille deploy`.
- Copier le code vers le CT sans GitHub (rsync et ssh sur le PC) : `make alpine-deploy HOST=root@<IP du CT>` ; état à distance : `make alpine-status HOST=root@<IP du CT>`.
- Variables du `.env` : `.env.example` (sans valeurs). Scripts du CT : `scripts/alpine/`.
- Centrage des écrans : avec `make dev` lancé, `BASE=http://localhost:5174 EMAIL=<compte local> PASSWORD=<son mot de passe> npm run check:layout`. Le script parcourt les écrans principaux à 360, 800, 1280, 1920 et 2560 px, affiche le tableau des marges de l'en-tête et du contenu, et échoue si les marges gauche et droite diffèrent de plus de 1 px ou si la page défile en largeur. Compte local sans double authentification ; `SHOTS=<dossier>` garde des captures. Il n'est pas lancé par `npm test` (il lui faut une pile qui tourne).

---

## 10. Toutes les commandes hubctl

`hubctl` seul ouvre un menu qui reprend ces commandes.

| Commande | Effet |
|---|---|
| `hubctl install` | Installer ou réparer (rejouable, garde `.env` et données ; sauvegarde avant si des données existent) |
| `hubctl update` | Mettre à jour (sauvegarde avant, retour arrière proposé si souci) ; `--no-git` après une copie par rsync, `--force` pour réinstaller les dépendances |
| `hubctl rollback` | Revenir à la version d'avant la dernière mise à jour |
| `hubctl status` | État complet |
| `hubctl logs [app\|erreurs\|tunnel\|sauvegarde] [lignes]` | Journaux |
| `hubctl start`, `stop`, `restart` | Démarrer, arrêter, redémarrer le hub |
| `hubctl backup` | Sauvegarder maintenant |
| `hubctl backup --export [sauvegarde]` | Archive chiffrée à copier hors du CT |
| `hubctl restore [...]` | Restaurer (voir 4.4) |
| `hubctl cloudflare` | Jeton du tunnel |
| `hubctl secrets access` | Cloudflare Access, facultatif (domaine d'équipe, AUD) |
| `hubctl secrets api` | Jeton API du hub, Account ID, Zone ID |
| `hubctl secrets erp` | Lien avec l'ERP |
| `hubctl secrets veille` | Jeton de lecture des zones |
| `hubctl secrets github` | Jeton GitHub en lecture seule (dépôt privé, nécessaire à `hubctl update`) |
| `hubctl licence-keygen <identifiant>` | Clé de signature des licences d'un logiciel : créée seulement si elle est absente (jamais remplacée), pose `LICENSE_KEY_DIR` dans le `.env` (pour Tracebay : `TRACEBAY_LICENSE_KEY_FILE`), affiche la clé publique. `--public` : réaffiche la clé publique |
| `hubctl tracebay-keygen` | Même chose que `hubctl licence-keygen tracebay` |
| `hubctl chromium` | Installer Chromium (compte dédié et pare-feu) |
| `hubctl admin` | Créer le compte ou changer le mot de passe, puis double authentification |
| `hubctl 2fa-reset` | Couper la double authentification (téléphone perdu), puis `hubctl admin` |
| `hubctl push-keys [mailto:adresse]` | Créer les clés des notifications (une seule fois) |
| `hubctl veille deploy` | Installer ou mettre à jour la veille Cloudflare (jeton demandé, jamais gardé) |
| `hubctl secrets php` | Agent du CT des sites PHP : IP et secret partagé (section 11.8) |

---

## 11. CT des sites PHP (lot P1)

Les sites PHP (MyTakumi d'abord) tournent dans un CT à eux, **kouziaphp**, sur le même Proxmox, séparé du hub et de l'ERP : le code des clients ne tourne jamais à côté du jeton Cloudflare ni des clés de licence. Cadrage complet : `docs/cadrage.md`, section 11. Ce lot installe le CT (nginx, PHP 8.3, MariaDB, pare-feu, tunnel) ; la création des sites depuis le hub vient aux lots suivants.

Toutes les commandes ci-dessous se tapent dans le **« Shell » du nœud Proxmox** (sauf mention), en remplaçant les valeurs d'exemple. Prérequis : le hub est à jour (`hubctl update`), car c'est lui qui fournit les scripts.

### 11.1 Valeurs à choisir

```sh
CTID=120                 # numéro libre pour le nouveau CT
IP=192.168.1.40/24       # IP fixe du CT PHP (hors de la plage DHCP de la box)
GW=192.168.1.1           # passerelle (la box), qui sert aussi de DNS
HUB=110                  # numéro du CT du hub
HUB_IP=192.168.1.30      # IP du CT du hub
STOCKAGE=local-lvm       # même stockage que les autres CT : pct config $HUB | grep rootfs
```

Ces variables ne vivent que dans la fenêtre du Shell : tout faire dans la même fenêtre, ou les retaper.

### 11.2 Créer le CT

```sh
pveam update
pveam available --section system | grep alpine
```

Repérer le modèle Alpine 3.22 ou plus récent (ex. `alpine-3.22-default_20250617_amd64.tar.xz`), puis :

```sh
MODELE=alpine-3.22-default_20250617_amd64.tar.xz     # le nom exact lu juste au-dessus
pveam download local $MODELE
pct create $CTID local:vztmpl/$MODELE --hostname kouziaphp --unprivileged 1 --features nesting=0 \
  --cores 2 --memory 2048 --swap 512 --rootfs $STOCKAGE:30 \
  --net0 name=eth0,bridge=vmbr0,ip=$IP,gw=$GW,firewall=1 \
  --nameserver $GW --onboot 1 --ostype alpine
pct start $CTID
pct exec $CTID -- passwd
```

`passwd` demande le mot de passe root du CT (à garder dans le gestionnaire de mots de passe). Le CT est **non privilégié** et sans imbrication : c'est la première protection si un site était détourné.

### 11.3 Pare-feu Proxmox du CT

C'est la protection principale : le CT ne peut pas la retirer, même en root. Le CT ne joint ni la box, ni le NAS, ni l'ERP, ni le hub, et n'envoie aucun e-mail ; seul le hub peut le joindre (port de l'agent, lot P2).

1. Le pare-feu doit être actif au niveau du centre de données (déjà fait pour l'ERP, section 2 d) étape 5.1 ; sinon suivre cette étape d'abord, dans cet ordre).
2. Puis :

```sh
cat > /etc/pve/firewall/$CTID.fw <<EOF
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT

[RULES]
IN ACCEPT -source $HUB_IP -p tcp -dport 8790 # agent des sites PHP (lot P2), hub seul
OUT ACCEPT -dest $GW -p udp -dport 53 # DNS
OUT ACCEPT -dest $GW -p tcp -dport 53 # DNS
OUT DROP -dest 10.0.0.0/8 # réseau local
OUT DROP -dest 172.16.0.0/12 # réseau local
OUT DROP -dest 192.168.0.0/16 # réseau local
OUT DROP -dest 100.64.0.0/10 # réseau local
OUT DROP -dest 169.254.0.0/16 # réseau local
OUT DROP -p tcp -dport 25 # SMTP : e-mails capturés, jamais envoyés
OUT DROP -p tcp -dport 465 # SMTP
OUT DROP -p tcp -dport 587 # SMTP
EOF
pve-firewall compile > /dev/null && echo "Règles acceptées"
```

Les règles se lisent de haut en bas, la première qui correspond s'applique : le DNS vers la box passe avant le refus du réseau local. Si le DNS du CT n'est pas la box, remplacer `$GW` dans les deux lignes DNS. L'interface Proxmox montre ces règles dans CT `kouziaphp` > Pare-feu.

**Vérifier** (toujours depuis le Shell du nœud) :

```sh
pct exec $CTID -- sh -c "wget -q -T 5 -O /dev/null http://$GW && echo 'ERREUR : la box répond' || echo 'OK : réseau local fermé'"
pct exec $CTID -- sh -c "nc -w 5 smtp.gmail.com 587 < /dev/null && echo 'ERREUR : SMTP ouvert' || echo 'OK : SMTP fermé'"
pct exec $CTID -- sh -c "wget -S -T 10 -O /dev/null https://api.stripe.com/v1/charges 2>&1 | grep 'HTTP/'"
```

La troisième doit afficher `HTTP/1.1 401 Unauthorized` : Stripe répond (paiements de test possibles), il demande seulement une clé.

### 11.4 Tunnel Cloudflare « kouziaphp »

Un tunnel à lui, distinct de ceux du hub et de l'ERP.

1. Cloudflare > **Zero Trust > Réseaux > Tunnels > Créer un tunnel** > **Cloudflared**, nom `kouziaphp`.
2. À l'étape « Installer et lancer un connecteur », copier la commande affichée (elle contient le jeton). Ne pas la lancer ailleurs : elle se colle à l'étape 11.5.
3. Étape « Routage » (nom d'hôte public / route publiée) : sous-domaine `*`, domaine `kouzia.com`, service **HTTP**, URL `localhost:8080`. Enregistrer.
4. **Cloudflare > kouzia.com > DNS > Enregistrements** : si un enregistrement `*` (CNAME vers `...cfargotunnel.com`) a été créé à l'étape 3, **le supprimer**. Sinon toutes les adresses inconnues en `.kouzia.com` arriveraient sur ce CT ; le hub créera lui-même un enregistrement par site PHP (lot P3).

Si le tableau de bord refuse `*` à l'étape 3, ne rien inventer : me le dire, le lot P3 posera chaque nom autrement.

### 11.5 Installer

Les scripts sont pris dans le CT du hub (aucun jeton GitHub dans le CT PHP) :

```sh
pct exec $HUB -- tar -C /opt/kouziahub/scripts -czf /tmp/php-ct.tgz php-ct
pct pull $HUB /tmp/php-ct.tgz /root/php-ct.tgz
pct exec $HUB -- rm -f /tmp/php-ct.tgz
pct push $CTID /root/php-ct.tgz /root/php-ct.tgz
pct exec $CTID -- sh -c 'tar -xzf /root/php-ct.tgz -C /root && sh /root/php-ct/install.sh'
```

L'installation pose nginx (écoute locale seulement), PHP 8.3 et ses extensions, MariaDB (socket local seulement), le pare-feu du CT pour les comptes des sites, l'outil `kouziaphpctl`, puis contrôle les limites par site et affiche l'état.

Ensuite, dans le CT (`pct enter $CTID`) :

```sh
kouziaphpctl tunnel      # coller la commande copiée en 11.4 (rien ne s'affiche)
kouziaphpctl upgrade     # premières mises à jour de sécurité
kouziaphpctl status
```

Dans Cloudflare, le tunnel `kouziaphp` doit passer **« Sain »**.

### 11.6 Me renvoyer

Copier la sortie de ces deux commandes, dans le CT :

```sh
kouziaphpctl cgroups
kouziaphpctl status
```

`cgroups` dit si les limites CPU, mémoire et processus **par site** fonctionnent dans ce CT : il lance un service d'essai borné, vérifie que les limites sont posées, puis qu'elles agissent vraiment (un processus qui dépasse la mémoire est arrêté, un trop-plein de processus est refusé). Si ce n'est pas le cas, les limites de PHP et celles du CT restent en place, et la suite se décide avec ce résultat.

### 11.7 Au quotidien

| Commande (dans le CT) | Rôle |
|---|---|
| `kouziaphpctl upgrade` | Mises à jour de sécurité (une fois par semaine) : paquets de la version d'Alpine installée, vérification de nginx, redémarrage des services touchés. `status` alerte après 14 jours sans mise à jour |
| `kouziaphpctl status` | État du CT |
| `kouziaphpctl install` | Réparer ou rejouer l'installation (rien n'est remplacé qui marche) |
| `kouziaphpctl firewall` | Reposer le pare-feu du CT |
| `kouziaphpctl cgroups` | Contrôler les limites par site |
| `kouziaphpctl tunnel` | Changer le jeton du tunnel |
| `kouziaphpctl agent` | Régler l'agent : IP du hub et secret, lus sur l'entrée (11.8) |

**Mettre à jour les scripts** du CT PHP après une mise à jour du hub : refaire les cinq commandes de 11.5 (l'installation est rejouable).

### 11.8 Relier le hub à l'agent (lot P2)

Le hub pilote le CT PHP par son **agent** : port 8790, ouvert au seul CT du hub par le pare-feu de 11.3. Chaque requête est signée par un secret partagé, avec un horodatage et un numéro à usage unique ; l'agent signe aussi ses réponses. Le hub doit être à jour (`hubctl update`) et les scripts du CT PHP aussi (11.5).

Le secret est créé dans le Shell du nœud Proxmox et posé dans les deux CT **sans jamais s'afficher** (même fenêtre que 11.1, pour les variables) :

```sh
SECRET=$(openssl rand -hex 32)
printf '%s\n%s\n' "$HUB_IP" "$SECRET" | pct exec $CTID -- kouziaphpctl agent
printf '%s\n%s\n' "${IP%/*}" "$SECRET" | pct exec $HUB -- hubctl secrets php
unset SECRET
```

La première ligne règle l'agent (IP du hub seule autorisée, secret), la deuxième donne au hub l'adresse du CT PHP et le même secret ; le hub redémarre seul.

**Vérifier** :

1. Dans le hub : Réglages > **Serveur des sites PHP** passe à « Configuré » et affiche PHP 8.3, les services, les limites par site et la date des mises à jour.
2. Depuis le Shell du nœud : `pct exec $HUB -- wget -S -O /dev/null http://${IP%/*}:8790/v1/etat 2>&1 | grep HTTP/` affiche `HTTP/1.1 401 Unauthorized` : l'agent répond au hub, mais refuse une requête non signée.
3. Depuis un autre poste du réseau, la même adresse ne répond pas (pare-feu Proxmox).

En cas de « signature refusée » dans la tuile : secret différent des deux côtés (refaire les quatre lignes), ou horloges des CT décalées de plus d'une minute (elles suivent celle du nœud Proxmox).

### 11.9 Créer et publier un site PHP (lot P3)

1. « Nouveau site », puis **Hébergement : PHP** (proposé seulement quand le serveur des sites PHP répond, 11.8). Régler :
   - **Version de PHP** : celles installées sur le CT (8.3 par défaut) ;
   - **Dossier public** : le seul dossier servi (`public` pour MyTakumi ; vide : racine du projet) ;
   - **Dossiers persistants** : gardés d'une version à l'autre et jamais servis (MyTakumi : `data`, qui contient sa base de développement, les originaux envoyés et sa clé `app.key`). Au premier envoi, leur contenu les initialise ; ensuite, une publication ne les écrase jamais.
2. La fiche montre les étapes : site posé sur le serveur PHP, page d'attente, adresse (vers le tunnel du CT), en ligne. **Pas d'attente de certificat** (celui de Cloudflare sur `kouzia.com` sert tout de suite).
3. Envoyer le projet (zip ou explorateur) : pour un site PHP, `src/`, `composer.json` et les `.php` sont gardés ; `.env`, `.git`, `node_modules`, les README restent refusés. Composer ne tourne jamais sur le serveur : envoyer le projet avec son `vendor/` s'il en a un. Il faut une page d'entrée (`index.php` ou `index.html`) dans le dossier public.
4. **Publier** : la version part en archive au CT, devient la version servie d'un coup, puis le hub vérifie que `/.env`, `/.git/config`, `/composer.json`, `/vendor/` et les dossiers persistants sont bien refusés. **Une fuite coupe le site** et fait échouer la publication, avec les chemins en cause.
5. Couper, rallumer, republier une ancienne version et supprimer marchent comme pour un site statique.

Les variables d'environnement (`.env` du site), la base MariaDB, les journaux, la tâche planifiée et les e-mails capturés arrivent aux lots P4 et P5.

### 11.10 Recette sur le vrai CT (à faire une fois, dans l'ordre)

But : vérifier en réel ce qui n'a tourné qu'en simulation (scripts Alpine, agent, site PHP), et me renvoyer les sorties. **Pas encore de vrai site client** à ce stade.

| # | Faire | Résultat attendu |
|---|---|---|
| 0 | CT du hub : `hubctl update` | « Mise à jour terminée », hub joignable ; la tuile « Serveur des sites PHP » des Réglages dit « Pas encore installé » |
| 1 | Shell du nœud : variables de 11.1 | rien à l'écran |
| 2 | Créer le CT (11.2) | `pct start` sans message ; `passwd` demande deux fois le mot de passe |
| 3 | Pare-feu (11.3), puis ses trois vérifications | « Règles acceptées » ; puis `OK : réseau local fermé`, `OK : SMTP fermé`, `HTTP/1.1 401 Unauthorized` |
| 4 | Tunnel (11.4) | tunnel « kouziaphp » créé ; route `*.kouzia.com` vers `localhost:8080` ; enregistrement DNS `*` supprimé s'il est apparu |
| 5 | Installer (11.5) | se termine par l'état du CT : nginx et MariaDB « en marche », PHP « 83 », pare-feu du CT « posé » (ou « absent » : me le dire) |
| 6 | Dans le CT : `kouziaphpctl tunnel`, puis `kouziaphpctl upgrade` | « Tunnel démarré » ; dans Cloudflare, le tunnel passe « Sain » ; puis « Système déjà à jour » ou la liste des paquets mis à jour |
| 7 | Dans le CT : `kouziaphpctl cgroups` | une suite de lignes OK, ou ÉCHEC avec la raison : **me renvoyer toute la sortie**, quel que soit le résultat |
| 8 | Agent (11.8, les quatre lignes) | « Agent démarré » ; dans le hub, tuile « Serveur des sites PHP » à « Configuré » avec PHP 8.3 ; `wget` depuis le hub : `HTTP/1.1 401 Unauthorized` |
| 9 | Hub : « Nouveau site », Perso, libellé « Recette PHP », sous-domaine `recette-php`, hébergement **PHP**, dossier public `public`, dossier persistant `data` | étapes « Site posé sur le serveur PHP », « Page d'attente publiée », « Enregistrement DNS créé », « Site en ligne » ; `https://recette-php.kouzia.com` montre la page d'attente |
| 10 | Récupérer la page de test : sur GitHub, dépôt KouziaHub, fichier `scripts/php-ct/recette/public/index.php`, « Download raw file ». Si la box n'est pas en 192.168.1.1, corriger la ligne `IP_DE_LA_BOX` | un fichier `index.php` sur le PC |
| 11 | Sur le PC, mettre `index.php` dans un dossier nommé `public`. Fiche du site, onglet Fichiers : « Ajouter un dossier », choisir ce dossier `public`, puis **Publier** | la liste montre `public/index.php` (et non `index.php` seul) ; publication réussie, sans message « Fuite détectée » |
| 12 | Ouvrir `https://recette-php.kouzia.com` | « Tous les points sont conformes. » et huit lignes OK : PHP 8.3, visite n° 1, lecture hors du site refusée, commandes coupées, Stripe en 401, réseau local et SMTP injoignables, e-mail capturé |
| 13 | Recharger la page deux fois | visite n° 2, puis n° 3 |
| 14 | Republier la même version (onglet Versions, « Republier ») puis recharger | visite n° 4 : `data/` a survécu à la publication |
| 15 | Ouvrir `https://recette-php.kouzia.com/.env`, puis `/data/visites.txt`, puis `/../data/visites.txt` | 403 ou 404 à chaque fois, jamais un contenu |
| 16 | Fiche : couper le site, recharger l'adresse ; puis le rallumer | coupé : erreur Cloudflare (l'adresse ne répond plus) ; rallumé : la page revient en moins d'une minute, visite suivante |
| 17 | Dans le CT : `ls /srv/sites/recette-php/mail/` | un ou plusieurs fichiers `.eml` (e-mails capturés, jamais envoyés) |
| 18 | Fiche, Réglages : supprimer le site `recette-php` | site retiré du hub ; dans le CT, `ls /srv/sites` ne le montre plus ; plus d'enregistrement DNS `recette-php` dans Cloudflare |

**À me renvoyer** : la sortie de `kouziaphpctl cgroups` et de `kouziaphpctl status`, une capture de la page de l'étape 12, et le texte exact de toute étape qui ne donne pas le résultat attendu (message d'erreur, ou les dernières lignes de `/var/log/kouziaphp/agent.err` et de `hubctl logs erreurs`).
