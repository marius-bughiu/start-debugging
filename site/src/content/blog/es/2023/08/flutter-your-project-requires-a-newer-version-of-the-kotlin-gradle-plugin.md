---
title: "Flutter: Your project requires a newer version of the Kotlin Gradle plugin"
description: "Arregla el error de Flutter 'Your project requires a newer version of the Kotlin Gradle plugin' actualizando ext.kotlin_version en tu archivo build.gradle a la última versión de Kotlin."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "es"
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

Esto se puede arreglar en dos pasos sencillos:

-   **Paso 1**: ve a [https://kotlinlang.org/docs/releases.html#release-details](https://kotlinlang.org/docs/releases.html#release-details) y averigua cuál es la última versión de Kotlin. En mi caso era la 1.9.0.
-   **Paso 2**: abre tu archivo `build.gradle` (ubicado en `<project path>\android\build.gradle`) y, justo al inicio (normalmente en la segunda línea), deberías ver algo como `ext.kotlin_version = '1.6.10'`. Actualiza esa línea para apuntar a la última versión de Kotlin. En mi caso quedaría así:

```gradle
buildscript {
    ext.kotlin_version = '1.9.0'
[...]
```
