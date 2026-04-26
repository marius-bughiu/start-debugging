---
title: "HttpClient を使用するコードのユニットテストを書く方法"
description: ".NET 11 における HttpClient のテスト完全ガイド: HttpClient を直接モックすべきでない理由、スタブ HttpMessageHandler の書き方、IHttpClientFactory での primary handler の差し替え、Polly のリトライ検証、WireMock.Net という選択肢。"
pubDate: 2026-04-26
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "httpclient"
lang: "ja"
translationOf: "2026/04/how-to-unit-test-code-that-uses-httpclient"
translatedBy: "claude"
translationDate: 2026-04-26
---

HTTP API と通信するコードのユニットテストを書くときは、`HttpClient` 自体をモックしてはいけません。代わりにその `HttpMessageHandler` を、返したい応答を返すスタブに差し替え、その `HttpClient` (もしくは `HttpClient` を払い出す `IHttpClientFactory`) をテスト対象クラスに注入します。継ぎ目はクライアントではなく handler です。以下はすべて .NET 11 (`Microsoft.NET.Sdk` 11.0.0、C# 14) と xUnit 2.9 を対象にしていますが、パターンは .NET 6、8、9、10 でも変わりません。

## HttpClient を直接モックしてはいけない理由

`HttpClient` には `GetAsync`、`PostAsync`、`SendAsync` といったモックできそうに見える公開 API があり、Moq は文句なくモックを作成できます。問題はそれらのメソッドが実際に何をするかです。すべてが最終的に、その下にある `HttpMessageHandler` の `HttpMessageInvoker.SendAsync(HttpRequestMessage, CancellationToken)` に集約されます。`HttpClient` 自身の便利メソッドは `virtual` ではないため、`Mock<HttpClient>` はそれらをまったくインターセプトしないか、あるいは Moq の `Protected()` のようなツールに頼って private な内部に踏み込む必要があります。

実用上の帰結が 2 つあります。

1. `HttpClient.GetAsync` を直接モックするテストは、handler パイプラインを静かにバイパスします。`IHttpClientFactory` に組み込んだリトライ handler、ロギング handler、認証 handler は一切実行されないので、グリーンなテストが壊れた handler チェーンを本番に出してしまうことがあります。
2. `GetAsync` から `Send` に変えただけでテストが壊れます。挙動が同じであっても、です。

Microsoft 公式ガイダンス、2018 年以降の Stack Overflow のまともな回答、そして `HttpClient` のソース自身が同じ継ぎ目を指しています。`HttpMessageHandler` を差し替える、です。この handler はオーバーライドすべきメソッドが `SendAsync` ひとつだけで、`protected internal virtual` であり、パイプラインの他のすべての要素がすでに対象としている契約です。

## 最小のスタブ handler

最も簡潔な実装は、デリゲートをラップするクラスです。モックフレームワークは不要です。

```csharp
// .NET 11, C# 14
public sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;
    public List<HttpRequestMessage> Requests { get; } = new();

    public StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    public StubHttpMessageHandler(HttpStatusCode status, string? body = null, string mediaType = "application/json")
        : this((_, _) => Task.FromResult(new HttpResponseMessage(status)
        {
            Content = body is null ? null : new StringContent(body, Encoding.UTF8, mediaType),
        }))
    {
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return _handler(request, cancellationToken);
    }
}
```

2 つのコンストラクターでほとんどのテストを賄えます。リクエストを検査したいテスト用のデリゲートコンストラクターと、「200 でこの JSON を返す」という単純なケース向けの status/body ショートカットです。`Requests` リストを使えば、テストは送信内容を検証できます。

## テスト対象のクラス

残りを具体的にするために、テストしたい典型的なコードの形を示します。

```csharp
// .NET 11, C# 14
public sealed record Repo(int Id, string Name, int Stars);

public sealed class GitHubClient
{
    private readonly HttpClient _http;

    public GitHubClient(HttpClient http) => _http = http;

    public async Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default)
    {
        var path = $"/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(name)}";
        using var response = await _http.GetAsync(path, ct);
        response.EnsureSuccessStatusCode();

        var dto = await response.Content.ReadFromJsonAsync<RepoDto>(ct);
        return new Repo(dto!.Id, dto.Full_Name, dto.Stargazers_Count);
    }

    private sealed record RepoDto(int Id, string Full_Name, int Stargazers_Count);
}
```

コンストラクターは `HttpClient` を受け取ります。静的参照でも、その場で `new` した個体でもありません。この一つの設計判断が、以下のすべてを可能にします。

## 既定の応答を返すテスト

```csharp
// .NET 11, C# 14, xUnit 2.9
[Fact]
public async Task GetRepoAsync_returns_parsed_repo_when_api_returns_200()
{
    var json = """
    { "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }
    """;

    var handler = new StubHttpMessageHandler(HttpStatusCode.OK, json);
    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    var repo = await sut.GetRepoAsync("octocat", "hello-world");

    Assert.Equal(42, repo.Id);
    Assert.Equal("octocat/hello-world", repo.Name);
    Assert.Equal(1300, repo.Stars);

    var sent = Assert.Single(handler.Requests);
    Assert.Equal(HttpMethod.Get, sent.Method);
    Assert.Equal("/repos/octocat/hello-world", sent.RequestUri!.AbsolutePath);
}
```

ポイントは 3 つです。handler は status と body から組み立てられ、`HttpClient` はその handler と `BaseAddress` で組み立てられ、テストはパース結果と送信リクエストの両方を検証します。3 つ目の検証は多くのテストが省略する部分で、最も多くの回帰を捕まえます。誤ったパス、忘れたヘッダー、空であってはならない空 body、などです。

## リクエストごとに異なる応答を返す

複数回のコールを行うクラス (ページング付きリスト、リトライ、条件付き GET) には、デリゲートを渡します。

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_throws_on_404()
{
    var handler = new StubHttpMessageHandler((req, _) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            RequestMessage = req,
            Content = new StringContent("""{ "message": "Not Found" }""", Encoding.UTF8, "application/json"),
        }));

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    await Assert.ThrowsAsync<HttpRequestException>(() => sut.GetRepoAsync("octocat", "ghost"));
}
```

逐次応答 (1 回目は 401、トークン更新後の 2 回目は 200) では、デリゲート内にカウンターを保持します。

```csharp
// .NET 11, C# 14
var calls = 0;
var handler = new StubHttpMessageHandler((req, _) =>
{
    var status = calls++ == 0 ? HttpStatusCode.Unauthorized : HttpStatusCode.OK;
    return Task.FromResult(new HttpResponseMessage(status)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });
});
```

ほぼすべてのユニットテストシナリオはこれで足ります。モックフレームワーク不要、protected メンバへの小細工不要、儀式不要です。

## Moq を使った亜種、そして避ける理由

コードベースが Moq を標準にしている場合、等価なコードはこうなります。

```csharp
// .NET 11, C# 14, Moq 4.20
var handler = new Mock<HttpMessageHandler>(MockBehavior.Strict);
handler
    .Protected()
    .Setup<Task<HttpResponseMessage>>(
        "SendAsync",
        ItExpr.IsAny<HttpRequestMessage>(),
        ItExpr.IsAny<CancellationToken>())
    .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });

var http = new HttpClient(handler.Object) { BaseAddress = new Uri("https://api.github.com") };
```

動作はします。難点は次のとおりです。

- `"SendAsync"` は文字列です。仮にフレームワークがリネームしても (しないでしょうが、原則として) コンパイラは捕まえません。
- `Protected()` には `using Moq.Protected;` が必要で、テストを読む開発者全員にその仕掛けの知識を要求します。
- シングルトンなモック設定から単一の `HttpResponseMessage` を返すと、応答が複数回列挙される場合に状態が呼び出し間で漏れます。前節のスタブ handler は呼び出しごとに新しい応答を作ります。

単発のテストなら Moq でも構いません。HTTP シナリオが 5 つあるテストクラスなら、自前のスタブの方が短く、読みやすく、デバッグしやすいです。

## IHttpClientFactory 経由でテストする

`IHttpClientFactory` を使う本番コード (現代のコードのほとんどがそうです) では、テスト対象は `IHttpClientFactory` または typed client を受け取り、ファクトリーが `Program.cs` で登録した handler チェーンを持つ `HttpClient` を組み立てます。テストの継ぎ目は「`HttpClient` を直接構築する」から「ファクトリーの primary handler を設定する」へと移ります。

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http 11.0
[Fact]
public async Task TypedClient_uses_registered_handler_chain()
{
    var stub = new StubHttpMessageHandler(HttpStatusCode.OK,
        """{ "id": 7, "full_name": "a/b", "stargazers_count": 5 }""");

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .ConfigurePrimaryHttpMessageHandler(() => stub)
        .Services
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();

    var repo = await sut.GetRepoAsync("a", "b");
    Assert.Equal(7, repo.Id);
}
```

`ConfigurePrimaryHttpMessageHandler` はチェーンの最下部だけを差し替えます。それ以外の handler (ロギング、リトライ、認証) はそのまま動作し、これこそが要点です。チェーン全体を置き換えたい場合 (ほぼ望まないでしょうが) は、`AddHttpMessageHandler` と末尾のスタブ handler を使うか、先の例のように `HttpClient` を手で構築します。

## Polly のリトライが本当にリトライしたかを検証する

これは Moq では辛く、スタブ handler では一瞬で書けるテストです。`Program.cs` で次のように登録しているとします。

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 9.0
builder.Services.AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
    .AddStandardResilienceHandler();
```

標準のレジリエンス handler はデフォルトで 5xx とタイムアウトを 3 回まで再試行します。これをテストで証明するには次のようにします。

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_retries_on_503()
{
    var calls = 0;
    var handler = new StubHttpMessageHandler((_, _) =>
    {
        calls++;
        var status = calls < 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK;
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                        Encoding.UTF8, "application/json"),
        });
    });

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .AddStandardResilienceHandler()
        .Services
        .ConfigureAll<HttpClientFactoryOptions>(o => o.HttpMessageHandlerBuilderActions.Add(b =>
            b.PrimaryHandler = handler))
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();
    var repo = await sut.GetRepoAsync("x", "y");

    Assert.Equal(3, calls);
    Assert.Equal(1, repo.Id);
}
```

`Assert.Equal(3, calls)` の検証こそが、これを handler チェーンの統合テストにします。`HttpClient.GetAsync` を純粋にモックしただけでは Polly はそもそも呼ばれず、検証は `calls == 1` になっていたはずで、それが先に警告した静かな失敗です。

## キャンセルとタイムアウト

キャンセルは単純です。スタブ handler は `CancellationToken` を受け取るので、それを観測させることができます。

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_propagates_cancellation()
{
    var handler = new StubHttpMessageHandler(async (_, ct) =>
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);
        return new HttpResponseMessage(HttpStatusCode.OK);
    });

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://x") };
    var sut = new GitHubClient(http);

    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        sut.GetRepoAsync("a", "b", cts.Token));
}
```

`HttpClient.Timeout` 自体は `TaskCanceledException` として現れます (.NET 5 以降は内部例外として `TimeoutException` を持ちます)。タイムアウト挙動をテストしたければ、`http.Timeout = TimeSpan.FromMilliseconds(50)` を設定し、handler 側でそれより長く `await Task.Delay` で待たせます。本番コードがすでに従っているはずの協調的キャンセルパターンについては [C# で長時間実行される Task をデッドロックなしでキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) を参照してください。

## リクエストボディに対する検証

`POST` と `PUT` では、handler のデリゲート内でリクエストコンテンツを取り込んで読み取ります。

```csharp
// .NET 11, C# 14
string? captured = null;
var handler = new StubHttpMessageHandler(async (req, ct) =>
{
    captured = req.Content is null ? null : await req.Content.ReadAsStringAsync(ct);
    return new HttpResponseMessage(HttpStatusCode.Created);
});
```

ボディは handler の中で読みます。`SendAsync` がリターンした後では、リクエストストリームが破棄されている可能性があります。

## ヘッダー、クエリ文字列、ベースアドレス

`BaseAddress` と相対パスの組み合わせが最もきれいな構成ですが、末尾スラッシュには注意してください。`new Uri("https://api.example.com/v1")` に `/users` へのリクエストを組み合わせると、URI に末尾スラッシュがないため `/v1` は捨てられます。`https://api.example.com/v1/` に `users` (先頭スラッシュなし) で `/v1/users` になります。テストで確かめましょう。

```csharp
// .NET 11, C# 14
Assert.Equal("/v1/users", handler.Requests[0].RequestUri!.AbsolutePath);
```

デフォルトヘッダーは個々のリクエストではなく `HttpClient` に付け、handler から見えます。

```csharp
// .NET 11, C# 14
http.DefaultRequestHeaders.Add("User-Agent", "start-debugging/1.0");
// in the handler:
Assert.Contains("start-debugging/1.0", req.Headers.UserAgent.ToString());
```

## WireMock.Net に切り替えるべきとき

スタブ handler のアプローチはユニットテストです。ソケットも実 HTTP も使いません。実際の HTTP スタックを動かすコンポーネントテストや統合テスト (TLS、コンテンツネゴシエーション、本物のチャンク転送、サーバー由来のタイムアウト) では [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net) を使います。

```csharp
// .NET 11, C# 14, WireMock.Net 1.6
using var server = WireMockServer.Start();
server
    .Given(Request.Create().WithPath("/repos/octocat/hello-world").UsingGet())
    .RespondWith(Response.Create()
        .WithStatusCode(200)
        .WithHeader("Content-Type", "application/json")
        .WithBody("""{ "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }"""));

var http = new HttpClient { BaseAddress = new Uri(server.Url!) };
var sut = new GitHubClient(http);
var repo = await sut.GetRepoAsync("octocat", "hello-world");
```

WireMock.Net はローカルホストのポートで実際の HTTP サーバーを立ち上げます。スタブ handler より遅く、より現実に近く、より壊れやすい (ポート競合、TLS、非同期起動)。フレームワークが実ソケットでしか行わない挙動を検証する必要があるテストでは使い、それ以外ではスタブ handler の方が速くて静かです。他の依存関係をモックする似た発想については、`GetRepoAsync` のデシリアライズ手順がすでに依存している [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) を参照してください。

## コードレビューで見つかる失敗例

複数の PR で指摘してきた事項を短く列挙します。

- テスト対象クラスの中で `HttpClient` を組み立てている (`private readonly HttpClient _http = new();`)。テストはフェイク handler を注入できないため、本物のネットワークを叩くか失敗します。依存として受け取りましょう。
- `HttpMessageHandler` のモックに `MockBehavior.Loose` を使い、リクエストを検証し忘れる。本番コードが API をまったく呼ばなくてもテストはパスします。
- 同じ `HttpResponseMessage` インスタンスを複数のテスト呼び出しから返す。コンテンツストリームは一度しか読めないため、2 回目の呼び出しは空のボディを見ます。呼び出しごとに新しい応答を作る (デリゲートコンストラクター) か、ボディを新しい `StringContent` にコピーしてください。
- 振る舞いではなく `response.StatusCode` を検証する。テストの目的は `GetRepoAsync` が 503 で何をするかであり、自分で構築した `HttpResponseMessage` リテラルが、自分で指定したステータスコードを持っていること、ではありません。
- `Mock<HttpClient>` で直接モックする。前述のとおり、これは handler チェーンを飛ばし、レジリエンスや認証 handler を静かに壊します。

handler が継ぎ目で、その他は付随します。テストで Moq、NSubstitute、FakeItEasy、WireMock が必要なら結構です。ただし設定するのは継ぎ目であって、表面ではありません。

## 参考リンク

- [HttpMessageHandler.SendAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.net.http.httpmessagehandler.sendasync)
- [IHttpClientFactory ガイダンス (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory)
- [ConfigurePrimaryHttpMessageHandler (MS Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.dependencyinjection.httpclientbuilderextensions.configureprimaryhttpmessagehandler)
- [Microsoft.Extensions.Http.Resilience](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net)
