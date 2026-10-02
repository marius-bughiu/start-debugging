---
title: "Agent Framework 1.23: o middleware de funções finalmente pode trocar a ferramenta que está chamando"
description: "O Microsoft Agent Framework .NET 1.23.0 respeita atribuições a FunctionInvocationContext.Function, então um middleware pode redirecionar uma chamada de ferramenta para outra AIFunction. O novo helper WrapWithPendingMiddleware mantém o resto da cadeia participando."
pubDate: 2026-10-02
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "pt-br"
translationOf: "2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool"
translatedBy: "claude"
translationDate: 2026-10-02
---

O Microsoft Agent Framework [dotnet-1.23.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.23.0) saiu em 1º de outubro de 2026 com uma longa lista de correções e cinco mudanças marcadas como BREAKING. A que eu quero destacar não está marcada, porque os mantenedores a tratam como correção de bug: o [PR #8615](https://github.com/microsoft/agent-framework/pull/8615) faz o middleware de funções realmente conseguir substituir a função que está prestes a chamar.

## O setter que não fazia nada

O middleware de chamada de funções registrado com `AIAgentBuilder.Use(...)` recebe um `FunctionInvocationContext`. A propriedade `Function` dele tem um setter público, e nada impedia você de atribuir outra `AIFunction` antes de chamar `next`. Até a 1.22, essa atribuição era ignorada silenciosamente. Mudanças em `context.Arguments` eram respeitadas, mas a continuação sempre invocava a função que o wrapper tinha capturado quando a lista de ferramentas foi montada.

Isso bloqueava toda uma classe de padrões: rotear uma chamada arriscada para uma implementação protegida, trocar a implementação por tenant em tempo de execução ou colocar um stub em um teste de integração sem reconstruir o agente. O contorno comum era pular `next` e invocar a outra função você mesmo, o que ignorava todo middleware registrado depois do seu.

## Redirecionando uma chamada na 1.23

O `FunctionInvocationDelegatingAgent` agora captura o alvo antes do seu callback rodar e despacha com base no que `context.Function` contém depois. Se você não mexeu nele, o comportamento é idêntico ao da 1.22. Se você o substituiu, a substituta é executada:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIFunction sandboxedDelete = AIFunctionFactory.Create(
    (string customerId) => $"Queued deletion of {customerId} for human review.",
    "delete_customer",
    "Deletes a customer record.");

async ValueTask<object?> RouteDestructiveCalls(
    AIAgent agent,
    FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    if (context.Function.Name == "delete_customer")
    {
#pragma warning disable MAAI001
        context.Function = context.WrapWithPendingMiddleware(sandboxedDelete);
#pragma warning restore MAAI001
    }

    return await next(context, cancellationToken);
}

AIAgent agent = baseAgent
    .AsBuilder()
        .Use(RouteDestructiveCalls)
        .Use(AuditMiddleware)
    .Build();
```

O modelo pediu `delete_customer`, os argumentos passam intactos e a versão em sandbox produz o resultado da ferramenta.

## Por que WrapWithPendingMiddleware existe

Uma substituta é invocada diretamente. Sem o helper, o `AuditMiddleware` do exemplo acima nunca veria a chamada redirecionada. O novo `FunctionInvocationContextExtensions.WrapWithPendingMiddleware(context, function)` envolve a sua substituta com os callbacks que ainda não rodaram para esta invocação, então o resto da cadeia continua enxergando a chamada.

Três regras tiradas do código-fonte:

- Chame de dentro de um callback em execução, antes de chamar `next`. Depois que a continuação rodou, não sobra nada pendente e o helper lança `InvalidOperationException`.
- Se não houver callbacks pendentes, ele devolve a sua função sem alteração.
- Ele está marcado como `[Experimental]` com o diagnóstico `MAAI001`, daí o pragma.

Uma coisa que a substituição não muda: a aprovação de ferramentas e a telemetria continuam refletindo a função que o modelo pediu originalmente, porque a chamada é resolvida antes de qualquer callback rodar. Se `delete_customer` exige aprovação, o usuário continua aprovando `delete_customer`, mesmo que o seu middleware depois execute outra coisa. É o padrão certo para auditoria, mas não conte com uma troca para escapar de uma aprovação.

## O resto da 1.23, em resumo

Se você vai atualizar, procure também estas entradas BREAKING: validação de nomes de ferramentas e tratamento de chamadas pendentes quando a lista de ferramentas muda entre execuções ([#8754](https://github.com/microsoft/agent-framework/pull/8754)), vinculação mais rígida das respostas de aprovação ([#8641](https://github.com/microsoft/agent-framework/pull/8641)) e uma allow list para chaves de configuração e de ambiente em workflows declarativos, com o fallback para variáveis de ambiente do processo desligado a menos que você defina `AllowProcessEnvironmentVariableFallback = true` ([#8200](https://github.com/microsoft/agent-framework/pull/8200)). A versão também atualiza `Microsoft.Extensions.AI` para 10.10.1 e OpenAI para 2.14.0.

Vindo da 1.21 ou anterior? Comece por [o que a 1.22 mudou com AsIChatClient e as ferramentas por execução](/pt-br/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) e depois vá para `Microsoft.Agents.AI` 1.23.0.
