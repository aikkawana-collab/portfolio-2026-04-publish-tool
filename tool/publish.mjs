#!/usr/bin/env node
/**
 * Portfolio Publish Tool - Main Orchestrator
 *
 * Usage:
 *   node tool/publish.mjs <slug> [options]
 *
 * Options:
 *   --dry-run                 Show execution plan without making changes
 *   --no-notion               Skip Notion step (for Phase 1 testing)
 *   --no-announcement         Skip X announcement generation
 *   --cleanup                 Remove temp dir on success
 *   --rollback-on-error=yes   Rollback without prompting on error (default for non-TTY)
 *   --rollback-on-error=no    Don't rollback on error
 *   --on-duplicate=<mode>     skip | update | recreate | abort (default: abort)
 *
 * Exit codes (per requirements.md §7):
 *   0   success
 *   1   generic error
 *   2   ValidationError
 *   3   CloneError
 *   4   SanitizeIncompleteError
 *   5   TemplateError
 *   6   GitHubApiError
 *   7   NotionApiError
 *   8   RollbackError
 *   10  ConfigurationError
 *   11  EnvironmentError
 *   12  NotionPermissionError
 *   13  DiskSpaceError
 *   14  ConcurrencyError
 *   15  EmptyRepositoryError
 *   130 SIGINT
 *   143 SIGTERM
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, LogLevel } from './lib/logger.mjs';
import { SafeError, formatErrorForUser } from './lib/errors.mjs';
import {
  prepareTempDir,
  cleanupTempDir,
  checkFreeSpace,
  acquireLock,
  releaseLock,
  fileExists,
} from './lib/fs-util.mjs';
import { validateProject } from './lib/input-validator.mjs';
import { cloneRepo, reinitializeGit } from './lib/git-cloner.mjs';
import { loadRules, sanitize, writeReport } from './lib/sanitizer.mjs';
import { enforceNoResiduals } from './lib/secret-scanner.mjs';
import { writeReadme } from './lib/readme-generator.mjs';
import {
  verifyGhVersion,
  verifyAuth,
  getCurrentUser,
  repoExists,
  createPublicRepo,
  deleteRepo,
  validateRepoName,
} from './lib/github-client.mjs';
import {
  loadConfig,
  createNotionClient,
  verifyIntegration,
  createProjectPage,
  archivePage,
  findExistingRecord,
} from './lib/notion-client.mjs';
import { buildProperties, buildBlocks, chunkBlocks } from './lib/notion-page-builder.mjs';
import { generateAnnouncements } from './lib/announcement-generator.mjs';
import { RollbackManager, promptChoice } from './lib/rollback.mjs';

const TOTAL_STEPS = 10;

// Resolve paths relative to this script
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(__dirname); // ~/Portfolio/
const PROJECTS_DIR = path.join(PROJECT_ROOT, 'projects');
const TOOL_DIR = __dirname;
const TEMPLATES_DIR = path.join(TOOL_DIR, 'templates');
const CONFIG_PATH = path.join(TOOL_DIR, 'config', 'secrets.local.json');
const SANITIZE_RULES_PATH = path.join(TOOL_DIR, 'sanitize-rules.json');
const README_TPL_PATH = path.join(TEMPLATES_DIR, 'public-readme.md.tpl');
const METRICS_DIR = path.join(PROJECT_ROOT, 'metrics');
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'announcements');

// ============================================================
// CLI argument parser
// ============================================================
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    slug: null,
    dryRun: false,
    noNotion: false,
    noAnnouncement: false,
    cleanup: false,
    rollbackOnError: 'ask',
    onDuplicate: 'abort',
  };
  for (const arg of args) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-notion') opts.noNotion = true;
    else if (arg === '--no-announcement') opts.noAnnouncement = true;
    else if (arg === '--cleanup') opts.cleanup = true;
    else if (arg.startsWith('--rollback-on-error=')) {
      opts.rollbackOnError = arg.split('=')[1];
    } else if (arg.startsWith('--on-duplicate=')) {
      opts.onDuplicate = arg.split('=')[1];
    } else if (!arg.startsWith('--') && !opts.slug) {
      opts.slug = arg;
    }
  }
  return opts;
}

// ============================================================
// Main
// ============================================================
async function main() {
  const opts = parseArgs(process.argv);
  const logger = createLogger({ totalSteps: TOTAL_STEPS });

  if (!opts.slug) {
    console.error(`Usage: node tool/publish.mjs <slug> [options]

Options:
  --dry-run
  --no-notion
  --no-announcement
  --cleanup
  --rollback-on-error=yes|no|ask
  --on-duplicate=skip|update|recreate|abort

Example:
  node tool/publish.mjs 2026-04-business-app
`);
    process.exit(2);
  }

  console.log('');
  console.log('🚀 Portfolio Publish Tool');
  console.log(`   Slug: ${opts.slug}${opts.dryRun ? ' (DRY-RUN)' : ''}`);
  console.log('');

  let lockPath = null;
  let tempPath = null;
  let createdRepo = null; // { name, url }
  let createdNotionPage = null; // { pageId, url }
  const rollback = new RollbackManager({
    logger,
    interactive: process.stdin.isTTY && opts.rollbackOnError === 'ask',
    rollbackOnError: opts.rollbackOnError,
  });

  // SIGINT/SIGTERM handler (FR-35)
  const signalHandler = async (sig) => {
    await logger.critical(`Received ${sig}, rolling back...`);
    try {
      await rollback.execute();
    } catch {}
    if (lockPath) await releaseLock(lockPath);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => signalHandler('SIGINT'));
  process.on('SIGTERM', () => signalHandler('SIGTERM'));

  try {
    // ============================================================
    // Step 1: Input validation
    // ============================================================
    await logger.step(1, TOTAL_STEPS, 'Input validation', '📋');
    const metadata = await validateProject(opts.slug, PROJECTS_DIR);
    await logger.success(`Validated: ${metadata.yaml.title}`);

    // ============================================================
    // Step 2: Pre-flight checks
    // ============================================================
    await logger.step(2, TOTAL_STEPS, 'Pre-flight checks', '✈️ ');

    // gh CLI
    await verifyGhVersion();
    const { username } = await verifyAuth();
    await logger.info(`GitHub authenticated: ${username}`);

    // Notion (if not skipped)
    let notionConfig = null;
    let notionClient = null;
    if (!opts.noNotion) {
      notionConfig = await loadConfig(CONFIG_PATH);
      notionClient = createNotionClient(notionConfig.notion.token);
      const integInfo = await verifyIntegration(
        notionClient,
        notionConfig.notion.projects_db_id
      );
      await logger.info(`Notion integration verified: ${integInfo.botName}`);
    }

    // Disk space (FR-33)
    await checkFreeSpace('/tmp', 500 * 1024 * 1024);
    await logger.info(`/tmp has sufficient free space`);

    // Concurrency lock (FR-34)
    lockPath = await acquireLock(opts.slug);
    rollback.register('Release lock file', () => releaseLock(lockPath), { protected: false });

    if (opts.dryRun) {
      console.log('');
      console.log('📝 DRY-RUN: Would execute the following steps:');
      console.log('  3. Clone source repo');
      console.log('  4. Sanitize (15 rules)');
      console.log('  5. Scan residuals');
      console.log('  6. Reinitialize .git (clean commit)');
      console.log('  7. Generate README');
      console.log(`  8. Create public repo: portfolio-${opts.slug}`);
      if (!opts.noNotion) console.log('  9. Create Notion DB record + child page');
      if (!opts.noAnnouncement) console.log(' 10. Generate X announcement (3 patterns)');
      await releaseLock(lockPath);
      process.exit(0);
    }

    // ============================================================
    // Step 3: Idempotency check
    // ============================================================
    const repoName = metadata.yaml.github_public_name ||
      `portfolio-${metadata.yaml.published_at.slice(0, 7)}-${opts.slug.replace(/^\d{4}-\d{2}-/, '')}`;
    validateRepoName(repoName);

    const githubExists = await repoExists(repoName, username);
    let notionExists = [];
    if (!opts.noNotion && notionClient) {
      notionExists = await findExistingRecord(
        notionClient,
        notionConfig.notion.projects_db_id,
        metadata.yaml.title,
        metadata.yaml.published_at
      );
    }

    if (githubExists || notionExists.length > 0) {
      await logger.warn(
        `既存公開を検出: GitHub=${githubExists} / Notion=${notionExists.length}件`
      );

      let choice = opts.onDuplicate;
      if (choice === 'ask' || (!process.stdin.isTTY && choice === 'ask')) {
        choice = await promptChoice(
          '既存の公開が見つかりました。どうしますか？',
          ['skip', 'update', 'recreate', 'abort']
        );
      }
      await logger.info(`Idempotency choice: ${choice}`);

      if (choice === 'abort') {
        await releaseLock(lockPath);
        console.log('Aborted by user choice.');
        process.exit(0);
      }
      if (choice === 'skip') {
        await releaseLock(lockPath);
        console.log('Skipped (existing preserved).');
        process.exit(0);
      }
      if (choice === 'recreate') {
        if (githubExists) {
          await deleteRepo(`${username}/${repoName}`, { logger });
          await logger.info(`Deleted existing repo: ${repoName}`);
        }
        for (const existing of notionExists) {
          await archivePage(notionClient, existing.id);
          await logger.info(`Archived existing Notion page: ${existing.id}`);
        }
        // Fall through to recreate
      }
      if (choice === 'update') {
        // Update mode: skip clone/sanitize/GitHub, just update Notion
        // For MVP simplicity, treat update same as recreate
        await logger.warn('Update mode: treating as recreate for MVP');
        if (githubExists) {
          await deleteRepo(`${username}/${repoName}`, { logger });
        }
        for (const existing of notionExists) {
          await archivePage(notionClient, existing.id);
        }
      }
    }

    // ============================================================
    // Step 4: Clone source repo
    // ============================================================
    await logger.step(3, TOTAL_STEPS, 'Clone source repository', '📥');
    tempPath = await prepareTempDir(opts.slug);
    rollback.register(
      `Remove temp dir (${tempPath})`,
      () => cleanupTempDir(tempPath),
      { protected: true } // keep by default for debugging
    );

    // Set log file path now that tempPath exists
    // IMPORTANT: write metadata files OUTSIDE tempPath so they don't end up in Public repo
    // tempPath = /tmp/portfolio-build-<slug>-<ts>/
    // metaDir  = /tmp/portfolio-build-<slug>-<ts>.meta/
    const metaDir = tempPath + '.meta';
    await fs.mkdir(metaDir, { recursive: true });
    const logFilePath = path.join(metaDir, 'publish.log');
    logger.setLogFilePath(logFilePath);

    const cloneInfo = await cloneRepo(metadata.sourceRepoUrl, tempPath, { logger });
    await logger.success(
      `Cloned ${cloneInfo.fileCount} files (${(cloneInfo.sizeMB).toFixed(1)} MB)`
    );

    // ============================================================
    // Step 5: Sanitize (Layer 1)
    // ============================================================
    await logger.step(4, TOTAL_STEPS, 'Sanitize secrets (Layer 1)', '🧹');
    const rulesData = await loadRules(SANITIZE_RULES_PATH);
    await logger.info(`Loaded ${rulesData.rules.length} sanitize rules (hash: ${rulesData.hash.slice(0, 12)}...)`);
    const report = await sanitize(tempPath, rulesData, { logger });
    // Write to metadata dir (outside tempPath) so it doesn't get pushed to Public repo
    const reportPath = path.join(metaDir, 'sanitize-report.json');
    await writeReport(reportPath, report);
    const totalReplacements = report.replacements.reduce(
      (sum, r) => sum + r.replacements.reduce((s, x) => s + x.count, 0),
      0
    );
    await logger.success(
      `Sanitized: ${report.processedFiles} files, ${totalReplacements} replacements`
    );

    // ============================================================
    // Step 6: Residual scan (Layer 2)
    // ============================================================
    await logger.step(5, TOTAL_STEPS, 'Scan residual secrets (Layer 2)', '🔍');
    await enforceNoResiduals(tempPath, {
      skipPatterns: rulesData.skipPatterns,
      logger,
    });
    await logger.success('No residual secrets detected ✓');

    // ============================================================
    // Step 7: Reinitialize .git (FR-19.1)
    // ============================================================
    await logger.step(6, TOTAL_STEPS, 'Reinitialize git (clean history)', '🗑 ');
    await reinitializeGit(
      tempPath,
      `Initial release - ${metadata.yaml.title}

Auto-published by portfolio-publish-tool v0.1.0
Published: ${metadata.yaml.published_at}
Sanitized from source (secrets removed)`
    );
    await logger.success('Git history cleaned');

    // ============================================================
    // Step 8: Generate README
    // ============================================================
    await logger.step(7, TOTAL_STEPS, 'Generate public README', '📝');
    const readmePath = path.join(tempPath, 'README.md');
    await writeReadme(metadata, README_TPL_PATH, readmePath);

    // Commit README
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['-C', tempPath, 'add', 'README.md']);
    await execFileAsync('git', [
      '-C', tempPath,
      'commit', '--amend', '--no-edit',
    ]);
    await logger.success('README generated and committed');

    // ============================================================
    // Step 9: Create public GitHub repo
    // ============================================================
    await logger.step(8, TOTAL_STEPS, 'Create public GitHub repo', '🐙');
    createdRepo = await createPublicRepo(repoName, tempPath, {
      description: `Portfolio: ${metadata.yaml.tagline}`,
      logger,
    });
    rollback.register(
      `Delete GitHub repo (${createdRepo.name})`,
      () => deleteRepo(`${username}/${createdRepo.name}`, { logger })
    );
    await logger.success(`Public repo created: ${createdRepo.url}`);

    // ============================================================
    // Step 10: Create Notion page
    // ============================================================
    let notionPageUrl = null;
    if (!opts.noNotion && notionClient) {
      await logger.step(9, TOTAL_STEPS, 'Create Notion page', '📘');
      const properties = buildProperties(metadata, createdRepo.url);
      const blocks = buildBlocks(metadata, createdRepo.url);
      // Notion limit: 100 blocks per create
      const firstChunk = blocks.slice(0, 100);
      createdNotionPage = await createProjectPage(
        notionClient,
        notionConfig.notion.projects_db_id,
        properties,
        firstChunk
      );
      rollback.register(
        `Archive Notion page (${createdNotionPage.pageId})`,
        () => archivePage(notionClient, createdNotionPage.pageId)
      );
      // Append remaining blocks if any
      if (blocks.length > 100) {
        const remainder = blocks.slice(100);
        const chunks = chunkBlocks(remainder, 100);
        for (const c of chunks) {
          await notionClient.blocks.children.append({
            block_id: createdNotionPage.pageId,
            children: c,
          });
        }
      }
      notionPageUrl = createdNotionPage.url;
      await logger.success(`Notion page created: ${notionPageUrl}`);
    } else {
      await logger.info('Notion step skipped (--no-notion)');
    }

    // ============================================================
    // Step 11: Generate X announcements
    // ============================================================
    if (!opts.noAnnouncement) {
      await logger.step(10, TOTAL_STEPS, 'Generate X announcement', '🐦');
      try {
        const announcements = await generateAnnouncements(
          metadata,
          notionPageUrl || createdRepo.url,
          {
            outDir: path.join(OUT_DIR, opts.slug),
            templatesDir: TEMPLATES_DIR,
            logger,
          }
        );
        await logger.success(
          `Generated ${announcements.files.length} announcement files`
        );
        if (announcements.warnings.length > 0) {
          for (const w of announcements.warnings) {
            await logger.warn(`Announcement: ${w}`);
          }
        }
        if (announcements.teaserContent) {
          console.log('');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('📢 X告知用テキスト（今すぐコピペ投稿）');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(announcements.teaserContent.trim());
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`保存先: ${path.join(OUT_DIR, opts.slug)}/`);
        }
      } catch (err) {
        // FR-42.4: announcement failure is non-fatal
        await logger.warn(`Announcement generation failed (non-fatal): ${err.message}`);
      }
    }

    // ============================================================
    // SUCCESS
    // ============================================================
    rollback.clear();
    await releaseLock(lockPath);

    // Save metrics
    await saveMetrics({
      slug: opts.slug,
      success: true,
      duration_ms: Date.now() - startTime,
      public_url: createdRepo.url,
      notion_url: notionPageUrl,
      sanitize_replacements: totalReplacements,
    });

    console.log('');
    console.log('🎉 Publish completed successfully!');
    console.log('');
    console.log(`  Public GitHub: ${createdRepo.url}`);
    if (notionPageUrl) console.log(`  Notion page:   ${notionPageUrl}`);
    console.log(`  Temp dir:      ${tempPath}`);
    console.log(`  Publish log:   ${logFilePath}`);
    console.log('');

    if (opts.cleanup) {
      await cleanupTempDir(tempPath);
      await logger.info('Cleanup: removed temp dir');
    }

    process.exit(0);
  } catch (err) {
    // Error path
    console.error(formatErrorForUser(err));

    try {
      await rollback.execute();
    } catch (rollbackErr) {
      console.error(`\n⚠️  Rollback also failed: ${rollbackErr.message}`);
      console.error('Manual cleanup may be required:');
      if (createdRepo) {
        console.error(`  gh repo delete ${createdRepo.name} --yes`);
      }
      if (tempPath) {
        console.error(`  rm -rf ${tempPath}`);
      }
    }

    if (lockPath) await releaseLock(lockPath).catch(() => {});

    // Save failure metrics
    await saveMetrics({
      slug: opts.slug,
      success: false,
      duration_ms: Date.now() - startTime,
      error: err.name,
      error_message: err.message,
    }).catch(() => {});

    const exitCode = (err instanceof SafeError ? err.exitCode : null) || 1;
    process.exit(exitCode);
  }
}

const startTime = Date.now();

async function saveMetrics(entry) {
  try {
    await fs.mkdir(METRICS_DIR, { recursive: true });
    const metricsFile = path.join(METRICS_DIR, 'publish-history.jsonl');
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    await fs.appendFile(metricsFile, line);
  } catch {}
}

main();
