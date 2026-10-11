# Renders docs/images/quickstart.gif: scaffold, local setup, dev server, policy tests.
# Needs vhs (brew install vhs), node, pnpm, jq and a free port 8787. From the repo root:
#   vhs docs/demo/quickstart.tape
Output docs/images/quickstart.gif

Require jq
Require pnpm

Set Shell bash
Set FontSize 16
Set Width 1400
Set Height 700
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 25ms

Hide
Type "cd $(mktemp -d) && clear"
Enter
Show

Type "npm create @castra-kit@latest my-app"
Enter
# The install is not worth watching: hide it, keep its output.
Hide
Wait+Screen@300s /Next steps/
Wait@10s
Show
Sleep 4s

Type "cd my-app && clear"
Enter
Type `echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .dev.vars`
Enter
Type "pnpm db:migrate:local"
Enter
Wait+Screen@120s /continue\?/
Sleep 1s
Type "y"
Enter
Wait@60s
Sleep 2s
Type "clear"
Enter

Hide
Type "pnpm dev < /dev/null > /dev/null 2>&1 &"
Enter
Type "until curl -sf localhost:8787/health > /dev/null; do sleep 1; done; clear"
Enter
Wait@120s
Show
Type "# pnpm dev is running: http://localhost:8787"
Enter

Type "curl -s localhost:8787/health | jq -c"
Enter
Sleep 1.5s
Type "curl -s localhost:8787/openapi.json | jq -c '.paths | keys'"
Enter
Sleep 2.5s
Type "curl -s localhost:8787/api/notes | jq -c   # empty, and anonymous only sees public rows"
Enter
Sleep 2s

Type "pnpm test:policies 2>&1 | grep -A3 'Test Files'   # allow AND deny tests for every rule"
Enter
Wait+Screen@120s /Duration/
Sleep 4s

Hide
Type "kill %1"
Enter
