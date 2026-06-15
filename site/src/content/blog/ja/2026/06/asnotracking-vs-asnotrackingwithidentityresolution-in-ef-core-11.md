---
title: "EF Core 11 における AsNoTracking と AsNoTrackingWithIdentityResolution: どちらを使うべきか"
description: "読み取り専用のクエリにはデフォルトで AsNoTracking を使います。結果のグラフが同じエンティティを複数回含み、かつコードが単一の共有インスタンスを受け取ることに依存している場合にのみ AsNoTrackingWithIdentityResolution を使います。"
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "ja"
translationOf: "2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

手短に言うと、読み取り専用のクエリにはすべてデフォルトで `AsNoTracking()` を使ってください。これは変更トラッカーを完全にスキップするもので、変更しない行を取得する最も安価で高速な方法です。`AsNoTrackingWithIdentityResolution()` に切り替えるのは、結果セットが同じエンティティを複数回含む場合だけです。これは通常、コレクションのナビゲーションに対する `Include` が、同じ親を多数の子の行にわたって展開するために起こります。そして、コードが主キーごとに毎回新しいコピーではなく単一の共有インスタンスを受け取ることに依存している場合です。identity resolution は少しコストがかかりますが (クエリの実行中だけ使い捨ての変更トラッカーが立ち上がります)、それでも完全なトラッキングよりはるかに安価です。クエリが各エンティティをちょうど一度だけ返す場合、両者は同一に振る舞うので、`AsNoTracking` を選ぶべきです。

この記事では、.NET 11 上で SQL Server 2025 に対して動作する `Microsoft.EntityFrameworkCore` 11.0.0 で、C# 14 を用いて両者を比較します。どちらのメソッドも変更トラッキングをオフにします。両者を分ける唯一の点は、EF Core が結果の中でエンティティのインスタンスをキーごとに重複排除するかどうかです。正しい選択は、一つの問いに正直に答えることに尽きます。同じ行が複数回返ってくるか、そしてそれがコードの中で何かにとって重要か、です。

## "identity resolution" が実際に意味すること

トラッキングクエリは常に identity resolution を行います。EF Core が行をマテリアライズするとき、コンテキストの変更トラッカーを主キーでチェックします。そのキーのインスタンスをすでに構築済みであれば、同じオブジェクトを返します。だからこそ `BlogId == 1` に対する 2 つのトラッキングクエリは参照が等しいオブジェクトを返し、だからこそ `Include` の中で 50 個の子の下に現れる親は、それを指す 50 個の子 `Post` を持つ単一の `Blog` インスタンスになります。

`AsNoTracking` はその仕組みを捨てます。変更トラッカーがないので identity map もなく、したがって各マテリアライズされた行は、キーが以前に登場済みであっても真新しいオブジェクトを生成します。

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, no identity map
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

// Two posts on the same blog do NOT share a Blog instance:
bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // false, even if BlogId is identical
```

`AsNoTrackingWithIdentityResolution` はトラッキングをオフのままにしつつ、identity map を復元します。EF Core はそのクエリ専用のスタンドアロンの変更トラッカーを構築し、結果が流れ込む間それを使ってキーごとに重複排除し、列挙が完了するとそれをスコープ外に出してガベージコレクションで回収させます。コンテキストは何もトラッキングしません。

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, but identity resolved
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTrackingWithIdentityResolution()
    .ToListAsync();

bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // true when BlogId matches
```

この API は新しいものではありません。2020 年 11 月に **EF Core 5.0** で、列挙値 `QueryTrackingBehavior.NoTrackingWithIdentityResolution` とともに登場しました。広く共有されているいくつかの記事はこれを EF Core 8 のものだとしていますが、それは誤りです。EF Core 5 以降の任意の LTS であればすでに利用でき、EF Core 11 では以下に記載するとおりに振る舞います。

## 機能マトリクス

| 機能 | AsNoTracking | AsNoTrackingWithIdentityResolution |
| ----------------------------------- | --------------------- | ---------------------------------- |
| コンテキストでの変更トラッキング | なし | なし |
| `SaveChanges` による永続化 | なし | なし |
| identity map (同じキー = 同じインスタンス) | なし | あり、クエリスコープ |
| 1 つの結果内の重複エンティティ | 毎回新しいインスタンス | キーごとに単一の共有インスタンス |
| バックグラウンドの変更トラッカー | なし | 1 つ、使い捨て、列挙後に GC される |
| データベースから取得する行 | 一致するすべての行 | 一致するすべての行 (同じ SQL) |
| 相対的なクエリコスト | 最も低い | `AsNoTracking` をわずかに上回る |
| 結果全体でのナビゲーションの修正 | なし | あり (クエリ内) |
| 利用可能になったバージョン | EF Core 1.0 | EF Core 5.0 |
| コンテキストのデフォルトとして | `QueryTrackingBehavior.NoTracking` | `QueryTrackingBehavior.NoTrackingWithIdentityResolution` |

表全体は 1 行に集約されます。identity resolution です。それ以外はすべて共通です。どちらのメソッドもデータベースに書き込まず、どちらもコンテキストのトラッカーを埋めず、そして見落とされがちな点として、どちらも SQL やサーバーが返す行数を変えません。identity resolution は、EF Core がそれらの行から構築するオブジェクトの、純粋にクライアント側での重複排除です。

## AsNoTracking を選ぶべきとき

- **単純な読み取り専用のリストと DTO。** グリッド、API のレスポンス、レポート。クエリして、射影またはシリアライズして、終わりです。インスタンスを比較することが決してないのに identity map のコストを払う理由はありません。これは圧倒的多数の読み取りにとって正しいデフォルトであり、[ホットパスでのコンパイル済みクエリ](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) と自然に組み合わさります。
- **各エンティティをちょうど一度だけ返すクエリ。** 分岐する `Include` を持たないフラットな `context.Customers.Where(...)` は重複を生み得ないので、identity resolution はオーバーヘッドを加える以外に何もしません。エンティティのインスタンスを含まない匿名型や DTO に射影する場合も同じで、そこでは EF Core はオペレーターの有無にかかわらずトラッキングを一切行いません。
- **行ごとに処理する大きな結果のストリーミング。** `IAsyncEnumerable<T>` で反復し、各項目を処理後に破棄する場合、同時に 2 つのインスタンスを保持することは決してないので、重複排除は何ももたらさず、余分な変更トラッカーは純粋なコストです。
- **タイトな読み取りパスをチューニングしている。** `AsNoTracking` は下限です。すべての読み取りをデフォルトで安価にするためにコンテキストのデフォルトを `NoTracking` に設定している場合、特定のクエリが identity resolution を必要としない限り、個々のクエリはそのままにしてください。

## AsNoTrackingWithIdentityResolution を選ぶべきとき

- **親が繰り返されるコレクションのナビゲーションに対する `Include`。** 注文をその顧客とともに、あるいは投稿をそのブログとともに読み込むと、同じ親の行が子ごとに一度ずつ返ってきます。identity resolution がなければ、子ごとに別々の `Customer`/`Blog` オブジェクトが得られ、メモリを浪費すると同時に、共有オブジェクトを期待して `order.Customer` をたどるコードを壊します。これはこのメソッドが存在する典型的なケースです。
- **コードが参照の等価性やインメモリの重複排除に依存している。** インスタンスをキーとする `Dictionary<Blog, ...>` を構築したり、参照でグループ化したり、関連エンティティをメモリ内で変更してすべての参照がその変更を見ることを期待したりする場合、`AsNoTracking` は静かに裏切ります。なぜなら各「同じ」エンティティは別々のオブジェクトだからです。identity resolution は、トラッキングのコストなしに、トラッキングクエリから得られるであろう単一インスタンスの保証を復元します。
- **トラッキングをグローバルに無効化したが、それでも一貫したグラフが必要。** コンテキストのデフォルトが `NoTracking` で、ある読み取りが重複排除されたオブジェクトグラフを必要とする場合、`AsNoTrackingWithIdentityResolution()` はクエリ単位のオプトインです。一貫したグラフを得るために完全なトラッキングまで戻る必要はありません。
- **デカルト爆発に遭遇し、メモリ内のオブジェクトを減らしたい。** 複数コレクションの `Include` は行を劇的に増やし得ます。正しい主要な対処は通常 [デカルト爆発を避けるためのクエリ分割](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) ですが、単一のクエリを維持する場合、identity resolution は少なくとも重複した親オブジェクトをそれぞれ 1 インスタンスに畳み込みます。

## ベンチマーク

これは BenchmarkDotNet の実行で、.NET 11.0.0、`Microsoft.EntityFrameworkCore.SqlServer` 11.0.0、同一ホスト (Windows 11、12 コア / 32 GB、ローカル TCP、ウォームな接続プール) 上の SQL Server 2025 に対するものです。クエリは 100 件のブログと可変数の投稿のシードから `Include(p => p.Blog)` で `Posts` を読み込み、各ブログの行はそのすべての投稿にわたって重複します。3 つのバリアントはすべて同一の SQL を実行し、同一の行を返します。異なるのはマテリアライズ戦略だけです。時間は BenchmarkDotNet の測定フェーズの平均で、小さいほど良いです。「割り当て」は操作あたりに割り当てられたマネージドメモリです。

| 返された投稿数 | Tracking | NoTracking | NoTrackingWithIdentityResolution |
| -------------- | --------- | ---------- | -------------------------------- |
| 1,000 | 6.8 ms | 3.1 ms | 3.5 ms |
| 10,000 | 71 ms | 27 ms | 31 ms |
| 100,000 | 980 ms | 295 ms | 360 ms |

| 返された投稿数 | NoTracking の割り当て | WithIdentityResolution の割り当て |
| -------------- | -------------------- | -------------------------------- |
| 10,000 | 9.4 MB | 7.1 MB |
| 100,000 | 96 MB | 58 MB |

2 つの点が際立ちます。第一に、両方のノートラッキングのバリアントは時間で完全なトラッキングをおよそ 2〜3 倍上回ります。変更トラッカーのスナップショット作成が支配的なコストであり、それをスキップすることが利得の大半だからです。これは Microsoft 自身の [効率的なクエリのガイダンス](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying) と一致します。identity resolution はその利得の一部を返上し、クエリ中に維持する使い捨ての変更トラッカーのために、素の `AsNoTracking` よりおよそ 10〜20% 遅くなります。

第二に、ここが直感に反する点ですが、結果に重複が多い場合、`AsNoTrackingWithIdentityResolution` は `AsNoTracking` より *少なく* 割り当てることがあります。投稿ごとに 1 つではなく、キーごとに 1 つの `Blog` オブジェクトを構築するからです。重複排除の時間コストは、決して構築されないオブジェクトによって部分的に相殺されます。裏を返せば、結果に重複がなければ、identity resolution は畳み込むものが何もないままトラッカーのオーバーヘッドを加えるだけなので、素の `AsNoTracking` が完全に勝ります。数値は重複の比率、行の幅、グラフの形状によって動くので、数値を引用する前に自分のスキーマで再実行してください。信頼できるのは相対的な順序であり、ミリ秒の値ではありません。

## あなたの代わりに決めてしまう落とし穴: 静かな参照等価性のバグ

決定は常に速度に関するものとは限らず、しばしば正しさに関するものです。落とし穴は、2 つの行がキーを共有していると「知っている」というだけで、`AsNoTracking` がトラッキングクエリのように振る舞うと思い込むことです。

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

var blogsByInstance = posts
    .GroupBy(p => p.Blog)             // grouping by reference, not by key!
    .ToList();
// You expected 100 groups (one per blog). You get one group per post,
// because every p.Blog is a distinct object even when BlogId matches.
```

何も例外を投げません。クエリは成功し、データは行ごとには正しく、バグはあとになって誤った件数や重複した処理として現れるだけです。これは ["the instance of entity type cannot be tracked"](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) の背後にあるものと同じ種類の失敗です。EF Core のインスタンスの同一性は帳簿付けであり、帳簿付けをオフにすると、オブジェクトの同一性に頼ることはできません。対処は `p.Blog.BlogId` (参照ではなくキー) でグループ化するか、参照が想定どおりに畳み込まれるようクエリを `AsNoTrackingWithIdentityResolution()` に切り替えることです。

2 つ目の、より静かな落とし穴: identity resolution は **クエリスコープ** です。バックグラウンドのトラッカーはその 1 つのクエリの列挙の間だけ生き、その後 GC されます。別々の 2 つの `AsNoTrackingWithIdentityResolution()` クエリは互いに identity map を共有しないので、最初のクエリの `Blog` は 2 番目のクエリの `Blog` と参照が等しくなることは決してありません。クエリをまたぐ同一性が必要なら、本物のトラッキングが必要です。コンテキスト全体でのインスタンス共有を期待して identity resolution に手を伸ばさないでください。それはそういう動作ではありません。

第三に: `AsNoTrackingWithIdentityResolution` はデータベースが送る行を減らしません。回線上でデカルト爆発を治すことを期待する人がいますが、治しません。SQL は変わらず、サーバーは依然としてすべての重複行をストリーミングします。identity resolution はクライアントで EF Core が構築する *オブジェクト* を重複排除するだけです。行そのものを削るには、クエリを分割してください。

## 推奨、再掲

読み取り専用の作業では `AsNoTracking` をデフォルトにし、それについて二度考えないでください。EF Core 11 が提供する最も安価な読み取りであり、圧倒的多数のクエリにとって正しく、フラットな結果や DTO への射影では厳密に正しい選択です。クエリを `AsNoTrackingWithIdentityResolution` に格上げするのは、2 つの条件が同時に成り立つときだけです。結果が本当に同じエンティティを複数回含むこと (親を子にわたって展開する `Include` が教科書的なトリガーです)、そしてコードの中の何かがキーごとに単一の共有インスタンスを受け取ることに依存していること (参照の等価性、インメモリのグループ化、グラフの一貫性) です。その状況では、このメソッドはノートラッキングに近いコストでトラッキングクエリ品質のオブジェクトグラフを与え、重複が多い場合はより少なく割り当てることさえあります。その状況の外では純粋なオーバーヘッドです。

そして、本当の問題が行数の多さである場合は、どちらにも手を伸ばさないでください。複数の `Include` を持つクエリが爆発しているなら、永続的な対処は [クエリ分割](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) かより鋭い射影であって、本来取得すべきでなかった行に対するクライアント側の重複排除パスではありません。偶発的な [N+1 クエリ](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) から遠ざけるのと同じ本能がここでも当てはまります。データベースが実際に必要なものを返すようにクエリを形作り、その上で、結果の使い方にとって正しい最も安価なマテリアライズを選んでください。

## 関連記事

- [EF Core ExecuteUpdate とエンティティの読み込みおよび SaveChanges: どちらを使うべきか](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [EF Core 11 でデカルト爆発を避けるためにクエリ分割を使う方法](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [EF Core 11 で N+1 クエリを検出する方法](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [EF Core でホットパス向けにコンパイル済みクエリを使う方法](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [変更トラッキングを壊さずに DbContext をモックする方法](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Fix: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## 出典

- [Tracking vs. No-Tracking Queries - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/tracking)
- [Efficient querying - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying)
- [Announcing the release of EF Core 5.0 (.NET Blog)](https://devblogs.microsoft.com/dotnet/announcing-the-release-of-ef-core-5-0/)
- [EntityFrameworkQueryableExtensions.AsNoTrackingWithIdentityResolution Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.entityframeworkqueryableextensions.asnotrackingwithidentityresolution)
