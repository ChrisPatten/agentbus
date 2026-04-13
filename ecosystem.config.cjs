const path = require("path");

const root = __dirname;
const configPath = process.env.AGENTBUS_CONFIG
  ? path.resolve(process.env.AGENTBUS_CONFIG)
  : path.join(root, "config.yaml");

// Platform adapters (Telegram, BlueBubbles) now run in-process with bus-core.
// Only agent connectors (Claude Code) run as separate processes, spawned by
// their respective runtimes — they are not managed by pm2.
module.exports = {
  apps: [
    {
      name: "bus-core",
      script: path.join(root, "node_modules/.bin/tsx"),
      args: "src/index.ts",
      cwd: root,
      env: {
        AGENTBUS_CONFIG: configPath,
      },
      out_file: `${process.env.HOME}/.agentbus/logs/bus-core-out.log`,
      error_file: `${process.env.HOME}/.agentbus/logs/bus-core-error.log`,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      restart_delay: 1000,
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
