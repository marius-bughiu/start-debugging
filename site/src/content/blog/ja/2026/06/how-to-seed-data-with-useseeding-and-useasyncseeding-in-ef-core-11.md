---
title: "EF Core 11 で UseSeeding と UseAsyncSeeding を使ってデータをシードする方法"
description: "EF Core 11 で UseSeeding と UseAsyncSeeding を使って参照データを正しくシードします。どこで設定するか、いつ実行されるか、省略できない冪等性チェック、そしてなぜ両方を実装する必要があるのかを解説します。"
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "ja"
translationOf: "2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

EF Core 11 でデータをシードするには、`DbContextOptionsBuilder` に `UseSeeding` と `UseAsyncSeeding` を設定し、各コールバックの先頭に存在チェックを書いて行が欠けているときだけ挿入が走るようにし、`EnsureCreated`/`EnsureCreatedAsync`、`Migrate`/`MigrateAsync`、または `dotnet ef database update` を呼び出してトリガーします。コールバックはこれらの操作のたびに、たとえマイグレーションが適用されていなくても実行されるため、重複挿入から守ってくれるのが存在チェックです。EF Core のツールは同期版しか呼び出さないので、同期と非同期の両方のオーバーロードを同じロジックで実装してください。この記事では .NET 11、EF Core 11（`Microsoft.EntityFrameworkCore` 11.0）、C# 14 を使用します。

`UseSeeding` と `UseAsyncSeeding` は EF Core 9 で登場し、EF Core 11 で推奨される汎用のシード手段です。これらは何でも `HasData` に押し込む古い習慣を置き換えます。EF チームはその後 `HasData` を「model managed data」に改名しましたが、それはまさに、ほとんどのアプリケーションが実際にシードしたい動的でデータベースに依存するデータのために `HasData` が設計されたものではなかったからです。

## なぜ UseSeeding が存在するのか

長年、「データベースに初期データをどう入れるか」への答えは `HasData` でした。これは機能しますが、データが固定のルックアップテーブル以外の何かになった途端に刺さる鋭いエッジを持っています。`HasData` はモデルに焼き込まれています。EF はマイグレーションのスナップショット内のデータを比較して挿入・更新・削除を計算するため、すべての主キーを手書きで指定する必要があり、データベースが生成するキーは使えず、決定論的でない値（`DateTime.UtcNow`、`Guid.NewGuid()`、ハッシュ化されたパスワード）はビルドのたびにモデルを「変更された」ように見せます。この最後のケースは、[EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)中に人々を驚かせる `PendingModelChangesWarning` のよくある原因です。

`UseSeeding` は、ライブの `DbContext` に対して実行される普通のアプリケーションコードです。クエリし、分岐し、必要なら外部 API を呼び出し、`SaveChanges` を呼び出します。モデルのスナップショットも、キーの差分計算も、決定論性の要件もありません。シードデータが次のいずれかである場合は、これが正しいツールです。テスト用のフィクスチャ、データベースに既にあるものに依存するデータ、マイグレーションのスナップショットに取り込みたくない大きな blob、キーがデータベースで生成される行、あるいはパスワードのハッシュ化のような変換を要するもの。公式ガイダンスははっきりと述べています。`UseSeeding` と `UseAsyncSeeding` は EF Core での推奨されるシード方法であり、`HasData` は国コードや郵便番号のような本当に静的な参照データのために予約されました。

## コールバックをどこで設定するか

これらのメソッドは `DbContextOptionsBuilder` にぶら下がっているので、オプションを構築する場所ならどこにでも置けます。一般的な場所は 2 つ、コンテキスト自体の `OnConfiguring` と、`Program.cs` の `AddDbContext` 登録です。

コンテキストクラスからそのまま使う `OnConfiguring` 形式は次のとおりです。

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            var admin = context.Set<Role>().FirstOrDefault(r => r.Name == "Admin");
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, cancellationToken) =>
        {
            var admin = await context.Set<Role>()
                .FirstOrDefaultAsync(r => r.Name == "Admin", cancellationToken);
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                await context.SaveChangesAsync(cancellationToken);
            }
        });
```

コールバックに渡される `context` は完全に機能する `DbContext` なので、`context.Set<T>()` はどこでも使っているのと同じクエリと追跡のインターフェースを提供します。破棄されるパラメーター `_` は、この操作中に EF がデータベースを作成したかどうかを伝える `bool` です。ほとんどのシーダーはこれを無視します。

典型的な ASP.NET Core アプリケーションでは、依存性注入の登録時に同じものを設定します。シグネチャは同一で、ホストだけが異なる点に注目してください。

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedRoles(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedRolesAsync(context, ct)));
```

本体を名前付きメソッド（`SeedRoles`、`SeedRolesAsync`）に切り出すと、登録が読みやすくなり、すべてのシードロジックが存在する明確な場所が得られます。これがこの機能の狙いの大きな部分でした。

## コールバックが実際にいつ実行されるか

これは人々がつまずく細部なので、正確に述べておく価値があります。シードのコールバックは次の一部として呼び出されます。

- `context.Database.EnsureCreated()` は `UseSeeding` を呼び出します。
- `context.Database.EnsureCreatedAsync()` は `UseAsyncSeeding` を呼び出します。
- `context.Database.Migrate()` と `MigrateAsync()` がこれらを呼び出します。
- `dotnet ef database update` がこれらを呼び出します。

重要なのは、これらがそれらの操作の**毎回**の呼び出しで実行されることです。モデルの変更がなく、マイグレーションが一切適用されなかったときでもです。既に最新のデータベースに対して `Migrate()` を呼んでも、シードのコールバックは依然として発火します。これは意図的なもので、肝に銘じるべき最も重要なことです。フレームワークは前回シードしたことを覚えていてあなたをスキップしたりはしません。何かすべきことがあるかを判断する責任は、あなたのコールバックにあります。

だからこそ上のどの例もクエリで始まります。形は常に同じです。行を探し、欠けている場合だけ挿入します。チェックを省くと、`Migrate` を呼び出す起動のたびに "Admin" を挿入することになり、1 週間も経てば重複した管理者ロールでいっぱいのテーブルができあがります。

## 冪等性チェックは省略可能ではない

コールバックは再実行されるので、シードロジックは冪等でなければなりません。1 回実行しても 10 回実行しても、データベースを同じ状態にしなければなりません。例の `FirstOrDefault`/`if (x is null)` ガードは最小限の形です。行のバッチに対しては、既にある集合をクエリし、差分だけを挿入します。

```csharp
// .NET 11, EF Core 11, C# 14 -- idempotent batch seed
static void SeedRoles(DbContext context)
{
    string[] required = ["Admin", "Editor", "Viewer"];

    var existing = context.Set<Role>()
        .Where(r => required.Contains(r.Name))
        .Select(r => r.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new Role { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<Role>().AddRange(missing);
        context.SaveChanges();
    }
}
```

存在するものを読むための 1 往復、新しいものだけを書くための 1 往復、そしてテーブルが完全に埋まれば何も起こりません。この最後の性質が重要です。起動のたびに、たとえ何もしない `SaveChanges` でも発行するシーダーは無駄であり、ログをノイズで埋めます。先に差分を計算し、`missing.Count > 0` のときだけ書き込んでください。

一意インデックスと握りつぶした例外を「冪等性」として頼りにしないでください。それは最初以降の起動のたびに捕捉された `DbUpdateException` に変わり、遅く、ログを汚し、本当の失敗を隠します。先にクエリしてください。

## なぜ両方のオーバーロードを実装する必要があるのか

ドキュメントの注記は読み飛ばしやすく、無視すると高くつきます。EF Core のツールは現在**同期**の `UseSeeding` メソッドに依存しており、`UseAsyncSeeding` だけを実装した場合は正しくシードしません。したがって `dotnet ef database update` を実行すると、アプリケーションのコードがどれほど非同期であっても、発火するのは同期のコールバックです。

逆もまた然りです。アプリケーションが `await context.Database.MigrateAsync()`（慣用的な非同期起動）で起動する場合、その経路は `UseSeeding` ではなく `UseAsyncSeeding` を呼び出します。同期版だけを実装すると、CLI 経由のシードは動くのにアプリケーション自身の起動時のシードは黙って何もしない、あるいはその逆になります。

安全なルールはこうです。両方を、同一のロジックで実装してください。本体を共有メソッドに切り出して、2 つのコールバックがずれないようにします。

```csharp
// .NET 11, EF Core 11, C# 14
options
    .UseSeeding((context, _) => SeedRoles(context))
    .UseAsyncSeeding((context, _, ct) => SeedRolesAsync(context, ct));

// sync and async bodies kept in lockstep
static void SeedRoles(DbContext context) { /* query, branch, SaveChanges */ }

static async Task SeedRolesAsync(DbContext context, CancellationToken ct)
{
    // same query, same branch, SaveChangesAsync(ct)
}
```

一方をもう一方のブロッキングで実装する誘惑（同期コールバック内での `SeedRolesAsync(context, ct).GetAwaiter().GetResult()`、あるいは非同期内で同期本体を `Task.Run` で囲む）には抗ってください。sync-over-async は一部の同期コンテキストでデッドロックを招き、async-over-sync は非同期であると偽るだけです。2 つの本体を書き出してください。どちらも短いものです。

## 並行性は対処済み、ただしシード本体に限る

本当に嬉しい性質があります。`UseSeeding` と `UseAsyncSeeding` の中のコードは、EF Core のマイグレーションのロック機構によって保護されています。アプリケーションの 2 つのインスタンスが同じ瞬間に起動して両方が `Migrate` を呼び出すと、ロックがそれらを直列化するので、両方が存在チェックをすり抜けて二重挿入することはありません。これは、その協調を自分で作らなければならない手書きの起動時シードに対する、実質的な利点です。

この保護はシードのコールバックに限って及びます。アプリケーション全体を単一ライターのシステムに変えるわけではなく、シードの経路の外で書き込むデータを保護するわけでもありません。これはまさにその通りのものとして扱ってください。シードのステップを多数のインスタンスから並行して実行しても安全にするためのガードです。

## UseSeeding が誤った選択になるとき

`UseSeeding` はあらゆる釘に使うハンマーではありません。2 つのケースがあなたを別の場所へ押しやります。

第一に、スキーマのマイグレーション以外では決して変わらない本当に静的な参照データ -- 典型例は郵便番号や ISO 国コードのテーブル -- は、依然として `HasData` のほうが適しています。マイグレーションとともに移動し、スキーマと並んでバージョン管理され、起動のたびの実行時クエリを必要としません。データが固定で、決定論的で、小さく、それがマイグレーションに所有されてよいなら、`HasData` を使ってください。

第二に、1 つのトランザクション内で 2 つの異なる `DbContext` インスタンスを必要とするシードは、1 つのコンテキストを受け取る単一の `UseSeeding` コールバックでは綺麗に表現できません。そのためにドキュメントは、普通のカスタム初期化ロジックへ戻るよう案内しています。コンテキストを自分で開き、作業を実行し、そして何より、並行性の問題に当たらず、稼働中のアプリケーションにスキーマを変更する権限を要求しないよう、通常のリクエスト経路の外に保ってください。

```csharp
// .NET 11, EF Core 11 -- custom initialization, run once at deploy time
await using var context = new AppDbContext();
await context.Database.MigrateAsync();

if (!await context.Roles.AnyAsync())
{
    context.Roles.AddRange(new Role { Name = "Admin" }, new Role { Name = "Viewer" });
    await context.SaveChangesAsync();
}
```

ドキュメントの警告は繰り返す価値があります。シードは一般に、通常のアプリケーション実行の一部であるべきではありません。各インスタンスの起動時にそれを実行することは、各インスタンスに書き込み権限が必要であり、正しさをロックに頼っていることを意味します。本番では、デプロイ時の専用の一度きりの初期化ステップのほうが綺麗です。`UseSeeding` は、ローカル開発、テスト、そして起動ごとのクエリが安価な、小さく冪等な参照データの類いで輝きます。

## まとめ

メンタルモデルは短いものです。`UseSeeding` と `UseAsyncSeeding` は、EF Core が `EnsureCreated`、`Migrate`、`dotnet ef database update` で呼び出すアプリケーションコードです。毎回実行されるので、最初の行は常に存在チェックであり、書き込みは欠けている行に対してだけ起こります。ツールと非同期の起動経路がそれぞれ別のものを呼び出すため、両方のオーバーロードを実装します。シード本体はロックで保護されているので、並行する起動が衝突しません。そして `HasData` は、静的で決定論的でマイグレーションに所有される参照データという狭いケースのために、依然として存在します。

EF Core 11 のデータ層の残りを引き締めているなら、何がいつ実行されるかについての同じ注意は他の場所にも現れます。[EF Core 11 のインターセプターが監査を扱う](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)方法を `SaveChanges` のチョークポイントで見て、一括書き込みで[エンティティを読み込んで SaveChanges を呼ぶより ExecuteUpdate を選ぶ](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)のはいつか、そして読み取りの多いクエリで[AsNoTracking と AsNoTrackingWithIdentityResolution](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)がなぜ重要かを確認してください。シードの挿入が[エンティティ型には主キーの定義が必要](/ja/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/)につまずくなら、それはシーダーが実行される前に直すべきモデリングの問題です。

出典: Microsoft Learn の EF Core の[データシードのドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)は、`UseSeeding`/`UseAsyncSeeding` の API、実行のタイミング、両方のオーバーロードの要件、マイグレーションのロックの保証を扱っています。API リファレンスの [DbContextOptionsBuilder.UseSeeding](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding) は正確なシグネチャを記載しています。
