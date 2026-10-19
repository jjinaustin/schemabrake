"""Converts the design exports in design/*.dc.html into the static site in site/.

    python3 scripts/convert-design.py design site

Keeps the designer's markup and inline styles; replaces only what the design tool's runtime
provided (style-hover, {{ bindings }}, sc-for/sc-if) and the copy and links edited below.
Every edit must match exactly once, so a revised design file fails loudly instead of silently.
The playground's behaviour lives in site/assets/playground.js, not here.
"""
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1])  # design/
OUT = Path(sys.argv[2])  # site/

REPO = "https://github.com/jjinaustin/schemabrake"
DOCS = f"{REPO}#readme"
MARKETPLACE = "https://github.com/marketplace/actions/schemabrake"
ISSUES = f"{REPO}/issues"
EMAIL = "support@schemabrake.dev"
WAITLIST = f"mailto:{EMAIL}?subject=Team%20Pro%20waitlist"


def split(doc: str):
    helmet = re.search(r"<helmet>(.*?)</helmet>", doc, re.S).group(1).strip()
    body = re.search(r"</helmet>(.*?)</x-dc>", doc, re.S).group(1).strip()
    return helmet, body


def edit(text: str, edits: list[tuple[str, str]], name: str) -> str:
    for old, new in edits:
        n = text.count(old)
        if n != 1:
            raise SystemExit(f"{name}: expected exactly one match, found {n}: {old[:90]!r}")
        text = text.replace(old, new)
    return text


def hovers(body: str) -> tuple[str, str]:
    """style-hover="..." -> a class with a :hover rule (!important beats the inline style)."""
    rules, seen = [], {}

    def repl(m):
        decls = m.group(1)
        if decls not in seen:
            seen[decls] = f"hv{len(seen) + 1}"
            important = ";".join(f"{d.strip()} !important" for d in decls.split(";") if d.strip())
            rules.append(f".{seen[decls]}:hover{{{important}}}")
        return f'class="{seen[decls]}"'

    body = re.sub(r'style-hover="([^"]*)"', repl, body)
    return body, "".join(rules)


def page(title: str, description: str, path: str, root: str, helmet: str, css: str, body: str, scripts: str = "") -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="https://schemabrake.dev{path}">
<link rel="icon" type="image/svg+xml" href="{root}icons/schemabrake-ink-square.svg">
<link rel="icon" type="image/png" sizes="32x32" href="{root}icons/favicon-32.png">
<link rel="apple-touch-icon" href="{root}icons/apple-touch-icon-180.png">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="https://schemabrake.dev{path}">
<meta property="og:image" content="https://schemabrake.dev/icons/app-icon-1024.png">
<meta name="theme-color" content="#111318">
{helmet}
<style>{css}</style>
</head>
<body>
{body}
{scripts}</body>
</html>
"""


# ---------------------------------------------------------------- homepage
helmet, body = split((SRC / "Homepage.dc.html").read_text())
body = edit(body, [
    # Links
    ('<a href="#" style="display:flex;align-items:center;gap:10px">\n<svg width="32"',
     '<a href="./" aria-label="SchemaBrake home" style="display:flex;align-items:center;gap:10px">\n<svg width="32"'),
    ('<a href="#playground">Playground</a>\n<a href="#features">Features</a>\n<a href="#pricing">Pricing</a>\n<a href="#">Docs</a>',
     f'<a class="nav-section" href="#playground">Playground</a>\n<a class="nav-section" href="#features">Features</a>\n'
     f'<a class="nav-section" href="#pricing">Pricing</a>\n<a class="nav-section" href="{DOCS}">Docs</a>'),
    ('<a href="#" style="background:#111318;color:#F4F2EC;padding:9px 16px;border-radius:8px"',
     '<a href="getting-started/" style="background:#111318;color:#F4F2EC;padding:9px 16px;border-radius:8px"'),
    ('<a href="#" style="display:flex;align-items:center;gap:10px;background:#E5482B',
     f'<a href="{MARKETPLACE}" style="display:flex;align-items:center;gap:10px;background:#E5482B'),
    ('<a href="#" style="display:flex;align-items:center;gap:10px;background:transparent',
     f'<a href="{REPO}" style="display:flex;align-items:center;gap:10px;background:transparent'),
    ('<a href="#" style="text-align:center;padding:14px;border-radius:10px;border:1.5px solid #111318;font-weight:700"',
     '<a href="getting-started/" style="text-align:center;padding:14px;border-radius:10px;border:1.5px solid #111318;font-weight:700"'),
    ('<a href="#" style="text-align:center;padding:14px;border-radius:10px;background:#E5482B;color:#fff;font-weight:700"',
     f'<a href="{WAITLIST}" style="text-align:center;padding:14px;border-radius:10px;background:#E5482B;color:#fff;font-weight:700"'),
    ('<a href="#" style="color:#5A5D66">Docs</a><a href="#" style="color:#5A5D66">GitHub</a><a href="#" style="color:#5A5D66">Marketplace</a>',
     f'<a href="{DOCS}" style="color:#5A5D66">Docs</a><a href="{REPO}" style="color:#5A5D66">GitHub</a>'
     f'<a href="{MARKETPLACE}" style="color:#5A5D66">Marketplace</a><a href="mailto:{EMAIL}" style="color:#5A5D66">Contact</a>'),
    # Copy that the product doesn't back up yet
    ('100% open source for public repos', 'Open source, MIT licensed'),
    ('Runs in &lt; 5 seconds', 'PostgreSQL’s own parser'),
    ('Full rule set included (HAZ-01 – HAZ-06)', 'Full rule set included (HAZ-01 – HAZ-09)'),
    ('>14-day free trial</span>', '>Coming soon</span>'),
    ('>Start free trial</a>', '>Join the waitlist</a>'),
    # Playground: dc bindings -> elements the playground script drives
    ('<button onClick="{{ pickPrisma }}" style="border:0;cursor:pointer;font-family:\'JetBrains Mono\',monospace;font-size:14px;padding:8px 16px;border-radius:7px;background:{{ prismaBg }};color:{{ prismaFg }}">',
     '<button type="button" data-orm="prisma" aria-pressed="true" style="border:0;cursor:pointer;font-family:\'JetBrains Mono\',monospace;font-size:14px;padding:8px 16px;border-radius:7px;background:#F4F2EC;color:#111318">'),
    ('<button onClick="{{ pickDrizzle }}" style="border:0;cursor:pointer;font-family:\'JetBrains Mono\',monospace;font-size:14px;padding:8px 16px;border-radius:7px;background:{{ drizzleBg }};color:{{ drizzleFg }}">',
     '<button type="button" data-orm="drizzle" aria-pressed="false" style="border:0;cursor:pointer;font-family:\'JetBrains Mono\',monospace;font-size:14px;padding:8px 16px;border-radius:7px;background:transparent;color:#9A9DA6">'),
    ('<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ filePath }}</span>',
     '<span id="pg-path" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">prisma/migrations/20261018_add_stripe_id/migration.sql</span>'),
    ('<button onClick="{{ reset }}" style=', '<button type="button" id="pg-reset" style='),
    ('<sc-for list="{{ lineNums }}" as="n" hint-placeholder-count="10"><div style="padding-right:12px">{{ n }}</div></sc-for>',
     '<div id="pg-lines" aria-hidden="true"></div>'),
    ('<textarea value="{{ sql }}" onChange="{{ onSql }}" spellCheck="false" style=',
     '<textarea id="pg-sql" aria-label="Migration SQL" spellcheck="false" wrap="off" style='),
    ('background:{{ verdictBg }};color:#fff">{{ verdict }}</span>',
     'background:#5A5D66;color:#fff" id="pg-verdict">LOADING</span>'),
    ('line-height:1.5">{{ summary }}</div>', 'line-height:1.5" id="pg-summary" aria-live="polite">Loading the PostgreSQL parser…</div>'),
], "Homepage")

# The result list: the card markup becomes a <template> the script clones per finding.
card = re.search(r'<sc-for list="\{\{ results \}\}" as="r" hint-placeholder-count="2">\n(.*?)\n</sc-for>', body, re.S)
clean = re.search(r'<sc-if value="\{\{ clean \}\}" hint-placeholder-val="\{\{ false \}\}">\n(.*?)\n</sc-if>', body, re.S)
card_html = card.group(1)
# The fix text follows a "Fix: " label inside the same element, so it gets a span of its own.
card_html = edit(card_html, [("</span>{{ r.fix }}</div>", '</span><span data-f="fix"></span></div>')], "card fix")
for binding, attr in [("{{ r.level }}", "level"), ("{{ r.id }}", "id"), ("{{ r.name }}", "name"),
                      ("{{ r.loc }}", "loc"), ("{{ r.desc }}", "desc")]:
    card_html = edit(card_html, [(f">{binding}<", f' data-f="{attr}"><')], f"card {attr}")
card_html = edit(card_html, [("background:{{ r.bg }};color:{{ r.fg }}", "")], "card colours")
clean_html = clean.group(1).replace("<div style=", '<div data-f="clean" style=', 1)
body = body.replace(card.group(0), '<div id="pg-results" style="display:contents"></div>')
body = body.replace(clean.group(0), "")
body += f'\n<template id="pg-card">{card_html}</template>\n<template id="pg-clean">{clean_html}</template>'

assert "{{" not in body and "sc-for" not in body and "sc-if" not in body, "unconverted dc binding"
body, css = hovers(body)
(OUT / "index.html").write_text(page(
    "SchemaBrake: catch dangerous database migrations before they merge",
    "A GitHub Action that reads Prisma and Drizzle migrations with PostgreSQL's own parser and flags table locks and data loss in the pull request. No database access.",
    "/", "", helmet, css + "textarea#pg-sql{tab-size:2}@media (max-width:640px){a.nav-section{display:none}}", body,
    '<script type="module" src="assets/playground.js"></script>\n'))

# ---------------------------------------------------------------- getting started
helmet, body = split((SRC / "Welcome.dc.html").read_text())
YAML_HTML = """<span style="color:#9A9DA6">name:</span> Database Safety Check
<span style="color:#9A9DA6">on:</span> pull_request
<span style="color:#9A9DA6">permissions:</span>
  <span style="color:#9A9DA6">contents:</span> read
  <span style="color:#9A9DA6">pull-requests:</span> write
<span style="color:#9A9DA6">jobs:</span>
  <span style="color:#9A9DA6">schemabrake:</span>
    <span style="color:#9A9DA6">runs-on:</span> ubuntu-latest
    <span style="color:#9A9DA6">steps:</span>
      - <span style="color:#9A9DA6">uses:</span> actions/checkout@v5
      - <span style="color:#9A9DA6">uses:</span> <span style="color:#FF7A5C">jjinaustin/schemabrake@v1</span>"""
old_pre = re.search(r"(<pre [^>]*>)(.*?)</pre>", body, re.S)
body = body.replace(old_pre.group(0), f'{old_pre.group(1)}<code id="yaml">{YAML_HTML}</code></pre>')
body = edit(body, [
    ('<a href="Homepage.dc.html" style=', '<a href="../" aria-label="SchemaBrake home" style='),
    ('<span style="font-family:\'JetBrains Mono\',monospace;font-size:12px;background:#111318;color:#F4F2EC;padding:5px 10px;border-radius:999px">TEAM PRO</span>\n', ''),
    ('</span>Subscription active', '</span>Getting started'),
    ('Welcome to SchemaBrake <span style="color:#E5482B">Team Pro.</span>',
     'Protect your first repository <span style="color:#E5482B">in a minute.</span>'),
    ('Your subscription is active. Let’s get your first repository protected in under a minute.',
     'Add one workflow file. Every pull request that changes a migration then gets a safety report before it can merge.'),
    ('<button onClick="{{ copy }}" style="border:1px solid #2C3038;background:{{ copyBg }};color:#F4F2EC;font-family:\'JetBrains Mono\',monospace;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer">{{ copyLabel }}</button>',
     '<button type="button" id="copy" style="border:1px solid #2C3038;background:transparent;color:#F4F2EC;font-family:\'JetBrains Mono\',monospace;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer">Copy</button>'),
    ('Using Drizzle? Change both paths to <code style="font-family:\'JetBrains Mono\',monospace">drizzle/**</code> and <code style="font-family:\'JetBrains Mono\',monospace">./drizzle</code>.',
     'SchemaBrake finds Prisma and Drizzle migrations on its own. Keep yours somewhere else? Add <code style="font-family:\'JetBrains Mono\',monospace">with: paths: db/migrations</code> under the last step.'),
    ('Push this file to a branch and open a PR. SchemaBrake will automatically scan your migration directory and post its first report.',
     'Push this file, then open a pull request that changes a migration. SchemaBrake posts its report as a comment, updates that same comment on every push, and marks each hazard on its line in the diff.'),
    ('Need help with custom rules or webhooks?', 'Questions or feedback?'),
    (f'or ask in our <a href="#" style="color:#E5482B;font-weight:500">Discord</a>.',
     f'or open an issue on <a href="{ISSUES}" style="color:#E5482B;font-weight:500">GitHub</a>.'),
    ('<a href="#" style="padding:14px 20px;border-radius:10px;background:#E5482B;color:#fff;font-weight:700"',
     '<a href="../#playground" style="padding:14px 20px;border-radius:10px;background:#E5482B;color:#fff;font-weight:700"'),
    ('>Return to Dashboard</a>', '>Try the playground</a>'),
    ('<a href="#" style="padding:14px 20px;border-radius:10px;border:1.5px solid #111318;font-weight:700"',
     f'<a href="{DOCS}" style="padding:14px 20px;border-radius:10px;border:1.5px solid #111318;font-weight:700"'),
    ('>View Documentation</a>', '>Read the docs</a>'),
], "Welcome")
assert "{{" not in body and 'href="#"' not in body
body, css = hovers(body)
COPY_JS = """<script>
document.getElementById("copy").addEventListener("click", (e) => {
  const button = e.currentTarget;
  navigator.clipboard?.writeText(document.getElementById("yaml").textContent).then(() => {
    button.textContent = "Copied";
    button.style.background = "#2F7D4F";
    clearTimeout(button._t);
    button._t = setTimeout(() => { button.textContent = "Copy"; button.style.background = "transparent"; }, 1800);
  }, () => { button.textContent = "Select and copy"; });
});
</script>
"""
(OUT / "getting-started").mkdir(exist_ok=True)
(OUT / "getting-started" / "index.html").write_text(page(
    "Get started with SchemaBrake",
    "Add SchemaBrake to a repository in one workflow file: every pull request that changes a Prisma or Drizzle migration gets a safety report.",
    "/getting-started/", "../", helmet, css + "@media (max-width:640px){p code{overflow-wrap:anywhere}}", body, COPY_JS))
print("wrote", OUT / "index.html", OUT / "getting-started" / "index.html")
