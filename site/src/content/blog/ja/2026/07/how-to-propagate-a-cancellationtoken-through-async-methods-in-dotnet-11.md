---
title: ".NET 11 で CancellationToken を非同期メソッドに伝播させる方法"
description: ".NET 11 の非同期呼び出しチェーンのすべての層に CancellationToken をきれいに通す方法: 最後のパラメーターの慣習、既定値、リンクされたトークン、ASP.NET Core の RequestAborted、そして渡し忘れを検出する CA2016 アナライザー。"
pubDate: 2026-07-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "ja"
translationOf: "2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-01
---

.NET のキャンセルは、トークンがブロッキングを行うコードに到達した場合にのみ機能します。リクエストの先頭で作成したものの、`HttpClient.GetAsync`、`DbContext.SaveChangesAsync`、あるいは `Stream.ReadAsync` の呼び出しに一度も渡さない `CancellationToken` はただの重荷です。外側の操作は最後まで実行され続けます。なぜなら、下流の誰もそれを聞いていないからです。トークンを伝播させるとは、キャンセルが要求される場所と作業が実際に発生する場所の間にあるすべての非同期メソッドに、その 1 つのパラメーターを通すことを意味します。この投稿では、.NET 11 (`Microsoft.NET.Sdk` 11.0.0、C# 14) における機械的なルールを扱います。パラメーターをどこに置くか、その既定値は何であるべきか、トークンをどう組み合わせるか、ASP.NET Core がどのように無料でトークンを渡してくれるか、そして `CA2016` アナライザーがどのように渡し忘れた呼び出しを見つけるかです。すべてのサンプルは .NET 11 に対してコンパイルされます。

## 移動しないトークンが無用である理由

.NET のキャンセルは協調的です。`Task.Kill()` は存在せず、ランタイムが独自にスレッドを中断することは決してありません。`CancellationToken` は、所有元の `CancellationTokenSource` に対して誰かが `Cancel()` を呼び出したときに「要求されていない」から「要求された」へ切り替わる、単なるシグナルです。コードがこの切り替えに反応するのは、`token.IsCancellationRequested` をチェックするか、`token.ThrowIfCancellationRequested()` を呼び出すか、あるいはこれらのチェックを内部で行うフレームワークの API にトークンを渡す場合のみです。トークンがブロッキング呼び出しに決して到達しなければ、ブロッキング呼び出しは自分が停止すべきだと知る術がありません。

これが伝播が重要である理由のすべてです。次のチェーンを考えてみましょう。

```csharp
// .NET 11, C# 14 -- broken: the token stops at the top
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync();          // no token -- runs to completion
    var enriched = await EnrichAsync(rows);    // no token -- runs to completion
    return Assemble(enriched);
}
```

一日中 `Cancel()` を呼び出すことができます。`LoadRowsAsync` と `EnrichAsync` はシグナルを決して見ないため、`BuildReportAsync` は呼び出し側の `catch (OperationCanceledException)` が発火する機会を得る前に、すべての作業を終えてしまいます。解決策は巧妙なコードではなく、規律です。トークンはパス上のすべてのメソッドのパラメーターでなければならず、すべての呼び出しがそれを渡さなければなりません。

```csharp
// .NET 11, C# 14 -- correct: the token reaches the leaves
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync(ct);
    var enriched = await EnrichAsync(rows, ct);
    return Assemble(enriched);
}
```

## エンドツーエンドの伝播手順

これは、エントリーポイントから I/O 呼び出しまでトークンを通すための一連の手順です。各ステップは機械的に適用するルールです。

1. **トークンを最後のパラメーターとして受け取る。** チェーン内のすべての非同期メソッドに `CancellationToken` パラメーターを与え、それを最後に置いて、コード全体で一貫して読め、フレームワーク自身のシグネチャと一致するようにします。
2. **一貫して名前を付ける。** 公開ライブラリ API では `cancellationToken` を (これは BCL の慣習です)、内部のアプリケーションコードでは `ct` を使います。1 つを選んでそれを貫き、渡しが grep で見つけられるようにします。
3. **トークンを受け取るすべての await 呼び出しに渡す。** 呼び出すメソッドに `CancellationToken` のオーバーロードまたはパラメーターがあれば、そこにトークンを渡します。「念のため」に `CancellationToken.None` を渡してはいけません。それはその呼び出しをキャンセルから静かにオプトアウトさせます。
4. **真のエントリーポイントでのみ既定値を与える。** ライブラリ向けのメソッドは `CancellationToken cancellationToken = default` を使い、気にしない呼び出し側が省略できるようにします。常にトークンを持つ内部メソッドには既定値を与えるべきではなく、引数の欠落がコンパイル時のリマインダーになるようにします。
5. **独自の期限を追加するときはトークンを組み合わせる。** メソッドが呼び出し側のトークンに加えて独自のタイムアウトを必要とする場合は、一方を選んでもう一方を捨てるのではなく、`CancellationTokenSource.CreateLinkedTokenSource` でそれらをリンクします。
6. **`CA2016` を有効にする。** ステップ 3 から 5 で見逃した呼び出しをアナライザーに指摘させます。

この投稿の残りでは、このリストのうち実際に微妙な点がある部分を掘り下げます。

## パラメーターをどこに置き、どう名付けるか

BCL 全体の慣習はこうです。`CancellationToken` は**最後の**パラメーターであり、`cancellationToken` という名前です。任意の最新の非同期 API を見れば、その形が分かります。

```csharp
// From the BCL, for reference
Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken);
Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
Task<HttpResponseMessage> GetAsync(string requestUri, CancellationToken cancellationToken);
```

自分のコードでこれを踏襲してください。これが単なる見た目の問題ではない理由が 2 つあります。

- **`CA2016` アナライザーは最後のパラメーターの位置を手がかりにします。** それは `CancellationToken` を最後のパラメーターとして受け取るメソッドを見て、内部の呼び出しがそれを渡しているかをチェックします。トークンを途中に置くと、あなたの間違いを捕らえるはずのツールを弱めることになります。
- **オプションのパラメーターはいずれにせよ最後に来なければなりません。** トークンに既定値を与える (`= default`) と、C# はそれをすべての非オプションパラメーターの後に置くことを強制するため、最後のパラメーターのルールは言語のルールから無料で導かれます。

名前については、分け方はこうです。公開されているものやライブラリ形式のものすべてには `cancellationToken` を (BCL との一貫性が勝ちます)。`ct` は許容され、長い呼び出しチェーンの可読性に簡潔さが役立つアプリケーション内部のコードでは一般的です。重要なのは 1 つの名前であることで、メソッドをざっと読む読者が、トークンが渡されているのか捨てられているのかを瞬時に見て取れるようにすることです。

## `default`、`CancellationToken.None`、そしてそもそも既定値を与えるべきかどうか

`default(CancellationToken)` と `CancellationToken.None` は同じ値です。決してキャンセルできないトークンです。`IsCancellationRequested` は常に `false` で、`CanBeCanceled` は `false` です。両者は意図のシグナリングだけが異なり、言語はオプションパラメーターの慣用的な形式として `= default` を提供します。

```csharp
// .NET 11, C# 14
public async Task<User> GetUserAsync(int id, CancellationToken cancellationToken = default)
{
    return await _db.Users.FindAsync([id], cancellationToken)
        ?? throw new KeyNotFoundException();
}
```

人がつまずく判断は、**そもそもパラメーターに既定値を与えるかどうか**です。あなたを誠実に保つルールはこうです。

- **公開 / ライブラリのメソッド: 既定値を与える。** 本当にトークンを持たない呼び出し側 (トップレベルのコンソール `Main`、ファイアアンドフォーゲットのパス) はそれを省略でき、メソッドは依然としてコンパイルされます。これが、BCL のすべての非同期メソッドがトークンに既定値を与える理由です。
- **常にトークンの下で実行される内部メソッド: 既定値を与えない。** `BuildReportAsync` がトークンを持つリクエストハンドラーからのみ呼び出されるなら、パラメーターを既定値なしにしておくことで、誰かがトークンを渡さずにそれを呼び出した瞬間にコンパイラーが文句を言うようになります。そのコンパイルエラーは機能です。そこで既定値を与えると、捨てられたトークンが静かな `CancellationToken.None` として通り抜けてしまいます。

避けるべきアンチパターンは、すでにスコープ内に本物のトークンを持つメソッドの中で `CancellationToken.None` に手を伸ばすことです。それは「安全」ではなく、慎重さを装ったキャンセルのリークです。

```csharp
// .NET 11, C# 14 -- wrong: leaks cancellation on purpose
public async Task ProcessAsync(CancellationToken ct)
{
    // ct is right there, and we throw it away
    await _client.PostAsync(url, content, CancellationToken.None);
}
```

`CancellationToken.None` の唯一の正当な用途は、外側の操作がキャンセルされても意図的に最後まで実行したい呼び出しです。たとえば、最終的な監査レコードの書き込みやリソースの解放です。その意図をコメントで明確にしてください。さもないとレビュアーはそれをバグとして読むからです。

## 呼び出し側のトークンを独自のタイムアウトと組み合わせる

よくある実際の状況です。メソッドが呼び出し側の `CancellationToken` を受け取りますが、独自のタイムアウトも必要とします (「この下流の呼び出しは 5 秒後にあきらめる」)。一方を選んでもう一方を無視してはいけません。**どちらか**のソースからのキャンセルが作業を停止するように、それらをリンクします。`CancellationTokenSource.CreateLinkedTokenSource` は、いずれかの親トークンがトリガーされたときにそのトークンがトリガーされるソースを生成します。

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithTimeoutAsync(
    string url,
    CancellationToken cancellationToken)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
        cancellationToken, timeoutCts.Token);

    try
    {
        return await _client.GetStringAsync(url, linkedCts.Token);
    }
    catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested
                                             && !cancellationToken.IsCancellationRequested)
    {
        // Distinguish "we timed out" from "the caller cancelled us"
        throw new TimeoutException($"GET {url} exceeded 5s");
    }
}
```

これを正しくする詳細が 2 つあります。

- **リンクされたソースを破棄する。** `CreateLinkedTokenSource` は親にコールバックを登録します。それを破棄しないと、最も長生きする親トークンの生存期間の間、それらの登録がリークします。`using` がそれを処理します。
- **`when` フィルターが 2 つのキャンセル原因を分離する。** トークンがトリガーされると、いずれにせよ `OperationCanceledException` が得られます。`timeoutCts.IsCancellationRequested` を `cancellationToken.IsCancellationRequested` と照らし合わせてチェックすることで、どのソースが発火したかが分かります。そのため、呼び出し側が開始したキャンセルはそのまま伝播し、タイムアウトは `TimeoutException` として表面化します。これは[デッドロックせずに長時間実行される Task をキャンセルする](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)ときに必要となるのと同じ規律です。

タイムアウトだけが必要で入ってくるトークンがない場合は、単一のソースに対する `CancelAfter` の方がリンクよりも単純です。呼び出し側のトークンとローカルの期限の両方が勝たなければならないときに、具体的にリンクに手を伸ばしてください。

## ASP.NET Core はトークンを渡してくれる: それを使う

Web アプリでは、チェーンの先頭のトークンを自分で作成することはめったにありません。ASP.NET Core は `HttpContext.RequestAborted` を公開しており、これはクライアントが切断するかサーバーがリクエストを中断したときにトリガーされる `CancellationToken` です。ミニマル API と MVC コントローラーの両方がそれを自動的にバインドします。`CancellationToken` パラメーターを宣言すれば、フレームワークがそれを `RequestAborted` から埋めます。

```csharp
// .NET 11, C# 14 -- minimal API
app.MapGet("/reports/{id}", async (
    int id,
    ReportService reports,
    CancellationToken cancellationToken) =>
{
    var report = await reports.BuildAsync(id, cancellationToken);
    return Results.Ok(report);
});
```

```csharp
// .NET 11, C# 14 -- MVC controller
[HttpGet("reports/{id}")]
public async Task<IActionResult> Get(int id, CancellationToken cancellationToken)
{
    var report = await _reports.BuildAsync(id, cancellationToken);
    return Ok(report);
}
```

この注入されたトークンは、伝播チェーン全体のエントリーポイントです。それを `BuildAsync` に渡し、`BuildAsync` はそれを EF Core のクエリと `HttpClient` の呼び出しに渡します。すると、ブラウザーのタブを閉じるクライアントは、誰も読まないクエリの代金を払う代わりに、下流のすべての作業を停止するようになります。期待される動作はこうです。`RequestAborted` がリクエストの途中で発火すると、あなたの await は `OperationCanceledException` (またはそのサブクラスの `TaskCanceledException`) をスローし、フレームワークはそれを 500 ではなくキャンセルされたリクエストとして扱います。この例外が `HttpClient` のログに見えたら、それはまさにこれが意図どおりに機能していることが多いです。タイムアウトとキャンセルの区別については[なぜ HttpClient から TaskCanceledException が表面化するのか](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)を参照してください。

バックグラウンド作業に特有の注意点が 1 つあります。`RequestAborted` はリクエストにスコープされています。リクエストハンドラーがレスポンスより長生きすべき作業を開始する場合、それに `RequestAborted` を与えてはいけません。レスポンスが完了した瞬間にキャンセルされてしまいます。その作業は独自の生存期間を持つホステッドサービスに属します。これは[BackgroundService で安全にファイアアンドフォーゲット作業を実行する](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)背後にあるパターンです。

## ストリーミングと `IAsyncEnumerable<T>` を通じた伝播

非同期ストリームは、トークンをイテレーターを通じて配線する必要があり、そのメカニズムはわずかに異なります。なぜなら、列挙時にトークンを供給するのはプロデューサーではなくコンシューマーだからです。プロデューサーはパラメーターに `[EnumeratorCancellation]` を付けます。

```csharp
// .NET 11, C# 14
public async IAsyncEnumerable<Row> ReadRowsAsync(
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    await using var reader = await _source.OpenAsync(cancellationToken);
    while (await reader.ReadAsync(cancellationToken))
    {
        yield return reader.Current;
    }
}
```

コンシューマーは `WithCancellation` でトークンを付加し、コンパイラーはそれを `[EnumeratorCancellation]` パラメーターにルーティングします。

```csharp
// .NET 11, C# 14
await foreach (var row in ReadRowsAsync().WithCancellation(cancellationToken))
{
    Process(row);
}
```

`[EnumeratorCancellation]` がないと、`WithCancellation` からのトークンは静かに無視され、列挙をキャンセルできません。これは `CA2016` アナライザーが必ずしも捕らえない微妙な伝播の断絶です。非同期ストリームに不慣れなら、[いつ IAsyncEnumerable に手を伸ばすか](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)の概説がより広い全体像を扱っています。

## 捨ててしまうものを `CA2016` に捕らえさせる

深い呼び出しチェーンを通してトークンを手動で通すのは、まさに呼び出しを 1 つ飛ばしてしまうタイプの作業です。`CA2016` アナライザー (「CancellationToken パラメーターを、それを受け取るメソッドに渡す」) はこのために作られています。それは `CancellationToken` を最後のパラメーターとして持つメソッドを検査し、内部でトークンを受け取れる (直接またはオーバーロード経由で) にもかかわらず受け取っていない呼び出しを指摘します。捨てられたトークンが出荷されるのではなく CI で失敗するように、それをビルドエラーに変えましょう。

```xml
<!-- .editorconfig -- .NET 11 -->
[*.cs]
dotnet_diagnostic.CA2016.severity = error
```

`CA2016` は .NET SDK アナライザーに付属しており、これは .NET 11 をターゲットとするプロジェクトでは既定で有効なので、重大度を引き上げるだけで済みます。コード修正が付属しているので、Visual Studio または `dotnet format analyzers` で、ファイル全体にわたってトークンを自動的に渡すことができます。それがやらないのは、囲んでいるメソッドがトークンを持たない場所でトークンを発明することです。これが、内部メソッドでパラメーターを非オプションにして、コンパイラーに追加を強制させるケースです。

`CA2016` の盲点についての注意です。それは最後のパラメーターの慣習と、一致するオーバーロードの存在を手がかりにします。トークンを最後以外の位置で受け取る呼び出しは指摘せず、`[EnumeratorCancellation]` のルーティングについては推論しません。それを一般的なケースのための強力なネットとして扱い、すべてのパスがカバーされているという証明としては扱わないでください。

## トークンが機能するのを妨げる伝播の間違い

トークンが技術的には存在していても、いくつかのパターンは伝播を壊します。

- **呼び出しごとの新しいソース。** メソッド内で `new CancellationTokenSource()` を作成して*その*トークンを渡すと、呼び出し側のトークンが完全に無視されます。置き換えるのではなくリンクしてください。
- **`async void`。** トークンは `async void` メソッドの外に伝播できません。なぜなら、呼び出し側が await したり `OperationCanceledException` を観測したりできる `Task` が存在しないからです。キャンセルのパスは `async Task` に保ってください。その理由は[なぜ async void はほとんど常に間違っているのか](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)と大きく重なります。
- **`OperationCanceledException` を握りつぶす。** それをキャッチして既定値を返すと、キャンセルが呼び出し側から隠され、外側の `Task.WhenAll` や await が操作が停止したことを決して知りません。それを変換する具体的な理由 (上記のタイムアウトのケースなど) がない限り、バブルアップさせてください。
- **同期のリーフを忘れる。** 非同期チェーンの最下部にある密な CPU ループには、トークンを渡せる await 対象の API がありません。ループ内に明示的な `cancellationToken.ThrowIfCancellationRequested()` を追加して、トークンにチェックポイントを持たせてください。

伝播は有効にする機能ではなく、維持する性質です。新しい非同期メソッドはそれぞれ、トークンを渡すか、チェーンを静かに切断するかのもう 1 つの環です。パラメーターを追加し、すべての呼び出しでそれを渡し、忘れた呼び出しを `CA2016` に守らせ、そして何があっても本当に完了させたい稀な操作のために `CancellationToken.None` を取っておいてください。

## 出典

- [CA2016: Forward the CancellationToken parameter to methods that take one](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2016) -- Microsoft Learn
- [HttpContext.RequestAborted Property](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpcontext.requestaborted) -- Microsoft Learn
- [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) -- Microsoft Learn
- [CancellationTokenSource.CreateLinkedTokenSource](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.createlinkedtokensource) -- Microsoft Learn
- [EnumeratorCancellationAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute) -- Microsoft Learn
</content>
</invoke>
