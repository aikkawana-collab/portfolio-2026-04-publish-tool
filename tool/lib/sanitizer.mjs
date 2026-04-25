/**
 * Sanitizer (第1層: Rule-based replacement)
 * FR-9, FR-9.1, FR-9.2, FR-10, FR-11, FR-11.1, FR-12
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { walkTextFiles } from './fs-util.mjs';

const MIN_RULES = 15;

/**
 * Load sanitize rules from JSON
 */
export async function loadRules(rulesPath) {
  const content = await fs.readFile(rulesPath, 'utf8');
  const data = JSON.parse(content);
  if (!Array.isArray(data.rules)) {
    throw new Error(`sanitize-rules.json: 'rules' must be an array`);
  }
  if (data.rules.length < MIN_RULES) {
    throw new Error(
      `sanitize-rules.json: minimum ${MIN_RULES} rules required, got ${data.rules.length}`
    );
  }
  // Compute hash for audit
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return {
    version: data.version || 'unknown',
    rules: data.rules,
    skipPatterns: data.skipPatterns || [],
    hash,
  };
}

/**
 * FR-9.1: Check if text is a placeholder (starts with < and ends with >)
 * Placeholders are excluded from further rule matching.
 */
function containsPlaceholder(text, placeholder) {
  return text.includes(placeholder);
}

/**
 * Sanitize all text files in rootPath
 * FR-9: apply all rules
 * FR-9.1: rules applied in definition order, placeholders excluded from re-matching
 * FR-12: generate sanitize-report.json
 */
export async function sanitize(rootPath, rulesData, options = {}) {
  const { logger } = options;
  const { rules, skipPatterns, hash } = rulesData;

  const report = {
    timestamp: new Date().toISOString(),
    rulesVersion: rulesData.version,
    rulesHash: hash,
    rootPath,
    totalFiles: 0,
    processedFiles: 0,
    skippedFiles: [],
    replacements: [], // { file, ruleId, count }
  };

  // Compile regex SOURCES once (not RegExp objects directly).
  // Storing source allows creating fresh RegExp instances per file to
  // avoid any shared `lastIndex` state across calls.
  const compiled = rules.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    replacement: r.replacement,
    severity: r.severity,
  }));

  for await (const filePath of walkTextFiles(rootPath, skipPatterns)) {
    report.totalFiles++;
    try {
      const relPath = path.relative(rootPath, filePath);
      const rawContent = await fs.readFile(filePath, 'utf8');

      // Early skip: very large files (>5MB text)
      if (rawContent.length > 5 * 1024 * 1024) {
        report.skippedFiles.push({ file: relPath, reason: 'oversize' });
        await logger?.warn(`Skipping oversized file (>5MB): ${relPath}`);
        continue;
      }

      // Normalize Unicode to NFC for consistent regex matching
      // (macOS filesystem may produce NFD encoding for Japanese characters)
      const originalContent = rawContent.normalize('NFC');
      let content = originalContent;
      const fileReplacements = [];

      for (const rule of compiled) {
        // Create fresh RegExp instances per file to ensure no shared lastIndex state.
        const matchRegex = new RegExp(rule.pattern, 'g');
        const replaceRegex = new RegExp(rule.pattern, 'g');

        // Find all matches, but exclude placeholders from later rules
        const matches = [...content.matchAll(matchRegex)];

        // FR-9.1: filter out matches that are already within a placeholder
        const realMatches = matches.filter((m) => {
          const matchStr = m[0];
          // Already-placeholder format: <...>
          if (/^<[\w-]+>$/.test(matchStr)) return false;
          return true;
        });

        if (realMatches.length > 0) {
          content = content.replace(replaceRegex, (match) => {
            // Don't re-replace placeholders
            if (/^<[\w-]+>$/.test(match)) return match;
            return rule.replacement;
          });
          fileReplacements.push({
            ruleId: rule.id,
            count: realMatches.length,
          });
        }
      }

      if (fileReplacements.length > 0) {
        await fs.writeFile(filePath, content);
        report.replacements.push({
          file: relPath,
          replacements: fileReplacements,
        });
      }
      report.processedFiles++;
    } catch (err) {
      // FR-9.2: on interruption, log which file was being processed
      await logger?.warn(`Failed to process ${filePath}: ${err.message}`);
      report.skippedFiles.push({ file: filePath, reason: err.message });
    }
  }

  return report;
}

/**
 * Write sanitize report to JSON file
 */
export async function writeReport(reportPath, report) {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
}
