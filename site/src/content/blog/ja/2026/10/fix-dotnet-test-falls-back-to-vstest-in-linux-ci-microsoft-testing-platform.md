---
title: "修正: プロジェクトが Microsoft.Testing.Platform を使っているのに、Linux の CI パイプラインで dotnet test が VSTest にフォールバックする"
description: "dotnet test は、作業ディレクトリから上位へたどって見つけた global.json からランナーを選びます。Linux CI では、そのファイルがない、名前が違う、キーの大文字小文字が違う、または SDK が 10 より古い場合に VSTest へフォールバックします。"
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "ci-cd"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-07
---

Linux のビルドエージェントでは `dotnet test` が Microsoft.Testing.Platform (MTP) のテストを VSTest 経由で実行するのに、手元のマシンでは実行しない場合、CLI はランナーの選択を認識できていません。`dotnet test` は何かをビルドする前に VSTest と MTP のどちらを使うかを決めます。その際、**現在の作業ディレクトリ**から上位へたどって `global.json` を探し、`"test": { "runner": "Microsoft.Testing.Platform" }` というセクションを、小文字のプロパティ名そのままで読み取ります。Linux では、ファイル名が小文字の `global.json` であること、ジョブがリポジトリの内側で実行されること、SDK が 10.0 以降であることが必要です。パイプラインが満たしていない項目を修正し、再発したときに CI が明確に失敗するようにしてください。

以下はすべて、macOS arm64 (Linux のファイルシステムと同様に動作する、大文字小文字を区別する APFS ボリュームを含む) で、.NET 10 SDK 10.0.302、.NET 11 SDK RC 1 (11.0.100-rc.1.26425.128)、.NET 9 SDK 9.0.318 を使い、MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) と xunit.v3 3.2.2 (MTP v1 と `xunit.runner.visualstudio` 3.1.5) に対して測定した結果です。

## エラーの実際の様子

"VSTest にフォールバックする"ときの見え方は、テストプロジェクトが使っている MTP のバージョンによって異なります。MTP 2.x (MSTest 4.x、MSTest.Sdk 4.x、`xunit.v3.mtp-v2`) のプロジェクトは実行を拒否し、ジョブを失敗させます。

```text
Microsoft.Testing.Platform.MSBuild.targets(355,5): error : Testing with VSTest target is no longer supported by Microsoft.Testing.Platform on .NET 10 SDK and later. If you use dotnet test, you should opt-in to the new dotnet test experience. For more information, see https://aka.ms/dotnet-test-mtp-error [/src/tests/SdkTests/SdkTests.csproj]
```

テスト対象の選択に MTP 専用の構文をパイプラインで使っている場合は、VSTest モードの `dotnet test` が未知のスイッチを MSBuild に渡すため、さらに早い段階で失敗します。

```text
MSBUILD : error MSB1001: Unknown switch.
    Full command line: '/usr/share/dotnet/sdk/10.0.302/MSBuild ... --target:VSTest --nologo -nodereuse:false --solution src/Repo.slnx ...'
Switch: --solution
```

危険なのは、成功のまま通ってしまうパターンです。VSTest アダプターを参照し続けている MTP v1 のプロジェクト (`xunit.runner.visualstudio` を併用する `xunit.v3` 3.x、または `Microsoft.NET.Test.Sdk` を使う MSTest 3.x) は、VSTest の下で問題なく実行されます。

```text
Test run for /src/tests/XTests/bin/Debug/net10.0/XTests.dll (.NETCoreApp,Version=v10.0)
A total of 1 test files matched the specified pattern.
Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 6 ms - XTests.dll (net10.0)
```

このモードでは、`dotnet test -- --report-trx` も終了コード 0 を返し、TRX ファイルをまったく書き出しません。`--` 以降のすべてが RunSettings の引数として扱われるためです。本物の MTP モードでは、同じプロジェクトが `--report-trx` を終了コード 5 で拒否します (拡張機能が参照されていないため)。こちらが正直な答えです。"存在する TRX ファイルをすべて発行する" パイプラインは、何も発行しないまま平然と進みます。

比較のために、MTP モードの出力を示します。`Running tests from` と `Test run summary` が表示されない場合、MTP モードではありません。

```text
Running tests from /src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64)
/src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64) passed (426ms)
Test run summary: Passed!
```

## dotnet test がランナーの選択を無視する理由

ランナーの選択は .NET 10 SDK で追加され、`global.json` の `test` セクションという 1 か所にのみ存在します。.NET 11 SDK (Preview 6 以降) では、環境変数 `DOTNET_TEST_RUNNER` でこれを上書きできます。どちらも MTP を選択していなければ、`dotnet test` は VSTest モードのままとなり、`VSTest` MSBuild ターゲットを呼び出して、MTP プロジェクトがそのバージョンなりの反応をするに任せます。この判断は MSBuild がプロジェクトを評価する前に CLI が行うため、`.csproj` 内の記述では変更できません。

再現できた原因を、実際のパイプラインでの頻度が高い順に挙げます。

1. **ジョブがリポジトリの外のディレクトリで実行されている**ため、上方向への探索が `global.json` に到達しません。ソリューションのパスを渡しても解決しません。探索はプロジェクトからではなく、作業ディレクトリから始まります。
2. **ファイル名が `Global.json`** (または `GLOBAL.JSON`) になっている。Windows と macOS の既定のファイルシステムは大文字小文字を区別しないため、ローカルでは動作します。Linux では動作しません。
3. **`global.json` が CI の実行場所にない**。たとえば `src/` にあるのにジョブはリポジトリのルートから実行される、または Docker のビルドコンテキストがプロジェクトをコピーしてもこのファイルをコピーしていない、といった場合です。
4. **プロパティ名の大文字小文字が間違っている。** `"Test"` や `"Runner"` は黙って無視されます。値は大文字小文字を区別しませんが、キーは区別します。
5. **CI イメージの SDK が 10.0 より古い。** .NET 9 SDK は `test` セクションの存在を知りません。
6. **.NET 11 SDK で、パイプラインまたはエージェントのレベルで `DOTNET_TEST_RUNNER=VSTest` が設定されている。** これは `global.json` より優先されます。

## 最小の再現手順

2 つのテストプロジェクト、1 つのソリューション、リポジトリのルートにある `global.json` を用意します。

```json
// global.json - .NET 10 SDK 10.0.302
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

```xml
<!-- tests/SdkTests/SdkTests.csproj - MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

リポジトリのルートから `dotnet test` を実行すると、両方のプロジェクトが MTP モードで実行されます。次に CI の挙動を再現します。

```bash
# .NET 10 SDK 10.0.302
cd /tmp/elsewhere
dotnet test /src/repo/Repo.slnx        # VSTest mode: "Testing with VSTest target is no longer supported"

cd /src/repo
mv global.json Global.json
dotnet test                             # macOS/Windows: MTP mode. Linux: VSTest mode
```

後半は、コンテナーなしで Linux のセマンティクスを得るために、大文字小文字を区別する APFS ディスクイメージ (`hdiutil create -fs "Case-sensitive APFS"`) 上で実行しました。`global.json` は成功し、`Global.json` は VSTest のエラーで失敗し、同じ `Global.json` を通常の大文字小文字を区別しないボリュームに置くと成功しました。これが典型的な "自分のマシンでは動く" の分かれ目です。

## 修正の詳細

### 1. エージェントがどちらのモードかを確認する

テストステップの前に診断ステップを追加します。`dotnet test --help` の最初の数行を見れば、CLI がどちらのコマンドを選んだかが分かります。

```bash
# .NET 10 SDK 10.0.302 - put this right before the test step
pwd
ls -la global.json || echo "no global.json in $(pwd)"
dotnet --version
dotnet test --help | sed -n 2p
```

MTP モードでは、2 行目が `.NET Test Command for Microsoft.Testing.Platform (opted-in via 'global.json' file)` と表示されます。VSTest モードでは `.NET Test Command for VSTest. To use Microsoft.Testing.Platform, opt-in to the Microsoft.Testing.Platform-based command via global.json.` と表示されます。細かな癖として、.NET 11 RC 1 SDK では、環境変数でオプトインした場合でも MTP のテキストが "via 'global.json' file" のままになります。

### 2. git でファイル名を小文字に変更する

大文字小文字を区別しないファイルシステムでは、大文字小文字だけを変えた同名へのリネームは確実には認識されません。git に任せてください。

```bash
# any git version
git mv Global.json global.json.tmp
git mv global.json.tmp global.json
git commit -m "Rename global.json to lowercase for Linux agents"
```

`Directory.Build.props` などにも同じことが当てはまりますが、それらは MSBuild が解決するため、大文字小文字が違うと別の症状が出ます。

### 3. リポジトリの内側からテストステップを実行する

探索は作業ディレクトリから上位へたどるため、ジョブは `global.json` があるフォルダーかその配下のどこかにいれば十分です。GitHub Actions の既定の作業ディレクトリはチェックアウト先なので、よくある原因は、明示的な `working-directory` や、成果物フォルダーへの `cd` です。

```yaml
# GitHub Actions, actions/setup-dotnet@v6, .NET 10 SDK
- uses: actions/setup-dotnet@v6
  with:
    global-json-file: global.json
- name: Test
  run: dotnet test --solution Repo.slnx
  # no working-directory pointing at a folder outside the repo
```

`global-json-file` は、`setup-dotnet` がインストールする SDK をファイルと同期させるので、原因 5 にも対応できます。SDK のバージョンは `sdk.version` から読み取られるため、手順 5 で示すピン留めと組み合わせてください。ピン留めがない場合、`setup-dotnet` のドキュメントによれば、ランナーにすでにインストールされている最新の SDK が優先されます。`global.json` が `src/` にある場合は、ルートに移動する (`dotnet build` や IDE も同じ方法で解決するため推奨) か、`working-directory: src` を指定してステップを実行してください。

Docker ビルドでは、`dotnet test` を実行するのと同じディレクトリに `global.json` をコピーし、`.dockerignore` を確認してください。

```dockerfile
# mcr.microsoft.com/dotnet/sdk:10.0
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS test
WORKDIR /src
COPY global.json ./
COPY Repo.slnx ./
COPY tests/ tests/
RUN dotnet test --solution Repo.slnx
```

### 4. セクションを正確に記述する

以下はすべて SDK 10.0.302 でテストしました。

| `global.json` の内容 | 結果 |
|---|---|
| `"test": { "runner": "Microsoft.Testing.Platform" }` | MTP |
| `"test": { "runner": "microsoft.testing.platform" }` | MTP (値は大文字小文字を区別しない) |
| `"Test": { "runner": ... }` または `"test": { "Runner": ... }` | VSTest (警告なし) |
| `"sdk": { "version": "10.0.302", "test": { ... } }` (入れ子) | VSTest (警告なし) |
| `"test": { "runner": "MTP" }` | CLI がクラッシュ: `Test runner 'MTP' is not supported.` |
| ファイル内の `// comments` | MTP (コメントは許可されている) |
| 末尾のカンマ | CLI がクラッシュ: `JsonException ... trailing comma` |

はっきり失敗するケースは対処が簡単です。警告なしで通ってしまう 2 つのケースがあるからこそ、ドキュメントどおりの大文字小文字を守り、`test` を `sdk` の内側ではなく、その隣のトップレベルに置く必要があります。

### 5. ランナーの選択を理解する SDK を使う

SDK 9.0.318 では、まったく同じ `global.json` でも、`dotnet test` は `test` セクションを完全に無視し、`xunit.v3` 3.2.2 のプロジェクトを VSTest 経由で実行しました (`VSTest version 17.14.1`)。`net9.0` 上の MSTest.Sdk 4.4.1 プロジェクトも成功のままでしたが、古い MSBuild ブリッジ経由でした (`Run tests: '...' [net9.0|arm64]`)。SDK 9 以前では、このブリッジが引き続きサポートされているためです。どちらの場合も、警告なしに MTP モードの挙動が失われます。

これは、`mcr.microsoft.com/dotnet/sdk:9.0` イメージを使うパイプラインや、`net8.0` または `net9.0` を対象とするプロジェクトで `dotnet-version: 9.0.x` の `setup-dotnet` を使うパイプラインで問題になります。プロジェクトのターゲットを変更する必要はなく、実行に 10.0 SDK が必要なだけです。同じファイルでピン留めしてください。

```json
// global.json - SDK pin plus runner selection, .NET 10 SDK
{
  "sdk": {
    "version": "10.0.302",
    "rollForward": "latestFeature"
  },
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

`sdk.version` をピン留めしておくと、一致する SDK がないエージェントは、黙って古い SDK を使うのではなく、"compatible .NET SDK was not found" エラーで起動時に失敗します。

### 6. .NET 11 のエージェントで DOTNET_TEST_RUNNER を確認する

.NET 11 RC 1 SDK で、ドキュメントに記載された優先順位を確認しました。`DOTNET_TEST_RUNNER=VSTest` は正しい `global.json` を上書きし、同じ "Testing with VSTest target is no longer supported" エラーを発生させます。一方、空の値や認識されない値 (`DOTNET_TEST_RUNNER=MTP`) は無視され、`global.json` が優先されます。この変数は逆方向にも機能するため、リポジトリを変更できないときの一時的な回避策として便利です。

```bash
# .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) and later; ignored by the .NET 10 SDK
export DOTNET_TEST_RUNNER=Microsoft.Testing.Platform
dotnet test --solution Repo.slnx
```

SDK 10.0.302 では、この変数はどちらの方向にも効果がないため、エージェントが .NET 11 になるまで頼らないでください。

### 7. フォールバックをビルド失敗にする

安価なガードを 2 つ入れるだけで、警告なしのパターンを赤いビルドに変えられます。

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
dotnet test --solution Repo.slnx --minimum-expected-tests 1
```

`--solution` (または `--project`) は MTP モードにしか存在しないため、VSTest モードではテストを誤った方法で実行する代わりに、コマンドが `MSB1001: Unknown switch` で停止します。`--minimum-expected-tests` は MTP のオプションで、期待より少ない数のテストしか実行されなかった場合に、終了コード 9 で実行を失敗させます。CI では、`--` の後ろに MTP のオプションを渡さないでください。VSTest モードが文句も言わずに飲み込んでしまうのは、まさにその構文です。

移行の途中であれば、`global.json` の切り替えが済んだ時点で、プロジェクトから `TestingPlatformDotnetTestSupport` も削除してください。これは VSTest モードでしか意味を持たず、残しておくと、ランナーの選択が失われたときに MTP v1 のプロジェクトがブリッジ経由で "動き続けて" しまいます。

## 落とし穴と紛らわしい症状

- **`.csproj` ではオプトインできません。** `TestingPlatformDotnetTestSupport`、`EnableMSTestRunner`、`UseMicrosoftTestingPlatformRunner` は、各モードでプロジェクトがどう動作するかを決めるものです。モードそのものを選ぶものではありません。
- **混在したソリューションは別のエラーです。** MTP モードが有効になると、VSTest のみをサポートするプロジェクトは実行に失敗します。これは逆の問題で、[VSTest から Microsoft.Testing.Platform への移行ガイド](/ja/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/)で扱っています。
- **終了コード 5 の `Zero tests ran` は、MTP モードであることを意味します。** テストアプリがオプションを拒否しました。[Microsoft.Testing.Platform での dotnet test 終了コード 5](/ja/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/)を参照してください。
- **Azure DevOps の `VSTest@2` と `VSTest@3` タスクは常に vstest.console を使います。** `global.json` を変更しても何も変わりません。代わりに、リポジトリのルートから `dotnet test` を呼び出すスクリプトステップを使ってください。
- **IDE は独自の判断をします。** Test Explorer がプロジェクトを CLI とは違う形で読み取るのは別種のバグです。たとえば、[dotnet test は成功するのに Test Explorer が xUnit v3 でハングする問題](/ja/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)があります。

## 関連記事

- `--logger` から `--report-trx` へ、`.runsettings` から `testconfig.json` への移行を含む、[.NET 11 での VSTest から Microsoft.Testing.Platform への完全な移行](/ja/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/)。
- MTP モードが有効なのにプロジェクトが引数を拒否する場合: [dotnet test の終了コード 5 と "Zero tests ran" の修正](/ja/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/)。
- CI が正しいモードで動くようになったら、MTP の失敗をプルリクエストの差分に注釈として表示する: [Microsoft.Testing.Platform 2.3 の GitHub Actions 注釈](/ja/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)。
- `xunit.v3` 3.x のプロジェクトを MTP v1 と VSTest アダプターから移行する: [テストプロジェクトを xUnit v2 から xUnit v3 へ移行する](/ja/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)。

## 参考資料

- [dotnet test コマンド: テストランナーの選択](https://learn.microsoft.com/dotnet/core/tools/dotnet-test#choose-a-test-runner)
- [dotnet test によるテスト: VSTest モードと MTP モード](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test)
- [global.json の概要 (ファイルの検索方法を含む)](https://learn.microsoft.com/dotnet/core/tools/global-json)
- [Microsoft.Testing.Platform を使った dotnet test](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [actions/setup-dotnet: global-json-file 入力](https://github.com/actions/setup-dotnet)
- [microsoft/testfx リポジトリ (MSTest と Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
