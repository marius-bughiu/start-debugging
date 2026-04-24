---
title: ".NET 11 Preview 3: dotnet run -e が launch profile なしで環境変数を設定"
description: ".NET 11 Preview 3 の dotnet run -e は CLI から直接環境変数を渡し、MSBuild の RuntimeEnvironmentVariable item として公開します。"
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "dotnet-cli"
  - "msbuild"
lang: "ja"
translationOf: "2026/04/dotnet-11-preview-3-dotnet-run-environment-variables"
translatedBy: "claude"
translationDate: 2026-04-24
---

.NET 11 Preview 3 は 2026 年 4 月 14 日に出荷され、小さいけれど広く適用できる SDK 変更を含みます: `dotnet run` が `-e KEY=VALUE` を受け付けて、コマンドラインから直接環境変数を渡せるようになりました。shell の export も、`launchSettings.json` の編集も、その場限りのラッパースクリプトも不要です。

## フラグがなぜ重要か

Preview 3 以前、単一実行のための env var 設定は 3 つのぎこちない選択肢の 1 つでした。Windows では `set ASPNETCORE_ENVIRONMENT=Staging && dotnet run` で `cmd.exe` の quoting サプライズ付き。bash では `ASPNETCORE_ENVIRONMENT=Staging dotnet run` で動きますが、shell から fork された子プロセスに変数が漏れます。あるいはチームの他の誰も本当に欲しくない profile をまた 1 つ `Properties/launchSettings.json` に追加していました。

`dotnet run -e` はその仕事を引き取り、scope を実行そのものにタイトに保ちます。

## 構文と実際に設定するもの

変数ごとに `-e` を 1 つ渡します。フラグは必要な分だけ繰り返せます:

```bash
dotnet run -e ASPNETCORE_ENVIRONMENT=Development -e LOG_LEVEL=Debug
```

SDK はこれらの値を起動されたプロセスの環境に注入します。アプリは他のあらゆる変数と同じように、`Environment.GetEnvironmentVariable` や ASP.NET Core 設定パイプライン経由で見ます:

```csharp
var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
Console.WriteLine($"Running as: {env}");
```

知っておく価値のある 2 つ目の、より目立たない副作用があります: 同じ変数が MSBuild に `RuntimeEnvironmentVariable` item として公開されます。つまり `dotnet run` のビルドフェーズ中に走る target もそれらを読めるので、flag に対するコード生成のゲートや、環境ごとのリソースファイルの入れ替えといったシナリオが解禁されます。

## target から RuntimeEnvironmentVariable item を読む

flag に反応すべきカスタム target があるなら、MSBuild がすでに populate した item を列挙します:

```xml
<Target Name="LogRuntimeEnvVars" BeforeTargets="Build">
  <Message Importance="high"
           Text="Runtime env: @(RuntimeEnvironmentVariable->'%(Identity)=%(Value)', ', ')" />
</Target>
```

`dotnet run -e FEATURE_X=on -e TENANT=acme` を走らせると、アプリが起動する前に target は `FEATURE_X=on, TENANT=acme` を出力します。これらは普通の MSBuild item なので、`Condition` でフィルタしたり、他の property に流し込んだり、同じビルド内の `Include`/`Exclude` の判断を駆動するのに使えます。

## ワークフローのどこに収まるか

`dotnet run -e` は `launchSettings.json` の代替ではありません。Launch profile は毎日当たる一般的な設定や、Visual Studio や Rider でのデバッグシナリオにまだ意味があります。CLI フラグは one-shot のケースに最適です: 特定の `LOG_LEVEL` の下で誰かが報告したバグを再現する、profile をコミットせずに feature flag をテストする、YAML ファイルを書き直すことなく `dotnet watch` で素早い CI ステップを配線する、などです。

小さな注意点: スペースや shell 特殊文字を含む値は、あなたの shell に対する quoting がまだ必要です。`dotnet run -e "GREETING=hello world"` は bash と PowerShell で問題なく、`dotnet run -e GREETING="hello world"` は `cmd.exe` で動きます。SDK 自体は代入をそのまま受け取りますが、shell が最初にコマンドラインをパースします。

紙の上では .NET 11 Preview 3 で最も小さな機能で、実際にはおそらく最もよく使われるものの 1 つです。完全なリリースノートは [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk) にあり、アナウンスポストは [.NET ブログ](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) にあります。
