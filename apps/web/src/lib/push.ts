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

/** Coupe les notifications sur cet appareil (côté navigateur ; le hub retire l'abonnement au prochain envoi refusé). */
export async function disablePushHere(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
}
