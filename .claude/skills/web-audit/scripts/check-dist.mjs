#!/usr/bin/env node
/**
 * Audit statique d'un site construit (dist/) : SEO, JSON-LD, accessibilité de base,
 * liens locaux, variables CSS orphelines, ressources tierces, poids par page.
 * Sans dépendance. Usage : node check-dist.mjs [dist] [https://example.com]
 * Sortie 1 si au moins une erreur.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = path.resolve(process.argv[2] || 'dist');
const SITE = (process.argv[3] || '').replace(/\/$/, '');
const BUDGET_KO = 500;

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

if (!fs.existsSync(DIST)) {
  console.error(`Dossier introuvable : ${DIST} (lancer le build d'abord)`);
  process.exit(2);
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const files = walk(DIST);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const rel = (f) => path.relative(DIST, f);

const decode = (s) => s
  .replace(/&nbsp;/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const norm = (s) => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];
const meta = (html, key) => {
  const t = tags(html, 'meta').find((m) => attr(m, 'name') === key || attr(m, 'property') === key);
  return t ? attr(t, 'content') : null;
};

const isLocal = (url) => url && !/^(?:[a-z]+:)?\/\//i.test(url) && !/^(?:data|mailto|tel|javascript):|^#/i.test(url);
const isOwnAbsolute = (url) => SITE && url.startsWith(SITE);
const resolveLocal = (fromFile, url) => {
  const clean = url.split(/[?#]/)[0];
  if (!clean) return null;
  const base = clean.startsWith('/') ? path.join(DIST, clean) : path.join(path.dirname(fromFile), clean);
  const candidates = [base, path.join(base, 'index.html'), `${base}.html`];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
};

const titles = new Map();
const descriptions = new Map();
const cssDefined = new Set();
const cssUsed = new Map();
const report = [];

const collectCss = (css, file) => {
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) cssDefined.add(m[1]);
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    if (!cssUsed.has(m[1])) cssUsed.set(m[1], { file, fallback: Boolean(m[2]) });
  }
};
files.filter((f) => f.endsWith('.css')).forEach((f) => collectCss(fs.readFileSync(f, 'utf8'), rel(f)));

for (const file of htmlFiles) {
  const name = rel(file);
  const html = fs.readFileSync(file, 'utf8');
  const robots = (meta(html, 'robots') || '').toLowerCase();
  const noindex = robots.includes('noindex') || /^404|\/404/.test(name);

  // Langue et titres
  const htmlTag = tags(html, 'html')[0] || '';
  if (!attr(htmlTag, 'lang')) err(name, '<html> sans attribut lang');
  const h1 = (html.match(/<h1\b/gi) || []).length;
  if (h1 !== 1) err(name, `${h1} élément(s) h1 (attendu : 1)`);
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  levels.forEach((lv, i) => { if (i && lv > levels[i - 1] + 1) warn(name, `saut de titre h${levels[i - 1]} vers h${lv}`); });
  if (!/<main\b/i.test(html)) warn(name, 'pas de <main>');

  // SEO
  const title = norm((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (!title) err(name, 'title absent');
  else if (title.length > 60) warn(name, `title de ${title.length} caractères (> 60)`);
  const desc = meta(html, 'description');
  if (!desc) (noindex ? warn : err)(name, 'meta description absente');
  else if (desc.length < 140 || desc.length > 160) warn(name, `description de ${desc.length} caractères (140 à 160 conseillés)`);
  if (!noindex) {
    if (title) titles.set(title, [...(titles.get(title) || []), name]);
    if (desc) descriptions.set(desc, [...(descriptions.get(desc) || []), name]);
    const canonical = attr(tags(html, 'link').find((l) => attr(l, 'rel') === 'canonical') || '', 'href');
    if (!canonical) err(name, 'canonical absent');
    else if (!/^https:\/\//.test(canonical)) err(name, `canonical non absolu en https : ${canonical}`);
    else if (SITE && !canonical.startsWith(SITE)) warn(name, `canonical hors du domaine ${SITE} : ${canonical}`);
    const ogImage = meta(html, 'og:image');
    if (!ogImage) warn(name, 'og:image absente');
    else if (!/^https:\/\//.test(ogImage)) err(name, `og:image non absolue : ${ogImage}`);
    else if (isOwnAbsolute(ogImage) && !resolveLocal(file, ogImage.slice(SITE.length) || '/')) err(name, `og:image introuvable dans ${path.basename(DIST)} : ${ogImage}`);
    for (const k of ['og:title', 'og:description', 'og:url']) if (!meta(html, k)) warn(name, `${k} absent`);
  }
  if (!tags(html, 'meta').some((m) => attr(m, 'name') === 'viewport')) err(name, 'meta viewport absente');

  // Images
  tags(html, 'img').forEach((img) => {
    const src = attr(img, 'src') || '?';
    if (attr(img, 'alt') === null) err(name, `img sans alt : ${src}`);
    if (!attr(img, 'width') || !attr(img, 'height')) warn(name, `img sans width/height (risque CLS) : ${src}`);
  });

  // Liens locaux, ressources tierces, poids
  let weight = Buffer.byteLength(html);
  let requests = 1;
  const seen = new Set();
  const refs = [...html.matchAll(/\s(?:href|src|poster)\s*=\s*"([^"]+)"/gi)].map((m) => decode(m[1]));
  const srcsets = [...html.matchAll(/\ssrcset\s*=\s*"([^"]+)"/gi)].flatMap((m) => decode(m[1]).split(',').map((s) => s.trim().split(/\s+/)[0]));
  for (const url of [...refs, ...srcsets]) {
    let local = url;
    if (isOwnAbsolute(url)) local = url.slice(SITE.length) || '/';
    if (!isLocal(local)) continue;
    const target = resolveLocal(file, local);
    if (!target) {
      err(name, `lien local cassé : ${url}`);
      continue;
    }
    if (/\.(?:css|js|mjs|woff2?|webp|avif|png|jpe?g|gif|svg|ico|mp4|webm)$/i.test(target) && !seen.has(target)) {
      seen.add(target);
      requests += 1;
      weight += fs.statSync(target).size;
    }
  }
  const loaded = [
    ...tags(html, 'script').map((t) => attr(t, 'src')),
    ...tags(html, 'link').filter((t) => /stylesheet|preload|modulepreload|preconnect|dns-prefetch|icon/i.test(attr(t, 'rel') || '')).map((t) => attr(t, 'href')),
    ...tags(html, 'img').map((t) => attr(t, 'src')),
    ...tags(html, 'iframe').map((t) => attr(t, 'src')),
    ...[...html.matchAll(/url\(\s*['"]?(https?:\/\/[^'")]+)/gi)].map((m) => m[1]),
  ];
  loaded.filter((u) => u && /^(?:https?:)?\/\//i.test(u) && !isOwnAbsolute(u))
    .forEach((u) => warn(name, `ressource tierce chargée : ${u}`));
  const ko = Math.round(weight / 102.4) / 10;
  report.push({ page: name, ko, gzipHtmlKo: Math.round(gzipSync(html).length / 102.4) / 10, requests });
  if (ko > BUDGET_KO) warn(name, `poids local ${ko} Ko > budget ${BUDGET_KO} Ko (non compressé, toutes images comprises)`);

  // CSS inline
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) collectCss(m[1], name);
  for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) collectCss(decode(m[1]), name);

  // JSON-LD
  const visible = norm(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<head\b[\s\S]*?<\/head>/i, ' '));
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { err(name, `JSON-LD invalide : ${e.message}`); continue; }
    const nodes = [];
    const visit = (n) => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!n || typeof n !== 'object') return;
      if (n['@id'] && Object.keys(n).some((k) => !k.startsWith('@'))) nodes.push(n);
      Object.values(n).forEach(visit);
    };
    visit(data);
    const ids = new Map();
    nodes.forEach((n) => ids.set(n['@id'], (ids.get(n['@id']) || 0) + 1));
    ids.forEach((count, id) => { if (count > 1) err(name, `JSON-LD : @id défini ${count} fois : ${id}`); });
    const all = [];
    const flat = (n) => { if (Array.isArray(n)) n.forEach(flat); else if (n && typeof n === 'object') { all.push(n); Object.values(n).forEach(flat); } };
    flat(data);
    all.forEach((n) => {
      const types = [].concat(n['@type'] || []);
      if (types.some((t) => /^(Review|AggregateRating)$/.test(t))) warn(name, `JSON-LD ${types.join(',')} : vérifier que des avis réels sont affichés`);
      for (const [k, v] of Object.entries(n)) if (v === 'true' || v === 'false') err(name, `JSON-LD ${k} : booléen écrit en chaîne`);
      if (types.includes('FAQPage')) {
        [].concat(n.mainEntity || []).forEach((q) => {
          const question = norm(q.name || '');
          const answer = norm([].concat(q.acceptedAnswer || [])[0]?.text || '');
          if (question && !visible.includes(question)) err(name, `FAQPage : question absente du texte visible : « ${question.slice(0, 70)} »`);
          if (answer && !visible.includes(answer)) err(name, `FAQPage : réponse absente du texte visible : « ${answer.slice(0, 70)} »`);
        });
      }
    });
  }
}

titles.forEach((pages, t) => { if (pages.length > 1) err(pages.join(', '), `title dupliqué : ${t}`); });
descriptions.forEach((pages) => { if (pages.length > 1) err(pages.join(', '), 'meta description dupliquée'); });
cssUsed.forEach(({ file, fallback }, v) => {
  if (!cssDefined.has(v)) (fallback ? warn : err)(file, `var(${v}) utilisée mais jamais définie${fallback ? ' (repli présent)' : ''}`);
});

// Fichiers d'indexation
const robotsPath = path.join(DIST, 'robots.txt');
if (!fs.existsSync(robotsPath)) err('robots.txt', 'absent');
else if (!/^Sitemap:\s*https:\/\//mi.test(fs.readFileSync(robotsPath, 'utf8'))) err('robots.txt', 'ligne Sitemap: absolue absente');
const sitemapPath = path.join(DIST, 'sitemap.xml');
if (!fs.existsSync(sitemapPath)) err('sitemap.xml', 'absent');
else {
  const locs = [...fs.readFileSync(sitemapPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (!locs.length) err('sitemap.xml', 'aucune URL');
  locs.forEach((loc) => {
    if (!/^https:\/\//.test(loc)) err('sitemap.xml', `loc non absolu : ${loc}`);
    if (SITE && loc.startsWith(SITE)) {
      const target = resolveLocal(path.join(DIST, 'index.html'), loc.slice(SITE.length) || '/');
      if (!target) err('sitemap.xml', `URL sans page construite : ${loc}`);
      else if (/noindex/i.test(meta(fs.readFileSync(target, 'utf8'), 'robots') || '')) err('sitemap.xml', `URL en noindex : ${loc}`);
    }
  });
}
if (!fs.existsSync(path.join(DIST, 'llms.txt'))) warn('llms.txt', 'absent (découverte par assistants IA)');

console.log('\nPoids par page (fichiers locaux, non compressés)');
console.table(report);
warnings.forEach((w) => console.log(`  ! ${w}`));
errors.forEach((e) => console.log(`  ✗ ${e}`));
console.log(`\n${errors.length} erreur(s), ${warnings.length} avertissement(s) sur ${htmlFiles.length} page(s).`);
process.exit(errors.length ? 1 : 0);
