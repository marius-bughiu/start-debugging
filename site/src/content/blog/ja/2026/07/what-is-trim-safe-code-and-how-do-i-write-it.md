---
title: "トリムセーフなコードとは何か、どう書けばよいのか？"
description: "トリムセーフなコードとは、.NET トリマーが静的に到達可能だと証明できるコードのことで、自己完結型アプリから未使用コードが削除されても生き残ります。本記事は実践ガイドです。アナライザーを有効にし、すべての IL2xxx 警告をゼロにし、リフレクションを DynamicallyAccessedMembers で注釈し、RequiresUnreferencedCode を公開 API まで伝播させ、解析不能なパターンをソースジェネレーターに置き換えます。"
pubDate: 2026-07-09
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/07/what-is-trim-safe-code-and-how-do-i-write-it"
translatedBy: "claude"
translationDate: 2026-07-09
---

トリムセーフなコードとは、.NET トリマーが静的に到達可能だと証明できるコードのことで、トリムされた自己完結型アプリを公開したときに削除されず、周囲の未使用メンバーが削除されてもアプリを密かに壊すことのないコードです。具体的には、プロジェクトがトリム解析のもとでクリーンにコンパイルされること、つまり `IL2026`、`IL3050`、`IL2070` とその仲間がゼロであることを意味します。コードをトリムセーフにするには、まずアナライザーを有効にし、それから警告リストをゼロにしていきます。表現できるリフレクションには注釈を付け（`[DynamicallyAccessedMembers]`）、表現できないリフレクションは `[RequiresUnreferencedCode]` の背後に隔離して公開 API まで押し上げ、どちらでも対処できないパターンはソースジェネレーターに置き換えます。クリーンな解析ビルドが契約です。ゼロにできないなら、そのアプリはトリムセーフではなく、トリミングは `dotnet run` では決して現れなかった本番環境限定のクラッシュを生み出します。

ここで扱う内容はすべて .NET 11 SDK（`11.0.100`）と C# 14 を対象としていますが、トリム解析の警告は .NET 6 以降存在しているため、そのメカニズムは `net6.0` 以降に適用されます。ライブラリ作業における実質的な最低ラインは .NET 8 SDK 以降です。というのも、アナライザーと AOT 互換性のストーリーが安定したのがそこだからです。

## なぜトリマーはあなたのコードの協力を必要とするのか

トリミングは到達可能性解析によって機能します。トリマー（内部的には `ILLink`）はエントリポイントから開始し、静的に見えるすべてのメソッド呼び出し、フィールドアクセス、型参照をたどり、触れたものを保持対象としてマークし、それ以外をすべて削除します。これが、自己完結型アプリが数十メガバイトからそのごく一部にまで縮む仕組みです。フレームワークは巨大で、アプリが使うのはその薄片にすぎず、残りは消えます。.NET 6 以降、デフォルトの粒度は古いアセンブリ単位の `copyused` 挙動ではなくメンバー単位（`TrimMode=full`）になっているため、トリマーは参照されないアセンブリ全体だけでなく、個々の未使用メソッドや型を削除します。これはより積極的であり、解析では見えない形で実際に到達しているものを削除してしまう可能性がより高くなります。

解析が見られないもの、それはリフレクションです。`type.GetMethods()` や `Activator.CreateInstance(someType)` と書くと、トリマーは実行時にどの具体的な型が流れ込むのか分からないため、どのメンバーを保持すべきか知りようがありません。トリマーには二つの悪い選択肢があります。そこに流れ込みうるすべてを保持する（これではトリミングが台無しになります）か、何も保持せず `MissingMethodException` で実行時に気づかせるか、です。トリマーはそのどちらもしません。代わりに、リフレクションを行うコードに対して、それが正確に何に触れるかを記述する注釈を携えることを要求し、注釈のない値がリフレクション呼び出しに流れ込むあらゆる箇所で警告を出します。トリムセーフなコードとは、そうした要求を満たすコードです。同じ規則が[トリミングを必須にする Native AOT ビルド](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)を支配しているため、以下のすべては AOT を利用するための入場料でもあります。

## ステップ 1: アナライザーを有効にする

見えない警告は修正できませんし、デフォルトでは通常のビルドは何も表示しません。警告を表面化させる方法は二つあり、それぞれが異なるものを捕捉するため、ドキュメントは両方を使うことを推奨しています。

トリムして公開する予定のアプリケーションでは、プロジェクトファイルに `PublishTrimmed` を設定します（コマンドラインだけでなく、`dotnet build` の間にも適用されるように）。

```xml
<!-- .NET 11, C# 14. App project. Turns on the trimmer at publish and
     the trim-compat Roslyn analyzer during every build. -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

ライブラリの場合は公開しないため、代わりにプロジェクト単位の解析を有効にします。`<IsTrimmable>true</IsTrimmable>` はアセンブリをトリム互換としてマークし、そのプロジェクトの警告を有効にします。

```xml
<!-- .NET 11, C# 14. Library project. Marks the assembly trimmable and
     emits trim warnings for this project's own code. -->
<PropertyGroup>
  <IsTrimmable>true</IsTrimmable>
</PropertyGroup>
```

ここで重要なニュアンスが二つあります。第一に、アセンブリがトリムセーフだと約束せずに警告だけがほしい場合（たとえばまだ対処中の場合）は、`IsTrimmable` の代わりに `<EnableTrimAnalyzer>true</EnableTrimAnalyzer>` を使います。これはアセンブリをトリム可能としてスタンプすることなく、同じ解析を出力します。第二に、`IsTrimmable` は `<IsAotCompatible>true</IsAotCompatible>` を設定すると `true` がデフォルトになるため、AOT 互換のライブラリは、別途要求したかどうかに関わらずトリム解析を受けています。

プロジェクト単位のライブラリ解析の落とし穴は、自分のコードと依存関係の参照アセンブリしか見えず、参照アセンブリにはトリマーが判断するのに十分な情報が含まれていないことです。ライブラリが依存関係をどう使うかに由来するものも含め、すべての警告を見るには、小さなトリミングテストアプリを作ります。ライブラリを参照し、`<PublishTrimmed>true</PublishTrimmed>` を設定し、ライブラリをルート化して全体が解析されるようにするコンソールプロジェクトです。

```xml
<!-- .NET 11. Trimming test app. Roots the library so ILLink walks every
     code path in it, not just the ones the console Main reaches. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\MyLibrary\MyLibrary.csproj" />
    <TrimmerRootAssembly Include="MyLibrary" />
  </ItemGroup>
</Project>
```

そして `dotnet publish -c Release -r linux-x64` を実行して警告を読みます。差を生むのは `TrimmerRootAssembly` です。これがなければトリマーは `Main` が実際に到達する呼び出ししか解析しません。あれば、ライブラリ全体をルートとして扱い、すべてのパスを走査します。

## 「まだトリムセーフではない」を意味する警告を読む

四つの警告ファミリーが、遭遇するもののほぼすべてをカバーします。どれがどれかを知ることが、修正方法を教えてくれます。

`IL2026`（`RequiresUnreferencedCode`）は、誰かがすでにトリム非互換と宣言したメソッドを呼び出したことを意味します。`IL3050`（`RequiresDynamicCode`）はその AOT 専用の兄弟で、JIT なら提供するが AOT ではできない実行時コード生成をメソッドが必要としています。`IL2070`、`IL2075`、`IL2077`、そして残りの `IL207x` 帯はデータフロー警告です。注釈のない `Type`（パラメーター、フィールド、戻り値から来たもの）が `[DynamicallyAccessedMembers]` の約束を必要とするリフレクション呼び出しに流れ込んだのに、誰もその約束をしなかった、というものです。これらの一つ一つを、アナライザーのノイズではなく本物の欠陥として扱ってください。アナライザーの全目的は、密かで公開時限定、ときには本番環境限定でしか起きない `MissingMethodException` を、正確な行を指し示すビルド時の警告に変換することにあります。

読み方のコツを一つ。.NET 6 以降、トリマーは `PackageReference` アセンブリからの内部警告をすべてアセンブリごとの単一の警告にまとめるため、制御できない依存関係のノイズに溺れずに済みます。実際にそれらをすべて見たい場合（依存関係が修正可能かどうか判断しようとしているとき）は、`<TrimmerSingleWarn>false</TrimmerSingleWarn>` を設定して展開します。

## IL207x の修正: 表現できるリフレクションに注釈を付ける

データフロー警告は自分のコードで修正するもので、修正はつねに同じ形をしています。`Type` が来る場所で要件を宣言し、約束が型システムの中に存在するようにするのです。次のヘルパーを見てください。`GetMethods()` は型が public メソッドを保持することを要求しますが、パラメーターは何も約束しないため警告が出ます。

```csharp
// .NET 11, C# 14. Warns IL2070: 'type' has no matching annotation.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

要件をパラメーターにコピーします。

```csharp
// .NET 11, C# 14. Clean: the parameter now carries the promise.
static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var m in type.GetMethods()) { /* ... */ }
}
```

要件は消えるのではなく、呼び出し元へ移動し、`typeof(Customer)` や具体的な型引数にたどり着くまで外側へ伝播し続けます。そこでトリマーはついに何を保持すべきか正確に知ることになります。求めるのは最小限にしてください。`Activator.CreateInstance(type)` をするだけなら、`All` ではなく `PublicParameterlessConstructor` を要求します。追加するフラグはすべて、トリマーが削除を禁じられるメンバーであり、それは対価として支払うバイナリサイズです。フィールド、ジェネリック型パラメーター、戻り値への注釈の付け方を含む完全なフローモデルは、[DynamicallyAccessedMembers の詳細解説](/ja/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/)で扱っています。一行でまとめると、この属性はそれ自体では何も保持せず、具体的な型が生まれる場所へ義務を伝播させる、ということです。

## IL2026 の修正: 表現できないリフレクションを隔離する

リフレクションが本当に解析不能なこともあります。構成から文字列で型を読み込む、あるいは実行時までは型が分からないオブジェクトに対して `GetProperties()` を走査する、といった場合です。それを注釈で切り抜けることはできないので、`[RequiresUnreferencedCode]` でメソッドをトリム非互換と宣言し、警告を伝播させます。

```csharp
// .NET 11, C# 14. Honest: this method reflects in a way trimming can break.
[RequiresUnreferencedCode("Serializes arbitrary types via reflection over their properties.")]
static string Serialize(object value)
{
    var sb = new StringBuilder();
    foreach (var p in value.GetType().GetProperties())
        sb.Append(p.Name).Append('=').Append(p.GetValue(value)).Append(';');
    return sb.ToString();
}
```

この属性は何も修正しません。`[DynamicallyAccessedMembers]` がその要件を移動させるのと同じように、`IL2026` 警告を `Serialize` のすべての呼び出し元へ移動させ、公開 API の境界に達するまで続きます。そこでライブラリ作者が制限を文書化し、伝播を止めます。これが、本当にトリムセーフではないコードにとって正しい結末です。密かな実行時の失敗ではなく、呼び出し元はこのパスがトリミングのもとで安全でないと告げるコンパイル時の警告を受け取り、それを避けるかどうか判断できます。公開 API へきれいに伝播させることが重要なのもこのためで、それによって一律の `IL2104: Assembly produced trim warnings` を抑制し、利用者にメソッド単位の正確なシグナルを与えられます。

パターンが主にリフレクションであるなら、呼び出しごとに注釈で回避しようとしないでください。それはコンパイル時のコード生成に置き換えるべきだというサインです。リフレクションベースのシリアライザーやマッパーがその典型例です。`GetProperties()` の走査に注釈を付けるのではなく、ビルド時にアクセスコードを出力する[ソースジェネレーター](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)を採用します。これこそがソース生成された `System.Text.Json` が存在する理由であり、AOT で推奨されるパスである理由です。

## 脱出ハッチと、それが罠になるとき

二つの属性はコードを変えずに警告を黙らせられますが、どちらも鋭利です。

`[UnconditionalSuppressMessage]` は特定の警告を一つ黙らせ、素の `[SuppressMessage]` とは違って IL に保存されるため、トリム解析がそれを尊重します。使うのは、データフローが本物で正しいのにアナライザーが追えない場合だけにしてください。たとえば、構築の仕方からすべての要素がコンストラクターを保持すると分かっている `Type[]` などです。

```csharp
// .NET 11, C# 14. Valid only because the setter guarantees the invariant.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only holds types stored through the annotated setter.")]
get => _types[i];
```

ドキュメントは失敗モードについてはっきり述べています。抑制が有効なのは、リフレクション対象のメンバーがプログラムの他の場所で本物のリフレクション対象になっている場合だけです。非リフレクション的に使われるメンバー（通常のメソッド呼び出し）は有効な抑制対象ではありません。オプティマイザーはそれをインライン化したり、名前を変えたり、移動したりする自由があり、抑制したリフレクションは警告する警告もないまま壊れるからです。「そのプロパティはアプリが使っているのだから必ずそこにある」を抑制するのは、まさにドキュメントが指摘する無効なパターンです。

`[DynamicDependency]` は最後の手段です。名前付きのメンバーを保持しますが解析には知らせないため、それ自体では警告を黙らせず、抑制と併せて使います。別のアセンブリから文字列でメンバーを読み込むような、`[DynamicallyAccessedMembers]` でも表現できないパターンに対してのみ使ってください。

```csharp
// .NET 11, C# 14. Last resort. Keeps Helper so the reflection below finds it.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

どちらかの属性を多くの呼び出し箇所にばらまくことになったなら、それはトリムセーフ性の修正ではなく、API が根本的にリフレクション形状であり、代わりにビルド時に再生成すべきだと告げる設計上の臭いです。

## フレームワークの機能スイッチ: 決して呼ばないコードをトリムする

トリムセーフ性のすべてが自分のリフレクションに関するものではありません。フレームワークの一部は機能スイッチの背後にトリマーディレクティブを備えて出荷されており、使わない機能領域全体を削除するようトリマーに指示できます。これらはランタイム構成とトリミング命令の二役を兼ねます。知っておく価値のあるものをいくつか。`<EventSourceSupport>false</EventSourceSupport>` は EventSource の配管を落とし、`<UseSystemResourceKeys>true</UseSystemResourceKeys>` は `System.*` アセンブリから完全な例外メッセージのテキストを剥ぎ取ってリソース ID にまで落とし、`<InvariantGlobalization>true</InvariantGlobalization>` はグローバリゼーションデータを削除し、`<StackTraceSupport>false</StackTraceSupport>`（.NET 8 以降）はランタイムのスタックトレース生成を削除します。.NET 10 では `<UseSizeOptimizedLinq>true</UseSizeOptimizedLinq>` が追加され、LINQ のスループットをいくらか犠牲にして出力を小さくします。これは `PublishAot` のもとではデフォルトです。これらはコードを解析可能にするためのものではなく、決して触れないフレームワーク機能に対してバイナリサイズという対価を払わないためのものです。それぞれが実際の挙動を削除するので、意図を持って有効にしてください。

## 実際にトリムセーフへ到達させるワークフロー

これらすべてをまとめる心的モデル。トリムセーフ性はスイッチではなく、防衛するビルド状態です。アナライザーを有効にします（アプリなら `PublishTrimmed`、ライブラリなら `IsTrimmable` とルート化したテストアプリ）。警告を読んで仕分けします。`IL207x` は `Type` の出所に最小限の `DynamicallyAccessedMembers` フラグを注釈して修正し、`IL2026`／`IL3050` は `[RequiresUnreferencedCode]` で注釈して公開 API に伝播させるか、リフレクションをソースジェネレーターに置き換えます。二つの脱出ハッチは、不変条件が本物でアナライザーが本当にそれを見られない場合にのみ使います。カウントをゼロまで追い込み、そのまま維持します。というのも、新しいトリム警告を持ち込むことは、あなたのライブラリをトリムして公開する誰にとっても破壊的変更であり、依存関係の更新はあなたの側の API 変更なしに警告を再導入しうるからです。安全でない呼び出しがアナライザーをすり抜けて実行時にしか失敗しないとき、あなたは再び [Native AOT の PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) をデバッグすることになります。これこそ、警告のないビルドが防ぐために存在する失敗そのものです。そしてターゲットが本物の Web サービスなら、[Native AOT の minimal API ウォークスルー](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)がクリーンビルドのレシピを最初から最後まで示します。トリムセーフなコードは C# の特別な方言ではありません。トリマーの到達可能性解析を正直に保つ、ごく普通の C# であり、アナライザーはそれができているかどうかをビルド時に教えてくれるツールです。

## 関連記事

- [Native AOT とは何か、そして何を犠牲にするのか？](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)：AOT のもとでなぜトリミングが必須なのか、他に何を手放すことになるのかを説明します。
- [DynamicallyAccessedMembers 属性とは何か？](/ja/2026/06/what-is-the-dynamicallyaccessedmembers-attribute/)：IL207x のデータフロー警告を修正する注釈の詳細解説です。
- [ソースジェネレーターとは何か、いつ必要になるのか？](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)：注釈できないリフレクションを置き換えるコンパイル時コード生成を扱います。
- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)：これらの警告が実際のアプリで現れるクリーンビルドのウォークスルーです。
- [修正: Native AOT の PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/)：警告のないトリムビルドが防ぐ実行時の失敗です。

## 出典

- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn（IsTrimmable、EnableTrimAnalyzer、テストアプリのパターン、RequiresUnreferencedCode、DynamicallyAccessedMembers、UnconditionalSuppressMessage、DynamicDependency）。
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options), MS Learn（PublishTrimmed、TrimmerSingleWarn、ILLinkTreatWarningsAsErrors、機能スイッチの表）。
- [Trim self-contained deployments and executables](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained), MS Learn（TrimMode の粒度と到達可能性トリミングの仕組み）。
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn（IL2026/IL3050/IL207x の警告カタログとデータフローモデル）。
