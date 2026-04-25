/**
 * GitHub Client (gh CLI wrapper)
 * FR-16, FR-17, FR-18, FR-19, FR-36
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitHubApiError,
  EnvironmentError,
} from './errors.mjs';

const execFileAsync = promisify(execFile);
const MIN_GH_VERSION = [2, 0, 0];
const REPO_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * FR-36: Verify gh CLI version
 */
export async function verifyGhVersion() {
  try {
    const { stdout } = await execFileAsync('gh', ['--version']);
    const match = stdout.match(/gh version (\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      throw new EnvironmentError('Could not parse gh version');
    }
    const version = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
    for (let i = 0; i < 3; i++) {
      if (version[i] > MIN_GH_VERSION[i]) break;
      if (version[i] < MIN_GH_VERSION[i]) {
        throw new EnvironmentError(
          `gh CLI version ${version.join('.')} is too old (need ${MIN_GH_VERSION.join('.')}+)`,
          { current: version.join('.'), required: MIN_GH_VERSION.join('.') }
        );
      }
    }
    return { version: version.join('.') };
  } catch (err) {
    if (err instanceof EnvironmentError) throw err;
    if (err.code === 'ENOENT') {
      throw new EnvironmentError(
        'gh CLI is not installed. Install from https://cli.github.com'
      );
    }
    throw new EnvironmentError(`gh --version failed: ${err.message}`);
  }
}

/**
 * Verify gh authentication.
 *
 * Note: Different gh CLI versions write `auth status` output to either
 * stdout or stderr (older versions write to stderr). We check both.
 */
export async function verifyAuth() {
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status']);
    const combined = (stdout || '') + '\n' + (stderr || '');
    const match = combined.match(/Logged in to github\.com (?:account )?(\S+)/);
    if (!match) {
      throw new EnvironmentError('gh auth status unparseable', {
        stdoutSnippet: (stdout || '').slice(0, 200),
        stderrSnippet: (stderr || '').slice(0, 200),
      });
    }
    return { username: match[1] };
  } catch (err) {
    if (err instanceof EnvironmentError) throw err;
    // Some versions exit non-zero but include valid info in stderr
    const combined = (err.stdout || '') + '\n' + (err.stderr || '');
    const match = combined.match(/Logged in to github\.com (?:account )?(\S+)/);
    if (match) {
      return { username: match[1] };
    }
    throw new EnvironmentError(
      'gh CLI is not authenticated. Run `gh auth login` first.',
      { error: err.message, stderr: (err.stderr || '').slice(0, 200) }
    );
  }
}

/**
 * Get current authenticated username
 */
export async function getCurrentUser() {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
    return stdout.trim();
  } catch (err) {
    throw new EnvironmentError(
      `Failed to get GitHub username: ${err.message}`
    );
  }
}

/**
 * FR-18: Check if a repo with name exists in authenticated user's account
 */
export async function repoExists(name, username = null) {
  const owner = username || (await getCurrentUser());
  try {
    await execFileAsync('gh', ['repo', 'view', `${owner}/${name}`, '--json', 'name']);
    return true;
  } catch (err) {
    // 404 → does not exist
    if (
      err.stderr?.includes('Could not resolve') ||
      err.stderr?.includes('404')
    ) {
      return false;
    }
    throw new GitHubApiError(
      `Failed to check repo existence: ${err.message}`,
      { name, owner, stderr: err.stderr }
    );
  }
}

/**
 * G-09: Validate repository name
 */
export function validateRepoName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new GitHubApiError(`Invalid repo name: ${name}`);
  }
  if (name.length > 100) {
    throw new GitHubApiError(`Repo name too long (>100 chars): ${name}`);
  }
  if (!REPO_NAME_REGEX.test(name)) {
    throw new GitHubApiError(
      `Invalid characters in repo name: ${name}. Use lowercase alphanumeric and hyphens.`
    );
  }
  return true;
}

/**
 * FR-16, FR-19: Create a public repository and push
 *
 * @param {string} name - repo name (without owner)
 * @param {string} sourcePath - local directory with git initialized
 * @param {object} options - { description, logger }
 * @returns {Promise<{url: string, htmlUrl: string}>}
 */
export async function createPublicRepo(name, sourcePath, options = {}) {
  const { description = '', logger } = options;
  validateRepoName(name);

  try {
    await logger?.info(`Creating public repo: ${name}`);
    const args = [
      'repo', 'create', name,
      '--public',
      '--source', sourcePath,
      '--push',
    ];
    if (description) {
      args.push('--description', description);
    }
    const { stdout } = await execFileAsync('gh', args, { timeout: 120_000 });
    // Extract URL from stdout
    const urlMatch = stdout.match(/https:\/\/github\.com\/\S+/);
    const url = urlMatch ? urlMatch[0] : stdout.trim();
    return {
      url,
      htmlUrl: url,
      name,
    };
  } catch (err) {
    throw new GitHubApiError(
      `Failed to create public repo: ${err.message}`,
      { name, stderr: err.stderr }
    );
  }
}

/**
 * Delete a repository (rollback)
 */
export async function deleteRepo(ownerSlashName, options = {}) {
  const { logger } = options;
  try {
    await logger?.warn(`Deleting repository: ${ownerSlashName}`);
    await execFileAsync('gh', ['repo', 'delete', ownerSlashName, '--yes']);
    return { deleted: true };
  } catch (err) {
    throw new GitHubApiError(
      `Failed to delete repo ${ownerSlashName}: ${err.message}`,
      { ownerSlashName, stderr: err.stderr }
    );
  }
}
