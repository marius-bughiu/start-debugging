---
title: "Como redigir valores sensíveis dos logs com LogProperties e redação de dados no .NET"
description: "Guia completo para redigir dados classificados em logs gerados por código-fonte: construa uma taxonomia, escreva um Redactor, conecte EnableRedaction e AddRedaction, e entenda o discriminador que quebra silenciosamente o mascaramento parcial. Com saída real do Microsoft.Extensions.Compliance.Redaction 10.9.0."
pubDate: 2026-08-17
template: how-to
tags:
  - "dotnet"
  - "logging"
  - "security"
  - "source-generators"
lang: "pt-br"
translationOf: "2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet"
translatedBy: "claude"
translationDate: 2026-08-17
---

Redigir valores sensíveis nos logs do .NET exige três peças que precisam estar todas presentes: um atributo de classificação de dados na propriedade, `AddRedaction` para registrar os redatores na injeção de dependência, e `EnableRedaction` no builder de log. Se faltar a classificação, nada é protegido. Se faltar `EnableRedaction`, os valores classificados são removidos por completo do estado estruturado. Se faltar `AddRedaction` com `EnableRedaction` ligado, os valores brutos são escritos nos seus logs em texto puro. Este artigo percorre as três peças, mais o discriminador de redação que quebra sem avisar qualquer redator que faça mascaramento parcial.

Tudo abaixo foi compilado e executado com `Microsoft.Extensions.Compliance.Redaction` 10.9.0, `Microsoft.Extensions.Compliance.Abstractions` 10.9.0 e `Microsoft.Extensions.Telemetry` 10.9.0, no SDK do .NET 10.0.201 mirando `net10.0`. Esses pacotes são publicados na cadência do `dotnet/extensions` e não na do runtime, e o 10.9.0 (publicado em 2026-08-11) mira `net8.0`, `net9.0`, `net10.0` e `net462`, então o mesmo código vale do .NET 8 até as previews atuais do .NET 11. Ainda não existe uma versão 11.x desses pacotes.

## O que o gerador de código-fonte realmente emite para uma propriedade classificada

Todo o recurso se apoia em uma coisa só: o gerador de código-fonte do `[LoggerMessage]` emite os valores classificados em um *array separado* do das tags comuns. Dado este método de log:

```csharp
// Microsoft.Extensions.Telemetry.Abstractions 10.9.0, net10.0
public static partial class Log
{
    [LoggerMessage(2, LogLevel.Information, "Via LogProperties")]
    public static partial void ViaProps(this ILogger logger, [LogProperties] Payment payment);
}
```

o gerador produz (cortado, mas no restante literal de `EmitCompilerGeneratedFiles`):

```csharp
var state = LoggerMessageHelper.ThreadLocalState;

_ = state.ReserveTagSpace(2);
state.TagArray[1] = new("{OriginalFormat}", "Via LogProperties");
state.TagArray[0] = new("payment.Amount", payment?.Amount);

_ = state.ReserveClassifiedTagSpace(2);
state.ClassifiedTagArray[1] = new("payment.CardNumber", payment?.CardNumber,
    new DataClassificationSet(_SensitiveAttribute));
state.ClassifiedTagArray[0] = new("payment.Cvv", payment?.Cvv,
    new DataClassificationSet(_SensitiveAttribute));
```

`Amount` vai para `TagArray`. `CardNumber` e `Cvv` vão para `ClassifiedTagArray` junto com o `DataClassificationSet` que veio do atributo. Nada aqui redige coisa alguma: o gerador apenas *rotula* os valores. Quem consumir `LoggerMessageState` decide o que acontece em seguida, e é por isso que a conexão importa tanto. Se você ainda não conhece como o `[LoggerMessage]` gera código, vale o desvio por [o que é um gerador de código-fonte e quando você precisa de um](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## Construindo a taxonomia, os atributos e um redator

Uma classificação é um par `(TaxonomyName, Value)`. Defina-as uma única vez em uma classe estática para que toda a solução compartilhe o mesmo vocabulário:

```csharp
// Microsoft.Extensions.Compliance.Abstractions 10.9.0
using Microsoft.Extensions.Compliance.Classification;

public static class Taxonomy
{
    public const string Name = "Contoso";

    public static DataClassification Sensitive => new(Name, nameof(Sensitive));
    public static DataClassification Pii => new(Name, nameof(Pii));
}
```

Os exemplos do MS Learn para esse recurso mostram parâmetros classificados escritos como `[MyTaxonomyClassifications.Private] string SSN`. Isso não compila: uma propriedade estática não é um atributo. Você precisa de uma subclasse real de `DataClassificationAttribute` para cada classificação, que é o que a [documentação de classificação de dados](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification) descreve corretamente:

```csharp
public sealed class SensitiveAttribute : DataClassificationAttribute
{
    public SensitiveAttribute() : base(Taxonomy.Sensitive) { }
}

public sealed class PiiAttribute : DataClassificationAttribute
{
    public PiiAttribute() : base(Taxonomy.Pii) { }
}
```

Agora decore o modelo. Tudo que não tiver atributo é registrado como está:

```csharp
public sealed class Payment
{
    [Sensitive] public string CardNumber { get; set; } = "";
    [Pii] public string Email { get; set; } = "";
    public int Amount { get; set; }
    [LogPropertyIgnore] public string InternalTrace { get; set; } = "";
}
```

Um redator é uma classe abstrata com dois membros. `GetRedactedLength` dimensiona o buffer de destino, `Redact` o preenche e devolve quantos caracteres escreveu:

```csharp
// Microsoft.Extensions.Compliance.Redaction 10.9.0
using Microsoft.Extensions.Compliance.Redaction;

public sealed class LastFourRedactor : Redactor
{
    public override int GetRedactedLength(ReadOnlySpan<char> input)
        => input.Length <= 4 ? input.Length : 4 + 4;

    public override int Redact(ReadOnlySpan<char> source, Span<char> destination)
    {
        if (source.Length <= 4)
        {
            source.CopyTo(destination);
            return source.Length;
        }

        "****".CopyTo(destination);
        source[^4..].CopyTo(destination[4..]);
        return 8;
    }
}
```

A assinatura baseada em spans é deliberada: o pipeline de log redige de span para span através de um `JustInTimeRedactor` de pool, então um redator bem escrito não aloca nada por registro de log.

## Como conectar tudo

Quatro passos, e os quatro são essenciais:

1. Instale `Microsoft.Extensions.Compliance.Redaction` para os redatores e `Microsoft.Extensions.Telemetry` para a integração com o log. Os tipos de classificação chegam de forma transitiva por `Microsoft.Extensions.Compliance.Abstractions`.
2. Chame `AddRedaction` na coleção de serviços e mapeie cada classificação para um redator.
3. Chame `EnableRedaction` no builder de log. Isso substitui pelo `ExtendedLogger`, o único componente que lê `ClassifiedTagArray`.
4. Registre através de um método `[LoggerMessage]` gerado por código-fonte. A redação não se aplica a `logger.LogInformation(...)`.

```csharp
var services = new ServiceCollection();

services.AddLogging(b =>
{
    b.AddJsonConsole();
    b.EnableRedaction();          // Microsoft.Extensions.Logging namespace
});

services.AddRedaction(r =>
{
    r.SetRedactor<LastFourRedactor>(Taxonomy.Sensitive);
    r.SetFallbackRedactor<ErasingRedactor>();
});
```

`EnableRedaction` fica no namespace `Microsoft.Extensions.Logging` apesar de ser distribuído no pacote `Microsoft.Extensions.Telemetry`, então o `using Microsoft.Extensions.Telemetry;` do exemplo oficial não é necessário.

## As três configurações e o que cada uma realmente registra

É aqui que o recurso morde. Este é o mesmo `Payment` registrado sob três conexões diferentes, tirado da saída real do `JsonConsole`.

**`AddRedaction` registrado, `EnableRedaction` não chamado.** O `ILogger` comum nunca olha para `ClassifiedTagArray`, então as propriedades classificadas ficam ausentes do estado estruturado e a mensagem achatada mostra um marcador:

```json
{"State":{"Message":"customer.Plan=enterprise,customer.Id=42,customer.CardNumber=<omitted> ([Contoso:Sensitive]),customer.Email=<omitted> ([Contoso:Pii])","customer.Plan":"enterprise","customer.Id":42}}
```

Não há vazamento, mas também não há dados, e nenhum erro avisa que a redação está desligada. Esse comportamento está registrado na [issue 5163 do dotnet/extensions](https://github.com/dotnet/extensions/issues/5163).

**`EnableRedaction` chamado, `AddRedaction` nunca chamado.** Este é o perigoso. Sem nenhum `IRedactorProvider` no contêiner, o pipeline cai em um redator de passagem direta e escreve o valor bruto:

```json
{"State":{"customer.CardNumber":"4111111111111111:customer.CardNumber","customer.Email":"ada@contoso.com:customer.Email"}}
```

Seus números de cartão estão agora no arquivo de log, com o nome da tag gentilmente anexado. Nada avisa você. Se você levar uma única coisa deste artigo: `EnableRedaction` e `AddRedaction` precisam ser adicionados juntos, e um teste de integração que procure um segredo conhecido no destino dos logs é um seguro barato.

**Ambos chamados.** Os valores classificados são redigidos, os não classificados passam intactos, e as propriedades com `[LogPropertyIgnore]` não aparecem de jeito nenhum:

```json
{"State":{"payment.Email":"****","payment.CardNumber":"****","payment.Amount":1999}}
```

Chamar `AddRedaction()` sem configuração nenhuma é seguro: o fallback padrão é `ErasingRedactor`, então todo valor classificado vira uma string vazia. Verificado diretamente contra o provider, `GetRedactor` devolve `ErasingRedactor` para uma classificação não mapeada e para `DataClassification.Unknown`, e `NullRedactor` (passagem direta) apenas para `DataClassification.None`.

## O discriminador que quebra o mascaramento parcial

Registre o `LastFourRedactor` de antes, registre um número de cartão `4111111111111111`, e você recebe isto:

```json
{"payment.CardNumber":"****mber","payment.Email":"****mail"}
```

`mber` são os últimos quatro caracteres de `payment.CardNumber`, não os do cartão. O redator nunca viu o valor sozinho. Instrumentar `Redact` com um espião mostra exatamente o que chega:

```text
[spy] Redact saw: "4111111111111111:payment.CardNumber" (len 35)
[spy] Redact saw: "ada@contoso.com:payment.Email"      (len 29)
```

Isso é intencional, não um bug. O `ExtendedLogger` constrói cada redação através de `JustInTimeRedactor.Get(value, redactor, discriminator)` onde o discriminador é o nome da tag, e `LoggerRedactionOptions.ApplyDiscriminator` vale `true` por padrão. A justificativa documentada é resistência à correlação: incluir o nome da tag no texto redigido torna impossível saber que um `user.Email` com hash e um `contact.Email` com hash são o mesmo endereço. Esse é um padrão genuinamente bom para redatores que fazem hash, e um bug de correção silencioso para qualquer coisa que inspecione a entrada.

A correção é uma única opção:

```csharp
b.EnableRedaction(o => o.ApplyDiscriminator = false);
```

Com o discriminador desligado, o mesmo redator produz o que você esperava:

```json
{"payment.CardNumber":"****1111","payment.Email":"****.com"}
```

Desligue apenas para redatores que precisam ver o valor real. Se você depende de valores com hash para identificar reincidentes dentro de um mesmo campo, deixe ligado. Note que um redator invocado diretamente por `IRedactorProvider` nunca vê um discriminador, então um teste unitário do seu redator isolado vai passar enquanto o pipeline de log se comporta mal. Teste através do logger.

## Fazer hash em vez de apagar

O `HmacRedactor` produz um hash `HMACSHA256` estável, o que permite correlacionar ocorrências do mesmo valor sem armazená-lo:

```csharp
#pragma warning disable EXTEXP0002
services.AddRedaction(r => r.SetHmacRedactor(o =>
{
    o.KeyId = 42;
    o.Key = Convert.ToBase64String(keyBytes);   // base64, at least 44 chars
}, Taxonomy.Pii));
#pragma warning restore EXTEXP0002
```

Saída real, com `ApplyDiscriminator` desligado:

```json
{"payment.Email":"42:AjapxXMS14J9i8GFw62JBQ==","payment.CardNumber":""}
```

O prefixo `42:` é o `KeyId`, então você consegue saber qual chave produziu um hash depois de uma rotação. Duas ressalvas. `SetHmacRedactor` é experimental e gera `EXTEXP0002`, então você precisa de uma supressão explícita ou de `<NoWarn>$(NoWarn);EXTEXP0002</NoWarn>`. E o `CardNumber` saiu vazio acima porque está classificado como `Sensitive`, que aqui não tem redator mapeado e por isso cai no fallback `ErasingRedactor`. Mapeie todas as classificações que você definir, ou o fallback vai decidir por você em silêncio.

## O resto da superfície do LogProperties

`[LogProperties]` tem mais botões do que a maioria usa:

```csharp
[LoggerMessage(4, LogLevel.Information, "Charging customer")]
public static partial void Charging(this ILogger logger,
    [LogProperties(OmitReferenceName = false, SkipNullProperties = true)] Customer customer);
```

`OmitReferenceName` vale `false` por padrão, que é o que produz o prefixo `customer.` em cada nome de tag; coloque em `true` e as tags viram simplesmente `Id`, `Plan`, e assim por diante. `SkipNullProperties = true` omite do estado as propriedades com valor nulo em vez de escrever nulos. Ambas são opções normais de tempo de compilação, sem custo em tempo de execução.

Objetos aninhados não são percorridos por padrão. Um `Customer.Address` de tipo complexo produz um aviso de compilação em vez de virar string em silêncio:

```text
warning LOGGEN036: The type "Address?" doesn't implement ToString(), IConvertible, or IFormattable
(did you forget to apply [LogProperties] or [TagProvider] to "Address"?)
```

Corrija colocando `[LogProperties]` na própria propriedade aninhada, que então emite tags `customer.Address.Street`, incluindo os atributos de classificação em `Address`. Existe também `[LogProperties(Transitive = true)]` para percorrer o grafo automaticamente, mas é marcado como experimental e falha a compilação com `EXTEXP0003` até ser suprimido.

## Classificar valores que você não pode atribuir

Atributos só funcionam em tipos que são seus. Para um DTO de terceiros, ou quando a classificação depende do estado em tempo de execução, use `[TagProvider]` e classifique dentro de um método coletor escrito à mão:

```csharp
public static class SessionTagProvider
{
    public static void Provide(ITagCollector collector, Session session)
    {
        collector.Add("user", session.User);
        collector.Add("token", session.Token, new DataClassificationSet(Taxonomy.Sensitive));
    }
}

[LoggerMessage(2, LogLevel.Information, "Session opened")]
public static partial void Opened(this ILogger logger,
    [TagProvider(typeof(SessionTagProvider), nameof(SessionTagProvider.Provide),
                 OmitReferenceName = true)] Session session);
```

A sobrecarga de `ITagCollector.Add` que recebe um `DataClassificationSet` é o equivalente programático de um atributo de classificação, e o valor flui para `ClassifiedTagArray` exatamente da mesma forma. Atenção aos nomes: por padrão o nome do parâmetro é prefixado à chave que você passar, então `collector.Add("session.token", ...)` em um parâmetro chamado `session` emite a tag `session.session.token`. Passe chaves simples e deixe o nome do parâmetro fornecer o prefixo, ou passe chaves simples e defina `OmitReferenceName = true` para eliminar o prefixo por completo. Não escreva o prefixo você mesmo.

## Provando com um teste

O `FakeLogger`, do `Microsoft.Extensions.Diagnostics.Testing` 10.9.0, roda por trás do mesmo `ExtendedLogger`, então a redação se aplica e as tags redigidas ficam legíveis através do `FakeLogCollector`. Isso torna direta a asserção sobre vazamento:

```csharp
var services = new ServiceCollection();
services.AddLogging(b => { b.AddFakeLogging(); b.EnableRedaction(); });
services.AddRedaction(r => r.SetRedactor<StarRedactor>(Taxonomy.Sensitive));

using var sp = services.BuildServiceProvider();
sp.GetRequiredService<ILoggerFactory>().CreateLogger("T")
  .Taken(new Payment { CardNumber = "4111111111111111", Amount = 1999 });

var records = sp.GetRequiredService<FakeLogCollector>().GetSnapshot();
Assert.DoesNotContain("4111111111111111",
    string.Join('\n', records.SelectMany(r => r.StructuredState ?? [])
                             .Select(kv => $"{kv.Key}={kv.Value}")));
```

O estado estruturado desse registro é exatamente `payment.CardNumber = ****`, `payment.Amount = 1999`, `{OriginalFormat} = Payment taken`. Faça a asserção sobre a ausência do segredo e não sobre a presença de `****`, para que o teste continue detectando uma regressão se alguém trocar o redator.

Duas coisas me surpreenderam. A redação só se aplica aos métodos de log gerados por código-fonte, então qualquer `logger.LogInformation($"card {card}")` que ainda exista no código está completamente desprotegido. Se você ainda não fez essa varredura, [converter as chamadas interpoladas do ILogger para templates de mensagem](/pt-br/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) é o pré-requisito de todo esse recurso. Segundo, `EnableRedaction` muda o que o `JsonConsole` escreve no campo aninhado `State.Message`: ele vira a string literal `Microsoft.Extensions.Logging.ExtendedLogger+ModernTagJoiner`. O `Message` de nível superior continua correto e todas as tags individuais continuam presentes, mas se você tiver um parser adiante lendo `State.Message`, ele vai quebrar. Destinos estruturados que enumeram o estado, como os cobertos no [guia de configuração do Serilog e Seq](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) ou um [pipeline de log com OpenTelemetry](/pt-br/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/), não são afetados.

O argumento mais forte a favor desse recurso é que a classificação vive no modelo, ao lado da propriedade, onde quem adicionar um campo vai vê-la. A política de redação vive em uma única chamada na raiz de composição que um revisor de segurança consegue ler em dez segundos. Essa separação vale o custo de configuração, desde que você realmente verifique: adicione um teste que registre um modelo totalmente preenchido em um destino em memória e falhe se qualquer string secreta conhecida aparecer na saída.

## Fontes

- [Geração de log por código-fonte em tempo de compilação](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/source-generation), MS Learn
- [Classificação de dados no .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification), MS Learn
- [Redação de dados no .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-redaction), MS Learn
- [ExtendedLogger.ModernPath](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/ExtendedLogger.cs) e [JustInTimeRedactor](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/JustInTimeRedactor.cs), dotnet/extensions
- [LoggerRedactionOptions.ApplyDiscriminator](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/LoggerRedactionOptions.cs), dotnet/extensions
- [Issue 5163 do dotnet/extensions](https://github.com/dotnet/extensions/issues/5163), sobre a saída do LogProperties quando a redação está desabilitada
