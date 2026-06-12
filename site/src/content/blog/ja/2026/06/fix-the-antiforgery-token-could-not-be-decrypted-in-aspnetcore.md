---
title: "解決: ASP.NET Core で The antiforgery token could not be decrypted"
description: "このエラーは Data Protection がトークンに署名したキーを失ったことを意味します。キーを共有された永続的なストアに保存し、SetApplicationName を呼び出して、すべてのインスタンスが同じキーリングを読み取るようにします。"
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
lang: "ja"
translationOf: "2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-12
---

The antiforgery token could not be decrypted は、トークンに署名した Data Protection のキーが、アプリケーションが読み取っているキーリングにもう存在しないために発生します。デフォルトでは、ASP.NET Core はこれらのキーをマシンごと・ユーザーごとのフォルダーに書き込みますが、これはコンテナーの再起動で失われ、インスタンス間で共有されません。すべてのインスタンスが読み取れる永続的なストア（ファイル共有、データベース、Azure Blob、Redis）にキーを保存し、`SetApplicationName` をすべての場所で同じ値に固定してください。これが解決策のすべてです。この記事の残りでは、なぜ発生するのか、そして各ストアの正確なコードを説明します。

これは ASP.NET Core 11（`.NET 11`）に適用されますが、同じ Data Protection スタックと同じ解決策は ASP.NET Core 2.x まで遡ります。

## コンテキスト内のエラー

通常、デプロイ、スケールアウト、コンテナーの再起動の直後の POST で、次のいずれかが表示されます。

```
Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException: The antiforgery token could not be decrypted.
 ---> System.Security.Cryptography.CryptographicException: The key {0cf0e637-...} was not found in the key ring.
   at Microsoft.AspNetCore.DataProtection.KeyManagement.KeyRingBasedDataProtector.UnprotectCore(...)
   at Microsoft.AspNetCore.Antiforgery.DefaultAntiforgeryTokenSerializer.Deserialize(String serializedToken)
```

内部例外が決め手です。`The key {guid} was not found in the key ring` は、トークンがこのインスタンスが一度も見たことのないキーを参照していることを意味します。別の内部メッセージ `The payload was invalid` は、存在するもののこの特定のトークンを復号できないキーを指しており、これは通常、2 つのアプリケーションがアプリケーション名の一致なしにキーリングを共有していることを意味します（詳細は後述）。

Blazor と Razor Pages では、同じ根本原因が `Bad Request - antiforgery token validation failed` を伴う HTTP 400 として現れ、MVC では antiforgery クッキーが検証できないためログインでのリダイレクトループとして現れます。

## なぜ発生するのか

antiforgery トークンは ASP.NET Core Data Protection によって暗号化および署名されます。検証は、トークンを読み取るインスタンスがそれを書き込んだキーをまだ保持している場合にのみ機能します。そのキーを失う方法は 4 つあります。

- **キーが一時的である。** 明示的な設定がない場合、Data Protection はキーを `%LOCALAPPDATA%\ASP.NET\DataProtection-Keys`（Windows）または `$HOME/.aspnet/DataProtection-Keys`（Linux）に保存します。コンテナーではこのパスは書き込み可能レイヤー内にあり、再起動のたびに消去されるため、新しいコンテナーごとに新しいキーリングが生成され、前のコンテナーが発行したすべてのトークンが拒否されます。
- **スケールアウトした。** ロードバランサーの背後にある 2 つ以上のインスタンスは、それぞれ独自のキーリングを生成します。インスタンス A が発行したトークンがインスタンス B に到達しますが、B のリングには A のキーが含まれていません。これが本番環境で最も一般的な原因です。
- **アイデンティティが変わった。** IIS で実行する場合、アプリケーションプールのリサイクルまたはアイデンティティの変更がキーフォルダーを移動させます。これはデフォルトパスがユーザースコープであるためです。Azure App Service のデプロイスロットも同じ効果があります。ステージングスロットと本番スロットは、指示しない限りキーを共有しません。
- **2 つのアプリケーション、1 つのリング、アプリケーション名なし。** 複数のアプリケーションが同じストアを指しているが、一致する `SetApplicationName` を設定していない場合、トークンが衝突します。Data Protection はアプリケーション識別子で分離するため、不一致は `The payload was invalid` を生成します。

デフォルトのキーの有効期間は 90 日なので、正当なキーローテーションがこれを引き起こすことはほとんどありません。これが見られる場合、キーは期限切れではなく、欠落しています。

## 最小限の再現

これは再起動をまたいでエラーを再現する最小のアプリケーションです。実行し、フォームを送信してから、再度送信する前にプロセスを再起動してください。

```csharp
// .NET 11, ASP.NET Core 11
// No Data Protection configuration: keys are ephemeral.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();

app.MapGet("/", (HttpContext ctx, IAntiforgery af) =>
{
    var tokens = af.GetAndStoreTokens(ctx);
    return Results.Content($"""
        <form action="/submit" method="post">
          <input name="{tokens.FormFieldName}" type="hidden" value="{tokens.RequestToken}" />
          <button type="submit">Submit</button>
        </form>
        """, "text/html");
});

app.MapPost("/submit", () => "OK").RequireAntiforgery();

app.Run();
```

`/` を読み込み、レンダリングされたフォームをコピーし、アプリケーションを再起動してから、古いフォームを POST します。メモリ内のキーリングが再起動時に再生成されたため、トークンはもう復号されず、`AntiforgeryValidationException` が発生します。単一の長時間実行プロセスでは表示されません。これがまさに、これがローカルテストをすり抜け、コンテナーやファームでのみ問題になる理由です。

## 解決策の詳細

実行する場所に合ったストアを選択してください。いずれの場合もルールは同じです。すべてのインスタンスが読み書きできる場所と、安定したアプリケーション名です。

### 1. ファイル共有（UNC またはマウントされたボリューム）: VM とベアメタルに最もシンプル

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(@"\\fileserver\dpkeys\myapp"))
    .SetApplicationName("MyApp");
```

Kubernetes では、共有 `PersistentVolume`（ReadWriteMany）をマウントし、`PersistKeysToFileSystem` をマウントパスに向けます。これにより、キーは個々の pod よりも長く存続します。共有ストレージが既にある場合、これが最も摩擦の少ない解決策です。

### 2. EF Core 経由のデータベース: データベースが既にある場合は追加のインフラが不要

[`Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`](https://www.nuget.org/packages/Microsoft.AspNetCore.DataProtection.EntityFrameworkCore/) パッケージと、`IDataProtectionKeyContext` を実装するコンテキストを追加します。

```csharp
// .NET 11, EF Core 11
public class KeysDbContext : DbContext, IDataProtectionKeyContext
{
    public KeysDbContext(DbContextOptions<KeysDbContext> options) : base(options) { }
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
}
```

```csharp
// Program.cs
builder.Services.AddDbContext<KeysDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Keys")));

builder.Services.AddDataProtection()
    .PersistKeysToDbContext<KeysDbContext>()
    .SetApplicationName("MyApp");
```

`DataProtectionKeys` テーブルを作成するマイグレーションを一度実行すれば、すべてのインスタンスが同じリングを読み取ります。これは私が最も頻繁に手を伸ばす選択肢です。アプリケーションが既に持っていないものを必要としないからです。

### 3. Azure Blob Storage: App Service と Azure Container Apps にクリーンな選択肢

[`Azure.Extensions.AspNetCore.DataProtection.Blobs`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Blobs) を追加します。接続文字列ではなくマネージド ID を使用してください。

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToAzureBlobStorage(
        new Uri("https://mystorage.blob.core.windows.net/dpkeys/keys.xml"),
        new DefaultAzureCredential())
    .SetApplicationName("MyApp");
```

これはデプロイスロットのバリアントも修正します。ステージングと本番が同じ blob を指している場合、スロットの入れ替えでアクティブなセッションが無効になることはなくなります。多層防御のために、`ProtectKeysWithAzureKeyVault`（パッケージ [`Azure.Extensions.AspNetCore.DataProtection.Keys`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Keys)）でラップして、キーリング自体を保存時に暗号化してください。

### 4. Redis: 大規模ファームに最も低いレイテンシ

`Microsoft.AspNetCore.DataProtection.StackExchangeRedis` を追加し、キャッシュに既に使用しているマルチプレクサーを再利用します。

```csharp
// .NET 11, ASP.NET Core 11
var redis = ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis")!);
builder.Services.AddDataProtection()
    .PersistKeysToStackExchangeRedis(redis, "DataProtection-Keys")
    .SetApplicationName("MyApp");
```

どのストアを選んでも、複数アプリケーションまたはスロットのシナリオでは `SetApplicationName` は省略可能ではありません。これは Data Protection がキー導出に混ぜ込むアプリケーション識別子を設定し、その値は互いのトークンを信頼すべきすべてのインスタンスとスロットでバイト単位で同一でなければなりません。

## 落とし穴とバリエーション

**`key not found` ではなく `The payload was invalid`。** キーは存在するが、アプリケーション識別子が異なります。2 つのアプリケーションがストアを共有し、一方が `SetApplicationName` を欠いているか、異なる値を持っています。両方に同じ名前を設定してください。これは、公開済みアプリケーションを新しいコンテンツルートパスにコピーするとトークンが壊れる理由でもあります。ASP.NET Core は、明示的に設定しない場合、コンテンツルートパスからアプリケーション名を導出するため、パス自体が識別子になります。

**他のインスタンスが読み取れない保存時暗号化キー。** Windows では、Data Protection はデフォルトで現在のユーザーまたはマシンにスコープされた DPAPI でキーリングを暗号化します。あるアイデンティティで書き込まれたキーは別のアイデンティティでは読み取れず、キーが物理的に存在していても同じ症状を生成します。マシン間でキーを共有する場合は、マシンスコープの暗号化を無効にするか、`ProtectKeysWithCertificate` のような明示的でポータブルなプロテクターを使用してください。

**ローカルでは動作するが、コンテナーでは失敗する。** 予想どおりです。開発マシンの単一プロセスは、セッション全体にわたって一時的なリングをメモリに保持するため、トークンは常に復号されます。バグは 2 番目のインスタンスまたは再起動が登場したときにのみ現れます。前面に何も置かずに異なるポートで 2 つのインスタンスをローカルで実行するか、上記の再現のようにリクエスト間で再起動して再現してください。

**antiforgery を無効にして「修正」しないでください。** `[ValidateAntiForgeryToken]` または `.RequireAntiforgery()` を削除するとエラーは消えますが、CSRF の穴が再び開きます。トークンは仕事をしています。代わりにキーを保存してください。

**読み取り専用レプリカでの `DisableAutomaticKeyGeneration`。** キーを消費すべきだが決して生成すべきでないワーカーを実行する場合は、`DisableAutomaticKeyGeneration()` を呼び出して、共有リングに競合するキーを作成しないようにします。ローテーションを所有するインスタンスではオフのままにしてください。

## 関連記事

- [.NET 10.0.7 が ASP.NET Core Data Protection の CVE-2026-40372 を修正するために帯域外でリリース](/ja/2026/04/dotnet-10-0-7-oob-cve-2026-40372-dataprotection/) は、同じスタックの HMAC 検証の欠陥と、キーリングをパッチ適用しておきたい理由を扱っています。
- [ASP.NET Core Identity で refresh トークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) は、同じ暗号化パイプラインのために Data Protection に依存しています。
- [Blazor の静的 SSR フォームが .NET 11 Preview 5 でクライアント側検証を取得](/ja/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/) は、静的にレンダリングされた Blazor フォームで antiforgery トークンが現れる場所です。
- [.NET 11 で Blazor の静的から対話的へのレンダリング境界をまたいで状態を保持する方法](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) は、「境界をまたいで状態が失われる」という関連するクラスのバグを扱っています。
- [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は、この例外を裸の 400 ではなくクリーンに表面化させるのに役立ちます。

## ソース

- [Configure ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/overview?view=aspnetcore-11.0) - 正確な `PersistKeysTo*`、`ProtectKeysWith*`、`SetApplicationName` の API とパッケージ名。
- [Key storage providers in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/implementation/key-storage-providers?view=aspnetcore-11.0) - ファイルシステム、Azure Blob、Redis、EF Core のプロバイダー。
- [Data Protection key management and lifetime](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/default-settings?view=aspnetcore-11.0) - デフォルトの 90 日の有効期間とデフォルトのストレージの場所。
- [dotnet/aspnetcore #47185: The antiforgery token could not be decrypted](https://github.com/dotnet/aspnetcore/issues/47185) - 実際の報告とメンテナーのガイダンス。
