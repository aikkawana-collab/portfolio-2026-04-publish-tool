/**
 * README Generator
 * FR-14, FR-15, FR-15.1
 *
 * Simple Mustache-like template rendering (no complex logic).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TemplateError } from './errors.mjs';

/**
 * Simple template rendering. Supports {{field}} placeholders.
 * Missing fields are replaced with empty string.
 */
function renderTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return data[key] ?? '';
  });
}

/**
 * Convert array of strings to bullet list markdown
 */
function arrayToBullets(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((item) => `- ${item}`).join('\n');
}

/**
 * Convert tech_stack array to 2-column table
 */
function techStackToTable(techStack) {
  if (!Array.isArray(techStack) || techStack.length === 0) return '';
  const rows = ['| 技術 | 用途 |', '| --- | --- |'];
  for (const tech of techStack) {
    rows.push(`| ${tech} | 実装 |`);
  }
  return rows.join('\n');
}

/**
 * Build cover image block (if provided)
 */
function buildCoverImageBlock(coverImage, assetsDir) {
  if (!coverImage) return '';
  const imagePath = coverImage.startsWith('assets/') ? coverImage : `assets/${path.basename(coverImage)}`;
  return `![Cover](${imagePath})\n`;
}

/**
 * Build demo section (FR-15.1: skip if no URL)
 */
function buildDemoSection(liveDemoUrl) {
  if (!liveDemoUrl || String(liveDemoUrl).trim() === '') return '';
  return [
    '## 🎬 Demo',
    '',
    `[Live App](${liveDemoUrl})`,
    '',
  ].join('\n');
}

/**
 * Generate README content from project metadata
 */
export async function generateReadme(metadata, templatePath) {
  let template;
  try {
    template = await fs.readFile(templatePath, 'utf8');
  } catch (err) {
    throw new TemplateError(
      `Failed to read README template: ${templatePath}`,
      { path: templatePath, error: err.message }
    );
  }

  const { yaml: y } = metadata;

  const data = {
    title: y.title,
    tagline: y.tagline,
    key_metric: y.key_metric,
    overview: y.overview,
    solution: y.solution,
    results: y.results,
    target_role: y.target_role,
    published_at: y.published_at,
    license: y.license || 'MIT',
    problem_bullets: arrayToBullets(y.problem),
    features_bullets: arrayToBullets(y.features),
    tech_stack_table: techStackToTable(y.tech_stack),
    demo_section: buildDemoSection(y.live_demo_url),
    cover_image_block: buildCoverImageBlock(y.cover_image, metadata.assetsDir),
  };

  return renderTemplate(template, data);
}

/**
 * Generate README and write to targetPath
 */
export async function writeReadme(metadata, templatePath, targetPath) {
  const content = await generateReadme(metadata, templatePath);
  await fs.writeFile(targetPath, content);
  return content;
}
