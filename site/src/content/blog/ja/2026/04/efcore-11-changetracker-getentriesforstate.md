---
title: "EF Core 11 が DetectChanges をスキップする GetEntriesForState を追加"
description: "EF Core 11 Preview 3 は ChangeTracker.GetEntriesForState を導入します。state フィルターされた enumerator で、SaveChanges interceptor や audit hook のようなホットパスで余分な DetectChanges パスを避けます。"
pubDate: 2026-04-16
tags:
  - "ef-core"
  - "dotnet-11"
  - "performance"
  - "csharp"
lang: "ja"
translationOf: "2026/04/efcore-11-changetracker-getentriesforstate"
translatedBy: "claude"
translationDate: 2026-04-24
---

`ChangeTracker.Entries()` はホットパスで使うあらゆるアプリを噛む癖を持っています: 返す前に暗黙的に `DetectChanges()` を呼ぶことです。audit interceptor や pre-`SaveChanges` バリデーターにとって、そのコストは実際の save で再度支払われ、tracked されたすべてのエンティティ上でスキャンを二重化します。[EF Core 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) はその冗長なパスを除去するために `GetEntriesForState` を特別に導入します。

## API の形

新しいメソッドは `ChangeTracker` 上に `Entries()` と並んで住み、scanner が歩く `EntityState` 値ごとに 4 つのフラグを受け取ります:

```csharp
IEnumerable<EntityEntry> GetEntriesForState(
    bool added,
    bool modified,
    bool deleted,
    bool unchanged);
```

`DetectChanges` を完全にスキップし、現在の state が要求されたフラグに既に合う entries を返します。この呼び出しについて自動変更検出を失いますが、それは数行後に save (したがって検出) をトリガーしようとしているコードで欲しい取引そのものです。

機能は [dotnet/efcore #37847](https://github.com/dotnet/efcore/issues/37847) として追跡され、Preview 3 EF Core ビットで出荷されました。

## ダブルスキャンなしの監査

典型的な audit interceptor は tracker から modified と deleted entries を取り出して audit テーブルに書き込みます。`Entries()` では、その interceptor は潜在的に何千ものエンティティに対して完全な検出パスを強制し、次に `SaveChanges` がもう一度それを行います:

```csharp
public override InterceptionResult<int> SavingChanges(
    DbContextEventData eventData,
    InterceptionResult<int> result)
{
    var context = eventData.Context!;

    // In EF Core 10: this call runs DetectChanges() even though
    // SaveChanges is about to run it again a moment later.
    foreach (var entry in context.ChangeTracker
        .GetEntriesForState(added: false, modified: true, deleted: true, unchanged: false))
    {
        WriteAudit(entry);
    }

    return result;
}
```

`SaveChanges` は常に自分の検出パスを走らせるので、audit ループは今や二重に支払わずに新しく計算された state を読みます。

## いつ手を伸ばすか

`GetEntriesForState` は `Entries()` のドロップイン代替ではありません。どの state が重要かをすでに知っていて、検出パスがいずれにせよ走ることがスケジュールされているときに使ってください。良い用途:

- `SaveChangesInterceptor` の実装。
- save と同じトランザクション内で走る Outbox publisher。
- `Deleted` の entries だけ必要な soft-delete rewriter。
- スループットと引き換えに「少し古い」結果を受け入れる validator。

save 前にすべての保留中の変更を見る必要があるコードには避けてください。例えば「3 件の未保存編集があります」をレンダリングする UI などです。その場合、`Entries()` はまだ正しいです。その検出パスが全体の目的だからです。

## 勝ちを測る

影響は tracked エンティティ数とともに大きくなります。複雑な value object を持つ 10,000 エンティティを保持する context では、`Entries()` は何かが変わったかを判断するためにプロパティごとのスキャンを走らせます。`Entries().Where(e => e.State != EntityState.Unchanged)` の audit 読み取りを `GetEntriesForState(false, true, true, false)` に置き換えると完全なパスを 1 つ削減し、これは典型的に audit-heavy な OLTP パスでの `SaveChanges` 総時間の 10-30% です。

いつも通り、測定してください: context が数十個を超えるエンティティをめったに保持しないなら、API はまだ良いですが、perf 差はノイズです。この preview で出荷される EF Core 変更の完全なリストは [EF Core 11 Preview 3 リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md) にあります。
