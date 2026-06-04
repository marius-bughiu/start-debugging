---
title: "EF Core の ExecuteUpdate とエンティティの読み込み＋SaveChanges：どちらを使うべきか"
description: "EF Core 11 のための意思決定ガイドと実測ベンチマーク。述語による集合ベースの書き込みには ExecuteUpdate を使い、変更トラッカー、インターセプター、複雑なオブジェクトグラフが必要なときだけ読み込み→SaveChanges の経路を選びます。"
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "ja"
translationOf: "2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges"
translatedBy: "claude"
translationDate: 2026-06-04
---

短い答え：述語に一致する行を変更し、その後エンティティをメモリ上で必要としないなら、`ExecuteUpdateAsync` を使ってください。これは単一の `UPDATE` にコンパイルされ、行を読み込まず変更トラッキングも行わずに、完全にデータベース側で実行されます。そして数百行を超えると 1〜2 桁速くなります。読み込み→`SaveChanges` のパターンに戻すのは、変更トラッカーが提供するものが本当に必要なときだけです。すなわち、自動的にチェックされる同時実行トークン、`SaveChanges` のインターセプターとドメインイベント、追跡されたグラフ上のカスケード動作、あるいは単一の SQL 文として表現できないエンティティ単位のきめ細かいロジックです。

この記事では、.NET 11 上で SQL Server 2025 に対して動作する `Microsoft.EntityFrameworkCore` 11.0.0、C# 14 で、2 つのアプローチを比較します。この 2 つは、単に速度が違うだけの交換可能なツールではありません。両者は異なるレイヤーに位置します。`SaveChanges` は追跡されたエンティティに対するユニットオブワークであり、`ExecuteUpdate` は集合ベースの SQL 文に対する型付きラッパーです。正しく選ぶことは、自分の操作が実際にはどのレイヤーに属するのかを正直に見極めることがほとんどです。

## 2 つの形を並べて

追跡される経路は、読み込み、変更し、保存します。

```csharp
// .NET 11, EF Core 11.0.0 - tracked: load, mutate, save
var employees = await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ToListAsync();

foreach (var e in employees)
{
    e.Salary += 1000;
}

await context.SaveChangesAsync();
```

集合ベースの経路は、変更を述語とセッターとして記述します。

```csharp
// .NET 11, EF Core 11.0.0 - set-based: one UPDATE, nothing loaded
await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ExecuteUpdateAsync(s => s.SetProperty(e => e.Salary, e => e.Salary + 1000));
```

最初の版は、一致するすべての行をクライアントに取り込む `SELECT` を実行し、エンティティごとに変更トラッキングのスナップショットを作り、`SaveChanges` でそれぞれを比較し、変更された行ごとに `UPDATE` を 1 つ発行します（バッチ化されますが、それでも個別にパラメーター化されます）。2 番目の版は単一の文を発行します。

```sql
UPDATE [e]
SET [e].[Salary] = [e].[Salary] + 1000
FROM [Employees] AS [e]
WHERE [e].[DepartmentId] = @departmentId
```

集合ベースのメソッドの完全な仕組み、それらが発行する SQL、複数列のセッター、EF Core 10 のデリゲートセッターについては、[ExecuteUpdate と ExecuteDelete による一括書き込み](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) の補足ガイドを参照してください。この記事は、それらと追跡される経路の間でどう選ぶかについてです。

## 機能マトリクス

| 機能 | 読み込み + SaveChanges | ExecuteUpdate / ExecuteDelete |
| ----------------------------- | ------------------------------------ | --------------------------------- |
| クライアントに読み込む行 | 一致するすべての行 | なし |
| トラッカーのスナップショット | エンティティごとに 1 つ | なし |
| ラウンドトリップ | 1 SELECT + バッチ化された UPDATE | 1 |
| 発行される SQL | エンティティごとに 1 つの UPDATE（バッチ化） | 1 つの集合ベース UPDATE |
| 自動の同時実行トークン | あり（`DbUpdateConcurrencyException`） | なし、行数で手動 |
| SaveChanges のインターセプター / イベント | あり | なし |
| グラフ上のカスケード削除 | あり（追跡） | データベースの FK カスケードのみ |
| 利用可能になったバージョン | 常時 | EF Core 7.0 |
| 挿入のサポート | あり（`Add`） | なし、更新と削除のみ |
| 文をまたぐ原子性 | SaveChanges ごとに 1 トランザクション | トランザクションは自分で開く |

このマトリクスは 1 つの軸に沿ってきれいに分かれます。`SaveChanges` があなたのために行うことはすべて、エンティティをマテリアライズして追跡することの結果であり、`ExecuteUpdate` がより速いことはすべて、それを行わないことの結果です。

## ExecuteUpdate / ExecuteDelete を選ぶとき

- **述語による集合ベースの書き込み。**「90 日より古い注文をすべてアーカイブ済みにする」「削除済みとマークされた行をすべて削除する」「カウンターをインクリメントする」。変更は `WHERE` と `SET` として表現でき、その後に行は必要ありません。これは EF Core 11 における一括メンテナンスやクリーンアップ処理の既定の選択肢です。
- **単一の値に対する原子的な読み取り-変更-書き込み。** `SetProperty(b => b.Balance, b => b.Balance - amount)` は単一の文の中でデータベース側で新しい値を計算し、読み取りと書き込みの間に別のトランザクションが割り込む隙間がありません。追跡される経路は、あるラウンドトリップで読み取り別のラウンドトリップで書き込むため、まさにその隙間を開けてしまいます。
- **同時実行トークンを持つホットパス上の単一行エンドポイント。** トークンを `Where` に入れ、影響を受けた行数を確認します。これは `SELECT` とスナップショットを完全に省くため、単一行であっても追跡される経路より速いことがよくあります。[ホットパスでのコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) と自然に組み合わさります。
- **すでに行単位のラウンドトリップと戦っている。** 追跡クエリに対して `foreach` に手を伸ばしたなら、[N+1 クエリ](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) を遅くするのと同じこと、つまりデータベースが 1 回の集合ベース操作でできる作業を 1 行ずつ行っているのです。

## 読み込み + SaveChanges を選ぶとき

- **自動の楽観的同時実行が必要。** `[Timestamp]` / `rowversion` トークンがあると、`SaveChanges` はそれを `WHERE` に追加し、影響を受けた行を数え、`DbUpdateConcurrencyException` をスローするので、競合を解決できます。`ExecuteUpdate` はこれをあなたのために行いません。行数は自分で調べる必要があります。
- **`SaveChanges` のインターセプター、監査、ドメインイベント。** `ModifiedUtc` を刻んだり、監査行を書いたり、ドメインイベントをディスパッチする `ISaveChangesInterceptor` を持っている場合、集合ベースの文はそれらをすべて迂回します。書き込みは行われますが、横断的なロジックは一切実行されません。
- **複雑なオブジェクトグラフとカスケード動作。** 子を持つ親を挿入または変更し、EF Core が順序とカスケードを割り出す処理は、まさに追跡されるユニットオブワークが担うものです。`ExecuteInsert` は存在せず、（データベースの FK カスケードではなく）EF の動作として構成したカスケードは `SaveChanges` を通じてのみ実行されます。
- **単一の SQL 式ではないエンティティ単位のロジック。** 各行の新しい値がアプリケーションコードに依存する場合（サービスを呼ぶ、テーブルにないデータで分岐する、SQL で表現できないものを計算する）、エンティティを読み込んで C# で変更する必要があります。

## ベンチマーク

これは BenchmarkDotNet の実行です。.NET 11.0.0、`Microsoft.EntityFrameworkCore.SqlServer` 11.0.0、同一ホスト（Windows 11、12 コア / 32 GB、ローカル TCP、ウォームな接続プール）上の SQL Server 2025 に対して行いました。各反復は、200,000 行の `Employees` テーブルの一致するすべての行で単一の `decimal` 列を更新し、述語の選択度を変化させます。既定のバッチ処理はそのままです（SQL Server は `SaveChanges` のバッチを 42 文に制限します）。時間は BenchmarkDotNet の測定フェーズの平均で、小さいほど良いです。

| 変更された行 | 読み込み + SaveChanges | ExecuteUpdate | 高速化 |
| ------------ | ---------------------- | ------------- | ------ |
| 100 | 11.4 ms | 2.1 ms | ~5x |
| 1,000 | 92 ms | 3.0 ms | ~30x |
| 10,000 | 880 ms | 8.7 ms | ~100x |
| 100,000 | 9,100 ms | 64 ms | ~140x |

見出しになるのは形であって、正確な数値ではありません。追跡される経路は行数にほぼ線形にスケールします。これは行ごとにマテリアライズされたスナップショット 1 つとパラメーター化された `UPDATE` 1 つの代償を払うためです。一方 `ExecuteUpdate` はほぼ横ばいのままです。データベースが全体を 1 文で処理し、クライアントは行を一切見ないためです。100 行ではその差は実在しますが、他の懸念（同時実行トークン、インターセプター）が正当にあなたの代わりに決定できる程度に小さいです。10,000 行になると、追跡される経路は集合ベースの文が単に行わない作業を行っており、`MaxBatchSize` をいくら調整してもその差は埋まりません。コストはマテリアライズとラウンドトリップであって、バッチサイズではないからです。これらの数値は、Microsoft 自身の [効率的な更新のガイダンス](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating) や、Milan Jovanovic の [EF Core 一括更新の記事](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates) のような独立したベンチマークで報告される桁違いの差と一致します。倍率を引用する前に、必ず自分のスキーマとハードウェアで再実行してください。選択度、インデックス、行の幅がすべてそれを動かします。

このテーブルが隠していることが 1 つあります。`MaxBatchSize` の調整が追跡される経路を助けるのは、範囲の中間だけです。ドキュメントは、バッチ処理は 4 文未満では効率が落ち、SQL Server では約 40 を超えると利点が低下すると述べており、だからこそ既定の上限は 42 です。これを 100 に上げると、1,000 行では追跡される列をわずかに短縮しますが、100,000 行では意味のある効果はありません。依然として行ごとに 1 つの `UPDATE` をネットワーク越しに送っているからです。

## あなたの代わりに決める落とし穴：変更トラッカーが古くなる

判断は常に速度の話とは限りません。この 2 つの経路が出会うときに最もよくあるバグは、同じユニットオブワークの中でそれらを混在させることです。`ExecuteUpdate` は SQL を直接書き、変更トラッカーには何も伝えないため、すでに読み込んだエンティティは古いスナップショットを保持し続けます。

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var blog = await context.Blogs.SingleAsync(b => b.Id == id); // tracked, Rating == 5

await context.Blogs
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, b => b.Rating + 1)); // DB now 6

blog.Rating += 2;            // in-memory 7, original still recorded as 5
await context.SaveChangesAsync(); // writes 7, silently clobbering the bulk +1
```

一括書き込みの後、行は `6` ですが、追跡されているインスタンスはそれを知りません。`SaveChanges` は現在の値 `7` を、スナップショットに記録した元の値 `5` と比較し、プロパティが変わったと判断して `7` を書き込みます。あなたの一括の増分は消えます。これは ["the instance of entity type cannot be tracked"](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) の背後にあるものと同じ種類の失敗です。変更トラッカーは状態を持つメモリ内の記録であり、サイドチャネルの書き込みはそれを更新しません。

同じ行に対して両方を行わなければならない場合は、まず一括書き込みを実行し、再クエリの前に `context.ChangeTracker.Clear()` を呼ぶか、影響を受ける行を `AsNoTracking()` でクエリして、追跡されたものが古くならないようにします。同じ境界が、これらのメソッドをメモリ内の代替でテストできない理由でもあります。これは [変更トラッキングを壊さずに DbContext をモックする](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) の背後にある考え方です。

2 つ目の落とし穴はトランザクションです。`SaveChanges` はバッチ全体を 1 つのトランザクションで包みますが、2 回の `ExecuteUpdate` 呼び出しは、`context.Database.BeginTransactionAsync()` で自分でトランザクションを開かない限り、2 つの独立したトランザクションです。2 つの一括文を一緒に成功または失敗させたいなら、それはあなたの責任です。

## 推奨、あらためて

概念的に集合ベースの変更であるものはすべて、既定で `ExecuteUpdate` と `ExecuteDelete` を選んでください。行を述語で記述し、変更をセッターで記述し、データベースに 1 文で処理させます。数百行を超えればパフォーマンスの差は些細ではなく、コードはより短く明快です。読み込み→`SaveChanges` の経路は、変更トラッカーのサービスが必要なときに意図的に選ぶものとして扱ってください。すなわち、同時実行競合の自動検出、インターセプターとドメインイベント、追跡されたグラフ上のカスケード動作、あるいは SQL に還元できない行単位のロジックです。これらは現実的で価値ある機能であり、それらが必要なときは、速度にかかわらず追跡される経路が正しいのです。やってはいけないのは、単一の `UPDATE` で済む 1 万行を変更するために習慣で追跡ループに手を伸ばすことであり、トラッカーを途中でクリアせずに 2 つの経路が同じエンティティに触れることを決して許してはいけません。

大量の *挿入* のケースでは、`ExecuteInsert` が存在しないため、どちらのメソッドも答えにはなりません。そのケースには [EF Core 11 と Dapper の一括挿入](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) という独自のベンチマークがあります。

## 関連

- [EF Core 11 で ExecuteUpdate と ExecuteDelete を使って一括書き込みする方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [EF Core 11 と Dapper の一括挿入：実測ベンチマーク](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [ホットパスで EF Core のコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [修正：the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## 出典

- [効率的な更新 - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating)
- [ExecuteUpdate と ExecuteDelete - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)
- [データ保存の概要 - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/)
- [What you need to know about EF Core bulk updates (Milan Jovanovic)](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates)
