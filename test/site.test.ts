import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES } from "../src/rules.js";

const PAGES = ["site/index.html", "site/getting-started/index.html"];

/** Built by `npm run build:site`, not committed. */
const BUILT = new Set(["site/assets/engine.js", "site/libpg-query.wasm"]);

describe.each(PAGES)("%s", (page) => {
  const html = readFileSync(page, "utf8");

  it("has no placeholder links or leftover design-tool markup", () => {
    expect(html).not.toMatch(/href="#"/);
    expect(html).not.toMatch(/\{\{|sc-for|sc-if|style-hover|support\.js/);
  });

  it("references only local files that exist", () => {
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    const local = refs.filter((r) => !/^(https?:|mailto:|#)/.test(r)).map((r) => r.split("#")[0]).filter(Boolean);
    expect(local.length).toBeGreaterThan(0);
    for (const ref of local) {
      const target = join(dirname(page), ref.endsWith("/") ? `${ref}index.html` : ref);
      expect(existsSync(target) || BUILT.has(target), `${page} → ${ref}`).toBe(true);
    }
  });

  it("points its Action snippet and links at this repository", () => {
    expect(html).not.toMatch(/schemabrake\/action@|migrations_path|Team Pro\.|Subscription active|free trial/i);
  });
});

it("advertises the full rule set", () => {
  const ids = Object.keys(RULES);
  expect(readFileSync("site/index.html", "utf8")).toContain(`HAZ-01 – ${ids.at(-1)}`);
});

it("tells Pages which domain to serve", () => {
  expect(readFileSync("site/CNAME", "utf8").trim()).toBe("schemabrake.dev");
});

it("loads the parser from where the playground looks for it", () => {
  // libpg_query resolves its .wasm against the page URL, so it must sit beside index.html.
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.scripts["build:site"]).toContain("site/libpg-query.wasm");
});
