---
title: "EF Core 11 の生成 id エスケープ変更後に EF Core Cosmos アプリを移行する"
description: "EF Core 11 は Cosmos DB の生成 id 値に含まれる '/', '\\', '?', '#' をエスケープしなくなったため、EF Core 8-10 で書き込んだドキュメントがキーで解決できなくなります。影響を受けるかどうかの確認方法、EscapeIllegalCosmosIdCharacters スイッチを設定すべき場面、そしてトランザクションバッチで id を安全に書き換える方法を解説します。"
pubDate: 2026-09-19
updatedDate: 2026-09-19
template: migration
tags:
  - "migration"
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/migrate-an-ef-core-cosmos-app-after-the-generated-id-escaping-change"
translatedBy: "claude"
translationDate: 2026-09-19
---

EF Core 11 では、ドキュメントの `id` が複数の値から構成される場合に、Azure Cosmos DB プロバイダーがその `id` を組み立てる方法が変わります。EF Core 8、9、10 は各パーツ内の `/`、`\`、`?`、`#` を `^2F`、`^5C`、`^3F`、`^23` に置き換えていました。EF Core 11 (この変更は 11.0 preview 5 で出荷され、私は 11.0.0 RC 1 で確認しました) は、代わりに生の文字をそのまま書き込みます。複合キーの値にこの 4 文字がどれも含まれていなければ、アップグレードによる変化は何もなく、次のセクションまで読めば十分です。含まれている場合は、アップグレード後に `FindAsync` やキーによる検索でそれらのドキュメントが見つからなくなります。そのときの選択肢は 2 つです。アプリの起動前に `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters` スイッチを設定するか、影響を受ける id を書き換えるかです。`/` または `\` を含むキーについては、スイッチが唯一機能する選択肢です。Cosmos DB は `id` にこれらの文字を含めることを拒否するからです。監査には 1 時間ほど見込んでおいてください。ほとんどのチームは、やることが何もないとわかるはずです。

## 実際に影響を受けるのは誰か

エスケープが適用されていたのは、複数パーツからなる id だけです。EF Core 11 RC 1 のタグで `JsonIdDefinition` を読んだところ、1 つの値からなるキーはそのまま書き込まれ、エスケープは複数の値が `|` で連結されるときにのみ行われます。パーティションキーのプロパティは、その判定の前に id から除外されます。したがって、エンティティ型が対象になるのは次のいずれかに当てはまる場合だけです。

- パーティションキーのプロパティを除いても、主キーに 2 つ以上のプロパティが残る。たとえば `HasKey(x => new { x.TenantId, x.OrderId, x.Sku })` と `HasPartitionKey(x => x.TenantId)` の組み合わせでは、id は `OrderId|Sku` になります。
- `HasDiscriminatorInJsonId()` を使っている。EF Core 8 からアップグレードしたアプリは、古い `Post|1` 形式の id を維持するために EF Core 9 でこれを有効にしていることが多いため、これが影響を受ける最も一般的なパターンです。

そのうえで、キー値のいずれかに `/`、`\`、`?`、`#` が含まれている必要があります。GUID や整数のキーには含まれ得ません。問題になるのは、自由記述やパス形式の文字列キー (`shoes/red` のような SKU、`2026/09/hello` のようなスラッグ、ファイル名、URL) です。

私は同じエンティティを、データベースなしで EF Core 10.0.12 と EF Core 11.0.0 RC 1 に通してみました。エンティティを `DbContext` に追加すると id の値ジェネレーターが実行されるので、生成された id を変更トラッカーから直接読み取れます。

| キー値 | EF Core 10.0.12 | EF Core 11 RC 1 | EF Core 11 RC 1 + スイッチ |
| ---------- | --------------- | --------------- | ------------------------ |
| `o-1`, `shoes/red` | `o-1\|shoes^2Fred` | `o-1\|shoes/red` | `o-1\|shoes^2Fred` |
| `o-1`, `shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` |
| `o-1`, `C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` | `o-1\|C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` |
| `o-1`, `a\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` |
| 単一キー `shoes/red` | `shoes/red` | `shoes/red` | `shoes/red` |
| `HasDiscriminatorInJsonId`, `2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` | `LegacyPost\|2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` |

最初の 2 行が、この変更の理由です ([dotnet/efcore#38244](https://github.com/dotnet/efcore/issues/38244))。エスケープ文字 `^` 自体はエスケープされていなかったため、`shoes/red` と `shoes^2Fred` が同じ id になり、2 回目の挿入が 1 つ目のドキュメントを黙って上書きしていました。EF チームは `^` もエスケープするのではなく、エスケープをやめることを選びました。`^` をエスケープすると、キャレットを含む既存の id がすべて壊れてしまうからです。修正は [dotnet/efcore#38245](https://github.com/dotnet/efcore/pull/38245) で、2026-05-08 にマージされました。なお、区切り文字 `|` はどちらのバージョンでも引き続き `^|` としてエスケープされるので、id のその部分は変わりません。

## 何が壊れるか

| 領域 | EF Core 11 へのアップグレード後の変化 | 深刻度 |
| ---- | ------------------------------------ | -------- |
| `FindAsync`、および完全なキーとパーティションキーでフィルターするクエリ | EF はこれらを新たに生成した id を使うポイント読み取りに変換するため、エスケープ済みの id で保存されたドキュメントは `null` または空の結果として返ってきます | 高 |
| 古いドキュメントとキーが一致するエンティティの挿入 | 新しい id が異なるため、`?` と `#` の場合は競合にならず、同じキー値を持つ 2 つ目のドキュメントが作られます | 高 |
| `/` または `\` を含む新しいキー | EF 11 はこれらの文字を id にそのまま送りますが、Cosmos DB サービスは id に `/` と `\` を許可していない ([サービスの制限](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)) ため、書き込みが失敗します | 高 |
| クエリで読み込んだエンティティの更新と削除 | 引き続き動作します。`SaveChanges` は新たに生成した値ではなく、ドキュメントから具体化された `__id` の値を使います | なし |
| 完全なキーでフィルターしないクエリ | 引き続き動作します。id を使わないからです | なし |

危険なのは 2 行目です。よくある「探して、なければ追加する」パターンは古いドキュメントに対して `null` を返し、その隣に重複を作ります。例外はスローされません。

## 事前チェックリスト

- アプリが `Microsoft.EntityFrameworkCore.Cosmos` 11.0.0-rc.1.26425.128 (リリースされたら GA 版) に対してビルドでき、[EF Core 11 の破壊的変更](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes)の残りにも目を通してあること。Cosmos プロバイダーには 11 でいくつかの変更があり、同期 I/O の削除や、マップされていないプロパティのラウンドトリップの廃止も含まれます。
- EF が書き込むすべてのコンテナーに対して、Data Explorer または SDK でアクセスできること。
- id を書き換える前に、アカウントで継続的バックアップまたはポイントインタイムリストアが有効になっていること。
- どのキープロパティがユーザー入力や自由記述の文字列を保持しているか把握していること。

## 移行手順

1. **複数パーツの id を持つエンティティ型を列挙する。**
   次のコードは公開されている Cosmos メタデータ API で EF モデルを走査し、プロバイダーと同じルールを適用します。

   ```csharp
   // EF Core 11.0 RC 1, .NET 11 RC 1
   foreach (var entityType in db.Model.GetEntityTypes().Where(t => !t.IsOwned()))
   {
       var key = entityType.FindPrimaryKey()!;
       var partitionKeyNames = entityType.GetPartitionKeyPropertyNames();
       var idParts = key.Properties.Count(p => !partitionKeyNames.Contains(p.Name));
       var discriminatorInId = entityType.GetDiscriminatorInKey()
           is IdDiscriminatorMode.EntityType or IdDiscriminatorMode.RootEntityType;

       Console.WriteLine($"{entityType.DisplayName(),-12} container={entityType.GetContainer(),-8} " +
           $"id parts={idParts} discriminator in id={discriminatorInId} " +
           $"-> {(idParts > 1 || discriminatorInId ? "AFFECTED" : "not affected")}");
   }
   ```

   パーティション分割された `OrderLine` (キーは `TenantId, OrderId, Sku`) と単一キーの `Product` を持つモデルでは、次のように出力されます。

   ```text
   OrderLine    container=Orders   id parts=2 discriminator in id=False -> AFFECTED
   Product      container=Catalog  id parts=1 discriminator in id=False -> not affected
   ```

   確認: `AFFECTED` と表示されたすべてのエンティティ型に、少なくとも 1 つの `string` キープロパティがあること。すべてが `Guid`、`int`、`long` なら作業は完了です。それらについて、EF Core 11 は EF Core 10 と同じ id を生成します。

2. **実際にエスケープシーケンスを含むドキュメントを数える。**
   影響を受ける型を保持している各コンテナーに対して、Data Explorer で次を実行します。

   ```sql
   -- Azure Cosmos DB for NoSQL
   SELECT c.id, c["$type"] FROM c
   WHERE CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C")
      OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23")
   ```

   `$type` は、EF Core 9 以降に EF が書き込んでいる JSON の識別子名です。EF Core 11 ではモデルのプロパティ名が `Discriminator` に変わりましたが、JSON 内の名前は引き続き `$type` です。確認: 0 行であれば、保存済みのドキュメントで id が変わるものはありません。その場合に残る問題は、*新しい*キーにこれらの文字が含まれ得るかどうかだけで、それについては手順 3 が引き続き当てはまります。

3. **古いエスケープを維持するか、生の id に移行するかを決める。**
   次のルールに従います。

   - キーに `/` または `\` が含まれ得る場合: スイッチで古いエスケープを維持します (手順 4)。これらの文字を含む生の id は Cosmos DB に保存できないので、移行先がありません。唯一の代替策は、キー値そのものを変えることです。
   - キーに含まれ得るのが `?` または `#` だけの場合: id を書き換え (手順 5)、古いエスケープを完全にやめることができます。これで衝突のバグもなくなります。
   - キー値をユーザーが入力できる場合: スイッチを有効にしていると、リテラル文字列 `shoes^2Fred` を送信したユーザーが `shoes/red` を上書きできる点に注意してください。それが問題になるなら、キーの入力に `^` が決して含まれないように検証します。

   確認: エンティティ型ごとに決定内容を書き残すこと。複数の型が混在するコンテナーでは、両方が必要になることもあります。

4. **エスケープを維持する場合は、EF が読み込まれる前にスイッチを設定する。**
   プロバイダーはスイッチを一度だけ読み取り、`JsonIdDefinition` の `static readonly` フィールドに格納します。最も安全な設定場所はプロジェクトファイルです。MSBuild がそれを `runtimeconfig.json` に書き込むからです。

   ```xml
   <!-- EF Core 11.0, .NET 11 -->
   <ItemGroup>
     <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters"
                                     Value="true" />
   </ItemGroup>
   ```

   `AppContext.SetSwitch("Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters", true)` も、`Program.cs` の最初の行、つまり `DbContext` が 1 つも作成される前であれば機能します。確認は id ジェネレーター自体で行います (手順 6)。私は RC 1 で `runtimeconfig.json` のエントリと起動時の `SetSwitch` 呼び出しの両方を試し、どちらも `o-1|shoes^2Fred` になりました。

5. **生の id に移行する場合は、ドキュメントをその場で書き換える。**
   Cosmos DB は `id` の名前を変更できないため、各ドキュメントを新しい id で作り直し、古いほうを削除します。両方のドキュメントは同じパーティションキーを共有するので、トランザクションバッチを使えば入れ替えをアトミックに行えます。新しい id は形式を自前で再実装するのではなく、EF Core 11 自体で計算します。キーだけを設定したインスタンスを使い捨てのコンテキストに追加して、`__id` を読み取ります。書き換えは EF を経由せず、生の JSON で行います。EF Core 11 はモデルにマップされていない JSON プロパティを保持しなくなったため、EF 経由で保存するとそれらが失われるからです。

   ```csharp
   // EF Core 11.0 RC 1, Microsoft.Azure.Cosmos 3.x, .NET 11 RC 1
   // Run with the switch OFF, so EF generates the new ids.
   using var client = new CosmosClient(connectionString);
   var container = client.GetContainer("shop", "Orders");
   var query = new QueryDefinition(
       """
       SELECT * FROM c
       WHERE c["$type"] = "OrderLine"
         AND (CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C") OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23"))
       """);

   await using var idContext = new ShopContext(connectionString); // never saved
   using var iterator = container.GetItemQueryStreamIterator(query);
   while (iterator.HasMoreResults)
   {
       using var page = await iterator.ReadNextAsync();
       page.EnsureSuccessStatusCode();
       var documents = JsonNode.Parse(page.Content)!["Documents"]!.AsArray();

       foreach (var doc in documents.Select(d => d!.AsObject()))
       {
           var oldId = (string)doc["id"]!;
           var line = new OrderLine
           {
               TenantId = (string)doc["TenantId"]!,
               OrderId = (string)doc["OrderId"]!,
               Sku = (string)doc["Sku"]!,
           };
           var entry = idContext.Add(line);
           var newId = (string)entry.Property("__id").CurrentValue!;
           entry.State = EntityState.Detached;

           if (newId == oldId) continue; // the key really contains "^2F"
           if (newId.Contains('/') || newId.Contains('\\'))
           {
               Console.WriteLine($"BLOCKED  {oldId} -> {newId}");
               continue;
           }

           Console.WriteLine($"{(apply ? "REWRITE " : "DRY RUN ")} {oldId} -> {newId}");
           if (!apply) continue;

           var etag = (string)doc["_etag"]!;
           foreach (var system in new[] { "_rid", "_self", "_etag", "_attachments", "_ts" })
               doc.Remove(system);
           doc["id"] = newId;

           using var body = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(doc));
           using var result = await container
               .CreateTransactionalBatch(new PartitionKey(line.TenantId))
               .CreateItemStream(body)
               .DeleteItem(oldId, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag })
               .ExecuteAsync();

           if (!result.IsSuccessStatusCode)
               Console.WriteLine($"  FAILED {result.StatusCode}: {result.ErrorMessage}");
       }
   }
   ```

   キーは、エスケープされた id から復元するのではなく、ドキュメント自身のプロパティから読み取ります。これが衝突ケースに対してツールを安全にしているポイントです。`o-1|shoes^2Fred` として保存され、`Sku` が本当に `shoes^2Fred` であるドキュメントは、EF 11 でも同じ id を生成するのでスキップされます。私は RC 1 で 4 つのサンプルドキュメントに対して id のロジックをオフラインで実行しました。出力は `BLOCKED o-1|shoes^2Fred -> o-1|shoes/red`、`DRY RUN o-1|gift^23card -> o-1|gift#card`、`DRY RUN o-1|what^3F -> o-1|what?` で、リテラル `shoes^2Fred` のドキュメントはスキップされました。バッチ自体はライブのアカウントでもエミュレーターでも実行していないので、まずドライランを実行し、その後データベースを復元したコピーに対して `--apply` を実行してください。削除に付けた `IfMatchEtag` により、同時に行われた書き込みを失う代わりにバッチが失敗します。失敗した場合はツールをもう一度実行します。確認: 手順 2 のクエリが `BLOCKED` のドキュメントだけを返すか、何も返さないこと。

6. **テストで id の形式を固定する。**
   id ジェネレーターは `Add` で実行されるので、単体テストで Cosmos DB なしに形式を確認できます。

   ```csharp
   // EF Core 11.0 RC 1, xUnit v3
   [Theory]
   [InlineData("shoes/red", "o-1|shoes^2Fred")] // expected with the switch on
   [InlineData("gift#card", "o-1|gift^23card")]
   public void Generated_id_matches_stored_documents(string sku, string expectedId)
   {
       using var db = new ShopContext("AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdA==");
       var entry = db.Add(new OrderLine { TenantId = "t1", OrderId = "o-1", Sku = sku });
       Assert.Equal(expectedId, entry.Property("__id").CurrentValue);
   }
   ```

   確認: アプリと一緒に出荷するものと同じ `runtimeconfig.json` で、CI 上のテストが成功すること。誰かが `RuntimeHostConfigurationOption` を削除したら、本番環境ではなくこのテストが失敗します。

## 検証

EF Core 11 をデプロイしたら、実データに対して次の 3 点を確認します。

- `await db.OrderLines.FindAsync("t1", "o-1", "shoes/red")` (以前はエスケープされていたキー) が `null` ではなくエンティティを返すこと。
- 手順 2 のクエリが、スイッチを維持した場合は以前と同じ件数を返し、移行した場合は (`BLOCKED` の行を除いて) 0 件を返すこと。
- 重複を探すクエリが何も返さないこと: `SELECT c.TenantId, c.OrderId, c.Sku, COUNT(1) AS n FROM c GROUP BY c.TenantId, c.OrderId, c.Sku` を実行し、`n` が 1 より大きいものがないか確認します。これで「何が壊れるか」の表にある、黙って行われる重複挿入を検出できます。

## ロールバック計画

スイッチの維持は完全に元に戻せます。パッケージのアップグレードを取り消せば、EF Core 10 はこれまでと同じ id を生成します。id の書き換えは、再デプロイでは元に戻せません。EF Core 10 は再びエスケープ済みの id を生成し、書き換えたドキュメントを見つけられなくなります。つまり、書き換えを行うと EF Core 11 から戻れなくなります。戻る手段が必要なら、書き換え前に取ったバックアップからコンテナーを復元するか、スイッチを有効にした EF Core 11 をデプロイし (古い id はその設定でも有効です)、ツールを逆方向に実行し直します。その手順に頼る前に、必ずテストしておいてください。

## 落とし穴

- **スイッチ名には世の中に 2 通りの綴りがあります。** issue と `JsonIdDefinition` 内のコードコメントはどちらも `Microsoft.EntityFrameworkCore.EscapeIllegalIdCharacters` と書いています。実際にコードが読み取るのは `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters` で、破壊的変更のドキュメントもこちらを記載しています。私は RC 1 で短いほうの名前を `runtimeconfig.json` に設定してみましたが、効果はなく、id はエスケープされないままでした。
- **スイッチを遅れて設定しても何も起きません。** 私の検証では、最初の `DbContext` が id を生成した後に呼び出した `AppContext.SetSwitch` は無視され、次のコンテキストも `o-2|shoes/red` を生成しました。`builder.Build()` の後に構成からスイッチを設定するホスト型アプリは、この問題に当たります。
- **単一キーの id はもともとエスケープされていませんでした。** `Id = "shoes/red"` の `Product` は、10 でも 11 でも常に `shoes/red` として書き込まれてきたので、`/` に関する Cosmos DB の制限はすでに適用されていました。今回の変更が影響するのは、複数の値からなる id だけです。
- **パーティションキーのプロパティは id に含まれません。** キーを確認するときは、`HasPartitionKey` に渡すプロパティを無視してください。プロバイダーはそれらを id ではなくパーティションキーとして送るので、その値には何が含まれていてもかまいません。
- **バッチはパーティション単位で、操作数の上限は 100 です。** このツールは失敗の影響を局所化するため、ドキュメントごとに 1 つのバッチを発行します。複数のドキュメントをまとめてバッチにする場合は、パーティションキーでグループ化し、上限を超えないようにしてください。

## 関連記事

- 書き換えツールは、EF Core 11 がすべての `SaveChanges` で使うようになったのと同じ仕組みに依存しています: [EF Core 11 は Cosmos DB のトランザクションバッチを既定で有効にします](/ja/2026/04/efcore-11-cosmos-transactional-batches/)。
- 複数のメジャーバージョンを一度に飛ばす場合は、[EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)に、途中で遭遇するその他の破壊的変更がまとめてあります。
- アップグレードで黙って変わる EF Core 11 の既定値はほかにもあります: [SQL Server の互換性レベル 150 と 160](/ja/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)。
- すべてのポイント読み取りをログに出し、EF が Cosmos DB にどの id を要求しているかを見るには、[EF Core のインターセプター](/ja/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/)が最も手軽なフックです。
- Cosmos ドキュメント内の所有型もアップグレード対象に入っているなら、[EF Core 11 における複合型と所有エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)を参照してください。

## ソース

- [EF Core 11 の破壊的変更: Cosmos の不正な `id` 文字はエスケープされなくなった](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes#cosmos-no-id-escape)
- [dotnet/efcore#38244: キー値にエスケープシーケンスが含まれると、生成された `id` 値が衝突する可能性がある](https://github.com/dotnet/efcore/issues/38244)
- [dotnet/efcore#38245: 不正な id 文字をエスケープしない](https://github.com/dotnet/efcore/pull/38245)
- [v11.0.0-rc.1.26425.128 時点の `JsonIdDefinition.cs`](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinition.cs)
- [v11.0.0-rc.1.26425.128 時点の `JsonIdDefinitionFactory.cs`](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinitionFactory.cs)
- [Azure Cosmos DB のサービスクォータ: ID 値に使用できる文字](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)
- [Azure Cosmos DB のトランザクションバッチ操作](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [EF Core 9 の破壊的変更: 識別子が `id` に含まれなくなった](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/breaking-changes#cosmos-id-property-changes)
