/**
 * fs-util tests - critical regression test for UTF-8 handling
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isTextFile, walkTextFiles } from '../lib/fs-util.mjs';

async function tmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'fsu-test-'));
}

test('isTextFile: ASCII text', async () => {
  const dir = await tmp();
  const p = path.join(dir, 'ascii.txt');
  await fs.writeFile(p, 'Hello World');
  assert.equal(await isTextFile(p), true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('isTextFile: Japanese UTF-8 text (regression)', async () => {
  // This is the exact bug that caused the email leak
  const dir = await tmp();
  const p = path.join(dir, 'japanese.md');
  await fs.writeFile(p, `# 日本語のマークダウンファイル

| 本番運用アカウント | \`<email>\`（個人 Gmail、事業用） |
| 開発元アカウント | \`<email>\`（clasp 現在ログイン中） |

本番と開発の区別を明確にする。`);
  const result = await isTextFile(p);
  assert.equal(result, true, 'Japanese UTF-8 files must be recognized as text');
  await fs.rm(dir, { recursive: true, force: true });
});

test('isTextFile: binary file with null bytes', async () => {
  const dir = await tmp();
  const p = path.join(dir, 'binary.bin');
  const buf = Buffer.from([0, 1, 2, 3, 4, 5]);
  await fs.writeFile(p, buf);
  assert.equal(await isTextFile(p), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('isTextFile: invalid UTF-8 byte sequences', async () => {
  const dir = await tmp();
  const p = path.join(dir, 'invalid.bin');
  // Invalid UTF-8 sequence
  const buf = Buffer.from([0xFF, 0xFE, 0x00, 0x80, 0x80]);
  await fs.writeFile(p, buf);
  // Has null byte - definitely binary
  assert.equal(await isTextFile(p), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('isTextFile: PNG header (binary)', async () => {
  const dir = await tmp();
  const p = path.join(dir, 'fake.png');
  const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  await fs.writeFile(p, buf);
  assert.equal(await isTextFile(p), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('walkTextFiles: includes Japanese .md files', async () => {
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, 'ja.md'),
    '# タイトル\n本文です。'
  );
  await fs.writeFile(
    path.join(dir, 'en.md'),
    '# Title\nBody text.'
  );
  const files = [];
  for await (const f of walkTextFiles(dir, [])) {
    files.push(path.basename(f));
  }
  assert.ok(files.includes('ja.md'), `ja.md should be walked, got: ${files.join(', ')}`);
  assert.ok(files.includes('en.md'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('walkTextFiles: skipPatterns excludes binary', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'code.js'), 'const x = 1;');
  await fs.writeFile(path.join(dir, 'img.png'), Buffer.from([0x89, 0x50]));
  const files = [];
  for await (const f of walkTextFiles(dir, ['**/*.png'])) {
    files.push(path.basename(f));
  }
  assert.ok(files.includes('code.js'));
  assert.ok(!files.includes('img.png'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('walkTextFiles: skipPatterns excludes node_modules', async () => {
  const dir = await tmp();
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  await fs.writeFile(path.join(dir, 'main.js'), 'x');
  const files = [];
  for await (const f of walkTextFiles(dir, ['**/node_modules/**'])) {
    files.push(path.relative(dir, f));
  }
  assert.ok(files.includes('main.js'));
  assert.ok(!files.some((f) => f.includes('node_modules')));
  await fs.rm(dir, { recursive: true, force: true });
});
