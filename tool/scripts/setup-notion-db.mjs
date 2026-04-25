#!/usr/bin/env node
/**
 * Phase 0 自動化: Projects DB を11列に拡張
 *
 * Adds 8 new columns to existing 3-column DB:
 *   - Category (select)
 *   - Featured (checkbox)
 *   - Status (select)
 *   - 実務種別 (select)
 *   - Published (date)
 *   - Demo URL (url)
 *   - GitHub URL (url)
 *   - Key Metric (rich_text)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, createNotionClient } from '../lib/notion-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'secrets.local.json');

const REQUIRED_PROPERTIES = {
  Category: {
    select: {
      options: [
        { name: 'Web App', color: 'blue' },
        { name: '業務自動化', color: 'green' },
        { name: 'AI', color: 'purple' },
        { name: 'その他', color: 'gray' },
      ],
    },
  },
  Featured: {
    checkbox: {},
  },
  Status: {
    select: {
      options: [
        { name: 'リリース済', color: 'green' },
        { name: '開発中', color: 'yellow' },
        { name: '完成', color: 'blue' },
      ],
    },
  },
  実務種別: {
    select: {
      options: [
        { name: '実務案件', color: 'pink' },
        { name: '自主開発', color: 'orange' },
        { name: '練習', color: 'gray' },
      ],
    },
  },
  Published: {
    date: {},
  },
  'Demo URL': {
    url: {},
  },
  'GitHub URL': {
    url: {},
  },
  'Key Metric': {
    rich_text: {},
  },
};

async function main() {
  const config = await loadConfig(CONFIG_PATH);
  const client = createNotionClient(config.notion.token);
  const dbId = config.notion.projects_db_id;

  // Get current schema
  const db = await client.databases.retrieve({ database_id: dbId });
  console.log('現在のDB列:');
  for (const [name, prop] of Object.entries(db.properties)) {
    console.log(`  - ${name} (${prop.type})`);
  }

  // Compute additions needed
  const existing = new Set(Object.keys(db.properties));
  const toAdd = {};
  for (const [name, def] of Object.entries(REQUIRED_PROPERTIES)) {
    if (!existing.has(name)) {
      toAdd[name] = def;
    }
  }

  if (Object.keys(toAdd).length === 0) {
    console.log('✅ 全ての列が既に存在します');
    return;
  }

  console.log('\n追加する列:');
  for (const name of Object.keys(toAdd)) {
    console.log(`  + ${name}`);
  }

  // Update DB schema
  const updated = await client.databases.update({
    database_id: dbId,
    properties: toAdd,
  });

  console.log('\n✅ DB拡張完了');
  console.log('現在のDB列（更新後）:');
  for (const [name, prop] of Object.entries(updated.properties)) {
    console.log(`  - ${name} (${prop.type})`);
  }
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  if (err.body) console.error('  Body:', err.body);
  process.exit(1);
});
