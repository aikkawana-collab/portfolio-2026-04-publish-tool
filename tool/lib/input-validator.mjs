/**
 * Input Validator
 * FR-1, FR-1.1, FR-2, FR-3, FR-38
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ValidationError } from './errors.mjs';

const REQUIRED_FIELDS = [
  'title',
  'tagline',
  'category',
  'tech_stack',
  'status',
  'project_type',
  'key_metric',
  'published_at',
  'target_role',
  'overview',
  'problem',
  'solution',
  'features',
  'results',
];

const ENUM_VALUES = {
  category: ['Web App', '業務自動化', 'AI', 'その他'],
  status: ['リリース済', '開発中', '完成'],
  project_type: ['実務案件', '自主開発', '練習'],
};

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\/?$/;

/**
 * Validate a project directory
 * FR-1.1
 *
 * @param {string} slug - project slug (e.g. "2026-04-business-app")
 * @param {string} projectsRoot - absolute path to projects/ directory
 * @returns {Promise<ProjectMetadata>}
 */
export async function validateProject(slug, projectsRoot) {
  if (!slug || typeof slug !== 'string') {
    throw new ValidationError('slug is required');
  }

  const projectDir = path.join(projectsRoot, slug);

  // FR-2: directory must exist
  try {
    const stat = await fs.stat(projectDir);
    if (!stat.isDirectory()) {
      throw new ValidationError(`projects/${slug}/ is not a directory`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      `projects/${slug}/ ディレクトリが存在しません。\n` +
      `作成手順:\n` +
      `  mkdir -p ${projectDir}/assets\n` +
      `  # portfolio.yaml と source-repo.txt を作成`,
      { projectDir, slug }
    );
  }

  // Load source-repo.txt
  const sourceRepoPath = path.join(projectDir, 'source-repo.txt');
  let sourceRepoRaw;
  try {
    sourceRepoRaw = await fs.readFile(sourceRepoPath, 'utf8');
  } catch {
    throw new ValidationError(
      `projects/${slug}/source-repo.txt が見つかりません`,
      { path: sourceRepoPath }
    );
  }
  const sourceRepoUrl = sourceRepoRaw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));

  if (!sourceRepoUrl) {
    throw new ValidationError(
      `projects/${slug}/source-repo.txt に有効な URL が記載されていません`
    );
  }

  const urlMatch = sourceRepoUrl.match(GITHUB_URL_REGEX);
  if (!urlMatch) {
    throw new ValidationError(
      `source-repo.txt の URL 形式が不正: ${sourceRepoUrl}\n` +
      `期待: https://github.com/<owner>/<repo>`,
      { sourceRepoUrl }
    );
  }

  // Load portfolio.yaml
  const yamlPath = path.join(projectDir, 'portfolio.yaml');
  let yamlContent;
  try {
    yamlContent = await fs.readFile(yamlPath, 'utf8');
  } catch {
    throw new ValidationError(
      `projects/${slug}/portfolio.yaml が見つかりません`,
      { path: yamlPath }
    );
  }

  // FR-38: UTF-8 without BOM check
  // Node fs returns UTF-8 by default; check for BOM prefix in raw bytes
  const rawBytes = await fs.readFile(yamlPath);
  if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
    throw new ValidationError(
      `portfolio.yaml は UTF-8 without BOM で保存してください（現在 BOM 付き）`,
      { path: yamlPath }
    );
  }

  // Parse YAML
  let ymeta;
  try {
    ymeta = yaml.load(yamlContent);
  } catch (err) {
    throw new ValidationError(
      `portfolio.yaml の YAML 構文エラー: ${err.message}`,
      { path: yamlPath, yamlError: err.message }
    );
  }

  if (!ymeta || typeof ymeta !== 'object') {
    throw new ValidationError(`portfolio.yaml が空または不正な形式です`);
  }

  // FR-3: required fields check
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = ymeta[f];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });
  if (missing.length > 0) {
    throw new ValidationError(
      `portfolio.yaml に必須フィールドが欠けています: ${missing.join(', ')}`,
      { missing }
    );
  }

  // enum validation
  const enumErrors = [];
  for (const [field, allowed] of Object.entries(ENUM_VALUES)) {
    if (!allowed.includes(ymeta[field])) {
      enumErrors.push(`${field}="${ymeta[field]}" (allowed: ${allowed.join('|')})`);
    }
  }
  if (enumErrors.length > 0) {
    throw new ValidationError(
      `enum フィールドに不正な値: ${enumErrors.join('; ')}`,
      { enumErrors }
    );
  }

  // tech_stack must be array
  if (!Array.isArray(ymeta.tech_stack) || ymeta.tech_stack.length === 0) {
    throw new ValidationError(`tech_stack は非空の配列である必要があります`);
  }
  // problem must be array
  if (!Array.isArray(ymeta.problem) || ymeta.problem.length === 0) {
    throw new ValidationError(`problem は非空の配列である必要があります`);
  }
  // features must be array
  if (!Array.isArray(ymeta.features) || ymeta.features.length === 0) {
    throw new ValidationError(`features は非空の配列である必要があります`);
  }

  // published_at format (ISO date)
  const pubDate = ymeta.published_at;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pubDate))) {
    throw new ValidationError(
      `published_at は ISO 8601 形式（YYYY-MM-DD）で記載してください: ${pubDate}`
    );
  }

  // Optional fields: set defaults
  const metadata = {
    slug,
    projectDir,
    sourceRepoUrl,
    sourceRepoOwner: urlMatch[1],
    sourceRepoName: urlMatch[2],
    assetsDir: path.join(projectDir, 'assets'),
    yaml: {
      ...ymeta,
      featured: ymeta.featured ?? false,
      license: ymeta.license ?? 'MIT',
      live_demo_url: ymeta.live_demo_url ?? null,
      github_public_name: ymeta.github_public_name ?? null,
      cover_image: ymeta.cover_image ?? null,
      architecture_note: ymeta.architecture_note ?? null,
      highlights: Array.isArray(ymeta.highlights) ? ymeta.highlights : [],
      disclosure_note: ymeta.disclosure_note ?? null,
      metrics: ymeta.metrics ?? {},
    },
  };

  return metadata;
}
