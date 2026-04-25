---
title: "Kestrel abandona exceções do seu parser HTTP/1.1 no .NET 11"
description: "O parser de requisições HTTP/1.1 do Kestrel no .NET 11 substitui BadHttpRequestException por um struct de resultado, cortando o overhead de requisições malformadas em até 40%."
pubDate: 2026-04-08
tags:
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "performance"
lang: "pt-br"
translationOf: "2026/04/kestrel-non-throwing-parser-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Toda requisição HTTP/1.1 malformada que atingia o Kestrel costumava lançar uma `BadHttpRequestException`. Essa exceção alocava um stack trace, desenrolava a pilha de chamadas, e era capturada em algum lugar mais acima, tudo por uma requisição que nunca produziria uma resposta válida. No .NET 11, o parser [muda para um caminho de código sem throws](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), e a diferença é mensurável: **20-40% mais throughput** em cenários com tráfego malformado frequente.

## Por que exceções eram caras

Lançar uma exceção no .NET não é grátis. O runtime captura um stack trace, percorre a pilha de chamadas procurando um `catch` correspondente, e aloca o objeto de exceção no heap. Para uma requisição bem formada isso nunca dispara, então você não percebe. Mas scanners de portas, clientes mal configurados, e tráfego malicioso podem empurrar milhares de requisições ruins por segundo. Cada uma pagava o imposto completo de exceção.

```csharp
// Before (.NET 10 and earlier): every parse failure threw
try
{
    ParseRequestLine(buffer);
}
catch (BadHttpRequestException ex)
{
    Log.ConnectionBadRequest(logger, ex);
    return;
}
```

Em caminhos quentes, `try/catch` com throws frequentes se torna um gargalo de throughput.

## A abordagem do struct de resultado

O parser do .NET 11 retorna um struct de resultado leve em vez disso:

```csharp
// After (.NET 11): no exception on parse failure
var result = ParseRequestLine(buffer);

if (result.Status == ParseStatus.Error)
{
    Log.ConnectionBadRequest(logger, result.ErrorReason);
    return;
}
```

O struct carrega um campo `Status` (`Success`, `Incomplete`, ou `Error`) e uma string de razão de erro quando relevante. Sem alocação no heap, sem desenrolar a pilha, sem overhead do bloco `catch`. Requisições válidas não veem nenhuma mudança porque já tomavam o caminho de sucesso.

## Quando isto importa

Se seu servidor fica atrás de um balanceador de carga que faz health-check com TCP cru ou se você expõe o Kestrel diretamente à internet, você está sendo atingido por requisições malformadas constantemente. Implantações honeypot, gateways de API lidando com protocolos mistos, e qualquer serviço exposto a scans de portas todos se beneficiam.

A melhoria é inteiramente interna ao Kestrel. Não há mudança de API, nem flag de configuração, nem opt-in. Atualize para .NET 11 e o parser é mais rápido por padrão.

## Outras vitórias de desempenho no .NET 11

Essa não é a única redução de alocação no .NET 11 Preview. O middleware de logging HTTP agora faz pool de suas instâncias de `ResponseBufferingStream`, cortando alocações por requisição quando o logging do corpo de resposta está habilitado. Combinada com a mudança do parser, .NET 11 continua o padrão da equipe de runtime de transformar caminhos quentes pesados em exceções em fluxos de resultado baseados em struct.

Se você quiser ver o impacto na sua própria carga de trabalho, rode um benchmark antes/depois com [Bombardier](https://github.com/codesenberg/bombardier) ou `wrk` enquanto injeta uma porcentagem de requisições malformadas. A mudança do parser é transparente, mas os números devem falar por si.
