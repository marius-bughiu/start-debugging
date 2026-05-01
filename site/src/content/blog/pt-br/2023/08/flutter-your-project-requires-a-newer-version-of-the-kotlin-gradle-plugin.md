---
title: "Flutter: Your project requires a newer version of the Kotlin Gradle plugin"
description: "Corrija o erro do Flutter 'Your project requires a newer version of the Kotlin Gradle plugin' atualizando ext.kotlin_version no seu arquivo build.gradle para a versão mais recente do Kotlin."
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "pt-br"
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

Dá para resolver em dois passos simples:

-   **Passo 1**: vá em [https://kotlinlang.org/docs/releases.html#release-details](https://kotlinlang.org/docs/releases.html#release-details) e descubra a versão mais recente do Kotlin. No meu caso era a 1.9.0.
-   **Passo 2**: abra o arquivo `build.gradle` (em `<project path>\android\build.gradle`) e, logo no início (normalmente na segunda linha), você verá algo como `ext.kotlin_version = '1.6.10'`. Atualize essa linha para a versão mais recente do Kotlin. No meu caso ficaria assim:

```gradle
buildscript {
    ext.kotlin_version = '1.9.0'
[...]
```
