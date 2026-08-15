---
title: "System.IO.Compression finalmente lê e escreve ZIPs criptografados no .NET 11 Preview 7"
description: "O .NET 11 Preview 7 adiciona entradas ZIP protegidas por senha ao System.IO.Compression, com suporte a AES-256, tipos de opções para operações em diretórios inteiros e um bug com arquivos vazios que já foi corrigido na main."
pubDate: 2026-08-15
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "security"
lang: "pt-br"
translationOf: "2026/08/dotnet-11-preview-7-password-protected-zip-archives"
translatedBy: "claude"
translationDate: 2026-08-15
---

Por dez anos, a resposta para "como eu escrevo um ZIP protegido por senha no .NET" foi "instale o DotNetZip ou o SharpZipLib". O pedido que começou tudo, [dotnet/runtime#1545](https://github.com/dotnet/runtime/issues/1545), foi aberto em setembro de 2016. Ele foi fechado neste mês: o [.NET 11 Preview 7](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/), lançado em 2026-08-11, traz suporte a criptografia no `System.IO.Compression` via [dotnet/runtime#122093](https://github.com/dotnet/runtime/pull/122093).

## A senha pertence à entrada, não ao arquivo compactado

A decisão de design que vale conhecer logo de cara: a criptografia é por entrada, não por arquivo compactado. `ZipArchive` não tem uma propriedade `Password`. Em vez disso, `CreateEntry` ganhou sobrecargas que recebem uma senha mais um `ZipEncryptionMethod`, e `ZipArchiveEntry.Open` ganhou sobrecargas que recebem uma senha.

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

Sim, a senha aparece duas vezes. `CreateEntry` registra os metadados de criptografia no arquivo compactado; `Open` é o que de fato define a chave do stream de cifra. As senhas são `ReadOnlySpan<char>` nas sobrecargas síncronas e `ReadOnlyMemory<char>` nas assíncronas, então você pode mantê-las fora das tabelas de interning de strings se isso importa para você.

A leitura de volta expõe duas propriedades novas:

```csharp
using var archive = ZipFile.OpenRead("payroll.zip");
ZipArchiveEntry entry = archive.GetEntry("march.csv")!;

Console.WriteLine(entry.IsEncrypted);      // True
Console.WriteLine(entry.EncryptionMethod); // Aes256

using Stream reader = entry.Open("correct horse battery staple");
```

`ZipEncryptionMethod` tem cinco valores reais: `None`, `ZipCrypto`, `Aes128`, `Aes192`, `Aes256`, mais `Unknown` para arquivos compactados escritos por ferramentas que o .NET não reconhece. `ZipCrypto` é a cifra original da PKWARE e está quebrada por ataques de texto claro conhecido, então ela existe por compatibilidade com ferramentas antigas. Escolha `Aes256` a menos que algo do outro lado force sua mão.

Uma senha errada aparece como `InvalidDataException`, que é a mesma exceção lançada para uma entrada corrompida. Não existe um tipo específico de "senha inválida", então não construa um fluxo de nova tentativa que assuma que os dois casos são distinguíveis.

## Operações em diretórios inteiros ganham tipos de opções

O Preview 7 também adiciona `ZipFileCreationOptions` e `ZipExtractionOptions`, que é onde as APIs em lote recebem as senhas:

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

## O bug de arquivo vazio que você vai encontrar no Preview 7

Fazer o ciclo completo com um diretório que contém um arquivo de zero byte (um `.gitkeep`, um log vazio) lança uma exceção na extração: "The archive entry was compressed using an unsupported compression method". A [dotnet/runtime#132213](https://github.com/dotnet/runtime/issues/132213), aberta em 2026-08-12, rastreou o problema até o escritor descartar o stream de criptografia antes de gravar o cabeçalho local do arquivo, o que forçava `Stored` e removia o campo extra de AES enquanto o diretório central ainda declarava o método 99.

O [PR #132217](https://github.com/dotnet/runtime/pull/132217) foi integrado em 2026-08-13 com o marco 11.0-rc1, então os binários do Preview 7 na sua máquina ainda têm o problema. Até o RC1 chegar em setembro, filtre os arquivos de comprimento zero ou grave-os você mesmo com `CreateEntry`.

Se você está auditando o que mais mudou nesta versão prévia, o [trabalho de pausa automática de circuitos no Blazor](/pt-br/2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7/) é o outro recurso que vale ler duas vezes.
