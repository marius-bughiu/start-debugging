---
title: "MediatR vs 単純なサービスクラス（2026年）: ライセンス変更で乗り換えるべきか？"
description: "新規コードには単純なサービスクラスがより良いデフォルトです。2025年7月のMediatRのライセンス変更が問題になるのは、Communityの500万ドルのしきい値を超えている場合か、RPL-1.5のcopyleftを拒否する場合だけです。pipeline behaviorsが不可欠なときはMediatRを残しましょう。"
pubDate: 2026-05-23
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

短い結論: 2026年の新規 .NET 11 コードでは、デフォルトで**単純なサービスクラス**を選び、その pipeline behaviors に実際に依存しているときだけ MediatR に手を伸ばしてください。2025年7月のライセンス変更は再評価する現実的な理由ですが、一部の人が描いたような崖ではありません。あなたの会社が年間総収益500万ドル未満であれば、Community エディションのもとで最新の MediatR を無料で使い続けられるので、ライセンスの問題が決断を迫るのは、より大きなチームか、無料のオープンソースライセンスに付く RPL-1.5 の copyleft を受け入れたくない人だけです。技術的な問い（そもそもメディエーターが必要か？）こそが実際に選択を左右すべきものであり、大半のリクエストディスパッチでは、取り除けるのはライブラリではなく間接化です。

本文を通して参照するバージョン: MediatR 12.5.0 は素の Apache 2.0 ライセンス下での最後のリリースです。MediatR 13.0（2025-07-02 リリース）とそれ以降の 14.x 系列は、Lucky Penny Software による Reciprocal Public License 1.5 / 商用のデュアルモデルのもとで配布されます。コードは .NET 11 SDK と C# 14 で `<TargetFramework>net11.0</TargetFramework>` を対象とします。

## 2025年7月に実際に変わったこと

MediatR と AutoMapper は、Jimmy Bogard によって長年、寛容なオープンソースライセンスのもとで保守されてきました。2025-07-02 に彼は両者を新会社 Lucky Penny Software に移し、ライセンスモデルを変更しました。あなたの判断にとって重要な仕組みは次のとおりです。

- **古いバージョンは永久に無料のままです。** MediatR 12.x 以前は Apache 2.0（一部の古い成果物は MIT）のままで、遡及的に再ライセンスされることはありません。`12.5.0` に固定して一切支払わずに済みます。難点は、その系列に対してセキュリティ更新も修正もサポートも得られないことです。
- **新しいバージョンはデュアルライセンスです。** MediatR 13.0 以降は、オープンソース利用向けの Reciprocal Public License 1.5（RPL-1.5）か、有償の商用ライセンスのもとで提供されます。
- **無料の Community エディションがあります。** 年間総収益500万 USD 未満の企業および個人（かつ外部資本を1000万 USD 超受け取っていないこと）、同じ予算未満の非営利団体、教育目的の利用、非本番環境は、いずれも商用契約の Community 階層のもとで最新の MediatR を無料で使う資格があります。
- **有償の階層はチーム規模に基づきます。** Standard（1～10名の開発者）、Professional（11～50名）、Enterprise（無制限）で、月額または年額で請求され、MediatR を呼び出すコードを書いたりコンパイルしたりする「プログラム的アクセス」を持つ開発者のみが数えられます。
- **ライセンスチェックはログ出力するだけです。** 期限切れまたは欠落したキーはランタイムの失敗ではなくログ警告を生成します。機能のロックも、性能の低下も、ライセンスサーバーもネットワーク呼び出しもありません。

つまり実用上の分岐はこうです。500万未満の小さな現場であれば、現行の MediatR に無料でとどまれます。唯一の摩擦は、Community キーを登録するまでログに出る警告だけです。より大きい、あるいは潤沢に資金がある場合は、支払うか、RPL-1.5 の相互的な義務を受け入れるか、去るかのいずれかです。その3番目のグループこそが、「vs 単純なサービスクラス」の比較を読むべき相手です。

## 機能マトリクスを一目で

| 観点 | MediatR 13+ | 単純なサービスクラス |
| ---- | ----------- | -------------------- |
| リクエストディスパッチ | `ISender.Send` による間接化 | 注入されたインターフェースのメソッドへの直接呼び出し |
| 横断的関心事 | ファーストクラスの `IPipelineBehavior<,>` | デコレーター（Scrutor）または明示的な呼び出し |
| 呼び出し側からの定義へ移動 | handler ではなく `Send` に着地 | 実装に着地 |
| コンパイル時の結線の安全性 | 実行時の解決、最初の呼び出しで失敗しうる | コンストラクター注入、起動時に失敗 |
| 通知 / fan-out | 組み込みの `INotification` 発行 | 手書きの handler のリスト |
| 起動コスト | handler を登録するためのアセンブリスキャン | 通常の DI 登録を超えるものはなし |
| 呼び出しごとのオーバーヘッド | wrapper のアロケーション + 辞書ルックアップ + 仮想ディスパッチ | ほぼゼロ、JIT が脱仮想化できる |
| Native AOT / trimming | 注意が必要、リフレクションベースの登録 | クリーン |
| ライセンス（収益500万超） | 商用購入または RPL-1.5 | なし、あなた自身のコード |
| 2026年の新規コード | behaviors が不可欠なときのみ | デフォルトの選択 |

ほとんどの議論を決める行は「横断的関心事」です。その表のほぼすべては単純なサービスクラスに有利です。MediatR の本物の、置き換えにくい価値はパイプラインです。すべてのリクエストを検証、ロギング、トランザクション、キャッシュで包む単一の場所です。そのパイプラインを使っていないなら、見栄えの良いサービスロケーターのために間接化とライセンスのコストを払っていることになります。

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

単純な版はより短く、そして決定的に重要なのは、`orders.GetByIdAsync` で定義へ移動を押すと、実行されるメソッドに着地することです。`sender.Send(new GetOrderById(id))` では MediatR の `Send` に着地し、推測するか「実装を検索」という遠回りで handler にたどり着きます。小さなチームではこの差はわずかです。何百もの handler を抱える大規模なコードベースでは、直接たどれることの喪失は、呼び出し側を handler の型から切り離す見返りとして MediatR モデルが課す、現実的で日常的な税金です。その切り離しが何かをもたらすかどうかは、呼び出し側に触れずに handler を入れ替える人が一度でもいるかにかかっており、実際にはまれです。

登録も比較に値します。MediatR は起動時にアセンブリをスキャンします。単純なサービスクラスは明示的に登録され、いずれかを忘れると（最初のリクエストではなく）起動時に失敗します。これは [Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) の背後にある種類のミスに直接関係します。

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicit, trim-friendly, fails fast at startup if a dep is missing
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

トレードオフは正直です。MediatR の behavior は単一の登録ですべてのリクエストに対してジェネリックですが、デコレーターはインターフェースごとです。横断的関心事が1つか2つで、サービスインターフェースがほんの一握りなら、デコレーターが明快さで勝ります。10個の behaviors を200種類のリクエスト型に一様に適用しなければならないなら、MediatR のジェネリックなパイプラインは本当にコードが少なく、それがとどまる（そして支払う、または Community の資格を得る）ことが擁護できるシナリオです。実際には HTTP の関心事であるリクエストレベルの関心事については、人々が behaviors に入れるものの一部はむしろ middleware やフィルターに属することに注意してください。これは [ASP.NET Core 11 でグローバルな例外フィルターを追加する](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) が扱うのと同じ領域です。

## ディスパッチが実際にかかるコスト

パフォーマンスはどちらの方向でも最も弱い論拠であり、それだけで選ぶべきではありませんが、誰も曖昧な主張をしないよう、コストがどこにあるかを知っておく価値はあります。単純なインターフェース呼び出しは1回の仮想ディスパッチで、JIT がしばしば脱仮想化してインライン化でき、何もアロケートせず、ナノ秒のオーダーのコストです。MediatR の `Send` は呼び出しごとにより多くの作業をします。リクエスト型を handler キャッシュで探し、`RequestHandlerWrapper` を構築または取得し、デリゲートを介して behavior の連鎖をたどり、コンテナーから handler を解決します。これは、あなたの handler 本体が実行される前に、送信ごとに数十ナノ秒のオーダーと小さなアロケーションがかかります。

| 観点 | MediatR の `Send` | 単純なインターフェース呼び出し |
| ---- | ----------------- | ------------------------------ |
| 型から handler への解決 | 呼び出しごとに辞書ルックアップ | なし、注入時に束縛 |
| wrapper / デリゲートの連鎖 | 送信ごとにアロケート | なし |
| JIT による脱仮想化 | いいえ | しばしばはい |
| 起動時のアセンブリスキャン | はい、handler 数とともに増加 | なし |
| 呼び出しごとのオーダー | 数十 ns + 小さなアロケーション | 約1 ns、アロケーションゼロ |

ここでの方法論的な誠実さ: データベースやネットワークに触れる handler に対しては、数十ナノ秒は見えません。一般的な数字を信じるのではなく、BenchmarkDotNet で自分のオブジェクトの形を測るべきです。実際に現れるコストは起動です。何百もの handler を登録するためにアセンブリをスキャンすると、コールドスタートに測定可能なミリ秒が加わります。これは serverless にとって重要で、[.NET 11 の AWS Lambda のコールドスタート時間を短縮する](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) で戦う類のものです。明示的で単純な登録はこれを完全に回避し、trimming に対して安全に保つべきリフレクションによる探索がないため、trimming と Native AOT に対してより親和的です。

## あなたの代わりに決めてくれる要点

いくつかの制約は、アーキテクチャの好みが入り込む前にこれを決着させます。

**価格ではなく RPL-1.5 こそが真の決め手です。** MediatR 13+ の無料のオープンソースの選択肢は Reciprocal Public License 1.5 で、相互的な copyleft の義務を伴います。これは SaaS の抜け穴を塞ぐよう設計されているので、RPL ライセンスのコードの上に構築されたネットワークサービスをデプロイすると、あなたのソースコードを利用可能にする義務が生じうるのです。クローズドソースの商用ソフトウェアを出荷していて Community のしきい値を超えているなら、無料の OSS ライセンスはあなたには実質的に使えず、「MediatR はまだオープンソースだ」はあなたの場合は誤解を招きます。商用ライセンスを買うか、去るかのどちらかです。実際には使っていなかった薄いディスパッチャーなら、去るのは簡単です。

**収益500万・資本1000万の線は寛大です。** ほとんどの小さなプロダクトチーム、コンサルティング会社、スタートアップはその下に収まり、Community エディションのもとで最新の MediatR を無料で使い続けられます。それがあなたなら、ライセンスは何かを引き剝がす理由にはなりません。Community キーを登録し、警告を黙らせて、先に進みましょう。負っていない請求を避けるために MediatR を削除するスプリントを費やすのは、誤ったトレードです。

**12.5.0 に固定するのは、現実的なコストを伴う現実的な選択肢です。** 最後の無料バージョンの Apache 2.0 は失効しません。しかし、セキュリティパッチを受けないバージョンに凍結し、保守リスクを自分で引き受けることになります。それは安定した社内アプリには問題なく、インターネットに露出するものには危険です。

**`Send` しか呼ばないなら、メディエーターは不要です。** 正直なテスト: ソリューションを開いて `IPipelineBehavior` と `INotification` を検索してください。behaviors がゼロで通知も発行していないなら、MediatR はメソッド呼び出しの上の間接化レイヤーとして機能しており、それを取り除くのは、コードをよりたどりやすくし、依存関係を1つ減らし、ライセンスの問題を一手で消す機械的なリファクタリングです。これは [System.Text.Json vs Newtonsoft.Json（2026年）](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) で同梱の選択肢を選ぶ背後にあるのと同じ、ライブラリの合理化の本能です。

## 結論を一行で

2026年の新規 .NET 11 コードでは、単純なサービスクラスを書き、インターフェースを直接注入してください。定義へ移動、すぐに失敗する起動時の結線、呼び出しごとのオーバーヘッドなし、trimming への親和性、そしてライセンスの露出ゼロが得られます。MediatR を残すのは、その pipeline behaviors が多数のリクエスト型にわたって現実的で一様な仕事をしているときだけにし、その場合は意図的に決めてください。500万未満なら Community エディションのもとで無料でとどまり、超えていてパイプラインが請求に見合うなら支払い、12.5.0 への固定は応急処置としてだけにします。誤りは、「MediatR が商用になった」を非・出来事として扱うことでも、五重の警報の火事として扱うことでもあります。どちらでもありません。それは、そもそもメディエーターが必要だったのかを問い直すきっかけであり、大半のリクエストディスパッチのコードにとって、その答えは最初からノーでした。

## 関連

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json（2026年）](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## 出典

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - 2025-07-02 のリリース告知、v13.0 の境界、デュアルの RPL-1.5 / 商用モデル。
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - 収益500万・資本1000万の Community しきい値、「プログラム的アクセス」による開発者の数え方、ログ出力のみのライセンスチェック。
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - 古いバージョンが元のオープンソースライセンスのままであることの確認。
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - 最初のデュアルライセンスのリリース。
- [Scrutor on GitHub](https://github.com/khellang/Scrutor) - pipeline behaviors をデコレーターで置き換えるために使う MIT ライセンスの `Decorate` 拡張。
</content>
