<?php
// Page de recette du serveur des sites PHP (README, section 11.10). Aucun secret, aucun phpinfo :
// elle vérifie l'isolement et affiche OK ou ÉCHEC pour chaque point. Site de test à supprimer après l'essai.
declare(strict_types=1);

header('Content-Type: text/html; charset=utf-8');

// IP de la box (passerelle du CT) : à remplacer si elle n'est pas 192.168.1.1.
const IP_DE_LA_BOX = '192.168.1.1';

$lignes = [];
function ligne(array &$lignes, string $point, bool $ok, string $detail): void
{
    $lignes[] = [$point, $ok, $detail];
}

// 1. Version de PHP (8.2 au moins pour MyTakumi).
ligne($lignes, 'Version de PHP', version_compare(PHP_VERSION, '8.2.0', '>='), PHP_VERSION);

// 2. Dossier persistant : data/ est à côté de public/, gardé d'une version à l'autre.
$fichier = dirname(__DIR__) . '/data/visites.txt';
$visites = (int) @file_get_contents($fichier) + 1;
$ecrit = @file_put_contents($fichier, (string) $visites, LOCK_EX) !== false;
ligne($lignes, 'Écriture dans data/ (persistant)', $ecrit, $ecrit ? "visite n° {$visites}" : 'écriture refusée');

// 3. Enfermement dans le dossier du site (open_basedir).
$hors = @file_get_contents('/etc/passwd');
ligne($lignes, 'Lecture hors du site refusée (/etc/passwd)', $hors === false, $hors === false ? 'refusée' : 'LUE : isolement à revoir');

// 4. Commandes système coupées (disable_functions).
$commandes = array_filter(['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen'], 'function_exists');
ligne($lignes, 'Commandes système coupées', $commandes === [], $commandes === [] ? 'aucune disponible' : 'disponibles : ' . implode(', ', $commandes));

// 5. Sortie HTTPS (paiement Stripe en test) : 401 attendu, la clé manque mais le serveur répond.
$contexte = stream_context_create(['http' => ['timeout' => 8, 'ignore_errors' => true]]);
@file_get_contents('https://api.stripe.com/v1/charges', false, $contexte);
$statut = $http_response_header[0] ?? 'aucune réponse';
ligne($lignes, 'HTTPS sortant (api.stripe.com)', str_contains($statut, '401'), $statut);

// 6. Réseau local fermé (box, NAS, ERP, hub).
$lan = @fsockopen(IP_DE_LA_BOX, 80, $code, $message, 3);
ligne($lignes, 'Réseau local fermé (' . IP_DE_LA_BOX . ':80)', $lan === false, $lan === false ? 'injoignable' : 'JOIGNABLE : pare-feu à revoir');

// 7. SMTP fermé : aucun vrai e-mail ne part du CT.
$smtp = @fsockopen('smtp.gmail.com', 587, $code, $message, 5);
ligne($lignes, 'SMTP sortant fermé (587)', $smtp === false, $smtp === false ? 'injoignable' : 'JOIGNABLE : pare-feu à revoir');

// 8. E-mail capturé (rangé sur le CT, jamais envoyé).
$capture = mail('recette@example.com', 'Recette du serveur PHP', "Message de recette, visite n° {$visites}.");
ligne($lignes, 'E-mail capturé', $capture, $capture ? 'rangé dans mail/ du site' : 'refusé par le capteur');

$echecs = count(array_filter($lignes, fn(array $l): bool => !$l[1]));
?>
<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recette du serveur des sites PHP</title>
  <style>
    body { margin: 0 auto; padding: 1rem; max-width: 46rem; font-family: system-ui, sans-serif; line-height: 1.5; }
    li { margin: 0.4rem 0; }
    strong { display: inline-block; min-width: 4.5rem; }
  </style>
</head>
<body>
  <main>
    <h1>Recette du serveur des sites PHP</h1>
    <p><?= $echecs === 0 ? 'Tous les points sont conformes.' : "{$echecs} point(s) en échec : voir ci-dessous." ?></p>
    <ul>
      <?php foreach ($lignes as [$point, $ok, $detail]): ?>
        <li><strong><?= $ok ? 'OK' : 'ÉCHEC' ?></strong> <?= htmlspecialchars($point) ?> : <?= htmlspecialchars($detail) ?></li>
      <?php endforeach; ?>
    </ul>
  </main>
</body>
</html>
