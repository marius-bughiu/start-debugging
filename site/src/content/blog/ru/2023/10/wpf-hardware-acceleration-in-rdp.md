---
title: "Аппаратное ускорение WPF в RDP"
description: "Узнайте, как в .NET 8 включить аппаратное ускорение WPF поверх RDP для лучшей производительности и более отзывчивого удалённого рабочего стола."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "ru"
translationOf: "2023/10/wpf-hardware-acceleration-in-rdp"
translatedBy: "claude"
translationDate: 2026-05-01
---
WPF-приложения по умолчанию используют программный рендеринг при работе через удалённый рабочий стол, даже если в системе есть аппаратные возможности рендеринга. В .NET 8 появилась новая опция, которая позволяет включить аппаратное ускорение при использовании протокола Remote Desktop. Это может дать прирост производительности и в целом сделать приложение более отзывчивым.

Для включения выставьте флаг `Switch.System.Windows.Media.EnableHardwareAccelerationInRdp` в значение `true` внутри файла _`runtimeconfig.json`_, например так:

```json
{
  "configProperties": {
    "Switch.System.Windows.Media.EnableHardwareAccelerationInRdp": true
  }
}
```

Этот же параметр можно задать в проекте через `RuntimeHostConfigurationOption`. Пример ниже:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <RuntimeHostConfigurationOption Include="Switch.System.Windows.Media.EnableHardwareAccelerationInRdp" Value="true" />
  </ItemGroup>
</Project>
```

Примечание: опцию аппаратного ускорения в RDP нельзя настроить через переменные окружения `DOTNET_`.
