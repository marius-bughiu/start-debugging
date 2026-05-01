---
title: "Flutter: Your project requires a newer version of the Kotlin Gradle plugin"
description: "build.gradle の ext.kotlin_version を最新の Kotlin リリースに更新して、Flutter の 'Your project requires a newer version of the Kotlin Gradle plugin' エラーを解消する方法を解説します。"
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "ja"
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

これは 2 つのシンプルなステップで解消できます。

-   **ステップ 1**: [https://kotlinlang.org/docs/releases.html#release-details](https://kotlinlang.org/docs/releases.html#release-details) にアクセスして、Kotlin の最新バージョンを確認します。私の場合は 1.9.0 でした。
-   **ステップ 2**: `build.gradle` ファイル (`<project path>\android\build.gradle` にあります) を開きます。一番上の方 (通常は 2 行目) に `ext.kotlin_version = '1.6.10'` のような行が見えるはずです。その行を最新の Kotlin バージョンに更新します。私の場合は次のような形になります。

```gradle
buildscript {
    ext.kotlin_version = '1.9.0'
[...]
```
