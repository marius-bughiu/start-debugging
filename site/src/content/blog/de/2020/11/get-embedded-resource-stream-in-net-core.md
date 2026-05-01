---
title: "Embedded-Resource-Stream in .NET Core abrufen"
description: "Erfahren Sie, wie Sie in .NET Core einen Stream zu einer eingebetteten Ressource abrufen, indem Sie die Zusammensetzung des Ressourcennamens verstehen und GetManifestResourceStream nutzen."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2020/11/get-embedded-resource-stream-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um eine eingebettete Ressource in .NET Core abzurufen, müssen wir zunächst verstehen, wie der Ressourcenname aufgebaut ist. Er besteht aus 3 Elementen, die alle mit Punkten (`.`) verbunden sind:

-   dem Root-Namespace
-   dem erweiterten bzw. Datei-Namespace
-   dem Dateinamen

Nehmen wir ein konkretes Beispiel. Wir haben ein Projekt (Assembly) mit dem Root-Namespace `MyApp.Core`. Innerhalb des Projekts befindet sich eine Ordner- und Unterordnerstruktur wie `Assets` > `Images`. Darin liegt eine eingebettete Ressource namens `logo.png`. In diesem Fall gilt:

-   Root-Namespace: `MyApp.Core`
-   erweiterter Namespace: `Assets.Images`
-   Dateiname: `logo.png`

Verbinden Sie sie mit `.` und Sie erhalten: `MyApp.Core.Assets.Images.logo.png`.

Sobald Sie den Ressourcen-Identifier kennen, brauchen Sie nur noch eine Referenz auf die Assembly, die die Ressource enthält. Diese erhalten wir leicht von jeder Klasse, die in dieser Assembly definiert ist; angenommen wir haben eine Klasse `MyClass`:

```cs
typeof(MyClass).Assembly.GetManifestResourceStream("MyApp.Core.Assets.Images.logo.png")
```

## Liste aller eingebetteten Ressourcen einer Assembly abrufen

Falls Sie die Ressource nicht finden, liegt das meist an einem der folgenden Gründe:

-   Sie haben den Identifier falsch
-   Sie haben die Datei nicht als Embedded Resource markiert
-   Sie suchen in der falschen Assembly

Zur Fehlersuche können Sie alle eingebetteten Ressourcen einer Assembly auflisten und von dort weiterarbeiten. Dazu:

```cs
typeof(MyClass).Assembly.GetManifestResourceNames()
```

Das liefert ein einfaches `string[]` zurück, das Sie zum Debuggen bequem im `Immediate Window` verwenden können.
