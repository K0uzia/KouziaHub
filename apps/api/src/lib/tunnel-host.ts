import type { FastifyInstance } from "fastify";

/**
 * Par le tunnel Cloudflare, seul l'hôte du hub (HUB_PUBLIC_ORIGIN, hub.kouzia.com) est servi : tout autre
 * nom d'hôte reçoit la même 404 qu'une route inconnue, comme sur l'ERP (lib/tunnel-hosts.ts). Sans
 * HUB_PUBLIC_ORIGIN, rien n'est servi par le tunnel. Le réseau local (hubctl, OpenRC) n'est pas concerné.
 */
export function getHubPublicHost(): string | null {
  const raw = process.env.HUB_PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    throw new Error(`HUB_PUBLIC_ORIGIN invalide : « ${raw} »`);
  }
}

export function registerTunnelHostGuard(app: FastifyInstance): void {
  const hubHost = getHubPublicHost();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.viaTunnel) return;
    // En-tête Host brut : request.hostname lirait X-Forwarded-Host, fourni par le client.
    const host = request.headers.host?.toLowerCase() ?? "";
    if (hubHost && host === hubHost) return;
    return reply.code(404).send({ error: "Not found" });
  });
}
