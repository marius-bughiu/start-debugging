---
title: "修正: EF Core Tools のアップグレード後に発生する MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty'"
description: "Tools 10.0.6 が一致するバージョンの Microsoft.EntityFrameworkCore.Design を取得しなくなったため、dotnet ef が ArgumentIsEmpty で MissingMethodException を投げます。Design を EF Core のバージョンに固定してください。"
pubDate: 2026-09-08
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "dotnet"
  - "dotnet-10"
  - "nuget"
lang: "ja"
translationOf: "2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools"
translatedBy: "claude"
translationDate: 2026-09-08
---

**スタートアッププロジェクト**に、他の EF Core パッケージと同じバージョンに固定した `Microsoft.EntityFrameworkCore.Design` への明示的な `PackageReference` を追加し、リストアしてください。`Microsoft.EntityFrameworkCore.Tools` の 10.0.6、10.0.7、10.0.8 は Design への依存を `>= 8.0.0` まで下げたため、NuGet は EF Core 10 のランタイムの隣で平然と Design 8.0.0 を解決してしまい、デザイン時アセンブリがもう存在しないメソッドを呼び出します。Tools を 10.0.9 以降にアップグレードしても解決します。10.0.9 でフレームワークごとのバージョン整合が復元されたからです。

## 実際のエラー

壊れたパッケージグラフに対して `dotnet ef migrations add` を実行した場合:

```
Build started...
Build succeeded.
System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigration.<>c__DisplayClass0_0.<.ctor>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.<>c__DisplayClass3_0`1.<Execute>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.Execute(Action action)
Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
```

まったく同じパッケージグラフでも、`dotnet ef database update` や `dotnet ef migrations list` ではまったく別の例外になります:

```
System.TypeLoadException: Method 'Identifier' in type 'Microsoft.EntityFrameworkCore.Design.Internal.CSharpHelper' from assembly 'Microsoft.EntityFrameworkCore.Design, Version=8.0.26.0, Culture=neutral, PublicKeyToken=adb9793829ddae60' does not have an implementation.
   at Microsoft.EntityFrameworkCore.Design.DesignTimeServiceCollectionExtensions.<>c__DisplayClass0_0.<AddEntityFrameworkDesignTimeServices>b__0(ServiceCollectionMap services)
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder.TryAddProviderSpecificServices(Action`1 serviceMap)
```

Visual Studio の Package Manager Console では、同じ現象が `Add-Migration` と `Update-Database` で現れます。2 つのメッセージの原因は 1 つです。`TypeLoadException` のほうが有用で、問題のアセンブリのバージョンがメッセージ内に直接出力されます。

## なぜ起きるのか

`Microsoft.EntityFrameworkCore.Design` は、マイグレーションのスキャフォールディングとリバースエンジニアリングを実際に実装しているアセンブリです。`dotnet ef` も Package Manager Console もこれを同梱しておらず、スタートアッププロジェクトの解決済み依存グラフから読み込みます。つまり Design のバージョンは NuGet が選んだものであり、NuGet はすべての制約を満たす最も低いバージョンを選びます。

10.0.5 までは、`Microsoft.EntityFrameworkCore.Tools` は自身のバージョンと同じ下限で `Microsoft.EntityFrameworkCore.Design` への依存を宣言していたため、Tools を参照するだけで一致する Design が引き込まれていました。10.0.6 でその下限が `8.0.0` まで下がりました。この変更は NuGet のカタログから直接読み取れます:

| Tools のバージョン | 公開日 | Design への依存 |
| --- | --- | --- |
| 10.0.5 | 2026-03-12 | `net8.0` -> `[10.0.5, )` |
| 10.0.6 | 2026-04-14 | `net8.0` -> `[8.0.0, )` |
| 10.0.7 | 2026-04-21 | `net8.0` -> `[8.0.0, )` |
| 10.0.8 | 2026-05-12 | `net8.0` -> `[8.0.0, )` |
| 10.0.9 | 2026-06-09 | `net8.0` -> `[8.0.26, )`, `net9.0` -> `[9.0.15, )`, `net10.0` -> `[10.0.9, )` |
| 10.0.10 | 2026-07-14 | 同じ形、`net10.0` -> `[10.0.10, )` |
| 10.0.11 | 2026-08-11 | 同じ形、`net10.0` -> `[10.0.11, )` |

10.0.6 での変更には正当な理由がありました。Tools パッケージは `net8.0` をターゲットとし、`net8.0`、`net9.0`、`net10.0` のプロジェクトから使えることが前提ですが、Design 10.0.x は `net10.0` のアセットしか出荷していないため、高い下限を 1 つだけ置くと古いフレームワークのプロジェクトでリストアが壊れていました。下限を `8.0.0` に下げたことでリストアは直りましたが、EF Core ランタイムが 9.x や 10.x の全員が壊れました。単一の `net8.0` 依存グループが、消費側のすべてのフレームワークに適用されるからです。Tools 10.0.9 では、ターゲットフレームワークごとに 1 つ、計 3 つの依存グループを置くことで正しく解決されました。

この失敗は純粋なバイナリ互換性の破壊です。EF Core 10 の `Check.NotEmpty` は `AbstractionsStrings.ArgumentIsEmpty(object)` を呼びますが、そのリソースクラスの 8.x と 9.x のビルドは異なるシグネチャを公開しています。JIT は `AddMigrationImpl` の最初の実行時に呼び出しを解決し、例外を投げます。

## 最小再現

パッケージ参照 2 つと `DbContext` 1 つで十分です。以下がプロジェクトの全体で、2026-09-08 に SDK 10.0.302 と `dotnet-ef` 10.0.11 で検証しました:

```xml
<!-- SDK 10.0.302. Reproduces the failure exactly as written. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=app.db");
}
```

`dotnet restore` のあと、グラフは次のようになります:

```
$ dotnet list package --include-transitive
   > Microsoft.EntityFrameworkCore              10.0.11
   > Microsoft.EntityFrameworkCore.Abstractions 10.0.11
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

ランタイム側はすべて 10.0.11 で、デザイン時アセンブリだけが 8.0.0 です。この状態で `dotnet ef migrations add Initial` が失敗します。

## 修正方法の詳細

### 1. スタートアッププロジェクトで Design を明示的に固定する

これが EF チームの推奨する修正であり、今後の Tools のリリースが何を宣言しようと動き続ける方法です:

```xml
<!-- SDK 10.0.302, EF Core 10.0.11. Version must match your other EF Core packages. -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

`PrivateAssets=all` はデザイン時アセンブリを発行出力から除外します。だからこそ、素の 1 行ではなくメタデータのブロックを書き出す価値があります。これを入れておけば、Tools が 10.0.6 のままでも `dotnet ef migrations add Initial` は成功します。

**スタートアップ**という語が重要です。`dotnet ef` がビルドして読み込むのはスタートアッププロジェクトであって、`DbContext` を持つプロジェクトではありません。`Data` がコンテキストを持ち `Api` がエントリポイントであるソリューションでは、`Data` の中で Design を固定しても意味がありません。`PrivateAssets=all` がプロジェクト参照を越えた流れを止めるからです:

```
$ dotnet list Api/Api.csproj package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

コマンドは同じ `MissingMethodException` で失敗し続けます。参照を `Api` に移せば通ります。慣習としてデザイン時パッケージをコンテキストのプロジェクトに置いているなら、両方に参照を追加してください。

### 2. または Tools を 10.0.9 以降にアップグレードする

パッケージ参照を追加したくない場合は、Tools パッケージのアップグレードだけでも十分です。10.0.9 でフレームワークごとの整合が復元されているからです:

```
$ dotnet list package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       10.0.9
```

ただし注意点があります。得られるのは Tools パッケージの下限であって、あなたの EF Core のバージョンではありません。Tools 10.0.9 を EF Core 10.0.11 の隣に置くと Design 10.0.9 になり、動作はしますが、自分で選んだわけではないバージョンのずれが残ります。習慣としては修正 1 のほうが優れています。

### 3. または Tools を 10.0.5 に戻す

10.0.5 へのダウングレードは、バージョンが一致する従来の依存関係を復元します。リリースの途中で広範囲にプロジェクトファイルを触れない状況では、有効な緊急停止です。ただし行き止まりでもあります。10.0.5 は数か月ぶんのツール修正より前のバージョンであり、その後どのようにアップグレードしても、修正 1 を併用しない限り壊れた区間に逆戻りします。

### 4. Central Package Management

CPM ではバージョンは `Directory.Packages.props` にあり、規則は同じです。そこで Design を宣言し、スタートアッププロジェクトから参照します。

```xml
<!-- Directory.Packages.props, EF Core 10.0.11 -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.11" />
</ItemGroup>
```

`PackageVersion` のエントリだけではパッケージは追加されません。何かが参照している場合にバージョンを決めるだけです。Design が Tools を通じて推移的にグラフへ入ってくる場合は、`CentralPackageTransitivePinningEnabled` を `true` にすると推移的な Design が宣言済みのバージョンまで引き上げられます。大規模なソリューションでは妥当な第 2 の防御線になります。

## ツールが読み込む Design のバージョンを確認する方法

`dotnet ef --version` を信用してはいけません。これはグローバルツールのバージョンを報告するもので、プロジェクトのグラフとは無関係です:

```
$ dotnet ef --version
Entity Framework Core .NET Command-line Tools
10.0.11
```

プロジェクトが Design 8.0.0 を読み込んでいる最中でも 10.0.11 と表示されます。本当の答えは 2 つのコマンドが教えてくれます。1 つ目は解決されたバージョンと、それを要求した相手を示します:

```
$ dotnet nuget why . Microsoft.EntityFrameworkCore.Design
Project 'EfToolsRepro' has the following dependency graph(s) for
'Microsoft.EntityFrameworkCore.Design':

  [net10.0]
  └── Microsoft.EntityFrameworkCore.Tools (v10.0.6)
      └── Microsoft.EntityFrameworkCore.Design (v8.0.0)
```

`dotnet nuget why` は .NET 9 SDK 以降が必要で、古い Design を引き込んでいるパッケージを特定する最短の方法です。引き込んでいるのが常に Tools とは限りません。古い下限で Design を直接参照しているライブラリがソリューション内にあれば、同じことが起こります。

2 つ目の確認はビルド出力を読みます。ツールが実際に解決の対象とするのはこちらです:

```
$ grep -o '"Microsoft.EntityFrameworkCore.Design/[0-9.]*"' bin/Debug/net10.0/Api.deps.json
"Microsoft.EntityFrameworkCore.Design/8.0.0"
```

Design のアセンブリ自体は `bin` にコピーされない点に注意してください。`deps.json` のエントリを通じて NuGet のグローバルパッケージフォルダーから解決されるため、実行ファイルの隣に DLL を探しても何もわかりません。

## 落とし穴とよく似たエラー

**一部のコマンドは動き続けます。だからこそパッケージの問題を早々に除外してしまいがちです。** Design 8.0.26 が EF Core 10.0.11 の隣にある状態でも、`dotnet ef dbcontext info` はコンテキスト、プロバイダー、データソースを何の文句もなく出力し、`dotnet ef dbcontext script` は正しい SQL を生成します。壊れるのは、食い違った型に触れるコードパスだけです。1 つのコマンドが成功したからといって、ツールのバージョンが揃っていると結論づけないでください。

**スタックトレース内の `AddMigrationImpl` のシグネチャを読んでください。** それ以上の調査なしに、読み込まれている Design のバージョンを特定できます。Design 9.x には 8.x と 10.x にはない `Boolean dryRun` パラメーターがあります:

```
// Design 9.0.15
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace, Boolean dryRun)

// Design 8.0.26
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
```

**"Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design" は原因が隣接した別のエラーです。** こちらは Design が誤ったバージョンで存在しているのではなく、まったく存在しないという意味です。2026-08-11 に公開された `Microsoft.EntityFrameworkCore.Tools` 11.0.0-preview.7.26381.103 が、空の `net10.0` 依存グループを宣言している点は知っておく価値があります。Design への依存はまったくありません。Tools だけを参照する習慣のまま EF Core 11 へアップグレードすると、こちらではなく[スタートアッププロジェクトが Design を参照していないというエラー](/ja/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/)に遭遇します。修正 1 の明示的な固定は、両方をカバーします。

**"Unable to create an object of type 'DbContext'" は無関係です。** これはデザイン時ファクトリまたはホストビルダーの問題であって、バージョンの不一致ではありません。スタックトレースに `DbContextActivator` や欠落した `IDesignTimeDbContextFactory` が出てくるなら、このページではなく[DbContext 生成のトラブルシューティング](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)が必要です。

**デザイン時ではなくアプリケーションの実行時に出る `MissingMethodException`。** 例外が `dotnet ef` ではなく Web アプリケーションから発生している場合、原因は通常 Design パッケージではなく、別のメジャーバージョンの EF Core に対してコンパイルされたライブラリです。ただし診断方法は同じで、`Microsoft.EntityFrameworkCore` に対して `dotnet nuget why` を実行し、古い下限を持つパッケージを探してください。

**マイグレーションバンドルも問題を引き継ぎます。** `dotnet ef migrations bundle` は実行ファイルを構築するために同じデザイン時スタックを走らせるため、壊れたグラフからは古いモデルに基づくバンドルが生成されたり、そのまま失敗したりします。本番に対して実行する成果物を生成する前に参照を直してください。手順は[マイグレーションバンドルによるデプロイの解説](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)にあります。

## EF Core 11 へのアップグレードで行うこと

EF Core 11 は 2026 年 9 月時点で preview であり、2026 年 11 月に .NET 11 とともに出荷されます。このマシンにある SDK は 10.0.302 だけなので、上記のコマンド出力はすべて EF Core 11 ではなく 10.0.11 に対して得たものです。今日 NuGet のカタログから検証できるのは依存関係の形です。Tools 11.0.0-preview.7 にはパッケージ依存が 1 つもありません。`Microsoft.EntityFrameworkCore.Design` は常に自分で宣言するパッケージとして扱い、他の EF Core パッケージとまったく同じバージョンに揃えてください。そうすれば、Tools が何を宣言していようとこの種の失敗は起こり得なくなります。[より広範な .NET 11 への移行作業](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)を始める前にやっておく価値のある 1 行の変更です。アップグレードの途中で失敗したマイグレーションコマンドを NuGet の下限に結びつけるのは、非常に難しいからです。

この一件が示す一般則は次のとおりです。`using` することのないものも含め、すべての `Microsoft.EntityFrameworkCore.*` パッケージを 1 つのバージョンに揃えてください。EF Core は自身のアセンブリ間でメジャーバージョンを混在させることをサポートしておらず、NuGet が混在したグラフを静かに解決しても、ツールは何も警告してくれません。

## 関連記事

- [修正: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/ja/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/)
- [修正: dotnet tool install --global dotnet-ef がエラーになる](/ja/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [修正: dotnet ef migrations add が "Unable to create an object of type DbContext" で失敗する](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [マイグレーションバンドルで EF Core 11 のマイグレーションを本番に適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [修正: EF Core 11 の "The model for context 'X' has pending changes"](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)

## 参考資料

- [dotnet/efcore#38124、アナウンス: Microsoft.EntityFrameworkCore.Tools 10.0.6 における Design パッケージ依存の変更](https://github.com/dotnet/efcore/issues/38124)
- [dotnet/efcore#38107、Add-Migration の例外: AbstractionsStrings.ArgumentIsEmpty](https://github.com/dotnet/efcore/issues/38107)
- [dotnet/efcore#38123、38107 の重複としてクローズ、TypeLoadException のバリアント](https://github.com/dotnet/efcore/issues/38123)
- [NuGet 上の Microsoft.EntityFrameworkCore.Tools、バージョンごとの依存グループ](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tools/)
- [.NET CLI 向け Entity Framework Core ツールリファレンス](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [dotnet nuget why コマンドリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-why)
