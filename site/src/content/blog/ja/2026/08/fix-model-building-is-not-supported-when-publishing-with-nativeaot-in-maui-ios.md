---
title: "修正: .NET MAUI の iOS ビルドで発生する Model building is not supported when publishing with NativeAOT"
description: "iOS ビルドは DynamicCodeSupport=false を設定するため、NativeAOT を有効にしていなくても EF Core はモデルの構築を拒否します。コンパイル済みモデルと事前コンパイル済みクエリを出荷するか、インタープリターを再び有効にしてください。"
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "maui"
  - "ios"
  - "native-aot"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-08-30
---

MAUI の iOS アプリが最初のデータベース呼び出しで `Model building is not supported when publishing with NativeAOT. Use a compiled model.` を出してクラッシュし、`<PublishAot>false</PublishAot>` を設定しても何も変わりません。理由は、EF Core が `PublishAot` を一切参照していないからです。EF Core が見ているのは `RuntimeFeature.IsDynamicCodeSupported` で、.NET for iOS の targets はインタープリターが有効でない限り、すべての iOS、tvOS、Mac Catalyst ビルドでこのスイッチを `false` に設定します。サポートされた修正は、`DbContext` とすべての LINQ クエリを通常のクラスライブラリに移し、そのライブラリに対して `dotnet ef dbcontext optimize --precompile-queries --nativeaot` を実行し、`<InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>` を追加することです。1 行で済む脱出口は `<UseInterpreter>true</UseInterpreter>` ですが、起動時の実コストを伴います。

以下の内容はすべて、macOS 上の .NET SDK 10.0.302、`Microsoft.EntityFrameworkCore.Sqlite` 8.0.21 / 9.0.19 / 10.0.11、`dotnet-ef` 10.0.11 CLI で検証しました。トリガーは AppContext のスイッチ 1 つだけなので、この失敗も 3 つの修正も、Xcode も iPhone もなしに素のコンソールアプリで再現できます。私が実行したことではなく iOS ビルドそのものについての主張は `dotnet/macios` と `dotnet/sdk` の targets を出典としており、その旨を明記します。

## エラーの全体像

```text
System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder...
   at Microsoft.EntityFrameworkCore.DbContext.get_Model()
```

これはモデルに触れる最初の操作で発生します。クエリ、`Add`、`SaveChanges`、`EnsureCreated` などです。`DbContext` を作るだけでは発生しないため、クラッシュ地点はデータベース設定のコードから遠く離れた場所になりがちです。

修正に着手すると遭遇しうる兄弟メッセージが 2 つあります。`Design-time DbContext operations are not supported when publishing with NativeAOT.` と `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` です。どちらも後述します。

## NativeAOT を有効にしていないのに iOS ビルドが NativeAOT のエラーを報告する理由

メッセージには NativeAOT と書かれていますが、実際のチェックにはその文字は出てきません。[`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs) の実際のコードは次のとおりです。

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, DbContextServices.CreateModel
if (modelFromOptions == null
    || (designTime && modelFromOptions is not Metadata.Internal.Model))
{
    return RuntimeFeature.IsDynamicCodeSupported
        ? dependencies.ModelSource.GetModel(_currentContext!.Context, dependencies, designTime)
        : designTime
            ? throw new InvalidOperationException(CoreStrings.NativeAotDesignTimeModel)
            : throw new InvalidOperationException(CoreStrings.NativeAotNoCompiledModel);
}
```

`RuntimeFeature.IsDynamicCodeSupported` は AppContext のスイッチ `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported` を読み取ります。このスイッチは SDK が MSBuild プロパティ `DynamicCodeSupport` から `runtimeconfig.json` に書き込みます。[`Microsoft.NET.Sdk.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.Sdk.targets) より:

```xml
<!-- .NET SDK 10.0.302 -->
<RuntimeHostConfigurationOption Include="System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported"
                                Condition="'$(DynamicCodeSupport)' != ''"
                                Value="$(DynamicCodeSupport)"
                                Trim="true" />
```

そして、それを設定している行が `dotnet/macios` の [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) にあります。

```xml
<!-- dotnet/macios, Xamarin.Shared.Sdk.targets -->
<DynamicCodeSupport Condition="'$(DynamicCodeSupport)' == '' And ( '$(MtouchInterpreter)' == '' And '$(UseInterpreter)' != 'true' ) And ('$(_PlatformName)' == 'iOS' Or '$(_PlatformName)' == 'tvOS' Or '$(_PlatformName)' == 'MacCatalyst')">false</DynamicCodeSupport>
```

この条件から 3 つのことが導かれ、そのいずれもこのエラーにまつわる通説と矛盾します。

`PublishAot` の問題ではありません。このプロパティは経路のどこにも登場しないため、`false` にしても何も変わりません。

Release 構成の問題でもありません。この条件に `Configuration` のチェックはありません。実際に決めているのはインタープリターが有効かどうかなので、インタープリターなしの Debug ビルドでも `IsDynamicCodeSupported = false` になり、`UseInterpreter=true` の Release ビルドではそうなりません。

Android には当てはまりません。プラットフォームの一覧は iOS、tvOS、Mac Catalyst だけです。だからこそ、iOS がクラッシュする一方で同じ実装が Android と Windows では動き続けます。

このプロパティは [dotnet/macios PR #18555](https://github.com/dotnet/macios/pull/18555)、"Set `DynamicCodeSupport=false` to enable trimming in full AOT mode" で導入され、8.0.6x 帯で MAUI ワークロードに流れ込みました。この時期は [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595) と一致します。報告者はワークロード 8.0.40 (動作) と 8.0.61 (破損) の間にリグレッションを絞り込んでおり、EF Core のコードは 1 行も変えていません。

## iPhone なしで再現する

トリガーがスイッチ 1 つなので、デスクトップのコンソールアプリで再現も修正もできます。プロジェクトを作り、iOS の targets が設定するのと同じプロパティを設定します。

```xml
<!-- .NET SDK 10.0.302, net10.0 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <!-- exactly what Xamarin.Shared.Sdk.targets sets for iOS/tvOS/MacCatalyst -->
  <DynamicCodeSupport>false</DynamicCodeSupport>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
</ItemGroup>
```

```csharp
// .NET 10, EF Core 10.0.11
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore;

Console.WriteLine($"IsDynamicCodeSupported = {RuntimeFeature.IsDynamicCodeSupported}");

using var db = new NotesContext();
db.Database.EnsureCreated();

public class Note
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

public class NotesContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=notes.db");
}
```

`dotnet run` は `IsDynamicCodeSupported = False` を出力し、そのあとまったく同じエラーをスローします。生成された `bin/Debug/net10.0/<app>.runtimeconfig.json` を見れば出どころがわかります。

```json
"configProperties": {
  "System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
}
```

この再現ループは重要です。代替手段は 1 回の試行ごとに 10 分かかる実機ビルドだからです。

## 修正 1: 共有ライブラリにコンパイル済みモデルと事前コンパイル済みクエリを置く

これがサポートされた経路であり、このスイッチが存在する目的であるトリミングの利点を保てる唯一の方法です。3 つの部分から成り、どれを飛ばしても次の例外に進むだけです。

**手順 1: `DbContext`、エンティティ、そしてすべての LINQ クエリを通常の `net10.0` クラスライブラリに移します。** `net10.0-ios` ではありません。`dotnet ef` ツールはホスト上のデザイン時プロセスでアセンブリを読み込むため、実際にビルドして読み込めるプロジェクトが必要です。通常のライブラリであれば `IsDynamicCodeSupported` がまだ `true` のプロジェクトも手に入り、次の手順ではそれが必要になります。

「すべての LINQ クエリ」という部分はスタイルの好みではありません。私が検証しました。最適化済みライブラリを参照しているアプリ側プロジェクトに書いたクエリは、依然として `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` をスローします。事前コンパイルは、見えている呼び出し箇所に対して C# のインターセプターを生成することで機能するため、別プロジェクトの呼び出し箇所は見えません。実務上はライブラリ内のリポジトリクラスやデータサービスクラスへ寄せることになりますが、MAUI アプリはもともとそこにこのコードを置くべきです。

```csharp
// .NET 10, EF Core 10.0.11 - Notes.Data class library
public static class NoteRepository
{
    public static async Task<List<Note>> GetAllAsync()
    {
        using var db = new NotesContext();
        return await db.Notes.OrderBy(n => n.Id).ToListAsync();
    }

    public static async Task<Note?> FindByTextAsync(string text)
    {
        using var db = new NotesContext();
        var needle = text;
        return await db.Notes.FirstOrDefaultAsync(n => n.Text == needle);
    }
}
```

この `var needle = text;` の行は飾りではありません。メソッドの引数に対して `n.Text == text` と直接書くと、EF Core 10.0.11 では事前コンパイルが `System.Diagnostics.UnreachableException: IdentifierName of type ParameterSymbol: text` で失敗します。引数をいったんローカル変数へコピーすると、同じクエリが問題なく事前コンパイルされます。上流で修正されるまではローカル変数を残してください。

**手順 2: インターセプターを有効にしてモデルを生成します。** ライブラリにプロパティを追加します。

```xml
<!-- Notes.Data.csproj, EF Core 10.0.11 -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
</PropertyGroup>
```

これがないとビルドは `CS9137: The 'interceptors' feature is not enabled in this namespace` で失敗します。見覚えがあるなら、それは [OpenAPI のソースジェネレーターのインターセプター](/ja/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) で多くの人がつまずくのと同じ有効化です。

続いて、ライブラリのディレクトリから実行します。

```bash
dotnet ef dbcontext optimize --output-dir CompiledModels --namespace Notes.Data.CompiledModels --precompile-queries --nativeaot
```

成功すると次のように出力されます。

```text
Successfully generated a compiled model, it will be discovered automatically, but you can also
call 'options.UseModel(Notes.Data.CompiledModels.NotesContextModel.Instance)'.
Run this command again when the model is modified.
```

この "discovered automatically" は EF Core 9 以降の挙動です。ジェネレーターが `[assembly: DbContextModel(typeof(NotesContext), typeof(NotesContextModel))]` を `NotesContextAssemblyAttributes.cs` に出力し、属性が `DbContext` と同じアセンブリにある限り EF が見つけます。EF Core 8 には属性がないので、自分で `UseModel` を呼ぶ必要があります。

**手順 3: ソースを変更するたびに再生成します。** C# のインターセプターはソースコード上の位置に固定されるため、ライブラリを編集すると無効になります。EF のドキュメントははっきり書いています。インターセプターの生成は "isn't expected to happen in the inner loop" です。実運用アプリでは、CLI コマンドを誰かが覚えていることに頼るのではなく、[`Microsoft.EntityFrameworkCore.Tasks`](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks) パッケージ (10.0.11) をライブラリに追加し、発行時に MSBuild にやらせてください。CLI 経路は端から端まで検証しました。MSBuild 統合はドキュメントが CI 向けに推奨している方法です。

3 つすべてを揃えた状態で、`DynamicCodeSupport=false` の私のコンソールアプリは行の挿入、行の一覧取得、パラメーター付きの検索を例外なしで実行できました。

## 修正 2: インタープリターを再び有効にする

macios の条件をもう一度見てください。`MtouchInterpreter` か `UseInterpreter` を設定すると `DynamicCodeSupport=false` が完全に抑止されるため、EF Core は Android とまったく同じように実行時にモデルを構築します。

```xml
<!-- MAUI app csproj -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <UseInterpreter>true</UseInterpreter>
</PropertyGroup>
```

これは裏技ではなく正当な構成です。Mono の IL インタープリターは JIT ではなく、Apple も許可しています。代償はスループットと起動時間です。インタープリター実行は AOT コンパイル済みコードより遅く、モデルも初回利用時にリフレクションで構築されるためです。リリースを通すための応急処置として使い、そのあと修正 1 を行ってください。

注意が 2 つあります。インタープリターは IL ストリッピングも無効にします (`MtouchInterpreter` が設定されると `EnableAssemblyILStripping` は `false` に強制されます) ので、アプリバンドルは大きくなります。そしてこれは Mono の機能です。macios の targets は "The property 'UseInterpreter' has no effect when not using the Mono runtime (for instance when using CoreCLR)" という警告を出します。これは今後を考えると重要です。[.NET 11 Preview 6 以降、MAUI モバイルは CoreCLR のみ](/ja/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) だからです。この修正は .NET 10 のための橋渡しであって、長期的な計画ではないと考えてください。

## 修正 3: DynamicCodeSupport を true に戻す

```xml
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <DynamicCodeSupport>true</DynamicCodeSupport>
</PropertyGroup>
```

macios の行の条件は `'$(DynamicCodeSupport)' == ''` から始まるので、明示的な値が優先され、スイッチは `true` として `runtimeconfig.json` に入ります。これで EF Core は例外をスローしなくなります。

これを最後に挙げたのには理由があります。このスイッチは飾りではありません。動的コードの経路を削除してよいとトリマーに伝えるものであり、それこそが [PR #18555](https://github.com/dotnet/macios/pull/18555) の目的です。アプリが完全に AOT コンパイルされたままで `true` にするのはランタイムに嘘をつくことであり、依存関係グラフ上のすべてのライブラリが「実体のない動的コードサポートを主張する環境」を許容してくれることに賭けることになります。[トリミング安全なコードが実際に何を要求するのか](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) をすでに踏んでいるなら、このリスクの形には見覚えがあるはずです。診断用に使い、出荷には使わないでください。

## モデルを直しても EnsureCreated と Migrate はスローし続ける

ここが多くの MAUI アプリを捕まえる段階です。SQLite の標準的な初期化はアプリのコンストラクターでの `EnsureCreated()` 呼び出しだからです。コンパイル済みモデルがあり `IsDynamicCodeSupported = false` の状態では、次の 2 つはどちらもスローします。

```text
EnsureCreated: InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
Migrate:       InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
```

先ほどの `CreateModel` の抜粋を見返してください。コンパイル済みモデルは `RuntimeModel` であって `Metadata.Internal.Model` ではないため、デザイン時モデルを要求する経路はすべて `NativeAotDesignTimeModel` の分岐に入ります。スキーマ作成は DDL を出すためにデザイン時モデルを必要とするので、コンパイル済みモデルからは動きません。これも EF Core 9 のリグレッションです。同じ `EnsureCreated()` 呼び出しをスイッチを切った状態で EF Core 8.0.21 に対して実行したところ、何の文句もなくデータベースを作成しました。

回避策は、DDL の計算をアプリにやらせるのをやめることです。SQL をホスト側で一度生成し、テキストとして実行します。

```bash
dotnet ef migrations script -o Migrations.sql
```

```csharp
// .NET 10, EF Core 10.0.11 - runs fine with IsDynamicCodeSupported = false
using var db = new NotesContext();
db.Database.ExecuteSqlRaw(await File.ReadAllTextAsync(scriptPath));
```

`Migrations.sql` を MAUI の raw アセットとして同梱し、初回起動時に実行してください。なお SQLite は `--idempotent` をサポートしません。`dotnet ef migrations script --idempotent` は "Generating idempotent scripts for migrations is not currently supported for SQLite" で失敗するので、適用済みマイグレーションを自分で追跡するか、スクリプトを `CREATE TABLE IF NOT EXISTS` で守ってください。`Migrate()` を実行する代わりにスクリプトを渡すという同じ考え方は、[マイグレーション用のログインがデータベースを作成できない場合](/ja/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) にも、理由は違いますが当てはまります。

## EF Core 8、9、10 の間で変わったこと

コンパイル済みモデルだけで iOS 上で動いていたアプリが、EF Core を更新したら再び壊れたのなら、理由はこれです。`DynamicCodeSupport=false` とコンパイル済みモデルはあるが事前コンパイル済みクエリはない状態で、同じコードを 3 つの EF Core バージョンに対して実行しました。

| EF Core | コンパイル済みモデルの検出 | `EnsureCreated()` | 単純な LINQ クエリ |
| --- | --- | --- | --- |
| 8.0.21 | `UseModel(...)` が必要 | 動作する | 動作する |
| 9.0.19 | 自動 | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |
| 10.0.11 | 自動 | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |

EF Core 8 ではクエリパイプラインが実行時に LINQ をコンパイルしており、式インタープリターがそれを支えていました。EF Core 9 以降はコンパイラーが同じスイッチで分岐します。[`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs) より:

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, QueryCompiler.ExecuteAsync
var compiledQuery
    = _compiledQueryCache
        .GetOrAddQuery(
            _compiledQueryCacheKeyGenerator.GenerateCacheKey(queryAfterExtraction, async),
            () => RuntimeFeature.IsDynamicCodeSupported
                ? CompileQueryCore<TResult>(_database, queryAfterExtraction, _model, async)
                : throw new InvalidOperationException(CoreStrings.QueryNotPrecompiled));
```

以前の挙動に戻す AppContext のスイッチはありません。EF Core 8 ではコンパイル済みモデルだけで十分でしたが、EF Core 9 以降は事前コンパイル済みクエリも必要です。

## よく似たエラー

`Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` は、コンパイル済みモデルは見つかったがクエリは見つからなかったという意味です。そのクエリが `optimize --precompile-queries` を実行したプロジェクトにあるか、生成された `*.EFInterceptors.*.cs` がコンパイル対象になっているかを確認してください。

`Dynamic LINQ queries are not supported when precompiling queries.` はアプリではなく optimize コマンドから出ます。クエリが複数の文にまたがって組み立てられている (`if` の中の `query = query.Where(...)` など) という意味です。ドキュメントが明示しているとおり、条件式の後ろに完結したクエリを 2 本並べる形に書き換えてください。

`Design-time DbContext operations are not supported when publishing with NativeAOT.` は `EnsureCreated`、`Migrate`、`GenerateCreateScript`、またはスイッチが切られた構成に対して動くデザイン時ツールです。これは `dotnet ef` 自体もブロックする点に注意してください。`DynamicCodeSupport=false` のプロジェクトで `dotnet ef dbcontext optimize` を実行すると同じ NativeAOT 系のエラーで失敗します。この鶏と卵の問題こそが、別のクラスライブラリを必要にしている理由です。

トリミング済みまたは AOT のアプリで起動時に出る `PlatformNotSupportedException` は原因の異なる別の失敗です。[Native AOT での PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) の解説を参照してください。

## 関連記事

- [Native AOT とは何か、そして何を犠牲にするのか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/) は、このスイッチが有効化しようとしているトレードオフを扱っています。
- [.NET 11 Preview 6 で MAUI モバイルは CoreCLR のみに](/ja/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) は、インタープリターという脱出口に賞味期限がある理由を説明しています。
- [トリミング安全なコードとは何か、どう書くのか](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) は、スイッチを上書きするのが危険な背景です。
- [修正: 'interceptors' 機能がこの名前空間で有効になっていない](/ja/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) は、手順 2 で遭遇する CS9137 を扱っています。
- [修正: CREATE DATABASE permission denied in database 'master'](/ja/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) は、`Migrate()` を呼ぶより SQL スクリプトを出荷したほうがよいもう 1 つのケースです。

## 参照元

- [NativeAOT サポートと事前コンパイル済みクエリ](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries)、EF Core ドキュメント。`InterceptorsNamespaces` の有効化、`Microsoft.EntityFrameworkCore.Tasks` パッケージ、動的クエリの制限を含みます。
- [コンパイル済みモデル](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models)、EF Core ドキュメント。`dotnet ef dbcontext optimize` とコンパイル済みモデルの制限について。
- `dotnet/efcore` の [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs) と [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs)。`RuntimeFeature.IsDynamicCodeSupported` の 2 つのチェックについて。
- `dotnet/macios` の [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets)。`DynamicCodeSupport` の既定値とインタープリターの条件について。
- このプロパティを導入した [dotnet/macios PR #18555](https://github.com/dotnet/macios/pull/18555)。
- リグレッションをワークロード更新に結び付けた元の報告、[dotnet/maui#23653](https://github.com/dotnet/maui/issues/23653) と [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595)。
