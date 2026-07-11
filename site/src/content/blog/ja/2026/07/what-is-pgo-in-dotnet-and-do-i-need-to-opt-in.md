---
title: ".NET の PGO とは何か、そして有効化する必要はあるのか？"
description: "PGO（プロファイルに基づく最適化）は、.NET の JIT がワークロードで実際に通る型や分岐に合わせてホットなコードを特化させる仕組みです。Dynamic PGO は .NET 8 以降デフォルトで有効なので、.NET 8 以降では有効化する必要はありません。PGO が何をするのか、その効果をどう確認するのか、そして設定に手を入れる数少ないケースを解説します。"
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "ja"
translationOf: "2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in"
translatedBy: "claude"
translationDate: 2026-07-11
---

PGO はプロファイルに基づく最適化（profile-guided optimization）の略です。コンパイラーがコードの実際の実行のされ方のプロファイルを収集し、そのプロファイルを使って重要なパスに対してより速いマシンコードを生成します。.NET では JIT が実行時にこれを行い、このモードは Dynamic PGO と呼ばれます。そして「有効化する必要はあるのか？」への短い答えは、いいえ、もう必要ありません、です。Dynamic PGO は .NET 8 以降デフォルトで有効なので、.NET 8、.NET 9、.NET 10、.NET 11 ではすでに使えています。スイッチに手を伸ばすのは、.NET 6 または 7（そこではデフォルトで無効）を使っている場合か、tier 1 に達する前に終了するような極端に短命で特殊なワークロードで無効化したい場合だけです。この記事では、プロファイルが何をもたらすのか、それが動いていることをどう確認するのか、そして設定に手を入れる価値のある数少ないケースを説明します。

ここで扱う内容はすべて .NET 11 SDK（`11.0.100`）での `<TargetFramework>net11.0</TargetFramework>` を対象としていますが、デフォルト有効の挙動は .NET 8 以降保たれており、その基盤となる仕組みは .NET 7 がそれを固めて以来安定しています。挙動が特定のバージョンに依存する場合は、その旨を明示します。

## 「プロファイルに基づく」が実際に意味すること

従来の最適化コンパイラーは推測せざるを得ません。仮想メソッド呼び出しを見たとき、実行時にどの具象型が現れるかを知る術がないので、汎用的な間接呼び出しを出力します。`if` を見たときも、どちらの分岐がホットかを知らないので、両方を同程度にありそうなものとして配置します。ループを見たときも、それが 2 回回るのか 200 万回回るのかを知りません。こうした推測はたいてい問題ありませんが、時に多くのパフォーマンスを取りこぼします。

プロファイルに基づく最適化は推測を取り除きます。プログラムを実行し、それらの各判断点で実際に何が起きたかを記録し、そのデータを最適化器へ戻します。これでコンパイラーは、ある呼び出し箇所が 98% の割合で `List<int>` だったこと、ある分岐が 1000 回に 1 回取られること、あるループが本当にホットであることを知ります。あらゆる可能性に備えて身構えるのではなく、現実に合わせてコードを特化できるのです。

古典的な事前 PGO はこれを 2 つの別々のビルドで行います。プロファイルを生成するために代表的なワークロードに対して実行する計装済みビルドと、そのプロファイルを消費する 2 つ目のビルドです。C や C# ならぬ C や C++ のツールチェーンは何十年もこうしてきましたが、これは強力な反面、面倒でもあります。本番に似たワークロードを捕捉し、再ビルドしなければならないからです。.NET の Dynamic PGO は両方のフェーズを 1 つの実行中プロセスに融合します。これこそが、ただ有効にしたまま放っておけるものにしている点です。

## Dynamic PGO が階層型コンパイルにどう乗っているか

Dynamic PGO はランタイムにあとから付け足された別のパスではありません。JIT がホットなメソッドを 2 回コンパイルするためにすでに使っている仕組みに相乗りしています。この 2 パスのモデルをまだ腹に落とせていなければ、[階層型コンパイルとは何か、どう捉えればよいか](/ja/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)についての記事が前提知識です。ごく短く言えば、メソッドはまず速く最適化されていない「tier 0」コードとしてコンパイルされ、ホットなものだけがバックグラウンドで完全に最適化された「tier 1」コードとして再コンパイルされます。

Dynamic PGO はこの最初のパスを活用します。有効なとき、JIT が出力する tier 0 コードは単に最適化されていないだけでなく、計装されています。コンパイラーは、各基本ブロックがどれくらいの頻度で実行されるかを数え、仮想呼び出しとインターフェース呼び出しの箇所では実際にどの具象型が到達するかの小さなヒストグラムを構築する、安価なプローブを挿入します。アプリがウォームアップする間、その tier 0 コードは静かにあなた固有のワークロードのプロファイルを収集します。メソッドがのちに tier 1 へ昇格すると、最適化器は収集したプロファイルを読み、それに応じて tier 1 コードを特化します。

このタイミングがすべての肝です。プロファイルは実際のワークロードから、実際のマシン上で、最適化コードが生成される直前に収集されるので、別個の計装済みビルドも代表的ワークロードの問題もありません。代償は、計装済みの tier 0 コードが素の tier 0 よりわずかに遅く、わずかに大きいことですが、それが問題になるのは昇格までの短い期間だけです。

## 残りすべての元を取る最適化：ガード付き非仮想化

Dynamic PGO が可能にする最も価値ある要素は、ガード付き非仮想化（guarded devirtualization、GDV）です。仮想呼び出しとインターフェース呼び出しが高価なのは、間接ジャンプそのものが遅いからではなく、JIT がそれらを越えてインライン化できないからです。そしてインライン化こそ、他の大半の最適化がてこを効かせる場所です。コンパイラーが呼び出しの中を見通せなければ、それを越えて定数を畳み込むことも、作業を外へ巻き上げることも、周囲の冗長なチェックを消すこともできません。

型プロファイルを手にすれば、JIT は高速パスを挿入できます。プロファイルで支配的だった型に対する明示的なチェックを出力し、チェックが通ればそのメソッド本体のインライン化された完全最適化コピーを実行し、失敗すれば通常の仮想呼び出しにフォールバックします。実際には常に `List<int>` である `IEnumerable<int>` 上のループを考えてみましょう。

```csharp
// .NET 11, C# 14.
// Dynamic PGO learns that `items` is a List<int> at this call site
// and inlines the enumerator's MoveNext/Current behind a type guard.
static long Sum(IEnumerable<int> items)
{
    long total = 0;
    foreach (int x in items) // virtual GetEnumerator/MoveNext without PGO
        total += x;
    return total;
}
```

PGO なしでは、`foreach` は要素ごとにインターフェースのディスパッチを通ります。PGO ありでは、JIT は `List<int>` を推測し、その推測を 1 回の型チェックでガードし、列挙子をインライン化するので、ループ本体は引き締まった、割り当てのない整数演算になります。.NET 8 以降では、2 つの支配的な型が見える箇所で JIT が複数のガードを出力することさえできますが、複数 GDV はデフォルトで無効で、構成設定の裏に置かれています。.NET チームは、GDV だけで実行時間がおよそ 40% 削減されたフレームワークメソッドを計測し、本番での実際の効果を報告しました。[Bing の .NET 8 への移行](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/)は、クエリあたりの CPU サイクルが 13% 減少したこと、gen0/gen1 の GC の影響を受けたクエリが 20% 減少したこと、一部の内部レイテンシが 25% 超低下したことを、Dynamic PGO がデフォルトで有効であることに大きく帰しています。

## 有効化する必要はあるのか？ バージョンごとの答え

これが検索クエリが本当に尋ねている部分です。

- **.NET 8、9、10、11**：不要です。Dynamic PGO はデフォルトで有効です。何もしません。`<TieredCompilation>` がデフォルト値（有効）なら、すでに PGO を使っています。
- **.NET 7**：存在し、よく機能しますが、デフォルトで無効です。使いたければ下の設定で有効化してください。
- **.NET 6**：ここで実験として導入され、デフォルトで無効、そして成熟度は低めです。有効化はできますが、プレビュー品質として扱ってください。
- **.NET 5 以前**：Dynamic PGO は存在しません。

デフォルトでない場所で有効化するには、プロジェクトファイルで MSBuild プロパティを設定します。

```xml
<!-- .NET 7 (or .NET 6). Opts into Dynamic PGO, which is off by default there. -->
<!-- Unnecessary on .NET 8+, where it is already enabled. -->
<PropertyGroup>
  <TieredPGO>true</TieredPGO>
</PropertyGroup>
```

あるいは環境変数を設定します。これは再ビルドなしで A/B テストをするのに便利です。

```bash
# Enable Dynamic PGO for a single run (any supported .NET version).
DOTNET_TieredPGO=1 ./myapp
```

MSBuild プロパティ、`runtimeconfig.json` のキー（`System.Runtime.TieredPGO`）、環境変数 `DOTNET_TieredPGO` は、いずれも同じスイッチを制御し、Microsoft の[コンパイル構成設定](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)リファレンスに文書化されています。Dynamic PGO は階層型コンパイルに依存するため、階層型コンパイルを無効化する（`DOTNET_TieredCompilation=0`）と、副作用として Dynamic PGO も無効になります。tier 0 がなければプロファイルのパスもありません。

## 正当に無効化してよい場合

PGO を有効のままにしておくのはほぼすべてのアプリで正しい選択ですが、正直に言って例外が 1 つあります。ホットなメソッドが tier 1 に達する前に終了するプロセスです。短命な CLI、リクエストを 1 つ処理して終わる serverless 関数、アグレッシブなタイムアウトを持つ AWS Lambda です。こうしたワークロードでは、計装済みの tier 0 コードが実行され、わずかなプロファイリングの税を払い、tier 1 への再コンパイルが起きる前にプロセスがシャットダウンするので、使うことのなかったプロファイルに対してお金を払ったことになります。

```xml
<!-- .NET 11, C# 14. Turns Dynamic PGO OFF. -->
<!-- Only sensible for ultra-short-lived processes that never reach tier 1. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

ここでも、思い込まず、計測してください。コールドスタートに敏感な多くのワークロードは、PGO を切り替えるより、ReadyToRun イメージや Native AOT のようなまったく別の戦略から大きな効果を得ます。コールドスタートに特有のトレードオフは、[.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)のガイドで掘り下げています。そして JIT を完全に手放すことを検討しているなら、[Native AOT](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/) のコードは Dynamic PGO の実行時再最適化をまったく受けないことに注意してください。事前コンパイル済みのバイナリには tier 0 のプロファイリングパスがないからです。

## Static PGO：フレームワークに同梱されるプロファイル

Dynamic PGO は .NET における唯一の PGO ではありません。フレームワーク自身の事前コンパイル済み ReadyToRun イメージは static PGO で構築されています。Microsoft はオフラインでプロファイルを収集し、それを `.mibc` ファイルとして保存し、`crossgen2` コンパイラーに渡すので、事前コンパイル済みのフレームワークコードでさえ代表的なプロファイルに従って配置されます。だからこそ `string`、`List<T>`、そして基底クラスライブラリの残りは、あなたのアプリが 1 行でも実行する前にすでにチューニングされて届くのです。

自分の AOT や ReadyToRun ビルドで同じことができます。ツールでプロファイルを捕捉し、`.mibc` を生成し、それを `crossgen2` に渡します。これはニッチで高度なワークフローで、主に Native AOT を発行し、実行時の JIT なしにプロファイルに基づく配置がほしい場合に関係します。JIT を保持する大多数のサーバーおよびデスクトップアプリでは、Dynamic PGO が同じ種類の恩恵を自動的に与え、缶詰のプロファイルではなく実際のワークロードに適応します。これはコンパイル時に焼き込まれた静的プロファイルより厳密に優れています。JIT-with-PGO と AOT モデルのどちらを選ぶかは、[.NET 11 における Native AOT と ReadyToRun と素の JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)の主題です。

## PGO が実際に何かをしていることをどう確認するか

PGO は設計上静かなので、それが機能していることをどう知るのかが自然な問いになります。2 つのアプローチがあります。

1 つ目はマシンコードを見ることです。`DOTNET_JitDisasm` にメソッド名を設定すると tier 1 のアセンブリがダンプされ、GDV を通ったメソッドはそれと分かる形を見せます。型比較、インライン化された高速パス、そしてフォールバックの呼び出しです。PGO を無効にして再度ダンプすると、ガードとインライン化された本体は消え、素の仮想呼び出しが残ります。この前後比較こそ、プロファイルが出力を変えたという最も明確な証拠です。

```bash
# .NET 11 SDK 11.0.100. Dump the JIT's assembly for a specific method,
# then compare with DOTNET_TieredPGO=0 to see the guarded fast path vanish.
DOTNET_JitDisasm=Sum DOTNET_TieredPGO=1 ./myapp
```

2 つ目のアプローチはスループットを正しく計測することです。つまり、それに先立つ tier 0 のウォームアップではなく、定常状態の tier 1 コードを計測することです。`Stopwatch` のループを手作りしないでください。[BenchmarkDotNet](https://benchmarkdotnet.org/) を使いましょう。これは計測時間が安定するまでウォームアップし、同じベンチマークを PGO の有効・無効の両方で実行できるので、比較可能なものどうしを比較できます。階層化と JIT のイベントが実際のプロセスで流れていく様子を見たければ、[dotnet-trace で .NET アプリをプロファイルする方法](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)についての記事が、各メソッドの最適化階層を報告するランタイムのプロバイダーの捕捉手順を案内します。

胸に留めておくべきメンタルモデルはこうです。PGO は、.NET の「ホットなメソッドを 2 回コンパイルする」設計が静的コンパイラーには真似できないコードを生む理由です。2 回目のコンパイルが、あなたの実際のワークロードのプロファイルによって情報を与えられているからです。.NET 8 以降ではすでに有効で、すでに適応し、すでにその元を取っています。有効化する必要はありません。必要なのは、それがそこにあることを知っておくことだけです。そうすればベンチマークをするとき、最適化された階層を計測し、それが稼いだ速度をプロファイルの功績として認められます。

## Related

- [階層型コンパイルとは何か、どう捉えればよいか？](/ja/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [Native AOT とは何か、そして何を犠牲にするのか？](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [.NET 11 における Native AOT と ReadyToRun と素の JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [dotnet-trace で .NET アプリをプロファイルし、その出力を読む方法](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Sources

- [コンパイル構成設定, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Dynamic PGO 設計ドキュメント, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
- [Performance Improvements in .NET 8, .NET Blog](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/)
- [Bing on .NET 8: The Impact of Dynamic PGO, .NET Blog](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/)
