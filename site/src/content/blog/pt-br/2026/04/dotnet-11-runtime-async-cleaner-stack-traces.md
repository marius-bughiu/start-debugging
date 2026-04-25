---
title: "Runtime Async do .NET 11 substitui state machines com stack traces mais limpos"
description: "Runtime Async no .NET 11 move o tratamento de async/await das state machines geradas pelo compilador para o próprio runtime, produzindo stack traces legíveis, breakpoints corretos, e menos alocações no heap."
pubDate: 2026-04-06
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
  - "debugging"
lang: "pt-br"
translationOf: "2026/04/dotnet-11-runtime-async-cleaner-stack-traces"
translatedBy: "claude"
translationDate: 2026-04-25
---

Se você já encarou um stack trace assíncrono no .NET tentando descobrir qual método realmente lançou, você conhece a dor. A infraestrutura de state machine gerada pelo compilador transforma uma simples cadeia de chamadas de três métodos em uma parede de `AsyncMethodBuilderCore`, `MoveNext`, e nomes genéricos destruídos. O .NET 11 Preview 2 entrega um recurso preview chamado Runtime Async que conserta isso no nível mais profundo possível: o próprio CLR agora gerencia a suspensão e retomada assíncrona em vez do compilador C#.

## Como funcionava antes: state machines em todo lugar

No .NET 10 e anterior, marcar um método como `async` diz ao compilador C# para reescrevê-lo em um struct ou classe que implementa `IAsyncStateMachine`. Toda variável local se torna um campo nesse tipo gerado, e todo `await` é uma transição de estado dentro de `MoveNext()`. O resultado é correto, mas tem custos:

```csharp
async Task<string> FetchDataAsync(HttpClient client, string url)
{
    var response = await client.GetAsync(url);
    response.EnsureSuccessStatusCode();
    return await response.Content.ReadAsStringAsync();
}
```

Quando uma exceção ocorre dentro de `FetchDataAsync`, o stack trace inclui frames para `AsyncMethodBuilderCore.Start`, o `<FetchDataAsync>d__0.MoveNext()` gerado, e o encanamento genérico de `TaskAwaiter`. Para uma cadeia de três chamadas async, você facilmente vê mais de 15 frames onde apenas três carregam informação significativa.

## O que o Runtime Async muda

Com Runtime Async habilitado, o compilador não emite mais uma state machine completa. Em vez disso, ele marca o método com metadados que dizem ao CLR para tratar a suspensão nativamente. O runtime mantém as variáveis locais na pilha e só as derrama para o heap quando a execução realmente cruza um limite de `await` que não pode completar de forma síncrona. O resultado prático: menos alocações e stack traces dramaticamente mais curtos.

Uma cadeia async de três métodos como `OuterAsync -> MiddleAsync -> InnerAsync` produz um stack trace que mapeia diretamente para sua fonte:

```
at Program.InnerAsync() in Program.cs:line 24
at Program.MiddleAsync() in Program.cs:line 14
at Program.OuterAsync() in Program.cs:line 8
```

Sem `MoveNext` sintético, sem `AsyncMethodBuilderCore`, sem genéricos com nomes destruídos. Apenas métodos e números de linha.

## Debug realmente funciona agora

Preview 2 adicionou uma correção crítica: breakpoints agora se vinculam corretamente dentro de métodos runtime-async. No Preview 1, o depurador às vezes pulava breakpoints ou aterrissava em linhas inesperadas ao passar por limites de `await`. Com Preview 2, você pode definir um breakpoint em uma linha após um `await`, atingi-lo, e inspecionar locais normalmente. Passar por cima de um `await` aterrissa na próxima instrução, não dentro da infraestrutura do runtime.

Isso também beneficia ferramentas de profiling e logging de diagnóstico. Qualquer coisa que chame `new StackTrace()` ou leia `Environment.StackTrace` em runtime agora vê a cadeia de chamadas real, o que torna o logging estruturado e handlers de exceção customizados mais úteis sem filtragem extra.

## Habilitando o Runtime Async

Isto ainda é um recurso preview. Opte adicionando duas propriedades ao seu `.csproj`:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

O suporte do lado do CLR está habilitado por padrão no .NET 11, então você não precisa mais definir a variável de ambiente `DOTNET_RuntimeAsync`. A flag do compilador é o único interruptor.

## O que observar

Runtime Async ainda não é o padrão para código de produção. A equipe .NET ainda está trabalhando em casos extremos com tail calls, certas restrições genéricas, e interação com ferramentas de diagnóstico existentes. Se você já está em previews do .NET 11 e quer experimentar em um projeto de teste, as duas linhas de MSBuild acima são tudo que você precisa.

Os detalhes completos do Runtime Async estão nas [notas de release do .NET 11 Preview 2](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/runtime.md) e na página [What's new in .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) na Microsoft Learn.
