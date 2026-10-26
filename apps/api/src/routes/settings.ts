import type { FastifyPluginAsync } from "fastify";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { HttpError } from "@/lib/http.js";
import { getSmtpSettings, sendFailure, smtpConfig, updateSmtpSettings } from "@/lib/mailer.js";
import { getReportSettings, parseReportSettings, updateReportSettings } from "@/lib/report-settings.js";
import type { Services } from "@/lib/services.js";

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

/** Compte SMTP du hub (lot P5) : remise des e-mails capturés des sites PHP. Mot de passe jamais renvoyé. */
export function smtpSettingsRoutes(services: Services): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/settings/smtp", async () => getSmtpSettings());

    app.patch("/api/settings/smtp", async (request) => {
      const settings = await updateSmtpSettings(request.body);
      await audit({ action: "settings.smtp", result: "ok", detail: `compte SMTP ${settings.configured ? "réglé" : "incomplet"}` });
      return settings;
    });

    // E-mail d'essai vers l'adresse de réception : le réglage est bon quand il arrive.
    app.post("/api/settings/smtp/essai", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async () => {
      const config = await smtpConfig();
      if (!config) throw new HttpError(409, "Renseigner d'abord le serveur, l'adresse d'expédition et l'adresse de réception.", "smtp_unset");
      try {
        await services.mailSender(config, {
          from: config.from,
          to: config.to,
          subject: "Kouzia Hub : e-mail d'essai",
          text: "Le compte SMTP du hub fonctionne. Les e-mails capturés des sites PHP pourront vous être remis.",
        });
      } catch (err) {
        const message = sendFailure(err);
        await audit({ action: "settings.smtp.test", result: "error", detail: message });
        throw new HttpError(502, message, "smtp_failed");
      }
      await audit({ action: "settings.smtp.test", result: "ok", detail: "e-mail d'essai envoyé" });
      return { sentTo: config.to };
    });
  };
}
