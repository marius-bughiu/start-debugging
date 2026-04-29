---
title: "ModularPipelines V3: escreva pipelines de CI em C#, depure localmente e pare de babá de YAML"
description: "ModularPipelines V3 permite escrever pipelines de CI em C# em vez de YAML. Execute-os localmente com dotnet run, obtenha segurança em tempo de compilação e depure com breakpoints."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/01/modularpipelines-v3-write-ci-pipelines-in-c-debug-locally-stop-babysitting-yaml"
translatedBy: "claude"
translationDate: 2026-04-29
---
Esta semana vi mais um lembrete de que CI não precisa ser um ciclo cego de push-and-pray: o **ModularPipelines V3** está sendo lançado ativamente (a tag mais recente `v3.0.86` foi publicada em 2026-01-18) e se apoia fortemente em uma ideia simples: seu pipeline é apenas uma aplicação .NET.

Fonte: [ModularPipelines repo](https://github.com/thomhurst/ModularPipelines) e o [release v3.0.86](https://github.com/thomhurst/ModularPipelines/releases/tag/v3.0.86).

## A parte que muda seu ciclo de feedback

Se você está entregando serviços em .NET 10, os passos do seu pipeline já têm "formato de código": compilar, testar, publicar, empacotar, escanear, implantar. O problema costuma ser o invólucro: YAML, variáveis tipadas como string e um ciclo de feedback de 5 a 10 minutos só para pegar typos.

ModularPipelines inverte isso:

-   Você pode executar o pipeline localmente com `dotnet run`.
-   As dependências são declaradas em C#, então o motor consegue paralelizar.
-   O pipeline é fortemente tipado, então refactors e erros aparecem como erros de compilação normais.

Aqui está o formato central direto do README do projeto, limpo em um exemplo mínimo colável:

```cs
// Program.cs
await PipelineHostBuilder.Create()
    .AddModule<BuildModule>()
    .AddModule<TestModule>()
    .AddModule<PublishModule>()
    .ExecutePipelineAsync();

public class BuildModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Build(new DotNetBuildOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}

[DependsOn<BuildModule>]
public class TestModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Test(new DotNetTestOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}
```

Isto é entediante no melhor sentido: é C# comum. Breakpoints funcionam. Sua IDE ajuda. "Renomear um módulo" não é uma busca global assustadora.

## Wrappers de ferramentas que acompanham o ecossistema

O release `v3.0.86` é "pequeno" de propósito: atualiza opções de CLI para ferramentas como `pnpm`, `grype` e `vault`. Esse é o tipo de manutenção que você quer que um framework de pipelines absorva por você. Quando uma CLI adiciona ou altera um flag, você quer que um wrapper tipado se mova, não uma dúzia de trechos de YAML apodrecendo.

## Por que gosto do modelo de módulos em repositórios reais

Em bases de código maiores, o custo oculto do YAML não é sintaxe. É gestão de mudanças:

-   Divida a lógica do pipeline por preocupação (build, test, publish, scan) em vez de um único megaarquivo.
-   Mantenha o fluxo de dados explícito. Módulos podem retornar resultados fortemente tipados que módulos seguintes consomem.
-   Deixe os analisadores pegarem erros de dependência cedo. Se você chama outro módulo, esquecer de declarar `[DependsOn]` não deveria ser uma surpresa em runtime.

Se você já vive em .NET 9 ou .NET 10, tratar seu pipeline como uma pequena aplicação C# não é "engenharia excessiva". É um ciclo de feedback mais curto e menos surpresas em produção.

Se quiser se aprofundar, comece pelo "Quick Start" e pela documentação do projeto: [Full Documentation](https://thomhurst.github.io/ModularPipelines).
