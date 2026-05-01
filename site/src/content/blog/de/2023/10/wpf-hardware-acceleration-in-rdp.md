---
title: "WPF-Hardwarebeschleunigung in RDP"
description: "Erfahren Sie, wie Sie in .NET 8 die WPF-Hardwarebeschleunigung über RDP aktivieren, um die Leistung zu verbessern und eine reaktionsfreudigere Remote-Desktop-Erfahrung zu erreichen."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "de"
translationOf: "2023/10/wpf-hardware-acceleration-in-rdp"
translatedBy: "claude"
translationDate: 2026-05-01
---
WPF-Anwendungen verwenden bei einem Zugriff über Remote Desktop standardmäßig Software-Rendering, auch wenn das System Hardware-Rendering unterstützt. Mit .NET 8 wird eine neue Option eingeführt, mit der Sie sich beim Remote Desktop Protocol für die Hardwarebeschleunigung entscheiden können. Das Ergebnis: bessere Leistung und insgesamt mehr Reaktionsfreudigkeit der Anwendung.

Sie aktivieren es, indem Sie das Flag `Switch.System.Windows.Media.EnableHardwareAccelerationInRdp` in einer _`runtimeconfig.json`_ auf `true` setzen, etwa so:

```json
{
  "configProperties": {
    "Switch.System.Windows.Media.EnableHardwareAccelerationInRdp": true
  }
}
```

Alternativ können Sie diese Einstellung direkt im Projekt setzen, indem Sie ein `RuntimeHostConfigurationOption` hinzufügen, siehe Beispiel:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <RuntimeHostConfigurationOption Include="Switch.System.Windows.Media.EnableHardwareAccelerationInRdp" Value="true" />
  </ItemGroup>
</Project>
```

Hinweis: Die Option für Hardwarebeschleunigung in RDP lässt sich nicht über `DOTNET_`-Umgebungsvariablen konfigurieren.
