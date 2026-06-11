---
title: ".NET 11 Preview 5 で Blazor の静的 SSR フォームがクライアントサイド検証を獲得"
description: "サーバーで静的にレンダリングされる Blazor フォームは、完全な POST のラウンドトリップの後でしか検証できませんでした。.NET 11 Preview 5 は検証メタデータをレンダリングし、Blazor の JS が DataAnnotations のルールをブラウザーで適用します。circuit は不要です。"
pubDate: 2026-06-11
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "ja"
translationOf: "2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-11
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) は 2026-06-09 にリリースされ、ASP.NET Core の 1 つの変更が、静的サーバーサイドレンダリング (static SSR) 上でフォームを構築する誰もが悩まされてきたギャップを埋めます。フォームがインタラクティブなレンダーモードなしでブラウザーで検証されるようになったのです。このプレビューまで、static SSR フォームがユーザーにメールアドレスの形式が正しくないと伝える方法はちょうど 1 つしかありませんでした。全体を送信し、サーバーに `DataAnnotations` を実行させ、エラーメッセージとともにページを再レンダリングするのです。タイプミス 1 つのために完全な POST のラウンドトリップが発生します。

## なぜ static SSR フォームはサーバーに縛られていたのか

Blazor Web App テンプレートは、ほとんどのコンテンツを静的な HTML としてレンダリングします。SignalR の circuit も WebAssembly のペイロードもなく、まさにそれが static SSR が安価で高速な理由です。しかしクライアントサイド検証にはブラウザーで実行されるコードが必要で、静的なページはクライアントにコンポーネントのロジックを一切送信しません。そのため検証は完全にサーバー側に存在していました。フォームを送信し、`DataAnnotationsValidator` がモデルを走査し、いかなる失敗も再レンダリングされたページとして返ってきました。正しくはあるものの低速で、フォーカスを失ったときに誤ったフィールドをマークするインタラクティブなフォームと比べると貧弱な体験です。

よくある回避策は、ライブのフィードバックを得るためだけにフォームのコンポーネントを `InteractiveServer` または `InteractiveWebAssembly` に切り替え、本来は不要な circuit や WASM のダウンロードのコストを払うことでした。

## Preview 5 はどのようにギャップを埋めるか

Preview 5 では、サーバーが検証ルールをメタデータとして HTML 内にレンダリングし、Blazor の JS がそれをブラウザーで適用します。あなたの `DataAnnotations` 属性は引き続き権威ある信頼できる情報源であり、送信時にサーバーで再び評価されます。ブラウザーは同じルールの早期かつ無償のコピーを受け取るだけです。この機能は `DataAnnotationsValidator` を含むすべての static SSR フォームに対してデフォルトで有効になっており、拡張フォームと非拡張フォームの両方で動作します。

学ぶべき新しい API はありません。すでに記述したフォームは、Preview 5 の SDK を対象にした瞬間からクライアントサイドで検証を始めます。

```razor
<EditForm Model="Model" Enhance FormName="registration" OnValidSubmit="HandleValidSubmit">
    <DataAnnotationsValidator />
    <div>
        <label for="Email">Email</label>
        <InputText @bind-Value="Model!.Email" id="Email" />
        <ValidationMessage For="@(() => Model!.Email)" />
    </div>
    <button type="submit" id="submit-btn">Register</button>
</EditForm>
```

```csharp
public class RegistrationModel
{
    [Required]
    [EmailAddress]
    public string Email { get; set; }

    [Required]
    [StringLength(100, MinimumLength = 8)]
    public string Password { get; set; }

    [Required]
    [Compare("Password")]
    [Display(Name = "Confirm Password")]
    public string ConfirmPassword { get; set; }
}
```

誤ったメールアドレスや短すぎるパスワードは、フォームがネットワークに到達する前にブラウザーで表示されるようになりました。サーバーは POST 時に依然として同じチェックを実行するため、多層防御を失うことはありません。クライアント検証は利便性のレイヤーであってセキュリティ境界ではない、まさにあるべき姿です。

## まだ欠けているもの

非同期ルール (データベースの一意性チェック、リモート API のルックアップ) はまだここには含まれていません。リリースノートによれば、完全な非同期のストーリーは、新しい非同期の `DataAnnotations` API が後のプレビューでリリースされるときに実現します。今のところこれは同期的な属性セットをカバーしており、それが現実のフォーム検証の大部分を占めます。

これは [System.Text.Json の JSON Lines シリアル化](/ja/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/) のような Preview 5 のその他の追加機能と組み合わさります。試すには、.NET 11 Preview 5 SDK をインストールし、`net11.0` を対象にしてください。すべての詳細は [ASP.NET Core Preview 5 リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md) にあります。
