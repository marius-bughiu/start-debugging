---
title: "C# ZIP-Dateien in einen Stream"
description: ".NET 8 enthält neue Überladungen von CreateFromDirectory und ExtractToDirectory, mit denen Sie ZIP-Dateien direkt in und aus einem Stream erstellen und extrahieren können, ohne auf die Festplatte zu schreiben."
pubDate: 2023-11-06
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/c-zip-files-to-stream"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 enthält neue `CreateFromDirectory`-Überladungen, mit denen Sie eine ZIP-Datei erstellen können, ohne sie auf die Festplatte zu schreiben. Das ist besonders nützlich, wenn Sie die gepackten Ressourcen nicht speichern müssen und den ZIP-Inhalt nur für die Übertragung verwenden.

Ein Beispiel: Sie stellen eine API zur Verfügung, die den Download mehrerer Dateien erlaubt. Dieser Endpunkt wird die ausgewählten Dateien höchstwahrscheinlich in einer `.zip` komprimieren und zum Download anbieten. Mit den neuen Überladungen umgehen Sie die Festplatte einfach, reduzieren so die Festplattenlast und bieten Ihren Nutzern eine schnellere Antwortzeit.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination);
```

Zusätzlich zur obigen Überladung gibt es weitere, mit denen Sie Optionen wie `compressionLevel`, `includeBaseDirectory` und `entryNameEncoding` konfigurieren können.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory);
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory, Encoding? entryNameEncoding);
```

## ZIP-Datei aus einem Stream extrahieren

Ähnlich wie bei den `CreateFromDirectory`-Überladungen enthält .NET 8 auch neue `ExtractToDirectory`-Überladungen, mit denen Sie eine ZIP-Datei direkt aus einem `Stream` extrahieren können, ohne die zwischenzeitliche `.zip` auf die Festplatte zu schreiben. Das ist besonders nützlich, wenn Sie die ZIP-Datei nicht speichern möchten und nur die entpackten Ressourcen benötigen.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName)
```

Zusätzlich zur obigen Überladung gibt es einige weitere, mit denen Sie Optionen wie `overwriteFiles` und `entryNameEncoding` konfigurieren können.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, bool overwriteFiles) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding, bool overwriteFiles) { }
```
