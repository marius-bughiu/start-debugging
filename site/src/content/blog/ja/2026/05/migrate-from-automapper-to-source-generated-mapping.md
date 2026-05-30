---
title: "AutoMapper から Mapperly のソース生成マッピングへ移行する"
description: "AutoMapper 15 の Profile、IMapper、ForMember、ProjectTo を .NET 11 の Riok.Mapperly 4.3 が生成するマッパーに置き換えるためのステップバイステップのチェックリスト。"
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/migrate-from-automapper-to-source-generated-mapping"
translatedBy: "claude"
translationDate: 2026-05-30
---

AutoMapper をソースジェネレーターに置き換えるのは、書き直しではなく、ファイルごとの機械的なリファクタリングです。いくつかの `Profile` クラスに 30-80 件のマッピングが散らばった典型的なサービスなら、半日から 1 日を見込んでください。各 `CreateMap<Source, Dest>()` は `[Mapper]` クラスの `partial` メソッドになり、`IMapper.Map<T>` の呼び出しは直接のメソッド呼び出しになり、`ProjectTo<T>()` は生成された `IQueryable` 拡張になります。壊れるのは、AutoMapper の実行時の柔軟性に依存していたものすべてです。動的な `Map(object)` 呼び出し、注入されたサービスを持つ `IValueResolver`、そしてアセンブリスキャンによる登録です。これを行う価値があるのは、AutoMapper の売上高 5,000,000 USD のラインを超えていてライセンスを購入したくない場合、Native AOT とトリミングを機能させたい場合、あるいはマッピングされていないプロパティを実行時に黙って破棄するのではなくビルドで失敗させたい場合です。

参照するバージョン: このガイドは、AutoMapper 14.x（最後の MIT リリース）と 15.0（Lucky Penny Software による Reciprocal Public License 1.5 / 商用のデュアルライセンスの最初のリリース）からの離脱を扱います。置き換え先は `<TargetFramework>net11.0</TargetFramework>` で、.NET 11 SDK、C# 14、Riok.Mapperly 4.3.1（2025-12-22 にリリース）を対象とします。そもそも離脱するかどうかをまだ検討している場合、これは MediatR と同じベンダーの話なので、並行するケースとして [MediatR から素の依存性注入への移行](/ja/2026/05/migrate-from-mediatr-to-plain-dependency-injection/) を読んでください。この記事は決定が済んでいることを前提とします。

## なぜチームは今まさに AutoMapper を離れるのか

- **ライセンスが 500 万 USD を超えると決断を迫る。** AutoMapper 15.0 は、相互的なコピーレフトライセンスである RPL-1.5 に加えて有料の商用層のもとでリリースされます。無償利用は、年間総売上高が 5,000,000 USD 未満の企業と非本番環境をカバーします。このラインを超えると、クローズドソースの商用ソフトウェアは RPL ビルドを利用できないため、購入するか離脱するかになります。MIT のもとで公開されたもの（14.x 以前）は永遠に MIT のもとで利用可能なままですが、修正は受け取れなくなります。
- **マッピングのエラーが実行時からコンパイル時に移る。** AutoMapper は、`AssertConfigurationIsValid()` を呼び出すか、実行時にマッピングに到達したときにのみ構成を検証します。Mapperly はマッピングされていないプロパティをコンパイル時の `RMG` 診断として報告するため、忘れられたフィールドは本番環境の `NullReferenceException` ではなく、ビルドの警告になります。
- **起動が安くなり、AOT が容易になる。** AutoMapper は最初の使用時にリフレクションでマッピング式を構築してコンパイルします。Mapperly はコンパイル時に素の C# を出力するため、起動コストもトリマーと戦うリフレクションもありません。これは [.NET 11 の AWS Lambda のコールドスタート時間を短縮する](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) ときや、[Native AOT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) を出荷するときに重要です。
- **生成されたコードを読める。** Mapperly は、不透明なコンパイル済みの式ツリーではなく、デバッガーでステップインできる読みやすい partial メソッドの本体を書きます。

## 何が壊れるか

| 領域 | 変更 | 深刻度 |
| --- | --- | --- |
| `IMapper` の注入 | 具体的な生成済みマッパークラスを直接注入する形に置き換え | 高 |
| `Profile` + `CreateMap<,>()` | 方向ごとに 1 つの `partial` メソッドを持つ partial な `[Mapper]` クラスに集約 | 高 |
| `ForMember(... MapFrom ...)` | `[MapProperty]` またはプライベートなマッピングメソッドに置き換え | 高 |
| `ReverseMap()` | 自動の逆変換はない。戻り方向のメソッドを明示的に宣言する | 中 |
| DI ありの `IValueResolver` / `ITypeConverter` | マッパーのコンストラクターとプライベートメソッドに置き換え | 中 |
| `ProjectTo<T>(config)` | 生成された `IQueryable<T>` 射影拡張に置き換え | 中 |
| `AddAutoMapper(assembly)` スキャン | 明示的な `AddSingleton<TMapper>()` 登録に置き換え | 中 |
| `mapper.Map(object, type)`（動的） | 実行時の型なしエントリーポイントはない。各マッピングは型付きメソッド | 高 |
| `AssertConfigurationIsValid()` テスト | 冗長。ビルドがアサーションになる | 低 |

## 事前チェックリスト

1. **.NET 11 SDK をインストール** し、`dotnet --version` が `11.0.x` を報告することを確認します。
2. **マッピングを棚卸しする。** `CreateMap<` を grep して構成の数を数え、`\.Map<` と `ProjectTo<` を grep して呼び出し箇所の数を数えます。これが移行の範囲です。
3. **動的なマッピングを見つける。** `Type` 引数または `object` のソースを渡す `Map(` 呼び出しを grep します。これらには Mapperly の直接の同等物がなく、型付きメソッドか手動の switch が必要です。まずこれらに対処してください。
4. **リゾルバーを見つける。** `IValueResolver`、`ITypeConverter`、`IMappingAction` を grep します。それぞれにマッパー上のプライベートメソッドが必要です。
5. **特別なバックアップは不要、通常どおりブランチを作成する。** この変更はファイルごとに元に戻せる（ロールバック計画を参照）ため、機能ブランチで十分です。

## 移行の手順

### 1. AutoMapper と並べて Mapperly を追加する

1 つずつ profile を移行できるよう、両方のパッケージをインストールします。

```bash
# .NET 11 SDK, run from the project directory
dotnet add package Riok.Mapperly --version 4.3.1
```

Mapperly はアナライザーと `Riok.Mapperly.Abstractions` の属性のみを提供するため、ランタイムの依存関係を追加しません。ビルドが引き続き成功することを確認してください。新しいエラーなしで `dotnet build` が通ること。最後の profile がなくなるまで、AutoMapper パッケージは参照したままにします。

### 2. 単純な profile を `[Mapper]` クラスに変換する

まず最小の profile を取り上げます。変更前:

```csharp
// AutoMapper 15.0
public class CarProfile : Profile
{
    public CarProfile()
    {
        CreateMap<Car, CarDto>();
    }
}
```

変更後は partial メソッドを持つ partial クラスです。Mapperly が本体を埋めます。

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
using Riok.Mapperly.Abstractions;

[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
}
```

検証: プロジェクトをビルドし、生成されたファイルを開きます（アナライザーの出力に現れます。あるいは `.csproj` に `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` を設定してディスクに書き出します）。`CarDto` のすべてのプロパティが代入されることを確認してください。代入されないものがあれば、Mapperly はマッピングされていないターゲットメンバーに対して `RMG020` のような診断を出力します。それは失敗ではなく機能です。

### 3. `ForMember` を `[MapProperty]` に変換する

AutoMapper のメンバーごとのカスタマイズは Mapperly の属性に対応します。名前の変更:

```csharp
// AutoMapper 15.0
CreateMap<Car, CarDto>()
    .ForMember(d => d.ModelName, o => o.MapFrom(s => s.Model));
```

は、ソースとターゲットのメンバーを指定する `[MapProperty]` 属性になります。

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[MapProperty(nameof(Car.Model), nameof(CarDto.ModelName))]
public partial CarDto ToDto(Car car);
```

計算値の場合、AutoMapper のインラインの `MapFrom` ラムダは、`Use` で参照されるプライベートなマッピングメソッドになります。

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => price.ToString("C");
}
```

プロパティを意図的に破棄するには、AutoMapper の `Ignore()` を `[MapperIgnoreTarget(nameof(CarDto.Internal))]` または `[MapperIgnoreSource(nameof(Car.Secret))]` に置き換えます。生成された本体が期待どおりのメンバーだけを代入することを確認して、各変換を検証してください。

### 4. `ReverseMap()` を明示的なメソッドに置き換える

AutoMapper の `ReverseMap()` は 1 回の呼び出しです。Mapperly には自動の逆変換がないため、戻り方向を同じマッパー上の独自のメソッドとして宣言します。

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
    public partial Car ToEntity(CarDto dto);
}
```

これはコード量が増えますが、正直です。逆マッピングはもはや暗黙ではないため、非対称なプロパティ（ソースのないターゲットフィールド）は黙って無視されるのではなく、独自の診断として現れます。両方の生成された本体を検証してください。

### 5. 依存関係を持つリゾルバーをマッパーのコンストラクターに移す

注入されたサービスを必要とする AutoMapper の `IValueResolver`:

```csharp
// AutoMapper 15.0
public class PriceResolver : IValueResolver<Car, CarDto, string>
{
    private readonly ICurrencyService _currency;
    public PriceResolver(ICurrencyService currency) => _currency = currency;
    public string Resolve(Car s, CarDto d, string m, ResolutionContext ctx)
        => _currency.Format(s.Price);
}
```

は、マッパーのコンストラクターとプライベートメソッドになります。Mapperly は、宣言したパラメーターを転送するコンストラクターを生成するため、マッパーは通常のコンストラクター注入に参加します。

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    private readonly ICurrencyService _currency;
    public CarMapper(ICurrencyService currency) => _currency = currency;

    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => _currency.Format(price);
}
```

テストでコンテナーからマッパーを解決し、整形された価格を確認して検証してください。

### 6. `ProjectTo<T>` を生成された射影に変換する

AutoMapper の `ProjectTo<T>()` は、EF Core がマッピングを SQL に変換できるように `Expression` ツリーを構築します。Mapperly は、`IQueryable<T>` を受け取って返すメソッドを宣言すると、同じ種類の `IQueryable` 拡張を生成します。

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public static partial class CarQueryMapper
{
    public static partial IQueryable<CarDto> ProjectToDto(this IQueryable<Car> q);
}
```

呼び出し箇所は `.ProjectTo<CarDto>(_config)` から `.ProjectToDto()` に変わります。

```csharp
// .NET 11, EF Core 11
var dtos = await db.Cars
    .Where(c => c.NumberOfSeats > 4)
    .ProjectToDto()
    .ToListAsync();
```

生成された SQL を取得し（`db.Cars...ToQueryString()` または EF Core のログ出力）、射影がメモリ内ではなくデータベースで実行されることを確認して検証してください。Mapperly の射影パスは、変換可能な式ツリーを生成しなければならないため、object factory やカスタムのオブジェクト生成メソッドを実行しないことに注意してください。

### 7. DI の登録を置き換える

AutoMapper の登録とアセンブリスキャンを削除します。

```csharp
// AutoMapper 15.0 - remove this
builder.Services.AddAutoMapper(typeof(CarProfile).Assembly);
```

各マッパーを明示的に登録します。注入された依存関係を持たないマッパーはステートレスでスレッドセーフなので、singleton として登録します。scoped な依存関係を持つマッパーは、そのライフタイムに合わせる必要があります。

```csharp
// .NET 11
builder.Services.AddSingleton<CarMapper>();        // no dependencies
builder.Services.AddScoped<InvoiceMapper>();       // depends on a scoped service
```

次に、コンシューマーを `IMapper` から具体的なマッパーに変更します。`_mapper.Map<CarDto>(car)` は `_carMapper.ToDto(car)` になります。静的マッパーは登録がまったく不要です。`CarQueryMapper.ProjectToDto(query)` を直接呼び出してください。アプリが起動することを確認します。登録の欠落は、いまや起動時の `InvalidOperationException` になります。これはまさに望ましい早期の失敗です。

### 8. AutoMapper を削除する

`using AutoMapper` と `CreateMap<` の grep が何も返さなくなったら、パッケージを削除します。

```bash
dotnet remove package AutoMapper
```

クリーンな `dotnet build` と完全な `dotnet test` の実行で検証してください。

## 検証

最後の profile がなくなったら、このチェックリストを実行します。

- `dotnet build` がエラーゼロを出し、各 `RMG` 診断を見直して、マッピングされていないメンバーの警告を意図的なものとして扱うか修正している。
- `dotnet test` が失敗ゼロで通る。以前 `AssertConfigurationIsValid()` を呼び出していたテストも含む（それらは削除してください。いまやビルドがアサーションです）。
- 射影クエリが引き続き SQL に変換される。`ToQueryString()` で、どの `ProjectToDto()` もクライアント側評価にフォールバックしていないことを確認する。
- AOT またはトリミングされたビルドでは、`dotnet publish -c Release` が、以前は AutoMapper のリフレクションから出ていた `IL2xxx` トリミング警告を出さない。
- コールドスタートに敏感なワークロードが、測定可能なほど速く起動する。最初のマッピングはもう式のコンパイルコストを払わない。

## ロールバック計画

この移行はファイルごとに元に戻せます。これが主な安全性の特性です。手順 7 まで AutoMapper を参照したままにしておいたため、誤動作する個々のマッパーは、その `Profile` を復元し、その 1 つのコンシューマーを `IMapper` に戻すことで元に戻せます。2 つのシステムは競合なく共存します。唯一の不可逆な瞬間は、手順 8 のパッケージの削除です。すべてのコンシューマーが変換され、テストスイート全体が緑になるまで、AutoMapper を削除しないでください。不安なら、マッパーの変換を 1 つのリリースで、パッケージの削除を次のリリースで出荷してください。

## ぶつかった落とし穴

- **意図的に破棄したかったプロパティでの `RMG020`。** Mapperly は、ソースメンバーがどこにもマッピングされないと警告します。診断をグローバルに抑制するのではなく、`[MapperIgnoreSource(...)]` で意図的に黙らせてください。そうすれば、次の意図しない破棄は引き続き警告されます。
- **フラット化は期待どおりには自動ではない。** AutoMapper は命名規則によって `Order.Customer.Name` を `OrderDto.CustomerName` にフラット化します。Mapperly はネストしたメンバーのフラット化をサポートしますが、DTO の名前がドット区切りのソースパスと一致しない場合は、`[MapProperty([nameof(Order.Customer), nameof(Customer.Name)], nameof(OrderDto.CustomerName))]` で明示的に書く必要があります。
- **型なしの `Map(object, Type)` はない。** `object` を実行時の `Type` にマッピングする汎用パイプラインがあった場合、ソース生成の同等物はありません。ペアごとの型付きメソッドに置き換えるか、小さな手書きの switch を維持してください。これはクリーンな置き換えが不可能な唯一の場所です。
- **`init` と主コンストラクターを持つ `record` ターゲット。** Mapperly は、ターゲットが `record` または `init` セッターのみを持つ場合、コンストラクターを通じてマッピングします。これは通常望ましい挙動です。間違ったコンストラクターを選ぶ場合は、`[MapperConstructor]` で曖昧さを解消してください。ここでの AutoMapper の挙動はより緩かったため、以前は動いていたマッピングが本物の曖昧さを表面化させることがあります。ターゲットの形状については [C# の record 対 class 対 struct](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) を参照してください。
- **enum のマッピングは名前についてより厳格。** Mapperly はデフォルトで enum を値でマッピングし、マッピングされていない enum メンバーについて警告できます。一方 AutoMapper は整数を黙って通していました。`[MapEnum]` 戦略で、値による方法と名前による方法を明示的に決めてください。

本番環境で信頼する前に、ジェネレーターがこれをコンパイル時にどう行うかを理解したい場合、その仕組みは [INotifyPropertyChanged 向けのソースジェネレーターの書き方](/ja/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) で扱っているものと同じです。

## 出典

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/), Jimmy Bogard
- [AutoMapper and MediatR Licensing Update](https://www.jimmybogard.com/automapper-and-mediatr-licensing-update/), Jimmy Bogard
- [Mapperly のドキュメント: 構成と queryable 射影](https://mapperly.riok.app/docs/configuration/mapper/)
- [GitHub の riok/mapperly](https://github.com/riok/mapperly) と [NuGet の Riok.Mapperly 4.3.1](https://www.nuget.org/packages/Riok.Mapperly)
