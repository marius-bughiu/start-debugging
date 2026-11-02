---
title: "How to take a Windows desktop screenshot from .NET"
description: "A runnable Windows-only .NET console sample that captures virtual-screen bounds, disposes drawing resources and saves a PNG."
pubDate: 2023-11-04
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
---
This example uses Windows Forms and `System.Drawing` to capture the virtual-screen bounding rectangle of the current Windows desktop session. It is a Windows application, even though the project is a console program.

**Correction — November 2, 2026:** The missing source has been restored with complete project settings, resource disposal, output-folder handling and a synthetic-image self-test. It was cross-built on macOS; real Windows display capture was not executed during this verification.

## Download and project settings

[Download the runnable source](/examples/windows-screenshot.zip). Its project file contains:

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

`UseWindowsForms` supplies the Windows Desktop framework reference. `EnableWindowsTargeting` permits a cross-build when targeting packs can be restored; it does not make the application runnable on macOS or Linux.

## Capture the virtual screen

The complete program supplies the imports and an STA entry point. Its capture operation is:

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

`screen.Left` and `screen.Top` may be negative when another monitor sits left or above the primary display. The bounding rectangle can include unused space between displays. It does not promise capture of other sessions, secure desktops or protected content.

The program creates the output directory and a unique PNG filename, and disposes its bitmap and graphics objects.

## Run on Windows

```powershell
dotnet run -c Release -- --self-test
dotnet run -c Release
dotnet run -c Release -- C:\Screenshots
```

The self-test creates and decodes a synthetic PNG without capturing a desktop. Normal execution writes to Pictures or the supplied directory. Test real capture in the target Windows session, including its display arrangement and DPI settings.

References: [SystemInformation.VirtualScreen](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.systeminformation.virtualscreen), [Graphics.CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen).
