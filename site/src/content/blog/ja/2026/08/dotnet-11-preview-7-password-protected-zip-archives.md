---
title: ".NET 11 Preview 7 で System.IO.Compression がついに暗号化 ZIP を読み書きします"
description: ".NET 11 Preview 7 は System.IO.Compression にパスワード保護された ZIP エントリを追加します。AES-256 のサポート、ディレクトリ全体を扱う操作向けのオプション型、そして main では既に修正済みの空ファイルの不具合について解説します。"
pubDate: 2026-08-15
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "security"
lang: "ja"
translationOf: "2026/08/dotnet-11-preview-7-password-protected-zip-archives"
translatedBy: "claude"
translationDate: 2026-08-15
---

10 年間、".NET でパスワード保護された ZIP を書き出すにはどうすればよいか" という質問への答えは "DotNetZip か SharpZipLib を入れてください" でした。発端となった要望 [dotnet/runtime#1545](https://github.com/dotnet/runtime/issues/1545) が登録されたのは 2016 年 9 月です。それが今月クローズされました。2026-08-11 にリリースされた [.NET 11 Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/) が、[dotnet/runtime#122093](https://github.com/dotnet/runtime/pull/122093) によって `System.IO.Compression` に暗号化サポートを追加しています。

## パスワードはアーカイブではなくエントリに紐づきます

最初に知っておく価値のある設計上の判断があります。暗号化はアーカイブ単位ではなくエントリ単位です。`ZipArchive` に `Password` プロパティはありません。代わりに `CreateEntry` にパスワードと `ZipEncryptionMethod` を受け取るオーバーロードが追加され、`ZipArchiveEntry.Open` にパスワードを受け取るオーバーロードが追加されました。

```csharp
using System.IO.Compression;

using var archive = ZipFile.Open("payroll.zip", ZipArchiveMode.Create);

ZipArchiveEntry entry = archive.CreateEntry(
    "march.csv",
    password: "correct horse battery staple",
    encryptionMethod: ZipEncryptionMethod.Aes256);

using Stream stream = entry.Open("correct horse battery staple");
using var writer = new StreamWriter(stream);
writer.WriteLine("employee,gross,net");
```

そのとおり、パスワードは 2 回登場します。`CreateEntry` は暗号化メタデータをアーカイブに記録し、実際に暗号ストリームへ鍵を渡すのは `Open` です。パスワードの型は同期オーバーロードでは `ReadOnlySpan<char>`、非同期オーバーロードでは `ReadOnlyMemory<char>` なので、文字列インターンのテーブルに残したくない場合はそれを避けられます。

読み戻すと、2 つの新しいプロパティが見えます。

```csharp
using var archive = ZipFile.OpenRead("payroll.zip");
ZipArchiveEntry entry = archive.GetEntry("march.csv")!;

Console.WriteLine(entry.IsEncrypted);      // True
Console.WriteLine(entry.EncryptionMethod); // Aes256

using Stream reader = entry.Open("correct horse battery staple");
```

`ZipEncryptionMethod` には実質的な値が 5 つあります。`None`、`ZipCrypto`、`Aes128`、`Aes192`、`Aes256` で、これに .NET が認識できないツールが書き出したアーカイブ向けの `Unknown` が加わります。`ZipCrypto` は PKWARE のオリジナルの暗号方式で、既知平文攻撃によって破られているため、古いツールとの互換性のためだけに存在します。相手側の事情で強制されない限り `Aes256` を選んでください。

パスワードが誤っている場合は `InvalidDataException` として現れますが、これはエントリが破損している場合と同じ例外です。"パスワードが違う" ことを表す専用の型はないため、2 つのケースを区別できる前提で再入力フローを組まないでください。

## ディレクトリ全体の操作にはオプション型が用意されます

Preview 7 は `ZipFileCreationOptions` と `ZipExtractionOptions` も追加します。一括処理用の API がパスワードを受け取るのはここです。

```csharp
ZipFile.CreateFromDirectory("out/reports", "reports.zip", new ZipFileCreationOptions
{
    Password = "hunter2".AsMemory(),
    EncryptionMethod = ZipEncryptionMethod.Aes256,
    CompressionLevel = CompressionLevel.SmallestSize,
});

await ZipFile.ExtractToDirectoryAsync("reports.zip", "in/reports", new ZipExtractionOptions
{
    Password = "hunter2".AsMemory(),
    OverwriteFiles = true,
});
```

## Preview 7 で必ず踏む空ファイルの不具合

0 バイトのファイル (`.gitkeep` や空のログなど) を含むディレクトリを圧縮して展開し直すと、展開時に "The archive entry was compressed using an unsupported compression method" で失敗します。2026-08-12 に登録された [dotnet/runtime#132213](https://github.com/dotnet/runtime/issues/132213) は、書き込み側がローカルファイルヘッダーより先に暗号化ストリームを破棄していたことを原因として突き止めました。その結果 `Stored` が強制され AES の拡張フィールドが失われる一方で、セントラルディレクトリは方式 99 のままだったのです。

[PR #132217](https://github.com/dotnet/runtime/pull/132217) は 2026-08-13 にマイルストーン 11.0-rc1 でマージされたため、手元の Preview 7 のビルドにはまだこの不具合が残っています。9 月に RC1 が出るまでは、長さ 0 のファイルを除外するか、自分で `CreateEntry` を使って書き込んでください。

このプレビューで他に何が変わったかを確認しているなら、[Blazor の circuit 自動一時停止](/ja/2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7/) がもう一つの読み返す価値のある機能です。
