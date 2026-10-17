# Hub Kouzia (propre à ce dépôt)

Outil interne de l'EI Kouzia, sur `hub.kouzia.com`. Il héberge les versions de travail des sites clients (recette, puis modifications futures) sur `<client>.kouzia.com`. Les règles `web-*` s'appliquent, avec les adaptations de l'ERP pour une application (voir plus bas).

## Décisions d'Alexandre (17/10/2026, verrouillées)

- Outil séparé de l'ERP, mono-utilisateur (Alexandre seul).
- Sites clients : statiques, hébergés sur Cloudflare Pages (compte Cloudflare d'Alexandre, offre gratuite, 100 sites au plus sans demande de hausse).
- Fonctions attendues : en un clic, créer `<client>.kouzia.com` ; un dossier par site, lié à un client de l'ERP ; envoi des fichiers du site ; activer ou couper le site ; présentation en catalogue (vignettes, façon « catalogue de streaming »).
- Version de travail protégée : le client y accède par un code (reçu par e-mail ou communiqué), jamais indexée.
- Domaine final du client : acheté par Alexandre au nom du client, sur son compte Cloudflare, et laissé vide jusqu'à validation. La mise en ligne sur le domaine final se fait à la main, hors de l'outil.
- Accès à l'outil : Cloudflare Access devant `hub.kouzia.com` (seule l'adresse d'Alexandre), puis login propre à l'outil.
- L'outil tourne sur le Proxmox d'Alexandre, comme l'ERP (CT Alpine, OpenRC, tunnel Cloudflare).
- Clients : lus depuis l'ERP en lecture seule ; rien n'est ressaisi.

## Garde-fous

- Aucun secret dans le dépôt, le chat ou les journaux. Le jeton API Cloudflare est créé par Alexandre, avec les droits minimaux, et placé par lui dans `.env`.
- Toute modification de l'ERP (point d'accès en lecture des clients) se fait dans le dépôt KouziaCRM, annoncée au superviseur et validée avant écriture.
- Travail uniquement dans ce dépôt (worktrees dans `.worktrees/`). Commit et fusion en local autorisés une fois vérifiés ; push seulement par la session superviseur, avec l'accord d'Alexandre.
- Typographie : ni tiret cadratin (U+2014) ni demi-cadratin (U+2013), nulle part.
