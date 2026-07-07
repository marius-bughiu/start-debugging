---
title: "EF Core 11 の名前付きクエリフィルター vs 単一のグローバルクエリフィルター: どちらを使うべきか"
description: "どちらも同じ SQL を生成します。名前付きフィルターに頼るのは、predicate を個別に無効化する必要があるときだけです。単一の関心事なら、EF Core 11 では 1 つに結合したフィルターの方がシンプルです。"
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "ja"
translationOf: "2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-07
---

エンティティ上のフィルタリングの関心事が 1 つなら、名前のない単一の `HasQueryFilter(e => ...)` を使ってください。クエリ実行時に個別に取り外す必要のある関心事が 2 つ以上あるなら、たとえば論理削除フィルターと tenant フィルターがあり、管理画面では削除済みの行を見せる必要があるが他の tenant の行は決して見せてはならない、といった場合は名前付きフィルターを使います。決定はこれで全部です。生成される SQL はどちらの場合も同一で、変わるのは `IgnoreQueryFilters` が predicate の半分を切り離せるかどうかだけです。名前付きクエリフィルターは EF Core 10 で登場し、EF Core 11 では複数フィルターのための標準的な仕組みです (`Microsoft.EntityFrameworkCore` 11.0、.NET 11、C# 14)。

以下のすべては、この 1 つの軸、つまり無効化の粒度についての話です。どちらのアプローチも同じ `WHERE` 句に変換されるため、ここにパフォーマンスの話もエコシステムの話もありません。この比較は純粋に、フィルターを切るためにどれだけの制御が必要かという点にあります。

## 2 つの形を並べて

グローバルクエリフィルターとは、EF Core がエンティティ型のすべての LINQ クエリに注入する predicate です。EF Core 10 より前はエンティティごとにちょうど 1 つだったため、2 つ目の関心事は `&&` を意味しました。

```csharp
// EF Core 9 style -- one unnamed filter, two concerns welded with &&
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

名前付きのオーバーロードは第 1 引数に文字列のキーを取り、繰り返し呼び出すと上書きではなく合成されます。

```csharp
// EF Core 11 -- two named filters on the same entity
modelBuilder.Entity<Invoice>()
    .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
    .HasQueryFilter("TenantFilter",       i => i.TenantId == _tenantId);
```

どちらの構成に対しても素のクエリを実行すると、同じ行と同じ SQL が返ります。

```sql
-- Identical for both the && filter and the two named filters
SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
```

選ぶ前に腑に落としておくべき重要な点はこれです。名前付きフィルターは「より強力なフィルタリング」ではありません。フィルタリングは完全に同じです。追加の手間で買っているのは、後でつかめる名前付きのハンドルです。

## 機能マトリクス

| 機能                                      | 単一のグローバルフィルター               | 名前付きフィルター                             |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| エンティティごとのフィルター数 (EF Core 11)| 名前のない predicate 1 つ                | 複数、それぞれに名前                           |
| 複数の関心事を組み合わせる                | `&&` で 1 つの式に                       | 関心事ごとに `HasQueryFilter` を 1 回          |
| 生成される SQL                            | `AND` で結合した `WHERE`                 | 同一の `AND` で結合した `WHERE`                |
| `IgnoreQueryFilters()` (引数なし)         | フィルター全体を落とす                   | すべての名前付きフィルターを落とす             |
| `IgnoreQueryFilters(["Name"])`            | 該当なし                                 | その predicate のみを落とす                    |
| 1 エンティティで名前付きと名前なしを混在  | 該当なし                                 | モデル構築時に例外。スタイルを 1 つ選ぶ        |
| 利用可能になったバージョン                | EF Core 2.0                              | EF Core 10                                      |
| クエリプランキャッシュへの影響            | パラメーター化、プラン 1 つ              | パラメーター化、プラン 1 つ                    |
| 手間                                      | 最小                                     | フィルター名の定数、拡張ヘルパー               |

結果を変える唯一の行は `IgnoreQueryFilters(["Name"])` の行です。それ以外の違いは見た目上のものか、一度回避すれば済む制約です。

## 単一のグローバルフィルターを使うとき

追加のアドレス可能性が何ももたらさないなら、シンプルな名前なしフィルターに頼ってください。

- **エンティティごとに関心事が 1 つ。** `!IsArchived` だけが必要な読み取り専用のルックアップテーブルには、選択的に無効化するものは何もありません。`HasQueryFilter(x => !x.IsArchived)` がすべてであり、名前は死荷重になります。
- **常にオール・オア・ナッシングでよい。** フィルターを回避する唯一の場面が、正当にすべてを見たい管理系や移行系の経路だけなら、引数なしの `IgnoreQueryFilters()` がまさに正解です。名前を付けても、できることが増えるのではなく減るだけです。
- **決して別々には取り外さない複数の関心事。** `&&` で組み合わせた 2 つの predicate は、片方をオンにしてもう片方をオフにするコード経路が存在しないなら問題ありません。「削除済みを表示」を決して公開しない社内ツールの `!IsDeleted && OrgId == _orgId` フィルターは、1 つの式の方がシンプルです。
- **EF Core 9 以前を使っている。** 名前付きのオーバーロードは EF Core 10 より前には存在しないため、単一の `&&` フィルターが唯一の組み込みの選択肢です。まだこの方法で関心事を組み合わせているなら、分割する前に [EF Core 6 から EF Core 11 への移行: 本当に噛みつく破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) を参照してください。

単一フィルターの利点は、マジックストリングがないことです。`IgnoreQueryFilters(["SoftDeletonFilter"])` のようなタイプミスが黙って何も無効化しないまま潜んでいる、ということが起きません。書き間違える名前そのものが存在しないからです。

## 名前付きフィルターを使うとき

2 つの関心事が 1 つのクエリの中で異なる寿命を必要とした瞬間に、フィルターに名前を付けてください。

- **同じテーブル上の論理削除とマルチテナンシー。** これが典型例です。管理レポートは削除済みの請求書を見る必要がありますが、現在の tenant に限定されたままでなければなりません。`IgnoreQueryFilters(["SoftDeletionFilter"])` を使えば tenant の predicate は生き残るため、レポート画面を tenant 間のデータ漏洩に変えてしまうことはできません。配線の全体は [EF Core 11 で論理削除とマルチテナンシーのために名前付きクエリフィルターを使う方法](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) にあります。
- **「切り替え可能」な関心事の隣に「決してオフにしない」関心事。** 一方の predicate がセキュリティ境界 (tenant、所有権、行レベルの認可) で、もう一方が利便性 (論理削除、公開/下書きの状態) であるときはいつでも、名前を付けることで、呼び出し側に境界を落とす手段を決して渡すことなく、利便性のスイッチを公開できます。
- **バイパスのために意図を明かす API がほしい。** 名前があれば、ignore を拡張メソッドの背後に包み、どの呼び出し側もフィルターの文字列を打たないようにできます。

```csharp
// EF Core 11 -- filter name hidden behind a readable call site
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant     = nameof(Tenant);
}

public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> q)
    => q.IgnoreQueryFilters([InvoiceFilters.SoftDelete]); // tenant filter stays on

// Reads like English, cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

- **フィルターが別々の構成クラスにある。** 論理削除が共有の `IEntityTypeConfiguration<T>` の規約から来て、tenant フィルターがアプリ固有なら、2 つの名前付き呼び出しがそれらを分離したままに保ち、1 つのクラスに結合した `&&` 式を所有させずに済みます。

## なぜベンチマークのセクションがないのか

比較記事は通常、数字を示す義務があります。この記事にはそれがなく、存在しない違いを探しに行かないよう、はっきり述べておく価値があります。どちらのアプローチも同じ predicate ツリーに落ちるため、EF Core は同じ `WHERE` 句を発行し、クエリプランナーは同じ SQL を見ます。tenant の値はどちらの場合もクエリパラメーターになり、つまりどちらのアプローチも、インライン化された定数がするようにはプランキャッシュを断片化しません。フィルターに名前を付けることによるクエリごとのコストはありません。名前はモデルのメタデータにのみ存在し、変換後のクエリには存在しません。名前付きフィルターがパフォーマンスのレバーでもあることを期待していたなら、そうではありません。無効化の粒度という軸だけで選んでください。フィルターを追加しながらクエリ数を測っているなら、実際に針を動かすのは join であり、それは [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) で扱っています。

## あなたの代わりに決めてしまう細部

3 つの制約は、スタイル上どちらを好むかにかかわらず、決定を強いることがあります。

**1 つのエンティティで名前付きと名前なしのフィルターは混在できません。** `Invoice` 上のいずれかのフィルターが名前を持った時点で、すべてが名前を持たなければなりません。すでに名前付きフィルターを持つエンティティに名前なしの `HasQueryFilter(i => ...)` を追加すると、モデル構築時に例外になります。つまり選択はフィルター単位ではなくエンティティ単位です。スタイルを一度決め、独立に切り替える 2 つ目の関心事が少しでも見込まれるなら、名前付きで始めてください。

**引数なしの `IgnoreQueryFilters()` は今なおすべてを吹き飛ばします。** フィルターに名前を付けても、古い引数なしの呼び出しが安全になるわけではありません。`context.Invoices.IgnoreQueryFilters().ToListAsync()` は tenant フィルターも落とします。tenant の列を持つどのテーブルでも、引数なしのオーバーロードはコードの臭いとして扱い、無効化するつもりの名前の明示的なリストを常に渡してください。この 1 つの習慣が、論理削除のスイッチと偶発的な tenant 間の読み取りとの違いになります。

**マジックストリングのフィルター名は黙って失敗します。** タイプミスのある `IgnoreQueryFilters(["SoftDeletonFilter"])` は何も無効化せず、エラーも投げません。EF にはあなたが本物のフィルターを指したと知る術がないからです。名前付きで進むなら、名前を `const` フィールドに固定して (上のスニペットのように)、タイプミスが本番の漏洩ではなくコンパイルエラーになるようにしてください。単一の名前なしフィルターにはこの罠がなく、関心事が 1 つだけのときは本物の利点になります。

1 つの細部は両者に等しく当てはまり、決め手にはなりません。ナビゲーションの必須側にあるフィルターは `Include` を `INNER JOIN` に変えるため、フィルターで外された親は黙って子を落とします。この挙動は、predicate が名前付きでも `&&` で組み合わせても同一です。修正、つまり任意ナビゲーション経由の `LEFT JOIN` か両端の一致するフィルターは、どちらの世界でも同じで、[名前付きクエリフィルターの How-to](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) で順を追って説明しています。

## 結合フィルターから名前付きフィルターへの移行

すでに `!IsDeleted && TenantId == x` フィルターを出荷していて、tenant のスコープを落とさずに「削除済みを表示」を公開する必要が出てきたなら、移行は機械的です。1 つの式を 2 つの名前付き呼び出しに分割します。

```csharp
// Before -- one filter, cannot disable half of it
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);

// After -- two named filters, soft delete now independently ignorable
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant,     i => i.TenantId == _tenantId);
```

デフォルトのクエリの挙動は何も変わりません。同じ行が返り、同じ SQL が生成されます。唯一の新しい能力は、`IgnoreQueryFilters([InvoiceFilters.SoftDelete])` が的を絞ったバイパスとして存在するようになることです。スタイルは混在できないので、この分割はエンティティ全体を 1 回の編集で行い、そのエンティティ上の既存の `IgnoreQueryFilters()` 呼び出しをすべて監査してください。かつて「削除済みを含む管理ビュー」を意味していた引数なしの呼び出しは、すでに tenant フィルターを落としていました。フィルターの分割は、それらの呼び出しを明示的にする好機です。

## 結論

デフォルトは、単一の名前なしグローバルクエリフィルターです。最も手間の少ない選択肢で、マジックストリングがなく、エンティティごとに関心事が 1 つという一般的なケースでは厳密に正しい選択です。2 つ目の関心事を 1 つ目とは独立に切り替える必要が出た瞬間に名前付きフィルターへ格上げしてください。それは実務上ほぼ常に「tenant または所有権の境界の隣にある論理削除」を意味します。経験則はこうです。片方の predicate をオフに、もう片方をオンにしたいクエリが想像できるなら、今すぐ名前を付ける。そうでなければ `&&` で組み合わせて先へ進む。SQL は違いに気づきませんが、管理レポートがなぜ他の tenant の請求書を漏らしたのかをデバッグする未来のあなたは、大いに気づきます。

## 関連記事

- [EF Core 11 で論理削除とマルチテナンシーのために名前付きクエリフィルターを使う方法](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [EF Core 11 の AsNoTracking vs AsNoTrackingWithIdentityResolution](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [EF Core 11 のインターセプターを監査に使う方法](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core ExecuteUpdate vs エンティティを読み込んで SaveChanges](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)

## 参考資料

- [Global Query Filters, EF Core ドキュメント (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10: multiple query filters per entity, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
- [Named global query filters in Entity Framework Core 10, Tim Deschryver](https://timdeschryver.dev/blog/named-global-query-filters-in-entity-framework-core-10)
- [Add ability to configure multiple query filters on a given DbSet, dotnet/efcore issue #33432](https://github.com/dotnet/efcore/issues/33432)
