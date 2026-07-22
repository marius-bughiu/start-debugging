---
title: "EF Core 11 の継承マッピングにおける TPH vs TPT vs TPC: どれを選ぶべきか"
description: "EF Core 11 では、ほぼすべての階層でデフォルトとして TPH を使い、単一のリーフ型をほぼ常にクエリしベンチマークで勝ると証明できる場合のみ TPC を選び、外部の制約に強いられる場合のみ TPT を使います。"
pubDate: 2026-07-22
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/07/tph-vs-tpt-vs-tpc-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

EF Core 11（.NET 11 と C# 14）では、測定に基づく理由がない限り、クラス階層は **table-per-hierarchy (TPH)** でマッピングします。TPH は階層全体を 1 つのテーブルにディスクリミネーター列とともに配置するため、読み取りは join のない単一テーブルのスキャンになります。**table-per-concrete-type (TPC)** に頼るのは、コードが圧倒的に単一のリーフ型をクエリし、あなたのデータでのベンチマークが TPH を上回ると示す場合だけです。**table-per-type (TPT)** を使うのは外部の制約に強いられる場合だけにします。というのも、Microsoft 自身のベンチマークでは、基底型のクエリにおいて TPT は TPH のおよそ 2 倍の時間と、ほぼ 2 倍のアロケーションになるからです。一行のルールとしては、デフォルトは TPH、リーフ型中心のワークロードで速く測定される場合は TPC、選択として TPT を選ぶことはない、です。

この記事は決定についてであり、設定の完全な手順ではありません。ディスクリミネーターの API、共有列、null 許容列の仕組みを詳しく知りたい場合は、[EF Core 11 で table-per-hierarchy (TPH) 継承マッピングを設定する方法](/ja/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)をお読みください。ここでは 3 つの戦略を並べて比較し、それぞれが生成するスキーマを示し、あなたに代わって決定を下す制約を挙げます。

## 1 画面で見る機能マトリクス

2 階層の階層を考えます。基底クラス `Blog` と、`RssUrl` を追加する派生クラス `RssBlog` です。3 つの戦略はこれを完全に異なる 3 つのスキーマにマッピングし、以下のトレードオフはすべてその形から生じます。

| 観点                                   | TPH                          | TPT                                | TPC                                   |
| -------------------------------------- | ---------------------------- | ---------------------------------- | ------------------------------------- |
| 生成されるテーブル                     | 1 つ、階層全体               | 型ごとに 1 つ（抽象型を含む）      | 具象型ごとに 1 つのみ                 |
| ディスクリミネーター列                 | あり                         | なし                               | なし                                  |
| 派生型の列                             | null 許容、共有テーブル      | 独自テーブル、`NOT NULL` 可能      | 独自テーブル、`NOT NULL` 可能         |
| 基底型のクエリ（`context.Blogs`）      | 1 つの `SELECT`、join なし   | 全テーブルにわたる `LEFT JOIN`     | 具象テーブルにわたる `UNION ALL`      |
| 単一リーフのクエリ（`OfType<RssBlog>`）| ディスクリミネーター述語     | 基底 + リーフテーブルの join       | 単一テーブル、フィルターなし          |
| 格納の形                               | 幅広く疎、null が多い        | 正規化され、null なし              | 非正規化、列が繰り返される            |
| キー生成                               | 任意（Identity で可）        | 任意（基底で Identity）            | 共有シーケンス、単純な Identity 不可  |
| 基底型への FK 制約                     | あり                         | あり                               | なし（キーはリーフテーブルにある）    |
| 複雑型 / JSON 列                       | あり                         | あり（EF Core 11 で新規）          | あり（EF Core 11 で新規）             |
| 基底型の読み取り: 相対速度             | 最速（基準）                 | 約 2 倍遅い                        | TPH とほぼ同じ                        |
| Microsoft の立場                       | 推奨されるデフォルト         | 「強いられる場合のみ」             | 単一リーフのクエリに適する            |

このパターンは微妙なものではありません。TPH は重要なほぼすべての行で勝つか同等であり、TPC は型をまたいでクエリする場合を除いて TPH と並び、TPT はより見た目の綺麗なスキーマと引き換えに、クエリ時にコストがかかる join を負います。これらのセルのうち 3 つは EF Core 11 で変わりました。複雑型と JSON 列が TPT と TPC の階層でも動作するようになり、これは以前はサポートされておらず、継承された値オブジェクトのために所有エンティティへ人々を戻していました。これは TPT と TPC を避けるパフォーマンス以外の最後の理由の 1 つを取り除きますが、パフォーマンスの結論は変えません。

## 各戦略が実際にデータベースへ書き込む内容

スキーマは抽象的なトレードオフを具体的にします。TPH は、ディスクリミネーターと null 許容の派生列を持つ単一のテーブルです。

```sql
-- TPH: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [RssUrl] nvarchar(max) NULL,          -- nullable: base Blogs have no RssUrl
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);
```

TPT は各型を独自のテーブルに分割し、共有される主キー上の外部キーで結び付けます。

```sql
-- TPT: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL,
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId]),
    CONSTRAINT [FK_RssBlogs_Blogs_BlogId] FOREIGN KEY ([BlogId])
        REFERENCES [Blogs] ([BlogId]) ON DELETE NO ACTION
);
```

TPC は各具象型に、継承された各列を繰り返した自己完結的なテーブルを与え、共有シーケンスに基づいてキーを付けます。

```sql
-- TPC: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,             -- inherited column, repeated here
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId])
);
```

各戦略の設定はルートエンティティ上の 1 行です。TPH はデフォルトで何も要りません。TPT と TPC はマッピング戦略の呼び出しでオプトインします。

```csharp
// EF Core 11: choosing a strategy on the root entity type
modelBuilder.Entity<Blog>().UseTphMappingStrategy(); // default, can be omitted
modelBuilder.Entity<Blog>().UseTptMappingStrategy(); // one table per type
modelBuilder.Entity<Blog>().UseTpcMappingStrategy(); // one table per concrete type
```

## TPH を選ぶとき

TPH は大多数の階層にとって正しい答えです。次の場合に選びます。

- **階層をまたいでクエリする場合。** 基底型を読むあらゆるコード（すべての `Payment` 行のリスト、`CardPayment` と `BankTransferPayment` を混在させるダッシュボード）は、TPH では 1 つのインデックス付きテーブルのスキャンです。join も `UNION` もありません。これは最も一般的なアクセスパターンであり、まさに TPT が破綻する箇所です。
- **階層が浅いか、派生型が追加する列が少ない場合。** それぞれ数個のプロパティを追加する 2、3 個のサブタイプは、わずかに疎なだけのテーブルを生みます。データベースは空の列をうまく扱い、SQL Server では、まれにしか埋まらない TPH の列を [sparse 列](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns)としてマークして領域を取り戻せます。
- **最も単純な書き込みを求める場合。** TPH の insert は 1 つのテーブルの 1 行です。派生型に対する `ExecuteUpdate` と `ExecuteDelete` は、あなたに代わってディスクリミネーター述語を適用し、単一のテーブルに触れます。これは [EF Core 11 で ExecuteUpdate と ExecuteDelete を一括書き込みに使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)で説明されている、きれいな一括書き込みの経路です。
- **基底型への外部キーが必要な場合。** 各行が 1 つのテーブルにあるため、基底型を指すリレーションシップは本物の FK 制約を得ます。TPC はその制約を強制できません。以下で扱います。

受け入れる唯一のコストは、派生型で必須のプロパティであっても null 許容列にマッピングされることです。兄弟の行がそれを空のままにするためです。データベースによって強制される派生プロパティの非 null が厳格な要件であれば、それが TPH を離れる古典的な理由であり、TPT を指し示します。

## TPC を選ぶとき

TPC は専門家です。型をまたぐクエリでは TPH に肉薄し、1 つの特定の形で前に出ます。

- **ほぼ常に単一のリーフ型をクエリする場合。** ホットパスが `context.RssBlogs.Where(...)` で、`context.Blogs` はまれであれば、TPC はディスクリミネーターフィルターも join もなしに自己完結的なテーブルを読みます。Microsoft のガイダンスは明確です。TPC は「単一のリーフ型のエンティティをクエリするとき」に優れます。利得はワークロードに依存するため、コミットする前にあなたのデータで TPH と比較して測定してください。
- **TPT の join なしで非 null の派生列を求める場合。** 各 TPC テーブルは具象型のすべての列をインラインで保持するため、必須の派生プロパティは独自のテーブルで `NOT NULL` にでき、その型の読み取りは依然として単一テーブルです。これは TPT が join で購う一方、TPC は join なしで購う性質です。

代償は非正規化されたスキーマと厄介なキーです。TPC は単純な `Identity` 列を使えません。シーケンスを所有する単一のテーブルが存在しないためです。EF Core 11 はデフォルトで共有のデータベースシーケンス（`NEXT VALUE FOR [BlogSequence]`）を使い、兄弟テーブル間でキーが一意に保たれるようにします。シーケンスを持たない SQLite では、TPC の整数キー生成は利用できず、クライアント側で生成する GUID にフォールバックします。さらに、基底型の主キーはどの具象テーブルにも存在しうるため、基底型を参照する外部キーはデータベース制約でまったく強制できません。すべての書き込みがナビゲーションを伴って EF Core を通るなら通常は問題ありませんが、データベースレベルの整合性の実質的な損失です。

## TPT を選ぶとき（そしてなぜ答えがたいてい「選ぶな」なのか）

TPT はクラス図に最も似たスキーマを生みます。型ごとに 1 テーブルで、キーで結合されます。その美観こそが罠です。TPT に頼るのは次の場合だけにします。

- **外部の制約がスキーマを指定する場合。** DBA が型ごとに正規化されたテーブルを義務付ける、変更できないレガシースキーマがすでにこの形をしている、あるいは別のシステムが型ごとのテーブルを直接読む、といった場合です。これらが Microsoft の言う「外部要因によって強いられる」ケースです。
- **FK 制約と非 null の派生列を備えた型ごとのテーブルが本当に必要で、型をまたぐクエリがまれな場合。** これは狭い交差であり、それでもまず TPC と比較してベンチマークすべきです。

きれいに感じるからという理由で TPT を選んではいけません。すべての基底型クエリはテーブルの集合全体を join し、join はリレーショナルデータベースのパフォーマンス問題の主要な源の 1 つです。数値がこれを裏付けます。次のセクションです。

## ベンチマーク: TPT はおよそ 2 倍のコスト

これは根拠のない話ではありません。Microsoft 自身の継承ベンチマークは、7 型の階層をセットアップし、型ごとに 5000 行（合計 35000 行）をシードし、データベースからすべての行を読み込みます。結果は次のとおりです。

| Method | Mean      | Allocated |
| ------ | --------- | --------- |
| TPH    | 149.0 ms  | 40 MB     |
| TPT    | 312.9 ms  | 75 MB     |
| TPC    | 158.2 ms  | 46 MB     |

TPT は TPH のおよそ 2.1 倍遅く、ほぼ 2 倍のメモリをアロケートします。階層の読み込みが 7 つのテーブルを join するためです。TPC はこの全型クエリで TPH の約 6 パーセント以内に収まり、1 つのテーブルを読む単一リーフのクエリでは TPH の前に出ます。そこでは TPH は依然として共有テーブルをディスクリミネーターフィルター付きでスキャンします。方法論が重要です。これは各テーブルに触れる基底型のクエリであり、TPC にとっても TPT にとっても最も不利なケースです。したがって、あなたのワークロードで見える差は、型をまたいでクエリするか単一リーフをクエリするかの頻度に依存します。それでも結論は実行間で安定しています。TPT は TPH と TPC が払わない join の税を払い、スキーマの美観に関するどんな主張もそれを取り戻しません。

不可逆な判断を下す前に、自分のモデルに対してベンチマークを実行してください。本番データを持ってから継承戦略を変えることは、行をテーブル間で移動させるスキーママイグレーションを意味するため、これは早い段階で一度測定する価値のある判断です。

## あなたに代わって決める落とし穴

3 つの制約が、好みに関係なく戦略を決めることがあります。

1 つ目は **派生プロパティに対するデータベース強制の非 null** です。TPH はこれをできません。共有列は兄弟の行のために null 許容でなければならないからです。データベース（アプリケーションだけでなく）に、すべての `CardPayment` が `Last4` を持つと保証させる必要があるなら、その列を独自のテーブルに置く必要があり、それは TPT か TPC を意味します。

2 つ目は **あなたのデータベースでのキー生成** です。TPC は整数キーにシーケンスを必要とします。SQL Server では自動ですが、SQLite では TPC で整数の Identity キーをまったく使えず、GUID に切り替える必要があります。SQLite を使っていて整数キーが欲しいなら、TPC は対象外です。

3 つ目は **基底型への外部キーの整合性** です。他のテーブルがあなたの基底型を参照し、データベースにそれらの参照を強制させたいなら、TPC は制約を提供できません。TPH と TPT は提供できます。これだけで、多くの正規化されたスキーマにおいて TPC は除外されます。

3 つすべてで共通する点が 1 つあります。エンティティの型を実行時に変更することはできません。`CardPayment` を `BankTransferPayment` に変えることは、どの戦略でも削除と挿入です。ディスクリミネーター（またはテーブルそのもの）が型をエンコードするためです。これはモデリングの現実であり、差別化要因ではありません。

## はっきり述べる推奨

デフォルトは TPH です。一般的な型をまたぐクエリで最速であり、それに対して書くのが最も単純で、キー生成の摩擦がない唯一の戦略であり、幅広いシナリオに対する Microsoft 推奨のデフォルトです。TPC に頼るのは、ワークロードが単一リーフ型のクエリに支配され、あなたのデータでのベンチマークが TPH を上回ると示す場合だけにし、それに伴う非正規化されたスキーマ、共有シーケンスのキー、基底型への FK 制約の欠如を受け入れます。TPT を使うのは外部要因が選択の余地を与えない場合だけにし、より整って見えるスキーマのためにおよそ 2 倍のクエリ税を払うと理解した上で行います。

メンタルモデルは数値が課すものと同じです。1 つのテーブルは速く、join で結ばれた多くのテーブルは遅く、join のない多くのテーブルは速いが非正規化されています。この判断がより広いバージョンアップの一部であれば、継承とマッピングの変更は [EF Core 6 から EF Core 11 への移行ガイド](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)にあるものと並んで表面化する傾向があります。

## 関連記事

- [EF Core 11 で table-per-hierarchy (TPH) 継承マッピングを設定する方法](/ja/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)は、TPH の完全な手順です。ディスクリミネーターの API、共有列、null 許容列のルールを扱います。
- [EF Core 11 における複雑型 vs 所有エンティティ](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)は、値オブジェクトのマッピングを扱います。これは TPT と TPC の階層の内部でも動作するようになりました。
- [EF Core 11 で JSON 列をマッピングしクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)は、継承階層が EF Core 11 で得た JSON 格納を説明します。
- [EF Core 11 で ExecuteUpdate と ExecuteDelete を一括書き込みに使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)は、TPH がきれいにする単一テーブルの一括書き込み経路を示します。
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11)は、TPT が助長しうる join の多いクエリパターンを捉えるのに役立ちます。

## 出典

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Modeling for performance: inheritance mapping (with the TPH/TPT/TPC benchmark)](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core inheritance benchmark source](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Benchmarks/Inheritance.cs)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [SQL Server sparse columns](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns)
