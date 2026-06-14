---
title: "O novo analisador EF1004 do EF Core 11 detecta um erro assíncrono silencioso"
description: "O EF Core 11 Preview 5 traz o analisador EF1004. Ele sinaliza ToAsyncEnumerable() em um IQueryable para que você não enumere uma consulta de banco de dados de forma síncrona dentro de um await foreach."
pubDate: 2026-06-14
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/ef-core-11-ef1004-analyzer-toasyncenumerable-vs-asasyncenumerable"
translatedBy: "claude"
translationDate: 2026-06-14
---

O .NET 11 Preview 5, lançado em 2026-06-09, adiciona um novo analisador do EF Core com o identificador de diagnóstico `EF1004`. Ele detecta um erro que ficou muito mais fácil de cometer desde que `System.Linq.AsyncEnumerable` passou a fazer parte da BCL no .NET 10: chamar `ToAsyncEnumerable()` em uma consulta do EF Core e executá-la de forma síncrona sem perceber.

## Como a chamada errada se infiltrou

Agora que `System.Linq.AsyncEnumerable` é distribuído no runtime, seus métodos de extensão estão disponíveis em quase todo lugar. Um deles é `ToAsyncEnumerable()`, que adapta qualquer `IEnumerable<T>` para um `IAsyncEnumerable<T>`. Um `IQueryable<T>` do EF Core também é um `IEnumerable<T>`, então a chamada compila sem erros e parece correta ao lado de um `await foreach`:

```csharp
// Looks async. Is not.
await foreach (var blog in db.Blogs.ToAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

O problema é que `ToAsyncEnumerable()` encapsula uma enumeração síncrona. Ele percorre o `IQueryable` usando o enumerador bloqueante, então a ida e volta ao banco de dados é executada na thread que fez a chamada. O `await foreach` te dá a sintaxe do streaming sem nada do comportamento assíncrono. Sob carga, essa é exatamente a forma que esgota o pool de threads e produz deadlocks que só aparecem em produção.

## O que o EF1004 espera em vez disso

O EF Core expõe seu próprio método `AsAsyncEnumerable()`. Esse sim roteia a consulta pelo pipeline assíncrono do EF Core, de modo que cada linha é materializada conforme sai do `DbDataReader` sem bloquear uma thread:

```csharp
// Runs through EF Core's async query pipeline.
await foreach (var blog in db.Blogs.AsAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

Os dois nomes de método diferem por três caracteres, ambos retornam `IAsyncEnumerable<T>` e ambos compilam. Antes do Preview 5, nada te dizia qual deles você tinha escolhido. O `EF1004` dispara em tempo de compilação no momento em que você chama `ToAsyncEnumerable()` em um `IQueryable<T>`, apontando você para `AsAsyncEnumerable()`.

## Transformando isso em erro

O analisador é distribuído no pacote de analisadores do EF Core e roda durante uma compilação normal, então você recebe o aviso sem configuração extra em um projeto que referencia `Microsoft.EntityFrameworkCore` 11.0.0. Se você quer garantir que ninguém publique a versão síncrona, promova-o no seu arquivo de projeto:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);EF1004</WarningsAsErrors>
</PropertyGroup>
```

Isso combina naturalmente com os padrões de streaming abordados em [Como usar IAsyncEnumerable&lt;T&gt; com EF Core 11](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/): `AsAsyncEnumerable()` é a chamada que faz o `await foreach` realmente transmitir. O EF1004 é apenas a proteção que impede o método parecido de passar despercebido na revisão de código.

Fonte: as [notas de versão do EF Core para o .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/efcore.md) e o [anúncio do .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/).
