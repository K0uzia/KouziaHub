import type { ErpClient } from "@/contract.js";

export type { ErpClient };

/** Annuaire des clients de l'ERP, en lecture seule. Le hub ne garde que l'identifiant. */
export interface ErpDirectory {
  readonly mode: "http" | "fake";
  /** Clients filtrés par nom ou numéro (sans accent ni casse). Lève ErpUnavailableError si l'ERP ne répond pas. */
  list(q?: string): Promise<ErpClient[]>;
  get(id: string): Promise<ErpClient | null>;
}

export class ErpUnavailableError extends Error {
  constructor(message = "Clients de l'ERP indisponibles.") {
    super(message);
  }
}

export const ERP_CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const foldText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export function filterClients(clients: ErpClient[], q?: string): ErpClient[] {
  const needle = foldText((q ?? "").trim());
  const sorted = [...clients].sort((a, b) => a.displayName.localeCompare(b.displayName, "fr"));
  if (!needle) return sorted;
  return sorted.filter((c) => foldText(c.displayName).includes(needle) || foldText(c.clientNumber ?? "").includes(needle));
}
