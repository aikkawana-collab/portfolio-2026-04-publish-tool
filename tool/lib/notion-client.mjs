/**
 * Notion API Client Wrapper
 * FR-20, FR-21, FR-28, FR-29, FR-30, FR-37, FR-40
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@notionhq/client';
import {
  NotionApiError,
  ConfigurationError,
  NotionPermissionError,
} from './errors.mjs';

const NOTION_VERSION = '2022-06-28';
const MAX_RETRIES = 3;

/**
 * Load configuration from env or secrets.local.json
 */
export async function loadConfig(configPath) {
  // FR-28: env > file
  const envToken = process.env.NOTION_TOKEN;
  const envDbId = process.env.NOTION_PROJECTS_DB_ID;

  let config = {
    notion: {
      token: envToken || null,
      projects_db_id: envDbId || null,
    },
    github: {
      username: process.env.GITHUB_USERNAME || null,
    },
    gmail: {
      notification_address: null,
    },
  };

  try {
    const content = await fs.readFile(configPath, 'utf8');
    const fileConfig = JSON.parse(content);
    // env takes priority; only fill missing values from file
    if (!config.notion.token) config.notion.token = fileConfig.notion?.token ?? null;
    if (!config.notion.projects_db_id) {
      config.notion.projects_db_id = fileConfig.notion?.projects_db_id ?? null;
    }
    if (!config.github.username) {
      config.github.username = fileConfig.github?.username ?? null;
    }
    config.gmail.notification_address = fileConfig.gmail?.notification_address ?? null;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new ConfigurationError(
        `Failed to read ${configPath}: ${err.message}`,
        { path: configPath }
      );
    }
    // File missing is OK if env is set
  }

  // FR-30: Validate token
  const { token, projects_db_id } = config.notion;
  if (!token || !token.startsWith('ntn_')) {
    throw new ConfigurationError(
      `NOTION_TOKEN is missing or invalid (must start with 'ntn_').\n` +
      `Setup:\n` +
      `  1. Set env: export NOTION_TOKEN=ntn_...\n` +
      `  2. Or create tool/config/secrets.local.json with {"notion": {"token": "ntn_..."}}\n` +
      `  3. See tool/config/secrets.example.json for template`
    );
  }
  if (!projects_db_id) {
    throw new ConfigurationError(
      `NOTION_PROJECTS_DB_ID is required (Projects DB ID)`
    );
  }

  return config;
}

/**
 * Create a Notion client instance
 */
export function createNotionClient(token) {
  return new Client({
    auth: token,
    notionVersion: NOTION_VERSION,
  });
}

/**
 * FR-37: Verify Notion API version + connection
 * FR-40: Verify integration permissions
 */
export async function verifyIntegration(client, projectsDbId) {
  let user;
  try {
    user = await retry(() => client.users.me({}), 'users.me');
  } catch (err) {
    throw new NotionApiError(
      `Failed to verify Notion integration: ${err.message}`,
      { operation: 'users.me' }
    );
  }

  // FR-40: Must be bot type
  if (user.type !== 'bot') {
    throw new NotionPermissionError(
      `Notion integration must be bot type (got: ${user.type})`,
      { userType: user.type }
    );
  }

  // FR-40: Must have access to Projects DB
  try {
    const db = await retry(
      () => client.databases.retrieve({ database_id: projectsDbId }),
      'databases.retrieve'
    );
    return {
      ok: true,
      botName: user.name,
      workspaceName: user.bot?.workspace_name || 'unknown',
      dbTitle: db.title?.[0]?.plain_text || '(untitled)',
      dbId: db.id,
    };
  } catch (err) {
    throw new NotionPermissionError(
      `Portfolio Publisher integration does not have access to Projects DB (${projectsDbId}).\n` +
      `Fix: Open the Notion page containing the DB, click "..." → "Connections" → add "Portfolio Publisher".`,
      { projectsDbId, error: err.message }
    );
  }
}

/**
 * Create a new page (record) in the Projects DB
 * FR-20, FR-21
 *
 * @param {Client} client
 * @param {string} databaseId
 * @param {object} properties - DB properties (§3.10 FR-21)
 * @param {Array} blocks - Children blocks (§3.8 FR-22 structure)
 * @param {object} options - { cover, icon }
 * @returns {Promise<{pageId: string, url: string}>}
 */
export async function createProjectPage(client, databaseId, properties, blocks, options = {}) {
  const payload = {
    parent: { database_id: databaseId },
    properties,
    children: blocks,
  };
  if (options.cover) {
    payload.cover = options.cover;
  }
  if (options.icon) {
    payload.icon = options.icon;
  }

  try {
    const page = await retry(() => client.pages.create(payload), 'pages.create');
    return {
      pageId: page.id,
      url: page.url,
    };
  } catch (err) {
    throw new NotionApiError(
      `Failed to create Notion page: ${err.message}`,
      {
        operation: 'pages.create',
        databaseId,
        statusCode: err.status,
        notionErrorCode: err.code,
      }
    );
  }
}

/**
 * FR-23.1: Archive a page (soft delete, since Delete permission is not granted)
 */
export async function archivePage(client, pageId) {
  try {
    await retry(
      () => client.pages.update({ page_id: pageId, archived: true }),
      'pages.update-archive'
    );
    return { archived: true, pageId };
  } catch (err) {
    throw new NotionApiError(
      `Failed to archive Notion page: ${err.message}`,
      { pageId, error: err.message }
    );
  }
}

/**
 * Search for existing records matching title+published_at
 * FR-27 idempotency
 */
export async function findExistingRecord(client, databaseId, title, publishedAt) {
  try {
    const response = await retry(
      () =>
        client.databases.query({
          database_id: databaseId,
          filter: {
            and: [
              { property: 'Name', title: { equals: title } },
              { property: 'Published', date: { equals: publishedAt } },
            ],
          },
        }),
      'databases.query'
    );
    return response.results;
  } catch (err) {
    // If Property names differ, fall back to loose search
    return [];
  }
}

/**
 * Retry wrapper with exponential backoff
 * FR-23 - handles 429 (rate limit) and transient errors
 */
async function retry(fn, operation, maxAttempts = MAX_RETRIES) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry 4xx except 429
      const status = err.status || err.statusCode;
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      if (attempt < maxAttempts) {
        const waitMs = Math.pow(2, attempt - 1) * 1000;
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
