---
name: web-git
description: Organise le travail Git d'un projet web - branches courtes nommées, worktrees pour plusieurs agents en parallèle, hooks d'hygiène, fusion vers main, fichiers à ne jamais versionner. À utiliser pour créer une branche, préparer un commit, fusionner, ou quand plusieurs sessions travaillent sur le même dépôt.
---

# Git

Source : `procedure-git-branching.md` et `procedure-contribution-git-local.md` de CapsuleOS. Commit et push restent des actions validées par l'humain.

## Modèle : tronc + branches courtes

| Branche | Usage | Durée |
|---------|-------|-------|
| `main` | toujours publiable, pas de commit direct | permanente |
| `feat/<zone>-<slug>` | fonctionnalité | jours |
| `fix/<zone>-<slug>` | correction | heures à jours |
| `content/<slug>` | textes, images, données | courte |
| `chore/<slug>`, `docs/<slug>` | outillage, doc | courte |
| `claude/<slug>` | session d'agent | une session |

Pas de `develop` ni de branche longue par section du site. Limite : 14 jours, au-delà rebaser ou découper.

## Flux

1. `git switch main && git pull --ff-only`, puis `git switch -c feat/<zone>-<slug>`.
2. Patch + contrôle minimal (skill `web-audit`).
3. Commit : message à l'impératif, une intention par commit.
4. Avant fusion : recette du périmètre verte, relecture du diff `main...HEAD`.
5. Fusion par l'humain : `git merge --ff-only` si possible, sinon merge commit `merge: <branche> → main`. Pas de squash systématique.
6. Rebase autorisé sur sa branche non partagée ; jamais de force-push sur une branche partagée ni sur `main`.

## Plusieurs agents en parallèle

Un dépôt n'a qu'un index et qu'une branche courante : un `git checkout -b` dans un dossier partagé fait basculer toutes les sessions. Un dossier par agent :

```bash
git worktree add ../site-feat-blog -b feat/blog-listing
git worktree list
git worktree remove ../site-feat-blog   # après fusion
```

- Un serveur de dev par worktree, sur des ports distincts.
- `Unable to create '.git/index.lock'` : un autre processus écrit. Attendre ; ne jamais supprimer le verrou pendant qu'il travaille.

## Hygiène

- Jamais versionnés : `node_modules/`, `dist/`, `.env*` (sauf `.env.example`), caches (`.astro/`, `.next/`), journaux, captures temporaires, états intermédiaires d'outils.
- Hook `pre-commit` recommandé : refuser ces fichiers et lancer `node .claude/skills/web-audit/scripts/check-repo.mjs`.
- Fichiers générés : régénérés par la commande du projet, jamais corrigés à la main dans le commit.
