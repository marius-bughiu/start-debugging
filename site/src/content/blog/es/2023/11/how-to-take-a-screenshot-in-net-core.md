---
title: "Cómo capturar el escritorio de Windows desde .NET"
description: "Ejemplo de consola .NET ejecutable solo en Windows: captura los límites de la pantalla virtual, libera recursos gráficos y guarda un PNG."
pubDate: 2023-11-04
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este ejemplo usa Windows Forms y `System.Drawing` para capturar el rectángulo que engloba la pantalla virtual de la sesión de escritorio Windows actual. Es una aplicación Windows aunque el proyecto sea un programa de consola.

**Corrección — 2 de noviembre de 2026:** se restauró el código con configuración completa del proyecto, liberación de recursos, manejo de la carpeta de salida y una autoprueba con imagen sintética. Se compiló para Windows desde macOS; no se ejecutó captura real de pantalla Windows durante esta verificación.

## Descarga y configuración del proyecto

[Descarga el código ejecutable](/examples/windows-screenshot.zip). El archivo de proyecto contiene:

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

`UseWindowsForms` aporta la referencia al framework Windows Desktop. `EnableWindowsTargeting` permite compilar desde otro sistema si se pueden restaurar los targeting packs; no hace ejecutable la aplicación en macOS o Linux.

## Capturar la pantalla virtual

El programa completo incluye imports y un punto de entrada STA. La operación de captura es:

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

`screen.Left` y `screen.Top` pueden ser negativos si otro monitor está a la izquierda o encima del principal. El rectángulo puede incluir espacio sin usar entre pantallas. No garantiza capturar otras sesiones, escritorios seguros o contenido protegido.

El programa crea la carpeta de salida y un nombre PNG único, y libera sus objetos bitmap y graphics.

## Ejecutar en Windows

```powershell
dotnet run -c Release -- --self-test
dotnet run -c Release
dotnet run -c Release -- C:\Screenshots
```

La autoprueba crea y decodifica un PNG sintético sin capturar el escritorio. La ejecución normal guarda en Imágenes o en el directorio indicado. Prueba la captura real en la sesión Windows de destino, incluida su disposición de pantallas y sus ajustes DPI.

Referencias: [SystemInformation.VirtualScreen](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.systeminformation.virtualscreen), [Graphics.CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen).
