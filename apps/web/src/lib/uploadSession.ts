import type { CreateUploadInput, UploadFileDecl, UploadResult, UploadSession } from "@hub/contract";
import { api, isAbort, xhrSend, type ApiError } from "@/lib/api";
import type { PickedFile } from "@/lib/files";
import { sha256Hex, sha256OfLargeBlob } from "@/lib/sha256";

/** Avancement global d'un envoi : préparation (empreintes), envoi des morceaux, finalisation. */
export type SendProgress = {
  phase: "hash" | "send" | "finish";
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
};

/** Nouvelles tentatives d'un morceau après une coupure réseau ou une erreur du serveur. */
const RETRIES = [1000, 3000, 8000];

export class SelectionMismatchError extends Error {
  constructor() {
    super("Ces fichiers ne correspondent pas à l'envoi interrompu (noms, tailles ou contenus différents). Choisissez exactement la même sélection, ou annulez l'envoi interrompu.");
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("Envoi annulé."), { name: "AbortError" }));
      },
      { once: true },
    );
  });

function base(siteId: string) {
  return `/api/sites/${siteId}/uploads`;
}

export function openSessions(siteId: string): Promise<UploadSession[]> {
  return api<UploadSession[]>(base(siteId));
}

export function cancelSession(siteId: string, id: string): Promise<unknown> {
  return api(`${base(siteId)}/${id}`, { method: "DELETE" });
}

/** Morceaux manquants envoyés (avec reprise sur coupure), puis finalisation. */
async function sendChunks(
  siteId: string,
  session: UploadSession,
  sliceOf: (start: number, end: number) => Blob,
  report: (bytesDone: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const received = new Set(session.received);
  let done = session.received.reduce((n, i) => n + Math.min(session.chunkSize, session.totalBytes - i * session.chunkSize), 0);
  report(done);
  for (let n = 0; n < session.chunkCount; n++) {
    if (received.has(n)) continue;
    const start = n * session.chunkSize;
    const end = Math.min(start + session.chunkSize, session.totalBytes);
    const data = await sliceOf(start, end).arrayBuffer();
    const sha = await sha256Hex(data);
    for (let attempt = 0; ; attempt++) {
      try {
        await xhrSend<UploadSession>("PUT", `${base(siteId)}/${session.id}/chunks/${n}`, data, {
          signal,
          headers: { "Content-Type": "application/octet-stream", "X-Chunk-Sha256": sha },
          onProgress: (f) => report(done + f * (end - start)),
        });
        break;
      } catch (err) {
        if (isAbort(err)) throw err;
        const status = (err as ApiError).status ?? 0;
        const transient = status === 0 || status >= 500 || (err as ApiError).code === "chunk_hash_mismatch";
        if (!transient || attempt >= RETRIES.length) throw err;
        await sleep(RETRIES[attempt]!, signal);
      }
    }
    done += end - start;
    report(done);
  }
  return api<UploadResult>(`${base(siteId)}/${session.id}/complete`, { method: "POST", signal });
}

/**
 * Envoi de fichiers par session : empreintes, ouverture (ou reprise d'une session dont la sélection est
 * identique), morceaux de 8 Mio, finalisation. `onSession` reçoit la session dès son ouverture (pour l'annuler).
 */
export async function sendFiles(opts: {
  siteId: string;
  dir: string;
  files: PickedFile[];
  resume?: UploadSession | null;
  signal?: AbortSignal;
  onProgress: (p: SendProgress) => void;
  onSession?: (s: UploadSession) => void;
}): Promise<UploadResult> {
  const { siteId, dir, files, signal, onProgress } = opts;
  const bytesTotal = files.reduce((n, f) => n + f.file.size, 0);
  const decls: UploadFileDecl[] = [];
  let hashed = 0;
  for (const f of files) {
    if (signal?.aborted) throw Object.assign(new Error("Envoi annulé."), { name: "AbortError" });
    decls.push({ path: f.path, size: f.file.size, sha256: await sha256Hex(f.file) });
    hashed += f.file.size;
    onProgress({ phase: "hash", bytesDone: hashed, bytesTotal, filesDone: decls.length, filesTotal: files.length });
  }

  let session: UploadSession;
  if (opts.resume) {
    session = await api<UploadSession>(`${base(siteId)}/${opts.resume.id}`, { signal });
    const prefix = session.dir ? `${session.dir}/` : "";
    const same =
      session.kind === "files" &&
      session.included.length === session.files.length &&
      session.included.every((i, k) => {
        const d = decls[i];
        const s = session.files[k]!;
        return d && prefix + d.path.normalize("NFC") === s.path && d.size === s.size && d.sha256 === s.sha256;
      });
    if (!same) throw new SelectionMismatchError();
  } else {
    const body: CreateUploadInput = { kind: "files", dir, files: decls };
    session = await api<UploadSession>(base(siteId), { method: "POST", json: body, signal });
  }
  opts.onSession?.(session);

  // Flux : fichiers retenus bout à bout, dans l'ordre de la session.
  const parts = session.included.map((i) => files[i]!.file);
  const starts: number[] = [];
  let acc = 0;
  for (const p of parts) {
    starts.push(acc);
    acc += p.size;
  }
  const sliceOf = (start: number, end: number) => {
    const pieces: Blob[] = [];
    for (let k = 0; k < parts.length; k++) {
      const s = starts[k]!;
      const e = s + parts[k]!.size;
      if (e <= start || s >= end) continue;
      pieces.push(parts[k]!.slice(Math.max(0, start - s), Math.min(parts[k]!.size, end - s)));
    }
    return new Blob(pieces);
  };
  const filesTotal = parts.length;
  const result = await sendChunks(
    siteId,
    session,
    sliceOf,
    (bytesDone) => {
      let filesDone = 0;
      for (let k = 0; k < parts.length; k++) if (starts[k]! + parts[k]!.size <= bytesDone) filesDone++;
      onProgress({ phase: bytesDone >= session.totalBytes ? "finish" : "send", bytesDone, bytesTotal: session.totalBytes, filesDone, filesTotal });
    },
    signal,
  );
  return result;
}

/** Envoi d'un zip par session (empreinte calculée par tranches, morceaux de 8 Mio). */
export async function sendZip(opts: {
  siteId: string;
  file: File;
  mode: "replace" | "merge";
  resume?: UploadSession | null;
  signal?: AbortSignal;
  onProgress: (p: SendProgress) => void;
  onSession?: (s: UploadSession) => void;
}): Promise<UploadResult> {
  const { siteId, file, mode, signal, onProgress } = opts;
  const sha256 = await sha256OfLargeBlob(
    file,
    (f) => onProgress({ phase: "hash", bytesDone: f * file.size, bytesTotal: file.size, filesDone: 0, filesTotal: 1 }),
    signal,
  );
  let session: UploadSession;
  if (opts.resume) {
    session = await api<UploadSession>(`${base(siteId)}/${opts.resume.id}`, { signal });
    const z = session.files[0];
    if (session.kind !== "zip" || !z || z.size !== file.size || z.sha256 !== sha256) throw new SelectionMismatchError();
  } else {
    const body: CreateUploadInput = { kind: "zip", mode, name: file.name, size: file.size, sha256 };
    session = await api<UploadSession>(base(siteId), { method: "POST", json: body, signal });
  }
  opts.onSession?.(session);
  return sendChunks(
    siteId,
    session,
    (start, end) => file.slice(start, end),
    (bytesDone) =>
      onProgress({ phase: bytesDone >= session.totalBytes ? "finish" : "send", bytesDone, bytesTotal: session.totalBytes, filesDone: 0, filesTotal: 1 }),
    signal,
  );
}
