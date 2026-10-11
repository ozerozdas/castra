# Renders docs/images/demo.gif. Needs vhs (brew install vhs), node, pnpm and jq.
#   vhs docs/demo/demo.tape
Output docs/images/demo.gif

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
Type "source docs/demo/setup.sh && clear"
Enter
Wait@180s
Show

Type "# Every table is closed unless castra.config.ts gives it a policy"
Enter
Type "sed -n '/notes: {/,/^    },/p' castra.config.ts"
Enter
Sleep 3s

Type "# Alice signs in and writes a public note"
Enter
Type `curl -s $API/notes -H "authorization: Bearer $ALICE" --json '{"title":"Hello, world","is_public":1}' | jq -c '{title, is_public}'`
Enter
Sleep 2s
Type `curl -s $API/notes -H "authorization: Bearer $ALICE" --json '{"title":"My diary"}' | jq -c .title`
Enter
Sleep 2s

Type "# Anonymous visitors only see public rows (the policy is a SQL WHERE)"
Enter
Type "curl -s $API/notes | jq -c '.data[].title'"
Enter
Sleep 2s

Type "# ...and cannot write"
Enter
Type `curl -s $API/notes --json '{"title":"spam"}' | jq -c '{status, detail}'`
Enter
Sleep 2s

Type "# owner_id is set by the server, never taken from the client"
Enter
Type `curl -s $API/notes -H "authorization: Bearer $ALICE" --json '{"title":"x","owner_id":"bob"}' | jq -c '{status, detail}'`
Enter
Sleep 2.5s

Type "# No policy, no route"
Enter
Type "curl -s $API/users | jq -c '{status, title}'"
Enter
Sleep 4s

Hide
Type "kill $DEMO_PID"
Enter
