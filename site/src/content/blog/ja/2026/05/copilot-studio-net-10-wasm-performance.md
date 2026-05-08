---
title: "Copilot Studio の .NET 10 WebAssembly 移行: コールドパスで 20%、ウォームパスで 5%"
description: "Microsoft は Copilot Studio の WASM エンジンを .NET 8 から .NET 10 に移行しました。JIT/AOT デュアルパッケージ、fingerprinting、WasmStripILAfterAOT がその数字を説明します。"
pubDate: 2026-05-08
tags:
  - "dotnet"
  - "webassembly"
  - "performance"
  - "blazor"
lang: "ja"
translationOf: "2026/05/copilot-studio-net-10-wasm-performance"
translatedBy: "claude"
translationDate: 2026-05-08
---

2026 年 5 月 7 日、Daniel Roth が .NET ブログに [Copilot Studio のケーススタディ](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/) を公開しました。要点は次のとおりです。NPM パッケージとして配布され、多くの Microsoft 365 サーフェスに埋め込まれている Copilot Studio の WebAssembly ランタイムが、.NET 10 で本番稼働を始めました。コールドパスの実行は約 20% 高速化、ウォームパスは約 5% 高速化し、移行自体はほぼ `<TargetFramework>` の差し替えだけで済みました。

興味深いのは、Copilot Studio が 2 つのエンジンをひとつのバンドルにどのように同梱しているか、そして .NET 10 の WebAssembly ツーリングの何が変わって新しいビルドが重要な部分では小さくなり、重要でない部分では少し大きくなったかという点です。

## 2 つのエンジン、ひとつのパッケージ

Copilot Studio は JIT か AOT かを選びません。両方を同じ NPM パッケージで配布し、ページ側で並列に読み込ませます。

JIT エンジンが先に起動し、ユーザー操作をすぐに処理し始めます。サイズが大きく、ダウンロードが遅い AOT エンジンはバックグラウンドで読み込みを終えます。準備ができ次第、ランタイムはアクティブなセッションを AOT に引き渡し、JIT エンジンは破棄されます。ユーザーには初回応答は速く感じられ、その後の会話の残りは静かにより高速な体験となります。

このデュアルロードがあるからこそ、Copilot Studio は 2 つのエンジン間でアセットを共有することにこだわります。両方が参照できるものは、二度ダウンロードされるべきではありません。

## .NET 10 で実際に変わったこと

差分の大部分は、.NET 10 の WebAssembly ワークロードにおける 2 つの変更で説明できます。

ひとつ目は、**アセットの自動 fingerprinting** です。.NET 8 ではチームが各 WASM/DLL ファイル名に SHA256 ハッシュを付加するためのカスタム PowerShell ステップを動かす必要がありました。これはキャッシュと整合性チェックを正しく動かすためです。.NET 10 ではこれが組み込まれ、publish 出力には最初から `dotnet.runtime.{hash}.js` のようなファイル名が生成され、独自の MSBuild の接ぎ木は不要になりました。

ふたつ目は、**`WasmStripILAfterAOT` がデフォルトで有効** であることです。AOT コンパイル後、コンパイル済みメソッドの元の IL は出荷されなくなります。これにより AOT のペイロードは小さくなりますが、JIT エンジンと AOT エンジンが共有できるファイル数は減ります。AOT 専用ファイルが、JIT エンジンが必要とする IL を持たなくなるためです。

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <RunAOTCompilation>true</RunAOTCompilation>
  <!-- Defaults to true on net10.0; shown here for clarity. -->
  <WasmStripILAfterAOT>true</WasmStripILAfterAOT>
</PropertyGroup>
```

.NET 8 では、Copilot Studio の JIT エンジンと AOT エンジンの間で 59 ファイルが共有されていました。.NET 10 では 22 まで減りました。パッケージ全体のサイズは約 15% 増加しています。これが AOT メソッドから IL を取り除いた代償です。デュアルエンジンモデルは、重複排除によるメリットの一部を失います。

## 数字を正直に読む

Microsoft はこのトレードオフを率直に示しています。AOT のダウンロードは高速 LAN で約 6% 遅く、これはおおよそ 200 ms に相当します。4G 回線では約 17% 遅くなり、約 5 秒に相当します。このペナルティは JIT がすでにユーザーを処理している裏側で支払われるため、time-to-interactive には現れません。ただし、ユーザーが読み込みの途中で切断したり、制限のあるネットワークで Copilot Studio を実行したりすると現れます。

その代わり次のメリットが得られます。

- 実行のコールドパス: 約 20% 高速化。
- 実行のウォームパス: 約 5% 高速化。
- フレームワークの引き上げ以外にコード変更なし。

Microsoft 365 サーフェスの中で動作し、絶え間なく呼び出されるワークロードにとって、各操作におけるコールドパスの 20% の改善は、バックグラウンドダウンロードの 5 秒よりも重要です。

## あなたの Blazor WebAssembly アプリにとっての意味

Blazor WebAssembly あるいは .NET WASM のアプリを出荷していて、まだ .NET 8 にいるなら、移行コストは小さいです。`TargetFramework` を `net10.0` に上げ、restore して publish し、新しい fingerprinting と AOT のデフォルトに任せてください。パイプラインに独自のハッシュ付与や IL 除去のステップがあるなら、削除してください。

JIT と AOT のデュアルエンジンを出荷していない場合 (大半のアプリはそうではありません)、Copilot Studio が見たような 15% のパッケージ増加は発生しません。重複排除の損失なしに IL ストリッピングの節約だけを得られます。これは .NET 10 のデフォルトが想定する構成です。

デプロイの詳細や、Copilot Studio がこれらの数字を本番でどう計測しているかを含む完全なケーススタディは、[.NET ブログ](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/) にあります。
