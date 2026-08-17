---
title: ".NET で LogProperties とデータレダクションを使ってログから機微な値を伏せる方法"
description: "ソースジェネレーターが生成するログで分類済みデータをレダクションする完全ガイドです。タクソノミーの構築、Redactor の実装、EnableRedaction と AddRedaction の配線、そして部分マスクを静かに壊すディスクリミネーターまでを扱います。Microsoft.Extensions.Compliance.Redaction 10.9.0 の実際の出力付きです。"
pubDate: 2026-08-17
template: how-to
tags:
  - "dotnet"
  - "logging"
  - "security"
  - "source-generators"
lang: "ja"
translationOf: "2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet"
translatedBy: "claude"
translationDate: 2026-08-17
---

.NET のログで機微な値をレダクションするには、3 つの構成要素がすべて揃っている必要があります。プロパティに付けるデータ分類属性、DI に Redactor を登録する `AddRedaction`、そしてログビルダー上の `EnableRedaction` です。分類を忘れると何も保護されません。`EnableRedaction` を忘れると、分類済みの値は構造化状態から完全に取り除かれます。`EnableRedaction` を有効にしたまま `AddRedaction` を忘れると、生の値が平文でログに書き込まれます。この記事ではこの 3 つに加えて、部分マスクを行う Redactor を静かに壊してしまうレダクションのディスクリミネーターについて解説します。

以下の内容はすべて、`Microsoft.Extensions.Compliance.Redaction` 10.9.0、`Microsoft.Extensions.Compliance.Abstractions` 10.9.0、`Microsoft.Extensions.Telemetry` 10.9.0 に対して、.NET 10.0.201 SDK で `net10.0` をターゲットにコンパイルおよび実行して確認しました。これらのパッケージはランタイムではなく `dotnet/extensions` のリリース周期で公開されており、10.9.0 (2026-08-11 公開) は `net8.0`、`net9.0`、`net10.0`、`net462` を対象としています。したがって同じコードが .NET 8 から現在の .NET 11 プレビューまで適用できます。これらのパッケージの 11.x リリースはまだ存在しません。

## 分類済みプロパティに対してソースジェネレーターが実際に出力するもの

この機能はただ 1 点に支えられています。`[LoggerMessage]` のソースジェネレーターは、分類済みの値を通常のタグとは*別の配列*に出力するという点です。次のログメソッドがあるとします。

```csharp
// Microsoft.Extensions.Telemetry.Abstractions 10.9.0, net10.0
public static partial class Log
{
    [LoggerMessage(2, LogLevel.Information, "Via LogProperties")]
    public static partial void ViaProps(this ILogger logger, [LogProperties] Payment payment);
}
```

ジェネレーターは次のコードを生成します (一部省略していますが、それ以外は `EmitCompilerGeneratedFiles` の出力そのままです)。

```csharp
var state = LoggerMessageHelper.ThreadLocalState;

_ = state.ReserveTagSpace(2);
state.TagArray[1] = new("{OriginalFormat}", "Via LogProperties");
state.TagArray[0] = new("payment.Amount", payment?.Amount);

_ = state.ReserveClassifiedTagSpace(2);
state.ClassifiedTagArray[1] = new("payment.CardNumber", payment?.CardNumber,
    new DataClassificationSet(_SensitiveAttribute));
state.ClassifiedTagArray[0] = new("payment.Cvv", payment?.Cvv,
    new DataClassificationSet(_SensitiveAttribute));
```

`Amount` は `TagArray` に入ります。`CardNumber` と `Cvv` は、属性から得られた `DataClassificationSet` とともに `ClassifiedTagArray` に入ります。ここでは何もレダクションされていません。ジェネレーターは値に*ラベルを付ける*だけです。その後どうなるかは `LoggerMessageState` を消費する側が決めます。配線がこれほど重要なのはそのためです。そもそも `[LoggerMessage]` がどのようにコードを生成するのかをご存じない場合は、[ソースジェネレーターとは何か、いつ必要になるのか](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) に寄り道する価値があります。

## タクソノミー、属性、Redactor を組み立てる

分類は `(TaxonomyName, Value)` のペアです。ソリューション全体で同じ語彙を共有できるよう、静的クラスに一度だけ定義します。

```csharp
// Microsoft.Extensions.Compliance.Abstractions 10.9.0
using Microsoft.Extensions.Compliance.Classification;

public static class Taxonomy
{
    public const string Name = "Contoso";

    public static DataClassification Sensitive => new(Name, nameof(Sensitive));
    public static DataClassification Pii => new(Name, nameof(Pii));
}
```

この機能に関する MS Learn のサンプルは、分類済みパラメーターを `[MyTaxonomyClassifications.Private] string SSN` のように書いています。これはコンパイルできません。静的プロパティは属性ではないからです。分類ごとに本物の `DataClassificationAttribute` のサブクラスが必要で、[データ分類のドキュメント](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification) はそちらを正しく説明しています。

```csharp
public sealed class SensitiveAttribute : DataClassificationAttribute
{
    public SensitiveAttribute() : base(Taxonomy.Sensitive) { }
}

public sealed class PiiAttribute : DataClassificationAttribute
{
    public PiiAttribute() : base(Taxonomy.Pii) { }
}
```

次にモデルに属性を付けます。属性のないものはそのままログに出ます。

```csharp
public sealed class Payment
{
    [Sensitive] public string CardNumber { get; set; } = "";
    [Pii] public string Email { get; set; } = "";
    public int Amount { get; set; }
    [LogPropertyIgnore] public string InternalTrace { get; set; } = "";
}
```

Redactor はメンバーが 2 つの抽象クラスです。`GetRedactedLength` が出力先バッファのサイズを決め、`Redact` がそれを埋めて書き込んだ文字数を返します。

```csharp
// Microsoft.Extensions.Compliance.Redaction 10.9.0
using Microsoft.Extensions.Compliance.Redaction;

public sealed class LastFourRedactor : Redactor
{
    public override int GetRedactedLength(ReadOnlySpan<char> input)
        => input.Length <= 4 ? input.Length : 4 + 4;

    public override int Redact(ReadOnlySpan<char> source, Span<char> destination)
    {
        if (source.Length <= 4)
        {
            source.CopyTo(destination);
            return source.Length;
        }

        "****".CopyTo(destination);
        source[^4..].CopyTo(destination[4..]);
        return 8;
    }
}
```

span ベースのシグネチャは意図的なものです。ログのパイプラインはプールされた `JustInTimeRedactor` を通じて span から span へレダクションするため、適切に書かれた Redactor はログレコードごとに何も割り当てません。

## 配線する

4 つの手順があり、そのすべてが不可欠です。

1. Redactor 用に `Microsoft.Extensions.Compliance.Redaction` を、ログ統合用に `Microsoft.Extensions.Telemetry` をインストールします。分類の型は `Microsoft.Extensions.Compliance.Abstractions` から推移的に入ります。
2. サービスコレクションに対して `AddRedaction` を呼び出し、各分類を Redactor に対応付けます。
3. ログビルダーに対して `EnableRedaction` を呼び出します。これによって `ExtendedLogger` に差し替わります。`ClassifiedTagArray` を読むのはこのコンポーネントだけです。
4. ソースジェネレーターが生成した `[LoggerMessage]` メソッド経由でログを出します。レダクションは `logger.LogInformation(...)` には適用されません。

```csharp
var services = new ServiceCollection();

services.AddLogging(b =>
{
    b.AddJsonConsole();
    b.EnableRedaction();          // Microsoft.Extensions.Logging namespace
});

services.AddRedaction(r =>
{
    r.SetRedactor<LastFourRedactor>(Taxonomy.Sensitive);
    r.SetFallbackRedactor<ErasingRedactor>();
});
```

`EnableRedaction` は `Microsoft.Extensions.Telemetry` パッケージで配布されていますが、名前空間は `Microsoft.Extensions.Logging` です。したがって公式サンプルにある `using Microsoft.Extensions.Telemetry;` は必要ありません。

## 3 つの構成と、それぞれが実際に記録する内容

ここがこの機能の落とし穴です。同じ `Payment` を 3 通りの配線でログに出したもので、いずれも実際の `JsonConsole` 出力です。

**`AddRedaction` は登録済み、`EnableRedaction` は未呼び出し。** 通常の `ILogger` は `ClassifiedTagArray` を一切見ないため、分類済みプロパティは構造化状態から抜け落ち、平坦化されたメッセージにはプレースホルダーが出ます。

```json
{"State":{"Message":"customer.Plan=enterprise,customer.Id=42,customer.CardNumber=<omitted> ([Contoso:Sensitive]),customer.Email=<omitted> ([Contoso:Pii])","customer.Plan":"enterprise","customer.Id":42}}
```

漏洩はありませんが、データもありません。しかもレダクションが無効であることを知らせるエラーも出ません。この挙動は [dotnet/extensions の issue 5163](https://github.com/dotnet/extensions/issues/5163) で追跡されています。

**`EnableRedaction` は呼び出し済み、`AddRedaction` は未呼び出し。** これが危険なケースです。コンテナーに `IRedactorProvider` がないため、パイプラインは素通しの Redactor にフォールバックし、生の値を書き込みます。

```json
{"State":{"customer.CardNumber":"4111111111111111:customer.CardNumber","customer.Email":"ada@contoso.com:customer.Email"}}
```

カード番号がログファイルに入り、ご丁寧にタグ名まで付いています。何の警告もありません。この記事から 1 つだけ持ち帰るとすれば、`EnableRedaction` と `AddRedaction` は必ずセットで追加すること、そしてログの出力先を既知のシークレットで検索する統合テストは安上がりな保険だということです。

**両方呼び出し済み。** 分類済みの値はレダクションされ、未分類の値はそのまま通過し、`[LogPropertyIgnore]` を付けたプロパティはまったく現れません。

```json
{"State":{"payment.Email":"****","payment.CardNumber":"****","payment.Amount":1999}}
```

`AddRedaction()` を設定なしで呼ぶこと自体は安全です。既定のフォールバックが `ErasingRedactor` なので、分類済みの値はすべて空文字列になります。プロバイダーに対して直接検証したところ、`GetRedactor` は未対応の分類および `DataClassification.Unknown` に対して `ErasingRedactor` を返し、`NullRedactor` (素通し) を返すのは `DataClassification.None` のときだけでした。

## 部分マスクを壊すディスクリミネーター

先ほどの `LastFourRedactor` を登録し、カード番号 `4111111111111111` をログに出すと、こうなります。

```json
{"payment.CardNumber":"****mber","payment.Email":"****mail"}
```

`mber` はカード番号ではなく `payment.CardNumber` という文字列の末尾 4 文字です。Redactor は値そのものを単独で受け取っていません。`Redact` にスパイを仕込むと、何が渡ってくるかがはっきり分かります。

```text
[spy] Redact saw: "4111111111111111:payment.CardNumber" (len 35)
[spy] Redact saw: "ada@contoso.com:payment.Email"      (len 29)
```

これはバグではなく意図的な挙動です。`ExtendedLogger` は各レダクションを `JustInTimeRedactor.Get(value, redactor, discriminator)` 経由で組み立てます。ディスクリミネーターはタグ名であり、`LoggerRedactionOptions.ApplyDiscriminator` の既定値は `true` です。文書化された根拠は相関耐性です。レダクション後のテキストにタグ名を含めることで、ハッシュ化された `user.Email` とハッシュ化された `contact.Email` が同じアドレスであると判別できなくなります。ハッシュ化する Redactor にとっては本当に良い既定値ですが、入力を調べる種類の Redactor にとっては静かな正しさのバグになります。

修正はオプション 1 つです。

```csharp
b.EnableRedaction(o => o.ApplyDiscriminator = false);
```

ディスクリミネーターを無効にすると、同じ Redactor が期待どおりの結果を返します。

```json
{"payment.CardNumber":"****1111","payment.Email":"****.com"}
```

無効にするのは、実際の値を見る必要がある Redactor に限ってください。単一フィールド内で繰り返し現れる値をハッシュで見つけたい場合は、有効のままにします。なお、`IRedactorProvider` から直接呼び出された Redactor はディスクリミネーターを受け取りません。そのため Redactor 単体の単体テストは通るのに、ログのパイプラインでは誤動作するという状況が起こります。ロガー経由でテストしてください。

## 消去ではなくハッシュ化する

`HmacRedactor` は安定した `HMACSHA256` ハッシュを生成するため、値を保存せずに同じ値の出現を相関付けられます。

```csharp
#pragma warning disable EXTEXP0002
services.AddRedaction(r => r.SetHmacRedactor(o =>
{
    o.KeyId = 42;
    o.Key = Convert.ToBase64String(keyBytes);   // base64, at least 44 chars
}, Taxonomy.Pii));
#pragma warning restore EXTEXP0002
```

`ApplyDiscriminator` を無効にした場合の実際の出力です。

```json
{"payment.Email":"42:AjapxXMS14J9i8GFw62JBQ==","payment.CardNumber":""}
```

接頭辞の `42:` は `KeyId` なので、ローテーション後にどの鍵がそのハッシュを生成したかを判別できます。注意点が 2 つあります。`SetHmacRedactor` は実験的な API で `EXTEXP0002` を出すため、明示的な抑制か `<NoWarn>$(NoWarn);EXTEXP0002</NoWarn>` が必要です。また上の出力で `CardNumber` が空になったのは、これが `Sensitive` に分類されており、ここでは対応する Redactor が設定されていないため `ErasingRedactor` のフォールバックに当たったからです。定義した分類はすべて対応付けてください。さもないとフォールバックが黙って決めてしまいます。

## LogProperties のその他の機能

`[LogProperties]` には、多くの人が使っているよりも多くのつまみがあります。

```csharp
[LoggerMessage(4, LogLevel.Information, "Charging customer")]
public static partial void Charging(this ILogger logger,
    [LogProperties(OmitReferenceName = false, SkipNullProperties = true)] Customer customer);
```

`OmitReferenceName` の既定値は `false` で、これがすべてのタグ名に `customer.` という接頭辞を付けています。`true` にすればタグは単に `Id` や `Plan` などになります。`SkipNullProperties = true` は、null を書き込む代わりに null 値のプロパティを状態から省きます。どちらも実行時コストのない通常のコンパイル時オプションです。

入れ子のオブジェクトは既定ではたどられません。複合型の `Customer.Address` は、黙って文字列化される代わりにビルド警告を出します。

```text
warning LOGGEN036: The type "Address?" doesn't implement ToString(), IConvertible, or IFormattable
(did you forget to apply [LogProperties] or [TagProvider] to "Address"?)
```

入れ子のプロパティ自体に `[LogProperties]` を付ければ解決し、`Address` 上の分類属性も含めて `customer.Address.Street` のタグが出力されるようになります。グラフを自動的にたどる `[LogProperties(Transitive = true)]` もありますが、実験的とされており、抑制するまでは `EXTEXP0003` でビルドが失敗します。

## 属性を付けられない値を分類する

属性が使えるのは自分が所有する型だけです。サードパーティの DTO の場合や、分類が実行時の状態に依存する場合は、`[TagProvider]` を使い、手書きのコレクターメソッドの中で分類します。

```csharp
public static class SessionTagProvider
{
    public static void Provide(ITagCollector collector, Session session)
    {
        collector.Add("user", session.User);
        collector.Add("token", session.Token, new DataClassificationSet(Taxonomy.Sensitive));
    }
}

[LoggerMessage(2, LogLevel.Information, "Session opened")]
public static partial void Opened(this ILogger logger,
    [TagProvider(typeof(SessionTagProvider), nameof(SessionTagProvider.Provide),
                 OmitReferenceName = true)] Session session);
```

`DataClassificationSet` を受け取る `ITagCollector.Add` のオーバーロードは、分類属性のプログラム的な等価物であり、値はまったく同じ経路で `ClassifiedTagArray` に流れます。命名には注意してください。既定では、渡したキーの前にパラメーター名が付きます。そのため `session` という名前のパラメーターで `collector.Add("session.token", ...)` とすると、タグは `session.session.token` になります。素のキーを渡してパラメーター名に接頭辞を付けさせるか、素のキーを渡したうえで `OmitReferenceName = true` を設定して接頭辞を完全に取り除いてください。接頭辞を自分で書いてはいけません。

## テストで裏付ける

`Microsoft.Extensions.Diagnostics.Testing` 10.9.0 の `FakeLogger` は同じ `ExtendedLogger` の後ろで動くため、レダクションが適用され、レダクション済みのタグを `FakeLogCollector` から読み取れます。おかげで漏洩のアサーションが簡単になります。

```csharp
var services = new ServiceCollection();
services.AddLogging(b => { b.AddFakeLogging(); b.EnableRedaction(); });
services.AddRedaction(r => r.SetRedactor<StarRedactor>(Taxonomy.Sensitive));

using var sp = services.BuildServiceProvider();
sp.GetRequiredService<ILoggerFactory>().CreateLogger("T")
  .Taken(new Payment { CardNumber = "4111111111111111", Amount = 1999 });

var records = sp.GetRequiredService<FakeLogCollector>().GetSnapshot();
Assert.DoesNotContain("4111111111111111",
    string.Join('\n', records.SelectMany(r => r.StructuredState ?? [])
                             .Select(kv => $"{kv.Key}={kv.Value}")));
```

このレコードの構造化状態はちょうど `payment.CardNumber = ****`、`payment.Amount = 1999`、`{OriginalFormat} = Payment taken` になります。`****` があることではなくシークレットがないことをアサートしてください。そうすれば誰かが Redactor を差し替えてもテストがリグレッションを捕まえられます。

意外だった点が 2 つあります。レダクションはソースジェネレーターが生成したログメソッドにしか適用されないため、コードベースに残っている `logger.LogInformation($"card {card}")` はまったく保護されません。その掃除がまだであれば、[補間された ILogger 呼び出しをメッセージテンプレートへ移行する](/ja/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) ことがこの機能全体の前提条件になります。もう 1 つ、`EnableRedaction` は `JsonConsole` が入れ子の `State.Message` フィールドに書き込む内容を変えます。この値は `Microsoft.Extensions.Logging.ExtendedLogger+ModernTagJoiner` というリテラル文字列になります。トップレベルの `Message` は引き続き正しく、個々のタグもすべて残りますが、下流に `State.Message` を読むパーサーがあると壊れます。状態を列挙する構造化シンク、たとえば [Serilog と Seq のセットアップガイド](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) や [OpenTelemetry のログパイプライン](/ja/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/) で扱っているものは影響を受けません。

この機能を推す最大の理由は、分類がモデル上のプロパティの隣に存在し、フィールドを追加する開発者の目に必ず入ることです。レダクションのポリシーはコンポジションルートの 1 か所の呼び出しにあり、セキュリティレビュー担当者が 10 秒で読めます。この分離はセットアップの手間に見合いますが、実際に検証することが条件です。完全に値を詰めたモデルをインメモリのシンクにログ出力し、既知のシークレット文字列が出力に現れたら失敗するテストを 1 つ追加してください。

## 参考資料

- [コンパイル時のログソース生成](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/source-generation), MS Learn
- [.NET のデータ分類](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification), MS Learn
- [.NET のデータレダクション](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-redaction), MS Learn
- [ExtendedLogger.ModernPath](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/ExtendedLogger.cs) と [JustInTimeRedactor](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/JustInTimeRedactor.cs), dotnet/extensions
- [LoggerRedactionOptions.ApplyDiscriminator](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/LoggerRedactionOptions.cs), dotnet/extensions
- [dotnet/extensions の issue 5163](https://github.com/dotnet/extensions/issues/5163), レダクション無効時の LogProperties 出力について
