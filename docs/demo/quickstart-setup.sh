DEMO_DIR=$(mktemp -d)
export npm_config_yes=true
export npm_config_update_notifier=false
export NO_COLOR=1
export PS1='$ '
trap 'for pid in $(jobs -pr); do kill "$pid" 2>/dev/null; done; rm -rf "$DEMO_DIR"' EXIT
cd "$DEMO_DIR"

npm() {
  if [ "$*" = 'run dev' ]; then
    command npm run dev
    return
  fi
  local status
  command npm "$@" > "$DEMO_DIR/command.log" 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then
    cat "$DEMO_DIR/command.log"
    return "$status"
  fi
  case "$*" in
    create*) sed -n '/^Created /p; /^added /p; /found 0 vulnerabilities/p' "$DEMO_DIR/command.log" | sed "s|/private$DEMO_DIR/|./|g; s|$DEMO_DIR/|./|g" ;;
    'run db:migrate:local') sed -n '/^Applying migrations/p; /000[0-9].*✅/p' "$DEMO_DIR/command.log" | awk '!seen[$0]++' ;;
    'run test:policies') sed -n '/Test Files.*passed/p; /Tests.*passed/p' "$DEMO_DIR/command.log" ;;
  esac
}
