---
title: "RDP 経由での WPF のハードウェアアクセラレーション"
description: ".NET 8 で RDP 経由の WPF ハードウェアアクセラレーションを有効化して、パフォーマンスを向上させ、リモートデスクトップでもより快適に使う方法を解説します。"
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "ja"
translationOf: "2023/10/wpf-hardware-acceleration-in-rdp"
translatedBy: "claude"
translationDate: 2026-05-01
---
WPF アプリケーションは、システムにハードウェアレンダリング機能があっても、リモートデスクトップ経由でアクセスされた場合、デフォルトではソフトウェアレンダリングを使います。.NET 8 では、リモートデスクトップ プロトコル使用時にハードウェアアクセラレーションを有効化できる新しいオプションが追加されました。これによりパフォーマンスが向上し、全体的により応答性の高いアプリケーションになります。

有効化するには、_`runtimeconfig.json`_ ファイル内で `Switch.System.Windows.Media.EnableHardwareAccelerationInRdp` フラグを `true` に設定します。次のような形です。

```json
{
  "configProperties": {
    "Switch.System.Windows.Media.EnableHardwareAccelerationInRdp": true
  }
}
```

プロジェクトに `RuntimeHostConfigurationOption` を追加して、この設定を行うこともできます。以下の例をご覧ください。

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <RuntimeHostConfigurationOption Include="Switch.System.Windows.Media.EnableHardwareAccelerationInRdp" Value="true" />
  </ItemGroup>
</Project>
```

注: RDP 内のハードウェアアクセラレーションのオプションは、`DOTNET_` 環境変数では設定できません。
