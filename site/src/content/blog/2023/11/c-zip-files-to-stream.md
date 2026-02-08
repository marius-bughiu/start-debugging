---
title: "C# ZIP files to Stream"
description: ".NET 8 include new CreateFromDirectory overloads which enable you to create a ZIP file without writing them to disk. This is particularly useful in situations where you don’t want to store the zipped resources, you use the Zip content only for transfer. For example: if you were to provide an API allowing multi-file download. That…"
pubDate: 2023-11-06
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
.NET 8 include new `CreateFromDirectory` overloads which enable you to create a ZIP file without writing them to disk. This is particularly useful in situations where you don’t want to store the zipped resources, you use the Zip content only for transfer.

For example: if you were to provide an API allowing multi-file download. That endpoint will most likely compress the selected files into a `.zip` and provide that for download. By using the new overloads, you can easily bypass the disk – reducing the load on the disk and offering a faster response time to your users.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination);
```

In addition to the overload above there are a couple more allowing you to configure some options such as `compressionLevel`, `includeBaseDirectory` and `entryNameEncoding`.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory);
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory, Encoding? entryNameEncoding);
```

## Extract ZIP file from Stream

Similar to the `CreateFromDirectory` overloads, .NET 8 also includes new `ExtractToDirectory` overloads which enable you to extract a ZIP file directly from a `Stream`, without writing the intermediary `.zip` to disk. This is particularly useful in situations where you don’t want to store the Zip file and all you care about are the unzipped resources.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName)
```

In addition to the overload above there are a few more allowing you to configure some options such as `overwriteFiles` and `entryNameEncoding`.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, bool overwriteFiles) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding, bool overwriteFiles) { }
```
