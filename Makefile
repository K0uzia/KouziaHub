# Cibles portables : Windows (PowerShell, cmd, Git Bash), Linux et macOS.
# Toute logique passe par node ou npm : GNU make sous Windows lance cmd.exe.
# Windows : GNU make (ex. choco install make) et Node.js 22 dans le PATH.
.PHONY: setup dev dev-lan build test typecheck db-deploy admin

# Premier lancement : .env de dev, dépendances, base, puis compte (e-mail et mot de passe demandés).
setup:
	node scripts/setup-env.mjs
	npm ci --no-audit --no-fund
	@$(MAKE) --no-print-directory db-deploy
	npm run admin:create -- --no-2fa

dev:
	@node scripts/dev.mjs --check-ports
	@node scripts/check-deps.mjs
	@$(MAKE) --no-print-directory db-deploy
	@echo API : http://127.0.0.1:3101
	@echo Interface : http://localhost:5174, proxy /api vers API
	npm run dev

# Comme dev, interface ouverte au téléphone du réseau local (adresse affichée au démarrage).
dev-lan:
	@node scripts/dev.mjs --check-ports
	@node scripts/check-deps.mjs
	@$(MAKE) --no-print-directory db-deploy
	npm run dev -- --lan

build:
	npm run build

test:
	npm test

typecheck:
	npm run typecheck

# Migrations puis client Prisma : un client en retard sur le schéma ferait échouer l'API.
db-deploy:
	npm run db:deploy
	npm run db:generate

admin:
	npm run admin:create
