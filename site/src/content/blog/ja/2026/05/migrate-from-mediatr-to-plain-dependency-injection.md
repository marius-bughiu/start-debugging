---
title: ".NET 11 で MediatR からシンプルな依存性注入へ移行する"
description: "MediatR 12-14 を削除し、IRequest ハンドラー、ISender、pipeline behavior、INotification をシンプルなサービスクラスとコンストラクター注入で置き換えるためのステップバイステップのチェックリスト。"
pubDate: 2026-05-30
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "mediatr"
  - "dependency-injection"
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/migrate-from-mediatr-to-plain-dependency-injection"
translatedBy: "claude"
translationDate: 2026-05-30
---

要求を一つずつ移行します。ハンドラーをサービスメソッドに置き換え、呼び出し元を更新し、必要な検証、トランザクション、通知の動作を維持します。登録を変える前に、依存関係と呼び出し箇所を調べて作業量を見積もります。

**2026年11月2日訂正:** DI の失敗時点と Community の適格条件を修正しました。未測定のコールドスタートの主張を削除し、検証デコレーターが書き込み契約を実装するようにしました。

例のターゲットは `net11.0` で、MediatR 13/14 の契約を示します。以下の DI 検証は .NET 10 で行いました。 設計を選ぶ段階なら、[MediatR とサービスの直接呼び出しの比較](/ja/2026/05/mediatr-vs-plain-service-classes-in-2026/)から始めてください。

## なぜチームは今まさに MediatR を削除しているのか

- ライセンス変更を移行理由にする前に、利用中の MediatR バージョンを調べ、資金調達額や組織での用途を含む[提供元の適格条件](https://luckypennysoftware.com/faq)を確認します。
- インターフェイス呼び出しから定義に移動するとインターフェイスのメソッドに到達し、IDE から実装を探せます。`Send` からは要求型に対応するハンドラーを探します。
- 起動時間を移行判断に使うなら、同じデプロイ環境で移行前後のコールドスタートを測定します。トリミングや Native AOT が必要なら発行したアプリを検証します。

## 何が壊れるか

| 領域 | 変更 | 深刻度 |
| --- | --- | --- |
| `ISender` / `IMediator` の注入 | 直接注入される具体的なサービスインターフェースに置き換え | 高 |
| `IRequest<T>` + `IRequestHandler<,>` | 1 つのインターフェース + 実装メソッドに畳み込まれる | 高 |
| `IPipelineBehavior<,>` | 汎用的なラップ地点なし。インターフェースごとにデコレーターまたは middleware で置き換え | 高 |
| `INotification` + `INotificationHandler<>` | fan-out 用の注入された `IEnumerable<IHandler>` またはイベントアグリゲーターで置き換え | 中 |
| `AddMediatR(...)` 登録 | 明示的な `AddScoped` 呼び出し（または 1 回の Scrutor スキャン）で置き換え | 中 |
| behavior 内の `RequestHandlerDelegate<T>` | 等価物なし。"next" チェーンは消える | 中 |
| `ISender.CreateStream` (`IStreamRequest`) | `IAsyncEnumerable<T>` を返すメソッドで置き換え | 低 |
| `ISender` をモックするユニットテスト | 具体的なインターフェースのモックへ向け直す | 低 |

## 事前チェックリスト

- .NET 11 SDK がインストールされていること: `dotnet --version` で確認します（`11.x` を期待）。
- 開始する*前に*、クリーンな git ブランチとグリーンのテストスイートがあること。`dotnet test` で検証し、失敗ゼロを確認します。
- 影響範囲を棚卸しします。検索を実行して件数を記録してください。それが作業の規模を教えてくれます。

```bash
# .NET 11 - inventory MediatR usage before touching anything
grep -rn "IRequestHandler\|IRequest<\|: IRequest" src/      # handlers + requests
grep -rn "IPipelineBehavior" src/                            # the hard part
grep -rn "INotification" src/                                # fan-out
grep -rn "ISender\|IMediator\|\.Send(\|\.Publish(" src/      # call sites
```

- behavior の置き換え形を*最初に*決めます。`IPipelineBehavior` のヒットがゼロなら、これは純粋な検索置換です。複数ある場合は、それぞれをデコレーター、ASP.NET Core middleware、エンドポイントフィルターのどれにするかを計画します。
- デコレーターを使うなら Scrutor を追加します: `dotnet add package Scrutor`（6.x、MIT ライセンス）。

## 移行手順

1. **各リクエストとハンドラーをサービスインターフェースとメソッドへ変換する。**

MediatR のリクエストはメッセージ型と別個のハンドラーです。両方を 1 つのインターフェースと 1 つの実装で置き換えます。古いリクエストごとにインターフェースを作るのではなく、関連するリクエストを 1 つのサービスにまとめてください。

```csharp
// .NET 11, C# 14, MediatR 14.x - BEFORE
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
```

```csharp
// .NET 11, C# 14 - AFTER: plain service, no MediatR reference
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
```

**検証:** 新しいファイルに `using MediatR;` がなく、メソッドシグネチャを除いてハンドラーの本体がバイト単位で同一であること。リクエストの `record` のパラメーターは、同じ順序でメソッドのパラメーターになります。

2. **`ISender.Send` の呼び出し箇所を直接のインターフェース呼び出しで置き換える。**

`ISender` または `IMediator` を注入していた各呼び出し元は、特定のサービスインターフェースを注入してメソッドを呼ぶようになります。

```csharp
// .NET 11, C# 14 - BEFORE
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);

// AFTER
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

**検証:** この手順の後、`grep -rn "ISender\|IMediator" src/` が返すのは、意図的にまだ移行していない行だけになります。件数はゼロへ向かって進むはずです。

3. **サービスを明示的に登録する。**

残りのハンドラーを移行したら `AddMediatR(...)` を削除し、置き換えたインターフェイスと実装を明示的に登録します。[コンストラクターの依存関係の不足](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)は検証時または解決時に報告されます。 デプロイ先の環境で登録を確認します。ホスト構築時に組み込みプロバイダーで登録済みコンストラクターの依存関係を検証したい場合は `ValidateOnBuild` を有効にします。本番設定で検証を無効にすると、不足がサービスの要求時まで見つからない場合があります。`ValidateScopes` は別途ライフタイムを検証します。[ASP.NET Core のプロバイダー設定](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild)を参照してください。

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

規約による登録を使う場合、Scrutor でアセンブリをスキャンし、クラス名で選択できます。

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

今回の .NET 10 のテストでは、`ValidateOnBuild` を明示的に有効にすると、コンストラクター依存関係の不足がホスト構築時に検出されました。無効なら構築は成功し、スコープから `IOrderService` を要求した時点で失敗しました。移行した各サービスをスコープ内で解決し、エンドポイントを呼び出してください。

4. **pipeline behavior をデコレーターまたは middleware で置き換える。**

これは判断を要する唯一の手順です。`IPipelineBehavior<,>` はすべてのリクエストを 1 か所で包んでいました。誠実な置き換えは 2 つあります。

純粋にサービスごとの関心事（ログ出力、キャッシュ、リトライ）には、Scrutor のデコレーターを使います。

```csharp
// .NET 11, C# 14, Scrutor 6.x - BEFORE was a generic ValidationBehavior<TRequest,TResponse>
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

// Registration: wrap the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

実は HTTP の関心事である関心事（リクエストのログ出力、例外から ProblemDetails への対応付け、認証）については、アプリケーション層から完全に取り出して ASP.NET Core middleware またはエンドポイントフィルターへ移してください。例外を捕捉してレスポンスを整形していた behavior は、デコレーターではなく [ASP.NET Core 11 のグローバル例外フィルター](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) と同じ場所に属します。

書き込み用のデコレーターには専用の `IOrderWriter` 契約を用意します。上の読み取り用 `IOrderService` は `GetByIdAsync` のままで構いません。

```csharp
using FluentValidation;

public interface IOrderWriter
{
    Task<OrderDto> CreateAsync(CreateOrder command, CancellationToken ct);
}

public sealed class ValidatingOrderWriter(
    IOrderWriter inner,
    IValidator<CreateOrder> validator) : IOrderWriter
{
    public async Task<OrderDto> CreateAsync(CreateOrder command, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(command, ct);
        return await inner.CreateAsync(command, ct);
    }
}
```

**検証:** 横断的な関心事がまだ実行されることを表明するテストを書くか残します。たとえば、無効なコマンドがデータベースに触れる前に `ValidationException` をスローすること。`dotnet test` を実行し、behavior のテストが通ることを確認します。

5. **`INotification` の fan-out を置き換える。**

MediatR の `Publish` はすべての `INotificationHandler<T>` を呼び出していました。あなたが定義する小さなハンドラーインターフェースの注入された `IEnumerable<T>` と、薄いパブリッシャーで置き換えます。

```csharp
// .NET 11, C# 14 - BEFORE: INotification + handlers, AFTER: explicit fan-out
public interface IOrderPlacedHandler
{
    Task HandleAsync(OrderPlaced evt, CancellationToken ct);
}

public sealed class OrderEventPublisher(IEnumerable<IOrderPlacedHandler> handlers)
{
    public async Task PublishAsync(OrderPlaced evt, CancellationToken ct)
    {
        foreach (var handler in handlers)
            await handler.HandleAsync(evt, ct);
    }
}

// Registration - each handler registered against the interface
builder.Services.AddScoped<IOrderPlacedHandler, SendConfirmationEmail>();
builder.Services.AddScoped<IOrderPlacedHandler, UpdateInventory>();
builder.Services.AddScoped<OrderEventPublisher>();
```

コンテナーは登録済みの各ハンドラーを `IEnumerable<IOrderPlacedHandler>` で渡してくれるので、ハンドラーの追加は登録 1 行で済みます。これは MediatR が提供していたのと同じ使い勝手です。多くのイベント型を発行する場合は、イベントごとに 1 つではなく、汎用の `IEventPublisher<T>` でパブリッシャーを生成してください。

**検証:** イベントの発行が登録済みのすべてのハンドラーを呼び出すことを表明します。どちらも呼び出しを記録する 2 つの偽ハンドラーを使うテストで十分です。

6. **パッケージと最後の参照を削除する。**

呼び出し箇所がなくなったら、依存関係を外します。

```bash
# .NET 11 - remove the package from every project that referenced it
dotnet remove package MediatR
grep -rn "MediatR" src/ || echo "clean"
```

**検証:** `grep -rn "MediatR" src/` が `clean` を表示します。ビルドに未解決の `using MediatR;` がなく、`dotnet build -c Release` が欠落パッケージに関する警告なしで成功します。

## 検証: 移行後のスモークテスト

このリストを上から下まで実行し、パフォーマンスの行を飛ばさないでください。

- `dotnet build -c Release` が警告なしで成功する。
- `dotnet test` が失敗ゼロで通り、手順 4 と 5 で追加した behavior と fan-out のテストも含まれる。
- アプリを起動し、移行した各エンドポイントを呼び出します。応答とスコープ付きサービスの解決を確認します。
- `grep -rn "MediatR" src/` が何も返さない。
- ログにライセンス警告が現れない（MediatR 13+ のライセンスチェックは未登録のキーで警告を記録していました。今は消えているはずです）。
- 出荷予定の発行プロファイルで、移行前後のコールドスタートを比較します。

## ロールバック計画

この移行はコミット単位で可逆ですが、一括で元に戻すのは面倒なので、段階的に進めてください。6 つの手順それぞれを別個のコミットとして保持し、ソリューション全体を一度にではなく、垂直スライス（1 つのサービスインターフェースとその呼び出し元）を一度に 1 つずつ移行します。移行中、MediatR とシンプルなサービスは共存できます。残りを変換する間、未移行のハンドラー用に `AddMediatR` を登録したままにしてください。スライスが誤動作したら、そのスライスのコミットを元に戻せば、アプリの残りは影響を受けません。ここにはデータやスキーマの変更がないため、ロールバックは元に戻すべき migration のない純粋なコードの revert です。

## 私たちがはまった落とし穴

**`IPipelineBehavior` の順序はデコレーターへきれいに対応付かない。** MediatR は 1 つのハンドラーの周りで登録順に behavior を実行します。Scrutor のデコレーターは `Decorate` を呼ぶ順序で入れ子になり、*最後に*登録したデコレーターが*最も外側*のラッパーです。順序を誤ると、ログ出力のデコレーターがバリデーションのデコレーターの周りではなく内側で実行されます。デコレートしたインターフェースごとに順序のテストを 1 つ書いてください。

循環依存は、登録したグラフの検証時またはサービスの解決時に発覚します。`OrderService` と `CustomerService` が互いを必要とするなら、共通処理を別のサービスに移します。

**ストリーミングリクエストには `Task<T>` ではなく `IAsyncEnumerable<T>` が必要。** `IStreamRequest<T>` と `CreateStream` を使っていた場合、置き換えるメソッドは `IAsyncEnumerable<T>` を返し、`yield return` を使います。`Task<List<T>>` に畳み込まないでください。それはストリーミングのセマンティクスを変え、大きな結果でメモリを使い果たすことがあります。これは [.NET 11 で大きな CSV をメモリ不足にならずに読む](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) で説明されているのと同じ罠です。

**`ISender` をモックしていたテストは、何もないものに対して静かに通る。** `sender.Send(...)` が値を返すよう設定したテストは、`ISender` がなくなるとコンパイルエラーになります。これは良いことです。しかし、本物の `IMediator` を注入してそれを通して振る舞いを表明していたテストは、具体的なインターフェースへ向け直す必要があります。スイート全体を再実行し、グリーンのビルドだけを信用しないでください。

これは、[System.Text.Json 対 Newtonsoft.Json（2026 年）](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) で組み込みのシリアライザーを選ぶのと同じ形で報われる依存関係の合理化です。ホットパス上のサードパーティライブラリが 1 つ減り、ライセンスの問いが 1 つ減り、新しいチームメイトがまずディスパッチの規約を学ばずに辿れるコードになります。

## 関連記事

- [MediatR 対シンプルなサービスクラス（2026 年）: ライセンス変更はあなたを動かすべきか?](/ja/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [大きなコードベースで Newtonsoft.Json から System.Text.Json へ移行する](/ja/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [ASP.NET Core 11 における Minimal APIs 対 controllers](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## 参考資料

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - 2025-07-02 の再ライセンス、v13.0 の境界、デュアルの RPL-1.5 / 商用モデル。
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - $5,000,000 の売上と $10,000,000 の資本という Community エディションのしきい値、およびログ記録のみのライセンスチェック。
- [LuckyPennySoftware/MediatR on GitHub](https://github.com/LuckyPennySoftware/MediatR) - 現行 14.x のソース、置き換え対象の `IPipelineBehavior` と `INotification` の契約。
- [Scrutor on GitHub](https://github.com/khellang/Scrutor) - behavior の置き換えと規約ベースのサービス登録に使う MIT ライセンスの `Decorate` と `Scan` の拡張。
- [.NET の依存性注入 - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection) - 通知の fan-out に使うサービスのライフタイムと `IEnumerable<T>` の解決。
