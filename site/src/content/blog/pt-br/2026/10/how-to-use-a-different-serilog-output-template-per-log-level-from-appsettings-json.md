---
title: "Como usar um template de saída do Serilog diferente por nível de log a partir do appsettings.json"
description: "O outputTemplate é fixo por sink, então formatação por nível exige um ExpressionTemplate com blocos {#if @l ...} ou dois sub-loggers Logger com filtros ByIncludingOnly / ByExcluding. Ambos configurados apenas pelo appsettings.json, testados no Serilog 4.4, Serilog.Settings.Configuration 10.0.1 e Serilog.Expressions 5.0."
pubDate: 2026-10-26
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "logging"
  - "serilog"
  - "aspnet-core"
lang: "pt-br"
translationOf: "2026/10/how-to-use-a-different-serilog-output-template-per-log-level-from-appsettings-json"
translatedBy: "claude"
translationDate: 2026-10-26
---

Um `outputTemplate` do Serilog pertence a um sink, não a um nível, então não existe uma configuração `"outputTemplate": { "Error": "..." }`. Há duas formas limpas de obter formatação por nível apenas com o `appsettings.json`. A primeira é trocar `outputTemplate` por um `formatter` do tipo `Serilog.Templates.ExpressionTemplate` (do pacote `Serilog.Expressions`) e ramificar dentro do template com `{#if @l in ['Error', 'Fatal']} ... {#else} ... {#end}`. A segunda é escrever em dois sub-loggers `"Name": "Logger"`, cada um com um `Filter` (`ByIncludingOnly` / `ByExcluding` sobre `@l`) e seu próprio `outputTemplate` simples. Não adicione simplesmente um segundo sink com `restrictedToMinimumLevel`: isso é um limite inferior, então cada erro é escrito duas vezes. Tudo abaixo foi executado com o SDK .NET 10.0.302, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0, Serilog.Sinks.Console 6.1.1 e Serilog.Sinks.File 7.0.0. O mesmo JSON funciona sem alterações no .NET 11.

## Por que o outputTemplate não pode variar por nível

`outputTemplate` é um argumento de construtor dos sinks de console e de arquivo. Internamente, o sink cria um único `MessageTemplateTextFormatter` a partir dessa string e o usa para todo evento que recebe. O Serilog.Settings.Configuration apenas chama `WriteTo.Console(outputTemplate: "...")` por você, então o que você coloca no JSON corresponde um a um a esse único formatter. O nível está disponível *dentro* do template como `{Level}`, mas um message template clássico não tem condicionais: ele pode imprimir o nível, mas não consegue mudar de formato por causa dele.

Portanto, a saída por nível exige uma de duas coisas:

1. um formatter que consiga tomar decisões por conta própria, que é o que o `ExpressionTemplate` faz, ou
2. pipelines separados, cada um com seu próprio formatter e um filtro na frente, de modo que um evento entre em exatamente um deles.

Motivos típicos para querer isso: saída curta de uma linha para `Debug` e `Information` no console, mas timestamps completos, propriedades de contexto extras e o stack trace para `Error` e `Fatal`; ou um `errors.log` dedicado com um layout mais rico que o do log principal.

## A configuração ingênua que duplica erros

Esta é a configuração que a maioria das pessoas tenta primeiro, e o motivo de a pergunta aparecer:

```json
// appsettings.json, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } },
      { "Name": "Console", "Args": { "restrictedToMinimumLevel": "Error", "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} ({SourceContext}){NewLine}{Exception}" } }
    ]
  }
}
```

O programa de teste registra um evento por nível, com uma exceção no `Error`:

```csharp
// Program.cs, .NET 10, Serilog 4.4.0
using Microsoft.Extensions.Configuration;
using Serilog;

var config = new ConfigurationBuilder().AddJsonFile(args[0]).Build();
Log.Logger = new LoggerConfiguration().ReadFrom.Configuration(config).CreateLogger();

var orderId = 42;
Log.Debug("Cache warm for {Region}", "eu-west");
Log.Information("Order {OrderId} accepted", orderId);
Log.Warning("Order {OrderId} took {Elapsed} ms", orderId, 1830);
try { throw new InvalidOperationException("Payment gateway timed out"); }
catch (Exception ex) { Log.Error(ex, "Order {OrderId} failed", orderId); }
Log.Fatal("Shutting down: {Reason}", "unrecoverable");
Log.CloseAndFlush();
```

A saída:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23 ERR] Order 42 failed
[09:04:23 ERR] Order 42 failed ()
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23 FTL] Shutting down: unrecoverable
[09:04:23 FTL] Shutting down: unrecoverable ()
```

`restrictedToMinimumLevel` significa apenas "este nível e acima". O primeiro sink não tem limite superior, então `Error` e `Fatal` caem nos dois. Não existe um argumento `restrictedToMaximumLevel`. Você precisa de um filtro de verdade ou de uma condicional de verdade.

## Opção 1: um sink, um ExpressionTemplate com blocos #if

O `Serilog.Expressions` traz o `ExpressionTemplate`, um `ITextFormatter` cuja linguagem de template suporta `{#if <expr>}`, `{#else if <expr>}`, `{#else}` e `{#end}`. O nível atual é `@l`. O Serilog.Settings.Configuration consegue construí-lo direto a partir do JSON porque os sinks de console e de arquivo têm uma sobrecarga que recebe um `ITextFormatter formatter`, e o leitor de configurações associa um objeto com a chave `type` ao construtor desse tipo.

1. Adicione os pacotes:

```bash
# .NET 10 SDK; package versions as of October 2026
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Expressions --version 5.0.0
```

O `Serilog.AspNetCore` 10.0.0 traz o Serilog 4.x, o Serilog.Settings.Configuration e os sinks de console e de arquivo. Em um app de console simples ou em um worker, use `Serilog.Extensions.Hosting` (ou os pacotes individuais, como no projeto de teste).

2. Substitua `outputTemplate` por um objeto `formatter`:

```json
// appsettings.json, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Console",
        "Args": {
          "formatter": {
            "type": "Serilog.Templates.ExpressionTemplate, Serilog.Expressions",
            "template": "{#if @l = 'Debug'}  dbg {@m}\n{#else if @l in ['Information', 'Warning']}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#else}[{@t:yyyy-MM-dd HH:mm:ss.fff} {@l:u3}] {@m} {Rest()}\n{#if @x is not null}{@x}{#end}{#end}"
          }
        }
      }
    ]
  }
}
```

3. Execute. Três layouts diferentes saem de um único sink:

```text
  dbg Cache warm for eu-west
[09:04:47 INF] Order 42 accepted
[09:04:47 WRN] Order 42 took 1830 ms
[2026-10-26 09:04:47.048 ERR] Order 42 failed {"OrderId":42}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[2026-10-26 09:04:47.051 FTL] Shutting down: unrecoverable {"Reason":"unrecoverable"}
```

A sintaxe do template não é a clássica, então traduza conforme avança:

| `outputTemplate` clássico | `ExpressionTemplate` |
| --- | --- |
| `{Timestamp:HH:mm:ss}` | `{@t:HH:mm:ss}` |
| `{Level:u3}` | `{@l:u3}` |
| `{Message:lj}` | `{@m}` (já renderiza strings sem aspas) |
| `{Exception}` | `{@x}` |
| `{NewLine}` | um `\n` literal na string JSON |
| `{Properties:j}` | `{Rest()}` ou `{Rest(true)}` |
| `{SourceContext}` | `{SourceContext}` (inalterado) |

Dois detalhes dessa tabela importam na prática. `{NewLine}` não existe em expression templates; o `\n` na string JSON é uma quebra de linha real depois do parse do JSON, que é exatamente o que você quer, então não faça escape duplo. E `{@x}` já termina com uma quebra de linha, então `{@x}\n` imprime uma linha vazia depois de cada stack trace.

### Mostre propriedades de contexto apenas quando houver alguma

`Rest()` retorna as propriedades do evento que o *expression template* não referenciou. Ele ainda inclui as que aparecem no texto da mensagem, e é por isso que `{"OrderId":42}` aparece acima, mesmo que a mensagem já diga "Order 42". `Rest(true)` também exclui as propriedades referenciadas no message template, e você pode protegê-lo para que um `{}` vazio nunca seja impresso:

```json
"template": "{#if @l in ['Error', 'Fatal']}[{@t:HH:mm:ss.fff} {@l:u3}] {@m}{#if Rest(true) <> {}} {Rest(true)}{#end}\n{@x}{#else}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#end}"
```

Com um `TenantId` colocado no `LogContext` em volta da chamada `Log.Error`, isso produz:

```text
[09:05:30 DBG] Cache warm for eu-west
[09:05:30 INF] Order 42 accepted
[09:05:30 WRN] Order 42 took 1830 ms
[09:05:30.374 ERR] Order 42 failed {"TenantId":"acme"}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 13
[09:05:30.383 FTL] Shutting down: unrecoverable
```

A linha `Fatal` não tem chaves no final porque sua única propriedade, `Reason`, já está na mensagem.

## Opção 2: dois sub-loggers, cada um com seu próprio outputTemplate

Se você quer manter as strings clássicas de `outputTemplate`, ou os dois layouts vão para sinks diferentes (console vs arquivo, Seq vs arquivo), use o sink `Logger`. Ele cria um sub-logger com suas próprias seções `Filter`, `WriteTo` e `Enrich`. As expressões de filtro vêm novamente do `Serilog.Expressions`, que adiciona `ByIncludingOnly(string expression)` e `ByExcluding(string expression)`.

1. Faça os dois filtros serem complementares, para que cada evento vá para exatamente um sub-logger:

```json
// appsettings.json, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByExcluding", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } } ]
          }
        }
      },
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByIncludingOnly", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss.fff} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}" } } ]
          }
        }
      }
    ]
  }
}
```

2. Execute. Sem duplicatas, e o ramo de erro recebe milissegundos, propriedades e a exceção:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23.840 ERR] Order 42 failed {}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23.842 FTL] Shutting down: unrecoverable {}
```

O `{}` é o comportamento clássico de `{Properties:j}`: ele lista apenas as propriedades que ainda não estão na mensagem, e aqui não há nenhuma. Diferentemente de `Rest(true)`, ele não pode ser condicional, o que é um motivo prático para preferir a Opção 1 na saída do console.

### Quando restrictedToMinimumLevel sozinho basta

Se o segundo layout só precisa de "este nível e acima" *e* vai para um destino diferente, nenhum filtro é necessário. Um arquivo de erros dedicado é o caso comum:

```json
// appsettings.json, Serilog.Sinks.File 7.0.0
{
  "Name": "File",
  "Args": {
    "path": "logs/errors-.log",
    "rollingInterval": "Day",
    "restrictedToMinimumLevel": "Error",
    "outputTemplate": "{Timestamp:o} [{Level:u3}] {Message:lj}{NewLine}{Properties:j}{NewLine}{Exception}"
  }
}
```

O problema de duplicação da configuração ingênua só existe quando as duas saídas acabam no mesmo lugar.

## Integrando ao ASP.NET Core ou a um worker

Nada na escolha do template muda o código de hospedagem. Com o Serilog.AspNetCore 10.0.0:

```csharp
// Program.cs, ASP.NET Core on .NET 10 / .NET 11, Serilog.AspNetCore 10.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

var app = builder.Build();
app.MapGet("/", (ILogger<Program> log) =>
{
    log.LogError("Something failed for {OrderId}", 42);
    return "ok";
});
app.Run();
```

Como o formatter fica na configuração, você pode dar ao `appsettings.Development.json` um template compacto de uma linha e ao `appsettings.Production.json` um formatter JSON, sem tocar no código. O [post sobre Serilog com Seq](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) cobre o bootstrap logger e o `Log.CloseAndFlush()` em torno disso.

## Armadilhas encontradas durante os testes

**As comparações de nível diferenciam maiúsculas de minúsculas.** `@l = 'error'` é `false` para um evento `Error`. Use os nomes exatos `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal`, ou adicione o modificador `ci`: `@l = 'error' ci` foi avaliado como `true` no teste. O `{#if}` também precisa de um Boolean `true` de verdade; um valor não Boolean não é "truthy".

**Um sub-logger não pode ser mais verboso que o logger pai.** Com o `"MinimumLevel": "Information"` na raiz e `"MinimumLevel": "Debug"` dentro de `configureLogger`, o sub-logger ainda não imprimiu nada abaixo de `INF`. Os eventos são descartados pelo logger raiz antes mesmo de o sink `Logger` os ver. Defina o mínimo da raiz como o menor nível de que qualquer ramo precisa e aumente-o por ramo.

**Propriedades ausentes deixam o texto ao redor para trás.** Os dois estilos de template renderizam uma propriedade que o evento não tem como nada: o `({SourceContext})` da configuração ingênua imprimiu `()`, e em um `ExpressionTemplate`, `(OrderId={OrderId})` no evento `Fatal` imprimiu `(OrderId=)`. Só o expression template consegue corrigir isso: envolva propriedades opcionais em `{#if OrderId is not null} ... {#end}`.

**Nomes desconhecidos falham em silêncio.** `"Enrich": [ "WithMachineName" ]` sem o pacote `Serilog.Enrichers.Environment` instalado não lançou exceção. O único vestígio foi este, depois de habilitar `Serilog.Debugging.SelfLog.Enable(Console.Error)`:

```text
Unable to find a method called WithMachineName. Candidate methods are:
...
```

O mesmo vale para um nome de sink digitado errado ou um nome de filtro quando o `Serilog.Expressions` não está referenciado. Ligue o `SelfLog` na primeira vez que uma mudança de template parecer não fazer nada.

**Mantenha a seção `Using` se você publicar como arquivo único.** O Serilog.Settings.Configuration descobre automaticamente qualquer dependência com "Serilog" no nome por meio do `.deps.json`, então o projeto de teste funcionou sem `Using` algum. O README do projeto observa que a descoberta automática não funciona no modo empacotado (arquivo único), então liste `"Serilog.Expressions"` e todos os assemblies de sink explicitamente.

**Variáveis de ambiente sobrescrevem entradas de array por índice.** Um template por nível é uma string longa em `WriteTo:0:Args:formatter:template`. Sobrescrevê-lo a partir de um contêiner usa `Serilog__WriteTo__0__Args__formatter__template`, e o índice muda se alguém reordenar `WriteTo`. Se os templates diferem por ambiente, prefira um arquivo `appsettings.{Environment}.json`.

## Qual opção escolher

Use o `ExpressionTemplate` quando os layouts compartilham um único destino, tipicamente o console. É um sink, uma passada sobre o evento, e ele consegue fazer coisas que sub-loggers não conseguem, como esconder bags de propriedades vazias. Use sub-loggers quando os layouts vão para sinks diferentes ou precisam de enrichers diferentes, ou quando a equipe prefere templates clássicos que todos conseguem ler. De qualquer forma, o filtro ou a condição deve ser escrito sobre `@l`; não existe uma configuração de template indexada por nível para encontrar.

## Leitura relacionada

- Comece por [logging estruturado com Serilog e Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) se o Serilog ainda não estiver configurado.
- Para que o layout por nível mostre quem disparou um erro, [adicione o ID do usuário atual a cada entrada de log no ASP.NET Core](/pt-br/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/) com `LogContext`.
- Propriedades que aparecem em `Rest()` ou `{Properties:j}` podem vazar segredos; [redija valores sensíveis com `[LogProperties]`](/pt-br/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/) antes que cheguem a qualquer template.
- `{@m}` e `{Message:lj}` só permanecem estruturados se os pontos de chamada usarem message templates, que é o que [migrar da interpolação de strings do `ILogger` para message templates](/pt-br/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) resolve.
- Se você está deixando o Serilog pelo OpenTelemetry, veja [migrando do Serilog para o logging do OpenTelemetry](/pt-br/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/).

## Fontes

- [Serilog.Expressions README](https://github.com/serilog/serilog-expressions): `ExpressionTemplate`, built-ins `@l`/`@x`, `#if`/`#else if`, `Rest([deep])` e o modificador `ci`.
- [Serilog.Settings.Configuration README](https://github.com/serilog/serilog-settings-configuration): `Using` e descoberta automática (incluindo a limitação do modo empacotado), associação do `formatter` complexo com `type` e configuração de sub-logger.
- [Serilog wiki: Configuration Basics](https://github.com/serilog/serilog/wiki/Configuration-Basics): sub-loggers e por que eles não podem reduzir o nível mínimo do pai.
- [Serilog.Sinks.Console](https://github.com/serilog/serilog-sinks-console) e [Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file): parâmetros `outputTemplate`, `formatter` e `restrictedToMinimumLevel`.
- [Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore): `AddSerilog` com `ReadFrom.Configuration` e `ReadFrom.Services`.
