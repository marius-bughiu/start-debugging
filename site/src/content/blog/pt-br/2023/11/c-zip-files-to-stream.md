---
title: "C# arquivos ZIP para Stream"
description: ".NET 8 inclui novas sobrecargas de CreateFromDirectory e ExtractToDirectory que permitem criar e extrair arquivos ZIP diretamente para e a partir de um Stream, sem gravar em disco."
pubDate: 2023-11-06
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/c-zip-files-to-stream"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 inclui novas sobrecargas de `CreateFromDirectory` que permitem criar um arquivo ZIP sem gravá-lo em disco. Isso é particularmente útil em situações em que você não precisa armazenar os recursos compactados e usa o conteúdo do ZIP apenas para transferência.

Por exemplo: se você estivesse oferecendo uma API que permitisse download de múltiplos arquivos. Esse endpoint provavelmente vai compactar os arquivos selecionados em um `.zip` e disponibilizá-lo para download. Ao usar as novas sobrecargas, você consegue contornar o disco facilmente, reduzindo a carga sobre o disco e oferecendo um tempo de resposta mais rápido aos seus usuários.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination);
```

Além da sobrecarga acima, há mais algumas que permitem configurar opções como `compressionLevel`, `includeBaseDirectory` e `entryNameEncoding`.

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory);
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory, Encoding? entryNameEncoding);
```

## Extrair arquivo ZIP a partir de um Stream

Assim como nas sobrecargas de `CreateFromDirectory`, o .NET 8 também inclui novas sobrecargas de `ExtractToDirectory` que permitem extrair um arquivo ZIP diretamente de um `Stream`, sem gravar o `.zip` intermediário em disco. Isso é particularmente útil em situações em que você não quer armazenar o arquivo Zip e tudo o que importa são os recursos descompactados.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName)
```

Além da sobrecarga acima, há mais algumas que permitem configurar opções como `overwriteFiles` e `entryNameEncoding`.

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, bool overwriteFiles) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding, bool overwriteFiles) { }
```
