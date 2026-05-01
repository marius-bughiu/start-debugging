---
title: "Xamarin Startup Tracing für Android"
description: "Verbessern Sie die Startzeit Ihrer Xamarin-Android-App um bis zu 48% durch Startup Tracing, das nur den beim Start benötigten Code AOT-kompiliert."
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "android"
  - "xamarin"
lang: "de"
translationOf: "2020/04/xamarin-startup-tracing-for-android"
translatedBy: "claude"
translationDate: 2026-05-01
---
Die Startzeit Ihrer App ist wichtig, denn sie ist der erste Eindruck, den der Nutzer von ihrer Performance bekommt. Es ist egal, was Sie mir versprechen, wenn die App jedes Mal 10 Sekunden zum Laden braucht. Ich könnte sie sogar deinstallieren, weil ich denke, sie funktioniere nicht. Bei Xamarin Android war das im Laufe der Zeit ein heißes Thema. Nun hat das Team beschlossen, das Problem etwas aggressiver mit Startup Tracing anzugehen.

## Was ist Startup Tracing?

Es bedeutet im Grunde, dass ein Teil Ihrer Assemblies ahead-of-time (AOT) statt just-in-time (JIT) kompiliert wird, was den Overhead beim Ausführen des Codes verringert, aber die APK-Größe erhöht.

Konkret AOT-kompiliert Startup Tracing nur das, was Ihre App beim Start benötigt, basierend auf einem benutzerdefinierten Profil Ihrer App. Damit bleibt die APK-Vergrößerung minimal, während der Effekt maximiert wird.

Einige Zahlen, die das Xamarin-Team geteilt hat:

| Typ | Startzeit | APK-Größe |
| --- | --- | --- |
| Normal | 2914 ms | 16.1 MB |
| AOT | 1180 ms (-59%) | 34.6 MB (+115%) |
| Startup Tracing | 1518 ms (-48%) | 20.1 MB (+25%) |

## Startup Tracing aktivieren

Die Aktivierung ist einfach: Öffnen Sie die Einstellungen Ihres Xamarin-Android-Projekts (Rechtsklick > Properties) und setzen Sie unter "Code Generation and Runtime" das Häkchen bei "Enable Startup Tracing", wie im folgenden Bild gezeigt.

![](/wp-content/uploads/2020/04/Annotation-2020-04-04-122649-3.png)
