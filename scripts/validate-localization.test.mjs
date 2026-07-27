import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateProject } from "./validate-localization.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "validate-localization.mjs");

function fixture({ component = 'export const Page = () => <h1>{t("page.title")}</h1>;', es = { page: { title: "Hola" } } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "velo-i18n-"));
  fs.mkdirSync(path.join(root, "mobile/frontend/src/i18n/locales"), { recursive: true });
  fs.mkdirSync(path.join(root, "mobile/frontend/src/pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/api/src/i18n/locales"), { recursive: true });
  fs.writeFileSync(path.join(root, "mobile/frontend/src/i18n/locales/en.json"), JSON.stringify({ page: { title: "Hello" } }));
  fs.writeFileSync(path.join(root, "mobile/frontend/src/i18n/locales/es.json"), JSON.stringify(es));
  fs.writeFileSync(path.join(root, "apps/api/src/i18n/locales/en.json"), "{}");
  fs.writeFileSync(path.join(root, "apps/api/src/i18n/locales/es.json"), "{}");
  fs.writeFileSync(path.join(root, "mobile/frontend/src/pages/Page.tsx"), component);
  fs.writeFileSync(path.join(root, "scripts-baseline.json"), "[]");
  return root;
}

function validate(root) {
  return validateProject(root, { baselineFile: "scripts-baseline.json" });
}

test("valid translation additions pass", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(validate(root), []);
});

test("missing translated keys fail", (t) => {
  const root = fixture({ es: {} });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(validate(root).join("\n"), /missing translation key "page\.title"/);
});

test("new hardcoded user-facing strings fail without affecting translated strings", (t) => {
  const root = fixture({ component: 'export const Page = () => <><h1>{t("page.title")}</h1><button>Pay now</button></>;' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const errors = validate(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Pay now/);
});

test("interpolation placeholders must match", (t) => {
  const root = fixture({ es: { page: { title: "Hola {{name}}" } } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(validate(root).join("\n"), /interpolation placeholders differ/);
});

test("CLI exits non-zero when validation fails", (t) => {
  const root = fixture({ es: {} });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing translation key/);
});
