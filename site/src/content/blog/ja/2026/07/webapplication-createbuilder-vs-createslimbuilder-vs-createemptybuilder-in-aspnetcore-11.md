---
title: "ASP.NET Core 11 における WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder"
description: "通常のアプリには CreateBuilder を、TLS プロキシの背後でトリミングまたは Native AOT を使って発行する場合は CreateSlimBuilder を、すべてのサービスを自分で登録したい場合にのみ CreateEmptyBuilder を使いましょう。ここでは機能マトリクスと、選択を左右する落とし穴を紹介します。"
pubDate: 2026-07-23
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "native-aot"
  - "csharp"
lang: "ja"
translationOf: "2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

通常の ASP.NET Core 11 Web アプリには `WebApplication.CreateBuilder(args)` を使いましょう。これがデフォルトなのには理由があります。期待されるすべてのホスティング機能を組み込んでくれるからです。`WebApplication.CreateSlimBuilder(args)` に切り替えるのは、トリミングまたは Native AOT で発行し、かつ TLS を終端するプロキシの背後で実行する場合のみにしましょう。これはバイナリを小さくするために HTTPS、HTTP/3、IIS 統合、静的 Web アセット、そして 2 つのログプロバイダーを削除するからです。`WebApplication.CreateEmptyBuilder(...)` に手を伸ばすのは、ほぼゼロのベースラインを求め、サーバー、ルーティング、構成を自分で登録するというまれなケースのみにしましょう。この記事は `Microsoft.NET.Sdk.Web` と C# 14 を用いた .NET 11（執筆時点では Preview 6、GA は 2026 年 11 月）を対象としていますが、これら 3 つのファクトリメソッドはいずれも .NET 8 から存在するため、この指針は .NET 8 から 11 まで変わらず当てはまります。

## ここでいう「デフォルト」が実際に意味するもの

3 つのメソッドの違いは、ただ 1 点だけです。あなたのコードが実行される前に、`WebApplicationBuilder` にどれだけのものを登録するか、という点です。それ以外はすべて、`builder.Services` コレクション、`builder.Build()`、`app.MapGet(...)` は同一です。ですから、意思決定のすべては、どのデフォルトを渡してもらいたいか、そしてどれを自分の手で追加し直しても構わないか、に帰着します。

`CreateBuilder` は完全なデフォルトホストを提供します。`CreateSlimBuilder` は、トリムセーフで小さくなるように厳選されたサブセットを提供します。`CreateEmptyBuilder` はほとんど何も提供せず、各要素を自分でオプトインすることを期待します。内部的には、これらは仕組みさえ共有しています。`CreateSlimBuilder` は、`CreateEmptyBuilder` が公開するのと同じ空のホストアプリケーションビルダーの上に構築され、その上にスリムなサービスセットを再度追加しています。だからこそ、以下の順序は厳密なスーパーセットの連鎖になっています。`CreateBuilder` は `CreateSlimBuilder` が行うすべてを含み、それは `CreateEmptyBuilder` が行うすべてを含みます。

## 機能マトリクス

各行は ASP.NET Core 11 のドキュメントと `WebApplication.cs` のソースに照らして検証済みです。「手動」は、その機能があなたのために登録されるわけではないが、示されている呼び出しで追加できることを意味します。

| 機能                                        | CreateBuilder | CreateSlimBuilder             | CreateEmptyBuilder            |
| ------------------------------------------ | ------------- | ----------------------------- | ----------------------------- |
| appsettings.json + appsettings.{env}.json  | あり          | あり                          | 手動                          |
| ユーザーシークレット（Development）        | あり          | あり                          | 手動                          |
| 環境変数 + コマンドライン構成               | あり          | あり                          | 手動                          |
| コンソールログ出力                          | あり          | あり                          | 手動（`AddConsole`）          |
| Debug / EventSource / EventLog ログ出力     | あり          | なし                          | なし                          |
| Kestrel サーバー                            | フル          | コア（`UseKestrelCore`）      | 手動（`UseKestrelCore`）      |
| Kestrel の HTTPS エンドポイント             | あり          | なし（`UseKestrelHttpsConfiguration`） | 手動               |
| HTTP/3（QUIC）                             | あり          | なし（`UseQuic`）             | 手動                          |
| IIS 統合                                    | あり          | なし                          | なし                          |
| 静的 Web アセット                           | あり          | なし                          | なし                          |
| ホスティングスタートアップアセンブリ / `UseStartup` | あり    | なし                          | なし                          |
| 正規表現および alpha ルーティング制約       | あり          | なし                          | なし                          |
| ルーティング / `MapGet` など                | あり          | あり                          | 手動                          |

この表から得られる最も重要なポイント：`CreateSlimBuilder` は依然として構成ソースとコンソールログ出力を保持します。これは、あなたが毎日使うものを取り除いているわけではありません。クラウドネイティブでプロキシを前面に置くデプロイでは通常必要とされないプロトコルおよびプラットフォーム機能、それに本番でめったに読まない 3 つのログプロバイダーを削除しているのです。

## CreateBuilder を選ぶべきとき

これがデフォルトであり、ほとんどのアプリではデフォルトのままにしておくべきです。

- **IIS または IIS Express にデプロイする、あるいは Windows 上で実行し Windows EventLog を読む場合。** どちらも `CreateBuilder` だけが組み込みます。`CreateSlimBuilder` には IIS 統合がないため、インプロセスの IIS デプロイは単純に正しくホストできません。
- **Razor クラスライブラリから静的 Web アセットを配信する、あるいは `UseStaticWebAssets` を使う場合。** Blazor や MVC の UI アプリはこれに依存します。スリムビルダーはこれを登録せず、その失敗の現れ方は、明白なエラーもなく CSS/JS が欠落するというものです。
- **`{id:regex(...)}` または `{name:alpha}` のルート制約を使う場合。** これらは、おおよそ 1 メガバイトのバイナリを節約するためにスリムビルダーから省かれています。`{id:int}` やその他のプリミティブ制約は問題ありません。消えるのは regex と alpha の 2 つです。
- **トリミングも AOT もまったく発行しない場合。** 通常のフレームワーク依存または自己完結型の JIT ビルドを出荷するなら、スリムビルダーは実行時にほとんど何も得をもたらしません。バイナリサイズと起動の勝利は、トリミングと AOT から来るものであって、ビルダーの選択それ自体から来るものではありません。ここでスリムを選ぶことは、見返りもなく HTTPS などを追加し直すことを意味するだけです。

## CreateSlimBuilder を選ぶべきとき

`CreateSlimBuilder` は、Native AOT Web API テンプレート（`dotnet new webapiaot`）のデフォルトとなることを特に目的として .NET 8 で導入されました。以下があなたのデプロイに当てはまる場合に選びましょう。

- **`<PublishAot>true</PublishAot>` または積極的なトリミング（`<PublishTrimmed>true</PublishTrimmed>`）で発行する場合。** スリムビルダーは、トリムに適さないコードパスをグラフに引き込むことを避け、警告を抑えて出力を小さく保ちます。このビルダーが設計対象としているフル AOT のセットアップについては、[ASP.NET Core minimal API で Native AOT を使う方法](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) を参照してください。
- **TLS を終端するプロキシまたはイングレス（Nginx、Caddy、YARP、Azure Application Gateway）の背後で実行する場合。** プロキシが HTTPS を処理するため、プレーンな HTTP をリッスンするあなたのプロセスはまさに正しい構成です。これは、スリムビルダーが Kestrel の HTTPS 構成を削除することで作り込んでいる前提です。
- **minimal API のマイクロサービスに対して、妥当な範囲で最小のコンテナイメージを求める場合。** トリミングと AOT を組み合わせることで、スリムビルダーは攻撃対象領域の小さな、単一の小さなネイティブ実行ファイルを生み出します。

スリムを選んだ後で HTTPS や HTTP/3 が必要だと分かっても、ビルダーを切り替える必要はありません。明示的に追加し直しましょう：

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateSlimBuilder(args);

// Re-enable HTTPS endpoints that CreateSlimBuilder omits by default.
builder.WebHost.UseKestrelHttpsConfiguration();

// Re-enable HTTP/3 (QUIC) if a client actually needs it.
builder.WebHost.UseQuic();

var app = builder.Build();
app.MapGet("/", () => "Hello from a slim host");
app.Run();
```

## CreateEmptyBuilder を選ぶべきとき

`CreateEmptyBuilder(WebApplicationOptions)` は、組み込みの振る舞いをまったく持たないビルダーを作成します。それが構築するアプリには、あなたが明示的に構成したサービスとミドルウェアだけが含まれます。これは専門的なツールであって、一般的なデフォルトではありません。可能な限り最小のサービスを構築していて、すべての登録を制御したいとき、あるいは ASP.NET Core がリクエストを処理するのに実際どれだけ少なくて済むかを実験しているときに手を伸ばしましょう。

以下は .NET 8 のリリースノートにある標準的な最小の例で、.NET 11 でも変わらずコンパイルできます：

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());

// Nothing is registered by default, so add the server yourself.
builder.WebHost.UseKestrelCore();

var app = builder.Build();

app.Use(async (context, next) =>
{
    await context.Response.WriteAsync("Hello, World!");
    await next(context);
});

Console.WriteLine("Running...");
app.Run();
```

必要になったときに手作業で追加しなければならない、欠けているものに注目してください：`appsettings.json` の読み込みはなく、コンソールログ出力はなく、ルーティングもなく（そのため `MapGet` はなく、代わりに生のミドルウェアを書きます）、構成のバインドもありません。それぞれを明示的な呼び出しで追加します：`builder.Configuration.AddJsonFile("appsettings.json")`、`builder.Logging.AddConsole()`、`builder.Services.AddRouting()` などです。それこそが空のビルダーの目的そのものです。使うものに対してだけ対価を払うのです。

## サイズの話、そしてそれがトリミングの話である理由

3 つすべてが存在する理由は、Native AOT のためのバイナリサイズと起動であって、生のリクエストスループットではありません。JIT コンパイルされたアプリでは、3 つのビルダーは異なるサービスグラフを登録しますが、いったんアプリがウォームになってしまえば、1 秒あたりのリクエスト数の差に価値があるわけではありません。価値が現れるのは、トリミングして AOT コンパイルするときです。

Native AOT Web API テンプレートに関する Microsoft 自身のベンチマークは、Native AOT 発行を、トリミングされたランタイムビルドおよびトリミングされていないランタイムビルドと比較し、AOT アプリが 3 つの中でアプリサイズ、メモリ使用量、起動時間が最も低いと報告しています。.NET 8 のリリースノートは、スペクトラムの空の端についての具体的な基準を示しています：上記の `CreateEmptyBuilder` の「Hello, World」サンプルを linux-x64 マシンで Native AOT を用いて発行すると、約 8.5 MB の自己完結型ネイティブ実行ファイルが生成されました。この数値は、AOT とトリミングが仕事を終えたときにほぼゼロのベースラインがどう見えるか、を示すものです。

発行されるフットプリントの実際の順序は、大きいものから小さいものへ、`CreateBuilder`、次に `CreateSlimBuilder`、次に `CreateEmptyBuilder` です。しかしそれらの差が開くのは、`PublishAot` または `PublishTrimmed` の下でのみです。プレーンなビルドを出荷すれば、スリムまたは空のビルダーの手間を払いながら、その報酬を回収しないことになります。これが最もよくある間違いです：「スリムのほうが速そう」という理由で、通常のデプロイにスリムビルダーを選んでしまうことです。それは実行時に速いのではなく、トリミングしたときに小さいのです。トリミングをしていないなら、スリムの道にコミットする前に [Native AOT が実際にあなたに何を強いるか](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) を読む価値があり、[Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) は各発行モードがどこで勝つかを扱っています。

## あなたの代わりに選んでくれる落とし穴

これを決めるのが好みであることはめったにありません。たいてい以下のいずれかが決めます。

- **IIS のインプロセスホスティングは `CreateBuilder` を強制します。** IIS 統合がないということは、インプロセスモジュールがないということです。ホストが IIS なら、決定は下されています。
- **静的 Web アセットは `CreateBuilder` を強制します。** `UseStaticWebAssets` を失う Blazor または Razor の UI アプリは、起動時に例外もなく壊れたスタイリングを出荷します。これは静かに噛みついてくるので、特別な理由がない限り、UI アプリはすべて `CreateBuilder` のアプリとして扱いましょう。
- **正規表現または alpha のルート制約は `CreateBuilder` を強制します。** ルーティングテーブルに `{code:regex(^[A-Z]{3}$)}` や `{slug:alpha}` があると、スリムビルダーはそれらの制約を解決しません。`:int`、`:guid`、`:datetime` のようなプリミティブ制約は影響を受けません。
- **AOT に TLS プロキシが加わると `CreateSlimBuilder` を強制します。** プロキシを前面に置くマイクロサービスのために AOT を発行しているなら、スリムが意図されたデフォルトであり、`CreateBuilder` から始めてそれに抗うと、トリムに適さないコードがグラフに引き戻されます。
- **MVC コントローラーは AOT を完全に排除し、それが問い全体を変えます。** MVC は Native AOT 互換ではないため、コントローラーが必要ならどのみちフル AOT にはできず、スリムビルダーの主な利点は消え去ります。まだその選択を天秤にかけているなら、[ASP.NET Core 11 における minimal API vs コントローラー](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) を参照してください。

## 結論、もう一度

デフォルトは `CreateBuilder` にしましょう。これは、IIS、静的 Web アセット、MVC、Blazor、正規表現のルート制約を使うすべてのアプリを含め、圧倒的多数の ASP.NET Core 11 アプリにとって正しい選択です。`CreateSlimBuilder` に移るのは、トリミングまたは Native AOT で発行し、かつ TLS を終端するプロキシの背後に位置するときだけです。これはまさに `webapiaot` テンプレートが対象とするシナリオです。HTTPS や HTTP/3 が必要なら、`UseKestrelHttpsConfiguration()` または `UseQuic()` の呼び出し 1 つで追加し直しましょう。`CreateEmptyBuilder` は、最後の 1 つまで自分で登録し、その下限を計測したい、本当に最小のサービスのために懐に忍ばせておきましょう。やってはいけない唯一のことは、速いという理屈で、通常の JIT デプロイにスリムまたは空のビルダーを選ぶことです。それはトリミングしたときに小さいのであって、実行時に速いのではなく、通常のビルドでは摩擦だけを得て見返りは得られません。そもそも古いホストをこのモデルに移行しようとしているなら、どのファクトリメソッドを呼ぶかを最適化する前に越えるべき関門が [IWebHostBuilder から WebApplication.CreateBuilder への移行](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/) です。

## Related

- [ASP.NET Core minimal API で Native AOT を使う方法](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [.NET 11 で IWebHostBuilder から WebApplication.CreateBuilder へ移行する](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/)
- [.NET 11 における Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Native AOT とは何か、そしてそれはあなたに何を強いるのか？](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [ASP.NET Core 11 における minimal API vs コントローラー](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Sources

- [WebApplication.CreateSlimBuilder Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.webapplication.createslimbuilder)
- [ASP.NET Core support for Native AOT: Compare CreateSlimBuilder and CreateBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot)
- [What's new in ASP.NET Core in .NET 8: New CreateEmptyBuilder method (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-8.0#new-createemptybuilder-method)
- [Andrew Lock: Comparing WebApplication.CreateBuilder to the new CreateSlimBuilder method](https://andrewlock.net/exploring-the-dotnet-8-preview-comparing-createbuilder-to-the-new-createslimbuilder-method/)
