---
title: "Como personalizar a serialização do System.Text.Json gerada por código-fonte com um modificador de type info resolver"
description: "Anexe um modificador de JsonTypeInfo a um JsonSerializerContext gerado por código-fonte no .NET 11: por que new MyContext(options) o descarta silenciosamente, a configuração com WithAddedModifier que funciona, o caminho rápido que você perde (medido) e a armadilha da política de nomes que anula o modificador."
pubDate: 2026-08-10
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "source-generators"
  - "serialization"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier"
translatedBy: "claude"
translationDate: 2026-08-10
---

Para personalizar um contrato do `System.Text.Json` gerado por código-fonte, coloque seu modificador nas `JsonSerializerOptions`, nunca no contexto: `new JsonSerializerOptions { TypeInfoResolver = MyContext.Default.WithAddedModifier(MyModifier) }`. A alternativa que parece óbvia, `new MyContext(optionsWithModifier)`, compila, executa e ignora seu modificador em silêncio, porque o construtor de `JsonSerializerContext` sobrescreve `TypeInfoResolver` com o próprio contexto. Modificadores funcionam bem com geração de código-fonte, inclusive com a serialização baseada em reflection desabilitada para Native AOT, mas custam o caminho rápido gerado. Tudo abaixo foi verificado no .NET 10.0.5 com o SDK 10.0.201; as APIs não mudam do .NET 8 ao .NET 11.

## Por que personalização de contrato e geração de código-fonte parecem incompatíveis

A personalização de contratos chegou no .NET 7. Você entrega ao `System.Text.Json` um `Action<JsonTypeInfo>` e ele chama você uma vez por tipo, depois que o contrato foi construído mas antes de ser usado, então você pode renomear propriedades, removê-las, adicionar propriedades sintéticas ou envolver os delegates de leitura e escrita. O ponto de entrada canônico é `DefaultJsonTypeInfoResolver.Modifiers`, e o .NET 8 adicionou [o método de extensão `WithAddedModifier`](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/) para que você possa sobrepor um modificador a qualquer `IJsonTypeInfoResolver`, não só ao baseado em reflection.

Essa parte de "qualquer resolver" é o que importa, porque um `JsonSerializerContext` gerado por código-fonte **é** um `IJsonTypeInfoResolver`. Não existe razão técnica para um modificador não decorar `MyContext.Default`. A razão pela qual tanta gente conclui que modificadores de contrato não funcionam com geração de código-fonte é que a ligação de aparência mais natural joga o modificador fora sem aviso, sem exceção e sem diagnóstico do compilador.

Este é o modelo que vou usar no restante do artigo. Um `Order` com um segredo, mais um `Address` aninhado que tem o mesmo problema:

```csharp
// .NET 11, C# 14
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string? ApiKey { get; set; }
    public Address? ShipTo { get; set; }
}

public class Address
{
    public string City { get; set; } = "";
    public string? ApiKey { get; set; }
}

[JsonSerializable(typeof(Order))]
public partial class OrderContext : JsonSerializerContext { }
```

E o modificador, que censura toda propriedade chamada `ApiKey` em qualquer ponto do grafo de objetos:

```csharp
// .NET 11, C# 14
static void RedactApiKey(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        if (property.Name != "ApiKey")
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

## A ligação que funciona e a que não faz nada em silêncio

Três passos, e a ordem importa:

1. Construa o resolver primeiro chamando `WithAddedModifier` na propriedade `Default` do seu contexto gerado. Isso devolve um `JsonTypeInfoResolverWithAddedModifiers` que delega ao contexto e depois executa seu callback.
2. Atribua esse resolver a um `JsonSerializerOptions.TypeInfoResolver` e guarde a instância de options em um campo `static readonly`. Nunca construa o `JsonSerializerContext` você mesmo.
3. Passe essa instância de options para `JsonSerializer.Serialize` ou `JsonSerializer.Deserialize`. Não passe o contexto, e não passe um `JsonTypeInfo` que você pegou de `MyContext.Default`.

```csharp
// .NET 11, C# 14 - works
static readonly JsonSerializerOptions RedactingOptions = new()
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
};

var order = new Order
{
    Id = 7,
    Customer = "acme",
    ApiKey = "sk-live-123",
    ShipTo = new Address { City = "Cluj", ApiKey = "sk-nested-999" }
};

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), RedactingOptions));
// {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
```

Repare que o `Address` aninhado também é censurado, mesmo nunca tendo aparecido em um atributo `[JsonSerializable]`. O gerador percorre o grafo de objetos a partir de cada raiz declarada, então `OrderContext.Default.GetTypeInfo(typeof(Address))` devolve um contrato e o modificador roda para ele como para qualquer outro tipo.

Agora a versão que parece igualmente razoável e não faz nada:

```csharp
// .NET 11, C# 14 - modifier is silently discarded
var context = new OrderContext(new JsonSerializerOptions
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
});

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), context));
// {"Id":7,"Customer":"acme","ApiKey":"sk-live-123","ShipTo":{...,"ApiKey":"sk-nested-999"}}

Console.WriteLine(context.Options.TypeInfoResolver?.GetType().Name);
// OrderContext
```

O construtor `JsonSerializerContext(JsonSerializerOptions)` copia suas options e depois se atribui a `TypeInfoResolver`, então o resolver decorado que você montou com cuidado some antes da primeira serialização. A orientação dos mantenedores do `System.Text.Json` na [discussão 121304 do dotnet/runtime](https://github.com/dotnet/runtime/discussions/121304) é exatamente essa: evite instâncias de `JsonSerializerContext` e passe as options diretamente para o `JsonSerializer`.

Mais duas formas de perder o modificador, ambas fáceis de escrever sem querer:

```csharp
// .NET 11, C# 14 - both bypass the modifier
JsonSerializer.Serialize(order, OrderContext.Default.Order);
JsonSerializer.Serialize(order, typeof(Order), OrderContext.Default);
```

`OrderContext.Default` é o contrato não modificado. Isso é um recurso, não um bug: modificadores nunca mutam a instância `Default` compartilhada, então um resolver que censura dados em uma parte da sua aplicação não vaza para outra. Se você quiser a sobrecarga com `JsonTypeInfo` para o caminho quente, pegue o type info das options modificadas:

```csharp
// .NET 11, C# 14
var typeInfo = (JsonTypeInfo<Order>)RedactingOptions.GetTypeInfo(typeof(Order));
JsonSerializer.Serialize(order, typeInfo);   // redacted
```

## Comparar por Name é a armadilha que morde no ASP.NET Core

`JsonPropertyInfo.Name` é o nome **JSON**, depois que `PropertyNamingPolicy` foi aplicada. Em uma aplicação de console com options padrão a política de nomes é null, então `property.Name` por acaso coincide com o nome da propriedade CLR e a comparação `== "ApiKey"` funciona. Ligue o mesmo modificador ao ASP.NET Core, onde a política padrão é camelCase, e a comparação não encontra nada:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolver = AppJsonContext.Default.WithAddedModifier(RedactApiKey);
});
```

Com `property.Name != "ApiKey"` o endpoint devolve tranquilamente `{"id":7,"customer":"acme","apiKey":"sk-live-1"}`. O modificador rodou; ele só nunca deu match, porque o contrato já reportava a propriedade como `apiKey`.

Compare pelo membro CLR em vez disso. `JsonPropertyInfo.AttributeProvider` é um `PropertyInfo` mesmo em contratos gerados por código-fonte, então tanto o nome do membro quanto quaisquer atributos personalizados estão disponíveis:

```csharp
// .NET 11, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class RedactAttribute : Attribute { }

static void RedactByAttribute(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        object[]? attributes = property.AttributeProvider
            ?.GetCustomAttributes(typeof(RedactAttribute), inherit: true);

        if (attributes is not { Length: > 0 })
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

Essa versão sobrevive a qualquer política de nomes e, no meu teste, produziu `{"id":7,"customer":"acme","apiKey":"***"}` a partir do mesmo endpoint de minimal API.

## O que você realmente pode mudar em um contrato gerado por código-fonte

Tudo o que [a documentação de contratos personalizados](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) descreve para o resolver de reflection também funciona sobre um gerado. Verifiquei cada um destes casos contra `OrderContext.Default`:

- **Remover uma propriedade.** `typeInfo.Properties.RemoveAt(i)` a elimina tanto da serialização quanto da desserialização. A saída passa a ser `{"Id":7,"Customer":"acme","ShipTo":{"City":"Cluj"}}`.
- **Adicionar uma propriedade sintética.** `typeInfo.CreateJsonPropertyInfo(typeof(string), "kind")` mais um delegate `Get`, e depois `typeInfo.Properties.Add(...)`, acrescenta `"kind":"order"` ao payload. Nenhum membro CLR precisa existir.
- **Envolver o setter.** Reatribuir `property.Set` roda na desserialização. Passar `Customer` para maiúsculas por um setter envolvido transformou `{"Customer":"acme"}` em `Customer == "ACME"`.
- **Escritas condicionais.** `property.ShouldSerialize = (_, value) => !string.IsNullOrEmpty((string?)value)` suprimiu a string vazia de `Customer` sem mexer no resto do contrato.
- **Tratamento de números por tipo.** `typeInfo.NumberHandling` é o único botão que se aplica a contratos `JsonTypeInfoKind.None` como `int`.

Modificadores se compõem na ordem em que você os adiciona. Encadeando duas chamadas de `WithAddedModifier`, a primeira passando todos os nomes para minúsculas e a segunda inserindo uma propriedade `"v"` no índice 0, obtive `{"v":"2","id":7,"customer":"acme",...}`: a passagem de minúsculas rodou primeiro, então a propriedade inserida depois manteve sua capitalização.

## Native AOT: modificadores não são o que quebra

A razão inteira para usar [um gerador de código-fonte](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) aqui é trimming e Native AOT, então a preocupação óbvia é se anexar um modificador traz reflection de volta. Não traz. Rodei o mesmo código de novo com `<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>`, que é o que `PublishAot` e `PublishTrimmed` configuram para você:

```text
IsReflectionEnabledByDefault = False
attribute-driven modifier over source-gen: {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
synthetic property with reflection off:    {"Id":7,...,"kind":"order"}
```

Tanto a busca de atributos via `AttributeProvider` quanto a propriedade criada em runtime funcionaram. O que continua quebrando nessa configuração é a regra habitual da geração de código-fonte: qualquer tipo raiz ausente do contexto lança exceção, e o modificador não tem nada a ver com isso:

```text
NotSupportedException: JsonTypeInfo metadata for type '<>f__AnonymousType0`1[System.Int32]'
was not provided by TypeInfoResolver of type
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'.
```

Se você bater no erro irmão sobre [serialização baseada em reflection desabilitada](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/), isso é um resolver ausente, não um modificador quebrado.

## O custo real: você abre mão do caminho rápido gerado

A geração de código-fonte tem dois modos. O modo de metadados move a construção do contrato para o tempo de compilação. O modo de otimização de serialização emite adicionalmente um escritor feito à mão que chama `Utf8JsonWriter` diretamente. Segundo [a documentação dos modos de geração de código-fonte](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes), o serializador abandona esse caminho rápido sempre que as options pedem algo que o escritor gerado não consegue expressar, e um contrato modificado é exatamente isso.

Medido com BenchmarkDotNet 0.15.8 no .NET 10.0.5 (Intel Core Ultra 7 265KF, 20 núcleos), serializando o `Order` de quatro propriedades acima:

| Método | Média | Ratio | Alocado | Ratio de alocação |
| --- | ---: | ---: | ---: | ---: |
| Source-gen, sem modificador | 88,76 ns | 1,00 | 200 B | 1,00 |
| Source-gen + modificador | 136,83 ns | 1,54 | 496 B | 2,48 |
| Resolver de reflection, sem modificador | 136,23 ns | 1,53 | 512 B | 2,56 |
| Resolver de reflection + modificador | 138,97 ns | 1,57 | 496 B | 2,48 |

Adicionar um modificador custa cerca de 54% de throughput e 2,5 vezes mais alocações neste payload, colocando a geração de código-fonte exatamente onde o resolver de reflection já estava. Você mantém os ganhos de tempo de inicialização e de trimming da geração de código-fonte, porque a construção do contrato continua acontecendo em tempo de compilação; você perde apenas o escritor otimizado. Para a maioria das APIs essa é uma troca aceitável, mas vale saber antes de anexar um modificador a um caminho quente de serialização e ficar se perguntando por que os números não mudaram.

## GenerationMode = Serialization torna seu modificador um no-op silencioso

Este é o modo de falha que mais se parece com "modificadores não funcionam com geração de código-fonte". Se você fixa um contexto em geração apenas de caminho rápido, não há metadados de propriedade para o modificador percorrer:

```csharp
// .NET 11, C# 14 - do not do this if you want a modifier
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(Order))]
public partial class FastPathOnlyContext : JsonSerializerContext { }
```

Imprimi o formato do contrato para os três modos de geração:

```text
Default mode         Kind=Object Properties=4
Serialization only   Kind=Object Properties=0
Metadata only        Kind=Object Properties=4
```

Com `Properties=0` o modificador é invocado uma vez, não itera nada e retorna. A serialização tem sucesso com o payload original, sem censura. A desserialização não, e a mensagem pelo menos é explícita:

```text
InvalidOperationException: TypeInfoResolver
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'
did not provide property metadata for type 'Order'.
```

O modo de geração padrão emite tanto os metadados quanto o caminho rápido, que é o que você quer: o caminho rápido é usado quando nenhum modificador está anexado, e o caminho de metadados assume quando há um.

## Guarde as options em cache e pare de mutá-las depois do primeiro uso

Contratos são cacheados por instância de `JsonSerializerOptions`, não globalmente. Serializar três vezes com um mesmo objeto de options em cache invocou meu modificador 4 vezes no total, uma por tipo do grafo. Construir `JsonSerializerOptions` novas dentro do laço o invocou 12 vezes e reconstruiu todos os contratos:

```text
modifierCalls after 3 serializations (cached options)  = 4
modifierCalls after 3 serializations (fresh options)   = 12
```

Depois que uma instância de options foi usada, tanto ela quanto os contratos que produziu ficam congelados. Atribuir `WriteIndented` após a primeira serialização lança `InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization`, e entrar em `options.GetTypeInfo(...)` para editar `Properties` depois do fato lança o equivalente de `JsonTypeInfo`. Todas as mudanças de contrato precisam acontecer dentro do modificador.

Se você precisa sobrepor vários resolvers em vez de um único contexto decorado, [`TypeInfoResolverChain`](/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/) aceita o resolver decorado tão bem quanto o simples, e a cadeia é consultada em ordem até que um contrato volte não nulo. O mesmo padrão cobre uma hierarquia que já usa [`JsonDerivedType` para polimorfismo](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), porque os contratos derivados passam pelo modificador como qualquer outro tipo.

A versão curta para guardar na cabeça: decore o resolver, nunca o contexto, compare por `AttributeProvider` em vez de `Name`, mantenha o modo de geração no padrão e guarde as options em cache.

## Fontes

- [Contratos personalizados de serialização e desserialização](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) no MS Learn
- [Modos de geração de código-fonte no System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes) no MS Learn
- [Discussão 121304 do dotnet/runtime: modificadores de contrato JSON e geração de código-fonte](https://github.com/dotnet/runtime/discussions/121304)
- [Referência da API `JsonTypeInfoResolver.WithAddedModifier`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsontypeinforesolver.withaddedmodifier), disponível do .NET 8 ao .NET 11
