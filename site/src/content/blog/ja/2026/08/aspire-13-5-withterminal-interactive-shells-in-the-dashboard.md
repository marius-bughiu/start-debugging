---
title: "Aspire 13.5 はダッシュボードの中に本物のターミナルを載せる"
description: "WithTerminal() はリソースに対話的な PTY セッションを与え、ダッシュボードから直接入力したり、自分のシェルからアタッチしたりできます。実験的機能であり、デバッガーは自動接続されず、以前あった Shell オプションは削除されました。"
pubDate: 2026-08-28
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "tooling"
lang: "ja"
translationOf: "2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard"
translatedBy: "claude"
translationDate: 2026-08-28
---

[Aspire 13.5 は 2026 年 8 月 18 日にリリースされ](https://devblogs.microsoft.com/aspire/whats-new-aspire-13-5/)、ダッシュボードの刷新、TypeScript AppHost の GA、そして 12 件の破壊的変更を伴いました。しかし開発ループを実際に変えるのは、それらより小さな機能です。`WithTerminal()` は、コンソールログを眺めるだけだったリソースに、ダッシュボードから直接入力できる生きた疑似ターミナルを与えます。

## 呼び出し 1 つでリソースに PTY が付く

```csharp
#pragma warning disable ASPIRETERMINAL001
var agent = builder.AddExecutable("agent", "my-agent", ".")
    .WithTerminal();
#pragma warning restore ASPIRETERMINAL001
```

この API は実験的なので、呼び出すと `ASPIRETERMINAL001` が発生し、上記の pragma か `<NoWarn>` への ID 追加で明示的に承認するまで AppHost はビルドできません。有効にすると、ダッシュボードのリソースの Console Logs ページに、通常のログストリームと並んでターミナルビューが追加され、実行中のリソースは既定でそのビューで開きます。

オプション付きのオーバーロードはグリッドの寸法を扱います。

```csharp
.WithTerminal(options =>
{
    options.Columns = 200;  // 既定値 120
    options.Rows = 50;      // 既定値 30
});
```

どちらも 1 以上である必要があり、0 や負値は `ArgumentOutOfRangeException` を投げます。3 つ目のオプション `ShowTerminalHost`（既定 `false`）は実装を有用な形で露出させます。これは「レプリカごとの隠しターミナルホストリソースを、ダッシュボードと CLI のリソース一覧に表示するかどうか」を制御します。各レプリカは自分専用の隠しホストリソースの背後に独立したセッションを持つため、`.WithReplicas(3).WithTerminal()` は 3 つのセッションを生み、ダッシュボードで切り替えられます。この 2 つの呼び出しの順序は問いません。同じリソースに対して `WithTerminal()` を 2 回呼ぶと例外になります。

## 自分のシェルからアタッチする

CLI 側は機能フラグの後ろにあります。

```bash
aspire config set features.terminalCommandsEnabled true
aspire terminal ps
aspire terminal attach agent --replica 1
```

セッションは同時に複数の閲覧者をサポートするので、ブラウザーのタブとローカルシェルが同じプロセスを操作しても、どちらかがセッションを切ってしまうことはありません。

## 2 つの鋭い角

1 つ目はデバッガーです。ドキュメントによれば、「`WithTerminal` を適用すると、Aspire はそのリソースを素のプロセスとして実行し、デバッガーを自動的にアタッチしません」。つまり、いまステップ実行している最中のプロジェクトには向かず、TUI や REPL、手で操作したいマイグレーションスクリプトに向いています。Aspire はこれを一時的な制限としています。

2 つ目は 13.4 のプレビューで試した人を刺します。起動するシェルを選ぶ方法はありません。`Shell` オプションは削除されました。理由は「下層の疑似ターミナルに一度も配線されておらず、何の効果もなかったため」です。`TerminalOptions.Shell` を設定していたコードは 13.5 でコンパイルできなくなります。13.4 では何もしていなかったのに、です。

試す前にアップグレードの注意を 1 つ。リリースノートは、13.4 と 13.5 のパッケージを混在させると実行時に `MissingMethodException` または `TypeLoadException` で失敗すると警告しています。SDK とすべての `Aspire.Hosting.*` パッケージを、同じコミットで揃ったバージョンに上げてください。複数の AppHost を並べて動かしているなら、[13.2 の `--isolated` フラグ](/ja/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/)との相性が良く、分離された実行ごとに独自のポートに加えて独自のターミナルセッションが得られます。
