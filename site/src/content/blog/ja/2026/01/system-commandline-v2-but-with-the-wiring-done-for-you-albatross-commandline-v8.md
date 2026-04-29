---
title: "System.CommandLine v2 を、配線済みで使う: `Albatross.CommandLine` v8"
description: "Albatross.CommandLine v8 は System.CommandLine v2 をベースに、ソースジェネレーター、DI 統合、ホスティング層を加え、.NET 9 と .NET 10 アプリの CLI ボイラープレートを削減します。"
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "ja"
translationOf: "2026/01/system-commandline-v2-but-with-the-wiring-done-for-you-albatross-commandline-v8"
translatedBy: "claude"
translationDate: 2026-04-30
---
System.CommandLine v2 は、よりすっきりした焦点で出荷されました。パースを最優先にし、実行パイプラインを簡素化し、"魔法"のような振る舞いを減らしています。それは素晴らしいことですが、現実の CLI の多くは、結局のところ繰り返しの配管にたどり着きます。DI のセットアップ、ハンドラーのバインド、共有オプション、キャンセル、そしてホスティングです。

`Albatross.CommandLine` v8 は、まさにそのギャップに対する新しい視点です。System.CommandLine v2 の上に乗り、ソースジェネレーターとホスティング層を加えることで、コマンドを宣言的に定義し、つなぎのコードを邪魔にならない場所へ追いやれます。

## 価値提案: 可動部品を減らし、構造を増やす

著者の主張は明快です。

-   最小限のボイラープレート: 属性でコマンドを定義し、配線は生成
-   DI 優先のコンポジション: コマンドごとのサービス、なんでも注入可能
-   非同期とシャットダウンの処理: CancellationToken と Ctrl+C を最初から
-   それでもカスタマイズ可能: 必要なら System.CommandLine のオブジェクトに降りていける

この組み合わせは、フルな framework 依存を抱え込まずに"退屈な"インフラを欲しがる .NET 9 と .NET 10 の CLI アプリにとってのスイートスポットです。

## 読みやすさを保つ最小のホスト

形はこのようになります (発表内容から簡略化したもの):

```cs
// Program.cs (.NET 9 or .NET 10)
using Albatross.CommandLine;
using Microsoft.Extensions.DependencyInjection;
using System.CommandLine.Parsing;

await using var host = new CommandHost("Sample CLI")
    .RegisterServices(RegisterServices)
    .AddCommands() // generated
    .Parse(args)
    .Build();

return await host.InvokeAsync();

static void RegisterServices(ParseResult result, IServiceCollection services)
{
    services.RegisterCommands(); // generated registrations

    // Your app services
    services.AddSingleton<ITimeProvider, SystemTimeProvider>();
}

public interface ITimeProvider { DateTimeOffset Now { get; } }
public sealed class SystemTimeProvider : ITimeProvider { public DateTimeOffset Now => DateTimeOffset.UtcNow; }
```

重要なのは"ほら、ホストです"という点ではありません。ホストが予測可能なエントリーポイントとなり、ハンドラー層をテストでき、コマンド定義とサービスの配線を分けて保てる、という点です。

## 向くケースと向かないケース

次のような場合に向いています。

-   コマンドが 3〜5 個を超え、共有オプションが広がり始めている
-   CLI でも DI を使いたいが、コマンドごとにハンドラーを手で配線したくない
-   CLI が実務 (ネットワーク、ファイルシステム、長い I/O) を行うため、優雅なシャットダウンを重視している

おそらく見合わないのは次のような場合です。

-   コマンドが 1 つだけのユーティリティを出荷している
-   特殊なパース動作が必要で、System.CommandLine の内部に入り込む覚悟がある

手早く評価したい場合は、次が出発点として適しています。

-   ドキュメント: [https://rushuiguan.github.io/commandline/](https://rushuiguan.github.io/commandline/)
-   ソース: [https://github.com/rushuiguan/commandline](https://github.com/rushuiguan/commandline)
-   Reddit のアナウンス: [https://www.reddit.com/r/dotnet/comments/1q800bs/updated\_albatrosscommandline\_library\_for/](https://www.reddit.com/r/dotnet/comments/1q800bs/updated_albatrosscommandline_library_for/)
