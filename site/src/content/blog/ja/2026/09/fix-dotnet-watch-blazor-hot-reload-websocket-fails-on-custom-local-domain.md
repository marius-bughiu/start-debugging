---
title: "修正: カスタムローカルドメインで dotnet watch の Blazor ホットリロード WebSocket が失敗する (403)"
description: "2026年9月の .NET SDK (10.0.112、10.0.401、11 RC1) 以降、dotnet watch は未知のオリジンからのブラウザー更新用 WebSocket を拒否します。DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS にホスト名を設定してください。"
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-10"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain"
translatedBy: "claude"
translationDate: 2026-09-29
---

`dotnet watch` を起動するシェルで `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` にカスタムホスト名 (`myapp.localhost` のようなホストのみで、スキームとポートは付けません) を設定し、再起動してください。2026年9月8日の SDK (10.0.112、10.0.401、9.0.121、9.0.318、8.0.131、8.0.425、11.0.100-rc.1) で CVE-2026-58649 が修正されました。それ以降、ブラウザー更新用の WebSocket が受け付ける `Origin` は、`localhost`、`127.0.0.1`、`[::1]`、およびこの変数に列挙したホストだけです。それ以外は 403 になります。以下の内容はすべて macOS 上で、SDK 10.0.302 (修正前) と 10.0.401 (修正後)、標準の `dotnet new blazor` テンプレートを使って計測しました。

## エラーの状況

素の `localhost` ではなく、`http://myapp.localhost:5080`、`https://shop.test`、hosts ファイルのエイリアスのような名前でアプリを開いているとします。ページは表示され、Blazor 自身の回線 (circuit) も接続されますが、ブラウザーのコンソールには次のように出力されます。

```
Failed to load resource: the server responded with a status of 403 (Forbidden)
WebSocket connection to 'ws://localhost:5599/' failed:
WebSocket failed to connect.
WebSocket connection to 'wss://localhost:63038/' failed:
WebSocket failed to connect.
Unable to establish a connection to the browser refresh server.
```

最後の 3 行は `aspnetcore-browser-refresh.js` の `console.debug` 出力なので、Chrome や Edge の DevTools で「Verbose」レベルを有効にしないと表示されません。ポート番号は固定しない限りランダムです。一方、`dotnet watch` のターミナルはまったく正常に見えます。

```
dotnet watch ⌚ Files updated: ./Components/Pages/Home.razor
dotnet watch 🔥 C# and Razor changes applied in 109ms.
```

ターミナルは変更が適用されたと言い、ブラウザーはそうではないと言います。この食い違いが、この問題をわかりにくくしています。この問題に遭遇した人の多くは、プロジェクト側では何も変更していません。Visual Studio、Homebrew、あるいは `rollForward: latestPatch` を指定した `global.json` を通じて、SDK が知らないうちに更新されたのです。[dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291) の報告もまさにそのとおりで、SDK 10.0.401 で `bug.dev.localhost` 上のホットリロードが壊れ、10.0.400 に固定すると再び動作しました。

## ブラウザー更新用ソケットが 403 を返すようになった理由

`dotnet watch` の下では、Web アプリに小さなスクリプト `_framework/aspnetcore-browser-refresh.js` が挿入されます。このスクリプトは、`dotnet watch` プロセス内でホストされているサーバーへ WebSocket を開きます。サーバーは `127.0.0.1` のランダムなポートで待ち受け、開発用証明書が利用できる場合は WSS ポートも待ち受けます。このソケットは、ページのリロード、CSS の更新、Blazor WebAssembly の差分、診断情報を運びます。挿入される URL は、ページ自体がどのホスト名で読み込まれたかに関係なく、常に `localhost` を指します。

```js
// injected by dotnet watch, SDK 10.0.401
const webSocketUrls = 'ws://localhost:5599,wss://localhost:63038'.split(',');
```

そのため、`http://myapp.localhost:5080` のページは `ws://localhost:5599` へクロスオリジンの WebSocket リクエストを送ることになり、ブラウザーはそこに `Origin: http://myapp.localhost:5080` を付けて送信します。2026年9月より前は、更新サーバーは `Origin` ヘッダーをまったく無視していました。ブラウザーで開いているどのサイトのどのページからでも接続でき、しかもこのソケットは IL と PDB の更新ペイロードを運びます。これが [CVE-2026-58649](https://github.com/dotnet/sdk/issues/56166) で、CWE-346 (Origin Validation Error)、CVSS 6.5 と評価されています。

修正 (`release/11.0.1xx` への [dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198) と、`main` へ移植された [#56246](https://github.com/dotnet/sdk/pull/56246)) では、WebSocket を受け付ける前に次のチェックが追加されます。

```csharp
// src/Dotnet.Watch/HotReloadClient/Web/BrowserRefreshServer.cs (SDK fix for CVE-2026-58649)
if (!Uri.TryCreate(context.Request.Headers.Origin.FirstOrDefault(), UriKind.Absolute, out var originUri) ||
    !webSocketConfig.GetAllowedOriginDomains().Contains(originUri.Host, StringComparer.OrdinalIgnoreCase))
{
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return;
}
```

`GetAllowedOriginDomains()` は、`localhost`、`127.0.0.1`、`[::1]`、`DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` のすべてのエントリ、そして設定されている場合は `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` の値を返します。比較は `Uri.Host` との完全一致で、大文字と小文字は区別されません。ワイルドカードも、サフィックス一致も、`*.localhost` の特別扱いもありません。`Origin` ヘッダーがまったくないリクエストも拒否されます。

## 最小再現手順

```bash
# .NET SDK 10.0.401, macOS 26 (any OS behaves the same)
dotnet new blazor -o BlazorRepro
cd BlazorRepro
DOTNET_WATCH_AUTO_RELOAD_WS_PORT=5599 dotnet watch run --urls http://localhost:5080
```

`DOTNET_WATCH_AUTO_RELOAD_WS_PORT` でポートを固定するのは、ソケットを調べやすくするためです。Chromium 系ブラウザーは hosts ファイルにエントリがなくても `*.localhost` の名前をすべてループバックに解決するので、`http://myapp.localhost:5080/` を開けば上記のコンソール出力が得られます。ブラウザーすら不要です。`curl` で生の WebSocket ハンドシェイクを行えば、判定結果を直接確認できます。

```bash
# .NET SDK 10.0.401, while dotnet watch is running
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://myapp.test:5000' \
  http://127.0.0.1:5599/
```

このハンドシェイクを、新しい変数の値を変えながら両方の SDK に対して実行しました。

| `Origin` ヘッダー | 10.0.302 | 10.0.401 | 10.0.401 + `ORIGINS=myapp.test;bug.dev.localhost` |
|---|---|---|---|
| `http://localhost:5000` | 101 | 101 | 101 |
| `http://myapp.test:5000` | 101 | 403 | 101 |
| `https://myapp.test` | 101 | 403 | 101 |
| `http://bug.dev.localhost:5000` | 101 | 403 | 101 |
| `https://evil.example` | 101 | 403 | 403 |
| (`Origin` なし) | 101 | 403 | 403 |

10.0.302 で `https://evil.example` に 101 (Switching Protocols) が返るのが、まさに脆弱性そのものです。10.0.401 では、列挙するまでカスタム名はすべて拒否されます。

## 修正方法: ホスト名を許可する

`dotnet watch` は、起動時に**自身の**プロセス環境からこの変数を読み取ります。`dotnet watch` を起動するシェル、タスクランナー、またはコンテナーで設定し、その後ウォッチャーを再起動してください。実行中のウォッチャーは変更を拾いません。

```bash
# bash / zsh, .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.localhost"
dotnet watch run --urls http://localhost:5080
```

```powershell
# PowerShell, .NET SDK 10.0.401+
$env:DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS = "myapp.localhost"
dotnet watch run
```

複数の名前を指定する場合は、`;` または `,` で区切ります。各エントリの前後の空白は取り除かれます。

```bash
# .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="shop.test;admin.shop.test,api.shop.test"
```

VS Code からウォッチャーを起動する場合は、`launch.json` ではなくタスクに変数を設定してください。`coreclr` の起動構成の `env` はアプリに渡されますが、チェックを行うのはアプリのプロセスではありません。

```json
// .vscode/tasks.json, .NET SDK 10.0.401+
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "watch",
      "type": "process",
      "command": "dotnet",
      "args": ["watch", "run", "--project", "BlazorRepro/BlazorRepro.csproj"],
      "options": { "env": { "DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS": "myapp.localhost" } },
      "isBackground": true
    }
  ]
}
```

`DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS=myapp.localhost` を設定すると、`http://myapp.localhost:5080` の同じページが接続され、手動でリフレッシュしなくても編集がブラウザーに反映されました。静的 SSR の `Home.razor` のテキスト変更と、`wwwroot/app.css` の色の変更は、どちらも開いているタブに表示されました。

## 実際に何が壊れるのか、なぜ一部の編集は動いているように見えるのか

症状はコンポーネントがどこでレンダリングされるかによって変わるため、このバグは断続的に見えます。10.0.401 で変数を設定せず、ページを `myapp.localhost` で開いた場合は次のとおりです。

- **Interactive Server コンポーネント** (テンプレートの `Counter.razor`、`@rendermode InteractiveServer`): Razor と C# の編集は**引き続き反映されました**。差分はサーバープロセス内で適用され、Blazor は自身の SignalR 回線 (`ws://myapp.localhost:5080/_blazor`) 経由で再レンダリングします。これは同一オリジンであり、更新サーバーには一切触れません。
- **静的 SSR ページ** (テンプレートの `Home.razor`): Razor の編集は**反映されませんでした**。`dotnet watch` は「C# and Razor changes applied」と表示しましたが、新しい HTML を表示できるのは、更新ソケット経由で送られるブラウザーのリフレッシュだけです。
- **`wwwroot` の CSS**: ターミナルには「Static asset changes applied」と表示されたにもかかわらず、どのページでも変更は**反映されませんでした**。CSS の更新は更新ソケットを通じて配信されます。
- **Blazor WebAssembly** (スタンドアロン、または `.Client` プロジェクト): 差分そのものが更新ソケットを通るため、WebAssembly コンポーネントの C# と Razor のホットリロードも止まります (このケースは計測していませんが、配信経路は同じソケットです)。

つまり、「カウンターのページではホットリロードが動くのにホームページでは動かない」という現象は、2 つの別の問題ではなく、同じこのバグです。コンポーネントがどのケースに該当するか分からない場合は、[Blazor がコンポーネントを実行するレンダーモードをどう決めるか](/ja/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)を参照してください。

## 落とし穴と紛らわしいケース

**値はオリジンではなくホスト名です。** チェックは `Uri.Host` を比較するので、`http://myapp.test` や `myapp.test:5000` は何にも一致しません。私の実行では、`DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.test:5000,*.localhost"` も `"http://myapp.test"` も、どのカスタムオリジンに対しても 403 のままでした。サブドメインはすべて明示的に列挙してください。

**`launchSettings.json` は機能しません。** プロファイルの `environmentVariables` はアプリのプロセスに渡されますが、その時点で `dotnet watch` はすでに許可リストを作り終えています。テンプレートの `launchSettings.json` の両方のプロファイルに変数を追加しても、`myapp.test` に対しては 403 のままでした。同じ修正で、起動プロファイルの変数がアプリに届く方法も変わりました。`-e` 引数ではなく、RPC 経由でホットリロードエージェントに渡されるようになっています ([CVE-2026-69806](https://github.com/dotnet/sdk/issues/56167)、同じ PR)。ただし、ウォッチャー自身の設定にはまったく影響しません。リポジトリと紐づけたい場合は、`.env` 形式のスクリプトか、上記のタスク定義が適切な場所です。

**`DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` は別の設定です。** そのホストも許可リストに追加されます (`HOSTNAME=myapp.test` にすると、私のテストでは `myapp.test` のオリジンが 101 を返しました) が、それだけではありません。更新サーバーがバインドするホストと、挿入されるスクリプトが接続する URL が変わります。Kestrel は IP でないホスト名を「すべてのインターフェースで待ち受ける」と解釈するため、ソケットがネットワークから到達可能になります。`HOSTNAME` を使うのは、ブラウザーが本当に `localhost` に到達できない場合、たとえば `dotnet watch` がコンテナー内やリモートの開発ボックスで動いている場合に限ってください。ページの名前だけが違う場合は `ORIGINS` を使ってください。

**古い SDK に固定すると、脆弱性を復活させることで「直った」ように見えます。** `global.json` を 10.0.400 や 10.0.302 に固定すると 403 は消えますが、それらの SDK は `https://evil.example` を含むあらゆるオリジンを受け付けるからです。これは修正ではなく、原因切り分けの手順として扱ってください。

**アドバイザリの表とリリースノートでバージョン番号が食い違っています。** アドバイザリでは 10.0.111 と 10.0.400 が「修正済み」とされています。[リリースメタデータ](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json)では、CVE-2026-58649 は 9月8日のリリース (ランタイム 10.0.12、SDK 10.0.112 と 10.0.401) に含まれています。計測結果と issue の報告者もリリースメタデータと一致しており、10.0.400 はあらゆるオリジンを受け付け、10.0.401 はチェックを強制します。公開されている `v10.0.400` と `v10.0.401` のタグは、セキュリティ修正が内部リポジトリからビルドされるため同じコミットを指しており、タグの差分を取っても意味がありません。

**ページ自体が 403 になる場合は別の問題です。** ドキュメント全体が 403 を返す場合は、そのポートで実際に何が待ち受けているかを確認してください。macOS では、ポート 5000 はコントロールセンターの AirPlay レシーバーが使用しており、どのパスに対しても 403 を返します。ブラウザーは `*.localhost` を `127.0.0.1` より先に `::1` に解決することがあるため、`127.0.0.1:5000` のみにバインドされた Kestrel は、その接続を AirPlay に奪われます。再現環境を作っている最中にまさにこれに遭遇したため、上記のコマンドでは `--urls http://localhost:5080` を使っています。

**カスタムドメインを使っていないのに更新されない場合は?** `localhost` でブラウズしていてもソケットが失敗するなら、原因は別にあります。信頼された開発用証明書がない状態で HTTPS ページが `wss://` を試みている、`DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH=1` が環境に残っている、あるいはレスポンスを書き換えるミドルウェアのせいでスクリプトが挿入されない、などです。[dotnet watch が dotnet run に追加するもの](/ja/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)では、スクリプトの挿入と、設定される環境変数を説明しています。

**この問題は将来なくなります。** SDK の `main` ブランチでは、[dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118) (2026-09-21 にマージ) が、ブラウザーツール用の WebSocket をアプリ自身のオリジン経由にし、ループバック専用のプロバイダーへ転送するようにしています。この設計ではページとソケットが同じオリジンを共有し、コードコメントには `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` は「no longer applies to this hop」と書かれています。この変更は本稿執筆時点でどの SDK にも含まれていないため、10.0.401 と 11 RC1 では引き続きこの変数が必要です。

## 関連記事

SDK の更新が、プロジェクトに何も変更を加えていないのに Blazor アプリを静かに壊したのは、これで 2 回目です。1 回目は [.NET 10 SDK のインストール後に発生する blazor.server.js の 404](/ja/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/) でした。ブラウザーソケット以外に `dotnet watch` が最近何を獲得したかについては、[.NET 11 Preview 3 の dotnet watch と Aspire ホスト、クラッシュ復旧](/ja/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/)を参照してください。CLI ではなく Visual Studio を使っている場合は、[Visual Studio 2026 の Hot Reload 自動再起動](/ja/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/)で、IDE が適用できない編集をどう扱うかを説明しています。この記事のために Visual Studio 独自のブラウザー接続はテストしていません。

## 情報源

- [CVE-2026-58649 のアドバイザリ、dotnet/sdk#56166](https://github.com/dotnet/sdk/issues/56166) と、[アナウンス、dotnet/announcements#441](https://github.com/dotnet/announcements/issues/441)。
- 修正である [dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198) (カスタムドメイン向けの回避策として `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` を説明しています) と、その `main` への移植 [#56246](https://github.com/dotnet/sdk/pull/56246)。
- [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291)、SDK 10.0.401 での `*.dev.localhost` に関するリグレッション報告と、メンテナーによる回避策。
- 変数名、区切り文字、既定値については、[dotnet/sdk の `EnvironmentVariables.cs`](https://github.com/dotnet/sdk/blob/main/src/Dotnet.Watch/Watch/Context/EnvironmentVariables.cs)。
- [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118)、`main` における同一オリジンのブラウザーツール再設計。
- どの SDK ビルドに修正が含まれるかについては、[.NET 10 リリースメタデータ](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json)。
