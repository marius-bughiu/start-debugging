---
title: ".NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United: 2026 年に選ぶべきはどれか"
description: ".NET 11 で新規の Blazor アプリを作るなら、Blazor Web App テンプレート (かつて Blazor United と呼ばれていたもの) を生成し、ページごとに描画モードを選びます。Server 専用や WebAssembly 専用のテンプレートが妥当なのは限られたケースだけです。"
pubDate: 2026-05-26
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

.NET 11 で新規の Blazor プロジェクトを始めるなら、答えは Blazor Web App テンプレート (.NET 8 のプレビュー期間中に「Blazor United」と呼ばれていたモデル) です。これによりコンポーネント単位で描画方法を決められます。マーケティング ページには静的なサーバー側描画、低レイテンシな CRUD 画面には Interactive Server、オフライン対応のウィジェットには Interactive WebAssembly、そして WASM のペイロードがダウンロードし終わった時点で Server から WebAssembly へ切り替わるべきコンポーネントには Auto を割り当てる、といった具合です。Server 専用や WebAssembly 専用のテンプレートを選ぶのは、統一モデルを除外する強い制約がある場合だけにしましょう。たとえば、WebAssembly のダウンロードが致命的になる社内アプリや、サードパーティ API に対して完全オフラインで動かなければならない PWA などです。

本記事は .NET 11 (執筆時点ではプレビュー、GA は 2026 年 11 月予定) と `Microsoft.AspNetCore.Components` 11.0.x パッケージ群を対象とします。プロジェクト テンプレートは `Microsoft.AspNetCore.Components.WebAssembly.Templates` と、.NET 11 SDK に同梱されている `dotnet new blazor` テンプレートを使います。バージョン間で挙動が異なる場合は、.NET 8、.NET 9、.NET 10、.NET 11 の違いを本文中で明示します。

## .NET 11 における「Blazor United」の実体

「Blazor United」は別のホスティング モデルではありません。.NET 8 のプレビュー サイクル中に Microsoft が使っていた作業名で、最終的に **Blazor Web App** テンプレートとして出荷されたものです。このテンプレートは 1 つのプロジェクトに 4 つの描画モードをまとめています。

- **Static Server (SSR)**: HTML をサーバーで描画し、インタラクティビティなし、SignalR の circuit なし、WebAssembly のダウンロードなし。Razor Page と同じように読み込まれます。
- **Interactive Server**: HTML をサーバーで描画し、DOM の更新を SignalR circuit 経由でプッシュします。これが従来の Blazor Server モデルです。
- **Interactive WebAssembly**: コンポーネントを WebAssembly ランタイムでブラウザー上で動作させます。従来の Blazor WebAssembly モデルです。
- **Interactive Auto**: ユーザーがバックグラウンドでの WebAssembly バンドルのダウンロード完了を待つ間は Server で描画し、次の遷移で透過的に WebAssembly へ引き継ぎます。WebAssembly が読み込めなかった場合のフォールバックはコンポーネント単位です。

モードはコンポーネントごとに `@rendermode InteractiveServer`、`@rendermode InteractiveWebAssembly`、`@rendermode InteractiveAuto` で宣言します。モード固有の API を呼ばない限り、同じ `.razor` ファイルをいずれのモードでも動かせます (詳細は後述)。

Blazor Server (スタンドアロン テンプレート `dotnet new blazorserver`) と Blazor WebAssembly (`dotnet new blazorwasm`) は .NET 11 でも依然として存在しますが、.NET 8 以降の Microsoft の指針は「特別な理由がない限り統一された Blazor Web App テンプレートを優先せよ」です。

## 機能マトリックス

| 機能                                      | Blazor Server (スタンドアロン)            | Blazor WebAssembly (スタンドアロン)             | Blazor Web App / United (.NET 11)             |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| 描画の場所                                | サーバー                                 | ブラウザー                                   | コンポーネント単位 (Static、Server、WASM、Auto) |
| 初期ペイロード (コールド キャッシュ)      | HTML 約 50-80 KB                         | WASM + アセンブリ 約 1.4 MB (R2R、.NET 11)   | HTML 約 50-80 KB、WASM は遅延ダウンロード     |
| First Contentful Paint (LAN)              | 約 80-150 ms                             | 約 600-900 ms                                | 約 80-150 ms (Static / Server) 約 600-900 ms (WASM-first) |
| FCP 後にインタラクティブになるまでの時間  | 数十 ms (WebSocket オープン)             | 数百 ms (WASM ブート)                        | ページの描画モードに依存                      |
| 永続的な WebSocket が必要か               | はい (SignalR)                           | いいえ                                       | Interactive Server コンポーネントだけ必要     |
| オフライン動作                            | 不可                                     | 可 (service worker と併用)                   | WebAssembly コンポーネントは可、Server コンポーネントは不可 |
| データベース / ファイル / シークレットへの直接アクセス | 可 (サーバー プロセス)            | 不可 (ブラウザー サンドボックス)             | Server コンポーネントは可、WASM コンポーネントは不可 |
| .NET API の表面                           | 完全なサーバー ランタイム                | トリミングされたブラウザー安全なサブセット   | コンポーネント次第で両方                      |
| デバッグ体験                              | Visual Studio / Rider で F5              | Chrome devtools + VS の WebAssembly デバッガー | 両方                                          |
| サーバーあたりのスケール上限              | 開いている circuit に律速 (ノードあたり約 5k) | 上限なし (静的ファイル + API)             | Interactive Server ページだけ律速             |
| Native AOT サポート                       | 不可 (サーバーは依然 JIT)                | WASM AOT で部分的に可                        | 描画モード単位                                |
| 認証の流儀                                | cookie + circuit                         | ブラウザー上の OIDC / トークン               | SSR/Server は cookie、WASM はトークン         |
| .NET 11 でのステータス                    | サポートされるが推奨デフォルトではない   | サポートされるが推奨デフォルトではない       | 推奨されるデフォルト                          |

ほとんどの新規アプリでは、最後の行で議論は決着します。Microsoft 自身のテンプレート、ドキュメント サンプル、チュートリアルはすべて Blazor Web App テンプレートから始まっています。2026 年に Server 専用や WebAssembly 専用を選ぶのは、明確な逸脱であり、相応の正当化が必要になります。

## Blazor Server (スタンドアロン) を選ぶべきタイミング

スタンドアロンの Blazor Server テンプレートが正解なのは、次のいずれかの制約があるときです。

- **LAN 内部アプリ、ユーザー数が固定、WebAssembly のダウンロードが禁止されている。** フィールド サービス ツール、製造業のダッシュボード、病棟のスクリーン。不安定なキオスク Wi-Fi で 1.4 MB の WebAssembly をダウンロードさせるのは、SignalR の再接続よりずっと悪いユーザー体験です。.NET 11 では、スタンドアロン Server テンプレートは WASM ランタイムを発行物にコピーしないので、コンテナ イメージも最もスリムです。
- **コンポーネントから Windows 認証の SQL Server や、Kerberos で保護されたサービスを呼び出す必要がある。** コンポーネントはサーバー プロセス内で動作するので、アプリケーション プール ID の統合資格情報を利用できます。WebAssembly でこれを実現するにはサーバー側プロキシが必須になります。
- **チームにフロントエンド要員が今もこれからもいない。** SignalR circuit によるサーバー描画は、ブラウザー固有の心配事をほぼすべて隠してくれます。状態はサーバーに置かれ、デバッグは通常の .NET ツールで、WASM バンドル用の二段目のビルド パイプラインも要りません。

.NET 11 における最小限の Blazor Server `Program.cs`:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

`AddRazorComponents()` と `AddInteractiveServerComponents()` の組み合わせは .NET 8 以降の API です。古い `AddServerSideBlazor()` も動きますが、互換レイヤー経由で動作するため、新しい描画モードの仕組みを点火しません。グリーンフィールド プロジェクトでは新しい API を使ってください。

## Blazor WebAssembly (スタンドアロン) を選ぶべきタイミング

スタンドアロンの WebAssembly テンプレートを選ぶのは、次のような場合です。

- **アプリがオフラインで動かなければならない。** フィールド エンジニアに配るための PWA、店舗スタッフ向けのタブレット アプリ、不安定な接続の向こうにバックエンドがあるあらゆるもの。service worker と (`Microsoft.JSInterop` 経由の `IndexedDB` などの) ローカル ストアを組み合わせれば、ネットワーク完全断にも耐えます。
- **.NET ランタイムを持たない CDN や静的ホストにデプロイする。** Blazor WebAssembly は `wwwroot/` と `_framework/` フォルダーだけです。Cloudflare Pages、GitHub Pages、Azure Static Web Apps、CloudFront 配下の S3 バケットなど、どこにでも置けます。コンピュートは無料です。一方、Blazor Web App テンプレートは Server / SSR ページのために ASP.NET Core ホストを必要とします。
- **バックエンドが自分のものではないサードパーティ API である。** データ ストアが Stripe、Auth0、公開 REST API なら、ホストするサーバー ロジックがありません。スタンドアロン WASM テンプレートと OIDC PKCE フローを組み合わせれば、自前インフラなしで完全クライアント側のアプリになります。
- **フロントエンドを MAUI Hybrid や Electron アプリの一部として配布したい。** `BlazorWebView` も .NET MAUI Hybrid テンプレートも、スタンドアロンの WebAssembly スタイルのコンポーネント グラフを前提としています。そこに Blazor Web App プロジェクトを埋め込んでもメリットはありません。

.NET 11 における最小限の Blazor WebAssembly `Program.cs`:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.WebAssembly 11.0.x
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

await builder.Build().RunAsync();
```

.NET 11 では、`.csproj` に `<WasmEnableThreads>true</WasmEnableThreads>` を指定すれば、新規プロジェクトの WebAssembly ランタイムでマルチスレッドが既定で有効になります。これによって、Blazor WebAssembly を敬遠する最大級の理由 (CPU バウンドな処理が UI スレッドをブロックする) が解消されます。

## Blazor Web App (United モデル) を選ぶべきタイミング

それ以外のすべてのケースです。統一テンプレートでは、1 つのプロジェクトで以下のような構成が可能になります。

- ランディング ページは `@rendermode StaticServer` で、JavaScript なしで 100 ms 未満で読み込まれます。クローラーから見れば Razor Page と区別がつきません。
- ダッシュボードは `@rendermode InteractiveServer` で、`DbContext` を直接扱い、これらのクエリを API として外に出したくありません。
- 画像注釈ツールは `@rendermode InteractiveWebAssembly` で、`Microsoft.ML.OnnxRuntime` 経由でブラウザー内で ONNX モデルを動かします。
- 共有シェル コンポーネントは `@rendermode InteractiveAuto`: 初回描画は Server 下で行い、バンドルのダウンロードが終わったら WebAssembly に引き継ぎます。これによって、その後の遷移は瞬時に行え、サーバーの再起動にも耐えます。

この構成可能性は、他のいかなる選択肢にも追いつけません。「Server アプリか WASM アプリか」という二者択一の決定から、Next.js が `ssr`、`static`、`client` を混ぜられるのと同じように、ページ単位の決定へと移行します。.NET 11 における最小限の Blazor Web App `Program.cs`:

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.Components.Server 11.0.x +
// Microsoft.AspNetCore.Components.WebAssembly.Server 11.0.x
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(BlazorApp.Client._Imports).Assembly);

app.Run();
```

テンプレートに付属する `.Client` プロジェクトは、WebAssembly で動かす必要のあるコンポーネントを置く場所です。サーバー専用のコンポーネントはホスト プロジェクトに残します。Interactive Auto コンポーネントは `.Client` に置きます (WebAssembly 側からも到達可能でなければならないため)。

## コールド スタートとバンドル サイズの実測値

以下の数値は、.NET 11 SDK `11.0.100-preview.4.26152.6` 上でクリーンな `dotnet new blazor`、`dotnet new blazorserver`、`dotnet new blazorwasm` を実行し、`dotnet publish -c Release` で発行して `dotnet run` で配信したものを計測した結果です。Chrome 137 を載せた MacBook Pro M2 で、コールド キャッシュ、DevTools の「Fast 3G」スロットリングで測定しました。

| 指標                                         | Blazor Server | Blazor WebAssembly | Blazor Web App (Auto ランディング) |
| -------------------------------------------- | ------------- | ------------------ | -------------------------------- |
| 初回 HTML 転送量                             | 8 KB          | 4 KB               | 8 KB                             |
| WebAssembly + アセンブリ転送量               | 0             | 1.42 MB (gzip)     | 1.42 MB (gzip、遅延)             |
| First Contentful Paint までの時間            | 320 ms        | 1850 ms            | 340 ms                           |
| インタラクティブになるまでの時間 (counter ボタン) | 410 ms     | 2300 ms            | 440 ms (Server) / 2400 ms (WASM への引き継ぎ) |
| 初回遷移後のメモリ                           | ブラウザー 7 MB | ブラウザー 38 MB | 9 MB、引き継ぎ後 41 MB           |

Auto モードの Blazor Web App はバンドルを待たないため、first paint でスタンドアロン WebAssembly に 5 倍差をつけて勝ちます。一方でスタンドアロン Server には勝てません。WebAssembly バンドルが読み込まれた後はメモリを消費してしまうからです。要点は「Auto がある一つの指標で最速」ということではありません。「Auto はけっして最遅にならない」ということです。

.NET 11 SDK がどのように WASM バンドルをトリミングするかについてもっと深く知りたい方は、同じ trimmer 設定を使う [.NET 11 の新しい Blazor WebWorker テンプレート](/2026/04/dotnet-11-preview-2-blazor-webworker-template/) をご覧ください。

## あなたに代わって決めてくれる落とし穴

好みに関係なく決定を強制してくる事項が 3 つあります。

1. **WebAssembly コンポーネントに `DbContext` のインジェクションを置くことはできません。** シークレットを含む `IConfiguration` の値も同様です。接続文字列を使う blob クライアントも同様です。ブラウザーは設計上、敵対的な環境です。コンポーネントが直接データベースを読まなければならないなら、それは Server でなければなりません (あるいは WASM コンポーネントから呼び出すバックエンド API が必要です)。Blazor Web App テンプレートはこれを早期に表面化させます。`.Client` のコンポーネントに `@inject ApplicationDbContext Db` を入れると、ビルドが依存性注入の欠落エラーで明確に失敗します。

2. **描画モードの境界の内側で `@rendermode` を切り替えることはできません。** Static Server で描画されるページは Interactive Server の「島」をホストできますし、Interactive Server のページは Interactive WebAssembly の島をホストできますが、インタラクティビティの中にインタラクティビティを入れ子にすることはできません。実際の運用では、ページに使える最も低い描画モードを選び、エスカレーションは島レベルだけで行ってください。

3. **HTTPS、antiforgery、認証状態は既定で cookie 経由で流れます。** WebAssembly コンポーネントは cross-origin のリクエストでこれらの cookie を見られません。Blazor Web App の WebAssembly 部分が外部 API を呼ぶ場合、ホスト cookie だけでは不十分で、OIDC トークン フローを上に重ねる必要があります。これは Blazor Server アプリを Web App テンプレートに移行する際に最もよくつまずくポイントです。

antiforgery の観点については、[.NET 11 の Blazor SSR での TempData の挙動](/2026/04/blazor-ssr-tempdata-dotnet-11/) と [共有バリデーション ロジックのガイド](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) が実践的なパターンを扱っています。

## 推奨の再掲

2026 年に .NET 11 で新規 Blazor プロジェクトを始めるなら、`dotnet new blazor` (Blazor Web App テンプレート) から始め、ページごとに描画モードを割り当ててください。マーケティング ページのために `@rendermode StaticServer` に下げたり、オフライン対応コンポーネントのために `@rendermode InteractiveWebAssembly` に上げたりできることのコストは、間違ったスタンドアロン テンプレートを選んで後で書き直すコストに比べればほぼゼロです。`dotnet new blazorserver` を選ぶのは、WebAssembly のダウンロードが厳格に禁じられているときだけにしましょう。`dotnet new blazorwasm` を選ぶのは、デプロイ先に .NET ランタイムがない場合、または MAUI Hybrid や Electron にフロントエンドを埋め込む場合だけです。

すでに Blazor Server で動いていて移行を検討中なら、移行先はほぼ常に「既存ページの大半を `@rendermode InteractiveServer` にした Blazor Web App テンプレート」になります。これがリスク最小の移行です。移行したページの挙動は同一のまま保たれ、Static Server や Auto コンポーネントを段階的に追加するという選択肢が解放されます。

## 関連

- [ASP.NET Core 11 における Minimal APIs vs コントローラー](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) — Blazor Web App が開くバックエンド API の意思決定について。
- [.NET 11 で Blazor WebAssembly と Tailwind CSS を使う方法](/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) — スタンドアロン WASM と Blazor Web App テンプレートのスタイル パイプラインの違いについて。
- [サーバーと Blazor WebAssembly でバリデーション ロジックを共有する方法](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) — Web App テンプレートが定式化する「共有プロジェクト」パターンの実践について。
- [.NET 11 における Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) — Server と WASM の双方に影響するコンパイル モードのトレードオフについて。
- [.NET 11 Preview 3 における Blazor `Virtualize` の可変高対応](/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) — Auto モードのコンポーネント リストが恩恵を受ける新 API の 1 つ。

## 出典

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, 2026-05-26 アクセス。
- [What's new in ASP.NET Core in .NET 8](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-8.0) — 統一テンプレート (プレビュー時には「Blazor United」と呼ばれていた) の初出荷について。
- [What's new in ASP.NET Core for .NET 11](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-11.0) — 描画モードごとの改善について。
- [ASP.NET Core Blazor WebAssembly with multithreading](https://learn.microsoft.com/aspnet/core/blazor/performance#webassembly-multithreading) — `WasmEnableThreads` フラグについて。
- [`dotnet/aspnetcore` discussion 51020](https://github.com/dotnet/aspnetcore/discussions/51020) — Microsoft のエンジニアが GA テンプレート名で「United」が「Web App」になった理由を説明したスレッド。
