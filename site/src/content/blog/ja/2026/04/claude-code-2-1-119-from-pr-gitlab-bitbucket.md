---
title: "Claude Code 2.1.119 が GitLab、Bitbucket、GitHub Enterprise から PR を取得"
description: "Claude Code v2.1.119 は --from-pr を github.com の外に拡張します。CLI は GitLab のマージリクエスト、Bitbucket のプルリクエスト、GitHub Enterprise の PR の URL を受け付けるようになり、新しい prUrlTemplate 設定がフッターのバッジを正しいコードレビュー ホストに向けます。"
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "gitlab"
  - "bitbucket"
lang: "ja"
translationOf: "2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket"
translatedBy: "claude"
translationDate: 2026-04-27
---

Claude Code の最新リリース v2.1.119 では、GitHub 以外のチームに向けた小さいながらも遅れていた変更が入ります。`--from-pr` が GitLab のマージリクエスト URL、Bitbucket のプルリクエスト URL、GitHub Enterprise の PR URL を受け付けるようになり、新しい `prUrlTemplate` 設定がフッターの PR バッジを github.com ではなく独自のコードレビュー URL に向けるようになりました。このリリースまで、PR レビューのフローはあらゆるコードレビュー ホストが github.com であると仮定しており、GitLab や Bitbucket Cloud を使う組織にとっては機能が使いづらいものでした。

## --from-pr が何をするか、なぜホストが重要か

`--from-pr` は「このプルリクエストに対してセッションを起動する」ためのフラグです。PR の URL を貼り付けると、Claude Code が head ブランチをチェックアウトし、diff とレビュー スレッドでセッションを温めます。出荷以来、特定のコードレビューを狙ったエージェント実行を起動する最もきれいな方法でしたが、URL パーサーは `github.com/owner/repo/pull/<n>` に固定されていました。GitHub 以外の URL はパーサーをすり抜け、セッションはレビューのコンテキストを失っていました。

v2.1.119 は URL の扱いを一般化します。changelog が明示的に挙げる形式は、GitLab のマージリクエスト URL、Bitbucket のプルリクエスト URL、GitHub Enterprise の PR URL です:

```bash
claude --from-pr https://github.com/acme/api/pull/482
claude --from-pr https://gitlab.com/acme/api/-/merge_requests/482
claude --from-pr https://bitbucket.org/acme/api/pull-requests/482
claude --from-pr https://github.acme.internal/acme/api/pull/482
```

同じフラグ、同じフロー、4 種類のレビュー ホストです。

## prUrlTemplate が github.com フッター リンクを置き換える

`--from-pr` が動いていても、もうひとつの摩擦点が残っていました。アクティブな PR を表示するフッター バッジは URL が CLI にハードコードされていたため github.com に固定されていたのです。v2.1.119 は `prUrlTemplate` 設定を追加し、このバッジを独自のコードレビュー URL に向けます。同じリリースでは、エージェント出力中の `owner/repo#N` ショートハンド リンクも github.com 固定ではなく、git remote のホストを使うようになったと示されており、書き換えはサーフェス全体で一貫します。

`prUrlTemplate` は他の Claude Code の設定と同様に `~/.claude/settings.json` に置かれます。新しいリリースは `/config` の設定 (テーマ、エディター モード、verbose など) も同じファイルに project/local/policy のオーバーライド優先順で永続化するため、組織は `~/.claude/settings.policy.json` 経由で `prUrlTemplate` を配布でき、開発者ひとりひとりが手で設定する必要がなくなります。

## GitLab を使う .NET 組織にとっての意味

ここ数年で Azure DevOps から離れた .NET チームの多くは GitHub またはセルフホストの GitLab に着地し、しばしば OSS との相互運用のために GitHub Enterprise インスタンスへミラーされる内部リポジトリの長いテールを抱えています。これまで、そうした GitHub 以外のリポジトリに Claude Code を向けるには次のいずれかが必要でした:

1. github.com ミラーから一時的に clone を作り、そこに PR を往復させる、または
2. diff をコピーして会話に手で貼り付けてレビューする。

v2.1.119 と組織のポリシー ファイルに焼き込まれた `prUrlTemplate` があれば、同じ `claude --from-pr <url>` フローがこの組み合わせ全体に対して動きます。少し前の v2.1.113 リリースでは [CLI がネイティブ バイナリ](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)に切り替わったため、自動 PR レビューのジョブを実行するビルド エージェントに Node.js ランタイムをインストールする必要もなくなり、厳しく管理された CI 群でもこの導入が通しやすくなります。

チーム向けに `~/.claude/settings.policy.json` を配布しているなら、今週が `prUrlTemplate` 行を追加する週です。v2.1.119 の完全なリリース ノートは [Claude Code の changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) にあります。
