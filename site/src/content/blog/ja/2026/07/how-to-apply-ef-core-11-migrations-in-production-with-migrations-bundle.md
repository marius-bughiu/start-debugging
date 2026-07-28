---
title: "dotnet ef migrations bundle で EF Core 11 のマイグレーションを本番に適用する方法"
description: "EF Core 11 のスキーマ変更をマイグレーション bundle でデプロイするための完全ガイドです。CI での efbundle のビルド、名前付き接続文字列における appsettings.json の落とし穴、self-contained bundle と Alpine の musl RID、EF Core 9 以降のマイグレーションロック、対象マイグレーションを指定したロールバック、そして MySQL ではマイグレーション単位のトランザクションが助けにならない理由を解説します。"
pubDate: 2026-07-28
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
  - "devops"
lang: "ja"
translationOf: "2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle"
translatedBy: "claude"
translationDate: 2026-07-28
---

EF Core 11 のマイグレーションを本番データベースに適用するには、CI で `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle` を実行してマイグレーション bundle をビルドし、その単一の実行ファイルをビルド成果物として公開し、`./efbundle --connection "$CONNECTION_STRING"` で独立したデプロイ手順として実行します。bundle はコンパイル済みのマイグレーションと EF Core のランタイムを 1 つのファイルに収めています。実行するマシンに .NET SDK も `dotnet-ef` ツールもソースコードへのアクセスも不要で、アプリケーション側にデータベースのスキーマ変更権限を持たせる必要もありません。この記事は EF Core 11 と .NET 11 (執筆時点では preview 6、GA は 2026 年 11 月) および C# 14 を対象としています。bundle は EF Core 6 から存在するため、ここに書いたことは EF Core 6 から 11 まで動作し、挙動が変わる下限バージョンはその都度示します。

## 他の 3 つの戦略の何が本当に問題なのか

どの .NET チームも、スキーマ変更を本番に届ける方法を 4 つのうち 1 つから選ぶことになりますが、そのうち 3 つには負荷がかかったときや切迫した状況でしか表面化しない失敗モードがあります。

**起動時に `Database.Migrate()` を呼ぶ方法**が最も頻繁に痛い目を見ます。Microsoft 自身のガイダンスがこれを本番には不適切だと述べており、理由は積み重なります。アプリケーションのプロセスがデプロイ時だけでなく常時 `db_ddladmin` 相当の権限を必要とすること、SQL を人間が確認しないままマイグレーションが走ること、そしてロールバックが新しいビルドの出荷を意味することです。EF Core 9 以降、少なくとも並行実行の危険は扱われるようになりました。`Migrate()` と `MigrateAsync()` は何かを適用する前にデータベース全体のロックを取得するため、10 個のレプリカが同時にロールアウトしても互いを壊さず直列化されます。これは最悪の症状を解消しましたが、構造的な問題は 1 つも解消していません。

**デプロイエージェント上で `dotnet ef database update` を実行する方法**は、そのエージェントに .NET SDK と `dotnet-ef` ツールをインストールし、ソースコードをチェックアウトし、`CREATE INDEX` を 1 つ適用するためだけにプロジェクトをビルドすることを意味します。そのエージェントが本番マシンなら、そこにコンパイラーを置いたことになります。

**SQL スクリプトを生成する方法** (`dotnet ef migrations script --idempotent`) は Microsoft が今も第一に推奨する戦略で、実際の利点があります。実行前に DBA が読めることです。代償として、それを実行するツールが別途必要になります。そして EF チームがドキュメントで述べているとおり、そうしたツールのトランザクション処理とエラー後の継続動作は一貫しておらず、時に予想外です。`sqlcmd` は 120 個中 40 個目のステートメントが失敗しても平然と先へ進み、どこで止まったかの記録も残さずスキーマを 2 つのマイグレーションの中間状態に置き去りにします。

bundle はこの種の問題を取り除きます。実行ファイルは `dotnet ef database update` と同じ EF Core のコードパスを通り、同じトランザクション意味論でマイグレーションを適用し、成功を報告するか、ゼロ以外の終了コードを返すかのどちらかです。

## 4 段階のパイプライン

デプロイ全体の形は次のとおりで、記事の残りはそれぞれの段階の詳細です。

1. **モデルとマイグレーションが一致していることを検証します。** CI で `dotnet ef migrations has-pending-model-changes` を実行します。誰かがエンティティを変更して `migrations add` を忘れていれば、ゼロ以外で終了します。
2. **bundle は CI で 1 回だけビルドします。** アプリケーションのバイナリを生成したのと同じコミットから行います。`dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle --force`
3. **`efbundle` をビルド成果物として公開します。** 必要な `appsettings.json` も一緒に添えます。
4. **独立したデプロイ手順として実行します。** 新しいバージョンのアプリケーションが応答を始める前に `./efbundle --connection "$CONNECTION_STRING"` を実行します。

## bundle をビルドする

このコマンドはデザイン時のコマンドなので、スタートアッププロジェクトが `Microsoft.EntityFrameworkCore.Design` を参照していることと、`dotnet ef` が動作することが必要です。

```bash
# EF Core 11, .NET 11
dotnet tool install --global dotnet-ef
dotnet ef migrations bundle
```

```output
Build started...
Build succeeded.
Building bundle...
Done. Migrations Bundle: /src/App.Api/efbundle
```

既定では出力はスタートアッププロジェクトの隣に置かれ、名前は `efbundle` (Windows では `efbundle.exe`) となり、ビルドを実行したマシンの RID 向けにビルドされます。オプションは全部挙げられる程度の数です。

| オプション | 短縮形 | 動作 |
| --- | --- | --- |
| `--output <FILE>` | `-o` | 作成する実行ファイルのパス。 |
| `--force` | `-f` | 既存の bundle を上書きします。 |
| `--self-contained` | | .NET のランタイムも同梱し、対象マシンにランタイムのインストールを不要にします。 |
| `--target-runtime <RID>` | `-r` | ビルド対象のランタイム識別子。 |

これに加えて通常のデザイン時オプションとして `--project`、`--startup-project`、`--context`、`--configuration`、`--framework`、`--no-build` があります。

実際のソリューションではコンテキストはクラスライブラリにあり、ホストは別の場所にあるので、CI が実行するのはもう少しこれに近い形になります。

```bash
# EF Core 11, .NET 11 - context in a class library, host in the API project
dotnet ef migrations bundle \
  --project src/App.Infrastructure \
  --startup-project src/App.Api \
  --context AppDbContext \
  --configuration Release \
  --self-contained -r linux-x64 \
  -o ./artifacts/efbundle \
  --force
```

EF Core 11 ではその大半を繰り返さずに済みます。リポジトリのルートに `.config/dotnet-ef.json` を置くと、`dotnet ef` は作業ディレクトリからディレクトリツリーを遡って探します。

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "context": "AppDbContext",
  "configuration": "Release"
}
```

明示的なコマンドラインオプションは引き続きファイルより優先されるので、開発者はローカルでどれでも上書きできます。これは EF Core 11 の新機能で、ビルドエージェント上のツールを更新する最大の理由になります。

## bundle は実行時に何をするのか

実行ファイルを起動すると、アセンブリ内のマイグレーションのうち `__EFMigrationsHistory` にまだ記録されていないものをすべて適用します。

```bash
./efbundle --connection "Server=prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true"
```

```output
Applying migration '20260721104512_AddOrderIndexes'.
Applying migration '20260726091133_AddCustomerTier'.
Done.
```

2 回目に実行しても何も起きません。再試行されうるデプロイ手順に望むのはまさにこの挙動です。

```output
No migrations were applied. The database is already up to date.
Done.
```

その全機能は引数 1 つとオプション 4 つです。引数は対象のマイグレーションで、マイグレーション名または ID を渡すとその地点まで上へも**下へも**移動でき、`0` を渡すとすべてのマイグレーションを取り消します。オプションは `--connection`、`--verbose` (`-v`)、`--no-color`、`--prefix-output` です。それだけです。`--timeout` オプションは存在せず、だからこそ大きなテーブルへの長時間のインデックス構築には接続文字列そのものに `Command Timeout=600` を書く必要があります。この失敗モードは [デプロイ中に EF Core のマイグレーションを止めるタイムアウト](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) について書いたときに詳しく扱いました。

`--prefix-output` は CI で有効にする価値があります。各行に重大度を付けてくれるので、ログ集約基盤にフィルターの手がかりを与えられます。

## appsettings.json の落とし穴

これはチームの午後を丸ごと奪う失敗で、ドキュメントからは読み取りにくいものです。

`DbContext` が**名前付き**の接続文字列で構成されている場合、たとえば `optionsBuilder.UseSqlServer("name=ConnectionStrings:DefaultConnection")` の場合、bundle は作業ディレクトリにそのキーを含む `appsettings.json` を必要とします。コマンドラインで `--connection` を渡していてもです。ない場合は次のようになります。

```output
A named connection string was used, but the name 'ConnectionStrings:DefaultConnection'
was not found in the application's configuration. Note that named connection strings
are only supported when using 'IConfiguration' and a service provider, such as in a
typical ASP.NET Core application.
```

そのファイルの値は無関係です。`--connection` が上書きするからで、構成のバインドが成功するために*キー*が存在していればよいだけです。これは [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) として報告され、対応予定なしとしてクローズされたので、修正を待つのではなく前提として設計してください。回避策は 2 つあります。

- 成果物の中で bundle の隣にダミーの `appsettings.json` を同梱し、想定されるキーの下にプレースホルダーの値を置きます。
- あるいはデザイン時の経路で名前付き接続文字列を使うのをやめ、bundle が解決すべきものをなくします。

EF Core のドキュメントは一般的なケースについても率直です。bundle の隣に `appsettings.json` をコピーするのを忘れないでください。bundle は実行ディレクトリにそれが存在することを前提としています。構成が環境ごとに分かれているなら、bundle を実行する前に `ASPNETCORE_ENVIRONMENT` (Web でないホストなら `DOTNET_ENVIRONMENT`) を設定し、対応する `appsettings.Production.json` も一緒にコピーしてください。bundle 自身に `--environment` オプションはありません。

私の好みは構成を完全に迂回することです。デプロイ時にシークレットストアから取得した接続文字列全体を `--connection` で渡し、バインダーを満足させるためだけにダミーの `appsettings.json` を置きます。こうすると bundle は引数だけで決まる純粋な関数になり、同じ成果物をステージングから本番へ昇格させるときに欲しいのはまさにその性質です。

## self-contained bundle と Alpine の罠

`--self-contained -r linux-x64` は .NET のランタイムを内包した実行ファイルを生成します。コンテナーでのデプロイではこれが正しい既定で、マイグレーション手順を .NET が一切入っていない最小のイメージで実行できるからです。

RID はアーキテクチャだけでなく対象の libc にも一致させる必要があります。`linux-x64` の self-contained bundle は glibc を対象としており、Alpine やその他の musl ベースのイメージでは動きません。そこでは `linux-musl-x64` が必要です。失敗は明快なメッセージではなく分かりにくい "not found" やローダーのエラーとして現れるので、RID は意図的に固定してください。

```bash
# EF Core 11, .NET 11 - for an Alpine-based runner
dotnet ef migrations bundle --self-contained -r linux-musl-x64 -o ./artifacts/efbundle --force
```

グローバリゼーションが Alpine での 2 つ目のつまずきどころです。self-contained bundle は ICU を前提とし、Alpine のイメージには `icu-libs` のインストールが必要です。マイグレーション用イメージに `apk add --no-cache icu-libs` を足すほうが、デプロイの時間枠の中で `Couldn't find a valid ICU package installed on the system` をデバッグするより安上がりです。

本番の実行環境に対応する .NET ランタイムが既にあるなら、`--self-contained` を外せば成果物はずっと小さくなります。Kubernetes の init コンテナーやロールアウト前に走る Job では、それでも self-contained 版が有利なことが多いです。マイグレーション手順をアプリケーションイメージのランタイムバージョンから切り離せるからです。[アプリケーションのイメージ自体を `dotnet publish /t:PublishContainer` でビルドする](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) 場合にも同じ理屈が当てはまります。スキーマの手順とアプリケーションの手順は別々の成果物として保ちましょう。

## マイグレーションロックと、それが守らないもの

EF Core 9 以降、マイグレーションの適用はまずデータベース全体のロックを取得します。これは `dotnet ef database update`、`Update-Database`、`Migrate()` と `MigrateAsync()`、そしてマイグレーション bundle に当てはまります。ロックは操作全体を通じて保持され、その一部として実行されるシード処理も含みます。したがって [`UseSeeding` と `UseAsyncSeeding`](/ja/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) でシードしている場合、その処理も保護されます。

ロックが**守らない**のは SQL スクリプトです。スクリプトは完全に EF Core の外で実行されるからです。パイプラインの半分が bundle を、もう半分が生成済みスクリプトを実行しているなら、両者の間に相互排他はありません。どちらかに揃えてください。

ロックの仕組みはプロバイダー固有で、鋭い角があります。SQLite ではロック用テーブルで実装されており、マイグレーションの途中でプロセスが死ぬとテーブルが取り残され、手で消すまで以後のあらゆるマイグレーションを止めてしまいます。SQLite に対して統合テストを走らせ、テストホストを強制終了することがあるなら重要です。

この周辺を設計する前に知っておくべき制限がもう 1 つあります。`MigrateAsync` を明示的なトランザクションで包むことはできません。EF Core 9 以降、これは例外を投げます。

## トランザクションは bundle 単位ではなくマイグレーション単位

よくある誤読は、bundle が保留中のマイグレーションをすべてアトミックに適用するというものです。そうではありません。EF Core は**マイグレーションごとに**独自のトランザクションで包みます。保留中のマイグレーションが 3 つなら、トランザクションも 3 つです。2 つ目が失敗した場合、1 つ目は適用済みのまま `__EFMigrationsHistory` に記録され、3 つ目は実行されません。

通常はこれが望ましい挙動です。bundle を再実行すれば止まった箇所からちょうど再開できるからです。ただしこれは「デプロイが失敗したのでデータベースを戻す」が単一の操作ではないことを意味し、スキーマが取りうる中間状態について考えておく必要があります。

プロバイダー固有の注意点が 2 つ、この話を鋭くします。

- トランザクション DDL を持たないデータベース、とりわけ MySQL では、失敗したマイグレーションがロールバックなしに部分的なスキーマ変更を残すことがあります。DDL のステートメントはそれぞれ暗黙にコミットします。MySQL ではすべてのマイグレーションを非トランザクションとみなし、手で追える程度に小さく保ってください。
- SQL Server や PostgreSQL でもトランザクション内で実行できない操作があります。たとえば並行的なインデックス作成です。その場合は `migrationBuilder.Sql(...)` に `suppressTransaction: true` を渡し、そのステートメントは保護されないと受け入れてください。

```csharp
// EF Core 11, C# 14 - a statement that must not run inside the migration transaction
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql(
        "CREATE INDEX CONCURRENTLY IX_Orders_CustomerId ON \"Orders\" (\"CustomerId\");",
        suppressTransaction: true);
}
```

## ロールバックする

bundle は対象のマイグレーションを位置引数として受け取り、「下方向」への移動は対象を前のものにした同じコマンドです。

```bash
# EF Core 11 - revert to the state right after AddOrderIndexes
./efbundle 20260721104512_AddOrderIndexes

# EF Core 11 - revert everything. Read that twice before running it.
./efbundle 0
```

これが機能するには、実行する bundle が戻り先のマイグレーションを*含んでいる*必要があります。最新のものだけでなく、これまでデプロイしたすべての bundle 成果物を保管しておく理由がここにあります。`Down` メソッドも正しくなければならず、それは多くのリポジトリで最もテストされていないコードです。列を削除する `Down` はロールバックではなく、手順が増えただけのデータ損失です。スクリプトを生成することで得られるのはまさにこのレビューであり、CI で両方の成果物を作ることを妨げるものは何もありません。パイプラインでは bundle を実行し、同じビルドに `dotnet ef migrations script --idempotent -o schema.sql` を添えて DBA に読んでもらいましょう。

## デプロイ前に不一致を捕まえる

EF Core 9 以降、最後のマイグレーションに対してモデルに未反映の変更があると `Migrate()` は例外を投げます (`RelationalEventId.PendingModelChangesWarning`)。それをデプロイ中に発見したくはありません。チェックは CI に置きましょう。

```bash
# EF Core 11 - fails the build if an entity changed without a migration
dotnet ef migrations has-pending-model-changes \
  --project src/App.Infrastructure \
  --startup-project src/App.Api
```

このコマンドは EF Core 8 で追加され、モデルとマイグレーションが乖離しているとゼロ以外で終了します。同じ job 内で bundle のビルドと組み合わせ、成果物とチェックが 1 つのコミットから出るようにしてください。

パイプラインを堅くするついでに、関連する 2 つの失敗モードも先回りしておく価値があります。[DbContext を作成できない](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) ときに `dotnet ef` がデザイン時ファクトリーを必要とする件と、[EF Core 6 から EF Core 11 へ上げる](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) ときに噛みついてくる挙動変更です。

## `database update --add` がはまる場面とはまらない場面

EF Core 11 は `dotnet ef database update <NAME> --add` を追加しました。マイグレーションを生成して 1 つのコマンドで適用するもので、Roslyn を使って実行時にマイグレーションをコンパイルします。内側の開発ループでは本当に気持ちのよいツールで、登場したときに [1 段階のマイグレーションワークフロー](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) について書きました。同時にこれは本番で望むものの正反対でもあります。成果物もレビュー手順も挟まずにスキーマ変更を生成して適用するからです。プロトタイピングでは使い、実データが背後にあるものには bundle を使ってください。EF Core 11 のその他のツール追加、`database drop` と `migrations remove` の `--connection`、`migrations remove` の `--offline` も同様で、開発ループの利便性であってデプロイの道具ではありません。

bundle がマイグレーションを適用したあとで何かがおかしく見えるなら、ログ出力を上げてローカルで再現してください。使い捨てのスキーマのコピーに対して [EF Core 11 が生成する SQL をログ出力させる](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) だけの話です。

## 関連記事

- [Fix: EF Core のマイグレーション中に発生する SqlException Timeout expired](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add が "Unable to create an object of type DbContext" で失敗する](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [EF Core 6 から EF Core 11 への移行：実際に噛みつく破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [EF Core 11 ではマイグレーションの作成と適用を 1 つのコマンドで行える](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [dotnet publish /t:PublishContainer で .NET 11 アプリをコンテナーイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## 参考資料

- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) は 4 つのデプロイ戦略、`efbundle` の引数とオプションの表、マイグレーションロックを扱っています。
- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) は `dotnet ef migrations bundle` のオプションと EF Core 11 の新しい構成ファイル `.config/dotnet-ef.json` に関する一次情報です。
- [Introducing DevOps-friendly EF Core Migration Bundles](https://devblogs.microsoft.com/dotnet/introducing-devops-friendly-ef-core-migration-bundles/) は最初の告知記事で、設計の意図を説明しています。
- [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) は名前付き接続文字列における `appsettings.json` の要件を記録しており、対応予定なしとしてクローズされています。
- [Managing Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) はマイグレーション単位のトランザクションと `suppressTransaction` を説明しています。
- [SQLite provider limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations) は取り残されたマイグレーションロックを扱っています。
