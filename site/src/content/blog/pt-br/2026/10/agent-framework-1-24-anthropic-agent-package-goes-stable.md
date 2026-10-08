---
title: "Agent Framework 1.24: o pacote Anthropic Agent é estável, exceto pelos serviços Beta"
description: "O Microsoft.Agents.AI.Anthropic 1.24.0 remove o sufixo preview e depende do Anthropic 12.53.0. Agentes criados a partir de IAnthropicClient agora são API estável, enquanto as extensões de client.Beta são marcadas como experimentais sob MAAIANTHROPIC001, que chamadas de método de extensão não disparam."
pubDate: 2026-10-08
tags:
  - "agent-framework"
  - "dotnet"
  - "anthropic"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/10/agent-framework-1-24-anthropic-agent-package-goes-stable"
translatedBy: "claude"
translationDate: 2026-10-08
---

O Microsoft Agent Framework [dotnet-1.24.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.24.0) foi lançado em 7 de outubro de 2026, e uma linha do changelog importa mais que o resto se você executa agentes baseados em Claude no .NET: o [PR #9111](https://github.com/microsoft/agent-framework/pull/9111), "Stabilize Anthropic agent package". Até a semana passada, o `Microsoft.Agents.AI.Anthropic` só existia como builds preview (o último foi o `1.23.0-preview.260928.1`). No NuGet agora ele é simplesmente `1.24.0`, publicado junto com o restante do framework.

## O que o estável realmente cobre

O pacote tem duas classes de extensão, e elas não receberam o mesmo tratamento.

`AnthropicClientExtensions`, que pendura `AsAIAgent` em `IAnthropicClient`, agora é API pública entregue. O PR adiciona baselines `PublicAPI.Shipped.txt` para todos os target frameworks do pacote (`net10.0`, `net9.0`, `net8.0`, `netstandard2.0`, `net472`), então a validação de pacote vai sinalizar breaking changes daqui em diante. A dependência também subiu de `Anthropic` 12.45.0 para 12.53.0, o SDK C# oficial da Anthropic, que por sua vez já é GA.

`AnthropicBetaServiceExtensions`, os overloads de `AsAIAgent` em `IBetaService` (o que você obtém de `client.Beta`), é a exceção. A classe inteira agora está marcada com `[Experimental("MAAIANTHROPIC001")]`, com uma nota na documentação dizendo que ela "may change in non-major releases as the underlying beta services evolve". O raciocínio na [issue #9110](https://github.com/microsoft/agent-framework/issues/9110) é direto: o SDK da Anthropic é GA, mas sua superfície beta não é, e o Agent Framework não quer prometer um contrato de compatibilidade que o upstream não oferece.

## O que muda no seu código

Se você cria agentes a partir do client normal, nada muda além da versão do pacote:

```xml
<PackageReference Include="Microsoft.Agents.AI.Anthropic" Version="1.24.0" />
```

```csharp
using Anthropic;
using Microsoft.Agents.AI;

AnthropicClient client = new() { ApiKey = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") };

ChatClientAgent agent = client.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You review C# pull requests and answer in short bullet points.",
    name: "reviewer");

Console.WriteLine(await agent.RunAsync("Is `async void` ever fine in an ASP.NET Core handler?"));
```

O caminho beta é onde fica sutil. Eu verifiquei a compilação com o SDK 10.0.302 contra o pacote 1.24.0. Primeiro, os overloads ficam no namespace `Anthropic.Services`, então `client.Beta.AsAIAgent(...)` não resolve até você adicionar esse `using`. Segundo, o atributo está na classe, não nos métodos, e o C# só reporta um `[Experimental]` em nível de classe quando o nome do tipo aparece no seu código. A sintaxe de método de extensão nunca nomeia o tipo, então isto compila sem nenhum diagnóstico:

```csharp
using Anthropic.Services;

ChatClientAgent agent = client.Beta.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You create PowerPoint presentations.",
    tools: [pptxSkill.AsAITool()]);
```

Se você nomear a classe diretamente, como em uma chamada estática ou ao ajustar o orçamento de tokens padrão compartilhado, recebe um erro, porque diagnósticos de `[Experimental]` são erros por padrão:

```csharp
AnthropicBetaServiceExtensions.DefaultMaxTokens = 8000;
```

```text
error MAAIANTHROPIC001: 'Anthropic.Services.AnthropicBetaServiceExtensions' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
```

O sample de skills do próprio framework suprime o diagnóstico no topo do arquivo com `#pragma warning disable MAAIANTHROPIC001`. Se os recursos beta fazem parte do seu design e não são um experimento, suprima uma única vez para o projeto:

```xml
<PropertyGroup>
  <NoWarn>$(NoWarn);MAAIANTHROPIC001</NoWarn>
</PropertyGroup>
```

## Por que a divisão é a decisão certa

Fixar um pacote preview em produção é um motivo comum para manter agentes Claude fora do Agent Framework e conectar o `IChatClient` à mão (os trade-offs estão na minha [comparação entre Anthropic SDK e Microsoft.Extensions.AI](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/)). Essa desculpa acabou para o caminho estável. Só não trate o diagnóstico como uma auditoria. Como o formato de chamada da extensão passa batido por ele, um build limpo não significa que você está fora da superfície beta: faça um grep por `client.Beta` e `IBetaService` para encontrar os pontos de chamada que podem quebrar em uma atualização minor do Agent Framework ou do SDK da Anthropic.

O restante do 1.24.0 é reforço: validação de capacidades do `LocalCodeAct`, rejeição de identificadores sensíveis em agentes declarativos e vinculação de headers de aprovação do MCP à invocação aprovada. Se você pulou o 1.23, comece pela sua [mudança no function middleware](/pt-br/2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool/) antes de atualizar.
