---
title: "GitHub issues をトリアージする Claude Code の定期タスクをスケジュールする方法"
description: "2026 年に Claude Code を無人で GitHub issues のトリアージにかける 3 つの方法: クラウドの Routines(新しい /schedule)、cron + issues.opened を使う claude-code-action v1、そしてセッション限定の /loop。実行可能な Routine プロンプト、完全な GitHub Actions の YAML、jitter と identity の落とし穴、そしてどれを選ぶべきかを含めて扱います。"
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "ja"
translationOf: "2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues"
translatedBy: "claude"
translationDate: 2026-04-29
---

GitHub バックログに対するスケジュールされたトリアージ実行は、コーディングエージェントに頼める最も有用な仕事の一つでありながら、最も簡単に間違えてしまう仕事でもあります。2026 年 4 月時点で「Claude Code のタスクをスケジュールする」プリミティブは 3 種類あり、別々のランタイムで動き、まったく異なる失敗モードを持ちます。本記事は同じ仕事 -- 「平日の朝 8 時に、リポジトリに来た新規 issue 全部にラベルを付けてルーティングする」 -- について 3 つの方法を、**Claude Code v2.1.x**、GitHub Action **`anthropics/claude-code-action@v1`**、そして Anthropic が[2026 年 4 月 14 日](https://claude.com/blog/introducing-routines-in-claude-code)に出した **routines のリサーチプレビュー**を使って歩きます。モデルはトリアージ用 prompt が `claude-sonnet-4-6`、重複検出パスが `claude-opus-4-7` です。

短い答え: アカウントで Claude Code on the web が有効なら、**スケジュールトリガーと `issues.opened` GitHub トリガーの両方を持つクラウド Routine** を使ってください。Bedrock、Vertex、または自前のランナーで必要なら、**GitHub Actions の schedule + workflow_dispatch + issues.opened** ワークフローにフォールバックしてください。**`/loop`** はセッションが開いている間のアドホックなポーリングのみに使い、無人のトリアージには絶対に使わないでください。

## 3 つの選択肢が存在する理由と、どれを選ぶか

Anthropic が意図的に 3 つの異なるスケジューラを出荷しているのは、そのトレードオフが本物だからです。公式の[scheduling ドキュメント](https://code.claude.com/docs/en/scheduled-tasks)が 1 ページにまとめています。

| 機能                         | Routines (cloud)         | GitHub Actions          | `/loop` (session)         |
| :--------------------------- | :----------------------- | :---------------------- | :------------------------ |
| 実行場所                     | Anthropic のインフラ     | GitHub ホストランナー   | あなたの端末              |
| ノート PC を閉じても動く     | はい                     | はい                    | いいえ                    |
| `issue.opened` でトリガー    | はい(ネイティブ)       | はい(ワークフローイベント) | いいえ                  |
| ローカルファイルアクセス     | いいえ(新しいクローン) | はい(checkout)         | はい(現在の cwd)         |
| 最小間隔                     | 1 時間                   | 5 分(cron の癖)        | 1 分                      |
| 自動失効                     | しない                   | しない                  | 7 日                      |
| 権限プロンプト               | なし(自律)             | なし(`claude_args`)    | セッションから継承        |
| プラン要件                   | Pro / Max / Team / Ent.  | API key を持つ任意プラン | ローカル CLI             |

「新しい issue ごとにトリアージし、毎日掃除を走らせる」なら、クラウド routine が正しいプリミティブです。GitHub のネイティブトリガーがあるので `actions/checkout` を配線する必要がなく、prompt は PR なしに Web UI から編集でき、実行は GitHub Actions の分を消費しません。スキップする唯一の理由は、組織が Claude を AWS Bedrock や Google Vertex AI 経由で動かしている場合で、その場合はクラウド routines はまだ利用できないので action にフォールバックします。

## トリアージ routine をエンドツーエンドで

routine は「保存された Claude Code 構成: prompt、1 つ以上のリポジトリ、connector の集合を一度パッケージ化し、自動で実行されるもの」です。各実行は権限プロンプトのない自律的な Claude Code のクラウドセッションで、デフォルトブランチからリポジトリをクローンし、コード変更があれば既定では `claude/` プレフィックス付きブランチに書き込みます。

任意の Claude Code セッション内から作成します。

```text
# Claude Code 2.1.x
/schedule weekdays at 8am triage new GitHub issues in marius-bughiu/start-debugging
```

`/schedule` は [claude.ai/code/routines の Web UI](https://claude.ai/code/routines) と同じフォームを順に進めます: 名前、prompt、リポジトリ、環境、connector、トリガー。CLI で設定したものは Web で編集でき、同じ routine がデスクトップ、Web、CLI に即座に現れます。重要な制約が一つ: `/schedule` は**スケジュール**トリガーしか付けません。トリアージをほぼ即時にする `issues.opened` GitHub トリガーを足すには、作成後に Web で routine を編集します。

### prompt

routine は人間がループにいない状態で動くので、prompt は自己完結している必要があります。Anthropic 自身が[routines のドキュメント](https://code.claude.com/docs/en/web-scheduled-tasks)で示す例のフレーズは「ラベルを付け、参照されたコード領域に基づいてオーナーをアサインし、Slack に要約を投稿してチームが整ったキューで一日を始められるようにする」です。具体的には:

```markdown
# Routine prompt: daily-issue-triage
# Model: claude-sonnet-4-6
# Repos: marius-bughiu/start-debugging

You are the issue triage bot for this repository. Every run, do the following.

1. List every issue opened or updated since the last successful run of this
   routine, using `gh issue list --search "updated:>=YYYY-MM-DD"` with the
   timestamp of the previous run from the routine's session history. If you
   cannot find a previous run, scope to the last 24 hours.

2. For each issue, classify it as exactly one of: bug, feature, docs,
   question, support, spam. Apply that label with `gh issue edit`.

3. Assess priority as one of: p0, p1, p2, p3. Apply that label too.
   p0 only when the issue describes a production-affecting regression
   with a reproducer.

4. Look up the touched code area. Use `gh search code --repo` and `rg`
   against the cloned working copy to find the most likely owner via
   the `CODEOWNERS` file. Assign that user. If there is no CODEOWNERS
   match, leave it unassigned and apply the `needs-triage` label.

5. Run a duplicate check. Use `gh issue list --search "<title keywords>
   in:title is:open"` to find similar open issues. If you find one with
   high confidence, post a comment on the new issue: "This looks like
   a duplicate of #N. Closing in favor of that thread; please reopen
   if I got it wrong." and then `gh issue close`.

6. Post a single Slack message to #engineering-triage via the connector
   summarizing what you did: counts per label, p0 issues by number, and
   any issue that you could not classify with confidence above 0.7.

Do not push any commits. Do not modify code. The only writes this routine
performs are GitHub label/assign/comment/close calls and one Slack message.
```

押さえておく価値のある自明でない 2 つの詳細:

- **「前回実行のタイムスタンプ」のトリック。** routines は実行間で状態を持ちません。各セッションは新しいクローンです。同じ issue を二重ラベル付けしないために、prompt はカットオフを永続的な何かから導出する必要があります。(a) routine の GitHub identity を使って `triaged-YYYY-MM-DD` ラベルを付け、そのラベルが付いたものをスキップする、または (b) connector 経由で前回の Slack 要約メッセージからタイムスタンプを読む、のどちらかです。両方とも信頼できます。「前回いつ走ったか覚えていてください」とモデルに頼むのは信頼できません。
- **自律モードのルール。** routines は権限プロンプトなしで動きます。セッションは shell コマンドを実行でき、含まれている任意の connector の任意のツールを使え、`gh` を呼べます。prompt はサービスアカウントのポリシーと同じように扱い、許可される書き込みを正確に綴ってください。

### トリガー

routine の編集フォームで 2 つのトリガーを付けます。

1. **スケジュール、平日 08:00。** 時刻はあなたのローカルゾーンで、サーバー側で UTC に変換されるので、US-Pacific のスケジュールも CET のスケジュールもクラウドセッションがどこに着地しても同じ壁時計時刻に発火します。routines はアカウントごとに最大数分の決定論的 stagger を加えるので、正確なタイミングが重要なら `0 8` ではなく `:03` や `:07` に設定してください。
2. **GitHub イベント、`issues.opened`。** これにより routine は新しい issue ごとに数秒以内に発火し、8 時の sweep に加わります。2 つは冗長ではありません。GitHub App が一時停止していたりアカウントごとの時間あたり上限に追いついている間に着地したものはスケジュールトリガーが拾い、フレッシュな issue が平日 1 日冷たいまま放置されないようにイベントトリガーが防ぎます。

`issues.opened` トリガーを付けるには、[Claude GitHub App](https://github.com/apps/claude) がリポジトリにインストールされている必要があります。CLI の `/web-setup` はクローンアクセスのみを付与し webhook 配信は有効化しないので、Web UI からのインストールが必須です。

### カスタム cron 表現

スケジュールのプリセットは hourly、daily、weekdays、weekly です。それ以外はフォームで最も近いプリセットを選び、CLI に降ります。

```text
/schedule update
```

スケジュールセクションまでプロンプトを進め、5 フィールドのカスタム cron 表現を与えます。唯一の固いルールは、**最小間隔は 1 時間**であることです。`*/15 * * * *` のような表現は保存時に拒否されます。本当により短いケイデンスが必要なら、それはスケジュールトリガーではなく GitHub Actions パスやイベントトリガーを欲しがっているサインです。

## GitHub Actions のフォールバック

チームが Bedrock や Vertex にいる、あるいは単純に Actions の実行ログの監査トレールを好むなら、同じジョブが `claude-code-action@v1` を使うワークフローとして動きます。action は 2025 年 8 月 26 日に GA になり、v1 の表面は 2 つの入力 -- `prompt` と Claude Code CLI に任意のフラグをそのまま渡す `claude_args` 文字列 -- に統一されています。beta 表面からのアップグレード表全文は[GitHub Actions のドキュメント](https://code.claude.com/docs/en/github-actions#breaking-changes-reference)にあります。

```yaml
# .github/workflows/issue-triage.yml
# claude-code-action v1, claude-sonnet-4-6, schedule + issues.opened + manual
name: Issue triage

on:
  schedule:
    - cron: "3 8 * * 1-5"  # weekdays 08:03 UTC, off the :00 boundary
  issues:
    types: [opened]
  workflow_dispatch:        # manual run from the Actions tab

permissions:
  contents: read
  issues: write
  pull-requests: read
  id-token: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            EVENT: ${{ github.event_name }}
            ISSUE: ${{ github.event.issue.number }}

            On a schedule run, list open issues updated in the last 24 hours
            and triage each one. On an `issues.opened` event, triage only
            the single issue ${{ github.event.issue.number }}.

            For each issue:
            1. Classify as bug / feature / docs / question / support / spam.
            2. Assess priority p0 / p1 / p2 / p3.
            3. Apply both labels with `gh issue edit`.
            4. Resolve the touched area via CODEOWNERS and assign the owner,
               or apply `needs-triage` if no match.
            5. Search for duplicates by title keywords. Comment and close
               only if confidence is high.

            Do not edit code. Do not push. Only GitHub label / assign /
            comment / close calls are allowed.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 12
            --allowedTools "Bash(gh:*),Read,Grep"
```

このワークフローが正しく押さえていて、自家製 cron が押さえないことが 3 つあります。**`workflow_dispatch`** を `schedule` と並べることで Actions タブに「Run workflow」ボタンを置き、8 時を待たずにテストできます。**`--allowedTools "Bash(gh:*),Read,Grep"`** はローカル CLI と同じ gating を使います。これがないと action は `Edit` と `Write` のアクセスも持ってしまいます。**分の `:03`** は GitHub Actions がピーク時に free-tier の cron トリガーに加える、広い非決定論的遅延を回避します。これは action の solutions ガイドにある [issue triage の例](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md) に、スケジュールトリガーと、より厳しいツール allowlist を加えたものに本質的に等しいです。

## `/loop` が正しいプリミティブのとき

`/loop` は 3 つ目の選択肢で、トリアージ業務には**最も使うべきでない**ものです。[scheduled-tasks のドキュメント](https://code.claude.com/docs/en/scheduled-tasks)が制約を明記しています。

- タスクは Claude Code が動作中かつアイドルの間しか発火しません。ターミナルを閉じると停止します。
- 繰り返しタスクは作成から 7 日後に失効します。
- セッションは同時に最大 50 個のスケジュール済みタスクを保持できます。
- cron は 1 分粒度で尊重され、最大 10% の jitter が 15 分でキャップされます。

`/loop` の正しい用途は、まだ調整中のトリアージ routine の世話をすることであって、トリアージ自体を走らせることではありません。リポジトリを向いた開いたセッション内で:

```text
/loop 30m check the last 5 runs of the daily-issue-triage routine on
claude.ai/code/routines and tell me which ones produced label edits
that look wrong. Skip silently if nothing has changed.
```

Claude は `30m` を cron 表現に変換し、生成された 8 文字 ID で prompt をスケジュールし、あなたが `Esc` を押すか 7 日経過するまで、あなたのターン間に再発火します。これは人間がキーボードに残っている間の「routine がドリフトしていないか?」のフィードバックループには本当に有用です。「無人で永久に走らせる」には不適切な形です。

## 初回実行前に知っておきたい落とし穴

計画しなければ初回スケジュール実行で噛みついてくるものがいくつかあります。

**Identity。** routines はあなた個人の claude.ai アカウントに属し、接続された GitHub identity を通じて routine が行うことはすべてあなたとして表示されます。OSS リポジトリでは専用 bot アカウントの下に routine をインストールするか、別の bot install による [Claude GitHub App](https://github.com/anthropics/claude-code-action) を使う GitHub Actions パスを使ってください。

**1 日の実行上限。** routines にはプランごとの 1 日上限があります(Pro 5、Max 15、Team と Enterprise 25)。各 `issues.opened` イベントは 1 回の実行なので、1 日に 30 件 issue が来るリポジトリは billing で追加使用を有効化しない限り昼までに上限に達します。スケジュールのみの routine と GitHub Actions パスはどちらもこれを回避します。後者は API トークンに対して請求されます。

**ブランチ push の安全性。** routine は既定では `claude/` プレフィックス付きブランチにしか push できません。上のトリアージ prompt は何も push しませんが、修正 PR を開くまで拡張するなら、プレフィックスを受け入れるか、リポジトリ単位で **Allow unrestricted branch pushes** を有効化するかのどちらかです。そのスイッチを上の空でひっくり返さないでください。

**`experimental-cc-routine-2026-04-01` ベータヘッダー。** API トリガーを支える `/fire` エンドポイントは今日このヘッダーで出荷されています。Anthropic は破壊的変更時に直近 2 つの日付付きバージョンを動かし続けるので、ヘッダーを定数に組み込み、各 webhook ではなくバージョン切り替え時に回してください。

**Stagger と catch-up なし。** 両ランタイムは決定論的オフセットを加えます(routines は周期の最大 10%、ピーク時の free-tier Actions ははるかに広い)が、どちらも逃した発火を再生しません。`schedule + issues.opened` の組み合わせはスケジュール単独より catch-up ギャップをうまく扱います。イベントトリガーがデッドゾーンをカバーするからです。

## 関連リーディング

- `--from-pr` を GitLab と Bitbucket に開いた完全な Claude Code リリースはクラウド routines とよく合います: [Claude Code 2.1.119: GitLab、Bitbucket、GHE からの PR](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) を参照してください。
- routine がトリアージ中に `.NET` 業務システムから読みたいなら、まず MCP で公開してください。手順は [.NET 11 で C# のカスタム MCP サーバーを作る方法](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) にあります。
- GitHub Copilot 形の同等品は agent skills 版が [Visual Studio 2026 Copilot エージェントスキル](/ja/2026/04/visual-studio-2026-copilot-agent-skills/) にあります。
- Anthropic 側ではなく Microsoft 側でエージェントランナーを構築する C# 開発者には、[Microsoft Agent Framework 1.0](/ja/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) が本番対応の入口です。
- 別のモデルに対するトークンで支払うなら、bring-your-own-key の経済については [VS Code の GitHub Copilot で BYOK Anthropic、Ollama、Foundry Local](/ja/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/) を参照してください。

routines はまだリサーチプレビューなので、正確な UI と `/fire` ベータヘッダーは動きます。ですが、これらすべてが狙うモデルは安定しています: 自己完結した prompt、スコープ付きツールアクセス、決定論的なトリガー、実行ごとの監査トレール。それが慎重に設計すべき部分です。ランタイムは入れ替えられる部分です。
