---
title: "C# ZIP-файлы в Stream"
description: ".NET 8 включает новые перегрузки CreateFromDirectory и ExtractToDirectory, которые позволяют создавать и извлекать ZIP-файлы напрямую в Stream и из него, без записи на диск."
pubDate: 2023-11-06
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/c-zip-files-to-stream"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 включает новые перегрузки `CreateFromDirectory`, которые позволяют создавать ZIP-файл, не записывая его на диск. Это особенно удобно в ситуациях, когда вам не нужно хранить упакованные ресурсы и содержимое ZIP используется только для передачи.

Например: предположим, что вы предоставляете API, позволяющий скачивать сразу несколько файлов. Эта конечная точка, скорее всего, будет сжимать выбранные файлы в `.zip` и отдавать его на скачивание. Используя новые перегрузки, вы легко обходите диск, снижая нагрузку на него и обеспечивая более быстрый отклик для своих пользователей.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination);
```

Помимо приведённой выше перегрузки есть ещё несколько, которые позволяют настраивать такие параметры, как `compressionLevel`, `includeBaseDirectory` и `entryNameEncoding`.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory);
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory, Encoding? entryNameEncoding);
```

## Извлечение ZIP-файла из Stream

Аналогично перегрузкам `CreateFromDirectory`, в .NET 8 также появились новые перегрузки `ExtractToDirectory`, которые позволяют извлекать ZIP-файл напрямую из `Stream`, не записывая промежуточный `.zip` на диск. Это особенно удобно в ситуациях, когда вы не хотите хранить ZIP-файл и вас интересуют только распакованные ресурсы.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName)
```

Помимо приведённой выше перегрузки есть ещё несколько, которые позволяют настраивать такие параметры, как `overwriteFiles` и `entryNameEncoding`.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, bool overwriteFiles) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding, bool overwriteFiles) { }
```
