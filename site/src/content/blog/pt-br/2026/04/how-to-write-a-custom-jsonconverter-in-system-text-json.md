---
title: "Como escrever um JsonConverter customizado em System.Text.Json"
description: "Um guia completo para escrever JsonConverter<T> customizado para System.Text.Json no .NET 11: quando você realmente precisa de um, como navegar pelo Utf8JsonReader corretamente, como lidar com tipos genéricos usando JsonConverterFactory e como manter compatibilidade com AOT."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "pt-br"
translationOf: "2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-04-25
---

Para escrever um conversor customizado para `System.Text.Json`, derive de `JsonConverter<T>`, sobrescreva `Read` e `Write` e decore o tipo alvo com `[JsonConverter(typeof(MyConverter))]` ou adicione uma instância a `JsonSerializerOptions.Converters`. Dentro de `Read`, você precisa percorrer o `Utf8JsonReader` exatamente pelo número de tokens que seu valor abrange, nem mais nem menos, caso contrário a próxima chamada do desserializador verá um stream quebrado. Dentro de `Write`, você chama métodos do `Utf8JsonWriter` diretamente e nunca aloca strings intermediárias a menos que precise. Para tipos genéricos ou polimorfismo, use `JsonConverterFactory` para que uma única classe possa produzir conversores para muitas instâncias genéricas fechadas. Tudo neste guia tem como alvo o .NET 11 (preview 3) e C# 14, mas a API é estável desde o .NET Core 3.0, então o mesmo código funciona em qualquer runtime suportado.

## Quando um JsonConverter é a ferramenta certa

A maioria das equipes recorre a um conversor customizado cedo demais. Antes de escrever um, verifique se seu problema pode ser resolvido com recursos já incluídos no .NET 11 (e em versões anteriores):

- Nomes de propriedades que não correspondem: use `JsonPropertyNameAttribute` ou um `JsonNamingPolicy`. O Preview 3 adicionou `JsonNamingPolicy.PascalCase` e um atributo `[JsonNamingPolicy]` em nível de membro, então as [políticas de nomenclatura no System.Text.Json 11](/pt-br/2026/04/system-text-json-11-pascalcase-per-member-naming/) provavelmente cobrem o que você precisa.
- Números como strings: `JsonNumberHandling.AllowReadingFromString` em `JsonSerializerOptions`.
- Enums como strings: `JsonStringEnumConverter` é nativo. Existe até uma [variante compatível com trim para Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/).
- Propriedades somente leitura ou parâmetros de construtor: o gerador de código-fonte (`[JsonSerializable]` mais `JsonSerializerContext`) lida com records e construtores primários diretamente.
- Polimorfismo por discriminador: `[JsonDerivedType]` e `[JsonPolymorphic]` (adicionados no .NET 7) evitam quase todos os truques antigos com conversores.

Um conversor customizado é a ferramenta certa quando o formato JSON e o formato .NET realmente divergem. Exemplos:

- Um value type que deve ser serializado como um primitivo (`Money` se torna `"42.00 USD"`).
- Um tipo cuja forma JSON depende do contexto (às vezes uma string, às vezes um objeto).
- Uma árvore onde a mesma propriedade carrega tipos diferentes dependendo de um campo irmão.
- Um formato de fio que você não controla (valores no estilo Stripe em centavos, durações ISO 8601, regras de recorrência RFC 5545).

Se nenhum desses casos se aplica, use os recursos nativos e pule este artigo.

## O contrato de JsonConverter<T>

`System.Text.Json.Serialization.JsonConverter<T>` tem dois métodos abstratos que você precisa sobrescrever e alguns hooks opcionais:

```csharp
// .NET 11, C# 14
public abstract class JsonConverter<T> : JsonConverter
{
    public abstract T? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options);

    public abstract void Write(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options);

    // Optional: opt in to dictionary-key handling.
    public virtual T ReadAsPropertyName(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual void WriteAsPropertyName(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual bool HandleNull => false;
}
```

Duas coisas nessa assinatura são fáceis de errar:

1. `Read` recebe `Utf8JsonReader` por `ref`. O reader é uma struct mutável que detém o cursor. Se você passá-lo para um método auxiliar, passe-o por `ref` também, caso contrário o cursor do chamador não avançará e você lerá o mesmo token para sempre.
2. `HandleNull` por padrão é `false`, o que significa que o serializador retornará `default(T)` para JSON `null` e nunca chamará seu conversor. Se você precisa mapear `null` para um valor não padrão (ou distinguir "ausente" de "null"), defina `HandleNull => true` e verifique `reader.TokenType == JsonTokenType.Null` por conta própria.

O contrato completo está documentado na página oficial do MS Learn sobre [como escrever conversores customizados](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to). O resto deste post é a versão prática.

## Um exemplo concreto: um value type Money

Considere um valor `Money` fortemente tipado:

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public override string ToString() =>
        $"{Amount.ToString("0.00", CultureInfo.InvariantCulture)} {Currency}";
}
```

O comportamento padrão do `System.Text.Json` o serializa como `{"Amount":42.00,"Currency":"USD"}`. Queremos um único token de string em vez disso: `"42.00 USD"`. Esse é exatamente o tipo de incompatibilidade de formato para o qual um conversor existe.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class MoneyJsonConverter : JsonConverter<Money>
{
    public override Money Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
            throw new JsonException(
                $"Expected string for Money, got {reader.TokenType}.");

        string raw = reader.GetString()!; // "42.00 USD"
        int space = raw.LastIndexOf(' ');
        if (space <= 0 || space == raw.Length - 1)
            throw new JsonException($"Invalid Money literal: '{raw}'.");

        decimal amount = decimal.Parse(
            raw.AsSpan(0, space),
            NumberStyles.Number,
            CultureInfo.InvariantCulture);
        string currency = raw[(space + 1)..];

        return new Money(amount, currency);
    }

    public override void Write(
        Utf8JsonWriter writer,
        Money value,
        JsonSerializerOptions options)
    {
        // Formats directly into the writer's UTF-8 buffer.
        Span<char> buffer = stackalloc char[64];
        if (!value.Amount.TryFormat(
                buffer, out int written,
                "0.00", CultureInfo.InvariantCulture))
        {
            writer.WriteStringValue(value.ToString());
            return;
        }

        // "<number> <currency>" without intermediate string allocation.
        Span<char> output = stackalloc char[written + 1 + value.Currency.Length];
        buffer[..written].CopyTo(output);
        output[written] = ' ';
        value.Currency.AsSpan().CopyTo(output[(written + 1)..]);
        writer.WriteStringValue(output);
    }
}
```

Alguns detalhes que vale a pena destacar:

- `reader.GetString()` materializa uma `string` gerenciada. Se você está desserializando milhões de registros e o valor analisado tem vida curta, prefira `reader.ValueSpan` (bytes UTF-8) mais `Utf8Parser` para evitar a alocação.
- `writer.WriteStringValue(ReadOnlySpan<char>)` codifica em UTF-8 diretamente no buffer agrupado do writer. Não há `string` intermediária. Essa sobrecarga, junto com `WriteStringValue(ReadOnlySpan<byte> utf8)`, é o caminho barato.
- `JsonException` é a exceção canônica para "os dados estão errados". O serializador a envolve com informações de linha e posição antes que ela chegue ao chamador, então você não precisa adicionar nenhuma.

## Lendo corretamente: disciplina de cursor

O bug mais comum em conversores customizados é não deixar o reader no token correto. O contrato é:

> Quando `Read` retorna, o reader precisa estar posicionado no **último token consumido pelo seu valor**, não no próximo.

O serializador chama `reader.Read()` uma vez entre valores. Se seu conversor consumir tokens demais, a próxima propriedade é silenciosamente pulada. Se consumir poucos, a próxima chamada do desserializador verá um stream malformado e lançará uma exceção sobre um token que não esperava.

Duas regras cobrem quase todos os casos:

1. Para um valor de token único (string, número, booleano), não faça nada além de ler do token atual. O cursor já está no token correto quando `Read` é invocado.
2. Para um objeto ou array, faça um loop até ver o token correspondente `EndObject` ou `EndArray`, e deixe o `reader.Read()` final do loop colocá-lo exatamente nesse token de fechamento.

Aqui está o esqueleto canônico para leitura de objetos:

```csharp
// .NET 11, C# 14
public override Foo Read(
    ref Utf8JsonReader reader,
    Type typeToConvert,
    JsonSerializerOptions options)
{
    if (reader.TokenType != JsonTokenType.StartObject)
        throw new JsonException();

    var result = new Foo();

    while (reader.Read())
    {
        if (reader.TokenType == JsonTokenType.EndObject)
            return result;

        if (reader.TokenType != JsonTokenType.PropertyName)
            throw new JsonException();

        string property = reader.GetString()!;
        reader.Read(); // advance to the value token

        switch (property)
        {
            case "id":
                result.Id = reader.GetInt32();
                break;
            case "name":
                result.Name = reader.GetString();
                break;
            case "child":
                // Recurse through the serializer so nested converters and
                // contracts apply.
                result.Child = JsonSerializer.Deserialize<Child>(
                    ref reader, options);
                break;
            default:
                reader.Skip(); // unknown field, advance past its value
                break;
        }
    }

    throw new JsonException(); // unexpected end of stream
}
```

`reader.Skip()` é o helper subestimado: ele percorre tudo o que o token atual introduz, incluindo um objeto ou array aninhado, deixando o cursor em seu token de fechamento. Use-o para qualquer coisa que você não entenda; nunca escreva um loop de skip customizado.

## Escrevendo eficientemente: fique no writer

`Utf8JsonWriter` escreve diretamente em um buffer UTF-8 agrupado, então qualquer coisa que não exija uma `string` gerenciada deve ficar fora do heap. Três regras:

1. Prefira as sobrecargas tipadas: `WriteNumber`, `WriteBoolean`, `WriteString(ReadOnlySpan<char>)`. Elas formatam direto no buffer.
2. Para pares propriedade+valor dentro de um objeto, use `WriteString("name", value)` e similares. Eles emitem o nome da propriedade e o valor em uma única chamada sem alocar.
3. Se você precisa construir uma string, use `string.Create` ou um `Span<char>` alocado na pilha em vez de `string.Format` ou interpolação, ambos os quais alocam.

Para o exemplo `Money` acima, uma versão ainda mais barata usa UTF-8 diretamente:

```csharp
// .NET 11, C# 14, micro-optimized hot path
public override void Write(
    Utf8JsonWriter writer,
    Money value,
    JsonSerializerOptions options)
{
    Span<byte> buffer = stackalloc byte[64];
    if (!value.Amount.TryFormat(
            buffer, out int written,
            "0.00", CultureInfo.InvariantCulture))
    {
        writer.WriteStringValue(value.ToString());
        return;
    }

    int currencyLen = Encoding.UTF8.GetByteCount(value.Currency);
    Span<byte> output = stackalloc byte[written + 1 + currencyLen];
    buffer[..written].CopyTo(output);
    output[written] = (byte)' ';
    Encoding.UTF8.GetBytes(value.Currency, output[(written + 1)..]);
    writer.WriteStringValue(output);
}
```

Esta versão nunca produz uma string gerenciada para o valor formatado. Para um serviço serializando dezenas de milhares de instâncias de `Money` por segundo, isso é uma diferença mensurável na taxa de alocação.

## Tipos genéricos e JsonConverterFactory

`JsonConverter<T>` é um tipo fechado. Se você quer um conversor para `Result<TValue, TError>` que funcione para todo genérico fechado, escreva uma `JsonConverterFactory` que produza os conversores fechados sob demanda:

```csharp
// .NET 11, C# 14
public sealed class ResultJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType
        && typeToConvert.GetGenericTypeDefinition() == typeof(Result<,>);

    public override JsonConverter CreateConverter(
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        Type[] args = typeToConvert.GetGenericArguments();
        Type closed = typeof(ResultConverter<,>).MakeGenericType(args);
        return (JsonConverter)Activator.CreateInstance(closed)!;
    }

    private sealed class ResultConverter<TValue, TError>
        : JsonConverter<Result<TValue, TError>>
    {
        public override Result<TValue, TError> Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options) =>
            throw new NotImplementedException(); // exercise for the reader

        public override void Write(
            Utf8JsonWriter writer,
            Result<TValue, TError> value,
            JsonSerializerOptions options) =>
            throw new NotImplementedException();
    }
}
```

A factory é registrada da mesma forma que um conversor regular (atributo ou `Options.Converters.Add`). O serializador armazena em cache o conversor fechado por genérico fechado, então `CreateConverter` é executado uma vez por par `(TValue, TError)` por instância de `JsonSerializerOptions`.

`Activator.CreateInstance` mais `MakeGenericType` é reflexão, que é hostil ao Native AOT e ao trim. Se você tem como alvo o AOT, veja a seção AOT abaixo.

## Registrando um conversor

Duas formas, e elas têm precedências diferentes:

```csharp
// .NET 11, C# 14
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly record struct Money(decimal Amount, string Currency);
```

O atributo prende o conversor ao tipo e é honrado por toda chamada `JsonSerializer` sem configuração por opções. Use-o para value types que você possui.

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    Converters = { new MoneyJsonConverter() }
};

string json = JsonSerializer.Serialize(invoice, options);
```

O registro em nível de opções é a resposta certa quando você não possui o tipo alvo, quando o conversor é específico de ambiente (teste vs prod) ou quando um único tipo precisa de formatos diferentes em contextos diferentes (uma API pública vs um log interno).

A ordem de busca, da prioridade mais alta para a mais baixa:

1. O conversor passado diretamente para uma chamada `JsonSerializer`.
2. `[JsonConverter]` na propriedade.
3. `Options.Converters` (último adicionado vence para tipos correspondentes).
4. `[JsonConverter]` no tipo.
5. O padrão nativo para esse tipo.

Se dois conversores reivindicam o mesmo tipo via mecanismos diferentes, o que está mais alto nessa lista vence. Esboce isso na sua cabeça antes de depurar "por que meu conversor não está rodando": quase sempre, um atributo de propriedade ou uma entrada de opções está sobrescrevendo o atributo do tipo.

## Geração de código-fonte e Native AOT

`JsonConverter<T>` funciona com o gerador de código-fonte: declare o tipo no seu `JsonSerializerContext` e o gerador emite um provedor de metadados que delega ao seu conversor onde apropriado. O mesmo **não** é automaticamente verdade para `JsonConverterFactory`. Qualquer coisa que a factory faça com `MakeGenericType` ou `Activator.CreateInstance` é reflexão, que o trim e o AOT não conseguem ver estaticamente.

Para factories compatíveis com AOT, faça uma das opções:

- Restringir a factory a um conjunto conhecido e finito de genéricos fechados e instanciá-los diretamente com `new ResultConverter<MyValue, MyError>()` por par.
- Anotar a factory com `[RequiresDynamicCode]` e `[RequiresUnreferencedCode]`, aceitar os avisos de trim e documentar que consumidores AOT precisam registrar o conversor fechado manualmente.

O padrão de usar interceptors para fazer chamadas `JsonSerializer.Serialize` automaticamente pegarem um contexto gerado, discutido em [a proposta de interceptors do C# 14 para JSON gerado por código-fonte](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/), é independente de conversores: mesmo com isso, você ainda escreve seu `JsonConverter<T>` customizado da mesma forma.

## Pegadinhas, em ordem de frequência com que aparecem

- **Esquecer de avançar o reader além de `EndObject`/`EndArray`.** Sintoma: a próxima propriedade no objeto pai é silenciosamente pulada ou o parser lança um erro confuso duas camadas acima. Audite escrevendo um teste de conversor que desserializa `{ "wrapped": <yourThing>, "next": 1 }` e verifica que `next` é lido.
- **Chamar `JsonSerializer.Deserialize<T>(ref reader, options)` no mesmo `T` que seu conversor manipula.** Isso recursa infinitamente. A recursão pelo serializador é para *outros* tipos (filhos, valores aninhados).
- **Manter o `Utf8JsonReader` através de um `await`.** O reader é uma `ref struct`, o compilador não permitirá, mas você pode ser tentado a copiar valores para variáveis locais e reanexar depois. Não faça isso. Leia o valor inteiro de forma síncrona dentro de `Read`. Se sua fonte de dados é assíncrona, faça buffer primeiro em um `ReadOnlySequence<byte>` e passe isso para o reader.
- **Lançar qualquer coisa diferente de `JsonException` para dados malformados.** Outras exceções cruzam a fronteira do serializador sem encapsulamento e perdem o contexto de linha/posição.
- **Mutar `JsonSerializerOptions` após a primeira chamada de serialização.** O serializador armazena em cache os conversores resolvidos por instância de opções; mutações subsequentes lançam `InvalidOperationException`. Construa uma instância de opções nova, ou chame `MakeReadOnly()` explicitamente quando terminar a configuração.
- **Usar `JsonConverterAttribute` em uma interface ou tipo abstrato e esperar polimorfismo de graça.** Não funciona assim. Use `[JsonPolymorphic]` e `[JsonDerivedType]` para serialização de hierarquia, ou escreva um conversor customizado que faça o despacho do discriminador você mesmo.
- **Alocar em `Write`.** É fácil escrever `JsonSerializer.Serialize(value)` recursivamente e esquecer que produz uma `string` que você então escreve de volta no writer. Use a sobrecarga `ref Utf8JsonWriter` de `Serialize` em vez disso.

Se você mantiver isso em mente, um conversor raramente leva mais de 30 linhas de código e roda no mesmo orçamento de alocação que o serializador nativo.

## Relacionados

- [Como usar Channels em vez de BlockingCollection em C#](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- padrões assíncronos por padrão, mesma era de design de API.
- [System.Text.Json no .NET 11 Preview 3 adiciona PascalCase e nomenclatura por membro](/pt-br/2026/04/system-text-json-11-pascalcase-per-member-naming/) -- quando uma política de nomenclatura é suficiente e um conversor não.
- [Como usar JsonStringEnumConverter com Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/) -- a história de trim/AOT para conversores nativos.
- [Interceptors para geração de código-fonte do System.Text.Json](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) -- uma direção de ergonomia paralela que vale acompanhar.
- [Como retornar múltiplos valores de um método em C# 14](/pt-br/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) -- os padrões de value-tuple e record que muitas vezes acabam precisando de um conversor.

## Fontes

- MS Learn: [Write custom converters for JSON serialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to)
- MS Learn: [How to use the source generator in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- Referência da API: [`Utf8JsonReader`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonreader), [`Utf8JsonWriter`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonwriter)
- Rastreador de issues do dotnet/runtime para a área System.Text.Json: [area-System.Text.Json](https://github.com/dotnet/runtime/labels/area-System.Text.Json)
