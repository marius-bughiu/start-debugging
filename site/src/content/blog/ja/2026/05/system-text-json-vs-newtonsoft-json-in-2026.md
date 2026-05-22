---
title: "System.Text.Json vs Newtonsoft.Json（2026年）: どちらを選ぶべきか？"
description: ".NET 11 の新規コードには System.Text.Json を選びましょう。ランタイムに同梱され、約2倍高速で、Native AOT で動作する唯一の選択肢です。Newtonsoft.Json は JSONPath、TypeNameHandling、本当に緩い JSON のためだけに使います。"
pubDate: 2026-05-22
tags:
  - "comparison"
  - "system-text-json"
  - "newtonsoft-json"
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/system-text-json-vs-newtonsoft-json-in-2026"
translatedBy: "claude"
translationDate: 2026-05-22
---

2026年に .NET 11 で新しいコードを書き始めるなら、**System.Text.Json** を使ってください。ランタイムに同梱され、わずかなアロケーションで約2倍の速さでシリアライズし、2つのうち Native AOT で動作する唯一の選択肢です。**Newtonsoft.Json** に頼るのは、System.Text.Json がまだ持たない機能に依存する場合だけにしてください。すなわち、JSONPath クエリ、`TypeNameHandling` 形式の型埋め込み、または本当に不正な形式の JSON（シングルクォート、クォートなしのキー）の解析です。どちらのライブラリも2026年に生きていますが、新規作業においてはもう対等ではありません。

ここでの各例は、.NET 11 SDK と C# 14 で `<TargetFramework>net11.0</TargetFramework>` をターゲットにしています。System.Text.Json は .NET 11 に同梱される組み込みバージョンです。Newtonsoft.Json は 2025-12-30 にリリースされたバージョン 13.0.4、NuGet 上の現行の安定版を指します。

## 機能マトリクスを一目で

これがあなたが見に来た表です。これは [Microsoft 公式の移行ガイド](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) の実用版で、参照するパッケージを実際に変える判断に絞り込んだものです。

| 観点 | System.Text.Json (.NET 11) | Newtonsoft.Json 13.0.4 |
| ---- | -------------------------- | ---------------------- |
| 組み込み | はい、ランタイムの一部 | いいえ、NuGet パッケージ |
| スループット（シリアライズ） | ベースライン、最速 | ~2x 遅い |
| アロケーション | Span ベース、低い | より高い |
| Native AOT / trimming | はい、ソースジェネレーター経由 | いいえ |
| デフォルトの寛容さ | 厳格（RFC 8259） | 寛容 |
| コメント / 末尾カンマ | オプトイン | デフォルトで有効 |
| 大文字小文字を区別しない照合 | オプトイン（ASP.NET Core では有効） | デフォルトで有効 |
| ポリモーフィックな（デ）シリアライズ | はい、.NET 7 以降（`[JsonDerivedType]`） | はい（`TypeNameHandling`） |
| `TypeNameHandling.All`（CLR 型の埋め込み） | いいえ、by design | はい |
| JSONPath / `SelectToken` | いいえ | はい |
| LINQ-to-JSON DOM | `JsonNode` / `JsonDocument` | `JObject` / `JArray` |
| `DataTable`、`ExpandoObject`、`BigInteger` | カスタムコンバーターが必要 | 組み込み |
| シングルクォート、クォートなしのキー | 拒否、by design | 受け入れる |
| メンテナンス状況 | 活発な開発 | メンテナンスモード |
| ライセンス | MIT | MIT |

要点は、Newtonsoft.Json がいまだに勝つ行は狭く特定的である一方、System.Text.Json が勝つ行（組み込み、AOT、速度）はほぼすべての新規プロジェクトに当てはまる、ということです。

## System.Text.Json を選ぶべきとき

.NET 11 で新しいものすべてのデフォルトとして選んでください。具体的には:

- **ASP.NET Core の API。** フレームワークはすでに内部で System.Text.Json を使い、Web に適したデフォルトをあなたのために構成します。すなわち、camelCase のプロパティ名、大文字小文字を区別しない照合、クォートされた数値のサポートです。古い挙動を取り戻すために `Microsoft.AspNetCore.Mvc.NewtonsoftJson` を追加するのは、特定の機能が強制しない限り後退です。
- **Native AOT や積極的な trimming で動作するものすべて。** これは好みではなく、厳格な要件です。System.Text.Json には [ソースジェネレーター](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) があり、シリアライズのメタデータをコンパイル時に生成するため、実行時にリフレクションは不要です。Newtonsoft.Json は実行時リフレクションと `Reflection.Emit` の上に構築されており、AOT はそれを許しません。そこでのトレードオフが気になるなら、[Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) の分析をご覧ください。
- **高スループットまたはメモリに敏感なパス。** シリアライザー、ログ送信、メッセージバスのコンシューマー、タイトなループで動くものすべて。System.Text.Json は `ReadOnlySpan<byte>` と UTF-8 の上で直接動作し、Newtonsoft.Json が行う中間文字列のアロケーションを回避します。
- **決定論的で仕様準拠の出力が欲しい。** System.Text.Json は RFC 8259 に厳格に従います。HTML に敏感な文字をデフォルトでエスケープし、XSS や情報漏えいに対する多層防御の手段とします。これは JSON がページに埋め込まれるときに重要です。

ソースジェネレーターが生成するコンテキストは、AOT と最速の起動を解き放つパターンです:

```csharp
// .NET 11, C# 14 - compile-time metadata, no runtime reflection
using System.Text.Json;
using System.Text.Json.Serialization;

[JsonSerializable(typeof(WeatherForecast))]
public partial class AppJsonContext : JsonSerializerContext;

var forecast = new WeatherForecast(DateOnly.FromDateTime(DateTime.Now), 22, "Mild");

// Pass the generated TypeInfo, not the raw type, to stay reflection-free
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);

public record WeatherForecast(DateOnly Date, int TemperatureC, string Summary);
```

System.Text.Json は歴史的なギャップの大半も埋めました。.NET 7 以降、`[JsonDerivedType]` を通じてポリモーフィックな（デ）シリアライズを行い、.NET 9 は長く要望されていた複数のオプションを追加しました。null 非許容の参照型を尊重する `RespectNullableAnnotations`、enum 値の名前を変更する `JsonStringEnumMemberName` 属性、そして .NET 型から JSON スキーマを生成する `JsonSchemaExporter` です。.NET 10 は `PipeReader` からの直接デシリアライズと、1行で済む厳格なプリセットを追加しました:

```csharp
// .NET 10 and later - the strict, spec-compliant defaults in one preset
var options = JsonSerializerOptions.Strict;

// .NET 10 and later - deserialize straight from a PipeReader, no stream adapter
WeatherForecast? f = await JsonSerializer.DeserializeAsync<WeatherForecast>(pipeReader);
```

## Newtonsoft.Json を選ぶべきとき

それに頼る本当の理由はまだあります。次のいずれかに突き当たったら Newtonsoft.Json を選んでください:

- **JSONPath クエリが必要。** `SelectToken("$.store.book[0].title")` には System.Text.Json に組み込みの同等物がありません。`JsonNode` はインデクサーで辿れますが、パスクエリのエンジンはありません。任意のドキュメントを解析してパスで値を取り出すなら、Newtonsoft.Json のほうがはるかにコードが少なくて済みます。
- **`TypeNameHandling` に依存している。** Newtonsoft.Json はペイロードに CLR 型名を埋め込み（`$type`）、戻すときに正確な実行時型を再構築できます。System.Text.Json はこれを by design で拒否します。攻撃者が制御する型名のデシリアライズは、よく知られたリモートコード実行のベクターだからです。これに依存する既存の内部プロトコルがある場合、移行は構成フラグではなく再設計です。
- **本当に寛容または非標準の JSON を解析する。** シングルクォートの文字列、クォートなしのプロパティ名、その他 RFC 非準拠の入力は Newtonsoft.Json では受け入れられ、System.Text.Json では by design で拒否されます。コメントと末尾カンマは System.Text.Json ではオプトイン（`ReadCommentHandling`、`AllowTrailingCommas`）ですが、シングルクォートと裸のキーはまったく有効化できません。
- **組み込みサポートのない型をシリアライズする。** `DataTable`、`ExpandoObject`、`TimeZoneInfo`、`BigInteger`、`DBNull`、`ValueTuple` はすべて System.Text.Json ではカスタムコンバーターが必要です。Newtonsoft.Json はそれらをネイティブに扱います。

デフォルトの寛容さの違いは、移行時に噛みつくものです。同じペイロードが異なる挙動をします:

```csharp
// Newtonsoft.Json 13.0.4 - lenient by default, this parses fine
using Newtonsoft.Json;

var config = JsonConvert.DeserializeObject<Config>("""
{
    "Name": "api", // inline comment
    "Retries": 3,
}
""");

public record Config(string Name, int Retries);
```

```csharp
// .NET 11, System.Text.Json - strict by default, the same input throws JsonException
using System.Text.Json;

// You must opt in to match Newtonsoft.Json's leniency
var options = new JsonSerializerOptions
{
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    PropertyNameCaseInsensitive = true
};
var config = JsonSerializer.Deserialize<Config>(input, options);
```

その厳格さこそ、何年も動いていたペイロードが突然例外を投げる移行後の驚きの最も一般的な原因であり、[変換できなかった JSON 値](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) や [解析されない DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) のようなエラーが切り替え直後に現れる理由でもあります。

## ベンチマークが実際に示すもの

パフォーマンスは曖昧な言葉で済ませるのが最も簡単な主張なので、「速い」という言葉ではなく具体的な数値を挙げます。10,000 個の単純な POCO オブジェクトをシリアライズする .NET 10 上で公開された BenchmarkDotNet の実行は、System.Text.Json が約 3.7 ms で 3.4 MB を割り当てて完了するのに対し、Newtonsoft.Json は同じワークロードで約 7.6 ms と 8.1 MB であることを示しています。

| メトリクス（10,000 POCO をシリアライズ） | System.Text.Json | Newtonsoft.Json 13.x |
| ---------------------------------------- | ---------------- | -------------------- |
| 平均時間 | ~3.7 ms | ~7.6 ms |
| 割り当て | ~3.4 MB | ~8.1 MB |
| 相対 | 1.0x（ベースライン） | ~2.0x 遅い、~2.4x メモリ |

方法論と注意点が重要なので、これらの数値は正直に読んでください:

- 上記の数値は公開された .NET 10 のベンチマーク（BenchmarkDotNet、デフォルトの release 構成）に由来し、代表値であって絶対ではありません。設計レビューで数値を引用する前に、自分のオブジェクト形状に対して BenchmarkDotNet を実行してください。
- ギャップは単純な POCO と大きなコレクションで最大であり、まさに Web API とメッセージパイプラインを支配する形状です。
- ごく小さなペイロード（リクエストごとに1つの小さなオブジェクト）では絶対差はマイクロ秒であり、ボトルネックになることはまれです。その場合は他の観点で選んでください。
- ソース生成は呼び出しごとのリフレクションを取り除くため、System.Text.Json に有利にギャップをさらに広げます。Newtonsoft.Json に同等物はありません。

まとめは2025年と2026年の信頼できるすべてのベンチマークで一貫しています。System.Text.Json は一般的なケースで約2倍速く、半分から3分の1のメモリしか割り当てません。差は Newtonsoft.Json に有利には縮まっていません。

## あなたの代わりに決める要素

ときには、好みが部屋に入る前に、たった1つの制約が決定を片付けます。

**Native AOT は閉じた門です。** デプロイ先が AOT を要求するなら（trimming されたコンテナ、scale-to-zero の関数、iOS ビルド）、Newtonsoft.Json は単に選択肢になりません。AOT が提供しない実行時リフレクションに依存しているからです。この1つの事実だけで、現代の .NET ワークロードの一群から失格となります。

**メンテナンスの軌跡。** Newtonsoft.Json は死んでも非推奨でもありません。現在 Microsoft で System.Text.Json そのものに取り組む James Newton-King は、いまもセキュリティとバグ修正のリリースを出しています（13.0.4 は 2025-12-30 に到着）。しかし明示的にメンテナンスモードです。大きな機能開発はなく、AOT の道筋も来ません。System.Text.Json は .NET のリリースごとに新しい能力を得ます。新しいコードを活発に進化するライブラリに賭けることは、何年も保守するシステムにとってリスクの低い選択です。

**参照処理とオブジェクトサイクルが異なります。** Newtonsoft.Json には `ReferenceLoopHandling` と `PreserveReferencesHandling` があります。System.Text.Json はそれらを `ReferenceHandler.IgnoreCycles` と `ReferenceHandler.Preserve` にマッピングしますが、挙動は同一ではありません（`IgnoreCycles` は Newtonsoft.Json がプロパティを落とすところで `null` を書きます）。EF Core のエンティティグラフをシリアライズするなら、これはクリーンなペイロードと [オブジェクトサイクルの可能性の例外](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/) の違いです。移行前に必要なハンドラーを把握してください。

**ライセンスは同一です。** どちらも MIT で提供されるため、MediatR や AutoMapper の状況とは異なり、ここではライセンスは要因ではありません。「Newtonsoft.Json はまだ無料か？」に決定を委ねないでください。無料ですし、System.Text.Json も同様です。

## 結論、1行で

2026年の新しい .NET 11 コードでは、デフォルトで System.Text.Json を使い、それができない具体的で名前のある機能（JSONPath、`TypeNameHandling`、寛容な解析、コンバーターのない非サポート型）に突き当たったときだけ Newtonsoft.Json を追加してください。組み込みで、より速く、AOT 対応で、Microsoft がいまも作り続けているものです。柔軟性に依存する既存システムには Newtonsoft.Json を残してください。見返りのない移行を急ぐ必要はありませんが、そこから始める必要もありません。戦略的なデフォルトは何年も前に切り替わり、2026年にはギャップが十分に広く、立証責任は組み込みライブラリを選ぶ側ではなく Newtonsoft.Json を選ぶ側にあります。

## 関連

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: a possible object cycle was detected with System.Text.Json](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [Fix: the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Fix: the JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)

## ソース

- [Migrate from Newtonsoft.Json to System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) - 機能差の権威ある表とデフォルト挙動の一覧。
- [What's new in System.Text.Json in .NET 9](https://devblogs.microsoft.com/dotnet/system-text-json-in-dotnet-9/) - nullable アノテーション、enum メンバー名、スキーマエクスポーター。
- [JsonSerializer.DeserializeAsync (PipeReader overload)](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.deserializeasync?view=net-10.0) - .NET 10 のストリーミング API。
- [Newtonsoft.Json releases](https://github.com/JamesNK/Newtonsoft.Json/releases) - バージョン 13.0.4 と現在のメンテナンス頻度。
