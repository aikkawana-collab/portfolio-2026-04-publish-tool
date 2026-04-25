/**
 * Rollback Manager
 * FR-23, FR-26
 */

import readline from 'node:readline';
import { RollbackError } from './errors.mjs';

export class RollbackManager {
  constructor(options = {}) {
    this.logger = options.logger;
    this.interactive = options.interactive !== false;
    this.rollbackOnError = options.rollbackOnError || 'ask'; // 'yes' | 'no' | 'ask'
    this._tasks = []; // { label, fn, isProtected }
  }

  /**
   * Register a rollback task. Will be executed in reverse order.
   *
   * @param {string} label - human-readable label
   * @param {Function} fn - async function to perform rollback
   * @param {object} options - { protected: don't rollback this (e.g., local temp dir) }
   */
  register(label, fn, options = {}) {
    this._tasks.push({ label, fn, isProtected: !!options.protected });
  }

  /**
   * Execute all rollback tasks in reverse order
   */
  async execute() {
    if (this._tasks.length === 0) {
      await this.logger?.info('No rollback tasks registered');
      return { rolled: 0, failed: 0, skipped: 0 };
    }

    const stats = { rolled: 0, failed: 0, skipped: 0 };

    // Reverse order (LIFO)
    const tasks = [...this._tasks].reverse();

    for (const task of tasks) {
      if (task.isProtected) {
        await this.logger?.info(`Rollback: protected - skipping "${task.label}"`);
        stats.skipped++;
        continue;
      }

      // Decide if this task should run
      const shouldRun = await this._shouldRollback(task.label);
      if (!shouldRun) {
        await this.logger?.info(`Rollback: user declined - skipping "${task.label}"`);
        stats.skipped++;
        continue;
      }

      try {
        await this.logger?.warn(`Rollback: executing "${task.label}"`);
        await task.fn();
        stats.rolled++;
      } catch (err) {
        await this.logger?.error(`Rollback failed for "${task.label}": ${err.message}`);
        stats.failed++;
      }
    }

    if (stats.failed > 0) {
      throw new RollbackError(
        `${stats.failed} rollback task(s) failed`,
        stats
      );
    }

    return stats;
  }

  async _shouldRollback(label) {
    if (this.rollbackOnError === 'yes') return true;
    if (this.rollbackOnError === 'no') return false;

    if (!this.interactive) {
      // Non-interactive default is 'yes' (safer)
      return true;
    }

    return await promptConfirm(`Rollback "${label}"? [Y/n]: `, true);
  }

  /**
   * Clear all registered tasks (on success)
   */
  clear() {
    this._tasks = [];
  }

  get taskCount() {
    return this._tasks.length;
  }
}

/**
 * Prompt user for yes/no confirmation
 */
export async function promptConfirm(question, defaultYes = true) {
  if (!process.stdin.isTTY) {
    return defaultYes;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else if (a === 'y' || a === 'yes') resolve(true);
      else resolve(false);
    });
  });
}

/**
 * Prompt user for choice from list
 */
export async function promptChoice(question, choices) {
  if (!process.stdin.isTTY) {
    return choices[choices.length - 1]; // default to last (usually safest = abort)
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log(question);
  choices.forEach((choice, i) => {
    console.log(`  ${i + 1}. ${choice}`);
  });
  return new Promise((resolve) => {
    rl.question('選択 [1-' + choices.length + ']: ', (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
      } else {
        resolve(choices[choices.length - 1]);
      }
    });
  });
}
