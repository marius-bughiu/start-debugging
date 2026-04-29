---
title: "Ideia para C# 14: interceptors poderiam fazer a geração de código-fonte do System.Text.Json parecer automática"
description: "Uma discussão da comunidade propôs usar interceptors do C# 14 para reescrever chamadas ao JsonSerializer de modo que utilizem automaticamente um JsonSerializerContext gerado, mantendo a geração de código-fonte amigável a AOT com pontos de chamada mais limpos."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
  - "system-text-json"
  - "aot"
lang: "pt-br"
translationOf: "2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics"
translatedBy: "claude"
translationDate: 2026-04-29
---

Uma das discussões mais interessantes de .NET nas últimas 24 a 48 horas foi uma pergunta simples: por que a geração de código-fonte do `System.Text.Json` ainda parece "manual" no ponto de chamada?

O gatilho foi uma thread de 7 de fevereiro de 2026 propondo uma abordagem muito no espírito do C# 14: **interceptors** que reescrevem chamadas `JsonSerializer.Serialize` e `JsonSerializer.Deserialize` para usar automaticamente um `JsonSerializerContext` gerado.

## A lacuna ergonômica: o contexto funciona, mas se espalha pelo seu código

Se você quer segurança de trimming e desempenho previsível no **.NET 10**, a geração de código-fonte é uma opção forte. O atrito é que você acaba propagando o contexto por toda parte:

```csharp
using System.Text.Json;

var foo = JsonSerializer.Deserialize<Foo>(json, FooJsonContext.Default.Foo);
var payload = JsonSerializer.Serialize(foo, FooJsonContext.Default.Foo);
```

É explícito e correto, mas é ruidoso. Esse ruído tende a vazar para camadas da aplicação que não deveriam se preocupar com encanamento de serialização.

## Como uma reescrita baseada em interceptors poderia parecer

A ideia é: manter os pontos de chamada limpos:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json);
```

E então ter um interceptor (em tempo de compilação) que o reescreva para a chamada baseada em contexto que você teria escrito à mão:

```csharp
var foo = JsonSerializer.Deserialize<Foo>(json, GlobalJsonContext.Default.Foo);
```

Se você tem múltiplos perfis de opções, o interceptor precisa de um mapeamento determinístico para a instância de contexto correta. É aí que começa a parte do "isso é difícil".

## As restrições que viabilizam ou inviabilizam (AOT é o juiz)

Para que isso seja mais do que uma ideia bonita, tem que sobreviver nos ambientes onde a geração de código-fonte mais importa:

- **NativeAOT e trimming**: a reescrita não pode acidentalmente reintroduzir fallbacks baseados em reflexão.
- **Identidade das opções**: você precisa de uma forma estável de escolher um contexto para um determinado `JsonSerializerOptions`. Opções mutadas em tempo de execução não encaixam bem.
- **Compilação parcial**: os interceptors devem se comportar de forma consistente entre projetos, assemblies de teste e builds incrementais.

Se essas restrições forem atendidas, você obtém uma vitória rara: **manter o pipeline amigável a AOT**, mas remover o "encanamento de contexto" da maior parte do seu código.

A conclusão prática hoje: mesmo que os interceptors não cheguem exatamente na forma discutida, este é um sinal forte de que desenvolvedores .NET querem melhor ergonomia em torno da geração de código-fonte. Eu esperaria que ferramentas futuras, analisadores ou padrões de framework se movam nessa direção.

Fontes:

- [Thread no Reddit](https://www.reddit.com/r/csharp/comments/1qyaviv/interceptors_for_systemtextjson_source_generation/)
- [Documentação de geração de código-fonte do System.Text.Json](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/source-generation)
