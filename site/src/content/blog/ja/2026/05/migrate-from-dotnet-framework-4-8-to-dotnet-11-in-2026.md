---
title: "2026 年に .NET Framework 4.8 から .NET 11 へ移行する"
description: ".NET Framework 4.8 の移行を、正確なサポート情報、ASP.NET の段階移行、依存関係、設定、ロールバックから計画。"
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "ja"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

**訂正 — 2026年11月2日:** .NET 11 の公開・サポート状態、Framework のライフサイクル、設定、シリアライズ、ツール、配備手順を訂正しました。根拠のない工数、メモリ削減率、「実際に遭遇した問題」という記述を削除しました。

.NET Framework 4.8 から現代の .NET へ移るには、新しいホストやライブラリ、配備、データ契約の変更が必要になる場合があります。ランタイムのインプレース更新ではありません。まず移行理由と、独立して移せる部分を特定してください。

確認時点で [.NET 11 RC3 は go-live プレリリース](https://dotnet.microsoft.com/en-us/download/dotnet/11.0)、.NET 11 は STS、.NET 10 はリリース済み LTS です。[Framework のサポートは基盤の Windows 製品に従います](https://learn.microsoft.com/en-us/lifecycle/faq/dotnet-framework)。すべての Windows 10 インストールに一律の Framework 4.8 終了日があるわけではありません。実際の OS と対応 Framework を確認してください。

## プロジェクト変更前に棚卸しする

現在のアプリをサポート対象の Windows 環境でビルド・テストします。移行中も developer/reference pack とビルドツールを維持してください。認証、セッション、Windows 統合、ネイティブライブラリ、定期処理、DB プロバイダー、保存形式を記録します。互換性は API とアセットで決まり、すべての `net48` ライブラリが利用不可になるわけではありません。

[Upgrade Assistant の概要](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)は、現在このツールを非推奨とし、GitHub Copilot のモダナイゼーションエージェントを案内しています。自動化は任意です。変更内容をレビューしテストしてください。古いバージョン未固定のインストールコマンドが .NET 11 対応を保証するわけではありません。

可能ならプロジェクト形式の整理とランタイム移行を分けます。SDK スタイルへの変換は `System.Web`、WCF ホスト、COM、独自 MSBuild タスクを変換しません。動作する基準を維持し、呼び出し側より先に末端のライブラリを移します。

## 移行の境界を決める

| 現在の依存関係 | 計画する作業 |
| --- | --- |
| ASP.NET MVC 5 / Web API 2 | ルート、フィルター、binding、認証、セッション、ホストを適合させる |
| Web Forms / System.Web | 段階移行の境界内に残すか UI を置換する。ASP.NET Core は Web Forms を実行しない |
| WCF サーバー | 必要な binding／機能で CoreWCF を評価するか契約を再設計 |
| WCF クライアント | 現行 System.ServiceModel パッケージとセキュリティ要件を確認 |
| EF6 | 現代のランタイム／プロバイダーを検証し、EF Core は別計画も可能 |
| WPF / WinForms | Windows ターゲットとコントロール、COM、ネイティブ依存、配備を検証 |
| 追加 AppDomain / Remoting / CAS | ロード、通信、分離を再設計 |

Microsoft の [ASP.NET 移行ガイド](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/?view=aspnetcore-10.0)は段階的移行をサポートしています。プロキシの背後でルートを移せば旧アプリを稼働させたまま進められます。認証、ルーティング、データ所有権、ロールバックを明確に管理する部分移行は有効です。

[CoreWCF](https://github.com/CoreWCF/CoreWCF) は全 WCF 機能や通信契約の一致を保証しません。実際の binding と認証をテストしてください。[EF6 は6.3から現代の .NET をサポートします](https://learn.microsoft.com/en-us/ef/ef6/what-is-new/)。6.5.0を普遍的な最低条件とせず、現在の互換バージョン／プロバイダーを選び検証します。EF Core は EF6 の無変更の置換ではありません。

## 小さな動作する部分から始める

.NET 11 を評価する ASP.NET Core プロジェクトの基本形です。

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

明示的に選んだインストール済み SDK と互換パッケージを使います。[.NET 8→11 チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)に現在の RC3 固定例があります。デスクトッププロジェクトは適切な Windows TFM と設定が必要です。すべてを `Microsoft.NET.Sdk.Web` に変えないでください。

これは完全な `Program.cs` ですが、移行済みアプリではなくスモークテストです。

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

今回 .NET 8 と10でビルド、発行、HTTP 呼び出しを確認しました。MVC アプリではマッピング前にコントローラーを登録します。認証には実際のスキームとサービス設定が必要で、`UseAuthentication()` の追加だけでは Forms Authentication を移行できません。

## 設定とデータの意味を保つ

小さな `appsettings.json` の例です。

```json
{
  "Migration": {
    "MaxRetries": 3
  }
}
```

[.NET の JSON 設定プロバイダーはキーの大文字小文字を区別しません](https://learn.microsoft.com/en-us/dotnet/core/extensions/configuration-providers)。一般の JSON シリアライズ規則とは別です。プロバイダーの優先順位と秘密の保管を確認します。XML 対応だけで全 `app.config` セクションや binding redirect が再現されるわけではありません。対応 API なら `System.Configuration.ConfigurationManager` が互換手段になる場合があり、全利用箇所の削除は必須ではありません。IIS ホストでは `web.config` が引き続き重要です。

`BinaryFormatter` の組み込み実装は .NET 9 以降で例外を投げますが、型は残ります。別のシリアライザーか、任意の型を生成せず旧データを取り出す [NRBF リーダー](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/)を検討します。Framework 4.8 上で古い危険なデシリアライザーを動かす方法しかないわけではありません。

`AssemblyLoadContext` はアセンブリのロードと協調的アンロードを提供しますが、AppDomain のセキュリティ境界を再現しません。参照、実行中コード、イベントハンドラーがアンロードを妨げる場合があります。GC 1回では成功の証明になりません。信頼できないコードには適切な権限を持つプロセス／コンテナー境界を使用します。

証明書検証は有効なままにしてください。TLS 障害では証明書、ホスト名、信頼チェーン、SQL クライアント設定、プラットフォームを調べます。すべての証明書を受け入れる回避策は使いません。.NET 11 全般の解析変更を仮定せず、具体的な日付形式・カルチャ・シリアライズ契約をテストします。

## 配備とロールバックを練習する

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

このコマンドは明示的にフレームワーク依存アプリを発行します。自己完結型には `--self-contained true` と適切な RID が必要で、`dotnet publish` だけで自動的になるものではありません。残る Framework プロジェクトには Windows CI を維持し、新しい成果物を実際の対象環境で検証します。

成功リクエストだけでなく認可拒否、セッション、DB 書き込み、メッセージ、バックグラウンド処理、デスクトップ統合も試します。旧配備を残し、互換性のあるスキーマ・データ変更を行い、トラフィックを戻す練習をします。ロールバックには旧アプリと設定が必要で、Framework 再頒布可能パッケージの再インストールだけでは足りません。

**検証範囲:** Windows／Framework アプリ、.NET 11 SDK、WCF サービス、EF プロバイダー移行、本番配備は検証していません。移植可能なエンドポイントと JSON 設定キーは .NET 8 と10で確認しました。工数と性能は自身の代表的な機能で評価してください。

## 追加の一次資料

- [AssemblyLoadContext](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext)
- [.NET Framework technologies unavailable on .NET](https://learn.microsoft.com/en-us/dotnet/core/porting/net-framework-tech-unavailable)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
