---
title: "Wie Sie zu C# 11 wechseln"
description: "Beheben Sie den Fehler 'Feature is not available in C# 10.0', indem Sie über das Target Framework oder LangVersion in Ihrer .csproj-Datei zu C# 11 wechseln."
pubDate: 2023-03-14
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/03/how-to-switch-to-c-11"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Feature is not available in C# 10.0. Please use language version 11.0 or later.

Es gibt zwei Wege, das anzugehen:

-   Ändern Sie das Target Framework Ihres Projekts auf .NET 7 oder höher. Die Sprachversion sollte automatisch aktualisiert werden.
-   Bearbeiten Sie Ihre **.csproj**-Datei und geben Sie die gewünschte **<LangVersion>** an, wie im folgenden Beispiel:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net7.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>11.0</LangVersion>
  </PropertyGroup>
</Project>
```

## Die Sprachversion ist ausgegraut und lässt sich nicht ändern

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

Die Sprachversion lässt sich nicht über das **Eigenschaften**-Fenster des Projekts ändern. Die Version ist an die Target-.NET-Framework-Version Ihres Projekts gebunden und wird entsprechend dieser aktualisiert.

Wenn Sie die Sprachversion überschreiben müssen, ist das wie oben beschrieben über das Anpassen der **.csproj**-Datei und das Festlegen von **LangVersion** möglich.

Beachten Sie, dass jede C#-Sprachversion eine minimal unterstützte .NET-Version hat. C# 11 wird nur auf .NET 7 und neueren Versionen unterstützt. C# 10 wird nur auf .NET 6 und neueren Versionen unterstützt. C# 9 wird nur auf .NET 5 und neueren Versionen unterstützt.

## Optionen für C#-LangVersion

Neben den Versionsnummern gibt es bestimmte Schlüsselwörter, mit denen Sie die Sprachversion Ihres Projekts angeben können:

-   **preview** -- bezieht sich auf die neueste Vorschauversion
-   **latest** -- die neueste freigegebene Version (einschließlich Minor-Version)
-   **latestMajor** oder **default** -- die neueste freigegebene Major-Version
