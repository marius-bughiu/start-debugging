---
title: "System.IO.Compression liest und schreibt endlich verschlüsselte ZIPs in .NET 11 Preview 7"
description: ".NET 11 Preview 7 ergänzt System.IO.Compression um passwortgeschützte ZIP-Einträge, mit AES-256-Unterstützung, Optionstypen für Operationen über ganze Verzeichnisse und einem Fehler bei leeren Dateien, der in main bereits behoben ist."
pubDate: 2026-08-15
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "security"
lang: "de"
translationOf: "2026/08/dotnet-11-preview-7-password-protected-zip-archives"
translatedBy: "claude"
translationDate: 2026-08-15
---

Zehn Jahre lang lautete die Antwort auf "wie schreibe ich ein passwortgeschütztes ZIP in .NET": "installieren Sie DotNetZip oder SharpZipLib". Die Anfrage, mit der alles begann, [dotnet/runtime#1545](https://github.com/dotnet/runtime/issues/1545), wurde im September 2016 eingereicht. Sie wurde diesen Monat geschlossen: [.NET 11 Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/), veröffentlicht am 2026-08-11, liefert Verschlüsselungsunterstützung in `System.IO.Compression` über [dotnet/runtime#122093](https://github.com/dotnet/runtime/pull/122093).

## Das Passwort hängt am Eintrag, nicht am Archiv

Die Designentscheidung, die man vorab kennen sollte: die Verschlüsselung gilt pro Eintrag, nicht pro Archiv. `ZipArchive` hat keine `Password`-Eigenschaft. Stattdessen hat `CreateEntry` Überladungen bekommen, die ein Passwort plus einen `ZipEncryptionMethod` entgegennehmen, und `ZipArchiveEntry.Open` hat Überladungen bekommen, die ein Passwort entgegennehmen.

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

Ja, das Passwort taucht zweimal auf. `CreateEntry` schreibt die Verschlüsselungsmetadaten ins Archiv; `Open` ist das, was den Cipher-Stream tatsächlich mit dem Schlüssel versorgt. Passwörter sind `ReadOnlySpan<char>` bei den synchronen Überladungen und `ReadOnlyMemory<char>` bei den asynchronen, Sie können sie also aus den String-Interning-Tabellen heraushalten, falls Ihnen das wichtig ist.

Beim Zurücklesen kommen zwei neue Eigenschaften ins Spiel:

```csharp
using var archive = ZipFile.OpenRead("payroll.zip");
ZipArchiveEntry entry = archive.GetEntry("march.csv")!;

Console.WriteLine(entry.IsEncrypted);      // True
Console.WriteLine(entry.EncryptionMethod); // Aes256

using Stream reader = entry.Open("correct horse battery staple");
```

`ZipEncryptionMethod` hat fünf echte Werte: `None`, `ZipCrypto`, `Aes128`, `Aes192`, `Aes256`, dazu `Unknown` für Archive, die von .NET nicht bekannten Werkzeugen geschrieben wurden. `ZipCrypto` ist die ursprüngliche PKWARE-Chiffre und durch Known-Plaintext-Angriffe gebrochen, sie existiert also nur zur Kompatibilität mit alten Werkzeugen. Wählen Sie `Aes256`, sofern nicht die Gegenseite etwas anderes erzwingt.

Ein falsches Passwort äußert sich als `InvalidDataException`, also dieselbe Ausnahme wie bei einem beschädigten Eintrag. Es gibt keinen eigenen Typ für "falsches Passwort", bauen Sie also keine Wiederholungsabfrage, die davon ausgeht, dass sich beide Fälle unterscheiden lassen.

## Operationen über ganze Verzeichnisse bekommen Optionstypen

Preview 7 ergänzt außerdem `ZipFileCreationOptions` und `ZipExtractionOptions`, und dort greifen die Massenoperationen das Passwort ab:

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

## Der Leere-Datei-Fehler, auf den Sie in Preview 7 stoßen werden

Ein Verzeichnis mit einer Null-Byte-Datei (eine `.gitkeep`, ein leeres Log) durch Packen und Entpacken zu schicken, wirft beim Extrahieren: "The archive entry was compressed using an unsupported compression method". [dotnet/runtime#132213](https://github.com/dotnet/runtime/issues/132213), gemeldet am 2026-08-12, führte das darauf zurück, dass der Writer den Verschlüsselungsstream vor dem lokalen Dateikopf freigab, was `Stored` erzwang und das AES-Zusatzfeld verwarf, während das zentrale Verzeichnis weiterhin Methode 99 auswies.

[PR #132217](https://github.com/dotnet/runtime/pull/132217) wurde am 2026-08-13 mit dem Meilenstein 11.0-rc1 gemergt, die Preview-7-Bits auf Ihrem Rechner enthalten den Fehler also noch. Bis RC1 im September erscheint, filtern Sie Dateien der Länge null heraus oder schreiben Sie sie selbst über `CreateEntry`.

Wenn Sie prüfen, was sich in dieser Vorschau sonst noch geändert hat: die [automatische Circuit-Pause in Blazor](/de/2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7/) ist die andere Funktion, die ein zweites Lesen verdient.
