# Hub Kouzia (propre à ce dépôt)

Outil interne de l'EI Kouzia, sur `hub.kouzia.com`. Il héberge les versions de travail des sites clients (recette, puis modifications futures) sur `<client>.kouzia.com`. Les règles `web-*` s'appliquent, avec les adaptations de l'ERP pour une application (voir plus bas).

## Décisions d'Alexandre (17/10/2026, verrouillées)

- Outil séparé de l'ERP, mono-utilisateur (Alexandre seul).
- Sites clients : statiques, hébergés sur Cloudflare Pages (compte Cloudflare d'Alexandre, offre gratuite, 100 sites au plus sans demande de hausse).
- Fonctions attendues : en un clic, créer `<client>.kouzia.com` ; un dossier par site, lié à un client de l'ERP ; envoi des fichiers du site ; activer ou couper le site ; présentation en catalogue (vignettes, façon « catalogue de streaming »).
- Version de travail protégée : le client y accède par un code (reçu par e-mail ou communiqué), jamais indexée.
- Domaine final du client : acheté par Alexandre au nom du client, sur son compte Cloudflare, et laissé vide jusqu'à validation. La mise en ligne sur le domaine final se fait à la main, hors de l'outil.
- Accès à l'outil : remplacé le 19/10/2026 par la quatrième série ci-dessous (sans Cloudflare Access).
- L'outil tourne sur le Proxmox d'Alexandre, comme l'ERP (CT Alpine, OpenRC, tunnel Cloudflare).
- Clients : lus depuis l'ERP en lecture seule ; rien n'est ressaisi.

## Décisions d'Alexandre (17/10/2026, deuxième série, verrouillées)

Elles remplacent les points correspondants ci-dessus et du cadrage (`docs/cadrage.md`, section 9).

- **Pas de code d'accès** : Alexandre donne directement le lien `<client>.kouzia.com`. La version de travail reste non indexée (`X-Robots-Tag: noindex, nofollow`, `robots.txt` en `Disallow: /`) et les adresses `pages.dev` redirigent vers le sous-domaine.
- **Bouton off = l'adresse ne répond plus** : retrait du CNAME puis du domaine du projet. Le rallumage remet le domaine et le CNAME (quelques minutes de certificat), l'interface le dit.
- **Sites perso** : un site peut n'être lié à aucun client de l'ERP, avec l'étiquette « Perso » et un filtre Clients / Perso.
- **Fichiers « comme un FTP »** : explorateur de fichiers dans la fiche du site (parcourir, ajouter, remplacer, supprimer, puis « Publier »), plus l'envoi du site entier en zip. Chaque publication est une version gardée, republiable.
## Décisions d'Alexandre (18/10/2026, troisième série : surveillance, verrouillées)

- Contrôles depuis deux points : le hub sur le Proxmox et un Worker Cloudflare planifié (offre gratuite).
- Alertes uniquement par notification sur le téléphone, en Web Push comme l'ERP. Ni ntfy ni e-mail pour l'instant.
- Client : rapport mensuel en PDF, téléchargé dans le hub et envoyé par Alexandre depuis l'ERP. Aucune page publique.
- Détection des domaines : Cloudflare seulement, par un jeton séparé en lecture seule. Pas de jeton Hostinger ; ses domaines s'ajoutent à la main.
- Détail technique : `docs/cadrage.md`, section 10.

## Défauts de la deuxième série

- **Défauts retenus par le superviseur** : tunnel propre au hub ; `hubctl` copié de `kouziactl` ; zip et explorateur d'abord, GitHub plus tard ; vignette capturée automatiquement avec repli sur une image envoyée ; sous-domaine proposé depuis le nom du client, modifiable, liste de noms interdits.

## Garde-fous

- Aucun secret dans le dépôt, le chat ou les journaux. Le jeton API Cloudflare est créé par Alexandre, avec les droits minimaux, et placé par lui dans `.env`.
- Toute modification de l'ERP (point d'accès en lecture des clients) se fait dans le dépôt KouziaCRM, annoncée au superviseur et validée avant écriture.
- Travail uniquement dans ce dépôt (worktrees dans `.worktrees/`). Commit et fusion en local autorisés une fois vérifiés ; push seulement par la session superviseur, avec l'accord d'Alexandre.
- Typographie : ni tiret cadratin (U+2014) ni demi-cadratin (U+2013), nulle part.

## Décisions d'Alexandre (19/10/2026, quatrième série : sans Cloudflare Access, verrouillées)

- Ni Cloudflare Access ni Zero Trust devant le hub. Le hub fonctionne comme l'ERP : tunnel Cloudflare à jeton, protection par le login du hub seul, mot de passe et code TOTP obligatoires. Access reste possible en option.
- Par le tunnel, seul `hub.kouzia.com` est servi (404 ailleurs) ; limite de débit stricte, attente progressive par IP puis par compte (appareils inconnus seulement, un appareil connu entre toujours, alerte à chaque mise en attente du compte), journal des connexions, notification à chaque nouvel appareil.
- Elles remplacent le point « Accès à l'outil » de la première série et le cadrage 1.6.

## Décisions d'Alexandre (22/10/2026, cinquième série : indexation et logiciels, verrouillées)

- Option « Autoriser l'indexation » par site, désactivée par défaut. Désactivée : comportement de la deuxième série (noindex). Activée : plus de `X-Robots-Tag`, `robots.txt` du site servi tel quel, sinon `Allow: /` avec la ligne `Sitemap:` si le fichier existe. Les adresses `pages.dev` restent en 301 et noindex. Premier usage : la démo Tracebay.
- Licences Tracebay émises dans le hub (page Logiciels), d'après `docs/licences-logiciels.md`. Pas de révocation (vérification hors ligne). Les demandes d'utilisation arrivent dans l'ERP depuis le site ; la licence garde l'id client de l'ERP.

## Décisions d'Alexandre (24/10/2026, sixième série : sites PHP, verrouillées)

- Le hub héberge aussi les versions de travail des sites dynamiques en PHP (MyTakumi d'abord), sur le seul Proxmox d'Alexandre, dans un CT dédié « kouziaphp », distinct du CT du hub et de celui de l'ERP. Aucune autre machine.
- Pilotage par un agent à opérations fermées et signées, ouvert au seul CT du hub ; le jeton Cloudflare et les clés de licence ne quittent jamais le CT du hub.
- Isolation : CT non privilégié, pare-feu Proxmox sur son interface (aucun accès au LAN, SMTP sortant bloqué), compte, pool PHP-FPM, base MariaDB et dossier par site.
- Versions de travail : jamais de vrai e-mail (capteur), paiements en mode test seulement (clés live refusées), relève IMAP coupée par défaut, noindex par défaut.
- Détail technique : `docs/cadrage.md`, section 11.
