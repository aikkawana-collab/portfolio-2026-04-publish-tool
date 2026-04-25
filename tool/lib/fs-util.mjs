/**
 * Filesystem utilities
 * FR-7, FR-33
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DiskSpaceError, ConcurrencyError } from './errors.mjs';

const execFileAsync = promisify(execFile);

/**
 * Generate ISO 8601 UTC timestamp like 20260424T105200Z (filesystem-safe)
 */
export function isoTimestampFilename() {
  const now = new Date();
  return now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
    .replace('Z', 'Z');
}

/**
 * Prepare temp directory for slug
 * Returns the absolute path
 * FR-7: existing directory is removed
 */
export async function prepareTempDir(slug) {
  const timestamp = isoTimestampFilename();
  const tempPath = path.join('/tmp', `portfolio-build-${slug}-${timestamp}`);
  await fs.mkdir(tempPath, { recursive: true });
  return tempPath;
}

/**
 * Clean up temp directory
 */
export async function cleanupTempDir(tempPath) {
  if (!tempPath || !tempPath.startsWith('/tmp/portfolio-build-')) {
    throw new Error(`Safety: refusing to delete non-temp path: ${tempPath}`);
  }
  await fs.rm(tempPath, { recursive: true, force: true });
}

/**
 * Check free disk space
 * FR-33
 * Returns available bytes. Throws DiskSpaceError if below threshold.
 */
export async function checkFreeSpace(checkPath = '/tmp', minBytes = 500 * 1024 * 1024) {
  try {
    const { stdout } = await execFileAsync('df', ['-k', checkPath]);
    // df output: Filesystem 1K-blocks Used Available Capacity Mounted
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) {
      return { ok: true, warning: 'df output unreadable' };
    }
    const parts = lines[1].split(/\s+/);
    // Available column is typically 3rd from start or specific position
    const availableKB = parseInt(parts[3], 10);
    const availableBytes = availableKB * 1024;
    if (availableBytes < minBytes) {
      throw new DiskSpaceError(
        `Insufficient disk space on ${checkPath}: ${formatBytes(availableBytes)} available, ${formatBytes(minBytes)} required`,
        { checkPath, availableBytes, minBytes }
      );
    }
    return { ok: true, availableBytes };
  } catch (err) {
    if (err instanceof DiskSpaceError) throw err;
    // df failed - not a fatal error, just warn
    return { ok: true, warning: `df failed: ${err.message}` };
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  return `${size.toFixed(1)}${units[unitIdx]}`;
}

/**
 * Walk text files in a directory, honoring skipPatterns (glob)
 * Returns AsyncGenerator<string> of absolute paths
 */
export async function* walkTextFiles(root, skipPatterns = []) {
  const skipRegexes = skipPatterns.map(globToRegex);
  async function* walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (shouldSkip(rel, skipRegexes)) continue;
      if (entry.isSymbolicLink()) {
        // Don't follow symlinks - safety (G-05)
        continue;
      }
      if (entry.isDirectory()) {
        yield* walk(full);
      } else if (entry.isFile()) {
        if (await isTextFile(full)) {
          yield full;
        }
      }
    }
  }
  yield* walk(root);
}

function shouldSkip(relativePath, skipRegexes) {
  const normalized = relativePath.replace(/\\/g, '/');
  return skipRegexes.some((rx) => rx.test(normalized));
}

/**
 * Glob-to-regex with proper globstar handling.
 *
 * Supported tokens:
 *   globstar (double-asterisk)         - match any path including slash
 *   globstar + slash                   - match zero-or-more directories
 *   slash + globstar                   - match zero-or-more tail
 *   single-asterisk                    - match any non-slash chars
 *   single-question                    - match single non-slash char
 */
function globToRegex(glob) {
  // Escape regex special chars except our glob chars (* and ?)
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Replace glob tokens with placeholders (to avoid self-rewriting)
  pattern = pattern
    .replace(/\*\*\//g, '\x01') // globstar + slash
    .replace(/\/\*\*/g, '\x02') // slash + globstar
    .replace(/\*\*/g, '\x03') // bare globstar
    .replace(/\*/g, '\x04') // single asterisk
    .replace(/\?/g, '\x05'); // question mark

  // Substitute placeholders with final regex fragments
  pattern = pattern
    .replace(/\x01/g, '(?:.*/)?')
    .replace(/\x02/g, '(?:/.*)?')
    .replace(/\x03/g, '.*')
    .replace(/\x04/g, '[^/]*')
    .replace(/\x05/g, '[^/]');

  return new RegExp(`^${pattern}$`);
}

/**
 * Heuristic check if a file is likely text.
 * Handles UTF-8 multi-byte characters (e.g. Japanese) correctly.
 *
 * Approach:
 *   1. Null byte = strong binary signal
 *   2. Decode non-strict (replace invalid sequences with U+FFFD)
 *   3. If replacement character ratio high OR control char ratio high = binary
 */
export async function isTextFile(filePath) {
  try {
    const handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    await handle.close();
    if (bytesRead === 0) return true; // Empty file, treat as text
    const slice = buffer.subarray(0, bytesRead);

    // Null byte = strong binary indicator
    if (slice.includes(0)) return false;

    // Decode non-strict: cut sample at the last complete UTF-8 code point
    // to avoid false positives from truncated multi-byte sequences.
    const safeSlice = trimIncompleteUtf8(slice);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(safeSlice);

    // Count invalid UTF-8 replacement characters (U+FFFD)
    let replacementCount = 0;
    let controlChars = 0;
    let totalChars = 0;
    for (const ch of text) {
      totalChars++;
      const cp = ch.codePointAt(0);
      if (cp === 0xFFFD) {
        replacementCount++;
        continue;
      }
      if (cp < 32 && cp !== 9 && cp !== 10 && cp !== 11 && cp !== 12 && cp !== 13) {
        controlChars++;
      } else if (cp === 127) {
        controlChars++;
      }
    }

    if (totalChars === 0) return true;
    // Heuristic thresholds: both must be low for text
    if (replacementCount / totalChars > 0.05) return false;
    if (controlChars / totalChars > 0.05) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Trim a Buffer to end at the last complete UTF-8 code point boundary.
 * Avoids misclassifying UTF-8 text as binary when the sample cut a multi-byte char.
 */
function trimIncompleteUtf8(buf) {
  if (buf.length === 0) return buf;
  // Walk back up to 4 bytes from the end to find a safe boundary.
  for (let i = 0; i < 4 && buf.length - 1 - i >= 0; i++) {
    const idx = buf.length - 1 - i;
    const b = buf[idx];
    // ASCII (0xxxxxxx) = safe boundary after this byte
    if ((b & 0x80) === 0) return buf.subarray(0, idx + 1);
    // Start of multi-byte (11xxxxxx) = this byte starts a truncated sequence -> cut before it
    if ((b & 0xC0) === 0xC0) return buf.subarray(0, idx);
    // Continuation byte (10xxxxxx) = keep looking back
  }
  // Fallback: trim last 4 bytes
  return buf.subarray(0, Math.max(0, buf.length - 4));
}

/**
 * Check if file exists
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create lockfile for concurrency control
 * FR-34
 *
 * Uses fs.writeFile with { flag: 'wx' } for atomic exclusive create.
 * This eliminates the TOCTOU race window between existence check and creation.
 */
export async function acquireLock(slug) {
  const lockPath = path.join('/tmp', `portfolio-build-${slug}.lock`);
  const lockContent = JSON.stringify({
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });

  // Try atomic exclusive create
  try {
    await fs.writeFile(lockPath, lockContent, { flag: 'wx' });
    return lockPath;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }

  // Lockfile already exists - check if it's stale
  let existingPid = null;
  let existingTimestamp = null;
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(content);
    existingPid = parsed.pid;
    existingTimestamp = parsed.timestamp;
  } catch {
    // Malformed lock file - try to take it over
    await fs.unlink(lockPath).catch(() => {});
    return acquireLock(slug); // retry once
  }

  // Check if owning process is still alive
  if (existingPid && typeof existingPid === 'number') {
    try {
      process.kill(existingPid, 0);
      // Process alive - we cannot take the lock
      throw new ConcurrencyError(
        `Another publish process is running for slug=${slug} (PID: ${existingPid})`,
        { pid: existingPid, timestamp: existingTimestamp }
      );
    } catch (killErr) {
      if (killErr instanceof ConcurrencyError) throw killErr;
      if (killErr.code !== 'ESRCH') {
        // Permission denied or other error - assume alive (safer)
        throw new ConcurrencyError(
          `Cannot verify lock owner state for slug=${slug} (PID: ${existingPid}): ${killErr.message}`,
          { pid: existingPid, timestamp: existingTimestamp, error: killErr.message }
        );
      }
      // Process dead - stale lock. Remove and retry atomic create.
    }
  }

  // Stale lock removal + retry atomic create
  await fs.unlink(lockPath).catch(() => {});
  try {
    await fs.writeFile(lockPath, lockContent, { flag: 'wx' });
    return lockPath;
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new ConcurrencyError(
        `Race detected acquiring lock for slug=${slug}, another process won`,
        { lockPath }
      );
    }
    throw err;
  }
}

export async function releaseLock(lockPath) {
  await fs.unlink(lockPath).catch(() => {});
}

/**
 * Get directory size in bytes (recursive)
 */
export async function getDirectorySize(dir) {
  let total = 0;
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          total += stat.size;
        } catch {}
      }
    }
  }
  await walk(dir);
  return total;
}
