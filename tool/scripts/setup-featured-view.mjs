#!/usr/bin/env node
/**
 * Try to create a Featured view programmatically via Notion API.
 *
 * Notion API limitations:
 *   - Cannot directly create views on a database
 *   - Linked databases via API: limited block types support filtering
 *
 * Strategy: Try multiple approaches and report which works.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, createNotionClient } from '../lib/notion-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'secrets.local.json');
const PAGE_ID = '<notion-page-id>';

async function main() {
  const config = await loadConfig(CONFIG_PATH);
  const client = createNotionClient(config.notion.token);
  const dbId = config.notion.projects_db_id;

  console.log('=== 試行1: 既存DB のビュー一覧取得（参考情報）===');
  try {
    const db = await client.databases.retrieve({ database_id: dbId });
    console.log('  DB ID:', db.id);
    console.log('  Title:', db.title?.[0]?.plain_text || '(none)');
    // views フィールドが返ってくるか
    if (db.views) {
      console.log('  Views:', JSON.stringify(db.views, null, 2));
    } else {
      console.log('  → ビュー情報は API レスポンスに含まれない（Notion APIの制限）');
    }
  } catch (err) {
    console.log('  Error:', err.message);
  }

  console.log('\n=== 試行2: Featured フィルタ付きの linked_database ブロック追加 ===');
  try {
    const result = await client.blocks.children.append({
      block_id: PAGE_ID,
      children: [
        {
          object: 'block',
          type: 'heading_2',
          heading_2: {
            rich_text: [{ type: 'text', text: { content: '⭐ Featured Projects' } }],
          },
        },
        {
          object: 'block',
          type: 'link_to_page',
          link_to_page: {
            type: 'database_id',
            database_id: dbId,
          },
        },
      ],
    });
    console.log('  ✅ link_to_page ブロック追加成功');
    console.log('  ※ ただし、フィルタ条件はAPIから設定不可');
  } catch (err) {
    console.log('  ❌ Failed:', err.message);
  }

  console.log('\n=== 結論 ===');
  console.log('Notion API は views の create / filter 設定をサポートしていません。');
  console.log('リンクブロックは作れたものの、Featured フィルタは UI 側で1クリック必要です。');
  console.log('');
  console.log('💡 推奨: 手動で30秒、Projects DB に Gallery ビューを追加してフィルタ設定。');
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
