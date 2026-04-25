#!/usr/bin/env node
/**
 * CLI: GitHub URL から portfolio.yaml を AI 自動生成
 *
 * Usage:
 *   node tool/scripts/generate-yaml.mjs <github-url> \
 *     --slug 2026-05-myapp \
 *     --key-metric "月20時間削減" \
 *     --target "個人事業主向け" \
 *     --project-type 自主開発 \
 *     [--published 2026-05-15]
 *
 * 出力:
 *   projects/<slug>/portfolio.yaml.draft
 *   projects/<slug>/source-repo.txt
 *
 * その後、内容確認 → portfolio.yaml にリネーム → publish.mjs 実行
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import readline from 'node:readline/promises';
import { generatePortfolioYaml } from '../lib/yaml-generator.mjs';
import { createLogger } from '../lib/logger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.dirname(__dirname);
const PROJECT_ROOT = path.dirname(TOOL_DIR);
const PROJECTS_DIR = path.join(PROJECT_ROOT, 'projects');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    url: null,
    slug: null,
    keyMetric: null,
    target: null,
    projectType: null,
    publishedAt: null,
    autoApprove: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--slug') opts.slug = args[++i];
    else if (a === '--key-metric') opts.keyMetric = args[++i];
    else if (a === '--target') opts.target = args[++i];
    else if (a === '--project-type') opts.projectType = args[++i];
    else if (a === '--published') opts.publishedAt = args[++i];
    else if (a === '--auto-approve') opts.autoApprove = true;
    else if (!a.startsWith('--') && !opts.url) opts.url = a;
  }
  return opts;
}

function showUsage() {
  console.log(`Usage:
  node tool/scripts/generate-yaml.mjs <github-url> [options]

Options:
  --slug <slug>           プロジェクトslug (例: 2026-05-myapp)
  --key-metric <text>     一番の自慢ポイント (例: "月20時間削減")
  --target <text>         対象ユーザー (例: "個人事業主向け")
  --project-type <enum>   実務種別: 実務案件 | 自主開発 | 練習
  --published <ISO-date>  公開日 (省略時は今日の日付)
  --auto-approve          確認なしでドラフトを portfolio.yaml にリネーム

Example:
  node tool/scripts/generate-yaml.mjs \\
    https://github.com/<github-owner>/myapp \\
    --slug 2026-05-myapp \\
    --key-metric "月20時間削減" \\
    --target "個人事業主向け" \\
    --project-type 自主開発
`);
}

async function promptInteractive(question, defaultValue) {
  if (!process.stdin.isTTY) return defaultValue;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim() || defaultValue;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.url) {
    showUsage();
    process.exit(2);
  }

  // Interactive fill-in for missing args (TTY only)
  if (process.stdin.isTTY) {
    if (!opts.slug) {
      const dateSlug = new Date().toISOString().slice(0, 7); // YYYY-MM
      const repoName = opts.url.split('/').pop().replace('.git', '');
      const defaultSlug = `${dateSlug}-${repoName}`;
      opts.slug = await promptInteractive('Slug', defaultSlug);
    }
    if (!opts.keyMetric) {
      opts.keyMetric = await promptInteractive('Key Metric (一番の自慢)');
    }
    if (!opts.target) {
      opts.target = await promptInteractive('対象ユーザー');
    }
    if (!opts.projectType) {
      opts.projectType = await promptInteractive('実務種別 [実務案件/自主開発/練習]', '自主開発');
    }
  }

  // Validate
  if (!opts.slug || !opts.keyMetric || !opts.target || !opts.projectType) {
    console.error('❌ Missing required arguments. See --help');
    showUsage();
    process.exit(2);
  }

  const logger = createLogger();

  console.log('');
  console.log('🤖 AI yaml 自動生成開始');
  console.log(`  URL:           ${opts.url}`);
  console.log(`  Slug:          ${opts.slug}`);
  console.log(`  Key Metric:    ${opts.keyMetric}`);
  console.log(`  Target:        ${opts.target}`);
  console.log(`  Project type:  ${opts.projectType}`);
  console.log('');

  try {
    const result = await generatePortfolioYaml({
      githubUrl: opts.url,
      slug: opts.slug,
      keyMetric: opts.keyMetric,
      target: opts.target,
      projectType: opts.projectType,
      publishedAt: opts.publishedAt,
      projectsRoot: PROJECTS_DIR,
      logger,
    });

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Draft 生成完了');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log(`📄 ${result.draftPath}`);
    console.log('');
    console.log('--- 生成された YAML ---');
    console.log(result.yamlContent);
    console.log('--- 終わり ---');
    console.log('');
    console.log('📝 次のアクション（レビュー必須）:');
    console.log('');
    console.log('1. ドラフトを確認・必要に応じて編集:');
    console.log(`   ${result.draftPath}`);
    console.log('');
    console.log('2. アセット（カバー画像・スクショ）を配置:');
    console.log(`   ${path.join(PROJECTS_DIR, opts.slug, 'assets/')}`);
    console.log('');
    console.log('3. ドラフトを portfolio.yaml にリネーム:');
    console.log(`   mv ${result.draftPath} ${path.join(PROJECTS_DIR, opts.slug, 'portfolio.yaml')}`);
    console.log('');
    console.log('4. publish 実行:');
    console.log(`   cd ${TOOL_DIR}`);
    console.log(`   node publish.mjs ${opts.slug}`);
    console.log('');

    if (opts.autoApprove) {
      const finalPath = path.join(PROJECTS_DIR, opts.slug, 'portfolio.yaml');
      await fs.rename(result.draftPath, finalPath);
      console.log(`✅ Auto-approved: renamed to ${finalPath}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('❌ 生成失敗:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
