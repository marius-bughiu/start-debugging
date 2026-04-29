---
title: "dev ビルドを台無しにせずに TreatWarningsAsErrors を使う (.NET 10)"
description: ".NET 10 で Directory.Build.props を使い、Release ビルドと CI で TreatWarningsAsErrors を強制しつつ、ローカル開発のために Debug を柔軟に保つ方法です。"
pubDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
`TreatWarningsAsErrors` を `true` にして即後悔した経験があるなら、それはあなただけではありません。最近出回っている r/dotnet のスレッドが、シンプルな調整方法を提案しています。Release (および CI) では警告ゼロを強制しつつ、ローカル探索のために Debug は柔軟に残す、というやり方です: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)

## Release のみ強制はトグルではなくポリシー

本当に達成したいのはワークフローです:

-   開発者はローカルでアナライザーのノイズと戦わずに試行錯誤できる。
-   新しい警告がしれっと混ざるとプルリクエストが失敗する。
-   時間とともに厳しさを段階的に上げていく余地は残る。

.NET 10 のリポジトリでは、これを集約するもっともきれいな場所は `Directory.Build.props` です。これでルールがテストプロジェクトを含むすべてのプロジェクトに、コピペなしで適用されます。

最小限のパターンはこちらです:

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

これはほとんどの CI パイプラインがそもそもビルドする内容 (Release) と一致します。CI が Debug をビルドしているなら、まず Release に切り替えてください。そうすれば「警告ゼロ」のラインが、出荷するバイナリと噛み合います。

## 厳格であることは盲目であることではない

大きなスイッチを入れたら、効くつまみは2つです:

-   `WarningsAsErrors`: 特定の警告 ID だけをエスカレートします。
-   `NoWarn`: 特定の警告 ID を抑制します (理想的にはコメントと追跡リンク付き)。

ある警告だけを締め、残りは警告のままにする例です:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <WarningsAsErrors>$(WarningsAsErrors);CS8602</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

ある1つのプロジェクトでうるさいアナライザーを一時的に抑制したい場合:

```xml
<Project>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <NoWarn>$(NoWarn);CA2007</NoWarn>
  </PropertyGroup>
</Project>
```

Roslyn アナライザーを使っている (モダンな .NET 10 ソリューションではよくあります) 場合、severity 制御のために `.editorconfig` も検討してください。発見しやすく、ポリシーをコードの近くに置けます:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.CA2007.severity = warning
```

## PR にもたらす実益

本当の勝ちは予測可能な PR フィードバックです。開発者はすぐに、警告は「将来の作業」ではなく Release の definition of done の一部だと理解します。Debug は速く寛容なまま、Release は厳格で出荷可能なまま、という形になります。

このパターンの元になったきっかけ (議論を生んだ小さなスニペット) を見たい場合は、こちらのスレッドをどうぞ: [https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/](https://www.reddit.com/r/dotnet/comments/1qjum3h/treating_warnings_as_errors_in_dotnet_the_right/)
