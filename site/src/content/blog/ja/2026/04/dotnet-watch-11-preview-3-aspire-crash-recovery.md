---
title: ".NET 11 Preview 3 の dotnet watch: Aspire ホスト、クラッシュリカバリー、まともな Ctrl+C"
description: ".NET 11 Preview 3 で dotnet watch が Aspire app host 統合、クラッシュ後の自動再起動、Windows desktop アプリ向けの修正された Ctrl+C 処理を得ます。"
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "aspire"
  - "dotnet-watch"
lang: "ja"
translationOf: "2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery"
translatedBy: "claude"
translationDate: 2026-04-24
---

`dotnet watch` はいつも .NET インナーループの静かな働き馬でした。ファイルが変わるとアプリを再ロードし、できるところで hot reload を適用し、できないときは道を譲ります。.NET 11 Preview 3 (2026 年 4 月 14 日出荷) は 3 つの具体的な痛点でツールを前進させます: 分散アプリを動かす、クラッシュを生き残る、Windows desktop ターゲットでの Ctrl+C への対処です。

## Aspire app host が今やクリーンに watch される

Preview 3 まで、`dotnet watch` 配下で Aspire app host を走らせるのはぎこちないものでした。Aspire は複数の子プロジェクトをオーケストレートしますが、watcher はそのモデルを理解していなかったので、ファイル変更はホストだけを rebuild するか、トポロジー全体をゼロからリスタートさせるかのどちらかでした。

Preview 3 は `dotnet watch` を Aspire app model に直接配線します:

```bash
cd src/MyApp.AppHost
dotnet watch
```

`MyApp.ApiService` のファイルを編集すれば、watcher はその service にだけ変更を適用し、Aspire トポロジーの残りを生かしたままにします。ダッシュボードは立ったままで、依存コンテナは走り続け、プロジェクトごとに秒数ではなく、変更ごとの boot time 秒数を失うだけで済みます。

microservice-heavy な solution にとって、これは `dotnet watch` が nice-to-have であることと、デフォルトの作業方法であることの違いです。

## クラッシュ後の自動再起動

2 つ目の見出しはクラッシュリカバリーです。以前は、watch 対象のアプリがハンドルされていない例外を投げて死ぬと、`dotnet watch` はクラッシュメッセージで駐車して手動の再起動を待っていました。次のキーストロークで fix を保存しても、Ctrl+R を叩くまで何も起きませんでした。

Preview 3 ではその挙動が反転します。爆発する endpoint を取ります:

```csharp
app.MapGet("/", () =>
{
    throw new InvalidOperationException("boom");
});
```

アプリを一度クラッシュさせ、fix を保存すると、次の関連ファイル変更で `dotnet watch` が自動的に再起動します。アプリが non-zero で終了すると決めただけで feedback loop を失うことはありません。同じ挙動は startup でのクラッシュもカバーし、以前は hot reload がアタッチする前に watcher が詰まっていた状況も解決します。

これはすでに存在する watch-wide な "rude edit" ハンドリングとうまく組み合わさります: hot reload がまず試み、非サポートの edit では restart にフォールバックし、そして今や crash 後にも restart にフォールバックします。3 つのパス、一貫した結果 1 つ: アプリが戻ってくる、です。

## Windows desktop アプリでの Ctrl+C

3 つ目の修正は小さいですが慢性的でした: WPF と Windows Forms アプリの `dotnet watch` での Ctrl+C です。以前は desktop プロセスを孤児にしたり、watcher から切り離したり、モーダルウィンドウ内でハングさせたりしていました。Preview 3 はシグナルハンドリングを再配線し、Ctrl+C が watcher と desktop プロセスの両方を順番に分解し、Task Manager に `dotnet.exe` のゾンビエントリが積み上がらないようにします。

`dotnet watch` 下で WPF シェルを走らせる場合:

```bash
dotnet watch run --project src/DesktopShell
```

Ctrl+C を 1 回叩けば、シェルと watcher の両方がクリーンに終了します。基本的に聞こえますし、実際そうですが、以前の挙動は多くのチームが desktop プロジェクトで `dotnet watch` を完全に避ける主な理由でした。

## この 3 つがなぜ一緒に重要か

各変更はそれ単体では控えめです。組み合わせると、`dotnet watch` をプロジェクト単位のヘルパーから、Aspire トポロジーを一日中ホストでき、たまのクラッシュを吸収し、終わったときに自分の後片付けができるセッション全体のハーネスに移します。インナーループは目に見えて脆くなくなりました。

リリースノートは [.NET ブログ](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) にあり、SDK のセクションは [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk) にあります。
