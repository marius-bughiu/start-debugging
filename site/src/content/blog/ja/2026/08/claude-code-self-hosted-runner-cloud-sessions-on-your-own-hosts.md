---
title: "Claude Code のクラウドセッションを自社ホストで実行できるようになりました"
description: "Claude Code 2.1.224 で claude self-hosted-runner が追加され、自分で用意したマシン上でクラウドセッションを実行できるパブリックベータが始まりました。セットアップ手順、runner とユーザーが 1 対 1 になる理由、そして今もネットワークの外に出るものを整理します。"
pubDate: 2026-08-11
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "ja"
translationOf: "2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts"
translatedBy: "claude"
translationDate: 2026-08-11
---

Claude Code のクラウドセッション、つまり claude.ai、モバイルおよびデスクトップアプリ、スケジュールされたルーチン、あるいはターミナルの `claude --cloud` から開始するセッションは、これまで常に Anthropic のインフラ上で実行されてきました。2026-08-07 に公開された Claude Code 2.1.224 はそれを変えます。新しいサブコマンド `claude self-hosted-runner` は、Linux または macOS のホストを、セッションを実際に実行するマシンに変えます。Team および Enterprise プラン向けのパブリックベータで、Owner または admin が Cloud environments 管理ページで "Allow self-hosted environments" を有効にするまでは表示されません。

## 環境、runner、セッション

これを成り立たせているのは 3 つの要素です。**環境**は claude.ai の管理設定で作成する名前付きの宛先で、Anthropic ホスト型の選択肢と並んで環境ピッカーに表示されます。**runner** は自社ネットワーク内にデプロイする長時間稼働のプロセスです。**セッション**は 1 つのタスクで、runner が環境のキューから取得し、リポジトリをクローンして作業を行う子 `claude` プロセスを起動します。

動作する最小構成は、3 つのコマンドと環境シークレットだけです。このシークレットは作成時に claude.ai が一度だけ表示し、365 日で失効します。

```bash
mkdir -p /etc/claude
(umask 077 && cat > /etc/claude/environment-secret)
mkdir -p /srv/claude-work

claude self-hosted-runner \
  --environment-secret-file '/etc/claude/environment-secret' \
  --base-dir '/srv/claude-work'
```

`--base-dir` を省略すると runner は `/workspace` にフォールバックしますが、これはそのパスが既に存在して書き込み可能な場合にのみ機能します。まず `claude self-hosted-runner --help` でホストを確認してください。2.1.224 より古いバージョンではサブコマンドが認識されず、一般的な `claude --help` の出力が返ります。ガイド付きの手順 `claude self-hosted-runner setup` も用意されていて、管理 UI の手順を案内しながら `./runner-setup/CHEAT-SHEET.md` にチートシートを書き出します。

## runner が 1 人のユーザーだけを担当する理由

これがフリートの規模を決める設計判断です。runner が最初に取得したセッションは、そのセッションを開始したユーザーのアカウントに runner をロックします。以降、その runner は同じアカウントの作業しか受け取らず、同時実行数の上限は `--capacity` です。capacity の既定値は `1` です。したがってフリートの最小規模は、同時にアクティブになると見込まれるユーザー数であり、セッション数ではありません。

runner は既定で使い捨てでもあります。`--drain-grace-sec` の既定値は `0` なので、runner はアクティブなセッションが終わり次第、キューの追加ポーリングをせずに終了します。これにより Kubernetes は、どのアカウントにも使えるクリーンなディスクで runner を再起動できます。ユーザーごとのチェックアウト分離が、ユーザー間で状態を削除せずに実現されるのはこのためです。ポーリングはハートビートも兼ねており、約 60 秒ポーリングが止まるとコントロールプレーンがセッションを別の runner 向けにキューへ戻します。ヘルスチェックと Prometheus のメトリクスは `--health-port`（既定 `8080`）の `/healthz` と `/metrics` に出ます。

## それでも api.anthropic.com に送られるもの

リポジトリのチェックアウト、ビルド成果物、シークレット、そしてセッションが書き込んだファイルは、あなたのマシンに残ります。会話そのものは残りません。プロンプト、応答、ツールの実行結果は推論のために `api.anthropic.com` へ送られ、Anthropic は別のサーフェスからセッションを再開できるようにトランスクリプトを保存します。すべての接続は外向きで、Anthropic があなたのネットワークへ接続してくることはありません。

展開を計画する前に確認しておきたい制限が 3 つあります。Zero Data Retention を有効にした組織では利用できません。セッションは Anthropic が発行するセッションスコープのトークンで認証するため、推論を Amazon Bedrock、Google Cloud's Agent Platform、Microsoft Foundry、LLM ゲートウェイ経由にすることはできません。そして Claude Tag、Claude Security、Code Review のセッションは、まだセルフホスト環境にはルーティングされません。

同じリリースでは[セッション間メッセージング](/ja/2026/08/claude-code-2-1-224-sessions-message-each-other/)も追加されました。フラグの一覧は[セルフホスト環境のリファレンス](https://code.claude.com/docs/en/self-hosted-environments-reference)にあります。
