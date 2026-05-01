---
title: "Flutter: Your project requires a newer version of the Kotlin Gradle plugin"
description: "Исправьте ошибку Flutter 'Your project requires a newer version of the Kotlin Gradle plugin', обновив ext.kotlin_version в файле build.gradle до последнего релиза Kotlin."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "ru"
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

Это можно исправить в два простых шага:

-   **Шаг 1**: зайдите на [https://kotlinlang.org/docs/releases.html#release-details](https://kotlinlang.org/docs/releases.html#release-details) и узнайте последнюю версию Kotlin. В моём случае это была 1.9.0.
-   **Шаг 2**: откройте файл `build.gradle` (он лежит в `<project path>\android\build.gradle`) и в самом начале (обычно во второй строке) вы увидите что-то вроде `ext.kotlin_version = '1.6.10'`. Обновите эту строку на последнюю версию Kotlin. В моём случае это выглядит так:

```gradle
buildscript {
    ext.kotlin_version = '1.9.0'
[...]
```
