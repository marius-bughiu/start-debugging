---
title: "Fix: The JSON value could not be converted to System.DateTime"
description: "System.Text.Json só aceita strings ISO 8601 para DateTime. Envie 2026-05-08T14:00:00Z ou registre um JsonConverter que parseie seu formato. Strings vazias e timestamps Unix também lançam."
pubDate: 2026-05-08
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "pt-br"
translationOf: "2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime"
translatedBy: "claude"
translationDate: 2026-05-08
---

A correção: `System.Text.Json` só desserializa um `DateTime` a partir de uma string JSON em formato ISO 8601 estendido, como `"2026-05-08T14:00:00Z"` ou `"2026-05-08T14:00:00+02:00"`. Se o seu produtor envia `"05/08/2026"`, uma string vazia `""`, um número de timestamp Unix, ou o `"/Date(1746715200000)/"` do Newtonsoft, o desserializador lança. Ou você muda o formato no fio para ISO 8601, ou registra um `JsonConverter<DateTime>` que saiba parsear o que você de fato recebe.

```text
System.Text.Json.JsonException: The JSON value could not be converted to System.DateTime. Path: $.startedAt | LineNumber: 0 | BytePositionInLine: 27.
   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, JsonReaderException ex)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
 ---> System.FormatException: The JSON value is not in a supported DateTime format.
```

Este guia foi escrito contra .NET 11 preview 4 e `System.Text.Json` 11.0.0-preview.4. O formato aceito e a exceção não mudaram desde que `System.Text.Json` foi lançado no .NET Core 3.0; o texto da `FormatException` interna foi o que se ajustou em torno do .NET 8. O segmento `Path` é o caminho JSON da propriedade ofensiva e é a primeira coisa a ler, ele te diz em qual campo o conversor engasgou sem você ter que instrumentar nada.

## Por que System.Text.Json é tão exigente

`System.Text.Json` implementa deliberadamente apenas o [perfil ISO 8601-1:2019 Extended](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support) para `DateTime` e `DateTimeOffset`. O formato deve ser `YYYY-MM-DDTHH:mm:ss[.fffffff][Z|+hh:mm]` com um literal `T` como separador. `t` minúsculo, espaço como separador, o estilo americano `MM/dd/yyyy`, anos de dois dígitos, segundos faltando, e valores só de hora ou só de data são todos rejeitados. Também o token JSON `null` a menos que a propriedade seja um `DateTime?` anulável, e também uma string vazia `""`.

Isso é por design: o parser permissivo de múltiplos formatos do Newtonsoft.Json causava bugs reais em que um produtor numa região enviava `01/05/2026` e um consumidor em outra parseava silenciosamente como a data errada. `System.Text.Json` trata o parseamento de DateTime do mesmo jeito que trata números em JSON: uma forma canônica, sem adivinhação.

Então o desserializador está correto em lançar. O trabalho é ou fazer o fio se conformar, ou registrar um conversor que mapeie o seu formato do fio para um `DateTime` exatamente uma vez.

## Uma reprodução mínima

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

record Event(DateTime StartedAt);

var bad = """{ "startedAt": "05/08/2026" }""";
var ev = JsonSerializer.Deserialize<Event>(bad); // throws
```

O produtor enviou uma data com barras no estilo americano e `System.Text.Json` não conhece esse formato. O mesmo erro dispara para qualquer um destes payloads:

```json
{ "startedAt": "" }
{ "startedAt": "2026-05-08" }
{ "startedAt": 1746715200 }
{ "startedAt": "/Date(1746715200000)/" }
{ "startedAt": "2026-05-08 14:00:00" }
{ "startedAt": "Friday, May 8, 2026" }
```

Cada um falha por um motivo diferente. A string vazia não é parseável como data. A data nua `"2026-05-08"` está sem o componente de hora, ISO 8601 Extended exige o `T` e uma hora. O número de timestamp Unix não consegue se vincular a `DateTime` de jeito nenhum. A sintaxe `/Date(...)` é um artefato histórico do Newtonsoft. O formato separado por espaço é ISO 8601 Basic, não Extended. A forma longa em inglês não é um formato de máquina.

## Correção, em detalhes

### 1. Faça o produtor enviar ISO 8601

A resposta certa é consertar na origem. ISO 8601 Extended com um `T` e um `Z` UTC (ou um offset explícito) faz round-trip entre todas as stacks modernas: `Date.prototype.toISOString()` do JavaScript, `datetime.isoformat()` do Python, `to_char(... 'YYYY-MM-DD"T"HH24:MI:SSOF')` do Postgres, `Instant.toString()` do Java, e `DateTime.UtcNow.ToString("o")` no .NET, todos emitem isso.

```csharp
// .NET 11, C# 14
var iso = DateTime.UtcNow.ToString("o"); // 2026-05-08T14:00:00.0000000Z
```

Se você controla o produtor, é uma linha de trabalho. Evite `"u"` (usa um espaço como separador, não um `T`) e evite stringificar `DateTime.Now` sem um offset, o que cria valores com kind `Unspecified` que fazem round-trip de forma ambígua.

### 2. Registre um JsonConverter para formatos não-ISO

Quando você não pode mudar o produtor (API de terceiros, payload legado), escreva um conversor. O padrão do conversor é o mesmo independentemente do formato de origem, a única coisa que muda é a chamada de parseamento.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class UsSlashDateConverter : JsonConverter<DateTime>
{
    private const string Format = "MM/dd/yyyy";

    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return DateTime.ParseExact(
            text!, Format, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture));
}
```

Registre uma vez nas opções, não instancie a cada ponto de chamada:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    Converters = { new UsSlashDateConverter() }
};
var ev = JsonSerializer.Deserialize<Event>(bad, options);
```

Sempre passe `CultureInfo.InvariantCulture` e fixe o formato exato com `ParseExact`. `Parse` e `TryParse` se apoiam na cultura atual e reintroduzem a mesma ambiguidade que ISO 8601 foi projetado para remover. Para detalhes do andaime do conversor, o [tutorial de JsonConverter customizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) cobre os truques de hot path (`Utf8JsonReader.ValueSpan`, parseamento com span) que importam quando o conversor está num pipeline de alto throughput.

### 3. Converta timestamps Unix com um leitor que reconhece números

Se o fio envia um número (`"startedAt": 1746715200`), `reader.GetString()` vai lançar porque o token é `Number`, não `String`. Bifurque com base em `TokenType`:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class UnixSecondsConverter : JsonConverter<DateTime>
{
    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        return reader.TokenType switch
        {
            JsonTokenType.Number => DateTimeOffset.FromUnixTimeSeconds(reader.GetInt64()).UtcDateTime,
            JsonTokenType.String when long.TryParse(reader.GetString(), out var s)
                => DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime,
            JsonTokenType.String
                => DateTime.Parse(reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            _ => throw new JsonException($"Unexpected token {reader.TokenType} for DateTime.")
        };
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteNumberValue(new DateTimeOffset(value, TimeSpan.Zero).ToUnixTimeSeconds());
}
```

Este é o conversor que você escreve para APIs REST mais antigas que misturam payloads de string e número (Twitter, Stripe, campos legados do Slack). `DateTimeOffset.FromUnixTimeSeconds` é o helper certo, não multiplique por 10.000 para fazer um valor `Ticks`, esse caminho perde precisão sub-segundo e ignora a diferença de epoch.

### 4. Trate strings vazias como null

Uma esquisitice comum de API é enviar `""` para "sem data". O desserializador não consegue vincular uma string vazia nem a `DateTime` nem a `DateTime?`. Faça a propriedade anulável e adicione um conversor que retorne `null` em entrada vazia:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class NullableEmptyDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        var text = reader.GetString();
        if (string.IsNullOrEmpty(text)) return null;
        return DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime? value,
        JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value.Value.ToString("o", CultureInfo.InvariantCulture));
    }
}
```

Aplique por propriedade se só um campo se comporta mal, com `[JsonConverter(typeof(NullableEmptyDateTimeConverter))]` na propriedade. O registro global acima substitui o conversor padrão para cada `DateTime?` no grafo; o atributo por propriedade é mais estreito e mais seguro.

### 5. Use DateOnly quando não há hora

Se o fio é de fato `"2026-05-08"` (uma data de calendário sem horário do dia), o tipo no consumidor deveria ser `DateOnly`, não `DateTime`. `System.Text.Json` 8.0+ tem suporte nativo e aceita o formato de data ISO 8601 diretamente:

```csharp
// .NET 11, C# 14
record Event(DateOnly StartedOn);

var json = """{ "startedOn": "2026-05-08" }""";
var ev = JsonSerializer.Deserialize<Event>(json); // works, no converter needed
```

`DateOnly` foi adicionado no .NET 6 especificamente porque data-sem-hora era o bug de modelagem relacionado a DateTime mais comum. Se o seu domínio realmente é um dia do calendário (um aniversário, uma data de entrega, um feriado), troque os tipos e o problema de parseamento JSON evapora.

## Formas comuns que disparam isso

### A propriedade é um struct DateTime mas o valor pode estar ausente

Um `DateTime` não anulável não consegue armazenar "ausente". O produtor envia `null` ou `""`, o desserializador lança. Faça a propriedade `DateTime?`. Se você não controla o esquema, `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` limpa o round-trip na saída, mas o caminho de leitura ainda precisa ser anulável.

### Um formato de data configurado do Newtonsoft vazou para o contrato

Se você está migrando do Newtonsoft.Json, seu código antigo provavelmente tinha `IsoDateFormatString = "MM/dd/yyyy"` ou um `DateTimeFormat` definido num `JsonSerializerSettings`. Newtonsoft aceitava, `System.Text.Json` não honra essa configuração de jeito nenhum. Procure no seu repositório por `DateFormatHandling`, `DateTimeFormat` e `IsoDateFormatString`, e ou conserte o produtor ou escreva o conversor acima. O time do vstest [removeu a dependência transitiva do Newtonsoft.Json](/pt-br/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) no .NET 11 preview 4 por motivos similares de aperto de contrato.

### O model binding do MVC engole a exceção interna

No ASP.NET Core, uma data inválida no corpo da requisição produz um `400 Bad Request` com `{"errors":{"$.startedAt":["The JSON value could not be converted to System.DateTime..."]}}`. O `Path: $.startedAt` da exceção interna vai parar no dicionário `errors`. Se você só vê "One or more validation errors occurred", veja o corpo da resposta, o caminho ofensor está lá.

### Os source generators escondem o registro do conversor

Quando você opta pela geração de código-fonte do `System.Text.Json` com `[JsonSerializable]` e um `JsonSerializerContext`, você precisa registrar conversores no mesmo contexto, não apenas num `JsonSerializerOptions` em runtime. O gerador emite `TypeInfo` para cada tipo raiz em tempo de compilação, e um conversor que você esqueceu de cabear no contexto é invisível em runtime. O [post sobre interceptors e geração de código-fonte](/pt-br/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) percorre a forma de registro que sobrevive a trimming e AOT.

### Fuso horário embutido no nome da propriedade, não no valor

Um esquema como `{"startedAtUtc": "2026-05-08T14:00:00"}` (sem `Z`, mas o nome da propriedade afirma UTC) parseia para `DateTimeKind.Unspecified`. Não lança, mas faz round-trip errado: `ToUniversalTime` vai tratá-lo como local. Ou conserte o produtor para emitir o `Z`, ou use `DateTimeOffset` para que o offset seja explícito. Melhor ainda, modele o valor como `DateTime` com um conversor que afirme `Kind == Utc` e lance em qualquer outra coisa, o padrão de conversor estrito captura a deriva cedo.

## Variantes que parecem este erro mas não são

### "The JSON value could not be converted to System.DateTimeOffset"

Mesma família de causa raiz, domínio levemente diferente. `DateTimeOffset` exige um offset explícito (`Z` ou `+hh:mm`) e rejeita strings com forma `Unspecified` que um `DateTime` nu aceitaria. A correção tem a mesma forma: envie o offset, ou escreva um conversor. Evite fazer round-trip de um `DateTimeOffset` através de um `DateTime` se você tem um no domínio, a informação do offset é dado.

### "Cannot get the value of a token type 'Number' as a String"

Exceção diferente, stack diferente. Significa que o conversor ou o leitor padrão chamou `GetString()` num token JSON `Number`. A correção é bifurcar com base em `reader.TokenType` antes de ler. O conversor da variante 3 acima é a forma canônica.

### "A possible object cycle was detected"

Ciclo de referência, não parseamento de data. Defina `ReferenceHandler = ReferenceHandler.IgnoreCycles` (ou `Preserve` para round-trip completo do grafo) nas opções. Percorre os trade-offs no [guia de tratamento de ciclos](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) (o mesmo post sobre conversor cobre a opção de ciclos na sua seção de gotchas).

### "The JSON value could not be converted to System.Guid"

Classe de exceção idêntica (`JsonException`), forma de mensagem idêntica, tipo alvo diferente. A causa é similar: a string Guid não está em nenhum dos quatro formatos que `System.Text.Json` aceita (`D`, `N`, `B`, `P`). A correção é novamente ou consertar o produtor para enviar `D` (a forma com hífens) ou escrever um conversor que chame `Guid.ParseExact`.

### "The JSON value could not be converted to System.Enum"

Mesma família. A correção é `JsonStringEnumConverter` (nativo) registrado nas opções; o conversor aceita tanto formas numéricas quanto de string e é configurável para sensibilidade de caixa. Por enum também é possível com `[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]` a partir do .NET 8, o que é preferível sob trimming porque não reflete sobre cada enum no assembly.

## Relacionado

Para o andaime do conversor em que as correções acima se apoiam, o [tutorial de JsonConverter customizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) cobre os truques de parseamento com span de bytes para hot paths. O [post sobre nomeação por membro PascalCase](/pt-br/2026/04/system-text-json-11-pascalcase-per-member-naming/) mostra os escapes `[JsonPropertyName]` e de política de nomeação que resolvem os erros 400 relacionados de "nome de propriedade errado". Se o seu DateTime é persistido como coluna JSON no EF Core 11, o [tutorial de JSON contains do SQL Server 2025](/pt-br/2026/04/efcore-11-json-contains-sql-server-2025/) explica como o banco de dados faz round-trip da mesma string ISO 8601. Para o diagnóstico paralelo de "tipo errado" com implicações de grafo maiores, a [trilha de migração de Newtonsoft para System.Text.Json](/pt-br/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) é o estudo de caso canônico do próprio time do .NET.

## Fontes

- [DateTime and DateTimeOffset support in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support), Microsoft Learn.
- [How to write custom converters](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to), Microsoft Learn.
- [`DateTimeStyles` enumeration](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.datetimestyles), Microsoft Learn.
- [`DateTimeOffset.FromUnixTimeSeconds`](https://learn.microsoft.com/en-us/dotnet/api/system.datetimeoffset.fromunixtimeseconds), Microsoft Learn.
- [System.Text.Json source repository](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Text.Json), dotnet/runtime on GitHub.
- [`DateOnly` and `TimeOnly` types](https://learn.microsoft.com/en-us/dotnet/api/system.dateonly), Microsoft Learn.
