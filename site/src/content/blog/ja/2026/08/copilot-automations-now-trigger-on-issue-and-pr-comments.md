---
title: "Copilot の自動化が issue と PR のコメントで起動できるようになりました"
description: "2026-08-03 の GitHub changelog が Copilot クラウドエージェントの自動化にコメントトリガーを追加し、6 月から各チームが手作りしてきた issue_comment ワークフローと PAT と REST 呼び出しの組み合わせを不要にします。"
pubDate: 2026-08-06
tags:
  - "github-copilot"
  - "ai-agents"
  - "automation"
  - "ci-cd"
lang: "ja"
translationOf: "2026/08/copilot-automations-now-trigger-on-issue-and-pr-comments"
translatedBy: "claude"
translationDate: 2026-08-06
---

2026-08-03 に GitHub が [Trigger Copilot automations with comments](https://github.blog/changelog/2026-08-03-trigger-copilot-automations-with-comments/) を公開しました。Copilot クラウドエージェントの自動化が、issue コメントまたは pull request コメントの作成時に、指定したコメント文字列との一致で起動できるようになりました。1 行の changelog エントリですが、驚くほど多くの YAML を消してくれます。

## これまでのトリガーはイベント向きで、会話向きではありませんでした

自動化は 2026-06-02 に 4 つのトリガーとともに登場しました。スケジュール実行 (1 時間ごと、毎日、毎週)、issue が作成されたとき、pull request が開かれたとき、そして pull request が同期されたときです。いずれも何かが特定の状態に入った瞬間に発火します。チームが実際に求めるパターン、つまり人がまずスレッドを読んでから「やって」と言う流れは、どれも満たしていませんでした。

そのため接着剤は自分で書くことになります。形はいつも同じでした。`issue_comment` のワークフロー、文字列によるガード、トークン、そして [Agent Tasks REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/) への `POST` です。

```yaml
name: copilot-on-comment
on:
  issue_comment:
    types: [created]

jobs:
  dispatch:
    if: startsWith(github.event.comment.body, '/copilot fix')
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch an agent task
        env:
          GH_USER_TOKEN: ${{ secrets.COPILOT_USER_TOKEN }}
        run: |
          curl -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            -H "Authorization: Bearer $GH_USER_TOKEN" \
            https://api.github.com/agents/repos/${{ github.repository }}/tasks \
            -d '{
              "prompt": "Investigate the stack trace in issue #${{ github.event.issue.number }} and open a fix PR.",
              "base_ref": "main",
              "create_pull_request": true
            }'
```

ここにある行はすべて保守対象です。組み込みの `GITHUB_TOKEN` ではエージェントタスクを起動できないため `secrets.COPILOT_USER_TOKEN` は user-to-server トークンである必要があり、しかも誰かの都合で期限切れになります。ガードは単なる前方一致なので `/copilot fixup` でも発火します。`X-GitHub-Api-Version: 2026-03-10` はレスポンス形式が変わりうるパブリックプレビューを固定しています。そしてトリガーの文字列がファイルにある以上、変更するには pull request が必要です。

## 代わりの設定はこうなります

リポジトリの **Agents** タブを開き、サイドバーで **Automations** を選び、**Create new** をクリックします。自動化は名前、プロンプト、1 つ以上のトリガー、任意のモデル、そしてツールの集合で構成されます。新しいトリガーではどのコメント文字列で開始するかを指定するだけで、統合はそれで終わりです。トークンもワークフローファイルも API バージョンヘッダーも要りません。

本当に考えるべきなのはツールの一覧です。これは実行時の権限境界であり、利便性の設定ではありません。コメントがエージェントを起こしたあと、何に触れてよいかを決めます。**Suggest tools** ボタンはプロンプトから候補を提案しますが、あくまで出発点として扱い、そのタスクに実際に必要なものまで絞り込んでください。

## 計画を立てる前に確認したい制約

自動化には **プライベートまたは内部** のリポジトリが必要です。パブリックリポジトリでは利用できないため、オープンソースプロジェクトが飛び込みの issue を仕分けする用途には使えません。作成には書き込み権限が必要で、プランは Copilot Pro、Pro+、Max、Business、Enterprise のいずれかである必要があり、Business と Enterprise では管理者が先にクラウドエージェントのポリシーを有効化する必要があります。**Run now** を使えば、実際のコメントが発火する前に自動化をテストできます。

ひとつ、じっくり考える価値のある帰結があります。これまでエージェントの起動には、メンテナーが意図して発行したトークンが必要でした。今はリポジトリの issue にコメントできる人なら誰でもエージェントの実行時間を消費できます。プライベートや内部という可視性が影響範囲を限定してくれますが、トリガーの文字列は具体的に、ツールの一覧は狭く保ってください。
