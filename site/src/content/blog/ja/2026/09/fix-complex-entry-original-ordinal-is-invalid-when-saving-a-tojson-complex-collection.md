---
title: "解決: ToJson の複合コレクション保存時に Complex entry original ordinal '-1' is invalid が出る"
description: "Microsoft.EntityFrameworkCore を 10.0.10 以降へ更新してください。それ以前は、2 つ目の ToJson 複合プロパティ配下でネストしたコレクションが増えると SaveChanges が失敗しました。"
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
translationOf: "2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection"
translatedBy: "claude"
translationDate: 2026-09-09
---

`Microsoft.EntityFrameworkCore` を 10.0.10 以降へ更新してください。10.0.0 から 10.0.9 では、エンティティが `ToJson()` で 2 つ以上の複合プロパティをマッピングしていて、そのうちの 1 つの中にネストしたコレクションが読み込みと保存の間に要素を 1 つ増やすと、変更トラッカーが平坦化されたすべての複合エントリを `Modified` または `Unchanged` に強制していました。正当に `Added` だったエントリも巻き込まれます。`Added` の要素は設計上、元の序数が `-1` になるため、状態遷移がそのまま `ValidateOrdinal` に突き当たって例外を投げていました。修正は `InternalEntryBase` の 1 行のガードで、プロバイダーには依存せず、更新後に変更すべき設定はありません。

## エラーの実際の姿

例外は SQL が送信される前、`SaveChanges` または `SaveChangesAsync` から発生します。

```
System.InvalidOperationException: Complex entry original ordinal '-1' is invalid for property
'XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner' as it's outside of the collection
of length '1'.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.
      InternalComplexCollectionEntry.ValidateOrdinal(InternalComplexEntry entry, Boolean original)
```

メッセージ中のプロパティパスは平坦化された連鎖であり、C# の式ではありません。`[]` は複合コレクションを 1 段たどることを表すので、`XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner` は「`XWidget` の `XDeepData` にぶら下がる `XMiddleData` 要素の中の `XDeepItem` 要素の中にある `XInnerEntry` の `Inner` コレクション」と読みます。このパスが問題のプロパティへの最短経路です。

先へ進む前に確認しておく価値のある点が 2 つあります。よく似たエラーと区別するための手がかりだからです。1 つ目は、このメッセージが **original ordinal** と **for property** と書いている点です。兄弟のメッセージは **ordinal** と **for the collection** と書き、根本原因も異なります。2 つ目は、末尾の件数が *元の* コレクション、つまり EF がデータベースから読み込んだ側のサイズであり、保存しようとしているコレクションのサイズではないという点です。

## なぜ序数が -1 になるのか: EF Core が複合コレクションで実際に追跡しているもの

複合コレクションは EF Core 10 で登場し、リレーショナルプロバイダーでは `ToJson()` によって単一の JSON 列へマッピングしなければなりません。別テーブルに置くことはできません。この制約がここでは効いてきます。テーブルもキーも存在しないため、EF は owned エンティティのように主キーで要素を識別できません。識別に使うのは **配列内の位置** です。

そのため変更トラッカーは `InternalComplexEntry` で要素ごとに 2 つの位置を保持します。

```csharp
// EF Core 10.0 / 11.0, src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs
public int Ordinal
{
    // -1 is used to indicate that the entry is deleted
    get;
    set { /* ... */ }
}

public int OriginalOrdinal
{
    // -1 is used to indicate that the entry is added
    get;
    set { /* ... */ }
}
```

`Ordinal` はこれから保存するコレクション内での要素の位置です。`OriginalOrdinal` は EF がマテリアライズしたコレクション内での位置です。2 つのセンチネル値がすべてを物語ります。

- **削除した** 要素は現在のコレクションに位置を持たないため、`Ordinal` は `-1` になります。
- **追加した** 要素は元のコレクションに位置を持たないため、`OriginalOrdinal` は `-1` になります。

追跡状態へ入る状態遷移はすべて、対応する序数を境界チェックに通します。

```csharp
// EF Core 10.0, InternalEntryBase.InternalComplexCollectionEntry.ValidateOrdinal
public readonly int ValidateOrdinal(InternalComplexEntry entry, bool original, List<InternalComplexEntry?> entries)
{
    var ordinal = original ? entry.OriginalOrdinal : entry.Ordinal;
    if (ordinal < 0 || ordinal >= entries.Count)
    {
        var property = entry.ComplexProperty;
        throw new InvalidOperationException(
            original
                ? CoreStrings.ComplexCollectionEntryOriginalOrdinalInvalid(/* ... */)
                : CoreStrings.ComplexCollectionEntryOrdinalInvalid(/* ... */));
    }
    // ...
}
```

このチェック自体は単独で見れば正しいものです。`-1` は実際に範囲外です。バグは、上流の何かが `Added` のエントリに `Modified` になるよう求めていた点にあり、`Added -> Modified` はまさに元の序数を検証する遷移です。`OriginalOrdinal == -1` であるべきエントリが、それを禁じるコードパスへ押し込まれていたわけです。

その上流の呼び出し元が `SetComplexCollectionModified` でした。変更検出が複合コレクションに変更ありと判断すると、エンティティのネストしたグラフ全体の複合エントリを返す `GetFlattenedComplexEntries()` を走査し、それぞれを `Modified` か `Unchanged` に設定していました。追加されたばかりの要素も他と一緒に巻き込まれていたのです。

## 最小の再現: 2 つの JSON 複合プロパティと増えるネストコレクション

[dotnet/efcore#38299](https://github.com/dotnet/efcore/issues/38299) の報告者は、同時に成立する必要のある 4 つの条件までトリガーを絞り込みました。

1. エンティティが `ToJson()` で 2 つ以上の複合プロパティをマッピングしている。
2. その JSON ドキュメントの 1 つが、それ自体コレクションを持つネストしたオブジェクトを含んでいる。
3. ネストしたコレクションの要素型が、`List<T>` のサブコレクションプロパティを 2 つ以上宣言している。
4. そのサブコレクションのいずれかが読み込みと保存の間に増える。

どれか 1 つでも欠けるとエンティティは問題なく保存されます。実際のコードベースでこれが断続的に見えるのはそのためです。4 つすべてを満たす最小のモデルを示します。

```csharp
// .NET 10, EF Core 10.0.7, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.1
public class Widget
{
    public int Id { get; set; }
    public required FlatData Flat { get; set; }   // JSON column 1
    public required DeepData Deep { get; set; }   // JSON column 2
}

public class FlatData
{
    public string? Note { get; set; }
}

public class DeepData
{
    public List<MiddleData> Middle { get; set; } = [];
}

public class MiddleData
{
    public string Name { get; set; } = "";
    public List<InnerEntry> Inner { get; set; } = [];   // sub-collection 1
    public List<InnerEntry> Extra { get; set; } = [];   // sub-collection 2
}

public class InnerEntry
{
    public string Value { get; set; } = "";
}
```

マッピングは 2 つのルートに `ComplexProperty` を、ネストした部分すべてに `ComplexCollection` を使います。ルートに `ToJson()` を付ければ十分で、ネストしたコレクションは JSON マッピングを継承します。

```csharp
// .NET 10, EF Core 10.0.7
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Widget>(b =>
    {
        b.ComplexProperty(w => w.Flat, c => c.ToJson());

        b.ComplexProperty(w => w.Deep, c =>
        {
            c.ToJson();
            c.ComplexCollection(d => d.Middle, m =>
            {
                m.ComplexCollection(x => x.Inner);
                m.ComplexCollection(x => x.Extra);
            });
        });
    });
}
```

そして落ちる 2 行はこれです。

```csharp
// .NET 10, EF Core 10.0.7. Throws on SaveChangesAsync, before any SQL is generated.
var widget = await db.Widgets.SingleAsync(w => w.Id == 1);
widget.Deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });
await db.SaveChangesAsync();
```

特殊なことは何もしていません。Microsoft 自身の推奨に従って JSON マッピングされた owned エンティティのグラフを複合型へ移した瞬間に行き着く形であり、報告がこの移行中のチームに集中しているのもそのためです。この移行を検討しているなら、[EF Core 11 における複合型と owned エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)がトレードオフを、[段階的なマッピングガイド](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)が設定方法を扱っています。

## 修正の詳細

### EF Core 10.0.10 以降へ更新する

これが本来の修正で、`release/10.0` に対する [PR #38373](https://github.com/dotnet/efcore/pull/38373) で出荷されました。プロバイダーを含め、EF Core のパッケージをまとめて上げてください。

```xml
<!-- .NET 10. Bump the provider package to a matching 10.0.x too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.12" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.12" />
```

この変更は、再帰的な走査に `Added` のエントリをそのままにしておくよう教えます。

```csharp
// EF Core 10.0.10+, InternalEntryBase.SetComplexCollectionModified
if (recurse)
{
    var newElementState = isModified ? EntityState.Modified : EntityState.Unchanged;
    foreach (var complexEntry in GetFlattenedComplexEntries())
    {
        // Added elements represent pending additions with no original ordinal, so forcing them to
        // Modified/Unchanged is incorrect and would fail the original ordinal validation. Leave their
        // state (computed by change detection) untouched, mirroring the bulk state-change logic in
        // InternalComplexCollectionEntry.SetState.
        if (!UseOldBehavior38299
            && complexEntry.EntityState is EntityState.Added)
        {
            continue;
        }

        complexEntry.SetEntityState(newElementState, modifyProperties: true);
    }
}
```

パッチを読むと 2 点が分かります。ガードはプロバイダー抽象より上の共通の変更トラッカーにあるため、SQL Server、Npgsql、SQLite を一度に修正します。プロバイダーの更新だけで解決すると期待していたなら、それでは直りません。また同じガードは `UseOldBehavior38299` フラグなしで EF Core 11 のコードベースにも入っているので、EF Core 11 への更新でも解消します。

### 10.0.10 未満に固定されている場合は、変更トラッカーを通さずに JSON 列を書く

このクラッシュは完全に変更追跡の中で起きます。`ExecuteUpdateAsync` はそこに一切触れませんし、EF Core 10 は JSON マッピングされた複合プロパティを直接指定できます。

```csharp
// .NET 10, EF Core 10.0.7. Untracked read, then a set-based write.
var deep = await db.Widgets
    .AsNoTracking()
    .Where(w => w.Id == id)
    .Select(w => w.Deep)
    .SingleAsync();

deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });

await db.Widgets
    .Where(w => w.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(w => w.Deep, deep));
```

その代わり `SaveChanges` の通常の保証は失われます。楽観的同時実行トークンのチェックはなく、書き込みに対するインターセプターも動かず、変更された 1 か所ではなく JSON ドキュメント全体が書き直されます。採用を決める前に自分のプロバイダーで変換を確認してください。`ExecuteUpdate` をより広く使うつもりなら、トレードオフは[ExecuteUpdate とエンティティ読み込み + SaveChanges の比較](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)で整理しています。

### モデルを変更できるなら、4 つの条件のどれかを崩す

条件 1 を取り除くのが一番安上がりです。走査が `Added` と `-1` という悪い組み合わせを生むのは、エンティティが JSON の複合プロパティを 2 つ以上持つ場合だけなので、2 つ目をテーブル分割でマッピングすれば対象から外れます。

```csharp
// .NET 10, EF Core 10.0.7. Flat becomes Flat_Note on the Widgets table.
b.ComplexProperty(w => w.Flat);   // no ToJson()
```

これはマイグレーションが必要で、保存形式も変わります。手早い回避策ではなく最後の手段として扱ってください。条件 3 がもう 1 つの狙い目です。ネストした要素型が `List<T>` を 1 つしか宣言していなければ、報告されたトリガーの形から外れます。どちらも EF チームが保証したものではなく、報告者の最小化したトリガー一覧を裏返しただけなので、頼る前に自分のモデルで確認してください。

## 注意点と派生: この系統に属する他の序数エラー

変更トラッカーの同じ一角から出てくる別のメッセージが 3 つあり、これと混同されがちです。

**`Complex entry ordinal '-1' is invalid for the collection '...' as it's outside of the collection of length 'N'.`** 文言に注目してください。*original ordinal* ではなく *ordinal*、*for property* ではなく *for the collection* です。これはエンティティを `Deleted` から `Unchanged` に戻すとき、つまり手書きの論理削除でよくある操作で発生します。[dotnet/efcore#37724](https://github.com/dotnet/efcore/issues/37724) がそれで、**10.0.6** で現在の序数を元の序数から復元することで修正されました。

```csharp
// EF Core 10.0.6+, InternalComplexEntry.SetEntityState
if (oldState is EntityState.Detached or EntityState.Deleted
    && newState is not EntityState.Detached and not EntityState.Deleted)
{
    if (!UseOldBehavior37724 && Ordinal == -1)
    {
        Ordinal = OriginalOrdinal;
    }

    ContainingEntry.ValidateOrdinal(this, original: false);
}
```

`EntityState` を手で切り替えて論理削除を書いているなら、そもそもやめることを検討してください。[名前付きクエリフィルター](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)なら変更トラッカーに触れずに同じ意図を表現できます。

**`Index was out of range. Must be non-negative and less than the size of the collection.`** これは `InvalidOperationException` ではなく `ArgumentOutOfRangeException` で、データベースの更新が成功した後の変更確定フェーズで投げられます。[dotnet/efcore#37585](https://github.com/dotnet/efcore/issues/37585) がそれで、要素自身がリストを持つ複合コレクションから要素を削除すると発生します。こちらも **10.0.6** で修正済みです。

**`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.`** 追跡中のエンティティで、コレクションを含む null 許容の複合プロパティに `null` を設定し、そのネストしたコレクションが 2 件以上のとき発生します。[dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632) がそれで、**10.0.13** にマイルストーンが設定されています。最新の安定パッチである EF Core 10.0.12 の時点ではまだオープンなので、このメッセージが出ている場合は更新してもまだ解決しません。

序数のエラーが EF ではなく本当に自分のバグである場合もあります。`ComplexCollectionEntry` はインデクサーと `GetOriginalEntry(int)` を公開しており、どちらも検証を行います。

```csharp
// .NET 10, EF Core 10.0.12. Throws if the collection has fewer than 4 elements.
var entry = db.Entry(widget).ComplexCollection(w => w.Deep.Middle)[3];

// Throws if the collection loaded from the database had fewer than 4 elements,
// even when the current collection is longer.
var original = db.Entry(widget).ComplexCollection(w => w.Deep.Middle).GetOriginalEntry(3);
```

落とし穴は 2 行目です。メモリ上で追加した後にしか存在しないインデックスで元のエントリを読むと、上のバグと同じ *original ordinal* の文言が、`-1` ではなく正の序数付きで出ます。メッセージ中の序数が `-1` でないなら、見ているのは自分のインデックス計算です。

## Microsoft.EntityFrameworkCore.Issue38299 スイッチは実際には何をするのか?

これらのパッチはいずれも、`release/10.0` ブランチでは `AppContext` の互換性スイッチの背後で出荷されています。

```csharp
// EF Core 10.0.x, InternalEntryBase.InternalComplexCollectionEntry.cs
internal static readonly bool UseOldBehavior37724 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue37724", out var enabled) && enabled;

internal static readonly bool UseOldBehavior38299 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue38299", out var enabled) && enabled;
```

向きをよく読んでください。多くの人が名前から受け取る印象とは逆です。このスイッチを `true` にすると **古い、壊れたほうの動作が復元されます**。バグの上に回避策を組んでしまったチームが、その回避策を壊さずにパッチリリースを取り込めるようにするためのものです。修正ではありませんし、有効にすればここへ来る原因となった例外がそのまま戻ってきます。

古い動作を一時的に固定する必要が本当にあるなら、EF の型が読み込まれる前に設定されるよう、コードではなくプロジェクトファイルに書きます。

```xml
<!-- .NET 10. Restores pre-10.0.10 behaviour. Do not use this to "fix" the crash. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.Issue38299" Value="true" />
</ItemGroup>
```

これらのスイッチは変更履歴も兼ねています。`src/EFCore/ChangeTracking/Internal/` で `UseOldBehavior` を `grep` すれば、10.0 のパッチ系列で複合コレクションの追跡がどう変わったかの完全な一覧が得られます。`InternalEntryBase` に `37724` と `38299`、ネストした `InternalComplexCollectionEntry` 構造体の中に `37585` と `38632` です。

4 つのバグはいずれも SQL 生成ではなく変更追跡の中にあるため、クエリログにもプロファイラーのトレースにも `dotnet ef migrations script` の差分にも現れません。最初の手がかりは常に、スタックの上のほうに `ValidateOrdinal` のフレームを伴う `SaveChanges` での例外です。そのフレームを見つけたら、モデルの設定を読むのはやめて、真っ先にパッケージのバージョンを確認してください。

## 関連記事

- [EF Core 11 における複合型と owned エンティティ: どちらを選ぶべきか](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [EF Core 11 で owned エンティティの代わりに複合型をマッピングする方法](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)
- [EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [解決: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause](/ja/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/)
- [EF Core 11 で論理削除とマルチテナンシーに名前付きクエリフィルターを使う方法](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)

## 参考資料

- [dotnet/efcore#38299: ComplexProperty ToJson(): SaveChangesAsync throws "ordinal -1 is invalid" when nested sub-collection grows](https://github.com/dotnet/efcore/issues/38299)
- [dotnet/efcore#38373: release/10.0 に対する修正](https://github.com/dotnet/efcore/pull/38373)
- [dotnet/efcore#37724: Can't change state of entity with complex collection](https://github.com/dotnet/efcore/issues/37724)
- [dotnet/efcore#37585: Deleting an item from a ComplexCollection that contains an array results in Error](https://github.com/dotnet/efcore/issues/37585)
- [dotnet/efcore#38632: DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [複合型、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [InternalComplexEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
