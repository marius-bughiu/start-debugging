---
title: "Native AOT とは何か、そして何を犠牲にするのか?"
description: "Native AOT は .NET アプリを JIT のない単一の自己完結型ネイティブバイナリにコンパイルし、高速な起動と小さなメモリフットプリントを手に入れます。その代償は、ビルド時の C ツールチェーン、遅くなるパブリッシュ、RID ごとのビルド、リフレクションや Reflection.Emit の不可、必須のトリミング、そして Dynamic PGO の不在です。ここに完全な収支を示します。"
pubDate: 2026-06-19
tags:
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
  - "csharp"
lang: "ja"
translationOf: "2026/06/what-is-native-aot-and-what-does-it-cost-you"
translatedBy: "claude"
translationDate: 2026-06-19
---

Native AOT は .NET のパブリッシュモデルで、アプリ全体に加えて縮小したランタイムのコピーを、事前に単一の自己完結型ネイティブ実行ファイルへコンパイルします。生成されるアプリには JIT コンパイラーがないため、起動が速くメモリ使用量も少なく、.NET ランタイムがインストールされていないマシンでも動作します。コストは 3 つの通貨で支払われます。ビルド時の摩擦 (C ツールチェーンが必要で、パブリッシュが遅くなり、各ビルドは 1 つの OS とアーキテクチャだけを対象にします)、実行時の機能の喪失 (リフレクションに依存するコード、`System.Reflection.Emit`、アセンブリの動的読み込みは不可で、トリミングは必須)、そしてしばしば目に見えないスループットの小さな低下です。AOT のコードはプロファイルに基づく再最適化を一度も受けないからです。このトレードオフが見合うかどうかは、ベンチマークの数値ではなく、あなたのデプロイの形にすべて依存します。この記事は、スイッチを入れる前に判断できるようにするための完全な収支です。

ここで扱うものはすべて .NET 11 SDK (`11.0.100`) で `<TargetFramework>net11.0</TargetFramework>` を対象とします。Native AOT 自体は .NET 7 で登場し、ASP.NET Core のサポートは .NET 8 で入ったため、以下の仕組みはバージョンが明記されていない限り .NET 8 以降に当てはまります。

## ここでの「事前」が本当に意味すること

通常の .NET アプリは IL (中間言語) として配布されます。実行時に JIT コンパイラー (just-in-time) がその IL を、各メソッドが初めて実行されるときに、メソッドごとに遅延しながらネイティブのマシンコードに変換します。起動したばかりの .NET プロセスが最初のいくつかのリクエストで少し遅いのはそのためで、進みながら自分自身をコンパイルしているのです。これが機能するには、ランタイム、GC、JIT がマシン上に存在している必要があります。

Native AOT は JIT を方程式から完全に取り除きます。`<PublishAot>true</PublishAot>` を指定して `dotnet publish` を実行すると、SDK は AOT コンパイラーである ILC を起動し、あなたのすべての IL、依存関係のすべての IL、そして縮小版の CoreCLR ランタイムを、単一のネイティブバイナリへコンパイルします。Microsoft の [Native AOT デプロイの概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) が述べるように、これらのアプリは「より速い起動時間と小さなメモリフットプリント」を持ち、「JIT が許可されない制限された環境で動作できます」。

最小限の有効化は、1 つの MSBuild プロパティとランタイム識別子です。

```xml
<!-- .NET 11, C# 14. Enables ILC at publish and turns on AOT analysis while editing. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. The -r RID is mandatory: AOT output is platform-specific.
dotnet publish -c Release -r linux-x64
```

パブリッシュディレクトリ内の出力は、実行に必要なすべてを「縮小版の coreclr ランタイムを含めて」内包する単一の実行ファイルです。インストールすべき別のランタイムはなく、バイナリの内部に JIT もありません。この一文が機能のすべてであり、同時にコストのすべてです。以下の制限はすべて「実行時に JIT が存在しない」ことから導かれます。

## ビルド時の請求書

コードを 1 行書く前に、Native AOT はあなたのビルドマシンと CI に必要なものを変えます。

**ネイティブの C ツールチェーンが必要です。** ILC はオブジェクトコードを生成し、それをプラットフォームのリンカーが本物の OS 実行ファイルにリンクする必要があるため、[前提条件](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) は OS ごとに交渉の余地がありません。Windows では「C++ によるデスクトップ開発」ワークロードを含む Visual Studio 2022 以降が必要です。Linux では clang と zlib の開発ヘッダーをインストールします (Ubuntu では `sudo apt-get install clang zlib1g-dev`、Fedora と RHEL では `sudo dnf install clang zlib-devel`、Alpine では `sudo apk add clang build-base zlib-dev`)。macOS では Xcode の Command Line Tools が必要です。素の `dotnet` SDK イメージはもはやビルドエージェントには十分ではなく、ツールチェーンを CI イメージにも焼き込む必要があります。

**パブリッシュが遅くなります。** プログラム全体のコンパイルに加えてトリミング、さらにネイティブリンクは、IL を出力するよりもはるかに多くの作業です。フレームワーク依存のアプリで数秒で終わるパブリッシュが、AOT では数分かかることがあり、それは依存関係グラフのサイズに比例します。これは実行ごとではなくパブリッシュごとの税ですが、通常は内側のループのビルドごとに AOT を実行せず、パブリッシュ時にだけ実行する程度には現実的です。

**各ビルドは RID ごとです。** AOT の出力は、コンパイルした OS と CPU アーキテクチャでのみ動作します。`win-x64` 向けにコンパイルしたバイナリは `linux-arm64` では動作しません、以上です。Linux では特にさらに厄介で、あるディストリビューションのバージョンでビルドしたバイナリは、そのバージョン以降でのみ動作します。ドキュメントは「Ubuntu 20.04 で生成された Native AOT バイナリは Ubuntu 20.04 以降では動作するが、Ubuntu 18.04 では動作しない」と明記しています。複数のプラットフォームに配布する場合、ビルドマトリックス、つまり RID ごとに 1 回のパブリッシュが必要です。.NET 9 は .NET 8 がサポートしていた x64 と Arm64 に加えて、Windows/Linux の x86 と 32 ビット Arm を対象に含めるよう拡大しました。

これをフレームワーク依存の JIT アプリと比べてみてください。そちらでは、単一のビルドが、対応する .NET ランタイムを持つあらゆるマシンで動作します。その移植性は、あなたが手放そうとしているものの 1 つです。

## あなたが手放す実行時の機能

ここがほとんどのプロジェクトの判断を決める部分です。なぜなら、損失は「遅くなる」ではなく「動作しない、そしてパブリッシュのステップが警告してくれる」だからです。JIT がないので、実行時にコードを生成したり発見したりすることに依存するものはすべて対象外になります。[公式の制限](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) からそのまま挙げると、

- **動的読み込みは不可**、例えば `Assembly.LoadFile` です。フォルダーをスキャンして DLL を探し実行時に読み込むプラグインアーキテクチャは機能できません。コードがバイナリにコンパイルされていないからです。
- **実行時のコード生成は不可**、例えば `System.Reflection.Emit` です。これはエコシステムの驚くほど多くの部分を静かに取り除きます。動的プロキシのライブラリ (Castle DynamicProxy)、一部のモッキングフレームワーク、そして速度のために IL を出力するあらゆるシリアライザーやマッパーです。
- **C++/CLI は不可**、そして Windows では **組み込みの COM は不可** です。
- **トリミングは必須です。** トリマーは、到達可能だと証明できないコードをすべて削除します。無制限のリフレクション (文字列からの `Type.GetType("SomeName")`、`GetProperties()` による走査、`Activator.CreateInstance(someType)`) はその解析を台無しにするため、リフレクションに大きく依存するコードは、注釈が必要になるか、ソースジェネレーターで置き換える必要があります。
- **単一ファイルへのパッケージ化が暗黙的に行われます。** これは独自の [既知の非互換性](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview) を伴います (ディスク上の `.dll` を前提とする API、空を返す `Assembly.Location` など)。
- **`System.Linq.Expressions` は常にインタープリター形式で実行されます。** 実行時にコンパイルするには JIT が必要なため不可能で、式ツリーに大きく依存するコードは動作し続けますが、JIT を持つホストよりも遅く実行されます。

最も重要な実践的ルールは、**コンパイラーが教えてくれる** ことです。「パブリッシュプロセスはプロジェクト全体とその依存関係を、起こりうる制限について解析します。パブリッシュされたアプリが実行時に遭遇する可能性のある制限ごとに、警告が発行されます。」これらの警告は IL2026 (参照されないコードを必要とする、トリミングの問題) と IL3050 (動的コードを必要とする、AOT の問題) です。IL2026/IL3050 の警告がゼロのクリーンな `dotnet publish` を、ドキュメントではなく、ゴー/ノーゴーのシグナルとして扱ってください。ゼロにできないなら、AOT で出荷しないでください。

ゼロに到達する方法は、ほぼ常にリフレクションをコンパイル時のコード生成で置き換えることです。ソース生成された `System.Text.Json` がその典型例です。実行時に DTO をリフレクションする代わりに、ジェネレーターがコンパイル時にシリアライズコードを出力します。この用語が初めてなら、[ソースジェネレーターとは何か、いつ必要になるか](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) が正しい第一歩です。AOT のもとでは、それはあれば嬉しいものではなくなり、一部のライブラリが動作する唯一の方法になるからです。

## 誰も触れないスループットのコスト

起動とサイズの見出しが隠しているコストが 1 つあります。JIT プロセスはあなたのコードを一度コンパイルするだけではありません。.NET 8 以降、**Dynamic PGO** (プロファイルに基づく最適化) が既定で有効になっています。アプリの実行中、ランタイムはどの型が実際に仮想呼び出しを通って流れるか、どの分岐がホットかを記録し、その実際のプロファイルを使ってそれらのメソッドを tier 1 で再コンパイルします。これは事前コンパイラーが決して持てない情報です。あなたの特定のワークロードが動いている間にしか存在しないからです。

Native AOT のコードはパブリッシュ時に固定されます。tier 1 の再最適化を一度も受けず、PGO も一度も受けません。何時間も動く CPU バウンドのホットループでは、よく暖まった JIT プロセスが、AOT でコンパイルした同じコードを生のスループットで上回ることがあります。AOT プロセスがほんの一部の時間で起動したとしてもです。AOT はロングテールのピークを、最初の命令から速い、平坦で予測可能な曲線と引き換えにします。測定された差は小さい (JSON API のベンチマークで数パーセント) ですが、現実であり、AOT が与える他のすべてとは逆方向に働きます。完全な数値は [Native AOT vs ReadyToRun vs JIT の比較](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) にあり、起動、スループット、サイズを真っ向から突き合わせています。

サイズに関するもう 1 つのニュアンスはジェネリックです。「構造体型引数で置き換えられたジェネリックパラメーターは、インスタンス化ごとに特殊化されたコードが生成されます。」JIT はそれらを必要に応じて生成しますが、AOT はそれらをすべて事前生成します。値型のジェネリックを多くインスタンス化すると、バイナリが大きくなります。AOT バイナリは一般的なケースでは小さい (最小 API でおよそ 10-13 MB) ですが、ジェネリックを多用するライブラリは、予想以上にそれを膨らませることがあります。

## そのコストが買うもの

メリットは本物で、適切なワークロードにとっては決定的です。起動が見出しです。Native AOT の最小 API は、JIT の暖機もアセンブリの読み込みもないため、同じアプリを素の JIT で動かすよりおよそ 3 倍速く起動します。メモリフットプリントは半分以上下がります。プロセスが JIT も IL も、それをコンパイルするのに必要なメタデータも持ち運ばないからです。そして出力が自己完結型なので、デプロイ単位はインストールすべきランタイムのない単一の小さなバイナリになり、これが、切り替えによってチームがコンテナイメージのサイズを大幅に削減する理由です。

もう 1 つのメリットは量的ではなく質的です。AOT アプリは「JIT が許可されない制限された環境で動作できます」。一部のロックダウンされたコンテナランタイムやセキュリティポリシーは、JIT が必要とする書き込み可能かつ実行可能なメモリページを禁止します。AOT は、そこでそもそも動作する唯一の .NET デプロイモデルです。

だからこそスイートスポットは scale-to-zero と高密度のコンピュートです。リクエスト課金の関数 (AWS Lambda、Azure Functions Consumption、ゼロにスケールした Cloud Run) では、コールドスタートがレイテンシ SLO と請求の両方を支配するため、3 倍の起動の勝ちはビルド時の多くの苦労に値します。[.NET 11 の AWS Lambda コールドスタート手引き](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は、Lambda 上の AOT という正確な道のりを辿ります。一握りのインスタンスで動く長寿命の CPU バウンドなサービスでは、起動はゼロまで償却され、一度だけ支払うメリットのために Dynamic PGO を手放すことになるため、通常は素の JIT が勝ちます。

## 当て推量せずに判断する方法

何かに本格的に取り組む前に、解析を実行してください。最も安いテストは、`<PublishAot>true</PublishAot>` を設定して、実際の依存関係グラフに対してパブリッシュを実行することです。

```bash
# .NET 11. Surfaces every IL2026 / IL3050 across your whole dependency tree.
dotnet publish -c Release -r linux-x64 -o ./publish
```

それが注釈で消せない警告とともに返ってくるなら、AOT はこのコードベースにはまだ現実的でなく、パブリッシュ 1 回のコストで答えが得られます。ASP.NET Core は論点を鋭くします。MVC コントローラー (`AddControllers`)、Razor Pages、サーバー側の SignalR ハブは .NET 11 では AOT 非対応ですが、最小 API と gRPC は対応しています。クリーンビルドの完全なレシピ (`CreateSlimBuilder` ホスト、ソース生成された JSON、ライブラリプロジェクトの落とし穴) が欲しいなら、[ASP.NET Core の最小 API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) が手順書です。そして AOT 非対応の API がアナライザーをすり抜けて実行時にだけ破裂したときは、[その結果生じる PlatformNotSupportedException の修正](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) が最も一般的な失敗をカバーします。

短い判断ルールです。起動時間、メモリフットプリント、デプロイサイズ、または JIT なしで動くことが支配的な制約であり、**かつ** `dotnet publish` が依存関係グラフ全体で AOT 警告ゼロを報告するときは、Native AOT に手を伸ばしてください。ピークの定常スループットが起動より重要なとき、単一の成果物を複数のプラットフォームに配布するとき、または何らかの中核的な依存関係が置き換えられないリフレクションや `Reflection.Emit` を必要とするときは、素の JIT のままにしてください。Native AOT はより速い `dotnet publish` ではありません。それは異なるデプロイの契約であり、上記のコストはその契約の条件です。署名する前に読んでください。

## 関連

- [Native AOT vs ReadyToRun vs JIT in .NET 11: どれを出荷すべきか?](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) は、起動、スループット、サイズのトレードオフに硬いベンチマークの数値を裏付けます。
- [ASP.NET Core の最小 API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、出荷を決めたあとのクリーンビルドの手順書です。
- [ソースジェネレーターとは何か、いつ必要になるか?](/ja/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) は、AOT が禁じるリフレクションを置き換えるコンパイル時のコード生成を説明します。
- [.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は、AOT の起動の勝ちが元を取る scale-to-zero のシナリオです。
- [修正: Native AOT での PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) は、AOT 非対応の API がクリーンビルドをすり抜けたときの実行時の失敗をカバーします。

## 出典

- [Native AOT デプロイの概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)、MS Learn (前提条件、制限、RID とプラットフォームごとの制約、単一ファイルとジェネリックの挙動)。
- [ASP.NET Core の Native AOT サポート](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/)、MS Learn (サポートされる/されない Web 機能)。
- [トリミングの非互換性](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities)、MS Learn (トリミングが必須である理由と、それが壊すもの)。
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/)、.NET Blog (Dynamic PGO の設計と、AOT がそれを見送る理由)。
