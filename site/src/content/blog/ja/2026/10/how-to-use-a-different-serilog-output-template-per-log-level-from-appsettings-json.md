---
title: "appsettings.json でログレベルごとに異なる Serilog の出力テンプレートを使う方法"
description: "outputTemplate はシンクごとに固定のため、レベル別の書式には {#if @l ...} ブロックを使った ExpressionTemplate か、ByIncludingOnly / ByExcluding フィルターを持つ 2 つの Logger サブロガーのどちらかが必要です。どちらも appsettings.json だけで設定でき、Serilog 4.4、Serilog.Settings.Configuration 10.0.1、Serilog.Expressions 5.0 で検証しています。"
pubDate: 2026-10-26
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "logging"
  - "serilog"
  - "aspnet-core"
lang: "ja"
translationOf: "2026/10/how-to-use-a-different-serilog-output-template-per-log-level-from-appsettings-json"
translatedBy: "claude"
translationDate: 2026-10-26
---

Serilog の `outputTemplate` はレベルではなくシンクに属しているため、`"outputTemplate": { "Error": "..." }` のような設定はありません。`appsettings.json` だけでレベル別の書式を実現する方法は 2 つあります。1 つ目は、`outputTemplate` を `Serilog.Templates.ExpressionTemplate` 型(`Serilog.Expressions` パッケージ)の `formatter` に置き換え、テンプレート内で `{#if @l in ['Error', 'Fatal']} ... {#else} ... {#end}` と分岐する方法です。2 つ目は、`"Name": "Logger"` のサブロガーを 2 つ用意し、それぞれに `Filter`(`@l` に対する `ByIncludingOnly` / `ByExcluding`)と専用のプレーンな `outputTemplate` を持たせる方法です。2 つ目のシンクを `restrictedToMinimumLevel` 付きで追加するだけにしてはいけません。それは下限指定なので、すべてのエラーが二重に出力されます。以下はすべて、.NET 10.0.302 SDK、Serilog 4.4.0、Serilog.Settings.Configuration 10.0.1、Serilog.Expressions 5.0.0、Serilog.Sinks.Console 6.1.1、Serilog.Sinks.File 7.0.0 で実行しました。同じ JSON は .NET 11 でもそのまま動作します。

## outputTemplate をレベルごとに変えられない理由

`outputTemplate` は、コンソールシンクとファイルシンクのコンストラクター引数です。シンクは内部でこの文字列から `MessageTemplateTextFormatter` を 1 つだけ作り、受け取るすべてのイベントに使い回します。Serilog.Settings.Configuration は `WriteTo.Console(outputTemplate: "...")` を呼び出しているだけなので、JSON に書いた内容はその 1 つのフォーマッターにそのまま対応します。レベルはテンプレートの*中*で `{Level}` として参照できますが、従来のメッセージテンプレートには条件分岐がありません。レベルを表示することはできても、レベルに応じて形を変えることはできないのです。

そのため、レベル別の出力には次のどちらかが必要です。

1. 自分で判断できるフォーマッター。これが `ExpressionTemplate` です。
2. それぞれ専用のフォーマッターを持つ別々のパイプラインと、イベントがちょうど 1 つにだけ入るようにする前段のフィルター。

これが必要になる典型的な場面は次のとおりです。コンソールでは `Debug` と `Information` を短い 1 行で出し、`Error` と `Fatal` ではフルのタイムスタンプ、追加のコンテキストプロパティ、スタックトレースを出したい場合。あるいは、メインのログより豊富なレイアウトの専用 `errors.log` が欲しい場合です。

## エラーが重複する単純な設定

多くの人が最初に試す設定で、この質問が繰り返される原因でもあります。

```json
// appsettings.json, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } },
      { "Name": "Console", "Args": { "restrictedToMinimumLevel": "Error", "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} ({SourceContext}){NewLine}{Exception}" } }
    ]
  }
}
```

テストプログラムは、レベルごとに 1 件ずつイベントを記録し、`Error` には例外を付けます。

```csharp
// Program.cs, .NET 10, Serilog 4.4.0
using Microsoft.Extensions.Configuration;
using Serilog;

var config = new ConfigurationBuilder().AddJsonFile(args[0]).Build();
Log.Logger = new LoggerConfiguration().ReadFrom.Configuration(config).CreateLogger();

var orderId = 42;
Log.Debug("Cache warm for {Region}", "eu-west");
Log.Information("Order {OrderId} accepted", orderId);
Log.Warning("Order {OrderId} took {Elapsed} ms", orderId, 1830);
try { throw new InvalidOperationException("Payment gateway timed out"); }
catch (Exception ex) { Log.Error(ex, "Order {OrderId} failed", orderId); }
Log.Fatal("Shutting down: {Reason}", "unrecoverable");
Log.CloseAndFlush();
```

出力は次のとおりです。

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23 ERR] Order 42 failed
[09:04:23 ERR] Order 42 failed ()
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23 FTL] Shutting down: unrecoverable
[09:04:23 FTL] Shutting down: unrecoverable ()
```

`restrictedToMinimumLevel` は"このレベル以上"という意味しかありません。1 つ目のシンクには上限がないため、`Error` と `Fatal` は両方のシンクに出力されます。`restrictedToMaximumLevel` という引数はありません。本物のフィルターか、本物の条件分岐が必要です。

## オプション 1: 1 つのシンクと、#if ブロック付きの ExpressionTemplate

`Serilog.Expressions` には `ExpressionTemplate` が含まれています。これは `ITextFormatter` で、テンプレート言語が `{#if <expr>}`、`{#else if <expr>}`、`{#else}`、`{#end}` をサポートしています。現在のレベルは `@l` です。コンソールシンクとファイルシンクには `ITextFormatter formatter` を受け取るオーバーロードがあり、設定リーダーは `type` キーを持つオブジェクトをその型のコンストラクターにバインドするため、Serilog.Settings.Configuration は JSON から直接これを構築できます。

1. パッケージを追加します。

```bash
# .NET 10 SDK; package versions as of October 2026
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Expressions --version 5.0.0
```

`Serilog.AspNetCore` 10.0.0 は、Serilog 4.x、Serilog.Settings.Configuration、コンソールシンクとファイルシンクを取り込みます。通常のコンソールアプリやワーカーアプリでは、代わりに `Serilog.Extensions.Hosting`(またはテストプロジェクトのように個別のパッケージ)を使います。

2. `outputTemplate` を `formatter` オブジェクトに置き換えます。

```json
// appsettings.json, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Console",
        "Args": {
          "formatter": {
            "type": "Serilog.Templates.ExpressionTemplate, Serilog.Expressions",
            "template": "{#if @l = 'Debug'}  dbg {@m}\n{#else if @l in ['Information', 'Warning']}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#else}[{@t:yyyy-MM-dd HH:mm:ss.fff} {@l:u3}] {@m} {Rest()}\n{#if @x is not null}{@x}{#end}{#end}"
          }
        }
      }
    ]
  }
}
```

3. 実行します。1 つのシンクから 3 種類のレイアウトが出力されます。

```text
  dbg Cache warm for eu-west
[09:04:47 INF] Order 42 accepted
[09:04:47 WRN] Order 42 took 1830 ms
[2026-10-26 09:04:47.048 ERR] Order 42 failed {"OrderId":42}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[2026-10-26 09:04:47.051 FTL] Shutting down: unrecoverable {"Reason":"unrecoverable"}
```

テンプレートの構文は従来のものとは異なるため、次の対応表で置き換えてください。

| 従来の `outputTemplate` | `ExpressionTemplate` |
| --- | --- |
| `{Timestamp:HH:mm:ss}` | `{@t:HH:mm:ss}` |
| `{Level:u3}` | `{@l:u3}` |
| `{Message:lj}` | `{@m}`(文字列は最初から引用符なしで表示されます) |
| `{Exception}` | `{@x}` |
| `{NewLine}` | JSON 文字列内のリテラルな `\n` |
| `{Properties:j}` | `{Rest()}` または `{Rest(true)}` |
| `{SourceContext}` | `{SourceContext}`(変更なし) |

この表のうち 2 点は、実際に使うときに重要です。`{NewLine}` は式テンプレートには存在しません。JSON 文字列内の `\n` は JSON のパース後に本物の改行になり、それがまさに望ましい動作なので、二重にエスケープしないでください。また、`{@x}` はすでに末尾が改行になっているため、`{@x}\n` と書くとスタックトレースの後に毎回空行が出力されます。

### コンテキストプロパティは存在するときだけ表示する

`Rest()` は、*式テンプレート*が参照していないイベントプロパティを返します。メッセージ本文に現れるプロパティも含まれるため、メッセージがすでに "Order 42" と言っているのに、上の出力に `{"OrderId":42}` が表示されています。`Rest(true)` はメッセージテンプレートで参照されているプロパティも除外します。さらに、空の `{}` が出力されないようにガードを付けることもできます。

```json
"template": "{#if @l in ['Error', 'Fatal']}[{@t:HH:mm:ss.fff} {@l:u3}] {@m}{#if Rest(true) <> {}} {Rest(true)}{#end}\n{@x}{#else}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#end}"
```

`Log.Error` の呼び出しの前後で `LogContext` に `TenantId` を追加すると、次のように出力されます。

```text
[09:05:30 DBG] Cache warm for eu-west
[09:05:30 INF] Order 42 accepted
[09:05:30 WRN] Order 42 took 1830 ms
[09:05:30.374 ERR] Order 42 failed {"TenantId":"acme"}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 13
[09:05:30.383 FTL] Shutting down: unrecoverable
```

`Fatal` の行に末尾の波括弧がないのは、唯一のプロパティである `Reason` がすでにメッセージに含まれているためです。

## オプション 2: 専用の outputTemplate を持つ 2 つのサブロガー

従来の `outputTemplate` 文字列を使い続けたい場合や、2 つのレイアウトを別々のシンク(コンソールとファイル、Seq とファイルなど)に出力する場合は、`Logger` シンクを使います。これは、専用の `Filter`、`WriteTo`、`Enrich` セクションを持つサブロガーを作成します。フィルター式も `Serilog.Expressions` が提供するもので、`ByIncludingOnly(string expression)` と `ByExcluding(string expression)` が追加されます。

1. 2 つのフィルターを互いに補完する条件にして、各イベントがちょうど 1 つのサブロガーに入るようにします。

```json
// appsettings.json, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByExcluding", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } } ]
          }
        }
      },
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByIncludingOnly", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss.fff} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}" } } ]
          }
        }
      }
    ]
  }
}
```

2. 実行します。重複はなくなり、エラー側にはミリ秒、プロパティ、例外が出力されます。

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23.840 ERR] Order 42 failed {}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23.842 FTL] Shutting down: unrecoverable {}
```

`{}` は従来の `{Properties:j}` の動作です。メッセージにまだ含まれていないプロパティだけを列挙し、ここでは該当するものがありません。`Rest(true)` と違って条件付きにはできないため、コンソール出力にはオプション 1 を選ぶ実用上の理由の 1 つになります。

### restrictedToMinimumLevel だけで足りる場合

2 つ目のレイアウトが"このレベル以上"だけで済み、*かつ*出力先が別であれば、フィルターは不要です。専用のエラーファイルが典型例です。

```json
// appsettings.json, Serilog.Sinks.File 7.0.0
{
  "Name": "File",
  "Args": {
    "path": "logs/errors-.log",
    "rollingInterval": "Day",
    "restrictedToMinimumLevel": "Error",
    "outputTemplate": "{Timestamp:o} [{Level:u3}] {Message:lj}{NewLine}{Properties:j}{NewLine}{Exception}"
  }
}
```

単純な設定で見た重複の問題は、2 つの出力が同じ場所に出力される場合にしか起きません。

## ASP.NET Core またはワーカーへの組み込み

テンプレートの選択によって、ホスティングのコードは変わりません。Serilog.AspNetCore 10.0.0 では次のようになります。

```csharp
// Program.cs, ASP.NET Core on .NET 10 / .NET 11, Serilog.AspNetCore 10.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

var app = builder.Build();
app.MapGet("/", (ILogger<Program> log) =>
{
    log.LogError("Something failed for {OrderId}", 42);
    return "ok";
});
app.Run();
```

フォーマッターは設定の中にあるため、コードに触れずに、`appsettings.Development.json` にはコンパクトな 1 行テンプレートを、`appsettings.Production.json` には JSON フォーマッターを指定できます。ブートストラップロガーとその前後の `Log.CloseAndFlush()` については、[Serilog と Seq のセットアップ記事](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)で扱っています。

## テストで見つかった落とし穴

**レベルの比較は大文字小文字を区別します。** `Error` イベントに対して `@l = 'error'` は `false` になります。`Verbose`、`Debug`、`Information`、`Warning`、`Error`、`Fatal` という正確な名前を使うか、`ci` 修飾子を付けてください。`@l = 'error' ci` はテストで `true` と評価されました。また、`{#if}` には本物の Boolean の `true` が必要で、Boolean 以外の値は"真"とは見なされません。

**サブロガーは親より詳細にはできません。** ルートの `"MinimumLevel": "Information"` に対して `configureLogger` 内で `"MinimumLevel": "Debug"` を指定しても、サブロガーは `INF` より下のレベルを何も出力しませんでした。イベントは `Logger` シンクに届く前にルートロガーで破棄されるためです。ルートの最小レベルは、どのブランチでも必要になる最も低いレベルに設定し、ブランチごとに引き上げてください。

**存在しないプロパティの周囲のテキストは残ります。** どちらのテンプレートスタイルでも、イベントに存在しないプロパティは何も表示されません。単純な設定の `({SourceContext})` は `()` と出力され、`ExpressionTemplate` では `Fatal` イベントに対して `(OrderId={OrderId})` が `(OrderId=)` と出力されました。これを直せるのは式テンプレートだけで、省略可能なプロパティを `{#if OrderId is not null} ... {#end}` で囲みます。

**不明な名前は黙って無視されます。** `Serilog.Enrichers.Environment` パッケージをインストールせずに `"Enrich": [ "WithMachineName" ]` と指定しても、例外は発生しませんでした。`Serilog.Debugging.SelfLog.Enable(Console.Error)` を有効にした後に残った唯一の痕跡は次のものです。

```text
Unable to find a method called WithMachineName. Candidate methods are:
...
```

シンク名のタイプミスや、`Serilog.Expressions` を参照していないときのフィルター名にも同じことが当てはまります。テンプレートを変更しても何も変わらないように見えたら、まず `SelfLog` を有効にしてください。

**単一ファイルで発行する場合は `Using` セクションを残してください。** Serilog.Settings.Configuration は、`.deps.json` を通じて名前に "Serilog" を含むすべての依存関係を自動検出するため、テストプロジェクトは `Using` なしでも動作しました。プロジェクトの README には、自動検出はバンドル(単一ファイル)モードでは機能しないと記載されています。そのため、`"Serilog.Expressions"` とすべてのシンクアセンブリを明示的に列挙してください。

**環境変数は配列要素をインデックスで上書きします。** レベル別テンプレートは、`WriteTo:0:Args:formatter:template` にある長い文字列です。コンテナーからこれを上書きするには `Serilog__WriteTo__0__Args__formatter__template` を使いますが、誰かが `WriteTo` の順序を入れ替えるとインデックスがずれます。環境ごとにテンプレートが異なる場合は、`appsettings.{Environment}.json` ファイルを使う方が確実です。

## どちらのオプションを選ぶか

複数のレイアウトが 1 つの出力先(通常はコンソール)を共有する場合は、`ExpressionTemplate` を使います。シンクが 1 つで、イベントを 1 回処理するだけで済み、空のプロパティバッグを隠すなど、サブロガーにはできないこともできます。レイアウトの出力先が別々のシンクである場合、異なるエンリッチャーが必要な場合、またはチーム全員が読める従来のテンプレートを好む場合は、サブロガーを使います。どちらの場合も、フィルターや条件は `@l` に対して書く必要があります。レベルをキーにしたテンプレート設定は存在しません。

## 関連記事

- Serilog がまだ組み込まれていない場合は、まず [.NET 11 での Serilog と Seq による構造化ログ](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)から始めてください。
- レベル別のレイアウトに、エラーを引き起こしたユーザーを表示するには、`LogContext` を使って[ASP.NET Core のすべてのログエントリに現在のユーザー ID を追加](/ja/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/)します。
- `Rest()` や `{Properties:j}` に現れるプロパティは機密情報を漏らす可能性があります。どのテンプレートに到達する前にも、[`[LogProperties]` で機密値をマスク](/ja/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)してください。
- `{@m}` と `{Message:lj}` は、呼び出し側がメッセージテンプレートを使っている場合にのみ構造化されたままになります。これを解決するのが、[`ILogger` の文字列補間からメッセージテンプレートへの移行](/ja/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)です。
- Serilog から OpenTelemetry へ移行する場合は、[Serilog から OpenTelemetry ログへの移行](/ja/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)を参照してください。

## 参考資料

- [Serilog.Expressions README](https://github.com/serilog/serilog-expressions): `ExpressionTemplate`、組み込みの `@l` / `@x`、`#if` / `#else if`、`Rest([deep])`、`ci` 修飾子。
- [Serilog.Settings.Configuration README](https://github.com/serilog/serilog-settings-configuration): `Using` と自動検出(バンドルモードでの制限を含む)、`type` を使った複合的な `formatter` のバインド、サブロガーの設定。
- [Serilog wiki: Configuration Basics](https://github.com/serilog/serilog/wiki/Configuration-Basics): サブロガーと、親の最小レベルを下げられない理由。
- [Serilog.Sinks.Console](https://github.com/serilog/serilog-sinks-console) と [Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file): `outputTemplate`、`formatter`、`restrictedToMinimumLevel` の各パラメーター。
- [Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore): `ReadFrom.Configuration` と `ReadFrom.Services` を使った `AddSerilog`。
