---
name: portfolio-publish
description: GitHubのURLから自動でポートフォリオを公開するスキル。リポジトリのクローン → サニタイズ → Public GitHub作成 → Notion DB更新 → X告知文生成までを完全自動化。AI が portfolio.yaml の中身も自動生成。トリガー: 「ポートフォリオに追加して」「新作を公開したい」「portfolio publish」「GitHubのURL渡すから処理して」等。
---

# Portfolio Publish Skill

## 目的
新作アプリを **GitHub URL 1本** + **3つのメタ情報** だけで Notion ポートフォリオに自動公開する。

## 起動方法

ユーザーが以下のいずれかを言ったときに起動:
- 「ポートフォリオに追加して」
- 「新作を公開したい」
- 「[GitHub URL] をポートフォリオ化して」
- `/portfolio-publish` または `/portfolio-add` 系コマンド
- 「本アプリ/myapp/etc を portfolio に」

## 必須インプット（Claude が対話的にユーザーから収集）

ユーザーから以下の **4 つ** を聞き出す:

1. **GitHub URL** (必須) - 例: `https://github.com/<github-owner>/myapp`
2. **Key Metric** (必須) - 一番の自慢ポイント、数字込み推奨
   - 例: 「月20時間の事務作業を自動化」「処理速度3倍」「LCP 0.3s」
3. **対象ユーザー** (必須) - 誰のためのツールか
   - 例: 「個人事業主向け」「小学校の先生向け」「中小企業の経理担当」
4. **実務種別** (必須) - 以下のいずれか
   - `実務案件` / `自主開発` / `練習`

すべて揃ったら次のステップへ進む。

## 実行手順

### Step 1: yaml 自動生成

```bash
cd ~/Portfolio/tool
node scripts/generate-yaml.mjs <github-url> \
  --slug <YYYY-MM-name> \
  --key-metric "<キーメトリック>" \
  --target "<対象>" \
  --project-type <実務案件|自主開発|練習>
```

- スラグは現在の年月 + repo名から自動生成
- 出力: `~/Portfolio/projects/<slug>/portfolio.yaml.draft`
- AI（Claude Code）が README とコード解析結果から portfolio.yaml の中身を生成

### Step 2: ドラフトレビュー（必須・スキップ禁止）

生成された `portfolio.yaml.draft` の中身を Read ツールで読んでユーザーに表示し、以下を確認:

```
このドラフトでよろしいですか？
- title: <生成されたタイトル>
- tagline: <生成されたタグライン>
- tech_stack: <生成された技術一覧>
- overview: <生成された概要の冒頭>

承認 / 修正必要 / キャンセル ?
```

- **承認**: ドラフトを portfolio.yaml にリネーム
- **修正必要**: ユーザーから修正点を聞き、Edit ツールで該当箇所を修正
- **キャンセル**: ドラフトを保持して中断

### Step 3: スクリーンショット配置（任意）

ユーザーがスクショを持っていれば、`~/Portfolio/projects/<slug>/assets/` に配置するよう促す。

### Step 4: 公開実行

```bash
cd ~/Portfolio/tool
node publish.mjs <slug>
```

- 全10ステップを自動実行
- 結果を確認して、Public GitHub URL / Notion URL / X告知文 を表示

### Step 5: 完了報告

ユーザーに以下を報告:

```
🎉 公開完了!

📦 Public GitHub: <URL>
📘 Notion ページ: <URL>
🐦 X 告知文（コピペで投稿可能）:

<teaser テキスト>

3日後に detail.txt、1週間後に tech.txt も投稿してください。
保存先: ~/Portfolio/out/announcements/<slug>/
```

## エラーハンドリング

| エラー | 対処 |
|------|------|
| 必須情報不足 | 不足項目を再質問 |
| GitHub URL 形式不正 | 正しい URL を再要求 |
| `claude --print` 失敗 | Claude Code 環境を確認 |
| publish.mjs エラー | エラーコード別に runbook 参照 |
| 機密検出 (FR-39) | 該当箇所をユーザーに確認・修正 |

## ガードレール

- **絶対禁止**:
  - ユーザーレビュー無しでの公開（Q3=B モード厳守）
  - 機密情報を含む yaml の publish 実行
  - 原本リポジトリへの書き込み

- **必須**:
  - portfolio.yaml.draft を必ず一度ユーザーに見せる
  - 承認後にのみ portfolio.yaml にリネーム
  - publish 後に Public URL を表示

## 関連ファイル

- ツール本体: `~/Portfolio/tool/`
- 設定: `~/Portfolio/tool/config/secrets.local.json`
- ドラフト保存先: `~/Portfolio/projects/<slug>/portfolio.yaml.draft`
- 告知文出力先: `~/Portfolio/out/announcements/<slug>/`
- 仕様書: https://github.com/<github-owner>/portfolio-publish-tool

## 月次運用イメージ

```
1. ユーザー: "今月作った myapp をポートフォリオに追加して。
            GitHub: https://github.com/.../myapp、
            Key Metric: 月10時間削減、対象: 個人事業主、実務: 自主開発"

2. Claude: yaml 自動生成 (約30秒)

3. Claude: 生成された yaml を表示 → 「承認しますか?」

4. ユーザー: "OK"

5. Claude: publish 実行 (約2分)

6. Claude: 公開完了報告 + X 告知文表示

7. ユーザー: 告知文を X にコピペ投稿
```

合計: **約3分** で月次運用完了。
