import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PhpServerStatus } from "@/contract.js";
import { phpCtDigest, PHP_CT_DIR, pushPhpCtScripts } from "@/lib/php-ct-update.js";
import { PhpAgentClient } from "@/lib/php-agent/client.js";
import { createAgent, systemProbes, type Probes } from "../../../../../scripts/php-ct/agent/agent.mjs";
import { ctOperations } from "../../../../../scripts/php-ct/agent/update.mjs";
import { memorySys } from "../helpers/php-memory.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub } from "../helpers/hub.js";

// Mise à jour du CT PHP par le hub : archive des scripts du dépôt du hub, envoyée signée à l'agent, contrôlée,
// installée par install.sh (simulé), agent relancé ensuite ; échec : installation d'avant remise.
const SECRET = "s".repeat(48);
const DIGEST = "a".repeat(64);
const tarAvailable = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function ct(installCode = 0, listing = "drwxr-xr-x 0/0 0 2026-10-25 10:00 php-ct/\n-rw-r--r-- 0/0 10 2026-10-25 10:00 php-ct/install.sh\n") {
  const m = memorySys((file, args) => {
    if (file === "/bin/tar" && args[0] === "-tvzf") return { code: 0, stdout: listing, stderr: "" };
    if (file === "/bin/sh") return { code: installCode, stdout: "\u001b[1m== Paquets ==\u001b[0m\nOK nginx, MariaDB...\n", stderr: installCode ? "ERREUR apk add a échoué" : "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  m.nodes.set("/usr/local/lib/kouziaphp", { type: "dir" });
  m.nodes.set("/usr/local/lib/kouziaphp/agent.mjs", { type: "file", text: "ancien agent" });
  m.nodes.set("/usr/local/lib/kouziaphp/openrc/kouziaphp-agent", { type: "file", text: "ancien service" });
  const ops = ctOperations({ stateDir: "/var/lib/kouziaphp", libDir: "/usr/local/lib/kouziaphp", initDir: "/etc/init.d", sys: m.sys, now: () => Date.UTC(2026, 9, 25, 18) });
  return { m, ops };
}

describe("mise à jour des scripts du CT (agent, système simulé)", () => {
  it("archive contrôlée : tout sous php-ct/, install.sh présent, ni lien ni chemin hors du dossier", async () => {
    for (const [listing, msg] of [
      ["-rw-r--r-- 0/0 1 2026-10-25 10:00 php-ct/install.sh\n-rw-r--r-- 0/0 1 2026-10-25 10:00 ailleurs.sh\n", /sous php-ct/],
      ["-rw-r--r-- 0/0 1 2026-10-25 10:00 php-ct/lib.sh\n", /install\.sh absent/],
      ["lrwxrwxrwx 0/0 0 2026-10-25 10:00 php-ct/install.sh -> /etc/shadow\n", /lien/],
      ["-rw-r--r-- 0/0 1 2026-10-25 10:00 php-ct/../../etc/cron\n", /hors du site/],
    ] as const) {
      const { ops } = ct(0, listing);
      await expect(ops.updateScripts("/var/lib/kouziaphp/update/a.tar.gz", DIGEST), listing).rejects.toThrow(msg);
    }
    await expect(ct().ops.updateScripts("/x.tar.gz", "pas-une-empreinte")).rejects.toThrow(/Empreinte/);
  });

  it("succès : install.sh lancé sans redémarrer l'agent ; version notée ; archive gardée pour kouziaphpctl update", async () => {
    const { m, ops } = ct();
    m.nodes.set("/var/lib/kouziaphp/update/a.tar.gz", { type: "file", text: "archive" });
    const r = await ops.updateScripts("/var/lib/kouziaphp/update/a.tar.gz", DIGEST);
    expect(r).toMatchObject({ ok: true, digest: DIGEST, restart: true });
    expect(r.log).toContain("== Paquets ==");
    expect(r.log).not.toContain("\u001b");
    const install = m.inputs.find((i) => i.file === "/bin/sh")!;
    expect(install.args).toEqual([`/var/lib/kouziaphp/update/${DIGEST}/php-ct/install.sh`]);
    expect(install.io.env).toMatchObject({ KP_NO_AGENT_RESTART: "1" });
    expect(m.runs).toContain(`/bin/tar -xzof /var/lib/kouziaphp/update/a.tar.gz -C /var/lib/kouziaphp/update/${DIGEST}`);
    expect(await ops.version()).toEqual({ digest: DIGEST, installedAt: "2026-10-25T18:00:00.000Z", result: "ok" });
    expect(m.nodes.get("/var/lib/kouziaphp/update/last.tar.gz")).toEqual({ type: "file", text: "archive" });
    expect(m.nodes.has("/usr/local/lib/kouziaphp.prev")).toBe(false);
  });

  it("échec d'install.sh : installation d'avant remise (scripts et services), version gardée, échec noté, pas de redémarrage", async () => {
    const { m, ops } = ct(1);
    // Une installation précédente réussie.
    m.nodes.set("/var/lib/kouziaphp/scripts.json", { type: "file", text: JSON.stringify({ digest: "b".repeat(64), installedAt: "2026-10-24T10:00:00.000Z", result: "ok" }) });
    // install.sh a déjà remplacé une partie avant d'échouer : simulé après la copie de côté.
    const realRunIo = m.sys.runIo;
    m.sys.runIo = async (file, args, io) => {
      if (file === "/bin/sh") m.nodes.set("/usr/local/lib/kouziaphp/agent.mjs", { type: "file", text: "nouvel agent à moitié posé" });
      return realRunIo(file, args, io);
    };
    m.nodes.set("/var/lib/kouziaphp/update/a.tar.gz", { type: "file", text: "archive" });
    const r = await ops.updateScripts("/var/lib/kouziaphp/update/a.tar.gz", DIGEST);
    expect(r).toMatchObject({ ok: false, restart: false });
    expect(r.log).toContain("ERREUR apk add a échoué");
    expect(m.runs).toContain("/bin/cp -a /usr/local/lib/kouziaphp /usr/local/lib/kouziaphp.prev");
    expect(m.runs).toContain("/bin/cp /usr/local/lib/kouziaphp/openrc/kouziaphp-agent /etc/init.d/kouziaphp-agent");
    expect(await ops.version()).toEqual({ digest: "b".repeat(64), installedAt: "2026-10-24T10:00:00.000Z", result: "echec" });
    expect(m.nodes.has("/var/lib/kouziaphp/update/a.tar.gz")).toBe(false);
  });
});

describe.runIf(tarAvailable)("mise à jour du CT de bout en bout (hub, agent signé, système simulé)", () => {
  let server: Server;
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  async function start(installCode: number) {
    const disk = mkdtempSync(join(tmpdir(), "kouzia-ct-update-"));
    let restarts = 0;
    let received = "";
    // tar simulé pour la liste : celle de la vraie archive reçue (contrôle réel de son contenu).
    const m = memorySys((file, args) => {
      // Lancé depuis le dossier : sous Windows, tar lirait « C:... » comme hôte:chemin.
      if (file === "/bin/tar" && args[0] === "-tvzf") return { code: 0, stdout: execFileSync("tar", ["-tvzf", basename(received)], { cwd: dirname(received), encoding: "utf8" }), stderr: "" };
      if (file === "/bin/sh") return { code: installCode, stdout: "install terminé\n", stderr: installCode ? "échec simulé" : "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const ops = ctOperations({ stateDir: "/var/lib/kouziaphp", libDir: "/usr/local/lib/kouziaphp", initDir: "/etc/init.d", sys: m.sys, now: Date.now });
    const probes = { ...systemProbes, alpine: () => "3.22.2", service: async () => "running", tunnelId: () => null, now: () => Date.now() } satisfies Probes;
    server = createAgent({
      secret: SECRET,
      allowedIps: ["127.0.0.1"],
      probes,
      ct: {
        ...ops,
        incomingFile: async (nonce) => {
          await ops.incomingFile(nonce);
          received = join(disk, `${nonce}.tar.gz`);
          return received;
        },
        // Le fichier reçu est sur le vrai disque : connu du système simulé pour le rangement qui suit.
        updateScripts: async (file, digest) => {
          m.nodes.set(file, { type: "file", text: "archive" });
          return ops.updateScripts(file, digest);
        },
      },
      restart: () => void restarts++,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agent = new PhpAgentClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: SECRET });
    return { agent, disk, restarts: () => restarts, m };
  }

  it("archive du dépôt du hub reçue, contrôlée, installée ; agent relancé APRÈS la réponse ; nouvelle version relue", async () => {
    const { agent, disk, restarts } = await start(0);
    const r = await pushPhpCtScripts(agent, disk, PHP_CT_DIR, 10_000);
    expect(r.ok).toBe(true);
    expect(r.digest).toBe(await phpCtDigest());
    expect(r.state?.scripts).toMatchObject({ digest: r.digest, result: "ok" });
    expect(restarts()).toBe(1);
  });

  it("bouton des Réglages : 202 tout de suite, travail suivi dans l'état du serveur jusqu'à la fin ; journalisé", async () => {
    const { agent } = await start(0);
    await resetDb();
    const hub = await buildTestHub({ phpAgent: agent });
    try {
      const started = await hub.app.inject({ method: "POST", url: "/api/php/serveur/mise-a-jour", headers: hub.headers });
      expect(started.statusCode).toBe(202);
      expect((await hub.app.inject({ method: "POST", url: "/api/php/serveur/mise-a-jour", headers: hub.headers })).statusCode).toBe(409);
      let status = (await hub.app.inject({ method: "GET", url: "/api/php/serveur", headers: hub.headers })).json() as PhpServerStatus;
      for (let i = 0; i < 40 && status.update?.running; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        status = (await hub.app.inject({ method: "GET", url: "/api/php/serveur", headers: hub.headers })).json() as PhpServerStatus;
      }
      expect(status.update).toMatchObject({ running: false, ok: true, log: null });
      expect(status).toMatchObject({ reachable: true, scriptsAvailable: await phpCtDigest() });
      expect(status.configured && status.reachable ? status.state.scripts?.digest : null).toBe(await phpCtDigest());
      expect(await prisma.auditEvent.findFirst({ where: { action: "php.ct.update" } })).toMatchObject({ result: "ok" });
    } finally {
      await hub.app.close();
    }
  });

  it("échec d'installation : rendu avec son journal, pas de redémarrage", async () => {
    const { agent, disk, restarts } = await start(1);
    const r = await pushPhpCtScripts(agent, disk, PHP_CT_DIR, 10_000);
    expect(r).toMatchObject({ ok: false });
    expect(r.log).toContain("échec simulé");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(restarts()).toBe(0);
  });

});

describe("empreinte des scripts du CT", () => {
  it("empreinte : même contenu, même empreinte ; un fichier changé la change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kouzia-ct-digest-"));
    writeFileSync(join(dir, "install.sh"), "echo 1\n");
    const a = await phpCtDigest(dir);
    expect(await phpCtDigest(dir)).toBe(a);
    writeFileSync(join(dir, "install.sh"), "echo 2\n");
    expect(await phpCtDigest(dir)).not.toBe(a);
  });
});
