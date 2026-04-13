.PHONY: dev kill start stop restart status logs

AGENTBUS_CONFIG ?= config.yaml
PM2 := ./node_modules/.bin/pm2

dev:
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) npx tsx src/index.ts

kill:
	-pkill -f "src/index.ts"

start:
	mkdir -p ~/.agentbus/logs
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) $(PM2) startOrRestart ecosystem.config.cjs
	$(PM2) save

stop:
	-$(PM2) stop ecosystem.config.cjs
	-$(PM2) delete ecosystem.config.cjs

restart:
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) $(PM2) startOrRestart ecosystem.config.cjs

status:
	$(PM2) status

logs:
	$(PM2) logs
