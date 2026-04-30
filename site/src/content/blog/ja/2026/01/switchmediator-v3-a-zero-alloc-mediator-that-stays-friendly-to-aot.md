---
title: "SwitchMediator v3: AOT に優しいまま、ゼロアロケーションのメディエーター"
description: "SwitchMediator v3 は .NET 9 と .NET 10 の CQRS サービス向けに、ゼロアロケーションかつ AOT 対応のディスパッチを目指します。それが何を意味するか、そして自分のメディエーターをどうベンチマークするかを解説します。"
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot"
translatedBy: "claude"
translationDate: 2026-04-30
---
「クリーン」な CQRS のコードベースをプロファイルして、メディエーター層で千の小さなアロケーションによる死を見つけたことがあるなら、本日リリースされた **SwitchMediator v3** は見ておく価値があります。作者は **ゼロアロケーション** かつ **AOT に優しい** 動作を明示的に挙げており、これはまさにレイテンシを気にする .NET 9 と .NET 10 のサービスで欲しい組み合わせです。

## 典型的なメディエーター実装はどこでアロケーションを漏らすか

静かにアロケートしてしまう、よくあるパターンがいくつかあります:

-   **ボックス化とインターフェースディスパッチ**: 特にハンドラーが `object` として保持され、リクエストごとにキャストされる場合。
-   **パイプライン behavior のリスト**: enumerator、クロージャ、中間リストをアロケートします。
-   **リフレクションによるハンドラー探索**: 便利ですが、トリミングやネイティブ AOT との相性は悪いです。

AOT に優しいメディエーターは普通その逆をやります: ハンドラーの登録を明示的にし、ディスパッチのロジックを実行時のリフレクションではなく既知のジェネリック型に基づかせます。

## 小さな「ビフォア vs アフター」のベンチマークハーネス

SwitchMediator を採用しないにしても、自分のメディエーターの境界はベンチマークすべきです。これは **.NET 10** をターゲットにしたコンソールアプリに放り込めば、ベースラインを把握できる最小のハーネスです。

```cs
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

public static class Program
{
    public static void Main() => BenchmarkRunner.Run<MediatorBench>();
}

public sealed record Ping(int Value);
public sealed record Pong(int Value);

public interface IMediator
{
    ValueTask<Pong> Send(Ping request, CancellationToken ct = default);
}

public sealed class MediatorBench
{
    private readonly IMediator _mediator = /* wire your mediator here */;

    [Benchmark]
    public async ValueTask<Pong> SendPing() => await _mediator.Send(new Ping(123));
}
```

私が見るポイント:

-   **操作あたりのアロケートバイト数**は、自明なリクエストではゼロに近づいているべきです。
-   **スループット**はディスパッチのオーバーヘッドではなく、ハンドラーの仕事量に応じてスケールするべきです。

ディスパッチ経路にアロケーションが見つかる場合、通常は戻り値型を `ValueTask` に切り替え (上記のように)、リクエスト/レスポンス型を JIT に予測可能なレコードや構造体として保つことで見つかります。

## AOT に優しいとはたいてい「明示的」を意味する

**.NET 10** でネイティブ AOT を試している場合、リフレクション頼りのメディエーターは最初に壊れるものの 1 つです。

アーキテクチャ上のトレードオフはシンプルです:

-   **リフレクションによるスキャン**: 開発体験は素晴らしいが、トリミング/AOT との相性は弱い。
-   **明示的な登録**: 少し配線が増えるが、予測可能でトリミングに優しい。

SwitchMediator のうたい文句からすると、スペクトルの「明示的」な側に寄っているようです。これは私のパフォーマンス作業へのアプローチと一致します: 本番で予測可能な振る舞いが手に入るなら、配線の行数が少し増えるのは許容します。

詳細が知りたい場合は、アナウンススレッドから始めて、そこからリポジトリのリンクをたどってください: [https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator\_v3\_is\_out\_now\_a\_zeroalloc/](https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator_v3_is_out_now_a_zeroalloc/)
