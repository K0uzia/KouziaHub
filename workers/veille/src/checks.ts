// Contrôle HTTP d'une cible depuis Cloudflare (cadrage 10.4) : GET, 10 s au plus, 5 redirections au plus,
// statut final 2xx ou 3xx, mot-clé facultatif. Toutes les sous-requêtes passent par un budget partagé.
import type { HttpObservation, MonitorTargetSpec } from "../../../apps/api/src/lib/monitor/core.js";
import { CHECK_TIMEOUT_MS, KEYWORD_SCAN_BYTES, MAX_REDIRECTS, SLOTS, type Deps } from "./env.js";

/** Tranche d'une cible : hachage FNV-1a 32 bits de l'identifiant, stable d'un déploiement à l'autre. */
export function slotOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SLOTS;
}

/** Tranche contrôlée à cette minute. */
export const slotAt = (nowMs: number) => Math.floor(nowMs / 60_000) % SLOTS;

/** Compteur de sous-requêtes partagé par les contrôles concurrents d'un passage. */
export class Budget {
  constructor(public left: number) {}
  take(): boolean {
    if (this.left <= 0) return false;
    this.left -= 1;
    return true;
  }
}

export type CheckResult = { skipped: true } | { skipped: false; obs: HttpObservation };

const isRedirect = (s: number) => s >= 300 && s < 400 && s !== 304;

async function containsKeyword(res: Response, keyword: string): Promise<boolean> {
  if (!res.body) return false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    while (read < KEYWORD_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.includes(keyword)) return true;
      // Seule la fin du texte lu peut encore contenir le début du mot-clé.
      if (text.length > keyword.length * 2) text = text.slice(-keyword.length * 2);
    }
    return false;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function checkTarget(target: MonitorTargetSpec, deps: Deps, budget: Budget, at: number): Promise<CheckResult> {
  const started = deps.now();
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const result = (ok: boolean, status: number | null, reason: string | null): CheckResult => ({
    skipped: false,
    obs: { targetId: target.id, observer: "edge", at, ok, status, ms: status === null ? null : Math.max(0, deps.now() - started), reason },
  });

  let url = target.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!budget.take()) {
      // Premier saut sans budget : cible non contrôlée à ce passage (aucun état écrit).
      if (hop === 0) return { skipped: true };
      return result(false, null, "contrôle interrompu");
    }
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "user-agent": "kouzia-veille/1 (surveillance technique)", accept: "text/html,*/*;q=0.8" },
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return result(false, null, timeout ? "délai dépassé" : "connexion impossible");
    }
    const location = res.headers.get("location");
    if (isRedirect(res.status) && location) {
      await res.body?.cancel().catch(() => undefined);
      try {
        url = new URL(location, url).href;
      } catch {
        return result(false, res.status, "redirection invalide");
      }
      continue;
    }
    if (res.status >= 400 || res.status < 200) {
      await res.body?.cancel().catch(() => undefined);
      return result(false, res.status, `statut ${res.status}`);
    }
    if (target.keyword) {
      const found = await containsKeyword(res, target.keyword).catch(() => false);
      return found ? result(true, res.status, null) : result(false, res.status, "mot-clé absent");
    }
    await res.body?.cancel().catch(() => undefined);
    return result(true, res.status, null);
  }
  return result(false, null, "trop de redirections");
}

/** Exécute fn sur chaque élément, `limit` à la fois au plus (6 connexions sortantes simultanées). */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
