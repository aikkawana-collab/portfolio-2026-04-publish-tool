/**
 * Git Cloner
 * FR-5, FR-6, FR-6.1, FR-6.2, FR-7, FR-8, FR-31, FR-32
 *
 * Read-only clone to /tmp. Never writes to source repository.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CloneError,
  EmptyRepositoryError,
} from './errors.mjs';
import { getDirectorySize } from './fs-util.mjs';

const execFileAsync = promisify(execFile);

const MAX_REPO_SIZE_MB = 500;
const MAX_RETRIES = 3;

/**
 * Safely clone a Git repository to targetPath.
 * - FR-6: NEVER writes to source
 * - FR-8: exponential backoff retry (1s/2s/4s)
 * - FR-31: detect empty repo
 * - FR-32: warn on >500MB
 *
 * @returns {Promise<{size: number, fileCount: number}>}
 */
export async function cloneRepo(url, targetPath, options = {}) {
  const { logger, confirmLargeRepo = null } = options;

  // Ensure target does not exist
  await fs.rm(targetPath, { recursive: true, force: true });

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // --no-checkout to prevent hook execution, then checkout explicitly
      await execFileAsync(
        'git',
        ['clone', '--no-checkout', '--no-hardlinks', url, targetPath],
        { timeout: 120_000 }
      );

      // Remove .git/hooks/ to prevent any hook execution (G-05)
      const hooksDir = path.join(targetPath, '.git', 'hooks');
      try {
        const hookFiles = await fs.readdir(hooksDir);
        for (const f of hookFiles) {
          await fs.rm(path.join(hooksDir, f), { force: true });
        }
      } catch {}

      // Checkout files (hooks are now removed)
      await execFileAsync(
        'git',
        ['-C', targetPath, 'checkout', 'HEAD', '--'],
        { timeout: 60_000 }
      );

      break; // success
    } catch (err) {
      lastError = err;
      const errMsg = err.message || String(err);

      // Don't retry on auth errors (401/403)
      if (
        errMsg.includes('Authentication failed') ||
        errMsg.includes('403') ||
        errMsg.includes('401') ||
        errMsg.includes('could not read Username')
      ) {
        throw new CloneError(
          `Authentication failed for ${url}. Check gh auth status or repository access.`,
          { url, attempt, stderr: err.stderr }
        );
      }

      if (attempt < MAX_RETRIES) {
        const waitMs = Math.pow(2, attempt - 1) * 1000;
        await logger?.warn(
          `Clone failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitMs}ms`,
          { url, error: errMsg }
        );
        await sleep(waitMs);
      }
    }
  }

  if (lastError) {
    throw new CloneError(
      `Failed to clone ${url} after ${MAX_RETRIES} attempts: ${lastError.message}`,
      { url, stderr: lastError.stderr }
    );
  }

  // FR-31: empty repo check
  const entries = await fs.readdir(targetPath);
  const nonGitEntries = entries.filter((e) => e !== '.git');
  if (nonGitEntries.length === 0) {
    throw new EmptyRepositoryError(
      `Cloned repository is empty (no files outside .git/)`,
      { url, targetPath }
    );
  }

  // FR-32: size warning
  const sizeBytes = await getDirectorySize(targetPath);
  const sizeMB = sizeBytes / (1024 * 1024);
  let fileCount = 0;
  async function count(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === '.git') continue;
      if (item.isDirectory()) {
        await count(path.join(dir, item.name));
      } else if (item.isFile()) {
        fileCount++;
      }
    }
  }
  await count(targetPath);

  if (sizeMB > MAX_REPO_SIZE_MB) {
    await logger?.warn(
      `Repository size ${sizeMB.toFixed(1)}MB exceeds recommended ${MAX_REPO_SIZE_MB}MB`,
      { sizeMB, fileCount }
    );
    if (confirmLargeRepo && typeof confirmLargeRepo === 'function') {
      const proceed = await confirmLargeRepo(sizeMB);
      if (!proceed) {
        throw new CloneError(`User aborted: repository too large (${sizeMB.toFixed(1)}MB)`);
      }
    }
  }

  return { sizeBytes, sizeMB, fileCount };
}

/**
 * Get the latest commit hash of a Git repository (local path)
 * Used for verifying source repo is not modified (AT-3)
 */
export async function getCommitHash(repoPath) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', 'HEAD'],
      { timeout: 5000 }
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * FR-19.1: Destroy .git history and initialize new clean repo
 * This prevents source repo's commit history from leaking secrets.
 */
export async function reinitializeGit(targetPath, initialCommitMessage) {
  // 1. Remove .git directory
  const gitDir = path.join(targetPath, '.git');
  await fs.rm(gitDir, { recursive: true, force: true });

  // 2. git init
  await execFileAsync('git', ['-C', targetPath, 'init']);

  // 3. Set default branch to main
  await execFileAsync('git', ['-C', targetPath, 'checkout', '-b', 'main']);

  // 4. Configure local user (avoid depending on global config)
  await execFileAsync('git', [
    '-C', targetPath,
    'config', 'user.name', 'portfolio-publish-tool',
  ]);
  await execFileAsync('git', [
    '-C', targetPath,
    'config', 'user.email', '<email>',
  ]);

  // 5. Add all and commit
  await execFileAsync('git', ['-C', targetPath, 'add', '.']);
  await execFileAsync('git', [
    '-C', targetPath,
    'commit',
    '-m', initialCommitMessage,
  ]);

  // 6. Verify: git log should have exactly 1 commit
  const { stdout } = await execFileAsync('git', [
    '-C', targetPath,
    'log', '--oneline',
  ]);
  const commitCount = stdout.trim().split('\n').filter(Boolean).length;
  if (commitCount !== 1) {
    throw new CloneError(
      `Expected 1 commit after reinit, got ${commitCount}`,
      { targetPath, commitCount }
    );
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
