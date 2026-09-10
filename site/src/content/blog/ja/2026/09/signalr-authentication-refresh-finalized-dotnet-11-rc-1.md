---
title: ".NET 11 RC 1 の SignalR は接続を切らずに期限切れ間近のトークンを差し替えます"
description: "SignalR の認証リフレッシュ API が .NET 11 RC 1 で確定しました。HubConnection 上に改名されたコールバック、TypeScript クライアント、そして更新後の ClaimsPrincipal を自動で取り込む Blazor Server の回線が含まれます。"
pubDate: 2026-09-10
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "signalr"
  - "blazor"
lang: "ja"
translationOf: "2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1"
translatedBy: "claude"
translationDate: 2026-09-10
---

[.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) の ASP.NET Core セクションは、Preview 6 から進められてきた認証リフレッシュの作業で始まります。SignalR の接続は期限切れ間近のアクセストークンをその場で置き換えられるようになり、RC 1 でサーバーと .NET クライアントの API の形が確定しました ([dotnet/aspnetcore#68702](https://github.com/dotnet/aspnetcore/pull/68702))。[System.Diagnostics.Process に POSIX シグナルを載せた](/ja/2026/09/dotnet-11-rc-1-process-signal-exit-status/)のと同じリリースで、go-live ライセンス付きで提供されます。

## これまでの選択肢がどちらも良くなかった理由

これまで、bearer トークンを使うハブには二つの選択肢しかなく、どちらも良いものではありませんでした。`CloseOnAuthenticationExpiration` を既定値のままにすると、すでに期限が切れた `ClaimsPrincipal` のまま接続が動き続け、認可の判断が古い claims に対して行われます。`true` にすると、トークンが期限切れになった瞬間に SignalR が接続を閉じるため、完全な再接続が発生します。`OnConnectedAsync` が再度実行され、グループへの参加を作り直す必要があり、クライアントがストリーミングしていたものはすべて止まります。

15 分のトークンを使うダッシュボードなら、トークン衛生以外に理由のない目に見える途切れが 15 分ごとに起きることになります。

## サーバー側で有効にする

リフレッシュはハブ単位のオプトインで、新しいトークンが既存の接続を引き継いでよいかをサーバー側で判断するフックが用意されています。

```csharp
using System.Security.Claims;

app.MapHub<ClockHub>("/clock", options =>
{
    options.EnableAuthenticationRefresh = true;
    options.CloseOnAuthenticationExpiration = true;
    options.OnAuthenticationRefresh = context =>
    {
        var previousSubject = context.PreviousUser.FindFirstValue("sub")
            ?? context.PreviousUser.FindFirstValue(ClaimTypes.NameIdentifier);
        var newSubject = context.NewUser.FindFirstValue("sub")
            ?? context.NewUser.FindFirstValue(ClaimTypes.NameIdentifier);

        return Task.FromResult(
            previousSubject is not null &&
            string.Equals(previousSubject, newSubject, StringComparison.Ordinal));
    };
});
```

ここで `false` を返せることが重要な点です。このチェックがなければ、クライアントはまったく別のユーザーの有効なトークンを渡して、最初の ID に紐づくグループ参加ごと接続を維持できてしまいます。

## クライアント側と、改名された箇所

.NET クライアントは期限より前にリフレッシュをスケジュールし、その結果を `HubConnection` のイベントとして公開します。

```csharp
await using var connection = new HubConnectionBuilder()
    .WithUrl(serverUrl, options =>
        options.AccessTokenProvider = GetAccessTokenAsync)
    .WithAuthenticationRefresh(options =>
    {
        options.EnableAutoRefresh = true;
        options.RefreshBeforeExpiration = TimeSpan.FromMinutes(2);
    })
    .Build();

connection.AuthenticationRefreshed += context =>
{
    Console.WriteLine($"New token lifetime: {context.NewTokenLifetime}");
    return Task.CompletedTask;
};

await connection.StartAsync();

// Force a refresh right after acquiring a token with updated claims.
await connection.RefreshAuthenticationAsync();
```

すでに Preview 7 を使っていた場合、三つの点が移動しています。`OnAuthenticationRefreshed` と `OnAuthenticationRefreshFailed` は `AuthenticationRefreshOptions` のコールバックではなくなり、上記の `HubConnection.AuthenticationRefreshed` および `HubConnection.AuthenticationRefreshFailed` イベントになりました。`AuthenticationRefreshContext` は `Microsoft.AspNetCore.Http.Connections` から `Microsoft.AspNetCore.Connections.Features` へ移りました。そしてカスタムトランスポートは `IConnectionUserRefreshFeature` ではなく `IConnectionAuthenticationRefreshFeature` を必要とします。

TypeScript クライアントも `withAuthenticationRefresh({ enableAutoRefresh: true, refreshBeforeExpirationInMilliseconds: 120_000 })` で同じ形を提供します ([dotnet/aspnetcore#67964](https://github.com/dotnet/aspnetcore/pull/67964))。

## Blazor Server は設定なしで恩恵を受けます

Interactive Server コンポーネントには設定が一切必要ありません ([dotnet/aspnetcore#68221](https://github.com/dotnet/aspnetcore/pull/68221))。コンポーネント用のハブが自らリフレッシュを有効化し、トークンが差し替わると Blazor が認証状態を更新して `AuthenticationStateChanged` を発火します。そのため `AuthorizeView` をはじめ `AuthenticationStateProvider` を利用するものは新しい claims で再描画されます。これにより「セッションの途中でユーザーのロールが変わった」という状況を、回線を破棄せずに反映できるようになりました。

詳細は [RC 1 の ASP.NET Core リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md)にあります。
