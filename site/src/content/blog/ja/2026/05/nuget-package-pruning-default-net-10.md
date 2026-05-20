---
title: ".NET 10 では NuGet パッケージプルーニングがデフォルトで有効"
description: "NuGet パッケージプルーニングが net10.0 プロジェクトでデフォルト有効になり、transitive な脆弱性レポートを 70%、restore 時間を最大 50% 削減します。"
pubDate: 2026-05-20
tags:
  - "dotnet"
  - "dotnet-10"
  - "nuget"
  - "security"
lang: "ja"
translationOf: "2026/05/nuget-package-pruning-default-net-10"
translatedBy: "claude"
translationDate: 2026-05-20
---

Nikolche Kolev は、`net10.0` 以降をターゲットとするすべてのプロジェクトで NuGet パッケージプルーニングがデフォルトで有効になることを [発表しました](https://devblogs.microsoft.com/dotnet/nuget-package-pruning-in-dotnet-10/)。この変更は .NET 10 SDK に含まれており、`dotnet list package --vulnerable` の出力をここ数年静かに騒がしくしてきたデフォルト値をリセットします。ランタイムライブラリはすでに共有フレームワークに含まれているため、それらを NuGet 依存関係として再度リストアップしてもファントム CVE を生み出すだけです。

## プルーニングが実際に取り除くもの

.NET SDK は、ランタイムが提供するパッケージとそれぞれのフレームワークが供給する最高バージョンのターゲットフレームワーク別マニフェストを同梱しています。restore の際、NuGet はバージョンがランタイムのバージョン以下である transitive なパッケージをすべて破棄します。直接参照は削除されませんが、ランタイムのコピーが勝つように `PrivateAssets='all'` と `IncludeAssets='none'` に書き換えられ、参照が完全に冗長な場合 NuGet は新しい警告 **NU1510** を発行します。

ブログは 2 つの具体的な数字を挙げています。新しいデフォルトのプロジェクトでは transitive な脆弱性レポートが 70% 減少し、ランタイムがすでに所有するパッケージをグラフが追いかけなくなることでプロジェクトあたりの restore 時間が最大 50% 短縮されます。

## デフォルトで有効になるもの

`net10.0` プロジェクトでは、SDK は次のように書いたかのように振る舞います。

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>true</RestoreEnablePackagePruning>
  <NuGetAuditMode>all</NuGetAuditMode>
</PropertyGroup>
```

`NuGetAuditMode=all` も `direct` から `all` に切り替わるため、残った transitive な集合は引き続き監査されます。プルーニングと監査は組み合わせるように設計されています。プルーニングはランタイムの上に実際に出荷されるものまでグラフを削り、監査はその小さくなったグラフに対して実行されます。

マルチターゲットプロジェクトでは、いずれかの TFM が `net10.0` 以降であれば、プルーニングはプロジェクト内のすべての TFM に適用されます。これにより、一方のヘッドが他方とは静かに異なる restore を行うという驚きを避けられます。

## 具体的な before / after

よくあるパターンは `Microsoft.Extensions.AI` と `NuGet.Protocol` を取り込むコンソールアプリです。.NET 9 では、`net10.0` が共有フレームワークでより新しい `System.Formats.Asn1` を出荷しているにもかかわらず、深い transitive パスを通じて `System.Formats.Asn1 6.0.0` が監査出力に表面化します。TFM を上げた後は次のようになります。

```xml
<TargetFramework>net10.0</TargetFramework>
```

`System.Formats.Asn1`, `System.Diagnostics.DiagnosticSource`, `System.Text.Json`, `System.Threading.Channels` は解決されたグラフから消えます。これらの CVE エントリは `dotnet list package --vulnerable` に表示されなくなります。そもそも実行時にロードされる予定はなかったからです。

## オプトアウト

両方の逃げ道が存在します。

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>false</RestoreEnablePackagePruning>
  <NuGetAuditMode>direct</NuGetAuditMode>
</PropertyGroup>
```

これは、ダウンレベルのコンシューマー向けに独自の `System.Text.Json` を本当に同梱する必要があるライブラリ、または lock ファイルを読み取る .NET 10 より前の SDK にツールがピン留めされたままの CI ジョブで行います。

共有フレームワークパッケージの transitive な脆弱性警告を黙らせるために `<NoWarn>NU1903;NU1904</NoWarn>` を引きずってきたなら、削除できるのはこのリリースです。TFM を上げ、一度 restore を実行し、監査レポートが縮んだかどうかを確認してください。
