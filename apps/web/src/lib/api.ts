/** Erreur d'appel : message affichable (jamais le statusText anglais), statut et code éventuel du serveur. */
export type ApiError = Error & { status?: number; code?: string };

export type ApiInit = RequestInit & {
  /** Objet sérialisé en JSON (Content-Type posé ici). */
  json?: unknown;
};

/** Événement émis sur un 401 d'une route protégée : la session a expiré, l'interface repasse par la connexion. */
export const SESSION_EXPIRED_EVENT = "hub:session-expired";

export async function api<T>(path: string, options: ApiInit = {}): Promise<T> {
  const { json, ...init } = options;
  const headers = new Headers(init.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers,
      body: json !== undefined ? JSON.stringify(json) : init.body,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw makeError("Le hub ne répond pas. Vérifiez la connexion puis réessayez.", 0);
  }
  if (!res.ok) throw await errorFrom(res, path);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return undefined as T;
}

async function errorFrom(res: Response, path: string): Promise<ApiError> {
  let message = statusMessage(res.status);
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    /* corps absent ou non JSON : message par statut */
  }
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
  return makeError(message, res.status, code);
}

function makeError(message: string, status: number, code?: string): ApiError {
  return Object.assign(new Error(message), { status, code });
}

export function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

export function errorMessage(error: unknown, fallback = "L'action a échoué. Réessayez."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Envoi multipart avec progression (fetch ne donne pas l'avancement de l'envoi) : XMLHttpRequest.
 * onProgress reçoit une fraction de 0 à 1.
 */
export function upload<T>(
  path: string,
  form: FormData,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: unknown; code?: unknown } | null = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
      const message = typeof body?.error === "string" && body.error ? body.error : statusMessage(xhr.status);
      reject(makeError(message, xhr.status, typeof body?.code === "string" ? body.code : undefined));
    };
    xhr.onerror = () => reject(makeError("L'envoi a été interrompu. Vérifiez la connexion puis réessayez.", 0));
    xhr.onabort = () => reject(Object.assign(new Error("Envoi annulé."), { name: "AbortError" }));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/** Message quand le serveur ne fournit pas le sien. */
export function statusMessage(status: number): string {
  if (status === 401) return "Session expirée. Reconnectez-vous.";
  if (status === 403) return "Action non autorisée.";
  if (status === 404) return "Élément introuvable.";
  if (status === 409) return "Action impossible dans l'état actuel. Rechargez la page.";
  if (status === 413) return "Fichier trop volumineux.";
  if (status === 429) return "Trop de requêtes. Patientez un instant puis réessayez.";
  if (status === 502 || status === 503 || status === 504) return "Le hub ne répond pas. Réessayez dans un instant.";
  if (status >= 500) return "Erreur du serveur. Réessayez ; si le problème revient, notez l'action concernée.";
  return `Requête refusée (erreur ${status}).`;
}
