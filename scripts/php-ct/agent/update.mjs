// Mise à jour des scripts du CT PHP par le hub (agent, kouziaphpctl, services), sans commande manuelle. L'archive
// vient seulement du dépôt du hub, par une opération signée, empreinte vérifiée en flux comme une version ; son
// identifiant (empreinte du contenu de scripts/php-ct, calculée par le hub) est dans le chemin signé.
//
// Déroulé : archive contrôlée (fichiers et dossiers seulement, tout sous php-ct/, install.sh présent), extraite à
// part, installation copiée de côté, install.sh lancé (rejouable) sans redémarrer l'agent ; en cas d'échec,
// l'installation d'avant est remise. Le serveur répond, PUIS l'agent s'arrête : supervise-daemon le relance aussitôt
// sur la nouvelle copie. La dernière archive reçue reste pour « kouziaphpctl update » (secours dans le CT).

import path from "node:path";
import { checkArchiveListing, OpError } from "./sites.mjs";

export const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Opérations sur le CT entier. ctx : { stateDir (/var/lib/kouziaphp), libDir (/usr/local/lib/kouziaphp),
 * initDir (/etc/init.d), sys (comme pour les sites), now() }.
 */
export function ctOperations(ctx) {
  const { stateDir, libDir, initDir, sys } = ctx;
  const updateDir = path.posix.join(stateDir, "update");
  const versionFile = path.posix.join(stateDir, "scripts.json");

  const run = async (file, args, what) => {
    const r = await sys.run(file, args);
    if (r.code !== 0) throw new OpError(500, `${what} : échec (${(r.stderr || "").trim().slice(0, 200) || `code ${r.code}`}).`);
    return r;
  };

  async function writeVersion(state) {
    await sys.writeFile(versionFile, `${JSON.stringify(state)}\n`, 0o600);
  }

  const ops = {
    /** Fichier où écrire l'archive reçue (dossier à root, 700), nommé par le nonce de la requête. */
    async incomingFile(nonce) {
      if (!/^[0-9a-f]{32}$/.test(nonce)) throw new OpError(400, "Nonce invalide.");
      await sys.mkdir(updateDir, 0o700);
      return path.posix.join(updateDir, `${nonce}.tar.gz`);
    },

    /** Version installée des scripts : empreinte, date, résultat de la dernière mise à jour. */
    async version() {
      if (!(await sys.exists(versionFile))) return { digest: null, installedAt: null, result: null };
      const v = JSON.parse(await sys.readFile(versionFile));
      return { digest: v.digest ?? null, installedAt: v.installedAt ?? null, result: v.result ?? null };
    },

    /** Installe l'archive reçue ; { ok, digest, log } ; restart vrai si l'agent doit se relancer sur la nouvelle copie. */
    async updateScripts(archive, digest) {
      if (!DIGEST_RE.test(digest)) throw new OpError(400, "Empreinte des scripts invalide.");
      const listing = await run("/bin/tar", ["-tvzf", archive], "Lecture de l'archive");
      const names = checkArchiveListing(listing.stdout);
      if (!names.length || names.some((n) => n !== "php-ct" && !n.startsWith("php-ct/"))) throw new OpError(400, "Archive refusée : tout doit être sous php-ct/.");
      if (!names.includes("php-ct/install.sh")) throw new OpError(400, "Archive refusée : install.sh absent.");

      const stage = path.posix.join(updateDir, digest);
      await sys.rm(stage);
      await sys.mkdir(stage, 0o700);
      await run("/bin/tar", ["-xzof", archive, "-C", stage], "Extraction des scripts");
      await run("/bin/chmod", ["-R", "go-w", stage], "Droits des scripts");

      // Installation d'avant mise de côté : remise telle quelle si install.sh échoue.
      const prev = `${libDir}.prev`;
      await sys.rm(prev);
      const hadLib = await sys.exists(libDir);
      if (hadLib) await run("/bin/cp", ["-a", libDir, prev], "Copie de l'installation actuelle");

      const r = await sys.runIo("/bin/sh", [path.posix.join(stage, "php-ct", "install.sh")], {
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", KP_NO_AGENT_RESTART: "1" },
        timeoutMs: 20 * 60_000,
        maxOutput: 256 * 1024,
      });
      // Journal sans couleurs, les 120 dernières lignes.
      const log = `${r.stdout}${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(-120).join("\n");
      const installedAt = new Date(ctx.now()).toISOString();

      if (r.code !== 0) {
        if (hadLib) {
          await sys.rm(libDir);
          await sys.rename(prev, libDir);
          // Services remis depuis l'installation d'avant (install.sh a pu les avoir déjà remplacés).
          for (const f of await sys.readdir(path.posix.join(libDir, "openrc"))) {
            await run("/bin/cp", [path.posix.join(libDir, "openrc", f), path.posix.join(initDir, f)], "Remise des services");
          }
        }
        const before = await ops.version();
        await writeVersion({ ...before, result: "echec", failedAt: installedAt, failedDigest: digest });
        await sys.rm(stage);
        await sys.rm(archive);
        return { ok: false, digest, log, restart: false };
      }

      await sys.rm(prev);
      await sys.rm(path.posix.join(updateDir, "last.tar.gz"));
      await sys.rename(archive, path.posix.join(updateDir, "last.tar.gz"));
      await sys.rm(stage);
      await writeVersion({ digest, installedAt, result: "ok" });
      return { ok: true, digest, log, restart: true };
    },
  };
  return ops;
}
