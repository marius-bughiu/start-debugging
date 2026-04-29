---
title: "Os apps baseados em arquivo do .NET 10 ganharam scripts com múltiplos arquivos: `#:include` está chegando"
description: ".NET 10 adiciona suporte a #:include em apps baseados em arquivo, permitindo que scripts executados com dotnet run abranjam vários arquivos .cs sem criar um projeto completo."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing"
translatedBy: "claude"
translationDate: 2026-04-30
---
A história dos "apps baseados em arquivo" no .NET 10 continua ficando mais prática. Um novo pull request do SDK adiciona suporte a `#:include`, o que significa que `dotnet run foo.cs` não precisa mais ser "um arquivo ou nada".

Isso é rastreado no SDK como "File-based apps: add support for `#:include`" e foi pensado para resolver o caso óbvio de scripting: dividir o código em um script principal mais auxiliares sem criar um projeto completo.

## Por que o múltiplos arquivos importa para `dotnet run file.cs`

A dor é simples. Se o seu script crescer além de um único arquivo, você acaba:

-   Copiando/colando os auxiliares no mesmo arquivo (rapidamente ilegível), ou
-   Desistindo e criando um projeto completo (mata o fluxo de "script rápido").

O comportamento desejado está descrito no issue do SDK: `dotnet run file.cs` deveria poder usar código de um `util.cs` adjacente sem cerimônia extra.

## O que `#:include` muda

Com `#:include`, o arquivo principal pode puxar outros arquivos `.cs` para que o compilador veja uma única unidade de compilação durante a execução. É a ponte que faltava entre a "sensação de script" e a "organização real do código".

Isso não é um recurso da linguagem C#; é um recurso do SDK do .NET para apps baseados em arquivo. Isso importa porque pode evoluir rapidamente nas versões prévias do .NET 10 sem esperar uma versão da linguagem.

## Um script com múltiplos arquivos minúsculo que você pode executar de verdade

Diretório:

```bash
app\
  file.cs
  util.cs
```

`file.cs`:

```cs
#:include "util.cs"

Console.WriteLine(Util.GetMessage());
```

`util.cs`:

```cs
static class Util
{
    public static string GetMessage() => ".NET 10 file-based apps can include files now.";
}
```

Execute com um SDK preview do .NET 10:

```bash
dotnet run app/file.cs
```

## Dois detalhes do mundo real para ficar de olho

### O cache pode esconder mudanças

Apps baseados em arquivo dependem de cache para manter as execuções do loop interno rápidas. Se desconfiar que está vendo saída desatualizada, execute novamente com `--no-cache` para forçar uma recompilação.

### Itens que não são `.cs` podem complicar o "caminho rápido"

Se estiver fazendo apps baseados em arquivo com partes do Web SDK (por exemplo `.razor` ou `.cshtml`), existe um issue aberto sobre invalidação de cache quando itens padrão que não são `.cs` mudam. Lembre-se disso antes de tratar apps baseados em arquivo como substituto de um projeto de aplicação real.

Se quiser acompanhar o lançamento exato, comece por:

-   PR: [https://github.com/dotnet/sdk/pull/52347](https://github.com/dotnet/sdk/pull/52347)
-   Issue do cenário com múltiplos arquivos: [https://github.com/dotnet/sdk/issues/48174](https://github.com/dotnet/sdk/issues/48174)
