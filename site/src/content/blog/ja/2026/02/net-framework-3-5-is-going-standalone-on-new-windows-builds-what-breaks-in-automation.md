---
title: ".NET Framework 3.5 が新しい Windows ビルドでスタンドアロン化: 何が壊れるか"
description: "Windows 11 Build 27965 から、.NET Framework 3.5 は Windows のオプションコンポーネントではなくなります。CI、プロビジョニング、ゴールデンイメージで何が壊れるか、そしてどう直すかを解説します。"
pubDate: 2026-02-07
tags:
  - "dotnet"
  - "windows"
lang: "ja"
translationOf: "2026/02/net-framework-3-5-is-going-standalone-on-new-windows-builds-what-breaks-in-automation"
translatedBy: "claude"
translationDate: 2026-04-29
---
Microsoft が、多くの開発者や IT 担当者が自動化してそのまま忘れていた何かを変えました。**Windows 11 Insider Preview Build 27965** から、**.NET Framework 3.5 は Windows のオプションコンポーネントとして含まれなくなります**。必要な場合は、これからは **スタンドアロンのインストーラー** として入手しなければなりません。

これは .NET Framework の話ですが、**.NET 10** と **C# 14** で最新のサービスを作っているチームにも影響します。痛みが出るのは、まっさらな開発者マシン、一時的な CI エージェント、ゴールデンイメージ、閉じたネットワークといった場所だからです。

## 重要なポイント: 「NetFx3」はもはや保証されない

投稿から:

-   この変更は Windows の **Build 27965 および今後のプラットフォームリリース** に適用されます。
-   **Windows 10** や **25H2** までの以前の Windows 11 リリースには **影響しません**。
-   ライフサイクルの現実と結びついています。**.NET Framework 3.5 は 2029 年 1 月 9 日にサポート終了が近づいています**。

スクリプトが「機能を有効にすれば Windows がやってくれる」を前提としているなら、新しいラインで壊れることを覚悟してください。

## 今、プロビジョニングがやるべきこと

.NET Framework 3.5 を、明示的にプロビジョニングして検証する依存関係として扱ってください。最低限:

-   新しい挙動になっている Windows のビルドバージョンを検出する。
-   そのマシンで `NetFx3` を照会して有効化できるかを確認する。
-   できない場合は、スタンドアロンインストーラーと互換性ノートに関する公式ガイダンスに従う。

ビルドエージェントのプロビジョニングや「プリフライト」ステップに組み込める、実用的なガードはこちらです。

```powershell
# Works on Windows PowerShell 5.1 and PowerShell 7+
$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$build = [int]$os.CurrentBuildNumber

Write-Host "Windows build: $build"

# Query feature state (if the OS exposes it this way)
dism /online /Get-FeatureInfo /FeatureName:NetFx3

if ($build -ge 27965) {
  Write-Host ".NET Framework 3.5 is obtained via standalone installer on this Windows line."
  Write-Host "Official guidance (installers + compatibility + migration paths):"
  Write-Host "https://go.microsoft.com/fwlink/?linkid=2348700"
}
```

これ自体は何もインストールしません。マシンイメージが知らないうちに変わっていたとき、失敗を早期に明確化し、解釈しやすくします。

## 今すぐ行動するべき「なぜ」

たとえ移行を計画していても、おそらくまだ次のものを抱えています。

-   3.5 を必要とする社内ツールやベンダー製アプリ
-   古いユーティリティを起動するテストスイート
-   アップグレードサイクルが長い顧客

つまり、当面の勝ちは「3.5 に留まる」ではありません。当面の勝ちは、サポート対象に向けて作業しながら、環境を予測可能に保つことです。

ソース:

-   [.NET Blog の投稿: .NET Framework 3.5 がスタンドアロンデプロイに移行](https://devblogs.microsoft.com/dotnet/dotnet-framework-3-5-moves-to-standalone-deployment-in-new-versions-of-windows/)
-   [Microsoft Learn のガイダンス: インストーラー、互換性、移行](https://go.microsoft.com/fwlink/?linkid=2348700)
