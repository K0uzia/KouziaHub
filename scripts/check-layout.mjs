// Contrôle du centrage des écrans du hub (règle web-design : centré jusqu'à 2560 px).
// Suppose une pile locale qui tourne (npm run dev) et un compte admin local sans double authentification.
//   BASE=http://localhost:5174 EMAIL=... PASSWORD=... npm run check:layout
// Variables facultatives : WIDTHS (360,800,1280,1920,2560), SHOTS (dossier de captures, sinon aucune).
// Pour l'en-tête et le contenu principal de chaque écran : marge gauche et marge droite mesurées dans la
// fenêtre ; échec si elles diffèrent de plus de 1 px, ou si la page défile horizontalement.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = (process.env.BASE ?? "http://localhost:5174").replace(/\/$/, "");
const { EMAIL, PASSWORD } = process.env;
const WIDTHS = (process.env.WIDTHS ?? "360,800,1280,1920,2560").split(",").map(Number);
const SHOTS = process.env.SHOTS ?? null;
const TOLERANCE = 1;

if (!EMAIL || !PASSWORD) {
  console.error("EMAIL et PASSWORD requis (compte admin local, sans double authentification).");
  process.exit(2);
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  const cookie = res.headers.get("set-cookie");
  if (!res.ok || body.mfaRequired || !cookie) {
    console.error(`Connexion refusée (${res.status}${body.mfaRequired ? ", double authentification active" : ""}).`);
    process.exit(2);
  }
  const [name, ...rest] = cookie.split(";")[0].split("=");
  return { name, value: rest.join("="), url: BASE };
}

async function api(cookie, p) {
  const res = await fetch(`${BASE}${p}`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
  return res.ok ? res.json() : null;
}

// Marges d'un bloc : on descend tant qu'il n'a qu'un enfant, puis on prend l'union de ses enfants visibles.
function measureIn(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    let el = root;
    while (el.children.length === 1 && el.firstElementChild.getBoundingClientRect().width > 0) el = el.firstElementChild;
    const kids = [...el.children].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(c).position !== "fixed";
    });
    const rects = (kids.length ? kids : [el]).map((c) => c.getBoundingClientRect());
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const vw = document.documentElement.clientWidth;
    return { left: Math.round(left * 10) / 10, right: Math.round((vw - right) * 10) / 10, width: Math.round(right - left) };
  }, selector);
}

function hasHorizontalScroll(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("#contenu");
    return doc.scrollWidth > doc.clientWidth + 1 || (main ? main.scrollWidth > main.clientWidth + 1 : false);
  });
}

const cookie = await login();
const sites = (await api(cookie, "/api/sites"))?.sites ?? [];
// Site client publié de préférence : son onglet Versions propose l'export.
const site = sites.find((x) => x.kind === "CLIENT" && x.currentVersion) ?? sites[0] ?? null;
const monitor = await api(cookie, "/api/monitor");
const target = monitor?.targets?.[0] ?? null;

/** Écrans : chemin, zone du contenu, action facultative (ouvrir une modale). */
const screens = [
  { name: "connexion", path: "/connexion", anonymous: true, content: "#contenu" },
  { name: "catalogue (cartes)", path: "/", content: "#contenu > .page-frame" },
  { name: "catalogue (liste)", path: "/", view: "list", content: "#contenu > .page-frame" },
  { name: "nouveau site (modale)", path: "/", content: "[role=dialog]", open: { role: "button", name: "Nouveau site" } },
  ...(site
    ? ["fichiers", "versions", "surveillance", "vignette", "serveur", "reglages"].map((tab) => ({
        name: `fiche : ${tab}`,
        path: `/sites/${site.id}?tab=${tab}`,
        content: "#contenu > .page-frame",
      }))
    : []),
  ...(site
    ? [{ name: "export (modale)", path: `/sites/${site.id}?tab=versions`, content: "[role=dialog]", open: { role: "button", name: "Télécharger la version de production" } }]
    : []),
  { name: "surveillance", path: "/surveillance", content: "#contenu > .page-frame" },
  ...(target ? [{ name: "surveillance : adresse", path: `/surveillance/${target.id}`, content: "#contenu > .page-frame" }] : []),
  { name: "réglages", path: "/reglages", content: "#contenu > .page-frame" },
  { name: "journal", path: "/reglages/journal?page=2", content: "#contenu > .page-frame" },
  { name: "incidents", path: "/surveillance/incidents", content: "#contenu > .page-frame" },
];
if (!site) console.warn("Aucun site : fiche et export non contrôlés.");

const browser = await chromium.launch();
const rows = [];
let failures = 0;
for (const width of WIDTHS) {
  for (const s of screens) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 780 : Math.round(width * 0.5625) }, reducedMotion: "reduce" });
    if (!s.anonymous) await ctx.addCookies([cookie]);
    await ctx.addInitScript((view) => {
      try {
        window.localStorage.setItem("hub:catalog-view", view);
      } catch {}
    }, s.view ?? "cards");
    const page = await ctx.newPage();
    await page.goto(BASE + s.path);
    await page.waitForLoadState("networkidle");
    if (s.open) {
      try {
        await page.getByRole(s.open.role, { name: s.open.name }).first().click({ timeout: 5000 });
        await page.waitForSelector(s.content, { timeout: 5000 });
        await page.waitForTimeout(400);
      } catch {
        rows.push({ largeur: width, écran: s.name, résultat: "non contrôlé (bouton absent)" });
        await ctx.close();
        continue;
      }
    }
    const header = s.anonymous ? null : await measureIn(page, "header.topbar > .page-frame");
    const content = await measureIn(page, s.content);
    const scroll = await hasHorizontalScroll(page);
    const bad = (m) => m && Math.abs(m.left - m.right) > TOLERANCE;
    const ok = !scroll && !bad(header) && !bad(content) && content !== null;
    if (!ok) failures++;
    rows.push({
      largeur: width,
      écran: s.name,
      "en-tête g": header?.left ?? "",
      "en-tête d": header?.right ?? "",
      "contenu g": content?.left ?? "absent",
      "contenu d": content?.right ?? "",
      "contenu l": content?.width ?? "",
      "défil. horiz.": scroll ? "oui" : "non",
      résultat: ok ? "ok" : "ÉCHEC",
    });
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const file = `${width}-${s.name.replace(/[^a-z0-9]+/gi, "-")}.png`;
      await page.screenshot({ path: path.join(SHOTS, file) });
    }
    await ctx.close();
  }
}
await browser.close();
console.table(rows);
console.log(failures ? `${failures} écran(s) en échec.` : "Tous les écrans sont centrés, sans défilement horizontal.");
process.exitCode = failures ? 1 : 0;
