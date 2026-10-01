---
title: "修正: Microsoft.Testing.Platform で dotnet test が終了コード 5 と \"Zero tests ran\" を返す"
description: "終了コード 5 は、テストがないのではなく MTP がコマンドラインオプションを拒否したことを意味します。テスト実行ファイルを直接実行して本当のエラーを確認し、拡張パッケージを追加するか、オプションをプロジェクトごとに振り分けてください。"
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-01
---

`dotnet test` が `Zero tests ran` に続けて `Exit code: 5` を出力する場合、渡した引数のどれかをテストアプリが拒否したため、テストは一度も検出されていません。Microsoft.Testing.Platform (MTP) では、終了コード 5 は「コマンドライン引数が無効」を意味しますが、`dotnet test` はその説明を捨ててしまいます。同じ引数でビルド済みのテスト実行ファイルを直接実行して (`./bin/Debug/net10.0/MyTests --logger trx`)、本当のメッセージを確認してください。そのうえで、そのオプションを提供する拡張パッケージを参照するか、VSTest 時代のフラグを MTP の同等フラグに置き換えるか、`TestingPlatformCommandLineArguments` でそのオプションを理解するプロジェクトにだけ振り分けます。

以下はすべて、macOS arm64 上の .NET 10 SDK 10.0.302 と .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) で、MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1)、MSTest.Sdk 4.3.3 (MTP 2.3.3)、xunit.v3.mtp-v2 4.0.1 を使い、`dotnet test` を MTP モードに切り替える `global.json` を置いて計測した結果です。

## エラーの全体像

これは、問題のない 2 つのテストを持つ MSTest プロジェクトに対して、SDK 10.0.302 で `dotnet test --project MsTests --logger trx` を実行したときの出力のすべてです。

```text
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0) Zero tests ran
Exit code: 5

Test run summary: Zero tests ran
  error: 1

  total: 0
  failed: 0
  succeeded: 0
  skipped: 0
  duration: 82ms
Test run completed with non-success exit code: 5 (see: https://aka.ms/testingplatform/exitcodes)
```

足りないものに注目してください。ターゲットフレームワークが `(net10.0|arm64)` ではなく `(net10.0)` と表示されており、`Running tests from ...` の行もありません。テストホストはテスト検出に到達していません。`--output Detailed`、`-v detailed`、`--diagnostic` を追加しても理由は表示されず、`--diagnostic` が書き出す `.diag` ファイルにも生のコマンドラインが記録されるだけです。

.NET 11 RC 1 SDK では、サマリー行が `Test run summary: Failed!` に変わり、新しい `Handshake failures:` セクションにモジュールが列挙されますが、理由は依然として表示されません。

複数のテストプロジェクトがあるソリューションでは、1 つが失敗して別の 1 つが成功するため、さらに読み違えやすくなります。

```text
XTests/bin/Debug/net10.0/XTests.dll (net10.0) Zero tests ran
Exit code: 5
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0|arm64) passed (848ms)
Test run summary: Failed!
  error: 1
  total: 2
```

## MTP が終了コード 5 を返し、テストが 0 件と表示される理由

MTP のテストプロジェクトは通常のコンソール実行ファイルです。MTP モードの `dotnet test` は各テストプロジェクトをビルドし、実行ファイルを起動し、自身が消費しない引数をすべて転送して、名前付きパイプ経由でプロセスと通信します。テストアプリは何よりも先にコマンドラインを検証します。未知のオプションがある場合や、既知のオプションに無効な値が渡された場合は、終了コード 5 で終了し、テストを 1 件も検出しません。[MTP の終了コード表](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting#exit-codes)は、5 を「テストアプリに渡されたコマンドライン引数が無効」と定義しています。

すると `dotnet test` は、結果を出さなかった他のモジュールと同じ方法でそのモジュールを報告します。それが `Zero tests ran` です。この文言は技術的には正しいものの、まったく誤解を招きます。`[TestMethod]` 属性の欠落やフィルターの不具合を探しに行かせてしまうからです。

オプションが未知になる原因は 4 つあり、実際のパイプラインで見かける順に並べています。

1. **VSTest のフラグが移行後も残っている。** `--logger trx`、`--collect "XPlat Code Coverage"`、`--blame-hang-timeout 5m`、`--blame-crash` は VSTest のものです。MTP には `--logger` も `--collect` もありません。
2. **拡張パッケージがない。** MTP のコアにはレポーター、カバレッジ、ダンプ、リトライが含まれません。`--report-trx` は `Microsoft.Testing.Extensions.TrxReport` を参照したときにだけ存在し、`--coverage` には `Microsoft.Testing.Extensions.CodeCoverage` が必要で、他も同様です。
3. **1 つのソリューションにフレームワークが混在している。** MSTest.Sdk は TRX とコードカバレッジをデフォルトで有効にしますが、素の xUnit v3 プロジェクトは有効にしません。同じ `dotnet test --solution` のコマンドラインが、一方のプロジェクトでは有効で、もう一方では無効になります。
4. **有効なオプションに不正な値を渡している。** エージェント上に存在しないファイルを指す `--settings` や、単位の接尾辞がない `--timeout 30` などです。

終了コード 8 は、同じ `Zero tests ran` の文言を出す別の失敗です。この場合は引数に問題がなく、テストアプリは検出を実行しましたが、何も一致しませんでした。`Exit code:` の行と、`Running tests from ...` が表示されているかどうかで見分けられます。

## 最小再現

`global.json` で `dotnet test` を MTP モードにオプトインします (.NET 10 SDK 以降で必要です。これがないと VSTest ブリッジのままです)。

```json
// .NET 10 SDK 10.0.302
{
  "sdk": { "version": "10.0.302" },
  "test": { "runner": "Microsoft.Testing.Platform" }
}
```

MSTest SDK を使う MSTest プロジェクトです。

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MsTests/Tests.cs, .NET 10, MSTest 4.4.1
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MsTests;

[TestClass]
public class CalculatorTests
{
    [TestMethod]
    public void Adds() => Assert.AreEqual(4, 2 + 2);

    [TestMethod, TestCategory("Slow")]
    public void Multiplies() => Assert.AreEqual(6, 2 * 3);
}
```

そして、その隣にある xUnit v3 プロジェクトです。

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  </ItemGroup>
</Project>
```

SDK 10.0.302 で各コマンドが返した結果は次のとおりです。

| コマンド | 終了コード | サマリーの内容 |
| --- | --- | --- |
| `dotnet test --project MsTests` | 0 | 成功、2 テスト |
| `dotnet test --project MsTests --logger trx` | 5 | Zero tests ran |
| `dotnet test --project MsTests --collect "XPlat Code Coverage"` | 5 | Zero tests ran |
| `dotnet test --project MsTests --blame-hang-timeout 5m` | 5 | Zero tests ran |
| `dotnet test --project MsTests --report-trx` | 0 | 成功、TRX を出力 |
| `dotnet test --solution All.sln --report-trx` | 5 | MSTest は成功、xUnit は "Zero tests ran" |
| `dotnet test --solution All.sln --coverage` | 5 | MSTest は成功、xUnit は "Zero tests ran" |
| `dotnet test --solution All.sln --settings x.runsettings` (ファイルなし) | 5 | 両方とも "Zero tests ran" |
| `dotnet test --project MsTests --filter "TestCategory=DoesNotExist"` | 8 | Zero tests ran (本当に 0 件) |
| `dotnet test --project MsTests --minimum-expected-tests 5` | 9 | 期待される最小テスト数のポリシー違反 |

## 修正の詳細

### 1. テストアプリから本当のエラーメッセージを取り出す

CI が渡しているのとまったく同じ引数で、ビルド済みの実行ファイルを自分で実行します。Windows では `MsTests.exe` で、Linux と macOS では拡張子がありません。

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
./MsTests/bin/Debug/net10.0/MsTests --logger trx
```

```text
Unknown option '--logger'
Option '--logger' uses VSTest syntax, which is not supported by Microsoft.Testing.Platform.
Use '--report-trx' instead.
Run '--help' to see the options registered by this test application. If the option belongs to an extension, ensure its package is referenced and the extension is registered.
Command line: --logger trx
```

`dotnet run --project MsTests --no-build -- --logger trx` でも同じ内容が表示され、同じく 5 を返します。"uses VSTest syntax ... Use '--report-trx' instead" というヒントは MTP 2.4 で追加されました。MTP 2.3.3 (MSTest.Sdk 4.3.3) では `Unknown option '--logger'` とそれに続くヘルプテキストだけが表示されますが、それでも十分です。

次に、アプリが実際に持っているオプションを問い合わせます。`--help` はプラットフォームのオプションと、参照しているパッケージが提供する "Extension options" を別々に列挙します。`--info` はプラットフォームのバージョンと、登録されているすべての拡張をそれぞれのバージョン付きで出力します。

```bash
# .NET 10 SDK 10.0.302
./XTests/bin/Debug/net10.0/XTests --help
./XTests/bin/Debug/net10.0/XTests --info
```

渡しているオプションがその一覧にない場合は、終了コード 5 で失敗します。この確認だけで、この種の問題の大半は解決します。

### 2. VSTest のフラグを MTP の同等フラグに置き換える

| VSTest の引数 | MTP の引数 | 提供するパッケージ |
| --- | --- | --- |
| `--logger trx` | `--report-trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--logger trx;LogFileName=x.trx` | `--report-trx --report-trx-filename x.trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--collect "Code Coverage"` | `--coverage` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--collect "XPlat Code Coverage"` | `--coverage --coverage-output-format cobertura` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--blame-hang-timeout 5m` | `--hangdump --hangdump-timeout 5m` | `Microsoft.Testing.Extensions.HangDump` |
| `--blame-crash` | `--crashdump` | `Microsoft.Testing.Extensions.CrashDump` |
| `--results-directory` | `--results-directory` | 組み込み |

執筆時点の最新バージョンは、TrxReport、HangDump、CrashDump が 2.4.1、CodeCoverage が 18.11.2 です。完全な対応表は [MTP CLI オプションのリファレンス](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options)にあります。`--filter` は MSTest と NUnit では VSTest の式構文のまま使えるため、通常は変更する必要がありません。

### 3. オプションを受け取るすべてのプロジェクトで拡張を参照する

再現環境では、ソリューション全体への `--report-trx` が失敗したのは、xUnit プロジェクトにレポーターがなかったことだけが原因でした。それを追加すると実行が通りました。

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<ItemGroup>
  <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.1" />
</ItemGroup>
```

```text
MsTests.dll (net10.0|arm64) passed (837ms)
XTests.dll (net10.0|arm64) passed (922ms)
Test run summary: Passed!
  total: 4
```

すべてのテストプロジェクトで TRX とカバレッジを出力したい場合は、`IsTestProject` を条件にした `Directory.Build.props` に参照を置くと、新しいプロジェクトも自動的に取り込まれます。MSTest.Sdk プロジェクトにはすでにこれらが含まれているため、参照の重複を避けたい場合は条件 `'$(UsingMSTestSdk)' != 'true'` を追加してください。

### 4. TestingPlatformCommandLineArguments でオプションをプロジェクトごとに振り分ける

拡張をすべてのプロジェクトに入れたくない場合もあります。統合テストプロジェクトのカバレッジはたいていノイズになりますし、ダンプはハングするプロジェクトでだけ役に立ちます。`dotnet test` のコマンドラインでオプションを渡す代わりに、それを理解するプロジェクトの中に書きます。

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <TestingPlatformCommandLineArguments>$(TestingPlatformCommandLineArguments) --coverage --coverage-output-format cobertura</TestingPlatformCommandLineArguments>
  </PropertyGroup>
</Project>
```

これを設定すると、素の `dotnet test --solution All.sln` が終了コード 0 を返し、xUnit プロジェクトはカバレッジなしで実行され、MSTest プロジェクトは `TestResults` に `.cobertura.xml` を書き出しました。Microsoft は[テストフレームワークや拡張が混在するソリューション](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions)に対して同じ方法を文書化しています。`Directory.Build.props` の値が上書きされないよう、`$(TestingPlatformCommandLineArguments)` は先頭に置いてください。

### 5. 名前だけでなく値も検証する

オプションが `--help` に載っているのに終了コード 5 になる場合は、値が間違っています。再現環境では、存在しないファイルを指す `--settings x.runsettings` が両方のプロジェクトを終了コード 5 で失敗させました。パスはテストプロセスの作業ディレクトリから解決されますが、CI ではそれがリポジトリのルートとは限りません。MTP では時間の値に単位が必要です。`--timeout 30m` は動作しますが、数字だけでは動作しません。

## 終了コード 8: 本当にテストが 0 件だった場合

終了コードが 8 の場合、引数は受け入れられており、フィルターまたはプロジェクトの結果としてテストがなかっただけです。MTP はこれをデフォルトで失敗として扱います。0 を返していた VSTest とは異なります。対処は 3 つあります。

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1

# Accept an empty run for this invocation (returns 0)
dotnet test --project MsTests --filter "TestCategory=Nightly" --ignore-exit-code 8

# Or demand a floor: fewer than 50 tests returns exit code 9
dotnet test --solution All.sln --minimum-expected-tests 50
```

`--ignore-exit-code` は環境変数 `TESTINGPLATFORM_EXITCODE_IGNORE` からも読み取られるため、同じフィルターを多数のパイプラインで実行する場合に便利です。使うのは控えめにしてください。何にも一致しないフィルターが黙って通ってしまうことこそ、終了コード 8 が検出するために設計されたバグです。

複数プロジェクトの実行では、SDK のバージョンが影響します。SDK 10.0.302 では、一方のプロジェクトがフィルターに一致し、もう一方が何にも一致しなかったソリューション実行は、全体として 8 を返しました。.NET 11 RC 1 SDK では、同じコマンドが `Test run summary: Passed!` とともに 0 を返しつつ、空のモジュールの横には `Exit code: 8` を表示しました。これは .NET 11 SDK で新しくなった[実行全体でのテスト 0 件の判定](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)です。同じフィルターで CI が .NET 10 では赤く、.NET 11 では緑になる場合は、これが理由です。終了コード 5 は変わっていません。どちらの SDK でも、いずれかのモジュールが引数を拒否すると実行全体が失敗します。

## 落とし穴と紛らわしい症状

- **サマリーの `error: 1` はテストではなくモジュールです。** 異常終了したモジュールの数を数えています。テストが実行されていないため、`failed: 0` はゼロのままです。
- **`dotnet test -- --some-option` は役に立ちません。** MTP モードでは、どちらの形でも引数が転送されるため、ダブルダッシュではテストアプリから引数を隠せません。
- **MTP のフィルターが何にも一致しない場合は、5 ではなく 8 を返します。** `Zero tests ran` の前に `Running tests from ...` が表示されているなら、引数は問題ありません。代わりにそのフレームワークのフィルター構文を確認してください。
- **`--zero-tests-policy strict` は、すべてスキップされた実行の結果を変えませんでした。** ドキュメントでは、strict はスキップされたテストを未実行として扱うとあります。MTP 2.4.1 では、唯一のテストに `[Ignore]` が付いたプロジェクトが strict でも 0 を返したため、唯一の防御策として頼らないでください。`--minimum-expected-tests` は明示的で信頼できます。
- **"No test projects were found" は別の問題です。** こちらはテストアプリではなくプロジェクトの評価で発生し (典型的には、`obj` フォルダーのないコンテナーステージでの `--no-restore`)、MTP のトラブルシューティングのページで扱われています。
- **Test Explorer では、これとは別の形で現れることがあります。** CLI は緑なのに Visual Studio が xUnit v3 でハングする場合は、引数の問題ではなく、ランナーの不一致です。

## 関連記事

- 段階的な[VSTest から Microsoft.Testing.Platform への移行](/ja/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/)では、`.runsettings` から `testconfig.json` への移行を含む、CI のその他の変更を扱っています。
- CLI は成功するのに Visual Studio がハングする場合は、[Test Explorer が xUnit v3 でハングするのに dotnet test は成功する問題](/ja/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)を参照してください。
- 新しいソリューションのフレームワーク選びで、MTP 対応を比較したもの: [2026 年の xUnit v3 vs NUnit vs MSTest](/ja/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)。
- 古い xUnit プロジェクトを先に MTP へ移す場合: [テストプロジェクトを xUnit v2 から xUnit v3 へ移行する](/ja/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)。
- 失敗をプルリクエスト上に直接注釈として表示するには: [Microsoft.Testing.Platform 2.3 の GitHub Actions 注釈](/ja/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)。

## 参考資料

- [Microsoft.Testing.Platform troubleshooting: exit codes and unrecognized extension options](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting)
- [Microsoft.Testing.Platform CLI options reference](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options)
- [Testing with dotnet test: solutions with mixed test frameworks or extensions](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions)
- [dotnet test in MTP mode, including whole-run minimums](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [microsoft/testfx repository (MSTest and Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
