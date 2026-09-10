---
title: "修正: PublishAot と EFOptimizeContext の組み合わせで EF Core のビルド中にメモリが枯渇する"
description: "EF Core のビルド時モデル生成が MSBuild を再帰的に呼び出し、RAM を使い切っていました。Tasks と Design を 10.0.10 以降に更新し、EF Core 11 では EFOptimizeContext を削除します。"
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "native-aot"
  - "msbuild"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/09/fix-publishaot-and-efoptimizecontext-exhaust-memory-during-an-ef-core-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

`Microsoft.EntityFrameworkCore.Tasks` と `Microsoft.EntityFrameworkCore.Design` の両方を 10.0.10 以降 (2026-09-10 時点の最新は 10.0.12) に更新し、残っているビルドプロセスを終了してから Visual Studio を再起動してください。10.0.9 までは、EF Core のビルド時のコンパイル済みモデル生成とクエリのプリコンパイルが、自身の入れ子になったビルドの内側から再び自分自身を起動し、マシンのメモリが尽きるまで MSBuild プロセスを生み出し続けていました。EF Core 11 では修正が取り込み済みで、`EFOptimizeContext` そのものが廃止されています。削除しないとビルドが失敗します。

## エラーの状況

検索できる例外が存在しないことが、この問題をやっかいにしています。EF Core 10.0.5 に対する報告 [dotnet/efcore#38087](https://github.com/dotnet/efcore/issues/38087) には症状がすべて書かれています。マシンが応答しなくなるまで RAM 使用量が増え続け、ビルド出力は最初の 1 行から先に進まず、Visual Studio でソリューションを開くだけで発生します。プロジェクトが読み込まれた瞬間に IntelliSense がデザイン時ビルドを開始するためです。この報告にある詳細ビルドログには、次の 1 行だけが記録されています。

```
Build started at 5:55 PM...
```

その間、タスク マネージャーや `top` には `dotnet` と `MSBuild` のプロセスが増え続ける様子が表示されます。原因となるプロジェクト設定は、いつも同じ 4 行です。

```xml
<!-- EF Core 10.0.5 through 10.0.9: do not build this without the fix -->
<PublishAot>true</PublishAot>
<EFOptimizeContext>true</EFOptimizeContext>
<EFScaffoldModelStage>build</EFScaffoldModelStage>
<EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
```

EF Core 11 に更新した後にこのページにたどり着いた場合は、見えるものが異なります。`Microsoft.EntityFrameworkCore.Tasks` 11.0.0-rc.1.26425.128 の `_EFValidateProperties` ターゲットが、次のメッセージでビルドを確実に失敗させます。

```
$(EFOptimizeContext) is no longer supported. Use $(EFScaffoldModelStage) and $(EFPrecompileQueriesStage) instead.
```

## 発生する理由

一見無関係な 2 つの事実が組み合わさっています。

1 つ目は、`PublishAot` が発行だけの設定ではないことです。プロジェクト ファイルに `<PublishAot>true</PublishAot>` があると、単なる `dotnet build` でも AOT の機能スイッチが `bin/Debug/net10.0/YourApp.runtimeconfig.json` に書き込まれます。その中には次のスイッチも含まれます。

```json
"System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
```

EF Core はこのスイッチに従い、ランタイムでのモデル構築を拒否します。そのため F5 のデバッグ セッションは最初のクエリで終了します。

```
Unhandled exception. System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
```

自然な対応は、コンパイル済みモデルとプリコンパイル済みクエリをビルドのたびに生成させることです。まさにそれを行うのが `EFScaffoldModelStage=build` と `EFPrecompileQueriesStage=build` で、EF Core 9 と 10 ではこれらは `EFOptimizeContext=true` と組み合わせたときだけ有効になります。これが 4 行になる理由です。

2 つ目は、`Microsoft.EntityFrameworkCore.Tasks` が生成処理をビルドに組み込む方法です。`_EFGenerateFilesAfterBuild` ターゲットは `$(TargetsTriggeredByCompilation)` に追加されるため、`CoreCompile` のたびに実行されます。このターゲットは `_EFGenerationStage=build` を指定して同じプロジェクトの入れ子の MSBuild を起動し、AOT を無効にしてプロジェクトを再ビルドしたうえで `OptimizeDbContext` タスクを実行します。プリコンパイル済みクエリの場合、EF のデザイン時コードはさらに Roslyn の `MSBuildWorkspace` でプロジェクトを開きます。この方法でプロジェクトを読み込むと、もう 1 回デザイン時ビルドが実行されます。

この連鎖が再帰になるのを防いでいたのは、生成ターゲットに付いた `'$(_EFGenerationStage)'==''` という条件だけでした。この条件には 2 つの穴がありました。

1. **Visual Studio のデザイン時ビルド。** `CoreCompile` は、プロジェクトを開いている間 VS が絶えず実行する軽量なデザイン時ビルドでも実行されます。そのたびにプロセス外での完全な生成が始まり、終わるよりも速く積み上がっていきました。[dotnet/efcore#38386](https://github.com/dotnet/efcore/pull/38386) は生成ターゲットに `'$(DesignTimeBuild)' != 'True'` を追加してこれを修正しました。この変更は **Tasks** パッケージの `.targets` ファイルにあります。
2. **コマンドラインからのビルド。** クエリのプリコンパイル用に開かれる `MSBuildWorkspace` は `_EFGenerationStage` を引き継いでいなかったため、そのビルドが条件を満たして生成を再び起動し、それがまた別の workspace を開く、という流れが続きました。[dotnet/efcore#38403](https://github.com/dotnet/efcore/pull/38403) は `_EFGenerationStage=build` をグローバル プロパティとして workspace を作成することでこれを修正しました。この変更は **Design** パッケージ内の `DbContextOperations` にあります。

どちらも 2026 年 6 月に `release/10.0` にマージされ、2026-07-14 の 10.0.10 で初めて出荷されました。マイルストーンを信用するのではなく、パッケージ自体で確認しています。10.0.9 の `Microsoft.EntityFrameworkCore.Tasks.targets` には `DesignTimeBuild` のチェックが 1 つもなく、10.0.10 には 3 つあります。また `_EFGenerationStage` という文字列は、10.0.10 で初めて `Microsoft.EntityFrameworkCore.Design.dll` に現れます。

## 最小限の再現

元の報告にあったプロジェクトを、SQLite 上のエンティティ 1 つとコンテキスト 1 つに絞ったものです。10.0.9 以前のすべてのバージョンで再現します。プロセス ツリーを強制終了する準備ができていないマシンではビルドしないでください。

```xml
<!-- .NET 10 SDK, EF Core 10.0.9 (broken). Reproduces the memory exhaustion. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <EFOptimizeContext>true</EFOptimizeContext>
    <EFScaffoldModelStage>build</EFScaffoldModelStage>
    <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
    <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.9" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.9" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.x
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();
await db.Database.OpenConnectionAsync();
await db.Database.ExecuteSqlRawAsync(
    "CREATE TABLE IF NOT EXISTS Entities (Id INTEGER PRIMARY KEY)");
var count = await db.Entities.Where(e => e.Id > 0).CountAsync();
Console.WriteLine($"Entities: {count}");

public class Entity { public int Id { get; set; } }

public class AppDbContext : DbContext
{
    public DbSet<Entity> Entities => Set<Entity>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=db.sqlite");
}
```

テーブルは `EnsureCreatedAsync()` ではなく、意図的に生の SQL で作成しています。理由は後述の注意点のセクションで説明します。

## 修正の詳細

### 1. Tasks と Design をそろえて 10.0.10 以降に更新する

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 (fixed) -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12" PrivateAssets="all" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.12" PrivateAssets="all" />
</ItemGroup>
```

Design は明示的に固定してください。デザイン時ビルド向けのガードは Tasks に、コマンドライン向けのガードは Design にあります。明示しない場合、Design は NuGet が解決したバージョンで推移的に依存関係グラフに入ってきますが、それが想定どおりのバージョンとは限りません。Tools 10.0.6 から 10.0.8 では Design が 8.0.0 まで下がって解決されることがあり、その混乱は [MissingMethodException ArgumentIsEmpty の修正](/ja/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/) で解説しています。Tasks だけを更新すると Visual Studio は直りますが、`dotnet build` は壊れたままです。実際に何が解決されたかは `dotnet nuget why . Microsoft.EntityFrameworkCore.Design` で確認できます。

次に、壊れたバージョンが残したものを片付けます。Visual Studio を閉じ、取り残された `dotnet` や `MSBuild` のプロセスを終了し、ビルド サーバーを停止し、`obj` を削除します。こうすることで、書きかけの生成ファイルやその `*.EFGeneratedSources.Build.txt` リストが次のコンパイルに持ち込まれなくなります。

```bash
dotnet build-server shutdown
```

上の再現を 10.0.12 に移し、SDK 10.0.302 でビルドすると、`dotnet build` は 5.4 秒、エラー 0 件で完了し、アプリは `Entities: 0` を出力します。`obj/Debug/net10.0/EfBombRepro.EFGeneratedSources.Build.txt` には 6 つの生成ファイルが並びます。

```
AppDbContextAssemblyAttributes.g.cs
EntityUnsafeAccessors.g.cs
AppDbContextModel.g.cs
AppDbContextModelBuilder.g.cs
EntityEntityType.g.cs
Program.EFInterceptors.AppDbContext.g.cs
```

インターセプターのファイルには、`CountAsync` 呼び出しの完成した SQL `SELECT COUNT(*) FROM "Entities" AS "e" WHERE "e"."Id" > 0` が文字列リテラルとして含まれています。これこそがクエリのプリコンパイルの目的で、ランタイムでは LINQ の変換が一切行われません。

### 2. EF Core 11 では EFOptimizeContext を削除する

EF Core 11 はこのプロパティを削除しました ([dotnet/efcore#35079](https://github.com/dotnet/efcore/issues/35079))。ステージ プロパティがすでにその役割をすべて表現していたためです。現在はステージ プロパティだけで生成が有効になります。

```xml
<!-- .NET 11, EF Core 11.0.0-rc.1.26425.128 -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <EFScaffoldModelStage>build</EFScaffoldModelStage>
  <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
</PropertyGroup>
```

rc.1 の targets ファイルには `DesignTimeBuild` のガードが、rc.1 の Design アセンブリには `_EFGenerationStage` による workspace の修正が含まれているため、この構成は安全です。発行時だけ生成すればよい場合は、2 つのステージ行も削除してください。どちらも既定値は `publish` で、`PublishAot=true` なら EF Core 11 は追加のプロパティなしで `dotnet publish` 中にコンパイル済みモデルとプリコンパイル済みクエリを生成します。`EFScaffoldModelStage=publish` と `EFPrecompileQueriesStage=build` の組み合わせだけは即座に拒否され、"If $(EFScaffoldModelStage) is set to 'publish' then $(EFPrecompileQueriesStage) must also be set to 'publish'." というメッセージで失敗します。

順序に注意してください。10.x では、ビルド ステージでの生成を有効にするスイッチは今も `EFOptimizeContext` です。修正済みの 10.0.12 の再現からこのプロパティを削除し、両方のステージを `build` のままにしたところ、ビルドは成功しましたが何も生成されず、アプリは最初のクエリで "Model building is not supported" の例外をスローしました。このプロパティは EF Core 11 への更新の一部として削除し、それより前には削除しないでください。また、EF Core 11 では Tasks パッケージが Design にまったく依存しなくなっている点にも注意してください。これも手順 1 の Design への明示的な参照を残しておく理由の 1 つです。

私のマシンにある SDK は 10.0.302 だけで、EF Core 11 のパッケージは `net11.0` のみを対象としているため、上記の EF Core 11 に関する記述は、実際にビルドした結果ではなく、rc.1 で出荷された targets ファイルとアセンブリを読んで確認したものです。

### 3. 内側の開発ループに PublishAot を持ち込まない

issue のスレッドでの EF メンテナーの助言は明快です: "I'd recommend not setting `<PublishAot>true</PublishAot>` for the inner dev loop"。一方で報告者の反論こそが本当の問題で、`PublishAot` を外すとトリミングと AOT の警告が IDE から消えてしまいます。しかしその必要はありません。アナライザーには専用のスイッチがあります。

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 -->
<PropertyGroup>
  <EnableAotAnalyzer>true</EnableAotAnalyzer>
  <EnableTrimAnalyzer>true</EnableTrimAnalyzer>
</PropertyGroup>
```

`PublishAot` をこの 2 行に置き換えても、再現では `new AppDbContext()` に対して同じ `IL2026` と `IL3050` の警告が引き続き報告されます。runtimeconfig には `IsDynamicCodeSupported` スイッチが含まれなくなり、EF Core はいつもどおりランタイムでモデルを構築し、ビルド中には何も生成されません。AOT は発行時の判断になります。

```bash
dotnet publish -c Release -r linux-x64 -p:PublishAot=true
```

EF のドキュメントでは、発行ステージで生成を実行する場合、スタートアップ プロジェクトに `<RuntimeIdentifier>` を設定することも推奨されています。

内側のループでのコストは仮定の話ではありません。エンティティ 1 つの再現で、`Program.cs` を編集した後のインクリメンタル ビルドは、ビルド ステージでの生成ありで 4.7 秒、なしで 1.2 秒かかりました。変更のないビルドはどちらも 0.6 秒でした。`CoreCompile` がスキップされるときは生成もスキップされるためです。ドキュメントは、生成されるモデルとインターセプターが "may currently be quite large" であり生成にも時間がかかると警告しているので、この差はモデルの規模に応じて広がります。

## 注意点と似たエラー

**"Design-time DbContext operations are not supported when publishing with NativeAOT."** `PublishAot=true` のもとでは、`EnsureCreatedAsync()`、`Migrate()`、その他デザイン時モデルを必要とするものはすべてこの例外をスローします。F5 でも、コンパイル済みモデルがあっても同じです。再現で生の SQL を使ってテーブルを作成しているのはこのためです。スキーマの変更は、デプロイ パイプラインから migrations bundle や SQL スクリプトで適用してください。

**`warning CS9270: 'InterceptsLocationAttribute(string, int, int)' is not supported`.** 10.0.12 が生成するインターセプターは、ファイル パスを使う形式の属性を今も使っているため、コンパイラーが生成ファイルに警告を出します。これは生成コードに対する警告であり、自分のコードで直すものではありません。同じ理由で、これらのファイルにはマシン固有の絶対パスが含まれるので、ソース管理ではなく `obj` に置くべきものです。

**CS9137, "The 'interceptors' feature is not enabled in this namespace".** `InterceptorsNamespaces` の行が欠けているか、EF のドキュメントによれば、古い `Microsoft.CodeAnalysis.CSharp.Workspaces` と `Microsoft.CodeAnalysis.Workspaces.MSBuild` への推移的な参照が依存関係グラフに入っています。別のジェネレーターが出す同じエラー コードは [CS9137 interceptors エラーの修正](/ja/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) で扱っています。

**複数プロジェクトのソリューションで生成が黙ってスキップされる。** `DbContext` や EF のクエリを含むすべてのプロジェクトに、それぞれ `Microsoft.EntityFrameworkCore.Tasks` への参照が必要です。この参照は推移的ではありません。また、この統合では別のスタートアップ プロジェクトを使えないため、別プロジェクトのホストから構成されるコンテキストには `IDesignTimeDbContextFactory<TContext>` が必要です。

**PublishAot なしでも iOS で同じモデル構築の例外が出る。** iOS のビルドは自動的に `DynamicCodeSupport=false` を設定するため、.NET MAUI アプリは AOT を有効にしていなくてもこの経路に入ります。[MAUI iOS での NativeAOT モデル構築エラーの修正](/ja/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/) を参照してください。

## 関連記事

- [最初のクエリの前に EF Core のモデルをウォームアップする方法](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)。AOT がまったく不要な場合に `dotnet ef dbcontext optimize` でコンパイル済みモデルを出荷する方法も扱っています。
- [修正: .NET MAUI の iOS ビルドでの Model building is not supported when publishing with NativeAOT](/ja/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/)
- [.NET 11 の Native AOT vs ReadyToRun vs JIT: どれを出荷すべきか](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)。EF Core アプリを AOT に決める前に読む価値があります。
- [修正: EF Core Tools の更新後に発生する MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty'](/ja/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/)
- [修正: The 'interceptors' feature is not enabled in this namespace](/ja/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/)

## 出典

- [dotnet/efcore#38087, `PublishAot` + `EFOptimizeContext` fork bombs the system](https://github.com/dotnet/efcore/issues/38087)
- [dotnet/efcore#38386, デザイン時ビルドから EF のファイル生成を保護する](https://github.com/dotnet/efcore/pull/38386)
- [dotnet/efcore#38403, コマンドライン ビルドでの EF のファイル生成を保護する](https://github.com/dotnet/efcore/pull/38403)
- [dotnet/efcore#35079, EF のターゲットから EFOptimizeContext プロパティを削除する](https://github.com/dotnet/efcore/issues/35079)
- [EF Core の MSBuild タスク](https://learn.microsoft.com/en-us/ef/core/cli/msbuild)
- [EF Core 11 の破壊的変更: MSBuild プロパティ EFOptimizeContext の削除](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [EF Core の NativeAOT サポートとプリコンパイル済みクエリ](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries)
- [NuGet の Microsoft.EntityFrameworkCore.Tasks](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks)
