---
title: "C# ZIP ファイルを Stream に書き出す"
description: ".NET 8 では、ZIP ファイルをディスクに書き込まずに Stream との間で直接作成・展開できる、新しい CreateFromDirectory と ExtractToDirectory のオーバーロードが追加されました。"
pubDate: 2023-11-06
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/c-zip-files-to-stream"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 には、ZIP ファイルをディスクに書き込まずに作成できる、新しい `CreateFromDirectory` のオーバーロードが追加されました。これは、圧縮したリソースを保存する必要がなく、ZIP の内容を転送のためだけに使うようなケースで特に役立ちます。

たとえば、複数ファイルのダウンロードを許可する API を提供する場合を考えてみます。そのエンドポイントはおそらく、選択されたファイルを `.zip` に圧縮してダウンロードできるようにするはずです。新しいオーバーロードを使えば、ディスクを介さずに済むので、ディスクへの負荷を減らしつつ、ユーザーにより速いレスポンスを返せます。

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination);
```

上記のオーバーロードに加えて、`compressionLevel`、`includeBaseDirectory`、`entryNameEncoding` などのオプションを設定できるオーバーロードもいくつか用意されています。

```cs
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory);
public static void CreateFromDirectory(string sourceDirectoryName, Stream destination, CompressionLevel compressionLevel, bool includeBaseDirectory, Encoding? entryNameEncoding);
```

## Stream から ZIP ファイルを展開する

`CreateFromDirectory` のオーバーロードと同様に、.NET 8 には、中間の `.zip` をディスクに書き出さずに `Stream` から直接 ZIP ファイルを展開できる、新しい `ExtractToDirectory` のオーバーロードも追加されています。これは、ZIP ファイル自体は保存したくなく、展開後のリソースだけがあればよいというケースで特に役立ちます。

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName)
```

上記のオーバーロードに加えて、`overwriteFiles` や `entryNameEncoding` などのオプションを設定できるオーバーロードもいくつか用意されています。

```cs
public static void ExtractToDirectory(Stream source, string destinationDirectoryName) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, bool overwriteFiles) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding) { }
public static void ExtractToDirectory(Stream source, string destinationDirectoryName, Encoding? entryNameEncoding, bool overwriteFiles) { }
```
