---
title: "Correção: CA1873 \"Evaluation of this argument may be expensive and unnecessary if logging is disabled\""
description: "CA1873 dispara por causa do array params object[] implícito, então quase toda chamada LogDebug o aciona. Corrija com [LoggerMessage] ou uma guarda IsEnabled."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "logging"
  - "analyzers"
  - "performance"
lang: "pt-br"
translationOf: "2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled"
translatedBy: "claude"
translationDate: 2026-08-18
---

CA1873 é um analisador de performance que vem habilitado no SDK do .NET 10 como **sugestão**, não como aviso, então ele aparece no Visual Studio, no Rider e no `dotnet format`, mas deixa o `dotnet build` limpo. Ele dispara por causa do array `params object?[]` implícito que toda chamada no estilo `ILogger.LogDebug` aloca, o que significa que ele é acionado em praticamente toda chamada de logging estruturado com pelo menos um argumento, mesmo uma string simples. A correção real é a geração de código-fonte com `[LoggerMessage]`; a correção rápida é uma guarda `IsEnabled` cujo nível coincida exatamente com a chamada.

O texto do diagnóstico que você está procurando:

```text
warning CA1873: Evaluation of this argument may be expensive and unnecessary if logging is disabled
```

Tudo abaixo foi verificado com o SDK `10.0.201`, o `Microsoft.Extensions.Logging` 10.0.0 e o C# 14, com o código-fonte do analisador lido do `dotnet/sdk`.

## O que torna CA1873 invisível no dotnet build?

Porque a severidade padrão dele no .NET 10 é sugestão (info), e diagnósticos de nível info não são impressos pelo `dotnet build` nem são afetados por `TreatWarningsAsErrors`.

Um projeto com uma dúzia de chamadas `LogDebug` compila completamente limpo:

```text
    0 Warning(s)
    0 Error(s)
```

Transforme-o em um aviso de verdade de uma destas duas formas:

```xml
<!-- .NET 10 SDK 10.0.201: promotes every "All"-mode analyzer, CA1873 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, targeted at just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = warning
```

O mesmo projeto então reporta 12 avisos CA1873. Se você está ligando severidades de analisadores ao CI, os trade-offs estão cobertos em [como manter TreatWarningsAsErrors fora das suas builds de desenvolvimento](/pt-br/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## Como um argumento obviamente barato ainda aciona CA1873?

Esta é a parte que manda as pessoas para os buscadores. A regra não olha apenas o seu argumento. Ela olha o **array `params object?[]` implícito** que o compilador cria para passar aquele argumento, e a criação de um array não vazio é ela própria reportada como cara.

`LoggerExtensions.LogDebug` não tem nenhuma sobrecarga sem params que receba argumentos de mensagem:

```csharp
// Microsoft.Extensions.Logging.Abstractions 10.0.0
public static void LogDebug(this ILogger logger, string? message, params object?[] args);
```

Então `_logger.LogDebug("v {V}", x)` compila para uma alocação `object[1]` independentemente do que `x` seja. A verificação de custo do analisador trata qualquer criação de array como uma violação, a menos que o array esteja vazio:

```csharp
// dotnet/sdk, AvoidPotentiallyExpensiveCallWhenLogging.cs
static bool IsEmptyImplicitParamsArrayCreation(IArrayCreationOperation arrayCreationOperation) =>
    arrayCreationOperation.IsImplicit &&
    arrayCreationOperation.DimensionSizes.Length == 1 &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.HasValue &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.Value is int size &&
    size == 0;
```

Montei uma matriz para confirmar o que realmente aciona a regra. Cada uma destas produziu CA1873 no SDK 10.0.201:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Logging.Abstractions 10.0.0
public void StringProp(Order o) => _logger.LogDebug("v {V}", o.Name);      // CA1873
public void IntProp(Order o)    => _logger.LogDebug("v {V}", o.Id);        // CA1873
public void StringField()       => _logger.LogDebug("v {V}", _nameField);  // CA1873
public void StringLocal()       { var s = "a"; _logger.LogDebug("v {V}", s); }  // CA1873
public void StringParam(string s) => _logger.LogDebug("v {V}", s);         // CA1873
public void ConstInt()          => _logger.LogDebug("v {V}", 42);          // CA1873
```

Só escapa uma chamada sem nenhum argumento de mensagem, porque aí o array params implícito tem comprimento zero:

```csharp
public void LiteralOnly() => _logger.LogDebug("nothing to see");           // clean
```

Essa é toda a surpresa. Não há nada de errado com `o.Name`. Uma mudança de novembro de 2025 intitulada "Reduce noise from CA1873" isentou especificamente acessos a propriedades, `GetType`, `GetHashCode` e `Stopwatch.GetTimestamp` da verificação de custo, mas essa isenção se aplica aos *elementos* do array, enquanto a alocação do array em si continua sinalizada. Para as sobrecargas baseadas em params, a redução de ruído é invisível.

## Qual é a reprodução mínima?

```csharp
// .NET 10 (SDK 10.0.201), C# 14
// dotnet new console + Microsoft.Extensions.Logging.Abstractions 10.0.0
using Microsoft.Extensions.Logging;

public class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order)
    {
        // CA1873: Evaluation of this argument may be expensive
        // and unnecessary if logging is disabled
        logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
    }
}
```

Com `<AnalysisMode>All</AnalysisMode>` ou uma severidade explícita no `.editorconfig`, essa única chamada reporta CA1873.

## Como corrijo CA1873 corretamente?

Use o gerador de código-fonte `[LoggerMessage]`. Ele emite um método fortemente tipado sem array params e sem boxing, então não sobra nada para o analisador sinalizar nem nada para o runtime alocar quando o nível está desabilitado.

```csharp
// .NET 10, C# 14. The class must be partial.
public partial class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order) => LogOrder(order.Id, order.Customer);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Order {OrderId} for {Customer}")]
    private partial void LogOrder(int orderId, string customer);
}
```

O método gerado verifica `IsEnabled` antes de tocar nos argumentos, então o analisador fica quieto e a chamada sai de graça quando Debug está desligado. Esse é o mesmo mecanismo por trás de [substituir new Regex(...) pelo gerador de código-fonte GeneratedRegex](/pt-br/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/); se o padrão não é familiar, comece por [o que é um gerador de código-fonte e quando você precisa de um](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## Quando uma guarda IsEnabled é suficiente?

Quando você quer uma mudança de uma linha e não quer reestruturar a classe em um tipo partial. O analisador reconhece a guarda e suprime o diagnóstico:

```csharp
// .NET 10, C# 14
if (logger.IsEnabled(LogLevel.Debug))
{
    logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
}
```

Duas restrições, e verifiquei que ambas produzem um diagnóstico quando violadas:

**O nível precisa coincidir exatamente.** Proteger um `LogDebug` com `IsEnabled(LogLevel.Information)` ainda reporta CA1873, porque o analisador compara a constante da guarda com o nível da chamada:

```csharp
if (logger.IsEnabled(LogLevel.Information))
{
    logger.LogDebug("v {V}", order.Describe());   // CA1873, levels differ
}
```

**A guarda precisa estar inline.** Movê-la para trás de uma propriedade ou de um método auxiliar anula a verificação por completo, porque o analisador percorre as operações contêineres procurando uma invocação literal de `ILogger.IsEnabled`:

```csharp
private bool DebugOn => logger.IsEnabled(LogLevel.Debug);

public void Process(Order order)
{
    if (DebugOn) { logger.LogDebug("v {V}", order.Describe()); }   // CA1873
}
```

## Quanto a chamada desprotegida custa de verdade?

O suficiente para importar em um caminho quente, e nada fora dele. Medido com BenchmarkDotNet 0.15.4 no .NET 10.0.5, Intel Core Ultra 7 265KF, com o nível mínimo definido como `Information` para que a chamada Debug esteja desabilitada:

| Método | Média | Ratio | Alocado |
| --- | ---: | ---: | ---: |
| Unguarded | 13,22 ns | 1,00 | 64 B |
| Guarded | 0,27 ns | 0,02 | 0 B |
| SourceGenerated | 0,51 ns | 0,04 | 0 B |

Os 64 bytes são o array `object[2]` mais o `int` boxed. As duas correções derrubam isso para zero. Repare no ratio, não só nos nanossegundos: 13 ns por chamada é irrelevante em um handler de requisição que executa uma consulta a banco de dados, e muito relevante em um laço que roda um milhão de vezes. É exatamente por isso que a regra é publicada como sugestão em vez de aviso.

## Quais níveis de log CA1873 verifica?

Por padrão, Information e abaixo. A justificativa de design, tirada do próprio histórico de commits do analisador, é que caminhos quentes registram em Debug e Trace, enquanto Warning e Error são raros o bastante para que o overhead por chamada não importe.

Há também um botão não documentado no `.editorconfig` para mudar o limiar:

```ini
# Not listed on the CA1873 docs page. Values: trace, debug, information, warning, error, critical
[*.{cs,vb}]
dotnet_code_quality.CA1873.max_log_level = warning
```

Varrer todos os valores no SDK 10.0.201 dá isto, e expõe um bug:

| `max_log_level` | Níveis que reportam CA1873 |
| --- | --- |
| `trace` | Trace, **Critical** |
| `debug` | Trace, Debug, **Critical** |
| `information` (padrão) | Trace, Debug, Information, **Critical** |
| `warning` | Trace, Debug, Information, Warning, Critical |
| `error` | todos os seis |

`LogCritical` reporta em todos os limiares, incluindo `trace`. Isso é um erro de deslocamento por um: a comparação publicada exclui Critical do intervalo em que ela sai antecipadamente.

```csharp
// dotnet/sdk commit 574cda32, "CA1873: Fix log level comparison"
-                    logLevel < LogLevelCritical &&
+                    logLevel <= LogLevelCritical &&
```

A correção chegou ao `dotnet/sdk` em 2026-06-19, depois de o SDK 10.0.201 ter sido publicado. Até você migrar para um SDK que a inclua, chamadas `LogCritical` vão continuar reportando CA1873 não importa como você configure `max_log_level`. Suprima essas individualmente em vez de desabilitar a regra.

## Falso positivo conhecido: chamadas geradas protegidas por guarda

Se você envolver um método de log gerado por código-fonte em uma verificação `IsEnabled`, o analisador ainda reporta CA1873. Isso está registrado como uma issue aberta contra o analisador, e se reproduz no SDK 10.0.201:

```csharp
// .NET 10, C# 14. Guarded, source-generated, still reports CA1873.
if (logger.IsEnabled(LogLevel.Information))
{
    LogKeys([.. dictionary.Select(p => p.Key)]);
}

[LoggerMessage(Level = LogLevel.Information, Message = "keys {Keys}")]
private partial void LogKeys(string[] keys);
```

A guarda só conta quando envolve uma chamada de `ILogger` reconhecida. Um método gerado é um método comum no que diz respeito ao analisador, então o argumento de expressão de coleção é avaliado por conta própria e sinalizado. Suprima este localmente até a correção chegar:

```csharp
#pragma warning disable CA1873
    LogKeys([.. dictionary.Select(p => p.Key)]);
#pragma warning restore CA1873
```

## Parecidos que caem nesta página por engano

**CA1848** ("For improved performance, use the LoggerMessage delegates") dispara nos mesmos pontos de chamada e tem a mesma correção, mas trata do custo de analisar o template da mensagem a cada chamada, não da avaliação de argumentos. Você normalmente vai ver os dois juntos, e `[LoggerMessage]` resolve ambos.

**CA2254** ("The logging message template should not vary between calls") trata da interpolação de strings destruindo seus campos estruturados. Se é isso que você está realmente caçando, veja [migrar da interpolação de strings com ILogger para templates de mensagem](/pt-br/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/), que também cobre `SkipEnabledCheck` e `[LogProperties]`.

## Você deveria simplesmente desligar a regra?

Para uma base de código que registra em Information nos caminhos de requisição e não tem laços quentes medidos, sim. Coloque em `none` e revisite quando você tiver um profile dizendo que o overhead de logging importa:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = none
```

O meio-termo mais útil é deixar na severidade padrão de sugestão e aplicar `[LoggerMessage]` de forma oportunista. Você ganha o empurrão da IDE nos pontos de chamada que toca, nenhum ruído no CI, e o logging sem alocação se acumula com o tempo em vez de chegar como uma refatoração de 400 arquivos. O ganho de alocação é real, só não é urgente, e o array params por trás dele é o mesmo que o C# 13 [começou a eliminar para outras APIs](/pt-br/2026/01/c-13-the-end-of-params-allocations/).

## Relacionado

- [Migrar da interpolação de strings com ILogger para templates de mensagem de logging estruturado no .NET 11](/pt-br/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)
- [Como redigir valores sensíveis dos logs com LogProperties no .NET](/pt-br/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [O que é um gerador de código-fonte e quando eu preciso de um?](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [TreatWarningsAsErrors sem sabotar as builds de desenvolvimento (.NET 10)](/pt-br/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [C# 13: o fim das alocações de params](/pt-br/2026/01/c-13-the-end-of-params-allocations/)

## Fontes

- [CA1873: Avoid potentially expensive logging](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1873) no MS Learn
- [Add CA1873: Avoid potentially expensive logging](https://github.com/dotnet/roslyn-analyzers/pull/7290), o PR original do analisador
- [Reduce noise from CA1873](https://github.com/dotnet/sdk/commit/bb4aee4d), que adicionou a opção `max_log_level` e a isenção de acessos a propriedades
- [CA1873: Fix log level comparison](https://github.com/dotnet/sdk/commit/574cda32), a correção do deslocamento por um de `LogCritical`
- [Falsos positivos de CA1873 quando a mensagem de log está envolvida em uma verificação IsEnabled](https://github.com/dotnet/roslyn-analyzers/issues/7690)
- [Referência da API LoggerMessageAttribute](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.logging.loggermessageattribute)
