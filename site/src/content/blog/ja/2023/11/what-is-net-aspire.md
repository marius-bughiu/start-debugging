---
title: ".NET Aspire とは?"
description: "スケーラブルな分散アプリケーションを構築するためのクラウド指向フレームワーク .NET Aspire の概要を、オーケストレーション、コンポーネント、ツールの観点から解説します。"
pubDate: 2023-11-14
updatedDate: 2023-11-16
tags:
  - "aspire"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Aspire は、スケーラブルで観測可能な本番品質の分散アプリケーションを作成するために設計された、クラウド指向の包括的なフレームワークです。.NET 8 リリースの一環としてプレビューで導入されました。

このフレームワークは一連の NuGet パッケージとして提供され、それぞれがクラウドネイティブアプリケーション開発のさまざまな側面に対応します。クラウドネイティブアプリケーションは通常、単一の大きなコードベースではなくマイクロサービスのネットワークとして構成され、データベース、メッセージングシステム、キャッシングソリューションなど、さまざまなサービスに大きく依存します。

## Orchestration

クラウドネイティブアプリケーションにおけるオーケストレーションには、さまざまなコンポーネントの同期と管理が含まれます。.NET Aspire は、クラウドネイティブアプリケーションのさまざまなセグメントのセットアップと統合を簡素化することで、このプロセスを向上させます。サービスディスカバリー、環境変数、コンテナーの構成といった側面を効果的に扱うための高水準の抽象化を提供し、煩雑な低レベルコードの必要性を排除します。これらの抽象化により、複数のコンポーネントとサービスから構成されるアプリケーション全体で統一された構成手順が保証されます。

.NET Aspire を用いたオーケストレーションは、次のような主要な領域に対応します。

-   **アプリケーション構成:** これにはアプリケーションを構成する .NET プロジェクト、コンテナー、実行可能ファイル、クラウドベースのリソースの定義が含まれます。
-   **サービスディスカバリーと接続文字列の管理:** アプリケーションホストは、正確な接続文字列とサービスディスカバリーの詳細をシームレスに組み込む役割を担い、開発プロセスを向上させます。

たとえば、.NET Aspire を使えば、ローカルの Redis コンテナーリソースの作成と、対応する接続文字列の "frontend" プロジェクトへの設定を、わずか数個のヘルパーメソッドを使用して最小限のコードで行えます。

```cs
// Create a distributed application builder given the command line arguments.
var builder = DistributedApplication.CreateBuilder(args);

// Add a Redis container to the application.
var cache = builder.AddRedisContainer("cache");

// Add the frontend project to the application and configure it to use the 
// Redis container, defined as a referenced dependency.
builder.AddProject<Projects.MyFrontend>("frontend")
       .WithReference(cache);
```

## Components

NuGet パッケージとして利用可能な .NET Aspire のコンポーネントは、Redis や PostgreSQL のような広く使用されているサービスやプラットフォームとの統合を効率化するために作られています。これらのコンポーネントは、ヘルスチェックの実装やテレメトリー機能を含む統一された構成セットアップを提供することで、クラウドネイティブアプリケーション開発のさまざまな側面に対応します。

これらの各コンポーネントは、.NET Aspire オーケストレーションフレームワークとシームレスに統合されるよう設計されています。.NET プロジェクトとパッケージ参照に定義された関係に基づき、依存関係を通じて自動的に構成を伝播する能力を持っています。つまり、あるコンポーネント、たとえば Example.ServiceFoo が別の Example.ServiceBar に依存する場合、Example.ServiceFoo は相互通信を可能にするために必要な構成を Example.ServiceBar から自動的に取り入れます。

具体例として、コーディング上のシナリオで .NET Aspire の Service Bus コンポーネントの使用を考えてみましょう。

```cs
builder.AddAzureServiceBus("servicebus");
```

.NET Aspire の `AddAzureServiceBus` メソッドは、いくつかの重要な機能を担います。

1.  依存性注入 (DI) コンテナー内に `ServiceBusClient` をシングルトンとして登録し、Azure Service Bus への接続を可能にします。
2.  このメソッドでは `ServiceBusClient` の構成が可能で、コード内で直接行うことも、外部の構成設定を介して行うこともできます。
3.  さらに、Azure Service Bus 向けに特化した関連するヘルスチェック、ロギング、テレメトリー機能を有効化し、効率的な監視と保守を保証します。

## Tooling

.NET Aspire で開発されたアプリケーションは、デフォルトの .NET Aspire プロジェクトテンプレートによって確立された統一された構造に従います。通常、.NET Aspire アプリケーションは少なくとも 3 つの異なるプロジェクトで構成されます。

1.  **Foo**: これは初期アプリケーションで、Blazor UI や Minimal API のような標準的な .NET プロジェクトにすることができます。アプリケーションが成長すると、より多くのプロジェクトを追加でき、それらのオーケストレーションは Foo.AppHost と Foo.ServiceDefaults プロジェクトで管理されます。
2.  **Foo.AppHost**: AppHost プロジェクトはアプリケーションの高水準のオーケストレーションを担います。これには API、サービスコンテナー、実行可能ファイルといったさまざまなコンポーネントの組み立てや、それらの相互接続および通信の構成が含まれます。
3.  **Foo.ServiceDefaults**: このプロジェクトには、.NET Aspire アプリケーションのデフォルト構成設定が格納されています。これらの設定にはヘルスチェックや OpenTelemetry の構成などが含まれ、必要に応じて調整・拡張できます。

この構造での開発を支援するため、2 つの主要な .NET Aspire スターターテンプレートが提供されています。

-   **.NET Aspire Application**: 基本的なスターターテンプレートで、Foo.AppHost と Foo.ServiceDefaults プロジェクトのみを含み、その上に構築するための基本的な枠組みを提供します。
-   **.NET Aspire Starter Application**: より包括的なテンプレートで、Foo.AppHost と Foo.ServiceDefaults プロジェクトに加え、事前に設定された UI および API プロジェクトも付属します。これらの追加プロジェクトには、サービスディスカバリーやその他の標準的な .NET Aspire 機能があらかじめ構成されています。

### Read next:

-   [How to install .NET Aspire](/ja/2023/11/how-to-install-net-aspire/)
-   [Build your first .NET Aspire application](/ja/2023/11/getting-started-with-net-aspire/)
