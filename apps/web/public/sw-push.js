// Service worker du hub, limité aux notifications (alertes de surveillance) : aucun cache, aucun mode hors ligne,
// aucune interception de requête. Contenu reçu : { title, body, url, tag }, chiffré de bout en bout par le service push.
// Repris de l'ERP (apps/web/sw/sw.ts, partie notifications).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Kouzia Hub";
  const message = { title, body: data.body || "", url: data.url || "/surveillance", tag: data.tag || "" };
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const onScreen = windows.filter((c) => c.visibilityState === "visible" && new URL(c.url).origin === self.location.origin);
      if (onScreen.length === 0) {
        await self.registration.showNotification(title, { body: message.body, tag: message.tag || undefined, lang: "fr", data: { url: message.url } });
        return;
      }
      // Hub à l'écran : le message s'affiche en toast dans la page, pas en notification de l'appareil.
      for (const client of onScreen) client.postMessage({ type: "kouzia-push", ...message });
      // Chaque push doit montrer une notification (userVisibleOnly ; Safari et Firefox retirent sinon
      // l'abonnement) : posée sans son ni vibration, puis retirée aussitôt.
      const tag = `ecran:${message.tag || Date.now()}`;
      await self.registration.showNotification(title, { body: message.body, tag, silent: true, lang: "fr", data: { url: message.url } });
      for (const n of await self.registration.getNotifications({ tag })) n.close();
    })(),
  );
});

// Clic : l'onglet du hub déjà ouvert est réutilisé, sinon une fenêtre s'ouvre sur l'écran visé (fiche ou Surveillance).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const wanted = (event.notification.data && event.notification.data.url) || "/surveillance";
  const target = new URL(wanted, self.location.origin);
  // Jamais d'adresse d'une autre origine depuis une notification.
  const href = target.origin === self.location.origin ? target.href : new URL("/surveillance", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(href);
          return;
        }
      }
      await self.clients.openWindow(href);
    })(),
  );
});
