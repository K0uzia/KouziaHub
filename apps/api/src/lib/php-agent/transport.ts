import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

// Transport du client de l'agent PHP. Le fetch de Node (undici) coupe à 300 s l'attente des en-têtes d'une réponse
// et entre deux morceaux du corps : une version lourde (réception, contrôle, extraction) ou une installation du CT
// pouvait dépasser ce délai et tomber en « injoignable ». node:http n'a aucun délai caché : seul celui de
// l'opération compte (signal). Les erreurs sont classées pour dire la vraie cause.

export type SendBody = string | Readable | undefined;
export type Send = (url: string, init: { method: string; headers: Record<string, string>; body: SendBody; signal: AbortSignal }) => Promise<Response>;

/** Statuts sans corps (Response les refuse avec un corps). */
const NO_BODY = new Set([101, 204, 205, 304]);

export const httpSend: Send = (url, { method, headers, body, signal }) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, signal }, (res) => {
      const status = res.statusCode ?? 502;
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h.set(k, v);
      resolve(new Response(NO_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers: h }));
    });
    // Après une réponse (413 envoyée avant la fin de l'envoi), une erreur d'écriture ne change plus rien.
    req.on("error", reject);
    if (body instanceof Readable) {
      body.on("error", (err) => req.destroy(err));
      body.pipe(req);
    } else req.end(body ?? "");
  });

/** fetch injecté (tests) : même interface, flux convertis pour fetch. */
export const fetchSend =
  (fetchImpl: typeof fetch): Send =>
  (url, { method, headers, body, signal }) =>
    fetchImpl(url, {
      method,
      headers,
      signal,
      ...(body instanceof Readable ? { body: Readable.toWeb(body) as unknown as WebReadableStream, duplex: "half" } : body ? { body } : {}),
    } as RequestInit);

/**
 * Cause d'un échec de connexion, en clair. Délai : celui de l'opération. Refus : agent arrêté ou port fermé.
 * Réseau : adresse ou pare-feu. Coupure : l'agent a fermé la connexion pendant l'échange.
 */
export function failureText(err: unknown, timedOut: boolean, timeoutMs: number, what: string): string {
  if (timedOut || (err as { name?: string } | null)?.name === "TimeoutError") return `Serveur des sites PHP : pas de réponse en ${Math.round(timeoutMs / 1000)} s (${what}).`;
  const e = err as { code?: string; cause?: { code?: string } } | null;
  const code = e?.code ?? e?.cause?.code ?? "";
  if (code === "ECONNREFUSED") return "Serveur des sites PHP injoignable : connexion refusée (agent arrêté, ou port fermé par le pare-feu).";
  if (["EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code)) return `Serveur des sites PHP injoignable : réseau (${code}, adresse du CT ou pare-feu Proxmox).`;
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return `Serveur des sites PHP : connexion coupée pendant l'échange (${what}). Voir le journal de l'agent (/var/log/kouziaphp/agent.err).`;
  return "Serveur des sites PHP injoignable.";
}
