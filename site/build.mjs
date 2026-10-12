/* global console */
// Builds https://castra.mehmetozer.dev: the landing page at / and the problem-type pages at /problems/<code> (ADR 0067).
// Source of truth: site/problems.json. Output: site/dist (deploy as static files; extensionless URLs resolve
// to <code>.html on GitHub Pages and Cloudflare static assets alike).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
const problems = JSON.parse(readFileSync(join(root, "problems.json"), "utf8"));
const BASE = "https://castra.mehmetozer.dev/problems/";
const REPO = "https://github.com/ozerozdas/castra";
const VERSION = JSON.parse(readFileSync(join(root, "../packages/core/package.json"), "utf8")).version;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Inline `code` only; everything else is escaped text.
const md = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

const CSS = `
:root{--bg:#fbfaf8;--fg:#1d1d1b;--muted:#5f5e5a;--line:#e4e2dc;--card:#fff;--accent:#c2410c;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a3a29c;--line:#2e2d2a;--card:#1c1c1a;--accent:#fb923c;--code:#262522}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1rem 4rem}
a{color:var(--accent)}
header{font-size:.9rem;color:var(--muted);margin-bottom:2rem}
header a{color:inherit;text-decoration:none}
.brand{font-weight:700;color:var(--fg)}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 .5rem;word-break:break-word}
h2{font-size:1rem;margin:2rem 0 .5rem}
.status{display:inline-block;font:600 .8rem ui-monospace,monospace;padding:.15rem .5rem;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.lead{font-size:1.1rem;margin:1rem 0 0}
code{overflow-wrap:anywhere;font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.1em .3em;border-radius:4px}
pre{background:var(--code);padding:1rem;border-radius:8px;overflow-x:auto;font-size:.85rem}
pre code{background:none;padding:0}
ul{padding-left:1.25rem}
table{width:100%;border-collapse:collapse;font-size:.95rem}
td{border-top:1px solid var(--line);padding:.5rem .25rem;vertical-align:top}
td:first-child{white-space:nowrap;padding-right:1rem}
footer{margin-top:3rem;font-size:.85rem;color:var(--muted)}
`;

const NAV = `<a href="/" class="brand">Castra</a> · <a href="/problems/">Problem types</a>`;

const page = (title, description, body, header = NAV) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<style>${CSS}</style>
</head>
<body><main>
<header>${header}</header>
${body}
<footer>Castra returns errors as <code>application/problem+json</code> (RFC 9457). The <code>type</code> field links here.
Source: <a href="${REPO}">${REPO.replace("https://", "")}</a></footer>
</main></body>
</html>
`;

const LANDING_CSS = `
.hero h1{font-size:2.4rem;letter-spacing:-.02em;margin:0 0 .75rem}
.hero .lead{font-size:1.2rem;color:var(--muted);margin:0 0 1.5rem}
.version{font:600 .8rem ui-monospace,monospace;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:.15rem .6rem;text-decoration:none}
.install{display:flex;gap:.5rem;align-items:center;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:.6rem .6rem .6rem 1rem;margin:0 0 1rem}
.install code{flex:1;background:none;padding:0;font-size:.95rem}
.install button{font:inherit;font-size:.85rem;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:.3rem .7rem;cursor:pointer}
.ctas{display:flex;flex-wrap:wrap;gap:.75rem;margin-bottom:2.5rem}
.btn{display:inline-block;padding:.55rem 1rem;border-radius:8px;text-decoration:none;font-weight:600;border:1px solid var(--line);color:var(--fg)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
figure{margin:0 0 1rem}
figure img{display:block;width:100%;height:auto;border-radius:10px;border:1px solid var(--line)}
figcaption{font-size:.85rem;color:var(--muted);margin-top:.5rem}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1rem;margin:1rem 0 0}
.features div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem}
.features b{display:block;margin-bottom:.25rem}
.features p{margin:0;font-size:.95rem;color:var(--muted)}
section{margin-top:3rem}
section h2{font-size:1.35rem;margin:0 0 .75rem}
.note{border-left:3px solid var(--accent);padding:.25rem 0 .25rem 1rem;color:var(--muted)}
`;

const FEATURES = [
  ["Closed by default", "A table without a policy has no routes. Unknown and closed tables answer the same 404."],
  ["Policies are SQL", "Rules compile to <code>WHERE</code> clauses, so pagination and counts stay correct."],
  ["Checked writes", "Every create and update is verified on the stored row, atomically. Server-set columns never come from the client."],
  ["Auth included", "Better Auth (email, GitHub), roles and API keys, checked against D1 on every request."],
  ["Agent-safe MCP", "Read and write tools on the same engine and write path as REST, with scoped tokens and an audit log."],
  ["Your account", "One Worker and one D1 database in your Cloudflare account. No hosted service in between."],
];

const POLICY = `import { authenticated, defineConfig, isPublic, owner, role } from "@castra-kit/core";

export default defineConfig({
  database: "d1",
  roles: ["admin", "editor"],
  tables: {
    posts: {
      read: isPublic().where((q) => q.eb("status", "=", "published")).or(owner("author_id")),
      create: authenticated(),
      update: owner("author_id").or(role("editor", "admin")),
      delete: role("admin"),
      fields: { author_id: { setBy: "server" } },
    },
  },
});
// Any table not listed here is never exposed.`;

const INSTALL = "npm create @castra-kit@latest my-app";

function landing() {
  const doc = (p) => `${REPO}/blob/master/docs/${p}`;
  const body = `<div class="hero">
<p><a class="version" href="${REPO}/blob/master/CHANGELOG.md">v${VERSION}</a></p>
<h1>A backend on Cloudflare that is closed by default.</h1>
<p class="lead">One Worker and one D1 database in your account serve a REST API for your tables. Every route is
protected by policies written in TypeScript and compiled to SQL, and an MCP server lets AI agents see exactly what
production enforces.</p>
<div class="install"><code>${INSTALL}</code><button type="button" onclick="navigator.clipboard.writeText('${INSTALL}').then(()=>{this.textContent='Copied'})">Copy</button></div>
<div class="ctas"><a class="btn primary" href="${doc("getting-started.md")}">Get started</a>
<a class="btn" href="${REPO}">GitHub</a><a class="btn" href="https://www.npmjs.com/package/@castra-kit/core">npm</a></div>
</div>
<figure><img src="/images/demo.gif" width="1400" height="700" alt="A policy in castra.config.ts, then curl: anonymous users see only public rows, cannot write or set owner_id, and a table without a policy returns 404">
<figcaption>Anonymous reads see only public rows, writes need a session, <code>owner_id</code> is set by the server, and a table without a policy does not exist.</figcaption></figure>
<div class="features">${FEATURES.map(([t, d]) => `<div><b>${t}</b><p>${d}</p></div>`).join("")}</div>
<section><h2>A policy</h2><pre><code>${esc(POLICY)}</code></pre></section>
<section><h2>From zero to a running API</h2>
<figure><img src="/images/quickstart.gif" width="1400" height="700" loading="lazy" alt="npm create, local migrations, the dev server answering /health and /openapi.json, and the policy tests passing">
<figcaption>Scaffold, migrate a local D1, run <code>pnpm dev</code>, and the allow and deny tests pass. Deploy with
<code>CLOUDFLARE_API_TOKEN=... pnpm run deploy</code>.</figcaption></figure></section>
<section><h2>Read before you rely on it</h2>
<p class="note">Castra is early (v${VERSION}). It is deployed and tested, but only writes are rate limited and D1 has a
single writer. See <a href="${doc("limits.md")}">status and limits</a> and the <a href="${doc("SECURITY.md")}">security model</a>.</p>
<p><a href="${doc("concepts.md")}">Concepts</a> · <a href="${doc("rest-api.md")}">REST API</a> · <a href="${doc("auth.md")}">Auth</a> ·
<a href="${doc("mcp.md")}">MCP</a> · <a href="${doc("cli.md")}">CLI</a> · <a href="/problems/">Problem types</a></p></section>`;
  const header = `<a href="/" class="brand">Castra</a> · <a href="${doc("getting-started.md")}">Docs</a> · <a href="/problems/">Problem types</a> · <a href="${REPO}">GitHub</a>`;
  return page("Castra · A backend on Cloudflare, closed by default", "Self-hosted backend on Cloudflare Workers and D1: policies compiled to SQL, Better Auth, auto REST and a read-only MCP server.", body, header)
    .replace("</style>", `${LANDING_CSS}</style>`)
    .replace(/<footer>[\s\S]*?<\/footer>/, `<footer>MIT © Mehmet Özer Özdaş · <a href="${REPO}">${REPO.replace("https://", "")}</a></footer>`);
}

const codes = Object.keys(problems).sort();

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "problems"), { recursive: true });

for (const code of codes) {
  const p = problems[code];
  const example = JSON.stringify({ type: BASE + code, title: "…", status: p.status, detail: "…" }, null, 2);
  const body = `<h1>${esc(code)}</h1>
<span class="status">HTTP ${p.status}</span>
<p class="lead">${md(p.summary)}</p>
<h2>Common causes</h2>
<ul>${p.causes.map((c) => `<li>${md(c)}</li>`).join("")}</ul>
<h2>How to fix</h2>
<p>${md(p.fix)}</p>
<h2>Response</h2>
<pre><code>${esc(example)}</code></pre>
<p><code>detail</code> says what exactly went wrong for this request.</p>`;
  writeFileSync(join(out, "problems", `${code}.html`), page(`${code} · Castra problem type`, p.summary, body));
}

const rows = codes
  .map((c) => `<tr><td><a href="/problems/${c}"><code>${c}</code></a></td><td>${problems[c].status}</td><td>${md(problems[c].summary)}</td></tr>`)
  .join("\n");
const index = page(
  "Castra problem types",
  "Every error type a Castra API can return.",
  `<h1>Problem types</h1>
<p class="lead">Every error a Castra API returns has a <code>type</code> of the form <code>${BASE}&lt;code&gt;</code>.
Clients can branch on it; it does not change between releases.</p>
<table>${rows}</table>`,
);
writeFileSync(join(out, "problems", "index.html"), index);
writeFileSync(join(out, "index.html"), landing());
mkdirSync(join(out, "images"));
for (const gif of ["demo.gif", "quickstart.gif"]) copyFileSync(join(root, "../docs/images", gif), join(out, "images", gif));
writeFileSync(join(out, "404.html"), page("Not found · Castra", "Page not found.", `<h1>Not found</h1><p><a href="/problems/">All problem types</a></p>`));

console.log(`site/dist: landing (v${VERSION}) + ${codes.length} problem pages`);
