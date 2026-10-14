# Terminal demo

From the repository root:

```sh
vhs docs/demo/quickstart.tape
npm run site:build
```

Requires VHS, ttyd, ffmpeg, Node.js, npm, openssl, network access, and a free port 8787.

The tape runs the published scaffolder in a temporary directory, applies local migrations, runs policy tests, and starts the development server. The hidden setup generates a fresh auth secret and removes the temporary project on exit. No Cloudflare account or deployment is needed.

`quickstart-setup.sh` filters successful npm output to the actual scaffold, migration, and test summaries. Failures retain their full output. Installation and test waiting time is omitted from the GIF; commands and results remain visible without comment lines.

README and the site both use `docs/images/quickstart.gif`.
