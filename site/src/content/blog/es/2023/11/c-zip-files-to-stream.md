---
title: "C# Archivos ZIP a Stream"
description: ".NET 8 incluye nuevas sobrecargas de CreateFromDirectory y ExtractToDirectory que te permiten crear y extraer archivos ZIP directamente desde y hacia un Stream, sin escribir en disco."
pubDate: 2023-11-06
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/c-zip-files-to-stream"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 incluye nuevas sobrecargas de `CreateFromDirectory` que te permiten crear un archivo ZIP sin escribirlo en disco. Esto es particularmente útil en situaciones en las que no necesitas almacenar los recursos comprimidos y solo usas el contenido del ZIP para transferirlo.

Por ejemplo: si proporcionaras una API que permita la descarga de varios archivos. Ese endpoint probablemente comprimirá los archivos seleccionados en un `.zip` y lo entregará para descarga. Al usar las nuevas sobrecargas, puedes evitar el disco fácilmente, reduciendo la carga sobre el disco y ofreciendo un tiempo de respuesta más rápido a tus usuarios.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination);
```

Además de la sobrecarga anterior hay un par más que te permiten configurar algunas opciones como `compressionLevel`, `includeBaseDirectory` y `entryNameEncoding`.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory);
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory, Encoding? entryNameEncoding);
```

## Extraer un archivo ZIP desde un Stream

De forma similar a las sobrecargas de `CreateFromDirectory`, .NET 8 también incluye nuevas sobrecargas de `ExtractToDirectory` que te permiten extraer un archivo ZIP directamente desde un `Stream`, sin escribir el `.zip` intermedio en disco. Esto es particularmente útil en situaciones en las que no quieres almacenar el archivo Zip y lo único que te importa son los recursos descomprimidos.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName)
```

Además de la sobrecarga anterior hay algunas más que te permiten configurar opciones como `overwriteFiles` y `entryNameEncoding`.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, bool overwriteFiles) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding, bool overwriteFiles) { }
```
