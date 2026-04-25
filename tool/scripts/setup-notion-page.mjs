#!/usr/bin/env node
/**
 * Phase 0 自動化:
 * 1) AI Engineer Portfolio ページに「料金目安」「受付中バッジ」「Tally 埋め込み」を追加
 * 2) 既存「提出物管理」レコードの新規列を埋める
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, createNotionClient } from '../lib/notion-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'secrets.local.json');

const PAGE_ID = '<notion-page-id>';
const TALLY_FORM_URL = 'https://tally.so/r/<form-id>';

// =============================================================
// 1) ページに新規セクションを末尾追加
// =============================================================
const NEW_SECTIONS = [
  // Divider
  { object: 'block', type: 'divider', divider: {} },

  // 受付中バッジ
  {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content: '現在受付中（2026年5月分・残り2枠）／ 24時間以内に初回返信します' } }],
      icon: { type: 'emoji', emoji: '🟢' },
      color: 'green_background',
    },
  },

  // 料金目安
  {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: '💴 料金の目安' } }],
    },
  },
  {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: 'AIと一緒に、小さな業務ツールを素早く形にします。お見積りはお気軽にどうぞ。' } }],
    },
  },
  {
    object: 'block',
    type: 'table',
    table: {
      table_width: 3,
      has_column_header: true,
      has_row_header: false,
      children: [
        tableRow(['案件サイズ', '料金目安', '納期目安']),
        tableRow(['小規模（業務ツール1本）', '5〜10万円', '2〜3週間']),
        tableRow(['中規模（Webアプリ等）', '10〜30万円', '1〜2ヶ月']),
        tableRow(['複雑案件・継続契約', '要相談', '要相談']),
      ],
    },
  },
  {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: '※ 本格契約の前に、簡易ヒアリング（30分・無料）でフィット感を確認します。' },
        },
      ],
    },
  },

  // Divider
  { object: 'block', type: 'divider', divider: {} },

  // お問い合わせ
  {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: '📥 お問い合わせ' } }],
    },
  },
  {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: '下のフォームから、業務課題や作りたいツールについてお聞かせください。24時間以内にお返事します。' },
        },
      ],
    },
  },
  {
    object: 'block',
    type: 'embed',
    embed: { url: TALLY_FORM_URL },
  },
  {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [
        {
          type: 'text',
          text: {
            content:
              'ご入力いただく情報（氏名・メール・会社名等）は、案件相談対応のためのみ利用します。保管期間は最終やり取りから3年、それ以降は削除します（個人情報保護法 APPI 準拠）。',
          },
        },
      ],
      icon: { type: 'emoji', emoji: '🔒' },
      color: 'gray_background',
    },
  },
];

function tableRow(cells) {
  return {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: cells.map((c) => [{ type: 'text', text: { content: c } }]),
    },
  };
}

// =============================================================
// 2) 既存「提出物管理」レコードを 11列スキーマに合わせて更新
// =============================================================
const SUBMISSION_TRACKER_PROPERTIES = {
  Category: { select: { name: '業務自動化' } },
  Featured: { checkbox: true },
  Status: { select: { name: 'リリース済' } },
  実務種別: { select: { name: '自主開発' } },
  Published: { date: { start: '2026-03-09' } },
  'GitHub URL': { url: 'https://github.com/<github-owner>/school-submission-manager' },
  'Key Metric': {
    rich_text: [{ type: 'text', text: { content: '40名同時接続対応 / 提出率+35% / 開発時間短縮' } }],
  },
  // 'Demo URL' は GAS で公開URL なので任意
};

async function main() {
  const config = await loadConfig(CONFIG_PATH);
  const client = createNotionClient(config.notion.token);

  // === Step 1: ページに新規セクションを追加 ===
  console.log('=== Step 1: ページ末尾に新セクション追加 ===');
  // すでに追加済みかチェック（'料金' 文字列がページ内にあれば skip）
  const existing = await client.blocks.children.list({ block_id: PAGE_ID, page_size: 100 });
  const allText = existing.results
    .map((b) => {
      const t = b.type;
      return b[t]?.rich_text?.map((rt) => rt.plain_text).join('') || '';
    })
    .join(' ');

  if (allText.includes('料金の目安') || allText.includes('お問い合わせ') && allText.includes('現在受付中')) {
    console.log('既に追加済みのセクションが検出されました - スキップ');
  } else {
    // Notion API は1回 append あたり 100ブロックまで
    await client.blocks.children.append({
      block_id: PAGE_ID,
      children: NEW_SECTIONS,
    });
    console.log(`✅ ${NEW_SECTIONS.length} ブロック追加`);
  }

  // === Step 2: 既存「提出物管理」レコード更新 ===
  console.log('\n=== Step 2: 「提出物管理」レコード新列補完 ===');
  const records = await client.databases.query({
    database_id: config.notion.projects_db_id,
    filter: { property: 'Name', title: { equals: '提出物管理' } },
  });
  if (records.results.length === 0) {
    console.log('「提出物管理」レコードが見つかりません');
  } else {
    const recordId = records.results[0].id;
    await client.pages.update({
      page_id: recordId,
      properties: SUBMISSION_TRACKER_PROPERTIES,
    });
    console.log('✅ 「提出物管理」を新スキーマで埋めました（Featured = true）');
  }

  console.log('\n🎉 完了');
  console.log(`  ページ: https://www.notion.so/AI-Engineer-Portfolio-${PAGE_ID.replace(/-/g, '')}`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  if (err.body) console.error('  Body:', err.body);
  process.exit(1);
});
