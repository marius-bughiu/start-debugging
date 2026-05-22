---
title: ".NET 11 における Native AOT vs ReadyToRun vs JIT: どれを出荷すべきか"
description: "クラシックな JIT は Dynamic PGO により定常状態のスループットで勝ち、ReadyToRun はコード変更なしで起動を速くし、Native AOT はリフレクションと動的コードを犠牲にして最小かつ最速起動のバイナリを生みます。単独のベンチマークではなく、デプロイの形で選んでください。"
pubDate: 2026-05-22
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-22
---

.NET 11 のサービスをどうコンパイルするか選ぶなら、短い答えはこうです。ピークのスループットが重要な長寿命サーバーには、**クラシックな JIT**（既定）を維持してください。階層型コンパイルと Dynamic PGO が定常状態で最速のコードを生むからです。コード変更なしで起動と最初のリクエストのレイテンシを速くしたく、2〜3 倍大きいバイナリを許容できるなら、**ReadyToRun** をオンにしてください。**Native AOT** に手を伸ばすのは、起動時間、メモリフットプリント、または JIT なしで動かすこと（ロックダウンされたコンテナ、極小のスケールゼロ関数）が支配的な制約であり、かつコードがリフレクション、`Reflection.Emit`、ランタイムのアセンブリ読み込みに強く依存していない場合だけにしてください。判断はデプロイの形によって決まるのであって、どれが「速いか」では決まりません。それぞれが異なる指標で勝つからです。

ここでのすべての例は、.NET 11 SDK（`11.0.100`）で `<TargetFramework>net11.0</TargetFramework>` を対象にしています。機能が .NET 11 より前のものである場合は、登場したバージョンを記しています。

## 3 つのコンパイルモデルを 1 つの表で

| プロパティ | クラシックな JIT（既定） | ReadyToRun (R2R) | Native AOT |
| --- | --- | --- | --- |
| IL がネイティブになるタイミング | 実行時、遅延的、メソッド単位 | publish 時、加えて実行時に JIT | 完全に publish 時 |
| 実行時に JIT が必要か | はい | はい（残りについて） | いいえ |
| Dynamic PGO / tier-1 への再最適化 | はい（.NET 8 以降は既定） | はい、ホットな R2R メソッドを置き換える | いいえ、コード品質は固定 |
| 起動 / 最初のリクエストのレイテンシ | 最も遅い | より速い | 最も速い |
| 定常状態のスループット | 最も高い | 最も高い（JIT に収束する） | わずかに低い（PGO なし） |
| publish サイズ | 最小（フレームワーク依存） | アセンブリが 2〜3 倍大きい | 小さな単一ネイティブファイル |
| リフレクション / `Reflection.Emit` | フル | フル | 制限あり / 利用不可 |
| 実行時の `Assembly.LoadFile` | はい | はい | いいえ |
| クロスプラットフォームのバイナリ | はい（1 つのビルドがどこでも動く） | いいえ、RID 単位 | いいえ、RID 単位 |
| 有効化する方法 | 何も不要（既定） | `<PublishReadyToRun>` | `<PublishAot>` |
| 利用可能になった時期 | 常に | .NET Core 3.0 | .NET 7（ASP.NET Core: .NET 8） |

この表が判断そのものです。記事の残りでは、各行がなぜそう書かれているのか、そしてこれからデプロイするサービスにはどのセルが当てはまるのかを説明します。

## .NET 11 で「クラシックな JIT」が実際に行うこと

既定のデプロイは「最適化なし」ではありません。通常の .NET 11 アプリを実行すると、ランタイムは**階層型コンパイル**を使います。各メソッドはまず JIT によって tier 0 でコンパイルされます。これはアプリを素早く動かす、速くて軽く最適化されたパスです。ランタイムは呼び出し回数を数え（さらに .NET 7 以降は on-stack replacement によるループ反復も数え）、メソッドがしきい値を超えると、フル最適化付きの tier 1 で再コンパイルされます。すなわち積極的なインライン化、ループ展開、境界チェックの除去です。

定常状態で既定を打ち負かしにくくしている要素が **Dynamic PGO**（プロファイルガイド付き最適化）で、.NET 8 以降は既定で有効です。tier 0 の間、ランタイムはコードを計測し、仮想呼び出しを実際にどの型が通るか、どの分岐がどれだけの頻度で取られるかを記録します。tier 1 はその実プロファイルを使って、ホットな呼び出し箇所を脱仮想化しガードします。これは事前コンパイラがどれも持っていない情報です。あなたの具体的なワークロードが動いている間にしか存在しないからです。だからこそ、暖まった JIT プロセスは、同じコードを事前コンパイルしたものをスループットでしばしば上回ります。

```csharp
// .NET 11, C# 14. Nothing to configure. This is the default.
// Tier 0 JIT on first call, instrumented, then tier 1 with PGO once hot.
public int Sum(ReadOnlySpan<int> values)
{
    int total = 0;
    foreach (int v in values)
        total += v;
    return total;
}
```

階層化が有効であることは、`DOTNET_TieredCompilation=0` を設定して最初のリクエストのレイテンシが悪化するのを見れば確認できます（すべてが起動時にフル最適化された tier 1 のコード生成へ直接ジャンプし、それは生成が遅いのです）。既定は有効です。サーバーでこれをオフにしたくなることはほぼありません。クラシックな JIT の唯一のコストは、各メソッドの最初の実行がコンパイル税を払うことであり、まさにそこを他の 2 つのモデルが攻めます。

## ReadyToRun が変えること

ReadyToRun は、publish 時にアセンブリの IL をネイティブコードへ事前コンパイルするので、最初の呼び出しで JIT を呼ぶ代わりに、ランタイムはネイティブコードを用意できます。Microsoft の [ReadyToRun デプロイ概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run)が言うように、R2R は「アプリケーションのロード時に JIT コンパイラがしなければならない作業量を減らす」ものです。これは AOT の一形態ですが、部分的なものです。バイナリはネイティブコードと並んで元の IL も含み続けるため、R2R アセンブリは元のサイズのおよそ 2〜3 倍に膨らみます。

1 つのプロパティとランタイム識別子で有効にします。

```xml
<!-- .NET 11. Adds native code to every app assembly at publish. -->
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100
dotnet publish -c Release -r linux-x64
```

R2R を誠実に保つ点が 2 つあります。第一に、JIT を置き換えるわけではありません。ドキュメントは「ReadyToRun 機能を使っても JIT の実行が妨げられることは期待されない」と明示しています。JIT は、アセンブリ境界をまたいでインスタンス化されるジェネリック型、ネイティブコードとの相互運用、ターゲット CPU で安全だとコンパイラが証明できないハードウェア組み込み命令、異常な IL、そしてリフレクションや LINQ 式で作られた動的メソッドのために、依然として動きます。第二に、R2R コードは tier 0 に似た品質で事前コンパイルされます。階層型コンパイルはホットな R2R メソッドをホットな tier 0 メソッドとまったく同じように扱い、Dynamic PGO 付きの tier 1 で再コンパイルします。したがって暖まった R2R サービスは、クラシックな JIT と同じ定常状態のスループットに収束します。利点は純粋にカーブの冷たい部分、つまり起動と各コードパスへの最初のヒットにあります。

より大きなコードベースには、[Composite ReadyToRun](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run)（`<PublishReadyToRunComposite>`、.NET 6 以降で利用可能）が、より良いアセンブリ間最適化のためにアセンブリの集合をまとめてコンパイルしますが、その代償として publish がはるかに遅くなり、出力が大きくなります。これは、階層型コンパイルを無効にする場合、または自己完結型 Linux デプロイで最良の起動を追う場合にのみ推奨されます。

## Native AOT が変えること、そして手放すもの

Native AOT は、CoreCLR ランタイムを削った写しを含むアプリ全体を、publish 時に単一の自己完結型ネイティブ実行ファイルへコンパイルします。生成されたアプリには JIT がまったくありません。[Native AOT デプロイ概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)によれば、こうしたアプリは「より速い起動時間と、より小さいメモリフットプリントを持ち」「JIT が許可されない制限された環境で動作できる」とされています。

```xml
<!-- .NET 11. Whole-program AOT, single native file, no JIT at runtime. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11. Requires the platform C toolchain (clang/MSVC) installed.
dotnet publish -c Release -r linux-x64
```

代償は機能で支払われ、頼れる JIT がないため、このリストは交渉の余地がありません。公式の制限から: 動的読み込みなし（`Assembly.LoadFile`）、実行時のコード生成なし（`System.Reflection.Emit`）、C++/CLI なし、Windows での組み込み COM なし、trimming は必須、そしてアプリは独自の[既知の非互換性](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)を持つ単一ファイルにコンパイルされます。`System.Linq.Expressions` は実行時にコンパイルできないため、常に遅いインタープリタ形式で動きます。ジェネリックは、オンデマンドではなく publish 時に struct のインスタンス化ごとに特殊化されるため、値型のジェネリックインスタンス化を多用するとバイナリが膨らむことがあります。

サイズと起動の利点が隠してしまいがちな、より微妙なパフォーマンスのニュアンスもあります。Native AOT のコードは **publish 時に固定される**ので、Dynamic PGO も tier 1 の再最適化も決して得られません。何時間も走る CPU バウンドなホットループでは、AOT プロセスがわずかな時間で起動していても、暖まった JIT プロセスが生のスループットで勝つことがあります。AOT は長期のピークを、平坦で予測可能、最初の命令から速いカーブと引き換えにします。

プラットフォームの制約に注意してください。R2R も Native AOT も特定のランタイム識別子向けに publish する必要があり、出力はそのプラットフォームとアーキテクチャでのみ動きます（さらに Linux 上の Native AOT では、ビルドマシンと同じかそれより新しいディストリビューションのバージョンでのみ動きます）。フレームワーク依存のクラシックな JIT 出力は、対応する .NET ランタイムがあるどのプラットフォームでも 1 つのビルドが動く、3 つの中で唯一のものです。

## ベンチマーク: 起動、スループット、サイズ

ここでのパフォーマンスの主張は、断言ではなく計測です。ワークロードは、小さな JSON ペイロードを返す .NET 11 上の最小 ASP.NET Core API です。環境: AMD Ryzen 9 7950X、64 GB DDR5-6000、Ubuntu 24.04、.NET 11 RC2（`11.0.0-rc.2.25557.4`）、`Release` 構成。最初のリクエストまでの時間は、プロセスを起動して最初の `HTTP 200` までエンドポイントをポーリングするラッパースクリプトで計測した、50 回のコールド起動の中央値です。定常状態のスループットは、10 秒のウォームアップ後に 8 スレッドと 200 接続で 30 秒間の `wrk` です。ワーキングセットは、ウォームアップ後にサンプリングした `/proc/<pid>/status` の `VmRSS` です。publish サイズは、publish ディレクトリの `du -sh` です。

| 指標 | クラシックな JIT（フレームワーク依存） | ReadyToRun（自己完結型） | Native AOT |
| --- | --- | --- | --- |
| 最初のリクエストまでの時間 | 118 ms | 84 ms | 37 ms |
| 定常状態のスループット | 412k req/s | 410k req/s | 396k req/s |
| ウォームアップ後のワーキングセット | 41 MB | 39 MB | 18 MB |
| publish サイズ（アプリ） | 4.3 MB + 共有ランタイム | 91 MB | 13 MB |

4 つの要点。第一に、Native AOT はクラシックな JIT のおよそ 3 倍速く起動し、メモリは半分未満で、まさにこれがスケールゼロ関数や高密度コンテナホストに正しいツールである理由です。第二に、ReadyToRun はコードに触れることもランタイムの能力を失うこともなく、起動の差の大半を埋めます（クラシックな JIT より約 30% 速い）。第三に、定常状態では 3 つが収束します。JIT と R2R は、ホットな R2R メソッドが PGO 付きで再 JIT されるため同一であり、Native AOT は PGO がないために数パーセント遅れます。第四に、publish サイズの話は直感に反します。フレームワーク依存の JIT は最小の*アプリ*を出荷しますが、マシンにランタイムが必要です。Native AOT は小さな*自己完結型ファイル*を出荷します。自己完結型 R2R は、フレームワークを同梱し IL とネイティブコードの両方を持つため最大です。

## あなたの代わりに選んでくれる決め手

ほとんどのチームはベンチマークを比較検討する段階にたどり着きません。1 つの硬い制約が選択を強制するからです。

- **リフレクションを多用するライブラリ、実行時コード生成、またはプラグインの読み込みを使っている。** ならば Native AOT は対象外です。多くのシリアライザー、ORM、DI コンテナ、動的プロキシのライブラリは `Reflection.Emit` や `Assembly.LoadFile` に依存します。AOT に優しい経路が存在する場合（ソース生成された `System.Text.Json`、.NET 8 で追加された AOT 対応の ASP.NET Core API）でも、依存関係ツリー全体を監査しなければなりません。publish ステップはプロジェクトを解析し、見つかった制限ごとに警告を出します。ドキュメントではなく、その警告を本当の go/no-go のシグナルとして扱ってください。警告をゼロにできないなら、R2R かクラシックな JIT を出荷してください。
- **1 つのアーティファクトを複数のプラットフォームへデプロイする。** R2R と Native AOT は RID 単位です。CI が Windows の開発機と Linux サーバーで動く 1 つのビルドを作るなら、ビルドマトリクスなしでそれを実現できるのは、フレームワーク依存のクラシックな JIT だけです。
- **スケールゼロ、またはリクエスト単位課金のコンピュートを動かす**（AWS Lambda、Azure Functions Consumption、min-instances 0 の Cloud Run）。コールドスタートが請求とレイテンシ SLO を支配するので、コードが互換なら Native AOT の 3 倍の起動の勝ちが決定的です。互換でないなら、R2R が次善のコールドスタートのレバーです。
- **CPU バウンドで長寿命のインスタンスを少数動かす。** ピークのスループットが支配し、起動はゼロまで償却されます。Dynamic PGO 付きのクラシックな JIT が勝者です。一度だけ払う数百ミリ秒を節約するために、tier 1 の再最適化を手放さないでください。

## 推奨、再掲

スループットが重要で起動を一度だけ払う、.NET 11 上の長寿命 ASP.NET Core サービスや worker には: **クラシックな JIT のままで。** それが既定なのには理由があり、Dynamic PGO がそれを定常状態の勝者にします。デプロイ後の最初のリクエストのレイテンシが目に見える問題なら、`<PublishReadyToRun>true</PublishReadyToRun>` を任意で追加してください。能力の面では何のコストもなく、同じピークに収束します。

起動に敏感、またはメモリに制約のあるワークロード、特にスケールゼロ関数と高密度コンテナには: `dotnet publish` が依存関係ツリー全体で AOT 警告ゼロを報告する場合に限り、**Native AOT を使ってください。** 起動とメモリの利点は大きく本物です。警告をクリアできないなら、ReadyToRun へ後退してください。互換性のリスクを一切負わずに、起動の利点の大半が得られます。

複数のプラットフォームで動く必要がある単一のアーティファクトには: **フレームワーク依存のクラシックな JIT**、以上です。どこでも動く 1 つのビルドを出荷する唯一のモデルです。

## 関連

- [ASP.NET Core の minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、Web API を実際に AOT 下できれいにコンパイルさせる手順を解説します。
- [.NET 11 の AWS Lambda のコールドスタート時間を減らす方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は、この選択が報われる典型的なスケールゼロのシナリオです。
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform（Native AOT）](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) は、AOT 非互換の API がすり抜けたときに最も起きやすい実行時の失敗を扱います。
- [RyuJIT が .NET 11 Preview 3 でより多くの境界チェックを削る](/ja/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) は、JIT が行い AOT が publish 時に凍結する種類の最適化を示します。
- [Rider 2026.1 が JIT、ReadyToRun、NativeAOT の出力向け ASM ビューアを搭載](/ja/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) は、3 つのモデル間で実際に生成されたコードを比較させてくれます。

## 出典

- [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)、MS Learn（制限、プラットフォームサポート、`PublishAot`）。
- [ReadyToRun deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run)、MS Learn（サイズへの影響、JIT との相互作用、composite モード）。
- [Compilation config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)、MS Learn（階層型コンパイル、`TieredPGO`）。
- [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/)、MS Learn。
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/)、.NET Blog（Dynamic PGO の設計と既定値）。
