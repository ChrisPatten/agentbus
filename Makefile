.PHONY: dev stop

AGENTBUS_CONFIG ?= config.yaml

dev:
	@trap 'kill 0' INT TERM; \
	npx tsx src/index.ts & \
	AGENTBUS_CONFIG=$(AGENTBUS_CONFIG) npx tsx src/adapters/telegram.ts & \
	wait
