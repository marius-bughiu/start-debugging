---
title: "System.Text.Json desabilitando a serialização baseada em reflexão"
description: "Desative os padrões de reflexão do System.Text.Json, entenda a InvalidOperationException e serialize com um contexto gerado em um exemplo executável .NET 8."
pubDate: 2023-10-21
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, defina `JsonSerializerIsReflectionEnabledByDefault` como `false` para desativar o fallback padrão por reflexão do `System.Text.Json`. Depois, forneça os metadados de serialização por meio de um contexto gerado a partir do código-fonte.

> **Correção — 2 de novembro de 2026:** A versão anterior citava a exceção errada e sugeria que bastava passar opções. Com os padrões de reflexão desativados, uma chamada comum de serialização lança `InvalidOperationException`; opções vazias não resolvem o problema.

## Desativar os padrões de reflexão

Adicione esta propriedade ao arquivo `.csproj`:

```xml
<PropertyGroup>
  <JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Com essa configuração, tanto `JsonSerializer.Serialize(widget)` quanto `JsonSerializer.Serialize(widget, new JsonSerializerOptions())` falham. Criar um objeto de opções não fornece os metadados do tipo. `JsonSerializer.IsReflectionEnabledByDefault` informa o valor efetivo da opção.

Essa opção controla o caminho padrão por reflexão do serializador; ela não desativa toda a reflexão na aplicação. Desde o .NET 8, `PublishTrimmed` também desativa esses padrões, a menos que você substitua a configuração explicitamente. Consulte a [nota de compatibilidade da Microsoft sobre trimming](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed).

## Serializar e desserializar com metadados gerados

Use este `Program.cs` completo em um projeto de console .NET 8 com a propriedade acima:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault);
var widget = new Widget(42, "Ada");
string json = JsonSerializer.Serialize(widget, DemoJsonContext.Default.Widget);
Widget restored = JsonSerializer.Deserialize(json, DemoJsonContext.Default.Widget)!;
Console.WriteLine(json);
Console.WriteLine($"Round trip: {restored.Id} {restored.Name}");

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

Saída:

```text
False
{"Id":42,"Name":"Ada"}
Round trip: 42 Ada
```

`[JsonSerializable]` registra `Widget`, e o contexto fornece diretamente seu `JsonTypeInfo<Widget>` gerado. Essas sobrecargas não precisam de uma instância separada de opções.

Se uma API aceitar `JsonSerializerOptions`, configure o resolver explicitamente:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default
};
string json = JsonSerializer.Serialize(widget, options);
```

Registre os tipos raiz realmente serializados, incluindo coleções quando necessário. Se seus modelos contêm enums, veja [JsonStringEnumConverter com Native AOT](/pt-br/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/). Para reutilizar opções congeladas, veja [MakeReadOnly e seu requisito de resolver](/pt-br/2023/09/net-8-mark-jsonserializeroptions-as-readonly/).

## Executar o exemplo verificado

[Baixe o projeto completo de opções do System.Text.Json](/examples/system-text-json-options.zip), extraia-o e execute:

```sh
dotnet run -c Release
```

O projeto sem dependências adicionais usa .NET 8 e verifica as chamadas padrão que falham, a serialização e desserialização geradas e o caminho pelo resolver de opções. Também testa as opções somente leitura. Todas as verificações foram executadas nos runtimes reais .NET 8.0.33 e .NET 10.0.10; os comandos separados estão no arquivo. O mesmo projeto também foi publicado e executado como Native AOT do .NET 8 em macOS arm64. As verificações de falha intencionais e as sobrecargas sensíveis à reflexão geram avisos de análise, documentados no registro.

Consulte o [guia de geração de código da Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation) para os tipos compatíveis e a integração na aplicação.
