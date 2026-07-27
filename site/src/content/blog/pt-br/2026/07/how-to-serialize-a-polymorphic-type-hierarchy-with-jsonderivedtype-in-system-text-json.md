---
title: "Como serializar uma hierarquia de tipos polimórfica com JsonDerivedType no System.Text.Json"
description: "Guia completo de JSON polimórfico no .NET 11: JsonDerivedType e JsonPolymorphic, por que o tipo declarado decide tudo, a regra de ordem do $type, todas as exceções que o recurso lança, o modelo de contratos para tipos que não são seus e o que o ASP.NET Core emite no OpenAPI."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "pt-br"
translationOf: "2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-07-27
---

Para fazer round-trip de uma hierarquia de classes com o `System.Text.Json`, coloque `[JsonDerivedType(typeof(Derived), "discriminator")]` no tipo base para cada subtipo que você quer suportar e então serialize e desserialize através do tipo **base**. O serializador escreve uma propriedade `$type` como primeiro membro do objeto e a lê de volta para escolher o subtipo certo. Sem uma string discriminadora, a serialização continua emitindo as propriedades derivadas, mas a desserialização sempre materializa o tipo base. Isso funciona da mesma forma desde o .NET 7 e tudo aqui tem como alvo o .NET 11 (`net11.0`, C# 14), com as duas adições posteriores destacadas onde importam: `AllowOutOfOrderMetadataProperties` (.NET 9) e `JsonSerializerOptions.Strict` (.NET 10).

## Por que a versão ingênua perde dados em silêncio

O motivo pelo qual as pessoas procuram esse recurso é que o código óbvio faz a coisa errada sem avisar. Considere uma hierarquia de pagamentos:

```csharp
// .NET 11, C# 14
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}
```

Serialize um `CardPayment` através de uma variável declarada como `PaymentMethod` sem nenhum atributo e você recebe `{"Amount":10}`. A propriedade `Last4` some. O `System.Text.Json` resolve o contrato a partir do tipo **declarado**, não do tipo em runtime, então ele só conhece os membros de `PaymentMethod`. Isso é deliberado: impede que um tipo derivado vaze propriedades que quem chama nunca concordou em expor, o que é uma consideração real de segurança em respostas de API.

Adicionar um único atributo muda o contrato:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(CardPayment))]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}
```

Agora `JsonSerializer.Serialize<PaymentMethod>(card)` produz `{"Last4":"4242","Amount":10}`. A serialização foi corrigida, a desserialização não. Ler esse payload de volta como `PaymentMethod` lança `NotSupportedException: Deserialization of interface or abstract types is not supported. Type 'PaymentMethod'.`, porque não há nada no JSON dizendo qual subtipo construir. Se o tipo base for concreto em vez de abstrato, a falha é mais silenciosa e pior: você recebe uma instância de `PaymentMethod` e `Last4` é descartado. O discriminador é o que fecha o ciclo.

## Cinco passos para uma hierarquia com round-trip

1. **Deixe o tipo base apto ao polimorfismo.** Ele precisa ser uma classe não selada, uma classe abstrata ou uma interface. Struct, tipos selados, tipos genéricos e `System.Object` são rejeitados com `InvalidOperationException: Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.`

2. **Declare cada subtipo com um discriminador.** O segundo argumento de `[JsonDerivedType]` é o valor discriminador, e é ele que faz a desserialização funcionar.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonDerivedType(typeof(CardPayment), "card")]
[JsonDerivedType(typeof(PaypalPayment), "paypal")]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}

public class PaypalPayment : PaymentMethod
{
    public string Email { get; set; } = "";
}
```

3. **Serialize através do tipo base.** O tipo declarado no ponto de chamada precisa ser a base polimórfica, seja como argumento genérico, como tipo da propriedade ou como tipo do elemento da coleção.

```csharp
// .NET 11, C# 14
PaymentMethod payment = new CardPayment { Amount = 10, Last4 = "4242" };

string json = JsonSerializer.Serialize(payment);
// {"$type":"card","Last4":"4242","Amount":10}
```

Repare na ordem. O `$type` é sempre escrito primeiro, antes das propriedades do próprio tipo derivado, e as propriedades do tipo base vêm por último. Isso não é cosmético, como a próxima seção explica.

4. **Desserialize através do tipo base.** O leitor olha o `$type`, encontra `CardPayment` e o constrói:

```csharp
// .NET 11, C# 14
PaymentMethod? back = JsonSerializer.Deserialize<PaymentMethod>(json);
Console.WriteLine(back is CardPayment); // True
```

5. **Renomeie o discriminador se `$type` colidir com o seu formato de transmissão.** `[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]` no tipo base muda o nome da propriedade. Duas coisas para saber: `$id`, `$ref` e `$values` são reservados e rejeitados, e o nome personalizado **não** passa pela política de nomes. Com `JsonSerializerOptions.Web`, um discriminador declarado como `"Kind"` continua `"Kind"` enquanto todas as outras propriedades ficam em camelCase. Escolha exatamente a capitalização que você quer no transporte.

Valores discriminadores também podem ser inteiros: `[JsonDerivedType(typeof(ClickEvent), 1)]` emite `{"$type":1,...}`. Misturar ids `string` e `int` na mesma hierarquia compila e funciona, mas deixa o payload mais difícil de consumir a partir de clientes que não são .NET. Escolha uma forma só.

## O tipo declarado decide, em todo lugar

A maioria dos relatos de "o discriminador sumiu" se resume a um ponto de chamada onde o tipo declarado é a classe derivada. A regra é mecânica e vale a pena internalizar como tabela. Tudo isso foi executado contra a mesma hierarquia acima:

| Ponto de chamada | Saída |
| --- | --- |
| `Serialize<PaymentMethod>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `Serialize<CardPayment>(card)` | `{"Last4":"4242","Amount":10}` |
| `Serialize(card)` onde `card` é do tipo `CardPayment` | `{"Last4":"4242","Amount":10}` |
| `Serialize<object>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| Elemento de `List<PaymentMethod>` | `[{"$type":"card",...}]` |
| Propriedade declarada como `PaymentMethod` | `{"Method":{"$type":"card",...}}` |
| Propriedade declarada como `CardPayment` | `{"Concrete":{"Last4":"9","Amount":3}}` |

A linha do `object` surpreende. `System.Object` não pode ser uma base polimórfica, mas quando o tipo declarado é `object` o serializador resolve o tipo em runtime e então aplica a configuração polimórfica do ancestral configurado mais próximo desse tipo. Então `Serialize<object>(card)` emite sim o discriminador, e `Serialize<object>(someUndeclaredSubtype)` lança exatamente como a chamada tipada pela base. Desserializar para `object` não é simétrico: você recebe um `JsonElement`, não um `CardPayment`.

No ASP.NET Core o tipo declarado é o tipo de retorno do endpoint, o que significa que a mesma tabela vale para as minimal APIs:

```csharp
// .NET 11, C# 14
app.MapGet("/payments/latest", () => (PaymentMethod)card);      // {"$type":"card","last4":"4242","amount":10}
app.MapGet("/payments/card",   () => card);                     // {"last4":"4242","amount":10}
app.MapGet("/typed",  () => TypedResults.Ok((PaymentMethod)card)); // discriminator present
app.MapGet("/typed2", () => TypedResults.Ok(card));             // discriminator absent
```

`TypedResults.Ok(card)` infere `Ok<CardPayment>`, e esse argumento genérico é o tipo declarado até chegar no `WriteAsJsonAsync`. Se um endpoint precisa retornar uma hierarquia, tipe o retorno da lambda como a base, ou use uma união explícita `Results<T1, T2>` para que o formato fique visível tanto para o serializador quanto para o gerador de OpenAPI. Retornar o tipo base é também o que o [guia de uniões com typed results](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) recomenda para qualquer coisa sobre a qual um cliente precise ramificar.

## A propriedade `$type` precisa vir primeiro

Por padrão o discriminador precisa estar no início do objeto JSON, agrupado com as demais propriedades de metadados `$id` e `$ref`. Este payload desserializa:

```json
{"$type":"card","Amount":10,"Last4":"4242"}
```

Este aqui lança `NotSupportedException: The JSON payload for polymorphic interface or abstract type 'PaymentMethod' must specify a type discriminator.`:

```json
{"Amount":10,"$type":"card","Last4":"4242"}
```

O motivo é o streaming. Ler em uma única passagem para a frente significa que o leitor precisa saber o tipo alvo antes de começar a vincular membros. A mensagem da exceção engana se você a lê por cima, porque o discriminador *está* no payload, só que tarde demais.

Desde o .NET 9 existe um opt-in:

```csharp
// .NET 11, C# 14, requires .NET 9 or later
var options = new JsonSerializerOptions { AllowOutOfOrderMetadataProperties = true };
var back = JsonSerializer.Deserialize<PaymentMethod>(json, options); // works
```

O custo é real, então não ligue isso globalmente sem pensar. Com a flag ativa, o desserializador não consegue mais processar as propriedades em uma passagem só, então ele armazena em buffer o objeto JSON inteiro na memória antes de vincular. Em um evento de 200 bytes isso é de graça. Em um documento de vários megabytes transmitido do blob storage é um risco de estourar a memória. Se o payload vem de um sistema que você controla, conserte o escritor. A origem comum de discriminadores fora de ordem é uma ida ao banco de dados: colunas `jsonb` do PostgreSQL normalizam a ordem das chaves, então um documento escrito corretamente pode voltar com `$type` no meio.

## Todas as exceções que esse recurso lança

Estas são as mensagens exatas do runtime, o que as torna pesquisáveis e acelera a triagem.

| Mensagem | Causa | Correção |
| --- | --- | --- |
| `Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.` | `[JsonDerivedType]` em um struct, uma classe selada ou um genérico aberto | Remova o sealed da base, ou introduza uma base ou interface não genérica |
| `Runtime type 'X' is not supported by polymorphic type 'Y'.` | Serializar um subtipo que nunca foi declarado | Adicione `[JsonDerivedType(typeof(X), "...")]`, ou configure `UnknownDerivedTypeHandling` |
| `The JSON payload for polymorphic interface or abstract type 'X' must specify a type discriminator.` | Discriminador ausente, ou não é a primeira propriedade | Emita `$type` primeiro, ou ligue `AllowOutOfOrderMetadataProperties` |
| `Read unrecognized type discriminator id 'x'.` | O payload nomeia um subtipo que você não declarou | Declare-o, ou ligue `IgnoreUnrecognizedTypeDiscriminators = true` |
| `The polymorphic type 'X' has already specified a type discriminator 'y'.` | Dois atributos `[JsonDerivedType]` compartilham um id | Deixe os ids discriminadores únicos por hierarquia |
| `The type 'X' contains property '$type' that conflicts with an existing metadata property name.` | Uma propriedade real serializa sob o nome do discriminador | Renomeie a propriedade, coloque `[JsonIgnore]`, ou renomeie o discriminador |
| `Runtime type 'X' has a diamond ambiguity between derived types 'A' and 'B'.` | `FallBackToNearestAncestor` com dois ancestrais igualmente próximos | Declare `X` explicitamente para que o fallback não seja necessário |
| `Deserialization of interface or abstract types is not supported. Type 'X'.` | Base abstrata sem nenhum discriminador declarado | Dê a cada `[JsonDerivedType]` um id discriminador |

O caso do discriminador não reconhecido lança `JsonException`; o resto lança `NotSupportedException` ou `InvalidOperationException`. Essa distinção importa se você captura falhas de serialização para retornar um 400: `JsonException` é o balde de "entrada inválida", enquanto `NotSupportedException` aqui quase sempre significa um erro de configuração do seu lado.

## Lidando com subtipos que você não declarou

Por padrão um subtipo não declarado é um erro duro na escrita, e esse é o padrão certo: degradar silenciosamente para o contrato base é como propriedades somem dos payloads em produção. Quando você realmente quer um modo de falha mais suave, `[JsonPolymorphic]` expõe a chave:

```csharp
// .NET 11, C# 14
[JsonPolymorphic(
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType,
    IgnoreUnrecognizedTypeDiscriminators = true)]
[JsonDerivedType(typeof(LeafNode), "leaf")]
public class Node
{
    public string Label { get; set; } = "";
}

public class DeepNode : Node { public int Depth { get; set; } }
```

Com essa configuração, serializar um `DeepNode` como `Node` escreve `{"Label":"x"}` em vez de lançar, e ler `{"$type":"unknown","Label":"x"}` produz um `Node` comum. Os dois ajustes só fazem sentido quando o tipo base é concreto e construível. `IgnoreUnrecognizedTypeDiscriminators` em uma base abstrata apenas empurra a falha um passo adiante, já que continua não havendo nada para instanciar.

A terceira opção, `JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor`, sobe até o ancestral declarado mais próximo. Ela é útil para hierarquias de interface onde outras equipes adicionam implementações, e é o único ajuste capaz de produzir o erro de ambiguidade em diamante: se um tipo implementa duas interfaces que são ambas tipos derivados declarados da raiz, o serializador se recusa a adivinhar.

## A configuração não é herdada hierarquia abaixo

Essa custa uma tarde para muita gente. A configuração polimórfica em um tipo base não se propaga através dos tipos intermediários:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(Middle), "middle")]
public abstract class Root { }

[JsonDerivedType(typeof(Leaf), "leaf")]
public class Middle : Root { }

public class Leaf : Middle { }

JsonSerializer.Serialize<Root>(new Leaf());
// NotSupportedException: Runtime type 'Leaf' is not supported by polymorphic type 'Root'.
```

`Middle` conhece `Leaf`, mas `Root` não, e o serializador não compõe as duas configurações. Toda base polimórfica precisa enumerar todos os tipos concretos que podem aparecer abaixo dela, incluindo os netos. Declarar `Leaf` tanto em `Root` quanto em `Middle` funciona, e cada nível pode usar seu próprio id discriminador, já que o id é resolvido contra o tipo base declarado no ponto de chamada.

## Quando você não pode anotar o tipo base

Atributos ficam fora de alcance para tipos de um pacote NuGet, de um cliente gerado ou de um assembly de contratos compartilhado que você não pode tocar. O modelo de contratos resolve isso: crie uma subclasse de `DefaultJsonTypeInfoResolver` e anexe `PolymorphismOptions` ao `JsonTypeInfo` do tipo base.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization.Metadata;

public class PaymentResolver : DefaultJsonTypeInfoResolver
{
    public override JsonTypeInfo GetTypeInfo(Type type, JsonSerializerOptions options)
    {
        JsonTypeInfo info = base.GetTypeInfo(type, options);

        if (info.Type == typeof(PaymentMethod))
        {
            info.PolymorphismOptions = new JsonPolymorphismOptions
            {
                TypeDiscriminatorPropertyName = "kind",
                IgnoreUnrecognizedTypeDiscriminators = true,
                UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FailSerialization,
                DerivedTypes =
                {
                    new JsonDerivedType(typeof(CardPayment), "card"),
                    new JsonDerivedType(typeof(PaypalPayment), "paypal")
                }
            };
        }

        return info;
    }
}

var options = new JsonSerializerOptions { TypeInfoResolver = new PaymentResolver() };
```

O resolver roda uma vez por tipo e o resultado fica em cache na instância de options, então o custo de reflexão é pago na inicialização, não a cada chamada. Essa é também a saída de emergência quando o discriminador precisa variar por endpoint ou por tenant: construa duas instâncias de options com dois resolvers em vez de tentar mutar uma. As options ficam somente leitura depois da primeira chamada de serialização, a mesma restrição descrita no [guia de JsonConverter personalizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Gerador de código-fonte e Native AOT

O polimorfismo funciona com o gerador de código-fonte, mas só no modo metadata. O caminho rápido (`JsonSourceGenerationMode.Serialization`) emite chamadas fixas ao `Utf8JsonWriter` para um formato conhecido e não tem onde ramificar conforme o tipo em runtime, então falha com `InvalidOperationException: TypeInfoResolver 'MyContext' did not provide property metadata for type 'CardPayment'.`

```csharp
// .NET 11, C# 14
[JsonSerializable(typeof(PaymentMethod))]
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
public partial class PaymentContext : JsonSerializerContext { }

string json = JsonSerializer.Serialize(payment, PaymentContext.Default.PaymentMethod);
// {"$type":"card","Last4":"4242","Amount":10}
```

Registrar o tipo base é suficiente; o gerador segue `[JsonDerivedType]` e emite metadados para cada subtipo declarado. É isso que torna o padrão seguro para trimming e para AOT, e é por isso que o polimorfismo é um dos poucos recursos com cara de reflexão que sobrevive à publicação com [Native AOT e minimal APIs](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). O que não sobrevive é qualquer subtipo que só existe em runtime, por exemplo um criado por uma biblioteca de mocking ou emitido dinamicamente.

## O que o ASP.NET Core coloca no documento OpenAPI

O gerador integrado `Microsoft.AspNetCore.OpenApi` lê os mesmos atributos, então um tipo de resposta polimórfico se documenta sozinho. Para a hierarquia de pagamentos acima, o schema gerado é:

```json
{
  "PaymentMethod": {
    "required": [ "$type" ],
    "type": "object",
    "anyOf": [
      { "$ref": "#/components/schemas/PaymentMethodCardPayment" },
      { "$ref": "#/components/schemas/PaymentMethodPaypalPayment" }
    ],
    "discriminator": {
      "propertyName": "$type",
      "mapping": {
        "card": "#/components/schemas/PaymentMethodCardPayment",
        "paypal": "#/components/schemas/PaymentMethodPaypalPayment"
      }
    }
  }
}
```

Cada schema derivado ganha uma propriedade `$type` tipada como um enum de valor único, que é o que permite aos geradores de cliente produzir uma união marcada. Vale repetir uma ressalva da documentação: a palavra-chave `discriminator` só aparece quando o tipo base é **abstrato**. Uma base concreta não consegue marcar `$type` como obrigatória em termos de OpenAPI, porque instâncias da própria base não têm discriminador, então o gerador descarta o objeto discriminator. Se o documento é uma entrega, torne a base abstrata. Se você precisa remodelar algo disso, isso acontece em um transformador de schema, coberto no [guia de transformadores do OpenAPI](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Detalhes menores que mordem

- **Record funciona, incluindo os posicionais.** `[JsonDerivedType(typeof(TextMessage), "text")]` em um record abstrato faz round-trip de `TextMessage(string Body)` sem cerimônia extra, porque o discriminador é lido antes de os argumentos do construtor serem vinculados.
- **Subtipos genéricos fechados são legais.** A base não pode ser genérica, mas `[JsonDerivedType(typeof(Envelope<int>), "int-envelope")]` está ok. Cada instanciação fechada precisa do próprio atributo e do próprio id.
- **Conversores personalizados e polimorfismo não se misturam.** Discriminadores só são suportados pelos conversores padrão de objetos, coleções e dicionários. Um `JsonConverter<T>` no tipo base substitui toda a maquinaria e precisa escrever o discriminador por conta própria.
- **`JsonSerializerOptions.Strict` (.NET 10) é compatível.** A propriedade `$type` é tratada como metadado, não como membro não mapeado, então `UnmappedMemberHandling.Disallow` não a rejeita. Propriedades de *dados* desconhecidas continuam lançando, que é justamente o objetivo do preset.
- **O `TypeNameHandling` do Newtonsoft.Json não tem equivalente, por design.** Embutir um nome de tipo CLR no payload é um vetor conhecido de gadgets de desserialização. `[JsonDerivedType]` exige uma lista explícita de permitidos, e por isso o caminho de migração a partir de `TypeNameHandling.All` é a aresta mais afiada ao [mover uma base de código grande para o System.Text.Json](/pt-br/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/).
- **Um discriminador errado aparece para quem chama como uma falha de conversão.** Se você está depurando isso de fora, os sintomas se sobrepõem à família geral de erros [JSON value could not be converted](/pt-br/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/).

O modelo mental que mantém tudo isso organizado: o tipo declarado seleciona o contrato, o contrato carrega a lista de permitidos de tipos derivados, e o discriminador é um metadado que precisa chegar antes dos dados que ele descreve. Todo modo de falha acima é uma dessas três frases sendo violada.

## Leitura relacionada

- [Como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: System.Text.Json.JsonException: The JSON value could not be converted](/pt-br/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Migrar do Newtonsoft.Json para o System.Text.Json em uma base de código grande](/pt-br/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Como usar Native AOT com as minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [record vs class vs struct em C#: uma matriz de decisão](/pt-br/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)

## Fontes

- [How to serialize properties of derived classes, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Referência de `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonderivedtypeattribute)
- [Referência de `JsonPolymorphicAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonSerializerOptions.AllowOutOfOrderMetadataProperties`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.allowoutofordermetadataproperties)
- [Personalizar um contrato JSON com o modelo de contratos](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)
- [Incluir metadados do OpenAPI em um app ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/include-metadata)
- [Strings de recurso do `System.Text.Json`, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/Resources/Strings.resx)
