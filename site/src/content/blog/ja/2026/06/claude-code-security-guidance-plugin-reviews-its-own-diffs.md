---
title: "Claude Code の security-guidance プラグインは commit 前に自分の差分をレビューします"
description: "Anthropic は Claude Code 向けの無料プラグイン security-guidance をリリースしました。エージェント自身の編集を 3 つの層で脆弱性スキャンし、コストなしのパターンマッチから commit 時のエージェント的レビューまでをカバーします。"
pubDate: 2026-06-08
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
lang: "ja"
translationOf: "2026/06/claude-code-security-guidance-plugin-reviews-its-own-diffs"
translatedBy: "claude"
translationDate: 2026-06-08
---

Anthropic は 2026 年 5 月下旬、Claude Code 向けの無料の [security-guidance プラグイン](https://code.claude.com/docs/en/security-guidance) をリリースしました。これは、ほとんどの AI コーディング環境が省略していることを行います。つまり、エージェントが作業しながら自分の差分を脆弱性についてレビューし、見つけたものを同じセッション内で修正させるのです。考え方はシンプルです。最も安価に修正できるセキュリティバグは pull request に到達しないものであり、元のアプローチに執着しない別個のレビュアーは、コードを書いたモデルよりも多くを検出します。

## 3 つの層、そのうちトークンを消費するのは 1 つだけ

このプラグインは 3 つのポイントで実行され、それぞれ深さが異なります。

最初の層は `Edit`、`Write`、`NotebookEdit` のたびに起動します。これはモデル呼び出しのない決定論的なパターンマッチングなので、利用コストは一切増えません。リスクのある構文が現れた瞬間にフラグを立てます。

- 動的な実行: `eval(`、`new Function`、`os.system`、`child_process.exec`
- 安全でないデシリアライズ: `pickle`
- DOM インジェクション: `dangerouslySetInnerHTML`、`.innerHTML =`、`document.write`
- `.github/workflows/` 配下の編集。リポジトリレベルの権限を密かに付与する可能性があります

各警告はパターンごと、ファイルごと、セッションごとに 1 回だけ発火するため、会話を埋め尽くすことはありません。

2 つ目の層は各ターンの終わりに実行されます。プラグインは、Bash やサブエージェントによる編集を含め、作業ツリーで変更されたすべての差分を取り、セキュリティに特化した別個の Claude レビューに渡します。ここは文字列マッチでは届かない領域です。認可バイパス、安全でない直接オブジェクト参照、SSRF、弱い暗号です。バックグラウンドで実行され、最大 30 個の変更ファイルをカバーし、連続して最大 3 回まで発火します。

3 つ目の層は、Claude が Bash ツールを通じて `git commit` または `git push` を実行したときに起動します。この層はエージェント的です。呼び出し元、サニタイザー、関連ファイルを読み、報告する前に検出結果が本物かどうかを判断します。これにより、単独では危険に見えてもコンテキストでは安全なコードに対する誤検出を低く保ちます。スライディング 1 時間あたり 20 回のレビューに制限されています。自分のシェルから実行した commit はレビューされません。

モデルベースの両方の層は、レビュアーとしてデフォルトで Claude Opus 4.7 を使用します。

## インストールと拡張

Claude Code 2.1.144 以降と、`PATH` 上の Python 3.8 が必要です。公式マーケットプレイスからインストールします。

```text
/plugin install security-guidance@claude-plugins-official
/reload-plugins
```

編集ごとの層は、モデルに触れずに拡張できます。リポジトリに `.claude/security-patterns.yaml` を置き、独自のルールを追加します。

```yaml
patterns:
  - rule_name: tenant_unfiltered_query
    regex: "\\.objects\\.all\\(\\)"
    paths: ["**/src/tenants/**"]
    reminder: "Multi-tenant code must filter by org_id."
```

3 つの層のいずれも、書き込みや commit をブロックしません。検出結果は書き込み中の Claude に指示として届き、レビュアーは依然として見落とす可能性があります。これは多層防御の 1 つの層として扱ってください。セッション内に位置し、オンデマンドの `/security-review` や pull request での完全な Code Review よりも前段にあります。正確な hook イベントと環境変数ごとのスイッチについては、[プラグインのドキュメント](https://code.claude.com/docs/en/security-guidance) がすべてを説明しています。
