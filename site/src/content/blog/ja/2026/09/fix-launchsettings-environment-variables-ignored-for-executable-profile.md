---
title: "修正: commandName: Executable のプロファイルで launchSettings.json の環境変数が無視される"
description: "Executable プロファイルが dotnet run や dotnet watch を実行する場合、内側のコマンドが既定のプロファイルを適用し、設定した変数を上書きします。--no-launch-profile を追加し、SDK 10.0.200 以降を使ってください。"
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dotnet-cli"
  - "launchsettings"
  - "dotnet-watch"
  - "dotnet-10"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/fix-launchsettings-environment-variables-ignored-for-executable-profile"
translatedBy: "claude"
translationDate: 2026-09-30
---

`commandName: "Executable"` のプロファイルが `dotnet run` や `dotnet watch run` を起動する場合は、そのプロファイルの `commandLineArgs` に `--no-launch-profile` (または `--launch-profile <name>`) を追加してください。そうしないと、内側のコマンドがプロジェクトの既定のプロファイルを選択し、そのプロファイルの `environmentVariables` が、Executable プロファイルが設定したばかりの値を上書きします。CLI が "The launch profile type 'Executable' is not supported" と表示する場合は、SDK が 10.0.200 より古い状態です。その SDK はプロファイル全体をスキップするため、アップグレードしてください。以下はすべて macOS 上で、SDK 10.0.112、10.0.302、10.0.401、11.0.100-rc.1 を使って計測しました。

## エラーの状況

この問題には 2 つのパターンがあり、どちらになるかは SDK によって決まります。

10.0.1xx の SDK (および Project プロファイルしか理解しなかったそれ以前の SDK) では、`dotnet run --launch-profile` が直接そのことを伝え、その後もプロジェクトを実行します。

```
Using launch settings from /src/app/Properties/launchSettings.json...
The launch profile "Exe" could not be applied.
The launch profile type 'Executable' is not supported.
MY_MODE=<null> DOTNET_ENVIRONMENT=<null> DOTNET_LAUNCH_PROFILE=<null> args=[] cwd=/src/app
```

アプリが起動するため、このメッセージは見落としやすいものです。ただしプロファイルがまったく適用されない状態で起動します。環境変数も `commandLineArgs` もなく、`DOTNET_LAUNCH_PROFILE` さえ設定されません。

10.0.200 以降では警告は出ません。プロファイルは実行されますが、アプリには誤った値が渡されます。これは [dotnet/sdk#56023](https://github.com/dotnet/sdk/issues/56023) で報告されたケースで、"Watch" プロファイルが `ASPNETCORE_ENVIRONMENT=Development` を設定しているのに、アプリは `Production` と報告します。手がかりは、"Using launch settings" の行が 2 回出力されることだけです。

```
Using launch settings from /src/app/Properties/launchSettings.json...
Using launch settings from /src/app/Properties/launchSettings.json...
MY_MODE=from-Default DOTNET_ENVIRONMENT=Production DOTNET_LAUNCH_PROFILE=Default args=[] cwd=/src/app
```

## 変数が失われる理由

原因を、よくあるものから順に挙げます。

1. **入れ子になった SDK コマンドがプロファイルを再適用する。** `dotnet run` は Executable プロファイルを正しく適用します。プロファイルの `environmentVariables` を設定した状態で `executablePath` を起動します。しかしその実行ファイルが `dotnet` 自身 (`run`、`watch run`) の場合、子プロセスは `--launch-profile` を持たない新しい `dotnet run` になります。子は同じ `launchSettings.json` を読み、サポートされている `commandName` を持つ*最初の*プロファイルを選び、そのプロファイルの変数をアプリのプロセスに設定します。プロファイルの変数は継承された変数より優先されるため ([`RunCommand.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Cli/dotnet/Commands/Run/RunCommand.cs) の `SetEnvironmentVariables` を参照)、外側の値は黙って置き換えられます。
2. **SDK が 10.0.200 より古い。** `dotnet run` と `dotnet watch` での Executable サポートは [dotnet/sdk#51727](https://github.com/dotnet/sdk/pull/51727) で入り、2025-12-12 に `release/10.0.2xx` へマージされました。それ以前の CLI は `commandName: "Project"` しか認識しませんでした。Visual Studio は以前から Executable プロファイルに対応しており、同じファイルが「VS では動く」のはそのためです。
3. **IDE が Executable プロファイルをまったく読まない。** VS Code の C# 拡張機能は、[デバッガー設定](https://code.visualstudio.com/docs/csharp/debugger-settings)で "Only profiles with `"commandName": "Project"` are supported" と明記しています。そこで Executable プロファイルを選んでも、その変数は何も使われません。

## dotnet run がプロファイルを選び変数を重ねる仕組み

CLI が従う正確な順序を知っておくと役立ちます。以下の回避策はすべて、これらのステップのどれかを制御する方法にすぎないからです。SDK 10.0.200 以降では、`dotnet run` は次のように動作します。

1. `--no-launch-profile` を渡すと、プロファイルはまったく使われません。ここで終了です。
2. そうでなければ `Properties/launchSettings.json` を探します (VB では `My Project/launchSettings.json`、ファイルベースアプリでは隣の `<app>.run.json`)。
3. `--launch-profile <name>` を指定すると、そのプロファイルを選びます。検索はまず大文字と小文字を区別し、見つからなければ区別しない一致にフォールバックします。フラグがない場合は、`commandName` が `Project` または `Executable` である最初のプロファイルを選びます。それ以外のコマンド名 (`IISExpress`、`Docker`、`DotNetCore`) はスキップされます。
4. 子プロセスの環境を 3 つの層で構築します。最初に `dotnet` プロセスが継承した環境。次に `DOTNET_LAUNCH_PROFILE`、Project プロファイルでは `applicationUrl` 由来の `ASPNETCORE_URLS`、そして `environmentVariables` のすべてのエントリ。最後にコマンドラインの `-e KEY=VALUE`。後の層が優先されます。

入れ子のケースが失敗するのはステップ 4 のためです。外側の `dotnet run` が値を内側の `dotnet run` の第 1 層に入れ、内側のコマンドの第 2 層がそれを置き換えます。内側のプロセスは、自分が起動プロファイルから起動されたことを知りません。どの修正も、内側のステップ 1 かステップ 3 の動作を変えることに帰着します。

## 最小の再現

実際に受け取った値を出力するコンソールアプリです。

```csharp
// .NET 10, C# 14 - Program.cs (ImplicitUsings enabled)
Console.WriteLine($"MY_MODE={Environment.GetEnvironmentVariable("MY_MODE") ?? "<null>"} " +
                  $"DOTNET_ENVIRONMENT={Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "<null>"} " +
                  $"DOTNET_LAUNCH_PROFILE={Environment.GetEnvironmentVariable("DOTNET_LAUNCH_PROFILE") ?? "<null>"} " +
                  $"args=[{string.Join(",", args)}] cwd={Environment.CurrentDirectory}");
```

そして、通常の Project プロファイルを先頭に置き、その後ろに 3 つの Executable プロファイルを並べた `Properties/launchSettings.json` です。

```json
{
  "profiles": {
    "Default": {
      "commandName": "Project",
      "environmentVariables": { "MY_MODE": "from-Default", "DOTNET_ENVIRONMENT": "Production" }
    },
    "Exe": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "bin/Debug/net10.0/app.dll hello",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Exe", "DOTNET_ENVIRONMENT": "Development" }
    },
    "ExeDotnetRun": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "run --no-build",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-ExeDotnetRun", "DOTNET_ENVIRONMENT": "Development" }
    },
    "Watch": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "watch run --non-interactive",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
    }
  }
}
```

各 SDK で `dotnet run --no-build --launch-profile <name>` を実行した結果は次のとおりです。

| プロファイル | 10.0.112 | 10.0.302 / 10.0.401 / 11.0.100-rc.1 |
| --- | --- | --- |
| `Default` (Project) | `from-Default` | `from-Default` |
| `Exe` (`app.dll` を実行) | "not supported" の警告、`<null>` | `from-Exe`、`Development`、args `[hello]` |
| `ExeDotnetRun` | "not supported" の警告、`<null>` | `from-Default`、`Production` |
| `Watch` | "not supported" の警告、`<null>` | `from-Default`、`Production` (10.0.302) |

`Exe` の行は、最近の SDK では Executable プロファイル自体のサポートが機能していることを示します。`ExeDotnetRun` と `Watch` の行が上書きを示しています。内側のコマンドは `DOTNET_LAUNCH_PROFILE=Default` を報告しており、自分で最初のプロファイルを拾ったことを意味します。

## 修正手順

1. **SDK を確認する。** プロジェクトのディレクトリで `dotnet --version` を実行してください。`global.json` が古いバンドに固定している場合があるためです。`dotnet run` と `dotnet watch` が Executable プロファイルを扱うには 10.0.200 以降が必要です。10.0.1xx では、代わりに変数を `Project` プロファイルに置いてください。
2. **入れ子のコマンドがプロファイルを選ばないようにする。** `executablePath` が `dotnet` で、引数が `run` または `watch` で始まる場合は、`--no-launch-profile` を追加します。

   ```json
   // .NET SDK 10.0.200+ - Properties/launchSettings.json
   "Watch": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "watch run --non-interactive --no-launch-profile",
     "workingDirectory": "..",
     "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
   }
   ```

   この変更により、10.0.302 の `dotnet watch` 配下で、アプリは `MY_MODE=from-WatchNoProfile DOTNET_ENVIRONMENT=Development` を出力しました。`DOTNET_LAUNCH_PROFILE` には引き続き外側のプロファイル名が表示されます。外側の `dotnet run` が設定し、何もそれを上書きしなかったためです。

3. **または、入れ子のコマンドに特定のプロファイルを指定する。** 変数がすでに Project プロファイルにある場合は、複製せずそれを参照します。

   ```json
   // .NET SDK 10.0.200+
   "ExeDotnetRunPinned": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "run --no-build --launch-profile Dev",
     "workingDirectory": ".."
   }
   ```

   これは `MY_MODE=from-Dev DOTNET_ENVIRONMENT=Development DOTNET_LAUNCH_PROFILE=Dev` を出力しました。この構成では、内側のプロファイルが変数を所有します。外側のプロファイルの `environmentVariables` に書いた内容は、両方のプロファイルが同じキーを設定した場合は常に負けます。

4. **VS Code では、変数を `launch.json` に移す。** C# 拡張機能は Project プロファイルだけを読み、その `environmentVariables`、`applicationUrl`、`commandLineArgs` しか使いません。代わりに `coreclr` の起動構成に `env` ブロックを置いてください。`launch.json` の値はいずれにしても `launchSettings.json` より優先されます。

## 落とし穴と似た症状

**先頭に置いた Executable プロファイルが既定になり、無限にフォークしうる。** 10.0.200 以降では、既定のプロファイルは `commandName` が `Project` *または* `Executable` である最初のものです ([`LaunchSettings.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Microsoft.DotNet.ProjectTools/LaunchSettings/LaunchSettings.cs) の `IsDefaultProfileType`、`dotnet watch` でも同じルールです)。先頭のプロファイルに `"commandLineArgs": "run --no-build"` を入れて通常の `dotnet run` を実行すると、すべての子が再び同じプロファイルを選びます。10.0.302 では、12 秒後に 53 個の `dotnet run` プロセスを数えたところで強制終了しました。上記の `--no-launch-profile` による修正はこのループも断ち切ります。Project プロファイルをファイルの先頭に置いておくのは、手軽で効果的な保険です。

**`dotnet run -e` も入れ子の段階を越えられない。** SDK 10.0.112 以降で `dotnet run -e KEY=VALUE` を確認しました ([`dotnet run -e`](/ja/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/) を参照)。これは、外側の `dotnet run` が起動するプロセスに対してはプロファイルを上書きします。そのプロセスが別の `dotnet run` の場合、内側の既定プロファイルがそれも上書きします。`-lp ExeDotnetRun -e MY_MODE=from-cli` でも `from-Default` が出力されました。単純なシェルの export でも同じです。`MY_MODE=from-shell dotnet run -lp Default` は `from-Default` を出力します。起動プロファイルの値は常に継承された値に勝つためです。

**`%VAR%` は展開されるが、`$(Property)` は (まだ) 展開されない。** CLI はすべての値を `Environment.ExpandEnvironmentVariables` に通すため、macOS や Linux でも `%HOME%` は機能します。`$(HOME)` と `${HOME}` はそのまま渡されます。`$(TargetPath)` や `$(ProjectDir)` のような MSBuild プロパティは、私が試したリリース済みのどの SDK (10.0.302、10.0.401、11.0.100-rc.1) でも展開されません。変数が黙って無視されるのではなく、`An error occurred trying to start process '$(TargetPath)' ... No such file or directory` というエラーになります。Visual Studio の `ProjectLaunchTargetsProvider` は展開します ([project-system の起動プロファイルのドキュメント](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)によります)。VS 向けの設定からコピーしたプロファイルが CLI で壊れるのはそのためです。[dotnet/sdk#56074](https://github.com/dotnet/sdk/pull/56074) がこの展開を追加します。2026-09-04 に `main` へマージされましたが、本日時点では `release/11.0.1xx-rc2` にも、どの 10.0 バンドにも含まれていません。出荷されるまでは、相対パスを使ってください。

**`workingDirectory` は、プロジェクトではなく `Properties` フォルダーからの相対パス。** CLI は `Path.Combine(Path.GetDirectoryName(launchSettingsPath), value)` で解決するため、`".."` はプロジェクトのディレクトリを意味します。Visual Studio と Rider は異なる方法で解決しており、[dotnet/sdk#56129](https://github.com/dotnet/sdk/pull/56129) が現在それを議論しています。Project プロファイルについては、現行の SDK では CLI は `workingDirectory` を完全に無視します。

**入れ子のケースへの修正がレビュー中。** [dotnet/sdk#56087](https://github.com/dotnet/sdk/pull/56087) は、`dotnet run` が Executable プロファイルから起動するプロセスに `DOTNET_LAUNCH_PROFILE_APPLIED=1` というマーカーを設定するようにします。すると、明示的なプロファイルを持たない入れ子の `dotnet run` は既定のプロファイルをスキップします。2026-09-30 時点ではまだオープンでした。出荷されたとしても、対象は CLI 経由で起動されたプロファイルだけです。IDE が Executable プロファイルを直接起動する場合は、引き続き `--no-launch-profile` が必要だと PR に記載されています。

**Project プロファイルの `hotReloadEnabled` は、`dotnet run` では何もしない。** #56023 の報告者もこれに気づいていました。ホットリロードはプロファイルのプロパティではなく `dotnet watch` によるものです。そもそも、人々が `dotnet watch` を Executable プロファイルで包む理由がまさにそこにあります。ウォッチャーが何を追加するかについては、[`dotnet watch` と `dotnet run` の違い](/ja/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)を参照してください。

## 関連記事

- [.NET 11 Preview 3: dotnet run -e sets environment variables without launch profiles](/ja/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [What is the difference between dotnet watch and dotnet run?](/ja/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)
- [Fix: dotnet watch Blazor hot reload WebSocket fails on a custom local domain](/ja/2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain/)。起動プロファイルの変数が期待するプロセスに届かない、もう 1 つのケースです
- [How to run a file-based C# app with `dotnet run app.cs`](/ja/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)。同じコードで `<app>.run.json` の起動プロファイルを読み込みます
- [How to add Aspire to an existing ASP.NET Core solution](/ja/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)。AppHost 自身の起動プロファイルが、各サービスに渡される環境を決めます

## 参考資料

- [dotnet/sdk#56023: `launchSettings.json` environment variables are not propagated for `commandName: Executable`](https://github.com/dotnet/sdk/issues/56023)
- [dotnet/sdk#51727: Add Executable launch profile support to dotnet run and dotnet watch](https://github.com/dotnet/sdk/pull/51727)
- [dotnet/sdk#56087: Preserve Executable launch profile environment in nested dotnet run](https://github.com/dotnet/sdk/pull/56087)
- [dotnet/sdk#56074: Expand MSBuild properties across launch profiles](https://github.com/dotnet/sdk/pull/56074)
- [dotnet/sdk#49131: Allow `dotnet run` to use launch profiles with `commandName: Executable`](https://github.com/dotnet/sdk/issues/49131)
- [dotnet/project-system: launch profiles documentation](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)
- [VS Code C# debugger settings: launchSettings.json support](https://code.visualstudio.com/docs/csharp/debugger-settings)
- [`dotnet run` command reference on Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnet-run)
