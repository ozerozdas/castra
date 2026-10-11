/* global console */
// Builds the static problem-type pages served at https://castra.mehmetozer.dev/problems/<code> (ADR 0067).
// Source of truth: site/problems.json. Output: site/dist (deploy as static files; extensionless URLs resolve
// to <code>.html on GitHub Pages and Cloudflare static assets alike).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
const problems = JSON.parse(readFileSync(join(root, "problems.json"), "utf8"));
const BASE = "https://castra.mehmetozer.dev/problems/";
const REPO = "https://github.com/ozerozdas/castra";

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

const page = (title, description, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<style>${CSS}</style>
</head>
<body><main>
<header><a href="/problems/">Castra · Problem types</a></header>
${body}
<footer>Castra returns errors as <code>application/problem+json</code> (RFC 9457). The <code>type</code> field links here.
Source: <a href="${REPO}">${REPO.replace("https://", "")}</a></footer>
</main></body>
</html>
`;

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
writeFileSync(join(out, "index.html"), index);
writeFileSync(join(out, "404.html"), page("Not found · Castra", "Page not found.", `<h1>Not found</h1><p><a href="/problems/">All problem types</a></p>`));

console.log(`site/dist: ${codes.length} problem pages`);
