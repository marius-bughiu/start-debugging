---
title: "dotnet-trace で .NET アプリをプロファイリングし、出力を読む方法"
description: ".NET 11 アプリを dotnet-trace でプロファイリングする完全ガイド: インストール、適切なプロファイルの選択、起動時からのキャプチャ、PerfView・Visual Studio・Speedscope・Perfetto での .nettrace の読み方。"
pubDate: 2026-04-25
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "diagnostics"
  - "profiling"
lang: "ja"
translationOf: "2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output"
translatedBy: "claude"
translationDate: 2026-04-25
---

`dotnet-trace` で .NET アプリをプロファイリングするには、`dotnet tool install --global dotnet-trace` でグローバルツールをインストールし、`dotnet-trace ps` で対象の PID を見つけ、`dotnet-trace collect --process-id <PID>` を実行します。フラグなしの場合、.NET 10/11 版のツールはデフォルトで `dotnet-common` と `dotnet-sampled-thread-time` の 2 つのプロファイルを使い、これらを合わせると以前の `cpu-sampling` プロファイルと同じ範囲をカバーします。Enter を押してキャプチャを停止すると、`dotnet-trace` は `.nettrace` ファイルを書き出します。読むには、Windows では Visual Studio または PerfView で開くか、`dotnet-trace convert` で Speedscope または Chromium 形式に変換し、[speedscope.app](https://www.speedscope.app/) または `chrome://tracing` / Perfetto で表示します。本記事では dotnet-trace 9.0.661903 と .NET 11 (preview 3) を使用していますが、このワークフロー自体は .NET 5 から安定しています。

## dotnet-trace が実際に何をキャプチャするか

`dotnet-trace` はマネージド専用のプロファイラーで、[診断ポート](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port)経由で .NET プロセスと通信し、ランタイムに [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe) 経由でイベントをストリームするよう要求します。ネイティブプロファイラーはアタッチされず、プロセスの再起動も不要で、管理者権限も必要ありません (例外は `collect-linux` 動詞、後述)。出力は `.nettrace` ファイルで、イベントのバイナリストリームに加えて、セッション終了時に発行される rundown 情報 (型名、JIT の IL からネイティブへのマップ) を含みます。

このマネージド専用という契約こそが、チームが PerfView、ETW、`perf record` ではなく `dotnet-trace` を選ぶ最大の理由です。JIT で解決された呼び出しスタック、GC イベント、アロケーションサンプル、ADO.NET コマンド、`EventSource` ベースのカスタムイベントを、Windows・Linux・macOS で同じように動く 1 つのツールから取得できます。クロスプラットフォーム版の `collect` 動詞で得られないのは、ネイティブフレーム、カーネルスタック、非 .NET プロセスのイベントです。

## インストールして最初のトレースをキャプチャする

マシンごとに 1 回インストールします。

```bash
# Verified against dotnet-trace 9.0.661903, .NET 11 preview 3
dotnet tool install --global dotnet-trace
```

ツールはマシン上で利用可能な最も新しい .NET ランタイムを使います。.NET 6 だけがインストールされていても動作しますが、2025 年に導入された .NET 10/11 のプロファイル名は表示されません。`dotnet-trace --version` で何が入っているか確認してください。

次に PID を見つけます。ツール自体の `ps` 動詞が最も安全な選択肢です。診断エンドポイントを公開しているマネージドプロセスだけを表示するためです。

```bash
dotnet-trace ps
# 21932 dotnet  C:\Program Files\dotnet\dotnet.exe   run --configuration Release
# 36656 dotnet  C:\Program Files\dotnet\dotnet.exe
```

最初の PID に対して 30 秒間キャプチャします。

```bash
dotnet-trace collect --process-id 21932 --duration 00:00:00:30
```

コンソールには有効になったプロバイダー、出力ファイル名 (デフォルトは `<appname>_<yyyyMMdd>_<HHmmss>.nettrace`)、ライブの KB カウンタが表示されます。指定した時間より早く止めたければ Enter を押します。停止は瞬時ではありません。ランタイムはトレースに登場した JIT コンパイル済みのメソッドすべてについて rundown 情報をフラッシュする必要があり、大規模アプリでは数十秒かかることもあります。Ctrl+C を 2 回押したくなる衝動を抑えてください。

## 適切なプロファイルを選ぶ

`dotnet-trace` が初見でわかりにくく感じる理由は、「どのイベントをキャプチャすべきか?」に正解が複数あるからです。ツールには名前付きのプロファイルが用意されているので、キーワードのビットマスクを覚える必要はありません。dotnet-trace 9.0.661903 時点で、`collect` 動詞は次をサポートします。

- `dotnet-common`: 軽量なランタイム診断。GC、AssemblyLoader、Loader、JIT、Exceptions、Threading、JittedMethodILToNativeMap、Compilation のイベントを `Informational` レベルで取得。`Microsoft-Windows-DotNETRuntime:0x100003801D:4` と等価。
- `dotnet-sampled-thread-time`: マネージドのスレッドスタックを約 100 Hz でサンプリングし、時間軸上のホットスポットを特定します。マネージドスタックを使うランタイムのサンプルプロファイラーを利用。
- `gc-verbose`: GC のコレクションに加えて、オブジェクトアロケーションのサンプリング。`dotnet-common` より重いですが、メモリプロファイラーを使わずにアロケーションのホットスポットを見つける唯一の手段です。
- `gc-collect`: GC のコレクションのみ、オーバーヘッド非常に小さめ。「GC で止まっているのか?」を、定常状態のスループットに影響を与えずに確かめたいときに有効です。
- `database`: ADO.NET と Entity Framework のコマンドイベント。N+1 クエリの検出に有用。

フラグなしで `dotnet-trace collect` を実行すると、ツールは現在 `dotnet-common` と `dotnet-sampled-thread-time` をデフォルトで選択します。この組み合わせは古い `cpu-sampling` プロファイルを置き換えるものです。古いプロファイルは CPU 使用にかかわらず全スレッドをサンプリングしていたため、アイドルなスレッドをホットと誤読する原因になっていました。古いトレースとの後方互換のため厳密に同じ動作が必要なら、`--profile dotnet-sampled-thread-time --providers "Microsoft-Windows-DotNETRuntime:0x14C14FCCBD:4"` を使ってください。

プロファイルはカンマで重ねられます。

```bash
dotnet-trace collect -p 21932 --profile dotnet-common,gc-verbose,database --duration 00:00:01:00
```

それ以上にカスタマイズしたい場合は `--providers` を使います。形式は `Provider[,Provider]` で、各プロバイダーは `Name[:Flags[:Level[:KeyValueArgs]]]` です。たとえば、コンテンションのイベントだけを verbose レベルでキャプチャするには次のようにします。

```bash
dotnet-trace collect -p 21932 --providers "Microsoft-Windows-DotNETRuntime:0x4000:5"
```

ランタイムのキーワードをよりわかりやすい構文で扱いたければ、`--clrevents gc+contention --clreventlevel informational` は `--providers Microsoft-Windows-DotNETRuntime:0x4001:4` と等価で、スクリプトでは格段に読みやすくなります。

## 起動時からキャプチャする

興味深いパフォーマンス問題の半分は、PID をコピーする間もない最初の 200 ms の間に起こります。.NET 5 では、ランタイムがリクエストを処理し始める前に `dotnet-trace` をアタッチする方法が 2 つ追加されました。

最も簡単なのは、`dotnet-trace` 自身に子プロセスを起動させる方法です。

```bash
dotnet-trace collect --profile dotnet-common,dotnet-sampled-thread-time -- dotnet exec ./bin/Debug/net11.0/MyApp.dll arg1 arg2
```

デフォルトでは子プロセスの stdin/stdout はリダイレクトされます。コンソール上でアプリと対話する必要があれば `--show-child-io` を渡します。`dotnet run` ではなく `dotnet exec <app.dll>` か発行済みの self-contained バイナリを使ってください。前者はビルド/ランチャーのプロセスを生成し、これらが先にツールへ接続することで、本来の対象アプリがランタイム上で停止したまま放置されることがあります。

より柔軟な方法は診断ポートです。あるシェルで次を実行します。

```bash
dotnet-trace collect --diagnostic-port myport.sock
# Waiting for connection on myport.sock
# Start an application with the following environment variable:
# DOTNET_DiagnosticPorts=/home/user/myport.sock
```

別のシェルで環境変数を設定して通常通りに起動します。

```bash
export DOTNET_DiagnosticPorts=/home/user/myport.sock
./MyApp arg1 arg2
```

ランタイムはツールが準備できるまで停止し、その後通常どおりに開始します。このパターンはコンテナ (ソケットをコンテナにマウント)、簡単にラップできないサービス、特定の子プロセスだけをトレースしたいマルチプロセスのシナリオと組み合わせられます。

## 特定のイベントで停止する

長いトレースはノイズが多くなります。「JIT が X のコンパイルを開始した」から「リクエストが完了した」までの区間だけが知りたいなら、`dotnet-trace` は特定のイベントが発火した瞬間に停止できます。

```bash
dotnet-trace collect -p 21932 \
  --stopping-event-provider-name Microsoft-Windows-DotNETRuntime \
  --stopping-event-event-name Method/JittingStarted \
  --stopping-event-payload-filter MethodNamespace:MyApp.HotPath,MethodName:Render
```

イベントストリームは非同期にパースされるため、マッチ後にセッションが実際にクローズするまでに少しだけ余分なイベントが漏れます。ホットスポットを探しているときは、これは通常問題になりません。

## .nettrace の出力を読む

`.nettrace` ファイルは正規のフォーマットです。3 つのビューワがそのまま扱え、もう 2 つは 1 行のコンバートで利用可能になります。

### PerfView (Windows、無料)

[PerfView](https://github.com/microsoft/perfview) は .NET ランタイムチーム自身が使う元祖ツールです。`.nettrace` を開き、`dotnet-sampled-thread-time` を取得していたら "CPU Stacks"、`gc-verbose` や `gc-collect` を取得していたら "GC Heap Net Mem" / "GC Stats" をダブルクリックします。"Exclusive %" カラムはマネージドスレッドが時間を費やした場所を、"Inclusive %" はホットなフレームに到達した呼び出しスタックを示します。

PerfView は情報密度が高めです。覚えておく価値のある操作は 2 つ。フレームを右クリックして "Set As Root" を選んでドリルインすること、そして "Fold %" テキストボックスで小さなフレームを畳んでホットパスを読みやすくすることです。未処理例外でトレースが切り詰められた場合、`/ContinueOnError` フラグ付きで PerfView を起動すれば、クラッシュ直前までの状態を調べられます。

### Visual Studio Performance Profiler

Visual Studio 2022/2026 では File > Open から `.nettrace` ファイルを直接開けます。CPU Usage ビューは PerfView を使ったことがない人にとって最もとっつきやすい UI で、フレームグラフ、"Hot Path" ペイン、PDB が近くにあればソース行への帰属表示まで揃っています。欠点は Visual Studio のビュー種類が PerfView より少ないことで、アロケーションのプロファイリングや GC 解析は通常 PerfView の方が見やすくなります。

### Speedscope (クロスプラットフォーム、ブラウザ)

Linux や macOS でトレースを最も速く見るには、Speedscope に変換してブラウザで開くのが一番です。`dotnet-trace` に直接 Speedscope を書き出させることもできます。

```bash
dotnet-trace collect -p 21932 --format Speedscope --duration 00:00:00:30
```

または既存の `.nettrace` を変換します。

```bash
dotnet-trace convert myapp_20260425_120000.nettrace --format Speedscope -o myapp.speedscope.json
```

生成された `.speedscope.json` を [speedscope.app](https://www.speedscope.app/) にドラッグ＆ドロップします。"Sandwich" ビューがキラー機能で、メソッドを合計時間順に並べ、どれをクリックしてもその場で呼び出し元と呼び出し先がインラインで見えます。Mac で PerfView に最も近い体験です。なお、変換は不可逆で、rundown のメタデータ、GC イベント、例外イベントは失われます。後でアロケーションを見たくなる可能性があるなら、元の `.nettrace` も並べて保存しておきましょう。

### Perfetto / chrome://tracing

`--format Chromium` は `chrome://tracing` や [ui.perfetto.dev](https://ui.perfetto.dev/) にドロップできる JSON ファイルを生成します。このビューは並行性に関する問いに強く、スレッドプールのスパイク、async のウォーターフォール、ロック競合の兆候は、フレームグラフよりタイムライン上のほうが自然に読み取れます。コミュニティ記事の [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/) は完全なループを解説しており、私たちも今年初めに [Perfetto + dotnet-trace の実践的なワークフロー](/2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10/) をより詳しく取り上げています。

### dotnet-trace report (CLI)

ヘッドレスのサーバー上にいる、あるいはざっくり確認したいだけのときは、ツール自身がトレースを要約できます。

```bash
dotnet-trace report myapp_20260425_120000.nettrace topN -n 20
```

エクスクルーシブな CPU 時間でトップ 20 のメソッドを出力します。`--inclusive` でインクルーシブ時間に切り替え、`-v` でパラメータシグネチャを完全な形で出力します。ビューワの代わりにはなりませんが、SSH を抜けずに「デプロイで明らかな退行はないか?」を確かめるには十分です。

## 初心者がよく踏む落とし穴

「なぜトレースが空なの?」という報告のほとんどは、いくつかのエッジケースで説明できます。

- バッファはデフォルトで 256 MB です。イベントレートの高いシナリオ (タイトループ内のすべてのメソッド、ストリーミング負荷上のアロケーションサンプリングなど) はこのバッファを溢れさせ、イベントが静かにドロップされます。`--buffersize 1024` で増やすか、プロバイダーを絞ってください。
- Linux と macOS では、`--name` と `--process-id` は対象アプリと `dotnet-trace` が同じ環境変数 `TMPDIR` を共有していることを要求します。一致していなければ、有用なエラーなしに接続がタイムアウトします。コンテナや `sudo` 経由の起動が常連の犯人です。
- 対象アプリがキャプチャ途中でクラッシュすると、トレースは不完全になります。ランタイムは破損を避けるためにファイルを切り詰めます。`/ContinueOnError` 付きの PerfView で開けば、そこまでの内容で原因究明には十分です。
- `dotnet run` は補助プロセスを生成し、これらが本来のアプリより先に `--diagnostic-port` のリスナーへ接続することがあります。起動時からトレースする場合は `dotnet exec MyApp.dll` か発行済みの self-contained バイナリを使ってください。
- デフォルトの `--resume-runtime true` は、セッションが準備できしだいアプリを開始させます。アプリを停止したままにしたい場合 (主にデバッガー用途、まれ) は、`--resume-runtime:false` を渡します。
- カーネル 6.4+ の Linux 上の .NET 10 では、新しい `collect-linux` 動詞がカーネルイベント、ネイティブフレーム、マシン全体のサンプルをキャプチャしますが、root が必要で、まだすべてのビューワがサポートしていない preview 形式の `.nettrace` を書き出します。本当にネイティブフレームが必要なときに使い、それ以外は `collect` をデフォルトに。

## 次に進む先

`dotnet-trace` は「アプリは今何をしているか?」のための適切なツールです。ファイルをまったく作らずに継続的なメトリクス (RPS、GC ヒープサイズ、スレッドプールのキュー長など) を取りたいなら `dotnet-counters`。実際のヒープダンプが必要なメモリリーク調査には `dotnet-gcdump`。3 つのツールは診断ポートの配管を共有しているので、install / `ps` / `collect` の指の感覚はそのまま転用できます。

本番で動くコードを書くなら、トレースしやすい言語のメンタルモデルも欲しくなります。私たちのメモ ([デッドロックなしで長時間タスクをキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)、[ASP.NET Core エンドポイントからバッファリングなしでファイルをストリームする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)、[.NET 11 でメモリ不足にならず大きな CSV を読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)) は、`dotnet-trace` のフレームグラフ上で素朴な実装とはずいぶん違って見えるパターンを示しています。それは良いことです。

`.nettrace` 形式はオープンです。解析をスクリプト化したいなら、[Microsoft.Diagnostics.Tracing.TraceEvent](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent) で同じファイルをプログラムから読めます。PerfView 自身もこの仕組みで動いており、既存のビューワが自分の問いに答えてくれないときに、その場限りのレポートを組むのもこの方法です。

## 参考リンク

- [dotnet-trace 診断ツールリファレンス](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace) (MS Learn、最終更新 2026-03-19)
- [EventPipe ドキュメント](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)
- [診断ポートのドキュメント](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port)
- [.NET の Well-known Event Providers](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/well-known-event-providers)
- [PerfView (GitHub)](https://github.com/microsoft/perfview)
- [Speedscope](https://www.speedscope.app/)
- [Perfetto UI](https://ui.perfetto.dev/)
