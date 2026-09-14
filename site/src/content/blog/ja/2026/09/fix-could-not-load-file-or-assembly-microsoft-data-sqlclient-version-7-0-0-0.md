---
title: "修正方法: EF Core の更新後に発生する Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'"
description: "EF Core 11 は Microsoft.Data.SqlClient 7.0.0.0 に対してコンパイルされていますが、リストアまたはデプロイで 6.x のコピーが採用されてしまっています。古い SqlClient の固定指定を削除し、出力全体を再デプロイしてください。"
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0"
translatedBy: "claude"
translationDate: 2026-09-14
---

**結論:** `Microsoft.EntityFrameworkCore.SqlServer` 11 (`11.0.0-rc.1.26425.128`、.NET 11 RC 1 で確認) は `Microsoft.Data.SqlClient, Version=7.0.0.0` に対してコンパイルされており、7.0.2 以降のパッケージを必要とします。この例外は、プロセスが 6.x の SqlClient を見つけたか、まったく見つけられなかったことを意味します。残っている `Microsoft.Data.SqlClient` 6.x の参照 (または `Directory.Packages.props` 内の `PackageVersion`) を削除し、`NU1605` に対する `NoWarn` をすべて取り除き、リビルドしたうえで、`runtimes/` を含む出力フォルダー全体を再デプロイしてください。

この記事の残りでは、6.x のコピーがどこから来るのか、それを 1 分以内に見つける方法、そして誤った修正に導きがちな 2 つの類似エラーを説明します。以下のシナリオはすべて、macOS 上で .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) と SDK 10.0.302 を使って再現しました。発生させるのにデータベースは不要です。

## エラーの発生状況

EF Core はコンテキストを登録した時点では SqlClient に触れません。読み込みが起きるのは、プロバイダーが初めて型マッピングを構築するとき、つまり最初のクエリ、`SaveChanges`、`MigrateAsync`、または `Database.GetDbConnection()` のときです。私の再現環境で出力された例外チェーンを、外側から順に示します。

```text
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerTypeMappingSource' threw an exception.
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerVectorTypeMapping' threw an exception.
System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5'. The system cannot find the file specified.
```

ログに外側の `TypeInitializationException` しか表示されない場合は、`InnerException` を 2 回たどってください。一番下の `FileNotFoundException` が本当のエラーです。

始める前に知っておくべきことが 1 つあります。`Version=7.0.0.0` は **アセンブリ** バージョンであり、パッケージバージョンではありません。SqlClient はメジャーライン内のすべてのリリースで `AssemblyVersion` を `Major.0.0.0` に固定しているため、7.0.3 パッケージに含まれる DLL のアセンブリバージョンは `7.0.0.0` (ファイルバージョンは `7.0.3.26253`) です。メンテナーは [dotnet/SqlClient#4310](https://github.com/dotnet/SqlClient/issues/4310) でこれが意図的なものだと認めています。7.x のパッケージであればどれでもこの参照を満たします。"ぴったり 7.0.0" を探し回る必要はありません。

## この問題が発生する理由

ランタイムはアセンブリバージョンでバインドし、ロールフォワードのみを行い、決してロールバックしません。EF Core 11 が `7.0.0.0` を要求し、プロービングパス上にある唯一の `Microsoft.Data.SqlClient.dll` が 6.x のビルド (アセンブリバージョン `6.0.0.0`) である場合、読み込みは失敗します。しかも、`.deps.json` が指しているまさにそのパスに 6.x のファイルが存在していても、"cannot find the file specified" という誤解を招くメッセージで失敗します。これは明示的にテストしました。出力内の 7.0.2 の DLL を 6.1.6 の DLL で上書きすると、まったく同じメッセージになります。

NuGet パッケージ内のアセンブリメタデータから直接読み取った、各パッケージのコンパイル対象は次のとおりです。

| パッケージ | SqlClient パッケージへの依存関係 | DLL 内のアセンブリ参照 |
| --- | --- | --- |
| `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10, 10.0.11, 10.0.12 | `>= 6.1.x` (10.0.12: `>= 6.1.6`) | `Microsoft.Data.SqlClient 6.0.0.0` |
| `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 | `>= 7.0.2` | `Microsoft.Data.SqlClient 7.0.0.0` |

つまり EF Core 10 では、プロバイダー自身が 7.0.0.0 を要求することはありません。EF Core 11 では常に要求します。それでも 6.x のコピーが採用されてしまう経路を、私が目にする頻度の高い順に挙げます。

1. **`Microsoft.Data.SqlClient` 6.x への直接参照が残っており、ダウングレード警告が抑制されている。** EF Core 8 から 10 のプロジェクトの多くは、修正や Entra ID サポートを取り込むために SqlClient への明示的な参照を追加していました。EF を上げた後、その固定指定はダウングレードになります。NuGet はこれを `NU1605` として報告し、SDK はこれをエラーとして扱います。ただし、以前の競合が原因でプロジェクトに `<NoWarn>NU1605</NoWarn>` が入っている場合は別です。
2. **デプロイで DLL が欠落するか置き換えられる。** SqlClient にはポータブルな実装がありません。本物のアセンブリは `runtimes/unix/lib/net9.0/` と `runtimes/win/lib/net9.0/` の下にあります。`bin/` のルートにある `*.dll` だけを取り込む Dockerfile やコピースクリプト、あるいは古いフォルダーの上に新しいビルドを展開する手順では、アプリに 7.x の SqlClient が存在しない状態になります。
3. **プラグインホストがデータレイヤーを動的に読み込む。** ホストプロセスの `.deps.json` には SqlClient のエントリがないため、既定の読み込みコンテキストではプラグインの依存関係を解決できません。

## 最小限の再現

SqlClient を固定指定した状態で EF Core 10 を使っていたコンソールアプリを、EF Core 11 RC 1 に更新したものです。ビルドエラーを実行時クラッシュに変えてしまうのは `NoWarn` の行です。

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <NoWarn>$(NoWarn);NU1605</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
    <PackageReference Include="Microsoft.Data.SqlClient" Version="6.1.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<ShopDb>()
    .UseSqlServer("Server=localhost;Database=Shop;User ID=sa;Password=x;TrustServerCertificate=True")
    .Options;

using var db = new ShopDb(options);
// Throws the FileNotFoundException above; no server connection is attempted.
Console.WriteLine(db.Database.GetDbConnection().GetType().Assembly.GetName());

class ShopDb(DbContextOptions<ShopDb> options) : DbContext(options);
```

`NoWarn` の行を削除すると、代わりにリストアの段階でビルドが止まります。これが望ましい動作です。

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to 6.1.6. Reference the package directly from the project to select a different version.
error NU1605:  app -> Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128 -> Microsoft.Data.SqlClient (>= 7.0.2)
error NU1605:  app -> Microsoft.Data.SqlClient (>= 6.1.6)
```

固定指定を取り除くと、同じプログラムは `Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5` を出力します。

## 修正方法の詳細

### 1. 6.x のコピーを持ち込んでいるのは誰かを突き止める

推測はしないでください。クラスライブラリではなく、スタートアッププロジェクトの依存関係グラフを NuGet に問い合わせます。

```bash
# .NET SDK 10.0.302 or .NET 11 RC 1 SDK
dotnet nuget why src/Shop.Api/Shop.Api.csproj Microsoft.Data.SqlClient
dotnet list src/Shop.Api/Shop.Api.csproj package --include-transitive
```

`dotnet nuget why` はターゲットフレームワークごとにツリーを出力するため、6.x への直接参照や、それを引き込んでいるパッケージが一目でわかります。次に、ランタイム向けに実際に書き出された内容を確認します。ホストが読むのはそちらだからです。

```bash
# .NET 11 RC 1 SDK
grep -A3 '"Microsoft.Data.SqlClient/' src/Shop.Api/bin/Release/net11.0/Shop.Api.deps.json
```

`.deps.json` に `7.0.x` と書かれているのにアプリがまだ失敗する場合、問題はリストアではなくデプロイ (ステップ 4) にあります。

### 2. SqlClient の固定指定を削除するか引き上げる

コード内に特定の SqlClient バージョンを必要とする箇所がなければ、直接参照を削除し、EF Core がビルド時に使ったバージョンを持ち込ませてください。明示的な指定を残したい場合は、現在の 7.x に引き上げます。

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <!-- Was 6.1.6. Any 7.x works; 7.0.3 is the latest stable at the time of writing. -->
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

[Central Package Management](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) と推移的な固定指定を使っている場合、固定指定は `Directory.Packages.props` にあり、リストアエラーのコードも異なります。

```text
error NU1109: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to centrally defined 6.1.6. Update the centrally managed package version to a higher version.
```

`PackageVersion` エントリそのものを更新してください。

```xml
<!-- .NET 11 RC 1, Directory.Packages.props -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <PackageVersion Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

### 3. NU1605 の抑制をやめる

`Directory.Build.props` も含めて、ソリューション全体で `NoWarn` 内の `NU1605` を検索してください。通常のビルドでこの問題が実行時まで到達してしまう理由は、この抑制しかありません。これを取り除けば、次に誰かがダウングレードを持ち込んだとき、本番環境でのクラッシュではなく、正確なパッケージパスを示すリストアエラーが出るようになります。

### 4. `runtimes/` を含む出力全体を再デプロイする

RID を指定しないフレームワーク依存のビルドでは、SqlClient の本物の実装は `runtimes/<os>/lib/net9.0/` の下にあり、`.deps.json` はそこを指しています。正常に動作するビルドからそのファイル 1 つだけを削除したところ同じ `FileNotFoundException` が発生し、`runtimes/` フォルダー全体を削除しても同じ結果になりました。Dockerfile やパイプラインが選択的にコピーしている場合は、publish フォルダー全体をコピーするように切り替えてください。

```dockerfile
# .NET 11 RC 1 images
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/Shop.Api/Shop.Api.csproj -c Release -r linux-x64 --self-contained false -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

RID を指定して publish すると (`-r linux-x64`)、プラットフォーム固有の SqlClient がルートにフラット化され、`Microsoft.Data.SqlClient.Extensions.Abstractions.dll` と `Microsoft.Data.SqlClient.Internal.Logging.dll` の隣に配置されるため、レイアウトがずっと壊れにくくなります。IIS、Azure App Service の zip デプロイ、xcopy デプロイでは、クリーンなフォルダーにデプロイしてください。そうすれば、前回のリリースの 6.x DLL が新しい `.deps.json` の隣に残ることはありません。`dotnet build` と `dotnet publish` のどちらの出力を配布すべきか迷っている場合は、[両者の違い](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) がここで重要になります。

### 5. Entra ID を使っている場合は Azure 拡張を追加する

SqlClient 7.0 への移行は、[EF Core 11 の破壊的変更](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes) で中程度の影響がある変更として挙げられています。Entra ID 認証 (`Active Directory Default`、マネージド ID、サービスプリンシパル) はコアパッケージから外されました。読み込みエラーを修正した後、これを使う接続文字列にはもう 1 つ参照が必要です。

```xml
<!-- .NET 11 RC 1, Microsoft.Data.SqlClient 7.x -->
<PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.3" />
```

このパッケージは `Microsoft.Data.SqlClient` と同じバージョンに揃えてください。7.0.2 以降、SqlClient、`Extensions.Azure`、`Extensions.Abstractions` は足並みを揃えてリリースされており、SqlClient 7.0.2 は `Extensions.Abstractions` を `[7.0.2, 8.0.0)` の範囲で要求します。NuGet には Azure パッケージの 7.0.0 は存在せず、バージョンは 1.0.0、7.0.2、7.0.3 と続きます。そのため、ドキュメントのスニペットからコピーした `Version="7.0.0"` はそのバージョンぴったりには解決されません。パッケージがない場合、7.0 はパッケージ名を示す対処しやすいエラーをスローするので、途方に暮れることはありません。[EF Core 6 から 11 への移行ガイド](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) では、SqlClient に起因する他の変更と合わせてこの点を扱っています。

### 6. プラグインホスト: `AssemblyLoadContext` を通して読み込む

EF Core への参照を持たないホストが `Assembly.LoadFrom` でデータレイヤーを読み込む場合、ホストの既定のコンテキストには SqlClient の `.deps.json` エントリがありません。[#4310](https://github.com/dotnet/SqlClient/issues/4310) でのメンテナーの回答は、標準的なプラグインパターンです。プラグインを `<EnableDynamicLoading>true</EnableDynamicLoading>` 付きでビルドし、プラグイン自身の `.deps.json` を読み取るコンテキストを通して読み込みます。

```csharp
// .NET 11 RC 1
using System.Reflection;
using System.Runtime.Loader;

sealed class PluginLoadContext(string pluginPath) : AssemblyLoadContext(isCollectible: false)
{
    private readonly AssemblyDependencyResolver _resolver = new(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        var path = _resolver.ResolveAssemblyToPath(name);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
    {
        var path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}

// var asm = new PluginLoadContext(pluginPath).LoadFromAssemblyPath(pluginPath);
```

私のテストでは、同じプラグインが `Assembly.LoadFrom` では失敗し、このコンテキストを通すと `Microsoft.Data.SqlClient, Version=7.0.0.0` を問題なく読み込みました。リゾルバーは特に SqlClient にとって重要です。要求をルートレベルのプレースホルダーアセンブリではなく、正しい `runtimes/<os>/` のファイルにマッピングしてくれるからです。

## 落とし穴と類似エラー

**"でも、まだ EF Core 10 を使っています。"** その場合、7.0.0.0 を要求しているのは EF ではありません。10.0.10 から 10.0.12 までのプロバイダー DLL はすべて `6.0.0.0` を参照しています。10.0.10 から 10.0.11 に移行した後にこのエラーを報告した [dotnet/efcore#38845](https://github.com/dotnet/efcore/issues/38845) が、再現なしでクローズされたのはそのためです。グラフ内の別の何かが 7.x に対してコンパイルされています。よくある発生源は Aspire です。`Aspire.Microsoft.EntityFrameworkCore.SqlServer` 13.5.3 は `Microsoft.Data.SqlClient >= 7.0.1` と EF Core 10.0.11 の両方に同時に依存しているため、Aspire のサービスで `dotnet nuget why` を実行すると、EF Core 10 のアプリの下で SqlClient が 7.0.1 に解決されているのがわかります。この組み合わせは問題ありません。私のテストでは、EF Core 10.0.12 は SqlClient 7.0.0 と 7.0.3 のどちらでも型マッピングを初期化し、`SqlConnection` を作成できました。壊れるのは 6.x の固定指定か古いデプロイが採用された場合だけで、その場合はステップ 1 から 4 に戻ることになります。

**`Could not load type 'Microsoft.Data.SqlClient.SqlAuthenticationMethod' from assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'`。** これはバージョン文字列が同じだけの別の障害です。ファイルは正常に読み込まれましたが、6.x に対してコンパイルされたライブラリ (よくあったのは SQL Server Management Objects 181.x) が、7.0.0 で `Microsoft.Data.SqlClient.Extensions.Abstractions` に移動した型を探しています。SqlClient 7.0.1 で `SqlAuthenticationMethod`、`SqlAuthenticationProvider` と関連する 3 つの型に型フォワードが追加されたため ([#4117](https://github.com/dotnet/SqlClient/pull/4117))、SqlClient を 7.0.1 以降に更新すれば解決します。

**`PlatformNotSupportedException: Microsoft.Data.SqlClient is not supported on this platform.`** ファイルは見つかりましたが、間違ったファイルでした。パッケージのルートの `lib/` にあるアセンブリはプレースホルダーで、動作する実装は `runtimes/` の下にあります。私のプラグインホストは `Assembly.LoadFrom` でまさにこのエラーに遭遇しました。プラグインのルートフォルダーにプレースホルダーが入っていたためです。修正方法は、ステップ 6 と同じ `AssemblyLoadContext` を使うか、RID 固有のアセットを含めて完全にデプロイすることです。

**メッセージ内のアセンブリ名が異なる場合。** エラーに自分のライブラリや別のパッケージの名前が出ている場合、上記の SqlClient 固有の内容は当てはまりません。[発行したアプリでの "Could not load file or assembly" エラー](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) の一般的な対処法で、ホストのトレースとトリミングを扱っています。アプリではなく `dotnet ef` が失敗する、EF ツール側のバージョン不一致については、[EF Core Tools のアップグレード後の MissingMethodException](/ja/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/) を参照してください。

## 関連記事

- [Directory.Packages.props で .NET ソリューションを Central Package Management に移行する](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)
- [EF Core 6 から EF Core 11 への移行: 実際に影響する破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [発行したアプリでの FileNotFoundException "Could not load file or assembly" を修正する](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [EF Core 11 での SQL Server のネイティブ json 列と nvarchar(max) の比較](/ja/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)。SqlClient 7 の `SqlDbType.Json` の実際の使用例を示しています
- [dotnet build と dotnet publish の違いとは](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)

## 出典

- [EF Core 11 の破壊的変更: Microsoft.Data.SqlClient が 7.0 に更新されました](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Microsoft.Data.SqlClient 7.0.0 のリリースノート](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md) と [7.0.1 のリリースノート](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.1.md)
- [dotnet/SqlClient#4310: 7.x を通じてアセンブリバージョンが 7.0.0.0 のままであること、プラグイン読み込みのガイダンス](https://github.com/dotnet/SqlClient/issues/4310)
- [dotnet/efcore#38845: EF Core 10.0.11 の報告](https://github.com/dotnet/efcore/issues/38845)
- [dotnet/SqlClient#4064](https://github.com/dotnet/SqlClient/issues/4064) と [#4117](https://github.com/dotnet/SqlClient/pull/4117): `SqlAuthenticationMethod` の型フォワード
- [NuGet 警告 NU1605](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1605) と [エラー NU1109](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1109)
- [プラグインを使用する .NET アプリケーションを作成する](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) と [既定のプローブ](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/default-probing)
