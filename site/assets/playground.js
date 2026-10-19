// The homepage playground. Runs the same engine as the GitHub Action (assets/engine.js, built
// from src/ by `npm run build:site`) on whatever is in the editor, entirely in the browser.

const SAMPLES = {
  prisma: {
    path: "prisma/migrations/20261018_add_stripe_id/migration.sql",
    sql: `-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- AlterTable
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "legacy_ref";
`,
  },
  drizzle: {
    path: "drizzle/0007_invoice_status.sql",
    sql: `ALTER TYPE "invoice_status" ADD VALUE 'refunded';
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "amount" SET DATA TYPE bigint;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "invoices_user_idx" ON "invoices" ("user_id");
`,
  },
};

const LEVEL = {
  critical: { label: "CRITICAL", bg: "#E5482B", fg: "#fff" },
  warning: { label: "WARNING", bg: "#F2B33D", fg: "#111318" },
  info: { label: "INFO", bg: "#DAD7CF", fg: "#111318" },
};

const $ = (id) => document.getElementById(id);
const editor = $("pg-sql");
const lines = $("pg-lines");
const results = $("pg-results");
const verdict = $("pg-verdict");
const summary = $("pg-summary");
const cardTemplate = $("pg-card");
const cleanTemplate = $("pg-clean");
const ormButtons = document.querySelectorAll("button[data-orm]");

let orm = "prisma";
let engine;
let run = 0;

function setVerdict(text, bg) {
  verdict.textContent = text;
  verdict.style.background = bg;
}

function renderLineNumbers() {
  const count = editor.value.split("\n").length;
  if (lines.childElementCount === count) return;
  lines.replaceChildren(
    ...Array.from({ length: count }, (_, i) => {
      const div = document.createElement("div");
      div.style.paddingRight = "12px";
      div.textContent = String(i + 1);
      return div;
    }),
  );
}

function card({ level, id, name, loc, desc, fix }) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  const field = (f) => node.querySelector(`[data-f="${f}"]`);
  const badge = field("level");
  badge.textContent = LEVEL[level].label;
  badge.style.background = LEVEL[level].bg;
  badge.style.color = LEVEL[level].fg;
  field("id").textContent = id;
  field("name").textContent = name;
  field("loc").textContent = loc;
  field("desc").textContent = desc;
  field("fix").textContent = fix;
  return node;
}

async function analyze() {
  const mine = ++run;
  const sample = SAMPLES[orm];
  const report = await engine.check(sample.path, editor.value, orm);
  if (mine !== run) return; // a newer edit already started

  if (report.error) {
    setVerdict("PARSE ERROR", "#5A5D66");
    summary.textContent = "PostgreSQL could not parse this migration, so no rules ran.";
    results.replaceChildren(
      card({
        level: "info",
        id: "SQL",
        name: "Syntax error",
        loc: report.error.line ? `Line ${report.error.line}` : "",
        desc: report.error.message,
        fix: "The Action fails the check on SQL that does not parse. Fix the statement and the report comes back.",
      }),
    );
    return;
  }

  const f = report.findings;
  const crit = f.filter((x) => x.severity === "critical").length;
  const warn = f.filter((x) => x.severity === "warning").length;
  const info = f.length - crit - warn;
  setVerdict(crit ? "MERGE BLOCKED" : warn ? "REVIEW NEEDED" : "SAFE TO MERGE", crit ? "#E5482B" : warn ? "#B7791F" : "#2F7D4F");
  summary.textContent =
    `Evaluated 1 migration file against production safety rules: ${crit} critical, ` +
    `${warn} warning${warn === 1 ? "" : "s"}, ${info} info.`;
  results.replaceChildren(
    ...(f.length
      ? f.map((x) =>
          card({
            level: x.severity,
            id: x.rule,
            name: engine.RULES[x.rule].name,
            loc: x.rule === "HAZ-06" ? "File" : `Line ${x.line}`,
            desc: x.message,
            fix: x.advice,
          }),
        )
      : [cleanTemplate.content.firstElementChild.cloneNode(true)]),
  );
}

let pending;
function schedule() {
  renderLineNumbers();
  if (!engine) return;
  clearTimeout(pending);
  pending = setTimeout(analyze, 120);
}

function pick(next) {
  orm = next;
  for (const b of ormButtons) {
    const on = b.dataset.orm === orm;
    b.setAttribute("aria-pressed", String(on));
    b.style.background = on ? "#F4F2EC" : "transparent";
    b.style.color = on ? "#111318" : "#9A9DA6";
  }
  $("pg-path").textContent = SAMPLES[orm].path;
  editor.value = SAMPLES[orm].sql;
  schedule();
}

for (const b of ormButtons) b.addEventListener("click", () => pick(b.dataset.orm));
$("pg-reset").addEventListener("click", () => pick(orm));
editor.addEventListener("input", schedule);
editor.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
  schedule();
});

editor.value = SAMPLES.prisma.sql;
renderLineNumbers();
import("./engine.js")
  .then(async (mod) => {
    await mod.ready();
    engine = mod;
    await analyze();
  })
  .catch(fail);

function fail(err) {
  console.error(err);
  setVerdict("UNAVAILABLE", "#5A5D66");
  summary.textContent = "The playground could not load the PostgreSQL parser in this browser. The GitHub Action is unaffected.";
  results.replaceChildren();
}
