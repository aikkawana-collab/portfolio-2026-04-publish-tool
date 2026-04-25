/**
 * Input validator tests
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateProject } from '../lib/input-validator.mjs';
import { ValidationError } from '../lib/errors.mjs';

async function makeProjectRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'iv-test-'));
}

const VALID_YAML = `
title: "Test App"
tagline: "A test"
category: "Web App"
tech_stack:
  - "React"
status: "リリース済"
project_type: "自主開発"
key_metric: "Test metric"
published_at: "2026-04-01"
target_role: "Test role"
overview: "Test overview"
problem:
  - "Problem 1"
solution: "Solution"
features:
  - "Feature 1"
results: "Test results"
`;

test('validateProject: success with all required fields', async () => {
  const root = await makeProjectRoot();
  const slug = 'test-slug';
  const dir = path.join(root, slug);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'portfolio.yaml'), VALID_YAML);
  await fs.writeFile(
    path.join(dir, 'source-repo.txt'),
    'https://github.com/test/repo'
  );
  const meta = await validateProject(slug, root);
  assert.equal(meta.slug, slug);
  assert.equal(meta.yaml.title, 'Test App');
  assert.equal(meta.sourceRepoOwner, 'test');
  assert.equal(meta.sourceRepoName, 'repo');
  assert.equal(meta.yaml.featured, false); // default
  assert.equal(meta.yaml.license, 'MIT'); // default
  await fs.rm(root, { recursive: true, force: true });
});

test('validateProject: missing directory throws', async () => {
  const root = await makeProjectRoot();
  try {
    await validateProject('nonexistent', root);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.ok(err.message.includes('ディレクトリが存在'));
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('validateProject: missing yaml throws', async () => {
  const root = await makeProjectRoot();
  const slug = 'no-yaml';
  const dir = path.join(root, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'source-repo.txt'),
    'https://github.com/test/repo'
  );
  try {
    await validateProject(slug, root);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('validateProject: missing required fields throws with list', async () => {
  const root = await makeProjectRoot();
  const slug = 'missing-fields';
  const dir = path.join(root, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'portfolio.yaml'),
    `title: "Test"\ntagline: "x"\n`
  );
  await fs.writeFile(
    path.join(dir, 'source-repo.txt'),
    'https://github.com/t/r'
  );
  try {
    await validateProject(slug, root);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.ok(err.message.includes('category'), 'Should mention missing fields');
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('validateProject: invalid enum throws', async () => {
  const root = await makeProjectRoot();
  const slug = 'bad-enum';
  const dir = path.join(root, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'portfolio.yaml'),
    VALID_YAML.replace('category: "Web App"', 'category: "InvalidCategory"')
  );
  await fs.writeFile(
    path.join(dir, 'source-repo.txt'),
    'https://github.com/t/r'
  );
  try {
    await validateProject(slug, root);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.ok(err.message.includes('enum'));
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('validateProject: invalid URL throws', async () => {
  const root = await makeProjectRoot();
  const slug = 'bad-url';
  const dir = path.join(root, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'portfolio.yaml'), VALID_YAML);
  await fs.writeFile(path.join(dir, 'source-repo.txt'), 'not-a-url');
  try {
    await validateProject(slug, root);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('validateProject: BOM detection (FR-38)', async () => {
  const root = await makeProjectRoot();
  const slug = 'bom';
  const dir = path.join(root, slug);
  await fs.mkdir(dir, { recursive: true });
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const yamlBuf = Buffer.concat([bom, Buffer.from(VALID_YAML, 'utf8')]);
  await fs.writeFile(path.join(dir, 'portfolio.yaml'), yamlBuf);
  await fs.writeFile(
    path.join(dir, 'source-repo.txt'),
    'https://github.com/t/r'
  );
  try {
    await validateProject(slug, root);
    assert.fail('Should have thrown for BOM');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.ok(err.message.includes('BOM'));
  }
  await fs.rm(root, { recursive: true, force: true });
});
