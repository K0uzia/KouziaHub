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
import { existsSync, readFileSync, readdirSync, appendFileSync, statfsSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const AGENT_VERSION = "1";
export const WINDOW_SECONDS = 60;
const MAX_BODY_BYTES = 1024 * 1024;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;

export const sha256Hex = (body) => createHash("sha256").update(body ?? "").digest("hex");

export function signRequest(secret, timestamp, nonce, method, path, body) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`).digest("hex")}`;
}

export function signResponse(secret, nonce, status, body) {
  return `sha256=${createHmac("sha256", secret).update(`${nonce}.${status}.${sha256Hex(body)}`).digest("hex")}`;
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
  return (await run("/sbin/rc-service", [name, "status"])) ? "running" : "stopped";
}

export const systemProbes = {
  alpine: () => readText("/etc/alpine-release"),
  php: () => ["82", "83", "84", "85"].filter((v) => existsSync(`/usr/sbin/php-fpm${v}`)).map((v) => `${v[0]}.${v.slice(1)}`),
  service: serviceState,
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
  now: () => Date.now(),
};

// --- Opérations (liste fermée : méthode et chemin exacts) ---

const operations = {
  "GET /v1/etat": async (probes) => ({
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
    lastUpgrade: probes.lastUpgrade(),
    disk: probes.disk(),
    sites: probes.sites(),
    time: new Date(probes.now()).toISOString(),
  }),
};

/**
 * Serveur de l'agent. options : secret (au moins 32 caractères), allowedIps (IP du hub), probes (sondes),
 * log (une ligne par requête : date, IP, méthode, chemin, statut ; jamais un en-tête ni un corps).
 */
export function createAgent({ secret, allowedIps, probes = systemProbes, log = () => {} }) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Secret de l'agent absent ou trop court (32 caractères au moins).");
  const allowed = new Set(allowedIps);
  const seen = new Map();

  const server = createServer((req, res) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const path = (req.url ?? "").split("?")[0];
    const nonce = String(req.headers["x-kouzia-hub-nonce"] ?? "");
    const reply = (status, payload) => {
      const body = JSON.stringify(payload);
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      // Réponse signée seulement pour une requête authentifiée (le nonce est alors vérifié).
      if (status !== 401 && status !== 403) headers["x-kouzia-agent-signature"] = signResponse(secret, nonce, status, body);
      res.writeHead(status, headers);
      res.end(body);
      log(`${new Date(probes.now()).toISOString()} ${ip} ${req.method} ${path} ${status}`);
    };

    if (!allowed.has(ip)) return reply(403, { error: "Adresse non autorisée." });

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const timestamp = String(req.headers["x-kouzia-hub-timestamp"] ?? "");
      const signature = String(req.headers["x-kouzia-hub-signature"] ?? "");
      const nowS = Math.floor(probes.now() / 1000);
      if (!TIMESTAMP_RE.test(timestamp) || !NONCE_RE.test(nonce) || Math.abs(nowS - Number(timestamp)) > WINDOW_SECONDS) {
        return reply(401, { error: "Requête non signée ou hors délai." });
      }
      if (!sameText(signature, signRequest(secret, timestamp, nonce, req.method ?? "", path, body))) {
        return reply(401, { error: "Signature invalide." });
      }
      // Rejeu : un nonce sert une fois ; on oublie ceux sortis de la fenêtre.
      for (const [n, at] of seen) if (nowS - at > 2 * WINDOW_SECONDS) seen.delete(n);
      if (seen.has(nonce)) return reply(401, { error: "Requête déjà reçue." });
      seen.set(nonce, nowS);

      const op = operations[`${req.method} ${path}`];
      if (!op) return reply(404, { error: "Opération inconnue." });
      try {
        return reply(200, await op(probes, body));
      } catch {
        return reply(500, { error: "L'opération a échoué sur le CT (journal de l'agent)." });
      }
    });
  });
  server.requestTimeout = 30_000;
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
  const env = readEnvFile("/etc/kouziaphp/agent.env");
  const secret = readText("/etc/kouziaphp/agent.secret") ?? "";
  const port = Number(env.KP_AGENT_PORT ?? 8790);
  const hubIps = (env.KP_AGENT_HUB_IP ?? "").split(/[ ,]+/).filter(Boolean);
  if (!hubIps.length) {
    console.error("KP_AGENT_HUB_IP absent de /etc/kouziaphp/agent.env : kouziaphpctl agent");
    process.exit(1);
  }
  const server = createAgent({
    secret,
    allowedIps: hubIps,
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
