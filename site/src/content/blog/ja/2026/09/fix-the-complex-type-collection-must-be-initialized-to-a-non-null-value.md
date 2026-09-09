---
title: "解決: The complex type collection must be initialized to a non-null value"
description: "EF Core 10.0.x では、ToJson の複合コレクション内で 2 要素のコレクションを持つ複合プロパティに null を代入すると DetectChanges が壊れます。11.0.0-rc.1 で修正されました。"
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "change-tracker"
  - "json"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/09/fix-the-complex-type-collection-must-be-initialized-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-09
---

`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.` には原因が 2 つあり、どちらも同じメッセージになります。メッセージ中のパスが、単に代入し忘れたプロパティを指しているだけなら、初期化すれば終わりです (`public List<Entry> Entries { get; set; } = new();`)。プロパティが初期化済みなのに `DetectChanges` や `SaveChanges` から例外が出るなら、[dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632) を踏んでいます。EF Core 10.0.0 から 10.0.12 では、`ToJson()` でマッピングした複合コレクションの中で、2 つ以上の要素を持つコレクションを含む型の null 許容な複合プロパティに `null` を代入すると、SQL が生成される前に変更検出がクラッシュします。修正はすでにマージされ `11.0.0-rc.1` に入っています。10.0.x へのバックポートはマイルストーン 10.0.13 で、まだリリースされていません。

## エラーの全体像

このメッセージは `CoreStrings.ComplexCollectionNotInitialized` に由来します。変更トラッカーのこの一角には似たメッセージが他に 4 つあるので、一文字ずつ読む価値があります。

```
System.InvalidOperationException: The complex type collection 'Root[]Group[]Item.Meta.Entries'
must be initialized to a non-null value before the elements can be accessed.
```

このバグの場合、重要なフレームは内側から順に `InternalComplexCollectionEntry.GetEntry`、`InternalComplexEntry.set_Ordinal`、`InternalComplexCollectionEntry.RemoveEntry`、そして `ChangeDetector.DetectComplexCollectionChanges` と並びます。スタックトレースに `RemoveEntry` と `set_Ordinal` があれば、それは自分の null ではなく EF のバグです。逆にスタックの先頭が自分で書いた `EntityEntry.ComplexCollection(...)` の呼び出しなら、後述の原因 1 に当たります。

メッセージ中のプロパティパスは C# の式ではなく、平坦化されたチェーンです。`[]` は複合コレクションを 1 段たどることを示し、その直後に要素の型名が続きます。したがって `Root[]Group[]Item.Meta.Entries` は「`Root` のコレクションにある `Group` 要素の中の `Item` 要素にぶら下がる `Meta` の `Entries` コレクション」と読みます。深いモデルでは、このパスが問題のプロパティに最短で到達する手がかりになります。

## 変更トラッカーが null のコレクションを受け付けない理由

複合コレクションは EF Core 10 で導入され、リレーショナルプロバイダーでは [`ToJson()` で単一の JSON 列にマッピングしなければなりません](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)。専用のテーブルには置けません。この制約こそがこのメッセージが存在する理由です。テーブルも主キーもないため、EF は owned エンティティのように主キーで要素を識別できません。EF は要素を **CLR のリスト上の位置** で識別します。

そのため `InternalComplexCollectionEntry` は、現在値用と元の値用に 2 本のエントリのリストを並行して保持し、返すエントリはすべて実際にオブジェクト上にある CLR のコレクションから導出されます。存在しないリストの位置を `GetEntry` が捏造することはできません。

```csharp
// EF Core 10 and 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
if (original)
{
    if (_containingEntry.GetOriginalValue(_complexCollection) == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionEntryOriginalNull(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
else
{
    if (_containingEntry[_complexCollection] == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionNotInitialized(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
```

分岐は 2 つ、メッセージも 2 種類です。`ComplexCollectionNotInitialized` は現在値側の分岐です。代わりに `The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'` が出た場合は、行をマテリアライズした時点でコレクションが `null` で、その後に初期化したということです。

`ChangeDetector` の動きにも注目してください。null のコレクションが必ずしも落ちない理由がここにあります。`DetectComplexCollectionChanges` は両側を読み、null かどうかの差をエラーではなく変更として扱います。

```csharp
// EF Core 11, ChangeDetector.DetectComplexCollectionChanges
var currentCollection = (IList?)entry[complexProperty];
var originalCollection = (IList?)entry.GetOriginalValue(complexProperty);
var changesFound = currentCollection == null != (originalCollection == null);
```

要素を回るループはどちらも `!= null` で守られています。つまり、単に null なだけのコレクションは変更検出を通過します。落ちるのは何かが *要素* に触れたときだけです。

## 原因 1: コレクションプロパティが本当に null

こちらはメッセージが本来の仕事をしている状態です。一度も代入されていないコレクションに対して変更トラッカーのエントリをインデックスした瞬間に発生します。

```csharp
// .NET 10, EF Core 10.0.12. Throws ComplexCollectionNotInitialized.
public class Distributor
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Address> ShippingCenters { get; set; } = null!;  // never assigned
}

var entry = db.Entry(distributor).ComplexCollection(d => d.ShippingCenters)[0];
```

Microsoft の指針は明快です。プロパティが null になりえないよう、コレクションは宣言と同時に初期化してください。

```csharp
// .NET 10, EF Core 10.0.12. The documented shape.
public List<Address> ShippingCenters { get; set; } = new();
```

ナビゲーションコレクションとは違い、EF がリストを作ってくれることはなく、遅延読み込みのプロキシがごまかしてくれることもありません。バグを探しに行く前に、同じ原因の 2 つのバリエーションを確認してください。

- **null 許容のコレクションプロパティ。** `List<Address>? ShippingCenters` と宣言していて JSON 列に SQL の `NULL` が入っていれば、マテリアライズはそのまま `null` を返し、最初の要素アクセスで例外になります。プロパティを null 非許容にして列を `'[]'` で埋め直すか、変更トラッカーに触れる前に null をチェックしてください。
- **パスの途中にある null 許容の複合プロパティ。** `Root[]Group[]Item.Meta.Entries` では、作成するすべての `Meta` で `Entries` を初期化していても、`Meta` 自体が `null` なら読むべき `Entries` はありません。これは後述する EF のバグとまったく同じ形であり、`Meta` をクリアした直後の項目に対してトラッカーをインデックスすれば自分でも再現できます。

このマッピングスタイルが初めてなら、[EF Core 11 における複合型と owned エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)で、多くの人が移行元にしている owned エンティティのグラフと複合型の挙動がどう違うのかを説明しています。設定そのものについては[段階的なマッピングガイド](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)を参照してください。

## 原因 2: dotnet/efcore#38632、再インデックスの経路

興味深いのは、モデル内のコレクションがすべて初期化されているのに `SaveChangesAsync` から例外が出るケースです。4 つの条件がそろう必要がありますが、実際のモデルではどれもありふれているため、特別なことをしていなくても踏んでしまいます。

```csharp
// .NET 10, EF Core 10.0.12. Complex types are never discovered by convention,
// so every value type here carries [ComplexType].
public class Root
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Group> Groups { get; set; } = new();
}

[ComplexType]
public class Group
{
    public required string Title { get; set; }
    public List<Item> Items { get; set; } = new();
}

[ComplexType]
public class Item
{
    public required string Sku { get; set; }
    public Meta? Meta { get; set; }               // nullable complex property
}

[ComplexType]
public class Meta
{
    public required string Kind { get; set; }     // optional complex types need one required property
    public List<Entry> Entries { get; set; } = new();
}

[ComplexType]
public class Entry
{
    public required string Key { get; set; }
    public string? Value { get; set; }
}
```

```csharp
// .NET 10, EF Core 10.0.12. On relational providers a complex collection must be JSON.
modelBuilder.Entity<Root>()
    .ComplexCollection(r => r.Groups, g => g.ToJson());
```

そして変更処理です。読み込んで書き換えて保存する、というごく普通の流れです。

```csharp
// .NET 10, EF Core 10.0.12. Throws inside DetectChanges, before any SQL is sent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);

var item = root.Groups[0].Items[0];
// item.Meta.Entries came back from the JSON column with two elements.
item.Meta = null;

await db.SaveChangesAsync();
```

`Meta` を null にすると、それを含む複合エントリが削除されます。削除は後続エントリの再インデックスを引き起こし、その再インデックスが残った各エントリに `Ordinal` を代入するため、再び `Meta.Entries` に対する `GetEntry` へ戻ってきます。その時点で `Meta` はすでに `null` なので、先ほどの現在値側の分岐が例外を投げます。`Entries` の要素が 1 つ以下なら再インデックスするものがなく、同じコードが問題なく保存できます。外から見てこのバグが理不尽に見えるのはそのためです。

報告者は 10.0.9 と 10.0.10 で遭遇し、コメント投稿者が 2026-08-15 に 10.0.11 で再確認しており、この issue は現在の安定パッチである 10.0.12 に対しても未解決のままです。クラッシュはプロバイダー抽象の上にある共有の変更トラッカーで起きるため、この問題はプロバイダーに依存せず、Npgsql と SQLite の両方で確認されています。プロバイダーだけを上げても解決しません。

## 解決策の詳細

### EF Core 11 RC1 に上げる

[PR #38667](https://github.com/dotnet/efcore/pull/38667) は 2026-07-20 にマイルストーン 11.0-rc1 で `main` にマージされたため、修正は今日すでに `11.0.0-rc.1.26425.128` のパッケージに入っています。変更は新しいロジックではなく順序の入れ替えです。追跡済みのエントリを CLR コレクションの null チェックより先に返すようにしたことで、親の複合値がすでに `null` になっていてもクリーンアップ中の再インデックスが動くようになりました。

```csharp
// EF Core 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
// Must check tracked entries first to allow reindexing during cleanup when the parent is null.
var existingEntries = original ? _originalEntries : _entries;
if (existingEntries != null
    && (uint)ordinal < (uint)existingEntries.Count
    && existingEntries[ordinal] is { } existingEntry)
{
    return existingEntry;
}
```

```xml
<!-- .NET 10 or .NET 11. Bump the provider package to a matching 11.0.0-rc.1 too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="11.0.0-rc.1.26425.128" />
```

EF Core 11 は 2026 年 11 月に .NET 11 と同時に安定版になるので、プレビューを使う期間は短く、いつまでも続くものではありません。とはいえプレビューであることに変わりはないので、出荷する前に EF Core 11 のリリースノート全体に目を通してください。

### サービシングリリースが必要なら 10.0.13 を追う

この issue は `main` の修正後、`release/10.0` へのバックポートを追跡するために再オープンされ、マイルストーン 10.0.13 が付いています。サポート対象のサービシングバンドにいてプレビューを使えないなら、待つべきはこのバージョンです。それまでは 10.0.x 内で更新しても解消しません。

### 変更を 2 回の SaveChanges に分ける

このバグは、親が null になる時点でネストされたコレクションに 2 つ以上の要素があることを必要とします。コレクションを別の保存で空にし、親を null にする前に現在値と元の値のスナップショットを両方とも空にしておけば、再インデックス自体が起きません。

```csharp
// .NET 10, EF Core 10.0.12. Two round trips, no reindex over a null parent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);
var item = root.Groups[0].Items[0];

item.Meta!.Entries.Clear();
await db.SaveChangesAsync();   // original values are accepted here

item.Meta = null;
await db.SaveChangesAsync();
```

これは報告者が最小化した発生条件を裏返したものであり、EF チームの保証ではありません。往復が 1 回増え、単一保存の原子性も失われます。途中の状態を他の読み手に見せたくない場合は両方の呼び出しを明示的なトランザクションで囲み、頼る前に自分のモデルで確認してください。

### 変更トラッカーを通さずに JSON 列を書く

このクラッシュは完全に変更検出の中にあり、`ExecuteUpdateAsync` はそこに一切近づきません。EF Core 10 は JSON にマッピングされた複合コレクションを直接指定できます。

```csharp
// .NET 10, EF Core 10.0.12. Untracked read, then a set-based write.
var groups = await db.Roots
    .AsNoTracking()
    .Where(r => r.Id == id)
    .Select(r => r.Groups)
    .SingleAsync();

groups[0].Items[0].Meta = null;

await db.Roots
    .Where(r => r.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(r => r.Groups, groups));
```

この書き込みでは `SaveChanges` の通常の保証を手放すことになります。楽観的同時実行チェックはなく、`SaveChanges` のインターセプターも動かず、変更された 1 か所ではなく JSON ドキュメント全体が書き換えられます。このパターンをより広く使うつもりなら、トレードオフは [ExecuteUpdate とエンティティ読み込み + SaveChanges の比較](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)で整理しています。

## このページにたどり着きがちな類似メッセージ

`CoreStrings` には複合コレクションと null 値に言及する文字列が他に 4 つありますが、#38632 とは無関係です。

**`The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'.`** これは `ComplexCollectionEntryOriginalNull` で、同じ `if` の兄弟分岐です。行をマテリアライズした時点でコレクションが `null` だったということです。元の値を一度も持たなかったコレクションから元の値を読もうとするのはバグではなく、答えのない問いです。エンティティを読み直すか、その経路で元の値を読むのをやめてください。

**`The value for the property '...' cannot be set, because it's on the complex type collection element '...[N]' that contains a 'null' value.`** これは `ComplexCollectionNullElementSetter` です。コレクション自体は存在しますが、その *要素* のひとつが `null` です。`[{...}, null]` のような JSON 配列で発生します。保存前に null を取り除くか、そもそも配列に書き込まないようにしてください。

**`Complex entry original ordinal '-1' is invalid for property '...' as it's outside of the collection of length 'N'.`** 別のバグで修正方法も異なり、[ToJson の複合コレクション保存時に Complex entry original ordinal '-1' is invalid が出る問題](/ja/2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection/)で扱っています。文言に注目してください。*original ordinal* であり *for property* です。そちらは 10.0.10 で修正済みなので、本記事のケースとは違い 10.0.x 内での更新で解消します。

**`The complex type collection '...' cannot be configured because complex value type collections are not supported.`** これは `ComplexValueTypeCollection` で、保存時ではなくモデル構築時にスローされます。複合コレクションの要素は参照型でなければならず、`Coordinate` が `readonly record struct` である `List<Coordinate>` はマッピングできません。必要であれば [dotnet/efcore#31411](https://github.com/dotnet/efcore/issues/31411) を追跡してください。

エラーが代わりに `AS JSON option can be specified only for column of nvarchar(max)` を含む場合、それは変更トラッカーではなく SQL Server の列型の問題で、[Azure SQL の AS JSON エラーの解決](/ja/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/)で別途扱っています。マッピング全般については[EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)から始めるとよいでしょう。

## 参考資料

- [dotnet/efcore#38632: ComplexCollection + ToJson(): DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [dotnet/efcore#38667: 修正、2026-07-20 にマージ](https://github.com/dotnet/efcore/pull/38667)
- [複合型、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [EF Core のリリースと計画](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
- [ChangeDetector.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/ChangeDetector.cs)
- [CoreStrings.resx, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx)
