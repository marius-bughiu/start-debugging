---
title: "Aceleración por hardware de WPF en RDP"
description: "Aprende a habilitar la aceleración por hardware de WPF sobre RDP en .NET 8 para mejorar el rendimiento y conseguir una experiencia de escritorio remoto más fluida."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "es"
translationOf: "2023/10/wpf-hardware-acceleration-in-rdp"
translatedBy: "claude"
translationDate: 2026-05-01
---
Las aplicaciones WPF, por defecto, usan renderizado por software cuando se acceden a través de escritorio remoto, incluso si el sistema tiene capacidades de renderizado por hardware. Con .NET 8 se introduce una nueva opción que te permite optar por la aceleración por hardware cuando se usa el protocolo Remote Desktop. Esto puede mejorar el rendimiento y, en general, hacer que la aplicación responda mejor.

Puedes activarla estableciendo el flag `Switch.System.Windows.Media.EnableHardwareAccelerationInRdp` en `true` dentro de un archivo _`runtimeconfig.json`_, así:

```json
{
  "configProperties": {
    "Switch.System.Windows.Media.EnableHardwareAccelerationInRdp": true
  }
}
```

También puedes configurar este ajuste en tu proyecto añadiendo un `RuntimeHostConfigurationOption`. Ejemplo a continuación:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <RuntimeHostConfigurationOption Include="Switch.System.Windows.Media.EnableHardwareAccelerationInRdp" Value="true" />
  </ItemGroup>
</Project>
```

Nota: la opción de aceleración por hardware en RDP no se puede configurar mediante variables de entorno `DOTNET_`.
