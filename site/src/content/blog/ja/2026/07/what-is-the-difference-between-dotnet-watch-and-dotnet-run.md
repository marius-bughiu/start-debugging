---
title: "dotnet watch と dotnet run の違いは何ですか？"
description: "dotnet run はプロジェクトを一度ビルドして起動します。dotnet watch は dotnet run をファイル監視で包み、ソースファイルを保存するたびにアプリを再起動するか hot reload を適用します。それぞれが正確に何をするのか、dotnet watch が設定して dotnet run が設定しないものは何か、どちらをいつ使うのかを解説します。"
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet run` はプロジェクトを一度ビルドし（既定は Debug）、生成されたアプリを一度だけ起動します。プロセスが終了すると、プロンプトに戻ります。`dotnet watch` は `dotnet run` を包むファイル監視です。アプリを起動したあとソースファイルを監視し、変更を保存するたびに、その変更を実行中のプロセスに hot reload で適用するか、アプリを再起動します。要するに、`dotnet run` は「一度ビルドして起動する」であり、`dotnet watch` は「編集している間、アプリをコードと同期し続ける」です。両者は競合しません。`dotnet watch` は内部で文字どおり `dotnet run` を呼び出すため、`dotnet run` が行うことはすべて `dotnet watch` も行い、そのうえに監視と hot reload が加わります。

以下はすべて .NET 11 SDK（`11.0.100`）を、`<TargetFramework>net11.0</TargetFramework>` と C# 14 で使用します。中核となる動作は、`dotnet watch` が Hot Reload を得た .NET 6 SDK 以降、安定しています。バージョン固有の変更は重要な箇所で示します。

## 一行で表すメンタルモデル

この 2 つのコマンドを続けて実行すると、違いはすぐに分かります。

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet run     # builds, launches once, returns to the prompt when the app exits
dotnet watch   # builds, launches, then stays resident watching for file changes
```

`dotnet run` は終了するコマンドです。作業を終えると制御を返します。`dotnet watch` は長時間動き続けるセッションです。Ctrl+C で止めるまで返りません。この 1 つの動作の事実、すなわち常駐か終了かが、ほかのすべての違いの根源です。

2 つのコマンドを機能ごとに並べると次のようになります。

| 動作                                 | `dotnet run`                  | `dotnet watch`                                  |
| ------------------------------------ | ----------------------------- | ----------------------------------------------- |
| 起動前にビルドする                   | はい（`dotnet build` 経由）   | はい（`dotnet run` に委譲）                     |
| 既定の構成                           | `Debug`                       | `Debug`                                          |
| アプリを起動する                     | 一度                          | 一度、その後は変更時に再起動                    |
| ソースファイルを監視する             | いいえ                        | はい                                             |
| 編集時の Hot Reload                  | いいえ                        | はい（.NET 6 SDK 以降）                         |
| 未対応の編集での再起動               | 該当なし                      | はい（rude edit の確認または自動再起動）        |
| ブラウザーの自動更新（Web アプリ）   | いいえ                        | はい                                             |
| 完了時にプロンプトへ戻る             | アプリが終了したとき          | Ctrl+C のときのみ                               |
| `launchSettings.json` を読む         | はい                          | はい（呼び出す `dotnet run` を通じて）           |

## dotnet run: 一度ビルドし、一度起動する

[dotnet run のリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run)は、これを「ソースコードから 1 つのコマンドで」アプリケーションを実行するコマンドと説明しています。これは `dotnet build` に依存するため、ビルドの要件はすべて `dotnet run` にも適用されます。順序は、暗黙の restore、`bin/<configuration>/<framework>/` へのビルド、続いて生成されたバイナリの起動です。ほとんどのプロジェクトで既定は `Debug` です。

`dotnet run` はコンパイル済みの DLL ではなくプロジェクトから動作するため、`Properties/launchSettings.json` も読み、既定で最初の起動プロファイルを適用します。`ASPNETCORE_ENVIRONMENT=Development` のような環境名やプロファイルの環境変数はそこから来ます。`--no-launch-profile` で無効にするか、`-lp|--launch-profile` で明示的に選択できます。

リテラルの `--` のあとの引数は、CLI ではなくアプリに転送されます。

```bash
# .NET 11 SDK 11.0.100. Everything after -- goes to your Main / top-level args.
dotnet run -- --input data.csv --verbose
```

`--` は見た目以上に重要です。`dotnet run` は認識しないトークンをすべてアプリケーションに転送しますが、その前に自身のオプションを取り除くため、残りが並べ替わることがあります。アプリの引数を `--` のあとに置くと、続くすべてのトークンがアプリケーション引数として扱われ、CLI がそれを解釈し直しません。これはまた、あとでアプリ向けのトークンと衝突しうる新しい `dotnet run` のオプションから、スクリプトを将来にわたって守ります。

`dotnet run` が意図的に行わないこともあります。これはデプロイツールではありません。ドキュメントは、依存関係を NuGet キャッシュから解決すること、そして「`dotnet run` を本番環境でのアプリケーション実行に使うことは推奨されない」ことを明言しています。それには `dotnet publish` が必要で、それは[dotnet build と dotnet publish の違い](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)で扱う別の話です。そして何も監視しません。アプリが立ち上がった時点で `dotnet run` は終了しており、あなたがファイルを編集したことを知る由もありません。

## dotnet watch: dotnet run に、ファイル監視と Hot Reload を加えたもの

[dotnet watch のリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch)ははっきり述べています。`dotnet watch` は「ファイル監視です。変更を検出すると、`dotnet run` コマンドまたは指定された `dotnet` コマンドを実行します」。変更が Hot Reload に対応していれば、再起動せずに実行中のアプリへ適用します。対応していなければ、アプリを再起動します。

これが価値の全体です。`.cs` ファイルを編集して保存すれば、ターミナルに触れることなく 1 〜 2 秒で変更が反映されます。停止、再ビルド、再起動という手動のループはありません。

既定のサブコマンドは `run` なので、次の 2 つは同一です。

```bash
# .NET 11 SDK 11.0.100. 'dotnet watch' with no subcommand defaults to 'run'.
dotnet watch
dotnet watch run
```

.NET 8 SDK 以降、`dotnet watch` は子コマンドとして `run`、`build`、`test` を受け付けます。したがって `dotnet watch test` は保存のたびにテストプロジェクトを再実行し、これは `dotnet run` にはまったく提供できない、密な red-green-refactor のループになります。

転送される引数も同じく機能し、基盤の `dotnet run` に委譲されます。

```bash
# .NET 11 SDK 11.0.100. Args after -- reach the app on every relaunch.
dotnet watch run -- --input data.csv
```

セッションが動いている間、キーボードの操作が 2 つあります。Ctrl+R はファイル変更がなくても再ビルドと再起動を強制します。Ctrl+C は監視とアプリの両方をまとめて畳みます。Ctrl+R はアプリが実際に動いている間だけ効果があります。すぐ終了するコンソールアプリを監視している場合、Ctrl+R を押しても何も起きませんが、監視は続き、ファイルが変更されれば再起動します。

## Hot Reload と、再起動を強いる「rude edit」

Hot Reload は `dotnet watch` を魔法のように感じさせる部分であり、`dotnet run` が持たない最大のものです。.NET 6 SDK 以降、`dotnet watch` は対象となる編集、メソッド本体、多くのステートメント変更、多くの場合に追加されたメンバーを、実行を続ける生きたプロセスに適用します。アプリのメモリ内の状態は編集を越えて維持されます。

すべての編集を実行中のプロセスに適用できるわけではありません。メソッドのシグネチャの変更、型のリネーム、ランタイムがその場でパッチできないものの編集、これらは「rude edit」です。`dotnet watch` がそれに当たると Hot Reload できず、既定ではどうするか尋ねます。

```
dotnet watch ⌚ Unable to apply hot reload because of a rude edit.
  ❔ Do you want to restart your app - Yes (y) / No (n) / Always (a) / Never (v)?
```

Always を選ぶと以後は尋ねず、rude edit のたびに単に再起動します。確認を完全に飛ばすこともできます。`DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1` を設定すると常に黙って再起動し、`--non-interactive`（.NET 7 SDK 以降で利用可能）で実行するとコンソール入力を待たずに rude edit で再起動します。これはスクリプトやコンテナのシナリオで欲しい動作です。Hot Reload をまったく扱わず、単純な変更時再起動のループが欲しい場合は、無効にします。

```bash
# .NET 11 SDK 11.0.100. Watch and restart, no Hot Reload.
dotnet watch --no-hot-reload
```

ここでの Hot Reload エンジンは Visual Studio が使うものと同じで、対応・未対応の編集の集合も同じ規則に従います。[Visual Studio 2026 の rude edit での Hot Reload 自動再起動](/ja/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/)の動作は CLI のそれを反映しています。一方で rude edit を理解すれば、もう一方でも理解できます。

## dotnet watch が環境に設定し、dotnet run が設定しないもの

`dotnet watch` がアプリを起動するとき、素の `dotnet run` が決して設定しない環境変数をいくつか注入します。これらはアプリが監視下で動いていることを検出できるようにし、ときに意外な動作を説明するため、知っておく価値があります。ドキュメントによる主なものは次のとおりです。

- **`DOTNET_WATCH`** は監視が起動するすべての子プロセスで `1` に設定されます。「自分は `dotnet watch` の下で動いているか」を検出する、きれいな方法です。
- **`DOTNET_WATCH_ITERATION`** は `1` から始まり、アプリが再起動または hot reload されるたびに 1 ずつ増えます。ログに出せば、セッションが何回のリロードサイクルを経たか分かります。
- **`DOTNET_HOTRELOAD_NAMEDPIPE_NAME`** は、監視が Hot Reload の差分を実行中プロセスへ送るために使う名前付きパイプを指定します。

したがって、ビルドステップや起動時の診断は監視に応じて分岐できます。

```csharp
// .NET 11, C# 14. Detect the watcher from inside the app.
if (Environment.GetEnvironmentVariable("DOTNET_WATCH") == "1")
{
    var iteration = Environment.GetEnvironmentVariable("DOTNET_WATCH_ITERATION");
    Console.WriteLine($"Running under dotnet watch, reload iteration {iteration}");
}
```

個々の動作（ブラウザー更新、ブラウザー起動、絵文字出力、MSBuild のインクリメンタル処理）を無効にする `DOTNET_WATCH_SUPPRESS_*` のスイッチも複数あります。これらはどれも `dotnet run` の世界には存在しません。`dotnet run` には監視も、Hot Reload のチャネルも、抑制すべきブラウザー更新の注入もないからです。

## どのファイルがリロードを引き起こし、どれが静かに引き起こさないか

よくある混乱のもと: `dotnet watch` の下で `appsettings.json` を編集しても何も再起動しない、というものです。これは設計どおりです。`dotnet watch` はプロジェクトの `Watch` アイテムグループのアイテムを監視します。これは既定で `Compile` と `EmbeddedResource` グループのすべてを、プロジェクト参照のグラフ全体にわたって含みます。実際には次を意味します。

- `**/*.cs`
- `*.csproj`
- `**/*.resx`
- Web コンテンツ: `wwwroot/**`

構成ファイル（`.json`、`.config`）は意図的に再起動を引き起こしません。構成システムが `IOptionsMonitor` とリロードトークンによる独自の変更検出を持つためです。監視に別の種類のファイルへ反応させたい場合は、`.csproj` の `Watch` グループを拡張します。

```xml
<!-- .NET 11. Make dotnet watch react to JS files too. -->
<ItemGroup>
  <Watch Include="**\*.js"
         Exclude="node_modules\**\*;**\*.js.map;obj\**\*;bin\**\*" />
</ItemGroup>
```

.NET 10 SDK 以降は、`DefaultItemExcludes` を使って、そうでなければ騒がしいリロードを引き起こすフォルダー全体を除外することもできます。たとえばアプリが実行時に書き込む `App_Data` ディレクトリです。`dotnet run` にはこの仕組みが一切ありません。起動後に何も読み直さないからです。

## Web アプリでは dotnet watch はブラウザーも更新する

`dotnet run` が触れない、`dotnet watch` 専用の動作がもう 1 つあります。ASP.NET Core と Blazor のアプリでは、監視は小さなブラウザー更新スクリプトを注入し、ツールへ戻る WebSocket を開きます。Razor や CSS の変更を保存すると、ブラウザーに切り替えて F5 を押さなくても、ブラウザーが再読み込みされます（対応する Blazor の編集ではライブ更新されます）。これが、`dotnet watch` が `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` を設定し、ブラウザー更新のミドルウェアが Web プロジェクトに現れる理由です。素の `dotnet run` の下ではこれらは一切得られません。ビューを変更しても、手動で再ビルドして再読み込みするまで、ブラウザーは古いページを表示します。

ドキュメントが指摘する注意点が 1 つあります。アプリがレスポンス圧縮を有効にしていると、ツールは更新スクリプトを注入できずに警告することがあります。対処は、更新スクリプトを自分で条件付きにするか、開発時に圧縮を無効にすることです。

## 動作が変わったバージョン

仕組みは古く安定していますが、いくつかの日付は押さえておく価値があります。

- **.NET 6 SDK**: `dotnet watch` が Hot Reload を得ました。それ以前は再起動のみでした。
- **.NET 7 SDK**: `--non-interactive` と `--disable-build-servers` が加わりました。
- **.NET 8 SDK**: `dotnet watch` は子コマンドを `run`、`build`、`test` に絞りました。以前は任意の `dotnet` コマンドを包めました。
- **.NET 9 SDK（9.0.200）**: `dotnet run -e KEY=VALUE` が登場し、起動プロファイルなしで一回限りの環境変数を CLI から直接渡せるようになりました。`dotnet watch` は `dotnet run` に転送するため、監視下でもこれを利用できます。[起動プロファイルなしで環境変数を設定する dotnet run -e](/ja/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)を参照してください。
- **.NET 10 SDK（10.0.100）**: ファイルベースのアプリ向けの `dotnet run --file app.cs` と、`dotnet watch` での `DefaultItemExcludes` サポート。
- **.NET 11 SDK**: `dotnet watch` は Aspire の app host とクリーンに統合し、クラッシュ後に自動で再起動することを学びました。詳しくは[.NET 11 の dotnet watch: Aspire ホストとクラッシュ復帰](/ja/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/)にあります。

## どちらを実行するか

アプリを一度起動したいときは `dotnet run` に手を伸ばしてください。変更の確認、コンソールツールの実行、CI での単一の呼び出しのスクリプト化、あるいは実行中にコードを編集する予定がないときすべてです。ビルドし、起動し、アプリとともに終了します。コードを動かす最も単純なものです。

編集・保存・確認のループにいるときは `dotnet watch` に手を伸ばしてください。API を反復開発する、Blazor ページのスタイルを整える、`dotnet watch test` で red-green を回す、あるいは絞り込むのに数回の編集を要する何かをデバッグする、といった場面です。常駐ターミナルを 1 つ使うコストがかかり、Hot Reload は rude edit のときにたまに再起動へ落ちますが、その代わり、変更のたびに再ビルド・再起動という手動の税金を払わなくて済みます。

一文のテスト: アプリを実行してからエディターで打ち続けるつもりなら `dotnet watch` を、ただ動かしたいだけなら `dotnet run` を使ってください。どちらも `dotnet publish` を置き換えません。それは今も、実際に出荷するものを生成する唯一のサポートされた方法です。

## 関連記事

- [dotnet build と dotnet publish の違いは何ですか？](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [.NET 11 Preview 3 の dotnet watch: Aspire ホスト、クラッシュ復帰、より賢い Ctrl+C](/ja/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/)
- [.NET 11 Preview 3: dotnet run -e は起動プロファイルなしで環境変数を設定する](/ja/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [Visual Studio 2026: rude edit での Hot Reload 自動再起動](/ja/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/)
- [.NET 11 Preview 5: ファイルベースのアプリが #:ref ディレクティブを得る](/ja/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)

## 参照

- [dotnet watch コマンドのリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch)（Microsoft Learn）
- [dotnet run コマンドのリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run)（Microsoft Learn）
- [dotnet build コマンドのリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build)（Microsoft Learn）
- [Hot Reload に対応する .NET アプリのフレームワークとシナリオ](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload)（Microsoft Learn）
