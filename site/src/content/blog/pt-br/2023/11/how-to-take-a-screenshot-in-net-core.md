---
title: "Como capturar o desktop do Windows com .NET"
description: "Exemplo de console .NET executável apenas no Windows: captura os limites da tela virtual, libera recursos gráficos e salva um PNG."
pubDate: 2023-11-04
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este exemplo usa Windows Forms e `System.Drawing` para capturar o retângulo que engloba a tela virtual da sessão atual de desktop Windows. É uma aplicação Windows, mesmo que o projeto seja um programa de console.

**Correção — 2 de novembro de 2026:** o código ausente foi restaurado com configurações completas, descarte de recursos, tratamento da pasta de saída e autoteste com imagem sintética. Ele foi compilado para Windows no macOS; a captura real de uma tela Windows não foi executada nesta verificação.

## Download e configurações do projeto

[Baixe o código executável](/examples/windows-screenshot.zip). O arquivo de projeto contém:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
```

`UseWindowsForms` fornece a referência ao framework Windows Desktop. `EnableWindowsTargeting` permite compilar em outro sistema quando os targeting packs podem ser restaurados; não torna a aplicação executável em macOS ou Linux.

## Capturar a tela virtual

O programa completo inclui imports e ponto de entrada STA. A operação de captura é:

```cs
var screen = SystemInformation.VirtualScreen;
using var bitmap = new Bitmap(screen.Width, screen.Height);
using (var graphics = Graphics.FromImage(bitmap))
{
    graphics.CopyFromScreen(
        screen.Left, screen.Top, 0, 0, screen.Size,
        CopyPixelOperation.SourceCopy);
}
bitmap.Save(filename, ImageFormat.Png);
```

`screen.Left` e `screen.Top` podem ser negativos quando outro monitor fica à esquerda ou acima do principal. O retângulo pode incluir áreas não utilizadas entre monitores. Não há garantia de capturar outras sessões, desktops seguros ou conteúdo protegido.

O programa cria o diretório de saída e um nome PNG único e descarta seus objetos bitmap e graphics.

## Executar no Windows

```powershell
dotnet run -c Release -- --self-test
dotnet run -c Release
dotnet run -c Release -- C:\Screenshots
```

O autoteste cria e decodifica um PNG sintético sem capturar o desktop. A execução normal grava em Imagens ou no diretório fornecido. Teste a captura real na sessão Windows de destino, incluindo disposição de monitores e configurações DPI.

Referências: [SystemInformation.VirtualScreen](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.systeminformation.virtualscreen), [Graphics.CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen).
