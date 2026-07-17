---
title: "ASP.NET Core 11 Preview 6 が自動 CSRF 保護を有効化"
description: "Preview 6 は、antiforgery トークンではなく Sec-Fetch-Site ヘッダーを読み取り、安全でないオリジン間のブラウザーリクエストをデフォルトで拒否します。何をブロックし、どう除外するかを解説します。"
pubDate: 2026-07-17
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "security"
  - "csrf"
  - "csharp"
lang: "ja"
translationOf: "2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6"
translatedBy: "claude"
translationDate: 2026-07-17
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) は 2026-07-15 にリリースされました。ASP.NET Core の変更のうち、あなたのアプリに最も影響しそうなのは、コードを一切書かなくてよいものです。cross-site request forgery (CSRF) 保護が、設定なしで、Minimal APIs、MVC、Razor Pages、Blazor 全体にわたってデフォルトで有効になりました。これは従来の antiforgery トークンに依存しません。代わりに、ブラウザーの `Sec-Fetch-Site` ヘッダーを読み取ります。

## なぜトークンの手間を置き換える価値があったのか

古いモデルは負担をあなたに課していました。すべてのフォームに antiforgery トークンを出力し、POST 時に検証し、ロードバランサーをまたいでもトークンが復号できるように、Data Protection の鍵をインスタンス間で共有していました。これらの手順のいずれかを忘れると、セキュリティホールか、あるいは実行時エラーのどちらかになりました（[antiforgery トークンを復号できなかった場合](/ja/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/) を参照）。トークンをぶら下げるサーバーレンダリングのフォームを持たない API では、指針はさらに曖昧でした。

Fetch Metadata はこれらすべてを回避します。最近のブラウザーはすべてのリクエストに `Sec-Fetch-Site` を付加し、その値はスクリプトでは偽造できません。Preview 6 はこれを検査し（`Origin` ヘッダーをフォールバックとして使用）、エンドポイントが実行される前に信頼の判定を記録します。

## 何が許可され、何が拒否されるのか

ルールは意図的に狭くなっています。同一オリジンのリクエスト、ユーザーが開始したナビゲーション（URL の入力、リンクのクリック）、そしてブラウザー以外のクライアント（モバイルアプリ、`HttpClient`、curl）は、いずれも許可されます。拒否されるのは、実際の CSRF の形、つまりエンドポイントの 1 つを利用しようとするオリジン間のブラウザーリクエストです。自動で動作するため、Blazor Web App のテンプレートは `app.UseAntiforgery()` を呼び出さなくなりました。

必要な場所では、除外は引き続き利用できます。外部サービスが POST する公開 webhook はブラウザー以外のクライアントなので通過しますが、明示したい場合は次のようにします。

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Protected automatically: a cross-origin page cannot POST here from a browser.
app.MapPost("/transfer", (TransferRequest req) => Results.Ok());

// Opt a single endpoint out.
app.MapPost("/webhook", (Payload p) => Results.Ok())
   .DisableAntiforgery();

app.Run();
```

MVC では、アクション単位の抜け道は変わりません。

```csharp
[HttpPost]
[IgnoreAntiforgeryToken]
public IActionResult Receive(Payload p) => Ok();
```

アプリ全体でこの機能をオフにするには、設定キー `DisableCsrfProtection` を設定します。

```json
{
  "DisableCsrfProtection": true
}
```

組み込みの判定ロジックがトポロジーに合わない場合は、独自の `ICsrfProtection` 実装を登録して、信頼の判断を完全に置き換えます。

## ランタイムを切り替える前に

この API は Preview 4 で初めて登場し、標準の options 規約に従うよう Preview 6 で再設計されました。以前に試したことがある場合は、配線を再確認してください。そして、これは認証の代替ではなく、多層防御として扱ってください。止められるのはオリジン間のブラウザー経由の攻撃ベクトルであって、盗まれた bearer トークンではありません。詳細は [ASP.NET Core Preview 6 のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md) にあります。.NET 11 Preview 6 SDK をインストールし、`net11.0` をターゲットにして、公開前に、オリジン間のブラウザー POST を正当に期待するすべてのエンドポイントを監査してください。
