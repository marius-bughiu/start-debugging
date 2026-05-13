---
title: "Fix: System.Text.Json.JsonException: The JSON value could not be converted"
description: "System.Text.Json lança esta exceção quando o token JSON recebido não corresponde ao tipo CLR de destino. Faça o JSON corresponder ao tipo, ou registre um JsonConverter ou uma JsonSerializerOption que os reconcilie."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "pt-br"
translationOf: "2026/05/fix-jsonexception-the-json-value-could-not-be-converted"
translatedBy: "claude"
translationDate: 2026-05-13
---

A correção: `System.Text.Json` lançou esta exceção porque o token JSON no caminho indicado não pode ser desserializado para o tipo CLR de destino. A mensagem geralmente aparece em duas formas. Ou o JSON tem o **tipo de token** errado (uma string onde se esperava um número, ou vice-versa, ou um número onde se esperava um valor de enum), ou o JSON tem o tipo correto mas o **conteúdo** não corresponde às regras de parsing do tipo (uma data fora do ISO, um `Guid` malformado, um literal como `"NaN"`). Escolha uma de três correções por ponto de chamada: mude o produtor para emitir o formato JSON esperado, opte por um converter que aceite o formato que você de fato recebe (`JsonStringEnumConverter`, `JsonNumberHandling.AllowReadingFromString`), ou escreva um `JsonConverter<T>` que faça o parsing você mesmo.

```text
System.Text.Json.JsonException: The JSON value could not be converted to MyApp.OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 21.
   at System.Text.Json.ThrowHelper.ThrowJsonException(String message)
   at System.Text.Json.Serialization.Converters.EnumConverter`1.Read(Utf8JsonReader& reader, Type typeToConvert, JsonSerializerOptions options)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
```

Este guia foi escrito contra .NET 11 preview 4 e `System.Text.Json` 11.0.0-preview.4. O tipo de exceção e os campos `Path` / `LineNumber` / `BytePositionInLine` mantêm-se estáveis desde que `System.Text.Json` foi lançado no .NET Core 3.0, então cada correção a seguir vale para .NET 6, 8, 10 e 11 sem mudanças. As únicas partes que mudam entre versões são os ajustes do converter: `JsonNumberHandling` chegou no .NET 5, `JsonStringEnumConverter<TEnum>` (a versão genérica, compatível com AOT) foi lançado no .NET 8, e o atributo `[JsonStringEnumMemberName]` apareceu no .NET 9.

A primeira coisa a ler é o segmento **`Path`**. É um caminho no estilo JSON Pointer com `$` como raiz, e ele diz exatamente qual propriedade engasgou o leitor. Os mecanismos de busca tendem a levar você a um stack trace que cita um converter genérico ("the JSON value could not be converted to `Int32`") sem indicar qual propriedade, mas `Path` está sempre lá. Se você não vir um segmento `Path`, está olhando para uma exceção embrulhada. Capture `JsonException` diretamente no ponto de chamada da desserialização e leia `ex.Path` a partir da propriedade, não de `ex.Message`.

## Por que System.Text.Json se recusa a coagir

Diferente do `Newtonsoft.Json`, `System.Text.Json` é **estrito por padrão**: ele não faz coerção entre tipos de tokens JSON e não roda um parser com perdas sobre o conteúdo da string. Se o seu endpoint aceita `{ "amount": "12.50" }` e seu DTO tem `decimal Amount`, o leitor vê `JsonTokenType.String`, não encontra conversão embutida de `string` para `decimal` e lança. A mesma lógica rejeita:

- Uma string JSON onde a propriedade espera um `bool`, `int`, `long`, `decimal`, `double`, `Guid`, `DateTime` ou `TimeSpan`. A direção oposta (um número JSON onde a propriedade espera uma `string`) também é rejeitada.
- Um número JSON que nomeia um valor de enum quando nenhum `JsonStringEnumConverter` está registrado, **ou** uma string JSON que nomeia um valor de enum quando o converter padrão só aceita inteiros está em vigor.
- Uma string vazia `""` onde a propriedade espera um tipo por valor. Strings vazias não são o mesmo que `null`, e tipos por valor não são anuláveis a menos que declarados como `T?`.
- Um objeto JSON polimórfico onde o discriminador não corresponde a nenhum `[JsonDerivedType]` que você registrou.
- Um literal de ponto flutuante como `"NaN"`, `"Infinity"` ou `"-Infinity"` quando `JsonNumberHandling.AllowNamedFloatingPointLiterals` não está habilitado.
- Um número de timestamp Unix (`1715600000`) para uma propriedade `DateTime`, porque `System.Text.Json` só lê `DateTime` a partir de uma string ISO 8601. O caso específico está coberto em [a correção canônica para conversão de DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

A estrita é o design, não o bug. A justificativa do time é que conversão com perdas é a fonte mais comum de corrupção silenciosa de dados em apps de negócio, e que o registro explícito de converters torna a intenção visível na fronteira entre o formato do fio e o sistema de tipos. O trade-off é que toda preocupação transversal que você costumava obter dos padrões de `Newtonsoft.Json` (string-para-número, string-para-enum, string-para-bool) agora precisa de uma opt-in explícita.

## Reprodução mínima

O menor programa que reproduz a variante mais comum, um enum chegando como string:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

var json = """{ "status": "Pending" }""";

var order = JsonSerializer.Deserialize<Order>(json);

Console.WriteLine(order!.Status);

public record Order(OrderStatus Status);
public enum OrderStatus { Pending, Shipped, Delivered }
```

Executar isto lança:

```text
Unhandled exception. System.Text.Json.JsonException:
The JSON value could not be converted to OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 20.
```

O converter de enum padrão aceita apenas a representação **inteira** (`{ "status": 0 }`). Qualquer outra coisa dispara a exceção. Uma vez que você entende que este é o modo de falha, todas as outras variantes neste post seguem o mesmo padrão: o formato JSON não corresponde ao tipo, e você escolhe qual lado dobrar.

## Correção 1: enums recebidos como strings

Registre `JsonStringEnumConverter<TEnum>` uma vez nas suas `JsonSerializerOptions`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    Converters = { new JsonStringEnumConverter<OrderStatus>() }
};

var order = JsonSerializer.Deserialize<Order>(json, options)!;
```

Se você tem muitos enums, registre o `JsonStringEnumConverter()` não-genérico em vez disso. Ele se aplica a todo tipo enum que o serializador encontrar, ao custo de ser incompatível com o trimming do Native AOT. Para Native AOT, prefira o converter genérico por enum ou anote cada enum com `[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]` diretamente, e mantenha a lista global de converters vazia.

Se o produtor diferencia maiúsculas e minúsculas ("PENDING" no fio, `Pending` em C#), passe uma política de nomes:

```csharp
var options = new JsonSerializerOptions
{
    Converters =
    {
        new JsonStringEnumConverter<OrderStatus>(JsonNamingPolicy.SnakeCaseUpper)
    }
};
```

Para produtores que enviam valores não representáveis como identificadores de C# ("in-progress", "n/a"), o .NET 9 introduziu `[JsonStringEnumMemberName]`:

```csharp
public enum OrderStatus
{
    Pending,

    [JsonStringEnumMemberName("in-progress")]
    InProgress,

    Delivered
}
```

Nas APIs mínimas do ASP.NET Core, configure o converter nas `JsonSerializerOptions` da aplicação para que cada endpoint o pegue:

```csharp
// .NET 11 preview 4, ASP.NET Core 11.0.0-preview.4
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter<OrderStatus>());
});
```

Para controllers, a chamada equivalente é `builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(...))`. Configurá-lo uma vez na raiz de composição é preferível a abrir `JsonConverter` em todo atributo `[JsonConverter(...)]`.

## Correção 2: números recebidos como strings (e vice-versa)

Quando o produtor codifica em JSON um campo numérico como string, `{ "amount": "12.50" }`, habilite `JsonNumberHandling.AllowReadingFromString`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowReadingFromString
};

var dto = JsonSerializer.Deserialize<Invoice>(json, options);

public record Invoice(decimal Amount);
```

`AllowReadingFromString` funciona para todo tipo integral e de ponto flutuante, mais `decimal`. É simétrico com `WriteAsString`, que você pode combinar se quiser que o serializador emita e leia o valor como string:

```csharp
NumberHandling = JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString
```

Para escopo por propriedade em vez de global, anote a propriedade diretamente:

```csharp
public record Invoice(
    [property: JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)] decimal Amount
);
```

O caso inverso, um número JSON enviado onde se espera uma `string` (um ID de rastreamento codificado como `42` em vez de `"42"`), **não** é coberto por `JsonNumberHandling`. Você precisa de um pequeno converter customizado:

```csharp
// .NET 11 preview 4
public sealed class NumberOrStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Number => reader.GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            JsonTokenType.Null => null,
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

Cubro o contrato do converter com mais profundidade em [o guia de como escrever um JsonConverter customizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), incluindo como compor converters e como curto-circuitar o despacho polimórfico.

## Correção 3: booleanos recebidos como 0 / 1 ou como strings "true" / "false"

`System.Text.Json` aceita apenas os tokens JSON `true` / `false` para `bool`. `0` / `1` numéricos e strings `"true"` / `"false"` são ambos rejeitados. Não há opção embutida para nenhum dos formatos; escreva um converter:

```csharp
// .NET 11 preview 4
public sealed class LooseBooleanConverter : JsonConverter<bool>
{
    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.True => true,
            JsonTokenType.False => false,
            JsonTokenType.Number => reader.GetInt32() != 0,
            JsonTokenType.String => bool.Parse(reader.GetString()!),
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options)
        => writer.WriteBooleanValue(value);
}
```

Registre-o por propriedade com `[JsonConverter(typeof(LooseBooleanConverter))]` em vez de globalmente, porque a maioria dos campos em uma API bem comportada não é flexível, e dobrar todo `bool` para aceitar três formatos obscurece o contrato.

## Correção 4: strings vazias para tipos por valor

Se o produtor emite `{ "shippedAt": "" }` para uma data ausente, `System.Text.Json` lê `JsonTokenType.String` e falha em fazer parse do conteúdo vazio como `DateTime`. Há duas correções limpas. A primeira é tornar a propriedade C# anulável e escrever um converter que mapeia `""` para `null`:

```csharp
public sealed class NullableDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType == JsonTokenType.String)
        {
            var s = reader.GetString();
            return string.IsNullOrEmpty(s) ? null : DateTime.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new JsonException();
    }

    public override void Write(Utf8JsonWriter writer, DateTime? value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

A segunda é definir `JsonSerializerOptions.RespectNullableAnnotations = true` (padrão no .NET 9+) e fazer o produtor enviar `null` em vez de `""`. A correção do lado do produtor é preferível quando você controla os dois lados, porque todo caso especial `""`-como-null acaba vazando para uma coluna não anulável ou uma NullReferenceException rio abaixo.

## Correção 5: Guid em formato errado

`System.Text.Json` usa `Guid.TryParseExact` com formato `D` (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Representações com chaves (`{...}`), com parênteses (`(...)`) e sem traços (`N`) todas lançam. A correção mais curta é um converter por propriedade:

```csharp
public sealed class FlexibleGuidConverter : JsonConverter<Guid>
{
    public override Guid Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.GetString();
        return Guid.Parse(s!);
    }

    public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

`Guid.Parse` aceita todas as strings de formato padrão, então isso é suficiente.

## Correção 6: objetos polimórficos com um discriminador desconhecido

Quando você declara um tipo base com `[JsonPolymorphic]` e `[JsonDerivedType]`, o leitor inspeciona a propriedade discriminadora e caminha até o subtipo correspondente. Se o valor do discriminador estiver ausente ou desconhecido, o leitor lança "the JSON value could not be converted to BaseType". Duas correções de produção:

- Defina `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType` para que o leitor materialize o tipo base quando nenhum tipo derivado corresponde.
- Defina `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor` se você tem uma hierarquia de classes mais profunda que um nível e quer o ancestral registrado mais próximo.

```csharp
// .NET 11 preview 4
[JsonPolymorphic(
    TypeDiscriminatorPropertyName = "$kind",
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType)]
[JsonDerivedType(typeof(EmailEvent), "email")]
[JsonDerivedType(typeof(SmsEvent), "sms")]
public abstract record Event;

public record EmailEvent(string To, string Subject) : Event;
public record SmsEvent(string To, string Body) : Event;
```

O comportamento padrão (`JsonUnknownDerivedTypeHandling.FailSerialization`) é correto para schemas fechados onde toda variante é conhecida. Use as opções de fallback quando você ingerir eventos de um produtor que adiciona novas variantes sem coordenar uma implantação.

## Correção 7: NaN e Infinity de ponto flutuante

Se um serializador do lado do produtor emite `"NaN"`, `"Infinity"` ou `"-Infinity"` para `double` / `float`, habilite:

```csharp
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
};
```

Isso é simétrico: a mesma opção também permite que seu serializador emita esses literais no caminho de escrita. Sem ela, tanto leitura quanto escrita lançam.

## Pegadinhas e casos parecidos

- **A mensagem de exceção cita um tipo base, não o concreto.** A desserialização polimórfica reporta a falha contra a raiz polimórfica, não contra o tipo apontado pelo discriminador. Leia o valor do discriminador no seu JSON cru antes de assumir que o converter é o problema.
- **Contextos gerados por código-fonte escondem opções.** Se você declarou `[JsonSerializable(typeof(Order))]` em um `JsonSerializerContext`, a lista de converters nas `JsonSerializerOptions` de runtime que você passa **é** respeitada, mas os metadados gerados por código-fonte também codificam atributos `[JsonConverter]` em tempo de compilação. Misturar os dois está ok, mas um `[JsonConverter(...)]` em nível de propriedade sempre vence sobre um global registrado em runtime. Veja [o suporte a interceptors de C# 14 para geração de código-fonte de System.Text.Json](/pt-br/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) para o trabalho de ergonomia nessa área.
- **A sensibilidade a maiúsculas é independente do converter.** `PropertyNameCaseInsensitive = true` e as políticas de nomes conscientes de caixa (`JsonNamingPolicy.CamelCase`, `JsonNamingPolicy.SnakeCaseLower`, o atributo de [nomes PascalCase por membro no .NET 11](/pt-br/2026/04/system-text-json-11-pascalcase-per-member-naming/)) afetam qual propriedade CLR o leitor liga, não como ele converte o valor. Se seu erro menciona `Path: $.OrderStatus` mas seu JSON tem `"orderStatus"`, você está olhando para uma falha de binding, não uma falha de conversão.
- **O ramo DateTime tem suas próprias convenções.** Somente ISO 8601, somente separador `T`, sem timestamps Unix. A tabela completa de formatos aceitos e rejeitados está em [a correção dedicada para conversão de DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).
- **Ler um número que não cabe.** Um JSON `9999999999` não pode ser lido em um `int` e lança com o mesmo texto de exceção. Verifique a magnitude antes de assumir que é um problema de formato.
- **Newtonsoft.Json coagia silenciosamente.** O caminho mais comum até este bug é uma migração do `Newtonsoft.Json` em que o código antigo aceitava `{ "amount": "12.50" }` porque o Newtonsoft tenta string-para-decimal por baixo dos panos. Não há interruptor global "seja tolerante" no `System.Text.Json`. Ou você define `NumberHandling` e registra `JsonStringEnumConverter`, ou fica no Newtonsoft para aquela fronteira.

## Relacionados

- [Fix: The JSON value could not be converted to System.DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cobre a variante específica de DateTime, incluindo o requisito de formato ISO 8601 e o parsing de timestamp Unix.
- [Como escrever um JsonConverter customizado em System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) mostra o contrato do converter, converters de fábrica e como cair no converter padrão.
- [Nomes PascalCase por membro em System.Text.Json 11](/pt-br/2026/04/system-text-json-11-pascalcase-per-member-naming/) é a ferramenta certa quando a falha é de binding de propriedade em vez de conversão de valor.
- [Interceptors de C# 14 para geração de código-fonte de System.Text.Json](/pt-br/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) explica como converters gerados por código-fonte interagem com as `JsonSerializerOptions` de runtime.
- [Fix: InvalidOperationException: Synchronous operations are disallowed](/pt-br/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) não é relacionado mas costuma ser visto junto com erros de conversão JSON ao migrar de JSON bufferizado para JSON em streaming no ASP.NET Core.

## Fontes

- [Visão geral do System.Text.Json, .NET docs](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/overview)
- [Como serializar e desserializar valores de enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Referência de `JsonNumberHandling`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonnumberhandling)
- [`JsonPolymorphicAttribute` e `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonStringEnumMemberNameAttribute`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenummembernameattribute)
- [Código-fonte de `dotnet/runtime` para `EnumConverter<T>`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/Converters/Value/EnumConverter.cs)
