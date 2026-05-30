---
title: "大規模な .NET 11 コードベースで Newtonsoft.Json 13 から System.Text.Json へ移行する"
description: "Newtonsoft.Json 13.0.4 を .NET 11 組み込みの System.Text.Json に置き換えるための、バージョン固定の手引きです。属性とオプションの対応付け、出力フォーマットを静かに変えてしまうデフォルト値、段階的な展開戦略、検証、そして大規模コードベースを襲う落とし穴を扱います。"
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "newtonsoft-json"
  - "system-text-json"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase"
translatedBy: "claude"
translationDate: 2026-05-30
---

大規模なコードベースで `Newtonsoft.Json` を `System.Text.Json` に置き換える作業は、めったに検索置換だけでは済みません。2 つのライブラリはデフォルト値で食い違っており、その違いがシリアライズ出力を変え、デシリアライズを静かに壊すため、安易な置き換えは JSON のすべての利用者に契約変更を配ってしまいます。小さなサービスなら数日、カスタムコンバーター、多態的なペイロード、`dynamic`/`JObject` による解析を抱える広大なコードベースなら 2 週間から 4 週間を見込んでください。得られるものは本物です。`System.Text.Json` はランタイムに組み込まれており、ごくわずかなアロケーションでおよそ 2 倍速くシリアライズし、2 つのうち Native AOT 下で動作する唯一のライブラリです。本記事はソースとして `Newtonsoft.Json` 13.0.4（2025-12-30 にリリースされた現行の安定版）を、ターゲットとして C# 14 を使う .NET 11 SDK 組み込みの `System.Text.Json` を固定します。そもそも移行すべきか迷っている場合は、まず [2026 年における System.Text.Json と Newtonsoft.Json の比較](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) を読んでください。本記事は移行を決めた前提で進めます。

## なぜ今移行するのか

- `System.Text.Json` は .NET 11 の共有フレームワークの一部です。`Newtonsoft.Json` の `PackageReference` を外すと、ランタイム、ASP.NET Core、テストプラットフォームが積極的に切り離してきた推移的依存が取り除かれます。
- スループット。典型的な POCO ペイロードでは、`System.Text.Json` は `Newtonsoft.Json` よりおよそ 2 倍速くシリアライズし、アロケーションは明らかに少なくなります。`string` や `TextReader` を経由せず、`Utf8JsonReader` と `Utf8JsonWriter` で UTF-8 バイトを直接扱うためです。
- Native AOT と trimming。`Newtonsoft.Json` はリフレクションに依存しており、Native AOT 下では動作しません。`System.Text.Json` にはソースジェネレーターモード（`JsonSerializerContext`）があり、コンパイル時に trim 安全で AOT 互換のシリアライズメタデータを出力します。[Native AOT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) がロードマップにあるなら、この移行は最適化ではなく前提条件です。
- セキュリティ面。`System.Text.Json` はデフォルトで厳格（RFC 8259）で、出力時に HTML に敏感な文字や非 ASCII 文字をエスケープし、不正な JSON を解釈しません。これにより、`Newtonsoft.Json` の寛容なデフォルトが許してきたインジェクションや解析の意外な挙動の一群が取り除かれます。

## 何が壊れるか

この移行の危険は、コンパイルできないコードではありません。問題なくコンパイルできて、出力フォーマットを変えてしまうコードです。この表は二度読む価値があります。

| 領域                              | 変更点                                                                                         | 深刻度  |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| プロパティ名の照合                | `Newtonsoft.Json` は読み取り時にデフォルトで大文字小文字を区別しない。`System.Text.Json` は区別する | 高      |
| コメントと末尾のカンマ            | `Newtonsoft.Json` ではデフォルトで受け入れられるが、`System.Text.Json` では `JsonException` を投げる | 高    |
| 単一引用符 / 引用符なしの JSON    | `Newtonsoft.Json` は受け入れるが、`System.Text.Json` は設計上拒否する                           | 高      |
| `string` プロパティへの非文字列値 | `Newtonsoft.Json` は `1` や `true` を変換する。`System.Text.Json` は例外を投げる                | 高      |
| 引用符で囲まれた数値              | `Newtonsoft.Json` は `"23"` を `int` に読み込む。`System.Text.Json` は `NumberHandling` が必要   | 中      |
| 文字のエスケープ                  | `System.Text.Json` はより積極的にエスケープするため、非 ASCII と HTML で出力バイトが異なる        | 中      |
| `[JsonProperty("name")]`          | `[JsonPropertyName("name")]` になる。1 つの属性に ignore/required を組み合わせるオプションはない | 中      |
| `TypeNameHandling.All`            | 設計上、相当物なし。多態性は代わりに `[JsonDerivedType]` を使う                                  | 高      |
| `JObject` / `JToken` / `dynamic`  | 異なる API を持つ `JsonNode` / `JsonDocument` / `JsonElement` に置き換わる                       | 中      |
| `JsonConvert.PopulateObject`      | 組み込みの相当物なし。カスタムコンバーターか手動マージが必要                                     | 中      |
| `ReferenceLoopHandling.Ignore`    | 「ループを静かに捨てる」モードはない。`ReferenceHandler.Preserve` を使うかグラフを再設計する     | 中      |
| `DateFormatString`, `DateTimeZoneHandling` | 日付フォーマットのグローバル設定はない。カスタム `JsonConverter<DateTime>` が必要     | 中      |
| コンバーター登録の優先順位        | `Converters` コレクションが型レベル属性を上書きするようになった（`Newtonsoft.Json` と逆）        | 低      |

ここの各行の信頼できる参照元は [Microsoft の移行ガイド](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) です。回避策のない一握りの機能（`JsonPath` クエリ、`TypeNameHandling.All`、単一引用符の解析）もそこに列挙されています。

## 事前チェックリスト

`using Newtonsoft.Json` を 1 つでも削除する前に、これをすべて行ってください。

1. 契約を固定します。JSON がプロセス境界を越える場合（公開 API、メッセージキュー、永続化されたカラム）、現在の出力の基準サンプルを取得します。代表的なオブジェクト群を `Newtonsoft.Json` 13.0.4 でシリアライズし、その文字列をテストフィクスチャとして保存します。これがリグレッションのオラクルになります。
2. 表面積を棚卸しします。作業量を把握するため、古いライブラリに触れているものすべてを grep します。
   ```bash
   # run from the repo root; counts the call sites you have to touch
   grep -rEl "Newtonsoft\.Json|JsonConvert|JObject|JArray|JToken|JsonProperty|JsonSerializerSettings" --include="*.cs" .
   ```
   検証: ファイル一覧が、シリアライズがどこにあるかという頭の中のモデルと一致すること。ここでの意外な発見（ロギングヘルパーに埋もれたコンバーターなど）は、まさに今見つけたいものです。
3. 回避策のない機能に印を付けます。具体的に `TypeNameHandling`、`SelectToken`、`SelectTokens`、単一引用符のテストフィクスチャを探します。`TypeNameHandling.All` か `.Auto` が見つかったら、続ける前に止まって多態性の置き換えを設計してください。直接の代替がないためです。
4. ターゲットを確認します。`dotnet --version` を実行して `11.0.x` を確認します。`System.Text.Json` は組み込みなので、中心的なシナリオでは追加するパッケージはありません。SDK が同梱するものより新しいアウトオブバンド版が必要な場合だけ、`System.Text.Json` を明示的な `PackageReference` として追加します。

## 移行ステップ

1. **グローバルオプションを対応付ける.**

   `Newtonsoft.Json` は挙動を `JsonSerializerSettings` に集約します。`System.Text.Json` は `JsonSerializerOptions` を使います。既存の設定オブジェクトをフィールドごとに翻訳してください。`System.Text.Json` のデフォルト値を盲目的に受け入れてはいけません。あなたのコードが何年も出力してきたものとは異なるからです。

   ```csharp
   // .NET 11, C# 14
   // BEFORE: Newtonsoft.Json 13.0.4
   var settings = new JsonSerializerSettings
   {
       ContractResolver = new CamelCasePropertyNamesContractResolver(),
       NullValueHandling = NullValueHandling.Ignore,
       ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
   };

   // AFTER: System.Text.Json (in-box on .NET 11)
   var options = new JsonSerializerOptions
   {
       PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
       PropertyNameCaseInsensitive = true,                       // restore Newtonsoft read behavior
       DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
       ReferenceHandler = ReferenceHandler.IgnoreCycles,         // closest match to ReferenceLoopHandling.Ignore
       // AllowTrailingCommas = true,                            // uncomment only if your inputs have them
       // ReadCommentHandling = JsonCommentHandling.Skip,        // uncomment only if your inputs have comments
   };
   ```

   検証: 基準サンプルのオブジェクトをこの `options` でシリアライズし、事前チェックのステップ 1 のフィクスチャと差分を取ります。差分は空であるか、説明できるはずです。`PropertyNameCaseInsensitive = true` は大規模コードベースにとって最も重要な一行です。無数のデシリアライズ経路が `Newtonsoft.Json` の大文字小文字を区別しない照合に静かに依存しているからです。

2. **属性を置き換える.**

   属性の改名は機械的ですが、`[JsonProperty]` は複数の関心事を 1 つの属性に詰め込んでおり、`System.Text.Json` はそれを分割します。

   ```csharp
   // .NET 11, C# 14
   // BEFORE
   public class Order
   {
       [JsonProperty("order_id")]
       public int Id { get; set; }

       [JsonProperty("notes", NullValueHandling = NullValueHandling.Ignore)]
       public string? Notes { get; set; }

       [JsonProperty(Required = Required.Always)]
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }

   // AFTER
   public class Order
   {
       [JsonPropertyName("order_id")]
       public int Id { get; set; }

       [JsonPropertyName("notes")]
       [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
       public string? Notes { get; set; }

       [JsonRequired]                       // or the C# `required` modifier
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }
   ```

   検証: モデルアセンブリ内に `Newtonsoft.Json` の `using` ディレクティブがゼロでプロジェクトがコンパイルでき、ラウンドトリップのテスト（`Deserialize(Serialize(order))`）がすべてのフィールドを保持すること。

3. **カスタムコンバーターを移植する.**

   ここで時間が溶けます。形は似ていますが契約が異なります。`System.Text.Json` のコンバーターは `Utf8JsonReader`（`ref struct`）と `Utf8JsonWriter` の上で動作し、`Read` は最初のトークンに位置付けられた状態で呼ばれます。

   ```csharp
   // .NET 11, C# 14 -- a converter that reads/writes DateTime in a fixed format,
   // replacing Newtonsoft's DateFormatString / DateTimeZoneHandling settings.
   public sealed class Iso8601DateTimeConverter : JsonConverter<DateTime>
   {
       public override DateTime Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions o)
           => DateTime.ParseExact(reader.GetString()!, "yyyy-MM-dd'T'HH:mm:ss'Z'",
                                  CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

       public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions o)
           => writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",
                                      CultureInfo.InvariantCulture));
   }
   ```

   型属性としてだけでなく `options.Converters` に登録してください。そして優先順位の変化に注意します。`System.Text.Json` では `Converters` コレクション内のコンバーターが型レベルの `[JsonConverter]` 属性を上書きし、これは `Newtonsoft.Json` とは逆です。詳しい仕組みは [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) にあります。移植した各コンバーターは、エンドツーエンドのペイロードだけでなくそれ自身のフィクスチャに対して検証し、優先順位の意外な挙動が合格する結合テストの陰に隠れないようにします。

4. **多態性と TypeNameHandling を置き換える.**

   クラス階層をラウンドトリップするために `TypeNameHandling` を使っていた場合、相当物はありません。これは意図的です。`TypeNameHandling.All` はよく知られたリモートコード実行のベクトルだからです。`System.Text.Json` は基底型の属性で識別子付きの多態性を行います。

   ```csharp
   // .NET 11, C# 14
   [JsonDerivedType(typeof(Dog), typeDiscriminator: "dog")]
   [JsonDerivedType(typeof(Cat), typeDiscriminator: "cat")]
   public abstract class Animal { public string Name { get; set; } = ""; }

   public sealed class Dog : Animal { public bool GoodBoy { get; set; } }
   public sealed class Cat : Animal { public int Lives { get; set; } }
   ```

   これは `"$type": "dog"` という識別子を出力し、正しいサブタイプへ読み戻します。検証: 混在したサブタイプの `List<Animal>` をシリアライズし、デシリアライズして、実行時の型が保たれることを確認します。出力フォーマットが変わった（`Newtonsoft.Json` のアセンブリ修飾された `$type` ではなく明示的な識別子文字列）ことに注意してください。したがって外部の利用者はすべて足並みをそろえて更新する必要があります。

5. **dynamic と JObject の解析を変換する.**

   `JObject`/`JToken`/`dynamic` を介して型のない JSON をつつくコードは、`JsonNode`（可変）または `JsonDocument`/`JsonElement`（読み取り専用、プール）に移ります。

   ```csharp
   // .NET 11, C# 14
   // BEFORE: JObject o = JObject.Parse(json); var name = (string)o["user"]!["name"]!;
   JsonNode root = JsonNode.Parse(json)!;
   string name = root["user"]!["name"]!.GetValue<string>();
   ```

   唯一の罠は、`JsonDocument` が `JObject` と違ってプールされたバッファを所有し `IDisposable` であることです。`using` で包まないと、借りたバッファをリークします。`JObject` のような可変ツリーが必要なときは `JsonNode` を選びましょう。検証: かつての `JObject` アクセス経路ごとに、同じキー検索を行うユニットテストがあること。

6. **ASP.NET Core の統合を切り替える.**

   コードベースが `Program.cs` で `AddNewtonsoftJson()` を呼んでいる場合、それを取り除くとパイプライン全体が `System.Text.Json` に切り替わります。ASP.NET Core の Web デフォルトはすでに camelCase、大文字小文字を区別しない照合、引用符で囲まれた数値の読み取りを有効にしているため、MVC 経路では手動オプションの多くが冗長になります。

   ```csharp
   // .NET 11, C# 14
   // BEFORE: builder.Services.AddControllers().AddNewtonsoftJson();
   builder.Services.AddControllers().AddJsonOptions(o =>
   {
       o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
       // camelCase + case-insensitive are already on by ASP.NET Core web defaults
   });
   ```

   深さの上限に注意してください。ASP.NET Core は `System.Text.Json` の `MaxDepth` をライブラリのデフォルト 64 ではなく 32 に制限します。`AddNewtonsoftJson()` で動いていた深くネストしたペイロードが例外を投げ始めることがあります。検証: コントローラーの結合テストを実行し、どのペイロードも深さの上限に引っかからないことを確認します。

## 検証

このスモークテストの一覧は、最後だけでなく PR ごとに実行してください。

- ソリューションが、移行したプロジェクトで `Newtonsoft.Json` への参照ゼロでビルドできること（`grep -r "Newtonsoft" --include="*.csproj"` がそれらのプロジェクトについて何も返さない）。
- 事前チェックのステップ 1 の基準サンプル差分が空であるか、各差分が文書化され意図されたものであること。
- テストスイート全体が通ること: `dotnet test` が失敗ゼロを報告する。
- ラウンドトリップのテスト（`Deserialize(Serialize(x))`）が、カスタムコンバーターや多態的な階層を持つすべてのモデルで成り立つこと。
- ホットパスについては `BenchmarkDotNet` で素早く比較し、呼び出しごとの不用意な `new JsonSerializerOptions()` のせいで後退するのではなく、スループットとアロケーションの数値が正しい方向に動いたことを確認します（options インスタンスは常にキャッシュして再利用してください。呼び出しごとに構築するのは、この移行で最もよくあるパフォーマンス後退です）。

## ロールバック計画

この移行はプロジェクト単位では元に戻せますが、簡単ではありません。ステップ 1 が出力フォーマットを変えるからです。きれいな戦略はストラングラー方式です。1 つのアセンブリまたは 1 つの endpoint ずつ移行し、最後の利用者が移るまで `Newtonsoft.Json` を参照したままにし、リスクのある endpoint は `Newtonsoft.Json` のフォーマッターへ戻せる feature flag の背後に置きます。`PackageReference` を削除して新しい出力フォーマットを外部の利用者に届けてしまうと、ロールバックはパッケージを再追加し、フォーマット変更をすべて一度に元に戻すことを意味し、これは `git revert` ではなく協調的なリリースになります。基準サンプルの差分が本番テレメトリで少なくとも 1 リリースサイクルのあいだ緑であり続けるまでは、パッケージ参照を削除しないでください。

## 私たちがぶつかった落とし穴

- **大文字小文字の区別による静かなデータ欠落。** `PascalCase` のキーを持つファイルからデシリアライズした設定オブジェクトが、すべてのプロパティをデフォルト値のまま返してきました。`System.Text.Json` が camelCase のメンバーに対して大文字小文字を区別して照合したためです。何も例外を投げませんでした。解決策は `PropertyNameCaseInsensitive = true` で、教訓は「解析できたか」だけでなく値を検査することでした。
- **`DateTime` のラウンドトリップがずれた。** `Newtonsoft.Json` の `DateTimeZoneHandling` は timestamp を静かに正規化していました。`System.Text.Json` は ISO 8601 のラウンドトリップ形式を読み、オフセットを保持するため、保存された timestamp が異なる kind で返ってきました。ステップ 3 のカスタムコンバーターと [JSON 値を System.DateTime に変換できなかった](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) の修正がこれを解決しました。
- **オブジェクトの循環が破棄ではなく例外を投げた。** `ReferenceLoopHandling.Ignore` が EF Core のナビゲーションプロパティにある本物の循環参照を覆い隠していました。`System.Text.Json` はそれを [オブジェクトの循環の可能性が検出された](/ja/2026/05/fix-possible-object-cycle-was-detected-system-text-json/) として表面化させました。`ReferenceHandler.IgnoreCycles` が橋渡しですが、より良い解決策は循環をそもそも持たない射影 DTO でした。
- **リクエストごとの `new JsonSerializerOptions()` がスループットを落とした。** ホットなハンドラー内で options オブジェクトを構築すると内部のメタデータキャッシュが効かなくなり、置き換え前の `Newtonsoft.Json` のコードより遅くなりました。`static readonly JsonSerializerOptions` を 1 つキャッシュして再利用してください。

## 出典

- [Microsoft Learn: Newtonsoft.Json から System.Text.Json への移行](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft)
- [Microsoft Learn: プロパティ名と値のカスタマイズ方法](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Microsoft Learn: System.Text.Json による多態的シリアライズ](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Microsoft Learn: 参照の保持と循環参照の処理](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references)
- [NuGet 上の Newtonsoft.Json 13.0.4](https://www.nuget.org/packages/newtonsoft.json/)
