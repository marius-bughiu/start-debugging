---
title: "Azure Functions と WebJobs - どちらを選ぶか"
description: "Azure Functions と WebJobs を比較します。スケーリング、料金、トリガーの主な違いと、どちらをいつ選ぶべきかを解説します。"
pubDate: 2020-11-18
updatedDate: 2021-02-19
tags:
  - "azure"
  - "azure-functions"
lang: "ja"
translationOf: "2020/11/azure-functions-vs-webjobs-which-to-choose"
translatedBy: "claude"
translationDate: 2026-05-01
---
どちらも開発者を対象にした code-first テクノロジーです ([design-first のワークフローサービスとは対照的に](/ja/2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate/))。複数の業務アプリケーションを 1 つのワークフローへオーケストレーション・統合でき、ワークフローのパフォーマンスをより細かく制御でき、ビジネスプロセスの一部としてカスタムコードを書くこともできます。

## Azure WebJobs

WebJobs は Azure App Service の一部で、プログラムやスクリプトを自動で実行するために使用できます。WebJob には 2 種類あります。

-   **Continuous.** 継続的なループで実行されます。例えば、共有フォルダーに新しい写真がないか確認するために継続的な WebJob を使えます。
-   **Triggered.** 手動またはスケジュールに基づいて実行できます。

WebJob のアクションを決めるために、さまざまな言語でコードを記述できます。例えば、Shell Script (Windows, PowerShell, Bash) で WebJob をスクリプト化できます。あるいは、PHP、Python、Node.js、JavaScript、.NET、その他フレームワークが対応する任意の言語でプログラムを書くこともできます。

## Azure Functions

Azure Function は多くの点で WebJob に似ていますが、主な違いはインフラについて一切気にする必要がない点です。

クラウド上で小さなコード片を実行するのに最適です。Azure は需要に応じて自動的に Function をスケールし、consumption plan ではコードの実行時間分のみ料金を支払います。

さまざまなトリガーで実行できます。例えば、次のとおりです。

-   **HTTPTrigger**. HTTP プロトコル経由のリクエストに応答して実行されます。
-   **TimerTrigger**. スケジュールに従った実行を可能にします。
-   **BlobTrigger**. Azure Storage アカウントに新しい blob が追加されたとき。
-   **CosmosDBTrigger**. NoSQL データベース内の新規・更新ドキュメントへの応答として。

## 違い

| 機能 | Azure WebJobs | Azure Functions |
| --- | --- | --- |
| 自動スケーリング | 不可 | 可 |
| ブラウザーでの開発・テスト | 不可 | 可 |
| 従量課金 (pay-per-use) | 不可 | 可 |
| Logic Apps との統合 | 不可 | 可 |
| パッケージマネージャー | WebJobs SDK を使用する場合は NuGet | NuGet と NPM |
| App Service アプリケーションの一部にできる | 可 | 不可 |
| `JobHost` の細やかな制御を提供 | 可 | 不可 |

## まとめ

Azure Functions は一般的に柔軟で運用も容易です。しかし、次のような場合は WebJobs のほうが優れた選択になります。

-   コードを既存の App Service アプリケーションの一部とし、そのアプリケーションの一部として、例えば同じ Azure DevOps 環境内で管理したい場合。
-   コードを起動するイベントを待ち受けるオブジェクトについて、細かな制御が必要な場合。
