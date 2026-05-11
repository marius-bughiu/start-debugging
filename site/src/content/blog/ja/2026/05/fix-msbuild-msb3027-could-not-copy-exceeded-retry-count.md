---
title: "Fix: MSB3027 Could not copy X to Y. Exceeded retry count of 10. Failed"
description: "MSB3027 は、MSBuild がファイルを 10 回コピーしようとしたが、別のプロセスが宛先を保持し続けていたことを意味します。ロック中のプロセスを終了するか、bin/obj をウイルス対策ソフトの除外に追加するか、CopyRetryCount を引き上げてください。"
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "ja"
translationOf: "2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count"
translatedBy: "claude"
translationDate: 2026-05-11
---

修正方法: MSBuild の `Copy` タスクは 1 秒の間隔で 10 回、あなたの `bin/` ディレクトリ内のファイルを上書きしようとしましたが、別のプロセスがそのファイルへのハンドルを保持し続けていました。`handle.exe` またはリソースモニターで保持しているプロセスを特定して終了させ、ビルドし直してください。Windows ではこの保持元はほぼ常に、自分のプログラムの前回の実行（`apphost.exe`、`MyApp.exe`、IIS Express の worker、または `dotnet watch` の子プロセス）か、Visual Studio の下に常駐し続けている `MSBuild.exe` の build server か、MSBuild が上書きしようとする数ミリ秒前に生成直後の DLL を検査のために開いたリアルタイムのウイルス対策ソフトのいずれかです。ロックの原因を取り除けない場合は、`Directory.Build.props` の `CopyRetryCount` と `CopyRetryDelayMilliseconds` を引き上げて先に進んでください。

```text
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed. The file is locked by: ".NET Host (4176)"  [C:\src\MyApp\MyApp.csproj]
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' because it is being used by another process.
```

この記事は .NET SDK 11.0.100-preview.4、MSBuild 17.13、Visual Studio 17.14 を前提に書かれています。`Copy` タスクと MSB3027 のメッセージ文字列は MSBuild 15（Visual Studio 2017）以降ずっと安定しているため、`net6.0` から `net11.0` までの現代的な SDK-style プロジェクトすべてに同じチェックリストが当てはまります。最近変わったのはリトライの挙動です。SDK 7.0.306 と 7.0.400 の間で、一部の `IOException` サブクラスに対するリトライ経路が厳しくなりました。これが、以前は見えなかった CI 失敗（リトライが成功していた）が現在 MSB3027 として表面化する理由です。

## MSB3027 が実際に意味するもの

`MSB3027` は MSBuild の `Copy` タスクがリトライループの最後に投げます。このタスクは `Microsoft.Common.CurrentVersion.targets` 内の標準的なターゲット `_CopyFilesMarkedCopyLocal` と `CopyFilesToOutputDirectory` から呼び出され、これらは各 `dotnet build` の終盤に走ります。ループは次の 2 つのプロパティで制御されます。

- `CopyRetryCount` の既定値は `10` です。これだけ連続して失敗するとタスクが失敗します。
- `CopyRetryDelayMilliseconds` の既定値は `1000` です。タスクはリトライ間にこれだけスリープします。

つまり 10 回分のリトライウィンドウは合計でおよそ 10 秒です。あるプロセスが宛先ファイルを 10 秒以上保持していると MSB3027 が発生します。MSBuild は次の行で内部例外（`System.IO.IOException`）を `MSB3021` として出力するため、この 2 つのエラーコードはほぼ常に一緒に現れます。

[MSB3027](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) の Microsoft Learn ページは標準的な原因として 4 つを挙げています。別のプログラムがファイルを保持している、アカウントに宛先への書き込み権限がない、ドライブの空き容量が不足している、あるいはネットワーク共有が落ちている、です。実際の開発者ワークステーションでは、1 つ目の原因が 95 パーセントをはるかに超えるトラフィックを占めます。

## なぜ起こるか（優先度順）

以下は実際の .NET 11 プロジェクトでこの失敗を説明する頻度順に並べた、よくある 7 つの原因です。

1. **自分のプログラムの前回の実行がまだ生きている。** `Console.ReadKey` でブロックしているコンソールアプリ、グレースフルシャットダウンを待っている dotnet の `IHostedService` ワーカー、クラッシュしたデバッグセッションから取り残された `apphost.exe` プロセスは、いずれもメイン実行ファイルに対するファイルロックを維持し続けます。エラーメッセージはそのプロセスを直接示します（例: `The file is locked by: ".NET Host (4176)"`）。
2. **IIS Express または Kestrel のアプリプールがアセンブリを保持している。** `dotnet run`、`iisexpress.exe`、IIS ワーカープロセス（`w3wp.exe`）は、ロード済みの DLL に対して排他的な read share を保持します。前回の F5 セッションが残ったまま Visual Studio からビルドを開始すると、毎回これに当たります。
3. **`dotnet watch` がリビルドの最中。** hot reload はアセンブリをその場で差し替えますが、rude edit ではフル再起動が走り、古いプロセスと新しいビルドが同じファイルに触れる小さなウィンドウが生まれます。多数のソースジェネレーターを含むプロジェクトでは、ジェネレーターの出力 DLL が 2 回コピーされるため、この問題が増幅します。dotnet SDK 側では .NET 8 の時代から [dotnet/sdk#40911](https://github.com/dotnet/sdk/issues/40911) として追跡されています。
4. **リアルタイムのウイルス対策ソフトが MSBuild の書き込み直後にファイルをスキャンした。** Windows Defender、CrowdStrike Falcon、SentinelOne などは新しい `.exe` や `.dll` をすべて検査のために開きます。スキャン自体は数百ミリ秒で終わりますが、並列ビルドで次のプロジェクトが同じファイルをコピーする必要がある場合、コピーがスキャナーと競合することがあります。リポジトリのルートを Defender の除外に追加すれば、この失敗モードを丸ごと消せます。
5. **OneDrive など同期クライアントがファイルを開いている。** OneDrive の "Files On-Demand" 機能は、同期フォルダー配下のファイルを脱水・再水和する際に書き込みハンドルを開きます。ソースツリーが `C:\Users\<あなた>\OneDrive\...` 配下にあると、長時間ビルド中にランダムに MSB3027 を引き起こします。
6. **MSBuild の build server（または VS BuildHost）が接続したまま。** `MSBUILDDISABLENODEREUSE=0`（既定）では、MSBuild はビルド間で `MSBuild.exe` ノードを生かしたままにします。Visual Studio 内での相当物は `VBCSCompiler.exe` と Roslyn の build server です。これらがコピーターゲットを保持することはまずありませんが、ハングしたノードがコンパイル直後のアセンブリを掴んだままになることはあります。
7. **1 つのソリューション内の並列プロジェクトが同じファイルを同時にコピーする。** 同じ `.sln` にあり、共有ライブラリに依存する 2 つのプロジェクトが、それぞれの出力にその同じライブラリをコピーしようとします。`/m` 並列性のもとでは、2 つ目のコピーが `OpenWrite` で MSB3021 にぶつかり、リトライ予算を使い切ることがあります。これは SDK 7.0.400 で再発し、[dotnet/msbuild#9169](https://github.com/dotnet/msbuild/issues/9169) として追跡されています。

## 最小再現: 自分のバイナリーを開いたままにするコンソールアプリ

最小の再現は終了しないコンソールアプリです。次を `MyApp/Program.cs` と `MyApp/MyApp.csproj` として保存します。

```xml
<!-- MyApp.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// Program.cs - .NET 11, C# 14
Console.WriteLine("running, press any key to exit");
Console.ReadKey();
```

1 つ目のターミナルで起動します。

```text
dotnet run
```

次に `Program.cs` を変更し（スペースを 1 つ追加するだけで十分）、2 つ目のターミナルから:

```text
dotnet build
```

2 回目のビルドは次を出力します。

```text
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file because it is being used by another process.
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed.
```

これが標準的なケースです。.NET ホストが DLL を `FILE_SHARE_READ` のみで開いたため書き込みが除外されており、1 つ目のターミナルが DLL の所有権を握っています。

## 修正の詳細

### 1. ロックしているプロセスを特定して終了する

`MSB3027` の後ろのメッセージは、MSBuild が解決できる場合はそのプロセスを列挙します。解決できない場合（コンテナ内やロックダウンされたマシンでよくあります）は、次のいずれかを使ってください。

```text
:: sysinternals handle.exe - https://learn.microsoft.com/sysinternals/downloads/handle
handle64.exe -nobanner -accepteula C:\src\MyApp\bin\Debug\net11.0\MyApp.dll
```

```powershell
# Get-Process by module path (PowerShell 7.4+)
Get-Process | Where-Object { $_.Modules.FileName -contains 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' }
```

```text
:: Kill by image name
taskkill /im MyApp.exe /f
:: Or by PID from handle.exe output
taskkill /pid 4176 /f
```

IIS Express の場合: システムトレイのアイコンを右クリックして `Exit All`、または `iisexpress /stop /siteid:<id>`。フル IIS の場合、`iisreset` は強引な選択肢、`Stop-WebAppPool -Name "<pool>"` はピンポイントな選択肢です。

### 2. ビルドと同じターミナルからプログラムを動かさない

最もきれいな修正はワークフロー側です。リビルド中にデバッグセッションをアタッチしたまま放置しないでください。Visual Studio では `Edit and Continue` や `Hot Reload` の経路が通常これを処理してくれます。コマンドラインからは、手動の `dotnet run` と別の `dotnet build` のループより、リビルドを把握している `dotnet watch` を選んでください。

`dotnet watch` 自体を使っていてリビルドのたびに MSB3027 が出る場合、症状はたいていコンパイルごとに出力 DLL が書き換えられるソースジェネレーターです。SDK リポジトリで文書化されている回避策は、ジェネレーターを別の `.csproj` に切り出し、`<EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>` と `<EmitCompilerGeneratedFiles>false</EmitCompilerGeneratedFiles>` を指定し、ジェネレータープロジェクトを `OutputItemType="Analyzer" ReferenceOutputAssembly="false"` で参照することです。ジェネレーターの DLL はもうコピー対象ではなくなります。

### 3. リポジトリ向けのウイルス対策除外を追加する

Microsoft Defender なら `Windows Security` > `Virus & threat protection` > `Manage settings` > `Exclusions` > `Add or remove exclusions` > `Add an exclusion` > `Folder` を開き、次を追加してください。

- リポジトリのルート、最低でも各 `bin/` と `obj/` サブディレクトリ。
- `%USERPROFILE%\.nuget\packages`（NuGet のグローバルキャッシュ）。
- `%USERPROFILE%\.dotnet`（SDK のインストール先）。

CrowdStrike / SentinelOne / 企業管理下の Defender の場合、自分で除外を設定することはできません。IT チームにチケットを切り、bin/obj フォルダーがユーザーデータではなくビルド成果物であることの根拠としてチームの `.gitattributes` や `.editorconfig` を提示してください。Microsoft 自身の [Defender 除外ドキュメント](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus) も、ビルド出力のリアルタイムスキャンが企業環境における断続的な MSBuild 失敗の主因であることを認めています。

### 4. リポジトリを OneDrive の外へ移す

リポジトリ内で `pwd` を実行して `C:\Users\<あなた>\OneDrive\source\...` と出るなら、移動してください。あらゆる種類の同期クライアント（OneDrive、Dropbox、Google Drive、iCloud）は、アップロード中やハイドレート中のファイルに対する書き込みハンドルを保持し、そのハンドルを MSBuild の都合ではなく自分の都合で解放します。`C:\src\<repo>` のように同期フォルダーの外に置くのが、Windows での .NET 開発の標準的な配置です。

### 5. リトライ予算を引き上げる（最終手段）

ロックがどうしても避けられない場合（共有キャッシュを持つ CI エージェント、除外できないウイルス対策、共有依存を踏みつける並列ビルドなど）、予算を引き上げてください。次をリポジトリのルートの `Directory.Build.props` に置けば、すべてのプロジェクトに適用されます。

```xml
<!-- Directory.Build.props - .NET 11 SDK, MSBuild 17.13 -->
<Project>
  <PropertyGroup>
    <CopyRetryCount>20</CopyRetryCount>
    <CopyRetryDelayMilliseconds>2000</CopyRetryDelayMilliseconds>
  </PropertyGroup>
</Project>
```

これで `Copy` タスクに 40 秒のリトライ予算が与えられます。それ以上の値はより深刻な問題（張り付いたプロセス、誤設定されたウイルス対策）を隠してしまうだけで、失敗したビルドが表に出るのに 1 分かかるようになるため、`CopyRetryCount=20` を超えてはいけません。

並列プロジェクトが同じ共有 DLL を奪い合う CI 特有のケースでは、問題のあるソリューションに `BuildInParallel=false` を設定するか、共有ライブラリを `<ProjectReference>` ではなく NuGet フィードへの `<PackageReference>` としてマークするほうが良い修正です。どちらでも競合は消えます。

### 6. MSBuild ノードがハングしたら build server を停止する

ハングした MSBuild ノードはまれですが目に見えます。`tasklist /fi "imagename eq MSBuild.exe"` を見ると、長時間再利用されていないノードが現れます。次のコマンドでシャットダウンしてください。

```text
dotnet build-server shutdown
```

断続的に MSB3027 が出るスクリプトではビルド間にこれを実行するか、`MSBUILDDISABLENODEREUSE=1` を設定してノード再利用を完全に無効化してください。ビルド時間は数秒伸びますが、ロングテールのファイルロック失敗は消えます。

## 落とし穴と亜種

- **MSB3026 は警告であり、エラーではありません。** MSBuild がコピーをリトライし、そのリトライが成功したことを意味します。MSB3026 しか出ていないならビルドは通っており、修正は不要です。一時的なロックが起こったというノイズに過ぎません。繰り返し出る MSB3026 は、来週 MSB3027 に格上げされる前に Defender の除外を追加するシグナルとして扱ってください。
- **MSB3021 だけで MSB3027 がない場合。** これはリトライループが追加される前の古い挙動です。MSB3021 だけが出ているなら、ずっと古いツールチェイン（.NET Core 2.x または VS 2015 の `msbuild.exe`）です。解決策は `CopyRetryCount` のつまみを除けば同じです。
- **Linux と macOS の亜種。** エラー番号は同じです。Unix カーネルは Windows のように強制的なファイルロックを行わないため、ロック原因の大半は当てはまりません。残るのは権限エラー（Docker ビルド後に宛先ディレクトリが `root` 所有になっている）と空き容量切れです。`df -h` と `ls -ld bin/` で数秒で両方を切り分けられます。
- **コンテナ。** Windows ホストにマウントされたボリュームを使って Linux コンテナ内でビルドするのは、両方の悪いところ取りです。ホストのウイルス対策がコンテナ内から書かれたファイルをスキャンしてしまいます。コンテナローカルのボリューム（`docker volume create`）を使ってコンテナ内でビルドするか、ホスト上で直接ビルドしてください。
- **The file is locked by: 'System' or 'unknown'.** 保持元が `System (4)` や名無しとして報告される場合、犯人はほぼ常にカーネルモードのウイルス対策ドライバーです。Defender、CrowdStrike、SentinelOne はこの形で現れます。ユーザーモードの `taskkill` では何ともなりません。除外を入れるか、一時的にリアルタイム保護を停止するのが解決策です。
- **Native AOT と trim 付き publish。** Native AOT プロジェクトに対する `dotnet publish -c Release` は、出力 `.exe` を 2 回（publish ステップで 1 回、trim 検証で 1 回）書くことがあります。遅い IO ではこれが自分自身と競合します。重複コピーを避けるには、`<PublishAot>true</PublishAot>` と `<PublishSingleFile>false</PublishSingleFile>` を併用してください。

## 関連記事

- [Fix: The type or namespace name 'X' could not be found after adding a project reference](/ja/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) は SDK-style プロジェクトのトラブルシューティングのもう半分です。参照の失敗とコピーの失敗は、思っているよりずっと多くのケースで根本原因を共有します。
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) では、MSB3027 が publish 経路から発生する trim と AOT のシナリオを扱っています。
- [How to profile a .NET app with dotnet-trace and read the output](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) は、ロック元が自分のプログラムで、そもそも何がプロセスを生かし続けたのかを知りたいときに役立ちます。
- [.NET watch in .NET 11 preview 3: Aspire crash recovery](/ja/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/) は、本記事の `dotnet watch` 系の失敗に影響する直近の SDK 変更です。
- [Visual Studio 2026 Hot Reload: auto-restart on rude edits](/ja/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) は hot reload の原因に対応する IDE 側の話題です。

## 出典

- Microsoft Learn, [MSB3027 diagnostic code - MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027)（公式の 1 画面のリファレンス）
- Microsoft Learn, [Configure Microsoft Defender Antivirus exclusions by extension, name, or location](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus)
- GitHub, [dotnet/msbuild#9169 File copy is no longer retried, causing builds to randomly fail](https://github.com/dotnet/msbuild/issues/9169)
- GitHub, [dotnet/sdk#40911 dotnet watch fails with MSB3021 (locked file) when project references custom source generator](https://github.com/dotnet/sdk/issues/40911)
- Microsoft Sysinternals, [handle.exe](https://learn.microsoft.com/en-us/sysinternals/downloads/handle): ロックしているプロセスを特定する標準ツール
