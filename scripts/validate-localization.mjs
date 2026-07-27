#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DEFAULT_CATALOGS = [
  ["mobile/frontend/src/i18n/locales/en.json", "mobile/frontend/src/i18n/locales/es.json"],
  ["apps/api/src/i18n/locales/en.json", "apps/api/src/i18n/locales/es.json"],
];
const FRONTEND_SOURCE = "mobile/frontend/src";
const BASELINE_FILE = "scripts/localization-baseline.json";
const USER_FACING_ATTRIBUTES = new Set(["alt", "aria-label", "placeholder", "title"]);

function flatten(value, prefix = "", result = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") result.set(fullKey, child);
    else if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, fullKey, result);
    else result.set(fullKey, child);
  }
  return result;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

function normalizedText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function looksUserFacing(text) {
  return /[A-Za-z]/.test(text) && !/^https?:\/\//.test(text);
}

function rawStringsInFile(file, root) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relativeFile = path.relative(root, file).replaceAll(path.sep, "/");
  const findings = [];

  function add(node, kind, rawText) {
    const text = normalizedText(rawText);
    if (!looksUserFacing(text)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file: relativeFile, line: line + 1, kind, text });
  }

  function inspectDisplayExpression(expression, node) {
    if (ts.isStringLiteralLike(expression)) add(node, "jsx-expression", expression.text);
    else if (ts.isConditionalExpression(expression)) {
      inspectDisplayExpression(expression.whenTrue, expression.whenTrue);
      inspectDisplayExpression(expression.whenFalse, expression.whenFalse);
    }
  }

  function visit(node) {
    if (ts.isJsxText(node)) add(node, "jsx-text", node.text);
    if (ts.isJsxAttribute(node) && USER_FACING_ATTRIBUTES.has(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer)) {
      add(node, `attribute:${node.name.text}`, node.initializer.text);
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      inspectDisplayExpression(node.expression, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

export function findRawUserFacingStrings(root, frontendSource = FRONTEND_SOURCE) {
  return sourceFiles(path.join(root, frontendSource)).flatMap((file) => rawStringsInFile(file, root));
}

function translationKeysInFile(file, root) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const relativeFile = path.relative(root, file).replaceAll(path.sep, "/");
  const findings = [];

  function visit(node) {
    if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text === "t" || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t")) {
      const index = relativeFile.startsWith("apps/api/") && ts.isIdentifier(node.expression) ? 1 : 0;
      const argument = node.arguments[index];
      if (argument && ts.isStringLiteralLike(argument)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile));
        findings.push({ file: relativeFile, line: line + 1, key: argument.text });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function fingerprint(finding) {
  return `${finding.file}\0${finding.kind}\0${finding.text}`;
}

export function validateProject(root, options = {}) {
  const errors = [];
  const catalogs = options.catalogs ?? DEFAULT_CATALOGS;
  const catalogMaps = new Map();

  for (const [englishRelative, translatedRelative] of catalogs) {
    const english = flatten(JSON.parse(fs.readFileSync(path.join(root, englishRelative), "utf8")));
    const translated = flatten(JSON.parse(fs.readFileSync(path.join(root, translatedRelative), "utf8")));
    catalogMaps.set(englishRelative, english);
    for (const key of english.keys()) {
      if (!translated.has(key)) errors.push(`${translatedRelative}: missing translation key "${key}"`);
      else if (JSON.stringify(placeholders(english.get(key))) !== JSON.stringify(placeholders(translated.get(key)))) {
        errors.push(`${translatedRelative}: interpolation placeholders differ for "${key}"`);
      }
    }
    for (const key of translated.keys()) {
      if (!english.has(key)) errors.push(`${translatedRelative}: extra translation key "${key}"`);
    }
  }

  const frontendFiles = sourceFiles(path.join(root, options.frontendSource ?? FRONTEND_SOURCE));
  const apiFiles = sourceFiles(path.join(root, "apps/api/src"));
  const frontendCatalog = catalogMaps.get(catalogs[0][0]);
  const apiCatalog = catalogMaps.get(catalogs[1]?.[0]);
  for (const reference of [...frontendFiles, ...apiFiles].flatMap((file) => translationKeysInFile(file, root))) {
    const catalog = reference.file.startsWith("apps/api/") ? apiCatalog : frontendCatalog;
    if (catalog && !catalog.has(reference.key)) errors.push(`${reference.file}:${reference.line}: unknown translation key "${reference.key}"`);
  }

  const baselinePath = path.join(root, options.baselineFile ?? BASELINE_FILE);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : [];
  const remaining = new Map();
  for (const entry of baseline) {
    const key = fingerprint(entry);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const finding of findRawUserFacingStrings(root, options.frontendSource ?? FRONTEND_SOURCE)) {
    const key = fingerprint(finding);
    const allowance = remaining.get(key) ?? 0;
    if (allowance > 0) remaining.set(key, allowance - 1);
    else errors.push(`${finding.file}:${finding.line}: user-facing ${finding.kind} must use a translation key: "${finding.text}"`);
  }

  return errors;
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0
    ? path.resolve(process.argv[rootFlag + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let errors;
  try {
    errors = validateProject(root);
  } catch (error) {
    console.error(`Localization validation could not run: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (errors.length) {
    console.error(`Localization validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Localization validation passed.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
