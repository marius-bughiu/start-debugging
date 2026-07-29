---
title: "解決: .NET コンテナーで Couldn't find a valid ICU package installed on the system"
description: "ベースイメージに ICU がありません。icu-libs と icu-data-full を入れるか、-extra イメージバリアントに切り替えるか、InvariantGlobalization=true にして序数比較の挙動を受け入れてください。"
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "globalization"
  - "alpine"
lang: "ja"
translationOf: "2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system"
translatedBy: "claude"
translationDate: 2026-07-29
---

コンテナーのベースイメージが ICU を同梱しておらず、.NET は ICU なしでは起動を拒否します。答えは 2 つのどちらかです。アプリが日付を書式設定する、文字列を言語的に比較する、あるいはインバリアント以外のカルチャーに触れるのであれば、ICU を入れてください。Alpine なら `RUN apk add --no-cache icu-libs icu-data-full` です。あるいは、最初から ICU を含む `-extra` イメージバリアントに切り替えます。アプリが本当にカルチャーデータを一切必要としないなら、プロジェクトファイルに `<InvariantGlobalization>true</InvariantGlobalization>` を設定して小さいイメージのままにしてください。環境変数だけを設定して祈るのはやめましょう。3 つのスイッチの中で最も弱いからです。

```text
Process terminated. Couldn't find a valid ICU package installed on the system.
Please install libicu (or icu-libs) using your package manager and try again.
Alternatively you can set the configuration flag System.Globalization.Invariant
to true if you want to run with no globalization support. Please see
https://aka.ms/dotnet-missing-libicu for more information.
```

以下の内容はすべて .NET 10 (`10.0`、2025-11-11 リリース) と .NET 11 のプレビューで検証しています。この仕組みは .NET 5 以降同じなので、同じ対処が `net8.0` や `net9.0` のイメージにもそのまま当てはまります。変わるのはパッケージ名とイメージタグだけです。

## ランタイムが縮退せずにプロセスを落とす理由

Unix における .NET のグローバリゼーション基盤は、ICU (International Components for Unicode) の薄いラッパーです。カルチャーデータ、言語的な文字列比較、ASCII を超えた大文字小文字の規則、カレンダーの書式設定、IDN の処理。これらはすべて `libicuuc` と `libicui18n` から来ており、これらは .NET の一部ではありません。ベースイメージが提供することを前提としたネイティブ依存関係です。

起動時、`GlobalizationMode` の静的コンストラクターは固定された判断リストをたどります。

1. グローバリゼーションインバリアントモードは有効か。有効なら ICU を完全にスキップし、組み込みのインバリアントデータを使います。
2. アプリローカル ICU は構成されているか。構成されていればアプリのディレクトリから `libicuuc.so.<version>` と `libicui18n.so.<version>` を読み込みます。
3. `DOTNET_ICU_VERSION_OVERRIDE` は設定されているか。設定されていればそのバージョンをそのまま試します。
4. どれにも当てはまらなければ、システムにインストールされている最も新しい ICU を読み込みます。

手順 4 で何も見つからないと、ランタイムは `Environment.FailFast` を呼びます。ここが多くの人のつまずきどころです。これは例外ではありません。救ってくれる `try`/`catch` もなければ、`AppDomain.UnhandledException` のフックもなく、インバリアントモードへの穏当なフォールバックもありません。プロセスは `Main` が実質的に動き出す前に中断され、Linux では SIGABRT とコンテナーの終了コード 134 として現れます。これは意図的な設計です。黙って序数比較に縮退すれば、並び順、大文字小文字、日付の解析が変わり、大きな失敗の代わりに誤ったデータが生まれてしまいます。

これに当たりやすいのは、まさに小ささを理由に選んだイメージです。Alpine、Azure Linux distroless、Ubuntu chiseled はいずれも ICU と tzdata を省いており、.NET のコンテナードキュメントはこれらのイメージがグローバリゼーションインバリアントモード向けに構成されたアプリでのみ動作すると明言しています。Debian と Ubuntu のフルイメージには ICU が含まれます。だからこそ手元のマシンと `sdk` イメージでは動き、ランタイムのステージに移った途端に落ちたわけです。

## 最小の再現

2 ステージ、標準的な SDK ビルド、Alpine のランタイム。この Dockerfile で十分です。

```dockerfile
# .NET 10. Fails at startup with the ICU error.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

アプリ側が特別なことをしている必要はありません。失敗はランタイムの初期化中、つまりコードが動く前に起きるので、次のようなものでもクラッシュします。

```csharp
// .NET 10, C# 14. Never reaches the WriteLine.
Console.WriteLine("hello");
```

これは覚えておく価値があります。最初の反応は原因となった `CultureInfo` の呼び出しを探すことだからです。そんな呼び出しは存在しません。グローバリゼーションの初期化は先行して行われます。

## 対処 1: イメージに ICU をインストールする

大半のアプリにとってこれが正しい対処であり、.NET のコンテナーサンプルが文書化している方法でもあります。Alpine の場合は次のとおりです。

```dockerfile
# .NET 10 on Alpine 3.22. Adds ICU and disables invariant mode.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
RUN apk add --no-cache icu-libs icu-data-full
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false \
    LC_ALL=en_US.UTF-8 \
    LANG=en_US.UTF-8
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`icu-data-full` は省略してよい飾りではありません。Alpine 3.16 以降 ICU のデータパッケージは分割され、`icu-libs` 単体では `en` ロケールしか入りません。その結果、最初のエラーよりずっと分かりにくい失敗が起きます。ランタイムは問題なく起動し、その後は英語以外のすべてのカルチャーが黙って英語として書式設定されるのです。`fr-FR` の日付書式を検証するテストが、エラーメッセージなしで落ち始めます。両方のパッケージを入れてください。

`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` の行が意味を持つのは、上流の何かがこれを `true` にしている場合だけです。実際に複数のベースイメージや CI テンプレートがそうしています。明示的に設定してもコストはゼロで、環境の継承に由来するバグを丸ごと 1 種類なくせます。

Debian や Ubuntu ベースのイメージでの同等の記述です。自分で組み立てた `runtime-deps` イメージの場合にだけ必要になります。

```dockerfile
# .NET 10 on Ubuntu 24.04 (noble).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu74 tzdata \
    && rm -rf /var/lib/apt/lists/*
```

`libicu` のパッケージ名は、使っているディストリビューションのリリースが実際に持っているものに固定してください (Ubuntu 24.04 なら `libicu74`、Debian bookworm なら `libicu72`)。追跡したくない場合は `apt-get install -y libicu-dev` を使うと正しいランタイムライブラリが推移的に入りますが、レイヤーは大きくなります。

## 対処 2: `-extra` イメージバリアントに切り替える

Microsoft はサイズ最適化イメージを 3 種類公開しており、`-extra` というフィーチャーサフィックスはまさに「小さいイメージに ICU、tzdata、`libstdc++` を足したもの」を意味します。chiseled や Azure Linux を使っているなら、パッケージのインストールではなく 1 行で済みます。

```dockerfile
# .NET 10, Ubuntu chiseled with globalization support.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

これを前提に設計する前に知っておくべき、提供状況の非対称性があります。Ubuntu chiseled と Azure Linux では、`-extra` は `runtime-deps`、`runtime`、`aspnet` の各リポジトリに存在します。Alpine では `-extra` は `runtime-deps` にしか公開されていないため、自己完結型 (self-contained) または Native AOT の発行でしか使えません。フレームワーク依存の Alpine アプリは、対処 1 のように手動でパッケージを入れる必要があります。

Dockerfile ではなく SDK 組み込みのコンテナーサポートでイメージをビルドしている場合は、`FROM` 行ではなく `ContainerFamily` でバリアントを選びます。

```xml
<!-- .NET 10 SDK. Applies to dotnet publish /t:PublishContainer. -->
<PropertyGroup>
  <ContainerFamily>noble-chiseled-extra</ContainerFamily>
</PropertyGroup>
```

これは [PublishContainer で .NET アプリをコンテナーイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) で説明した流れにそのまま乗り、ベースイメージの選択を、発行設定の残りが置かれているプロジェクトファイルの中に保てます。

## 対処 3: インバリアントグローバリゼーションを意図的に有効にする

アプリが本当にカルチャーに依存しないなら (ISO-8601 のタイムスタンプとインバリアント書式の数値だけをやり取りする社内 API が典型例です)、インバリアントモードは回避策ではなく正しい構成です。依存関係を完全に取り除き、イメージは小さく、起動は速くなります。

```xml
<!-- .NET 10, C# 14. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
</PropertyGroup>
```

Dockerfile ではなくプロジェクトファイルに設定してください。ランタイムのグローバリゼーションインバリアントモード設計ドキュメントによれば、プロジェクトファイルと `runtimeconfig.json` の設定は `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT` より優先されます。つまり MSBuild プロパティが常に勝ち、環境変数が黙って負けます。プロジェクトファイルはアプリと一緒に移動もします。誰かがコンテナーを別のオーケストレーターに載せ替え、環境変数のブロックを忘れて障害を復活させる、ということが起きません。

何に同意しているのかは把握しておいてください。インバリアントモードでは次のようになります。

- `ToUpper` と `ToLower` は ASCII 範囲しか変換しません。トルコ語のドット付き / ドットなし I の扱いは失われます。
- `String.Compare`、`IndexOf`、`LastIndexOf` は、渡した `CompareOptions` や `StringComparison` に関係なく序数比較を行います。言語的な並び順が黙ってバイト順になります。
- `String.Normalize` は文字列をそのまま返します。
- Linux のタイムゾーン表示名は、ICU のローカライズ名ではなく標準名にフォールバックします。
- `TimeZoneInfo.TryConvertIanaIdToWindowsId` とその逆方向は ICU に依存しているため失敗します。
- カルチャーの列挙はちょうど 1 つだけを返し、すべての LCID が `0x1000` に潰れます。

実務で最も痛いのはカルチャーの生成です。.NET 6 以降、インバリアントモードでは `PredefinedCulturesOnly` の既定値が `true` なので、`new CultureInfo("fr-FR")` は次をスローします。

```text
System.Globalization.CultureNotFoundException: Only the invariant culture is supported
in globalization-invariant mode.
```

生成そのものは成功させたい場合 (`Accept-Language` を解析するリクエストローカライゼーションのミドルウェアは、結果を使わなくてもこれを行います)、条件を緩められます。

```xml
<!-- .NET 10. Cultures can be created, but all behave as invariant. -->
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>
  <PredefinedCulturesOnly>false</PredefinedCulturesOnly>
</PropertyGroup>
```

これで例外は止まります。ただしカルチャー固有の挙動が戻るわけではありません。生成したどのカルチャーもインバリアントとまったく同じ振る舞いをします。`1234.56m.ToString("C", new CultureInfo("de-DE"))` は依然として汎用通貨記号を伴うインバリアントの通貨形式を返し、ドイツ語書式のユーロ金額にはなりません。本当にローカライズされたアプリでこの組み合わせを「解決策」として扱うと、en-US 以外のあらゆる場所で出力が誤ったアプリを出荷することになります。

## 対処 4: アプリローカル ICU で自前の ICU を持ち歩く

ニッチではあるものの正当な選択肢です。ICU のバージョンを固定してアプリと一緒に配布し、どのホストにデプロイしても挙動をバイト単位で同一に保ちます。ICU のバージョンが上がると CLDR データが変わり、CLDR データが変われば並び順と書式が変わります。書式設定された出力に対してゴールデンファイルのテストを持つアプリは、頼んでもいないベースイメージの更新で不安定になり得ます。

```xml
<!-- .NET 10. Ships ICU 72.1 with the app instead of using the system copy. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Globalization.AppLocalIcu" Value="72.1" />
  <PackageReference Include="Microsoft.ICU.ICU4C.Runtime" Version="72.1.0.3" />
</ItemGroup>
```

このスイッチが設定されていると、.NET はアプリのネイティブ探索パスから `libicuuc.so.72.1` と `libicui18n.so.72.1` を読み込み、システム側のコピーを一切見ません。対応する環境変数は `DOTNET_SYSTEM_GLOBALIZATION_APPLOCALICU` で、値の形式は `<version>` または `<suffix>:<version>` です。サフィックスはカスタムビルドの ICU に対応します。ライブラリが見つからない場合は、より具体的な別の失敗が出ます。`Failed to load app-local ICU: <library name>` です。`PackageReference` のバージョンをスイッチの値と一致させないと、まさにこれを見ることになります。

## 誤った対処に導く落とし穴

**Dockerfile の `ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false` が何も効かない。** プロジェクトファイルを確認してください。そこか `runtimeconfig.json` に `<InvariantGlobalization>true</InvariantGlobalization>` があれば、そちらが優先され、環境変数は無効です。善意のサイズ最適化がよく置かれている `Directory.Build.props` も含め、ソリューション全体を grep してください。

**上のメッセージではなく `Failed to load system ICU: libicuuc.so.<n>` が出る。** これは別の分岐です。バージョン探索で ICU は見つかったものの、その soname を読み込めなかったことを意味します。原因は部分的なインストールか、アーキテクチャーの不一致 (`arm64` エミュレーション上で動く `amd64` レイヤーなど) が大半です。コンテナー内で `ldconfig -p | grep icu` を実行して確認してください。

**Native AOT やトリム済みの発行でだけエラーが出る。** その場合、原因はイメージではない可能性が高いです。`PublishAot` と `PublishTrimmed` は機能スイッチと相互作用し、`InvariantGlobalization` は AOT テンプレートでサイズのためによく有効化されるスイッチの 1 つです。同種の「SDK が裏でスイッチを変えた」問題は [リフレクションベースのシリアル化が無効になる理由](/ja/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) と、より広い議論である [トリムセーフなコード](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) で扱っています。

**日付は正しく書式設定されるのに、タイムゾーンが解決できない。** ICU と tzdata は別のパッケージです。`TimeZoneInfo.FindSystemTimeZoneById` は `/usr/share/zoneinfo` を読みますが、サイズ最適化イメージはこれも省いています。`icu-libs` と一緒に `tzdata` を入れるか、両方を含む `-extra` バリアントを使ってください。

**カルチャー固有のテスト以外はすべて動く。** Alpine で `icu-data-full` なしに `icu-libs` を入れています。`en` のデータしかありません。

**SDK イメージでは動くのにランタイムイメージでは動かない。** 想定どおりです。`sdk` イメージは既定で Debian ベースであり ICU を含みます。依存関係が必要なのは最終ステージの `aspnet` または `runtime` の方です。ビルドレイヤーではなく、実際のランタイムレイヤーの中で切り分けてください。

どのモードになったかを推測せずに確認するには、次のコードを使います。

```csharp
// .NET 10, C# 14. Prints 1 in invariant mode, several hundred with ICU loaded.
using System.Globalization;

Console.WriteLine(CultureInfo.GetCultures(CultureTypes.AllCultures).Length);
Console.WriteLine(AppContext.TryGetSwitch("System.Globalization.Invariant", out bool inv) && inv);
```

## 関連記事

- [dotnet publish /t:PublishContainer で .NET 11 アプリをコンテナーイメージとして発行する方法](/ja/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [Native AOT とは何か、そして何を犠牲にするのか?](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform (Native AOT)](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [トリムセーフなコードとは何か、どう書けばよいのか？](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [.NET 11 AWS Lambda のコールドスタート時間を縮める方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## 参考資料

- [.NET globalization invariant mode](https://github.com/dotnet/runtime/blob/main/docs/design/features/globalization-invariant-mode.md)：挙動の一覧と設定の優先順位について - dotnet/runtime
- [`GlobalizationMode.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Globalization/GlobalizationMode.Unix.cs)：読み込み順と ICU 欠如時の `FailFast` について - dotnet/runtime
- [グローバリゼーションの構成設定](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/globalization) - MS Learn
- [.NET のグローバリゼーションと ICU](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu)：アプリローカル ICU と Linux での探索順について - MS Learn
- [.NET コンテナーイメージでグローバリゼーションを有効にする](https://github.com/dotnet/dotnet-docker/blob/main/samples/enable-globalization.md) - dotnet/dotnet-docker
- [.NET イメージバリアント](https://github.com/dotnet/dotnet-docker/blob/main/documentation/image-variants.md)：どのリポジトリが `-extra` を公開しているかについて - dotnet/dotnet-docker
- [.NET コンテナーイメージ](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images) - MS Learn
- [Alpine への .NET のインストール](https://learn.microsoft.com/en-us/dotnet/core/install/linux-alpine)：`icu-data-full` を含む依存関係の一覧について - MS Learn
- [Alpine 3.16 icu-libs now contains only en](https://github.com/dotnet/dotnet-docker/issues/3844) - dotnet/dotnet-docker
- [グローバリゼーションインバリアントモードでのカルチャー生成とケースマッピング](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode) - MS Learn
