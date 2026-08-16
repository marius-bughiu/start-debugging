---
title: "Como fazer o System.Text.Json ignorar uma propriedade com o modificador required"
description: "[JsonIgnore] em um membro required lança InvalidOperationException: marked required but does not specify a setter. Veja por que os dois recursos colidem e as quatro formas de ignorar a propriedade mesmo assim, medido no .NET 10."
pubDate: 2026-08-16
tags:
  - "system-text-json"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "serialization"
  - "json"
lang: "pt-br"
translationOf: "2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier"
translatedBy: "claude"
translationDate: 2026-08-16
---

Resposta curta: você não pode colocar `[JsonIgnore]` em um membro que tem o modificador `required` do C#. No momento em que o System.Text.Json monta o contrato daquele tipo, ele lança `InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter`, tanto na serialização quanto na desserialização. Existem quatro alternativas que funcionam, e qual delas você quer depende de "ignorar" significar *parar de escrever no JSON* ou *parar de exigir do JSON*. Se o tipo é seu, coloque `[SetsRequiredMembers]` em um construtor e mantenha o `[JsonIgnore]`. Se o tipo não é seu, limpe `JsonPropertyInfo.IsRequired` em um modificador de `DefaultJsonTypeInfoResolver`.

Tudo abaixo foi medido com o SDK .NET 10.0.201 contra o runtime 10.0.5 com C# 14. O System.Text.Json respeita o modificador `required` desde o .NET 7 e as APIs do modelo de contrato usadas aqui são estáveis desde o .NET 7, então o comportamento vale para o .NET 7 e posteriores, a menos que uma seção diga o contrário. A única exceção é `RespectRequiredConstructorParameters`, que chegou no .NET 9.

## Por que required e JsonIgnore não convivem

Os dois recursos parecem ortogonais. `required` é um recurso de linguagem do C# 11 que obriga quem chama a atribuir um membro em um inicializador de objeto, e `[JsonIgnore]` é uma instrução para o serializador. Eles colidem porque o System.Text.Json lê o modificador `required` e o transforma em metadados de serialização.

Conforme a [documentação de propriedades obrigatórias](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties), o modificador `required` do C# e `[JsonRequired]` "são equivalentes, e ambos mapeiam para o mesmo pedaço de metadados", a saber `JsonPropertyInfo.IsRequired`. Então `required` não é apenas um contrato do compilador, é um contrato de desserialização: a propriedade precisa aparecer no payload.

`[JsonIgnore]` funciona de outro jeito. Ele não remove a propriedade do contrato. Ele mantém o `JsonPropertyInfo` e retira os acessores. Dá para ver isso acontecendo pendurando um modificador no resolver e imprimindo o contrato:

```csharp
// .NET 10.0.5, C# 14
var probe = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Type != typeof(Ignored)) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    Console.WriteLine($"{p.Name}: IsRequired={p.IsRequired} hasSet={p.Set is not null} hasGet={p.Get is not null}");
            }
        }
    }
};

JsonSerializer.Deserialize<Ignored>("""{"Name":"a"}""", probe);

public class Ignored
{
    public required string Name { get; set; }
    [JsonIgnore] public required string InternalId { get; set; }
}
```

O modificador roda antes da validação, então ele imprime antes da exceção:

```text
Name: IsRequired=True hasSet=True hasGet=True
InternalId: IsRequired=True hasSet=False hasGet=False
InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter.
```

Aí está. `InternalId` continua no contrato, continua marcado como `IsRequired=True`, mas o `[JsonIgnore]` zerou os dois acessores. O serializador fica com uma propriedade que precisa preencher a partir do payload e sem nenhuma forma de preencher. Ele se recusa a montar o contrato, e é por isso que a mensagem da exceção fala de um setter ausente quando o seu código-fonte claramente tem um.

Duas consequências de isso ser uma falha de *validação do contrato* e não de desserialização:

- Também lança na serialização. `JsonSerializer.Serialize(new Ignored { Name = "a", InternalId = "x" })` falha com a mesma `InvalidOperationException`, mesmo que escrever JSON nunca precise de um setter.
- É uma falha em tempo de execução, não em tempo de compilação. Nada te avisa. O código vai para produção e então lança na primeira vez que aquele tipo for tocado.

A mesma coisa acontece com `[JsonRequired]` no lugar da palavra-chave `required`, e com campos `required` assim que `IncludeFields` estiver ligado. O que importa é a marca `IsRequired`, não como você a definiu.

## A reprodução mínima

```csharp
// .NET 10.0.5, C# 14
using System.Text.Json;
using System.Text.Json.Serialization;

var order = new Order { Id = 7, InternalAuditToken = "tok_abc" };

// Throws InvalidOperationException, not a JsonException.
string json = JsonSerializer.Serialize(order);

public class Order
{
    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

A intenção é óbvia e razoável: `InternalAuditToken` sempre precisa ser definido pelo seu próprio código (é para isso que serve `required`) e nunca pode trafegar pela rede (é para isso que serve `[JsonIgnore]`). O System.Text.Json simplesmente não tem como expressar as duas coisas ao mesmo tempo apenas com atributos.

## Marcar um construtor com SetsRequiredMembers

Essa é a solução para quando o tipo é seu. `System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute` informa ao compilador que um determinado construtor atribui todos os membros obrigatórios, de modo que quem chama não precisa mais fazer isso. O System.Text.Json também entende esse atributo, e quando ele está presente para de tratar os membros como obrigatórios.

```csharp
// .NET 10.0.5, C# 14
using System.Diagnostics.CodeAnalysis;

public class Order
{
    [SetsRequiredMembers]
    public Order()
    {
        Id = 0;
        InternalAuditToken = TokenFactory.NewToken();
    }

    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

Agora as duas direções funcionam. `JsonSerializer.Deserialize<Order>("""{"Id":7}""")` devolve uma instância cujo `InternalAuditToken` contém o que o construtor tiver produzido, e a serialização emite `{"Id":7}` sem sinal do token.

Vale entender o mecanismo, porque ele explica o raio de impacto. Imprimir o contrato de um tipo com e sem o atributo mostra o que muda:

```text
[without SetsRequiredMembers]
  Name: IsRequired=True  set=True
  InternalId: IsRequired=True  set=True

[with SetsRequiredMembers]
  Name: IsRequired=False set=True
  InternalId: IsRequired=False set=True
```

`[SetsRequiredMembers]` limpa `IsRequired` para **todos** os membros do tipo, não só para o ignorado. Se você contava com `required` para rejeitar payloads que omitem `Id`, essa validação sumiu junto com o erro que você estava tentando corrigir. Recoloque `[JsonRequired]` nos membros que ainda quer exigir:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    [SetsRequiredMembers]
    public Order() { Id = 0; InternalAuditToken = TokenFactory.NewToken(); }

    [JsonRequired]                       // keeps the payload requirement
    public required int Id { get; set; }

    [JsonIgnore]                         // no longer required by the serializer
    public required string InternalAuditToken { get; set; }
}
```

Essa combinação entrega exatamente a intenção original: o compilador do C# continua obrigando o seu próprio código a definir os dois membros, o contrato JSON continua rejeitando um payload sem `Id`, e o token nunca aparece no JSON.

## Limpar IsRequired com um modificador do resolver

Quando o tipo vem de um pacote que você não controla, ou você quer aplicar a regra a vários tipos de uma vez, edite o contrato em vez do tipo. Um modificador de `DefaultJsonTypeInfoResolver` roda depois que o contrato padrão é montado e antes de ele ser validado, então consegue desligar `IsRequired` a tempo.

A marreta genérica, tirada direto do exemplo do Microsoft Learn, remove a restrição em todo lugar:

```csharp
// .NET 10.0.5, C# 14
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Kind != JsonTypeInfoKind.Object) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    p.IsRequired = false;
            }
        }
    }
};
```

Isso normalmente é amplo demais. Uma versão direcionada se apoia em um atributo marcador seu, de forma que a política fica ao lado da propriedade que descreve e vale para todos os tipos do modelo:

```csharp
// .NET 10.0.5, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class ServerOwnedAttribute : Attribute;

public class Order
{
    public required int Id { get; set; }

    [ServerOwned]
    public required string? InternalAuditToken { get; set; }
}

var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                {
                    if (p.AttributeProvider?.IsDefined(typeof(ServerOwnedAttribute), inherit: true) != true)
                        continue;

                    p.IsRequired = false;                        // stop demanding it on read
                    p.ShouldSerialize = static (_, _) => false;  // stop emitting it on write
                }
            }
        }
    }
};
```

Resultados medidos com essas opções: `Deserialize<Order>("""{"Id":7}""")` funciona e deixa o token nulo, e `Serialize(new Order { Id = 7, InternalAuditToken = "secret" })` emite `{"Id":7}`. Repare que não há `[JsonIgnore]` na propriedade aqui. É o `ShouldSerialize` que suprime a escrita e, diferente do `[JsonIgnore]`, ele não retira os acessores, então não há erro de validação.

Se você preferir que a propriedade suma do contrato por completo, remova-a em vez de reconfigurá-la. `typeInfo.Properties` é uma lista mutável:

```csharp
// .NET 10.0.5, C# 14
for (int i = typeInfo.Properties.Count - 1; i >= 0; i--)
    if (typeInfo.Properties[i].Name == "InternalAuditToken")
        typeInfo.Properties.RemoveAt(i);
```

Isso também funciona nas duas direções, e é o mais próximo do que as pessoas esperam que o `[JsonIgnore]` faça. Lembre que `Name` aqui é o nome JSON, então ele reflete qualquer política de nomenclatura ou `[JsonPropertyName]` já aplicada. Se você for anexar isso a opções que já têm um resolver, vale ler antes a mecânica de [modificar um type info resolver existente](/pt-br/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/), e o mesmo ponto de extensão funciona para [contratos gerados por código-fonte](/pt-br/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/).

## Ignorar só na escrita, que é o que muita gente realmente quer

Metade das vezes o requisito é assimétrico: a propriedade precisa estar presente ao ler um payload, mas não deve ser devolvida ao escrever um. Hashes de senha, tokens de auditoria e identificadores internos costumam cair aqui. Esse caso tem uma resposta de primeira classe e nenhum conflito com `required`, porque o ignore condicional não retira os acessores:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    public required int Id { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public required string? InternalAuditToken { get; set; }
}
```

Medido: `Serialize(new Order { Id = 7, InternalAuditToken = null })` emite `{"Id":7}`, enquanto `Deserialize<Order>("""{"Id":7}""")` continua lançando `JsonException: JSON deserialization for type 'Order' was missing required properties including: 'InternalAuditToken'`. As duas metades ficam intactas. `JsonIgnoreCondition.WhenWritingDefault` se comporta do mesmo jeito para tipos por valor. Só o `[JsonIgnore]` puro, que significa `JsonIgnoreCondition.Always`, quebra.

A quarta opção, e muitas vezes a certa em uma superfície de API pública, é parar de fazer um único tipo cumprir dois papéis. Um DTO de transporte separado, sem membros `required`, mapeado de e para o seu tipo de domínio, contorna o problema inteiro e te dá um lugar para colocar depois as questões de versionamento. Custa um método de mapeamento e compra um contrato que você pode mudar sem tocar no seu modelo de domínio.

## Detalhes que vale conhecer antes de escolher

**Um `null` explícito satisfaz `required`.** `Deserialize<Order>("""{"Id":7,"InternalAuditToken":null}""")` funciona. `required` significa que a chave está presente, não que o valor seja significativo. Se você precisa de não nulo, isso é uma questão de validação, não de serialização.

**Um inicializador de propriedade também não satisfaz.** `public required string InternalId { get; set; } = "fallback";` continua lançando `JsonException` quando a chave falta no payload. O padrão é aplicado e então o serializador rejeita o payload do mesmo jeito.

**A mensagem de erro usa o nome JSON.** Com `[JsonPropertyName("internal_id")]` em uma propriedade obrigatória, a exceção de propriedade ausente diz `missing required properties including: 'internal_id'`, e não o nome do membro CLR. Útil quando há uma política de nomenclatura envolvida e você está procurando a string errada.

**Campos obrigatórios só são exigidos quando `IncludeFields` está ligado.** Um campo `public required string InternalId;` é invisível para o System.Text.Json por padrão, então um payload que o omite desserializa sem problema. Ligue `IncludeFields = true` e o mesmo tipo começa a lançar. Se você ligar essa opção em uma base de código existente, espere que isso apareça.

**Você não pode esconder o membro atrás de um setter privado.** `public required string InternalId { get; private set; }` não compila: o compilador do C# rejeita com `CS9032: Required member 'X' cannot be less visible or have a setter less visible than the containing type`. Isso fecha uma saída que as pessoas costumam tentar, e é primo do [erro CS9035 que aparece quando um inicializador de objeto esquece um membro obrigatório](/pt-br/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**A geração de código-fonte se comporta igual.** Desserializar através de um `JsonSerializerContext` produz exatamente a mesma `InvalidOperationException` para `[JsonIgnore]` mais `required`, e a mesma `JsonException` para uma propriedade obrigatória ausente. Inspecionar o código gerado com `EmitCompilerGeneratedFiles` mostra o porquê: ele emite `properties[0].IsRequired = true;` diretamente. Vale sinalizar porque a página do Microsoft Learn ainda recomenda usar `[JsonRequired]` em vez de `required` no modo de geração de código-fonte, alegando que "seu código não vai compilar" com a palavra-chave. No .NET 10 compila e funciona; `[SetsRequiredMembers]` também funciona através de um contexto gerado. Se você estiver em um SDK mais antigo, verifique antes de confiar nisso.

**`RespectRequiredConstructorParameters` é outro botão.** Introduzido no .NET 9, ele torna *parâmetros de construtor* não opcionais obrigatórios no payload. Não tem nada a ver com o modificador `required` em membros, e desligá-lo não vai te salvar aqui. Verificado: com um construtor `Order(string name, string internalId)` e sem opções, `Deserialize<Order>("""{"Name":"a"}""")` funciona e deixa o parâmetro no valor padrão; com `RespectRequiredConstructorParameters = true` a mesma chamada lança `JsonException`. Se o seu problema é um argumento de construtor ausente e não um membro ausente, é essa a flag para olhar.

Se o objetivo real é rejeitar payloads que trazem campos que você não modelou, esse é o problema espelhado e tem o seu próprio interruptor: veja [como lidar com membros ausentes e não mapeados durante a desserialização](/pt-br/2023/09/net-8-handle-missing-members-during-json-deserialization/). E quando a propriedade só precisa ser ignorada em algumas formas de uma hierarquia, um [JsonConverter personalizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) dá controle total sobre o que é escrito, ao custo de manter as rotas de leitura e escrita na mão.

Minha recomendação padrão: se o tipo é seu, `[SetsRequiredMembers]` em um construtor mais `[JsonRequired]` nos membros que você ainda quer exigir. São três linhas, mantém a garantia em nível de compilador que te fez escrever `required` em primeiro lugar, e não precisa de um objeto de opções customizado atravessando a sua aplicação.

## Fontes

- [Require properties for deserialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties) no Microsoft Learn, pela equivalência entre `required`, `[JsonRequired]` e `JsonPropertyInfo.IsRequired`, e pelo feature switch `RespectRequiredConstructorParameters`.
- [How to ignore properties with System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/ignore-properties) pela lista completa de `JsonIgnoreCondition` e pela configuração global `DefaultIgnoreCondition`.
- Referência de API de [JsonPropertyInfo.IsRequired](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.isrequired) e [JsonPropertyInfo.ShouldSerialize](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.shouldserialize).
- Referência de API de [SetsRequiredMembersAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.setsrequiredmembersattribute).
- [O modificador required](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) na referência da linguagem C#, incluindo a regra de visibilidade CS9032.
