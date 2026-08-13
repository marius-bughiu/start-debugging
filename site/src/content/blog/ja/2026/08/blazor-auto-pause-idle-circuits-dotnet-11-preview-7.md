---
title: "Blazor Server のサーキットがタブのアイドル時に自動で一時停止するようになりました"
description: ".NET 11 Preview 7 では、ブラウザーのタブが非表示になったときに対話型 Server サーキットを一時停止するオプトインのパッケージが追加され、実際にはいないユーザーが抱え込んでいたメモリと SignalR 接続が解放されます。"
pubDate: 2026-08-13
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "signalr"
lang: "ja"
translationOf: "2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-13
---

.NET 11 Preview 7 は 2026-08-11 にリリースされ、その ASP.NET Core セクションには Blazor Server の最も古い容量問題に対する答えが埋もれています。誰も見ていないサーキットが、誰かが使っているサーキットとまったく同じコストを払い続ける、という問題です。[ASP.NET Core Preview 7 のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/aspnetcore.md)では、[dotnet/aspnetcore#64886](https://github.com/dotnet/aspnetcore/issues/64886) を起点とする自動一時停止が紹介されています。

## 非表示のタブは切断されたタブではありません

Blazor Server はユーザーごとの状態をサーバー上のサーキットに保持し、そのサーキットは SignalR 接続が生きている限り生き続けます。ユーザーが別のタブに移り、あなたのアプリのタブを忘れても、WebSocket は閉じません。デスクトップのブラウザーは何時間でも平然と接続を開いたままにします。その間もサーキットはコンポーネントツリー、DI スコープ、レンダーキュー、そして同時実行数の枠を保持し続けます。お昼に離席したきりのユーザーのために、です。

自動一時停止は代わりにブラウザーの可視性シグナルを利用します。タブが設定可能な時間だけ非表示のままになると、クライアントがサーバーにサーキットの一時停止を要求し、サーキットが解放されます。ユーザーが戻ってくるとサーキットは再開されます。

## 有効化の方法

この機能はオプトインで、専用のパッケージとして提供されます。

```xml
<PackageReference Include="Microsoft.AspNetCore.Components.Server.AutoPause" />
```

設定はレンダーモードの登録にぶら下がります。

```csharp
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .WithBrowserOptions(options =>
    {
        options.AddAutoPause(pause =>
        {
            pause.Enabled = true; // default
            pause.HiddenDelay = TimeSpan.FromSeconds(30); // default is 2 minutes
        });
    });
```

`HiddenDelay` の既定値は 2 分です。30 秒まで下げるとメモリの回収は速くなりますが、タブを行ったり来たりするユーザーからの再開のラウンドトリップが増えます。

## 一時停止を見送るケース

面白い設計は、自動一時停止が「やらない」と決めている部分にあります。テキスト入力欄や `contenteditable` 要素にフォーカスがある場合、ミュートされていない音声や動画が再生中の場合、Picture-in-Picture ウィンドウが開いている場合、Web Lock が保持されている場合、そして `IJSRuntime` の呼び出しやストリーム転送のようなサーキットの処理が進行中の場合には、一時停止が延期されます。つまり、非表示でもユーザーのために何かをやり続けているタブが、足元からいきなり奪われることはありません。

独自の延期ロジックは JavaScript イニシャライザーから追加できます。

```javascript
// wwwroot/{ASSEMBLY NAME}.lib.module.js
export function beforeWebStart(options) {
  options.circuit ??= {};
  options.circuit.circuitHandlers ??= [];

  options.circuit.circuitHandlers.push({
    onCircuitPausing: async (signal) => {
      await savePendingWork(signal);
    },
  });
}
```

`signal` は一時停止がキャンセルされたとき、たとえばハンドラーが保存処理を続けている最中にタブが再び表示されたときに中断されます。サーバー側では `Circuit.RequestCircuitPauseAsync` が `Task<bool>` を返すようになり、省略可能なキャンセルトークンを受け取るため、接続が切れた時点で延期処理をキャンセルできます。

## 有効にする前に確認すること

自動一時停止は .NET 10 で導入された一時停止と再開の仕組みの上に乗っています。つまり再開時には、永続化されたコンポーネントの状態からサーキットが再構築されます。コンポーネントが単なるフィールドに持っているだけで永続化対象として宣言していないものは、一時停止のあとに消えます。本番で有効にする前に状態を持つコンポーネントを点検し、再接続のテレメトリを監視してください。ここでの失敗の見え方は、[サーキットが勝手に切断された場合](/ja/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)とよく似ています。

Preview 7 は盛りだくさんのリリースです。C# 側では同じタイミングで[ラベル付きの break と continue](/ja/2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7/) が入りました。
