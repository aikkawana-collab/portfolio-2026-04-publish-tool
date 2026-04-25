/**
 * YAML Generator
 *
 * Given a GitHub URL + 3 meta info (key_metric / target / project_type),
 * clones the repo, analyzes content, calls Claude Code to generate
 * a complete portfolio.yaml file.
 *
 * Strategy:
 *   1. Clone repo to temp dir (read-only)
 *   2. Run repo-analyzer to extract tech stack, README, etc.
 *   3. Call `claude --print` with structured prompt
 *   4. Parse Claude's response → yaml
 *   5. Run secret scan (FR-39)
 *   6. Validate yaml structure
 *   7. Save as portfolio.yaml.draft for user review (Q3=B mode)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { cloneRepo } from './git-cloner.mjs';
import { analyzeRepo, summarizeRepo } from './repo-analyzer.mjs';
import { scanString } from './secret-scanner.mjs';
import { prepareTempDir, cleanupTempDir } from './fs-util.mjs';

const execFileAsync = promisify(execFile);

const SYSTEM_PROMPT = `あなたはポートフォリオ用の portfolio.yaml ファイルを生成する専門家です。
GitHub リポジトリの README とコード分析結果を読み、以下のスキーマに沿った正確な YAML を生成してください。

## 生成ルール
- 出力は YAML だけ。前後に説明・コードフェンスは不要
- 必ず指定された全フィールドを記入する
- overview/solution/results は 2-3 段落（150〜300字）で具体的・自然な日本語
- problem/features は配列、各要素は 1 文（30〜80字）
- tech_stack は分析結果から重複なく整理（HTML/CSS は分離せず "HTML / CSS / Vanilla JS" のように1つでまとめてOK）
- highlights（こだわりポイント）は3〜5項目、技術者が読んで「おっ」となる内容
- architecture_note は3〜5文の技術構成説明
- 機密情報（実メール・実APIキー・実パスワード等）は絶対に出力しない
- 推測できない場合は妥当なデフォルト値を入れる（例: featured: true、license: MIT）`;

/**
 * Build the user prompt from analysis + meta info
 */
function buildPrompt(analysis, meta) {
  const summary = summarizeRepo(analysis);

  return `# ポートフォリオ yaml 生成依頼

以下のリポジトリ分析と、ユーザーから指定された3つのメタ情報を元に、portfolio.yaml の中身を生成してください。

## ユーザー指定の必須情報（これらの値はそのまま使用してください、変更・null化禁止）
- key_metric: ${meta.keyMetric}
- 対象ユーザー (target_role に反映): ${meta.target}
- 実務種別 (project_type): ${meta.projectType}
- スラグ: ${meta.slug}
- published_at: ${meta.publishedAt}  ← 必ずこの日付文字列をそのまま設定する。null や別日付に変えないこと

## リポジトリ分析結果

${summary}

## 出力する YAML スキーマ（このフォーマットを厳守）

\`\`\`yaml
title: "<アプリ名・30字以内>"
tagline: "<1-2文の価値提案・80字以内>"
category: "<Web App | 業務自動化 | AI | その他>"
tech_stack:
  - "<技術名>"
  # 配列、3-7項目
status: "<リリース済 | 開発中 | 完成>"
project_type: "${meta.projectType}"
key_metric: "${meta.keyMetric}"
published_at: "${meta.publishedAt}"
target_role: "<対象ユーザー / 担当範囲を 1 文で>"
overview: |
  <2-3段落、150〜300字>
problem:
  - "<課題1・30〜80字>"
  - "<課題2>"
  - "<課題3>"
solution: |
  <1-2段落、解決アプローチ。150〜250字>
features:
  - "<機能1・1文>"
  - "<機能2>"
  - "<機能3>"
  # 4-6項目推奨
results: |
  <1-2段落、定量結果込み。150〜250字>
featured: true
live_demo_url: null
cover_image: null
github_public_name: "portfolio-${meta.slug}"
architecture_note: |
  <3-5文の技術構成・データフローの説明>
highlights:
  - "<こだわり1>"
  - "<こだわり2>"
  - "<こだわり3>"
  # 3-5項目
disclosure_note: "個人開発のため掲載可"
license: "MIT"
metrics:
  dev_hours: <数値>
  lines_of_code: <数値>
  issues_closed: "<例: '19/19' or null>"
  cost: "<例: '$0/月'>"
\`\`\`

⚠️ 重要:
- 出力は **yaml の中身だけ**（コードフェンス不要）
- 必ず日本語で、自然で読みやすい文章
- 機密情報は絶対に含めない（メールアドレス・APIキー等は出さない）`;
}

/**
 * Call Claude Code via subprocess.
 *
 * Passes prompt via stdin instead of as an argv positional, to avoid
 * the OS-level argv length limit (E2BIG, ~256KB on macOS) that would
 * trigger for very long repository contexts.
 */
async function callClaude(prompt, options = {}) {
  const { logger, timeoutMs = 300_000 } = options;
  await logger?.info('Calling Claude Code (claude --print)...');

  return await new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(
          'claude CLI が見つかりません。Claude Code をインストールしてください: https://claude.com/claude-code'
        ));
      } else {
        reject(new Error(`Claude Code 起動失敗: ${err.message}`));
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new Error(`Claude Code timeout after ${timeoutMs}ms`));
      }
      if (code !== 0) {
        return reject(new Error(
          `Claude Code 失敗 (exit ${code}): ${stderr.slice(0, 500)}`
        ));
      }
      if (stderr && !stderr.includes('Loaded')) {
        logger?.debug?.(`Claude stderr: ${stderr.slice(0, 500)}`);
      }
      resolve(stdout.trim());
    });

    // Write prompt via stdin and close
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

/**
 * Parse Claude response → extract YAML
 *
 * Tries to be resilient: even if Claude wraps in code fence or adds preamble,
 * extract the actual YAML body.
 */
function parseYamlResponse(response) {
  let content = response;

  // Try to extract from ```yaml ... ``` code fence
  const fenceMatch = content.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    content = fenceMatch[1];
  }

  // Strip leading/trailing whitespace
  content = content.trim();

  // Validate it's parseable
  try {
    yaml.load(content);
    return content;
  } catch (err) {
    throw new Error(
      `Claude の出力が有効な YAML ではありません: ${err.message}\n--- 出力 ---\n${content.slice(0, 500)}`
    );
  }
}

/**
 * Normalize a parsed YAML object: convert Date objects to ISO date strings.
 * (js-yaml parses YYYY-MM-DD as Date by default.)
 */
function normalizeYaml(parsed, yamlContent) {
  // published_at: convert Date → "YYYY-MM-DD" string
  if (parsed.published_at instanceof Date) {
    parsed.published_at = parsed.published_at.toISOString().slice(0, 10);
  }
  return parsed;
}

/**
 * Validate generated yaml has all required fields
 */
function validateRequired(parsed) {
  const REQUIRED = [
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
  const missing = REQUIRED.filter((f) => {
    const v = parsed[f];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });
  if (missing.length > 0) {
    throw new Error(`Generated yaml missing required fields: ${missing.join(', ')}`);
  }

  // enum validation
  const enums = {
    category: ['Web App', '業務自動化', 'AI', 'その他'],
    status: ['リリース済', '開発中', '完成'],
    project_type: ['実務案件', '自主開発', '練習'],
  };
  for (const [field, allowed] of Object.entries(enums)) {
    if (!allowed.includes(parsed[field])) {
      throw new Error(`Invalid enum: ${field}="${parsed[field]}" (allowed: ${allowed.join('|')})`);
    }
  }
}

/**
 * Main entry: generate portfolio.yaml from a GitHub URL + 3 meta info
 *
 * @param {object} options
 * @param {string} options.githubUrl
 * @param {string} options.slug
 * @param {string} options.keyMetric
 * @param {string} options.target
 * @param {string} options.projectType
 * @param {string} [options.publishedAt] - ISO date, defaults to today
 * @param {object} [options.logger]
 * @returns {Promise<{yamlContent: string, parsed: object, draftPath: string}>}
 */
export async function generatePortfolioYaml(options) {
  const {
    githubUrl,
    slug,
    keyMetric,
    target,
    projectType,
    projectsRoot,
    logger,
  } = options;

  // Default to today if publishedAt is null/undefined/empty
  const publishedAt =
    options.publishedAt && options.publishedAt.trim?.()
      ? options.publishedAt
      : new Date().toISOString().slice(0, 10);

  if (!githubUrl || !slug || !keyMetric || !target || !projectType) {
    throw new Error(
      'Required: githubUrl, slug, keyMetric, target, projectType'
    );
  }
  if (!['実務案件', '自主開発', '練習'].includes(projectType)) {
    throw new Error(`Invalid project_type: ${projectType}`);
  }

  // 1. Clone repo
  await logger?.info(`Cloning ${githubUrl}...`);
  const tempPath = await prepareTempDir(`yaml-gen-${slug}`);
  try {
    await cloneRepo(githubUrl, tempPath, { logger });
    await logger?.info('Clone complete');

    // 2. Analyze
    await logger?.info('Analyzing repository...');
    const analysis = await analyzeRepo(tempPath);
    await logger?.info(`Detected ${analysis.techStack.length} tech items, ${analysis.fileCount} files`);

    // 3. Build prompt
    const prompt = buildPrompt(analysis, {
      keyMetric,
      target,
      projectType,
      slug,
      publishedAt,
    });

    // 4. Call Claude
    const fullPrompt = SYSTEM_PROMPT + '\n\n' + prompt;
    await logger?.info('Calling Claude Code (this may take 20-60 seconds)...');
    const response = await callClaude(fullPrompt, { logger });

    // 5. Parse YAML
    let yamlContent;
    let parsed;
    try {
      yamlContent = parseYamlResponse(response);
      parsed = yaml.load(yamlContent);
      parsed = normalizeYaml(parsed, yamlContent);
    } catch (parseErr) {
      // Save raw response for debugging
      const projectDir = path.join(projectsRoot, slug);
      await fs.mkdir(projectDir, { recursive: true });
      const rawPath = path.join(projectDir, '.claude-raw-response.txt');
      await fs.writeFile(rawPath, response);
      throw new Error(
        `${parseErr.message}\n\nRaw response saved to: ${rawPath}`
      );
    }

    // 6. Secret scan (FR-39)
    const findings = scanString(yamlContent);
    if (findings.length > 0) {
      const detail = findings.slice(0, 3).map((f) => `${f.pattern}: ${f.match}`).join('; ');
      throw new Error(`Generated yaml contains potential secrets: ${detail}`);
    }

    // 7. Validate (with debug info on failure)
    try {
      validateRequired(parsed);
    } catch (validErr) {
      const projectDir = path.join(projectsRoot, slug);
      await fs.mkdir(projectDir, { recursive: true });
      const rawPath = path.join(projectDir, '.claude-raw-response.txt');
      const yamlPath = path.join(projectDir, '.parsed-yaml.txt');
      await fs.writeFile(rawPath, response);
      await fs.writeFile(yamlPath, yamlContent);
      throw new Error(
        `${validErr.message}\n\n` +
        `生成内容のフィールド一覧: ${Object.keys(parsed).join(', ')}\n` +
        `Raw response saved to: ${rawPath}\n` +
        `Extracted YAML saved to: ${yamlPath}`
      );
    }

    // 8. Save as draft (Q3=B mode: review before publish)
    const projectDir = path.join(projectsRoot, slug);
    await fs.mkdir(path.join(projectDir, 'assets'), { recursive: true });
    const draftPath = path.join(projectDir, 'portfolio.yaml.draft');
    // Re-serialize from normalized parsed object (so published_at is string)
    const finalYaml = yaml.dump(parsed, { lineWidth: 100, noRefs: true, indent: 2 });
    await fs.writeFile(draftPath, finalYaml);
    yamlContent = finalYaml;

    // Also save source-repo.txt
    const sourceRepoPath = path.join(projectDir, 'source-repo.txt');
    await fs.writeFile(sourceRepoPath, githubUrl + '\n');

    await logger?.info(`Draft saved: ${draftPath}`);

    return {
      yamlContent,
      parsed,
      draftPath,
      analysis,
    };
  } finally {
    // Always cleanup temp dir for yaml generation
    try {
      await cleanupTempDir(tempPath);
    } catch {}
  }
}
