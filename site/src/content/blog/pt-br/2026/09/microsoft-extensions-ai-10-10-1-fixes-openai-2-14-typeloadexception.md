---
title: "Microsoft.Extensions.AI.OpenAI 10.10.1 corrige a TypeLoadException do OpenAI 2.14"
description: "O OpenAI 2.14.0 renomeou GlobalMcpToolCallApprovalPolicy, o que quebrou toda chamada à Responses API com ferramentas através do Microsoft.Extensions.AI.OpenAI 10.10.0. A versão 10.10.1 passa para o OpenAI 2.14.0 e também traz a correção do status de raciocínio null para endpoints compatíveis com OpenAI."
pubDate: 2026-09-26
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "openai"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception"
translatedBy: "claude"
translationDate: 2026-09-26
---

O `Microsoft.Extensions.AI.OpenAI` 10.10.1 chegou ao NuGet em 25 de setembro de 2026, e as [notas de versão](https://github.com/dotnet/extensions/releases/tag/v10.10.1) têm uma linha: "Upgrade OpenAI SDK to 2.14.0". Essa linha esconde um crash em tempo de execução. Se sua aplicação referencia o `Microsoft.Extensions.AI.OpenAI` 10.10.0 e algo no grafo puxou o `OpenAI` para 2.14.0 (um bump do Dependabot, uma referência direta, outro pacote), toda chamada à Responses API que carrega uma ferramenta vem morrendo com uma `TypeLoadException` desde 15 de setembro.

## Um tipo experimental renomeado, resolvido em tempo de JIT

O `OpenAI` 2.14.0 saiu em 15 de setembro. Entre as mudanças, o struct experimental `OpenAI.Responses.GlobalMcpToolCallApprovalPolicy` virou `DefaultMcpToolCallApprovalPolicy`, e a propriedade `GlobalPolicy` de `McpToolCallApprovalPolicy` virou `DefaultPolicy`. APIs experimentais (`OPENAI001`) podem quebrar, mas o `Microsoft.Extensions.AI.OpenAI` 10.10.0 foi compilado contra o nome antigo dentro de `OpenAIResponsesChatClient.ToResponseTool`, o método que converte cada `AITool` em uma ferramenta da Responses.

O nuspec da 10.10.0 declara o `OpenAI` com mínimo `2.13.0`, então o NuGet resolve 2.14.0 sem reclamar quando outra coisa pede. Nada falha no build. A primeira chamada com um `ChatOptions` contendo ferramentas falha quando o JIT compila `ToResponseTool`:

```text
System.TypeLoadException: Could not load type 'OpenAI.Responses.GlobalMcpToolCallApprovalPolicy'
from assembly 'OpenAI, Version=2.14.0.0, Culture=neutral, PublicKeyToken=b4187f3e65366280'.
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.ToResponseTool(AITool tool, ChatOptions options, ToolSearchLookup toolSearchLookup)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.AsCreateResponseOptions(...)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.GetStreamingResponseAsync(...)
```

Não importa se você usa MCP. O método referencia o tipo, então uma simples `AIFunction` também dispara o erro. A [issue #7760](https://github.com/dotnet/extensions/issues/7760) relatou o problema com `Microsoft.Agents.AI.OpenAI` 1.21.0 no .NET 10.

## Por que ficar no OpenAI 2.13.0 não era uma saída limpa

Fixar o `OpenAI` de volta em 2.13.0 evita o crash, mas a 2.13.0 tem seu próprio bug: a desserialização de `ReasoningResponseItem` chama `ToReasoningStatus()` sobre um `null` do JSON. Backends de terceiros compatíveis com OpenAI que serializam um item de raciocínio como `"status": null` em vez de omiti-lo derrubam o stream SSE inteiro com `ArgumentOutOfRangeException: Unknown ReasoningStatus value`. O OpenAI 2.14.0 adicionou a verificação de null. Então, por uma semana, você precisava escolher qual bug preferia.

O [PR #7761](https://github.com/dotnet/extensions/pull/7761) resolve os dois: sobe para o `OpenAI` 2.14.0, mapeia `HostedMcpServerToolAlwaysRequireApprovalMode` e `HostedMcpServerToolNeverRequireApprovalMode` para `DefaultMcpToolCallApprovalPolicy` e adiciona um teste de regressão de streaming para o caso de `status` null.

## A atualização

Mova os dois pacotes juntos. O `Microsoft.Extensions.AI.OpenAI` 10.10.1 agora exige o `OpenAI` 2.14.0, então se você fixou a 2.13.0 como workaround, remova esse pin ou vai receber um erro de downgrade `NU1605`:

```xml
<ItemGroup>
  <PackageReference Include="Microsoft.Extensions.AI.OpenAI" Version="10.10.1" />
  <PackageReference Include="OpenAI" Version="2.14.0" />
</ItemGroup>
```

Depois confira o que foi realmente resolvido, já que frameworks de agentes e wrappers de SDK costumam trazer esses pacotes de forma transitiva:

```bash
dotnet list package --include-transitive | grep -E "OpenAI|Extensions.AI"
```

Se você usa os tipos de aprovação de MCP diretamente no seu código, a renomeação também vale para você:

```csharp
#pragma warning disable OPENAI001
var policy = new McpToolCallApprovalPolicy(DefaultMcpToolCallApprovalPolicy.NeverRequireApproval);
var mode = policy.DefaultPolicy; // was policy.GlobalPolicy in OpenAI 2.13.0
#pragma warning restore OPENAI001
```

A lição mais ampla: uma dependência de versão mínima de uma biblioteca sobre um pacote com APIs experimentais é, na prática, uma faixa aberta para breaking changes. Se você roda em produção um agente baseado na Responses, um smoke test que envie uma requisição com ferramenta após cada bump de dependência teria pegado isso no CI em vez de em tempo de execução. Para o resto do que mudou nesta linha de versões, veja o artigo anterior sobre [Microsoft.Extensions.AI 10.10 reprovando métricas de avaliação sem nota](/pt-br/2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics/).
