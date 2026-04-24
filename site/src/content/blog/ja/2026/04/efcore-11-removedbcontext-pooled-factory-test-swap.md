---
title: "EF Core 11 Preview 3 がテストでクリーンなプロバイダースワップのための RemoveDbContext を追加"
description: "EF Core 11 Preview 3 は RemoveDbContext、RemoveExtension、そして AddPooledDbContextFactory の引数なしオーバーロードを導入し、テストでのプロバイダー切り替え周りのボイラープレートを除去して pooled factory 設定を集約します。"
pubDate: 2026-04-23
tags:
  - "dotnet-11"
  - "ef-core-11"
  - "testing"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/04/efcore-11-removedbcontext-pooled-factory-test-swap"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 Preview 3 は、EF Core での結合テストにおける最も長く続く煩わしさの 1 つを静かに修正します: 別のプロバイダーを登録する前に親プロジェクトの `AddDbContext` 呼び出しを取り消す必要があったことです。リリースは `RemoveDbContext<TContext>()` と `RemoveExtension<TExtension>()` ヘルパー、そして context 自体の内部で宣言された設定を再利用する `AddPooledDbContextFactory<TContext>()` の引数なしオーバーロードを導入します。

## 古いテストスワップダンス

`Startup` や `Program.cs` の composition root が SQL Server context を登録しているなら、結合テストプロジェクトは通常それをオーバーライドする必要があります。今まで、それをきれいに行うには、プロダクション登録を設定 delegate を取る extension method にリストラクチャーするか、`IServiceCollection` を手動で歩いて EF Core が登録した各 `ServiceDescriptor` を削除するかのどちらかが必要でした。後者のルートは脆く、与えられたプロバイダーに対して EF Core が配線する内部サービスの正確なセットに依存するからです。

```csharp
// EF Core 10 and earlier: manual cleanup before swapping providers
services.RemoveAll<DbContextOptions<AppDbContext>>();
services.RemoveAll(typeof(AppDbContext));
services.RemoveAll(typeof(IDbContextOptionsConfiguration<AppDbContext>));
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

どの descriptor 型をスクラブするか知っておく必要があり、EF Core がその options パイプラインをどう配線するかの変更はどれもテストセットアップを静かに壊し得ました。

## `RemoveDbContext` が実際にすること

Preview 3 では同じスワップが 2 行に収束します:

```csharp
services.RemoveDbContext<AppDbContext>();
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

`RemoveDbContext<TContext>()` は context 登録、紐付いた `DbContextOptions<TContext>`、そしてその context について EF Core が蓄積した設定コールバックを剥がします。設定のほとんどをそのまま維持しつつ単一の options extension だけをドロップしたいケース向けには、より外科的な `RemoveExtension<TExtension>()` もあります。例えばパイプライン全体を組み直すことなく SQL Server の retry strategy を削除するようなケースです。

## 設定を重複させない pooled factory

2 つ目の変更は `AddPooledDbContextFactory<TContext>()` を狙います。以前は、context がすでに `OnConfiguring` をオーバーライドしているか `ConfigureDbContext<TContext>()` 経由で設定を登録していても、呼び出しには options delegate が必要でした。Preview 3 は引数なしオーバーロードを追加するので、自分自身を設定する方法をすでに知っている context を 1 行で pooled factory として公開できます:

```csharp
services.ConfigureDbContext<AppDbContext>(o =>
    o.UseSqlServer(connectionString));

services.AddPooledDbContextFactory<AppDbContext>();
```

組み合わせると、この 2 つの変更は、プロダクション登録を取ってプロバイダーを剥がし、同じ context を別の store を指す pooled factory として再登録することを些細にします - これはまさに多くの multi-tenant テスト fixture がすでに欲しがっていた形です。

## もっと読むには

フルノートは [EF Core 11 Preview 3 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md) にあり、アナウンスは [.NET 11 Preview 3 ポスト](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) にあります。手動で `RemoveAll` ダンスを踊る test fixture base class を保守しているなら、今がそれを削除する瞬間です。
