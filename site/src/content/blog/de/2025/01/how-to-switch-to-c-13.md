---
title: "Wie man auf C# 13 umstellt"
description: "Wie Sie 'Feature is not available in C# 12.0' beheben und Ihr Projekt auf C# 13 umstellen, indem Sie das Target Framework ändern oder LangVersion in Ihrer .csproj-Datei setzen."
pubDate: 2025-01-01
updatedDate: 2025-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "de"
translationOf: "2025/01/how-to-switch-to-c-13"
translatedBy: "claude"
translationDate: 2026-05-01
---
Beim Ausprobieren der C#-13-Funktionen kann es sein, dass Sie auf Fehler wie diese stoßen:

> Feature is not available in C# 12.0. Please use language version 13.0 or later.

oder

> Error CS8652: The feature ‘<feature name>’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

Es gibt zwei Wege, diesen Fehler zu beheben:

-   ändern Sie das Target Framework Ihres Projekts auf .NET 9 oder höher. Die Sprachversion sollte automatisch aktualisiert werden.
-   bearbeiten Sie Ihre **.csproj**-Datei und geben Sie die gewünschte **<LangVersion>** wie im Beispiel unten an:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## Sprachversion ist ausgegraut und kann nicht geändert werden

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

Die Sprachversion lässt sich nicht über das Fenster **Properties** des Projekts ändern. Die Version ist an die Target-.NET-Framework-Version Ihres Projekts gekoppelt und wird entsprechend aktualisiert.

Wenn Sie die Sprachversion überschreiben müssen, tun Sie das wie oben beschrieben, indem Sie die **.csproj**-Datei bearbeiten und die **LangVersion** angeben.

Beachten Sie, dass jede C#-Sprachversion eine minimal unterstützte .NET-Version hat. C# 13 wird nur auf .NET 9 und neueren Versionen unterstützt. C# 12 wird nur auf .NET 8 und neueren Versionen unterstützt.

## C#-LangVersion-Optionen

Zusätzlich zu den Versionsnummern gibt es bestimmte Schlüsselwörter, die zur Angabe der Sprachversion Ihres Projekts verwendet werden können:

-   **preview** – verweist auf die neueste Vorschauversion
-   **latest** – die zuletzt veröffentlichte Version (einschließlich Nebenversion)
-   **latestMajor** oder **default** – die zuletzt veröffentlichte Hauptversion

## Nicht das, wonach Sie suchen?

Vielleicht möchten Sie auf eine andere C#-Version wechseln, in dem Fall:

-   [Wie man auf C# 12 umstellt](/2023/06/how-to-switch-to-c-12/)
-   [Wie man auf C# 11 umstellt](/2023/03/how-to-switch-to-c-11/)
