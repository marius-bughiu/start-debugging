---
title: "System.IO.Compression por fin lee y escribe ZIP cifrados en .NET 11 Preview 7"
description: ".NET 11 Preview 7 agrega entradas ZIP protegidas con contraseña a System.IO.Compression, con soporte de AES-256, tipos de opciones para operaciones sobre directorios completos y un error con archivos vacíos que ya está corregido en main."
pubDate: 2026-08-15
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "security"
lang: "es"
translationOf: "2026/08/dotnet-11-preview-7-password-protected-zip-archives"
translatedBy: "claude"
translationDate: 2026-08-15
---

Durante diez años, la respuesta a "cómo escribo un ZIP protegido con contraseña en .NET" fue "instala DotNetZip o SharpZipLib". La solicitud que lo empezó todo, [dotnet/runtime#1545](https://github.com/dotnet/runtime/issues/1545), se abrió en septiembre de 2016. Se cerró este mes: [.NET 11 Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/), publicado el 2026-08-11, incluye soporte de cifrado en `System.IO.Compression` a través de [dotnet/runtime#122093](https://github.com/dotnet/runtime/pull/122093).

## La contraseña viaja con la entrada, no con el archivo comprimido

La decisión de diseño que conviene conocer desde el principio: el cifrado es por entrada, no por archivo comprimido. `ZipArchive` no tiene una propiedad `Password`. En su lugar, `CreateEntry` ganó sobrecargas que reciben una contraseña más un `ZipEncryptionMethod`, y `ZipArchiveEntry.Open` ganó sobrecargas que reciben una contraseña.

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

Sí, la contraseña aparece dos veces. `CreateEntry` registra los metadatos de cifrado en el archivo comprimido; `Open` es lo que realmente inicializa la clave del stream de cifrado. Las contraseñas son `ReadOnlySpan<char>` en las sobrecargas sincrónicas y `ReadOnlyMemory<char>` en las asíncronas, así que puedes mantenerlas fuera de las tablas de interning de cadenas si eso te importa.

Leer de vuelta expone dos propiedades nuevas:

```csharp
using var archive = ZipFile.OpenRead("payroll.zip");
ZipArchiveEntry entry = archive.GetEntry("march.csv")!;

Console.WriteLine(entry.IsEncrypted);      // True
Console.WriteLine(entry.EncryptionMethod); // Aes256

using Stream reader = entry.Open("correct horse battery staple");
```

`ZipEncryptionMethod` tiene cinco valores reales: `None`, `ZipCrypto`, `Aes128`, `Aes192`, `Aes256`, más `Unknown` para archivos comprimidos escritos por herramientas que .NET no reconoce. `ZipCrypto` es el cifrado original de PKWARE y está roto por ataques de texto plano conocido, así que existe por compatibilidad con herramientas antiguas. Elige `Aes256` a menos que algo del otro lado te obligue a otra cosa.

Una contraseña incorrecta se manifiesta como `InvalidDataException`, que es la misma excepción que obtienes por una entrada corrupta. No hay un tipo distinto para "contraseña incorrecta", así que no construyas un flujo de reintento que asuma que ambos casos se pueden distinguir.

## Las operaciones sobre directorios completos reciben tipos de opciones

Preview 7 también agrega `ZipFileCreationOptions` y `ZipExtractionOptions`, que es donde las APIs masivas recogen las contraseñas:

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

## El error con archivos vacíos que vas a encontrar en Preview 7

Hacer un ida y vuelta de un directorio que contiene un archivo de cero bytes (un `.gitkeep`, un log vacío) lanza una excepción al extraer: "The archive entry was compressed using an unsupported compression method". [dotnet/runtime#132213](https://github.com/dotnet/runtime/issues/132213), reportado el 2026-08-12, lo rastreó hasta que el escritor liberaba el stream de cifrado antes de escribir el encabezado local del archivo, lo que forzaba `Stored` y descartaba el campo extra de AES mientras el directorio central seguía declarando el método 99.

El [PR #132217](https://github.com/dotnet/runtime/pull/132217) se integró el 2026-08-13 con el hito 11.0-rc1, así que los binarios de Preview 7 en tu máquina todavía lo tienen. Hasta que llegue RC1 en septiembre, filtra los archivos de longitud cero o escríbelos tú mismo con `CreateEntry`.

Si estás revisando qué más cambió en esta versión preliminar, el [trabajo de pausa automática de circuitos en Blazor](/es/2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7/) es la otra característica que vale la pena leer dos veces.
