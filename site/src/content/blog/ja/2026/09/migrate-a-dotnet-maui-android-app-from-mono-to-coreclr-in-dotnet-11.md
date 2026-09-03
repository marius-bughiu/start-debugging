---
title: ".NET 11 で .NET MAUI の Android アプリを Mono から CoreCLR へ移行する"
description: "Android 向け .NET MAUI を Mono から CoreCLR へ移行する手順ガイドです。API 24 という下限、ビルドを壊すようになった Mono 専用の MSBuild プロパティ、APK が大きくなった理由、dotnet-dsrouter と dotnet-trace による起動リグレッションのプロファイリング、そして Mono の経路が失われた今のロールバックの実態を扱います。"
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "dotnet-11"
  - "maui"
  - "android"
  - "coreclr"
  - "mono"
lang: "ja"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-03
---

小規模なアプリであれば、この移行は `TargetFramework` の変更と `android:minSdkVersion` の変更、そして半日の計測で終わります。大規模なアプリなら 1 週間を見込んでください。しかもその 1 週間は、ほぼ次の 2 つに消えます。何もしないか、あるいは積極的にビルドを壊すようになった Mono 時代の MSBuild プロパティを削除すること。そして、あなたのコードとは無関係な起動リグレッションを追いかけることです。見返りは本物です (統一されたデバッグ/診断、階層化 JIT、動的 PGO、Android における Native AOT への現実的な道筋)。ただし正直に言えば、これは選択肢ではありません。[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/) 以降、Microsoft は Android、iOS、Mac Catalyst 向けに Mono の独立した経路を提供しなくなりました。本ガイドは .NET 11 Preview 7 (`11.0.100-preview.7`、2026-08-11 リリース) と .NET MAUI `11.0.0-preview.7` を対象とし、Mono 上の .NET 10 からの移行を扱います。.NET 11 の正式版は 2026-11-10 に予定されています。

## 「選択肢がない」以外にこれをやる価値

- **プロファイラーがようやく動きます。** `dotnet-trace` と `dotnet-counters` が、ASP.NET Core のプロセスに接続するのとまったく同じやり方で、`dotnet-dsrouter` を介して実行中の Android アプリに接続できるようになりました。Mono 固有のトレース方言はもう不要です。
- **階層化コンパイルと動的 PGO が電話機にも来ます。** Mono AOT はビルド時に一度コンパイルして、最適化の話はそこで終わりでした。CoreCLR は Tier 0 でコードを計測し、実際のプロファイルデータを使って Tier 1 でホットなメソッドを再コンパイルします。そのため、長時間動作するアプリの定常状態のスループットは、あなたが何も変えなくても改善します。
- **起動の仕組みとして ReadyToRun が Mono AOT を置き換えます。** Android では、MAUI は CoreCLR の Release ビルドに対して既定で *composite partial* R2R を使い、workload に同梱される `.mibc` プロファイルがそれを制御します。プロファイルが重要と判断したメソッドだけが事前コンパイルされるため、サイズのオーバーヘッドが破滅的にならずに済んでいます。
- **ランタイムが 1 つ、バグトラッカーも 1 つ。** Android 上の `System.Text.Json` や `HttpClient` のバグは、サーバー上のバグと同一のものになり、同じ場所で修正されます。

## 何が壊れるか

| 領域 | 変更 | 深刻度 |
| --- | --- | --- |
| Android の最小 API | 21 (Android 5.0) から 24 (Android 7.0) へ引き上げ | 高 |
| Android の ABI | Android x86 (32 ビット) は CoreCLR ではサポート対象外 | 高 |
| Mono AOT のプロパティ | `RunAOTCompilation`、`AndroidAotMode`、`UseInterpreter` は Mono 専用。`RunAOTCompilation=true` は今も `MonoAOTCompiler` を呼び出してビルドを失敗させることがある | 高 |
| 起動時間 | 大規模アプリで数秒規模のリグレッションと ANR が報告されている | 高 (状況依存) |
| APK サイズ | R2R イメージは `.dll` ファイルの内部に置かれるため、アセンブリが大きくなる | 中 |
| NuGet パッケージ | パッケージが `net6.0-android` 以降ではなく `MonoAndroid` のアセットに解決されると `NU1703` が出る | 中 |
| 旧来のリソース | 依存関係に埋め込まれた旧来の Xamarin.Android リソースに対する `XA0149` | 低 |
| `Microsoft.Maui.Controls.Compatibility` | Preview 6 でパッケージが削除 | 中 (明示的に参照している場合のみ) |
| HTTP エラー | `AndroidMessageHandler` の転送失敗が `WebException` ではなく `HttpRequestException` をスローする | 低 |
| ランタイムの埋め込み | Android の埋め込み API は CoreCLR には引き継がれない | 高 (使用している場合) |

API レベルの下限は、ユーザーにまで届く変更です。[破壊的変更の告知](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level)によれば、.NET 11 でビルドしたアプリは API 21、22、23 ではインストールも実行もできません。着手する前に Play Console の配信内訳を確認してください。これはビルド設定ではなく、ユーザーについての意思決定です。

## 事前チェックリスト

- .NET 11 SDK `11.0.100-preview.7` 以降と、インストール済みの `maui-android` workload。
- `$ANDROID_HOME` が有効な Android SDK のパスを指していること。`dotnet-dsrouter` はそこにある `adb` を使ってポートフォワードを設定するため、そうでないと確実に見つけられません。
- 診断ツールをグローバルにインストールしておくこと: `dotnet tool install --global dotnet-dsrouter`、`dotnet-trace`、`dotnet-counters`。
- **何かを変更する前に、Mono 上の .NET 10 で取得した数値のベースライン。** 誰もが飛ばして後悔する手順です。「なんとなく遅い」は二分探索できないからです。
- エミュレーターだけでなく実機。報告されているリグレッションは起動のリグレッションであり、エミュレーターの起動時間は代表値になりません。

## 移行手順

1. **Mono のベースラインを取得します。** 現行の .NET 10 Release ビルドで APK をインストールし、Android のアクティビティマネージャーでコールドスタートを計測します。`TotalTime` がミリ秒で出力されます。

   ```console
   # .NET 10, Mono, Release
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   5 回実行し、1 回目を捨てて中央値を記録します。Release の APK または AAB のサイズも記録してください。**検証:** ターミナルのスクロールバック以外の場所に、2 つの数値が書き留められていること。

2. **ターゲットフレームワークと API の下限を一緒に動かします。** CoreCLR on Android は API 24 を要求するため、両方の変更を 1 つのコミットで行います。

   ```xml
   <!-- .NET 11 Preview 7, MAUI 11.0.0-preview.7 -->
   <PropertyGroup>
     <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   `Platforms/Android/AndroidManifest.xml` で `android:minSdkVersion` を手書きしている場合は、プロジェクト設定と一致するよう `24` に引き上げてください。**検証:** `dotnet build -f net11.0-android -c Release` が成功し、生成されたマニフェストに `minSdkVersion="24"` が表示されること。

3. **Mono 専用の MSBuild プロパティをすべて削除するか、条件付きにします。** `.csproj`、`Directory.Build.props`、そして CI が注入するプロパティを `RunAOTCompilation`、`AndroidAotMode`、`AndroidEnableProfiledAot`、`UseInterpreter`、`UseMonoRuntime` で grep してください。`Directory.Build.props` に `RunAOTCompilation=true` が残っているのは既知のビルド破壊です。アプリが CoreCLR 上にあっても `MonoAOTCompiler` ターゲットが実行されてしまいます ([dotnet/android#11068](https://github.com/dotnet/android/issues/11068))。丸ごと削除するか、古い TFM を並行してビルドしているなら条件を付けてください。

   ```xml
   <PropertyGroup Condition="'$(UseMonoRuntime)' == 'true'">
     <RunAOTCompilation>true</RunAOTCompilation>
     <AndroidEnableProfiledAot>true</AndroidEnableProfiledAot>
   </PropertyGroup>
   ```

   **検証:** `dotnet build -f net11.0-android -c Release -bl` を実行し、バイナリログを `MonoAOTCompiler` で検索します。ヒット 0 件が合格条件です。

4. **ABI の一覧とパッケージ警告を片付けます。** CoreCLR は配布しないので、`RuntimeIdentifiers` に `x86` が残っていれば外します。

   ```xml
   <RuntimeIdentifiers>android-arm64;android-x64</RuntimeIdentifiers>
   ```

   次に `NU1703` に対処します。Preview 5 で導入された警告で、パッケージが非推奨の `MonoAndroid` フォルダーのアセットに解決されたときに出ます: "Package 'PackageName' 1.0.0 uses the deprecated MonoAndroid framework instead of 'net6.0-android' or later." 新しいバージョンがあればパッケージを更新してください。存在しないなら、それは残り時間が限られた Xamarin 時代の依存関係を見つけたということであり、警告の抑制は修正ではなくそのリスクを引き受ける意思決定です。**検証:** `dotnet restore` がクリーンであること。あるいは残っている `NU1703` がすべて、意識的にトリアージ済みのパッケージであること。

5. **Release で再ビルドし、手順 1 と比較して再計測します。** 同じ実機、同じ手順、同じ実行回数で行います。

   ```console
   # .NET 11 Preview 7, CoreCLR, Release
   dotnet publish -f net11.0-android -c Release
   adb install -r bin/Release/net11.0-android/publish/com.example.myapp-Signed.apk
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Microsoft 自身の見解では、テンプレートのベースラインアプリにおいて Android は起動とアプリサイズで「Mono の 10 パーセント以内」に収まっています。**検証:** この範囲に入っていればパフォーマンス作業は完了です。2 倍以上悪いなら、MSBuild のプロパティを手当たり次第に切り替えるのではなく手順 6 へ進んでください。

6. **推測せずにリグレッションをプロファイルします。** `.csproj` の隣に `DOTNET_DiagnosticPorts=127.0.0.1:9000,suspend` を書いた `app.env` ファイルを置き、条件付きで参照します。

   ```xml
   <ItemGroup Condition="'$(AndroidEnableProfiler)'=='true'">
     <AndroidEnvironment Include="app.env" />
   </ItemGroup>
   ```

   ルーターを起動し、プロファイラーを有効にしてビルドし、アプリを起動してから接続します。

   ```console
   dotnet-dsrouter server-server -ipcs ~/mylocalport -tcps 127.0.0.1:9000 --forward-port Android &
   dotnet build -f net11.0-android -c Release -t:Run /p:AndroidEnableProfiler=true
   dotnet-trace collect --diagnostic-port ~/mylocalport,connect
   ```

   ポートを `suspend` で構成しているので、ランタイムは `dotnet-trace` が接続するまで起動時にブロックします。起動後のすべてではなく起動パスそのものを見たいときに、まさに必要な挙動です。Windows では IPC チャネルが名前付きパイプになるため、`~/mylocalport` ではなく `mylocalport` を使ってください。**検証:** 起動区間が埋まった `.nettrace` ファイルがあり、包括時間の上位 3 メソッドを名前で挙げられること。

7. **トレースが正当化するものだけを調整します。** アセンブリサイズが問題なら、最初に触るつまみは R2R です。R2R イメージは `.dll` ファイルの中に詰め込まれており、それがアセンブリの肥大化の理由だからです。

   ```xml
   <PropertyGroup Condition="'$(Configuration)' == 'Release'">
     <PublishReadyToRun>false</PublishReadyToRun>  <!-- smaller APK, slower startup -->
     <TrimMode>full</TrimMode>                     <!-- default is partial -->
   </PropertyGroup>
   ```

   この 2 つは逆方向に働きます。R2R を切ると起動時間とサイズを交換することになり、`TrimMode=full` はサイズを取り戻す代わりに、あなた自身のコードと NuGet 参照までトリミングするため、フルのリグレッションテストが必要になります。1 つずつ変更し、その都度手順 5 をやり直してください。**検証:** どのつまみも、ブログ記事ではなく自分で引用できる計測差分によって正当化されていること。

8. **段階的にロールアウトします。** まず内部トラックに公開し、クラッシュ率だけでなく ANR 率を特に注視します。大規模アプリで報告されている CoreCLR の障害モードは、Android がプロセスを強制終了するほど起動が長引くというもので、例外ではなく ANR として現れます。**検証:** 1 週間の内部テスト後、Play Console の ANR 率が Mono ビルドと比べて横ばいであること。

## 検証チェックリスト

- `dotnet build -f net11.0-android -c Release` のバイナリログに `MonoAOTCompiler` の呼び出しがない。
- 実機でのコールドスタートの中央値が、.NET 10 のベースラインに対して許容範囲内に収まっている。
- APK/AAB のサイズ差分が記録され、受け入れられている。
- リフレクション、`HttpClient` のエラーパス、シリアル化に触れるテストを含め、テストスイート全体が通る。
- Hot Reload が動作する。CoreCLR では Mono のインタープリターではなく Edit and Continue を経由するため、前回リリースで検証したものとは実際に別のコードパスです。
- アクティブなインストールベースに API 21-23 の端末がない。あるいは切り捨てを周知済みである。

## ロールバック計画

はっきり言っておきます。**ランタイムレベルのロールバックはもう存在しません。** `<UseMonoRuntime>true</UseMonoRuntime>` は Preview 4 で CoreCLR が既定になったときの脱出ハッチとして文書化されましたが、その時点でも、リグレッションを報告する間の一時的な回避策という位置づけでした。Preview 6 は Android、iOS、Mac Catalyst 向けの独立した Mono 経路を削除しました。このプロパティは消えたものとして扱い、リリース計画をその上に組み立てないでください。

実際のロールバック手段はターゲットフレームワークです。.NET 11 のビルドが本番の実ロールアウトを乗り切るまで、`net10.0-android` のビルドをブランチでグリーンに保っておいてください。プロパティを 1 つ切り替えるよりずっと重いロールバックであり、だからこそ手順 1 と手順 5 が存在します。

## 実際に時間を奪う落とし穴

**起動リグレッションは実在し、しかも一様ではありません。** 障害モードを記録した issue が 2 件あります。[dotnet/android#10588](https://github.com/dotnet/android/issues/10588) は "an app that takes 1s to launch on mono can take 6s on coreclr" と報告し、Avalonia の `ControlCatalog.Android` での ANR を挙げています。[dotnet/android#10914](https://github.com/dotnet/android/issues/10914) は `11.0.100-preview.2` でコールドスタートがおよそ 1.0 秒から 6.0 秒へ、APK が 21 MB から 38 MB へ増えたと報告しています。どちらも MAUI ではなく Avalonia であり、どちらも composite partial R2R と MIBC プロファイルの作業がプレビュー期間の後半に入る前のものです。ですから、これらを自分の期待値として読まないでください。手順 1 が必須である理由として読んでください。

**痛むのは XAML の比重が大きい起動パスです。** 報告に共通するのは初期化中のリフレクションと XAML の解析であり、これはまさに、同梱の `.mibc` プロファイルがあなたのアプリの形をカバーしていない場合に partial R2R が事前コンパイルできない処理です。最初のフレームより前に大きなビジュアルツリーを構築するアプリなら、まずそこを見てください。

**`UseInterpreter` は静かに無意味になります。** Mono では Debug で既定が `true` であり、Mono 時代の Hot Reload を成立させていたのがこれでした。CoreCLR では不活性です。何か理由があって有効にしていたのなら (Mono AOT で扱えない動的なコードパスなど)、その理由は消えたのではなく移動しただけです。CoreCLR on Android は Debug で本物の JIT を動かすのでコードは動きますが、そう決めつけず意識的に再テストしてください。

**APK の中身は形が変わります。** Mono では `libmonosgen-2.0.so` と `libaot-*.dll.so` イメージを同梱していました。CoreCLR では `libcoreclr.so`、`libclrjit.so`、`libmonodroid.so` (Android のグルーコードは Mono 時代の名前のままです)、そして R2R イメージ付きの圧縮 MSIL を格納した単一の `libassemblies.arm64-v8a.so` を同梱します。これらのファイル名を参照するビルドスクリプト、サイズ予算、ProGuard/R8 の設定があるなら、更新が必要です。

**サイズの本体はトリミングにあります。** MAUI は今も既定で `TrimMode=partial` を使い、フレームワークのアセンブリはトリミングしますが、あなたのコードと NuGet 参照はそのまま残します。サイズに関する不満の大半は、アセンブリ単位の内訳を見た途端にトリミングの話に変わります。

## 関連記事

- ランタイムの切り替えそのものは、[MAUI が Preview 4 で Android、iOS、Mac Catalyst の既定を CoreCLR にした](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/)ときに発表されました。オプトアウト用プロパティもここから来ています。
- 脱出ハッチは 2 か月後、[MAUI のモバイルが Preview 6 で CoreCLR 専用になった](/ja/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/)ときに閉じられました。
- まだ古いスタック上にいるなら、先に必要な移行は本記事ではなく [Xamarin.Forms から MAUI 11 へ](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/)です。
- 手順 7 の R2R と Mono AOT のトレードオフは [.NET 11 における Native AOT と ReadyToRun と JIT の比較](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)で詳しく扱っています。CoreCLR が Android で開く最終的な行き先については [Native AOT が実際に何を犠牲にするのか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)を参照してください。
- 手順 7 の `TrimMode=full` がシリアル化を壊した場合、その症状は [reflection-based serialization has been disabled for this application](/ja/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) の形で現れます。
- 手順 4 で同梱する ABI の一覧を変えると、以前は配信できていた端末で [「doesn't support required ABI」のインストール失敗](/ja/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/)が起きることがあります。

## 参考資料

- [.NET MAUI Moves to CoreCLR in .NET 11](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/)、.NET ブログ
- [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/)、.NET ブログ
- [Runtimes and compilation in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/deployment/runtimes-compilation)、Microsoft Learn
- [Breaking change: Minimum Android API level raised to 24](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level)、Microsoft Learn
- [Breaking change: NU1703 warning for packages that use deprecated MonoAndroid framework assets](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/11/nu1703-deprecated-monoandroid-framework)、Microsoft Learn
- [dotnet-dsrouter](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter)、Microsoft Learn
- [dotnet/maui#33386、Android での CoreCLR 対応の追跡 epic](https://github.com/dotnet/maui/issues/33386)
- [dotnet/android#10588、ANR while running large app](https://github.com/dotnet/android/issues/10588)
- [dotnet/android#11068、RunAOTCompilation runs MonoAOTCompiler under CoreCLR](https://github.com/dotnet/android/issues/11068)
