import type { MonitorOverview, OrphanReport, PhpAgentState, PhpServerStatus, StorageUsage, SystemStatus } from "@hub/contract";
import { plural } from "@/lib/format";

/** État d'une tuile des Réglages, en un coup d'œil : texte et icône, jamais la couleur seule. */
export type TileStatus = { level: "ok" | "todo" | "error"; label: "Configuré" | "À faire" | "Erreur"; reason: string };

const ok = (reason: string): TileStatus => ({ level: "ok", label: "Configuré", reason });
const todo = (reason: string): TileStatus => ({ level: "todo", label: "À faire", reason });
const error = (reason: string): TileStatus => ({ level: "error", label: "Erreur", reason });

/** Part des projets Cloudflare à partir de laquelle la limite « approche ». */
export const PROJECTS_WARN_RATIO = 0.9;

/** null : lecture en cours (pas encore d'état). */
type Read<T> = { data: T | null | undefined; error: string | null };

export function securityStatus({ data, error: err }: Read<{ enabled: boolean; recoveryCodesRemaining: number }>): TileStatus | null {
  if (err && !data) return error("État de la double authentification illisible.");
  if (!data) return null;
  if (!data.enabled) return todo("Double authentification à activer : sans elle, la connexion par Internet est refusée.");
  if (data.recoveryCodesRemaining === 0) return todo("Plus aucun code de secours : régénérez-en.");
  return ok(`Double authentification active, ${plural(data.recoveryCodesRemaining, "code de secours", "codes de secours")}.`);
}

export function notificationsStatus({ data, error: err }: Read<{ publicKey: string | null; devices: number }>): TileStatus | null {
  if (err && !data) return error("Notifications illisibles.");
  if (!data) return null;
  if (!data.publicKey) return todo("Clés de notification absentes sur le serveur (hubctl push-keys).");
  if (data.devices === 0) return todo("Aucun appareil ne reçoit les alertes.");
  return ok(`${plural(data.devices, "appareil reçoit", "appareils reçoivent")} les alertes.`);
}

export function cloudflareStatus(system: Read<SystemStatus>, orphans: OrphanReport | null): TileStatus | null {
  if (system.error && !system.data) return error("État de Cloudflare illisible.");
  const s = system.data;
  if (!s) return null;
  const { projectsUsed: used, projectsLimit: limit } = s.cloudflare;
  if (orphans?.error) return error(`Vérification des orphelins en échec : ${orphans.error}`);
  if (used != null && used >= limit) return error(`Limite des projets atteinte (${used} sur ${limit}).`);
  if (s.cloudflare.mode === "fake") return todo("Mode démonstration : jeton API du hub à poser (hubctl secrets api).");
  if (used != null && used >= limit * PROJECTS_WARN_RATIO) return todo(`La limite des projets approche (${used} sur ${limit}).`);
  if (orphans && orphans.findings.length > 0) return todo(`${plural(orphans.findings.length, "orphelin", "orphelins")} à regarder.`);
  return ok(used == null ? `Compte réel, limite de ${limit} projets.` : `Compte réel, ${used} projets sur ${limit}.`);
}

export function erpStatus({ data, error: err }: Read<SystemStatus>): TileStatus | null {
  if (err && !data) return error("État du lien ERP illisible.");
  if (!data) return null;
  if (data.erp.mode === "fake") return todo("Clients d'exemple : l'ERP n'est pas encore relié (hubctl secrets erp).");
  if (!data.erp.reachable) return error("ERP injoignable : les noms des clients ne s'affichent pas.");
  return ok("ERP joignable, clients lus en lecture seule.");
}

export function storageStatus({ data, error: err }: Read<StorageUsage>): TileStatus | null {
  if (err && !data) return error("Place utilisée illisible.");
  if (!data) return null;
  const freeable = data.total.orphanBytes + data.total.tempBytes;
  if (freeable > 0) return todo("De la place peut être libérée (temporaires ou fichiers orphelins).");
  return ok("Rien à libérer.");
}

/** Veille prête mais sans rien à surveiller : elle ne passe pas, ce n'est pas une panne. */
export const VEILLE_READY = "Veille prête : ajoutez un site ou une adresse à surveiller.";

export function veilleStatus({ data, error: err }: Read<Pick<MonitorOverview, "health" | "stats">>, now = Date.now()): TileStatus | null {
  if (err && !data) return error("État de la veille illisible.");
  if (!data) return null;
  const edge = data.health.edge;
  if (!edge.configured) return todo("Worker de veille non déployé (hubctl veille deploy) : seule la box surveille.");
  if (edge.error) return error(`Veille en erreur : ${edge.error}`);
  if (data.stats.watched === 0) return todo(VEILLE_READY);
  if (!edge.lastSeenAt) return todo("Veille déployée, pas encore de passage.");
  if (now - Date.parse(edge.lastSeenAt) > 15 * 60_000) return error("Veille muette depuis plus de 15 minutes.");
  return ok("Veille active, passages réguliers.");
}

/** Échecs récents du journal (7 derniers jours) : à regarder s'il y en a. */
export function journalStatus({ data, error: err }: Read<{ errorsLastWeek: number }>): TileStatus | null {
  if (err && !data) return error("Journal illisible.");
  if (!data) return null;
  if (data.errorsLastWeek > 0) return todo(`${plural(data.errorsLastWeek, "échec", "échecs")} sur les 7 derniers jours.`);
  return ok("Aucun échec sur les 7 derniers jours.");
}

/** Rapports : le pied de page du PDF porte un nom et au moins un moyen de contact (e-mail ou téléphone). */
export function reportsStatus({ data, error: err }: Read<{ displayName: string | null; email: string | null; phone: string | null }>): TileStatus | null {
  if (err && !data) return error("Coordonnées des rapports illisibles.");
  if (!data) return null;
  const name = !!data.displayName?.trim();
  const contact = !!data.email?.trim() || !!data.phone?.trim();
  if (!name && !contact) return todo("Coordonnées absentes du pied de page des rapports.");
  if (!name) return todo("Nom affiché absent du pied de page des rapports.");
  if (!contact) return todo("Aucun moyen de contact (e-mail ou téléphone) dans le pied de page des rapports.");
  return ok("Nom et contact imprimés en bas de chaque rapport.");
}

/** Mises à jour de sécurité du CT des sites PHP : alerte au-delà de 14 jours (comme kouziaphpctl status). */
export const PHP_UPGRADE_MAX_DAYS = 14;

const SERVICE_LABEL: Record<keyof PhpAgentState["services"], string> = {
  nginx: "nginx",
  mariadb: "MariaDB",
  tunnel: "tunnel",
  firewall: "pare-feu du CT",
};

/** Jours entiers entre deux dates AAAA-MM-JJ (ou ISO), null si l'une est illisible. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from.slice(0, 10));
  const b = Date.parse(to.slice(0, 10));
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86_400_000);
}

export function phpServerStatus({ data, error: err }: Read<PhpServerStatus>): TileStatus | null {
  if (err && !data) return error("État du serveur des sites PHP illisible.");
  if (!data) return null;
  if (!data.configured) return todo("Pas encore installé : CT des sites PHP et son agent (README, section 11).");
  if (!data.reachable) return error(data.error);
  const s = data.state;
  const stopped = (Object.keys(s.services) as Array<keyof PhpAgentState["services"]>).filter((k) => s.services[k] !== "running");
  if (stopped.length) return error(`Arrêté ou absent : ${stopped.map((k) => SERVICE_LABEL[k]).join(", ")}.`);
  const age = s.lastUpgrade ? daysBetween(s.lastUpgrade, s.time) : null;
  if (age === null || age > PHP_UPGRADE_MAX_DAYS) return todo("Mises à jour de sécurité en retard : kouziaphpctl upgrade dans le CT.");
  return ok(`Joignable : PHP ${s.php.join(", ") || "absent"}, ${plural(s.sites, "site", "sites")}.`);
}
