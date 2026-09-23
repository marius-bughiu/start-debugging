---
title: "Como serializar campos públicos como Vector3 e Quaternion com System.Text.Json"
description: "System.Text.Json escreve Vector3 como {} e Quaternion como {\"IsIdentity\":false} porque esses tipos guardam os dados em campos públicos. Veja como IncludeFields, um converter personalizado, um modificador de resolver e a geração de código resolvem isso, medido no .NET 10 e no .NET 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "system-text-json"
  - "csharp"
  - "dotnet-10"
  - "dotnet-11"
  - "serialization"
  - "json"
lang: "pt-br"
translationOf: "2026/09/how-to-serialize-vector3-and-quaternion-with-system-text-json"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Resposta curta:** `System.Numerics.Vector3`, `Vector2`, `Vector4`, `Quaternion`, `Plane` e `Matrix4x4` guardam seus dados em *campos* públicos, e o System.Text.Json ignora campos por padrão. Por isso `JsonSerializer.Serialize(new Vector3(1, 2.5f, -3))` retorna `{}`, e desserializar `{"X":1,"Y":2,"Z":3}` devolve silenciosamente `<0, 0, 0>`. Defina `IncludeFields = true` em `JsonSerializerOptions` (ou `[JsonSourceGenerationOptions(IncludeFields = true)]` em um contexto com geração de código) e adicione `IgnoreReadOnlyProperties = true` para que `Quaternion.IsIdentity` pare de vazar para a saída. Se você quer um formato compacto `[x, y, z]`, ou se serializa `Matrix4x4`, escreva um `JsonConverter<T>`.

Todas as saídas deste post foram capturadas executando o mesmo probe baseado em arquivo no .NET 10.0.10 (SDK 10.0.302) e no .NET 11.0.0 RC 1 (SDK 11.0.100-rc.1.26425.128). Os dois runtimes produziram saídas idênticas byte a byte, então nada aqui muda no .NET 11. As APIs de tratamento de campos (`IncludeFields`, `[JsonInclude]`) existem desde o .NET 5; as propriedades de linha `Matrix4x4.X/Y/Z/W`, que deixam a saída de matrizes mais ruidosa, são novas no .NET 10.

## Por que o System.Text.Json escreve um objeto vazio para Vector3

O System.Text.Json monta um contrato para cada tipo a partir das suas **propriedades** públicas de instância. Campos públicos só são considerados quando você opta por isso. Esse padrão está documentado na página [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), e é o oposto do que o Newtonsoft.Json fazia, e por isso pega muita gente de surpresa durante uma migração.

Os tipos de `System.Numerics` foram projetados para SIMD e interop, não para serialização. Seus componentes são campos mutáveis simples:

```csharp
// Shape of the types in System.Numerics (.NET 10), simplified
public struct Vector3    { public float X; public float Y; public float Z; }
public struct Quaternion { public float X; public float Y; public float Z; public float W;
                           public bool IsIdentity { get; } }
public struct Plane      { public Vector3 Normal; public float D; }
```

`Vector3` não tem nenhuma propriedade pública de instância que o serializador possa usar, então seu contrato fica vazio. `Quaternion` tem exatamente uma propriedade pública de instância, a calculada `IsIdentity`, então essa é a única coisa escrita. Nada lança exceção, nada gera aviso.

## A reprodução mínima

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1, C# 14
using System.Numerics;
using System.Text.Json;

var v = new Vector3(1f, 2.5f, -3f);
var q = Quaternion.CreateFromYawPitchRoll(0.5f, 0f, 0f);

Console.WriteLine(JsonSerializer.Serialize(v));
// {}
Console.WriteLine(JsonSerializer.Serialize(q));
// {"IsIdentity":false}
Console.WriteLine(JsonSerializer.Serialize(new Transform { Position = v, Rotation = q }));
// {"Position":{},"Rotation":{"IsIdentity":false}}

Vector3 back = JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""");
Console.WriteLine(back);
// <0. 0. 0>

public class Transform
{
    public Vector3 Position { get; set; }
    public Quaternion Rotation { get; set; }
}
```

A linha de desserialização é a perigosa. O JSON claramente contém `X`, `Y` e `Z`, mas como o contrato não tem membros com esses nomes, o serializador os trata como não mapeados e os pula. Você recebe `Vector3.Zero` e um teste verde, se o seu teste só verifica que a desserialização não lançou exceção.

Se você quer que essa classe de bug falhe de forma explícita, ative `UnmappedMemberHandling`:

```csharp
// .NET 10.0.10
var strict = new JsonSerializerOptions
{
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
};
JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""", strict);
// JsonException: The JSON property 'X' could not be mapped to any .NET member
// contained in type 'System.Numerics.Vector3'.
```

Essa configuração existe desde o .NET 8 e é abordada com mais detalhes em [como tratar membros ausentes e não mapeados durante a desserialização](/pt-br/2023/09/net-8-handle-missing-members-during-json-deserialization/).

## Correção 1: IncludeFields em JsonSerializerOptions

Esta é a correção de uma linha, e é a certa para a maioria dos apps:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
var options = new JsonSerializerOptions
{
    IncludeFields = true,
    IgnoreReadOnlyProperties = true
};

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);
// {"X":1,"Y":2.5,"Z":-3}
JsonSerializer.Serialize(Quaternion.Identity, options);
// {"X":0,"Y":0,"Z":0,"W":1}
JsonSerializer.Serialize(new Plane(new Vector3(0, 1, 0), 5), options);
// {"Normal":{"X":0,"Y":1,"Z":0},"D":5}

JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""", options);
// <1. 2. 3>
```

Por que `IgnoreReadOnlyProperties` também? Só com `IncludeFields = true`, `Quaternion` é serializado assim:

```json
{"IsIdentity":false,"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

`IsIdentity` é um dado derivado. Ele custa bytes em cada rotação que você escreve, e qualquer cliente que lê o seu JSON passa a ver um campo que parece gravável, mas é ignorado na volta. `IgnoreReadOnlyProperties` remove da saída as propriedades somente leitura, o que tira `IsIdentity` e mantém os quatro componentes. Ele não mexe em campos, então é seguro combinar os dois.

A desserialização funciona porque esses tipos são structs: o System.Text.Json cria uma instância padrão e atribui os campos, sem precisar do construtor `Vector3(float, float, float)`. Um componente ausente fica `0`, então `{"X":1}` vira `<1, 0, 0>`.

Duas coisas para saber sobre `IncludeFields`:

- **Ele é global.** Todo tipo no grafo passa a ter seus campos públicos serializados. Se alguns dos seus próprios DTOs têm campos públicos que você não pretendia expor, eles também aparecem na saída. Procure campos `public` nos seus tipos serializados antes de ativá-lo em uma instância de opções compartilhada.
- **Ele muda o comportamento de `required`.** Um campo público `required` é invisível para o System.Text.Json até que os campos sejam incluídos; depois disso, um payload que o omite passa a lançar exceção. Eu medi isso no post sobre [ignorar propriedades que têm o modificador `required`](/pt-br/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/).

### Por que [JsonInclude] não ajuda aqui

A alternativa por membro a `IncludeFields` é `[JsonInclude]`, mas ele vai no *campo*, e `System.Numerics.Vector3` não é seu. Colocá-lo em um membro seu do tipo `Vector3` não faz nada pelos campos dentro dele:

```csharp
// .NET 10.0.10
public class Holder
{
    [JsonInclude] public Vector3 Pos = new(1, 2, 3);
}

JsonSerializer.Serialize(new Holder());
// {"Pos":{}}
```

`[JsonInclude]` tornou o próprio `Pos` parte do contrato de `Holder`. O contrato de `Vector3` continua vazio.

## Correção 2: um JsonConverter para um formato de array compacto

Componentes nomeados são legíveis, mas um arquivo de cena ou um fluxo de telemetria com milhares de posições paga por `"X":`, `"Y":`, `"Z":` em cada uma. glTF e GeoJSON usam arrays para vetores. Um converter entrega esse formato e torna a escolha independente de qualquer opção global:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1, C# 14
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class Vector3ArrayConverter : JsonConverter<Vector3>
{
    public override Vector3 Read(ref Utf8JsonReader reader, Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray)
            throw new JsonException("Expected [x, y, z].");

        Span<float> c = stackalloc float[3];
        for (int i = 0; i < 3; i++)
        {
            if (!reader.Read() || reader.TokenType != JsonTokenType.Number)
                throw new JsonException("Expected [x, y, z].");
            c[i] = reader.GetSingle();
        }

        if (!reader.Read() || reader.TokenType != JsonTokenType.EndArray)
            throw new JsonException("Expected [x, y, z].");

        return new Vector3(c);
    }

    public override void Write(Utf8JsonWriter writer, Vector3 value,
        JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteNumberValue(value.X);
        writer.WriteNumberValue(value.Y);
        writer.WriteNumberValue(value.Z);
        writer.WriteEndArray();
    }
}
```

Registre-o nas opções ou com `[JsonConverter(typeof(Vector3ArrayConverter))]` na propriedade:

```csharp
// .NET 10.0.10
var options = new JsonSerializerOptions { Converters = { new Vector3ArrayConverter() } };

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);  // [1,2.5,-3]
JsonSerializer.Deserialize<Vector3>("[1,2,3]", options);         // <1. 2. 3>
JsonSerializer.Deserialize<Vector3>("[1,2]", options);           // JsonException: Expected [x, y, z].
```

Um converter cobre apenas o tipo para o qual foi registrado. Na reprodução de `Transform` acima, essa instância de opções escreve `{"Position":[1,2.5,-3],"Rotation":{"IsIdentity":false}}`: a posição está corrigida, a rotação continua quebrada. Escreva um converter por tipo que você usa (uma versão para `Quaternion` é o mesmo código com quatro componentes), ou combine o converter com `IncludeFields = true` para o resto. Para a mecânica do reader e do writer, incluindo por que você deve deixar o reader no último token consumido, veja [como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Correção 3: Matrix4x4 precisa de um converter, não de IncludeFields

`Matrix4x4` é onde `IncludeFields` desmorona no .NET 10 e posteriores. A struct tem 16 campos públicos, de `M11` a `M44`, e o .NET 10 adicionou as propriedades de linha de leitura e escrita `X`, `Y`, `Z` e `W` (cada uma um `Vector4`), além da propriedade de leitura e escrita `Translation` que já existia. Como essas têm setters, `IgnoreReadOnlyProperties` não as remove. O resultado para `Matrix4x4.CreateTranslation(1, 2, 3)` com `IncludeFields = true`:

```json
{"IsIdentity":false,"Translation":{"X":1,"Y":2,"Z":3},
 "X":{"X":1,"Y":0,"Z":0,"W":0},"Y":{"X":0,"Y":1,"Z":0,"W":0},
 "Z":{"X":0,"Y":0,"Z":1,"W":0},"W":{"X":1,"Y":2,"Z":3,"W":1},
 "M11":1,"M12":0,"M13":0,"M14":0,"M21":0,"M22":1,"M23":0,"M24":0,
 "M31":0,"M32":0,"M33":1,"M34":0,"M41":1,"M42":2,"M43":3,"M44":1}
```

Cada valor é escrito duas vezes, e de `M41` a `M43` três vezes. O round-trip funciona, mas na desserialização os membros são aplicados na ordem em que aparecem no JSON, e o último a escrever vence. Eu verifiquei: `{"M41":9,"W":{"X":1,"Y":2,"Z":3,"W":1}}` produz `M41 == 1`, e os mesmos membros na ordem inversa produzem `M41 == 9`. Um cliente que edita uma representação e não a outra recebe uma matriz que depende da ordem das chaves. Note também que um payload parcial como `{"M11":1}` gera uma matriz com zeros em todo o resto, e não `Matrix4x4.Identity`, porque o valor inicial é `default`.

Para matrizes, escreva um converter que emite os 16 campos `M` como um array plano em ordem de linha (row-major), no mesmo padrão de `Vector3ArrayConverter` com um loop de 16 elementos. É menos código do que se defender do formato duplicado.

## Correção 4: remover membros com um modificador de resolver

Se você quer componentes nomeados (o formato da Correção 1), mas precisa de controle preciso, por exemplo porque não pode usar `IgnoreReadOnlyProperties` já que seus próprios DTOs dependem de propriedades somente leitura sendo escritas, personalize o contrato apenas para os tipos numéricos:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

var options = new JsonSerializerOptions
{
    IncludeFields = true,
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            ti =>
            {
                if (ti.Type != typeof(Quaternion) && ti.Type != typeof(Matrix4x4))
                    return;

                for (int i = ti.Properties.Count - 1; i >= 0; i--)
                {
                    if (ti.Properties[i].Name is "IsIdentity" or "Translation")
                        ti.Properties.RemoveAt(i);
                }
            }
        }
    }
};

JsonSerializer.Serialize(Quaternion.CreateFromYawPitchRoll(0.5f, 0f, 0f), options);
// {"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

Esta é a mesma técnica de [modificar um type info resolver existente](/pt-br/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/). O ganho está no escopo por tipo: seus próprios tipos mantêm o contrato padrão. Note que no .NET 10+ isso ainda deixa as linhas `X/Y/Z/W` de `Matrix4x4` no lugar, o que é mais um argumento a favor do converter de matriz.

## Geração de código e Native AOT

Se você usa um `JsonSerializerContext` (obrigatório para Native AOT e apps com trimming), a chave fica no contexto em vez das opções:

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
[JsonSourceGenerationOptions(IncludeFields = true, IgnoreReadOnlyProperties = true)]
[JsonSerializable(typeof(Transform))]
internal partial class SceneContext : JsonSerializerContext;

JsonSerializer.Serialize(new Transform { Position = v, Rotation = q },
    SceneContext.Default.Transform);
// {"Position":{"X":1,"Y":2.5,"Z":-3},"Rotation":{"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}}
```

Um contexto sem `IncludeFields = true` gera o mesmo contrato vazio que você viu na reprodução: `{}` para `Vector3`, medido. Converters personalizados também funcionam com geração de código; adicione-os com `[JsonSourceGenerationOptions(Converters = [typeof(Vector3ArrayConverter)])]`.

Uma armadilha em que caí ao montar o probe: apps baseados em arquivo do .NET 10 (`dotnet run probe.cs`) usam `PublishAot=true` por padrão, o que desativa a serialização baseada em reflection. Chamar `JsonSerializer.Serialize(v)` sem um contexto então lança `InvalidOperationException: Reflection-based serialization has been disabled for this application`. Use um contexto, ou adicione `#:property JsonSerializerIsReflectionEnabledByDefault=true` para um experimento rápido. O contexto está em [desativar a serialização baseada em reflection no System.Text.Json](/pt-br/2023/10/system-text-json-disable-reflection-based-serialization/).

## Armadilhas: NaN, precisão, maiúsculas e minúsculas, e vetores no estilo Unity

**NaN e infinito lançam exceção.** Um passo de física que divide por zero produz componentes `NaN`, e o `Utf8JsonWriter` os recusa:

```csharp
// .NET 10.0.10
JsonSerializer.Serialize(new Vector3(float.NaN, 0, 0), new JsonSerializerOptions { IncludeFields = true });
// ArgumentException: .NET number values such as positive and negative infinity
// cannot be written as valid JSON.
```

`NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals` os escreve como strings, `{"X":"NaN","Y":"Infinity","Z":0}`. Se isso é melhor do que falhar depende de quem lê o JSON; o `JSON.parse` do JavaScript devolve a string `"NaN"`, não um número.

**Floats fazem round-trip na representação mais curta.** `new Vector3(0.1f, 1f/3f, 1e-8f)` é serializado como `{"X":0.1,"Y":0.33333334,"Z":1E-08}`. O System.Text.Json escreve a string mais curta que volta para o mesmo `float`, então não há perda de precisão, mas um consumidor que faz o parse para `double` vê `0.33333334`, não `1/3`.

**Políticas de nomenclatura se aplicam a campos.** `JsonSerializerDefaults.Web` mais `IncludeFields = true` escreve `{"x":1,"y":2.5,"z":-3}`, e lê qualquer uma das grafias porque os padrões Web não diferenciam maiúsculas de minúsculas. Se um cliente JavaScript espera `X` maiúsculo, não use os padrões Web para esse payload.

**Vetores no estilo Unity explodem com um erro de ciclo.** `UnityEngine.Vector3` também guarda `x`, `y`, `z` em campos, mas tem propriedades calculadas como `normalized`, que retornam outro `Vector3`. Uma struct com esse formato, serializada com ou sem `IncludeFields`, falha porque `normalized` tem seu próprio `normalized`, para sempre:

```text
JsonException: A possible object cycle was detected. This can either be due to a cycle
or if the object depth is larger than the maximum allowed depth of 64.
Path: $.normalized.normalized.no...
```

`ReferenceHandler.IgnoreCycles` não ajuda, já que não há referências para rastrear em uma struct; cada `normalized` é um valor novo. `IgnoreReadOnlyProperties = true` com `IncludeFields = true` resolveu no meu teste e gerou `{"x":3,"y":0,"z":4}`, que fez o round-trip corretamente. Testei com uma struct no formato da do Unity (campos mais as propriedades somente leitura `magnitude`, `sqrMagnitude` e `normalized`), não dentro do editor do Unity, que tem seu próprio serializador. Mais sobre essa exceção em [como corrigir "A possible object cycle was detected"](/pt-br/2026/05/fix-possible-object-cycle-was-detected-system-text-json/).

## Qual correção escolher

1. Adicione `IncludeFields = true` e `IgnoreReadOnlyProperties = true` às suas opções (ou ao seu `JsonSourceGenerationOptions`) se você serializa `Vector2`, `Vector3`, `Vector4`, `Quaternion` ou `Plane` e não se importa com objetos `{"X":..,"Y":..}`.
2. Ative `UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow` nos testes, para que um tipo futuro com o mesmo problema de campos falhe em vez de ser desserializado como zeros.
3. Escreva um `JsonConverter<T>` para `Matrix4x4`, e também para vetores se o tamanho do payload importa ou se uma especificação (glTF, GeoJSON) exige arrays.
4. Use um modificador de `DefaultJsonTypeInfoResolver` quando `IncludeFields` precisa ficar ativo, mas uma propriedade específica tem que sair, sem mudar como seus próprios tipos são serializados.

Se você está vindo do `BinaryFormatter`, que serializava essas structs campo a campo sem perguntar, a mesma decisão sobre `IncludeFields` aparece no [guia de migração do BinaryFormatter](/pt-br/2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet/).

## Relacionados

- [Como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Como fazer o System.Text.Json ignorar uma propriedade que tem o modificador required](/pt-br/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/)
- [Como corrigir "A possible object cycle was detected" no System.Text.Json](/pt-br/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [.NET 8: incluir membros não públicos na serialização JSON](/pt-br/2023/09/net-8-include-non-public-members-in-json-serialization/)
- [System.Text.Json: modificar um type info resolver existente](/pt-br/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)

## Fontes

- [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields), Microsoft Learn
- [`JsonSerializerOptions.IncludeFields`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.includefields) e [`IgnoreReadOnlyProperties`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.ignorereadonlyproperties)
- [Propriedade `Matrix4x4.X`](https://learn.microsoft.com/dotnet/api/system.numerics.matrix4x4.x), válida para .NET 10 e .NET 11
- [Customize a JSON contract](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/custom-contracts), Microsoft Learn
- [`JsonNumberHandling`](https://learn.microsoft.com/dotnet/api/system.text.json.serialization.jsonnumberhandling)
