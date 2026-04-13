.PHONY: dev kill start stop restart status logs help

AGENTBUS_CONFIG ?= config.yaml
PM2 := ./node_modules/.bin/pm2

## Show available make targets and their descriptions
help:
	@echo "AgentBus Make targets:";
	@awk -F':' ' \
		/^[a-zA-Z0-9_.-]+:/ { \
			gsub(/:.*/, "", $$1); tgt=$$1; \
			if (prev ~ /^##/) { \
				gsub(/^##[ ]?/, "", prev); \
				printf "  %-14s %s\n", tgt, prev; \
			} \
		} { prev=$$0 }' $(MAKEFILE_LIST)

## Run the server in development mode
dev:
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) npx tsx src/index.ts

## Kill the running process
kill:
	-pkill -f "src/index.ts"

## Start the server with pm2
start:
	mkdir -p ~/.agentbus/logs
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) $(PM2) startOrRestart ecosystem.config.cjs
	$(PM2) save

## Stop the server with pm2
stop:
	-$(PM2) stop ecosystem.config.cjs
	-$(PM2) delete ecosystem.config.cjs

## Restart the server with pm2
restart:
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) $(PM2) startOrRestart ecosystem.config.cjs

## Get the status of pm2
status:
	$(PM2) status

## Tail the logs with pm2
logs:
	$(PM2) logs
