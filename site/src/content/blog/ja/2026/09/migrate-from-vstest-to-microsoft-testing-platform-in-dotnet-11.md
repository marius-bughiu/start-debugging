---
title: ".NET 11 SDK で VSTest から Microsoft.Testing.Platform へ移行する"
description: "VSTest から Microsoft.Testing.Platform 2.3.3 への手順ごとの移行ガイドです。OutputType Exe によるオプトイン、global.json でのランナー切り替え、ロガーからレポーターへの改名、.runsettings から testconfig.json への置き換え、そして緑だった CI ジョブを赤にする終了コードを扱います。"
pubDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "vstest"
  - "microsoft-testing-platform"
  - "testing"
  - "dotnet-11"
  - "dotnet"
  - "ci-cd"
lang: "ja"
translationOf: "2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-02
---

ソリューションを VSTest から Microsoft.Testing.Platform (MTP) へ移すのは、プロジェクトファイルの作業が半日、CI の作業が丸一日という規模です。プロジェクト側の作業はテストプロジェクトごとに 3 行だけで、`<OutputType>Exe</OutputType>`、テストフレームワークごとのオプトインプロパティ、そして `"runner": "Microsoft.Testing.Platform"` を設定した `global.json` です。実際に時間を食うのはその先にあるすべてです。パイプライン内のすべての `--logger`、`--collect`、`--blame` フラグは、NuGet パッケージを追加して初めて存在する別のオプションに対応し、`.runsettings` ファイルはほとんどの意味を失い、テストを 1 件も実行しなかったテストプロジェクトは成功する代わりに終了コード 8 でビルドを失敗させるようになります。本ガイドは .NET 11 SDK (Preview 7、2026 年 8 月)、Microsoft.Testing.Platform 2.3.3、MSTest 4.3.3、NUnit3TestAdapter 6.3.0、xunit.v3 4.0.0 を対象に書かれています。

## 今この切り替えを行う価値

- **これが進む方向です。** MSTest は 3.2.0 以降、NUnit は NUnit3TestAdapter 5.0.0 以降、それぞれ独自の MTP ランナーを備えており、xUnit v3 は最初から MTP の上に構築されています。VSTest はメンテナンス段階にあり、今年もっとも目立った変更は [Newtonsoft.Json への依存を外したこと](/ja/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)でした。
- **テストモジュールが既定で並列に実行されます。** VSTest は抵抗しない限りアセンブリを直列化します。MTP は最大で `Environment.ProcessorCount` 個のテストモジュールを同時に実行し、`--max-parallel-test-modules` で上限を設定できます。
- **外部ランナーが不要です。** テストプロジェクト自体が実行可能ファイルになります。`./MyApp.Tests` は `vstest.console.exe` も `dotnet test` もアダプター探索パスもなしにスイートを実行します。これはコンテナーイメージにとっても、CI の失敗をローカルで再現する場合にも効いてきます。
- **以前はスクリプトを書く必要があった実行単位のポリシー。** `--timeout`、`--maximum-failed-tests`、`--minimum-expected-tests`、`--ignore-exit-code` が第一級のオプションになり、後ろの 3 つは CI が必要とするからこそ存在しています。

## 何が壊れるか

| 領域 | 変更点 | 深刻度 |
| --- | --- | --- |
| プロジェクトの形 | テストプロジェクトは `<OutputType>Exe</OutputType>` を設定する必要があります | 高 |
| ソリューションの一貫性 | `global.json` で MTP を有効にすると、**すべての**テストプロジェクトが MTP を使う必要があります。混在したソリューションは警告ではなくエラーです | 高 |
| `--logger` | 「レポーター」に改名されました。`--logger trx` は `--report-trx` になり、`Microsoft.Testing.Extensions.TrxReport` が必要です | 高 |
| `--collect "Code Coverage"` | `--coverage` になり、`Microsoft.Testing.Extensions.CodeCoverage` が必要で、`IncludeTestAssembly` の既定値は `false` になりました | 高 |
| `--blame-crash` / `--blame-hang` | 別パッケージの `--crashdump` / `--hangdump` になります。`--blame-crash-collect-always` に相当するものはありません | 中 |
| テストが 0 件実行された場合 | VSTest は 0 を返します。MTP は終了コード 8 を返します | 高 |
| `.runsettings` | MSTest と NUnit の VSTest ブリッジ経由でのみサポートされます。プラットフォーム自体は `testconfig.json` を読みます | 中 |
| `dotnet test MyTests.csproj` | 位置指定のプロジェクトパスはなくなりました。`--project`、`--solution`、`--test-modules` を使います | 中 |
| xUnit のフィルター | `--filter` は実装されていません。`--filter-class`、`--filter-method`、`--filter-namespace`、`--filter-trait`、`--filter-query` を使います | 高 (xUnit のみ) |
| `RunConfiguration.TargetPlatform=x86` | `--arch x86` になります | 低 |
| コンソールのエンコーディング | MTP は常に UTF-8 を設定します。VSTest の既定の分離モードはそうしていませんでした | 低 |

スケジュールを決めるのはソリューションの一貫性の行と `--logger` の行の 2 つです。それ以外はツールが教えてくれます。

## 事前チェックリスト

- **.NET 10 SDK 以降。** ランナーの選択は .NET 10 SDK で入りました。.NET 9 以前では `TestingPlatformDotnetTestSupport` ブリッジと必須の `--` 区切りから逃れられません。
- **各テストプロジェクトで MTP 1.7 以降。** `dotnet test` の MTP 統合は 1.7 以降でのみサポートされます。現在の安定版は 2.3.3 です。
- **まずパイプラインを棚卸ししてください。** CI を `dotnet test`、`vstest.console`、`--logger`、`--collect`、`--blame`、`--settings`、`--filter` で grep します。その grep の結果が実際の作業リストです。
- **すべての `.runsettings` を洗い出します。** `find . -name "*.runsettings"` を実行し、1 つずつ読みます。`DataCollectionRunSettings` の下にあるものは CLI オプションになるか、消えるかのどちらかです。
- **使っているフレームワークを把握します。** MSTest と xUnit のプロジェクトが同居するソリューションでは、プロジェクト単位の引数ルーティングが必要です (手順 6 を参照)。CI が終了コード 5 で落ちてからではなく、今のうちに確認します。
- **まず 1 つのプロジェクトを最後まで移行し**、実際の CI 実行を通してから残りに手を付けます。

## 移行手順

1. **SDK を固定し、`global.json` でランナーを選択する。**

   ランナーの選択はプロジェクト単位ではなくリポジトリ単位の決定です。

   ```json
   // global.json - .NET 11 SDK
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     },
     "test": {
       "runner": "Microsoft.Testing.Platform"
     }
   }
   ```

   もう 1 つの有効な値は `VSTest` で、`test` セクションがない場合の既定値のままです。.NET 11 SDK では環境変数 `DOTNET_TEST_RUNNER` でシェルごとに上書きでき、バージョン管理下のファイルを編集せずに CI ジョブを比較する最速の方法になります。

   確認: `dotnet test --help` に `--project`、`--solution`、`--test-modules` が並ぶようになります。まだ `--logger` と `--collect` が並んでいるなら、ランナーの切り替えが効いていません。

2. **すべてのテストプロジェクトを実行可能ファイルにする。**

   これはフレームワークによらない共通のオプトインです。各プロジェクトで繰り返すのではなく、テストプロジェクトの隣の `Directory.Build.props` に置きます。

   ```xml
   <!-- tests/Directory.Build.props - .NET 11 SDK, MTP 2.3.3 -->
   <Project>
     <PropertyGroup>
       <OutputType>Exe</OutputType>
     </PropertyGroup>
   </Project>
   ```

   `Main` を書く必要はありません。MTP 対応のフレームワークがいずれも推移的に持ち込む `Microsoft.Testing.Platform.MSBuild` が `TestingPlatformEntryPoint` を生成します。

   確認: `dotnet build` が出力フォルダーに `MyApp.Tests` 実行可能ファイル (または `.exe`) を生成し、それを直接実行するとスイートが走ります。

3. **テストフレームワークのランナーを有効にする。**

   フレームワークごとにプロパティが異なり、最小バージョンも異なります。

   ```xml
   <!-- tests/Directory.Build.props - pick the one that matches your framework -->
   <PropertyGroup>
     <!-- MSTest 3.2.0+, current 4.3.3 -->
     <EnableMSTestRunner>true</EnableMSTestRunner>

     <!-- NUnit3TestAdapter 5.0.0+, current 6.3.0 -->
     <EnableNUnitRunner>true</EnableNUnitRunner>

     <!-- xunit.v3 1.0.1+, current 4.0.0 -->
     <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
   </PropertyGroup>
   ```

   MSTest のプロジェクトは、プロジェクト SDK を `MSTest.Sdk` に切り替えればこのプロパティを完全に省略できます。そこでは MTP が既定で有効です。xunit.v3 4.0.0 は MTP v2 向けのパッケージバリアントに解決されます。3.x 系は既定で MTP v1 でしたが、4.0.0 でそれは削除されました。まだ xUnit v2 を使っている場合、MTP への公式な経路はないので、先に [v2 から v3 への移行](/ja/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)を済ませてください。

   確認: テスト用の実行可能ファイルを `--help` 付きで実行します。プラットフォームのオプション (`--filter-uid`、`--timeout`、`--list-tests`) と、フレームワークが登録するオプションが表示されるはずです。

4. **.NET 9 時代のブリッジ用プロパティを削除する。**

   多くのブログ記事や MS Learn の MSTest ページの一部にも、これらはまだ載っています。`global.json` でランナーを選択する .NET 10 または .NET 11 SDK では時代遅れであり、削除すべきです。

   ```xml
   <!-- delete these from every test project and Directory.Build.props -->
   <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   <TestingPlatformShowTestsFailure>true</TestingPlatformShowTestsFailure>
   ```

   これらが要求していた `--` 区切りも省略可能になりますが、手順 6 で説明する理由から CI では残しておく価値があります。

   確認: `dotnet test` が引き続き動作し、コンソール出力が VSTest ではなく MTP のターミナルレポーターになります。

5. **ロガーとコレクターを拡張パッケージとして入れ直す。**

   MTP 本体はこれらを一切同梱していません。パッケージが欠けているオプションをパイプラインが渡すと、そのオプションは認識されないため実行は**終了コード 5** で失敗します。

   ```xml
   <!-- tests/Directory.Build.props - MTP 2.3.3 extensions -->
   <ItemGroup>
     <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.10.0" />
     <PackageReference Include="Microsoft.Testing.Extensions.HangDump" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CrashDump" Version="2.3.3" />
   </ItemGroup>
   ```

   コードカバレッジ拡張はプラットフォームとは独立にバージョン付けされます。Visual Studio のテストプラットフォームの採番に従うため、他が 2.3.3 である一方で現行リリースは 18.10.0 です。ドキュメント化された互換性表では 18.1.x 系が MTP 2.0.x、18.0.x が 1.8.x、17.14.x が 1.6.2 に対応し、指針は双方を最新に保つことです。Central Package Management を使っているなら、これらは `Directory.Packages.props` に入れるべきで、着手前に[ソリューションを Directory.Packages.props へ移す](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)理由がもう 1 つ増えます。

   確認: `dotnet test --help` に `--report-trx`、`--coverage`、`--hangdump`、`--crashdump` が並びます。

6. **CI のコマンドラインを書き換える。**

   ここが作業の大部分です。対応関係は次のとおりです。

   ```bash
   # before - VSTest, .NET 9 SDK
   dotnet test MyApp.sln \
     --logger "trx;LogFileName=results.trx" \
     --collect "Code Coverage" \
     --blame-hang-timeout 5m \
     --results-directory ./artifacts/tests \
     --filter "TestCategory=Integration"
   ```

   ```bash
   # after - MTP 2.3.3, .NET 11 SDK
   dotnet test --solution MyApp.sln \
     --results-directory ./artifacts/tests \
     -- --report-trx --report-trx-filename results.trx \
        --coverage --coverage-output-format cobertura \
        --hangdump --hangdump-timeout 5m \
        --filter "TestCategory=Integration"
   ```

   注目すべき点は 3 つあります。位置指定の `MyApp.sln` が `--solution` になったのは、MTP モードの `dotnet test` が裸のパスを受け付けなくなったためです。`--` は .NET 10 SDK 以降では技術的には省略可能ですが、`dotnet test` は認識できないトークンをテストアプリケーションに転送するため、認識された SDK のオプションが認識されないオプション名とその値の間に入ると、残りのトークンの結び付き方が変わります。テストアプリケーションの引数を `--` の後ろに置けば、この曖昧さは消えます。最後に、`--results-directory` は SDK とプラットフォームの両方が理解するので、どちら側に置いても構いません。

   フレームワークや拡張の構成が混在するソリューションでは、引数をグローバルにではなくプロジェクト単位でルーティングします。

   ```xml
   <!-- only the projects that reference HangDump get the option -->
   <PropertyGroup Condition="'$(MSBuildProjectName)' == 'MyApp.Integration.Tests'">
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --hangdump --hangdump-timeout 5m
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   確認: 実行によって `./artifacts/tests` の下に `results.trx` と Cobertura ファイルが生成され、終了コードが 0 になります。

7. **`.runsettings` を `testconfig.json` に置き換える。**

   MSTest と NUnit は VSTest ブリッジを通じて `--settings config.runsettings` を引き続き尊重するので、この作業は後回しにできます。xUnit v3 は尊重せず、プラットフォーム自体は runsettings を読むことがありません。置き換え後は次のようになります。

   ```json
   // testconfig.json at the repo root - MTP 2.3.3
   {
     "platformOptions": {
       "resultDirectory": "./artifacts/tests",
       "exitProcessOnUnhandledException": false
     },
     "environmentVariables": {
       "DOTNET_ENVIRONMENT": "Testing"
     },
     "mstest": {
       "parallelism": { "enabled": true, "workers": 4, "scope": "method" },
       "timeout": { "test": 30000 }
     }
   }
   ```

   対応は 1 対 1 ではありません。`RunConfiguration/ResultsDirectory` は `platformOptions.resultDirectory` になります。`RunConfiguration/MaxCpuCount` に相当するものはなく、プロセス単位の並列度は `--max-parallel-test-modules` が担うようになりました。`LoggerRunSettings/Loggers` と `DataCollectionRunSettings` の下にあるものはすべて、手順 5 の CLI オプションになります。`TestRunParameters` は `--test-parameter key=value` になります。MTP 2.3.0 以降は CLI オプション自体も `testconfig.json` に書けるようになり、拡張のオプションも含まれます。これが `--coverage-output-format cobertura` をパイプラインの各ファイルから追い出す方法です。`environmentVariables` セクションも 2.3.0 以降です。

   `Directory.Build.props` から、すべてのプロジェクトを 1 つの共有ファイルに向けます。

   ```xml
   <PropertyGroup>
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --config-file $(MSBuildThisFileDirectory)testconfig.json
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   確認: CI から `.runsettings` の参照を削除し、結果が設定したディレクトリに引き続き出力されることを確かめます。

8. **CI のタスク自体を差し替える。**

   Azure DevOps では `VSTest@2` タスクを `DotNetCoreCLI@2` に置き換えます。中身は通常の `dotnet test` の呼び出しなので、手順 6 の規則がそのまま当てはまります。

   ```yml
   # azure-pipelines.yml - .NET 11 SDK, MTP 2.3.3
   - task: DotNetCoreCLI@2
     inputs:
       command: 'test'
       arguments: '--solution MyApp.sln -- --report-trx --results-directory $(Agent.TempDirectory)'
   ```

   GitHub Actions では、`Microsoft.Testing.Extensions.GitHubActionsReport` と `--report-gh` の組み合わせが失敗をプルリクエストの差分に直接表示します。これが [MTP 2.3 で安定版になったレポーティングの話](/ja/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)です。紛らわしい点に注意してください。サードパーティーの `GitHubActionsTestLogger` パッケージは `--report-github` を使い、公式オプションとは 1 文字しか違いません。

   確認: わざと失敗させたテストで赤いジョブになり、その失敗が生ログだけでなく実行サマリーにも表示されます。

## 移行を検証する

ソリューション全体に変更を広げる前に、1 つのプロジェクトに対してこのリストを実行してください。

- `dotnet build` がテストプロジェクトごとに実行可能ファイルを出力し、それを直接実行 (`./MyApp.Tests`) したときのテスト件数が `dotnet test` と一致する。
- `dotnet test --help` にパイプラインが渡すすべてのオプションが並ぶ。並んでいないものがあれば、そのパッケージが欠けています。
- テスト件数が移行前の VSTest の件数と一致する。減っている場合、たいていはフィルター式が一致しなくなったのであって、テストが消えたわけではありません。
- TRX ファイルとカバレッジレポートが、後続のステップが読むパスに存在する。
- Visual Studio のテストエクスプローラーが引き続きテストを検出して実行する。MTP のサポートには Visual Studio 17.14 以降が必要で、VS Code には C# Dev Kit が必要です。
- 成功した実行の後の `echo $?` が 0 になり、わざと失敗させた実行の後は 2 になる。

## ロールバック

この移行は、`Microsoft.NET.Test.Sdk` とフレームワークの VSTest アダプターパッケージを参照したままにしておく限り、コミット 1 つで元に戻せます。`global.json` から `test` セクションを削除すればランナーは VSTest に戻り、`OutputType=Exe` とオプトインプロパティは VSTest 配下では無効になります。だからこそ、同じプルリクエストで `xunit.runner.visualstudio` や `Microsoft.NET.Test.Sdk` を削除すべきではありません。CI とチーム全員の IDE が MTP で動いた 1 週間後に、片付けのパスを行ってください。

## 始める前に知っておきたい落とし穴

**終了コード 8 が緑のジョブを赤にします。** テストを 1 件も実行しなかったプロジェクトは、MTP では 8、VSTest では 0 で終了します。プレースホルダーのテストプロジェクトがある場合や、何にも一致しないフィルターがある場合に効いてきます。フィルターを直すか、明示的にオプトアウトするかのどちらかです。

```xml
<PropertyGroup>
  <TestingPlatformCommandLineArguments>
    $(TestingPlatformCommandLineArguments) --ignore-exit-code 8
  </TestingPlatformCommandLineArguments>
</PropertyGroup>
```

`--ignore-exit-code` はセミコロン区切りのリスト (`--ignore-exit-code 2;8`) を受け取り、`TESTINGPLATFORM_EXITCODE_IGNORE` は同じことを環境変数から行います。別件として、MTP 2.3.0 は全件スキップの扱いを変更しました。すべてのテストがスキップされた実行は既定で成功になり、`--zero-tests-policy strict` を指定すると 2.3.0 より前の失敗する挙動に戻ります。

**混在したソリューションは警告ではなくエラーです。** `global.json` が MTP を選択すると、`dotnet test` はグラフ内のすべてのテストプロジェクトが MTP プロジェクトであることを期待します。VSTest に取り残された 1 つが実行全体を失敗させます。まず末端のプロジェクトを移行し、`global.json` の切り替えは最後にします。

**終了コード 5 はタイプミスではなくパッケージの欠落を意味します。** プロジェクトの半分が `Microsoft.Testing.Extensions.HangDump` を参照し、半分がしていない場合、`--hangdump` は一方では有効で他方では未知となり、実行は 5 で落ちます。手順 6 のプロジェクト単位の `TestingPlatformCommandLineArguments` の条件を使ってください。

**xUnit は `--filter` を無視します。** MSTest と NUnit は MTP 配下でも VSTest の式構文 (`FullyQualifiedName~UnitTest1|TestCategory=CategoryA`) を維持します。xUnit v3 はこれをまったく実装していません。`--filter-class`、`--filter-method`、`--filter-namespace`、`--filter-trait`、`--filter-query` と、その否定形が必要です。CI のフィルターが何にも一致しないまま静かに通り、その後で終了コード 8 を踏むというのが実際の現れ方です。[xUnit v3 と NUnit と MSTest を比較](/ja/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)している場合も、この静かなフィルター問題は同じ種類のものとして理解しておく価値があります。

**カバレッジの数値が動きます。** `IncludeTestAssembly` の既定値は `Microsoft.Testing.Extensions.CodeCoverage` では `false` で、VSTest では `true` でした。合計カバレッジ率は、コードとは無関係の理由で移行コミットの時点で変わります。プッシュする前に、カバレッジのゲートを見ている人に伝えておいてください。

**生成されるエントリポイントが 2 種類の奇妙なコンパイルエラーを引き起こします。** `Microsoft.Testing.Platform.MSBuild` は `TestingPlatformEntryPoint` と `SelfRegisteredExtensions` を `$(RootNamespace)` の中に出力し、その既定値はプロジェクト名です。`Contoso.Serialization.Tests` という名前のプロジェクトが `Contoso.Serialization` パッケージも参照していると、`CS0118: 'Serialization' is a namespace but is used like a type` が出ることがあります。`<RootNamespace>Contoso.SerializationTests</RootNamespace>` を設定するか、`<RootNamespace />` で空にしてください。別件として、テストプロジェクトを参照する非テストプロジェクトは、生成されたエントリポイントが自分の `Main` と衝突して `CS8892` になります。参照する側のプロジェクトに `<IsTestingPlatformApplication>false</IsTestingPlatformApplication>` を、あるいはテストプロジェクトに `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` を設定します。

**テストエクスプローラーの不調には専用のスイッチがあります。** IDE でテストの検出がおかしい場合、`<DisableTestingPlatformServerCapability>true</DisableTestingPlatformServerCapability>` が MTP のサーバーモードを無効にし、IDE は VSTest アダプターに戻ります。これは回避策であって修正ではなく、[`dotnet test` は通るのにテストエクスプローラーがハングする問題](/ja/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)とは別の話です。

.NET 11 SDK は移行の時期として好都合です。実行単位の `--timeout` と `--maximum-failed-tests`、`--no-dependencies`、`--use-current-runtime`、`--test-modules` 向けの `!` 接頭辞による除外パターン、`Microsoft.Build.Traversal` のサポート、そして対話的なターミナルでの実行中テストのライブ表示があります。いずれも VSTest 側には存在しません。

## 関連記事

- [テストプロジェクトを xUnit v2 から xUnit v3 へ移行する](/ja/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)
- [Microsoft.Testing.Platform 2.3 と GitHub Actions のアノテーション](/ja/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [2026 年の xUnit v3 と NUnit と MSTest](/ja/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [.NET 11 Preview 4 で VSTest が Newtonsoft.Json を外す](/ja/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)
- [.NET ソリューションを Central Package Management へ移行する](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## 参照元

- MS Learn の [VSTest から Microsoft.Testing.Platform (MTP) への移行ガイド](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform)
- [Microsoft.Testing.Platform 版の dotnet test コマンド](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp)、MTP モードの CLI リファレンス
- [Microsoft.Testing.Platform の CLI オプションリファレンス](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-cli-options)、シナリオ別の拡張オプション表を含みます
- 終了コードの完全な表がある [Microsoft.Testing.Platform のトラブルシューティング](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-troubleshooting)
- `testconfig.json` と runsettings の対応関係については [Microsoft.Testing.Platform の構成オプション](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-config)
- 拡張のオプションとバージョン互換性表については [Microsoft.Testing.Platform のコードカバレッジ](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-code-coverage)
- .NET ブログの [Enhance your CLI testing workflow with the new dotnet test](https://devblogs.microsoft.com/dotnet/dotnet-test-with-mtp/)
- Preview 7 のテスト関連の改善については [.NET 11 の SDK とツールの新機能](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk)
- [xUnit.net v3 における Microsoft Testing Platform のサポート](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
