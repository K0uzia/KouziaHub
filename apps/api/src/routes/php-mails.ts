import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PhpMailDetail, PhpMailList, PhpMailRedirect } from "@/contract.js";
import { audit } from "@/lib/audit.js";
import { requireAuth } from "@/lib/auth.js";
import { HttpError } from "@/lib/http.js";
import { idParams } from "@/lib/http-input.js";
import { getSmtpSettings } from "@/lib/mailer.js";
import { phpSite, viaAgent } from "@/lib/php-app.js";
import {
  attachmentOf,
  checkMailId,
  detailOf,
  forgetMail,
  forwardMail,
  loadMail,
  mailHtml,
  mailHtmlCsp,
  markerNow,
  parseRecipients,
  redirectOf,
  setRedirectMarker,
  summaryOf,
  type ForwardDeps,
} from "@/lib/php-mails.js";
import { agentOf } from "@/lib/php-sites.js";
import { prisma } from "@/lib/prisma.js";
import type { Services } from "@/lib/services.js";
import { contentDisposition } from "@/routes/files.js";

// E-mails capturés d'un site PHP (docs/cadrage.md, 11.6, lot P5) : liste, lecture (texte, en-têtes, HTML isolé,
// pièces jointes), remise à une adresse autorisée, option de redirection.

const mailParams = idParams.extend({ mailId: z.string().max(40) });
const pieceParams = mailParams.extend({ n: z.coerce.number().int().min(0).max(999) });
const htmlQuery = z.object({ distant: z.enum(["0", "1"]).optional() });
const redirectSchema = z.object({ enabled: z.boolean().optional(), recipients: z.array(z.string().max(254)).max(20).optional() }).strict();

export function phpMailRoutes(services: Services, deps: Omit<ForwardDeps, "services">): FastifyPluginAsync {
  const forward: ForwardDeps = { services, ...deps };
  return async (app) => {
    app.addHook("onRequest", requireAuth);

    app.get("/api/sites/:id/php/mails", async (request): Promise<PhpMailList> => {
      const site = await phpSite(idParams.parse(request.params).id);
      const mails = await viaAgent(() => agentOf(services).mails(site.slug));
      const smtp = await getSmtpSettings();
      return { mails: mails.map(summaryOf), redirect: redirectOf(site), smtp: { configured: smtp.configured, to: smtp.to } };
    });

    app.patch("/api/sites/:id/php/mails/redirection", async (request): Promise<PhpMailRedirect> => {
      const site = await phpSite(idParams.parse(request.params).id);
      const parsed = redirectSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "Réglage invalide.");
      const recipients = parsed.data.recipients !== undefined ? parseRecipients(parsed.data.recipients) : undefined;
      const enabled = parsed.data.enabled;
      // Option posée : seuls les e-mails arrivés ensuite sont remis (pas l'arriéré des 100 gardés).
      if (enabled && !site.phpMailRedirect) await setRedirectMarker(site.id, markerNow());
      const updated = await prisma.site.update({
        where: { id: site.id },
        data: {
          ...(enabled !== undefined ? { phpMailRedirect: enabled } : {}),
          ...(recipients !== undefined ? { phpMailRecipients: recipients.join("\n") || null } : {}),
        },
      });
      const view = redirectOf(updated);
      await audit({
        action: "site.php.mail.redirect",
        result: "ok",
        siteId: site.id,
        siteSlug: site.slug,
        detail: `${view.enabled ? "activée" : "coupée"}, ${view.recipients.length || "aucune"} adresse(s) autorisée(s)`,
      });
      return view;
    });

    app.get("/api/sites/:id/php/mails/:mailId", async (request): Promise<PhpMailDetail> => {
      const { id, mailId } = mailParams.parse(request.params);
      const site = await phpSite(id);
      return detailOf(await viaAgent(() => loadMail(services, site, mailId)));
    });

    // HTML de l'e-mail, pour un iframe sandbox sans scripts ni même origine : la réponse elle-même interdit scripts,
    // formulaires et tout chargement distant (sauf images, styles et polices si « distant=1 », demandé par un clic).
    app.get("/api/sites/:id/php/mails/:mailId/html", async (request, reply) => {
      const { id, mailId } = mailParams.parse(request.params);
      const remote = htmlQuery.parse(request.query).distant === "1";
      const site = await phpSite(id);
      const html = mailHtml(await viaAgent(() => loadMail(services, site, mailId)));
      if (html === null) throw new HttpError(404, "Cet e-mail n'a pas de version HTML.");
      return reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", mailHtmlCsp(remote))
        .header("X-Frame-Options", "SAMEORIGIN")
        .header("Referrer-Policy", "no-referrer")
        .header("Cache-Control", "private, no-store")
        .send(html);
    });

    app.get("/api/sites/:id/php/mails/:mailId/pieces/:n", async (request, reply) => {
      const { id, mailId, n } = pieceParams.parse(request.params);
      const site = await phpSite(id);
      const piece = attachmentOf(await viaAgent(() => loadMail(services, site, mailId)), n);
      // Toujours en téléchargement, jamais affichée dans le hub (un .html joint ne s'y exécute pas).
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", contentDisposition(piece.filename))
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .send(piece.content);
    });

    app.get("/api/sites/:id/php/mails/:mailId/eml", async (request, reply) => {
      const { id, mailId } = mailParams.parse(request.params);
      const site = await phpSite(id);
      const loaded = await viaAgent(() => loadMail(services, site, mailId));
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", contentDisposition(`${site.slug}-${mailId}.eml`))
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .send(loaded.raw);
    });

    // « Envoyer à mon adresse » : vers l'adresse de réception du SMTP du hub, jamais vers le destinataire d'origine.
    app.post("/api/sites/:id/php/mails/:mailId/envoyer", async (request) => {
      const { id, mailId } = mailParams.parse(request.params);
      const site = await phpSite(id);
      const sentTo = await viaAgent(() => forwardMail(forward, site, checkMailId(mailId), null, "bouton"));
      return { sentTo };
    });

    app.delete("/api/sites/:id/php/mails/:mailId", async (request) => {
      const { id, mailId } = mailParams.parse(request.params);
      const site = await phpSite(id);
      await viaAgent(() => agentOf(services).removeMail(site.slug, checkMailId(mailId)));
      forgetMail(site.slug, mailId);
      return { ok: true };
    });

    app.delete("/api/sites/:id/php/mails", async (request) => {
      const site = await phpSite(idParams.parse(request.params).id);
      const removed = await viaAgent(() => agentOf(services).clearMails(site.slug));
      forgetMail(site.slug);
      await audit({ action: "site.php.mail.clear", result: "ok", siteId: site.id, siteSlug: site.slug, detail: `${removed} e-mail(s) capturé(s) retiré(s)` });
      return { removed };
    });
  };
}
