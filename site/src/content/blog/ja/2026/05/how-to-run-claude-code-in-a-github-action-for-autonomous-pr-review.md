---
title: "GitHub Action で Claude Code を実行して自律的に PR レビューする方法"
description: "anthropics/claude-code-action@v1 を設定し、@claude トリガーなしで各 pull request に自律的な Claude Code レビューを実行させます。v1 の YAML、claude-sonnet-4-6 と claude-opus-4-7 用の claude_args、インラインコメントツール、パスフィルター、REVIEW.md、セルフホスト型 action とマネージド Code Review リサーチプレビューの選択を含みます。"
pubDate: 2026-05-01
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "ja"
translationOf: "2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review"
translatedBy: "claude"
translationDate: 2026-05-01
---

pull request が開かれると、GitHub Actions が起動し、Claude Code がリポジトリ全体のコンテキストの中で diff を読み、気に入らない行にインラインコメントを投稿し、サマリーを書きます。誰も `@claude` と入力していません。これがこの記事で `anthropics/claude-code-action@v1` (2025年8月26日にリリースされた GA 版)、レビューパスのための `claude-sonnet-4-6`、セキュリティ上重要なパスのためのオプションの `claude-opus-4-7` へのアップグレードを使ってエンドツーエンドで構築するワークフローです。2026年5月時点でこれを行うには2つの方法があり、互換性はありませんので、この記事ではまず選択について述べ、その後、どのプランでも動作するセルフホスト型 Action のパスを順を追って説明します。

短い答え: `anthropics/claude-code-action@v1` を `pull_request: [opened, synchronize]` でトリガーし、prompt と `--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"` を指定して使用します。`@claude` メンションによるゲーティングはスキップしてください。組織が Team または Enterprise プランで Zero Data Retention を実行していない場合、[マネージドの Code Review リサーチプレビュー](https://code.claude.com/docs/en/code-review) は同じ仕事に対するより摩擦の少ない選択肢です。

## 2つのプリミティブ、2つのコストモデル、1つの決定

Anthropic は2026年に2つの別々の「Claude が PR をレビューする」製品を出しています。外見は似ていますが、振る舞いは大きく異なります。

| 機能                              | claude-code-action@v1                   | Managed Code Review (preview)              |
| :------------------------------- | :-------------------------------------- | :----------------------------------------- |
| 実行場所                          | あなたの GitHub Actions runner          | Anthropic のインフラ                       |
| 設定するもの                      | `.github/workflows/` のワークフロー YAML | `claude.ai/admin-settings` のトグル         |
| トリガー範囲                      | 記述可能な任意の GitHub イベント        | リポジトリごとのドロップダウン: opened、各 push、manual |
| モデル                            | `--model claude-sonnet-4-6` または任意の ID | マルチエージェントフリート、ユーザーがモデルを選択不可 |
| diff 行へのインラインコメント     | `mcp__github_inline_comment` MCP サーバー経由 | ネイティブ、重要度マーカー付き             |
| コスト                            | API トークンと Actions の分数            | レビュー1件あたり $15-25、追加使用量として課金 |
| プラン要件                        | API キーがあれば任意のプラン            | Team または Enterprise、非 ZDR のみ        |
| Bedrock / Vertex で利用可能       | はい (`use_bedrock: true`、`use_vertex: true`) | いいえ                                   |
| カスタム prompt                   | `prompt` 入力にフリーテキスト            | `CLAUDE.md` プラス `REVIEW.md`             |

マネージド製品は、利用できる場合には正しい答えです。専門化されたエージェントのフリートを並列で実行し、所見を投稿する前に検証ステップを実行するため、誤検知が低く保たれます。トレードオフは、モデルを固定できないことと、価格が PR サイズに比例して上がるため、2000行のリファクタリングに対する1件 $25 のレビューが、トークン単価の課金を期待していたマネージャーを驚かせる可能性があることです。

Action は、prompt を完全に制御したい場合、データレジデンシーのために Bedrock や Vertex を使いたい場合、パスフィルターやブランチ名でゲートしたい場合、または Team や Enterprise プランでない場合の正しい答えです。以下はすべて Action のパスです。

## 最小限の自律レビューワークフロー

admin であるリポジトリで開始します。[Claude Code 2.x](https://code.claude.com/docs/en/setup) がインストールされたターミナルから:

```text
# Claude Code 2.x
claude
/install-github-app
```

スラッシュコマンドが [Claude GitHub App](https://github.com/apps/claude) のインストールとリポジトリの secret としての `ANTHROPIC_API_KEY` の保存を案内します。これは Anthropic API の直接ユーザーに対してのみ機能します。Bedrock や Vertex の場合は OIDC を手動で配線する必要があり、それは [GitHub Actions のドキュメント](https://code.claude.com/docs/en/github-actions) の "Using with AWS Bedrock & Google Vertex AI" でカバーされています。

これを `.github/workflows/claude-review.yml` に置きます:

```yaml
# claude-code-action v1 (GA Aug 26, 2025), Claude Code 2.x
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review the diff for correctness, security, and obvious bugs.
            Focus on logic errors, unhandled error paths, missing input
            validation, and tests that do not actually exercise the new
            behavior. Skip style nits. Post inline comments on the lines
            you have something concrete to say about, then a one-paragraph
            summary as a top-level PR comment.

          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 8
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

これだけです。`@claude` トリガーゲーティングなし、コメント本文への `if:` 条件分岐なし、`mode: agent` なし。Action の [v1 リリース](https://code.claude.com/docs/en/github-actions) は、コメント以外のイベントで `prompt` 入力を提供すると自動化モードを自動検出するため、条件分岐を自分で書く必要はもうありません。`permissions` ブロックは prompt が必要とするものを正確に付与します: リポジトリの読み取り、PR コメントの書き込み、(クラウドプロバイダーへの OIDC のために) ID トークンの発行。

この YAML には、間違えやすく重要な点がいくつかあります。

`actions/checkout@v6` の `fetch-depth: 1`。Action は `gh` 経由で PR の diff を読みますが、prompt によって作業ディレクトリのファイルを開いて所見を投稿する前に検証することもできます。checkout がないと、「周辺のコードを見る」ターンはすべて失敗し、Claude は推測するかタイムアウトします。

`--allowedTools "mcp__github_inline_comment__create_inline_comment,..."`。Action は GitHub のレビュー API をラップする MCP サーバーを同梱しています。この allowlist がないと、Claude は特定の行にコメントを付ける手段がありません。1つの大きなトップレベル PR コメントにフォールバックしますが、これでは価値が半減します。`Bash(gh pr ...)` のエントリは、diff の読み取りとサマリーコメントの投稿に限定されています。

`--max-turns 8`。会話予算。8 回はモデルが diff を読み、コンテキストのために 3、4 個のファイルを開き、コメントを投稿するのに十分です。これより上げることが見た目どおりの勝利になることはまれです。レビューがタイムアウトするなら、ターンを増やすのではなく、パスフィルターを絞るかモデルを切り替えてください。

## v1 は多くの beta ワークフローを壊しました

`claude-code-action@beta` から来た場合、古い YAML は実行されません。v1 の [破壊的変更の表](https://code.claude.com/docs/en/github-actions#breaking-changes-reference) は移行のチートシートです:

| Beta 入力             | v1 の同等項目                          |
| :-------------------- | :------------------------------------- |
| `mode: tag` / `agent` | 削除、イベントから自動検出             |
| `direct_prompt`       | `prompt`                               |
| `override_prompt`     | GitHub 変数を使った `prompt`           |
| `custom_instructions` | `claude_args: --append-system-prompt`  |
| `max_turns: "10"`     | `claude_args: --max-turns 10`          |
| `model: ...`          | `claude_args: --model ...`             |
| `allowed_tools: ...`  | `claude_args: --allowedTools ...`      |
| `claude_env: ...`     | `settings` JSON 形式                   |

パターンは明確です: CLI 形式の設定はすべて `claude_args` に集約され、「これはコメントトリガーのフローか自動化のフローか」を区別していたものは、v1 がイベントから判別するため削除されました。移行は機械的ですが、順序が重要です。`mode: tag` を残しておくと、v1 は誤ったパスを黙って実行する代わりに設定エラーで失敗します。

## モデルの選択: Sonnet 4.6 が default なのには理由があります

Action は `--model` が設定されていない場合に `claude-sonnet-4-6` をデフォルトとし、それは PR レビューにとって正しいデフォルトです。Sonnet 4.6 は速く、トークンあたり安く、PR レビューの実体である「diff をスキャンして明らかなバグを見つける」ループに対してよく調整されています。Opus 4.7 は、diff が認証、暗号化、決済フロー、または見逃したバグが $5 のレビューより高くつくものに触れるときに手を伸ばすアップグレードです。

最もきれいなパターンは2つのワークフローです。Sonnet 4.6 をすべての PR で、Opus 4.7 はパスフィルターが支出に値すると言うときだけ:

```yaml
# Opus 4.7 review for security-critical paths only
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/auth/**"
      - "src/billing/**"
      - "src/api/middleware/**"

jobs:
  review-opus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Treat this diff as security-sensitive. Flag any changes to
            authentication, session handling, secret storage, or trust
            boundaries. Cite a file:line for every claim about behavior,
            do not infer from naming.
          claude_args: |
            --model claude-opus-4-7
            --max-turns 12
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr comment:*)"
```

同じ手法は逆方向にも機能します: Sonnet ワークフローを `paths-ignore: ["docs/**", "*.md", "src/gen/**"]` でゲートし、ドキュメントのみの PR がトークンを消費しないようにします。

## インラインコメントと進捗追跡の追加

MCP サーバー `mcp__github_inline_comment__create_inline_comment` は、Claude を「長い PR コメントを書く」から「特定の diff 行に提案を残す」へと進化させる部分です。`--allowedTools` で許可されており、必要な配線はそれだけです。モデルがいつそれを呼び出すかを決定します。

実行が生きているという可視シグナルが必要な、より大きなレビューのために、Action は `track_progress` 入力を提供しています。`track_progress: true` を設定すると、Action はチェックボックス付きの追跡コメントを投稿し、Claude がレビューの各部分を完了するたびにそれをチェックし、最後に完了とマークします。[公式の `pr-review-comprehensive.yml` の例](https://github.com/anthropics/claude-code-action/tree/main/examples) からの完全なパターンは:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    track_progress: true
    prompt: |
      REPO: ${{ github.repository }}
      PR NUMBER: ${{ github.event.pull_request.number }}

      Comprehensive review covering: code quality, security, performance,
      test coverage, documentation. Inline comments for specific issues,
      one top-level summary at the end.
    claude_args: |
      --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

`track_progress` は v1 で古い beta の `mode: agent` の UX に最も近いものであり、レビューが日常的に1、2分以上かかり、PR の作者が動いていることを知りたい場合に正しい選択です。

## レビュアーが指摘する内容のキャリブレーション

すべての変数名やすべての欠落したカンマにコメントを残すワークフローは、1週間でミュートされます。リポジトリのルートにある2つのファイルが、モデルが真剣に受け取るものを支配します: 一般的な振る舞いのための `CLAUDE.md` と、(マネージド Code Review プレビューでのみ) レビュー固有のルールのための `REVIEW.md`。Action は `REVIEW.md` を自動的にロードしませんが、ローカルの Claude Code セッションと同じ方法で `CLAUDE.md` を読み、引き締まった `CLAUDE.md` と引き締まった `prompt` で同じ範囲をカバーできます。

レビュー品質を実際に変えるルールは、具体的でリポジトリ固有で短いものです:

```markdown
# CLAUDE.md (excerpt)

## What "important" means here
Reserve "important" for findings that would break behavior in
production, leak data, or block a rollback: incorrect logic,
unscoped database queries, PII in logs, migrations that are not
backward compatible. Style and naming are nits at most.

## Cap the nits
Report at most five nits per review. If you found more, say
"plus N similar items" in the summary.

## Do not report
- Anything CI already enforces (lint, format, type errors)
- Generated files under `src/gen/` and any `*.lock`
- Test-only code that intentionally violates production rules

## Always check
- New API routes have an integration test
- Log lines do not include user IDs or request bodies
- Database queries are scoped to the caller's tenant
```

このような内容を `prompt` 入力に貼り付けることもでき、ルールがワークフローファイルと一緒にバージョン管理されるという利点があります。いずれにしても、重要なてこは「些細な指摘の量に対して声に出してノーと言うこと」です。なぜなら、Sonnet のデフォルトのレビューの声色はほとんどのチームが望むよりも徹底的だからです。

## fork、secret、`pull_request_target` の罠

デフォルトの `on: pull_request` イベントは PR の head ブランチのコンテキストで実行されます。fork からの PR の場合、これはワークフローが `ANTHROPIC_API_KEY` を含むリポジトリの secret にアクセスせずに実行されることを意味します。明白に見える修正は、base ブランチのコンテキストで実行され、secret を持つ `pull_request_target` への切り替えです。自律的な Claude レビューでこれを行わないでください。`pull_request_target` はデフォルトで base ブランチのコードを checkout するため、間違ったツリーをレビューしていることになりますし、checkout を head ref を取得するように変更すると、攻撃者が制御するコードに対して、secret がスコープにあるモデル駆動のツールを実行することになります。

サポートされるパターンは: `on: pull_request` のままにして fork PR がレビューされないことを受け入れる (それらをカバーする必要がある場合はマネージド Code Review プレビューを使用する)、または、メンテナーが diff を確認した後に fork PR で手動でトリガーするワークフローを実行する、です。完全な [セキュリティガイダンス](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) は、プライベートリポジトリ以外のどこかにこれを出荷する前に一度読む価値があります。

## Bedrock や Vertex に手を伸ばすべきとき

組織が AWS Bedrock または Google Vertex AI を経由する場合、Action は `use_bedrock: true` または `use_vertex: true` と Action 実行前の OIDC 認証ステップで両方をサポートします。モデル ID の形式が変わり (Bedrock はリージョンプレフィックス形式を使用します、例えば `us.anthropic.claude-sonnet-4-6`)、クラウドプロバイダーのドキュメントが IAM と Workload Identity Federation のセットアップを順を追って説明します。上記のトリガーと prompt のパターンは変わりません。同じアプローチが Microsoft Foundry にも文書化されています。これらのパスをサポートしない唯一の Anthropic マネージド製品は Code Review リサーチプレビューであり、これがマネージドプレビューが GA になった後でもセルフホスト Action が有用であり続ける理由の1つです。

## 関連

- [GitHub issue をトリアージする再帰的な Claude Code タスクをスケジュールする方法](/ja/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [CLI をラップするカスタム MCP サーバーを TypeScript で作成する方法](/ja/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [Anthropic SDK アプリにプロンプトキャッシングを追加してヒット率を測定する方法](/ja/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [Claude Code 2.1.119: GitLab と Bitbucket からの pull request のレビュー](/ja/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/)
- [GitHub Copilot のコーディングエージェントの dotnet/runtime: 10ヶ月のデータ](/ja/2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data/)

## 出典

- [Claude Code GitHub Actions ドキュメント](https://code.claude.com/docs/en/github-actions)
- [Claude Code Code Review (リサーチプレビュー) ドキュメント](https://code.claude.com/docs/en/code-review)
- [GitHub の `anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
- [`pr-review-comprehensive.yml` の例](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml)
- [`pr-review-filtered-paths.yml` の例](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-filtered-paths.yml)
