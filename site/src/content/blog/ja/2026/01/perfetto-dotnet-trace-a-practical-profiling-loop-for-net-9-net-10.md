---
title: "Perfetto + dotnet-trace: .NET 9/.NET 10 のための実践的なプロファイリングループ"
description: ".NET 9 と .NET 10 のための実践的なプロファイリングループ: dotnet-trace でトレースをキャプチャし、Perfetto で可視化し、CPU、GC、スレッドプールの問題を反復的に解決する。"
pubDate: 2026-01-21
updatedDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
  - "performance"
lang: "ja"
translationOf: "2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
.NET で「遅い」状態から最速で抜け出す方法は、推測をやめてタイムラインを見ることです。今週話題になっている記事は、`dotnet-trace` でトレースをキャプチャし、Perfetto (Android や Chromium 界隈で多くの人が知っているのと同じトレースビューワーのエコシステム) で確認するというきれいなワークフローを示しています: [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/)。

## Perfetto をツールボックスに加える価値がある理由

すでに `dotnet-counters` やプロファイラーを使っているなら、Perfetto はその置き換えではありません。補完です:

-   並行性の問題 (スレッドプールのスパイク、ロック競合の兆候、非同期のウォーターフォール) について考えやすくなる視覚的なタイムラインが手に入ります。
-   IDE や商用プロファイラーをインストールしてもらわなくても、トレースファイルを別のエンジニアと共有できます。

.NET 9 と .NET 10 のアプリでは、「小さな」変更が誤って余計なアロケーションや余計なスレッド、新たな同期のボトルネックを持ち込んでいないか検証したいときに特に役立ちます。

## キャプチャループ (まず再現、次にトレース)

コツはトレースを単発の作業ではなくループとして扱うことです:

-   遅さを再現可能にします (同じエンドポイント、同じペイロード、同じデータセット)。
-   関心のある時間帯の前後で 10-30 秒キャプチャします。
-   観察し、仮説を立て、ひとつだけ変更し、繰り返します。

グローバルツールを使った最小のキャプチャ手順は次のとおりです:

```bash
dotnet tool install --global dotnet-trace

# Find the PID of the target process (pick one)
dotnet-trace ps

# Capture an EventPipe trace (default providers are usually a good starting point)
dotnet-trace collect --process-id 12345 --duration 00:00:15 --output app.nettrace
```

`app.nettrace` ができあがります。そこから先は元の記事の変換/オープン手順に従ってください (「Perfetto で開く」の正確な経路は、どの Perfetto UI を使うか、どの変換手順を選ぶかによります)。

## トレースを開いたときに何を見るか

数分で答えられる質問から始めます:

-   **CPU 使用**: CPU-bound (ホットなメソッド) ですか、それとも待機中 (ブロック、スリープ、I/O) ですか？
-   **スレッドプールの挙動**: レイテンシのスパイクと相関する worker スレッドのバーストはありますか？
-   **GC との相関**: 一時停止のウィンドウは遅いリクエストと一致していますか、それともバックグラウンド処理だけですか？

怪しいウィンドウを見つけたら、コードに戻って外科的な変更を加えます (例: アロケーションを減らす、sync-over-async を避ける、リクエストのホットパスからロックを外す、高コストな呼び出しをまとめる)。

## 実用的なパターン: シンボルを失わずに Release でトレースする

可能なら遅いパスを Release で実行 (本番に近い) しつつ、フレームを推論するのに十分な情報は残します。SDK-style プロジェクトでは PDB がデフォルトで生成されますが、プロファイリングのセッションでは出力パスを予測可能にしたいことが多いです:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Configuration>Release</Configuration>
    <DebugType>portable</DebugType>
  </PropertyGroup>
</Project>
```

退屈に保ってください: 安定した入力、安定した設定、短いトレース、繰り返し。

Perfetto の詳細な手順とスクリーンショットが欲しい場合は、ループを回している間に開いておく参照として元の記事が一番です: [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/)。
