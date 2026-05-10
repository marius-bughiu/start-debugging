---
title: "GitHub Copilot がすべての面で Claude Sonnet 4 を廃止"
description: "GitHub は 2026 年 5 月 6 日に Copilot Chat、インライン編集、ask モードと agent モード、コード補完で claude-sonnet-4 を非推奨にしました。推奨される移行先は Claude Sonnet 4.6 です。次に固定したモデル選択が静かに壊れる前に、リポジトリで何を grep すべきかを解説します。"
pubDate: 2026-05-10
tags:
  - "github-copilot"
  - "ai-agents"
  - "claude"
lang: "ja"
translationOf: "2026/05/copilot-deprecates-claude-sonnet-4-may-2026"
translatedBy: "claude"
translationDate: 2026-05-10
---

GitHub は [2026 年 5 月 6 日に Copilot のすべての面から Claude Sonnet 4 を削除しました](https://github.blog/changelog/2026-05-07-claude-sonnet-4-deprecated/)。Chat のモデルピッカーだけではありません。今回の非推奨化は Copilot Chat、インライン編集、ask モード、agent モード、コード補完を対象としています。推奨される移行先は Claude Sonnet 4.6 (`claude-sonnet-4-6`) です。

changelog 自体は短い 2 段落です。興味深いのは、書かれていない内容のほうです。

## 発表が実際にカバーする範囲

原文どおり: "We have deprecated the following model across all GitHub Copilot experiences (including Copilot Chat, inline edits, ask and agent modes, and code completions) on May 6, 2026."

これが名指しされた面の完全なリストです。Copilot CLI は列挙されていません。カスタム命令も列挙されていません。`claude-sonnet-4` に固定されたリクエストが後継モデルに自動でルーティングされるのか、それとも単に失敗するのかは明示されていません。"Please update your workflows and integrations to use supported models" が唯一の移行ガイダンスです。

選択可能だった場所で Sonnet 4 を動かしている場合は、削除されたものとして扱い、それに応じて計画してください。自動ルーティングが行われていると想定してはいけません。

## 典型的なリポジトリで Sonnet 4 が潜む場所

IDE のモデルピッカーは一つの場所を選びます。リポジトリの設定で固定されたモデルは別の場所を選び、こちらが静かに動かなくなる側です。次の変更をリリースする前に grep をかけておくべき 3 か所を挙げます。

```bash
# 1. VS Code workspace and user settings
grep -R "claude-sonnet-4" .vscode/ "$HOME/.config/Code/User/settings.json" 2>/dev/null

# 2. Copilot custom agent / skill manifests
grep -R "claude-sonnet-4" .github/copilot/ .github/agents/ 2>/dev/null

# 3. Workflow files that invoke Copilot CLI or the Copilot agent
grep -R "claude-sonnet-4" .github/workflows/
```

探すべき文字列はモデル ID そのままの `claude-sonnet-4` です。`claude-sonnet-4-5` でも `claude-sonnet-4-6` でもありません。これらはどちらも引き続きサポートされます。単語境界付きの置換が安全な手です。

```bash
# Replace only the bare id, leave 4-5 and 4-6 alone
git ls-files | xargs sed -i 's/\bclaude-sonnet-4\b/claude-sonnet-4-6/g'
```

Copilot エージェントのスキルやカスタム命令ファイルでは、変更は通常このようになります。

```yaml
# .github/copilot/agents/review.yml
- name: code-review
-   model: claude-sonnet-4
+   model: claude-sonnet-4-6
    instructions: |
      Review the diff against the project conventions.
```

## デフォルトとして正しいのは Opus 4.7 ではなく Sonnet 4.6 である理由

Sonnet 4.6 は同じファミリーで、レイテンシのプロファイルも近く、Sonnet 4 がチューニング対象としていたロングコンテキストとエージェントループのベンチマークで明らかに強くなっています。PR レビュー、インライン編集、安価な呼び出しを多数発火する agent モードのループでは、Sonnet 4.6 がそのままの差し替え候補です。[Claude Opus 4.7 はコストを正当化できる作業](/ja/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)、たとえばセキュリティ上重要な diff や難しいリファクタリングの場合にだけ使ってください。

チーム向けに Copilot のロールアウトを管理しているなら、発表のリンクを共有し、grep を実行し、固定モデルを同じ PR で更新しましょう。「ID を固定した人がいなかったから大半は動いている」状態で進む静かな非推奨化は、あるエンジニアのパイプラインだけが赤くなった火曜の朝に噛みついてくるタイプの問題です。
