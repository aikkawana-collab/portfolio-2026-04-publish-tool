/**
 * Errors (G-03 secret masking) tests
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskSecrets,
  maskSecretsInObject,
  SafeError,
  ValidationError,
  NotionApiError,
} from '../lib/errors.mjs';

test('maskSecrets: Notion token', () => {
  const input = 'Auth: <notion-token>';
  assert.ok(!maskSecrets(input).includes('ntn_ABCDEF'));
  assert.ok(maskSecrets(input).includes('[REDACTED:'));
});

test('maskSecrets: GitHub PAT', () => {
  const out = maskSecrets('Token: <github-pat>');
  assert.ok(out.includes('[REDACTED:github-pat]'));
});

test('maskSecrets: OpenAI key', () => {
  const out = maskSecrets('OPENAI=<openai-key>');
  assert.ok(out.includes('[REDACTED:openai-key]'));
});

test('maskSecrets: email', () => {
  const out = maskSecrets('Contact: <email>');
  assert.ok(out.includes('[REDACTED:email]'));
});

test('maskSecrets: JWT', () => {
  const out = maskSecrets('JWT: <jwt>');
  assert.ok(out.includes('[REDACTED:jwt]'));
});

test('maskSecretsInObject: recursive', () => {
  const input = {
    a: '<github-pat>',
    nested: {
      token: '<notion-token>',
    },
    arr: ['<openai-key>'],
  };
  const out = maskSecretsInObject(input);
  assert.ok(!JSON.stringify(out).includes('ghp_ABCDEF'));
  assert.ok(!JSON.stringify(out).includes('ntn_SECRET'));
  assert.ok(!JSON.stringify(out).includes('sk-REDACTTEST'));
});

test('SafeError: masks in message and context', () => {
  const err = new SafeError(
    'Failed for token <github-pat>',
    { apiKey: '<openai-key>' }
  );
  const json = err.toJSON();
  assert.ok(!JSON.stringify(json).includes('ghp_ABCDEF'));
  assert.ok(!JSON.stringify(json).includes('sk-MASKTEST'));
});

test('Custom errors have correct exit codes', () => {
  assert.equal(new ValidationError('x').exitCode, 2);
  assert.equal(new NotionApiError('y').exitCode, 7);
});

test('SafeError preserves non-secret context', () => {
  const err = new SafeError('normal error', { slug: '2026-04-test', step: 5 });
  assert.equal(err.context.slug, '2026-04-test');
  assert.equal(err.context.step, 5);
});
