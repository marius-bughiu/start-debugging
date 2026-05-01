---
title: "Flutter: Your project requires a newer version of the Kotlin Gradle plugin"
description: "Beheben Sie den Flutter-Fehler 'Your project requires a newer version of the Kotlin Gradle plugin', indem Sie ext.kotlin_version in Ihrer build.gradle auf die neueste Kotlin-Version aktualisieren."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "de"
translationOf: "2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin"
translatedBy: "claude"
translationDate: 2026-05-01
---
```xml
[!] Your project requires a newer version of the Kotlin Gradle plugin.                                                                      
Find the latest version on https://kotlinlang.org/docs/releases.html#release-details, then update 
<project path>\android\build.gradle: 

ext.kotlin_version = '<latest-version>'
```

Das lässt sich in zwei einfachen Schritten beheben:

-   **Schritt 1**: Öffnen Sie [https://kotlinlang.org/docs/releases.html#release-details](https://kotlinlang.org/docs/releases.html#release-details) und ermitteln Sie die neueste Kotlin-Version. In meinem Fall war es 1.9.0.
-   **Schritt 2**: Öffnen Sie Ihre `build.gradle`-Datei (zu finden unter `<project path>\android\build.gradle`). Direkt am Anfang (meist in der zweiten Zeile) sehen Sie etwas wie `ext.kotlin_version = '1.6.10'`. Aktualisieren Sie diese Zeile auf die neueste Kotlin-Version. Bei mir würde es so aussehen:

```gradle
buildscript {
    ext.kotlin_version = '1.9.0'
[...]
```
