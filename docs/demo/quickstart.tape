Output docs/images/quickstart.gif

Require npm
Require openssl

Set Shell bash
Set FontSize 20
Set Width 1400
Set Height 700
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 25ms

Hide
Type "source docs/demo/quickstart-setup.sh && clear"
Enter
Sleep 500ms
Show

Type "npm create @castra-kit@latest backend"
Enter
Hide
Wait+Screen@300s /added .*packages/
Show
Sleep 2s

Type "cd backend"
Enter
Type "cp .dev.vars.example .dev.vars"
Enter
Hide
Type `printf '\nBETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" >> .dev.vars`
Enter
Sleep 500ms
Show

Type "npm run db:migrate:local"
Enter
Hide
Wait+Screen@120s /0003.*✅/
Show
Sleep 2s

Type "npm run test:policies"
Enter
Hide
Wait+Screen@120s /Tests.*passed/
Show
Sleep 2s

Hide
Type "clear"
Enter
Sleep 500ms
Show
Type "npm run dev"
Enter
Hide
Sleep 10s
Show
Sleep 2s
Ctrl+C
Sleep 500ms
