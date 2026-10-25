import type { PhpEnvVar, PhpServerStatus } from "@hub/contract";
import { formatBytes } from "@/lib/format";

/** Ligne de l'écran des variables : clé locale stable (React), nom et valeur saisis. */
export type EnvRow = { key: number; name: string; value: string };

/** Variables à envoyer : lignes vides ignorées, noms en majuscules, espaces retirés autour du nom. */
export function envPayload(rows: EnvRow[]): PhpEnvVar[] {
  return rows.filter((r) => r.name.trim() || r.value).map((r) => ({ name: r.name.trim().toUpperCase(), value: r.value }));
}

/** Vrai si les lignes diffèrent des variables enregistrées (ordre compris : l'ordre affiché est celui du serveur). */
export function envDirty(rows: EnvRow[], saved: PhpEnvVar[]): boolean {
  const now = envPayload(rows);
  return now.length !== saved.length || now.some((v, i) => v.name !== saved[i]!.name || v.value !== saved[i]!.value);
}

/** Clé de paiement réelle (même règle que l'agent) : signalée dès la saisie, refusée à l'enregistrement. */
export const LIVE_KEY_RE = /\b(?:sk|pk|rk)_live_[A-Za-z0-9]/;

/** Plafond de mémoire d'un site (groupe de contrôle) : une requête à pleine mémoire et 256 Mo pour le reste. */
export const siteMemoryMb = (memoryLimitMb: number) => memoryLimitMb + 256;

/**
 * Alerte si la somme des plafonds des sites PHP dépasse la mémoire du CT : un pic simultané réveillerait l'OOM du
 * CT entier. null si tout tient, ou si la mémoire du CT est inconnue.
 */
export function memoryWarning(status: PhpServerStatus | null): string | null {
  if (!status?.configured || !status.reachable || !status.state.memoryBytes) return null;
  const ctMb = Math.round(status.state.memoryBytes / 1024 / 1024);
  if (status.sitesMemoryMb <= ctMb) return null;
  return `Les plafonds de mémoire des sites PHP (${formatBytes(status.sitesMemoryMb * 1024 * 1024)} au total) dépassent la mémoire du CT (${formatBytes(status.state.memoryBytes)}) : baisser la mémoire par requête d'un site, ou augmenter celle du CT dans Proxmox.`;
}
