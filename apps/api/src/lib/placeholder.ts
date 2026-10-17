/** Page d'attente publiée à la création d'un site : sobre, non indexée, sans contenu inventé. */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Site en préparation</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #f7f7f8; --muted: #55555c; }
@media (prefers-color-scheme: dark) { :root { --fg: #f2f2f3; --bg: #151517; --muted: #b4b4ba; } }
body { display: grid; min-height: 100vh; margin: 0; padding: 1rem; place-items: center; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 36rem; text-align: center; }
h1 { margin: 0 0 0.5rem; font-size: clamp(1.5rem, 4vw, 2rem); }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>Site en préparation</h1>
<p>Ce site est en cours de préparation.</p>
</main>
</body>
</html>
`;
