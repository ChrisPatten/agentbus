#!/bin/bash
# Manual/CI test: safe_restart.sh --dry-run must cope with a pm2 client that
# prints the "In-memory PM2 is out-of-date" banner before valid JSON.
# Needs a healthy bus-core on :3000 for the final "health OK" line; the
# resolution/noise assertions below do not.
set -u
cd "$(dirname "$0")/../.." || exit 1
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/pm2" <<'FAKE'
#!/bin/bash
case "$1" in
  -v) echo 7.0.3 ;;
  jlist) echo ">>>> In-memory PM2 is out-of-date, do:"; echo ">>>> \$ pm2 update"
         echo "In memory PM2 version: 7.0.3"; echo "Local PM2 version: 6.0.14"
         echo '[{"name":"bus-core","pm2_env":{"status":"online"}}]' ;;
  pid) echo 4242 ;;
esac
FAKE
chmod +x "$T/pm2"
# Source just the helper functions.
eval "$(sed -n '/^extract_pm2_json() {/,/^}/p;/^pm2_bus_core_status() {/,/^}/p' scripts/safe_restart.sh)"
PM2="$T/pm2"
st="$(pm2_bus_core_status)"
echo "status through noisy pm2: $st"
[ "$st" = "online" ] || { echo FAIL; exit 1; }
echo "--- full dry run with PM2_BIN=fake ---"
PM2_BIN="$T/pm2" HEALTH_TIMEOUT_S=10 scripts/safe_restart.sh --dry-run
echo PASS
