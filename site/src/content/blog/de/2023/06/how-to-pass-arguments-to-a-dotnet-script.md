---
title: "Wie Sie einem dotnet script Argumente übergeben"
description: "Lernen Sie, wie Sie einem dotnet script Argumente über den Trenner -- übergeben und auf sie über die Args-Sammlung zugreifen."
pubDate: 2023-06-12
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
lang: "de"
translationOf: "2023/06/how-to-pass-arguments-to-a-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
Bei der Verwendung von **dotnet script** können Sie Argumente übergeben, indem Sie sie nach **--** (zwei Bindestrichen) angeben. Im Script greifen Sie anschließend über die Sammlung **Args** auf die Argumente zu.

Sehen wir uns ein Beispiel an. Angenommen, wir haben die folgende Skriptdatei **myScript.csx**:

```cs
Console.WriteLine($"Inputs: {string.Join(", ", Args)}");
```

Wir können diesem Script Parameter wie folgt übergeben:

```shell
dotnet script myScript.csx -- "a" "b"
```
