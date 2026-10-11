# Sourced (hidden) by demo.tape: scaffolds an app from npm, starts it and signs Alice in.
# Needs node, pnpm, jq and port 8811. Run from the repo root: vhs docs/demo/demo.tape
DEMO_DIR=$(mktemp -d)
cd "$DEMO_DIR"
npm create -y @castra-kit@latest my-app >/dev/null 2>&1
cd my-app
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .dev.vars
pnpm -s db:migrate:local >/dev/null 2>&1
pnpm dev --port 8811 >/dev/null 2>&1 &
DEMO_PID=$!
until curl -sf localhost:8811/health >/dev/null; do sleep 1; done
curl -s localhost:8811/api/auth/sign-up/email --json '{"email":"alice@example.com","password":"correct-horse-1","name":"Alice"}' >/dev/null
export API=localhost:8811/api
export ALICE=$(curl -s -D - -o /dev/null $API/auth/sign-in/email \
  --json '{"email":"alice@example.com","password":"correct-horse-1"}' | awk -F': ' 'tolower($1)=="set-auth-token"{print $2}' | tr -d '\r')
