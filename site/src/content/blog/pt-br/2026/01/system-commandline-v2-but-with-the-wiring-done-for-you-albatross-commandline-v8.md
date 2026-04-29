---
title: "System.CommandLine v2, mas com a fiação já pronta: `Albatross.CommandLine` v8"
description: "Albatross.CommandLine v8 se apoia em System.CommandLine v2 com um gerador de código-fonte, integração de DI e uma camada de hosting para eliminar o código repetitivo de CLI em aplicações .NET 9 e .NET 10."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2026/01/system-commandline-v2-but-with-the-wiring-done-for-you-albatross-commandline-v8"
translatedBy: "claude"
translationDate: 2026-04-30
---
O System.CommandLine v2 chegou com um foco muito mais limpo: parsing primeiro, uma pipeline de execução simplificada, menos comportamentos "mágicos". Isso é ótimo, mas a maioria das CLIs reais ainda acaba com encanamento repetitivo: configuração de DI, ligação de handlers, opções compartilhadas, cancelamento e hosting.

`Albatross.CommandLine` v8 é uma nova abordagem para exatamente essa lacuna. Ele se apoia em System.CommandLine v2 e adiciona um gerador de código-fonte e uma camada de hosting, para que você possa definir comandos de forma declarativa e manter o código de cola fora do seu caminho.

## A proposta de valor: menos peças móveis, mais estrutura

A proposta do autor é específica:

-   Código repetitivo mínimo: defina comandos com atributos, gere a fiação
-   Composição com DI em primeiro lugar: serviços por comando, injete qualquer coisa
-   Tratamento de async e de shutdown: CancellationToken e Ctrl+C de fábrica
-   Ainda customizável: você pode descer até os objetos do System.CommandLine quando precisar

Essa combinação é o ponto ideal para aplicações de CLI em .NET 9 e .NET 10 que querem infraestrutura "chata" sem assumir uma dependência completa de framework.

## Um host mínimo que continua legível

Esta é a forma (simplificada a partir do anúncio):

```cs
// Program.cs (.NET 9 or .NET 10)
using Albatross.CommandLine;
using Microsoft.Extensions.DependencyInjection;
using System.CommandLine.Parsing;

await using var host = new CommandHost("Sample CLI")
    .RegisterServices(RegisterServices)
    .AddCommands() // generated
    .Parse(args)
    .Build();

return await host.InvokeAsync();

static void RegisterServices(ParseResult result, IServiceCollection services)
{
    services.RegisterCommands(); // generated registrations

    // Your app services
    services.AddSingleton<ITimeProvider, SystemTimeProvider>();
}

public interface ITimeProvider { DateTimeOffset Now { get; } }
public sealed class SystemTimeProvider : ITimeProvider { public DateTimeOffset Now => DateTimeOffset.UtcNow; }
```

A parte importante não é "olha, um host". É que o host se torna um ponto de entrada previsível onde você pode testar a camada de handlers e manter as definições de comandos separadas da fiação de serviços.

## Onde ele se encaixa, e onde não

É uma boa combinação se:

-   Você tem mais de 3 a 5 comandos e as opções compartilhadas estão começando a se espalhar
-   Você quer DI na sua CLI, mas não quer ligar handlers à mão para cada comando
-   Você se importa com shutdown gracioso porque sua CLI faz trabalho real (rede, sistema de arquivos, E/S longa)

Provavelmente não vale a pena se:

-   Você está entregando um utilitário de comando único
-   Você precisa de comportamento de parsing exótico e espera viver nos internos do System.CommandLine

Se quiser avaliar rápido, estes são os melhores pontos de partida:

-   Docs: [https://rushuiguan.github.io/commandline/](https://rushuiguan.github.io/commandline/)
-   Fonte: [https://github.com/rushuiguan/commandline](https://github.com/rushuiguan/commandline)
-   Anúncio no Reddit: [https://www.reddit.com/r/dotnet/comments/1q800bs/updated\_albatrosscommandline\_library\_for/](https://www.reddit.com/r/dotnet/comments/1q800bs/updated_albatrosscommandline_library_for/)
