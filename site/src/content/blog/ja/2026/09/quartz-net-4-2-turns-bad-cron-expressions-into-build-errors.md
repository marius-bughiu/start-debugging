---
title: "Quartz.NET 4.2、不正なcron式をビルドエラーに変換"
description: "Quartz.NET 4.2.0には、パース不能なcronリテラルをコンパイル時にQZ0001としてエラーにするRoslynアナライザーと、[QuartzJob]および[CronTrigger]属性をAddDeclaredJobs()の登録に変換するソースジェネレーターが同梱されています。本記事では、何がチェックされるのか、生成されるコードがどのようなものか、そしてどうすれば無効化できるかを解説します。"
pubDate: 2026-09-28
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "source-generators"
  - "roslyn-analyzers"
lang: "ja"
translationOf: "2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors"
translatedBy: "claude"
translationDate: 2026-09-28
---

Quartz.NETを使ったことがある人の多くは、レビューでは問題なく見えたcron式が起動時に`FormatException`をスローした経験があるはずです。2026年9月25日にリリースされ、9月27日の4.2.1パッチが続いた[Quartz.NET 4.2.0](https://github.com/quartznet/quartznet/releases/tag/v4.2.0)は、この失敗をコンパイラーの領域に移します。`Quartz`パッケージは、追加のパッケージをインストールしなくても、独自のアナライザーとソースジェネレーターを備えるようになりました。

## QZ0001: cronパーサーがビルド時に実行される

このアナライザーは、`WithCronSchedule`、`CronScheduleBuilder.Create`、`CronExpression`のコンストラクター、`CronCalendar`、`CronTriggerImpl`に渡されるすべてのcronリテラルまたは定数を検査します。別の文法を使っているわけではなく、スケジューラー自身のパーサーのソースをリンクしており、128個の式からなるパリティコーパスによって両者の一致が保たれています。コンパイラーがリテラルを受け入れるなら、スケジューラーもそれを受け入れます。

```csharp
q.AddTrigger(t => t
    .ForJob(jobKey)
    .WithCronSchedule("0 12 * * 1-5"));
// error QZ0001, reported on the literal with the parser's own message
```

この例は典型的な間違いです。Linuxからそのままコピーした5フィールドのcrontab式です。Quartzは(秒が先頭の)6フィールドまたは7フィールドを読み取り、2つある日フィールドのどちらかに`?`が必要なので、Quartz版は`"0 0 12 ? * MON-FRI"`になります。本当にUnix文法を使いたい場合は、リテラルとして`CronFormat.Unix`を渡せば、アナライザーはそちらを基準に検証します。

これに加えて、さらに3つのルールが同梱されています。

- **QZ0002**（エラー）: `[JobTimeout("...")]`の値がパースできない、または負の場合。
- **QZ0003**（警告）: `[DisallowConcurrentExecution]`を伴わない`[PersistJobDataAfterExecution]`。この場合、2つの同時実行がジョブデータマップを互いに上書きする可能性があります。
- **QZ0004**（情報）: `CancellationToken`を一度も参照しない`Execute`メソッド。

## ジョブをクラスに宣言する

この機能の後半部分は、`IJob`型から`[QuartzJob]`と`[CronTrigger]`を読み取るジェネレーターです。

```csharp
[QuartzJob(Name = "cleanup", Group = "maintenance")]
[CronTrigger("0 0 0/6 * * ?")]
[CronTrigger("0 0 12 ? * MON-FRI", Name = "cleanup-weekday-noon", TimeZone = "Europe/Helsinki")]
public sealed class CleanupJob : IJob
{
    public ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => default;
}

services.AddQuartz(q => q.AddDeclaredJobs());
services.AddQuartzHostedService();
```

`AddDeclaredJobs()`は、`IQuartzBuilder`に対する`internal`拡張として自分のアセンブリ内に生成されます。手書きした場合と全く同じ`AddJob<T>`と`AddTrigger<T>`の呼び出しを含むため、アセンブリスキャンは発生せず、トリミングやNative AOTのためにルート化するものもありません。属性内のcron文字列も、他のリテラルと同様にQZ0001を通過します。生成された`QuartzDeclaredJobs.g.cs`を読みたい場合は、`<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>`を設定してください。

このジェネレーターには独自のガードレールもあります。`QZ1001`は具象`IJob`型でない型への属性指定を拒否し、`QZ1002`は同一のidentityを持つ2つの宣言を拒否し、`QZ1003`は`[QuartzJob]`を伴わない`[CronTrigger]`を拒否します。トリガーを持たないジョブは、ストアがすぐに削除しないよう`Durable = true`が強制されます。

## アップグレードに関する注意点

このアナライザーはデフォルトで有効になっているため、不正なリテラルを含む既存プロジェクトはビルドできなくなります。これは意図された挙動ですが、`TreatWarningsAsErrors`を使っている場合はQZ0003にも注意してください。すべて無効化するには、プロジェクトファイルに次の設定を追加します。

```xml
<PropertyGroup>
  <DisableQuartzAnalyzers>true</DisableQuartzAnalyzers>
</PropertyGroup>
```

リリースノートでは、パッケージ参照に`ExcludeAssets="analyzers"`を指定しても、.NET 10 SDKではこれを無効化できない点が指摘されています。個々の重大度は`.editorconfig`で調整できます。

永続化されたジョブストアを使用している場合、新しいトリガーコンティニュエーション機能により、最初の4.2ノードを起動する前に`database/migrations/4.2/add_continuations_<dialect>.sql`マイグレーションを適用する必要もあります。また、`tables_sqlServerMOT.sql`または`tables_sqlServer_Below2016.sql`から作成したスキーマで新しいデータベースバックの実行履歴を有効にする場合は、`RETRY_ATTEMPT`列の欠落を修正した[4.2.1](https://github.com/quartznet/quartznet/releases/tag/v4.2.1)に直接移行してください。

そもそもQuartzが自分にとって適切なスケジューラーかどうか迷っている場合は、[Hangfire vs Quartz.NET vs IHostedService](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/)で他の選択肢と比較しています。
