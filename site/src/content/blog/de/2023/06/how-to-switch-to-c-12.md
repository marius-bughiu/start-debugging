---
title: "Wie Sie zu C# 12 wechseln"
description: "Beheben Sie C#-12-Sprachversionsfehler, indem Sie Ihr Target Framework auf .NET 8 aktualisieren oder LangVersion in Ihrer .csproj-Datei setzen."
pubDate: 2023-06-10
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/06/how-to-switch-to-c-12"
translatedBy: "claude"
translationDate: 2026-05-01
---
Beim Ausprobieren von C#-12-Features stoßen Sie möglicherweise auf Fehler ähnlich diesen:

> Feature is not available in C# 11.0. Please use language version 12.0 or later.

oder

> Error CS8652: The feature '<feature name>' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Es gibt zwei Wege, diesen Fehler zu beheben:

-   Ändern Sie das Target Framework Ihres Projekts auf .NET 8 oder höher. Die Sprachversion sollte automatisch aktualisiert werden.
-   Bearbeiten Sie Ihre **.csproj**-Datei und geben Sie die gewünschte **<LangVersion>** an, wie im folgenden Beispiel:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<LangVersion>preview</LangVersion>
  </PropertyGroup>
</Project>
```

## Die Sprachversion ist ausgegraut und lässt sich nicht ändern

[![](/wp-content/uploads/2023/03/image.png)](/wp-content/uploads/2023/03/image.png)

Die Sprachversion lässt sich nicht über das **Eigenschaften**-Fenster des Projekts ändern. Die Version ist an die Target-.NET-Framework-Version Ihres Projekts gebunden und wird entsprechend dieser aktualisiert.

Wenn Sie die Sprachversion überschreiben müssen, ist das wie oben beschrieben über das Anpassen der **.csproj**-Datei und das Festlegen von **LangVersion** möglich.

Beachten Sie, dass jede C#-Sprachversion eine minimal unterstützte .NET-Version hat. C# 12 wird nur auf .NET 8 und neueren Versionen unterstützt. C# 11 wird nur auf .NET 7 und neueren Versionen unterstützt. C# 10 wird nur auf .NET 6 und neueren Versionen unterstützt. Und so weiter.

## Optionen für C#-LangVersion

Neben den Versionsnummern gibt es bestimmte Schlüsselwörter, mit denen Sie die Sprachversion Ihres Projekts angeben können:

-   **preview** -- bezieht sich auf die neueste Vorschauversion
-   **latest** -- die neueste freigegebene Version (einschließlich Minor-Version)
-   **latestMajor** oder **default** -- die neueste freigegebene Major-Version
