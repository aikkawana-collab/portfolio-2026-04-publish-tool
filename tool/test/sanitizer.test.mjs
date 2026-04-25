/**
 * Sanitizer tests
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRules, sanitize } from '../lib/sanitizer.mjs';
import { scanString, enforceNoResiduals } from '../lib/secret-scanner.mjs';
import { SanitizeIncompleteError } from '../lib/errors.mjs';

const RULES_PATH = path.join(import.meta.dirname, '..', 'sanitize-rules.json');

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'sanitizer-test-'));
}

test('loadRules: loads 15+ rules', async () => {
  const rules = await loadRules(RULES_PATH);
  assert.ok(rules.rules.length >= 15, `Expected ≥15 rules, got ${rules.rules.length}`);
  assert.ok(rules.hash && rules.hash.length === 64);
  assert.ok(rules.skipPatterns.length > 0);
});

test('sanitize: replaces email', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'app.js'), 'const email = "<email>";');
  const rules = await loadRules(RULES_PATH);
  const report = await sanitize(dir, rules);
  const content = await fs.readFile(path.join(dir, 'app.js'), 'utf8');
  assert.ok(!content.includes('<email>'));
  assert.ok(content.includes('<email>'));
  assert.ok(report.replacements.length > 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('sanitize: replaces GAS Script ID and Deployment ID', async () => {
  const dir = await makeTempDir();
  const code = `
    const SCRIPT_ID = "<script-id>f";
    const DEPLOY = "<deployment-id>";
  `;
  await fs.writeFile(path.join(dir, 'config.js'), code);
  const rules = await loadRules(RULES_PATH);
  await sanitize(dir, rules);
  const content = await fs.readFile(path.join(dir, 'config.js'), 'utf8');
  assert.ok(content.includes('<script-id>'));
  assert.ok(content.includes('<deployment-id>'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('sanitize: FR-9.1 placeholders excluded from re-matching', async () => {
  const dir = await makeTempDir();
  // Sanitized value must not be re-processed
  await fs.writeFile(path.join(dir, 'already.md'), '連絡先: <email>');
  const rules = await loadRules(RULES_PATH);
  await sanitize(dir, rules);
  const content = await fs.readFile(path.join(dir, 'already.md'), 'utf8');
  assert.equal(content, '連絡先: <email>');
  await fs.rm(dir, { recursive: true, force: true });
});

test('scanString: detects real secrets', () => {
  const findings = scanString('API_KEY=<openai-key>');
  assert.ok(findings.length > 0);
});

test('scanString: ignores placeholders', () => {
  const findings = scanString('email: <email>, key: <openai-key>, user: <email>');
  assert.equal(findings.length, 0, 'Placeholders and example.com should be excluded');
});

test('enforceNoResiduals: throws on residuals', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'leak.js'), 'secret = "<openai-key>";');
  try {
    await enforceNoResiduals(dir);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof SanitizeIncompleteError);
    assert.ok(err.findings.length > 0);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('enforceNoResiduals: passes clean code', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'clean.js'), 'const key = "<openai-key>";');
  const result = await enforceNoResiduals(dir);
  assert.ok(result.ok);
  await fs.rm(dir, { recursive: true, force: true });
});

test('sanitize: skipPatterns exclude binary files', async () => {
  const dir = await makeTempDir();
  // Create a fake "image" (binary)
  const buf = Buffer.alloc(100);
  buf[0] = 0x89;
  buf[1] = 0x50;
  await fs.writeFile(path.join(dir, 'image.png'), buf);
  await fs.writeFile(path.join(dir, 'code.js'), 'const x = 1;');
  const rules = await loadRules(RULES_PATH);
  const report = await sanitize(dir, rules);
  // image.png should not be in processed files (skipPattern excludes)
  assert.ok(!report.replacements.find((r) => r.file === 'image.png'));
  await fs.rm(dir, { recursive: true, force: true });
});
