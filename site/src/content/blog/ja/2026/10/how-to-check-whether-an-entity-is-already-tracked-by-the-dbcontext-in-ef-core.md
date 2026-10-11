---
title: "EF Core でエンティティを Attach する前に、DbContext がすでに追跡しているか確認する方法"
description: "DbSet.Local.FindEntry(key) を使えば、データベースへの往復やスキャンなしで、指定したキーのエンティティが追跡されているかを変更トラッカーに問い合わせられます。この確認で Entry(entity).State が当てにならない理由、Find がクエリを発行する理由、EF Core 10 で検証済みの AttachOrMerge ヘルパーを紹介します。"
pubDate: 2026-10-11
template: how-to
tags:
  - "ef-core"
  - "dotnet-10"
  - "csharp"
  - "change-tracker"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-11
---

**結論:** `db.Set<T>().Local.FindEntry(id)` を呼び出してください。そのプライマリキーで追跡されている `EntityEntry<T>` を返し、該当するものがなければ `null` を返します。データベースへのクエリは一切発行しません。エントリが返ってきた場合は、Attach せずに `entry.CurrentValues.SetValues(incoming)` で値をそのエントリにコピーします。`null` が返ってきた場合は、`Attach` または `Update` を安全に呼び出せます。複合キーの場合は `Local.FindEntryUntyped([part1, part2])` を使います。この確認に `db.Entry(incoming).State == EntityState.Detached` を使ってはいけません。これが示すのはそのオブジェクトインスタンス自身の状態だけで、キーについては何も分かりません。

以下の内容はすべて、.NET 10 SDK 10.0.302 上の EF Core 10.0.12 (`Microsoft.EntityFrameworkCore.Sqlite` 10.0.12) で実行したものです。`LocalView<T>.FindEntry` ファミリーは EF Core 8 で追加されたため ([dotnet/efcore#29686](https://github.com/dotnet/efcore/pull/29686))、同じコードが EF Core 8、9、10、および EF Core 11 のリリース候補でも動作します。

## "追跡されているか" はオブジェクトではなくキーの問題である理由

変更トラッカーは ID マップを保持しています。エンティティ型ごとに、プライマリキーの値 1 つにつき追跡対象の CLR インスタンスを 1 つだけ持ちます。マップにすでにあるキーと同じキーを持つ別のインスタンスで `Attach`、`Update`、`Add` を呼び出すと、EF Core はおなじみの [`The instance of entity type cannot be tracked because another instance with the same key value is already being tracked`](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) 例外をスローします。

つまり、Attach の前に知りたいのは "ID マップがこのキーを持つインスタンスを *何か* 保持しているか" です。これは "*このインスタンス* が追跡されているか" とは別の問いであり、最もよく勧められる確認方法は後者に答えるものです。

## 落とし穴の最小再現

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite
using var db = new Shop(options);

var tracked  = db.Customers.First(c => c.Id == 1);           // tracked, Unchanged
var incoming = new Customer { Id = 1, Name = "changed" };    // e.g. deserialized from a request

Console.WriteLine(db.Entry(tracked).State);   // Unchanged
Console.WriteLine(db.Entry(incoming).State);  // Detached  <-- looks "safe"

db.Attach(incoming);
// InvalidOperationException: The instance of entity type 'Customer' cannot be tracked
// because another instance with the same key value for {'Id'} is already being tracked.
```

`incoming` は実際に追跡されていないため、`db.Entry(incoming)` は例外もスローせずに `Detached` 状態のエントリを返します。オブジェクトの追跡を開始することもありません (私の実行結果では、その後も変更トラッカーが保持するエントリはちょうど 1 つのままでした)。`if (db.Entry(x).State == EntityState.Detached) db.Attach(x);` というコードは、確認を通過した直後の行で例外をスローします。このパターンは "まったく同じオブジェクトをすでに Attach したか" の確認には問題ありませんが、DTO、キャッシュ、JSON ボディから来たオブジェクトを扱う切断シナリオでは誤りです。

## 各手法の計測結果

`CoreEventId.DetectChangesStarting` にカウンターを仕込み、実行されたリーダーの数を数える `DbCommandInterceptor` も用意して、`Customer` を 1 件追跡しているコンテキストに対してすべての候補を実行しました。

| 確認方法 | キーの問いに答えられるか | `DetectChanges` の実行回数 | DB クエリ数 |
| --- | --- | --- | --- |
| `db.Entry(incoming).State` | いいえ、そのインスタンスについてのみ | 0 | 0 |
| `db.ChangeTracker.Entries<Customer>().Any(e => e.Entity.Id == 1)` | はい、線形スキャンで | 1 | 0 |
| `db.Customers.Find(1)` (追跡中) | はい、追跡中のインスタンスを返す | 0 | 0 |
| `db.Customers.Find(2)` (未追跡) | 確認にならない: 行を読み込む | 0 | 1 |
| `db.Customers.Local.FindEntry(1)` | はい、ID マップの参照で | 1 (`Local` のゲッター由来) | 0 |
| `cachedLocal.FindEntry(1)` | はい | 0 | 0 |

いくつか目に付く点があります。

**`Find` は追跡の確認ではありません。** 最初に ID マップを調べるので、追跡中の場合はコストがかかりませんが、キーが追跡されていないときはデータベースに問い合わせ、見つかったものの追跡を開始します。Attach するかどうかの判断に `Find` を使うと、必要のない行を読み込むことになるか、追跡中のインスタンスが返ってきたところに自分のコピーを Attach して例外になるかのどちらかです。

**`ChangeTracker.Entries<T>()` は動作しますがスキャンします。** 最初に `DetectChanges` を実行し、その型の追跡中エントリをすべて列挙します。エンティティが 10 件ならほぼ無視できます。しかし、デスクトップアプリや、数万件のエントリを保持するバッチジョブのような長寿命のコンテキストで、受け取った項目ごとにこれを行うと二次関数的に遅くなります (EF Core 11 の [`GetEntriesForState` API](/ja/2026/04/efcore-11-changetracker-getentriesforstate/) は `DetectChanges` のパスを省略しますが、それでも列挙です)。

**`Local.FindEntry` はこの用途のために作られた API です。** `Attach` が確認するのと同じ ID マップでキーを解決するので、`Attach` が実際に判断に使う答えとまったく同じものが得られます。表の `DetectChanges` の 1 回は `FindEntry` ではなく `DbSet<T>.Local` プロパティのゲッター由来です。`LocalView<Customer>` を変数にキャッシュして `FindEntry` を呼び出したところ、カウンターはゼロのままでした。[API ドキュメント](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry)にも同じことが書かれており、繰り返し検索する場合は `Local` オブジェクトを再利用することが推奨されています。

## 確認してから Attach またはマージする

この疑問が最もよく出てくる切断更新のシナリオでの手順は次のとおりです。

1. ローカルビューを一度だけ取得します: `var local = db.Customers.Local;`。
2. `local.FindEntry(incoming.Id)` でキーを検索します。
3. エントリが返ってきた場合は、`entry.CurrentValues.SetValues(incoming)` で受け取った値を追跡中のインスタンスにコピーします。EF Core は実際に値が変わったプロパティだけを変更済みとしてマークします。
4. `null` が返ってきた場合は、そのキーを保持するものがないので、`Update(incoming)` (または `Attach` と明示的な `IsModified` フラグ) を安全に使えます。
5. 最後に `SaveChanges` を一度だけ呼び出します。

ヘルパーにすると次のようになります。

```csharp
// .NET 10, EF Core 10.0.12
static Customer AttachOrMerge(Shop db, Customer incoming)
{
    var existing = db.Customers.Local.FindEntry(incoming.Id);
    if (existing is null)
    {
        db.Customers.Update(incoming);   // nothing tracked with this key
        return incoming;
    }

    existing.CurrentValues.SetValues(incoming);  // merge into the tracked instance
    return existing.Entity;
}
```

顧客 1 をすでに追跡しているコンテキストに対して実行した結果です。

```text
Helper: same=True state=Modified name=merged modifiedProps=Name
```

返されたオブジェクトはコンテキストがもともと追跡していたインスタンスで、状態は `Unchanged` から `Modified` に変わり、フラグが立っているのは `Name` だけなので、生成される `UPDATE` は 1 列だけを対象にします。呼び出し元には `incoming` ではなく追跡中のインスタンスを返してください。マージ後も `incoming` は EF Core が何も知らない切断されたオブジェクトのままです。

## あらゆるエンティティ型に使える汎用版

エンティティ型ごとにヘルパーを用意したいことはほとんどないでしょう。`FindEntryUntyped` はキーの値をキーの順序どおりに `IEnumerable<object?>` として受け取り、どのプロパティがプライマリキーを構成するかはモデルから分かります。

```csharp
// .NET 10, EF Core 10.0.12
static EntityEntry<T>? FindTrackedEntry<T>(DbContext db, T entity) where T : class
{
    var key = db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!;
    var entry = db.Entry(entity);   // Detached entry, does not start tracking
    var keyValues = key.Properties
        .Select(p => entry.Property(p.Name).CurrentValue)
        .ToArray();

    return db.Set<T>().Local.FindEntryUntyped(keyValues);
}

static bool IsTracked<T>(DbContext db, params object?[] keyValues) where T : class
    => db.Set<T>().Local.FindEntryUntyped(keyValues) is not null;
```

リフレクションではなく `db.Entry(entity).Property(...)` 経由でキーを読み取るので、シャドウプロパティのキーやフィールドにマップされたキーも特別な処理なしで動作します。再現コードでは、`incoming` 自体は別のオブジェクトであるにもかかわらず、`FindTrackedEntry(db, incoming)` が追跡中の顧客を見つけました。これは `Entry(...).State` による確認にはない挙動です。

## ハマりやすい注意点

### 複合キーには `FindEntry` ではなく `FindEntryUntyped` が必要

`FindEntry` はジェネリックで、`FindEntry<TKey>(TKey keyValue)` です。配列やリストを渡すと、コンパイラは `TKey` を `object[]` や `List<object?>` に問題なくバインドし、EF Core は全体を 1 つのキー値として扱います。

```csharp
// .NET 10, EF Core 10.0.12. OrderLine has HasKey(x => new { x.OrderId, x.LineNo })
db.OrderLines.Local.FindEntry(new object[] { 10, 1 });
// ArgumentException: Entity type 'OrderLine' is defined with a 2-part composite key,
// but 1 values were passed to the 'Find' method.

db.OrderLines.Local.FindEntryUntyped([10, 1]);   // works, returns the tracked entry
```

非ジェネリックのオーバーロードに当たることを期待して、`IEnumerable<object?>` 型の変数も試しましたが、同じ例外でした。プライマリキー用の `FindEntry(IEnumerable<object?>)` オーバーロードは存在せず、型なし版は別の名前になっています。

### キーの型は完全に一致している必要がある

`FindEntry<TKey>` は型変換を行いません。`int` のキーの場合は次のようになります。

```text
FindEntry(1L): ArgumentException: Property 'Customer.Id' is of type 'int' but the generic type provided is of type 'long'.
```

`FindEntryUntyped` も寛容ではなく、ボックス化された型を確認します。

```text
FindEntryUntyped([1L]): ArgumentException: The 'FindEntry' or 'GetEntries' method was passed a 'long' value for the 'Id' property, when a 'int' value was expected.
```

これは、キーがルート値や、`long` または `object` で型付けされたジェネリックリポジトリから渡されるときに発生します。呼び出す前に、キープロパティの CLR 型 (`key.Properties[i].ClrType`) に変換してください。

### 削除済みのエンティティも追跡されたまま

`db.Customers.Remove(customer2)` の後は次のようになります。

```text
FindEntry(2) after Remove: Deleted; Local.Count=1; Find(2)=entity
```

ローカルの *コレクション* は `Deleted` のエンティティを隠しますが (`Local.Count` は 1 に減りました。[ドキュメントの説明](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries#the-local-view)のとおりです)、`FindEntry` はそのエントリを返し、`Find` も同様です。キーはまだ ID マップに残っており、`Attach` も例外をスローするので、今回の目的にはこれが正しい挙動です。ただし、マージのロジックが "見つかった" を "有効である" と見なしている場合は、`SetValues` を呼び出す前に `entry.State` を確認してください。そうしないと、`SaveChanges` が削除しようとしている行にプロパティの変更を復活させてしまいます。

### "追跡されていない" は "データベースに存在する" を意味しない

`FindEntry` が `null` を返したとき、ヘルパーは `Update` を呼び出します。これはすべてのプロパティを変更済みとしてマークし、`UPDATE` を生成します。テーブルに存在しないキーの場合、`SaveChanges` は 0 行にしか影響せず、`DbUpdateConcurrencyException` をスローします。再現コードでは、`AttachOrMerge(db, new Customer { Id = 3 })` はエンティティを `Added` ではなく `Modified` のままにしました。受け取ったオブジェクトが新規である可能性がある場合は、`Add` と `Update` のどちらを使うかを、自分のデータ (既定のキー、バージョン列、明示的なフラグ) から事前に判断してください。別の選択肢として、追跡自体を避けて書き込みに [`ExecuteUpdate`](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) を使う方法もあります。

### ストア生成キーの既定値

`Id` が `0` の `Customer` を Attach しても、例外にはならず衝突もしません。EF Core は未設定のストア生成キーと見なし、一時的な値を持つ `Added` としてエンティティを追跡します。この場合、先に `FindEntry(0)` を確認しても有用な情報は得られません。検索の前に `entry.IsKeySet` (または `id == default`) で分岐してください。

### 代替キーや外部キーによる検索

`LocalView<T>` には、プライマリキー以外での検索用に `FindEntry<TProperty>(string propertyName, TProperty value)` と `GetEntries(...)` もあります。たとえば `Local.FindEntry(nameof(Customer.Email), email)` のように使います。プロパティが代替キーまたは外部キーの場合、EF Core がすでにそれらの参照を保持しているため高速です。通常のプロパティでは、追跡中のエントリのスキャンにフォールバックします。再現コードでは、`Local.FindEntry(nameof(Customer.Name), "a")` は正しいエントリを返しましたが、`Name` はキーではないため、スキャンでした。

### AutoDetectChanges を無効にした場合

`db.ChangeTracker.AutoDetectChangesEnabled = false` にすると、`Local` のゲッターも `Entries<T>()` も `DetectChanges` を起動しません (どちらもカウンターは 0)。追跡中のエンティティのキーは変更できないため、ID マップの検索には影響しません。一括インポートのループで自動検出を無効にした場合は、追跡中のエンティティを直接変更するときに、`SaveChanges` の前に自分で `db.ChangeTracker.DetectChanges()` を呼び出してください。

## 追跡しないことがより良い解決策になる場合

この確認がコードに必要になっているのが、同じコンテキストで先に行った読み取りによって、今から更新したいエンティティが追跡されたためである場合、上流で解決するほうがすっきりすることがよくあります。結果を表示するだけの場合や DTO にマップするだけの場合は `AsNoTracking()` で読み取り ([AsNoTracking と AsNoTrackingWithIdentityResolution の比較](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)で、どちらを選ぶべきかを解説しています)、コンテキストを短寿命に保って、ある作業単位が別の作業単位の追跡中エンティティを引き継がないようにします。`FindEntry` が適しているのは、1 つのコンテキストが同じキーを 2 つの方向から正当に目にする場合です。たとえば、長寿命のコンテキストを持つデスクトップアプリ、複数のファイルからレコードをマージするバッチジョブ、すでに読み込み済みのエンティティと一部重複するエンティティを含んだグラフが届く場合などです。

同じ検索はテストでも役立ちます。プロバイダーをフェイクに置き換えていて、アサーションが追跡対象に依存する場合、`Local.FindEntry` は実際の ID マップを読み取るため、[変更追跡を壊さずに DbContext をモックする方法](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)で説明されているとおり、テストの正確性を保てます。

### 次に読む

- [Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)
- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/ja/2026/04/efcore-11-changetracker-getentriesforstate/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [ExecuteUpdate vs loading entities and SaveChanges](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## 参考資料

- [`LocalView<TEntity>.FindEntry` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry), Microsoft Learn.
- [`LocalView<TEntity>.FindEntryUntyped` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentryuntyped), Microsoft Learn.
- [Accessing tracked entities](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries), EF Core docs (Entry、Find、Entries、ローカルビューとその `DetectChanges` のコスト)。
- [Lookup entities by primary key, alternate key, or foreign key](https://github.com/dotnet/efcore/pull/29686), dotnet/efcore PR #29686 (2022 年 12 月にマージ、EF Core 8 で提供)。
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), EF Core docs.
