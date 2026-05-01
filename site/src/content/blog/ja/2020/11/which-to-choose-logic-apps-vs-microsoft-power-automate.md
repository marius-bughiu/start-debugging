---
title: "どちらを選ぶ: Logic Apps か Microsoft Power Automate か"
description: "Azure Logic Apps と Microsoft Power Automate を比較し、自分のユースケースに最適なワークフロー自動化サービスを判断します。"
pubDate: 2020-11-18
tags:
  - "azure"
  - "logic-apps"
  - "microsoft-power-automate"
lang: "ja"
translationOf: "2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate"
translatedBy: "claude"
translationDate: 2026-05-01
---
両方とも design-first テクノロジーで、ワークフローをコードで書く代わりに描画できるユーザーインターフェースを提供します。両者には次のような共通点もあります。

-   入力を受け付けられる
-   アクションを実行できる
-   条件でワークフローを制御できる
-   出力を生成できる

## Logic Apps

Logic Apps は Azure が提供するサービスで、分散アプリケーションの異なるコンポーネントの自動化、オーケストレーション、統合を行えます。Logic Apps を通じて、複雑なビジネスプロセスをモデル化する複雑なワークフローを描けます。

Logic Apps はコードビューも提供しており、JSON 表記でワークフローを作成・編集できます。

統合プロジェクトに最適で、さまざまなアプリや外部サービス向けの何百もの異なるコネクターを備えています。さらに、独自のカスタムコネクターを簡単に作成することもできます。

## Microsoft Power Automate

Microsoft Power Automate は Logic Apps の上に構築されたサービスで、開発や IT Pro の経験がなくてもワークフローを作りたい人に向けられています。Microsoft Power Automate のウェブサイトやモバイルアプリを使って、多数の異なるコンポーネントを統合する複雑なワークフローを作成できます。

ワークフローには 4 種類があります。

-   **Automated**: トリガーによって開始されるフロー。例えば、新しいツイートの到着や新しいファイルのアップロードなどがトリガーになります。
-   **Button**: モバイルアプリから手動で起動できるフロー。
-   **Scheduled**: 定期的に実行されるフロー。
-   **Business process**: ビジネスプロセスをモデル化したフローで、必要な担当者への通知と承認の記録、各ステップのカレンダー上の日付、各フローステップの時間記録などを含められます。

コネクターについては、Microsoft Power Automate は Logic Apps とまったく同じコネクターを備えており、カスタムコネクターの作成・利用も可能です。

## 違い

| | Microsoft Power Automate | Logic Apps |
| --- | --- | --- |
| **想定ユーザー** | オフィスワーカーやビジネスアナリスト | 開発者と IT pros |
| **想定シナリオ** | セルフサービスでのワークフロー作成 | 高度な統合プロジェクト |
| **設計ツール** | GUI のみ。ブラウザーとモバイルアプリ | ブラウザーと Visual Studio のデザイナー。JSON でコード編集も可能 |
| **Application Lifecycle Management** | Power Automate にはテスト環境と本番環境が含まれる | Logic Apps のソースコードは Azure DevOps やソース管理システムに含められる |

## まとめ

2 つのサービスは非常に似ており、主な違いはターゲットとなる利用者です。Microsoft Power Automate は技術系ではない担当者を、Logic Apps はより IT プロフェッショナル、開発者、DevOps の実践者を対象としています。
