---
title: ".NET 11 で ILogger の文字列補間から構造化ログのメッセージテンプレートへ移行する"
description: "$ 補間を使った ILogger 呼び出しを、メッセージテンプレートと [LoggerMessage] によるソース生成メソッドへ .NET 11 で置き換える手順: 何が壊れるか、CA2254 でコードベースを一掃する方法、JSON の State を検証する方法、ロールバックの手順。"
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "logging"
  - "observability"
lang: "ja"
translationOf: "2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-25
---

コードベースにある `_logger.LogInformation($"Order {orderId} failed for {customerId}")` は、アラートが鳴ったときにまさに必要になる 2 つのフィールドを捨てています。この記事では、.NET 11 のコードベース (SDK 11.0.100-preview.6、C# 14) を補間されたログ呼び出しからメッセージテンプレートへ変換し、続いてホットパスを `[LoggerMessage]` によるソース生成メソッドへ変換します。中規模のサービスであれば、テンプレートの一掃は CA2254 に導かれたほぼ機械的な編集で半日、ソースジェネレーターの工程はきちんとやればもう 1 日です。危険な要素はありません。修正は破壊的変更ではなく、各手順は個別に元へ戻せます。そして見返りとして、ログのバックエンドがレンダリング済みの文章を grep する代わりに、ようやく `OrderId` で絞り込めるようになります。

## 補間が本当に必要なデータを失う理由

- **ロガーが見る前に構造が消えています。** `$"Order {orderId} failed"` は呼び出し箇所で `string.Concat` または `DefaultInterpolatedStringHandler` の呼び出しにコンパイルされます。`ILogger.Log` が動く時点で `orderId` というプロパティは存在せず、1 つの文があるだけです。ログの State にある `{OriginalFormat}` は完全にレンダリングされたテキストを保持することになるため、注文 ID が違うたびに集約基盤側では別々の「テンプレート」になります。
- **カーディナリティが間違った場所で爆発します。** Seq、Loki、Elastic、そしてあらゆる OTLP バックエンドは、テンプレートと名前付きプロパティでグループ化とインデックス作成を行います。補間された呼び出しは呼び出しごとに一意なテンプレートを生み出し、それはこれらのシステムがもっとも苦手とする形です。
- **レベルがオフでも文字列は組み立てられます。** `_logger.LogDebug($"Payload: {Serialize(request)}")` は本番環境で `Debug` が無効でも、リクエストごとに文字列を割り当てて `Serialize` を実行します。Microsoft 自身の[ライブラリ作成者向けガイダンス](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance)がこれを明示しています。`LoggerExtensions` に補間文字列ハンドラーのオーバーロードを追加する提案 ([dotnet/runtime#111283](https://github.com/dotnet/runtime/issues/111283)) は not planned として閉じられているため、この状況が勝手に改善されることはありません。
- **データ内の波かっこが例外を投げることがあります。** 詳しくは後半で触れますが、値に `{` や `}` を含む補間文字列は、ログ出力のパイプライン内部から `FormatException` を投げる可能性があります。

ログの送り先をまだ決めていないなら、先にそこを片付けてください。[Serilog と Seq による構造化ログ](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) と [.NET 11 と無料バックエンドでの OpenTelemetry](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) は、いずれもこの記事のテンプレートがすでに正しいことを前提にしています。

## 2 つの書き方が実際に生成するもの

これが最小の再現コードです。意図は同じで呼び出しスタイルが 2 通り、.NET 11 の `JsonConsole` フォーマッターを通しています。

```csharp
// .NET 11 preview 6, C# 14
int orderId = 4711;
string customerId = "acme-inc";

// Interpolated: the template IS the rendered sentence.
_logger.LogInformation($"Order {orderId} failed for {customerId}");

// Message template: placeholders survive as named properties.
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", orderId, customerId);
```

1 つ目の呼び出しは、役に立たないエントリーが 1 つだけの State を出力します。

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "{OriginalFormat}": "Order 4711 failed for acme-inc"
  }
}
```

2 つ目の呼び出しはフィールドを出力します。

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "OrderId": 4711,
    "CustomerId": "acme-inc",
    "{OriginalFormat}": "Order {OrderId} failed for {CustomerId}"
  }
}
```

レンダリングされた `Message` は同一です。ログをクエリ可能にする要素はすべて、この差分の中にあります。

## 何が壊れるか

| 領域 | 変更点 | 深刻度 |
| --- | --- | --- |
| `$"..."` を使う呼び出し箇所 | 定数テンプレートと引数に書き換える必要がある | 高 (量の問題であってリスクではない) |
| ログのクエリとダッシュボード | レンダリング済みテキストに一致する保存済み検索はそのまま動く。プロパティによる新しいフィルターは作り直しが必要 | 中 |
| `{OriginalFormat}` を条件にしたアラート規則 | テンプレート文字列が変わるため、古いレンダリング済みテキストとの完全一致規則が一致しなくなる | 中 |
| テンプレート内の文字列連結 | `"Order " + id + " failed"` も同じ欠陥で、同じ規則が検出する | 中 |
| `[LoggerMessage]` への変換 | 含んでいるクラスとメソッドを `partial` にする必要がある。メソッドは `void` を返す必要がある | 低 |
| `EventId` の値 | アセンブリ内で ID が重複するとジェネレーターの警告が出る | 低 |
| Serilog の `@` によるデストラクチャリング | `{@Order}` の意味は `Microsoft.Extensions.Logging` の State 列挙とは異なる | 低 |

いずれも実行時の破壊的変更ではありません。この一掃を主導する Roslyn の規則 [CA2254](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254) は、破壊的でない修正として明示的に文書化されています。

## 事前チェックリスト

- .NET SDK 11.0.100-preview.6 以降がインストールされていること (`dotnet --list-sdks`)。この記事の内容は .NET 8、9、10 でも動きます。
- `<LangVersion>` が 9 以上であること。`[LoggerMessage]` ジェネレーターは C# 9 未満では動作を拒否します。.NET 11 では既定で C# 14 になります。
- `[LoggerMessage]` メソッドを宣言するすべてのプロジェクトで `Microsoft.Extensions.Logging.Abstractions` を参照していること。`Microsoft.NET.Sdk.Web` を使うプロジェクトは推移的に取得します。
- `Directory.Build.props` に `<EnableNETAnalyzers>true</EnableNETAnalyzers>` と `<AnalysisLevel>latest</AnalysisLevel>` があること。そうでなければ CA2254 は一度も発火しません。
- 開始前にクリーンな `git status` とグリーンなテスト実行。この一掃は数百行に触れるので、簡単に元へ戻せる状態が欲しくなります。

## 移行手順

順番が重要です。まずアナライザーに騒がせ、見つかったものをすべて直し、そのうえでメモリ割り当てが実際にコストになっているパスにだけソースジェネレーターを持ち込みます。

1. **CA2254 をビルドエラーにします。** まず `.editorconfig` に `warning` として規則を追加し、影響範囲を確認してから、件数がゼロになった時点で `error` へ引き上げます。検証: 初回実行時に `dotnet build` が 0 でない CA2254 の件数を報告すること。
2. **補間および連結された呼び出しをメッセージテンプレートへ変換します。** 値をすべて文字列の外へ出して引数として渡し、プレースホルダー名は PascalCase にします。検証: `dotnet build` の CA2254 の診断がゼロになること。
3. **引数の順序を直します。バインドは位置ベースです。** `LoggerExtensions` は引数をプレースホルダーへ左から順にバインドし、名前では対応させません。検証: アプリを実行し、JSON の State の各プロパティが名前どおりの値を保持していることを確認すること。
4. **ホットパスに `[LoggerMessage]` メソッドを追加します。** リクエストごと、要素ごとのログ呼び出しを `partial` クラス上の `partial` メソッドへ変換し、テンプレートをコンパイル時に一度だけ解析させます。検証: `dotnet build` がクリーンで、生成ファイルが `obj/**/Microsoft.Extensions.Logging.Generators/` に現れること。
5. **メッセージごとに安定した `EventId` を割り当て、重複させません。** 検証: ビルドログにイベント ID 重複の `SYSLIB` 警告が出ないこと。
6. **引数の評価が高価な箇所では `SkipEnabledCheck` と手動のガードを使います。** 検証: カテゴリーを `Information` にして、高価な呼び出しが実行されないことを確認すること。
7. **オブジェクトは `ToString()` ではなく `[LogProperties]` で展開します。** 検証: オブジェクトのパブリックプロパティが、1 つに潰れた文字列ではなく個別のエントリーとしてログの State に現れること。

### 1. CA2254 をビルドエラーにする

CA2254 は .NET 10 以降では既定で提案として有効になっており、つまり CI 上では見えません。格上げしましょう。

```ini
# .editorconfig -- .NET 11, analyzers at latest
[*.{cs,vb}]

# CA2254: Template should be a static expression
dotnet_diagnostic.CA2254.severity = warning
```

ビルドして、扱う量を数えます。

```bash
dotnet build -warnaserror:CA2254 --no-incremental
```

CA1848 はまだ有効にしないでください。この規則はコードベース内のすべての `LogInformation` 呼び出しに対して、正しいものも含めて発火し、CA2254 のシグナルを埋もれさせます。手順 4 で戻ってきます。

### 2. メッセージテンプレートへ変換する

よくある 3 つの形での機械的な変換です。

```csharp
// .NET 11, C# 14 -- before
_logger.LogInformation($"Order {order.Id} failed for {order.CustomerId}");
_logger.LogWarning("Retry " + attempt + " of " + maxAttempts);
_logger.LogError(ex, $"Import of {file.Name} aborted after {sw.ElapsedMilliseconds} ms");

// after
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", order.Id, order.CustomerId);
_logger.LogWarning("Retry {Attempt} of {MaxAttempts}", attempt, maxAttempts);
_logger.LogError(ex, "Import of {FileName} aborted after {ElapsedMs} ms", file.Name, sw.ElapsedMilliseconds);
```

あとで元が取れる命名規則が 3 つあります。

- プレースホルダーは PascalCase にします。Microsoft 自身のガイダンスもこれを推奨しており、手書きのテンプレートと生成されたテンプレートの間でプロパティ名が揃います。
- 同じ概念にはどこでも同じ名前を付けます。あるサービスで `OrderId` なら全サービスで `OrderId` です。そうでないと、サービス横断のクエリは表記ごとに `or` 句が必要になります。
- 例外は決してテンプレートに入れません。`LogError(ex, "...")` は専用の `Exception` パラメーター経由で渡し、表示方法はプロバイダーが決めます。

### 3. 引数のバインドは名前ではなく位置

この一掃が持ち込みうる唯一のバグであり、CA2254 は捕まえてくれません。

```csharp
// .NET 11 -- compiles, no analyzer warning, WRONG
_logger.LogInformation("Order {OrderId} for {CustomerId}", customerId, orderId);
```

`Microsoft.Extensions.Logging` はプレースホルダーを引数へ順番に対応付けます。名前は生成されるプロパティのラベルであって、バインドのキーではありません。ログ行は顧客 ID を `OrderId` として出力し、3 週間後にクエリが意味不明な結果を返すまで誰も気づきません。変換した行はこの失敗パターンだけを念頭に一度読み返し、一括の検索と置換の結果を鵜呑みにするより、メソッド単位で変換することをおすすめします。

手順 4 の `[LoggerMessage]` ジェネレーターにはこの問題がありません。テンプレートのプレースホルダーとパラメーター名を大文字小文字を区別せずに突き合わせるため、そこではパラメーターの順序は関係ありません。

### 4. ホットパスに [LoggerMessage] を追加する

メッセージテンプレートは構造を直しました。呼び出しごとのコストは直していません。`LoggerExtensions.LogInformation` は依然として値型を `object` にボックス化し、`params object?[]` を割り当て、呼び出しのたびにテンプレートを解析し直します。[`[LoggerMessage]` ソースジェネレーター](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)は、コンパイル時に強く型付けされた `LoggerMessage.Define` のラッパーを出力することで、この 3 つをすべて取り除きます。

```csharp
// .NET 11 preview 6, C# 14
using Microsoft.Extensions.Logging;

public partial class OrderProcessor(ILogger<OrderProcessor> logger, OrderPipeline pipeline)
{
    public async Task ProcessAsync(Order order, CancellationToken ct)
    {
        try
        {
            await pipeline.RunAsync(order, ct);
            OrderProcessed(order.Id, order.CustomerId);
        }
        catch (PaymentDeclinedException ex)
        {
            OrderFailed(ex, order.Id, order.CustomerId);
        }
    }

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "Order {OrderId} processed for {CustomerId}")]
    private partial void OrderProcessed(int orderId, string customerId);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Warning,
        Message = "Order {OrderId} failed for {CustomerId}")]
    private partial void OrderFailed(Exception ex, int orderId, string customerId);
}
```

.NET 9 以降、ジェネレーターはプライマリコンストラクターのパラメーターからも `ILogger` を読み取ります。上の例に明示的な `_logger` フィールドがないのはそのためです。フィールドとプライマリコンストラクターのパラメーターが両方ある場合はフィールドが優先されます。

覚えておく価値のある制約は[ソース生成のドキュメント](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator)にあります。メソッドは `partial` で `void` を返す必要があり、メソッド名もパラメーター名もアンダースコアで始めてはいけません。パラメーターは `params`、`scoped`、`out` を使えず、`ref struct` 型にもできません。静的メソッドは `ILogger` をパラメーターとして受け取る必要があり、`this` を付ければ拡張メソッドになります。

変換済みのプロジェクトでは、残りを埋め尽くさないよう範囲を絞って CA1848 を有効にします。

```ini
# .editorconfig, in the hot-path project folder only
[*.cs]
# CA1848: Use the LoggerMessage delegates
dotnet_diagnostic.CA1848.severity = warning
```

CA1848 は .NET 10 以降でも既定では有効になっておらず、意図的に厳しい規則です。`LogInformation` 系の呼び出しをすべて指摘します。本当にすべてのメッセージをソース生成するつもりでない限り、ソリューション全体ではなくプロジェクト単位で有効にしてください。

### 5. イベント ID を安定かつ一意に保つ

`EventId` はログメッセージの安定した識別子です。テンプレートの文言変更にも耐えるため、アラート規則が拠り所にすべきものです。衝突が見えるように、アセンブリごとに 1 か所へまとめます。

```csharp
// .NET 11 -- one file, one range per subsystem
internal static class LogEvents
{
    public const int OrderProcessed = 1001;
    public const int OrderFailed    = 1002;
    public const int PaymentRetried = 1003;
}
```

ジェネレーターはクラス内でのイベント ID の重複を警告します。クラスをまたぐ重複は警告しないので、この定数ファイルは実際に仕事をしています。

### 6. 高価な引数には SkipEnabledCheck

既定では生成されたメソッドは何かをする前に `ILogger.IsEnabled` を呼ぶため、無効なレベルのコストは仮想呼び出し 1 回です。ただし、呼び出し側が引数を計算するのを止めることはできません。引数が高価な場合はガードを外へ持ち上げます。

```csharp
// .NET 11, C# 14
[LoggerMessage(
    EventId = 2001,
    Level = LogLevel.Debug,
    Message = "Request body: {Body}",
    SkipEnabledCheck = true)]
private partial void RequestBody(string body);

// call site
if (logger.IsEnabled(LogLevel.Debug))
{
    RequestBody(await SerializeAsync(request, ct));  // only runs when Debug is on
}
```

これが、補間された `LogDebug` 呼び出しが静かに奪っていたスループットを取り戻すパターンです。

### 7. [LogProperties] でオブジェクトを展開する

`Order` パラメーターに対する `Message = "Processing {Order}"` は、`ToString()` の出力を保持するプロパティを 1 つ与えるだけです。オブジェクトのフィールドを別々のプロパティとして得るには、`Microsoft.Extensions.Telemetry.Abstractions` を追加してパラメーターに注釈を付けます。

```csharp
// .NET 11, Microsoft.Extensions.Telemetry.Abstractions
[LoggerMessage(
    EventId = 1004,
    Level = LogLevel.Information,
    Message = "Processing order")]
private partial void ProcessingOrder([LogProperties] Order order);
```

`Order` のパブリックプロパティはそれぞれ `order.Id`、`order.CustomerId` のようにログの State に入ります。同じパッケージが分類済みパラメーターの秘匿も可能にしており、メールアドレスを含むリクエストオブジェクトのログ出力を頼まれたときの正解はこれです。

## 検証

このチェックリストは最後に 1 回ではなく、各フェーズのあとで実行してください。

- `dotnet build -warnaserror:CA2254` が終了コード 0 で終わること。
- `dotnet test` が新たな失敗なしで通ること。レンダリング済みのログテキストをアサートするテストが典型的な犠牲者です。State のプロパティをアサートする形に書き直してください。
- コンソールのフォーマッターを JSON に切り替え (`appsettings.Development.json` の `"Console": { "FormatterName": "json" }`)、代表的なエンドポイントを 1 つ叩いて、出力された `State` オブジェクトを読みます。気にしている値はすべて独立したキーとして現れ、`{OriginalFormat}` はデータではなくプレースホルダーを含んでいる必要があります。
- ビルド出力を `SYSLIB1015` (対応するプレースホルダーのないパラメーター) と `SYSLIB0025` (テンプレートに含まれた例外) で grep します。どちらも抑制ではなく修正すべき警告です。
- 生成されたソースが存在することを確認します: `obj/Debug/net11.0/generated/Microsoft.Extensions.Logging.Generators/`。フォルダーが空なら、属性が `partial` でないメンバーに付いていて、ジェネレーターは黙って何も有用なことをしていません。
- ステージングへデプロイしてログ量を比較します。変わらないはずです。減っていれば、どこかのレベルのガードを誤って厳しくしています。

## ロールバック計画

各手順は `git revert` で個別に元へ戻せますし、公開 API やワイヤーフォーマットを変える手順はありません。ただし声を大にして言っておくべき注意点が 1 つあります。ログのバックエンドが新しいプロパティ名のインデックス作成を始めた時点で、それに基づくダッシュボードとアラートはコードを戻すと壊れます。先にコードを戻し、あとからダッシュボードを戻してください。順序を選べるように、2 つの変更は別々のコミットに保ちます。

`.editorconfig` の深刻度の引き上げは、コード変更を戻す場合でも残しておく価値があります。CA2254 を `warning` のままにしておけば、検討している間に新しい補間呼び出しが入り込むのを防げます。

## 実際にはまった落とし穴

**データ内の波かっこが FormatException を投げます。** 補間形式には、多くのチームが最初に本番で出会う失敗モードがあります。`Microsoft.Extensions.Logging` は `message` 引数を書式文字列として扱い、`LogValuesFormatter` に通します。これは `{Name}` を `{0}` に書き換えて `string.Format` を呼びます。補間の結果に波かっこが含まれていると、たとえば JSON のペイロードをログ出力した場合、フォーマッターは対応する引数のないプレースホルダーを見て例外を投げます (`aspnet/Logging#351` が定番の報告です)。メッセージテンプレートはこれに影響されません。JSON は引数であり、決して書式文字列の一部にはならないからです。

```csharp
// .NET 11 -- throws FormatException at runtime when json contains { }
_logger.LogInformation($"Response: {json}");

// safe
_logger.LogInformation("Response: {Json}", json);
```

**Serilog の `{@Property}` は Microsoft.Extensions.Logging の機能ではありません。** Serilog を使っているなら、`{@Order}` はオブジェクトを構造化された値へデストラクチャリングします。`[LoggerMessage]` ジェネレーターはそのテンプレートを受け付けますが、`@` は `Serilog.Extensions.Logging` が処理する Serilog の慣習です。素の OTLP やコンソールのプロバイダーで何かをしてくれると考えてはいけません。プロバイダーに依存しない展開が欲しいときは `[LogProperties]` を使ってください。

**ログのテキストをアサートするテスト。** `Assert.Contains("Order 4711 failed", sink.Messages)` は移行中もそのまま通ります。レンダリングされたメッセージが変わらないからです。これは罠です。つまり、テストがプロパティの存在を一度も証明しないままコードベースを変換できてしまいます。State のキーをアサートするテストを、サブシステムごとに最低 1 つ追加してください。

**EF Core 自身のログはすでにテンプレート化されています。** これを「修正」しないでください。プロバイダーから読みやすい SQL を得たいのであれば、[EF Core 11 が生成する SQL をログ出力する](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)のは呼び出し箇所ではなく設定の問題です。

**バックエンドの移行は別の仕事です。** 呼び出し箇所を変換してもログはどこにも移動しません。OTLP が行き先なら、まずこの移行でテンプレートを正しくしてから、[Serilog から OpenTelemetry のログ出力へ移行する](/ja/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)手順に進んでください。両方を同時にやると、どちらの変更がダッシュボードを壊したのか判断できなくなります。

## 参考資料

- [コンパイル時のログソース生成](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator)、Microsoft Learn
- [.NET の高パフォーマンスなログ出力](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/high-performance-logging)、Microsoft Learn
- [.NET ライブラリ作成者向けのログ出力ガイダンス](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance)、Microsoft Learn
- [CA2254: テンプレートは静的な式であるべき](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254)、Microsoft Learn
- [CA1848: LoggerMessage のデリゲートを使う](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1848)、Microsoft Learn
- [API 提案: ILogger 拡張への補間文字列オーバーロード](https://github.com/dotnet/runtime/issues/111283)、dotnet/runtime、not planned として終了
- [LogInformation(string) が FormatException を投げる](https://github.com/aspnet/Logging/issues/351)、aspnet/Logging
- [.NET 11 Preview 6 が公開されました](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/)、.NET Blog
