---
title: ".NET 8 から .NET 11 への移行: 完全チェックリスト"
description: ".NET 11 RC3 の現状、SDK の厳密な固定、互換性、配備検証、ロールバックに基づく .NET 8 移行ガイド。"
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "ja"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

**訂正 — 2026年11月2日:** .NET 11 をリリース済み LTS として説明していた誤りを訂正しました。SDK 固定、パッケージ、ホスティング、シリアライズ、EF クエリ、ロック、ロールバックも見直しました。以前の移行実績に関する記述には記録されたテストの裏付けがありませんでした。

.NET 8 のサポートは **2026年11月10日** に終了します。[現在のサポート方針](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)では .NET 10 が LTS、.NET 11 RC3 が go-live プレリリースです。.NET 11 は STS 系列です。今すぐリリース済み LTS へ移るなら .NET 10 を検討してください。.NET 11 が必要なら現在の状態を明示的に受け入れ、次の更新を計画します。SDK だけ更新しても配備済みアプリは更新されません。

## 1. 基準を記録し SDK を選ぶ

配備中のランタイム、ビルド SDK、OS、依存関係、テスト結果、代表的な動作を記録します。移行前の成功は回帰調査に役立ちますが、その後のすべての失敗が移行原因だと証明するものではありません。

```bash
dotnet --info
dotnet --list-sdks
dotnet --version
dotnet list package --include-transitive
dotnet test -c Release
```

意図した SDK を選び、ソリューションディレクトリで実行してください。[SDK 選択](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json)とターゲットフレームワークは別です。[ダウンロードページ](https://dotnet.microsoft.com/en-us/download/dotnet/11.0)記載の完全な RC3 バージョンを評価する `global.json` は次のとおりです。

```json
{
  "sdk": {
    "version": "11.0.100-rc.3.26522.148",
    "rollForward": "disable",
    "allowPrerelease": true
  }
}
```

`disable` はこの SDK そのものを要求し、`latestFeature` は後続 feature band を許可します。CI にも選択した SDK をインストールします。この RC3 番号は公開メタデータと照合しましたが、本稿ではインストール・実行していません。別リリースへ移るときに明示的に更新してください。

## 2. ターゲットと依存関係を個別に見直す

最小限の Web プロジェクト定義は次の形です。

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

これは .NET 11 用の定義であり、ここで .NET 11 のビルドを検証したものではありません。理由がなければ言語バージョンは SDK/TFM の既定に任せます。C# 14 は .NET 10 の言語で、.NET 11 の新しい言語バージョンではありません。

**すべての `Microsoft.*` パッケージを11へ上げてはいけません。** 製品ごとにバージョン系列が異なります。対応 TFM、依存関係、プロバイダー、リリース状態を確認してください。EF Core、本体プロバイダー、Design パッケージ、ツールは各ドキュメントに従って揃えます。集中管理なら `Directory.Packages.props` も確認します。`net8.0` パッケージはそのまま互換性を持つ場合があり、NuGet が新しいターゲットだからという理由だけで古い .NET Standard アセットを優先するわけではありません。

## 3. 途中の全バージョンを確認する

[.NET 9](https://learn.microsoft.com/en-us/dotnet/core/compatibility/9.0)、[.NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10.0)、[.NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11) の互換性一覧と、使用するフレームワーク／プロバイダーの注意事項を読みます。.NET 11 の一覧は明示的に作成途中とされています。

- **BinaryFormatter:** .NET 9 以降は組み込み実装が例外を投げますが、API の型は残っています。別形式を優先してください。[移行ガイド](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/)は任意のシリアライズ型を生成せず NRBF を読む方法も説明しています。変換が必ず古い .NET 8 アプリの実行を必要とするわけではありません。
- **ホスティング:** `WebHostBuilder`、`IWebHost`、`WebHost` は [.NET 10 で非推奨になりました](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/webhostbuilder-deprecated?view=aspnetcore-10.0)。すべての `IWebHostBuilder`／`ConfigureWebHostDefaults` コードが削除された根拠ではありません。新規コードでは `WebApplication.CreateBuilder` を優先し、実際の診断に対応します。
- **EF クエリ:** SQL Server では EF8 がコレクションの JSON パラメーター化を導入し、[EF10 の新しい既定はスカラーパラメーターです](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection)。実際の DB／プロバイダーで SQL と実行計画を確認します。無差別な `ToList()` は処理をメモリに移す可能性があり、万能な修正ではありません。
- **シリアライズとコンパイル:** 実際の JSON 契約、日付、数値、enum、多態性をテストします。span 変換など具体的な診断を調べ、span オーバーロードが常に配列に勝つとは仮定しません。
- **ロック:** `System.Threading.Lock` と Monitor は両方とも再入可能です。静的に `Lock` 型の式と、`object` にキャストした参照では別の仕組みを使います。同じ状態の保護に混在させないでください。ロック変更はリターゲットの必須条件ではありません。
- **ホストサービス:** Azure Functions には独自の[サポート表](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide#supported-versions)があります。確認時点の isolated worker の最大ターゲットは .NET 10、in-process のサポート終了は2026年11月10日です。SDK の公開だけから .NET 11 対応を推測してはいけません。

## 4. 配備する成果物を検証する

次は簡単なスモークテスト用エンドポイントを提供する完全な `Program.cs` です。本番の認証、コントローラー、DB は構成しません。

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

この例は .NET 8.0.33 と10.0.10でビルド、発行、HTTP 呼び出しを確認しました。`--self-contained false` ではホストに互換ランタイムが必要です。自己完結型なら実際の RID と `--self-contained true` を指定し、対象 OS で成果物をテストします。任意のプロジェクトへ `/health` が自動追加されるわけではありません。

staging では認証、認可、読み書き契約、トランザクション、バックグラウンド処理、ロールバックも確認します。合意した負荷で性能を測定してください。trimming／AOT を使うなら実際の発行警告に対応して発行物を実行します。注釈だけで任意の動的コード生成が Native AOT 対応になるわけではありません。

## 5. ロールバック互換性を保つ

旧成果物と設定を保管します。DB スキーマ、保存データ、メッセージ、認証状態が新旧の共存可否を決めます。最初の書き込みで自動的にロールバック不能になるわけではなく、SDK 変更だけで DB マイグレーションが生じることもありません。互換性のある変更を使い、切り替え前にトラフィックを戻す手順を練習してください。

**検証範囲:** .NET 11 移行、EF／DB 更新、Azure 配備、性能比較は実行していません。移植可能なサンプルと一部の訂正事項を .NET 8/10 で試し、バージョン固有の情報は一次資料で確認しました。

## 追加の一次資料

- [System.Threading.Lock](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# 14 span overload resolution](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
