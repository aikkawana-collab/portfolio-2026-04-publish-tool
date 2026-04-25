/**
 * Announcement generator tests
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  calculateXLength,
  generateAnnouncements,
} from '../lib/announcement-generator.mjs';

const TEMPLATES_DIR = path.join(import.meta.dirname, '..', 'templates');

const sampleMeta = {
  slug: '2026-04-business-app',
  yaml: {
    title: '業績管理アプリ',
    tagline: 'スマホ特化・月額0円',
    category: '業務自動化',
    tech_stack: ['Google Apps Script', 'React', 'TypeScript'],
    key_metric: '月額0円でCalendly代替を実現',
    target_role: '個人事業主向け / 要件定義〜実装',
    problem: ['業績管理ツールは月額制で高い'],
    features: ['ワンタップ記録'],
    results: '月額コスト0円、実装18.5時間。継続利用が可能。',
    highlights: ['Calendly 代替を $0 で実現'],
  },
};

test('calculateXLength: handles URLs and emojis', () => {
  const text = 'Hello 🎉 https://example.com/path';
  const len = calculateXLength(text);
  // "Hello " = 6, emoji = 2, " " = 1, URL = 23
  assert.equal(len, 6 + 2 + 1 + 23);
});

test('calculateXLength: pure ascii', () => {
  assert.equal(calculateXLength('Hello World'), 11);
});

test('generateAnnouncements: creates 3 files with hashtags', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ann-'));
  const result = await generateAnnouncements(sampleMeta, 'https://www.notion.so/xxxx', {
    outDir,
    templatesDir: TEMPLATES_DIR,
  });
  assert.equal(result.files.length, 3);

  for (const f of result.files) {
    const content = await fs.readFile(f, 'utf8');
    assert.ok(content.includes('#個人開発'), `${f} missing #個人開発`);
    const len = calculateXLength(content);
    assert.ok(len <= 280, `${f} is ${len} chars (over 280)`);
  }
  await fs.rm(outDir, { recursive: true, force: true });
});

test('generateAnnouncements: writes teaser with Key Metric', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ann-'));
  const result = await generateAnnouncements(sampleMeta, 'https://n.so/x', {
    outDir,
    templatesDir: TEMPLATES_DIR,
  });
  const teaser = await fs.readFile(
    path.join(outDir, '01-teaser.txt'),
    'utf8'
  );
  assert.ok(teaser.includes(sampleMeta.yaml.key_metric));
  assert.ok(teaser.includes('DMください') || teaser.includes('🙋'));
  await fs.rm(outDir, { recursive: true, force: true });
});

test('generateAnnouncements: secret in content triggers warning', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ann-'));
  const leakedMeta = {
    ...sampleMeta,
    yaml: {
      ...sampleMeta.yaml,
      key_metric: 'Integrated <openai-key> system',
    },
  };
  const result = await generateAnnouncements(leakedMeta, 'https://n.so/x', {
    outDir,
    templatesDir: TEMPLATES_DIR,
  });
  // Should have warnings or reject some files
  assert.ok(
    result.warnings.length > 0 || result.files.length < 3,
    'Should warn or skip on secret content'
  );
  await fs.rm(outDir, { recursive: true, force: true });
});
