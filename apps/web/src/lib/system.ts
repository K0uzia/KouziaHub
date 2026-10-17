import { useEffect, useState } from "react";
import type { SystemStatus } from "@hub/contract";
import { api } from "@/lib/api";

/** Domaine des versions de travail (décision du 17/10 : <slug>.kouzia.com), tant que /api/system n'a pas répondu. */
const DEFAULT_SITES_DOMAIN = "kouzia.com";

let cache: Promise<SystemStatus> | null = null;

/** État du système lu une fois par session d'onglet (réglages, domaine, capture disponible). */
export function loadSystem(force = false): Promise<SystemStatus> {
  if (!cache || force) {
    cache = api<SystemStatus>("/api/system").catch((err) => {
      cache = null;
      throw err;
    });
  }
  return cache;
}

export function useSystem(): SystemStatus | null {
  const [system, setSystem] = useState<SystemStatus | null>(null);
  useEffect(() => {
    let alive = true;
    loadSystem()
      .then((s) => alive && setSystem(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return system;
}

export function useSitesDomain(): string {
  return useSystem()?.sitesDomain ?? DEFAULT_SITES_DOMAIN;
}
