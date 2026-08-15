---
title: "System.IO.Compression Finally Reads and Writes Encrypted ZIPs in .NET 11 Preview 7"
description: ".NET 11 Preview 7 adds password-protected ZIP entries to System.IO.Compression, with AES-256 support, options types for whole-directory operations, and one empty-file bug that is already fixed in main."
pubDate: 2026-08-15
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "security"
---

For ten years the answer to "how do I write a password-protected ZIP in .NET" was "install DotNetZip or SharpZipLib". The request that started it, [dotnet/runtime#1545](https://github.com/dotnet/runtime/issues/1545), was filed in September 2016. It closed this month: [.NET 11 Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/), released August 11, 2026, ships encryption support in `System.IO.Compression` via [dotnet/runtime#122093](https://github.com/dotnet/runtime/pull/122093).

## The password rides on the entry, not the archive

The design decision worth knowing up front: encryption is per entry, not per archive. `ZipArchive` has no `Password` property. Instead `CreateEntry` gained overloads that take a password plus a `ZipEncryptionMethod`, and `ZipArchiveEntry.Open` gained overloads that take a password.

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

Yes, the password appears twice. `CreateEntry` records the encryption metadata in the archive; `Open` is what actually keys the cipher stream. Passwords are `ReadOnlySpan<char>` on the synchronous overloads and `ReadOnlyMemory<char>` on the async ones, so you can keep them out of the string interning tables if you care.

Reading back exposes two new properties:

```csharp
using var archive = ZipFile.OpenRead("payroll.zip");
ZipArchiveEntry entry = archive.GetEntry("march.csv")!;

Console.WriteLine(entry.IsEncrypted);      // True
Console.WriteLine(entry.EncryptionMethod); // Aes256

using Stream reader = entry.Open("correct horse battery staple");
```

`ZipEncryptionMethod` has five real values: `None`, `ZipCrypto`, `Aes128`, `Aes192`, `Aes256`, plus `Unknown` for archives written by tools .NET does not recognize. `ZipCrypto` is the original PKWARE cipher and is broken by known-plaintext attacks, so it exists for compatibility with old tooling. Pick `Aes256` unless something on the other end forces your hand.

A wrong password surfaces as `InvalidDataException`, which is the same exception you get for a corrupt entry. There is no distinct "bad password" type, so do not build a retry prompt that assumes the two are distinguishable.

## Whole-directory operations get options types

Preview 7 also adds `ZipFileCreationOptions` and `ZipExtractionOptions`, which is where the bulk APIs pick up passwords:

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

## The empty-file bug you will hit in Preview 7

Round-tripping a directory that contains a zero-byte file (a `.gitkeep`, an empty log) throws on extraction: "The archive entry was compressed using an unsupported compression method". [dotnet/runtime#132213](https://github.com/dotnet/runtime/issues/132213), filed August 12, traced it to the writer disposing the encryption stream before writing the local file header, which forced `Stored` and dropped the AES extra field while the central directory still claimed method 99.

[PR #132217](https://github.com/dotnet/runtime/pull/132217) merged on August 13 with the 11.0-rc1 milestone, so the Preview 7 bits on your machine still have it. Until RC1 lands in September, filter zero-length files or write them through `CreateEntry` yourself.

If you are auditing what else changed in this preview, the [Blazor circuit auto-pause work](/2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7/) is the other feature worth reading twice.
