import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getCookieSecure } from "@/lib/env.js";
import { prisma } from "@/lib/prisma.js";

// Appareils reconnus (repris de l'ERP, rememberAdminDevice) : un identifiant aléatoire en cookie, la base
// n'en garde que l'empreinte. Hub mono-utilisateur : la liste tient dans un réglage (HubSetting), sans table.

export const DEVICE_COOKIE = "kz_hub_device";
/** Durée du cookie (400 jours : plafond des navigateurs). */
const DEVICE_TTL_MS = 400 * 86_400_000;
/** Appareils gardés au plus : au-delà, le moins récemment vu est oublié. */
export const MAX_DEVICES = 20;
const KEY = "auth.devices";

type Device = { hash: string; firstSeenAt: string; lastSeenAt: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function readDevices(): Promise<Device[]> {
  const row = await prisma.hubSetting.findUnique({ where: { key: KEY } });
  if (!row) return [];
  try {
    const list = JSON.parse(row.value) as unknown;
    return Array.isArray(list) ? list.filter((d): d is Device => typeof d?.hash === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Enregistre l'appareil d'une connexion réussie. Nouveau : vrai pour un appareil inconnu, sauf le tout
 * premier (rien à signaler à la première connexion).
 */
export async function rememberDevice(request: FastifyRequest, reply: FastifyReply): Promise<{ isNew: boolean }> {
  const existing = request.cookies[DEVICE_COOKIE];
  const deviceId = existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing) ? existing : randomBytes(24).toString("base64url");
  const hash = sha256(deviceId);
  const now = new Date().toISOString();
  const devices = await readDevices();
  const known = devices.find((d) => d.hash === hash);
  if (known) known.lastSeenAt = now;
  else devices.push({ hash, firstSeenAt: now, lastSeenAt: now });
  const kept = devices.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, MAX_DEVICES);
  const value = JSON.stringify(kept);
  await prisma.hubSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  reply.setCookie(DEVICE_COOKIE, deviceId, {
    path: "/api/auth",
    httpOnly: true,
    sameSite: "strict",
    secure: getCookieSecure() || request.viaTunnel,
    expires: new Date(Date.now() + DEVICE_TTL_MS),
  });
  return { isNew: !known && devices.length > 1 };
}

/** Appareil déjà connu (cookie d'une connexion réussie) : jamais mis en attente par les échecs d'un autre. */
export async function isKnownDevice(request: FastifyRequest): Promise<boolean> {
  const id = request.cookies[DEVICE_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{32,64}$/.test(id)) return false;
  const hash = sha256(id);
  return (await readDevices()).some((d) => d.hash === hash);
}

/** Nom lisible de l'appareil d'après son navigateur (« Chrome sur Android »), pour le journal et l'alerte. */
export function describeUserAgent(ua: string | undefined): string {
  if (!ua) return "Appareil inconnu";
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
