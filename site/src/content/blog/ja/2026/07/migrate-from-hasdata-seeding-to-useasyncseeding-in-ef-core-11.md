---
title: "EF Core 11 で HasData シーディングから UseAsyncSeeding へ移行する"
description: "EF Core 11 でシードデータを HasData から UseSeeding と UseAsyncSeeding へ移す手順ガイド。見落とすと既存の行を削除してしまう DeleteData マイグレーションの落とし穴も含みます。"
pubDate: 2026-07-08
updatedDate: 2026-07-08
template: migration
tags:
  - "migration"
  - "efcore"
  - "dotnet"
lang: "ja"
translationOf: "2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-08
---

EF Core 11 でシードデータを `HasData` から `UseSeeding`/`UseAsyncSeeding` へ移すのは、典型的なアプリケーションなら半日の作業です。そしてあなたを噛むのは新しい API ではありません。問題は、`HasData` の呼び出しを削除すると、次の `dotnet ef migrations add` が `DeleteData` の命令を生成し、マイグレーションが実行されるすべてのデータベースからまさにその行を削除してしまうことです。順序を考えずに同じデプロイで `HasData` を削除して `UseSeeding` を追加すると、本番の参照データを消してしまう可能性があります。このガイドは、それを避ける順序でマイグレーションを進めます。使用するのは .NET 11、EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0)、そして C# 14 です。中規模アプリなら午後いっぱいを見込んでください。その大半は、何年も前に移すべきだったシードを監査する時間に費やされます。

やる価値はあるでしょうか。動的なもの、キーが生成されるもの、計算されるもの、条件付きのものなら、答えはイエスで、しかも遅すぎたくらいです。本当に静的な 3 行の参照テーブルなら `HasData` のままにしておきましょう。ここでの目的は「すべての `HasData` を削除する」ことではなく、「そもそもモデルに属していなかったシードを移す」ことです。

## そもそもなぜ HasData を離れるのか

`HasData` はシードデータをモデルのスナップショットに埋め込みます。この 1 つの設計上の事実が、離れるべきあらゆる理由の根源です。

- **非決定的な値がファントムマイグレーションを生む。** `HasData` の行の中にある `DateTime.UtcNow`、`Guid.NewGuid()`、あるいはハッシュ化されたパスワードは、モデルの diff を決して一致させません。そのため EF はビルドのたびにモデルが変わったと判断し、`PendingModelChangesWarning` で警告するか、無意味なマイグレーションを延々と垂れ流します。これは多くのチームがぶつかる壁で、しばしば [EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)の途中で起こります。
- **データベース生成のキーが不可能。** `HasData` はすべての主キーを手で書き出すことを要求します。identity 列やシーケンスは対象外なので、結局キーを自分で考え出し、実際の挿入と衝突しないよう祈ることになります。
- **条件ロジックも、ナビゲーショングラフも、変換もない。** 「Development でのみデモテナントをシードする」や「このオブジェクトグラフをナビゲーションプロパティ経由で挿入する」は、`HasData` ではまったく表現できません。
- **望むと望まざるとにかかわらず、シードはスキーマの diff の一部になる。** すべての値の編集はマイグレーション内の `UpdateData` になります。これは国コードにとっては機能ですが、コードとして管理したい他のあらゆるものにとっては迷惑です。

EF チームは `HasData` を "model-managed data" に改名しましたが、それはまさに汎用シーディングツールとしての使用を思いとどまらせるためです。EF Core 9 で導入され EF Core 11 でも現役の `UseSeeding` と `UseAsyncSeeding` は、生きた `DbContext` に対して実行される普通のアプリケーションコードで、これらの制限はどれもありません。どのシードを移すかまだ決めかねているなら、[HasData と UseSeeding の判断マトリクス](/ja/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/)が行ごとに線引きをしてくれます。

## 何が壊れるか

| 領域 | 変更 | 深刻度 |
| ---- | ---- | ------ |
| 既存のデータベース | `HasData` の呼び出しを削除すると `DeleteData` が生成され、マイグレーション時にシード行を削除する | 高 |
| べき等性 | `HasData` は自動的に差分が取られていた。`UseSeeding` は毎回実行され、手書きの存在チェックが必要 | 高 |
| 2 つのコードパス | ツールは同期版の `UseSeeding` を呼び、async 起動は `UseAsyncSeeding` を呼ぶ。片方だけ実装すると、もう片方は静かに何もしない | 高 |
| バージョン管理 | シードの値はマイグレーションのスナップショットを離れ、起動コードに存在するようになる。マイグレーション履歴には捕捉されなくなる | 中 |
| 参照整合性 | 他テーブルの外部キーが依存するデータが、マイグレーションのトランザクション内ではなく起動コールバックに置かれるようになる | 中 |
| テストのセットアップ | `HasData` が `EnsureCreated` 経由で実行されることに依存していたテストは、両方のオーバーロードを実装した場合に限り引き続き動作する | 低 |

一番上の行が、インシデントレポートに載る行です。それ以外は機械的な作業です。

## 事前チェックリスト

シーディングのコードに 1 行でも触れる前に:

- **EF Core のバージョンが 9.0 以降であることを確認する。** `UseSeeding`/`UseAsyncSeeding` は EF Core 9 より前には存在しません。`dotnet list package | findstr EntityFrameworkCore` を実行し、11.0(最低でも 9.0)を確認してください。
- **すべての `HasData` 呼び出しを棚卸しする。** コードを grep します: `grep -rn "HasData" .`(Windows なら `findstr /s HasData *.cs`)。それぞれについて、下記のルールで残すか移すかを判断してください。
- **各シードを分類する。** データが小さく、固定で、決定的で、キーが手書きで、それがなければスキーマが意味をなさないもの(注文ステータスの enum、ISO 国コード)なら `HasData` に残します。データベース生成のキー、計算値や非決定的な値、条件ロジック、ナビゲーションプロパティ、外部変換を持つなら `UseSeeding` へ移します。
- **本番をバックアップするか、復元したコピーでリハーサルする。** あなたはこれから `DELETE` 命令を発行するマイグレーションを生成しようとしています。その挙動を本番で発見してはいけません。
- **`HasData` の行がすでに適用されている staging データベースを用意する。** 削除マイグレーションが、空のデータベースではなく、旧来の方法でシードされたデータベースに対して何をするのかを見る必要があります。

## マイグレーションの手順

順序が重要です。これを間違った順序で行うことが、まさに本番の参照データを削除する方法そのものです。

### 1. まず UseSeeding と UseAsyncSeeding のコールバックを書く

何かを削除する前に、新しいシーディングのパスを追加します。両方のオーバーロード、同一のロジック、それぞれの先頭に存在チェックを置きます。同期版と async 版がずれないよう、本体を共有メソッドに切り出します。

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedStatuses(context))
        .UseAsyncSeeding((context, _, ct) => SeedStatusesAsync(context, ct)));

static void SeedStatuses(DbContext context)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        context.SaveChanges();
    }
}

static async Task SeedStatusesAsync(DbContext context, CancellationToken ct)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = await context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToListAsync(ct);

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        await context.SaveChangesAsync(ct);
    }
}
```

このバージョンはもう `Id` を手書きで固定していない点に注目してください。データベースが割り当てます。それが要点です。もし以前 `HasData` でキーを手書きで割り当てていたなら、既存の外部キー参照がまさにその値を指している可能性があり、それが手順 2 を繊細にします。

**検証:** `HasData` の呼び出しをまだ残したまま、空のローカルデータベースに対してアプリケーションを実行します。重複行なしできれいに起動するはずです。存在チェックにより、2 回目の起動は何もしない(読み取りクエリ 1 回、書き込み 0 回)はずです。

### 2. HasData を削除する前に、既存の行をどう保存するかを決める

これは誰もが飛ばして後悔する手順です。`HasData` の呼び出しを削除して `dotnet ef migrations add` を実行すると、EF は以前シードされた各行について `Up` メソッドに `DeleteData` を生成します。

```csharp
// .NET 11, EF Core 11 -- what removing HasData generates
migrationBuilder.DeleteData(
    table: "OrderStatuses",
    keyColumn: "Id",
    keyValues: new object[] { 1, 2, 3 });
```

既存のデータベースでは、その `DELETE` が実行されます。他のテーブルにこれらの行を指す外部キーがあると、削除は `FOREIGN KEY constraint failed` エラーで失敗するか、さらに悪いことにカスケードします。安全な選択肢は 3 つあります。

- **A. キーを安定させ、シードに再挿入させる。** 行が入ってくる外部キーのない純粋な参照データなら、マイグレーションに削除させ、次の起動時に `UseSeeding` に再挿入させるのは問題ありません。ただし新しいキーは(データベース生成なので)変わるため、古いキーを何も参照していない場合にのみ安全です。
- **B. 生成されたマイグレーションを手で編集して `DeleteData` を取り除く。** `dotnet ef migrations add RemoveStatusSeed` のあと、生成されたファイルを開いて `DeleteData` の呼び出し(および `Down` の対応する `InsertData`)を削除します。行はそのまま残り、モデルスナップショットだけがそれらの追跡をやめます。外部キーがシード行を参照していて、それらを手つかずのままにしたい場合、これが最も安全な選択肢です。
- **C. 新しいシーダーでキーを保存する。** 正確なキー値を保持しなければならない(外部キーがそれらに依存している)場合は、`UseSeeding` の中で引き続き明示的に割り当て、それでも `DeleteData` は手で編集して取り除きます。このテーブルではデータベース生成キーの利点を失いますが、参照整合性は保たれます。

入ってくる外部キーを持つものについては、選択肢 B がほぼ常にあなたの求めるものです。行を移す必要はなく、移すのはそれらの所有権だけです。

**検証:** 削除マイグレーションを生成したら、適用する前に生成されたファイルを読んでください。`DeleteData` の呼び出しが期待どおりの行だけを対象にしていること、そして各テーブルについて A、B、C のいずれかを選んで適用したことを確認します。

### 3. OnModelCreating から HasData の呼び出しを削除する

さて、移すシードの `HasData` ブロックを削除します。

```csharp
// Before -- .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}

// After -- the HasData block is gone; seeding lives in UseSeeding now
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    // OrderStatus seeding moved to UseSeeding in Program.cs
}
```

**検証:** プロジェクトは引き続きコンパイルでき、`dotnet ef migrations has-pending-model-changes` は、これから捕捉しようとしている保留中の変更(削除されたシード)を報告します。

### 4. 削除マイグレーションを生成してレビューする

```bash
# .NET 11, EF Core 11
dotnet ef migrations add RemoveOrderStatusSeed
```

生成されたマイグレーションを開き、手順 2 での判断を適用します。選択肢 B を選んだ場合は、`Up` から `DeleteData` を、`Down` から対応する `InsertData` を削除します。モデルスナップショットの変更はそのまま残してください。それらは正しく、必要なものです。

**検証:** staging データベースに対して `dotnet ef migrations script` を実行し、SQL を読みます。行を保存するつもりだったなら、予期しない `DELETE FROM OrderStatuses` が生き残っていないことを確認してください。

### 5. staging に対して適用し、データが生き残ることを確認する

```bash
# .NET 11, EF Core 11
dotnet ef database update
```

その後、`UseAsyncSeeding` が実行されるようにアプリケーションを起動します。

**検証:** テーブルを照会します。参照行はちょうど 1 回だけ存在します。アプリケーションをもう一度起動し、重複が現れないことを確認します。これは存在チェックが機能していることの証明です。外部キーが行を参照している場合は、それらの関係が壊れていないことを確認してください。

## マイグレーション後のスモークテスト

出荷する前に、staging に対してこのチェックリストを実行してください。

- `dotnet build` が `PendingModelChangesWarning` なしで成功する。
- `dotnet ef migrations has-pending-model-changes` が保留中のものを何も報告しない。
- アプリケーションが async パス(`await context.Database.MigrateAsync()`)経由で起動し、シードされた行が 1 回存在する。
- 新しいデータベースに対する `dotnet ef database update` も正しくシードする(これはツールが呼ぶ同期版 `UseSeeding` を働かせる)。
- アプリケーションを再起動しても何も新しく挿入されない(べき等性が保たれる)。
- 古いシードキーを指していた外部キーの関係が引き続き解決する。
- どのテーブルもファントムマイグレーションの症状を示さない: 新しいマイグレーションを追加してもシード関連の `InsertData`/`DeleteData` が生成されない。

## ロールバック計画

このマイグレーションは可逆ですが、細かい文字も読んでください。選択肢 B(手で `DeleteData` を取り除いた)を選んだ場合、スキーマレベルの `Down` はデータに対して何もしないため、マイグレーションをロールバックしても行はそのまま残り、モデルスナップショットが復元されるだけです。`HasData` ブロックを再追加して新しいマイグレーションを生成すれば旧世界に戻りますが、EF は不足している行を `InsertData` しようとします。

選択肢 A(削除と再シードを起こさせた)を選んだ場合、ロールバックはより危険です。行は今やデータベース生成のキーを持つため、固定キーを期待する `HasData` モデルへ戻すと不一致になります。その場合、ライブデータのインプレースロールバックを試みてはいけません。事前チェックの手順で取ったバックアップから復元してください。だからこそ事前バックアップは任意ではないのです。

## 私たちがはまった落とし穴

- **削除が外部キー経由でカスケードした。** `Order` テーブルが `OrderStatus.Id` を参照していました。削除マイグレーションの `DeleteData` が `FOREIGN KEY constraint failed` を発生させました。これは少なくとも大きな音を立てて失敗します。もし関係がカスケード削除で構成されていたら、注文を静かに道連れにしていたでしょう。選択肢 B(`DeleteData` を編集して取り除く)が修正です。削除が伝播する仕組みについては [FOREIGN KEY constraint failed の修正](/ja/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)を参照してください。
- **async オーバーロードだけを実装したので、`dotnet ef database update` が何もシードしなかった。** ツールは同期版の `UseSeeding` を呼びます。アプリは本番(async 起動パス)では動きましたが、CI の `database update` は空のルックアップテーブルを生み、統合テストが失敗しました。常に両方を実装してください。
- **存在チェックがキーではなく `DateTime` を照会していた。** 誰かがガードを `if (!context.Set<User>().Any(u => u.CreatedAt == seedTime))` と書きました。`CreatedAt` は `DateTime.UtcNow` だったため、チェックは決して一致せず、シーダーは起動のたびに新しい管理者を挿入しました。ガードは安定した自然キー(メール、ステータス名)で行い、非決定的な列では決して行わないでください。完全なパターンは [UseSeeding と UseAsyncSeeding でデータをシードする方法](/ja/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)にあります。
- **各インスタンスの起動時のシードが、あらゆる場所で書き込み権限を必要とした。** `UseSeeding` は各レプリカの `Migrate` で実行されます。本番アプリの Pod がほぼ読み取り専用のデータベース権限で動いている場合、シードのコールバックは例外を投げます。本番では、起動のたびのシードよりも、デプロイ時の 1 回限りの初期化ステップを選んでください。`UseSeeding` はローカル開発とテストで真価を発揮します。
- **部分的な移行が、他のシードが依存していた `HasData` の行を残した。** シードの半分を移した結果、起動コールバックの挿入が、削除マイグレーションがちょうど削除したルックアップ行を参照しました。依存するシードは一緒に移すか、ルックアップを `HasData` に残して依存データだけを移してください。

エンティティが record であっても、これらは何も変わりません: [record は EF Core 11 で正しく動作します](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)。`HasData` でも `UseSeeding` でも同じです。そしてついでにデータ層を引き締めているなら、同じ「何がいつ実行されるか」の規律が [監査のための EF Core 11 インターセプター](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)にも現れます。

## 関連記事

- [EF Core 11 でデータをシードする際の HasData と UseSeeding](/ja/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/)
- [EF Core 11 で UseSeeding と UseAsyncSeeding を使ってデータをシードする方法](/ja/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [EF Core 6 から EF Core 11 への移行: 本当に噛みつく破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix: EF Core 11 でエンティティを削除する際の FOREIGN KEY constraint failed](/ja/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [EF Core 11 で record を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## 出典

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
