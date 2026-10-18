import type { FastifyPluginAsync } from "fastify";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { getReportSettings, parseReportSettings, updateReportSettings } from "@/lib/report-settings.js";

/** Réglages du hub : coordonnées du pied de page des rapports mensuels. */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", requireAuth);

  app.get("/api/settings/reports", async () => getReportSettings());

  app.patch("/api/settings/reports", async (request) => {
    const settings = await updateReportSettings(parseReportSettings(request.body));
    await audit({ action: "settings.reports", result: "ok", detail: "coordonnées des rapports" });
    return settings;
  });
};
