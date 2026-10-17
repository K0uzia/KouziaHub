---
name: web-release
description: Prépare et vérifie une mise en production de site (FTP/SFTP mutualisé, rsync, plateforme) - paquet construit depuis un commit propre de main, liste des fichiers publiés, contrôle de dérive, envoi validé par l'humain, vérifications et retour arrière. À utiliser avant tout déploiement ou pour savoir si la production est à jour.
---

# Mise en production

Source : `procedure-mise-en-production.md` de CapsuleOS (Hostinger). Principe : automatiser la détection, pas la publication.

## 1. Règles

- Le paquet publié est la photo d'un commit précis de `main`, arbre propre, gates vertes. Jamais construit depuis une branche de travail ou un arbre modifié : il aurait l'air à jour sans correspondre à aucune version.
- Le paquet est une copie figée (pas de liens symboliques ni de liens durs vers le dépôt).
- Liste blanche de ce qui part en ligne (le dossier de build, `.htaccess`, `robots.txt`…) ; tout le reste est exclu par défaut.
- L'envoi vers le serveur est une action irréversible vers l'extérieur : validation humaine explicite à chaque fois.
- Pas de déploiement déclenché par l'horloge. Un contrôle quotidien peut seulement signaler « il y a du neuf » ou « la prod est en retard ».

## 2. Construire depuis un commit propre

```bash
git fetch origin
REF=origin/main
DIR="$(mktemp -d)/release"
git worktree add --detach "$DIR" "$REF"
( cd "$DIR" && npm ci && npm run build )
git -C "$DIR" rev-parse --short HEAD > "$DIR/dist/.release"   # à exclure de l'envoi si non voulu en ligne
```

Puis la recette (skill `web-audit`) sur `"$DIR/dist"`. Le manifeste de version (commit, date, auteur) reste à côté du paquet, pas forcément en ligne.

## 3. Envoyer (après accord)

```bash
# SFTP/rsync : miroir exact du dossier construit
rsync -avz --delete --exclude='.release' "$DIR/dist/" user@hote:/chemin/public_html/
```

Hébergeur sans SSH : FileZilla en mode miroir, en relisant d'abord la liste des fichiers à envoyer et à supprimer. Ne jamais envoyer `node_modules`, sources, `.env`, `.git`.

## 4. Après l'envoi

1. `bash .claude/skills/web-audit/scripts/check-headers.sh https://domaine`
2. Parcours principal à la main sur mobile et ordinateur, console sans erreur.
3. Formulaire : un envoi réel de test reçu.
4. Search Console : sitemap soumis, pas de nouvelle erreur de couverture.
5. `git tag release-AAAA-MM-JJ <commit>` (après accord), pour savoir ce qui est en ligne.

## 5. Retour arrière

Garder le paquet précédent (ou son tag). En cas de régression : renvoyer le paquet précédent, puis corriger sur une branche. Ne jamais corriger directement sur le serveur.

## 6. Contrôle de dérive

Question unique : la production correspond-elle au dernier commit de `main` ?

```bash
curl -s https://domaine/.release   # si publié
git rev-parse --short origin/main
```

Égal : rien à faire. Différent : préparer une publication (sections 2 à 4).
