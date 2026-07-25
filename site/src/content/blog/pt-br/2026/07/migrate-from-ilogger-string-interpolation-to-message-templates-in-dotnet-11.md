---
title: "Migre da interpolação de strings no ILogger para templates de mensagem de log estruturado no .NET 11"
description: "Guia passo a passo para converter chamadas de ILogger com interpolação $ em templates de mensagem e métodos gerados com [LoggerMessage] no .NET 11: o que quebra, como varrer um código base com CA2254, como verificar o estado JSON e como reverter."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "logging"
  - "observability"
lang: "pt-br"
translationOf: "2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-25
---

Cada `_logger.LogInformation($"Order {orderId} failed for {customerId}")` no seu código base está jogando fora os dois campos que você vai querer quando o alerta disparar. Este guia converte um código base .NET 11 (SDK 11.0.100-preview.6, C# 14) de chamadas de log interpoladas para templates de mensagem e, depois, converte os caminhos quentes em métodos gerados com `[LoggerMessage]`. Em um serviço de porte médio, a varredura de templates leva meio dia de edições quase mecânicas guiadas pelo CA2254, e a etapa do gerador de código-fonte leva mais um dia se for feita direito. Nada disso é arriscado: a correção não gera mudanças incompatíveis, cada etapa é reversível de forma independente, e o retorno é que o seu backend de log finalmente consegue filtrar por `OrderId` em vez de fazer grep em frases renderizadas.

## Por que a interpolação perde os dados de que você realmente precisa

- **A estrutura some antes de o logger vê-la.** `$"Order {orderId} failed"` é compilado para uma chamada a `string.Concat` ou `DefaultInterpolatedStringHandler` no ponto da chamada. Quando `ILogger.Log` executa, não existe mais nenhuma propriedade `orderId`, apenas uma frase. O `{OriginalFormat}` no estado do log acaba guardando o texto totalmente renderizado, então cada ID de pedido distinto produz um "template" distinto no seu agregador.
- **A cardinalidade explode no lugar errado.** Seq, Loki, Elastic e todo backend OTLP agrupam e indexam pelo template mais suas propriedades nomeadas. Chamadas interpoladas geram um template único por invocação, que é exatamente o formato com que esses sistemas lidam pior.
- **A string é construída mesmo com o nível desligado.** `_logger.LogDebug($"Payload: {Serialize(request)}")` aloca a string e executa `Serialize` em cada requisição, em produção, com `Debug` desabilitado. A própria [orientação da Microsoft para autores de bibliotecas](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance) diz isso explicitamente. A proposta de adicionar sobrecargas com handler de string interpolada a `LoggerExtensions` ([dotnet/runtime#111283](https://github.com/dotnet/runtime/issues/111283)) foi fechada como não planejada, então isso não vai ser resolvido sozinho.
- **Chaves nos seus dados podem lançar exceção.** Há mais sobre isso nos detalhes finais, mas uma string interpolada cujo valor contém `{` ou `}` pode lançar uma `FormatException` de dentro do pipeline de log.

Se você ainda não decidiu para onde os logs vão, resolva isso primeiro. [Log estruturado com Serilog e Seq](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) e [OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) partem do princípio de que os templates deste guia já estão corretos.

## O que as duas formas realmente produzem

Este é o menor caso reproduzível. Mesma intenção, dois estilos de chamada, passando pelo formatador `JsonConsole` no .NET 11.

```csharp
// .NET 11 preview 6, C# 14
int orderId = 4711;
string customerId = "acme-inc";

// Interpolated: the template IS the rendered sentence.
_logger.LogInformation($"Order {orderId} failed for {customerId}");

// Message template: placeholders survive as named properties.
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", orderId, customerId);
```

A primeira chamada emite um estado com uma única entrada inútil:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "{OriginalFormat}": "Order 4711 failed for acme-inc"
  }
}
```

A segunda chamada emite os campos:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "OrderId": 4711,
    "CustomerId": "acme-inc",
    "{OriginalFormat}": "Order {OrderId} failed for {CustomerId}"
  }
}
```

A `Message` renderizada é idêntica. Tudo o que torna o log consultável mora na diferença.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| Pontos de chamada com `$"..."` | Precisam virar um template constante mais argumentos | alta (por volume, não por risco) |
| Consultas e painéis de log | Buscas salvas que casam com o texto renderizado continuam funcionando; novos filtros por propriedade precisam ser criados | média |
| Regras de alerta baseadas em `{OriginalFormat}` | A string do template muda, então regras de correspondência exata com o texto renderizado antigo param de casar | média |
| Concatenação de strings em templates | `"Order " + id + " failed"` é o mesmo defeito e é pego pela mesma regra | média |
| Conversão para `[LoggerMessage]` | A classe contêiner e o método precisam virar `partial`; o método precisa retornar `void` | baixa |
| Valores de `EventId` | IDs duplicados dentro do assembly produzem avisos do gerador | baixa |
| Destructuring `@` do Serilog | A semântica de `{@Order}` difere da enumeração de estado do `Microsoft.Extensions.Logging` | baixa |

Nada aqui é uma mudança incompatível em tempo de execução. A regra do Roslyn que guia a varredura, [CA2254](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), é documentada explicitamente como uma correção não incompatível.

## Checklist antes de começar

- .NET SDK 11.0.100-preview.6 ou posterior instalado (`dotnet --list-sdks`). Tudo neste guia também funciona no .NET 8, 9 e 10.
- `<LangVersion>` em 9 ou superior. O gerador `[LoggerMessage]` se recusa a rodar abaixo de C# 9. No .NET 11 você tem C# 14 por padrão.
- `Microsoft.Extensions.Logging.Abstractions` referenciado em todo projeto que vai declarar métodos `[LoggerMessage]`. Projetos que usam `Microsoft.NET.Sdk.Web` recebem isso de forma transitiva.
- `<EnableNETAnalyzers>true</EnableNETAnalyzers>` e `<AnalysisLevel>latest</AnalysisLevel>` em `Directory.Build.props`, caso contrário o CA2254 nunca dispara.
- Um `git status` limpo e uma execução de testes verde antes de começar. A varredura toca centenas de linhas e você vai querer uma reversão trivial.

## Etapas da migração

A ordem importa: primeiro faça o analisador gritar, corrija tudo o que ele achar e só então recorra ao gerador de código-fonte nos caminhos em que a alocação realmente custa alguma coisa.

1. **Transforme o CA2254 em erro de build.** Adicione a regra ao `.editorconfig` primeiro como `warning` para ver o tamanho do estrago e suba para `error` quando a contagem chegar a zero. Verifique: `dotnet build` reporta uma contagem de CA2254 diferente de zero na primeira execução.
2. **Converta chamadas interpoladas e concatenadas para templates de mensagem.** Tire cada valor da string e passe como argumento, com um nome de placeholder em PascalCase. Verifique: `dotnet build` reporta zero diagnósticos CA2254.
3. **Corrija a ordem dos argumentos, porque a ligação é posicional.** `LoggerExtensions` liga argumentos a placeholders da esquerda para a direita, não por nome. Verifique: rode a aplicação e confirme que cada propriedade do estado JSON contém o valor que o nome promete.
4. **Adicione métodos `[LoggerMessage]` para os caminhos quentes.** Converta chamadas de log por requisição e por item em métodos `partial` de uma classe `partial`, para que o template seja analisado uma única vez em tempo de compilação. Verifique: `dotnet build` limpo e o arquivo gerado aparece em `obj/**/Microsoft.Extensions.Logging.Generators/`.
5. **Atribua um `EventId` estável por mensagem e mantenha-os únicos.** Verifique: nenhum aviso `SYSLIB` de ID de evento duplicado no log de build.
6. **Use `SkipEnabledCheck` mais uma guarda manual onde avaliar os argumentos for caro.** Verifique: coloque a categoria em `Information` e confirme que a chamada cara não roda.
7. **Expanda objetos com `[LogProperties]` em vez de `ToString()`.** Verifique: as propriedades públicas do objeto aparecem como entradas individuais no estado do log, não como uma única string achatada.

### 1. Transforme o CA2254 em erro de build

O CA2254 vem habilitado como sugestão por padrão a partir do .NET 10, o que significa que ele é invisível no CI. Promova a regra:

```ini
# .editorconfig -- .NET 11, analyzers at latest
[*.{cs,vb}]

# CA2254: Template should be a static expression
dotnet_diagnostic.CA2254.severity = warning
```

Compile e conte com o que você está lidando:

```bash
dotnet build -warnaserror:CA2254 --no-incremental
```

Ainda não habilite o CA1848. Aquela regra dispara em toda chamada `LogInformation` do código base, inclusive nas corretas, e vai soterrar o sinal do CA2254. Ela volta na etapa 4.

### 2. Converta para templates de mensagem

A transformação mecânica, em três formatos comuns:

```csharp
// .NET 11, C# 14 -- before
_logger.LogInformation($"Order {order.Id} failed for {order.CustomerId}");
_logger.LogWarning("Retry " + attempt + " of " + maxAttempts);
_logger.LogError(ex, $"Import of {file.Name} aborted after {sw.ElapsedMilliseconds} ms");

// after
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", order.Id, order.CustomerId);
_logger.LogWarning("Retry {Attempt} of {MaxAttempts}", attempt, maxAttempts);
_logger.LogError(ex, "Import of {FileName} aborted after {ElapsedMs} ms", file.Name, sw.ElapsedMilliseconds);
```

Três regras de nomenclatura que se pagam depois:

- Placeholders em PascalCase. A própria orientação da Microsoft recomenda, e isso mantém os nomes de propriedade consistentes entre templates escritos à mão e gerados.
- O mesmo conceito recebe o mesmo nome em todo lugar. Se é `OrderId` em um serviço, é `OrderId` em todos, caso contrário consultas entre serviços precisam de uma cláusula `or` por grafia.
- Nunca coloque a exceção no template. `LogError(ex, "...")` passa a exceção pelo parâmetro `Exception` dedicado, e o provider decide como renderizá-la.

### 3. A ligação de argumentos é posicional, não por nome

Este é o único bug que a varredura pode introduzir, e o CA2254 não vai pegar:

```csharp
// .NET 11 -- compiles, no analyzer warning, WRONG
_logger.LogInformation("Order {OrderId} for {CustomerId}", customerId, orderId);
```

O `Microsoft.Extensions.Logging` mapeia placeholders para argumentos em ordem. Os nomes são rótulos para as propriedades resultantes, não uma chave de ligação. A linha de log renderiza o ID do cliente sob `OrderId` e ninguém percebe até uma consulta devolver besteira três semanas depois. Leia cada linha convertida uma vez pensando nessa falha específica, e prefira converter um método inteiro de cada vez em vez de aceitar a saída de um localizar e substituir em massa.

O gerador `[LoggerMessage]` da etapa 4 não tem esse problema: ele casa os placeholders do template com os nomes dos parâmetros sem diferenciar maiúsculas, então a ordem dos parâmetros é irrelevante lá.

### 4. Adicione [LoggerMessage] nos caminhos quentes

Os templates de mensagem consertaram a estrutura. Eles não consertaram o custo por chamada: `LoggerExtensions.LogInformation` ainda faz boxing de tipos por valor em `object`, aloca um `params object?[]` e reanalisa o template a cada chamada. O [gerador de código-fonte `[LoggerMessage]`](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) elimina os três emitindo em tempo de compilação um wrapper `LoggerMessage.Define` fortemente tipado.

```csharp
// .NET 11 preview 6, C# 14
using Microsoft.Extensions.Logging;

public partial class OrderProcessor(ILogger<OrderProcessor> logger, OrderPipeline pipeline)
{
    public async Task ProcessAsync(Order order, CancellationToken ct)
    {
        try
        {
            await pipeline.RunAsync(order, ct);
            OrderProcessed(order.Id, order.CustomerId);
        }
        catch (PaymentDeclinedException ex)
        {
            OrderFailed(ex, order.Id, order.CustomerId);
        }
    }

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "Order {OrderId} processed for {CustomerId}")]
    private partial void OrderProcessed(int orderId, string customerId);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Warning,
        Message = "Order {OrderId} failed for {CustomerId}")]
    private partial void OrderFailed(Exception ex, int orderId, string customerId);
}
```

Desde o .NET 9, o gerador lê o `ILogger` de um parâmetro de construtor primário, que é o motivo de o exemplo acima não ter um campo `_logger` explícito. Se existirem tanto um campo quanto um parâmetro de construtor primário, o campo vence.

As restrições que vale a pena memorizar, segundo a [documentação de geração de código-fonte](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator): os métodos precisam ser `partial` e retornar `void`, nem os nomes nem os nomes de parâmetro podem começar com underscore, e os parâmetros não podem usar `params`, `scoped` ou `out`, nem ser tipos `ref struct`. Métodos estáticos precisam receber o `ILogger` como parâmetro; adicione `this` para transformá-los em métodos de extensão.

Agora ligue o CA1848 nos projetos que você converteu, com escopo limitado para não inundar o resto:

```ini
# .editorconfig, in the hot-path project folder only
[*.cs]
# CA1848: Use the LoggerMessage delegates
dotnet_diagnostic.CA1848.severity = warning
```

O CA1848 não vem habilitado por padrão nem no .NET 10 e posteriores, e é deliberadamente agressivo: ele marca toda chamada no estilo `LogInformation`. Habilite por projeto, não na solução inteira, a menos que você realmente pretenda gerar todas as mensagens pelo gerador.

### 5. Mantenha os IDs de evento estáveis e únicos

`EventId` é a identidade estável de uma mensagem de log. Ele sobrevive a reescritas do template, o que o torna a coisa certa para as regras de alerta usarem como chave. Coloque os IDs em um único lugar por assembly para que colisões fiquem óbvias:

```csharp
// .NET 11 -- one file, one range per subsystem
internal static class LogEvents
{
    public const int OrderProcessed = 1001;
    public const int OrderFailed    = 1002;
    public const int PaymentRetried = 1003;
}
```

O gerador avisa sobre IDs de evento duplicados dentro de uma classe. Ele não avisa entre classes, então o arquivo de constantes faz trabalho de verdade.

### 6. SkipEnabledCheck para argumentos caros

Por padrão o método gerado chama `ILogger.IsEnabled` antes de fazer qualquer coisa, então um nível desabilitado custa uma chamada virtual. O que ele não consegue fazer é impedir que quem chama compute os argumentos. Quando um argumento é caro, suba a guarda:

```csharp
// .NET 11, C# 14
[LoggerMessage(
    EventId = 2001,
    Level = LogLevel.Debug,
    Message = "Request body: {Body}",
    SkipEnabledCheck = true)]
private partial void RequestBody(string body);

// call site
if (logger.IsEnabled(LogLevel.Debug))
{
    RequestBody(await SerializeAsync(request, ct));  // only runs when Debug is on
}
```

Esse é o padrão que recupera o throughput que as chamadas interpoladas de `LogDebug` estavam custando silenciosamente.

### 7. Expanda objetos com [LogProperties]

`Message = "Processing {Order}"` com um parâmetro `Order` dá a você uma única propriedade contendo a saída de `ToString()`. Para obter os campos do objeto como propriedades separadas, adicione `Microsoft.Extensions.Telemetry.Abstractions` e anote o parâmetro:

```csharp
// .NET 11, Microsoft.Extensions.Telemetry.Abstractions
[LoggerMessage(
    EventId = 1004,
    Level = LogLevel.Information,
    Message = "Processing order")]
private partial void ProcessingOrder([LogProperties] Order order);
```

Cada propriedade pública de `Order` cai no estado do log como `order.Id`, `order.CustomerId`, e assim por diante. O mesmo pacote é o que habilita a redação de parâmetros classificados, que é a resposta correta quando alguém pede para você logar um objeto de requisição que contém um endereço de e-mail.

## Verificação

Rode este checklist depois de cada fase, não uma vez só no fim:

- `dotnet build -warnaserror:CA2254` sai com código zero.
- `dotnet test` passa sem novas falhas. Testes que fazem asserções sobre o texto renderizado do log são a vítima usual; reescreva-os para fazer asserções sobre as propriedades do estado.
- Troque o formatador de console para JSON (`"Console": { "FormatterName": "json" }` em `appsettings.Development.json`), chame um endpoint representativo e leia o objeto `State` emitido. Todo valor que importa precisa aparecer como chave própria, e `{OriginalFormat}` precisa conter placeholders em vez de dados.
- Faça grep na saída do build por `SYSLIB1015` (parâmetro sem placeholder correspondente) e `SYSLIB0025` (exceção incluída no template). Ambos são avisos que você deveria corrigir em vez de suprimir.
- Confirme que o código-fonte gerado existe: `obj/Debug/net11.0/generated/Microsoft.Extensions.Logging.Generators/`. Se a pasta estiver vazia, o atributo está em um membro que não é `partial` e o gerador silenciosamente não fez nada útil.
- Implante em staging e compare o volume de log. Deve estar inalterado. Uma queda significa que alguma guarda de nível foi apertada sem querer.

## Plano de rollback

Cada etapa é reversível de forma independente com `git revert`, e nenhuma etapa muda uma API pública ou um formato de transmissão. Há uma ressalva que vale dizer alto e claro: assim que o seu backend de log começar a indexar os novos nomes de propriedade, painéis e alertas construídos sobre eles quebram se você reverter o código. Reverta o código primeiro, os painéis depois, e mantenha as duas mudanças em commits separados para que a ordem fique disponível para você.

O aumento de severidade no `.editorconfig` também vale a pena manter mesmo se você reverter as mudanças de código. Deixar o CA2254 em `warning` impede que novas chamadas interpoladas cheguem enquanto você decide.

## Detalhes em que tropeçamos

**Chaves nos dados lançam FormatException.** A forma interpolada tem um modo de falha que a maioria dos times conhece primeiro em produção. O `Microsoft.Extensions.Logging` trata o argumento `message` como string de formato e o passa pelo `LogValuesFormatter`, que reescreve `{Name}` como `{0}` e chama `string.Format`. Se o seu resultado interpolado contém chaves, por exemplo porque você logou um payload JSON, o formatador vê placeholders sem argumentos correspondentes e lança exceção (`aspnet/Logging#351` é o relato canônico). Templates de mensagem são imunes: o JSON é um argumento, nunca parte da string de formato.

```csharp
// .NET 11 -- throws FormatException at runtime when json contains { }
_logger.LogInformation($"Response: {json}");

// safe
_logger.LogInformation("Response: {Json}", json);
```

**`{@Property}` do Serilog não é um recurso do Microsoft.Extensions.Logging.** Se você usa Serilog, `{@Order}` desestrutura o objeto em um valor estruturado. O gerador `[LoggerMessage]` vai aceitar o template, mas o `@` é convenção do Serilog, tratada pelo `Serilog.Extensions.Logging`. Não assuma que ele faz alguma coisa em um provider OTLP ou de console puro. Use `[LogProperties]` quando quiser expansão independente de provider.

**Testes que fazem asserção sobre o texto do log.** `Assert.Contains("Order 4711 failed", sink.Messages)` continua passando durante a migração, porque a mensagem renderizada não muda. Isso é uma armadilha: significa que você pode converter o código base sem que os testes jamais provem que as propriedades existem. Adicione pelo menos um teste por subsistema que faça asserção sobre a chave do estado.

**Os logs do próprio EF Core já usam templates.** Não "conserte" eles. Se o que você quer é obter SQL legível do provider, [logar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) é um problema de configuração, não de ponto de chamada.

**Uma migração de backend é outro trabalho.** Converter pontos de chamada não move os logs para lugar nenhum. Se o destino é OTLP, faça esta migração primeiro para que os templates fiquem certos, e depois siga [sair do Serilog para logging com OpenTelemetry](/pt-br/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/). Fazer as duas coisas ao mesmo tempo significa que você não consegue dizer qual mudança quebrou um painel.

## Fontes

- [Geração de código-fonte de log em tempo de compilação](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator), Microsoft Learn
- [Log de alto desempenho no .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/high-performance-logging), Microsoft Learn
- [Orientação de log para autores de bibliotecas .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance), Microsoft Learn
- [CA2254: o template deve ser uma expressão estática](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), Microsoft Learn
- [CA1848: use os delegates de LoggerMessage](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1848), Microsoft Learn
- [Proposta de API: sobrecargas com strings interpoladas para as extensões de ILogger](https://github.com/dotnet/runtime/issues/111283), dotnet/runtime, fechada como não planejada
- [LogInformation(string) lança FormatException](https://github.com/aspnet/Logging/issues/351), aspnet/Logging
- [.NET 11 Preview 6 já está disponível](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/), .NET Blog
