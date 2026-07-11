---
title: "階層型コンパイルとは何か、どう捉えればよいのか？"
description: "階層型コンパイルは、.NET の JIT に各メソッドを2回コンパイルさせます。まずアプリを起動させるために高速かつ未最適化で、次にランタイムがメソッドをホットだと認識した時点で完全な最適化を施して再度コンパイルします。本記事では tier 0、tier 1、オンスタック置換、Dynamic PGO がどう組み合わさるか、そしてそれらをどう観測し調整するかを解説します。"
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "ja"
translationOf: "2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it"
translatedBy: "claude"
translationDate: 2026-07-11
---

階層型コンパイルは、各メソッドを複数回コンパイルするという .NET ランタイムの戦略です。メソッドが初めて実行されるとき、JIT（just-in-time）コンパイラは「tier 0」のコードを高速かつほとんど最適化なしで生成し、アプリが素早く起動できるようにします。その後そのメソッドがホットだと判明した場合（少なくとも30回呼び出される、または長いループで回り続ける場合）、バックグラウンドのスレッドが完全に最適化された「tier 1」のコードとして再コンパイルし、静かに差し替えます。起動速度と定常状態のスループットの両方を、どちらかを選ぶことなく同じバイナリから得られます。この機能は .NET Core 3.0 以降デフォルトで有効になっており、.NET 8 以降ではプロファイラー（Dynamic PGO）にも情報を供給して、静的コンパイラでは実現できないほど tier 1 のコードを賢くします。本記事では、その可動部分と、プロファイリングやベンチマークの際にそれらをどう捉えるかを説明します。

本記事の内容はすべて .NET 11 SDK（`11.0.100`）を用いた `<TargetFramework>net11.0</TargetFramework>` を対象としていますが、その仕組みは .NET 7 以降安定しています。.NET 7 では、オンスタック置換とループの高速 JIT が x64 と arm64 でデフォルトの挙動になりました。挙動が特定のバージョンに依存する場合は、その旨を明記します。

## なぜランタイムは同じメソッドを2回コンパイルするのか

JIT コンパイラは、メソッドを初めて見るたびにジレンマに直面します。そのメソッドを時間をかけてコンパイルし、優れた機械語を生成することもできます。これは100万回実行されるメソッドには最適ですが、起動時に1回だけ実行されるメソッドには無駄です。あるいは高速にコンパイルして凡庸なコードを生成することもできます。これは起動には最適ですが、ホットパスではスループットを取りこぼします。

ahead-of-time コンパイラは、すべてを事前に最適化することでこれを回避し、その代償としてビルド時間と大きなバイナリを支払います。常に最適化する純粋な JIT は、遅い起動という代償を支払います。なぜなら、実際のアプリケーションは最初のリクエストを処理する前に数千のメソッドを JIT コンパイルするからです。階層型コンパイルは、選ぶことを拒みます。まず高速にコンパイルしてプロセスを動き出させ、次にどのメソッドが本当に重要かを観察し、そのメソッドだけを高価な最適化器で再コンパイルします。どのプロセスでも大多数のメソッドは数回しか実行されず、tier 1 を勝ち取ることは決してないため、最適化器の予算は報われる場所に向かいます。

## tier 0 と tier 1：「高速」と「最適化済み」が実際に意味するもの

tier 0 は「quick JIT」によって生成されます。コンパイラはほとんどの最適化を省きます。積極的なインライン化なし、ループの展開なし、最小限のレジスタ割り当てです。完全なコンパイルにかかる時間のごく一部で、素直な機械語を出力します。その結果のコードは正しく、しばしば最適化済みコードより数倍遅いものの、ほぼ即座に存在します。

tier 1 は完全な最適化器です。インライン化を行い、冗長だと証明できる箇所では境界チェックを除去し、不変式をループの外に引き上げ、（.NET 8 以降は）tier 0 の実行中に収集したプロファイルデータを使います。tier 1 のコンパイルは生成にはるかに時間がかかります。これこそランタイムが、価値があると証明されたメソッドにだけそれを費やす理由です。

同じシステムに参加するコードの第3の供給源があります。ReadyToRun（R2R）です。フレームワークのアセンブリは事前コンパイル済みの R2R コードとともに配布されるため、ランタイムは起動のたびに `string.Substring` を JIT コンパイルする必要がありません。R2R コードは、事前に焼き上げられた層として扱われ、そのメソッドがあなた固有のワークロードでホットだと判明した時点で、さらに優れた tier 1 版に置き換えられることがあります。だからこそ、階層型コンパイルを無効にすると、アプリが速くなるどころか遅くなることが時々あるのです。あなたのプロファイルでフレームワークのメソッドを再最適化する能力を失うからです。

## 呼び出し回数のしきい値と階層化の遅延

メソッドは温まった瞬間に tier 1 へ跳ね上がるわけではありません。2つの仕組みが昇格を制御します。

1つ目は呼び出しカウンターです。各 tier 0 メソッドにはカウンターがあり、30回呼び出された時点で（`DOTNET_TC_CallCountThreshold` のデフォルト値）、tier 1 の再コンパイルのためにキューに入れられます。30 は意図的に低い値です。狙いは、遅いコードで数千回実行されるのを待たずに、繰り返し実行されるものを捕まえることです。

2つ目は起動時の遅延です。ランタイムはすぐに呼び出しを数え始めません。起動中はほぼすべてのメソッドが初めて呼び出されており、定常状態でホットなものはまだ1つもないからです。新しい tier 0 メソッドが JIT コンパイルされるたびにリセットされる、およそ100 ミリ秒のタイマーがあります。そのタイマーが新しい tier 0 コンパイルなしで経過したとき、つまり起動時の JIT の嵐が収まったときにのみ、呼び出しのカウントが本格的に始まります。だからこそ起動そのものは安価な tier 0 コードにとどまり、最適化器は初期化中にしか実行されなかったメソッドの上で無駄に動き回らないのです。

再コンパイルは、スレッドプールから借りたバックグラウンドスレッドで、1回あたり約10 ミリ秒のスライスで行われるため、ワーカーを独占することは決してありません。あなたのホットなメソッドは、最適化された版が準備できるまで tier 0 のコードを実行し続け、準備できた時点でランタイムは以降の呼び出しをアトミックに tier 1 のコードへ振り向けます。何もブロックされず、実行中の呼び出しが中断されることもありません。

```csharp
// .NET 11, C# 14.
// Call this in a tight loop and the runtime will promote it to tier 1
// after ~30 calls, once startup has settled. You will not see the
// promotion in the method's behavior, only in its speed.
static long SumOfSquares(int n)
{
    long acc = 0;
    for (int i = 0; i < n; i++)
        acc += (long)i * i;
    return acc;
}
```

## オンスタック置換：決して戻らないホットなループから抜け出す

呼び出しカウントの仕組みには明白な穴があります。ちょうど1回だけ呼び出され、その後プロセスの生涯にわたってループで回り続けるメソッドはどうなるのでしょうか。`Main` や、キューを永遠に反復するワーカーを考えてみてください。その呼び出し回数は1なので、遅い tier 0 のコードに永久に閉じ込められてしまいます。

オンスタック置換（OSR, on-stack replacement）がこの穴を塞ぎます。quick JIT がループを含むメソッドの tier 0 コードを出力するとき、ループの後方エッジ（先頭へ戻るジャンプ）に小さなカウンターも挿入します。その後方エッジが十分な回数実行されると、ランタイムはメソッドの最適化版をコンパイルし、実行中のスタックフレームをその場で置き換えて、実行を飛行中に移します。tier 0 で始まったループは、メソッドが一度も戻ることなく tier 1 で終わります。

そもそもループを含むメソッドを quick JIT で安全にコンパイルできるのは、OSR のおかげです。OSR が登場する前、ランタイムはループを含むいかなるメソッドにも quick JIT を適用することを拒んでいました（`TieredCompilationQuickJitForLoops` の古いデフォルト値 `false`）。未最適化のコードに閉じ込められた長いループは、性能上の本物の崖だったからです。[dotnet/runtime の PR #65675](https://github.com/dotnet/runtime/pull/65675) は、.NET 7 で x64 と arm64 に対して `DOTNET_TC_QuickJitForLoops` と `DOTNET_TC_OnStackReplacement` の両方をデフォルトで有効にしました。そのため今日ではほぼすべてのメソッドが tier 0 で始まり、ランタイムは長いループに閉じ込められたものを救い出すために OSR に頼ります。その結果、JIT 負荷の高いアプリケーションでおよそ25 %の起動改善が得られ、TechEmpower のベンチマークでは最初のリクエストまでの時間が10 ~ 30 %改善しました。これは [.NET 7 の性能レポート](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/)によるものです。

## Dynamic PGO：tier 0 のパスはプロファイリングも行う

ここが人々を驚かせる部分です。.NET 8 以降、Dynamic PGO（profile-guided optimization）はデフォルトで有効であり、これこそが2パス設計全体を単なる「2回コンパイルする」以上のものにしています。

Dynamic PGO が有効なとき、tier 0 のコードは未最適化であるだけでなく、計測用に仕込まれてもいます。メソッドが実際にどう振る舞うかについて、安価な事実を記録します。仮想呼び出しのサイトにどの具体型が現れるか、`if` のどの分岐が最も頻繁に選ばれるか、ループが何回反復するか、といったことです。メソッドが tier 1 に昇格すると、最適化器はそのプロファイルを読み、実行時に実際に起きたことに合わせてコードを特殊化します。呼び出し先が99 %の確率で `List<int>` だった仮想呼び出しは、型チェックで守られた形でその経路がインライン化されます（ガード付き仮想化解除）。ほとんど選ばれない分岐は、ホットパスから追い出されます。

これは静的コンパイラには行えない最適化です。あなた固有のワークロードが動いている間にしか存在しないデータに依存するからです。また、これこそ階層型コンパイルと Dynamic PGO の組み合わせが、起動だけでなく実際のスループットでも、最初から完全最適化された構成を上回れる理由です。比較のために無効化することもできます。

```xml
<!-- .NET 11, C# 14. Disables Dynamic PGO. Default is enabled since .NET 8. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

トレードオフは、計測付きの tier 0 コードが素の tier 0 よりわずかに遅く、わずかに大きく、tier 1 の結果がより良くなることです。何時間も動くサーバーにとっては、これは簡単な勝ちです。何かが tier 1 に到達する前に終了する短命な関数にとっては、計測は報酬のない純粋なコストであり、これはコールドスタートに敏感なワークロードが時々これをオフにする理由の1つです。このシナリオのより詳しい扱いは、[.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)のガイドにあります。

## 階層化が実際に起きるのを見る方法

階層型コンパイルについて捉えることは、それを見られるようになると格段に容易になります。ランタイムは各 JIT コンパイルについて、tier のタグを付けた ETW/EventPipe イベントを発行するため、`dotnet-trace` で遷移を見ることができます。

```bash
# .NET 11 SDK 11.0.100. Capture JIT and tiering events for a running process.
dotnet-trace collect --process-id 1234 \
  --providers Microsoft-Windows-DotNETRuntime:0x1000:5
```

`MethodJittingStarted` と `MethodLoadVerbose` のイベントには最適化階層のフィールドが含まれるため、あるメソッドが2回、まず tier 0 として、次に tier 1 として現れれば、それがあなたの探している昇格です。これらのトレースの読み方の手順については、[dotnet-trace で .NET アプリをプロファイリングする方法](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)の記事を参照してください。

各階層で JIT が生成した機械語を見たい場合、`DOTNET_JitDisasmSummary=1` はメソッドごとにその tier を1行で出力し、`DOTNET_JitDisasm` にメソッド名を設定すると実際のアセンブリをダンプします。[Rider 2026.1 の逆アセンブルビューア](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)のようなツールは、環境変数と格闘することなく同じ出力を見せてくれます。同じメソッドの tier 0 と tier 1 の逆アセンブルを比較することは、「最適化済み」が何をもたらすかについての直観を養う最速の方法です。

## 誰もがはまる計測の罠

階層型コンパイルにまつわる最も一般的な間違いは、うっかり tier 0 のコードを計測してしまうことです。ストップウォッチのループを書いてメソッドを数千回実行し結果を平均すると、初期の反復は遅い tier 0 で実行され、途中で昇格が起き、平均は2つの異なるコード片の無意味な混合になります。

対処法はウォームアップです。昇格を引き起こすのに十分な回数メソッドを実行し、バックグラウンドのコンパイルが完了するのを待ってから計測を始めます。これはまさに [BenchmarkDotNet](https://benchmarkdotnet.org/) があなたの代わりに行うことです。ウォームアップフェーズを実行し、時間が安定した時点を検出し、定常状態の tier 1 のコードを計測します。`Stopwatch` を使ってマイクロベンチマークを手作りし、その数字を信じてはいけません。ほぼ確実に間違った tier を計測しています。どうしても必要なら、`DOTNET_TieredCompilation=0` を設定してすべてを直接最適化コードにコンパイルさせて問題を強制的に解決できますが、これは起動時の挙動を変えますし、本番であなたのアプリが動く姿でもありません。

## つまみと、実際にいつ触るべきか

デフォルト値は良好です。.NET チームは膨大な実アプリケーション群に対してそれらを調整しており、ほとんどのプロジェクトにとって正直な答えは、どの設定にも手を触れないことです。とはいえ、レバーには理由があって存在します。

- `TieredCompilation`（env `DOTNET_TieredCompilation`、デフォルトで有効）：これをオフにするのは、はるかに遅い起動を代償に、あらゆる場所で完全最適化コードを強制する場合だけにしてください。長いウォームアップを許容でき、tier 0 のジッターをゼロにしたいレイテンシ重視のサービスには時折有用ですが、決める前に計測してください。
- `TieredCompilationQuickJit`（env `DOTNET_TC_QuickJit`、デフォルトで有効）：これを無効にすると tier 0 が完全な最適化器を使うようになり、目的の大半が損なわれます。
- `TieredCompilationQuickJitForLoops`（env `DOTNET_TC_QuickJitForLoops`、x64/arm64 では .NET 7 以降デフォルトで有効）：OSR と組み合わさっており、変える価値があることはめったにありません。
- `TieredPGO`（env `DOTNET_TieredPGO`、.NET 8 以降デフォルトで有効）：超短命なプロセスのために正当に無効化するかもしれないもの、あるいはデフォルト変更以前の .NET 6/7 アプリのために有効化するかもしれないものです。

これらはすべて `.csproj` の MSBuild プロパティと、`runtimeconfig.json` の `System.Runtime.*` キーに対応しており、Microsoft の[コンパイル構成設定](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)のリファレンスに文書化されています。階層型 JIT と JIT を完全に手放すことを天秤にかけているなら、そのトレードオフは [Native AOT 対 ReadyToRun 対 素の JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) と、[Native AOT があなたに何を強いるか](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)のより深い考察にあります。AOT のコードは Dynamic PGO の再最適化をまったく受けないからです。

心に留めておくべきメンタルモデルはこうです。あなたのプロセスは、静かにメモを取っている、安価で生成の速い tier 0 のコードで起動します。少数のメソッドが自らホットであることを証明します。バックグラウンドのスレッドが、そのメモに基づいた完全な最適化器で、まさにそれらのメソッドを書き換えます。そして OSR が、呼び出しカウントでは取りこぼすであろう、ループに閉じ込められたものを捕まえます。それがトレースの中で起きているのを見られるようになれば、階層型コンパイルはブラックボックスであることをやめ、あなたが捉えられるツールになります。

## 関連記事

- [.NET 11 における Native AOT 対 ReadyToRun 対 素の JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Native AOT とは何か、そして何を強いるのか？](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [dotnet-trace で .NET アプリをプロファイリングし、出力を読む方法](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [JIT と Native AOT の逆アセンブルのための Rider 2026.1 の ASM ビューア](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)

## 出典

- [コンパイル構成設定, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [階層型コンパイルの設計ドキュメント, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/tiered-compilation.md)
- [オンスタック置換の設計ドキュメント, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/OnStackReplacement.md)
- [Enable QJFL and OSR by default for x64 and arm64, PR #65675](https://github.com/dotnet/runtime/pull/65675)
- [Performance Improvements in .NET 7, .NET Blog](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/)
- [Dynamic PGO の設計ドキュメント, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
