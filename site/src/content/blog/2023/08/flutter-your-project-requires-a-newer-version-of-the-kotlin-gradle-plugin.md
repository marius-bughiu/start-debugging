---
title: "Flutter: Your project requires a newer version of the Kotlin Gradle plugin"
description: "This can be fixed in two simple steps:"
pubDate: 2023-08-18
updatedDate: 2023-11-05
tags:
  - "flutter"
---
```xml
[!] Your project requires a newer version of the Kotlin Gradle plugin.                                                                      
Find the latest version on https://kotlinlang.org/docs/releases.html#release-details, then update 
<project path>\android\build.gradle: 

ext.kotlin_version = '<latest-version>'
```

This can be fixed in two simple steps:

-   **Step 1** – Go to [https://kotlinlang.org/docs/releases.html#release-details](https://kotlinlang.org/docs/releases.html#release-details) and determine the latest version of Kotlin. In my case, it was 1.9.0.
-   **Step 2** – Open up your `build.gradle` file (located at `<project path>\android\build.gradle`) and right at the top (usually on the second line), you should see something like `ext.kotlin_version = '1.6.10'`. Update that line to point to the latest Kotlin version. In my case, it would look like this:

```gradle
buildscript {
    ext.kotlin_version = '1.9.0'
[...]
```
