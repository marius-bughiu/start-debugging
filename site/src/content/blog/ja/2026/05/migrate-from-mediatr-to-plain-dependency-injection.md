---
title: ".NET 11 で MediatR からシンプルな依存性注入へ移行する"
description: "MediatR 12-14 を削除し、IRequest ハンドラー、ISender、pipeline behavior、INotification をシンプルなサービスクラスとコンストラクター注入で置き換えるためのステップバイステップのチェックリスト。"
pubDate: 2026-05-30
updatedDate: 2026-05-30
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

.NET 11 のコードベースから MediatR を削除するのは、書き直しではなく機械的なリファクタリングです。ハンドラーが 50-150 個ある典型的なサービスでは、半日から 1 日を見込んでください。ほとんどのハンドラーはシンプルなサービスクラスのメソッドへ 1 対 1 で畳み込まれ、`ISender.Send` の呼び出しは直接のインターフェース呼び出しになり、設計上の検討を要する唯一の部分はパイプラインです。壊れるのは、runtime でのハンドラー解決や、すべてのリクエストを `IPipelineBehavior<,>` で包む仕組みに依存していたものすべてです。それらはコンストラクター注入とデコレーターになります。これを行う価値があるのは、`Send` しか呼び出していない場合、MediatR の Community エディションの $5,000,000 の売上ラインを超えていて商用ライセンスを購入したくない場合、あるいは Native AOT と trimming への適合性が欲しい場合です。pipeline behavior が数百のリクエスト型にわたって不可欠である場合は、行う価値はありません。

参照するバージョン: このガイドは MediatR 12.5.0（Apache 2.0 ライセンス下の最後のリリース）、13.0（2025-07-02 リリース、Lucky Penny Software による Reciprocal Public License 1.5 / 商用のデュアルモデル初のリリース）、および現行の 14.x 系の削除を扱います。置き換えるコードは `<TargetFramework>net11.0</TargetFramework>` を .NET 11 SDK と C# 14 で対象とし、デコレーターには Scrutor 6.x を使います。*移行すべきかどうか*をまだ検討中であれば、まず [MediatR 対シンプルなサービスクラス（2026 年）](/ja/2026/05/mediatr-vs-plain-service-classes-in-2026/) を読んでください。この記事は決定済みであることを前提とします。

## なぜチームは今まさに MediatR を削除しているのか

- **ライセンスが $5M 超で決断を迫る。** MediatR 13+ の無償のオープンソース利用は RPL-1.5 の下にあり、これは SaaS の抜け穴を塞ぐよう設計された相互的な copyleft ライセンスです。Community エディションの売上しきい値を超えてクローズドソースの商用ソフトウェアを出荷する場合、このライセンスは使えないため、購入するか去るかです。
- **定義へ移動するとハンドラーに着地し、`Send` には着地しない。** 直接のインターフェース呼び出しは、mediator の間接化がジャンプのたびに奪う移動しやすさを取り戻します。
- **起動が安くなり、AOT が容易になる。** ハンドラー登録のためのアセンブリスキャンを削除するとコールドスタートのミリ秒が削られ、trimming と戦うリフレクションがなくなります。これは [.NET 11 の AWS Lambda のコールドスタート時間を短縮する](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) ときに重要です。
- **配線は最初のリクエストではなく起動時に失敗する。** 明示的な `AddScoped` 登録は、欠落した依存関係を runtime の `InvalidOperationException` ではなく起動時のエラーに変えます。

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

`AddMediatR(...)` を削除し、各サービスを登録します。明示的な登録は trimming に対して安全で、起動時に素早く失敗します。これはまさに [Unable to resolve service for type while attempting to activate](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) の背後にある失敗モードです。

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

MediatR のリフレクションモデルなしで規約ベースの登録が欲しい場合、Scrutor はインターフェース名でスキャンします。

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

**検証:** アプリが起動します。実行して移行済みのエンドポイントにアクセスしてください。登録の欠落は、最初のリクエストではなく起動時にスローされるようになります。singleton から scoped を取得する誤りが紛れ込んでいないことを確認します。これは [Cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) で扱われているバグのクラスです。

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

`ValidationBehavior` 内で FluentValidation を使っていた場合は、バリデーターを残し、1 つのデコレーターまたは minimal API のエンドポイントフィルターから呼び出します。

```csharp
// .NET 11, C# 14 - a validation decorator replacing ValidationBehavior for one interface
public sealed class ValidatingOrderService(
    IOrderService inner,
    IValidator<CreateOrder> validator) : IOrderService
{
    public async Task<OrderDto> CreateAsync(CreateOrder cmd, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(cmd, ct);
        return await inner.CreateAsync(cmd, ct);
    }

    public Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
        => inner.GetByIdAsync(orderId, ct);
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
- アプリが起動し、以前 MediatR でディスパッチされていた各エンドポイントが以前と同じレスポンスを返す。登録の欠落は、起動時のここで表面化するようになります。
- `grep -rn "MediatR" src/` が何も返さない。
- ログにライセンス警告が現れない（MediatR 13+ のライセンスチェックは未登録のキーで警告を記録していました。今は消えているはずです）。
- コールドスタートが同等か改善する。アプリが serverless なら、前後で起動時間を測ってください。アセンブリスキャンの削除で悪化してはなりません。

## ロールバック計画

この移行はコミット単位で可逆ですが、一括で元に戻すのは面倒なので、段階的に進めてください。6 つの手順それぞれを別個のコミットとして保持し、ソリューション全体を一度にではなく、垂直スライス（1 つのサービスインターフェースとその呼び出し元）を一度に 1 つずつ移行します。移行中、MediatR とシンプルなサービスは共存できます。残りを変換する間、未移行のハンドラー用に `AddMediatR` を登録したままにしてください。スライスが誤動作したら、そのスライスのコミットを元に戻せば、アプリの残りは影響を受けません。ここにはデータやスキーマの変更がないため、ロールバックは元に戻すべき migration のない純粋なコードの revert です。

## 私たちがはまった落とし穴

**`IPipelineBehavior` の順序はデコレーターへきれいに対応付かない。** MediatR は 1 つのハンドラーの周りで登録順に behavior を実行します。Scrutor のデコレーターは `Decorate` を呼ぶ順序で入れ子になり、*最後に*登録したデコレーターが*最も外側*のラッパーです。順序を誤ると、ログ出力のデコレーターがバリデーションのデコレーターの周りではなく内側で実行されます。デコレートしたインターフェースごとに順序のテストを 1 つ書いてください。

**別のハンドラーを呼ぶハンドラー内の `ISender` は直接のサービス呼び出しになり、それが循環を露呈させることがある。** MediatR の間接化はハンドラー間の依存関係を隠していました。`OrderService` が `ICustomerService` を注入し、`CustomerService` が `IOrderService` を注入すると、コンテナーは循環依存により起動時にスローします。これは移行が、MediatR が覆い隠していた設計上の問題を表面化させているのです。共有ロジックを 3 つ目のサービスに抽出して循環を断ち切ってください。

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
