---
title: "Copilot Code Review が pull request を承認できるようになりました"
description: "2026-09-01 の GitHub changelog により、Copilot はリポジトリの必須承認ルールを満たす承認レビューを送信できるようになりました。既定では無効で、ファイル glob で範囲を絞り、新しいコミットで取り消されます。ブランチ保護で実際に何が変わるのかを解説します。"
pubDate: 2026-09-06
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "ja"
translationOf: "2026/09/copilot-code-review-can-now-approve-pull-requests"
translatedBy: "claude"
translationDate: 2026-09-06
---

2026-09-01、GitHub は Copilot Code Review を「意見」から「権限」へ移す変更を出荷しました: [Copilot code review can now approve pull requests](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/)。Copilot Pro、Pro+、Max、Business、Enterprise 向けのパブリックプレビューです。

ここでは別々の 2 つのものが同時に着地しています。これを混同することが、チームが驚かされる原因になります。

## 判定は承認ではありません

Copilot のレビューは、概要コメントの末尾に承認判定を出すようになりました。その pull request が承認できる状態かどうかについての Copilot の判断です。この部分は全員に対して有効ですが、仕組みとしては何も変えません。コメント内の一文であり、マージ要件には触れません。

2 つ目が実際の承認レビューです。`copilot-pull-request-reviewer[bot]` が送信し、チームメイトの承認とまったく同じようにリポジトリの必須承認ルールにカウントされます。これは**既定で無効**で、企業、組織、またはリポジトリのレベルで管理者が有効にする必要があります。

ブランチ ruleset に "Require 1 approval" を設定したリポジトリでこれを有効にした場合、レビュアーを 1 人増やしたことにはなりません。人間のレビュアーを任意にしたということです。

## 有効化する前に glob で範囲を絞る

リポジトリレベルの設定は 1 行 1 つのファイル glob のリストを受け取り、「変更されたすべてのファイルがいずれかの glob に一致する pull request」でのみ Copilot の承認をカウントします。効いているのは*すべて*という語です。`docs/setup.md` と `src/Payments/Charge.cs` の両方に触れる pull request は、glob のリストがドキュメントのみであればカウント対象の承認を得られません。これが正しい初期方針です。誤った承認のコストが小さいパスから始めてください。

承認は新しいコミットがプッシュされたときにも取り消されます。古いレビューを取り消す設定のリポジトリでの人間の承認と同じです。つまり、force push のあとに古い承認が残り続けるという失敗モードにはなりません。

## 自動レビューは ruleset のルールであり、スクリプト化できます

承認のトグルは設定側にありますが、Copilot がそもそもレビューするかどうかはブランチ ruleset のルール (`copilot_code_review`) なので、クリックではなく API から作成できます:

```bash
gh api repos/OWNER/REPO/rulesets --method POST --input - <<'JSON'
{
  "name": "copilot-review-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    {
      "type": "copilot_code_review",
      "parameters": {
        "review_on_push": true,
        "review_draft_pull_requests": false
      }
    }
  ]
}
JSON
```

これに監査用のクエリを組み合わせてください。GitHub はこの用途のダッシュボードを用意していません。承認は通常のレビューなので、数えられます:

```bash
gh api "repos/OWNER/REPO/pulls/123/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | {state, submitted_at}'
```

マージ済みの pull request 全体に対してこれを実行すれば、本当に重要な数字が得られます。人間が見ないまま承認要件を満たしてマージされた件数です。`review_on_push` を有効にすると premium requests の消費も倍増し、[既定のレビュー労力が 2026-09-28 に Lite から Balanced へ切り替わる件](/ja/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/)と重なります。

まずは生成ファイルとドキュメントで有効にしてください。範囲を広げるのは監査の数字が出てからで、その前ではありません。
