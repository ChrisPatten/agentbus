.PHONY: help dev debug-payloads kill start stop restart safe-restart status logs logs-err \
	health test test-one typecheck check pool pool-attach pool-capture approvals

.DEFAULT_GOAL := help

AGENTBUS_CONFIG ?= config.yaml
PM2 := ./node_modules/.bin/pm2
TSX := ./node_modules/.bin/tsx
VITEST := ./node_modules/.bin/vitest
TSC := ./node_modules/.bin/tsc

# Where bus-core listens. Override if `bus.http_port` differs from the default.
BUS_URL ?= http://127.0.0.1:3000
# Only needed when `bus.auth_token` is set in config.yaml.
BUS_TOKEN ?=
CURL := curl -sf $(if $(BUS_TOKEN),-H "X-Bus-Token: $(BUS_TOKEN)")

# GET $(1) from bus-core and pretty-print it. Captures curl's output first so a
# failed request fails the target; piping straight to jq would report jq's
# exit status and hide the failure.
bus_get = out=$$($(CURL) "$(BUS_URL)$(1)") || { echo "request to $(BUS_URL)$(1) failed (bus-core down, or a bad request)" >&2; exit 1; }; echo "$$out" | jq .

# The cc-pool tmux session (`tmux_session` in config.yaml).
POOL_SESSION ?= peggy-pool
LINES ?= 60

## Show available make targets and their descriptions
help:
	@echo "AgentBus Make targets:";
	@awk -F':' ' \
		/^[a-zA-Z0-9_.-]+:/ { \
			gsub(/:.*/, "", $$1); tgt=$$1; \
			if (prev ~ /^##/) { \
				gsub(/^##[ ]?/, "", prev); \
				printf "  %-16s %s\n", tgt, prev; \
			} \
		} { prev=$$0 }' $(MAKEFILE_LIST)

## Run the server in the foreground
dev:
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) $(TSX) src/index.ts

## Run in the foreground, logging raw Telegram payloads without forwarding to agents
debug-payloads:
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) TELEGRAM_DEBUG_PAYLOADS=1 $(TSX) src/index.ts

## Stop pm2's bus-core and any foreground bus-core from this checkout
kill: stop
	-pkill -f "$(CURDIR)/node_modules/.*src/index.ts"

## Start the server with pm2
start:
	mkdir -p ~/.agentbus/logs
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) $(PM2) startOrRestart ecosystem.config.cjs
	$(PM2) save

## Stop the server with pm2
stop:
	-$(PM2) stop ecosystem.config.cjs
	-$(PM2) delete ecosystem.config.cjs

## Restart with pm2, then wait for /health to answer
restart:
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) $(PM2) startOrRestart ecosystem.config.cjs > /dev/null
	@for i in $$(seq 1 30); do \
		if $(CURL) $(BUS_URL)/api/v1/health > /dev/null 2>&1; then echo "bus-core healthy"; exit 0; fi; \
		sleep 1; \
	done; \
	echo "bus-core did not become healthy within 30s; see 'make logs-err'" >&2; exit 1
	@$(PM2) describe bus-core

## Restart with health check and automatic rollback to main (scripts/safe_restart.sh)
safe-restart:
	scripts/safe_restart.sh

## Get the status of pm2
status:
	$(PM2) describe bus-core

## Tail bus-core output (LINES=60 of history)
logs:
	$(PM2) logs bus-core --lines $(LINES)

## Tail bus-core errors only (LINES=60 of history)
logs-err:
	$(PM2) logs bus-core --err --lines $(LINES)

## Show bus-core health
health:
	@$(call bus_get,/api/v1/health)

## Run the full test suite
test:
	$(VITEST) run

## Run one test file (FILE=src/path/to.test.ts)
test-one:
	$(if $(FILE),,$(error FILE is required, e.g. make test-one FILE=src/pool/pane.test.ts))
	$(VITEST) run $(FILE)

## Type-check without building
typecheck:
	$(TSC) --noEmit

## Type-check, then run the full test suite
check: typecheck test

## Show cc-pool pane states and parked-queue depth
pool:
	@$(call bus_get,/api/v1/pool)

## Attach to a pool pane (N=<pane number>, or PANE=<tmux target>)
pool-attach:
	$(if $(or $(N),$(PANE)),,$(error N or PANE is required, e.g. make pool-attach N=1))
	@target="$(or $(PANE),$(POOL_SESSION):$(N))"; \
	if [ -n "$$TMUX" ]; then tmux switch-client -t "$$target"; else tmux attach -t "$$target"; fi

## Print a pool pane's screen (N=<pane number> or PANE=<tmux target>, LINES=60)
pool-capture:
	$(if $(or $(N),$(PANE)),,$(error N or PANE is required, e.g. make pool-capture N=1))
	@tmux capture-pane -t "$(or $(PANE),$(POOL_SESSION):$(N))" -p -S -$(LINES)

## List approval requests (STATUS=pending|approved|denied|expired|stale)
approvals:
	@$(call bus_get,/api/v1/approvals?status=$(or $(STATUS),pending))
