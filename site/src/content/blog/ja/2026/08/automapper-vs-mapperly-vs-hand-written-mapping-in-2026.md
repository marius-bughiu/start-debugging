---
title: "AutoMapper と Mapperly と手書きマッピングの比較 (2026年版)"
description: "新しい .NET コードでは Mapperly が既定の選択です。手書きマッピングと同等の速度で、Native AOT でも動作し、マップ漏れをコンパイル時に検出します。ProjectTo では AutoMapper が依然として優位です。ベンチマークとライセンスのしきい値付き。"
pubDate: 2026-08-31
template: vs
tags:
  - "comparison"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet"
  - "performance"
lang: "ja"
translationOf: "2026/08/automapper-vs-mapperly-vs-hand-written-mapping-in-2026"
translatedBy: "claude"
translationDate: 2026-08-31
---

2026年に新しい .NET コードを書くなら **Mapperly** を使ってください。ビルド時にプレーンな C# を生成し、手書きマッピングの3%以内の速度で動き、Native AOT でも警告なく発行でき、マップし忘れたプロパティを「静かな空文字列」ではなくコンパイラーの診断に変えます。マップが20個程度より少ないプロジェクトや、ソースとターゲットの形が本当に食い違う場合は**手書き**にしてください。**AutoMapper** を残すのは、大規模な EF Core コードベースで `ProjectTo` が中核になっていて、かつ無料の Community 枠に該当する場合だけです。年間売上が 5,000,000 USD を超えると、ライセンスがこの判断を購買稟議に変えてしまうからです。

以下の数値はすべて Apple M4 (10コア) 上で、.NET SDK 10.0.302、ターゲット `net10.0`、AutoMapper 16.2.0 (2026-07-02 リリース)、Riok.Mapperly 4.3.1 (2025-12-22 リリース)、BenchmarkDotNet 0.15.8 で計測しました。

## 比較表

| | AutoMapper 16.2.0 | Mapperly 4.3.1 | 手書き |
| --- | --- | --- | --- |
| ライセンス | RPL-1.5 コピーレフトまたは有償の商用 | Apache 2.0 | なし |
| 売上 5,000,000 USD 超での費用 | 年間 799 から 6,399 USD | 無料 | 無料 |
| マッピングの生成方法 | 初回利用時のリフレクションとコンパイル済み式ツリー | ビルド時の Roslyn ソースジェネレーター | あなた |
| マップされていないターゲットメンバー | 無言、`AssertConfigurationIsValid()` でのみ検出 | 警告 `RMG012`、エラーに昇格可能 | コンパイラーも何も言わない |
| マップされていないソースメンバー | まったく報告されない | 警告 `RMG020` | 報告されない |
| Native AOT での発行 | `IL2104` と `IL3053`、起動時にクラッシュ | 警告ゼロ、動作する | 警告ゼロ、動作する |
| 初回マッピングのコールドコスト | 3マップで約33 ms | 約1 ms | 0 |
| 単一オブジェクトのマッピング | 105.79 ns | 60.44 ns | 58.48 ns |
| EF Core の射影 | 明示的展開、パラメーター、再帰深度に対応した `ProjectTo` | 生成された `IQueryable` 射影、いくつかの機能は非対応 | `Select` を自分で書く |
| 実行時の `Map(object, type)` | あり | なし | なし |
| デバッグ可能な出力 | コンパイル済み式ツリー | ステップインできる読める `.g.cs` | 自分のコード |

## すべての判断はライセンスを軸に決まる

2025-07-02 に Jimmy Bogard は AutoMapper と MediatR を Lucky Penny Software に移し、両方をライセンス変更しました。AutoMapper 15.0.0 以降はデュアルモデルで提供されます。オープンソース利用向けの [Reciprocal Public License 1.5](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) か、有償の商用ライセンスです。14.x 以前は今後も永久に MIT のままです。

RPL-1.5 は「手順が増えただけの MIT」ではありません。配布されたソフトウェアだけでなく、デプロイされたソフトウェアにも及ぶ強い相互コピーレフトなので、クローズドソースの商用製品が RPL ビルドの上で出荷するのは現実的ではありません。残るのは商用契約で、その無料の Community 枠は、年間総売上が 5,000,000 USD 未満で、かつ外部資本の調達額が 10,000,000 USD 未満であり、政府機関・準政府機関・高等教育機関でない組織が対象です。この線を超えると、[公開されている料金体系](https://automapper.io/)は、開発者1名から10名の Standard が年間 799 USD、11名から50名の Professional が年間 1,499 USD、開発者数無制限の Enterprise が年間 6,399 USD です。数えるのはライブラリを呼び出すコードを実際に書いて保守している開発者だけで、QA、デザイナー、フロントエンドの作業は含まれません。

ライセンスの強制は意図的に緩やかです。ライセンスサーバーもネットワーク呼び出しも機能ロックもありません。キーがない、または期限切れの場合はログメッセージが出るだけで、それ以上は何も起きません。16.2.0 からは `cfg.LicenseKey` の代わりに環境変数 `AUTOMAPPER_LICENSE_KEY` または `LUCKYPENNY_LICENSE_KEY` からキーを読み取ることもできます。ただし緩やかな強制は許諾と同じではなく、「ログの警告に気づかなかった」は購買レビューで誰も擁護したくないライセンス上の立場です。

これはメディエーター系ライブラリとまったく同じ分岐で、考え方もそのまま当てはまります。Community 枠と RPL-1.5 の義務の詳細は [MediatR とプレーンなサービスクラスの比較 (2026年版)](/ja/2026/05/mediatr-vs-plain-service-classes-in-2026/) を参照してください。

## Mapperly を選ぶべき場合

- **トリミングや Native AOT で発行するもの全般。** これは好みではなく、越えられない条件です。後述の AOT の節を参照してください。
- **サーバーレスや短命なプロセス。** 構築すべき構成オブジェクトがないため、Mapperly は起動時に何のコストもかかりません。
- **DTO のずれが現実的なリスクになるコードベース。** エンティティに追加されたのに DTO に反映されていない新しい列は、ビルド時に `RMG020` を出します。AutoMapper はそれについて一切触れません。
- **マッピングを読みたいチーム。** Mapperly は開いて差分を取り、デバッガーでたどれる `.g.cs` ファイルを書き出します。

## 手書きマッピングを選ぶべき場合

- **対象範囲が小さいとき。** マップが20個程度までなら、型ごとの静的な `ToDto` メソッドのほうが、ジェネレーターとその属性の語彙一式より仕掛けが少なく、誰も驚かせません。
- **形が本当に異なるとき。** ほとんどのメンバーに `MapFrom`、`IValueResolver`、条件分岐が必要なら、どちらのライブラリも「結局書くはずだったメソッドの、より悪い書き方」に退化します。
- **公開 API の契約。** バージョン管理された通信フォーマットとしての DTO は、フィールドごとの代入が差分に現れる明示的でレビュー可能なマッピングに値します。
- **ビルド時の依存をゼロにしたいレイヤー。** Mapperly はソースジェネレーターなのでビルドに参加しますが、静的メソッドは参加しません。

## AutoMapper を残すべき場合

- **`ProjectTo` の上に築かれた大規模な EF Core コードベース。** AutoMapper の queryable 拡張は、明示的展開、匿名オブジェクトによる実行時のパラメーター化、自己参照モデル向けの `RecursiveQueriesMaxDepth`、多態的マッピングに対応しています。Mapperly の射影は一般的なケースは押さえていますが、object factory、`ByName` の列挙型戦略、参照の追跡、ディープクローンには明示的に非対応で、ユーザー定義メソッドをインライン化できない場合は `RMG068` を報告します。
- **Community のしきい値を下回っていて、マップがすでに動いているとき。** 呼び出しあたり 45 ns を節約するために動作中の200個のマップを書き直すのは、事業上の理由になりません。
- **動的で型なしのマッピング。** `mapper.Map(source, sourceType, destType)` にソース生成の等価物はありません。実行時に型を発見するプラグイン機構があるなら、AutoMapper は Mapperly が構造的にできないことをしています。

移行すると決めたなら、手順は [AutoMapper から Mapperly のソース生成マッピングへ移行する](/ja/2026/05/migrate-from-automapper-to-source-generated-mapping/) に段階を追って書いてあります。

## ベンチマーク

モデルは、5つのスカラーメンバー、ネストした `Customer`、5つの `OrderLine` の子、そして文字列名にマップされる列挙型を持つ `Order` です。`[MemoryDiagnoser]` を付け、既定のジョブを使い、AutoMapper の式のコンパイルは `[GlobalSetup]` で温めてあるので、計測されるのは初回呼び出しのコストではなく定常状態のスループットです。

```csharp
// .NET SDK 10.0.302, net10.0, C# 14
// AutoMapper 16.2.0, Riok.Mapperly 4.3.1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
public class MappingBenchmarks
{
    private Order _order = null!;
    private List<Order> _orders = null!;
    private IMapper _autoMapper = null!;
    private OrderMapper _mapperly = null!;

    [GlobalSetup]
    public void Setup()
    {
        _order = MakeOrder(1);
        _orders = Enumerable.Range(1, 1000).Select(MakeOrder).ToList();

        var config = new MapperConfiguration(
            cfg => cfg.AddProfile<OrderProfile>(),
            NullLoggerFactory.Instance);
        _autoMapper = config.CreateMapper();
        _mapperly = new OrderMapper();

        _autoMapper.Map<OrderDto>(_order); // warm the expression compilation
    }

    [Benchmark(Baseline = true)]
    public OrderDto HandWritten_Single() => HandMapper.ToDto(_order);

    [Benchmark]
    public OrderDto Mapperly_Single() => _mapperly.ToDto(_order);

    [Benchmark]
    public OrderDto AutoMapper_Single() => _autoMapper.Map<OrderDto>(_order);
}
```

Apple M4、物理10コア、.NET 10.0.10 Arm64 RyuJIT での結果:

| メソッド | 平均 | Ratio | 割り当て | 割り当て比 |
| --- | ---: | ---: | ---: | ---: |
| HandWritten_Single | 58.48 ns | 1.00 | 624 B | 1.00 |
| Mapperly_Single | 60.44 ns | 1.03 | 624 B | 1.00 |
| AutoMapper_Single | 105.79 ns | 1.81 | 704 B | 1.13 |
| HandWritten_1000 | 72,696 ns | 1.00 | 632,091 B | 1.00 |
| Mapperly_1000 | 77,334 ns | 1.06 | 672,093 B | 1.06 |
| AutoMapper_1000 | 103,376 ns | 1.42 | 720,640 B | 1.14 |

正直に読んでください。オブジェクトあたり45ナノ秒は、乗り換えるべき理由にはなりません。1,000件の注文をマップするリクエストでも差は合計31マイクロ秒で、データベースへの1往復の隣では見えません。パフォーマンスの議論が効いてくるのはオブジェクト数が非常に多い場合だけで、Mapperly を選ぶ3つの理由のうち最も弱いものです。

1,000オブジェクトのケースで Mapperly と手書きの間にある 40,000 バイトの差は、理解しておく価値のある実在の現象です。Mapperly は生成するネストしたコレクション用マッパーの引数を `IReadOnlyCollection<T>` に広げます。

```csharp
// Riok.Mapperly 4.3.1 generated output, trimmed
private List<OrderLineDto> MapToListOfOrderLineDto(IReadOnlyCollection<OrderLine> source)
{
    var target = new List<OrderLineDto>(source.Count);
    foreach (var item in source)
        target.Add(MapToOrderLineDto(item));
    return target;
}
```

`List<T>` をインターフェース越しに列挙すると構造体の列挙子がボックス化されます。注文あたり40バイト、バッチ全体で 40,000 バイトです。ネストしたコレクションのマッパーを具体的な `List<OrderLine>` の引数で自分で宣言すれば、これはなくなります。生成コードがディスク上にあるからこそ見つけて直せる、まさにこの種のことが、ソースジェネレーターとコンパイル済み式ツリーの実務上の違いです。

## 判断を決めてしまう落とし穴: Native AOT

`net10.0` で `<PublishAot>true</PublishAot>` を付けて AutoMapper 16.2.0 を呼ぶコンソールアプリを発行すると、ビルドが警告します。

```text
AutoMapper.dll : warning IL2104: Assembly 'AutoMapper' produced trim warnings.
AutoMapper.dll : warning IL3053: Assembly 'AutoMapper' produced AOT analysis warnings.
```

警告は無視しやすいものです。しかし出来上がったバイナリはそうはいきません。

```text
Unhandled exception. System.TypeInitializationException: A type initializer threw an exception.
 ---> System.ArgumentNullException: Value cannot be null. (Parameter 'method')
   at System.Linq.Expressions.Expression.Call(MethodInfo, Expression)
   at AutoMapper.Execution.ExpressionBuilder..cctor()
   at AutoMapper.MapperConfiguration..ctor(MapperConfigurationExpression, ILoggerFactory)
```

トリマーが `ExpressionBuilder` がリフレクションで探すメソッドを削除したため、最初のマッピングに到達する前に静的コンストラクターが死にます。同じ設定で発行した Mapperly 版のアプリは IL 警告ゼロで、1.1 MB のネイティブバイナリを生成し、動作します。これは呼び出し側に `DynamicDependency` 属性を付けて解決できる調整の問題ではありません。実行時に式ツリーからマップを組み立てるという性質そのものであり、[trim-safe なコードとは何か、どう書くか](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) で説明したのと同じ罠です。Native AOT がロードマップにあるなら、判断はすでに決まっています。

同じ影響の穏やかな版がコールドスタートです。構成を組み立てて3つの型の最初のマッピングを実行するのに、このマシンでは33ミリ秒かかりました。`new OrderMapper()` と最初の呼び出しなら1ミリ秒です。長時間動く Web アプリでは見えませんが、Lambda ではコールド実行の測定可能な一部になります。だからこそ [.NET の AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) で取り上げています。

## 安全性の差が実際に表れるところ

DTO に `Slug` プロパティを足して、マップするのを忘れてみてください。AutoMapper 16.2.0 はそれでもオブジェクトをマップします。

```text
map ok: Id=1 Name=n Slug=''
```

`AssertConfigurationIsValid()` は確かに検出し、"Unmapped members were found" を含む `AutoMapperConfigurationException` を投げます。ただし呼び出すのを覚えていた場合に限り、しかもマップされていない*ターゲット*メンバーについてだけです。どの DTO にも届かなくなったソースプロパティはまったく報告されません。

Mapperly は両方向をビルド時に、実際のメッセージ文で報告します。

```text
warning RMG020: The member InternalNote on the mapping source type Diag.Source
                is not mapped to any member on the mapping target type Diag.Target
warning RMG012: The member Slug on the mapping target type Diag.Target
                was not found on the mapping source type Diag.Source
```

既定では警告なので、騒がしいビルドでは埋もれてしまいます。`.editorconfig` で昇格させれば、ビルドはきっぱり失敗します。

```ini
[*.cs]
dotnet_diagnostic.RMG012.severity = error
dotnet_diagnostic.RMG020.severity = error
```

この設定こそが、Mapperly を「速い AutoMapper」から別種の道具へ変えるものです。マッピングのバグは本番障害ではなくビルドの失敗になります。同時にこれは、[ソースジェネレーター](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) がビルド時の依存に見合う理由の最も明快な例でもあります。

念のため書いておくと、手書きマッピングにはそうしたチェックはありません。`ToDto` メソッドでの代入漏れは AutoMapper とまったく同じくらい静かです。その安全性はコードレビューで見えることから来るもので、ツールから来るものではありません。

## 結論

新しいコードでは既定で Mapperly を選び、初日から `RMG012` と `RMG020` をエラーに昇格させて、実際に恩恵を受けられるようにしてください。プロジェクトが小さいか形が不規則なら手書きにし、ツールによるチェックをレビューのしやすさと引き換えにしていると理解してください。AutoMapper を残すのは、`ProjectTo` を多用する成熟したコードベースがすでに動いていて、Community のしきい値を下回っていて、Native AOT がロードマップにない場合です。この3つのどれか1つでも成り立たなくなったら、ライセンスを予算化するのではなく移行を始めてください。パフォーマンスの表はこの比較で最も面白くない部分です。コードベースの振る舞いを実際に変えるのは、トリミング時の安全性とビルド時の診断です。

## 関連記事

- [AutoMapper から Mapperly のソース生成マッピングへ移行する](/ja/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [解決: 'MapperConfiguration' に引数を1個指定できるコンストラクターがない](/ja/2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments/)
- [MediatR とプレーンなサービスクラスの比較 (2026年版)](/ja/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [ソースジェネレーターとは何か、いつ必要になるのか](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [Native AOT とは何か、そして何を犠牲にするのか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)

## 参考リンク

- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - 15.0.0 という境界、売上 5,000,000 USD と資本 10,000,000 USD という Community のしきい値、開発者の数え方。
- [AutoMapper LICENSE.md](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) - RPL-1.5 または商用というデュアルライセンスの条文。
- [AutoMapper のライセンス設定ドキュメント](https://docs.automapper.io/en/latest/License-configuration.html) - `AUTOMAPPER_LICENSE_KEY` と `LUCKYPENNY_LICENSE_KEY` の検出、およびログのみの強制モデル。
- [AutoMapper Queryable Extensions](https://docs.automapper.io/en/latest/Queryable-Extensions.html) - `ProjectTo` の明示的展開、パラメーター化、「チェーンの最後の呼び出しでなければならない」という制約。
- [Mapperly の queryable 射影](https://mapperly.riok.app/docs/configuration/queryable-projections/) - 非対応機能の一覧とインライン化の診断 `RMG068`。
- [Mapperly のアナライザー診断](https://mapperly.riok.app/docs/configuration/analyzer-diagnostics/) - `RMG012`、`RMG020`、`.editorconfig` での重大度の昇格。
- [NuGet の Riok.Mapperly](https://www.nuget.org/packages/Riok.Mapperly) - 4.3.1 のリリース日と Apache 2.0 ライセンス。
- [NuGet の AutoMapper](https://www.nuget.org/packages/AutoMapper) - 16.2.0 のリリース日とバージョン履歴。
