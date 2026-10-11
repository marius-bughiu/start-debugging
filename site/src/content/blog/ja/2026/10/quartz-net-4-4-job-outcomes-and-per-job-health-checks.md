---
title: "Quartz.NET 4.4: ジョブが成果を報告し、ヘルスチェックが停止に気づく"
description: "Quartz.NET 4.4.0 では、ジョブが context.Result に JobRunReport (Succeeded、Failed、Cancelled、Skipped と、サマリーおよびメトリクス) を設定でき、その結果がジョブごとに実行履歴へ保存されます。さらに RequireSuccessWithin ヘルスチェックにより、夜間ジョブが成功しなくなったときに Degraded を報告できます。"
pubDate: 2026-10-11
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "health-checks"
  - "background-jobs"
lang: "ja"
translationOf: "2026/10/quartz-net-4-4-job-outcomes-and-per-job-health-checks"
translatedBy: "claude"
translationDate: 2026-10-11
---

Quartz.NET [v4.4.0](https://github.com/quartznet/quartznet/releases/tag/v4.4.0) が 2026-10-07 にリリースされました。目玉の数値はクラスタリングに関するもので (すでに実行時刻に達しているトリガーは、取得したトランザクション内で発火します。PostgreSQL では、毎秒 20 トリガーの条件で発火の 95 から 99 % が 50 ms 以内に収まり、4.3.0 の 54 % から向上しました)、しかしアプリケーションコードの多くが使うのは、もっと小さな変更です。ジョブがようやく実行結果を自分で伝えられるようになり、ヘルスエンドポイントがそれに基づいて動作できるようになりました。

## "例外が出なかった" は "うまくいった" ではない

4.3 までの Quartz が区別していた結果は 2 つだけでした。ジョブが例外をスローしたか、しなかったかです。掃除する対象がなかったクリーンアップジョブも、上流 API が空のページを返したために途中で終了した同期処理も、実際に作業を行った実行も、履歴上はすべて同じに見えました。さらに、トリガーが一時停止されたりミスファイアしたりして 3 日間動いていない夜間ジョブも、何も失敗していないため、履歴には何も現れませんでした。

## JobRunReport で結果を報告する

4.4 では、ジョブが `context.Result` に `JobRunReport` を設定します。結果は 4 種類 (`Succeeded`、`Failed`、`Cancelled`、`Skipped`) で、最大 1,000 文字の任意のサマリーと、AOT 対応の JSON として保存される最大 4,000 文字のメトリクスを添えられます。

```csharp
public sealed class ReleaseStaleReservationsJob : IJob
{
    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
    {
        int scanned = await CountReservations(cancellationToken);
        int released = await ReleaseStale(cancellationToken);

        context.Result = released == 0
            ? JobRunReport.Skipped("no stale reservations").With("scanned", scanned)
            : JobRunReport.Succeeded($"released {released}")
                .With("scanned", scanned)
                .With("released", released);
    }
}
```

記録される結果は決まった優先順位に従います。キャンセルされた発火は `Cancelled`、例外をスローしたジョブは `Failed`、それ以外は `context.Result` に設定した値、何も設定していなければ `Succeeded` です。`JobRunReport.Failed(...)` を報告することは、例外をスローすることとは異なります。リトライポリシーと `OnFailure` の継続処理を動かすのはスローされた例外だけなので、リトライしても意味がない場合に失敗を報告してください。

履歴にはジョブごとに `JobRunStatus` (`LastSucceededAtUtc`、`ConsecutiveFailures`、`LastFailureMessage`、実行回数と失敗回数) が保持され、保持期間は結果ごとに変えられます。また `quartz.job.execution.duration` メトリクスに `quartz.job.result` タグが加わったため、OpenTelemetry のダッシュボードでスキップされた実行と実際に処理した実行を分けて表示できます。

## ジョブごとのヘルスチェック

私が今すぐ有効にしたいのはこの部分です。`RequireSuccessWithin` は、指定した期間内にジョブが成功していない場合に、そのジョブを異常として報告します。トリガーの一時停止、ミスファイア、veto によってスキップされ続けるジョブといった、静かに起きる問題を捕捉できます。

```csharp
builder.Services.AddQuartzExecutionHistory();

builder.Services.AddHealthChecks().AddQuartz(options =>
{
    // Degraded once the nightly report has not succeeded for 26 hours.
    options.RequireSuccessWithin(new JobKey("nightly-report", "reports"), TimeSpan.FromHours(26));

    // Unhealthy, so the node leaves rotation, after 90 minutes without a ledger close.
    options.RequireSuccessWithin(
        new JobKey("ledger-close", "billing"),
        TimeSpan.FromMinutes(90),
        HealthStatus.Unhealthy);
});
```

既定のステータスは `Degraded` で、`Skipped` の実行は成功として扱われます。そのため、上のジョブの "処理対象なし" のパスで誰かが呼び出されることはありません。対象のリストは `RequiredJobs` を通じて構成から割り当てることもできます。実行履歴が無効な場合は、永久に通過しないチェックを報告するのではなく、ホストが起動時に失敗します。

## 4.3 からのアップグレード

このリリースは追加のみの変更です。4.3 のコードは変更なしでコンパイルでき、新しいインターフェースメンバーにはすべて既定の実装があります。実行履歴を有効にした永続ジョブストアを使っている場合は、最初の 4.4 ノードを起動する前に `4.4/add_execution_outcome_<dialect>.sql` スクリプトを実行してください。このリリースにはほかに、ジョブクラス用の `[RetryPolicy]` 属性、`q.RunAtStartup(jobKey)`、MySQL、Oracle、Firebird 向けの Weasel スキーマ管理も含まれており、いずれも[移行ガイド](https://www.quartz-scheduler.net/documentation/quartz-4.x/migration-guide.html#upgrading-from-4-3-to-4-4)と[ジョブ結果のハウツー](https://www.quartz-scheduler.net/documentation/quartz-4.x/how-tos/job-outcomes.html)で解説されています。

まだ 4.2 を使っている場合は、[4.2 の cron アナライザーと `[QuartzJob]` ソースジェネレーター](/ja/2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors/)も一緒に利用できるようになります。
