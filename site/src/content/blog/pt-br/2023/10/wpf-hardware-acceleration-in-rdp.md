---
title: "Aceleração por hardware do WPF em RDP"
description: "Aprenda a habilitar a aceleração por hardware do WPF sobre RDP no .NET 8 para melhorar o desempenho e ter uma experiência de área de trabalho remota mais responsiva."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
  - "wpf"
lang: "pt-br"
translationOf: "2023/10/wpf-hardware-acceleration-in-rdp"
translatedBy: "claude"
translationDate: 2026-05-01
---
Aplicações WPF, por padrão, usam renderização por software quando acessadas via área de trabalho remota, mesmo que o sistema tenha capacidade de renderização por hardware. Com o .NET 8 chega uma nova opção que permite habilitar a aceleração por hardware ao usar o protocolo Remote Desktop. Isso pode resultar em melhor desempenho e em uma aplicação mais responsiva no geral.

Para ativar, defina o flag `Switch.System.Windows.Media.EnableHardwareAccelerationInRdp` como `true` dentro de um arquivo _`runtimeconfig.json`_, assim:

```json
{
  "configProperties": {
    "Switch.System.Windows.Media.EnableHardwareAccelerationInRdp": true
  }
}
```

Também dá para configurar esse ajuste diretamente no projeto, adicionando um `RuntimeHostConfigurationOption`, como no exemplo abaixo:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <RuntimeHostConfigurationOption Include="Switch.System.Windows.Media.EnableHardwareAccelerationInRdp" Value="true" />
  </ItemGroup>
</Project>
```

Observação: a opção de aceleração por hardware em RDP não pode ser configurada por variáveis de ambiente `DOTNET_`.
