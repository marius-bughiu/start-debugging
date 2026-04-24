---
title: "EF Core 11 で record を正しく使う方法"
description: "C# の record と EF Core 11 を組み合わせる実践的なガイド。record がどこに収まり、どこで change tracking を壊すのか、そしてフレームワークと戦わずに value object、エンティティ、プロジェクションをモデリングする方法。"
pubDate: 2026-04-21
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "records"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/04/how-to-use-records-with-ef-core-11-correctly"
translatedBy: "claude"
translationDate: 2026-04-24
---

短い答え: EF Core 11 と C# 14 では、プロジェクション、DTO、複合型 (value object) には `record class` 型を使い、トラッキング対象のエンティティには init-only プロパティとバインディングコンストラクターを持つ普通の `class` を選びます。`record struct` は複合型としては問題ありませんが、トラッキング対象のエンティティとしては絶対に使ってはいけません。人々がぶつかる摩擦は、ほぼ必ず、位置指定 record を完全なエンティティとして使おうとして、`with` 式・値等価性・読み取り専用主キーが EF Core の identity tracking と衝突したときに驚くことから来ます。修正は設定ではなく、どの形の record がどの席に座るかを知ることです。

この記事では 3 つの席 (エンティティ、複合型、プロジェクション) を扱い、EF Core 11 で実際に出荷されているコンストラクターバインディングのルールを示し、人々がつまずく具体的な落とし穴を歩いていきます: store-generated キー、`with` 式、ナビゲーションプロパティ、値等価性の落とし穴、そして JSON にマッピングされた record。

## なぜ record と EF Core は喧嘩する評判があるのか

C# の record は、不変で値等価のデータ型を簡単にするように設計されました。`record Address(string City, string Zip)` の 2 つのインスタンスは、フィールドが等しいときに等しく、同じ参照のときではありません。これがまさに value object に対して正しいセマンティクスです。

EF Core の change tracker は反対の前提で構築されています。[ChangeTracker](https://learn.microsoft.com/en-us/ef/core/change-tracking/) はエンティティが最初にアタッチされたときの各エンティティのプロパティ値のスナップショットを保存し、[identity resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution) は単一の `DbContext` 内では主キーごとに正確に 1 つの CLR インスタンスがあると言います。両方とも値同一性ではなく参照同一性に依存しています。`record` に主キーをスタンプし、`with` で新しいインスタンスを作って変更すると、等しいと比較されるが同じトラッキング対象エンティティではない 2 つの CLR 参照が手元にあります。change tracker は PK が既にトラックされているとして例外を投げるか、編集を黙って無視します。

公式の C# ドキュメントは長年「record 型は Entity Framework Core でエンティティ型として使うのに適していない」と述べています。この警告は上記の状況の率直な要約であり、厳格な禁止ではありません。record をエンティティとして使うことはでき、EF Core 11 はそれに必要なすべてのメカニズムをサポートし続けています。位置指定でない、init-only な形を選び、[EF Core のコンストラクタードキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/constructors) のコンストラクターバインディングのルールに従って遊ぶ必要があるだけです。

## 席 1: 複合型としての record (スイートスポット)

EF Core 8 が `ComplexProperty` を導入し、EF Core 11 は複合型を、ほとんどの場合における owned エンティティのデフォルト代替として推奨できる程度に安定させました。複合型こそが record が輝く場所です: 複合型は独自のアイデンティティを持たず、その値等価性はデータベースのセマンティクスと一致し、いずれかのフィールドが変わったときに丸ごと置き換えられることを意図しています。

```csharp
// .NET 11, C# 14, EF Core 11
public record Address(string Street, string City, string PostalCode);

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Address ShippingAddress { get; set; } = new("", "", "");
    public Address BillingAddress { get; set; } = new("", "", "");
}

// OnModelCreating
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress);
    b.ComplexProperty(c => c.BillingAddress);
});
```

これを成立させるもの:

- `Address` は位置指定の `record class` です。EF Core はプライマリコンストラクターがプロパティ名と 1 対 1 で一致するため、複合型として位置指定 record を箱から出してそのままマップします。
- `Address` は独自の主キーを必要としません。複合型はアイデンティティを持たないからです。
- 顧客の `ShippingAddress` を `customer.ShippingAddress = customer.ShippingAddress with { City = "Cluj" };` で置き換えると、期待通りトラッキング対象のエンティティが更新されます。EF Core は `Customer` のスナップショットが以前の値から乖離したことを見て、マップされた 3 つのカラムを dirty にマークします。

値型が必要なら、`record struct` も複合プロパティとして有効で、行ごとの追加のヒープアロケーションを避けられます。トレードオフはお馴染みのものです: 大きなフィールドセットはコピーで痛く、わざわざ EF の規約のためにパラメーターレスコンストラクターを追加する余裕も失います。

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency);
```

小さく形が固定された値 (お金、座標、日付範囲) には `record struct` を使ってください。それ以外には `record class` を使ってください。

## 席 2: エンティティとしての record (動くが規律が必要)

不変に見えるエンティティが欲しい場合、change tracking を生き残る形は、**位置指定でない** init-only プロパティと、EF Core がマテリアライズ中に呼べるバインディングコンストラクターを持つ `record class` です。

```csharp
// .NET 11, C# 14, EF Core 11
public record class BlogPost
{
    // EF binds to this ctor during materialization
    public BlogPost(int id, string title, DateTime publishedAt)
    {
        Id = id;
        Title = title;
        PublishedAt = publishedAt;
    }

    // Parameterless ctor lets EF (and serializers) create instances
    // before setting properties one at a time when needed.
    private BlogPost() { }

    public int Id { get; init; }
    public string Title { get; init; } = "";
    public DateTime PublishedAt { get; init; }

    // Navigation props cannot be bound via constructor.
    public List<Comment> Comments { get; init; } = new();
}
```

[コンストラクターバインディングのドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/constructors) のルールを record に適用すると:

1. EF Core はパラメーター名と型がマップされたプロパティに一致するコンストラクターを見つけると、それをマテリアライズ中に使います。Pascal-case のプロパティは camel-case のパラメーターと一致できます。
2. ナビゲーションプロパティ (コレクション、参照) はコンストラクター経由でバインドできません。プライマリコンストラクターから外し、デフォルトで初期化してください。
3. setter のないプロパティは規約上マップされません。`init` は setter としてカウントされるので、init-only プロパティはマップされます。`public string Title { get; }` のように setter が一切ないプロパティは計算プロパティとして扱われ、スキップされます。
4. store-generated キーには書き込み可能なキーが必要です。`init` はオブジェクト初期化時に書き込み可能で、それは EF Core が値をセットするタイミングそのものです。なので `int Id { get; init; }` は store-generated identity 列で機能します。

なぜエンティティ自体に位置指定 record を使わないのか? 2 つの理由があります。

第一に、位置指定 record には **`init` セッター付きのコンパイラー生成プロパティセット** が暗黙的に存在しますが、保護された `<Clone>$` メソッドと、`with` 式が使うコピーコンストラクターも存在します。`post with { Title = "New title" }` を呼んだ瞬間、トラッキング対象と同じ主キーを持つ新品の `BlogPost` インスタンスが手に入ります。`context.Update(newPost)` を試すと `InvalidOperationException: The instance of entity type 'BlogPost' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked.` に当たります。Identity resolution は仕事をしているのです。あなたは同じ行だと考えているものに 2 つの参照を渡しました。

第二に、位置指定 record は値ベースの `Equals` と `GetHashCode` を生成します。EF Core の change tracker、relationship fixup、`DbSet.Find` はすべて参照同一性に寄りかかっています。値等価性はこれらを直ちに壊しはしませんが、驚くような挙動を生みます: 異なるクエリから新しくロードされた 2 つのエンティティがハッシュ等価になりつつ別のトラッキング対象インスタンスであり得て、`HashSet<BlogPost>` はそれらをまとめます。アイデンティティを持つ何かから値等価性を遠ざけてください。

上記のように明示プロパティを持つ record class は、両方の落とし穴を避けます。不変性と素敵な `ToString` を得て、`with` ベースの変更を諦めます (それはトラッキング対象エンティティでは欲しくなかった機能でしょう)。

### 不変スタイルのエンティティを更新する

エンティティが「不変」なので、更新パスは「変更してから SaveChanges」にはなりません。EF Core 11 で実用的な 2 つのパターン:

```csharp
// .NET 11, EF Core 11
// Pattern A: load, assign to a local with init setters cleared.
// Requires exposing init setters on the class.
var post = await db.BlogPosts.SingleAsync(p => p.Id == id);

// This mutates the tracked instance. Works because 'init' is
// a settable accessor from EF Core's point of view, and nothing
// stops you from assigning through reflection or source-gen.
// If you want real immutability, use Pattern B.
db.Entry(post).Property(p => p.Title).CurrentValue = "New title";
await db.SaveChangesAsync();

// Pattern B: detach the old, attach a freshly-constructed one,
// mark the touched columns modified. No 'with' expression.
var updated = new BlogPost(post.Id, "New title", post.PublishedAt);
db.Entry(post).State = EntityState.Detached;
db.Attach(updated);
db.Entry(updated).Property(p => p.Title).IsModified = true;
await db.SaveChangesAsync();
```

ほとんどのチームが行き着くのはパターン A です: 読み取り時の人間工学的な `ToString`、デコンストラクション、フィールドごとの等価性のために record を使い、書き込みパスは EF Core のメタデータを介して change tracker が init プロパティを変更するのを受け入れます。これは言語レベルの不変性違反ではなく、EF Core がプロパティをどうバインドするかの問題です。完全な話が欲しければ、不変な更新の一級サポートを追跡している長期にわたる EF Core issue があります ([efcore#11457](https://github.com/dotnet/efcore/issues/11457))。

## 席 3: プロジェクションと DTO としての record (常に安全)

record が change tracker の外側でマテリアライズされるとき、上記の問題はどれも当てはまりません。Record プロジェクションは最も退屈で最も有用なパターンです:

```csharp
// .NET 11, C# 14, EF Core 11
public record PostSummary(int Id, string Title, DateTime PublishedAt);

// No tracking, no identity, no ChangeTracker snapshot.
var summaries = await db.BlogPosts
    .AsNoTracking()
    .Select(p => new PostSummary(p.Id, p.Title, p.PublishedAt))
    .ToListAsync();
```

EF Core 11 のクエリパイプラインはプロジェクション内で位置指定 record に喜んでバインドします。これらを `System.Text.Json` で web API からそのまま出荷できます。`System.Text.Json` は .NET 5 以降 record のシリアライズを、.NET 7 以降位置指定 record のデシリアライズをサポートしています。

同じ議論はコマンドの入力 DTO にも当てはまります: コントローラーから位置指定 record を受け取り、検証し、上記のエンティティ形式にマップして、EF Core にエンティティを追跡させましょう。ワイヤー型 (record) を永続化型 (init を持つ class) から分離することで、この記事が扱っているバグカテゴリー全体を取り除けます。

戻り値形式としての record の詳細は、[multiple-values 記事の末尾の意思決定マトリクス](/ja/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) を参照してください。

## Store-generated キーと init-only プロパティ

これは人々が引っかかる単一の最も一般的な場所です。`Id` が `public int Id { get; }` のように setter なしで宣言されていると、EF Core はマップせず、マイグレーションは欠落した key について文句を言います。`public int Id { get; init; }` であれば、マップされ、オブジェクト初期化中に書き込み可能です。それは EF Core がデータベースから読んだ値をセットするタイミングそのものです。

insert のために、EF Core は生成された値を `SaveChanges` の後にエンティティに書き戻す必要もあります。プロパティの setter を介して行いますが、init-only プロパティでも依然として機能します。EF Core がパブリックな C# 構文ではなくプロパティアクセスメタデータを使うからです。EF Core 11 で確認済み; これは EF Core 5 以降安定しています。

機能しないもの: `public int Id { get; } = GetNextId();` のようなフィールドイニシャライザーかつ setter なし。EF Core は setter を見ず、プロパティをマップせず、欠落キーのビルドエラーか意図しない shadow key のいずれかを得ます。

## `with` 式はトラッキング対象エンティティでの自損ツール

エンティティがプライマリコンストラクターのコピーを持つ `record` (位置指定でもそうでなくても) のとき、`with` はオリジナルと等しいと比較されるが異なる CLR 参照のクローンを生成します。EF Core はそれを「同じキー、別のインスタンス」として扱い、identity resolution をトリガーします。安全なルール:

```csharp
// .NET 11, EF Core 11
// BAD: creates a second instance with the same PK.
var edited = post with { Title = "New" };
db.Update(edited); // throws InvalidOperationException on SaveChanges

// GOOD: mutate the tracked instance.
post.Title = "New"; // via init (within EF) or a regular setter
await db.SaveChangesAsync();
```

本当に「detach、clone、re-attach」セマンティクスが欲しければ、まず `db.Entry(post).State = EntityState.Detached;` を経由し、それからクローンをアタッチしてプロパティを `IsModified` にマークしてください。ほとんどの場合、それは欲しくないものです。前のセクションのパターン A が欲しいのです。

複合型にはこの問題はありません。`Customer` 内の `Address` への `with` は新しい値を生成し、`customer.ShippingAddress` に代入し直し、EF Core はスナップショットに対してフィールドごとに比較します。それが複合型のすべての要点です。

## ホットパスでの値等価性 vs アイデンティティ

位置指定 record エンティティを主張するなら、値等価性が `GetHashCode` でバックされたすべてのコレクションに漏れることを覚えておいてください。`HashSet<BlogPost>` は「同じデータの異なるエンティティ」2 つを潰します。エンティティをキーにした辞書は、異なる 2 つの PK が同じペイロードを持つことになると予測不能に振る舞います。標準的な回避策は record の `Equals` と `GetHashCode` をオーバーライドして主キーだけを基準にすることですが、それは最初に record を選んだ理由全体を打ち消します。

change tracker 自体は、EF Core 11 時点でも内部的に参照同一性を使い続けています。詳細は [change-tracking のソース](https://github.com/dotnet/efcore) を確認できますが、短い版は: EF Core は値等価だからといって 2 つのエンティティを誤って「マージ」しません。ただし、`DbSet.Find`、トラッキング対象クエリの `FirstOrDefault`、relationship fixup を介してそのマージを表面化させます。それがチームがすぐには説明できない奇妙な挙動を見続ける理由です。

繰り返しますが、修正はランタイムと議論することではありません。値等価性を値型 (複合型、DTO) に保ち、エンティティ型はデフォルトの参照等価性のままにすることです。

## JSON カラムと record

EF Core 7 が JSON カラムマッピングを追加し、EF Core 11 はそれを [SQL Server 2025 での JSON_CONTAINS 翻訳](/2026/04/efcore-11-json-contains-sql-server-2025/) と JSON ドキュメント内の複合型でさらに拡張します。位置指定 record は owned JSON 型に対して人間工学的にフィットします:

```csharp
// .NET 11, C# 14, EF Core 11
public record TagSet(List<string> Tags, DateTime UpdatedAt);

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public TagSet Metadata { get; set; } = new(new(), DateTime.UtcNow);
}

// OnModelCreating
modelBuilder.Entity<Article>()
    .OwnsOne(a => a.Metadata, b => b.ToJson());
```

record は JSON として格納される複合プロパティです。`article.Metadata = article.Metadata with { Tags = [..article.Metadata.Tags, "net11"] };` で丸ごと置き換え、EF Core は `SaveChanges` で部分木全体をシリアライズします。アイデンティティトラッキングなし、`with` 対 mutation の議論なし。

## まとめる

エンドツーエンドの現実的なドメイン:

```csharp
// .NET 11, C# 14, EF Core 11
// Complex types (records)
public record Address(string Street, string City, string PostalCode);
public readonly record struct Money(decimal Amount, string Currency);

// Entity (class with init-only properties + binding ctor)
public class Order
{
    public Order(int id, string customerName, Money total, Address shipTo)
    {
        Id = id;
        CustomerName = customerName;
        Total = total;
        ShipTo = shipTo;
    }

    private Order() { } // EF fallback

    public int Id { get; init; }
    public string CustomerName { get; init; } = "";
    public Money Total { get; init; }
    public Address ShipTo { get; init; } = new("", "", "");

    public List<OrderLine> Lines { get; init; } = new();
}

// Projection/DTO (positional record)
public record OrderSummary(int Id, string CustomerName, decimal Total);

// Input command (positional record, validated before mapping)
public record CreateOrder(string CustomerName, Money Total, Address ShipTo);
```

これが経験則のすべてです: アイデンティティを持つものにはクラス、データで定義されるものには record。EF Core 11 のコンストラクターバインディング、複合型マッピング、JSON マッピングはすべて、適切な場合に `ComplexProperty` または `OwnsOne(..ToJson())` を超える追加の設定なしにこの分割をサポートします。

## 関連記事

- [EF Core 11 が DetectChanges をスキップする GetEntriesForState を追加](/2026/04/efcore-11-changetracker-getentriesforstate/) は、この記事が依拠する change tracker の内部をカバーします。
- [EF Core 11 が split クエリの不要な reference join を剪定](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) は、エンティティがナビゲーションに大きく依存している場合のよい伴侶です。
- [EF Core 11 が SQL Server 2025 で Contains を JSON_CONTAINS に翻訳](/2026/04/efcore-11-json-contains-sql-server-2025/) は、上記の JSON マッピング record パターンと結びつきます。
- [C# 14 のメソッドから複数の値を返す方法](/ja/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) は、メソッド戻り値レベルで record がタプルやクラスに勝つときをより深く扱います。

## 参考資料

- [EF Core のコンストラクターとプロパティバインディング](https://learn.microsoft.com/en-us/ef/core/modeling/constructors)
- [EF Core 変更追跡の概要](https://learn.microsoft.com/en-us/ef/core/change-tracking/)
- [EF Core identity resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution)
- [EF Core 11 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [C# record 型リファレンス](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records)
- [不変なエンティティ更新のサポート (efcore#11457)](https://github.com/dotnet/efcore/issues/11457)
- [record 型をエンティティとしてドキュメント化 (EntityFramework.Docs#4438)](https://github.com/dotnet/EntityFramework.Docs/issues/4438)
