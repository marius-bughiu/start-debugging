---
title: "MediatR vs 単純なサービスクラス（2026年）: ライセンス変更で乗り換えるべきか？"
description: "MediatR のディスパッチとパイプライン、サービスの直接呼び出しを比較します。DI 検証、ライセンス条件、性能の測り方を説明します。"
pubDate: 2026-05-23
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "mediatr"
  - "dependency-injection"
  - "architecture"
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/mediatr-vs-plain-service-classes-in-2026"
translatedBy: "claude"
translationDate: 2026-05-23
---

各要求の呼び出し先が明確なら、サービスを直接呼び出す方法が適しています。複数の要求型でパイプラインのビヘイビアを共有したり、複数の受信先へ通知したりする場合は MediatR が役立ちます。利用するバージョンのライセンス条件は別途確認してください。

**2026年11月2日訂正:** DI 検証とライセンス条件の比較を修正し、裏付けのないディスパッチ時間と割り当ての数値を削除しました。

例のターゲットは `net11.0` で、MediatR 13/14 の契約を示します。以下の DI 検証は .NET 10 で行いました。

## 2025年7月に実際に変わったこと

MediatR 12.5.0 は Apache 2.0 で配布されました。作者は 2025 年 7 月に 13.0.0 から RPL-1.5 と商用ライセンスを提供すると発表しました。以前のバージョンには元の条件が適用されます。

[Lucky Penny Software の Community 条件](https://luckypennysoftware.com/faq)には、年間総収入（非営利組織は予算）が 500 万米ドル未満、外部資本が 1,000 万米ドル以下という要件があります。政府・準政府機関、高等教育機関での利用、顧客向けの業務にも条件があります。組織と用途に該当する条件を確認してください。

## 機能マトリクスを一目で

| 観点 | MediatR 13+ | 単純なサービスクラス |
| ---- | ----------- | -------------------- |
| リクエストディスパッチ | `ISender.Send` による間接化 | 注入されたインターフェースのメソッドへの直接呼び出し |
| 横断的関心事 | ファーストクラスの `IPipelineBehavior<,>` | デコレーター（Scrutor）または明示的な呼び出し |
| DI 検証 | 登録内容とプロバイダーの設定に依存 | 登録内容とプロバイダーの設定に依存 |
| 通知 / fan-out | 組み込みの `INotification` 発行 | 手書きの handler のリスト |

設計上の主な違いはパイプラインです。複数の要求で検証、ログ、トランザクション、キャッシュを共有できます。

## MediatR の見た目と、単純な等価物

これは MediatR の典型的な形です。リクエスト、handler、そして `ISender` 経由でディスパッチする呼び出し側です。

```csharp
// .NET 11, C# 14, MediatR 13+ - request + handler
using MediatR;

public record GetOrderById(int OrderId) : IRequest<OrderDto>;

public sealed class GetOrderByIdHandler(AppDbContext db)
    : IRequestHandler<GetOrderById, OrderDto>
{
    public async Task<OrderDto> Handle(GetOrderById request, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([request.OrderId], ct)
            ?? throw new OrderNotFoundException(request.OrderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);
```

単純な版は、リクエストと handler を注入されたサービスの単一のメソッドにまとめます。呼び出し側はインターフェースに直接依存します。

```csharp
// .NET 11, C# 14 - plain service class, no MediatR
public interface IOrderService
{
    Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct);
}

public sealed class OrderService(AppDbContext db) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([orderId], ct)
            ?? throw new OrderNotFoundException(orderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

インターフェイス呼び出しから定義に移動するとインターフェイスのメソッドに到達し、IDE から実装を探せます。`Send` からは要求型に対応するハンドラーを探します。

`AddScoped` はサービスの登録を記録します。組み込みプロバイダーで `ValidateOnBuild` が有効なら、登録済みサービスのコンストラクターが要求する未登録の依存関係をホストの構築時に検出できます。無効なら構築には成功し、サービスを解決する時点で失敗することがあります。[ASP.NET Core の検証の既定値](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild)は環境によって異なります。`ValidateScopes` はライフタイムを検証する別の設定です。

今回 .NET 10 で、コンストラクターの依存関係が未登録のスコープ付きサービスを検証しました。既定の Development ホストは `Build()` で失敗し、Production ホストは構築後の解決時に失敗しました。`ValidateOnBuild` を明示すると失敗の段階が変わりました。

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicitly register the scoped service
builder.Services.AddScoped<IOrderService, OrderService>();
```

## pipeline behavior と、それなしで生きる方法

ここが MediatR が価値を発揮する場所です。pipeline behavior はすべてのリクエストを包み、検証、ロギング、計時、あるいはトランザクションを追加するための場所をちょうど一つ与えてくれます。

```csharp
// .NET 11, C# 14, MediatR 13+ - cross-cutting validation for ALL requests
using MediatR;

public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        foreach (var validator in validators)
            await validator.ValidateAndThrowAsync(request, ct);
        return await next(ct);
    }
}
```

一度登録すれば、その behavior はすべての handler の前で実行されます。これを各単純サービスにコピー＆ペーストした検証呼び出しで置き換えるのは退行であり、メディエーターを残す最良の論拠です。しかし、デコレーターパターンを使えば、単純な DI でも同じ「すべてを包む」性質を得られます。Scrutor（MIT ライセンス）を使ってインターフェースの周りにデコレーターを登録します。

```csharp
// .NET 11, C# 14, Scrutor 6.x - a decorator gives you the same cross-cutting hook
public sealed class LoggingOrderService(
    IOrderService inner,
    ILogger<LoggingOrderService> logger) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        logger.LogInformation("Fetching order {OrderId}", orderId);
        return await inner.GetByIdAsync(orderId, ct);
    }
}

// Registration: decorate the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

トレードオフは正直です。MediatR の behavior は単一の登録ですべてのリクエストに対してジェネリックですが、デコレーターはインターフェースごとです。横断的関心事が1つか2つで、サービスインターフェースがほんの一握りなら、デコレーターが明快さで勝ります。10個の behaviors を200種類のリクエスト型に一様に適用しなければならないなら、MediatR のジェネリックなパイプラインは本当にコードが少なく、それがとどまる（そして支払う、または Community の資格を得る）ことが擁護できるシナリオです。実際には HTTP の関心事であるリクエストレベルの関心事については、人々が behaviors に入れるものの一部はむしろ middleware やフィルターに属することに注意してください。これは [ASP.NET Core 11 でグローバルな例外フィルターを追加する](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) が扱うのと同じ領域です。

## ディスパッチが実際にかかるコスト

`Send` はハンドラーを解決し、構成したパイプラインを実行します。直接呼び出す場合は注入済みサービスを利用します。両者を同じ条件で測定した結果がないため、ここでは呼び出し時間や割り当て回数を示しません。

ディスパッチのコストが判断に関わるなら、ハンドラーの処理、ライフタイム、ランタイム、ビヘイビアの条件をそろえて両方式を測定します。登録とコールドスタートは別に測ります。明示的登録ならハンドラーのスキャンを省けます。トリミングと Native AOT は発行したアプリで検証してください。

## あなたの代わりに決めてくれる要点

いくつかの制約は、アーキテクチャの好みが入り込む前にこれを決着させます。

12.5.0 に固定したアプリは、そのバージョンと適用条件を維持します。長期固定を決める前に保守の必要性を検討してください。

**`Send` しか呼ばないなら、メディエーターは不要です。** 正直なテスト: ソリューションを開いて `IPipelineBehavior` と `INotification` を検索してください。behaviors がゼロで通知も発行していないなら、MediatR はメソッド呼び出しの上の間接化レイヤーとして機能しており、それを取り除くのは、コードをよりたどりやすくし、依存関係を1つ減らし、ライセンスの問題を一手で消す機械的なリファクタリングです。これは [System.Text.Json vs Newtonsoft.Json（2026年）](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) で同梱の選択肢を選ぶ背後にあるのと同じ、ライブラリの合理化の本能です。

## 結論を一行で

呼び出し元からサービスへ直接つなぐには明示的な注入を選びます。複数の要求型が共通パイプラインや通知の恩恵を受けるなら MediatR を維持します。サービスに移行する場合は[具体的な手順](/ja/2026/05/migrate-from-mediatr-to-plain-dependency-injection/)を参照してください。

## 関連

- [Minimal APIs vs controllers in ASP.NET Core 11](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json（2026年）](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## 出典

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - 2025-07-02 のリリース告知、v13.0 の境界、デュアルの RPL-1.5 / 商用モデル。
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - 収益500万・資本1000万の Community しきい値、「プログラム的アクセス」による開発者の数え方、ログ出力のみのライセンスチェック。
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - 古いバージョンが元のオープンソースライセンスのままであることの確認。
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - 最初のデュアルライセンスのリリース。
- [Scrutor on GitHub](https://github.com/khellang/Scrutor) - pipeline behaviors をデコレーターで置き換えるために使う MIT ライセンスの `Decorate` 拡張。
