---
title: "解決: CA1873 \"Evaluation of this argument may be expensive and unnecessary if logging is disabled\""
description: "CA1873 は暗黙の params object[] 配列に反応するため、ほぼすべての LogDebug 呼び出しで発生します。[LoggerMessage] か IsEnabled ガードで解決します。"
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "logging"
  - "analyzers"
  - "performance"
lang: "ja"
translationOf: "2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled"
translatedBy: "claude"
translationDate: 2026-08-18
---

CA1873 は .NET 10 SDK で**提案 (suggestion)** として有効化されているパフォーマンス アナライザーであり、警告ではありません。そのため Visual Studio、Rider、`dotnet format` には表示されますが、`dotnet build` の出力はきれいなままです。反応する対象は、`ILogger.LogDebug` 形式の呼び出しがすべて確保する暗黙の `params object?[]` 配列です。つまり、引数が 1 つでもある構造化ログ呼び出しであれば、たとえ単純な文字列であってもほぼ確実に発生します。本質的な解決策は `[LoggerMessage]` によるソース生成で、手早い解決策は呼び出しとレベルが完全に一致する `IsEnabled` ガードです。

探している診断テキストは次のとおりです。

```text
warning CA1873: Evaluation of this argument may be expensive and unnecessary if logging is disabled
```

以下の内容はすべて SDK `10.0.201`、`Microsoft.Extensions.Logging` 10.0.0、C# 14 で検証し、アナライザーのソースコードは `dotnet/sdk` から読み取りました。

## CA1873 が dotnet build で見えないのはどういう仕組みですか?

.NET 10 での既定の重大度が提案 (info) であり、info レベルの診断は `dotnet build` では出力されず、`TreatWarningsAsErrors` の影響も受けないからです。

`LogDebug` 呼び出しが 12 個あるプロジェクトでも、ビルドは完全にきれいに通ります。

```text
    0 Warning(s)
    0 Error(s)
```

本物の警告に変えるには、次の 2 つのいずれかを使います。

```xml
<!-- .NET 10 SDK 10.0.201: promotes every "All"-mode analyzer, CA1873 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, targeted at just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = warning
```

同じプロジェクトが今度は CA1873 の警告を 12 件報告します。アナライザーの重大度を CI に組み込む場合のトレードオフは、[開発ビルドを壊さずに TreatWarningsAsErrors を使う方法](/ja/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)で扱っています。

## 明らかに軽い引数でも CA1873 が発生するのはどうしてですか?

ここが検索エンジンに人を向かわせる部分です。このルールは引数だけを見ているわけではありません。その引数を渡すためにコンパイラーが生成する**暗黙の `params object?[]` 配列**を見ており、空でない配列の生成それ自体が高コストとして報告されます。

`LoggerExtensions.LogDebug` には、メッセージ引数を受け取る params なしのオーバーロードが存在しません。

```csharp
// Microsoft.Extensions.Logging.Abstractions 10.0.0
public static void LogDebug(this ILogger logger, string? message, params object?[] args);
```

そのため `_logger.LogDebug("v {V}", x)` は、`x` が何であるかに関係なく `object[1]` の確保にコンパイルされます。アナライザーのコスト判定は、配列が空でない限り、あらゆる配列生成を違反として扱います。

```csharp
// dotnet/sdk, AvoidPotentiallyExpensiveCallWhenLogging.cs
static bool IsEmptyImplicitParamsArrayCreation(IArrayCreationOperation arrayCreationOperation) =>
    arrayCreationOperation.IsImplicit &&
    arrayCreationOperation.DimensionSizes.Length == 1 &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.HasValue &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.Value is int size &&
    size == 0;
```

実際に何が引き金になるのかを確かめるため、マトリクスを作成しました。次のいずれも SDK 10.0.201 で CA1873 を発生させました。

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Logging.Abstractions 10.0.0
public void StringProp(Order o) => _logger.LogDebug("v {V}", o.Name);      // CA1873
public void IntProp(Order o)    => _logger.LogDebug("v {V}", o.Id);        // CA1873
public void StringField()       => _logger.LogDebug("v {V}", _nameField);  // CA1873
public void StringLocal()       { var s = "a"; _logger.LogDebug("v {V}", s); }  // CA1873
public void StringParam(string s) => _logger.LogDebug("v {V}", s);         // CA1873
public void ConstInt()          => _logger.LogDebug("v {V}", 42);          // CA1873
```

免れるのはメッセージ引数がまったくない呼び出しだけです。その場合にかぎり暗黙の params 配列の長さがゼロになります。

```csharp
public void LiteralOnly() => _logger.LogDebug("nothing to see");           // clean
```

驚きの正体はこれだけです。`o.Name` に問題はありません。2025 年 11 月の "Reduce noise from CA1873" という変更では、プロパティ アクセス、`GetType`、`GetHashCode`、`Stopwatch.GetTimestamp` がコスト判定から明示的に除外されましたが、この除外が効くのは配列の*要素*に対してであり、配列の確保そのものは依然として報告されます。params ベースのオーバーロードでは、このノイズ削減は目に見えません。

## 最小の再現コードは?

```csharp
// .NET 10 (SDK 10.0.201), C# 14
// dotnet new console + Microsoft.Extensions.Logging.Abstractions 10.0.0
using Microsoft.Extensions.Logging;

public class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order)
    {
        // CA1873: Evaluation of this argument may be expensive
        // and unnecessary if logging is disabled
        logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
    }
}
```

`<AnalysisMode>All</AnalysisMode>` または `.editorconfig` での明示的な重大度指定があれば、この 1 つの呼び出しだけで CA1873 が報告されます。

## CA1873 を正しく解決するには?

`[LoggerMessage]` ソースジェネレーターを使います。params 配列もボックス化もない厳密に型付けされたメソッドが生成されるため、アナライザーが指摘する対象も、レベルが無効なときにランタイムが確保するものも残りません。

```csharp
// .NET 10, C# 14. The class must be partial.
public partial class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order) => LogOrder(order.Id, order.Customer);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Order {OrderId} for {Customer}")]
    private partial void LogOrder(int orderId, string customer);
}
```

生成されたメソッドは引数に触れる前に `IsEnabled` を確認するため、アナライザーは沈黙し、Debug が無効なときの呼び出しコストはゼロになります。これは [new Regex(...) を GeneratedRegex ソースジェネレーターに置き換える](/ja/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/)のと同じ仕組みです。このパターンに馴染みがなければ、[ソースジェネレーターとは何か、いつ必要になるのか](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)から始めてください。

## IsEnabled ガードで十分なのはどんなときですか?

1 行の変更で済ませたく、クラスを partial 型に作り替えたくない場合です。アナライザーはこのガードを認識し、診断を抑制します。

```csharp
// .NET 10, C# 14
if (logger.IsEnabled(LogLevel.Debug))
{
    logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
}
```

制約が 2 つあり、どちらも違反すると診断が出ることを確認しました。

**レベルは完全に一致する必要があります。** `LogDebug` を `IsEnabled(LogLevel.Information)` で囲んでも CA1873 は報告され続けます。アナライザーがガード内の定数と呼び出しのレベルを比較しているためです。

```csharp
if (logger.IsEnabled(LogLevel.Information))
{
    logger.LogDebug("v {V}", order.Describe());   // CA1873, levels differ
}
```

**ガードはインラインでなければなりません。** プロパティやヘルパー メソッドの背後に追い出すと、この判定は完全に無効になります。アナライザーは外側の操作をたどって、文字どおりの `ILogger.IsEnabled` 呼び出しを探しているからです。

```csharp
private bool DebugOn => logger.IsEnabled(LogLevel.Debug);

public void Process(Order order)
{
    if (DebugOn) { logger.LogDebug("v {V}", order.Describe()); }   // CA1873
}
```

## ガードなしの呼び出しは実際どれくらいのコストですか?

ホットパスでは無視できず、それ以外ではまったく問題にならない程度です。BenchmarkDotNet 0.15.4、.NET 10.0.5、Intel Core Ultra 7 265KF で、最小レベルを `Information` に設定して Debug 呼び出しを無効にした状態で測定しました。

| メソッド | 平均 | Ratio | 確保量 |
| --- | ---: | ---: | ---: |
| Unguarded | 13.22 ns | 1.00 | 64 B |
| Guarded | 0.27 ns | 0.02 | 0 B |
| SourceGenerated | 0.51 ns | 0.04 | 0 B |

64 バイトの内訳は `object[2]` 配列とボックス化された `int` です。どちらの解決策でもゼロになります。ナノ秒だけでなく比率にも注目してください。呼び出しあたり 13 ns は、データベース クエリを実行するリクエスト ハンドラーでは無意味ですが、100 万回まわるループでは大いに意味を持ちます。このルールが警告ではなく提案として出荷されているのは、まさにそのためです。

## CA1873 はどのログレベルを検査しますか?

既定では Information 以下です。アナライザー自身のコミット履歴に記された設計上の根拠によれば、ホットパスは Debug と Trace に記録する一方、Warning と Error は十分にまれなので呼び出しごとのオーバーヘッドは問題にならない、という考え方です。

しきい値を変更する、文書化されていない `.editorconfig` のスイッチもあります。

```ini
# Not listed on the CA1873 docs page. Values: trace, debug, information, warning, error, critical
[*.{cs,vb}]
dotnet_code_quality.CA1873.max_log_level = warning
```

SDK 10.0.201 で全値を試すと次のようになり、バグが露呈します。

| `max_log_level` | CA1873 が報告されるレベル |
| --- | --- |
| `trace` | Trace, **Critical** |
| `debug` | Trace, Debug, **Critical** |
| `information` (既定) | Trace, Debug, Information, **Critical** |
| `warning` | Trace, Debug, Information, Warning, Critical |
| `error` | 6 つすべて |

`LogCritical` は `trace` を含むあらゆるしきい値で報告されます。これは 1 つずれ (off-by-one) の不具合で、出荷された比較式が早期リターンの範囲から Critical を除外してしまっています。

```csharp
// dotnet/sdk commit 574cda32, "CA1873: Fix log level comparison"
-                    logLevel < LogLevelCritical &&
+                    logLevel <= LogLevelCritical &&
```

この修正が `dotnet/sdk` に入ったのは 2026-06-19 で、SDK 10.0.201 の出荷後です。修正を含む SDK に移行するまでは、`max_log_level` をどう設定しても `LogCritical` の呼び出しは CA1873 を報告し続けます。ルール全体を無効化するのではなく、個別に抑制してください。

## 既知の誤検知: ガードで囲まれた生成済み呼び出し

ソース生成されたログ メソッドを `IsEnabled` の判定で囲んでも、アナライザーは CA1873 を報告します。これはアナライザーに対する未解決の issue として登録されており、SDK 10.0.201 で再現します。

```csharp
// .NET 10, C# 14. Guarded, source-generated, still reports CA1873.
if (logger.IsEnabled(LogLevel.Information))
{
    LogKeys([.. dictionary.Select(p => p.Key)]);
}

[LoggerMessage(Level = LogLevel.Information, Message = "keys {Keys}")]
private partial void LogKeys(string[] keys);
```

ガードが有効に働くのは、認識済みの `ILogger` 呼び出しを囲んでいるときだけです。アナライザーから見れば生成されたメソッドはごく普通のメソッドなので、コレクション式の引数はそれ単体で評価され、指摘されます。修正が出荷されるまでは局所的に抑制してください。

```csharp
#pragma warning disable CA1873
    LogKeys([.. dictionary.Select(p => p.Key)]);
#pragma warning restore CA1873
```

## 間違えてこのページに来やすい類似ルール

**CA1848** ("For improved performance, use the LoggerMessage delegates") は同じ呼び出し箇所で発生し、解決策も同じですが、対象は引数の評価ではなく、呼び出しごとのメッセージ テンプレート解析コストです。通常は両方が同時に出て、`[LoggerMessage]` で両方とも解消します。

**CA2254** ("The logging message template should not vary between calls") は、文字列補間が構造化フィールドを壊してしまう問題を扱います。追いかけている本題がそちらであれば、[ILogger の文字列補間からメッセージ テンプレートへの移行](/ja/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)を参照してください。`SkipEnabledCheck` と `[LogProperties]` も扱っています。

## いっそ無効にすべきですか?

リクエスト経路で Information に記録していて、実測されたホットループを持たないコードベースであれば、無効で構いません。`none` に設定し、ログのオーバーヘッドが効いているとプロファイルが示した時点で見直してください。

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = none
```

より有用な中間策は、既定の提案レベルのままにして `[LoggerMessage]` を機会があるたびに適用していくことです。触れた呼び出し箇所で IDE の後押しを受けられ、CI にノイズは出ず、確保ゼロのログが 400 ファイルのリファクタリングとしてまとめて来るのではなく時間をかけて積み上がります。確保量の削減は本物ですが、急ぐ話ではありません。その背後にある params 配列は、C# 13 が[他の API について取り除き始めた](/ja/2026/01/c-13-the-end-of-params-allocations/)ものと同じです。

## 関連記事

- [.NET 11 で ILogger の文字列補間から構造化ログのメッセージ テンプレートへ移行する](/ja/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)
- [.NET で LogProperties を使ってログから機密値を伏せる方法](/ja/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [ソースジェネレーターとは何か、いつ必要になるのか?](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [開発ビルドを壊さない TreatWarningsAsErrors (.NET 10)](/ja/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [C# 13: params の確保の終わり](/ja/2026/01/c-13-the-end-of-params-allocations/)

## 参考資料

- MS Learn の [CA1873: Avoid potentially expensive logging](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1873)
- [Add CA1873: Avoid potentially expensive logging](https://github.com/dotnet/roslyn-analyzers/pull/7290)、アナライザーの元の PR
- [Reduce noise from CA1873](https://github.com/dotnet/sdk/commit/bb4aee4d)、`max_log_level` オプションとプロパティ アクセスの除外を追加したコミット
- [CA1873: Fix log level comparison](https://github.com/dotnet/sdk/commit/574cda32)、`LogCritical` の 1 つずれの修正
- [ログ メッセージを IsEnabled の判定で囲んだときの CA1873 誤検知](https://github.com/dotnet/roslyn-analyzers/issues/7690)
- [LoggerMessageAttribute API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.logging.loggermessageattribute)
