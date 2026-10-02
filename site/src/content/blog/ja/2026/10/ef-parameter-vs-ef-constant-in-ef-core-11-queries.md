---
title: "EF Core 11 クエリにおける EF.Parameter と EF.Constant の違い"
description: "EF.Constant はキャプチャした値を SQL リテラルとして埋め込み、EF.Parameter はリテラルを SQL パラメーターに変換します。基本は EF Core の既定のままにし、動的に組み立てた式ツリーが呼び出しのたびに再コンパイルされるのを防ぐには EF.Parameter を使います。EF.Constant は、値の種類が少なく、データの偏りが大きくて値ごとに別のプランが必要な場合だけに使います。"
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "sql-server"
  - "performance"
lang: "ja"
translationOf: "2026/10/ef-parameter-vs-ef-constant-in-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-10-02
---

`EF.Constant(x)` は、変数から取得した値であっても SQL にリテラルとして書き込むよう EF Core に指示します (`WHERE [Status] = N'Pending'`)。通常、EF はこの値をパラメーターとして送信します。`EF.Parameter(x)` はその逆で、EF が通常は埋め込むはずの値 (リテラルや、手で組み立てたツリー内の `Expression.Constant` など) を、パラメーターとして送信させます (`WHERE [Status] = @p`)。ほとんどのクエリでは既定の動作が正解です。式ツリーを動的に組み立てる場合は `EF.Parameter` を使ってください。そうしたツリー内の生の定数は、値が変わるたびにクエリ全体のコンパイルを引き起こすためです。`EF.Constant` を使うのは、列の値の種類が少なくデータの偏りが大きく、データベースが値ごとに別のプランを必要とする場合だけです。

以下の内容はすべて、Apple M4 上で EF Core 11.0.0-rc.1.26425.128 と SDK 11.0.100-rc.1.26425.128 を使って実行しました。注記のある箇所では EF Core 10.0.12 (SDK 10.0.302) でも確認しており、同じ動作でした。`EF.Constant` は EF Core 8.0.2、`EF.Parameter` は EF Core 9、コレクション専用の `EF.MultipleParameters` は EF Core 10 で提供されました。

## 比較の概要

| | `EF.Parameter(x)` | `EF.Constant(x)` |
| --- | --- | --- |
| 提供開始 | EF Core 9 | EF Core 8.0.2 |
| スカラー値の SQL での結果 | `@p` パラメーター | リテラル (例: `N'Pending'`) |
| コレクションの SQL での結果 (EF 10/11) | JSON パラメーター 1 つ + `OPENJSON` | `IN (1, 2, 3, ...)` のリテラル |
| N 個の異なる値に対する EF クエリキャッシュのエントリ数 | 1 | 1 (EF 9 以降) |
| N 個の異なる値に対するデータベースのプランキャッシュのエントリ数 | 1 | 最大 N |
| 実際の値に合わせたプラン | なし (パラメーター スニッフィングが働く) | あり |
| 既定で EF のログに値が出るか | 出ない (`'?'`) | 出ない (EF 10 以降は `?` にマスクされる) |
| `EF.CompileQuery` / クエリフィルターでの利用 | 不可 (例外をスローする) | 不可 (例外をスローする) |
| 主な用途 | 動的な式ツリー、JSON コレクションパラメーターの強制 | 偏りのある低カーディナリティの列、`IN` リストの埋め込みの強制 |

## EF Core の既定の動作

EF のパラメーター化のルールは単純です。式ツリーの外から来るもの (キャプチャしたローカル変数、フィールド、メソッドの引数) はパラメーターになり、ラムダ内にリテラルとして書かれたものは定数になります。EF Core 11 RC 1 が SQL Server 向けに生成する SQL を、`ToQueryString()` からそのまま示します。

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer, .NET 11 RC 1
var status = "Pending";

db.Orders.Where(o => o.Status == status);
// DECLARE @status nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @status

db.Orders.Where(o => o.Status == "Pending");
// WHERE [o].[Status] = N'Pending'
```

この使い分けは意図的なものです。ソースコード中のリテラルは実行ごとに変わることがないため、埋め込んでもコストがかからず、オプティマイザーが実際の値を使って見積もりを行えます。一方、キャプチャした変数は呼び出しのたびに変わりうるため、埋め込むと値ごとに異なる SQL 文字列が生成され、異なる文字列ごとにデータベースのプランキャッシュに別のエントリができます。負荷の高い SQL Server では、これはプランキャッシュの肥大化と、新しい値ごとのコンパイルにつながります。

`EF.Constant` と `EF.Parameter` は、このルールをどちらの方向にも上書きするために存在します。

## EF.Constant でリテラルを強制する

```csharp
// EF Core 11.0.0-rc.1
var status = "Pending";
db.Orders.Where(o => o.Status == EF.Constant(status));
// WHERE [o].[Status] = N'Pending'

var name = "O'Brien";
db.Orders.Where(o => o.Customer == EF.Constant(name));
// WHERE [o].[Customer] = N'O''Brien'
```

インジェクションが気になる場合は、2 つ目のクエリが重要です。EF はプロバイダーの型マッピングを通してリテラルを生成するため、引用符はエスケープされます。`EF.Constant` は文字列連結ではありません。

これを行う理由はパラメーター スニッフィングです。SQL Server はパラメーター化されたプランを最初に見た値でコンパイルし、以降のすべての値でそのプランを再利用します。`Status = 'Archived'` が 4,000 万行に一致し、`Status = 'Pending'` が 200 行に一致する場合、一方に合わせてコンパイルされたプランはもう一方には不適切です。リテラルを使えば、値ごとに独自のカーディナリティ推定を持つ独自のプランが得られます。このトレードオフが成り立つのは、列の値が少数の固定された集合である場合だけです。ユーザー ID や注文番号を `EF.Constant` で包むと、EF の既定が避けるように設計されたプランキャッシュの問題を自分で再現することになります。

### EF.Constant は EF の再コンパイルを引き起こさなくなった

EF Core 8 の実装では、定数がパイプラインの早い段階、つまり EF 自身のクエリキャッシュの検索より前に挿入されていたため、新しい値ごとに LINQ から SQL への完全なコンパイルが発生していました。[EF Core 9 の破壊的変更のページ](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)にその書き直しの説明があります。このメソッドは現在、キャッシュの後の段階で処理されます。これを確認するために、SQLite のインメモリで 50 クエリのウォームアップの後、500 個の異なる値で 500 回実行し、`Compiling query expression` というデバッグログイベントの数を数えました。

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.Sqlite
for (int i = 0; i < 500; i++)
{
    using var db = new Ctx(conn, log: s => { if (s.Contains("Compiling query expression")) compiles++; });
    var value = "S" + i;
    db.Orders.Where(o => o.Status == EF.Constant(value)).ToList();
}
```

結果は追加のコンパイルがゼロでした。EF はコンパイル済みのクエリを再利用し、SQL テキストを再生成するだけです。現在の `EF.Constant` のコストは、すべてデータベース側にあり、異なる SQL 文字列ごとに 1 つのプランです。

## EF.Parameter でパラメーターを強制する

```csharp
// EF Core 11.0.0-rc.1
db.Orders.Where(o => o.Status == EF.Parameter("Pending"));
// DECLARE @p nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @p
```

ハードコードされたリテラルを包むこと自体が役に立つことはまれです。`EF.Parameter` が真価を発揮するのは、動的なクエリ構築です。`System.Linq.Expressions` で述語を組み立てるとき、自然に書くのは `Expression.Constant(value)` ですが、EF はこれをソースコード中のリテラルとまったく同じように扱います。

```csharp
// EF Core 11.0.0-rc.1, .NET 11 RC 1
static Expression<Func<T, bool>> Eq<T>(string property, string value, bool wrap)
{
    var p = Expression.Parameter(typeof(T), "e");
    Expression v = Expression.Constant(value);
    if (wrap)
        v = Expression.Call(typeof(EF), nameof(EF.Parameter), [typeof(string)], v);
    return Expression.Lambda<Func<T, bool>>(
        Expression.Equal(Expression.Property(p, property), v), p);
}

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: false));
// WHERE [o].[Status] = N'Shipped'

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: true));
// DECLARE @p nvarchar(4000) = N'Shipped';
// WHERE [o].[Status] = @p
```

`EF.Constant` と違い、生の `Expression.Constant` は EF がキャッシュキーとして使うツリーの一部です。そのため、異なる値ごとにキャッシュミスが起こり、完全なコンパイルが発生します。ここが、測定可能なコストが現れる場所です。上記と同じハーネスで、500 個の異なる値を、バリアントごとに 1 プロセスでウォームアップ後に実行しました。

| バリアント (EF Core 11 RC 1、SQLite インメモリ、M4) | EF のコンパイル回数 | 500 クエリの所要時間 |
| --- | --- | --- |
| キャプチャした変数 (既定) | 0 | 186-292 ms |
| `EF.Constant(variable)` | 0 | 188-226 ms |
| 組み立てたツリー内の生の `Expression.Constant` | 500 | 2201-2261 ms |
| `EF.Parameter` で包んだ `Expression.Constant` | 0 | 202-355 ms |

範囲は、それぞれ 2 回の実行結果です。テーブルは空なので、これは EF 自身のオーバーヘッドだけを切り出したものです。データベースが何かを実行する前の段階で、クエリあたり約 4 ms のコンパイルがかかる計算になります。SQL Server では、これに加えて異なる文字列ごとにデータベースのプランコンパイルが発生します。`EF.Parameter` への `Expression.Call` を 1 つ加えるだけで、動的ツリーのコストは通常の LINQ クエリ並みに戻ります。

もう 1 つの方法は、値をクロージャオブジェクトにキャプチャし、`Expression.Property(Expression.Constant(holder), "Value")` を使うことです。これは C# コンパイラーがラムダに対して行っていることです。この方法でも動作しますが、`EF.Parameter` のほうが短く、意図も明確になります。このクロージャの手法については、[EF Core が変換できる再利用可能な LINQ 述語の書き方](/ja/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)でより詳しく取り上げました。

## コレクション: 3 つの戦略と 3 つのマーカー

スカラー値の場合、選択は二択です。`Contains` で使うコレクションの場合、EF Core 10 と 11 には 3 つの変換方法があり、各マーカーメソッドがクエリごとにその 1 つを選択します。

```csharp
// EF Core 11.0.0-rc.1, SQL Server provider
int[] ids = [1, 2, 3, 4, 5, 6, 7, 8];

db.Orders.Where(o => ids.Contains(o.Id));
// DECLARE @ids1 int = 1; ... DECLARE @ids8 int = 8;
// DECLARE @ids9 int = 8; DECLARE @ids10 int = 8;
// WHERE [o].[Id] IN (@ids1, @ids2, ..., @ids10)

db.Orders.Where(o => EF.Constant(ids).Contains(o.Id));
// WHERE [o].[Id] IN (1, 2, 3, 4, 5, 6, 7, 8)

db.Orders.Where(o => EF.Parameter(ids).Contains(o.Id));
// DECLARE @ids nvarchar(4000) = N'[1,2,3,4,5,6,7,8]';
// WHERE [o].[Id] IN (
//     SELECT [i].[value]
//     FROM OPENJSON(@ids) WITH ([value] int '$') AS [i]
// )

db.Orders.Where(o => EF.MultipleParameters(ids).Contains(o.Id));
// same padded IN (@ids1, ..., @ids10) as the default
```

EF Core 10 以降の既定は、要素ごとに 1 つのスカラーパラメーターを使い、8 個の値が 10 個のパラメーターになるようパディングする方式です (最後の値が繰り返されます)。これにより、異なる SQL 文字列の数を少なく保ちつつ、オプティマイザーに値のおおよその個数を伝えられます。コレクションに `EF.Parameter` を使うと、EF Core 8 と 9 の動作に戻ります。つまり、`OPENJSON` で展開される単一の JSON パラメーターです。リストの長さにかかわらず SQL 文字列は 1 つですが、プランナーにはカーディナリティの情報が渡されません。`EF.Constant` は値を埋め込み、これは EF Core 7 の動作です。

グローバルな切り替えは `UseParameterizedCollectionMode` です。

```csharp
// EF Core 11.0.0-rc.1
options.UseSqlServer(connectionString,
    o => o.UseParameterizedCollectionMode(ParameterTranslationMode.Constant));
```

これを設定すると、通常の `ids.Contains(...)` は `IN (1, 2, ...)` を生成し、`EF.MultipleParameters(ids)` は単一のクエリをパディングされたパラメーターに戻し、`EF.Parameter(ids)` は `OPENJSON` に切り替えます。このモードが影響するのはコレクションだけです。スカラー値のキャプチャ変数は、どのモードでも `@status` のままです。EF Core 9 のメソッド `TranslateParameterizedCollectionsToConstants()` と `TranslateParameterizedCollectionsToParameters()` は、EF Core 10 で `[Obsolete]` とされ、EF Core 11 RC 1 のソースからは削除されています。そのため、EF 9 からアップグレードするプロジェクトは `UseParameterizedCollectionMode` に移行する必要があります。アップグレードの残りの手順は、[EF Core 6 から 11 への破壊的変更のウォークスルー](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)にまとめています。

## テスト中に遭遇した落とし穴

### マーカーはラムダの内側になければならない

`EF.Constant` と `EF.Parameter` は関数ではなくマーカーです。実際の本体は例外をスローします。EF が変換する式ツリーの内側にあるときだけ機能します。次のコードはコンパイルできますが、実行時に失敗します。

```csharp
// EF Core 11.0.0-rc.1
db.Orders.OrderBy(o => o.Id).Take(EF.Constant(10));
// InvalidOperationException: The 'EF.Constant<T>' method may only be used
// within Entity Framework LINQ queries.
```

`Take(int)` は `Expression` ではなく単なる `int` を受け取るため、C# は `EF.Constant(10)` をクエリの外で即座に評価します。ラムダではないすべての演算子の引数にも同じことが当てはまります。

### コンパイル済みクエリとクエリフィルターでは使えない

EF Core 9 以降、どちらのメソッドも `EF.CompileQuery` と `EF.CompileAsyncQuery` の内側では例外をスローします。EF Core 11 RC 1 では、EF 9 で文書化されていた `InvalidCastException` よりも分かりやすいメッセージになっています。

```text
InvalidOperationException: 'EF.Constant<T>' is not supported when using compiled queries or query filters.
InvalidOperationException: 'EF.Parameter<T>' is not supported when using compiled queries or query filters.
```

ホットパスで定数が必要なら、コンパイル済みクエリのラムダにリテラルを直接書いてください。値ごとのプランが必要な場合、コンパイル済みクエリは 1 つの SQL 文字列に固定されるため、そもそも適したツールではありません。コンパイル済みクエリが効果を発揮する場面は、[コンパイル済みクエリのガイド](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)で取り上げています。このメッセージはグローバルクエリフィルターも対象外としているため、テナント ID を[名前付きクエリフィルター](/ja/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/)に埋め込もうと考えていた場合は注意が必要です。

### 埋め込まれた値はログでマスクされる

EF Core 10 より前は、埋め込まれた定数はパラメーターの値と違って、ログに出力された SQL に表示されていました。EF Core 10 以降、EF はこれをマスクします。機密データのログ出力をオフにした状態での EF Core 11 RC 1 のログを示します。

```text
Executed DbCommand (20ms) [Parameters=[@secret='?' (Size = 17)], ...]
WHERE "o"."Customer" = @secret

Executed DbCommand (0ms) [Parameters=[], ...]
WHERE "o"."Customer" = ?
```

データベースは実際のリテラルを受け取っています。マスクされるのはログの行だけです。[EF Core が生成する SQL をログに出力](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)して SSMS に貼り付けようとすると、この `?` に最初は戸惑うかもしれません。値を確認するには、開発環境で `EnableSensitiveDataLogging()` を有効にしてください。

### コレクションモードはクエリキャッシュのキーに含まれない

これには驚きました。同じ型の 2 つのコンテキストを、一方は `ParameterTranslationMode.Constant`、もう一方は既定で構成した場合、両者は 1 つの内部サービスプロバイダーと 1 つのコンパイル済みクエリキャッシュを共有します。あるクエリの形を最初に実行したほうが、両方の SQL を決めてしまいます。

```csharp
// EF Core 11.0.0-rc.1 and 10.0.12, same process
using (var a = new Ctx(ParameterTranslationMode.Constant))
    a.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)

using (var b = new Ctx(mode: null))   // default MultipleParameters
    b.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)   <- cached translation from context a
```

理由はソースを見ると分かります。`RelationalOptionsExtension` は `GetServiceProviderHashCode()` から `0` を返し、`RelationalCompiledQueryCacheKey` には `UseRelationalNulls` と `QuerySplittingBehavior` が含まれていますが、コレクションモードは含まれていません。構成が 1 つだけの通常のアプリでは、これが問題になることはありません。問題になるのは、同じ `DbContext` を異なるモードで 2 回登録する場合や、テストフィクスチャでモードを切り替えて次のテストで異なる SQL を期待する場合です。その場合は、クエリごとのマーカーを使ってください。マーカーは式ツリーの一部であり、したがってキャッシュキーの一部になるためです。

## EF.Parameter を選ぶ場合

- `System.Linq.Expressions` で述語を組み立てる場合 (フィルタービルダー、グリッド検索、OData のようなエンドポイント)。ユーザー入力を保持するすべての `Expression.Constant` を `EF.Parameter` で包んでください。そうしないと、異なる値ごとに完全なコンパイルのコストを支払うことになります。
- リストの長さが大きく変動する (ID が 1 個から 2,000 個まで) 単一のクエリに `OPENJSON` 変換を使いたい場合。データベースが、パディングされた多数のバリアントではなく 1 つのプランを持てるようになります。
- グローバルなコレクションモードを `Constant` に設定していて、1 つのクエリだけそこから外したい場合。

## EF.Constant を選ぶ場合

- ステータスや型の識別子のように、少数の値しか持たずデータが大きく偏っていて、測定すると値ごとにプランが異なる列。まず実際の実行プランで性能低下を確認してください。
- `Contains` に渡す、短く安定した値のリスト (固定のロールやリージョンの集合) で、オプティマイザーがリテラルを見ることで利益を得られ、かつ組み合わせの数が少ないと分かっている場合。
- ID、種類が際限なくあるユーザー入力、コンパイル済みクエリの内側のものには使わないでください。

## 推奨事項

測定するまでは、EF Core 11 の既定のままにしてください。実際の利点の大半は `EF.Parameter` から得られます。生の定数を含む動的に組み立てたツリーは起こしやすい間違いで、データベースに届く前に、呼び出しごとに約 4 ms の EF コンパイルのコストがかかるためです。`EF.Constant` は、偏りのある低カーディナリティの列でのパラメーター スニッフィングに対する的を絞った対処です。もう EF の再コンパイルのコストはかかりませんが、異なる値ごとにデータベースのプランのコストは発生します。どちらになっているか分からない場合は、`ToQueryString()` を見ればすぐに分かります。`DECLARE @` を探してください。また、アップグレード後にクエリの性能が低下した場合は、どちらのマーカーに手を伸ばす前に、[SQL Server の互換性レベルが EF Core 11 に与える変更](/ja/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)を確認してください。

## 参考資料

- [What's new in EF Core 9: force or prevent query parameterization](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [What's new in EF Core 10: improved translation for parameterized collections, redacting inlined constants](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Breaking changes in EF Core 9: EF.Constant and EF.Parameter in compiled queries](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [`EF.cs`, `EFExtensions.cs` and `ParameterTranslationMode.cs` in dotnet/efcore](https://github.com/dotnet/efcore/tree/main/src/EFCore)
- [dotnet/efcore#13617, the original plan cache issue for inlined collections](https://github.com/dotnet/efcore/issues/13617)
