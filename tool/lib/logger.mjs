/**
 * Structured Logger with automatic secret masking
 * FR-24, FR-24.1 (G-03)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { maskSecrets, maskSecretsInObject } from './errors.mjs';

export const LogLevel = Object.freeze({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
});

const COLORS = {
  DEBUG: '\x1b[90m',
  INFO: '\x1b[36m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  CRITICAL: '\x1b[1;31m',
  RESET: '\x1b[0m',
  GREEN: '\x1b[32m',
  BLUE: '\x1b[34m',
};

export class Logger {
  constructor(options = {}) {
    this.logFilePath = options.logFilePath || null;
    this.minLevel = options.minLevel || LogLevel.INFO;
    this.steps = options.totalSteps || 10;
    this.currentStep = 0;
    this._buffer = [];
  }

  /**
   * Set the log file path (after tempDir is created)
   */
  setLogFilePath(filePath) {
    this.logFilePath = filePath;
    // Flush buffer to file
    this._flushBuffer();
  }

  async _flushBuffer() {
    if (!this.logFilePath || this._buffer.length === 0) return;
    const lines = this._buffer.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await fs.appendFile(this.logFilePath, lines).catch(() => {});
    this._buffer = [];
  }

  async _write(level, message, context = {}, step = null) {
    const maskedMessage = maskSecrets(message);
    const maskedContext = maskSecretsInObject(context);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      step: step || maskedContext.step,
      message: maskedMessage,
      context: maskedContext,
    };

    // Console output
    const color = COLORS[level] || '';
    const reset = COLORS.RESET;
    const prefix = `${color}[${level}]${reset}`;
    const stepStr = entry.step ? `${COLORS.BLUE}${entry.step}${reset} ` : '';
    console.log(`${prefix} ${stepStr}${maskedMessage}`);
    if (Object.keys(maskedContext).length > 0 && level === LogLevel.DEBUG) {
      console.log(`  ${COLORS.DEBUG}${JSON.stringify(maskedContext)}${COLORS.RESET}`);
    }

    // File output (JSON Lines)
    if (this.logFilePath) {
      try {
        await fs.appendFile(this.logFilePath, JSON.stringify(entry) + '\n');
      } catch {
        // Silent fail - logging should never break the app
      }
    } else {
      this._buffer.push(entry);
    }
  }

  async debug(message, context) {
    await this._write(LogLevel.DEBUG, message, context);
  }

  async info(message, context) {
    await this._write(LogLevel.INFO, message, context);
  }

  async warn(message, context) {
    await this._write(LogLevel.WARN, message, context);
  }

  async error(message, context) {
    await this._write(LogLevel.ERROR, message, context);
  }

  async critical(message, context) {
    await this._write(LogLevel.CRITICAL, message, context);
  }

  /**
   * Log start of a step with progress indicator
   * NFR-U-3
   */
  async step(stepNumber, totalSteps, name, emoji = '▶') {
    this.currentStep = stepNumber;
    const stepLabel = `[Step ${stepNumber}/${totalSteps}]`;
    console.log('');
    console.log(`${COLORS.BLUE}${emoji} ${stepLabel} ${name}${COLORS.RESET}`);
    await this.info(`Starting: ${name}`, { step: stepLabel });
  }

  async success(message, context) {
    console.log(`${COLORS.GREEN}✅ ${message}${COLORS.RESET}`);
    await this._write(LogLevel.INFO, `SUCCESS: ${message}`, context);
  }
}

/**
 * Create a logger. logFilePath can be set later via setLogFilePath()
 */
export function createLogger(options = {}) {
  return new Logger(options);
}
