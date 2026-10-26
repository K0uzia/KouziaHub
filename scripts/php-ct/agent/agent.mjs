// Agent du CT des sites PHP (docs/cadrage.md, section 11.1, lot P2). Seul point d'entrée du hub dans ce CT :
// une liste fermée d'opérations, chacune signée par le secret partagé avec le hub, sur le réseau du Proxmox,
// port ouvert au seul CT du hub par le pare-feu Proxmox. Pas de commande libre, pas de shell.
//
// Protocole (le hub fait de même dans apps/api/src/lib/php-agent/protocol.ts ; un test compare les deux) :
//   requête : x-kouzia-hub-timestamp (secondes), x-kouzia-hub-nonce (32 hex), x-kouzia-hub-signature =
//     « sha256= » + HMAC-SHA256(secret, « horodatage.nonce.MÉTHODE.chemin.sha256(corps) ») ;
//     refusée hors d'une fenêtre de 60 s, ou si le nonce a déjà servi (rejeu).
//   réponse : x-kouzia-agent-signature = HMAC-SHA256(secret, « nonce de la requête.statut.sha256(corps) ») :
//     le hub ne croit pas une réponse forgée sur le réseau, ni une réponse rejouée pour une autre requête.
// JavaScript sans dépendance (node: seulement) : rien à installer d'autre que Node sur le CT.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, appendFileSync, statfsSync, createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createServer, request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { fileSha256, realSys, siteOperations } from "./sites.mjs";
import { ctOperations } from "./update.mjs";

export const AGENT_VERSION = "2";
export const WINDOW_SECONDS = 60;
const MAX_BODY_BYTES = 1024 * 1024;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;

export const sha256Hex = (body) => createHash("sha256").update(body ?? "").digest("hex");

export function signRequest(secret, timestamp, nonce, method, path, body) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`).digest("hex")}`;
}

export function signResponse(secret, nonce, status, body) {
  return signResponseHash(secret, nonce, status, sha256Hex(body));
}

/** Même signature, sur l'empreinte d'un corps envoyé en flux (export de la base). */
export function signResponseHash(secret, nonce, status, bodySha256) {
  return `sha256=${createHmac("sha256", secret).update(`${nonce}.${status}.${bodySha256}`).digest("hex")}`;
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- Sondes du système (remplacées dans les tests) ---

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000 }, (err) => resolve(!err));
  });
}

function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

async function serviceState(name) {
  if (!existsSync(`/etc/init.d/${name}`)) return "absent";
  if (!(await run("/sbin/rc-service", [name, "status"]))) return "stopped";
  // Pare-feu : le service démarré ne suffit pas, sa table doit être chargée.
  if (name === "kouziaphp-firewall" && !(await run("/usr/sbin/nft", ["list", "table", "inet", "kouziaphp"]))) return "stopped";
  return "running";
}

export const systemProbes = {
  alpine: () => readText("/etc/alpine-release"),
  php: () => ["82", "83", "84", "85"].filter((v) => existsSync(`/usr/sbin/php-fpm${v}`)).map((v) => `${v[0]}.${v.slice(1)}`),
  service: serviceState,
  memory: () => {
    const kb = Number(/^MemTotal:\s+(\d+) kB$/m.exec(readText("/proc/meminfo") ?? "")?.[1]);
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  },
  cgroups: () => {
    const text = readText("/var/lib/kouziaphp/cgroups");
    if (!text) return { result: null, checkedAt: null };
    const line = (key) => text.split("\n").find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
    const result = line("resultat");
    return { result: result === "ok" || result === "echec" ? result : null, checkedAt: line("date") };
  },
  lastUpgrade: () => readText("/var/lib/kouziaphp/last-upgrade"),
  disk: () => {
    try {
      const s = statfsSync("/srv/sites");
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      return null;
    }
  },
  sites: () => {
    try {
      return readdirSync("/srv/sites", { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    } catch {
      return 0;
    }
  },
  tunnelId: () => tunnelIdOf(readText("/etc/kouziaphp/tunnel.token")),
  now: () => Date.now(),
};

/**
 * Identifiant du tunnel, lu dans son jeton (JSON en base64 : compte « a », tunnel « t », secret « s ») : le hub en
 * fait la cible des CNAME des sites PHP. Seul l'identifiant sort, jamais le secret ni le jeton.
 */
export function tunnelIdOf(token) {
  if (!token) return null;
  try {
    const t = JSON.parse(Buffer.from(token.trim(), "base64").toString("utf8"))?.t;
    return typeof t === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

// --- Opérations (liste fermée : méthode et chemin exacts, paramètres validés) ---

async function etat(probes, ct) {
  return {
    agentVersion: AGENT_VERSION,
    alpine: probes.alpine(),
    node: process.versions.node,
    php: probes.php(),
    services: {
      nginx: await probes.service("nginx"),
      mariadb: await probes.service("mariadb"),
      tunnel: await probes.service("cloudflared"),
      firewall: await probes.service("kouziaphp-firewall"),
    },
    cgroups: probes.cgroups(),
    // Scripts du CT installés par le hub (mise à jour sans commande manuelle) : empreinte, date, résultat.
    scripts: ct ? await ct.version() : null,
    lastUpgrade: probes.lastUpgrade(),
    disk: probes.disk(),
    // Mémoire du CT (lxcfs : la limite du CT dans Proxmox), pour comparer à la somme des limites des sites.
    memoryBytes: probes.memory?.() ?? null,
    sites: probes.sites(),
    time: new Date(probes.now()).toISOString(),
  };
}

const SITE = "([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
// stream : corps envoyé en flux (archive d'une version, import de base), empreinte annoncée dans
// x-kouzia-hub-content-sha256 ; kind : type du fichier reçu. download : réponse en flux (fichier rendu par l'opération,
// retiré après l'envoi), empreinte dans x-kouzia-agent-content-sha256 et signée.
const BASE = (rest) => new RegExp(`^/v1/sites/${SITE}/base${rest}$`);
const routes = [
  { method: "GET", re: /^\/v1\/etat$/, run: (c) => etat(c.probes, c.ct) },
  { method: "GET", re: /^\/v1\/tunnel$/, run: (c) => ({ tunnelId: c.probes.tunnelId() }) },
  // Scripts du CT envoyés par le hub (archive de son dépôt) ; l'empreinte de leur contenu est dans le chemin signé.
  { method: "PUT", re: /^\/v1\/ct\/scripts\/([0-9a-f]{64})$/, ct: true, stream: true, run: (c, [digest]) => c.ct.updateScripts(c.file, digest) },
  { method: "POST", re: /^\/v1\/sites$/, site: true, run: (c) => c.sites.upsert(c.json()) },
  { method: "PUT", re: new RegExp(`^/v1/sites/${SITE}/versions/(\\d{1,7})$`), site: true, stream: true, kind: () => "version", run: (c, [slug, n]) => c.sites.receive(slug, Number(n), c.file) },
  { method: "POST", re: new RegExp(`^/v1/sites/${SITE}/publier$`), site: true, run: (c, [slug]) => c.sites.publish(slug, Number(c.json().version)) },
  { method: "POST", re: new RegExp(`^/v1/sites/${SITE}/couper$`), site: true, run: (c, [slug]) => c.sites.setEnabled(slug, false) },
  { method: "POST", re: new RegExp(`^/v1/sites/${SITE}/rallumer$`), site: true, run: (c, [slug]) => c.sites.setEnabled(slug, true) },
  { method: "GET", re: new RegExp(`^/v1/sites/${SITE}/verifier$`), site: true, run: (c, [slug]) => c.sites.check(slug) },
  { method: "DELETE", re: new RegExp(`^/v1/sites/${SITE}$`), site: true, run: (c, [slug]) => c.sites.remove(slug) },
  // Lot P4 : variables, base, script du projet.
  { method: "PUT", re: new RegExp(`^/v1/sites/${SITE}/env$`), site: true, run: (c, [slug]) => c.sites.setEnv(slug, c.json().vars) },
  { method: "GET", re: BASE(""), site: true, run: (c, [slug]) => c.sites.dbState(slug) },
  { method: "POST", re: BASE(""), site: true, run: (c, [slug]) => c.sites.createDb(slug) },
  { method: "PUT", re: BASE("/import/(sql|sqlgz)"), site: true, stream: true, kind: ([, k]) => k, run: (c, [slug, k]) => c.sites.importDb(slug, c.file, k === "sqlgz") },
  { method: "GET", re: BASE("/export"), site: true, download: true, run: (c, [slug]) => c.sites.exportDb(slug) },
  { method: "POST", re: BASE("/reinitialiser"), site: true, run: (c, [slug]) => c.sites.resetDb(slug) },
  { method: "POST", re: BASE("/dump"), site: true, run: (c, [slug]) => c.sites.dumpBefore(slug, Number(c.json().version)) },
  { method: "POST", re: BASE("/restaurer"), site: true, run: (c, [slug]) => c.sites.restoreDump(slug, Number(c.json().version)) },
  { method: "POST", re: new RegExp(`^/v1/sites/${SITE}/script$`), site: true, run: (c, [slug]) => c.sites.runScript(slug, c.json().path, c.json().args ?? [], c.json().stdin ?? "") },
];

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * Serveur de l'agent. options : secret (au moins 32 caractères), allowedIps (IP du hub), probes (sondes),
 * sites (opérations sur les sites, sites.mjs ; absentes : 503), log (une ligne par requête : date, IP, méthode,
 * chemin, statut ; jamais un en-tête ni un corps).
 */
export function createAgent({ secret, allowedIps, probes = systemProbes, sites = null, ct = null, restart = () => {}, log = () => {} }) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Secret de l'agent absent ou trop court (32 caractères au moins).");
  const allowed = new Set(allowedIps);
  const seen = new Map();

  const server = createServer((req, res) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const path = (req.url ?? "").split("?")[0];
    const nonce = String(req.headers["x-kouzia-hub-nonce"] ?? "");
    let done = false;
    const reply = (status, payload) => {
      if (done) return;
      done = true;
      const body = JSON.stringify(payload);
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      // Réponse signée seulement pour une requête authentifiée (le nonce est alors vérifié).
      if (status !== 401 && status !== 403) headers["x-kouzia-agent-signature"] = signResponse(secret, nonce, status, body);
      res.writeHead(status, headers);
      res.end(body);
      log(`${new Date(probes.now()).toISOString()} ${ip} ${req.method} ${path} ${status}`);
    };

    if (!allowed.has(ip)) {
      reply(403, { error: "Adresse non autorisée." });
      req.resume();
      return;
    }
    const route = routes.find((r) => r.method === req.method && r.re.test(path));
    const params = route ? route.re.exec(path).slice(1) : [];

    // Contrôle commun : horodatage, nonce, signature (corps ou empreinte annoncée), rejeu.
    const authenticate = (bodyHash) => {
      const timestamp = String(req.headers["x-kouzia-hub-timestamp"] ?? "");
      const signature = String(req.headers["x-kouzia-hub-signature"] ?? "");
      const nowS = Math.floor(probes.now() / 1000);
      if (!TIMESTAMP_RE.test(timestamp) || !NONCE_RE.test(nonce) || Math.abs(nowS - Number(timestamp)) > WINDOW_SECONDS) {
        reply(401, { error: "Requête non signée ou hors délai." });
        return false;
      }
      const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${String(req.method).toUpperCase()}.${path}.${bodyHash}`).digest("hex")}`;
      if (!sameText(signature, expected)) {
        reply(401, { error: "Signature invalide." });
        return false;
      }
      for (const [n, at] of seen) if (nowS - at > 2 * WINDOW_SECONDS) seen.delete(n);
      if (seen.has(nonce)) {
        reply(401, { error: "Requête déjà reçue." });
        return false;
      }
      seen.set(nonce, nowS);
      return true;
    };

    // Fichier rendu en flux : empreinte calculée d'abord, signée avec le nonce, puis envoi ; fichier retiré ensuite.
    const sendFile = async (file) => {
      const sha = await fileSha256(file);
      done = true;
      res.writeHead(200, {
        "content-type": "application/gzip",
        "cache-control": "no-store",
        "x-kouzia-agent-content-sha256": sha,
        "x-kouzia-agent-signature": signResponseHash(secret, nonce, 200, sha),
      });
      try {
        await pipeline(createReadStream(file), res);
      } finally {
        await rm(file, { force: true });
        log(`${new Date(probes.now()).toISOString()} ${ip} ${req.method} ${path} 200`);
      }
    };

    const execute = async (ctx) => {
      if (!route) return reply(404, { error: "Opération inconnue." });
      if (route.site && !sites) return reply(503, { error: "Opérations sur les sites indisponibles sur cet agent." });
      if (route.ct && !ct) return reply(503, { error: "Mise à jour du CT indisponible sur cet agent." });
      try {
        const result = await route.run(ctx, params);
        if (route.download) return await sendFile(result.file);
        // Scripts mis à jour : réponse envoyée d'abord, puis l'agent s'arrête ; supervise-daemon le relance sur la nouvelle copie.
        if (result?.restart) res.once("finish", () => setTimeout(restart, 300));
        return reply(200, result);
      } catch (err) {
        if (err && typeof err.status === "number") return reply(err.status, { error: err.message });
        return reply(500, { error: "L'opération a échoué sur le CT (journal de l'agent)." });
      }
    };

    if (route?.stream) {
      // Archive : signature vérifiée sur l'empreinte annoncée AVANT de lire le corps, puis écriture en flux,
      // empreinte recalculée et comparée ; rien n'est gardé si elle diffère.
      const declared = String(req.headers["x-kouzia-hub-content-sha256"] ?? "");
      if (!SHA_RE.test(declared)) {
        reply(401, { error: "Empreinte de l'archive absente." });
        req.resume();
        return;
      }
      if (!authenticate(declared)) {
        req.resume();
        return;
      }
      // Taille annoncée au-delà du plafond : refus clair AVANT de recevoir (sinon la connexion serait coupée).
      const announced = Number(req.headers["content-length"] ?? 0);
      if (announced > MAX_UPLOAD_BYTES) {
        reply(413, { error: `Envoi trop lourd : ${Math.round(announced / 1024 / 1024)} Mio, ${MAX_UPLOAD_BYTES / 1024 / 1024} Mio au plus.` });
        req.resume();
        return;
      }
      if ((route.site && !sites) || (route.ct && !ct)) {
        execute({ probes, sites, ct, json: () => ({}) });
        req.resume();
        return;
      }
      (async () => {
        let file;
        try {
          file = route.ct ? await ct.incomingFile(nonce) : await sites.incomingFile(params[0], nonce, route.kind(params));
        } catch (err) {
          req.resume();
          return reply(err?.status ?? 500, { error: err?.message ?? "Site inconnu." });
        }
        const hash = createHash("sha256");
        let size = 0;
        const out = createWriteStream(file, { mode: 0o600 });
        req.on("data", (c) => {
          size += c.length;
          if (size > MAX_UPLOAD_BYTES) {
            req.destroy();
            out.destroy();
          } else hash.update(c);
        });
        try {
          await pipeline(req, out);
        } catch {
          await rm(file, { force: true });
          return reply(413, { error: "Archive trop lourde ou envoi interrompu." });
        }
        if (hash.digest("hex") !== declared) {
          await rm(file, { force: true });
          return reply(400, { error: "Archive altérée en route (empreinte différente)." });
        }
        return execute({ probes, sites, ct, file, json: () => ({}) });
      })();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (!authenticate(sha256Hex(body))) return;
      const json = () => {
        try {
          return JSON.parse(body.toString("utf8") || "{}");
        } catch {
          return {};
        }
      };
      void execute({ probes, sites, ct, json });
    });
  });
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 10_000;
  return server;
}

// --- Lancement par OpenRC : /etc/kouziaphp/agent.secret et agent.env (KP_AGENT_HUB_IP, KP_AGENT_PORT) ---

function readEnvFile(path) {
  const out = {};
  for (const line of (readText(path) ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Filet : l'erreur d'un flux (tube d'une commande fermée, connexion coupée) est journalisée sans arrêter l'agent,
  // l'opération en cours voit l'échec de sa commande. Toute autre erreur l'arrête (supervise-daemon le relance).
  process.on("uncaughtException", (err) => {
    console.error(`${new Date().toISOString()} erreur non rattrapée :`, err?.stack ?? err);
    if (!["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes(err?.code)) process.exit(1);
  });
  const env = readEnvFile("/etc/kouziaphp/agent.env");
  const secret = readText("/etc/kouziaphp/agent.secret") ?? "";
  const port = Number(env.KP_AGENT_PORT ?? 8790);
  const hubIps = (env.KP_AGENT_HUB_IP ?? "").split(/[ ,]+/).filter(Boolean);
  if (!hubIps.length) {
    console.error("KP_AGENT_HUB_IP absent de /etc/kouziaphp/agent.env : kouziaphpctl agent");
    process.exit(1);
  }
  // Opérations sur les sites : chemins réels du CT, commandes lancées sans shell.
  const runImpl = (file, args) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  const sites = siteOperations({
    paths: {
      sitesDir: "/srv/sites",
      confDir: "/etc/kouziaphp",
      nginxSitesDir: "/etc/nginx/kouziaphp-sites",
      nginxPort: 8080,
      runDir: "/run/kouziaphp",
      initDir: "/etc/init.d",
      confdDir: "/etc/conf.d",
      passwdFile: "/etc/passwd",
    },
    domain: env.KP_SITES_DOMAIN || "kouzia.com",
    phpInstalled: () => systemProbes.php(),
    limitsEffective: () => systemProbes.cgroups().result === "ok",
    httpStatus: (host, p) =>
      new Promise((resolve) => {
        const r = httpRequest({ host: "127.0.0.1", port: 8080, path: p, method: "GET", headers: { host }, timeout: 2000 }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("timeout", () => r.destroy());
        r.on("error", () => resolve(0));
        r.end();
      }),
    sys: realSys(runImpl),
  });
  const ct = ctOperations({ stateDir: "/var/lib/kouziaphp", libDir: "/usr/local/lib/kouziaphp", initDir: "/etc/init.d", sys: realSys(runImpl), now: Date.now });
  const server = createAgent({
    secret,
    ct,
    // Après une mise à jour des scripts : arrêt propre, supervise-daemon relance l'agent sur la nouvelle copie.
    restart: () => process.exit(0),
    allowedIps: hubIps,
    sites,
    log: (line) => {
      try {
        appendFileSync("/var/log/kouziaphp/agent.log", `${line}\n`);
      } catch {
        // Journal indisponible : l'agent continue.
      }
    },
  });
  server.listen(port, "0.0.0.0", () => console.log(`Agent des sites PHP sur le port ${port}, hub autorisé : ${hubIps.join(", ")}`));
}
