/**
 * Custom Error Hierarchy
 * Based on design.md §7.1
 *
 * SafeError: Base class with automatic secret masking in toString/toJSON
 */

const SECRET_PATTERNS = [
  { name: 'notion-token', pattern: /ntn_[A-Za-z0-9_-]+/g },
  { name: 'github-pat', pattern: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'github-pat-finegrained', pattern: /github_pat_[\w_]{80,}/g },
  { name: 'openai-key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{90,}/g },
  { name: 'google-key', pattern: /AIza[A-Za-z0-9_-]{30,}/g },
  { name: 'google-oauth', pattern: /ya29\.[A-Za-z0-9_-]+/g },
  { name: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { name: 'jwt', pattern: /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g },
  { name: 'basic-auth', pattern: /Basic\s+[A-Za-z0-9+/=]+/g },
  { name: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._-]+/g },
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },
];

/**
 * Replace secret patterns in text with [REDACTED:<type>]
 */
export function maskSecrets(text) {
  if (typeof text !== 'string') return text;
  let masked = text;
  for (const { name, pattern } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, `[REDACTED:${name}]`);
  }
  return masked;
}

/**
 * Recursively mask secrets in any object
 */
export function maskSecretsInObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return maskSecrets(obj);
  if (Array.isArray(obj)) return obj.map(maskSecretsInObject);
  if (typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = maskSecretsInObject(v);
    }
    return result;
  }
  return obj;
}

/**
 * Base class for all custom errors
 * Automatically masks secrets in error messages and stack traces
 */
export class SafeError extends Error {
  constructor(message, context = {}) {
    super(maskSecrets(message));
    this.name = this.constructor.name;
    this.context = maskSecretsInObject(context);
    this.exitCode = 1;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      exitCode: this.exitCode,
      stack: this.stack ? maskSecrets(this.stack) : undefined,
    };
  }

  toString() {
    return `${this.name}: ${this.message}`;
  }
}

export class ValidationError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 2;
  }
}

export class CloneError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 3;
  }
}

export class SanitizeIncompleteError extends SafeError {
  constructor(message, findings = []) {
    super(message, { findings: maskSecretsInObject(findings) });
    this.exitCode = 4;
    // Security: store masked findings only.
    // Raw secrets must NOT be retained on the error object even briefly,
    // because handlers might log err.findings directly.
    this.findings = maskSecretsInObject(findings);
  }
}

export class TemplateError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 5;
  }
}

export class GitHubApiError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 6;
  }
}

export class NotionApiError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 7;
  }
}

export class RollbackError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 8;
  }
}

// Special exit codes
export class ConfigurationError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 10;
  }
}

export class EnvironmentError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 11;
  }
}

export class NotionPermissionError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 12;
  }
}

export class DiskSpaceError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 13;
  }
}

export class ConcurrencyError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 14;
  }
}

export class EmptyRepositoryError extends SafeError {
  constructor(message, context) {
    super(message, context);
    this.exitCode = 15;
  }
}

/**
 * Format an error for display to the user with recovery hints
 */
export function formatErrorForUser(err) {
  const lines = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `❌ ${err.name}: ${err.message}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ];

  const hints = getRecoveryHints(err);
  if (hints.length > 0) {
    lines.push('');
    lines.push('💡 考えられる原因と対処法:');
    hints.forEach((hint, i) => lines.push(`  ${i + 1}. ${hint}`));
  }

  if (err.context && Object.keys(err.context).length > 0) {
    lines.push('');
    lines.push('🔍 詳細:');
    lines.push(JSON.stringify(err.context, null, 2));
  }

  lines.push('');
  lines.push(`Exit code: ${err.exitCode || 1}`);
  lines.push('');
  return lines.join('\n');
}

function getRecoveryHints(err) {
  if (err instanceof ValidationError) {
    return [
      'projects/<slug>/portfolio.yaml の必須フィールドを確認',
      'projects/<slug>/source-repo.txt の URL 形式を確認（https://github.com/owner/repo）',
      'portfolio.yaml が UTF-8 without BOM で保存されているか確認',
    ];
  }
  if (err instanceof CloneError) {
    return [
      'gh auth status で GitHub 認証を確認',
      'source-repo.txt の URL にアクセス可能か確認（gh repo view <url>）',
      'ネットワーク接続を確認',
    ];
  }
  if (err instanceof SanitizeIncompleteError) {
    return [
      '出力された機密パターンを tool/sanitize-rules.json に追加',
      '原本リポジトリの該当箇所を直接修正',
      '.env やテストデータに残っていないか確認',
    ];
  }
  if (err instanceof NotionApiError) {
    return [
      'tool/config/secrets.local.json の notion.token が有効か確認',
      'Portfolio Publisher インテグレーションが対象ページに共有されているか確認',
      'projects_db_id が正しいか確認',
    ];
  }
  if (err instanceof GitHubApiError) {
    return [
      'gh auth status で認証を確認',
      'Public リポジトリ作成権限があるか確認',
      '同名リポジトリが既に存在する場合は冪等性フロー（skip/update/recreate）を使用',
    ];
  }
  if (err instanceof DiskSpaceError) {
    return [
      '/tmp の空き容量を確認（df -h /tmp）',
      '/tmp/portfolio-build-* を削除してスペース確保',
    ];
  }
  if (err instanceof ConfigurationError) {
    return [
      'tool/config/secrets.local.json が存在するか確認',
      '環境変数 NOTION_TOKEN が ntn_ で始まる値を持つか確認',
    ];
  }
  return [];
}
