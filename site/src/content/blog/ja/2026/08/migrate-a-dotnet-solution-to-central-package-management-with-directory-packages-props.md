---
title: "Directory.Packages.props で .NET ソリューションを Central Package Management に移行する"
description: "すべてのパッケージバージョンを csproj から 1 つの Directory.Packages.props へ移します。競合するバージョンを本物の semver 順序で統合する生成スクリプト、何が動いたかを証明する移行前後の依存関係グラフ差分、NU1008/NU1010/NU1013/NU1507、推移的ピン留め、GlobalPackageReference、VersionOverride、そしてネストした Directory.Packages.props がルートのものを黙って覆い隠す理由を解説します。"
pubDate: 2026-08-28
template: migration
tags:
  - "migration"
  - "dotnet"
  - "nuget"
  - "csharp"
lang: "ja"
translationOf: "2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props"
translatedBy: "claude"
translationDate: 2026-08-28
---

Central Package Management は、`.csproj` ファイルからすべての `Version` 属性を取り除き、リポジトリルートにある 1 つの `Directory.Packages.props` に集約します。`<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>` で有効にし、ソリューションが使うパッケージごとに `<PackageVersion Include="..." Version="..." />` を宣言し、すべての `<PackageReference>` から `Version` 属性を削除します。移行そのものは機械的で、スクリプト化できます。人間の判断が必要なのは、プロジェクトごとに異なるバージョンで固定されているパッケージの調整です。それらを統合するのは書式の変更ではなく、実際の挙動の変更だからです。以下の内容はすべて、同梱の NuGet 7.6.0 を含む .NET 10 SDK 10.0.302 で検証しました。

## 実際に変わるもの

これまでは、各プロジェクトが自分のバージョンを持っていました。

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
</ItemGroup>
```

移行後、プロジェクトは*何に*依存するかだけを宣言し、ルートのファイルが*どのバージョンか*を決めます。

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" />
</ItemGroup>
```

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

`Directory.Packages.props` は、`Directory.Build.props` と同じように各プロジェクトのディレクトリから*上に向かって*探索されます。ソリューションファイルの隣に置く必要はなく、明示的にインポートするものもありません。移動するのはバージョンだけである点に注意してください。`PrivateAssets`、`IncludeAssets`、`ExcludeAssets` は、それを必要とするプロジェクトの `PackageReference` に残ります。これらはプロジェクト単位の判断だからです。

## 手順

1. リポジトリルートに `Directory.Packages.props` を作成し、`ManagePackageVersionsCentrally` を `true` にします。
2. すべてのプロジェクトのすべての `PackageReference` からバージョンを集め、パッケージ ID ごとに `PackageVersion` 項目を 1 つ出力します。
3. 複数のバージョンで現れるパッケージを解決します。機械的でないのはこの手順だけです。
4. すべてのプロジェクトのすべての `PackageReference` から `Version` 属性を削除します。
5. 復元し、解決済みの依存関係グラフを、着手前に取得しておいたものと比較します。

## いま手元にあるものからファイルを生成する

ここではファイルベースの C# アプリがよく合います。ファイル 1 つ、プロジェクト不要、`dotnet run` で直接実行できます。バージョンを集め、競合を報告し、props ファイルを書き、それから属性を取り除きます。

```csharp
// migrate-to-cpm.cs -- 実行方法: dotnet run migrate-to-cpm.cs .
#:property ManagePackageVersionsCentrally=false
#:package NuGet.Versioning@6.*

using System.Xml.Linq;
using NuGet.Versioning;

var root = args.Length > 0 ? args[0] : ".";
var projects = Directory.GetFiles(root, "*.csproj", SearchOption.AllDirectories);
var versions = new Dictionary<string, SortedSet<NuGetVersion>>(StringComparer.OrdinalIgnoreCase);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        var id = (string?)reference.Attribute("Include") ?? (string?)reference.Attribute("Update");
        var version = (string?)reference.Attribute("Version") ?? (string?)reference.Element("Version");
        if (id is null || version is null) continue;
        if (!versions.TryGetValue(id, out var set))
            versions[id] = set = new SortedSet<NuGetVersion>();
        if (NuGetVersion.TryParse(version, out var parsed)) set.Add(parsed);
    }
}

foreach (var (id, set) in versions.Where(v => v.Value.Count > 1))
    Console.WriteLine($"conflict: {id} -> {string.Join(", ", set)}");

var props = new XElement("Project",
    new XElement("PropertyGroup",
        new XElement("ManagePackageVersionsCentrally", true),
        new XElement("CentralPackageTransitivePinningEnabled", true)),
    new XElement("ItemGroup",
        versions.OrderBy(v => v.Key, StringComparer.OrdinalIgnoreCase)
                .Select(v => new XElement("PackageVersion",
                    new XAttribute("Include", v.Key),
                    new XAttribute("Version", v.Value.Max()!)))));

File.WriteAllText(Path.Combine(root, "Directory.Packages.props"), props + Environment.NewLine);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    var changed = false;
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        if (reference.Attribute("Version") is { } attribute) { attribute.Remove(); changed = true; }
        if (reference.Element("Version") is { } element) { element.Remove(); changed = true; }
    }
    if (changed) doc.Save(project);
}

Console.WriteLine($"wrote {versions.Count} PackageVersion entries from {projects.Length} projects");
```

このスクリプトで要となる箇所が 2 つあります。

1 つ目は、単なる文字列ではなく `NuGetVersion` を使っている点です。バージョンをテキストとして並べ替えるのは誤りで、しかも黙ってダウングレードする方向に誤ります。

```text
string  max: 13.0.3
semver  max: 13.0.10
```

2 つ目は 1 行目の `#:property ManagePackageVersionsCentrally=false` ディレクティブです。これがないと、スクリプトは成功した瞬間に自分自身を壊します。ファイルベースアプリの `#:package` ディレクティブは `Version` 付きの `PackageReference` に展開されますが、スクリプトが書き出したばかりの `Directory.Packages.props` が同じディレクトリツリーにあるため、次の実行は `Main` に到達する前に失敗します。

```text
migrate-to-cpm.cs.csproj : error NU1008: The following PackageReference items cannot define a value for
Version: NuGet.Versioning. Projects using Central Package Management must define a Version value on a
PackageVersion item.
```

これはこのスクリプトを離れても覚えておく価値があります。リポジトリルートで CPM を有効にすると、リポジトリ内のファイルベース `.cs` アプリすべてにも適用され、`#:package` はそれと両立しません。`#:property` で個別に除外するか、スクリプトをツリーの外に置いてください。

## 競合こそが移行作業

3 つのプロジェクトの指定が食い違うソリューションでスクリプトを走らせると、実際の作業項目リストが得られます。

```text
conflict: Serilog -> 4.1.0, 4.2.0
conflict: Newtonsoft.Json -> 13.0.1, 13.0.3
wrote 3 PackageVersion entries from 3 projects
```

スクリプトがやっているように最も高いバージョンを採用するのは、*既定値*としては正しく、*方針*としては誤りです。正しいのは、同じライブラリを 2 つのバージョンで抱えているソリューションはたいてい判断の結果ではなく事故だからであり、低いほうの固定はたいてい誰も見直していない古いものだからです。方針として誤りなのは、「高いほうが勝つ」はまさに、ビルドファイルを整理していただけのつもりが、あるプロジェクトで気づかないうちにメジャーバージョンの境界を越えてしまう経路だからです。リストを読み、メジャーバージョンをまたぐものについては、スクリプト任せにせず、そのプロジェクトを意識的に移行してください。

## 何が動いたかを証明する

CPM は無変更の操作ではありません。実際に何をしたかを知る手段は、解決済みグラフの比較です。着手前に、各プロジェクトの復元結果から取得しておきます。

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(k) for t in d['targets'].values() for k in sorted(t)]" src/Domain/obj/project.assets.json
```

上記の 3 プロジェクト構成での移行前後です。

```text
            BEFORE                       AFTER
Api       Newtonsoft.Json/13.0.3      Newtonsoft.Json/13.0.3
          Polly/8.5.0                 Polly/8.5.0
          Serilog/4.2.0               Serilog/4.2.0
Domain    Newtonsoft.Json/13.0.1  ->  Newtonsoft.Json/13.0.3
Workers   Serilog/4.1.0           ->  Serilog/4.2.0
          Polly/8.5.0                 Polly/8.5.0
```

2 つのプロジェクトが動きました。これがテストすべき変更であり、プルリクエストの説明に書くべき内容です。差分が空なら、その移行は本当に機械的だったということで、はるかに軽い手続きでマージできます。

## 遭遇する 4 つのエラー

**NU1008** — `PackageReference` にまだ `Version` が残っています。これは移行の途中で当然発生する状態ですが、警告ではなくエラーなので、中途半端に移行したリポジトリはビルドできません。

```text
error NU1008: The following PackageReference items cannot define a value for Version: Serilog.
```

**NU1010** — `PackageReference` に対応する `PackageVersion` がありません。たいていは、スクリプトが走査しなかったプロジェクト、たとえば渡したルートの外にあるプロジェクトにだけ現れるパッケージです。

```text
error NU1010: The following PackageReference items do not define a corresponding PackageVersion item:
Humanizer.Core.
```

**NU1013** — `CentralPackageVersionOverrideEnabled` が `false` の状態で `VersionOverride` が使われました。後述の脱出ハッチを参照してください。

**NU1507** — これは警告で、そして皆が見過ごすものです。

```text
warning NU1507: There are 2 package sources defined in your configuration. When using central package
management, please map your package sources with package source mapping
(https://aka.ms/nuget-package-source-mapping) or specify a single package source.
The following sources are defined: nuget.org, contoso
```

ソースが 1 つなら何も変わりません。nuget.org と並んでプライベートフィードがある場合、中央で宣言されたバージョンはどちらからでも解決できるようになり、依存関係混同による差し替えの余地が広がります。警告を抑制するのではなく、パッケージソースマッピングで対処してください。

## 推移的ピン留め

これ単体で移行の価値があると言える機能です。`<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>` で有効にすると、宣言した `PackageVersion` が推移的に入ってくるパッケージにも適用されます。

`Newtonsoft.Json.Bson` だけを参照するプロジェクトを考えます。`Directory.Packages.props` が 13.0.3 を宣言していても、その `Newtonsoft.Json >= 12.0.1` という依存はそのまま 12.0.1 に解決されます。対応する `PackageReference` のない `PackageVersion` は、既定では何もしないからです。

```text
warning NU1903: Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability
```

推移的ピン留めを有効にすると、同じ復元がクリーンになります。

```text
Top-level Package           Requested   Resolved
> Newtonsoft.Json.Bson      1.0.2       1.0.2

Transitive Package      Resolved
> Newtonsoft.Json       13.0.3
```

パッケージは 13.0.3 に引き上げられ、分類は推移的のままです。つまり、プロジェクトの公開依存関係の面には加わらず、自分が作るパッケージの nuspec に漏れ出すこともありません。これこそが狙いどおりの挙動です。あとで消し忘れる直接参照を追加することなく、脆弱な推移的依存をすべてのプロジェクトで一度に修正できます。

## GlobalPackageReference

source link プロバイダー、アナライザー、バージョニングツールのように、ビルド時のみ効き、すべてのプロジェクトに入れたいパッケージには専用の項目型があります。`Directory.Packages.props` に一度宣言すれば、`.csproj` には一切触れずに済みます。

```xml
<ItemGroup>
  <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
</ItemGroup>
```

`GlobalPackageReference` は `PackageReference` と違い、`Version` を要素にそのまま持つ点に注意してください。開発時のみのアセット挙動を持つトップレベル参照としてあらゆる場所に適用されるため、すべてのプロジェクトの `dotnet package list` に現れます。本当にすべてに必要なパッケージにだけ使ってください。「とりあえず」グローバルにしたパッケージを後から外すのは非常に困難です。

## 脱出ハッチ

あるプロジェクトだけ別のバージョンが必要で、そこに正当な理由がある場合。`VersionOverride` が中央の値に優先します。

```xml
<PackageReference Include="Newtonsoft.Json" VersionOverride="13.0.1" />
```

CPM を導入した目的がバージョンのばらつきを不可能にすることだったなら、`<CentralPackageVersionOverrideEnabled>false</CentralPackageVersionOverrideEnabled>` でその扉を閉じてください。以後、使用すると NU1013 になります。

プロジェクト全体を対象外にするには、その `.csproj` に `<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>` を書きます。以降そのプロジェクトは再び自前でバージョンを管理します。ただしこれは推移的ピン留めからも外れることを意味し、ソリューションの他の部分が引き上げた脆弱な推移的依存が、そのプロジェクトにだけそのまま戻ってきます。

## ネストした Directory.Packages.props は覆い隠すもので、マージはしない

探索は最初に見つかったファイルで止まります。したがってサブディレクトリの `Directory.Packages.props` は、ルートのものに足し合わされるのではなく完全に置き換え、その配下のすべてのプロジェクトは、ルートのファイルが宣言していたパッケージについて直ちに NU1010 で失敗します。領域ごとのバージョンが必要なら、親を明示的にインポートし、`Update` で上書きします。

```xml
<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Packages.props', '$(MSBuildThisFileDirectory)../'))" />
  <ItemGroup>
    <PackageVersion Update="Newtonsoft.Json" Version="13.0.2" />
  </ItemGroup>
</Project>
```

項目はすでに存在するので、`Include` ではなく `Update` です。ここを誤ると 1 つのパッケージに `PackageVersion` 項目が 2 つでき、曖昧になります。

## CLI はすでに理解している

移行後に props ファイルを手で編集する必要はありません。.NET 10 SDK のパッケージコマンドは CPM を理解しており、正しいファイルに自分で書き込みます。

`dotnet package add Humanizer.Core --project src/Lib1/Lib1.csproj` は、プロジェクトにバージョンなしの `PackageReference` を追加し、*さらに* `Directory.Packages.props` にアルファベット順で `PackageVersion` を挿入します。

```text
info : PackageReference for package 'Humanizer.Core' version '3.0.10' added to file
'/repo/Directory.Packages.props'.
```

`dotnet package update Serilog --project src/App/App.csproj` は中央のバージョンだけを編集し、プロジェクトファイルには触れません。`dotnet package list --outdated` は `GlobalPackageReference` 項目も含めて正しく報告します。`dotnet nuget why <project> <package>` は、これからピン留めしようとしている推移的パッケージをどの参照が引き込んだのかを調べる最速の手段であり続けます。

## 関連

- CPM は [NuGet Package Pruning が .NET 10 で既定有効に](/ja/2026/05/nuget-package-pruning-default-net-10/) の推移的依存の整理と自然に噛み合います。ピン留めが考慮する前に、フレームワーク提供のパッケージをグラフから取り除いてくれます。
- 移行スクリプトで使った `#:package` と `#:property` ディレクティブは [`dotnet run app.cs` でファイルベース C# アプリを実行する方法](/ja/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) で詳しく解説しています。
- プロジェクト間でバージョンを統合しておくのは、[.NET 8 から .NET 11 への移行](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) の*前に*やっておくとよい作業です。そうすれば差分の変数がフレームワークの更新だけになります。
- バージョンを取り除いた後にプロジェクトがコンパイルできなくなった場合、原因は CPM ではなく参照そのものであることがほとんどです。[プロジェクト参照を追加した後に型または名前空間名が見つからない](/ja/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) をご覧ください。
- 2 つのプロジェクトが 1 つのバージョンに収束したとき、それを知らせてくるのは実行時のロードエラーです。診断方法は [公開したアプリでファイルまたはアセンブリを読み込めない](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) で解説しています。

## 出典

- NuGet ドキュメントの [Central Package Management](https://learn.microsoft.com/ja-jp/nuget/consume-packages/central-package-management)。`PackageVersion`、`GlobalPackageReference`、`VersionOverride`、推移的ピン留めについて。
- [NuGet のエラーと警告のリファレンス](https://learn.microsoft.com/ja-jp/nuget/reference/errors-and-warnings/)。NU1008、NU1010、NU1013、NU1507 について。
- [パッケージソースマッピング](https://learn.microsoft.com/ja-jp/nuget/consume-packages/package-source-mapping)。NU1507 への推奨される対処。
- [Directory.Build.props でビルドをカスタマイズする](https://learn.microsoft.com/ja-jp/visualstudio/msbuild/customize-by-directory)。`Directory.Packages.props` にも適用されるディレクトリ探索について。
