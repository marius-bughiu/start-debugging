---
title: "System.Text.Json vs Newtonsoft.Json em 2026: qual você deve escolher?"
description: "Escolha System.Text.Json para código novo no .NET 11: já vem integrado, é cerca de 2x mais rápido e é o único que funciona com Native AOT. Recorra ao Newtonsoft.Json apenas para JSONPath, TypeNameHandling ou JSON realmente permissivo."
pubDate: 2026-05-22
tags:
  - "comparison"
  - "system-text-json"
  - "newtonsoft-json"
  - "dotnet"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/system-text-json-vs-newtonsoft-json-in-2026"
translatedBy: "claude"
translationDate: 2026-05-22
---

Se você está começando código novo no .NET 11 em 2026, use **System.Text.Json**. Ele já vem integrado com o runtime, serializa cerca de duas vezes mais rápido com uma fração das alocações e é o único dos dois que roda sob Native AOT. Recorra ao **Newtonsoft.Json** apenas quando você depender de um recurso que o System.Text.Json ainda não tem: consultas JSONPath, incorporação de tipos no estilo `TypeNameHandling`, ou a análise de JSON realmente malformado (aspas simples, chaves sem aspas). Ambas as bibliotecas estão vivas em 2026, mas não são mais equivalentes para trabalho novo.

Cada exemplo aqui tem como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11 e C# 14. System.Text.Json é a versão integrada que vem com o .NET 11. Newtonsoft.Json refere-se à versão 13.0.4, lançada em 2025-12-30, a estável atual no NuGet.

## A matriz de recursos em um relance

Esta é a tabela que você veio buscar. É a versão prática do [guia oficial de migração da Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), reduzida às decisões que de fato mudam qual pacote você referencia.

| Aspecto | System.Text.Json (.NET 11) | Newtonsoft.Json 13.0.4 |
| ------- | -------------------------- | ---------------------- |
| Vem integrado | Sim, parte do runtime | Não, pacote do NuGet |
| Desempenho (serializar) | Base, o mais rápido | ~2x mais lento |
| Alocações | Baseadas em Span, baixas | Mais altas |
| Native AOT / trimming | Sim, via gerador de código-fonte | Não |
| Permissividade padrão | Estrita (RFC 8259) | Permissiva |
| Comentários / vírgulas finais | Opcional | Ativado por padrão |
| Correspondência sem diferenciar maiúsculas | Opcional (ativada no ASP.NET Core) | Ativada por padrão |
| (De)serialização polimórfica | Sim, desde o .NET 7 (`[JsonDerivedType]`) | Sim (`TypeNameHandling`) |
| `TypeNameHandling.All` (incorporar tipo CLR) | Não, por design | Sim |
| JSONPath / `SelectToken` | Não | Sim |
| DOM LINQ-to-JSON | `JsonNode` / `JsonDocument` | `JObject` / `JArray` |
| `DataTable`, `ExpandoObject`, `BigInteger` | Requer conversor personalizado | Integrado |
| Aspas simples, chaves sem aspas | Rejeitadas, por design | Aceitas |
| Status de manutenção | Desenvolvimento ativo | Modo de manutenção |
| Licença | MIT | MIT |

O resumo é que as linhas em que o Newtonsoft.Json ainda vence são estreitas e específicas, enquanto as linhas em que o System.Text.Json vence (integrado, AOT, velocidade) se aplicam a quase todo projeto novo.

## Quando escolher System.Text.Json

Escolha-o como padrão para qualquer coisa nova no .NET 11. Concretamente:

- **APIs do ASP.NET Core.** O framework já usa System.Text.Json internamente e configura para você os padrões amigáveis para a web: nomes de propriedade em camelCase, correspondência sem diferenciar maiúsculas e suporte a números entre aspas. Adicionar `Microsoft.AspNetCore.Mvc.NewtonsoftJson` para recuperar o comportamento antigo é um passo para trás, a menos que um recurso específico force isso.
- **Qualquer coisa que rode sob Native AOT ou trimming agressivo.** Isto não é uma preferência, é um requisito rígido. System.Text.Json tem um [gerador de código-fonte](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) que emite os metadados de serialização em tempo de compilação, então nenhuma reflexão é necessária em tempo de execução. Newtonsoft.Json é construído sobre reflexão em tempo de execução e `Reflection.Emit`, que o AOT não permite. Se você se importa com os trade-offs aí, veja o detalhamento de [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Caminhos de alto throughput ou sensíveis à memória.** Serializadores, agentes de envio de log, consumidores de barramento de mensagens, qualquer coisa que rode em um loop apertado. System.Text.Json trabalha diretamente sobre `ReadOnlySpan<byte>` e UTF-8, evitando as alocações de string intermediárias que o Newtonsoft.Json faz.
- **Você quer uma saída determinística e em conformidade com a especificação.** System.Text.Json segue a RFC 8259 de forma estrita. Ele escapa caracteres sensíveis para HTML por padrão como medida de defesa em profundidade contra XSS e divulgação de informações, o que importa quando o JSON é incorporado em uma página.

Um contexto gerado por código-fonte é o padrão que desbloqueia o AOT e a inicialização mais rápida:

```csharp
// .NET 11, C# 14 - compile-time metadata, no runtime reflection
using System.Text.Json;
using System.Text.Json.Serialization;

[JsonSerializable(typeof(WeatherForecast))]
public partial class AppJsonContext : JsonSerializerContext;

var forecast = new WeatherForecast(DateOnly.FromDateTime(DateTime.Now), 22, "Mild");

// Pass the generated TypeInfo, not the raw type, to stay reflection-free
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);

public record WeatherForecast(DateOnly Date, int TemperatureC, string Summary);
```

System.Text.Json também fechou a maioria das lacunas históricas. Desde o .NET 7 ele faz (de)serialização polimórfica por meio de `[JsonDerivedType]`, e o .NET 9 adicionou várias opções há muito solicitadas: `RespectNullableAnnotations` para respeitar os tipos de referência não anuláveis, o atributo `JsonStringEnumMemberName` para renomear valores de enum, e `JsonSchemaExporter` para produzir um schema JSON a partir de um tipo do .NET. O .NET 10 adicionou a desserialização direta a partir de um `PipeReader` e um preset estrito de uma linha:

```csharp
// .NET 10 and later - the strict, spec-compliant defaults in one preset
var options = JsonSerializerOptions.Strict;

// .NET 10 and later - deserialize straight from a PipeReader, no stream adapter
WeatherForecast? f = await JsonSerializer.DeserializeAsync<WeatherForecast>(pipeReader);
```

## Quando escolher Newtonsoft.Json

Ainda há motivos reais para recorrer a ele. Escolha Newtonsoft.Json quando você esbarrar em um destes:

- **Você precisa de consultas JSONPath.** `SelectToken("$.store.book[0].title")` não tem equivalente integrado no System.Text.Json. `JsonNode` permite navegar por indexador, mas não há um motor de consultas por caminho. Se você analisa documentos arbitrários e extrai valores por caminho, Newtonsoft.Json é muito menos código.
- **Você depende de `TypeNameHandling`.** Newtonsoft.Json pode incorporar o nome do tipo CLR no payload (`$type`) e reconstruir o tipo exato em tempo de execução na volta. System.Text.Json se recusa a fazer isso por design, porque desserializar um nome de tipo controlado por um atacante é um vetor de execução remota de código bem conhecido. Se você tem um protocolo interno existente que depende disso, a migração não é uma flag de configuração, é um redesenho.
- **Você analisa JSON realmente permissivo ou não padrão.** Strings com aspas simples, nomes de propriedade sem aspas e outras entradas que não cumprem a RFC são aceitas pelo Newtonsoft.Json e rejeitadas pelo System.Text.Json por design. Comentários e vírgulas finais são opcionais no System.Text.Json (`ReadCommentHandling`, `AllowTrailingCommas`) mas aspas simples e chaves sem aspas não podem ser habilitadas de forma alguma.
- **Você serializa tipos sem suporte integrado.** `DataTable`, `ExpandoObject`, `TimeZoneInfo`, `BigInteger`, `DBNull` e `ValueTuple` todos precisam de um conversor personalizado no System.Text.Json. Newtonsoft.Json os trata de forma nativa.

A diferença de permissividade padrão é a que morde durante uma migração. O mesmo payload se comporta de forma diferente:

```csharp
// Newtonsoft.Json 13.0.4 - lenient by default, this parses fine
using Newtonsoft.Json;

var config = JsonConvert.DeserializeObject<Config>("""
{
    "Name": "api", // inline comment
    "Retries": 3,
}
""");

public record Config(string Name, int Retries);
```

```csharp
// .NET 11, System.Text.Json - strict by default, the same input throws JsonException
using System.Text.Json;

// You must opt in to match Newtonsoft.Json's leniency
var options = new JsonSerializerOptions
{
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    PropertyNameCaseInsensitive = true
};
var config = JsonSerializer.Deserialize<Config>(input, options);
```

Essa rigidez é a fonte mais comum da surpresa pós-migração em que um payload que funcionou por anos de repente lança uma exceção, que é também o motivo pelo qual erros como um [valor JSON que não pôde ser convertido](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) ou um [DateTime que não é analisado](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) aparecem logo após uma troca.

## O que os benchmarks de fato mostram

Desempenho é a afirmação mais fácil de tratar com vaguidão, então aqui vão números concretos em vez da palavra "mais rápido". Execuções publicadas de BenchmarkDotNet no .NET 10 serializando uma coleção de 10.000 objetos POCO simples mostram que System.Text.Json termina em cerca de 3.7 ms alocando 3.4 MB, contra Newtonsoft.Json em cerca de 7.6 ms e 8.1 MB para a mesma carga de trabalho.

| Métrica (serializar 10.000 POCOs) | System.Text.Json | Newtonsoft.Json 13.x |
| --------------------------------- | ---------------- | -------------------- |
| Tempo médio | ~3.7 ms | ~7.6 ms |
| Alocado | ~3.4 MB | ~8.1 MB |
| Relativo | 1.0x (base) | ~2.0x mais lento, ~2.4x memória |

A metodologia e as ressalvas importam, então leia estes números com honestidade:

- Os valores acima vêm de um benchmark público do .NET 10 (BenchmarkDotNet, configuração de release padrão) e são representativos, não dogma. Execute o BenchmarkDotNet contra as suas próprias formas de objeto antes de citar um número em uma revisão de design.
- A diferença é maior para POCOs simples e coleções grandes, exatamente a forma que domina APIs web e pipelines de mensagens.
- Para payloads minúsculos (um único objeto pequeno por requisição) a diferença absoluta é de microssegundos e raramente é o gargalo. Escolha pelos outros aspectos nesse caso.
- A geração de código-fonte amplia ainda mais a diferença a favor do System.Text.Json porque remove a reflexão por chamada. Newtonsoft.Json não tem equivalente.

O resumo é consistente em cada benchmark confiável de 2025 e 2026: System.Text.Json é cerca de duas vezes mais rápido e aloca entre a metade e um terço para o caso comum. A margem não se estreitou a favor do Newtonsoft.Json.

## Os detalhes que decidem por você

Às vezes uma única restrição encerra a decisão antes que as preferências entrem na sala.

**Native AOT é um portão fechado.** Se o seu alvo de implantação requer AOT (um contêiner enxuto, uma função com escalonamento a zero, uma build de iOS), Newtonsoft.Json simplesmente não é uma opção. Ele depende de reflexão em tempo de execução que o AOT não fornece. Esse único fato o desqualifica para uma classe inteira de cargas de trabalho modernas do .NET.

**Trajetória de manutenção.** Newtonsoft.Json não está morto nem obsoleto. James Newton-King, que agora trabalha na Microsoft no próprio System.Text.Json, ainda lança versões de segurança e correção de bugs (a 13.0.4 chegou em 2025-12-30). Mas está explicitamente em modo de manutenção: nenhum trabalho importante de recursos, nenhuma estratégia de AOT a caminho. System.Text.Json recebe novos recursos a cada versão do .NET. Apostar o código novo na biblioteca que evolui ativamente é a escolha de menor risco para um sistema que você vai manter por anos.

**O tratamento de referências e os ciclos de objetos diferem.** Newtonsoft.Json tem `ReferenceLoopHandling` e `PreserveReferencesHandling`. System.Text.Json os mapeia para `ReferenceHandler.IgnoreCycles` e `ReferenceHandler.Preserve`, mas o comportamento não é idêntico (`IgnoreCycles` escreve `null` onde o Newtonsoft.Json descarta a propriedade). Se você serializa grafos de entidades do EF Core, esta é a diferença entre um payload limpo e uma [exceção de possível ciclo de objetos](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). Saiba qual handler você precisa antes de migrar.

**As licenças são idênticas.** Ambas são distribuídas sob MIT, então diferente da situação do MediatR ou do AutoMapper, a licença não é um fator aqui. Não deixe "o Newtonsoft.Json ainda é gratuito?" conduzir a decisão: ele é, e o System.Text.Json também.

## A decisão, em uma linha

Para código novo no .NET 11 em 2026: use System.Text.Json por padrão, e adicione Newtonsoft.Json apenas quando você esbarrar em um recurso concreto e nomeado que ele não consegue fazer (JSONPath, `TypeNameHandling`, análise permissiva, ou um tipo não suportado sem conversor). Ele vem integrado, é mais rápido, está pronto para AOT e é o que a Microsoft continua construindo. Mantenha Newtonsoft.Json em sistemas existentes que dependam da sua flexibilidade; não apresse uma migração que não tem retorno, mas também não comece por ela. O padrão estratégico virou anos atrás, e em 2026 a diferença é ampla o suficiente para que o ônus da prova recaia sobre escolher Newtonsoft.Json, não sobre escolher a biblioteca integrada.

## Relacionado

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: a possible object cycle was detected with System.Text.Json](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [Fix: the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Fix: the JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)

## Fontes

- [Migrate from Newtonsoft.Json to System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) - a tabela autoritativa de diferenças de recursos e a lista de comportamentos padrão.
- [What's new in System.Text.Json in .NET 9](https://devblogs.microsoft.com/dotnet/system-text-json-in-dotnet-9/) - anotações de nulabilidade, nomes de membros de enum, exportador de schema.
- [JsonSerializer.DeserializeAsync (PipeReader overload)](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.deserializeasync?view=net-10.0) - a API de streaming do .NET 10.
- [Newtonsoft.Json releases](https://github.com/JamesNK/Newtonsoft.Json/releases) - a versão 13.0.4 e a cadência de manutenção atual.
