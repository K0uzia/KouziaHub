import type { PushDevice } from "@hub/contract";
import { api } from "@/lib/api";

/** Service worker limité aux notifications (public/sw-push.js), sur tout le hub. */
const SW_URL = "/sw-push.js";

/** Notifications possibles sur ce navigateur ? (repris de l'ERP, lib/push.ts) */
export type PushSupport = "ok" | "insecure" | "unsupported";

export function pushSupport(): PushSupport {
  // Le push exige https (ou localhost).
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return "unsupported";
  return "ok";
}

/** Nom lisible de l'appareil, pour la liste (« Chrome sur Android »). */
export function deviceLabel(ua = navigator.userAgent): string {
  const browser = /SamsungBrowser/i.test(ua)
    ? "Samsung Internet"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Navigateur";
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad/i.test(ua)
      ? "iPhone"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X/i.test(ua)
          ? "Mac"
          : /Linux/i.test(ua)
            ? "Linux"
            : "appareil inconnu";
  return `${browser} sur ${os}`;
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Abonnement de cet appareil (null si aucun). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Demande l'autorisation, abonne l'appareil et l'enregistre sur le hub. */
export async function enablePush(publicKey: string): Promise<{ permission: NotificationPermission; device: PushDevice | null }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { permission, device: null };
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  const device = await api<PushDevice>("/api/push/subscribe", {
    method: "POST",
    json: { subscription: sub.toJSON(), label: deviceLabel() },
  });
  return { permission, device };
}

/** Désabonne cet appareil : navigateur puis hub (appareil reconnu par son adresse d'abonnement). */
export async function disablePush(devices: PushDevice[]): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const mine = devices.find((d) => d.endpoint === sub.endpoint);
  await sub.unsubscribe();
  if (mine) await api(`/api/push/devices/${mine.id}`, { method: "DELETE" });
}

/** Notification reçue pendant que le hub est à l'écran : le service worker la passe à la page (toast). */
export type ForegroundPush = { title: string; body: string; url: string; tag: string };
export type PushToastKind = "success" | "error" | "warning" | "info";

/** Pastille du toast d'après la notification (titres du hub et de la veille, workers/veille/src/push.ts). */
export function pushToastKind(p: { title: string; tag?: string }): PushToastKind {
  if ((p.tag ?? "").startsWith("test:")) return "info";
  if (/^(Rétabli|Site rétabli|Hub de nouveau en ligne)\b|sites rétablis$/.test(p.title)) return "success";
  if (/^(Panne|Site en panne|Toujours en panne|Hub hors ligne)\b|sites (toujours )?en panne$/.test(p.title)) return "error";
  return "warning";
}

/** Écran à ouvrir : chemin du hub seulement, jamais une autre origine. */
export function pushTarget(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? url : "/surveillance";
}

/** Écoute les notifications passées par le service worker ; renvoie la fonction qui arrête l'écoute. */
export function onForegroundPush(handler: (push: ForegroundPush) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => undefined;
  const listener = (event: MessageEvent) => {
    const d = event.data as Partial<ForegroundPush> & { type?: string };
    if (d?.type !== "kouzia-push" || typeof d.title !== "string") return;
    handler({ title: d.title, body: typeof d.body === "string" ? d.body : "", url: pushTarget(typeof d.url === "string" ? d.url : ""), tag: typeof d.tag === "string" ? d.tag : "" });
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
