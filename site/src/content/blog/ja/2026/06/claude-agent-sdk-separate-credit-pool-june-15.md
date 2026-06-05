---
title: "Claude Agent SDK と claude -p が 6 月 15 日に専用のクレジットプールを持ちます"
description: "Anthropic は 2026-06-15 に Claude のプログラム的な利用をサブスクリプションから分離します。何がプログラム的とみなされるか、プランごとのクレジット、そして CI のエージェントが静かに止まるのを防ぐ方法を解説します。"
pubDate: 2026-06-05
tags:
  - "claude-code"
  - "ai-agents"
  - "anthropic"
lang: "ja"
translationOf: "2026/06/claude-agent-sdk-separate-credit-pool-june-15"
translatedBy: "claude"
translationDate: 2026-06-05
---

Claude をパイプラインで実行しているなら、2026-06-15 をカレンダーに記しておいてください。その日から、Anthropic は Claude のプログラム的な利用をすべてサブスクリプションの制限から外し、API の定価で課金される、独立した有限の月次クレジットプールに移します。インタラクティブなチャットとインタラクティブなターミナルはまったく変わりません。この変更が影響するのはリアルタイムで監視できないワークロードだけであり、それはまさに静かに壊れやすいものです。

## 何が「プログラム的」とみなされるか

この分離は、どのモデルを呼び出すかではなく、Claude がどのように呼び出されるかに関わります。以下はプランの使用制限ではなく、新しいクレジットプールを消費します。

- スクリプト化されたプロジェクトや個人プロジェクトでの Claude Agent SDK。
- `claude -p`、Claude Code の非インタラクティブな headless モード。
- GitHub Actions 内で実行される Claude Code。
- Agent SDK を通じて認証するサードパーティ製アプリ。

Web、デスクトップ、モバイルのチャット、そして手で操作するインタラクティブなターミナルセッションは、引き続きサブスクリプションのままです。Claude Cowork も同様です。人が入力しているなら、何も変わりません。

## プランごとのクレジット

各プランには、そのティアにおおよそ見合った固定の月次クレジットが付与されます。

| プラン | 月次クレジット |
| --- | --- |
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team Standard (シートあたり) | $20 |
| Team Premium (シートあたり) | $100 |
| Enterprise Premium (シートあたり) | $200 |

そのクレジットを使い切ると、アカウント設定の「usage credits」トグルに応じて、リクエストは API の定価で課金されるか拒否されます。Max 20x のサブスクリプションに余裕で収まっていた夜間のエージェントループが、いまや月の途中で尽きるかもしれませんし、以前は「ただ動いていた」CI ジョブが、プールが空になった瞬間にエラーを返し始めるかもしれません。

## 自動化を予測可能にする: 専用のキーを与える

最もきれいな解決策は、自動化にサブスクリプションを借りさせるのをやめることです。headless のワークロードを専用の API キーに向ければ、支出は計測でき、帰属でき、インタラクティブなシートから分離されます。GitHub Actions では、これは 1 行の変更です。

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Claude Code headless
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Triage the newest issue and label it" \
            --allowedTools "Bash(gh:*)"
```

`ANTHROPIC_API_KEY` を設定すると、`claude -p` と Agent SDK はサブスクリプションのクレジットではなく API アカウントに対して認証するため、6 月 15 日のプールはそのジョブには一切関係しなくなります。いずれにせよ定価を支払いますが、いまや請求は予算化できる場所に届きます。

## 期限の前に

今週やっておく価値のあることが 3 つあります。Anthropic が送ったメールから一度きりのクレジットを受け取ってください(アカウント設定での手動の操作です)。プログラム的な利用が API 価格で実際にいくらかかるかを精査し、クレジットが 1 週間分なのか 1 か月分なのかを把握してください。そのうえで、月次の割り当てがいまや有限であることを CI の担当者に伝え、超過分を課金すべきか、それとも強制的に失敗させるべきかをパイプラインごとに判断してください。

正式な条件については、[Claude のリリースノート](https://support.claude.com/en/articles/12138966-release-notes)と [Anthropic のニュースルーム](https://www.anthropic.com/news)をお読みください。
