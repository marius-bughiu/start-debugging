---
title: "SDK スタイルのプロジェクトで厳密な名前付きアセンブリの完全な公開キーを InternalsVisibleTo に追加する方法"
description: "署名済みアセンブリは、フレンドをトークンではなく 320 文字の完全な公開キーで指定する必要があり、そうしないとビルドが CS1726 または CS0281 で失敗します。sn -p と sn -tp、またはクロスプラットフォームの .NET スクリプトでキーを取得し、.csproj の InternalsVisibleTo 項目の Key メタデータに設定します。PublicKey プロパティによるフォールバック、Moq の DynamicProxyGenAssembly2 のキー、改行の落とし穴も扱います。"
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "msbuild"
  - "unit-testing"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-add-a-strong-named-assemblys-full-public-key-to-internalsvisibleto"
translatedBy: "claude"
translationDate: 2026-10-04
---

結論から言うと、アクセスを許可する側のアセンブリが厳密な名前付きの場合、`InternalsVisibleTo` にはフレンドアセンブリの**完全な公開キー** (`0024000004800000...` で始まる長い 16 進文字列) を指定する必要があり、16 文字の `PublicKeyToken` は使えません。SDK スタイルのプロジェクトでは、このために `AssemblyInfo.cs` は不要です。`ItemGroup` に `<InternalsVisibleTo Include="MyLib.Tests" Key="0024000004800000940000000602..." />` を追加すれば、SDK が属性を生成してくれます。キーは、Windows ではフレンドの `.snk` から `sn -p key.snk key.pub` に続けて `sn -tp key.pub` を実行して取得するか、どの OS でも以下の小さな .NET スクリプトで取得できます。キーはスペースや改行を含まない 1 つの連続した文字列でなければならず、そうでない場合、コンパイラーはその許可を黙って無視します。

この記事の内容はすべて、macOS 上の .NET 10 (SDK 10.0.302) で、厳密な名前付きのクラスライブラリと厳密な名前付きのテストプロジェクトを対象に実行したものなので、以下に引用するエラーテキストは実際のコンパイラー出力です。この MSBuild 項目は .NET 5 SDK からサポートされており、コンパイラー側のルールは .NET Framework 2.0 以降変わっていません。

## 完全なキーがない場合に発生する 2 つのエラー

多くの人が使っている構成から始めます。署名済みのライブラリと署名済みのテストプロジェクトに、署名なしのプロジェクトなら問題なく動く項目を加えたものです。

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <SignAssembly>true</SignAssembly>
    <AssemblyOriginatorKeyFile>../lib.snk</AssemblyOriginatorKeyFile>
  </PropertyGroup>
  <ItemGroup>
    <InternalsVisibleTo Include="Contoso.Core.Tests" />
  </ItemGroup>
</Project>
```

```csharp
// Contoso.Core/PriceCalculator.cs, .NET 10, C# 14
namespace Contoso.Core;

internal static class PriceCalculator
{
    internal static decimal ApplyDiscount(decimal price, decimal percent) =>
        price * (1 - percent / 100m);
}
```

ビルドは**ライブラリ**の中で、自分では書いていないファイルで失敗します。

```text
obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs(20,12): error CS1726: Friend assembly reference
'Contoso.Core.Tests' is invalid. Strong-name signed assemblies must specify a public key in their
InternalsVisibleTo declarations.
```

SDK は `InternalsVisibleTo` 項目を、生成された `AssemblyInfo.cs` 内の `[assembly: InternalsVisibleTo("Contoso.Core.Tests")]` に変換し、コンパイラーがそれを拒否します。理由は ID にあります。厳密な名前付きアセンブリの名前は、簡易名、バージョン、カルチャ、公開キーの組です。簡易名だけへの許可では、誰でも署名なしの `Contoso.Core.Tests.dll` をコンパイルして内部メンバーを読めてしまい、署名する意味がなくなります。そのため、許可にはキーを指定する必要があります。

すべてのアセンブリ修飾名に現れるため多くの人が手元に持っているトークンを試しても、同じエラーになります。

```xml
<InternalsVisibleTo Include="Contoso.Core.Tests, PublicKeyToken=90d333c425def132" />
```

```text
error CS1726: Friend assembly reference 'Contoso.Core.Tests, PublicKeyToken=90d333c425def132' is invalid.
Strong-name signed assemblies must specify a public key in their InternalsVisibleTo declarations.
```

トークンはキーの SHA-1 から取った 8 バイトの断片です。キーを識別はできても検証はできないため、コンパイラーは完全なキーしか受け付けません。バージョン、カルチャ、プロセッサアーキテクチャも拒否されます。この属性が受け付けるのは、簡易名と、省略可能な `PublicKey=` だけです。

2 つ目のエラーは、キーを渡したもののそれが間違っている場合に発生します。以下は、ライブラリが自分自身のキー (よくあるコピー&ペーストのミス) や古い `.snk` のキーでアクセスを許可したときのビルド出力です。

```text
Contoso.Core.Tests/Program.cs(1,32): error CS0281: Friend access was granted by 'Contoso.Core,
Version=1.0.0.0, Culture=neutral, PublicKeyToken=d2571df32581560a', but the public key of the output
assembly ('0024000004800000940000000602000000240000525341310004000001000100d938...') does not
match that specified by the InternalsVisibleTo attribute in the granting assembly.
```

CS0281 は**フレンド**側のプロジェクトで報告され、フレンドが実際に持っているキーを表示するので、2 つのうちこちらの方が役に立ちます。フレンドが署名済みなら、エラーメッセージからその 16 進文字列をそのまま許可にコピーできます。かっこの中が空 (`('')`) の場合、フレンドはまったく署名されていません。署名するか、許可からキーを削除してください。

## ステップ 1: フレンドの完全な公開キーを取得する

必要なのは、アクセスを**受け取る**側のアセンブリ (テストプロジェクト、ベンチマークプロジェクト、モックライブラリのプロキシアセンブリ) の公開キーであり、許可する側のライブラリのキーではありません。

### Windows で sn.exe を使う

厳密名ツールは Windows SDK に含まれており、Developer Command Prompt ではパスが通っています。キーペアの `.snk` から直接キーを表示することはできないため、2 段階の手順になります。

```bash
# Windows, Developer Command Prompt for VS 2026
sn -p Contoso.Core.Tests.snk Contoso.Core.Tests.pub
sn -tp Contoso.Core.Tests.pub
```

`sn -p` は公開部分を新しいファイルに抽出します。`sn -tp` は公開キーとそのトークンを表示します。キーは複数行に折り返して表示されるので、使う前に 1 つの文字列に連結してください。コンパイル済みの DLL しかない場合は、`sn -Tp Contoso.Core.Tests.dll` (大文字の `T`) でアセンブリからキーを読み取れます。

### どの OS でも .NET スクリプトを使う

`sn.exe` は macOS や Linux には存在せず、.NET SDK にも含まれていません。形式は自分で計算できるほど単純です。以下を `snkpub.cs` として保存し、`dotnet run snkpub.cs -- <file>` で実行します (ファイルベースのアプリには .NET 10 SDK が必要です)。

```csharp
// snkpub.cs, .NET 10, C# 14: print the full public key (and token) of a .snk, a .pub or a signed .dll
using System.Reflection;
using System.Security.Cryptography;

var path = args[0];
byte[] publicKey;
if (path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
{
    publicKey = AssemblyName.GetAssemblyName(path).GetPublicKey()
        ?? throw new InvalidOperationException("Assembly is not strong-named.");
}
else if (File.ReadAllBytes(path) is [0x06 or 0x07, ..] capiBlob) // full key pair .snk
{
    using var rsa = new RSACryptoServiceProvider();
    rsa.ImportCspBlob(capiBlob);
    byte[] blob = rsa.ExportCspBlob(includePrivateParameters: false); // PUBLICKEYBLOB
    BitConverter.TryWriteBytes(blob.AsSpan(4), 0x00002400); // aiKeyAlg = CALG_RSA_SIGN, as the compiler writes it
    // Strong-name public key = SigAlgID (CALG_RSA_SIGN) + HashAlgID (CALG_SHA1) + blob length + blob
    publicKey = [.. BitConverter.GetBytes(0x00002400), .. BitConverter.GetBytes(0x00008004),
                 .. BitConverter.GetBytes(blob.Length), .. blob];
}
else
{
    publicKey = File.ReadAllBytes(path); // public-key-only file from "sn -p", already in this format
}
byte[] hash = SHA1.HashData(publicKey);
byte[] token = hash[^8..];
Array.Reverse(token);
Console.WriteLine($"PublicKey={Convert.ToHexStringLower(publicKey)}");
Console.WriteLine($"PublicKeyToken={Convert.ToHexStringLower(token)}");
```

`.snk` ファイルは Windows CryptoAPI の `PRIVATEKEYBLOB` です。メタデータに格納される厳密名の公開キーは、12 バイトのヘッダー (署名アルゴリズム、ハッシュアルゴリズム、BLOB の長さ) の後に CryptoAPI の `PUBLICKEYBLOB` が続いたものです。自明でない行は `aiKeyAlg` の書き換えだけです。コンパイラーは BLOB ヘッダーに常に `CALG_RSA_SIGN` (`0x2400`) を書き込みますが、`RSACryptoServiceProvider` や一部のツールで生成したキーは `CALG_RSA_KEYX` (`0xA400`) を持っています。この書き換えがないと、スクリプトは本物と 1 バイトだけ異なるキーを出力し、ぱっと見では同一に見える 2 つのキーで CS0281 が発生します。この記事を検証している最中に、私もまさにそれに遭遇しました。

誰もが知っているキーでスクリプトを確認するには、Castle DynamicProxy の [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk) に対して実行します。Moq が `DynamicProxyGenAssembly2` 用に記載しているのと同じ `0024...5cc7` のキー (トークン `a621a9e7e5c32e69`) が出力されます。`.snk` の代わりに署名済み DLL を渡すのが最も確実な確認方法です。その場合、コンパイラーが実際に比較に使うキーを読み取ることになるからです。

## ステップ 2: キーをプロジェクトファイルに記述する

.NET SDK の `Microsoft.NET.GenerateAssemblyInfo.targets` は、すべての `InternalsVisibleTo` 項目で `Key` メタデータを読み取ります。そこにキーを貼り付けます。

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<ItemGroup>
  <InternalsVisibleTo Include="Contoso.Core.Tests"
                      Key="0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec01921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae125d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6" />
</ItemGroup>
```

生成された `obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs` には次の内容が含まれるようになります。

```csharp
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(@"Contoso.Core.Tests, PublicKey=0024000004800000940000000602...")]
```

ビルドすると、テストプロジェクトから再び `PriceCalculator.ApplyDiscount` を呼び出せるようになります。`PublicKey` メタデータは `Key` の別名として機能します。targets が属性を生成する前に値をコピーするため、`<InternalsVisibleTo Include="Contoso.Core.Tests" PublicKey="0024..." />` でもまったく同じようにビルドされます。SDK のドキュメントに記載されている名前なので、`Key` を使ってください。

ソースに属性を書く方が好みなら、その方法も引き続き使えます。C# は定数文字列の連結をコンパイル時に畳み込むので、巨大な 1 行を書くよりも優れています。

```csharp
// Contoso.Core/FriendAssemblies.cs, .NET 10, C# 14
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Contoso.Core.Tests, PublicKey=" +
    "0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa" +
    "216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec0" +
    "1921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae1" +
    "25d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6")]
```

同じフレンドに対して両方のスタイルを混在させないでください。属性が 2 つになり、キーをローテーションしたときに片方しか更新されなくなります。

## 多数のフレンドに 1 つのキー: PublicKey プロパティ

ほとんどのソリューションでは、すべてのプロジェクトを同じ `.snk` で署名します。そうなるとすべての許可に同じキーが必要になり、項目ごとに 320 文字の 16 進数を繰り返すのはノイズでしかありません。同じ targets ファイルにはフォールバックがあります。`InternalsVisibleTo` 項目に `Key` がない場合、MSBuild の**プロパティ** `$(PublicKey)` が使われます。dotnet/runtime のビルドに使われている dotnet/arcade SDK はこの方法で `$(PublicKey)` を設定しており、それらのリポジトリはこうしてテストアセンブリに内部メンバーへのアクセスを許可しています。

```xml
<!-- Directory.Build.props at the repo root, .NET 10 SDK -->
<Project>
  <PropertyGroup>
    <SignAssembly>true</SignAssembly>
    <AssemblyOriginatorKeyFile>$(MSBuildThisFileDirectory)build/Contoso.snk</AssemblyOriginatorKeyFile>
    <PublicKey>0024000004800000940000000602000000240000525341310004000001000100d938683d...</PublicKey>
  </PropertyGroup>
</Project>
```

```xml
<!-- Any library project -->
<ItemGroup>
  <InternalsVisibleTo Include="$(AssemblyName).Tests" />
  <InternalsVisibleTo Include="Contoso.Benchmarks" />
</ItemGroup>
```

これについて 2 つのことを検証しました。1 つ目に、SDK は `AssemblyOriginatorKeyFile` から `$(PublicKey)` を自動的に設定**しません**。署名を有効にしてプロパティを設定しない場合、キーなしの項目は依然として CS1726 で失敗します。2 つ目に、このプロパティを設定してもライブラリ自体の署名方法は変わりません。署名済み DLL は引き続き自身の `.snk` から得たトークンを持っていました。このプロパティは属性ジェネレーターに値を渡すだけです。明示的な `Key` を持つ項目はプロパティより優先されます。これは、次のセクションのようなサードパーティのフレンドにとって望ましい動作です。

## Moq、NSubstitute などの Castle プロキシへのアクセスを許可する

厳密な名前付きライブラリの `internal` インターフェースをモックするには、2 つ目の許可が必要です。モック型はテストアセンブリではなく、実行時に `DynamicProxyGenAssembly2` という動的アセンブリに出力されるためです。Castle DynamicProxy はその動的アセンブリを固定のキーで署名するので、Moq、NSubstitute、FakeItEasy のいずれでも許可は常に同じ形になります。

```xml
<!-- .NET 10 SDK; key from Castle.Core's DynProxy.snk, documented by Moq -->
<ItemGroup>
  <InternalsVisibleTo Include="DynamicProxyGenAssembly2"
                      Key="0024000004800000940000000602000000240000525341310004000001000100c547cac37abd99c8db225ef2f6c8a3602f3b3606cc9891605d02baa56104f4cfc0734aa39b93bf7852f7d9266654753cc297e7d2edfe0bac1cdcf9f717241550e0a7b191195b7667bb4f64bcb8e2121380fd1d9d46ad2d92d2d15605093924cceaf74c4861eff62abf69b9291ed0a340e113be11e6a7d3113e92484cf7045cc7" />
</ItemGroup>
```

これがないと、型が `DynamicProxyGenAssembly2` からアクセスできないことを示す Castle の実行時例外で失敗し、そのメッセージ自体に追加すべき属性が含まれています。ライブラリが署名されていない場合は、キーなしの `<InternalsVisibleTo Include="DynamicProxyGenAssembly2" />` で十分です。

## 注意点

**改行やスペースはエラーなしで許可を壊します。** 320 文字の `Key` 属性を `.csproj` 内で複数行に折り返したくなるものです。MSBuild は空白をそのまま保持し、コンパイラーは結果を解析できず、ライブラリ側には警告が出るだけです。

```text
warning CS1700: Assembly reference 'Contoso.Core.Tests, PublicKey=00240000048000009400...' is invalid and cannot be resolved
```

続いて、テストプロジェクトで `error CS0122: 'PriceCalculator' is inaccessible due to its protection level` が発生します。警告をエラーとして扱っていればすぐに気付きますが、そうでなければ CS0122 は許可がまったく存在しないように見えます。キーは 1 行に収めるか、上で示した C# の連結を使ってください。

**フレンドは実際に署名されている必要があります。** キー付きの許可は、そのキーで署名されたフレンドにしか一致しません。私の検証では、テストプロジェクトで `SignAssembly` を無効にすると、空のキー `('')` を伴う CS0281 が発生しました。逆方向は寛容です。署名なしのライブラリは署名済みのフレンドに簡易名でアクセスを許可でき、コンパイラーはそれを受け入れます。

**公開署名と遅延署名も署名済みとして扱われます。** オープンソースのリポジトリでは、キーの公開部分だけをコミットし、`<PublicSign>true</PublicSign>` を設定することがよくあります。そうすればコントリビューターは秘密キーなしで Linux や macOS でビルドできます。これはフレンドのチェックでも機能します。`.pub` ファイルだけで公開署名したテストプロジェクトは、そのキーを使った許可に対してビルドも実行もできました。コンパイラーはキーを比較するだけで、署名は検証しません。遅延署名や公開署名のアセンブリを .NET Framework で実行するのは別の問題ですが、.NET Core 以降は読み込み時に厳密名の署名を無視します。

**キーをローテーションするとすべての許可を更新する必要があります。** 新しい `.snk` を生成すると (たとえば古いキーが 1024 ビットだった、または漏洩したなどの理由で)、公開キーとトークンが変わるため、そのフレンドを指定しているすべての `InternalsVisibleTo` も合わせて変更する必要があります。`Directory.Build.props` の `$(PublicKey)` プロパティを使えば、それは 1 行の変更で済みます。リポジトリ内で古いトークンも検索してください。構成ファイル内のアセンブリ修飾型名やバインディングリダイレクトにもトークンが含まれています。

**厳密な名前付けの効果は以前ほど大きくありません。** .NET Core および .NET 5 以降では、ランタイムは厳密名の署名を検証せず、バインディングは統合のためにキーを無視します。Microsoft の現在のガイダンスでは、ほとんどのライブラリは、それを必要とする .NET Framework のコードから使われるのでない限り、厳密な名前付けは不要とされています。ソリューション全体を自分で管理していて最新の .NET だけを対象にしているなら、署名を無効にすればこの種の問題はすべてなくなります。.NET Framework の利用者向けに出荷するなら、署名を維持して上記のパターンを使ってください。

**許可は必要以上に広い場合があります。** 許可は、必要だった 1 つの型だけでなく、すべての internal 型をフレンドに公開します。minimal hosting に対する統合テストでは、通常は `public partial class Program` の方が範囲を絞った選択肢です。

### 次に読む

- [ASP.NET Core 11 で WebApplicationFactory を使って統合テストを書く方法](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) では、テストアセンブリにすべての内部メンバーへのアクセスを許可する代わりとなる `public partial class Program` を扱っています。
- [公開済みの .NET アプリで "Could not load file or assembly" を修正する方法](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) では、公開キートークンが同じく登場する、アセンブリ ID のバインディング側について説明しています。
- [Directory.Packages.props を使って .NET ソリューションを Central Package Management に移行する方法](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) は、共有の `$(PublicKey)` プロパティと同じ、ルートレベルの MSBuild ファイルのパターンを使っています。
- [2026 年の xUnit v3 vs NUnit vs MSTest](/ja/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) は、アクセスを許可する対象のテストプロジェクトのフレームワーク選びに役立ちます。
- [変更追跡を壊さずに DbContext をモックする方法](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) は、すべての internal メンバーをテスト可能にするのに Castle プロキシが必要なわけではないことを思い出させてくれます。

### 参考資料

- [`InternalsVisibleToAttribute` の補足説明](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-runtime-compilerservices-internalsvisibletoattribute)、.NET ドキュメント
- [フレンドアセンブリ](https://learn.microsoft.com/en-us/dotnet/standard/assembly/friend)、.NET ドキュメント
- [.NET SDK プロジェクトの MSBuild リファレンス: `InternalsVisibleTo`](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props#internalsvisibleto)、.NET ドキュメント
- [Sn.exe (厳密名ツール)](https://learn.microsoft.com/en-us/dotnet/framework/tools/sn-exe-strong-name-tool)、.NET Framework ドキュメント
- [厳密な名前付きアセンブリ](https://learn.microsoft.com/en-us/dotnet/standard/assembly/strong-named) と [ライブラリの厳密な名前付けに関するガイダンス](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/strong-naming)、.NET ドキュメント
- [`Microsoft.NET.GenerateAssemblyInfo.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets)、dotnet/sdk (`Key`、`PublicKey` メタデータと `$(PublicKey)` フォールバック)
- [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk)、castleproject/Core
