---
title: "解決: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design"
description: "Microsoft.EntityFrameworkCore.Design は DbContext を含むプロジェクトではなく、dotnet ef がビルドするスタートアッププロジェクトに追加し、階層化されたソリューションでは -s を渡します。"
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
lang: "ja"
translationOf: "2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design"
translatedBy: "claude"
translationDate: 2026-07-30
---

パッケージは **スタートアッププロジェクト**、つまり `dotnet ef` がビルドして実行するプロジェクトに追加してください。`DbContext` を持つクラスライブラリではありません: `dotnet add package Microsoft.EntityFrameworkCore.Design`。階層化されたソリューションでは、`-s ./src/Api` でそれがどのプロジェクトなのかをツールに伝えてください。`Microsoft.EntityFrameworkCore.Tools` 10.0.6 以降、Design パッケージは自動的には取り込まれません。

```text
Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design. This package is required for the Entity Framework Core Tools to work. Ensure your startup project is correct, install the package, and try again.
```

この記事は EF Core 11.0.0-preview.6 (`11.0.0-preview.6.26359.118`、2026-07-14)、.NET 11 SDK preview 6、C# 14 を対象に書いています。ツールの挙動が異なる箇所については EF Core 9 と 10 についても触れます。現在の安定版ラインは 10.0.10 です。エラー文字列そのものは EF Core 2.1 から変わっていませんが、パッケージが無いとツールが判断する **仕組み** は EF Core 10 で大きく変わりました。そしてそれが、以下のどの対処があなたに当てはまるかを決めます。

## ツールが実際に訴えていること

このメッセージは `.csproj` の静的なチェックのように読めます。違います。これは読み込みの失敗であり、事後に報告されているだけです。

`dotnet ef migrations add Init` を実行したときの実際の流れは次のとおりです。

1. `dotnet-ef` がスタートアッププロジェクトのメタデータビルドを実行します。EF Core 10 と 11 では `dotnet build --no-restore /getProperty:AssemblyName /getProperty:OutputPath ... /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems` です。
2. 返ってきた `RuntimeCopyLocalItems` を走査し、`Microsoft.EntityFrameworkCore.Design` を含む `FullPath` を探して、その絶対パスを保持します。
3. スタートアッププロジェクトをビルドし、その後 `ef.dll` を呼び出します。見つけたパスを `--design-assembly` として渡し、あわせてプロジェクトの `.deps.json` と `.runtimeconfig.json` も渡して、ツールのプロセスがアプリケーションのアセンブリ読み込み挙動を再現できるようにします。
4. `ef.dll` は `Microsoft.EntityFrameworkCore.Design.dll` を `AssemblyLoadContext` に読み込みます。パスを受け取っていればそのパスから、そうでなければアセンブリ名で読み込みます。
5. 手順 4 が `FileNotFoundException` をスローし、見つからないアセンブリ名がちょうど `Microsoft.EntityFrameworkCore.Design` だった場合、ツールはそれを飲み込み、スタートアップアセンブリの名前を添えて上記の親切なメッセージを出力します。

ここから 2 つの帰結が直接導かれます。1 つ目は、メッセージに出てくるプロジェクトは **スタートアップ** プロジェクトだということです。その名前に驚いたのなら、問題はパッケージの欠落ではなく手順 1 にあります。2 つ目は、存在はしていてもコピーローカルなランタイムアセットを生まない `PackageReference` は手順 2 から見えないということです。だからこそ、`.csproj` をイシュー報告に貼り付けて「パッケージはちゃんとある」と主張する人が出てきます。

EF Core 9 以前は違う動きでした。`dotnet-ef` は埋め込みの `EntityFrameworkCore.targets` ファイルをプロジェクトに注入し、`ef.dll` はスタートアッププロジェクトの `.deps.json` を通じてアセンブリ名から Design を解決していました。この違いは、後述する 1 つの特定の失敗パターンで意味を持ちます。

## 最小の再現

2 プロジェクト構成の階層化されたソリューションです。このエラーを最も多く生む構成です。

```text
Shop.sln
  src/Shop.Api/Shop.Api.csproj          <- startup project, has Program.cs
  src/Shop.Data/Shop.Data.csproj        <- has AppDbContext and Migrations/
```

```xml
<!-- src/Shop.Data/Shop.Data.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

```xml
<!-- src/Shop.Api/Shop.Api.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shop.Data/Shop.Data.csproj" />
  </ItemGroup>
</Project>
```

```bash
# .NET 11 SDK preview 6
cd src/Shop.Data
dotnet ef migrations add Init -s ../Shop.Api
# Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design.
```

Design パッケージは参照されています。間違ったプロジェクトで参照されており、そこから移動することはできません。

## 対処 1: スタートアッププロジェクトで Design を参照する

ほぼすべてのケースでこれが答えです。スタートアッププロジェクトのディレクトリから実行してください。

```bash
# .NET 11 SDK preview 6, EF Core 11
dotnet add src/Shop.Api/Shop.Api.csproj package Microsoft.EntityFrameworkCore.Design
```

Design は nuspec で `developmentDependency` と指定されているため、NuGet は次のように書き込みます。

```xml
<!-- src/Shop.Api/Shop.Api.csproj - EF Core 11.0.0-preview.6 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

この `IncludeAssets` のリストを注意深く読んでください。問題の両側面がここで説明できます。

- `runtime` はリストに **含まれています**。これが `Microsoft.EntityFrameworkCore.Design.dll` を `bin` フォルダーに置き、ひいては `RuntimeCopyLocalItems` に載せるものであり、ツールが探しているのはまさにこれです。削除しないでください。
- `compile` はリストに **含まれていません**。アプリケーションコードから Design の型を参照することはできませんが、これは意図的です。設計時のパッケージであり、出荷するコードがこれに束縛されるべきではありません。
- `PrivateAssets: all` は、その参照が **推移的に流れない** ことを意味します。データプロジェクトにパッケージを置くだけでは足りず、対処 1 が独立した手順として存在するのは、まさにこのためです。

## 対処 2: 正しいスタートアッププロジェクトをツールに指し示す

エラーに出るプロジェクト名が意図したプロジェクトでない場合、パッケージは正しく、ターゲットが間違っています。EF Core CLI のドキュメントにあるルールはこうです。*ターゲットプロジェクト* はファイルが書き込まれる先 (`--project`、`-p`、既定はカレントディレクトリ)、*スタートアッププロジェクト* は接続文字列とモデルを調べるためにツールがビルドして実行するもの (`--startup-project`、`-s`、こちらも既定はカレントディレクトリ) です。

```bash
# EF Core 11, run from the repository root
dotnet ef migrations add Init -p src/Shop.Data -s src/Shop.Api
```

これを毎回のコマンドで打たなければならないせいで、チームはエラーを消すためだけに間違ったプロジェクトへパッケージを取り付けてしまいます。EF Core 11 はまさにこのための構成ファイルを追加しました。カレントディレクトリから上へたどり、最初に見つかった `.config/dotnet-ef.json` が使われます。

```json
{
  "project": "src/Shop.Data",
  "startupProject": "src/Shop.Api"
}
```

相対パスは `.config` ディレクトリの親ディレクトリを基準に解決されるので、このファイルをリポジトリのルートに置けば、どのサブディレクトリからの `dotnet ef` 呼び出しでも読み込まれます。明示的なコマンドラインオプションは引き続きファイルより優先されます。受け付けられるのはドキュメント化されたキーだけです: `project`、`startupProject`、`context`、`framework`、`configuration`、`runtime`、`verbose`、`noColor`、`prefixOutput`。未知のキーは警告ではなく致命的なエラーなので、`startProject` のような打ち間違いはコマンド自体を失敗させます。

## 対処 3: データプロジェクトの参照を流そうとするのをやめる

ときどきこの裏技を見つける人がいて、実際に動きます。

```xml
<!-- src/Shop.Data/Shop.Data.csproj - do not do this -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>none</PrivateAssets>
</PackageReference>
```

`PrivateAssets` を `none` にすると参照は `Shop.Api` へ推移的に流れ、エラーは消えます。同時に、データ層を参照するすべてのプロジェクトへ Roslyn を引きずり込みます。Design は `Microsoft.CodeAnalysis.CSharp` と `Microsoft.CodeAnalysis.CSharp.Workspaces` (10.0.10 パッケージでは 5.0.0 以降) に依存し、さらに `Microsoft.Build.Framework`、`Humanizer.Core`、`Mono.TextTemplating`、`Newtonsoft.Json` にも依存しています。ひとつの `.csproj` の 1 行を節約するために、コード生成のツールチェーンをランタイムの依存グラフへ持ち込んだことになります。代わりに、スタートアッププロジェクトで明示的に参照してください。

## Tools 10.0.6 以降のバージョン不一致のパターン

`Microsoft.EntityFrameworkCore.Tools` (Package Manager Console のモジュール) をインストールすれば Design も付いてくる、という前提はもう成り立ちません。10.0.6 より前は、Tools は一致するバージョンの Design に依存していました。Design 10.0.x は `net10.0` のみを対象とするため、`net8.0` を対象とするプロジェクトで復元が壊れていました。そこで EF チームは Tools 10.0.6 で下限を Design 8.0.0 まで下げました。EF Core 11 のブランチでは、`Microsoft.EntityFrameworkCore.Tools` は Design への `PackageReference` を一切持っていません。

実務上の結果として、NuGet は下限を満たす古い Design を解決できるようになり、症状はこのエラーではなく次のようになります。

```text
System.MissingMethodException: Method not found ...
System.TypeLoadException: Could not load type ...
```

対処は、バージョンを一致させた明示的な参照です。中央パッケージ管理を使っているなら、一度だけ固定してください。

```xml
<!-- Directory.Packages.props - EF Core 11.0.0-preview.6 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

中央パッケージ管理にはここ特有の罠もあります。`Directory.Packages.props` の `PackageVersion` エントリは参照ではありません。スタートアッププロジェクトには依然として `Version` 属性なしの `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" />` が必要です。`dotnet-ef` 自体も歩調を合わせてください。10.x のツールが 11.x の Design アセンブリを駆動するのは別種の失敗になります。

```bash
dotnet tool update --global dotnet-ef --version 11.0.0-preview.6.26359.118
```

## 参照がちゃんとあるのに失敗するとき

ツールが実行しているのと同じクエリを自分で実行し、答えを直接見てください。`-getItem` スイッチには .NET 8 SDK 以降が必要です。

```bash
# .NET 11 SDK preview 6
dotnet build src/Shop.Api/Shop.Api.csproj --no-restore \
  /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems
```

その JSON に `Microsoft.EntityFrameworkCore.Design.dll` が無ければ、`.csproj` に何が書かれていようと EF Core 10 と 11 からは見えません。よくある原因は、アナライザーだけのパッケージから誰かがコピーしてきたアセットフローの属性です。

- Design の参照に付いた `<ExcludeAssets>runtime</ExcludeAssets>` または `<ExcludeAssets>all</ExcludeAssets>`。
- `runtime` を落とした `<IncludeAssets>` のリスト、たとえば `build; analyzers`。
- `<PackageReference ... GeneratePathProperty="true" ExcludeAssets="all" />`。パッケージの tools ディレクトリだけが欲しいときに現れるパターンです。

`-v` を付けると、何を解決したのかについてツール自身の説明が得られます。詳細出力にはメタデータビルドの完全なコマンドと、選ばれた Design アセンブリのパスが出力されるので、当て推量が 2 行の診断に変わります。

```bash
dotnet ef migrations add Init -s src/Shop.Api -v
```

正しい `.csproj` でも本当に足りなかった唯一のケースはこれです。EF Core 9 と特定の .NET 9 SDK ビルドの組み合わせで、[dotnet/sdk#45259](https://github.com/dotnet/sdk/pull/45259) が `PrivateAssets="all"` の付いた `PackageReference` エントリを `.deps.json` へ出力しなくなりました。EF Core 9 の `ef.dll` はそのファイルを通じてアセンブリ名から Design を解決していたため、ツールはパッケージを見失いました ([dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265)。その重複のひとつが [#35544](https://github.com/dotnet/efcore/issues/35544) です)。EF Core 10 の [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527) で修正され、アプリのベースパスを探索する `AssemblyLoadContext.Resolving` ハンドラーが登録されるようになりました。前述の明示的な `--design-assembly` パスと併用されます。EF Core 9 のプロジェクトでこれに当たっているなら、グローバルの `dotnet-ef` ツールを 10 以降に更新するだけで十分です。ツールは、駆動するランタイムパッケージのバージョンから独立しているからです。

## 落とし穴とよく似た別物

**パッケージ無しで生成されたプロジェクト。** 初期の .NET 11 preview 3 SDK ビルドは、`dotnet new mvc --auth Individual` のプロジェクトを Design 参照なしで生成していました。preview 2 からのリグレッションで、[dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750) として記録されています。SDK `11.0.100-preview.3.26166.111` 以降は再現しなくなりました。その期間に生成されたプロジェクトなら原因はテンプレートであり、必要なのは対処 1 だけです。

**`netstandard2.0` のクラスライブラリをスタートアッププロジェクトにしている。** ツールはアプリケーションコードを実行する必要があり、それには実際のランタイムが要りますが、.NET Standard は実装ではなく仕様です。Design を追加しても解決しません。ライブラリを参照する使い捨てのコンソールプロジェクトを作り、それを `-s` に指定してください。

**プラットフォーム固有のターゲットフレームワーク。** `net11.0-android` や `net11.0-ios` では、プラットフォーム固有のフレームワークについての別のメッセージが出ます。ドキュメント上の答えは `IDesignTimeDbContextFactory<TContext>` を実装し、ツールがアプリを起動しなくて済むようにすることです。

**詳細出力に出る `NETSDK1004`。** メタデータビルドは `--no-restore` で走ります。プロジェクトが一度も復元されていない場合、`dotnet-ef` はパッケージの欠落ではなく復元が必要であると報告します。`dotnet restore` を実行してから再試行してください。

**複数ターゲット。** `dotnet-ef` は最初のターゲットフレームワークを選び、自分自身を再呼び出しします。Design が特定の TFM に条件付けされていて、最初のものがそれでない場合は、`--framework net11.0` を明示的に渡してください。

**`Unable to create an object of type 'AppDbContext'`。** 別のエラー、別の原因です。Design アセンブリの読み込みは成功し、その後でツールがコンテキストのインスタンスを作れなかったのです。これは [設計時の DbContext 探索についてのガイド](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) で扱っています。

**CI コンテナー。** `dotnet/aspnet` ではなく `dotnet/sdk` イメージを使い、`dotnet ef` の呼び出しの前に `dotnet tool install --global dotnet-ef` を実行してください。パイプラインがマイグレーションの作成ではなく適用だけを必要とするなら、ツールは完全に省いてマイグレーションバンドルを出荷してください。

## この問題に一度も当たらない構成

次の 4 つのルールで、このエラーはソリューションから消えます。

1. `Microsoft.EntityFrameworkCore.Design` はスタートアッププロジェクトが参照しており、`PrivateAssets` と `IncludeAssets` は `dotnet add package` が書く既定のままである。
2. プロバイダーのパッケージ (`Microsoft.EntityFrameworkCore.SqlServer`、`Npgsql.EntityFrameworkCore.PostgreSQL` など) がスタートアッププロジェクトから到達可能である。データプロジェクト経由の推移的な到達で問題ありません。
3. EF Core のすべてのパッケージバージョンと `dotnet-ef` ツールのバージョンが一致しており、できれば `Directory.Packages.props` で固定されている。
4. `.config/dotnet-ef.json` が `project` と `startupProject` を記録しており、誰も `-p` と `-s` を覚えなくてよい。

## 関連記事

- [設計時ツールがなぜ DbContext のインスタンスを作れないのか](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)：このエラーを直した直後に当たるエラーを扱っています。
- [マイグレーションバンドルでスキーマ変更を出荷する](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)：このパッケージが同じく前提となる設計時コマンドであり、`dotnet-ef` を本番マシンから遠ざける方法です。
- [PendingModelChangesWarning が実際に検出しているもの](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)：マイグレーションが動き出したあとに CI が次に知らせてくるものです。
- [DbContextOptions を正しく登録する](/ja/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)：階層化されたソリューションで似た見え方をする、依存性注入側の失敗を説明しています。
- [EF Core 6 から EF Core 11 への破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)：アップグレード前に知っておく価値のあるツール周りの変更を含みます。

## 参考資料

- [EF Core ツールリファレンス (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)。ターゲットプロジェクトとスタートアッププロジェクトのルール、および EF Core 11 の `dotnet-ef.json` 構成ファイルを含みます。
- [設計時ツールのアーキテクチャ](https://learn.microsoft.com/en-us/ef/core/miscellaneous/internals/tools)。`dotnet-ef` から `ef.dll`、そして `EFCore.Design.dll` へと続く連鎖について。
- [`src/dotnet-ef/Project.cs`](https://github.com/dotnet/efcore/blob/main/src/dotnet-ef/Project.cs) と [`src/ef/Commands/ProjectCommandBase.cs`](https://github.com/dotnet/efcore/blob/main/src/ef/Commands/ProjectCommandBase.cs)。`RuntimeCopyLocalItems` の探索と、`FileNotFoundException` がこのメッセージに変わる正確な地点について。
- [お知らせ: Microsoft.EntityFrameworkCore.Tools 10.0.6 における Design パッケージ依存関係の変更](https://github.com/dotnet/efcore/issues/38124)。
- [dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265) と [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527)。`.deps.json` と `PrivateAssets` のリグレッションについて。
- [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750)。.NET 11 preview 3 のテンプレートのリグレッションについて。
