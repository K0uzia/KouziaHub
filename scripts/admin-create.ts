// Compte unique du hub : création ou changement du mot de passe, puis double authentification.
// Interactif (hubctl admin) ; sans terminal, lit HUB_ADMIN_EMAIL et HUB_ADMIN_PASSWORD (dev, recette).
//   --no-2fa : pas d'enrôlement TOTP (dev seulement ; par Internet, la connexion l'exige).
import { createInterface } from "node:readline";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/auth.js";
import { otpauthUri } from "@/lib/admin/totp.js";
import { confirmEnrollment, isTwoFactorEnabled, resetTwoFactor, startEnrollment } from "@/lib/admin/two-factor.js";

const MIN_PASSWORD = 12;

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Saisie masquée : rien n'est renvoyé à l'écran après la question.
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main() {
  const interactive = process.stdin.isTTY === true;
  const no2fa = process.argv.includes("--no-2fa");
  const existing = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });

  let email = process.env.HUB_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  let password = process.env.HUB_ADMIN_PASSWORD ?? "";
  if (interactive && !email) {
    email = (await ask(`Adresse e-mail${existing ? ` [${existing.email}]` : ""} : `)).toLowerCase() || existing?.email || "";
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Adresse e-mail invalide.");
  if (interactive && !password) {
    password = await ask(`Mot de passe (${MIN_PASSWORD} caractères au moins) : `, true);
    if ((await ask("Mot de passe, encore une fois : ", true)) !== password) throw new Error("Les deux saisies diffèrent.");
  }
  if (password.length < MIN_PASSWORD) throw new Error(`Mot de passe trop court (${MIN_PASSWORD} caractères au moins).`);

  const passwordHash = await hashPassword(password);
  // Mono-utilisateur : le compte existant est mis à jour, jamais doublé. Ses sessions sont fermées.
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { email, passwordHash, failedLogins: 0, lockedUntil: null } })
    : await prisma.user.create({ data: { email, passwordHash } });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  console.log(existing ? "Compte mis à jour." : "Compte créé.");

  if (no2fa || !interactive) {
    if (!isTwoFactorEnabled(user)) console.log("Double authentification non activée : connexion possible en local seulement.");
    return;
  }
  if (isTwoFactorEnabled(user)) {
    const redo = await ask("La double authentification est déjà active. La refaire (nouveau téléphone) ? [o/N] : ");
    if (!/^o/i.test(redo)) return;
    await resetTwoFactor(user.id);
  }

  const secret = await startEnrollment(user.id);
  const uri = otpauthUri(secret, email, "Kouzia Hub");
  console.log("\nDans l'application d'authentification du téléphone, scannez ce code :\n");
  console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
  console.log(`Ou saisissez la clé : ${secret}\n`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await ask("Code à 6 chiffres affiché par l'application : ");
    const recovery = await confirmEnrollment(user.id, code);
    if (recovery) {
      console.log("\nDouble authentification activée. Codes de secours (à garder sur papier, chacun sert une fois) :\n");
      for (const c of recovery) console.log(`  ${c}`);
      console.log("");
      return;
    }
    console.log("Code incorrect, réessayez.");
  }
  throw new Error("Trois codes incorrects : relancez « hubctl admin ».");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
