---
title: ".NET 11 Preview 5 permite que file-based apps referenciem umas às outras com `#:ref`"
description: ".NET 11 Preview 5 adiciona a diretiva #:ref para que um script dotnet run possa referenciar outra file-based app como biblioteca, com referências transitivas e sem arquivo de projeto."
pubDate: 2026-06-23
tags:
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/06/dotnet-11-preview-5-file-based-apps-ref-directive"
translatedBy: "claude"
translationDate: 2026-06-23
---
As file-based apps começaram como uma forma de executar um único arquivo `.cs` com `dotnet run` e sem projeto. No [.NET 10 elas aprenderam `#:include`](/pt-br/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/), que traz arquivos extras para uma única compilação. O [.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) vai um passo além: a nova diretiva `#:ref` permite que uma file-based app referencie outra file-based app como *biblioteca*, e referências transitivas são suportadas. Nenhum `.csproj` é necessário.

## Como `#:ref` difere de `#:include`

A distinção é real, não cosmética. `#:include` mescla outro arquivo na mesma unidade de compilação, então tudo termina em um único assembly. `#:ref` trata o alvo como uma biblioteca separada e o referencia, da mesma forma que um `ProjectReference` faria, exceto que não há projeto em nenhum dos lados.

Isso significa que `#:ref` te dá um limite de verdade. O arquivo referenciado compila por conta própria, expõe seus tipos públicos, e o consumidor vincula contra ele. Você obtém reúso entre scripts sem copiar e colar funções auxiliares nem montar uma biblioteca de classes.

## Um exemplo de dois arquivos que você pode executar

Coloque uma pequena biblioteca em `lib.cs`:

```csharp
// lib.cs
namespace MyLib;

public static class Greeter
{
    public static string Greet(string name) => $"Hello, {name}!";
}
```

Referencie-a a partir de `app.cs`:

```csharp
// app.cs
#:ref lib.cs

Console.WriteLine(MyLib.Greeter.Greet("World"));
```

Execute com um SDK do .NET 11 Preview 5:

```bash
dotnet run app.cs
```

Se `lib.cs` carregar por sua vez um `#:ref` para um terceiro arquivo, essa referência flui adiante. As referências transitivas são resolvidas, então você pode compor um pequeno grafo de scripts da mesma forma que comporia um pequeno grafo de projetos.

## As diretivas não estão mais bloqueadas

A outra novidade no Preview 5 é que as diretivas de file-based apps `#:include`, `#:exclude` e `#:project` não exigem mais um feature flag, e as diretivas dentro dos arquivos incluídos agora são processadas de forma transitiva. Então `#:include` pode alcançar arquivos aninhados, e `#:project` pode apontar um script para um `.csproj` real quando você superar o esquema apenas de scripts.

Isso te dá um gradiente em vez de um precipício. Comece com um arquivo. Separe as funções auxiliares com `#:include`. Promova uma função auxiliar a uma biblioteca reutilizável com `#:ref`. Traga um projeto completo com `#:project` quando a coisa deixar de ser um script. Cada passo é uma linha de diretiva, e nenhum te obriga a parar de usar `dotnet run`.

## Onde isso se encaixa

`#:ref` é voltado para o mesmo público que o restante do trabalho em file-based apps: scripts de tooling, exemplos, reproduções, e aquele tipo de código de cola que nunca mereceu um arquivo de solução. O novo limite torna esses scripts compartilháveis sem arrastar a cerimônia do MSBuild. É um recurso prévio, então experimente em um SDK do .NET 11 Preview 5 e leia as [notas de versão do SDK](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) para conhecer o comportamento exato antes de depender dele.
