---
title: "SignalR クライアントが .NET 11 Preview 6 でついに実行中のハブメソッドをキャンセルできます"
description: "InvokeAsync に渡す CancellationToken のキャンセルがサーバーに届き、ハブメソッドをキャンセルするようになりました。2019 年から開いていた SignalR の要望が解決します。"
pubDate: 2026-07-24
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
  - "csharp"
lang: "ja"
translationOf: "2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-24
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) は 2026-07-15 にリリースされ、SignalR で最も長く残っていた機能要望の 1 つを解決します。[Issue #11542](https://github.com/dotnet/aspnetcore/issues/11542)「Possibility to cancel long running hub method from client」は 2019 年から開いていました。[PR #64098](https://github.com/dotnet/aspnetcore/pull/64098) でついに配線され、.NET クライアントで `InvokeAsync` に渡す `CancellationToken` が実際にサーバーに届き、ハブメソッドをキャンセルするようになりました。

## これまであなたを欺いていたトークン

Preview 6 より前でも、.NET の SignalR クライアントは `InvokeAsync` で `CancellationToken` を受け取っていました。ただ、多くの人が想定した動作はしていませんでした。キャンセルすると*クライアント*が結果を待つのを止めますが、サーバー側のハブメソッドは最後まで実行を続けていました。サーバーに「止めてください、呼び出し元は離れました」と伝える手段がなかったのです。ストリーミング呼び出しは `CancelInvocation` メッセージを送信していましたが、通常のリクエスト・レスポンス呼び出しは送信していませんでした。

そのギャップはなくなりました。`InvokeAsync` に渡したトークンをキャンセルすると、クライアントは `CancelInvocationMessage` をサーバーに送信し、サーバーは対応する呼び出しを見つけてキャンセルします。

## 配線のしかた

サーバーでは、ハブメソッドに `CancellationToken` パラメーターを宣言します。SignalR がそれを合成引数として埋めるため、クライアントは決してそれを送信しません。

```csharp
public class ReportHub : Hub
{
    public async Task<string> BuildReport(int rows, CancellationToken cancellationToken)
    {
        for (var i = 0; i < rows; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(50, cancellationToken); // real work here
        }

        return "done";
    }
}
```

Preview 6 までは、ストリーミングでないハブメソッドの `CancellationToken` パラメーターは無視されていました。フレームワークはストリーミングメソッドに対してのみそれを合成していたためです。今では `HubMethodDescriptor` がどこでもそれを許可します。

クライアントでは、トークンを渡し、結果が不要になったらキャンセルします。

```csharp
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(2));

try
{
    var result = await connection.InvokeAsync<string>(
        "BuildReport", 100_000, cts.Token);
}
catch (OperationCanceledException)
{
    // The server's token fired too, so the hub method stopped.
}
```

## 内部で起きていること

`DefaultHubDispatcher` は、各呼び出しの `CancellationTokenSource` を呼び出し id をキーとして `ActiveRequestCancellationSources` に登録します。`CancelInvocationMessage` が届くと、そのソースを探して `Cancel()` を呼び出し、ハブメソッドが監視しているトークンが発火します。これはストリーミング呼び出しがすでに使っていたのと同じレジストリで、今は通常の呼び出しと共有されています。

覚えておくべき点が 2 つあります。キャンセルは協調的です。ハブメソッドがトークンを一度も確認せず、実行する非同期呼び出しに転送もしなければ、何も止まりません。そして、これはプレビューであるため、.NET 11 が 2026 年 11 月にリリースされるまでに動作はまだ変わる可能性があります。

同じ Preview 6 では[自動 CSRF 保護も有効化](/ja/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)されたので、テストするのに良いリリースです。詳細はすべて [ASP.NET Core Preview 6 のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)にあります。ユーザーを欺くだけの「キャンセル」ボタンをこれまでに作ったことがあるなら、これはそれを誠実にするリリースです。
