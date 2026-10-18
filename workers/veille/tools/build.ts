// npm run veille:build : produit workers/veille/dist/index.js (non versionné).
import { WORKER_OUT, bundleWorker } from "./bundle.js";

const code = await bundleWorker(WORKER_OUT);
console.log(`Worker regroupé : ${WORKER_OUT} (${(code.length / 1024).toFixed(1)} Kio)`);
