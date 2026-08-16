---
title: "JavaScript 相互運用なしで Blazor コンポーネントからファイルをダウンロードする方法"
description: "downloadFileFromStream の JS モジュールは不要です。TypedResults.File を返す minimal API エンドポイントを指す download 属性付きのアンカーをレンダリングするか、AntiforgeryToken を含むプレーンな HTML フォームを POST します。download 属性が Blazor の拡張ナビゲーションによるクリック横取りを防ぐ理由、data-enhance がファイルを黙って捨てる理由、cookie と bearer の落とし穴も解説します。"
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "minimal-apis"
lang: "ja"
translationOf: "2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop"
translatedBy: "claude"
translationDate: 2026-08-16
---

JavaScript を一行も書かずに Blazor コンポーネントからファイルをダウンロードするには、`href` が `TypedResults.File` を返すエンドポイントを指し、`download` 属性が付いたプレーンな `<a>` 要素をレンダリングします。仕掛けはそれだけです。`download` 属性は単なるファイル名のヒントではありません。Blazor の拡張ナビゲーションにクリックを見送らせ、ブラウザーに本物のナビゲーションを実行させるための目印であり、そのナビゲーションを `Content-Disposition: attachment` ヘッダーが保存動作へと変えます。内容がユーザー入力に依存するファイルの場合は、`<AntiforgeryToken />` を含むプレーンな HTML の `<form>` を同じ種類のエンドポイントへ POST します。以下の内容はすべて .NET 11 と C# 14 を対象としており、ASP.NET Core 10.0.5 上で動作する Blazor Web App に対して端から端まで検証しました。そこでの挙動も同一です。これらの API は .NET 8 以降変わっていません。

## 公式ガイドが JS 相互運用に頼る理由と、それを無視してよい場面

[Blazor のファイルダウンロードのドキュメント](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads)は 2 つのレシピを示しますが、どちらも `.js` ファイルを追加するところから始まります。小さいファイル向けのレシピは `Stream` を `DotNetStreamReference` でラップし、`downloadFileFromStream` という JS 関数へ渡して、クライアント側で `Blob` と object URL に組み直します。大きいファイル向けのレシピは `triggerFileDownload` という JS 関数を呼び、スクリプトで `HTMLAnchorElement` を組み立てて合成 `click` イベントを発火させます。

2 つ目をもう一度読んでください。この JavaScript は、アンカー要素を作ってクリックするためだけに存在しています。あなたがいるのは、HTML 要素をレンダリングすることを仕事のすべてとする UI フレームワークの中です。アンカーは自分でレンダリングできます。

JS なしの経路はコード量が減るだけでなく、相互運用の経路が正面から踏み込むバグの一群を回避します。`IJSRuntime` はコンポーネントのプリレンダリング中は使えません。だからこそ [JavaScript 相互運用の呼び出しは現時点では発行できない](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)は Blazor で最も多い例外の 1 つになっています。静的サーバー側レンダリング (static SSR) を使うコンポーネントでも利用できません。呼び出す先の回線も WebAssembly ランタイムも存在しないからです。アンカーは static SSR を含むあらゆるレンダリングモードで動作し、ライフサイクルの制約は一切ありません。

相互運用が本当に必要な場面はちょうど 1 つあります。クライアントでバイト列を生成し、サーバーを往復せずに保存しなければならないスタンドアロンの Blazor WebAssembly アプリです。それでも `data:` URI でかなりのところまで行けますし、その限界は最後に扱います。

## download 属性が Blazor にクリックを食わせない

ここは誰も説明しない部分であり、「アンカーを使えばいい」という助言が Blazor Web App でしばしば失敗する理由でもあります。

Blazor Web App は拡張ナビゲーションを既定で有効にします。ドキュメントレベルのクリックハンドラーが内部リンクを横取りし、`fetch` で遷移先を取得して、ページ全体を読み込み直す代わりに返ってきた HTML を既存の DOM へ当て込みます。ページに対しては優れた仕組みですが、CSV に対しては致命的です。

そのインターセプターのガード条件は、配布される `blazor.web.js` の中に見えています。

```js
return (!t || "_self" === t) && e.hasAttribute("href") && !e.hasAttribute("download")
```

アンカーが横取りの対象になるのは、`href` を持ち、かつ `download` 属性を持た**ない**場合だけです。この属性はフレームワークに組み込まれた意図的な適用除外です。

属性を外すと実際に何が起きるか、稼働中のアプリに対してブラウザーで計測した結果がこちらです。`<a href="/exports/orders.csv">` をクリックするとこうなります。

```text
[warn] Enhanced navigation failed for destination http://localhost:5248/exports/orders.csv.
       Falling back to full page load.
```

アドレスバーは余計な疑問符付きの `/exports/orders.csv?` に変わる一方、DOM には前のページが表示されたままです。ネットワークログを見ると、エンドポイントは**2 回**叩かれています。1 回目は `text/csv` を解釈できなかった拡張ナビゲーションの `fetch`、2 回目はブラウザーが最終的にダウンロードマネージャーへ引き渡すフォールバックのドキュメントナビゲーションです。エクスポートのクエリは 2 回走り、ユーザーの URL は誤ったものになり、それでもファイルは届きます。動いているように見えてしまうという点で、これは最悪の組み合わせです。

`download` を付ければ、そのどれも起きません。クリックは横取りされず、URL は変わらず、リクエストは 1 本、返るファイルも 1 つです。

## JS なしのダウンロードを組み立てる手順

1. **ファイルを返すエンドポイントを書きます。** `TypedResults.File`、`TypedResults.Bytes`、`TypedResults.Stream` のいずれかを返す minimal API の `MapGet` は、`fileDownloadName` を渡せば `Content-Disposition: attachment` を自動で設定します。
2. **そこを指すアンカーを、`download` 属性を付けてレンダリングします。** エンドポイントが既に `Content-Disposition` を設定していても省略しないでください。
3. **パラメーター付きのエクスポートには、プレーンな `<form method="post">`** をエンドポイントに向けて使います。中に `<AntiforgeryToken />` を置き、`data-enhance` 属性は付けません。
4. **エンドポイントがブラウザーのナビゲーションと同じ方法で認証されるようにします。** つまり `Authorization` ヘッダーではなく cookie です。
5. **ブラウザーの保存ダイアログではなく、レスポンスヘッダーを検証します。** エンドポイントに `curl -I` を投げれば、`Content-Disposition: attachment` と想定どおりのファイル名が見えるはずです。

## エンドポイント: TypedResults の 3 つの形

もともとメモリに収まる内容なら、エンドポイントに `byte[]` を渡します。

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders.csv", () =>
{
    var csv = new StringBuilder("Id,Customer,Total\n");
    foreach (var order in OrderStore.Recent())
    {
        csv.Append(CultureInfo.InvariantCulture, $"{order.Id},{order.Customer},{order.Total}\n");
    }

    return TypedResults.File(
        Encoding.UTF8.GetBytes(csv.ToString()),
        contentType: "text/csv",
        fileDownloadName: "orders.csv");
});
```

これでブラウザーが必要とするヘッダーがそのまま出力されます。

```text
HTTP/1.1 200 OK
Content-Length: 75
Content-Type: text/csv
Content-Disposition: attachment; filename=orders.csv; filename*=UTF-8''orders.csv
```

`filename` と `filename*` が二重に出ている点に注目してください。ASP.NET Core は RFC 6266 の形式を自動で出力しており、これが非 ASCII のファイル名を無事に届けてくれます。

バッファリングがメモリのリスクになる程度に大きいものには、コールバック付きの `TypedResults.Stream` を使い、レスポンス本文へ直接書き込みます。

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders-stream.csv", (IOrderQuery query, CancellationToken ct) =>
    TypedResults.Stream(
        async stream =>
        {
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true);
            await writer.WriteLineAsync("Id,Customer,Total");

            await foreach (var order in query.StreamAsync(ct))
            {
                await writer.WriteLineAsync($"{order.Id},{order.Customer},{order.Total}");
            }
        },
        contentType: "text/csv",
        fileDownloadName: "orders-stream.csv"));
```

このレスポンスは `Transfer-Encoding: chunked` になり `Content-Length` が付かないため、ユーザーには進捗バーが出ません。その代わりサーバーはエクスポート全体を保持せずに済みます。同じトレードオフは、[ASP.NET Core のエンドポイントからバッファリングせずにファイルをストリーミングする](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)場面でも常に当てはまります。

`new UTF8Encoding(false)` は意図的です。`StreamWriter` の既定である `Encoding.UTF8` は BOM のプリアンブルが有効なので、省略形で書くとヘッダー行の前に余計な 3 バイトが書き込まれます。検証用アプリで実際に踏みました。`byte[]` のエンドポイントは `Encoding.UTF8.GetBytes` がプリアンブルを一切出さないためきれいな出力になり、ストリーミングのエンドポイントは `Id,Customer,Total` の前に BOM を付けました。Excel で開く CSV ならその BOM はむしろ欲しいものなので、偶然任せにせずフォーマットごとに選んでください。

ファイルが既にディスク上にあるなら、バッファはまるごと省けます。`TypedResults.File(File.OpenRead(path), "application/pdf", "manual.pdf", enableRangeProcessing: true)` のように書けば、範囲処理によってブラウザーが中断したダウンロードを再開できます。

## static SSR: アンカーとプレーンなフォームだけ、回線は不要

static SSR を採用し、レンダリングモードも `@onclick` も持たず、2 種類のファイルをダウンロードするコンポーネントがこちらです。

```razor
@* .NET 11, static SSR, no render mode *@
@page "/exports"

<h1>Exports</h1>

<a href="/exports/orders.csv" download>Download today's orders</a>

<a href="/exports/orders.csv" download="orders-2026-08.csv">Download with a custom name</a>

<form method="post" action="/exports/orders">
    <AntiforgeryToken />
    <label>
        Rows
        <input type="number" name="maxRows" value="500" />
    </label>
    <input type="hidden" name="format" value="csv" />
    <button type="submit">Export</button>
</form>
```

2 つ目のアンカーは、`download` 属性が拡張ナビゲーションからの離脱以外に果たす唯一の役割を示しています。その値がサーバーの提案するファイル名を上書きします。エンドポイントの `fileDownloadName` が既に適切なら空のままにしてください。

このフォームは `action` を持つプレーンな HTML の `<form>` であり、`EditForm` ではありません。`@formname` も `@onsubmit` も付いていません。これは意図的です。`EditForm` は Blazor コンポーネントへポストバックしますが、コンポーネントの仕事は HTML のレンダリングなので、ファイルを返す手段がありません。別のエンドポイントへ POST することだけが、ダウンロードで終わる唯一の経路です。

`<AntiforgeryToken />` は隠しフィールド `__RequestVerificationToken` をレンダリングします。これは必須です。`[FromForm]` パラメーターをバインドする minimal API エンドポイントは、.NET 8 以降 antiforgery 検証の対象だからです。トークンなしで POST すると、素っ気ない `400` が返ります。

```csharp
// .NET 11, C# 14
app.MapPost("/exports/orders", ([FromForm] string format, [FromForm] int maxRows) =>
{
    var bytes = ExportBuilder.Build(format, maxRows);

    return TypedResults.File(bytes, "text/csv", $"orders.{format}");
});
```

パイプラインに `app.UseAntiforgery()` があり、フォームにトークンがあれば、これはファイルをブラウザーへ直接返します。回線もなく、WebAssembly のペイロードもなく、JavaScript もありません。

.NET 11 はここに 2 層目を足します。`WebApplication.CreateBuilder` で構築したアプリでは、ヘッダーに基づく自動 CSRF 保護が既定で有効になり、安全でないメソッドに対して `Sec-Fetch-Site` と `Origin` を検査します。Blazor SSR のフォーム POST は、信頼できないクロスオリジンの POST に対して `400 Bad Request` を返します。トークン検証が走るのは引き続き `UseAntiforgery` を呼んだ場合だけで、両方が有効なときはトークンの判定が優先されます。.NET 10 で動いていたフォームがアップグレード後に 400 を返し始めたら、まずこのミドルウェアを疑ってください。その挙動は [ASP.NET Core 11 が自動 CSRF 保護を有効にした](/ja/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)ときに詳しく扱いました。

## インタラクティブなレンダリングモード: クライアントに渡すのはバイト列ではなく URL

インタラクティブなコンポーネントでは、ボタンのハンドラーで `byte[]` を作り、それをどうにかブラウザーへ押し込もうとしたくなります。発想を逆にしてください。ハンドラーはサーバー側でエクスポートを用意し、トークンの背後に置いて、アンカーをレンダリングします。

```razor
@* .NET 11, C# 14 *@
@page "/reports"
@rendermode InteractiveServer
@inject IReportService Reports

<button @onclick="Prepare" disabled="@_working">Prepare export</button>

@if (_token is not null)
{
    <a href="@($"/exports/report/{_token}")" download="report.csv">Your export is ready</a>
}

@code {
    private string? _token;
    private bool _working;

    private async Task Prepare()
    {
        _working = true;
        _token = await Reports.QueueExportAsync();
        _working = false;
    }
}
```

ユーザーは 2 回クリックすることになりますが、もともと実時間のかかるエクスポートに対しては誠実な UI ですし、バイト列が SignalR の回線を通ることは一切ありません。

どうしても 1 クリックにしたいなら、`NavigationManager.NavigateTo(url, forceLoad: true)` が使えます。これも自分で書く相互運用コードは不要です。レスポンスが `Content-Disposition: attachment` を持つため、ブラウザーはダウンロードを開始してナビゲーションを取りやめます。呼び出し後も SPA の URL がそのままであることを確認しました。呼び出し前が `/interactive`、呼び出し後も `/interactive` で、ファイルは配信されています。

```csharp
// .NET 11, C# 14
private void Download() => Nav.NavigateTo("/exports/orders-stream.csv", forceLoad: true);
```

注意点として、これはナビゲーションなので、エンドポイントがファイルではなく `404` や `500` を返すと、ブラウザーはアプリから離れてエラーページへ遷移します。アンカーでも同じように失敗しますが、少なくともクリックしたのはユーザー自身の選択です。

## サーバーのない Blazor WebAssembly: data URI という抜け道

バイト列がクライアントで生成され、指すべきエンドポイントが存在しない場合は、base64 にして `href` へ埋め込みます。

```razor
@* .NET 11, C# 14, Blazor WebAssembly *@
@rendermode InteractiveWebAssembly

<button @onclick="Build">Build report</button>

@if (_href is not null)
{
    <a href="@_href" download="client-report.csv">Save client-report.csv</a>
}

@code {
    private string? _href;

    private void Build()
    {
        var bytes = Encoding.UTF8.GetBytes(ReportBuilder.ToCsv());
        _href = $"data:text/csv;base64,{Convert.ToBase64String(bytes)}";
    }
}
```

Chrome は `data:` URI へのトップレベルナビゲーションをブロックしますが、`download` 属性を持つアンカーは明示的に除外しているため、この方法は生き残ります。WebAssembly のハイドレーション後も、レンダリングされたアンカーが `download="client-report.csv"` を保っていることを DOM で確認しました。

これが万能解にならない理由は 2 つあります。base64 はペイロードを約 3 分の 1 だけ膨らませ、しかもその全体が DOM 属性の中に置かれるため、30 MB のエクスポートはレンダーツリー内の 40 MB の文字列になります。さらに上限についてブラウザーの見解が割れています。Chrome と Edge は一部の `data:` コンテキストで 2 MB の上限を課す一方、Firefox と Safari は明文化された上限を持ちません。おおよそ 1 メガバイト未満なら問題ありません。それを超えるならサーバーのエンドポイントを追加するか、`Blob` と `URL.createObjectURL` が必要になること、つまり相互運用が必要になることを受け入れてください。

## 実際に刺さる落とし穴

**フォームの `data-enhance` はファイルを黙って捨てます。** 拡張フォーム処理は `fetch` で POST し、Blazor エンドポイント以外との通信を拒否します。上のエクスポートフォームに `data-enhance` を付けると、コンソールにこう出ました。

```text
Enhanced navigation does not support making a non-GET request to a non-Blazor endpoint.
Avoid enabling enhanced navigation for forms that post to a non-Blazor endpoint.
```

ネットワークタブでは `POST` が完全な CSV 本文とともに `200` を返していました。サーバーはエクスポートを組み立てて送出し、クライアントはそれを捨てたのです。ダウンロードは何も起きませんでした。`Enhance` を付けた `EditForm` も同じように失敗します。

**bearer トークンはナビゲーションを越えられません。** アンカーのクリックとフォームの POST はブラウザーが開始するリクエストです。`Authorization` ヘッダーは付きません。それを付けるあなたのコードが走っていないからです。API がメモリ上の JWT で認証しているなら、マークアップがどれだけ正しくてもダウンロードのエンドポイントは `401` を返します。そのエンドポイントだけ cookie 認証にするか、短命な使い捨てトークンを発行してインタラクティブの例のようにパスへ載せるかのどちらかです。選ぶ前に [JWT 認証と cookie 認証のトレードオフ](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)に目を通す価値があります。これは回避策ではなく、本物のアーキテクチャ上の分岐だからです。

**`download` 属性はクロスオリジンでは無視されます。** Chrome 65 以降、クロスオリジンの URL ではファイル名のヒントが黙って破棄され、Firefox は属性ごと無視して代わりに遷移します。ファイルが CDN や別の API ホストにあるなら、この属性はもはや要にはならず、オリジンのサーバーが設定する `Content-Disposition: attachment` だけが保存を引き起こします。そちら側で設定してください。

**静的アセットにも属性は必要です。** `<a href="/docs/manual.pdf" download>` は `wwwroot` 内のファイルに対して機能しますが、`download` がなければ拡張ナビゲーションの横取りはそれらにも及びます。しかも PDF は、拡張ナビゲーションが DOM への当て込みの途中で諦める典型的なレスポンスです。

**コンポーネントからレスポンスを書こうとしないでください。** static SSR のコンポーネントでカスケードされた `HttpContext` を取り、`Response.Body` にバイト列を書き込むのはレンダラーとの喧嘩であり、[ヘッダーは読み取り専用です、レスポンスは既に開始しています](/ja/2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore/)に行き着きます。コンポーネントはマークアップをレンダリングし、エンドポイントはファイルを返す。この分担を守ってください。

ここから導かれる原則は、覚えられる程度に短いものです。ブラウザーはファイルのダウンロード方法を既に知っており、Blazor はアンカーのレンダリング方法を既に知っています。両者の間に立ちはだかっているのは、フレームワークが明示的にチェックしている属性 1 つだけです。

## 参考資料

- Microsoft Learn の [ASP.NET Core Blazor file downloads](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads)。この記事が置き換える、相互運用ベースのレシピについて
- [ASP.NET Core Blazor forms overview](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/)。`AntiforgeryToken` コンポーネント、拡張フォーム処理、.NET 11 の自動 CSRF ミドルウェアについて
- [Breaking change: IFormFile parameters require anti-forgery checks](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/8/antiforgery-checks)。`[FromForm]` バインドにトークンが必要な理由
- [Deprecations and removals in Chrome 65](https://developer.chrome.com/blog/chrome-65-deprecations)。`download` 属性のクロスオリジン制限について
- 挙動は ASP.NET Core 10.0.5 上の `dotnet new blazor -int Auto` アプリで確認し、`blazor.web.js`、レスポンスヘッダー、ブラウザーコンソールを調べました
