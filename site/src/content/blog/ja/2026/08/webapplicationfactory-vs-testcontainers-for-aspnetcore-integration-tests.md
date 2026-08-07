---
title: "ASP.NET Core の統合テストにおける WebApplicationFactory と Testcontainers の比較"
description: "両者は選択肢の関係にありません。WebApplicationFactory はアプリケーションを起動し、Testcontainers はその依存先を起動します。.NET SDK 10.0.201 で計測した結果、コンテナーを持つフィクスチャはクラスあたり 1.7 秒、SQLite なら 10 ミリ秒。そして Postgres が 22001 で拒否する HasMaxLength(16) 違反を、SQLite は黙って受け入れます。"
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "ja"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

両方を使ってください。`WebApplicationFactory<T>` はアプリケーションを起動し、Testcontainers はアプリケーションが通信する相手を起動します。実際に決める必要があるのはデータ層の裏側に何を置くかだけで、答えはこうです。テストがデータベースの強制する何かを検証するなら、コンテナー内の本物のデータベースが必要です。ルーティング、モデルバインディング、認可、JSON の形を検証するだけなら、Docker を省いて 1.7 秒ではなく 10 ミリ秒を払ってください。

以下の計測はすべて .NET SDK 10.0.201 上で、`Microsoft.AspNetCore.Mvc.Testing` 10.0.1、`Testcontainers.PostgreSql` 4.13.0、EF Core 10.0.1、`postgres:17.6-alpine` を用い、Docker Desktop 29.5.3 (WSL2 バックエンド、CPU 20 個を割り当て) 上、Intel Core Ultra 7 265KF、メモリ 32 GB、Windows 11 26200 で行いました。これらの API は .NET 11 プレビューでも変わっていません。

## 実際に議論されている 3 つの構成

「WebApplicationFactory と Testcontainers のどちらか」という問いの立て方は適切ではありません。両者は異なるレイヤーに属しているからです。実際に選ばれているのは、次の 3 つの構成のいずれかです。

| | A. WAF + プロセス内の代替実装 | B. WAF + Testcontainers | C. すべて Testcontainers |
| --- | --- | --- | --- |
| アプリの実行場所 | テストプロセス内 | テストプロセス内 | 自分でビルドしたコンテナー内 |
| トランスポート | `TestServer`、ソケットなし | `TestServer`、ソケットなし | 本物のソケット、本物の Kestrel |
| データベース | SQLite / インメモリ / モック | コンテナー内の本物のエンジン | コンテナー内の本物のエンジン |
| Docker が必要か | 不要 | 必要 | 必要 |
| フィクスチャのコスト (実測) | 約 10 ミリ秒 | 約 1.7 秒 | 約 1.7 秒 + イメージのビルド |
| アプリのコードにブレークポイントを置けるか | 可能 | 可能 | 不可 |
| サービスを代替実装に差し替えられるか | 可能 | 可能 | 不可 |
| Dockerfile や entrypoint を検証できるか | 不可 | 不可 | 可能 |
| HTTPS、HTTP/2、Kestrel の上限を検証できるか | 不可 | 不可 | 可能 |
| データベースの制約違反を検出できるか | 不可 (後述) | 可能 | 可能 |

A と B は接続文字列が違うだけの同じコードです。C は本質的に別物で、「どちらか」という選択が実際に成立する唯一の行でもあります。C では `ConfigureTestServices` が完全に使えなくなるからです。アプリケーションは封をされた成果物になり、HTTP 経由でしか話しかけられません。

ほとんどのチームが求めているのは B ですが、Docker が遅く感じられたという理由で A に流れ、C を真剣に検討することはありません。以下の数値が示すのは、A はあなたが高いと思っているほど安く、B もあなたが思うより安く、そして B を選ぶ理由はパフォーマンスとはまったく関係がない、ということです。

## 計測

テスト対象は、EF Core 経由で書き込む `POST /orders` と読み戻す `GET /orders` を持つ minimal API です。`Order.Sku` には `HasMaxLength(16)` と一意インデックスを設定しています。計測用のコードは構成ごとに同一プロセス内でファクトリーを 3 回新しく起動するので、ラウンド 1 には JIT と EF のモデル構築が含まれ、ラウンド 2 と 3 が定常状態を表します。

```csharp
// .NET 10.0.201, C# 14, Mvc.Testing 10.0.1, Testcontainers.PostgreSql 4.13.0
var sw = Stopwatch.StartNew();
var pg = new PostgreSqlBuilder("postgres:17.6-alpine").Build();
await pg.StartAsync();
var containerStart = sw.ElapsedMilliseconds;

sw.Restart();
await using var factory = new PostgresFactory(pg.GetConnectionString());
var client = factory.CreateClient();
var boot = sw.ElapsedMilliseconds;
```

構成 A、SQLite のインメモリ接続の上に載せた `WebApplicationFactory<T>`、Docker なし:

| ラウンド | ファクトリー起動 | スキーマ作成 | 最初のリクエスト | 書き込み 100 回 | 読み取り 100 回 |
| --- | --- | --- | --- | --- | --- |
| 1 | 129 ミリ秒 | 309 ミリ秒 | 64 ミリ秒 | 205 ミリ秒 | 193 ミリ秒 |
| 2 | 11 ミリ秒 | 2 ミリ秒 | 4 ミリ秒 | 49 ミリ秒 | 70 ミリ秒 |
| 3 | 4 ミリ秒 | 7 ミリ秒 | 3 ミリ秒 | 49 ミリ秒 | 67 ミリ秒 |

構成 B、同じファクトリーを Testcontainers で起動した PostgreSQL インスタンスに向けたもの。イメージは取得済みです:

| ラウンド | コンテナー起動 | ファクトリー起動 | スキーマ作成 | 最初のリクエスト | 書き込み 100 回 | 読み取り 100 回 | 停止 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2933 ミリ秒 | 5 ミリ秒 | 198 ミリ秒 | 4 ミリ秒 | 210 ミリ秒 | 191 ミリ秒 | 321 ミリ秒 |
| 2 | 1403 ミリ秒 | 5 ミリ秒 | 42 ミリ秒 | 6 ミリ秒 | 131 ミリ秒 | 197 ミリ秒 | 300 ミリ秒 |
| 3 | 1424 ミリ秒 | 4 ミリ秒 | 32 ミリ秒 | 5 ミリ秒 | 81 ミリ秒 | 81 ミリ秒 | 306 ミリ秒 |

ここから、通説に反する 2 つのことが読み取れます。

**ファクトリー自体はどちらの構成でもコストがゼロに近い。** プロセスが温まったあとの `WebApplicationFactory<T>` の起動は、背後のデータベースが何であっても 4 から 5 ミリ秒です。「統合テストは遅い」と言われるとき、その対象が `TestServer` であることはまずありません。

**リクエストあたりのコストはほぼ同じ。** ミドルウェアのパイプライン全体、モデルバインディング、EF Core を通って戻ってくる往復を 100 回行うと、定常状態で SQLite が 49 ミリ秒、コンテナー内の Postgres が 81 ミリ秒です。WSL2 へのループバックソケット越しで、リクエストあたり 0.3 ミリ秒の差にすぎません。テストスイートを遅くしているのは、データベースが本物であることではありません。

高くつくのはフィクスチャです。コンテナーの起動と停止でフィクスチャあたり約 1.7 秒、プロセス内の選択肢では約 10 ミリ秒。これに、それぞれが自前のコンテナーを持つテストクラスの数を掛ければ答えが出ます。コンテナーを持つフィクスチャが 40 個あるスイートは、Postgres を起動しては停止するだけで 68 秒を費やします。

コールドスタートのコストは別に述べる価値があります。最初の CI 実行が払うのはこちらだからです。`postgres:17.6-alpine` をゼロから取得するのに、106 MB のイメージで 11.3 秒かかりました。これは安いほうの端です。SQL Server の開発者向けイメージは 1 桁以上大きく、だからこそ [SQL Server と Testcontainers のガイド](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) は CI でそのレイヤーをキャッシュする話に 1 節を割いています。

## 決め手になる結果

判断の軸はパフォーマンスではありません。こちらです:

```csharp
// .NET 10.0.201, EF Core 10.0.1
// Order.Sku is configured HasMaxLength(16)
db.Orders.Add(new Order { Sku = "TOOLONGSKU-0123456789", Total = 1m });
await db.SaveChangesAsync();
```

コンテナーに対して:

```
postgres: 22001: value too long for type character varying(16)
```

インメモリの SQLite に対して:

```
sqlite:   ACCEPTED, stored 21 chars
```

SQLite には `varchar` の長さの強制がありません。EF Core は `HasMaxLength(16)` を持つ文字列に対して忠実に `TEXT` を出力し、SQLite は 21 文字すべてを文句なく保存し、検証が機能することを証明するはずだったテストは成功します。本番環境では同じ書き込みが例外を投げます。この 1 つの相違がすべての論拠であり、しかも一般化します。SQLite は小数の精度、識別子の大文字小文字の区別、`DateTime` の精度、同時書き込みの挙動、そしてあなたが今後書くことになるほぼすべての `FromSql` クエリにおいて、Postgres や SQL Server と異なります。EF Core のインメモリプロバイダーはさらに悪く、リレーショナルなセマンティクスをまったく強制しません。

したがってルールは「常に Testcontainers を使え」でも「Testcontainers は遅すぎる」でもありません。こうです。**テストの検証内容がデータベースエンジンの強制する何かに依存した瞬間、偽物のデータベースはそのテストを嘘に変えます。** 制約違反、カスケード削除、`rowversion` の同時実行トークン ([rowversion トークンによる楽観的同時実行制御](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) を参照)、生の SQL、マイグレーション、そしてクエリトランスレーターに触れるものはすべて構成 B に属します。

## それぞれをいつ選ぶか

**構成 A (WAF、Docker なし) を選ぶのは**、テストが HTTP の表面に関するものであるときです。`/orders/{id:int}` は `abc` を 400 で拒否しますか。`[Authorize(Policy = "Admin")]` 属性は管理者でない相手に 403 を返しますか。レスポンスは `total` を文字列ではなく数値としてシリアライズしますか。例外ハンドラーは `ProblemDetails` の本文を生成しますか。これらはいずれもデータベースが本物かどうかを気にしませんし、そもそもデータベースを必要としないものも多くあります。`ConfigureTestServices` でスタブのリポジトリを登録し、永続化を丸ごと省いてください。これらはキーを打つたびに実行したいテストであり、準備が 10 ミリ秒ならそれが可能です。

**構成 B (WAF + Testcontainers) を選ぶのは**、検証がストレージエンジンまで届くときです。リポジトリのテスト、EF Core のクエリのテスト、マイグレーションの検証、そして興味深い挙動がデータベースのエラー経路であるようなエンドポイントについては、これが既定の選択になります。マイグレーションが空のデータベースに実際に適用できることを検証する唯一の誠実な方法でもあります。これはどんな代替実装も捕まえられず、しかも本番を止める種類の障害です。

**構成 C (完全にコンテナー化) を選ぶのは**、成果物そのものがテスト対象であるときです。Dockerfile が実行可能なイメージをビルドすること、entrypoint が Helm チャートの設定する環境変数を読むこと、TLS が正しく終端されること、HTTP/2 のネゴシエーションが動くことを検証する場合です。`TestServer` はソケットを一度も開かないので、これらについて何も教えてくれません。C はパイプラインの最後に置くひとにぎりのスモークテストであって、テスト戦略ではありません。

## B を安くする: 再利用

フィクスチャあたり 1.7 秒は固定費ではありません。Testcontainers は以前からコンテナーの再利用に対応しており、ローカル開発中はフィクスチャのコストを誤差の範囲に変えてくれます:

```csharp
// Testcontainers 4.13.0
var pg = new PostgreSqlBuilder("postgres:17.6-alpine")
    .WithReuse(true)
    .Build();
await pg.StartAsync();
// deliberately not disposed: reuse keeps the container alive between runs
```

同一プロセス内で連続して 3 回起動した計測結果:

| 起動 | 所要時間 | コンテナー ID |
| --- | --- | --- |
| 1 | 1812 ミリ秒 | `81ae62b0f2b4` |
| 2 | 103 ミリ秒 | `81ae62b0f2b4` |
| 3 | 81 ミリ秒 | `81ae62b0f2b4` |

同じコンテナーで、1812 ミリ秒ではなく 81 ミリ秒です。再利用はコンテナー構成のハッシュで照合されるので、イメージのタグ、環境、ポートマッピングを変えれば正しく新しいコンテナーが作られます。

注意点はクリーンアップです。Testcontainers のドキュメントは、再利用を有効にすると resource reaper が無効になると明記しています。つまり Ryuk はコンテナーを削除してくれませんし、再利用可能なコンテナーに対する `DisposeAsync()` は削除ではなく停止を行います。先週のスキーマを抱えた古いコンテナーは、手で削除するまで平然とテストに応答し続けます。この実行間で状態が残る性質こそ、再利用を CI ではなくローカル開発向けの最適化にしている理由です。環境変数のチェックで囲み、パイプラインが常にきれいなエンジンを受け取るようにしてください。

なお Java の実装とは異なり、.NET 版の Testcontainers は `~/.testcontainers.properties` での有効化を必要としません。`WithReuse(true)` だけで十分であり、便利である一方、だからこそ制御は自分の責任になります。

CI でより効くもう 1 つの手は、クラスごとに 1 つではなく、多数のテストクラスで 1 つのコンテナーを共有することです。xUnit では `IClassFixture<T>` ではなく collection fixture または assembly fixture がこれにあたります。フレームワークごとの違いは [xUnit v3、NUnit、MSTest の比較](/ja/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) で扱っています。コンテナーは共有し、データは分離してください。共有サーバー上でテストクラスごとに専用のスキーマまたはデータベースを与えるか、テストの合間に truncate でリセットします。

## 組み立てるときに遭遇する 3 つのエラー

いずれも、この記事の計測用コードを現行のパッケージバージョンで組み立てる過程で実際に出たものです。

**`Solution root could not be located using application root`。** `WebApplicationFactory<T>` は、`Microsoft.AspNetCore.Mvc.Testing` の MSBuild ターゲットがテストアセンブリに `WebApplicationFactoryContentRootAttribute` を刻んでいない限り、テストアセンブリからディレクトリツリーを遡って `.sln` または `.slnx` ファイルを探すことでアプリの content root を特定します。ソリューションファイルに属していないテストプロジェクトは、`dotnet run app.cs` 時代のレイアウトでますます一般的になっていますが、最初の `CreateClient()` で失敗します。プロジェクトをソリューションに追加するか、`CreateHost` をオーバーライドして content root を明示的に設定してください。

**`Services for database providers 'Npgsql.EntityFrameworkCore.PostgreSQL', 'Microsoft.EntityFrameworkCore.Sqlite' have been registered in the service provider. Only a single database provider can be registered in a service provider.`** これは `DbContext` を差し替える際の典型的な失敗で、Stack Overflow で見つかる助言は古くなっています。EF Core 9 以降の `AddDbContext` は、本番のプロバイダーを保持したままの `IDbContextOptionsConfiguration<TContext>` も登録するため、`DbContextOptions<TContext>` を削除するだけでは足りません。3 つとも削除してください:

```csharp
// .NET 10.0.201, EF Core 10.0.1
protected override void ConfigureWebHost(IWebHostBuilder builder)
{
    builder.ConfigureTestServices(services =>
    {
        services.RemoveAll(typeof(IDbContextOptionsConfiguration<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions));
        services.AddDbContext<OrdersDbContext>(o => o.UseNpgsql(_connectionString));
    });
}
```

`Program.cs` が自分の管理下にあるなら、より筋のよい代替案は、差し替えるつもりのプロバイダーを最初から登録しないことです。接続文字列を構成から読み、テスト用のファクトリーが `ConfigureAppConfiguration` でそれを供給するようにします。そうすれば削除するものは何もありません。

**`'PostgreSqlBuilder.PostgreSqlBuilder()' is obsolete`。** Testcontainers 4.13.0 以降、モジュールのパラメーターなしビルダーは非推奨となり、イメージはコンストラクターに渡す必要があります: `new PostgreSqlBuilder("postgres:17.6-alpine")`。これはモジュールがメンテナーの選んだタグを既定値にするのをやめた 4.10 の変更の締めくくりです。現在は警告で、いずれエラーになりますが、正しい判断です。イメージのタグが浮動していると、昨日通った CI パイプラインが、あなたのコミットとは無関係な理由で今日落ちる可能性があるからです。

## 私ならこうする

既定は、呼び出しスタックにリポジトリが登場するものはすべて構成 B、それ以外は構成 A です。具体的には、アセンブリごとに共有コンテナーを 1 つ、ローカルでは `WithReuse(true)`、クラスごとのコンテナーではなくテスト間の truncate によるリセット、そして HTTP の表面を扱うテスト用に Docker 依存のない高速なテストプロジェクトを別に用意し、そのプロジェクトの `dotnet test` が 1 秒を切り続けるようにします。

SQLite やインメモリプロバイダーを本番エンジンの代用にしてはいけません。データベースが検証内容にとって本当に付随的である場合にだけ使い、その時点で自分が書いているのは「永続化層が存在する必要があるだけの HTTP テスト」だと正直に認めてください。100 リクエストあたり 30 ミリ秒の節約は、本番なら赤になるはずの緑のテストに見合いません。それでも代替実装が欲しいなら、[変更追跡を壊さずに `DbContext` をモックする](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) ほうが、異なる SQL 方言よりも誠実な代替実装です。

そして構成 C は控えめに使ってください。これは B の上位版ではなく別個の能力です。コードではなく成果物を検証するものなので、置き場所は開発者が push 前に走らせるスイートではなく、デプロイのスモークテストの隣です。

## 関連記事

- ファクトリー自体の仕組み全般、`ConfigureTestServices` と `ConfigureWebHost` の違いや認証の偽装を含みます: [ASP.NET Core 11 で `WebApplicationFactory<T>` を使う統合テスト](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)。
- コンテナー側の詳細、`IAsyncLifetime`、マイグレーション、Ryuk まで: [Testcontainers で本物の SQL Server に対して統合テストを書く](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)。
- フィクスチャの共有、並列実行の既定値、ライフサイクルはフレームワークごとに異なります: [2026 年の xUnit v3、NUnit、MSTest 比較](/ja/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)。
- 信頼できないテストのもう 1 つのよくある原因: [`TimeProvider` と `FakeTimeProvider` で時刻に依存するコードをテストする](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)。
- 偽物のデータベースでは再現できない同時実行の挙動: [EF Core 11 での `rowversion` トークンによる楽観的同時実行制御](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)。

## 参考資料

- [ASP.NET Core の統合テスト](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests): `WebApplicationFactory<TEntryPoint>` と content root 属性について
- EF Core ドキュメントの [テスト戦略の選択](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy): インメモリプロバイダーがデータベースではない理由について
- [Testcontainers for .NET](https://dotnet.testcontainers.org/) のドキュメントと [4.10.0 から 4.13.0 までのリリース](https://github.com/testcontainers/testcontainers-dotnet/releases): イメージの明示的な固定の必須化と再利用ハッシュの API が導入されました
- [Testcontainers のコンテナー再利用に関する議論](https://github.com/testcontainers/testcontainers-dotnet/discussions/1470): 非推奨となったパラメーターなしビルダーについて
- NuGet のパッケージバージョン: [Microsoft.AspNetCore.Mvc.Testing 10.0.1](https://www.nuget.org/packages/Microsoft.AspNetCore.Mvc.Testing)、[Testcontainers.PostgreSql 4.13.0](https://www.nuget.org/packages/Testcontainers.PostgreSql)
