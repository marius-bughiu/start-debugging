---
title: "Cursor Router により Auto はリクエストごとのモデル選択になりました"
description: "Cursor Router が 2026-07-22 にリリースされました。Auto はリクエストごとに分類して別のモデルへルーティングするようになり、Cost、Balance、Intelligence の各モードは品質と課金の両方を変えます。"
pubDate: 2026-07-27
tags:
  - "cursor"
  - "ai-agents"
  - "developer-tools"
lang: "ja"
translationOf: "2026/07/cursor-router-makes-auto-a-per-request-model-decision"
translatedBy: "claude"
translationDate: 2026-07-27
---

Cursor は 2026-07-22 に [Cursor Router](https://cursor.com/blog/router) をリリースしました。これにより、モデル設定の Auto が意味するものが静かに変わりました。これまでの Auto はトークン消費を抑えることを狙った単一のルーティングポリシーでした。今の Auto は、アカウントで利用できるすべてのモデルの手前に立つ判断システムであり、リクエストごとにタスクの種類と複雑さを分類し、その 1 回のリクエストに使うモデルを選びます。

## 3 つのモード、3 種類の請求

モデルピッカーで Auto を選び、その下の "Optimize For" でモードを選択します。[ドキュメント](https://cursor.com/docs/cursor-router) では次のように説明されています。

- **Cost** は従来の Auto のルーティングロジックを使います。トークン消費を最適化し、Auto のバンドル料金を維持したまま、100 万トークン単位で課金されます。
- **Balance** は知性、速度、コストを最適化し、ルーティング先モデルのレートでリクエスト単位に課金されます。
- **Intelligence** は難しいタスクを最も能力の高いモデルへルーティングし、単一のフロンティアモデルを使い続けるより低いコストに抑えます。こちらもリクエスト単位の課金です。

このリクエスト単位の課金こそ、二度読む価値のある部分です。バンドル料金を維持するのは Cost だけです。Cursor 自身の案内でも、Balance と Intelligence は平均して Cost のおよそ 2 倍、選ぶモードによっては 2 倍から 4 倍のコストになるとされています。

このトレードオフは宣伝ではなく実測です。Cursor によると、早期アクセスの顧客はすべてを Opus 4.8 で実行する場合と比べて 30 から 50 パーセント削減し、コミットあたりのコストは Intelligence で 6.76 USD、Balance で 4.63 USD でした。Intelligence はユーザー満足度で Fable に迫りながら、チームのコストを約 60 パーセント下げます。Balance は Opus 4.8 を上回る満足度で、コストは約 36 パーセント低くなります。

## ルーティング先のモデルは既定で非表示です

ダッシュボードには、各応答の冒頭で Auto がどのモデルへルーティングしたかを表示する設定があります。既定は非表示で、Cursor もそのままにすることを推奨しています。

日々の作業ではそれで問題ありません。しかしエージェントの挙動を突き詰めたい場合には困ります。同じプロンプトが月曜にはきれいなリファクタリングを出し、火曜には平凡な結果を返すとき、その差はルーティング先モデルかもしれませんが、既定ではトランスクリプトに手がかりが残りません。チームへ展開する前にルーターを評価するなら、まず表示を有効にして、試用期間中はオンのままにしてください。

## 再現性が必要な実行ではモデルを固定してください

ルーティングは対話的な作業には向きますが、ベースラインと比較する作業には向きません。CI の実行、評価用ハーネス、スクリプト化したエージェントジョブでは、Auto を引き継がずに明示的なモデルを固定します。

```bash
# see the exact model ids this account exposes
agent --list-models

# pin one for a run that has to be repeatable
agent -p "run the failing tests and fix them" \
  --model <id-from-list-models> \
  --output-format json
```

Cursor Router はデスクトップ、Web、iOS、CLI、SDK で動作します。Teams プランでは既定で有効、Enterprise では管理者がダッシュボードから有効化し、個人向けプラン (Hobby、Pro、Pro+、Ultra) はリリースの数か月後に利用できるようになります。管理者はメンバーが選べるモードの制限、既定モードの指定、個別モデルの許可やブロック、Auto への統一のソフトまたはハードな強制を設定できます。

すでにチームが [Cursor 3.11 で入った side chats](/ja/2026/07/cursor-3-11-side-chats-parallel-agent-threads/) のような並列エージェント作業に頼っているなら、ルーターはその全体のコスト構造を一度に変えます。請求が据え置きだと考える前に、管理者が設定したモードを確認してください。
