---
title: "修正: Pomelo.EntityFrameworkCore.MySql と EF Core 10 の間で発生する NU1608 / NU1107 バージョン競合"
description: "Pomelo 9.0.0 は EF Core Relational 9.0.x しか許可しておらず、EF Core 10 向けのビルドもありません。EF Core のパッケージをすべて 9.0.x にそろえるか、Microting.EntityFrameworkCore.MySql 10.0.x に切り替えてください。警告を抑制すると起動時にクラッシュします。"
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "dotnet-10"
  - "nuget"
  - "mysql"
lang: "ja"
translationOf: "2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10"
translatedBy: "claude"
translationDate: 2026-10-13
---

**結論:** `Pomelo.EntityFrameworkCore.MySql` 9.0.0 は nuget.org で今も最新のリリース (2026年10月時点) であり、`Microsoft.EntityFrameworkCore.Relational` の依存範囲を `[9.0.0, 9.0.999]` と宣言しています。依存関係グラフに EF Core 10 のパッケージが含まれると、この範囲と衝突するか (`NU1107`、復元エラー)、範囲を押しのけて採用されるか (`NU1608`、警告) のどちらかになります。EF Core 10 向けの Pomelo ビルドは、ナイトリーフィードを含めて存在しません。有効な選択肢は 2 つです。EF Core と Identity のパッケージをすべて 9.0.x にそろえる (`net10.0` で問題なく動作します) か、Pomelo を `Microting.EntityFrameworkCore.MySql` 10.0.x のフォークに置き換えます。`NU1608` を `NoWarn` で抑制してはいけません。アプリはコンパイルできますが、`UseMySql` の中で `MissingMethodException` が発生して終了します。

以下の内容はすべて macOS 上で、.NET SDK 10.0.302、EF Core 10.0.13 と 9.0.21、Pomelo 9.0.0、Microting 10.0.12、Oracle の `MySql.EntityFrameworkCore` 10.0.9 を使って再現しました。

## エラーの状況

追加した EF Core 10 のパッケージによって、エラーは 2 通りの形で現れます。`Microsoft.EntityFrameworkCore.Design` や ASP.NET Core Identity など、別のパッケージが EF Core 10 を推移的に取り込んでいる場合、復元は即座に失敗します。

```text
error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 10.0.13 directly to project App to resolve this issue.
error NU1107:  App -> Microsoft.EntityFrameworkCore.Design 10.0.13 -> Microsoft.EntityFrameworkCore.Relational (>= 10.0.13)
error NU1107:  App -> Pomelo.EntityFrameworkCore.MySql 9.0.0 -> Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999).
```

この案内に従って `Microsoft.EntityFrameworkCore.Relational` 10.0.13 を直接参照すると、直接参照は常に推移的な範囲より優先されるため、エラーは警告に変わります。

```text
warning NU1608: Detected package version outside of dependency constraint: Pomelo.EntityFrameworkCore.MySql 9.0.0 requires Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999) but version Microsoft.EntityFrameworkCore.Relational 10.0.13 was resolved.
```

そして、この "修正済み" のビルドを実行すると、コンテキストを構成する最初の行で次のようにクラッシュします。

```text
Unhandled exception. System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NullButNotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.MySqlDbContextOptionsBuilderExtensions.UseMySql(DbContextOptionsBuilder optionsBuilder, String connectionString, ServerVersion serverVersion, Action`1 mySqlOptionsAction)
```

NuGet のメッセージは、クラッシュを引き起こす操作をそのまま案内しています。.NET 10 のリリースから数か月が経っても、このエラーが issue トラッカーに現れ続けるのはそのためです。

## なぜ起きるのか

EF Core のプロバイダーは、特定のメジャーバージョンの EF Core の内部実装に対してコンパイルされています。Pomelo はそれを nuspec の上限付きの範囲で表現しています。

```xml
<!-- Pomelo.EntityFrameworkCore.MySql 9.0.0 nuspec -->
<group targetFramework="net8.0">
  <dependency id="Microsoft.EntityFrameworkCore.Relational" version="[9.0.0, 9.0.999]" include="All" />
  <dependency id="MySqlConnector" version="2.4.0" exclude="Build,Analyzers" />
</group>
```

NuGet はプロジェクトごとに、各パッケージのバージョンを 1 つだけ解決します。グラフ内の 2 つの経路が食い違うと、次のようになります。

- **どちらも推移的で、範囲が重ならない場合** (`Design 10 -> Relational >= 10.0.13` と `Pomelo -> Relational <= 9.0.999`): NuGet はどちらも選べず、`NU1107` で失敗します。
- **直接参照が優先される場合** (Relational 10.0.13 を自分で参照している、または Central Package Management で固定している): NuGet は直接参照のバージョンを採用し、Pomelo の制約に違反したことを `NU1608` で警告します。

この上限は心配しすぎではありません。Pomelo 9.0.0 は `Check.NullButNotEmpty` のようなヘルパーを呼び出しており、EF Core 9 ではそれが `AbstractionsStrings.ArgumentIsEmpty(object)` に転送されます。EF Core 10 ではこれらの内部リソースメソッドが変更されたため、Pomelo のアセンブリ内の IL は存在しないメソッドを指しています。JIT がそれに気づくのはメソッドが最初に呼ばれたときです。ビルドが成功するのに起動時にクラッシュするのはそのためです。

EF Core 10 の GA から 1 年近く経った 2026年10月になってもこの問題が続いている理由は次のとおりです。Pomelo の [EF Core 10 対応のトラッキング issue #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007) は 120 件を超えるリアクションを集めたまま未解決で、メンテナーの最後のコメント (2025年10月) は "soon" リリースすると述べており、EF Core 10 向けのコミュニティの PR がいくつもマージされないまま残っています。nuget.org の一覧と Pomelo の Azure DevOps ナイトリーフィードの両方を確認しましたが、どちらも最新のビルドは 2025年8月の `9.0.1-servicing` CI パッケージでした。アップグレード先となる 10.x は存在しません。

## 最小限の再現手順

`net10.0` のプロジェクトを 3 つ用意し、それぞれ Pomelo 9.0.0 と EF Core 10 のパッケージを 1 つずつ参照します。

```xml
<!-- .NET SDK 10.0.302. Swap the second reference to get each outcome. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
    <!-- NU1107: -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13" />
    <!-- NU1107 too: Microsoft.AspNetCore.Identity.EntityFrameworkCore 10.0.13 -->
    <!-- NU1608 + crash: Microsoft.EntityFrameworkCore.Relational 10.0.13 -->
    <!-- No warning at all + crash: Microsoft.EntityFrameworkCore 10.0.13 -->
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 9.0.x or 10.0.x depending on the graph above
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<Shop>()
    .UseMySql("Server=localhost;Database=shop;User=root;Password=x",
              new MySqlServerVersion(new Version(8, 4, 0)))
    .Options;

using var db = new Shop(options);
Console.WriteLine(db.Orders.Where(o => o.Total > 10m).ToQueryString());

public class Order { public int Id { get; set; } public decimal Total { get; set; } }
public class Shop(DbContextOptions<Shop> o) : DbContext(o)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

一覧の最後のパターンには、特に注意が必要です。`Microsoft.EntityFrameworkCore` 10.0.13 (Relational ではなく) を追加すると、復元は何も出力しません。`Microsoft.EntityFrameworkCore.Relational` 9.0.0 は `Microsoft.EntityFrameworkCore >= 9.0.0` としか宣言しておらず上限がないため、NuGet は Relational 9.0.0 の隣に EF Core 10.0.13 をそのまま解決します。`dotnet nuget why` で確認できます。

```text
[net10.0]
 └── Pomelo.EntityFrameworkCore.MySql (v9.0.0)
     └── Microsoft.EntityFrameworkCore.Relational (v9.0.0)
```

`NU1608` も `NU1107` も出ませんが、実行時には同じ `MissingMethodException` が発生します。NuGet の警告なしにこの例外が出ている場合は、これが原因です。

## 修正方法の詳細

### 1. EF Core 10 を取り込んでいるパッケージをすべて見つける

何かを変更する前に、10.x を要求しているのが誰なのかを確認します。復元できるプロジェクト (`NU1608` の場合) では、`dotnet nuget why` で経路がわかります。

```bash
dotnet nuget why src/App/App.csproj Microsoft.EntityFrameworkCore.Relational
```

`NU1107` で止まっているプロジェクトでは、エラー自体に両方の経路が表示されます。`net10.0` アプリで典型的な原因は次のとおりです。

- Dependabot や Renovate で更新された `Microsoft.EntityFrameworkCore.Design` と `Microsoft.EntityFrameworkCore.Tools`。
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore`。Identity のテンプレートはフレームワークのバージョン (10.0.x) を使うためです。
- アプリを参照するテストプロジェクトの `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore`、`Microsoft.EntityFrameworkCore.InMemory`、または `.Sqlite`。
- すでに EF Core 10 に移行したサードパーティのライブラリ (バルク拡張、監査、マルチテナンシーなど)。
- すべての `Microsoft.EntityFrameworkCore.*` パッケージを 1 つの共有バージョンプロパティに固定している `Directory.Packages.props`。

最後のものは Central Package Management の落とし穴です。1 つの `$(EfCoreVersion)` を 10.0.x に上げると、推移的だった Relational が黙って固定されたものに変わります。その結果、`NU1107` ではなく `NU1608` になり、強制的に止まる機会を失います。

### 2. 選択肢 A: .NET 10 でも EF Core 9.0.x にとどまる

EF Core 9 は `net8.0` を対象としているため、.NET 10 ランタイムで問題なく動作します。EF Core のパッケージすべてと、Identity を使っている場合はそれも、同じ 9.0.x のパッチバージョンに固定します。

```xml
<!-- .NET 10 app, EF Core 9.0.21, Pomelo 9.0.0 -->
<ItemGroup>
  <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0.21">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
  <PackageReference Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="9.0.21" />
</ItemGroup>
```

Central Package Management を使っている場合は、プロバイダー側のバージョンが明確になるようにプロパティを分けます。

```xml
<!-- Directory.Packages.props, .NET 10 solution with Pomelo 9.0.0 -->
<PropertyGroup>
  <!-- Pomelo 9.0.0 caps Relational at 9.0.999. Do not bump until the provider moves. -->
  <EfCoreVersion>9.0.21</EfCoreVersion>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
</ItemGroup>
```

このグラフで再現用プログラムを `net10.0` 上で実行したところ、EF Core と Relational はどちらも `9.0.21.0` と報告され、モデルの構築、`ToQueryString()`、`GenerateCreateScript()` がすべて動作し、Identity 9.0.21 のプロジェクトも問題なく復元・実行できました。Dependabot には 9.x 系を更新しないよう指示してください (`Microsoft.EntityFrameworkCore*` に対する `ignore` ルールで `update-types: ["version-update:semver-major"]` を指定します)。そうしないと、毎週同じ PR が作り直されます。

問題はスケジュールです。EF Core 9 のサポートは .NET 9 の STS サポート期間に従い、[2026年11月10日](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)に終了します。その日以降、EF Core 9 のパッケージにセキュリティパッチは提供されません (EF Core 8 LTS も同じ日に終了します)。選択肢 A はつなぎであり、最終的な到達点ではありません。

### 3. 選択肢 B: Microting.EntityFrameworkCore.MySql 10.0.x に切り替える

[Microting.EntityFrameworkCore.MySql](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql) は Pomelo のフォークで、2026年2月から EF Core 10 向けのビルドを公開しており、`11.0.0-preview.1` もあります。10.0.12 の nuspec は `net10.0` を対象とし、`Microsoft.EntityFrameworkCore.Relational [10.0.12, 10.0.999]` と `MySqlConnector 2.6.2` に依存します。Pomelo のトラッキング issue で、多くの人が移行した先がこのフォークです。

```xml
<!-- .NET 10, EF Core 10.0.13, Microting 10.0.12 -->
<ItemGroup>
  <PackageReference Include="Microting.EntityFrameworkCore.MySql" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

`UseMySql(...)` 拡張メソッドと `MySqlServerVersion` / `ServerVersion.AutoDetect` は、どちらのパッケージでも `Microsoft.EntityFrameworkCore` 名前空間にあります。そのため、再現用の `Program.cs` は置き換え後も変更なしでコンパイルでき、EF Core 9 と Pomelo 9.0.0 のときと同じ MySQL の SQL が出力されました。

```text
SELECT `o`.`Id`, `o`.`Customer`, `o`.`Total`
FROM `Orders` AS `o`
WHERE (`o`.`Total` > 10.0) AND (`o`.`Customer` LIKE 'A%')
ORDER BY `o`.`Id`
LIMIT 5
```

変更が必要な点は次のとおりです。

1. すべての `using Pomelo.EntityFrameworkCore.MySql.*;` を `using Microting.EntityFrameworkCore.MySql.*;` に書き換えます。フォークではアセンブリ名と名前空間の両方が変更されています (たとえば `Pomelo.EntityFrameworkCore.MySql.Infrastructure` は `Microting.EntityFrameworkCore.MySql.Infrastructure` になります)。
2. プラグインのパッケージも置き換えます。`Pomelo.EntityFrameworkCore.MySql.Json.Microsoft` は `Microting.EntityFrameworkCore.MySql.Json.Microsoft` になり、`.Json.Newtonsoft` と `.NetTopologySuite` も同様です。Pomelo のプラグインを 1 つでも残すと、Pomelo 9.0.0 と `NU1107` がすぐに戻ってきます。
3. スキャフォールディングのコマンドのプロバイダー名を更新します: `dotnet ef dbcontext scaffold "<conn>" Microting.EntityFrameworkCore.MySql`。
4. 実行時の EF Core のバージョンと合わせるため、`dotnet-ef` ツールを 10.0.x にアップグレードします。
5. 既存のマイグレーションに対して `dotnet ef migrations add ProviderSwapCheck` を実行します。生成されたマイグレーションが空であれば、モデルのスナップショットは互換性があります。`dotnet ef migrations remove` で削除してください。空でない場合は、本番に出す前に必ず内容を確認してください。その差分は、そのまま本番環境に対して実行される内容です。

これが何であるかは正しく理解しておいてください。1 社が保守するコミュニティのフォークであり、公式のプロバイダーではありません。バージョンを正確に固定し、更新前にリリースノートを読み、両方のリポジトリを監視してください。Pomelo が後から 10.0.0 を公開した場合、元に戻す作業は同じ名前変更を逆に行うだけです。

### 4. 選択肢 C: Oracle の MySql.EntityFrameworkCore

Oracle のプロバイダー [MySql.EntityFrameworkCore](https://www.nuget.org/packages/MySql.EntityFrameworkCore) は、10.0.0-rc 以降 EF Core 10 向けのビルドがあり、現在は 10.0.9 です。nuspec は単純な下限指定 (`Microsoft.EntityFrameworkCore.Relational >= 10.0.9`) を使っているため、この競合は発生しません。これはフォークではなく別のプロバイダーで、API も異なります。

```csharp
// .NET 10, EF Core 10.0.13, MySql.EntityFrameworkCore 10.0.9
options.UseMySQL(connectionString); // capital SQL, no ServerVersion argument
```

クエリの変換結果も異なります。再現用の同じ `Customer.StartsWith("A")` フィルターは、Pomelo と Microting では `LIKE 'A%'` が出力されるのに対し、`LIKE CONCAT('A', '%')` と `LEFT(...) = CONVERT(... USING utf8mb4) COLLATE utf8mb4_bin` による比較になります。型マッピングやマイグレーションのアノテーションも異なるため、空でないマイグレーション差分が出ることを想定し、本格的なマイグレーションのレビューを計画してください。ベンダーが保守するプロバイダーが欲しく、そのレビューの負担を許容できる場合はこちらを選んでください。そうでなければ、変更が小さい選択肢 B のほうが適しています。

### 5. やってはいけないこと

- **`<NoWarn>NU1608</NoWarn>` を追加しないでください。** 再現手順のとおり、ビルドは成功し、最初の `UseMySql` 呼び出しで `MissingMethodException` が発生します。`TreatWarningsAsErrors` が `NU1608` を表面化させたのであれば、それは本来の役割を果たしています。
- **`NU1107` のメッセージに従って `Microsoft.EntityFrameworkCore.Relational` 10.x を直接参照しないでください。** エラーがクラッシュに変わるだけです。
- **ソリューション内でメジャーバージョンを混在させないでください。** EF Core 9 のアプリを参照するテストプロジェクトが EF Core 10 の InMemory を使うと、両方がテストのグラフに入り、テストプロジェクトだけで `NU1107` (または黙った不一致) が発生します。

## 注意点と似たエラー

- **NuGet の警告がないのに `MissingMethodException` が出る場合**: 再現手順にある `Microsoft.EntityFrameworkCore` 10 と Relational 9.0.0 の組み合わせです。`dotnet nuget why <project> Microsoft.EntityFrameworkCore.Relational` を実行し、10.x の EF Core の隣に 9.x の Relational がないか確認してください。
- **`Pomelo.EntityFrameworkCore.MySql.Json.Microsoft` が出てくる `NU1107` または `NU1608`**: プラグインのパッケージも同じ `Microsoft.EntityFrameworkCore.Relational [9.0.0, 9.0.999]` の制約を持ち、自身も Pomelo 9.0.0 に依存しています。メインのパッケージと同時に移行してください。
- **`NU1605` (パッケージのダウングレードを検出)**: 別の問題です。直接固定したバージョンより新しいバージョンをグラフ内の何かが要求しています。選択肢 A を適用した直後に、推移的なパッケージがまだ EF Core 10 を要求している場合によく発生します。さらにダウングレードするのではなく、そのパッケージを見つけて固定することで解決してください。
- **`dotnet ef` がツールのバージョンがランタイムより新しいと警告する場合**: それ自体は無害ですが、選択肢 A の後は、デザイン時の動作が本番で動くものと一致するように、`dotnet-ef` ツールをアプリの EF Core パッケージと同じメジャーバージョンにそろえてください。
- **同じソリューション内で Npgsql や SQL Server のパッケージが 10.x の場合**: グラフを共有しない別々のプロジェクトにある限り問題ありません。1 つのプロジェクトには 1 つの EF Core メジャーバージョンです。

## 関連記事

- 警告でビルドが失敗するために `NU1608` が表面化した場合は、本当の問題を隠さずに厳格さを保つ方法として [TreatWarningsAsErrors without sabotaging dev builds](/ja/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/) を参照してください。
- 選択肢 A で使う共有バージョンプロパティのパターンについては、[migrating a .NET solution to Central Package Management](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) を参照してください。
- .NET 10 では、グラフに現れる推移的なパッケージ自体も変わりました: [NuGet package pruning is on by default in .NET 10](/ja/2026/05/nuget-package-pruning-default-net-10/)。
- 代わりに `dotnet-ef` ツールと SDK が食い違っている場合は、[the DotnetToolSettings.xml fix](/ja/2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package/) を参照してください。
- EF Core 9 の先への移行を計画している場合: [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)。

## 参考資料

- [Pomelo EF Core 10 support tracking issue #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007)
- [Pomelo.EntityFrameworkCore.MySql README: compatibility table and nightly feeds](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql)
- [Pomelo.EntityFrameworkCore.MySql 9.0.0 on NuGet](https://www.nuget.org/packages/Pomelo.EntityFrameworkCore.MySql/9.0.0)
- [Microting.EntityFrameworkCore.MySql on NuGet](https://www.nuget.org/packages/Microting.EntityFrameworkCore.MySql) and [its README on the namespace rename](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql)
- [MySql.EntityFrameworkCore on NuGet](https://www.nuget.org/packages/MySql.EntityFrameworkCore)
- [NuGet warning NU1608](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1608) and [NuGet error NU1107](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1107)
- [.NET and .NET Core support policy](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)
