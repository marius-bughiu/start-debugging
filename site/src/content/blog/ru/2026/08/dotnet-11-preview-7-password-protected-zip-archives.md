---
title: "System.IO.Compression наконец читает и пишет зашифрованные ZIP в .NET 11 Preview 7"
description: ".NET 11 Preview 7 добавляет в System.IO.Compression записи ZIP, защищённые паролем, с поддержкой AES-256, типами опций для операций над целыми каталогами и одной ошибкой с пустыми файлами, которая уже исправлена в main."
pubDate: 2026-08-15
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "security"
lang: "ru"
translationOf: "2026/08/dotnet-11-preview-7-password-protected-zip-archives"
translatedBy: "claude"
translationDate: 2026-08-15
---

Десять лет ответом на вопрос "как записать защищённый паролем ZIP в .NET" было "установите DotNetZip или SharpZipLib". Запрос, с которого всё началось, [dotnet/runtime#1545](https://github.com/dotnet/runtime/issues/1545), был создан в сентябре 2016 года. Он закрыт в этом месяце: [.NET 11 Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/), выпущенный 2026-08-11, приносит поддержку шифрования в `System.IO.Compression` через [dotnet/runtime#122093](https://github.com/dotnet/runtime/pull/122093).

## Пароль привязан к записи, а не к архиву

Проектное решение, о котором стоит знать заранее: шифрование задаётся для каждой записи, а не для архива целиком. У `ZipArchive` нет свойства `Password`. Вместо этого у `CreateEntry` появились перегрузки, принимающие пароль и `ZipEncryptionMethod`, а у `ZipArchiveEntry.Open` появились перегрузки, принимающие пароль.

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

Да, пароль указывается дважды. `CreateEntry` записывает метаданные шифрования в архив, а `Open` уже задаёт ключ потока шифрования. Пароли имеют тип `ReadOnlySpan<char>` в синхронных перегрузках и `ReadOnlyMemory<char>` в асинхронных, поэтому их можно не помещать в таблицы интернирования строк, если это для вас важно.

При обратном чтении доступны два новых свойства:

```csharp
using var archive = ZipFile.OpenRead("payroll.zip");
ZipArchiveEntry entry = archive.GetEntry("march.csv")!;

Console.WriteLine(entry.IsEncrypted);      // True
Console.WriteLine(entry.EncryptionMethod); // Aes256

using Stream reader = entry.Open("correct horse battery staple");
```

У `ZipEncryptionMethod` пять реальных значений: `None`, `ZipCrypto`, `Aes128`, `Aes192`, `Aes256`, плюс `Unknown` для архивов, записанных инструментами, которые .NET не распознаёт. `ZipCrypto` представляет собой исходный шифр PKWARE и взломан атаками на основе известного открытого текста, поэтому он существует только ради совместимости со старыми инструментами. Выбирайте `Aes256`, если противоположная сторона не вынуждает вас к другому варианту.

Неверный пароль проявляется как `InvalidDataException`, то есть то же исключение, что и при повреждённой записи. Отдельного типа для случая "неверный пароль" нет, поэтому не стройте логику повторного ввода в расчёте на то, что эти два случая различимы.

## Операции над целыми каталогами получают типы опций

Preview 7 также добавляет `ZipFileCreationOptions` и `ZipExtractionOptions`, и именно там массовые API получают пароли:

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

## Ошибка с пустыми файлами, на которую вы наткнётесь в Preview 7

Полный цикл упаковки и распаковки каталога, содержащего файл нулевой длины (`.gitkeep`, пустой журнал), падает при извлечении: "The archive entry was compressed using an unsupported compression method". В [dotnet/runtime#132213](https://github.com/dotnet/runtime/issues/132213), заведённом 2026-08-12, причину нашли в том, что писатель освобождал поток шифрования до записи локального заголовка файла, из-за чего принудительно выбирался `Stored` и терялось дополнительное поле AES, тогда как центральный каталог по-прежнему объявлял метод 99.

[PR #132217](https://github.com/dotnet/runtime/pull/132217) влит 2026-08-13 с вехой 11.0-rc1, так что в сборках Preview 7 на вашей машине ошибка ещё присутствует. Пока RC1 не выйдет в сентябре, отфильтровывайте файлы нулевой длины или записывайте их вручную через `CreateEntry`.

Если вы разбираете, что ещё изменилось в этой предварительной версии, [автоматическая приостановка circuit в Blazor](/ru/2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7/) представляет собой вторую возможность, которую стоит прочитать дважды.
