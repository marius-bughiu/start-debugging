---
title: "Cursor Bugbot に Default、High、Custom のエフォートレベルが追加"
description: "2026 年 5 月 11 日、Cursor は Bugbot にエフォートレベルを追加しました。Default は 1 回のレビューで 0.7 件のバグを検出し、High は 0.95 件まで引き上げ、Custom では各モードがいつ動作するかを自然言語で記述できます。"
pubDate: 2026-05-12
tags:
  - "cursor"
  - "bugbot"
  - "ai-agents"
  - "pull-requests"
lang: "ja"
translationOf: "2026/05/cursor-bugbot-effort-levels-pr-review"
translatedBy: "claude"
translationDate: 2026-05-12
---

2026 年 5 月 11 日、Cursor は [Bugbot にエフォートレベルを追加しました](https://cursor.com/changelog)。Bugbot は、監視しているリポジトリに対して開かれた pull request にコメントする PR レビューエージェントです。これまでは、すべてのレビューが同じ予算で同じループを実行していました。今回のリリースでは、Teams 管理者と従量課金の Individual ユーザーに対して、Default、High、Custom の 3 つのつまみが提供されます。Cursor がリリースとともに公開した数値は、設定方法を語る前に確認しておく価値があります。

## 1 回の実行で検出されるバグ数で見た Default と High

Cursor は [changelog のエントリ](https://cursor.com/changelog) で具体的な 2 つの数値を報告しています。

- **Default** は 1 回のレビューあたり平均 **0.7 件のバグを検出** し、"optimized for efficiency and speed" と説明されています。指摘された問題の 79% 以上が PR がマージされる前に解決されており、これがシグナル対ノイズで重要な部分です。
- **High** は 1 回のレビューあたり平均 **0.95 件のバグを検出** します。推論トークンに多くを費やし、PR あたりの所要時間も長くなります。

これは 1 回の実行あたりのバグ件数が 36% 増えることに相当し、その代価は追加のレイテンシとトークンです。このトレードオフが見合うかは、PR の傾向次第です。長く続く微妙なリグレッションを抱えるリポジトリと、ほとんどのバグが diff を 10 秒読めば明らかになるリポジトリでは話が違います。Cursor はその判断をあなたに代わって下しません。それこそが 3 番目のモードの存在意義です。

## Custom は自然言語のルーターです

Custom モードはスライダーや YAML スキーマを提供しません。短い指示を書くと、Bugbot がそれをルーティング用のプロンプトとして使い、レビューごとに Default か High かを選択します。Cursor が [Bugbot ドキュメント](https://docs.cursor.com/en/bugbot) で示すパターンは、設定ファイルというよりトリアージのルールに近い読み心地です。

```text
Use High effort for any PR that:
- touches files under src/billing/** or src/auth/**
- changes a database migration (paths matching db/migrations/**)
- modifies a public API surface (anything in src/api/v1/**)

Use Default effort for everything else, including
documentation, tests, and dependency bumps.
```

これをリポジトリのエフォート設定欄に貼り付けます。次の PR で、Bugbot は diff のメタデータを読み、ルールを適用し、レビュー開始前にモードを選びます。コンパイルステップも `bugbot.yaml` もありません。ルールが曖昧な場合、Bugbot は Default に戻ります。

## 設定する場所

エフォートはリポジトリ単位で生き、ユーザー単位ではありません。したがって、同じリポジトリで一人のエンジニアを High に、別のエンジニアを Default にすることはできません。設定は `cursor.com/dashboard/bugbot/<repo>` の Bugbot ダッシュボード内、"Review effort" の項にあります。Teams 管理者は組織のリポジトリに対してグローバルに設定します。従量課金の Individual プランのユーザーは自分のリポジトリで同じパネルを見ます。定額制の Individual プランにはエフォート選択がありません。そのバケットは Default のままです。

## 予算を燃やさずにモードを選ぶ

率直に言えば、**High は「賢くする」ボタンではなく「もっと使う」ボタンです**。1 回の実行あたりのバグ件数が 36% 増えるということは、使用上限に対して請求されるトークン数もおよそ 36% 増えることを意味し、レイテンシの打撃は昼食前にマージしたい PR で最も痛みます。Custom は、その請求を抑えながら運用できる唯一のモードです。バグを見逃すと実際にコストがかかる部分にだけ狙いを定めるルールを書き、それ以外は Default に任せてください。そのルールを 3 行の日本語で表現できないなら、おそらく High は不要です。

このリリースは [Cursor 3.3 の並列ビルドと PR 分割の機能](/ja/2026/05/cursor-3-3-build-in-parallel-split-prs/) と同時期に登場しており、より大きなパターンを示しています。Cursor は、すべての人を満足させるべき単一のデフォルトではなく、ワークフローごとに設定できるつまみへとエージェントを分解しているのです。
