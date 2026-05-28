---
title: ".NET 8 から .NET 11 への移行: 完全チェックリスト"
description: ".NET 8 LTS から .NET 11 LTS へのバージョン固定の移行チェックリストです。SDK のインストール、csproj の target framework、ASP.NET Core / EF Core / System.Text.Json の破壊的変更、C# 14 のオーバーロード解決の変化、ロールバックの注意点を扱います。"
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "ja"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

LTS を 2 回まとめて飛び越えるのは、この 10 年でほとんどのチームが行う中で最も安い .NET アップグレードです。.NET 8 は 2026 年 11 月に標準サポートを抜け、.NET 11 が現在の LTS で、その間の道のりは 3 セットの破壊的変更（.NET 9, 10, 11）と 3 つの C# 言語バージョン（C# 13, 14、加えて C# 12 はすでに 8 で提供済み）を通ります。小さなサービスなら集中した週末で十分です。EF Core、カスタムミドルウェア、いくつかの source generator を持つ中規模のモノリスは通常 3 ～ 5 日かかります。`BinaryFormatter` を固定していたり、`System.Web.HttpContext` のシムに依存したり、in-process な Azure Functions を動かしているコードベースはもっとかかり、その痛みが最初に現れます。

この投稿では `net8.0` をソース、`net11.0` をターゲットとして使います。コードブロックごとにバージョンを明示的に固定するため、いくつかのパッチリリースを経ても手順は再現可能なままです。

## なぜ今移行するのか

- .NET 8 の標準サポートは 2026-11-10 に終わります。その後はセキュリティパッチもサービシングもありません。8 上の本番コードは Black Friday の 3 週間前に監査リスクにさらされます。
- .NET 11 は意味のあるランタイムの恩恵を無料で提供します。動的 PGO がデフォルトで有効、新しい tiered JIT が `async` ステートマシンを過去のペナルティなしで扱い、Native AOT が ASP.NET Core の minimal API と EF Core の読み取りパスの大部分をサポートします。
- .NET 9 で導入された `System.Threading.Lock` 型は、monitor の再入に関する地雷を一掃します。移行を飛ばすと古い `lock(object)` パターンが残ったままになります。
- C# 14 はプロパティの安定した `field` キーワードと `partial` コンストラクターを持ち込みます。便利ですが、移行の理由ではありません。おまけ扱いにしてください。

## 何が壊れるか

| 領域                     | 変更                                                                              | 重大度 |
| ------------------------ | --------------------------------------------------------------------------------- | ------ |
| `lock(object)`           | 新しい `System.Threading.Lock` 型は採用時に monitor のセマンティクスを変える       | 低     |
| `BinaryFormatter`        | .NET 9 で完全に削除。opt-in スイッチなし                                          | 高     |
| `System.Text.Json`       | `JsonObject` ラウンドトリップのデフォルト `JsonNumberHandling` が .NET 10 で変化  | 中     |
| EF Core クエリパイプライン | プリミティブコレクションのトランスレーションが EF Core 10 で変わり、一部 LINQ が例外を投げる | 高 |
| ASP.NET Core ミドルウェア | `UseExceptionHandler` のオーバーロードシグネチャが .NET 10 でシフト              | 低     |
| Native AOT のトリム警告  | いくつかの `System.Reflection.Emit` パスが新たに `IL2026` 警告を出すように       | 中     |
| C# 14 のオーバーロード解決 | Span オーバーロードが配列オーバーロードに勝つようになる（曖昧な場合）             | 中     |
| `IWebHostBuilder`        | 8 ですでに非推奨、11 で削除。`WebApplication.CreateBuilder` に移行                | 高     |
| `dotnet ef` ツール       | メジャーバージョンアップが必要 (`dotnet tool update --global dotnet-ef --version 11.*`) | 低 |
| Azure Functions          | in-process モデルは削除。isolated worker が必須                                   | 高     |

完全な公式リストは [.NET 11 の破壊的変更ドキュメント](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0) にあります。`.csproj` に触れる前に最初から最後まで読んでください。

## プリフライトチェックリスト

target framework を変更する前にこれを実行してください。

1. すべての開発マシンと CI ランナーに .NET 11 SDK をインストールします。`dotnet --list-sdks` で確認し、`11.0.x` が表示されることを確かめます。SDK は side-by-side なので .NET 8 は引き続き動作します。
2. CI が静かにロールフォワードしないように `global.json` で SDK を固定します。
   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```
3. ベースラインを取ります。.NET 8 上で `dotnet test` を実行し、結果を保存します。アップグレード後の最初の赤を明確にするため、開始前にクリーンな緑が欲しいのです。
4. 本番ランタイムのスナップショットを取ります。ライブホストから `dotnet --info` をダンプします。8.0.0 より古いランタイムにリンクしているものがあれば（古い self-contained 公開、サードパーティのプラグイン）、今のうちに見つけてください。
5. `dotnet list package --outdated --include-transitive` で NuGet パッケージを棚卸しします。`Microsoft.*` を `8.0.x` に固定しているものはメジャーバンプが必要、`7.*` 以前に固定しているものはレッドフラグです。
6. 移行用にブランチを切ります。論理ステップごとの 1 PR は、巨大な一発 PR より戻しやすいです。

## 移行手順

1. **target framework を上げる。** すべての `.csproj` を開き、`TargetFramework`（または `TargetFrameworks`）の値を変更します。`dotnet build` で確認し、最初に出る compile エラー群を移行の本当のスコープとして扱います。

   ```xml
   <!-- src/MyApi.csproj, .NET 11 -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
   </Project>
   ```

   検証: `dotnet build` が少なくとも leaf プロジェクトで 0 終了するか、認識できるエラーで失敗する。

2. **すべての `Microsoft.*` NuGet パッケージを 11.x 系に更新する。** `Directory.Packages.props` を盲目的に触るのではなく、プロジェクトごとに `dotnet add package` で 1 つのバッチとして行います。ランタイム、ASP.NET Core、EF Core、`Microsoft.Extensions.*` パッケージは SDK と歩調を合わせてバージョンが上がります。

   ```bash
   # .NET 11
   dotnet add package Microsoft.AspNetCore.OpenApi --version 11.0.0
   dotnet add package Microsoft.EntityFrameworkCore.SqlServer --version 11.0.0
   dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
   ```

   検証: `dotnet restore` が成功し、`dotnet list package` が `Microsoft.*` 名前空間下に `8.0.x` を残していない。

3. **`BinaryFormatter` の利用を取り除く。** コードベースが `BinaryFormatter` で何かをシリアライズしているなら、今置き換えてください。JSON ワイヤフォーマットが必要かバイナリが必要かに応じて、`System.Text.Json`、MessagePack、`protobuf-net` が通常の置き換えです。.NET 9 以降には互換フラグはなく、型自体がなくなりました。

   検証: `grep -r "BinaryFormatter" src/` が何も返さない。ストレージから古い `BinaryFormatter` ブロブを読む必要があるなら、.NET 8 環境を落とす前に、それらを変換するための使い捨ての .NET 8 移行ツールを書いてください。

4. **`IWebHostBuilder` を `WebApplication.CreateBuilder` に置き換える。** 古い generic-host シムは .NET 6 で非推奨となり、.NET 11 で削除されました。まだ `Host.CreateDefaultBuilder().ConfigureWebHostDefaults(...)` を呼び出している `Program.cs` はコンパイルできません。

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.MapOpenApi();
   app.MapControllers();
   app.Run();
   ```

   検証: アプリが `dotnet run` で起動し、`/openapi/v1.json` エンドポイントが HTTP 200 で応答する。

5. **`System.Text.Json` の動作変更を監査する。** `JsonObject` の数値ラウンドトリップのデフォルト処理は .NET 10 で変わり、整数を再シリアライズしても精度を失わなくなりました。また、ポリモーフィックなデシリアライザはデフォルトで未知の discriminator に対してより厳格になりました。公開 API 契約を保守しているなら、契約テストを走らせて失敗を注意深く読んでください。契約自体は変わっていないことが多いのですが、以前は静かに通っていたミスマッチが今は例外を投げます。コンパニオン投稿の [JSON value could not be converted to System.DateTime の修正](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) が最も一般的な変換失敗モードを扱っています。

   検証: フィクスチャ JSON ファイルに対してシリアライズを動かしているプロジェクトすべてで `dotnet test` がクリーンに通る。

6. **プリミティブコレクションを使う EF Core クエリを移行する。** EF Core 10 では `List<int>.Contains(x)` の翻訳が作り直され、パラメータ化されたコレクションが `IN` 句に展開されず単一の SQL パラメータを生成するようになりました。これにより plan-cache 肥大の問題は解決しましたが、`Contains` をサーバ評価される他の式と組み合わせていた小さなクエリ群が壊れました。すべての EF Core 統合テストを再実行し、`InvalidOperationException: The LINQ expression ... could not be translated` を投げるようになったクエリを点検してください。脱出ハッチは、結合前にコレクションを `.ToList()` でマテリアライズすることです。

   検証: `DbSet<T>` に対する素の LINQ を動かしている統合テストがすべて通る。代表的なクエリで `LogTo(Console.WriteLine, LogLevel.Information)` を使って生成された SQL を抜き取り検査する。

7. **`System.Threading.Lock` を一括置換ではなく選択的に採用する。** `private readonly object _gate = new();` を `private readonly System.Threading.Lock _gate = new();` に置き換えるのはほとんどの場合正しいのですが、同一スレッドからの再入が観測可能かどうかを変えてしまいます。先にコードパスを歩いてください。より深いトレードオフ比較は [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) にあります。

   検証: コードレビューが変更されたすべての `lock(...)` サイトを明示的にカバーする。テストスイートに機能変化なし。

8. **trim と AOT のアナライザを再実行する。** プロジェクトが `<PublishAot>true</PublishAot>` または `<TrimMode>full</TrimMode>` を設定しているなら、.NET 8 では静かだった `System.Reflection.Emit` 経路のあたりで .NET 11 は新しい警告を出します。修正は通常 `[DynamicallyAccessedMembers]` アノテーションを追加するか、JSON の source generator を登録することです。[Native AOT vs ReadyToRun vs JIT の比較](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) が各モデルがコストに見合うタイミングを扱っています。

   検証: leaf プロジェクトで `dotnet publish -c Release` が `IL2026` や `IL3050` の警告をゼロで出す。生成された native バイナリがローカルで起動する。

9. **C# 14 のオーバーロード解決の驚きを調整する。** C# 14 は解決規則を変え、`ReadOnlySpan<T>` を受けるオーバーロードが `T[]` を受けるオーバーロードより優先されるようになりました（両方適用可能な場合）。ほとんどのコードは影響を受けません。壊れるのは通常、モック、流暢な assertion ライブラリ、配列オーバーロードが勝つ前提で書かれたカスタムの拡張メソッドです。コンパイラは明確な診断を出します。修正はたいてい cast です。[C# 14 のオーバーロード解決の破壊的変更（span）](/ja/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) が診断と cast パターンを案内します。

   検証: `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` で `dotnet build` が警告ゼロ。

10. **CI ランナーイメージを更新する。** GitHub Actions の `actions/setup-dotnet` の `dotnet-version` を `11.0.x` に上げ、Dockerfile のベースイメージを `mcr.microsoft.com/dotnet/sdk:11.0` と `mcr.microsoft.com/dotnet/aspnet:11.0` に更新し、.NET 8 SDK イメージへのピンを外します。セルフホストランナーは CI を通す前に手で SDK をインストールする必要があります。

    検証: feature ブランチでパイプライン実行が publish ステップを含めて端から端まで緑。

## 検証（スモークチェックリスト）

上記の手順の後、移行 PR をマージする前に、アプリは次のリストのすべての行を通過するはずです。

- `dotnet --list-sdks` がビルドで実際に使われているバージョンとして 11.0.x を示す（リポジトリルートで `dotnet --version` が `11.0.x` を表示する）。
- `dotnet restore && dotnet build -c Release` が 0 終了し、警告ゼロ。
- `dotnet test -c Release` が緑で、テスト数が .NET 8 ベースラインと一致する。
- `dotnet publish -c Release` がローカルで起動し `/health` を提供するアーティファクトを生成する。
- 代表的な読み取りパスと書き込みパスをそれぞれ 1 つずつステージング環境に対して動かす。レイテンシ p50/p95 は .NET 8 ベースラインの 10 パーセント以内。
- ログに `BinaryFormatter`、`IWebHostBuilder`、`IL2026` への first-chance 参照が出ない。

どれか 1 つでも落ちたら止めてください。部分的にしか移行されていないコードベースをマージしないこと。

## ロールバック

この移行は、.NET 11 下で書き込みを受ける最初の本番デプロイまで可逆です。それまでは `global.json`、`TargetFramework`、NuGet のバンプを 1 コミットで戻してください。.NET 11 で最初の本番書き込みを終えた後はロールバックは技術的に可能ですが、ほとんど割に合いません。EF Core 11 のトランスレータの下で行ったかもしれないスキーマ変更、新しいデフォルトでシリアライズされた JSON 出力、`System.Threading.Lock` の採用はそれぞれ別の検討が必要です。前進して直す計画にしてください。

## ぶつかった落とし穴

- **`net8.0` だけをターゲットにする NuGet パッケージは net11.0 で必ずしも壊れているわけではない**が、パッケージが .NET Standard 2.0 のファサードを公開していれば静かにそちらが読み込まれます。これは時に古い `System.*` 依存を引き戻します。バンプ後の `dotnet list package --include-transitive` は省略不可です。
- **`Microsoft.Data.SqlClient` のバージョンが重要。** EF Core 11 は `Microsoft.Data.SqlClient` 7.x 以上を欲しがります。古い transitive ピンはコンパイルは通り、その後より新しい SQL Server ボックスに対する TLS 1.3 ネゴシエーションで実行時に失敗します。
- **Roslyn 4.6 で構築された source generator は .NET 11 同梱の Roslyn 上で警告を出します。** 多くは generator の `Microsoft.CodeAnalysis.CSharp` 参照を上げれば解決します。自前の generator を出荷しているなら別 PR でやってください。
- **in-process な Azure Functions は消えました。** 1 つでも .NET 8 で in-process モデルを使っている function プロジェクトが残っていれば、.NET 11 はそれを実行しません。先に isolated worker モデルに移行し、その後にバンプします。
- **.NET 11 の `HttpClient` のキャンセルセマンティクス**は、与えられた token と一致する `CancellationToken` を持つ `TaskCanceledException` を正しく投げます。以前は一部のパスが `CancellationToken.None` で投げていました。token をパターンマッチする catch ブロックは小さな調整が必要です。根拠は [C# の async void vs async Task](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) の議論にあります。

## 関連

- [.NET 11 における ConfigureAwait(false) vs デフォルト](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [.NET 11 における Native AOT vs ReadyToRun vs JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [EF Core 11 vs Dapper の bulk insert 実測ベンチマーク](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)
- [ASP.NET Core 11 における Minimal APIs vs コントローラー](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## 出典

- [.NET 11 の破壊的変更](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET のリリーススケジュールとサポートポリシー](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [EF Core 10 と 11 の破壊的変更](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [C# 14 言語リファレンス](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
- [`System.Threading.Lock` API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock)
