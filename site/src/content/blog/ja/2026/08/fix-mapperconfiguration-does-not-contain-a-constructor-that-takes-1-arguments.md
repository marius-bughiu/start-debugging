---
title: "解決方法: 'MapperConfiguration' does not contain a constructor that takes 1 arguments"
description: "AutoMapper 15 は引数1つの MapperConfiguration コンストラクターを削除しました。第2引数に ILoggerFactory を渡し、すべての AddAutoMapper 呼び出しに構成アクションを追加してください。"
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "automapper"
  - "migration"
lang: "ja"
translationOf: "2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments"
translatedBy: "claude"
translationDate: 2026-08-18
---

`new MapperConfiguration(cfg => ...)` はもうコンパイルできません。AutoMapper 15.0 が引数1つのコンストラクターを削除したためです。第2引数に `ILoggerFactory` を渡してください。つまり `new MapperConfiguration(cfg => ..., loggerFactory)`、テストでは `NullLoggerFactory.Instance` です。同じリリースは構成アクションを受け取らない `AddAutoMapper` のオーバーロードもすべて削除したため、`services.AddAutoMapper(typeof(Program))` も同じビルドで別のエラーコードとともに壊れます。

以下の内容はすべて、.NET SDK 10.0.201 上でターゲット `net10.0` として AutoMapper 15.1.3 および 16.2.0 で検証しています。この変更は [15.0.0 (2025-07-02)](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0) で入り、16.2.0 でも API の形は変わっていません。

## エラーの実際の姿

```text
Repro.cs(11,26): error CS1729: 'MapperConfiguration' does not contain a constructor that takes 1 arguments
```

依存性注入で AutoMapper を登録している場合、同じビルドでたいてい次の2つのエラーも出ます。これらは同じ破壊的変更が別の姿で現れたものです。

```text
Repro.cs(15,32): error CS1503: Argument 2: cannot convert from 'System.Type' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
Repro.cs(16,32): error CS1503: Argument 2: cannot convert from 'System.Reflection.Assembly' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
```

エラーは3つ、原因は1つです。コンストラクターだけ直してもビルドは赤いままです。

## なぜ引数1つのコンストラクターが消えたのか

AutoMapper 15 はライセンスキーとライセンス状態のログ出力を追加しました。そのログには書き込み先が必要です。静的ロガーや暗黙のシンクに頼るのではなく、メンテナーは依存関係を明示的にしました。`MapperConfiguration` は書き込み先となる `ILoggerFactory` を受け取るようになったのです。Jimmy Bogard は [issue #4542 で](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542)、これが意図的な破壊的変更であること、そして当初のリリースノートから漏れていたことを認めています。多くの人が何を検索すればよいか分からないまま踏み抜くのはそのためです。

出荷されたアセンブリをリフレクションで調べると差分が具体的になります。AutoMapper 14.0.0 が公開しているのは次のとおりです。

```text
// AutoMapper 14.0.0
MapperConfiguration.ctor(MapperConfigurationExpression)
MapperConfiguration.ctor(Action`1)
```

AutoMapper 15.1.3 と 16.2.0 はどちらも次を公開しています。

```text
// AutoMapper 15.1.3 and 16.2.0
MapperConfiguration.ctor(MapperConfigurationExpression, ILoggerFactory)
MapperConfiguration.ctor(Action`1, ILoggerFactory)
```

`ILoggerFactory` 引数に既定値を持つオーバーロードは存在しないため、以前の呼び出し箇所をコンパイルできる状態に保つ方法はありません。直接生成しているところはすべて手を入れる必要があります。

## 最小限の再現コード

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;

public record Source(int Id, string Name);
public record Dest(int Id, string Name);

public class Repro
{
    public void OldStyle()
    {
        // error CS1729
        var config = new MapperConfiguration(cfg => cfg.CreateMap<Source, Dest>());
        var mapper = config.CreateMapper();
    }
}
```

`<PackageReference Include="AutoMapper" Version="15.1.3" />` だけを書いた `csproj` で再現します。これはコンパイル時だけの破壊である点に注意してください。マッピングエンジンには何の変更もないので、呼び出し箇所がコンパイルできるようになれば、マッピングの挙動は 14 のときとまったく同じです。

## 依存性注入の外では ILoggerFactory に何を渡せばよいですか

静的なマッパー構成、テストフィクスチャ、ホストのないコンソールツールでは、`Microsoft.Extensions.Logging.Abstractions` の `NullLoggerFactory.Instance` が正解です。AutoMapper はすでに `Microsoft.Extensions.Logging.Abstractions` に依存しているので、追加するパッケージはありません。

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;
using Microsoft.Extensions.Logging.Abstractions;

public static class Maps
{
    public static readonly MapperConfiguration Config = new(
        cfg =>
        {
            cfg.LicenseKey = "<your key>";
            cfg.AddProfile<MyProfile>();
        },
        NullLoggerFactory.Instance);

    public static readonly IMapper Mapper = Config.CreateMapper();
}
```

静的な `MapperConfiguration` は今もサポートされたパターンです。それが issue #4542 のもう1つの懸念でしたが、Bogard は直接答えています。静的インスタンスで問題なく、ライセンスキーはリテラルに埋め込まずに `IConfiguration` やシークレットストアから取得できます。

`AssertConfigurationIsValid()` はこれまでどおり構成オブジェクトにぶら下がっているので、検証テストはコンストラクター以外の変更を必要としません。

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
[Fact]
public void Mapping_configuration_is_valid()
{
    var config = new MapperConfiguration(
        cfg => cfg.AddProfile<MyProfile>(),
        NullLoggerFactory.Instance);

    config.AssertConfigurationIsValid();
}
```

テスト実行時にライセンス診断を見たい場合は、`NullLoggerFactory.Instance` を実際のファクトリーに差し替えてください。この引数の用途はそれだけです。

## 同時に壊れた AddAutoMapper の呼び出しはどう直しますか

構成アクションを取らない `AddAutoMapper` のオーバーロードは 15.0 ですべて削除されました。`Microsoft.Extensions.DependencyInjection.ServiceCollectionExtensions` の public static メンバーをバージョン間で比較すると、次の3つが消えています。

```text
// Present in AutoMapper 14.0.0, gone in 15.0.0 and later
AddAutoMapper(IServiceCollection, Assembly[])
AddAutoMapper(IServiceCollection, Type[])
AddAutoMapper(IServiceCollection, IEnumerable<Assembly>, ServiceLifetime)
```

つまり構成アクションは必須になり、常に2番目に来ます。

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3, ASP.NET Core minimal host
var builder = WebApplication.CreateBuilder(args);

// Before (AutoMapper 14):
// builder.Services.AddAutoMapper(typeof(Program));

// After:
builder.Services.AddAutoMapper(
    cfg => cfg.LicenseKey = builder.Configuration["AutoMapper:LicenseKey"],
    typeof(Program));
```

アクションに書くことがなければ、空のラムダで構いません。`services.AddAutoMapper(_ => { }, typeof(Program))` は有効です。位置引数としては依然として必須です。

依存性注入の経路では `ILoggerFactory` が自動的に供給されるので、手作業で組み立てる `MapperConfiguration` はありません。何が登録されるかは知っておく価値があります。ライフタイムが非対称だからです。

```text
// Registered by AddAutoMapper, AutoMapper 15.1.3
AutoMapper.IConfigurationProvider -> Singleton
AutoMapper.IMapper               -> Transient
```

高価なオブジェクト、つまりコンパイル済みの構成がシングルトンです。`IMapper` はその上に乗る安価な transient のラッパーで、だからこそ `IMapper` を scoped や transient のサービスに注入してもコストはなく、[シングルトンから scoped サービスを使う captive dependency の問題](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)にも陥りません。

`IServiceProvider` を渡してくれるオーバーロードもあります。キーが生の構成ではなくサービスの背後にある場合に便利です。

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
services.AddAutoMapper(
    (sp, cfg) => cfg.LicenseKey = sp.GetRequiredService<ILicenseStore>().AutoMapperKey,
    typeof(MyProfile));
```

## その直後に 'No service for type ILoggerFactory has been registered' が出たらどうしますか

コンストラクターを直してビルドが緑になった直後、実行時にテストが吹き飛びます。

```text
System.InvalidOperationException: No service for type 'Microsoft.Extensions.Logging.ILoggerFactory' has been registered.
```

これは、AutoMapper が今必要とするロガーファクトリーを DI 登録が取りに行っているところです。ASP.NET Core アプリでは見ることがありません。`WebApplicationBuilder` が、あなたが `AddAutoMapper` を呼ぶより前にログ出力を組み立ててしまうからです。目にするのは、素の `ServiceCollection` を組み立てる単体テストや小さなコンソールアプリです。

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - throws on resolve
var services = new ServiceCollection();
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

1行で直ります。

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - resolves
var services = new ServiceCollection();
services.AddLogging();                       // this is the missing piece
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

このエラーメッセージは十分に一般的なので、[DbContextOptions の登録漏れ](/ja/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)が見当違いのファイルを探させるのと同じように、別のバグとして追いかけてしまいがちです。AutoMapper 15 に上げたのと同じコミットで出たのなら、原因はこれです。

## ライセンスキーを一度も設定しないと実際どうなるか

何も壊れません。AutoMapper 15.1.3 は、キーが一切なくても、無効なキーでも、空文字列でも、平然とオブジェクトをマッピングします。得られるのは `LuckyPennySoftware.AutoMapper.License` カテゴリのログメッセージだけです。

```text
warn: LuckyPennySoftware.AutoMapper.License[0]
      You do not have a valid license key for the Lucky Penny software AutoMapper. This is allowed for
      development and testing scenarios. If you are running in production you are required to have a
      licensed version. Please visit https://luckypennysoftware.com to obtain a valid license.
```

これが強制メカニズムのすべてであり、`ILoggerFactory` 引数が存在しなければならなかった理由でもあります。ドキュメントは、ログメッセージ以外にライセンスの強制は一切ないと明言しています。これは技術的な関門ではなく法的な義務なので、この警告は黙らせるべき実行時の問題ではなく、コンプライアンス上の項目として扱ってください。

多くの人が半日を費やす細かい点が1つあります。不正な形式のキーは、警告の前に critical レベルで JWT の解析失敗とともに記録されます。キーが署名済みの JWT だからです。

```text
crit: LuckyPennySoftware.AutoMapper.License[0]
      Error validating the Lucky Penny software license key
      Microsoft.IdentityModel.Tokens.SecurityTokenMalformedException: IDX14100: JWT is not well formed,
      there are no dots (.).
```

ログ基盤が `Critical` でページャーを鳴らす構成なら、環境変数に入った切り詰められたキーや空白の混じったキーが誰かを叩き起こす一方で、アプリケーション自体は正常に動き続けます。AutoMapper が壊れたと判断する前に、この文字列を探してください。

キーについて実務的な注意をあと2つ。1つ目に、`cfg.LicenseKey` は文書化された唯一の経路ではありません。ドキュメントは環境変数 `AUTOMAPPER_LICENSE_KEY` と `LUCKYPENNY_LICENSE_KEY` を挙げており、コード内の明示的な値の次にこの順で解決されるとしています。ただし私の 15.1.3 での検証では、どちらの環境変数も読み取られませんでした。各変数に意図的に不正な値を入れても、明示的な `cfg.LicenseKey` が引き起こす JWT 解析エラーは一度も出ず、ライセンス未取得の一般的な警告だけが出たからです。15.x 系ではキーをコードで設定し、構成から読み込んでください。2つ目に、AutoMapper 16.2.0 は同じ検証でライセンス関連のメッセージを一切記録しませんでした。警告が出ないことをキーが受理された証拠と読まないでください。

## 代わりに AutoMapper 14 に固定すべきですか

これは issue のスレッドで最もよく提案される回避策ですが、2026-03 以降は悪手です。AutoMapper 14.0.0 と 15.1.1 未満のすべてには [GHSA-rvv3-g6hj-g44x](https://github.com/advisories/GHSA-rvv3-g6hj-g44x) があります。深刻度 High (CVSS 7.5) の制御されない再帰の問題で、深くネストしたオブジェクトグラフや自己参照するグラフをマッピングするとスタックを使い切り、キャッチできない `StackOverflowException` でプロセスごと落ちます。信頼できない入力がマッピング対象の型に届くなら、それはサービス拒否です。今 14.0.0 に戻すと、ビルドのたびにこれが出ます。

```text
warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability,
https://github.com/advisories/GHSA-rvv3-g6hj-g44x
```

修正は 15.1.1 と 16.1.1 で出荷され、どちらも 2026-03 のリリースです。つまり本当の選択肢は 15.1.3 か 16.2.0 であって、15 か 14 かではありません。どちらも同じコンストラクターを取るので、上で説明した移行作業はいずれにせよ同じです。

そもそもマッパーに費用を払いたくないのであれば、その判断はこのコンパイルエラーとは別の話で、ビルドが壊れた圧力の下ではなく落ち着いて下すべきものです。トレードオフは [AutoMapper から Mapperly のソース生成マッピングへ移行する](/ja/2026/05/migrate-from-automapper-to-source-generated-mapping/)の解説にまとめてあり、同じ商用ライセンスの問題は Bogard の別のライブラリでも [MediatR vs 単純なサービスクラス](/ja/2026/05/mediatr-vs-plain-service-classes-in-2026/)として一度展開されています。

## AutoMapper 16 で再び変わるもの

手を入れる必要のあるものはありません。コンストラクターの形と `AddAutoMapper` のシグネチャは 15.1.3 と 16.2.0 で同一なので、15 向けに直したコードは 16 でもそのままコンパイルできます。違いはパッケージングにあります。

- 15.x は `net8.0`、`net9.0`、`netstandard2.0` をターゲットにしています。
- 16.x は `net10.0` と `net471` を追加し、`Microsoft.Extensions.*` の依存関係を 8.0.0 から 10.0.0 に引き上げています。

すでに .NET 10 にいるなら、16.2.0 は 8.0.0 の拡張パッケージを依存グラフに引き込まずに済みます。推移的依存関係が固定された .NET 8 から動けないなら、15.1.3 はサポートされたパッチ済みの落ち着き先です。どちらもセキュリティ修正より後のバージョンであり、アップグレード自体はどちらでも同じ3行の編集です。ロガーファクトリーを足し、構成アクションを足し、キーの置き場所を決める、それだけです。

## 関連記事

- [AutoMapper から Mapperly のソース生成マッピングへ移行する](/ja/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [MediatR vs 単純なサービスクラス（2026年）: ライセンス変更で乗り換えるべきか？](/ja/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [解決方法: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered](/ja/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)
- [解決方法: Cannot consume scoped service 'X' from singleton 'Y'](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [EF Core 6 から EF Core 11 への移行: 本当に効いてくる破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## 参照元

- [AutoMapper 15.0 アップグレードガイド](https://docs.automapper.io/en/stable/15.0-Upgrade-Guide.html)
- [AutoMapper v15.0.0 リリースノート](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0)
- [Issue #4542: MapperConfiguration single argument constructor](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542)
- [AutoMapper のライセンス構成ドキュメント](https://docs.automapper.io/en/stable/License-configuration.html)
- [AutoMapper の依存性注入ドキュメント](https://docs.automapper.io/en/stable/Dependency-injection.html)
- [GHSA-rvv3-g6hj-g44x: AutoMapper の制御されない再帰](https://github.com/advisories/GHSA-rvv3-g6hj-g44x)
