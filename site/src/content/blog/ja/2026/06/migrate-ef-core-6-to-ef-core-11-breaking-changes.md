---
title: "EF Core 6 から EF Core 11 への移行: 本当に効いてくる破壊的変更"
description: "EF Core 6.0 から EF Core 11.0 へのバージョン固定の移行ガイド。実際のアプリを壊す EF7、8、9、10、11 の破壊的変更を辿ります: Encrypt=True、OPENJSON による Contains、PendingModelChangesWarning、ネイティブ json 列、そして SqlClient 7.0 の分割。"
pubDate: 2026-06-04
updatedDate: 2026-06-04
template: migration
tags:
  - "migration"
  - "ef-core"
  - "ef-core-6"
  - "ef-core-11"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes"
translatedBy: "claude"
translationDate: 2026-06-04
---

EF Core 6.0 から EF Core 11.0 への移動は一度に 5 つのメジャーバージョンを飛び越えることであり、痛みを伴う部分はほとんどの場合 API の名称変更ではありません。静かな動作の変更です。何年も動いていた接続文字列が SSL エラーをスローし、`Contains` クエリが古い SQL Server で突然タイムアウトし、EF がモデルに保留中の変更があると判断してデプロイが中断します。小さなサービスなら半日、非自明なモデル、カスタム値コンバーター、データベースファーストの scaffolding フローを持つモノリスなら 2 ～ 4 日を見込んでください。これらはどれもデータベースレベルでは一方通行ではありませんが、2 つの変更（EF Core 7 の `Encrypt` 既定値と EF Core 9 の `PendingModelChangesWarning` 例外）は、計画しなければ初日にアプリの起動を止めます。

このガイドは `Microsoft.EntityFrameworkCore` 6.0 をソース、11.0 をターゲットとして固定し、.NET 11 上で実行します。EF Core の target framework の下限は途中で上がる（EF Core 7 は .NET 6、EF Core 8 と 9 は .NET 8、EF Core 10 は .NET 10、EF Core 11 は .NET 11 を必要とする）ため、これはランタイムの移行でもあります。ランタイムをまだ移していない場合は、まず [.NET 8 から .NET 11 へのチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) を使ってそれを行い、戻ってきてください。

## 今移行する理由

- EF Core 6.0 は 2024 年 11 月にサポートを終了しました。サポートされていないデータレイヤーをサポートされているランタイムに対して実行しており、セキュリティレビューの観点では両方の世界の最悪の組み合わせです。
- EF Core 11 は実際のクエリ改善を無料でもたらします。`OPENJSON` ベースの `Contains` 変換（EF 8 以降に 3 回改良）、複数のスカラーパラメーターによるより良いカーディナリティ推定、そして一流のインデックス作成を備えた SQL Server のネイティブ `json` 列型です。
- EF Core 7 で追加され、それ以降のすべてのバージョンで改善されてきた `ExecuteUpdate` と `ExecuteDelete` は、集合ベースの書き込みを単一の SQL 文に変えます。エンティティを読み込んでから変更しているなら、1 ～ 2 桁の性能をテーブルに残しています。ベンチマークについては [ExecuteUpdate とエンティティの読み込みおよび SaveChanges の比較](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) を参照してください。
- EF 9（モデルの保留中の変更の検出）と EF 11（マイグレーション不在の検出）で登場した移行のガードレールは、「データベースとモデルが静かに乖離した」という一群の本番インシデントを捕捉します。

## 何が壊れるか

これは 5 つのバージョン全体にわたる累積リストです。深刻度は、典型的なアプリが壊れる可能性の高さであり、修正の難しさではありません。

| 領域 | 変更 | バージョン | 深刻度 |
| ---- | ---- | ---------- | ------ |
| SQL Server 接続 | `Encrypt` が既定で `true` になり、信頼されない証明書は例外をスローする | EF 7 | 高 |
| トリガーを持つ SaveChanges | OUTPUT 句のパスがトリガーや一部の計算列を持つテーブルで壊れる | EF 7 | 高 |
| 任意のリレーションシップ | 切り離し時に孤立した従属エンティティが自動削除されなくなる | EF 7 | 中 |
| リストに対する `Contains` | `OPENJSON` 経由で変換され、SQL Server 2016 / 互換性レベル 130 未満では失敗する | EF 8 | 高 |
| `Contains` のパフォーマンス | 一部のワークロードで `OPENJSON` のプランが大きく劣化することがある | EF 8 | 高 |
| JSON 列の enum | 既定で `string` ではなく `int` として格納される | EF 8 | 高 |
| SQL Server の文字列キー | 変更トラッカーで大文字小文字を区別せずに比較される | EF 8 | 中 |
| マイグレーションの適用 | `PendingModelChangesWarning` が `Migrate()` で例外をスローするようになる | EF 9 | 高 |
| トランザクション内のマイグレーション | `Migrate()` を囲む外部トランザクションが例外をスローするようになる | EF 9 | 高 |
| `EF.Constant` / `EF.Parameter` | コンパイル済みクエリ内で `InvalidCastException` をスローする | EF 9 | 低 |
| EF ツール、マルチターゲットプロジェクト | `--framework` が必須になる | EF 10 | 中 |
| パラメーター化されたコレクション | 既定の変換が複数のスカラーパラメーターになる | EF 10 | 低 |
| SQL Server の JSON ストレージ | `nvarchar(max)` の JSON が互換性レベル 170 / Azure SQL でネイティブ `json` に移行する | EF 10 | 低 |
| マイグレーションなしの Migrate | ログ出力ではなく既定で例外をスローする | EF 11 | 低 |
| `Microsoft.Data.SqlClient` 7.0 | Entra ID 認証の依存関係が別パッケージに分割される | EF 11 | 中 |

バージョンごとの権威あるリストは末尾にリンクしてあります。開始前に [EF 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes)、[EF 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes)、[EF 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) のページを読んでください。この 3 つが深刻度の高い変更を担っています。

## 事前チェックリスト

1. ランタイムを .NET 11 に移し、まず古い EF Core 6 パッケージでクリーンな `dotnet test` を確認します。一度に変わる変数を 1 つにしたいので、EF を上げた後の最初の赤が明確になります。
2. プロバイダーをインベントリ化します。SQL Server、SQLite、PostgreSQL（Npgsql）、Cosmos にはそれぞれ独自の破壊的変更があります。このガイドは SQL Server に焦点を当て、SQLite が異なる箇所を指摘します。
3. SQL Server のバージョンと互換性レベルを確認します。EF 8 の `Contains` 変更には互換性レベル 130 以上が必要です。
   ```sql
   -- run against your target database
   SELECT name, compatibility_level FROM sys.databases;
   ```
4. `Database.Migrate(` と `MigrateAsync(` を grep します。各呼び出し箇所は EF 9 の保留中変更例外と EF 9 の明示的トランザクション例外の候補です。
5. enum 上の `.HasConversion<string>()` と、JSON にマップされた owned 型の中にマップされた enum プロパティを grep します。これらは EF 8 の JSON 内 enum の変更です。
6. いずれかの接続文字列で Entra ID（Azure AD）認証（`Authentication=Active Directory Default`、マネージド ID、サービスプリンシパル）を使っているかどうかを記録します。これは EF 11 の SqlClient 分割です。
7. 移行用にブランチを切り、データベースをバックアップします。スキーマを変更するマイグレーション（識別子の最大長、ネイティブ `json`）は自動生成されるので、本番に対して実行する前にレビューしてください。

## 移行手順

1. **すべての EF Core パッケージを一度に 11.0 へ上げます。** 1 バージョンずつ上げないでください。破壊的変更は累積的でバージョンごとに文書化されているため、ドキュメントを開いた状態での 1 回のジャンプは 5 回の中間コンパイルより速いです。`Microsoft.EntityFrameworkCore`、プロバイダー（`Microsoft.EntityFrameworkCore.SqlServer`）、`Microsoft.EntityFrameworkCore.Design` を更新します。`dotnet restore` と `dotnet build` で確認し、最初のコンパイルエラーを移行の真のスコープとして扱います。
   ```xml
   <!-- src/MyApp.csproj, EF Core 11 on .NET 11 -->
   <ItemGroup>
     <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0" PrivateAssets="all" />
   </ItemGroup>
   ```

2. **`dotnet ef` ツールを一致するメジャーバージョンに更新します。** 6.x ツールは 11.0 モデルを読めません。`dotnet ef --version` で確認し、`11.0.x` を確認します。
   ```bash
   dotnet tool update --global dotnet-ef --version 11.*
   ```

3. **何よりもまず `Encrypt=True` の既定値を修正します。** これは EF ではなく `Microsoft.Data.SqlClient` に存在する EF Core 7 の変更であるため、EF 側のスイッチはありません。信頼されたサーバー証明書のない開発マシンでは、最初の接続が SSL エラーをスローします。ローカル開発では `TrustServerCertificate=True` を追加し、本番では有効な証明書をインストールします。接続を 1 つ開いて確認します。`dotnet ef dbcontext info` が SSL プロバイダーエラーなしで接続するはずです。
   ```text
   Server=localhost;Database=App;Trusted_Connection=True;TrustServerCertificate=True
   ```

4. **すべての `Migrate()` 呼び出し箇所で移行のガードレールに対処します。** EF Core 9 はモデルが最後のマイグレーションと異なる場合に `PendingModelChangesWarning` をスローし、EF Core 11 はマイグレーションがまったくない場合に `MigrationsNotFound` をスローします。スキーマをマイグレーションで管理しているなら、修正は不足しているマイグレーションを追加することです。スキーマを別の方法（Dapper、DACPAC、手書き SQL）で管理していて、習慣で `Migrate()` を呼んでいるだけなら、呼び出しを削除するか警告を抑制します。`dotnet ef migrations has-pending-model-changes` を実行してクリーンな結果を得ることで確認します。
   ```csharp
   // EF Core 11. Only suppress if you intentionally manage schema elsewhere.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.ConfigureWarnings(w =>
       {
           w.Ignore(RelationalEventId.PendingModelChangesWarning);
           w.Ignore(RelationalEventId.MigrationsNotFound);
       });
   ```

5. **`Migrate()` を囲む明示的なトランザクションをすべて削除します。** 一般的な「回復力のあるマイグレーション」パターン（トランザクション開始、マイグレート、コミット、実行戦略の内側で）は、EF が現在トランザクションとデータベースロックを自分で管理するため、EF Core 9 で `MigrationsUserTransactionWarning` をスローします。ラッパーを削除し、`MigrateAsync` を直接呼び出します。アプリが起動し、マイグレーションを 1 回適用することを確認します。
   ```csharp
   // EF Core 9+. EF manages the transaction and execution strategy.
   await dbContext.Database.MigrateAsync(cancellationToken);
   ```

6. **`Contains` 変更のために SQL Server の互換性レベルを確認します。** `sys.databases` が 130 未満のレベルを報告する場合、EF Core 8 の `OPENJSON` 変換は実行時に失敗します。可能ならレベルを上げるか、変換モードを固定します。`.Where(x => list.Contains(x.Id))` を使うクエリを実行し、有効な SQL を確認します。
   ```csharp
   // EF Core 10+: pick the translation strategy explicitly.
   // Constant = pre-EF8 inlining, Parameter = OPENJSON, MultipleParameters = EF10 default.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.UseSqlServer(connectionString,
           o => o.UseParameterizedCollectionMode(ParameterTranslationMode.MultipleParameters));
   ```

7. **文字列値に依存している場合は JSON 内 enum のストレージを固定します。** EF Core 8 は JSON にマップされた owned 型の中の enum を文字列から整数に変更しました。EF 6 が書き込んだ既存のドキュメントは文字列を保持しています。アップグレード後、EF はそれを整数として読み込んで失敗します。古いデータを読めるように文字列変換を強制します。JSON 列内に enum プロパティを持つエンティティを往復させて確認します。
   ```csharp
   protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
       => configurationBuilder.Properties<OrderStatus>().HaveConversion<string>();
   ```

8. **EF が現在要求するスキーマ変更のためにマイグレーションを追加します。** EF Core 8 は TPH の識別子列に上限付きの最大長を与え、EF Core 10 は Azure SQL または互換性レベル 170 で JSON 列をネイティブ `json` 型にマップします。マイグレーションを生成し、それを読み、それからのみ適用します。生成された `AlterColumn` 操作のレビューで確認します。
   ```bash
   dotnet ef migrations add UpgradeToEfCore11
   dotnet ef migrations script --idempotent --output migrate.sql
   ```

9. **使っている場合は Entra ID 認証を切り出します。** EF Core 11 は `Microsoft.Data.SqlClient` 7.0 に移行し、コアパッケージから Azure 認証の依存関係を削除します。接続文字列が `Active Directory` 認証を使う場合は拡張パッケージを追加します。ローカルだけでなく、デプロイされた環境でマネージド ID を使って接続して確認します。
   ```xml
   <PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.0" />
   ```

## 検証

移行後、この順序でスモークテストを実行します。

1. `dotnet build` がクリーンであり、`Microsoft.EntityFrameworkCore.Design` 参照の解決を含む（EF 11 ツールはもはやそれを推移的に取り込みません）。
2. `dotnet ef migrations has-pending-model-changes` が保留中の変更なしを報告する。
3. アプリが起動し、（呼び出している場合）`Migrate()` が `PendingModelChangesWarning` や `MigrationsNotFound` なしでクリーンに適用される。
4. `dotnet test` が緑である。生成された SQL 文字列をアサートするテストに注意してください。`Contains` とパラメーター化されたコレクションの変換が変わったため、スナップショットのアサーションは更新が必要になります。
5. リストに対する `Contains` でフィルターするクエリを実行し、コンパイルだけでなく実行されることを確認する。
6. enum を持つ JSON マップされたエンティティと、リレーションシップで使われる文字列キーのエンティティを抜き取りで確認し、値が正しいことを確認する。

## ロールバック計画

パッケージとコードの変更は元に戻せます。ブランチを戻し、EF Core 6.0 パッケージを復元し、`dotnet-ef` ツールをダウングレードします。リスクは手順 8 のスキーマ移行です。識別子の最大長とネイティブ `json` の変更はデータベースを変更し、EF Core 6.0 は EF Core 11 がスタンプしたマイグレーションを知りません。そのマイグレーションを適用した後にランタイムをロールバックできる必要がある場合は、先にダウンスクリプト（`dotnet ef migrations script UpgradeToEfCore11 PreviousMigration`）を生成し、リリースとともに保管してください。そのスクリプトがなければ、スキーマ変更は EF 6 バイナリにとって事実上一方通行です。

## 私たちが踏んだ落とし穴

**`Contains` のタイムアウトが最も陰険です。** クエリはコンパイルされ、正しい結果を返し、小さなデータセットではすべてのテストに合格します。その後、数百万行を持つ本番テーブルが `OPENJSON` のプランに当たり、クエリがタイムアウトします。EF チームはこれを 3 回改良しました。EF 8 は `OPENJSON` を導入し、EF 9 は `TranslateParameterizedCollectionsToConstants` を追加し、EF 10 は既定を複数のスカラーパラメーターに変えました。リグレッションが見られる場合、クエリごとの脱出弁は `EF.Constant(list).Contains(...)` で、グローバルの既定をそのままにしつつその 1 つのクエリの値をインライン化します。[N+1 検出ガイド](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) と [クエリ分割ガイド](/ja/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) は、同じパスで確認する価値のある隣接するクエリ形状の罠をカバーしています。

**大文字小文字を区別しない文字列キーが静かにマッチングを変えます。** EF Core 8 は、SQL Server が外部キーをマッチさせる方法に合わせるため、SQL Server プロバイダーが変更トラッカーで文字列キー値を大文字小文字を区別せずに比較するようにしました。コードが `"ABC"` と `"abc"` がメモリ上で別のキーであることに依存していた場合、変更トラッカーは今やそれらを同じエンティティとして扱います。修正はそれらのキーに大文字小文字を区別するカスタム `ValueComparer` を設定することですが、まず本当にそれに依存しているか確認してください。ほとんどのアプリは新しい動作を望んでいます。

**保留中変更例外は動的なシードデータで発火します。** `DateTime.UtcNow` や `Guid.NewGuid()` を使って `HasData` でシードするモデルは、ビルドごとに EF からは「変更された」ように見えるため、何も変えていなくても EF 9 は `PendingModelChangesWarning` をスローします。動的な値をシード内の静的定数に置き換えるか、EF 9 のシードパターンに移行してください。これは本物のマイグレーションのバグと誤診断しやすいものです。

**データベースファーストの scaffolding の出力は形が変わります。** データベースから再 scaffolding すると、EF 8 は `date` と `time` 列に対して `DateOnly` と `TimeOnly` を生成し、既定値を持つブール列の nullable ラッパーを外し、複合外部キーのナビゲーションを異なる名前にします。これらはどれも実行中のアプリを壊しませんが、間違いと取り違えやすい大きくノイズの多い diff を生成します。diff をレビューできるよう、再 scaffolding は独立したコミットで行ってください。

5 つのメジャーバージョンは実際よりも重く聞こえます。2 つの変更は初回実行でアプリを完全に止め（`Encrypt` の既定値とマイグレーション例外）、1 つは潜在的なパフォーマンスの罠です（`Contains` 変換）。その 3 つに備え、唯一のスキーマ移行を生成して読み、残りはパッケージのバンプと緑のテスト実行です。同じアップグレードのより広いランタイム面については、[.NET 8 から .NET 11 へのチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) が、これと一緒に来る framework、ASP.NET Core、C# 14 の変更をカバーしています。

## 出典

- [Breaking changes in EF Core 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes)
- [Breaking changes in EF Core 8.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes)
- [Breaking changes in EF Core 9.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [Breaking changes in EF Core 10.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [Breaking changes in EF Core 11.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Microsoft.Data.SqlClient 7.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md)
