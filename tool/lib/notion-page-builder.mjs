/**
 * Notion Page Builder
 * Builds {properties, blocks} payload for FR-21, FR-22, FR-22.1〜22.4
 *
 * 2-layer structure (ADR-003):
 * - 表層 (11 blocks): non-engineer audience
 * - 深掘り層 (2 toggles): engineer audience
 * - 補足 (1 block): disclosure
 */

/**
 * Build DB properties (§3.10 FR-21)
 *
 * @param {object} metadata - from input-validator
 * @param {string} publicUrl - created GitHub public URL
 */
export function buildProperties(metadata, publicUrl) {
  const y = metadata.yaml;
  const props = {
    Name: {
      title: [{ type: 'text', text: { content: y.title } }],
    },
    '概要': {
      rich_text: [{ type: 'text', text: { content: y.tagline } }],
    },
    Category: {
      select: { name: y.category },
    },
    Tech: {
      multi_select: y.tech_stack.map((t) => ({ name: t })),
    },
    Featured: {
      checkbox: !!y.featured,
    },
    Status: {
      select: { name: y.status },
    },
    '実務種別': {
      select: { name: y.project_type },
    },
    Published: {
      date: { start: y.published_at },
    },
    'GitHub URL': {
      url: publicUrl,
    },
    'Key Metric': {
      rich_text: [{ type: 'text', text: { content: y.key_metric } }],
    },
  };
  if (y.live_demo_url) {
    props['Demo URL'] = { url: y.live_demo_url };
  }
  return props;
}

/**
 * Build children blocks (§3.8 FR-22)
 * Returns array of Notion Block objects.
 */
export function buildBlocks(metadata, publicUrl) {
  const y = metadata.yaml;
  const blocks = [];

  // ━━━ 表層（非エンジニア向け）━━━

  // 1. (Cover image is a page-level cover, not a block - handled by buildCover)

  // 2. 🎯 Key Metric (callout, blue background)
  blocks.push(calloutBlock(y.key_metric, '🎯', 'blue_background'));

  // 3. 👥 対象・役割
  blocks.push(paragraph(`👥 ${y.target_role}`));

  // 4. Overview 概要
  blocks.push(heading2('Overview 概要'));
  blocks.push(paragraph(y.overview));

  // 5. Problem 何を解決するか
  blocks.push(heading2('Problem 何を解決するか'));
  for (const p of y.problem) {
    blocks.push(bulletedListItem(p));
  }

  // 6. Solution どうやって解決するか
  blocks.push(heading2('Solution どうやって解決するか'));
  blocks.push(paragraph(y.solution));

  // 7. Tech Stack 使用技術 (as a 2-column table)
  blocks.push(heading2('Tech Stack 使用技術'));
  blocks.push(techStackTable(y.tech_stack));

  // 8. Features 主な機能
  blocks.push(heading2('Features 主な機能'));
  for (const f of y.features) {
    blocks.push(bulletedListItem(f));
  }

  // 9. 📊 Results 成果
  blocks.push(heading2('📊 Results 成果'));
  blocks.push(paragraph(y.results));

  // 10. Demo (FR-22.2: skip if no URL)
  if (y.live_demo_url) {
    blocks.push(heading2('Demo アプリURL'));
    blocks.push(bookmarkBlock(y.live_demo_url));
  }

  // 11. GitHub
  blocks.push(heading2('GitHub'));
  blocks.push(bookmarkBlock(publicUrl));

  // ━━━ 深掘り層（エンジニア向け・Toggle）━━━

  // 12. ▼ 技術詳細 (FR-22.3)
  const techDetailChildren = [];
  techDetailChildren.push(heading3('技術スタック'));
  techDetailChildren.push(techStackTable(y.tech_stack));
  if (y.architecture_note) {
    techDetailChildren.push(heading3('アーキテクチャ'));
    techDetailChildren.push(paragraph(y.architecture_note));
  }
  if (y.metrics) {
    const m = y.metrics;
    const metricLines = [];
    if (m.dev_hours) metricLines.push(`開発工数: ${m.dev_hours}h`);
    if (m.lines_of_code) metricLines.push(`コード規模: 約${m.lines_of_code}行`);
    if (m.issues_closed) metricLines.push(`完了Issue: ${m.issues_closed}`);
    if (m.cost) metricLines.push(`運用コスト: ${m.cost}`);
    if (metricLines.length > 0) {
      techDetailChildren.push(heading3('コード規模・統計'));
      for (const line of metricLines) {
        techDetailChildren.push(bulletedListItem(line));
      }
    }
  }
  blocks.push(toggleBlock('▼ 技術詳細（クリックで展開）', techDetailChildren));

  // 13. ▼ こだわりポイント (FR-22.4: skip if empty)
  if (Array.isArray(y.highlights) && y.highlights.length > 0) {
    const highlightChildren = y.highlights.map((h) => bulletedListItem(h));
    blocks.push(toggleBlock('▼ こだわりポイント', highlightChildren));
  }

  // ━━━ 補足 ━━━
  blocks.push(heading2('📝 補足'));
  const disclosureText = [
    `実務種別: ${y.project_type}`,
    y.disclosure_note || '一般公開可',
  ].join(' / ');
  blocks.push(paragraph(disclosureText));

  return blocks;
}

/**
 * Build page cover config (FR-22.1)
 * Returns null if no cover_image specified.
 * Note: Notion API requires URL for cover, so file path won't work.
 * For MVP, users can set cover manually in Notion UI.
 */
export function buildCover(metadata) {
  // Cover image requires external URL for Notion API
  // Local asset paths can't be used directly
  // Skip for MVP - user sets cover manually or uploads to hosting
  return null;
}

// =============================================================
// Block builders
// =============================================================

function textRun(content) {
  return {
    type: 'text',
    text: { content: String(content).slice(0, 2000) }, // Notion limit
  };
}

function paragraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [textRun(text)],
    },
  };
}

function heading2(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [textRun(text)],
    },
  };
}

function heading3(text) {
  return {
    object: 'block',
    type: 'heading_3',
    heading_3: {
      rich_text: [textRun(text)],
    },
  };
}

function bulletedListItem(text) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [textRun(text)],
    },
  };
}

function calloutBlock(text, emoji, color) {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [textRun(text)],
      icon: { type: 'emoji', emoji },
      color: color || 'default',
    },
  };
}

function bookmarkBlock(url) {
  return {
    object: 'block',
    type: 'bookmark',
    bookmark: { url },
  };
}

function toggleBlock(label, children) {
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [textRun(label)],
      children,
    },
  };
}

function techStackTable(techStack) {
  if (!Array.isArray(techStack) || techStack.length === 0) {
    return paragraph('（技術スタック未記載）');
  }
  // Notion table: header row + data rows
  const rows = [
    tableRow(['技術', '用途']),
    ...techStack.map((t) => tableRow([t, '実装'])),
  ];
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
      children: rows,
    },
  };
}

function tableRow(cells) {
  return {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: cells.map((c) => [textRun(c)]),
    },
  };
}

/**
 * Split blocks into chunks of 100 (Notion API limit)
 */
export function chunkBlocks(blocks, size = 100) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += size) {
    chunks.push(blocks.slice(i, i + size));
  }
  return chunks;
}
