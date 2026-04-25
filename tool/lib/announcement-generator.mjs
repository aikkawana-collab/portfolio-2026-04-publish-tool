/**
 * X Announcement Generator
 * FR-41, FR-42, FR-42.1〜42.9, C-T-8, NFR-M-5
 *
 * Generate 3 patterns of X (Twitter) announcement text from template + yaml.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TemplateError } from './errors.mjs';
import { scanString } from './secret-scanner.mjs';

const MAX_CHARS_X = 280;
const URL_FIXED_LENGTH = 23; // X's t.co short URL length
const REQUIRED_HASHTAGS = ['#個人開発']; // FR-42.1

/**
 * FR-42.9: Placeholder conversion rules
 */
function convertPlaceholders(metadata, notionUrl) {
  const y = metadata.yaml;

  // {{target_role_short}}: take before first "/", max 20 chars
  const targetRoleShort = (y.target_role || '').split('/')[0].trim().slice(0, 20);

  // {{problem_first}}: array[0], max 40 chars
  const problemFirst = Array.isArray(y.problem) && y.problem[0]
    ? String(y.problem[0]).slice(0, 40)
    : '';

  // {{results_short}}: first sentence, max 50 chars
  const resultsFirst = (y.results || '').split(/[。\.]/)[0].slice(0, 50);

  // {{tech_list_top3}}: top 3 joined by ", "
  const techList = Array.isArray(y.tech_stack) ? y.tech_stack.slice(0, 3) : [];
  const techListTop3 = techList.join(', ');

  // {{tech_hashtags}}: top 3 as hashtags, alphanumeric/Japanese only
  const techHashtags = techList
    .map((t) => {
      // Remove symbols except Japanese/alphanumeric
      const clean = String(t).replace(/[^a-zA-Z0-9぀-ヿ一-鿿]/g, '');
      return clean.length > 0 ? `#${clean}` : null;
    })
    .filter(Boolean)
    .join(' ');

  // {{highlight_first}}: array[0], max 40 chars
  const highlightFirst = Array.isArray(y.highlights) && y.highlights[0]
    ? String(y.highlights[0]).slice(0, 40)
    : '';

  return {
    title: String(y.title || '').slice(0, 30),
    key_metric: String(y.key_metric || '').slice(0, 40),
    category: String(y.category || ''),
    notion_url: notionUrl,
    target_role_short: targetRoleShort,
    problem_first: problemFirst,
    results_short: resultsFirst,
    tech_list_top3: techListTop3,
    tech_hashtags: techHashtags,
    highlight_first: highlightFirst,
  };
}

/**
 * FR-42.1, C-T-8: Calculate X character count
 * - Regular char: 1
 * - Emoji: 2
 * - URL: 23 (t.co fixed)
 */
export function calculateXLength(text) {
  // URL detection (http/https)
  let remaining = text;
  let urlLength = 0;
  const urlRegex = /https?:\/\/\S+/g;
  const urls = text.match(urlRegex) || [];
  for (const url of urls) {
    urlLength += URL_FIXED_LENGTH;
    remaining = remaining.replace(url, '');
  }

  // Count emojis (surrogate pairs + emoji sequences)
  // Simple approach: count characters with code point > 0xFFFF (need surrogate pair)
  let emojiCount = 0;
  for (const ch of remaining) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) emojiCount++;
  }

  // Regular chars
  const charCount = [...remaining].length;
  const emojiExtra = emojiCount * 1; // emojis count as 2, we already count 1

  return charCount + emojiExtra + urlLength;
}

/**
 * FR-42.5: Auto-shorten if over 280 chars
 * Priority: reduce hashtags → trim body tail
 */
function autoShorten(text) {
  if (calculateXLength(text) <= MAX_CHARS_X) return text;

  // Split into lines
  const lines = text.split('\n');

  // Find hashtag line (typically last non-empty line)
  let hashtagLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/#\S/.test(lines[i])) {
      hashtagLineIdx = i;
      break;
    }
  }

  // Strategy 1: reduce hashtags to 3
  if (hashtagLineIdx >= 0) {
    const tags = lines[hashtagLineIdx].match(/#\S+/g) || [];
    // Keep required + up to 3 total
    const keep = [];
    for (const req of REQUIRED_HASHTAGS) {
      if (tags.includes(req)) keep.push(req);
    }
    for (const t of tags) {
      if (keep.length >= 3) break;
      if (!keep.includes(t)) keep.push(t);
    }
    lines[hashtagLineIdx] = keep.join(' ');
    const candidate = lines.join('\n');
    if (calculateXLength(candidate) <= MAX_CHARS_X) return candidate;
  }

  // Strategy 2: trim body from end (preserve first line, hashtag line, URL)
  let result = lines.join('\n');
  while (calculateXLength(result) > MAX_CHARS_X && result.length > 50) {
    // Remove last non-empty non-hashtag line
    const ls = result.split('\n');
    for (let i = ls.length - 1; i >= 1; i--) {
      if (ls[i].trim() === '') continue;
      if (/#\S/.test(ls[i])) continue;
      if (/https?:\/\//.test(ls[i])) continue;
      ls.splice(i, 1);
      break;
    }
    const newResult = ls.join('\n');
    if (newResult === result) break; // No more trimming possible
    result = newResult;
  }

  return result;
}

/**
 * FR-42.1: Validate announcement meets hashtag requirements
 */
function validateHashtags(text) {
  const tags = text.match(/#\S+/g) || [];
  // Must include all required hashtags
  for (const req of REQUIRED_HASHTAGS) {
    if (!tags.includes(req)) {
      return {
        ok: false,
        reason: `Missing required hashtag: ${req}`,
      };
    }
  }
  // Must have at least 3 hashtags
  if (tags.length < 3) {
    return {
      ok: false,
      reason: `Expected ≥3 hashtags, got ${tags.length}`,
    };
  }
  return { ok: true };
}

/**
 * Render a single template file with placeholders
 */
async function renderTemplate(templatePath, placeholders) {
  let template;
  try {
    template = await fs.readFile(templatePath, 'utf8');
  } catch (err) {
    throw new TemplateError(
      `Template not found: ${templatePath}`,
      { path: templatePath, error: err.message }
    );
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return placeholders[key] ?? '';
  });
}

/**
 * FR-42.6: Back up existing announcements directory
 */
async function backupExisting(outDir) {
  try {
    await fs.access(outDir);
  } catch {
    return; // doesn't exist
  }
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const files = await fs.readdir(outDir);
  for (const f of files) {
    const from = path.join(outDir, f);
    const to = path.join(outDir, `${f}.bak.${timestamp}`);
    try {
      await fs.rename(from, to);
    } catch {}
  }
}

/**
 * FR-42.7: Secret scan before save
 */
function assertNoSecrets(text, patternName) {
  const findings = scanString(text);
  if (findings.length > 0) {
    const detail = findings.map((f) => `${f.pattern}: ${f.match}`).join('; ');
    throw new Error(`Announcement ${patternName} contains secrets: ${detail}`);
  }
}

/**
 * Main: generate 3 announcements for a slug
 * FR-42, FR-42.1〜42.7
 *
 * @param {object} metadata - from input-validator
 * @param {string} notionUrl - created Notion page URL
 * @param {object} options - { outDir, templatesDir, logger }
 * @returns {Promise<{files: string[], warnings: string[]}>}
 */
export async function generateAnnouncements(metadata, notionUrl, options = {}) {
  const { outDir, templatesDir, logger } = options;

  const patterns = [
    { name: 'teaser', filename: '01-teaser.txt', template: 'announcement-teaser.md.tpl' },
    { name: 'detail', filename: '02-detail.txt', template: 'announcement-detail.md.tpl' },
    { name: 'tech', filename: '03-tech.txt', template: 'announcement-tech.md.tpl' },
  ];

  const warnings = [];
  const generatedFiles = [];

  // Ensure output dir exists + backup existing
  await fs.mkdir(outDir, { recursive: true });
  await backupExisting(outDir);

  // Prepare placeholders once
  const placeholders = convertPlaceholders(metadata, notionUrl);

  for (const p of patterns) {
    try {
      const tplPath = path.join(templatesDir, p.template);
      let content = await renderTemplate(tplPath, placeholders);

      // FR-42.5: auto-shorten if needed
      const originalLength = calculateXLength(content);
      if (originalLength > MAX_CHARS_X) {
        const shortened = autoShorten(content);
        const shortenedLength = calculateXLength(shortened);
        if (shortenedLength <= MAX_CHARS_X) {
          content = shortened;
          warnings.push(
            `${p.filename}: auto-shortened from ${originalLength} to ${shortenedLength} chars`
          );
        } else {
          warnings.push(
            `${p.filename}: could not shorten below ${MAX_CHARS_X} chars (current: ${shortenedLength}). Skipped.`
          );
          continue;
        }
      }

      // FR-42.7: secret scan
      assertNoSecrets(content, p.name);

      // FR-42.1: validate hashtags
      const hashtagCheck = validateHashtags(content);
      if (!hashtagCheck.ok) {
        warnings.push(`${p.filename}: ${hashtagCheck.reason}`);
      }

      // Save
      const outPath = path.join(outDir, p.filename);
      await fs.writeFile(outPath, content);
      generatedFiles.push(outPath);
      await logger?.info(
        `Announcement generated: ${p.filename} (${calculateXLength(content)}/${MAX_CHARS_X} chars)`
      );
    } catch (err) {
      warnings.push(`${p.filename}: ${err.message}`);
      await logger?.warn(`Failed to generate ${p.filename}: ${err.message}`);
    }
  }

  return {
    files: generatedFiles,
    warnings,
    teaserContent: await readOrNull(path.join(outDir, '01-teaser.txt')),
  };
}

async function readOrNull(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}
