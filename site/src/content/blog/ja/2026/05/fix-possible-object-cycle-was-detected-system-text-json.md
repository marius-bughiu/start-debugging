---
title: "Fix: A possible object cycle was detected"
description: "System.Text.Json は逆参照を持つグラフのシリアライズを拒否します。ReferenceHandler.IgnoreCycles を設定するか、DTO に射影するか、逆向きポインタに [JsonIgnore] を付けてください。Preserve は最終手段です。"
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
  - "ef-core"
lang: "ja"
translationOf: "2026/05/fix-possible-object-cycle-was-detected-system-text-json"
translatedBy: "claude"
translationDate: 2026-05-14
---

解決策: `System.Text.Json` は、自分自身に戻ってくるオブジェクトグラフのシリアライズを一切拒否します。`Parent` プロパティと `Children` コレクションが互いに参照し合う EF Core エンティティでは、writer が無限にループし、深さガードに当たって例外を投げます。1 行で済ませたい場合は `JsonSerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles` を設定し、恒久的に対処したい場合は逆向きポインタに `[JsonIgnore]` を付け、あるいはエンティティを単に逆向きポインタを持たない DTO に射影してください。`ReferenceHandler.Preserve` も動作しますが、ワイヤフォーマットを `$id` / `$ref` に変えてしまい、これは API コンシューマーが望むものではほとんどありません。

```text
System.Text.Json.JsonException: A possible object cycle was detected. This can either be due to a cycle or if the object depth is larger than the maximum allowed depth of 32. Consider using ReferenceHandler.Preserve on JsonSerializerOptions to support cycles. Path: $.Children.Parent.Children.Parent.Children.Parent...
   at System.Text.Json.ThrowHelper.ThrowJsonException_SerializerCycleDetected(Int32 maxDepth)
   at System.Text.Json.Serialization.JsonConverter`1.TryWrite(Utf8JsonWriter writer, T& value, JsonSerializerOptions options, WriteStack& state)
   at System.Text.Json.Serialization.Metadata.JsonTypeInfo`1.SerializeAsObject(Utf8JsonWriter writer, Object rootValue)
   at System.Text.Json.JsonSerializer.WriteString[TValue](TValue value, JsonTypeInfo jsonTypeInfo)
```

このガイドは .NET 11 preview 4 および `System.Text.Json` 11.0.0-preview.4 に対して書かれています。`System.Text.Json` が .NET 5 で循環検出を初めて追加して以来、例外メッセージは変わっておらず、`ReferenceHandler.IgnoreCycles` は .NET 6 から利用できます。例外内の `Path` セグメントは、writer が諦めた時点で居た JSON パスです。パスが `$.Children.Parent.Children.Parent` のような繰り返しパターンであれば、本物の循環があります。パスが `$.Order.Customer.Address.Country.Region.Continent...` のようなまっすぐな下降であれば、循環ではなく、本当に 32 段より深いグラフを抱えており、`MaxDepth` という別の解決策が必要です。

## なぜ writer はループに従うことを拒むのか

`System.Text.Json` はグラフを木としてシリアライズします。JSON ドキュメントは定義上、木であり、「このノードはあちらのノードと同じものだ」という構文はありません。そのため writer はオブジェクトグラフを深さ優先でたどり、各参照を新しい入れ子オブジェクトとして出力します。あるプロパティが先祖を指し返した瞬間、走査は終わりません。

プロセスがスタックを使い切るまで動き続けないように、writer は現在の深さを追跡し、`JsonSerializerOptions.MaxDepth`（デフォルトは 64）を超えると `JsonException` を投げます。デフォルトのエラーメッセージは 2 つのケース（本物の循環と正直に深い木）を混同しています。writer は内部からその違いを判断できず、深すぎるとしかわからないからです。メッセージ末尾の `Consider using ReferenceHandler.Preserve` というヒントは、ランタイムの精一杯の推測です。`Preserve` であれば呼び出しは成功する、というのは正しいですが、API にとって正しい解決策であることはほぼありません。DTO への射影、または逆向きポインタを切ることが正解です。

ASP.NET Core のデフォルトは .NET 6 で変更され、フレームワークの `JsonOptions`（minimal API やコントローラーアクションが使うもの）は自動で `IgnoreCycles` に切り替わらなくなりました。明示的にオプトインします。理由は、循環を黙って捨てるとレスポンスモデルのバグが隠れるからで、正しい答えはモデルを直すことだ、というものでした。

## 最小限の再現

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4, System.Text.Json 11.0.0-preview.4
public class Author
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Book> Books { get; set; } = new();
}

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }
    public Author Author { get; set; } = null!;
}
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var author = new Author { Id = 1, Name = "Carla" };
var book = new Book { Id = 1, Title = "Refactoring", Author = author };
author.Books.Add(book);

var json = JsonSerializer.Serialize(author); // throws
```

`author.Books[0].Author` は `author` と同じインスタンスです。writer は `Books` に下り、最初の `Book` に下り、その `Author` に下り、再び `Books` を見つけてループします。プロセスが死ぬ前に 64 段の深さガードが発火します。

EF Core のナビゲーションプロパティを `Include` してトラッキング中のエンティティをコントローラーから射影せずに返した瞬間、同じ形が現れます。EF Core はナビゲーションプロパティを修正して、親が子を指し、子が親を指し返すようにします。これは変更追跡にとって正しい挙動です。JSON にとっては間違った形です。

## 詳細な解決策

### 1. DTO に射影する

正しい答えは、EF Core エンティティを直接シリアライズしないことです。逆向きポインタを平坦化または省略した DTO を返してください:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public record AuthorDto(int Id, string Name, IReadOnlyList<BookDto> Books);
public record BookDto(int Id, string Title);

var dto = await db.Authors
    .Where(a => a.Id == 1)
    .Select(a => new AuthorDto(
        a.Id,
        a.Name,
        a.Books.Select(b => new BookDto(b.Id, b.Title)).ToList()))
    .FirstAsync();

var json = JsonSerializer.Serialize(dto); // works
```

これは .NET チームが推奨する答えであり、公開 API にとって正しい答えです。DTO はコンシューマーが実際に欲しいものであり、エンティティはたまたま同じフィールド名を持っている内部型に過ぎません。EF Core クエリ内で射影すると SQL も小さくなり、データベースは DTO が必要な列だけを返します。このパターンの EF Core 側の背景については、[最初のクエリの前に EF Core モデルをウォームアップする方法](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)の記事が射影のメカニクスをより深く扱っています。

### 2. ReferenceHandler.IgnoreCycles をグローバルに設定する

どうしてもエンティティを直接シリアライズしなければならない場合（手軽な内部エンドポイント、管理用ツール、デバッグダンプ）、ホストに一度だけオプションを設定します:

```csharp
// .NET 11, C# 14, ASP.NET Core 11
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

コントローラーの場合 (System.Text.Json):

```csharp
// .NET 11, C# 14, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

`IgnoreCycles` は、writer が現在の枝にすでに存在するインスタンスをまた訪れようとしているのを検出すると、その都度 `null` を書き込みます。循環が断ち切られ、呼び出しは成功し、コンシューマーは木を受け取ります。コストは、`book.Author` が明らかに値を持っていても `null` としてシリアライズされる点で、コンシューマーが往復の忠実性を期待していると混乱しうることです。

`IgnoreCycles` が .NET 6 で追加されたのは、`Preserve` がデフォルトとしては破壊的すぎ、`[JsonIgnore]` ではケースごとにしか解決できないという理由からでした。読み取り専用のレスポンスパスにはグローバルなシリアライザ設定としてこれを使い、モデルはそのままにしておきましょう。

### 3. 逆向き参照に [JsonIgnore] を付ける

逆向きポインタが JSON で役に立たない場合（コンシューマーは要求した直後なので親を必ず知っている）、直接マークします:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }

    [JsonIgnore]
    public Author Author { get; set; } = null!;
}
```

`[JsonIgnore]` はその型のシリアライザとデシリアライザの両方からプロパティを除外します。循環はコンパイル時に消え、ランタイムオプションは不要です。これは、変更追跡のためだけに存在し、どの JSON コンシューマーも必要としないナビゲーションプロパティに対する正しい解決策です。

トレードオフは、`Author` が JSON 層からどこでも見えなくなることです。`Author` をネストした `Book` を返したい別のエンドポイントがあるなら、`[JsonIgnore]` は荒すぎるので、代わりに DTO に射影すべきです。

### 4. 本当に往復が必要なときの ReferenceHandler.Preserve

シナリオが内部対内部（アクターシステム、サーバー間プロトコル、別の .NET プロセスで読み戻すスナップショット）であれば、`Preserve` がグラフをそのまま保つオプションです:

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.Preserve
};

var json = JsonSerializer.Serialize(author, options);
```

出力には `$id` と `$ref` プロパティが付きます:

```json
{
  "$id": "1",
  "Id": 1,
  "Name": "Carla",
  "Books": {
    "$id": "2",
    "$values": [
      {
        "$id": "3",
        "Id": 1,
        "Title": "Refactoring",
        "Author": { "$ref": "1" }
      }
    ]
  }
}
```

公開 REST API において `Preserve` が正しい答えになることは **決して** ありません。JavaScript クライアント、モバイルクライアント、Postman、あらゆるコードジェネレーター、あらゆる Swagger バリデーターは素の JSON を期待しています。`$id` と `$ref` は System.Text.Json 独自の規約（元は Newtonsoft 由来）であり、標準ではありません。ブラウザはそれらを展開しません。受け側で `System.Text.Json` の同じ `Preserve` オプションでデシリアライズしないのであれば、出力しないでください。

正当な用途は、両端が .NET で、契約をあなたが管理し、グラフを重複なく往復させる必要が本当にあるサーバー間通信です。

### 5. MaxDepth を上げる、ただし正直に深い木に対してのみ

例外内のパスを確認して、繰り返しパターンではなく長いまっすぐな下降であれば、グラフは本当に 64 段より深いということです:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    MaxDepth = 128
};
```

これは稀です。ほとんどのドメインに 64 段の深さの木はありませんし、もしあるならほぼ確実にレスポンスをチャンクするかページングしたいはずです。しかし、再帰的なフォルダー構造、組織階層、深さがバグではなくデータである式木のようなものには、正しいノブです。

循環を「回避」するために `MaxDepth` を上げては **いけません**。深さガードはプロセスとスタックオーバーフローの間に立つ唯一のものです。

## これを引き起こす一般的な形

### シリアライズされたエンティティ上の EF Core ナビゲーションプロパティ

教科書的なケースです。`Order` に `Customer`、`Customer` に `List<Order> Orders` があり、`Include` が両側を埋めます。修正は DTO に射影するか、逆向きポインタに `[JsonIgnore]` を付けることです。コントローラーからエンティティを返すことが、この例外の単独の最も一般的な発生源です。

### 自己参照する木

`Parent` と `List<Category> Children` を持つ `Category` を、再帰的な `Include` で埋めるケース。循環は `category.Children[0].Parent == category` です。`IgnoreCycles` は逆向きポインタでループを検出し、そこに `null` を出力するので、これをきれいに処理します。

### LINQ から組み立てた匿名型

匿名型でグラフを組み立てる LINQ 射影は通常安全です（匿名型は逆向きポインタを持ちません）。しかし `Select(a => new { a, Books = a.Books })` のような射影はエンティティを再導入し、循環は戻ります。意図したものではなく、実際に書いたものを点検してください。

### ソースのナビゲーションプロパティをコピーした DTO

エンティティから DTO に `Author Author` を移すマッピング設定は、DTO の目的を台無しにします。プロパティを DTO から落とすか、その型を `AuthorDto`（逆向きポインタを持たない葉の形のレコード）に変えてください。

### 32 段より深いグラフと古いデフォルトメッセージ

.NET 8 より前、`MaxDepth` のデフォルトは明示的に設定されていない場合のみ 64 で、ソースジェネレーター経路や一部のレガシー初期化子は 32 を使っていました。例外メッセージには、一部の古いバージョンでは「32」、新しいバージョンでは「64」または独自の値がハードコードされています。ドキュメントではなく実際の例外を読んでください。数字を決めるのはランタイムのバージョンです。

## 似ているが別物

### "The object or value could not be serialized. There was a recursive call detected."

別のエラー、同じ系統です。これは Newtonsoft.Json が `ReferenceLoopHandling` をデフォルトの `Error` のままにしているときに出すメッセージです。Newtonsoft での修正は `ReferenceLoopHandling.Ignore`（`IgnoreCycles` に相当）または `PreserveReferencesHandling.All`（`Preserve` に相当）です。移行中であれば、[Newtonsoft から System.Text.Json への移行の道筋](/ja/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)が最も正準に近いケーススタディです。両ライブラリは同じ形の解決策にたどり着きますが、オプションの綴り方が異なります。

### "JsonException: The JSON value could not be converted to ..."

別の例外、別のスタックです。こちらは入力がターゲット型と合わずパースに失敗する話です。循環例外は書き込み側の問題で、変換例外は読み込み側の問題です。[System.DateTime 変換ガイド](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)は読み込み側系統の正準的なまとめです。

### "Self referencing loop detected for property ..."

これはそのまま Newtonsoft のメッセージです。`System.Text.Json` を使っているはずの 2026 年のコードベースでこれを見るなら、まだどこかに Newtonsoft シリアライザが配線されています。たいていは MVC ビルダーに残った `AddNewtonsoftJson()` の呼び出しです。ホストの startup を探してください。フレームワークは最後に登録された JSON フォーマッタを採用します。

### "An item with the same key has already been added. Key: $id"

これは `Preserve` のデシリアライザが、入力内に同じ `$id` が二度現れるために失敗している状態です。ペイロードが壊れている（異なる 2 つのオブジェクトに同じ id が割り当てられている）か、`Preserve` でシリアライズした後、id を書き換えるトランスフォーマーを通って再シリアライズされたかのどちらかです。修正はコンシューマー側ではなくプロデューサー側です。

### Blazor レンダリングからの "PossibleCycleDetected"

まったく別の層です。Blazor の差分エンジンにはコンポーネントパラメーター用の独自の循環ガードがあり、例外の型もスタックも異なります。Blazor のレンダリングループを直すために `JsonSerializerOptions` を変えてはいけません。

## ソースジェネレーターでの使い方

`System.Text.Json` のソースジェネレーションを使う場合も、同じオプションが適用されます。生成されたコンテキストに渡す `JsonSerializerOptions` に `ReferenceHandler` を設定するか、コンテキスト型に `[JsonSourceGenerationOptions]` 属性を付けます:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    ReferenceHandler = JsonKnownReferenceHandler.IgnoreCycles)]
[JsonSerializable(typeof(Author))]
public partial class ApiJsonContext : JsonSerializerContext { }
```

`JsonKnownReferenceHandler` は属性向けの enum で、ランタイムでは `ReferenceHandler.IgnoreCycles` / `Preserve` と同じハンドラーに対応します。ソースジェネレーターについての記事 [interceptors と System.Text.Json ソースジェネレーションの使い心地](/ja/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) は、trimming と AOT 発行を生き延びるコンテキスト登録の形を扱っていますが、同じ形がここにも当てはまります。

## 関連

この例外の読み込み側の対になる記事は、[The JSON value could not be converted to System.DateTime の修正](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) を参照してください。デフォルトの参照ハンドリングを回避する独自コンバーターを書くための一般的な土台は、[カスタム JsonConverter のウォークスルー](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) にあります。シリアライズするエンティティが EF Core 11 由来で、データベース往復の話が知りたい場合は、[SQL Server 2025 JSON contains のウォークスルー](/ja/2026/04/efcore-11-json-contains-sql-server-2025/) が JSON 列型がどのようにデータベース層でグラフを扱うかを説明しています。コードベース全体を Newtonsoft の `ReferenceLoopHandling` から移行する広い文脈については、[.NET 11 preview 4 で vstest が Newtonsoft.Json を外した件](/ja/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) のノートに .NET チーム自身の playbook があります。

## 出典

- [Preserve references and handle circular references in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references), Microsoft Learn.
- [`JsonSerializerOptions.ReferenceHandler`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.referencehandler), Microsoft Learn.
- [`JsonSerializerOptions.MaxDepth`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.maxdepth), Microsoft Learn.
- [`JsonIgnoreAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonignoreattribute), Microsoft Learn.
- [dotnet/runtime issue 30820: cycle detection in JSON serialization](https://github.com/dotnet/runtime/issues/30820), `Preserve` と後の `IgnoreCycles` を生んだ元の設計議論。
