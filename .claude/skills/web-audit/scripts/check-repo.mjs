#!/usr/bin/env node
/**
 * Hygiène du dépôt : aucun secret ni fichier sensible suivi par Git, .gitignore minimal présent.
 * Usage : node check-repo.mjs (depuis la racine du dépôt). Sortie 1 si erreur.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const errors = [];
const warnings = [];
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0').filter(Boolean);

const FORBIDDEN = [
  /(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /\.(?:pem|key|p12|pfx|keystore|jks)$/,
  /(^|\/)id_(?:rsa|ed25519|ecdsa)$/, /(^|\/)node_modules\//, /\.(?:sqlite3?|db)$/, /(^|\/)\.npmrc$/,
];
tracked.forEach((f) => { if (FORBIDDEN.some((re) => re.test(f))) errors.push(`fichier sensible suivi par Git : ${f}`); });

const gitignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
if (!gitignore) errors.push('.gitignore absent');
['node_modules', '.env'].forEach((needle) => {
  if (!gitignore.split('\n').some((l) => l.trim().replace(/^\/|\/$/g, '').startsWith(needle))) errors.push(`.gitignore ne couvre pas ${needle}`);
});

const SECRET = /(sk_live_[0-9a-zA-Z]{10,}|AKIA[0-9A-Z]{16}|ghp_[0-9a-zA-Z]{30,}|glpat-[0-9a-zA-Z_-]{20}|xox[bap]-[0-9a-zA-Z-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
tracked.filter((f) => !/(^|\/)(?:package-lock\.json|.*\.(?:png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|pdf|zip|mp4|webm))$/i.test(f))
  .forEach((f) => {
    let text;
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) return; text = fs.readFileSync(f, 'utf8'); } catch { return; }
    const s = text.match(SECRET);
    if (s) errors.push(`motif de secret dans ${f} : ${s[1].slice(0, 12)}…`);
    const ip = text.match(PRIVATE_IP);
    if (ip) warnings.push(`IP privée dans ${f} : ${ip[0]} (préférer 203.0.113.x dans la doc)`);
  });

if (fs.existsSync('package.json') && !fs.existsSync('package-lock.json') && !fs.existsSync('pnpm-lock.yaml') && !fs.existsSync('yarn.lock')) {
  warnings.push('aucun fichier de verrouillage des dépendances');
}
if (fs.existsSync('.env') && !fs.existsSync('.env.example')) warnings.push('.env présent sans .env.example versionné');

warnings.forEach((w) => console.log(`  ! ${w}`));
errors.forEach((e) => console.log(`  ✗ ${e}`));
console.log(`${errors.length} erreur(s), ${warnings.length} avertissement(s) sur ${tracked.length} fichier(s) suivi(s).`);
process.exit(errors.length ? 1 : 0);
