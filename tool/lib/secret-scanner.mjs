/**
 * Secret Scanner (第2層: 独立したパターンで残存チェック)
 * FR-13, FR-39, G-06
 *
 * Independent from sanitize-rules.json (ADR-002 redundancy).
 * Different patterns maintained here to detect residuals missed by Layer 1.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { walkTextFiles } from './fs-util.mjs';
import { SanitizeIncompleteError } from './errors.mjs';

/**
 * RESIDUAL_PATTERNS
 * Intentionally independent from sanitize-rules.json
 * Minimum 8 patterns required (FR-13)
 */
const RESIDUAL_PATTERNS = [
  {
    name: 'email',
    regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
    description: 'Email address (RFC5322 simplified)',
  },
  {
    name: 'gas-deployment-id',
    regex: /AKfycb[\w_-]{50,}/g,
    description: 'Google Apps Script Deployment ID',
  },
  {
    name: 'gas-script-id',
    // Google Apps Script ID: 44 chars total, starts with '1', uses [A-Za-z0-9_-]
    // Stricter regex to reduce false positives:
    //  - Must contain at least one letter AND at least one digit (excludes hex/UUID/numeric)
    //  - Surrounding word boundary
    regex: /\b1(?=[\w-]{43}\b)(?=[\w-]*[A-Za-z])(?=[\w-]*[0-9])[\w-]{43}\b/g,
    description: 'Google Apps Script ID (44 chars, mixed alnum)',
  },
  {
    name: 'gcp-oauth',
    regex: /(AIza|ya29\.)[\w_.-]{20,}/g,
    description: 'GCP API Key or OAuth token',
  },
  {
    name: 'notion-token',
    regex: /ntn_\w{30,}/g,
    description: 'Notion Integration Token',
  },
  {
    name: 'github-pat',
    regex: /(ghp_|github_pat_)\w{30,}/g,
    description: 'GitHub Personal Access Token',
  },
  {
    name: 'openai-or-anthropic',
    regex: /sk-(ant-)?[A-Za-z0-9_-]{20,}/g,
    description: 'OpenAI or Anthropic API Key',
  },
  {
    name: 'jwt',
    regex: /eyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{20,}/g,
    description: 'JWT Token',
  },
  {
    name: 'aws-key',
    regex: /AKIA[0-9A-Z]{16}/g,
    description: 'AWS Access Key ID',
  },
  {
    name: 'auth-header',
    regex: /(Basic|Bearer)\s+[A-Za-z0-9+/=_-]{20,}/g,
    description: 'HTTP Auth header',
  },
];

/**
 * Check if a match is a placeholder (safe to ignore)
 */
function isPlaceholder(match) {
  // Standard placeholder format: <...>
  if (/^<[\w-]+>$/.test(match)) return true;
  // Common example/sample indicators
  if (/example\.com|example\.co\.jp|example\.org/i.test(match)) return true;
  if (/SAMPLE|PLACEHOLDER|YOUR_|REPLACE_|REDACTED/i.test(match)) return true;
  if (/test[-_]user|dummy|mock/i.test(match)) return true;
  return false;
}

/**
 * Scan for residual secrets after sanitization.
 * Throws SanitizeIncompleteError if any are found.
 *
 * @param {string} rootPath
 * @param {object} options { skipPatterns, logger }
 */
export async function scanResiduals(rootPath, options = {}) {
  const { skipPatterns = [], logger } = options;
  const findings = [];

  for await (const filePath of walkTextFiles(rootPath, skipPatterns)) {
    try {
      const rawContent = await fs.readFile(filePath, 'utf8');
      if (rawContent.length > 5 * 1024 * 1024) continue; // skip large
      // Normalize to NFC for consistent matching (macOS NFD vs NFC issue)
      const content = rawContent.normalize('NFC');

      for (const pattern of RESIDUAL_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const matches = [...content.matchAll(pattern.regex)];
        for (const m of matches) {
          const matchStr = m[0];
          if (isPlaceholder(matchStr)) continue;
          findings.push({
            file: path.relative(rootPath, filePath),
            pattern: pattern.name,
            description: pattern.description,
            match: matchStr.substring(0, 50) + (matchStr.length > 50 ? '...' : ''),
            offset: m.index,
          });
        }
      }
    } catch (err) {
      await logger?.warn(`Scanner: failed to read ${filePath}: ${err.message}`);
    }
  }

  return {
    findings,
    ok: findings.length === 0,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Enforce: throw if residuals found
 */
export async function enforceNoResiduals(rootPath, options) {
  const result = await scanResiduals(rootPath, options);
  if (!result.ok) {
    throw new SanitizeIncompleteError(
      `Residual secrets detected after sanitization (${result.findings.length} findings)`,
      result.findings
    );
  }
  return result;
}

/**
 * FR-39: Scan a single text string for secrets (for AI-generated content)
 * Returns findings without throwing.
 */
export function scanString(text) {
  const findings = [];
  for (const pattern of RESIDUAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    const matches = [...text.matchAll(pattern.regex)];
    for (const m of matches) {
      if (isPlaceholder(m[0])) continue;
      findings.push({
        pattern: pattern.name,
        match: m[0].substring(0, 50),
        offset: m.index,
      });
    }
  }
  return findings;
}

export { RESIDUAL_PATTERNS };
