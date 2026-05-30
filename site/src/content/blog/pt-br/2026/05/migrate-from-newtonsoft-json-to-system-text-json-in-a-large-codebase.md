---
title: "Migrar de Newtonsoft.Json 13 para System.Text.Json em uma base de código grande de .NET 11"
description: "Um guia com versões fixadas para trocar o Newtonsoft.Json 13.0.4 pelo System.Text.Json embutido no .NET 11: os mapeamentos de atributos e opções, os valores padrão que mudam seu formato de saída silenciosamente, uma estratégia de implantação em etapas, a verificação e os problemas que afetam bases de código grandes."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "newtonsoft-json"
  - "system-text-json"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase"
translatedBy: "claude"
translationDate: 2026-05-30
---

Trocar o `Newtonsoft.Json` pelo `System.Text.Json` em uma base de código grande raramente é um trabalho de localizar e substituir. As duas bibliotecas discordam nos valores padrão de maneiras que mudam sua saída serializada e quebram a desserialização silenciosamente, então uma troca ingênua envia uma mudança de contrato para cada consumidor do seu JSON. Reserve alguns dias para um serviço pequeno e de duas a quatro semanas para uma base de código extensa com conversores personalizados, payloads polimórficos e análise com `dynamic`/`JObject`. O ganho é real: `System.Text.Json` vem de fábrica com o runtime, serializa cerca de duas vezes mais rápido com uma fração das alocações, e é o único dos dois que roda sob Native AOT. Este artigo fixa `Newtonsoft.Json` 13.0.4 (a versão estável atual, lançada em 2025-12-30) como origem e o `System.Text.Json` embutido no .NET 11 SDK com C# 14 como destino. Se você ainda está decidindo se vai migrar ou não, leia primeiro [System.Text.Json vs Newtonsoft.Json em 2026](/pt-br/2026/05/system-text-json-vs-newtonsoft-json-in-2026/); este artigo assume que você já decidiu migrar.

## Por que migrar agora

- `System.Text.Json` faz parte do framework compartilhado no .NET 11. Remover o `PackageReference` do `Newtonsoft.Json` elimina uma dependência transitiva que o runtime, o ASP.NET Core e a plataforma de testes têm descartado ativamente.
- Throughput. Em payloads POCO típicos, o `System.Text.Json` serializa cerca de 2x mais rápido que o `Newtonsoft.Json` com alocações marcadamente menores, porque trabalha diretamente sobre bytes UTF-8 com `Utf8JsonReader` e `Utf8JsonWriter` em vez de passar por `string` e `TextReader`.
- Native AOT e trimming. `Newtonsoft.Json` depende de reflexão e não funciona sob Native AOT. `System.Text.Json` tem um modo de gerador de código-fonte (`JsonSerializerContext`) que emite metadados de serialização compatíveis com AOT e seguros para o trimming em tempo de compilação. Se [Native AOT](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) está no seu roadmap, esta migração é um pré-requisito, não uma otimização.
- Postura de segurança. `System.Text.Json` é estrito por padrão (RFC 8259), faz escape de caracteres sensíveis a HTML e não ASCII na saída, e não interpreta JSON malformado. Isso elimina uma classe de surpresas de injeção e análise que os valores padrão permissivos do `Newtonsoft.Json` permitem.

## O que quebra

O perigo desta migração não é o código que não compila. É o código que compila bem e muda seu formato de saída. Esta tabela é a que deve ser lida duas vezes.

| Área                              | Mudança                                                                                        | Severidade |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| Correspondência de nomes de propriedade | `Newtonsoft.Json` não diferencia maiúsculas na leitura por padrão; `System.Text.Json` diferencia | alta     |
| Comentários e vírgulas finais     | Aceitos por padrão no `Newtonsoft.Json`, lançam `JsonException` no `System.Text.Json`           | alta       |
| JSON com aspas simples / sem aspas | Aceito pelo `Newtonsoft.Json`, rejeitado por design no `System.Text.Json`                      | alta       |
| Valor não-string em propriedade `string` | `Newtonsoft.Json` converte `1` ou `true`; `System.Text.Json` lança exceção                | alta       |
| Números entre aspas               | `Newtonsoft.Json` lê `"23"` em um `int`; `System.Text.Json` precisa de `NumberHandling`         | média      |
| Escape de caracteres              | `System.Text.Json` faz escape de forma mais agressiva, então os bytes de saída diferem para não-ASCII e HTML | média |
| `[JsonProperty("name")]`          | Vira `[JsonPropertyName("name")]`; não há opções combinadas de ignore/required em um atributo   | média      |
| `TypeNameHandling.All`            | Não há equivalente, por design. O polimorfismo usa `[JsonDerivedType]` em vez disso             | alta       |
| `JObject` / `JToken` / `dynamic`  | Substituídos por `JsonNode` / `JsonDocument` / `JsonElement` com uma API diferente              | média      |
| `JsonConvert.PopulateObject`      | Não há equivalente embutido; precisa de um conversor personalizado ou mesclagem manual          | média      |
| `ReferenceLoopHandling.Ignore`    | Não há modo "descartar o loop silenciosamente"; você tem `ReferenceHandler.Preserve` ou redesenha o grafo | média |
| `DateFormatString`, `DateTimeZoneHandling` | Não há controle global de formato de data; precisa de um `JsonConverter<DateTime>` personalizado | média |
| Precedência de registro de conversores | A coleção `Converters` agora sobrepõe um atributo no nível do tipo (invertido em relação ao `Newtonsoft.Json`) | baixa |

A referência autoritativa para cada linha aqui é o [guia de migração da Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), que também lista o punhado de recursos (consultas `JsonPath`, `TypeNameHandling.All`, análise de aspas simples) que não têm solução alternativa.

## Lista de verificação prévia

Faça tudo isso antes de apagar um único `using Newtonsoft.Json`.

1. Fixe o contrato. Se o seu JSON cruza um limite de processo (uma API pública, uma fila de mensagens, uma coluna persistida), capture amostras de referência da saída atual. Serialize um conjunto representativo de objetos com `Newtonsoft.Json` 13.0.4 e guarde as strings como fixtures de teste. Elas são seu oráculo de regressão.
2. Inventarie a superfície. Use grep em tudo que toca a biblioteca antiga para conhecer o tamanho do trabalho:
   ```bash
   # run from the repo root; counts the call sites you have to touch
   grep -rEl "Newtonsoft\.Json|JsonConvert|JObject|JArray|JToken|JsonProperty|JsonSerializerSettings" --include="*.cs" .
   ```
   Verifique: a lista de arquivos corresponde ao seu modelo mental de onde a serialização vive. Surpresas aqui (um conversor enterrado em um auxiliar de log) são exatamente o que você quer encontrar agora.
3. Sinalize os recursos sem solução alternativa. Procure especificamente por `TypeNameHandling`, `SelectToken`, `SelectTokens` e fixtures de teste com aspas simples. Se encontrar `TypeNameHandling.All` ou `.Auto`, pare e projete a substituição do polimorfismo antes de continuar, porque não há substituto direto para isso.
4. Confirme o destino. Execute `dotnet --version` e confirme `11.0.x`. `System.Text.Json` vem embutido, então não há pacote a adicionar para os cenários principais; você só adiciona `System.Text.Json` como um `PackageReference` explícito se precisar de uma versão out-of-band mais nova do que a que o SDK inclui.

## Passos de migração

1. **Mapeie as opções globais.**

   `Newtonsoft.Json` centraliza o comportamento em `JsonSerializerSettings`. `System.Text.Json` usa `JsonSerializerOptions`. Traduza seu objeto de configuração existente campo por campo; não aceite os valores padrão do `System.Text.Json` cegamente, porque eles diferem do que seu código vem emitindo há anos.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: Newtonsoft.Json 13.0.4
   var settings = new JsonSerializerSettings
   {
       ContractResolver = new CamelCasePropertyNamesContractResolver(),
       NullValueHandling = NullValueHandling.Ignore,
       ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
   };

   // AFTER: System.Text.Json (in-box on .NET 11)
   var options = new JsonSerializerOptions
   {
       PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
       PropertyNameCaseInsensitive = true,                       // restore Newtonsoft read behavior
       DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
       ReferenceHandler = ReferenceHandler.IgnoreCycles,         // closest match to ReferenceLoopHandling.Ignore
       // AllowTrailingCommas = true,                            // uncomment only if your inputs have them
       // ReadCommentHandling = JsonCommentHandling.Skip,        // uncomment only if your inputs have comments
   };
   ```

   Verifique: serialize seus objetos de amostra de referência com estas `options` e compare com os fixtures do passo 1 do preflight. A diferença deve estar vazia ou explicada. `PropertyNameCaseInsensitive = true` é a linha mais importante para bases de código grandes, porque inúmeros caminhos de desserialização dependem silenciosamente da correspondência sem diferenciar maiúsculas do `Newtonsoft.Json`.

2. **Substitua os atributos.**

   A renomeação de atributos é mecânica, mas `[JsonProperty]` empacotava várias responsabilidades em um único atributo que o `System.Text.Json` separa.

   ```csharp
   // .NET 11, C# 14
   // BEFORE
   public class Order
   {
       [JsonProperty("order_id")]
       public int Id { get; set; }

       [JsonProperty("notes", NullValueHandling = NullValueHandling.Ignore)]
       public string? Notes { get; set; }

       [JsonProperty(Required = Required.Always)]
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }

   // AFTER
   public class Order
   {
       [JsonPropertyName("order_id")]
       public int Id { get; set; }

       [JsonPropertyName("notes")]
       [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
       public string? Notes { get; set; }

       [JsonRequired]                       // or the C# `required` modifier
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }
   ```

   Verifique: o projeto compila com zero diretivas `using` de `Newtonsoft.Json` no assembly de modelos, e um teste de ida e volta (`Deserialize(Serialize(order))`) preserva cada campo.

3. **Porte os conversores personalizados.**

   É aqui que as horas vão embora. As formas são similares mas os contratos diferem: os conversores do `System.Text.Json` trabalham sobre `Utf8JsonReader` (um `ref struct`) e `Utf8JsonWriter`, e `Read` é chamado posicionado no primeiro token.

   ```csharp
   // .NET 11, C# 14 -- a converter that reads/writes DateTime in a fixed format,
   // replacing Newtonsoft's DateFormatString / DateTimeZoneHandling settings.
   public sealed class Iso8601DateTimeConverter : JsonConverter<DateTime>
   {
       public override DateTime Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions o)
           => DateTime.ParseExact(reader.GetString()!, "yyyy-MM-dd'T'HH:mm:ss'Z'",
                                  CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

       public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions o)
           => writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",
                                      CultureInfo.InvariantCulture));
   }
   ```

   Registre-o em `options.Converters`, não apenas como um atributo de tipo, e note a mudança de precedência: no `System.Text.Json` um conversor na coleção `Converters` sobrepõe um atributo `[JsonConverter]` no nível do tipo, o contrário do `Newtonsoft.Json`. Os detalhes mecânicos estão em [como escrever um JsonConverter personalizado em System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Verifique cada conversor portado contra seu próprio fixture, não apenas o payload de ponta a ponta, para que uma surpresa de precedência não se esconda atrás de um teste de integração que passa.

4. **Substitua o polimorfismo e o TypeNameHandling.**

   Se você usava `TypeNameHandling` para fazer ida e volta de uma hierarquia de classes, não há equivalente, e isso é deliberado: `TypeNameHandling.All` é um vetor de execução remota de código bem conhecido. `System.Text.Json` faz polimorfismo discriminado com atributos no tipo base.

   ```csharp
   // .NET 11, C# 14
   [JsonDerivedType(typeof(Dog), typeDiscriminator: "dog")]
   [JsonDerivedType(typeof(Cat), typeDiscriminator: "cat")]
   public abstract class Animal { public string Name { get; set; } = ""; }

   public sealed class Dog : Animal { public bool GoodBoy { get; set; } }
   public sealed class Cat : Animal { public int Lives { get; set; } }
   ```

   Isso emite um discriminador `"$type": "dog"` e o lê de volta para o subtipo correto. Verifique: serialize uma `List<Animal>` de subtipos misturados, desserialize-a e confirme que os tipos em tempo de execução sobrevivem. Note que o formato de saída mudou (uma string discriminadora explícita em vez do `$type` qualificado por assembly do `Newtonsoft.Json`), então qualquer consumidor externo deve ser atualizado em conjunto.

5. **Converta a análise com dynamic e JObject.**

   O código que mexe em JSON sem tipo via `JObject`/`JToken`/`dynamic` passa para `JsonNode` (mutável) ou `JsonDocument`/`JsonElement` (somente leitura, em pool).

   ```csharp
   // .NET 11, C# 14
   // BEFORE: JObject o = JObject.Parse(json); var name = (string)o["user"]!["name"]!;
   JsonNode root = JsonNode.Parse(json)!;
   string name = root["user"]!["name"]!.GetValue<string>();
   ```

   A única armadilha: `JsonDocument` possui um buffer em pool e é `IDisposable`, diferente de `JObject`. Envolva-o em um `using` ou você vazará o buffer alugado. Prefira `JsonNode` quando precisar de uma árvore mutável parecida com `JObject`. Verifique: cada antigo caminho de acesso a `JObject` tem um teste unitário que exercita as mesmas buscas de chave.

6. **Troque a integração do ASP.NET Core.**

   Se a base de código chama `AddNewtonsoftJson()` no `Program.cs`, removê-lo comuta todo o pipeline para `System.Text.Json`. Os valores padrão web do ASP.NET Core já habilitam camelCase, a correspondência sem diferenciar maiúsculas e a leitura de números entre aspas, então muitas das suas opções manuais se tornam redundantes no caminho MVC.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: builder.Services.AddControllers().AddNewtonsoftJson();
   builder.Services.AddControllers().AddJsonOptions(o =>
   {
       o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
       // camelCase + case-insensitive are already on by ASP.NET Core web defaults
   });
   ```

   Atenção ao limite de profundidade: o ASP.NET Core limita o `MaxDepth` do `System.Text.Json` a 32, não ao padrão da biblioteca de 64. Payloads profundamente aninhados que funcionavam com `AddNewtonsoftJson()` podem começar a lançar exceções. Verifique: execute os testes de integração do controller e confirme que nenhum payload ultrapassa o limite de profundidade.

## Verificação

Execute esta lista de testes de fumaça após cada PR, não apenas no final:

- A solução compila com zero referências a `Newtonsoft.Json` nos projetos migrados (`grep -r "Newtonsoft" --include="*.csproj"` não retorna nada para esses projetos).
- A diferença de amostras de referência do passo 1 do preflight está vazia ou cada diferença está documentada e é intencional.
- Toda a suíte de testes passa: `dotnet test` reporta zero falhas.
- Um teste de ida e volta (`Deserialize(Serialize(x))`) é válido para cada modelo com um conversor personalizado ou hierarquia polimórfica.
- Para caminhos quentes, execute uma comparação rápida com `BenchmarkDotNet` e confirme que os números de throughput e alocações se moveram na direção certa em vez de regredir por causa de um acidental `new JsonSerializerOptions()` por chamada (sempre faça cache e reutilize a instância de options; construí-la a cada chamada é a regressão de desempenho mais comum nesta migração).

## Plano de rollback

Esta migração é reversível por projeto mas não trivialmente, porque o passo 1 muda seu formato de saída. A estratégia limpa é uma abordagem strangler: migre um assembly ou um endpoint por vez, mantenha o `Newtonsoft.Json` referenciado até o último consumidor ter sido movido, e proteja os endpoints arriscados atrás de um feature flag que possa rotear de volta para o formatador do `Newtonsoft.Json`. Uma vez que você tenha apagado o `PackageReference` e enviado o novo formato de saída para os consumidores externos, fazer rollback significa readicionar o pacote e reverter a mudança de formato em todos os lugares de uma vez, o que é uma versão coordenada, não um `git revert`. Não apague a referência ao pacote até que as diferenças de amostras de referência tenham ficado verdes na telemetria de produção por pelo menos um ciclo de versão.

## Problemas que encontramos

- **Perda silenciosa de dados por diferenciação de maiúsculas.** Um objeto de configuração desserializado de um arquivo com chaves `PascalCase` voltou com cada propriedade no seu valor padrão porque o `System.Text.Json` correspondeu diferenciando maiúsculas contra os membros em camelCase. Nada lançou exceção. A solução foi `PropertyNameCaseInsensitive = true`, e a lição foi verificar valores, não apenas se "analisou".
- **Os ida e volta de `DateTime` se desviaram.** O `DateTimeZoneHandling` do `Newtonsoft.Json` vinha normalizando timestamps silenciosamente. `System.Text.Json` lê o formato de ida e volta ISO 8601 e preserva o offset, então os timestamps armazenados voltaram com um kind diferente. O conversor personalizado do passo 3 mais a correção de [o valor JSON não pôde ser convertido para System.DateTime](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) resolveu isso.
- **Ciclos de objetos lançavam exceções em vez de serem descartados.** `ReferenceLoopHandling.Ignore` vinha mascarando uma referência circular genuína em uma propriedade de navegação do EF Core. `System.Text.Json` a trouxe à tona como [um possível ciclo de objetos foi detectado](/pt-br/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). `ReferenceHandler.IgnoreCycles` é a ponte, mas a melhor solução foi um DTO de projeção que não tinha o loop em absoluto.
- **Um `new JsonSerializerOptions()` por requisição afundou o throughput.** Construir o objeto de options dentro de um handler quente derrota o cache de metadados interno e foi mais lento que o código do `Newtonsoft.Json` que substituiu. Faça cache de um `static readonly JsonSerializerOptions` e reutilize-o.

## Fontes

- [Microsoft Learn: Migrar de Newtonsoft.Json para System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft)
- [Microsoft Learn: Como personalizar nomes e valores de propriedades](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Microsoft Learn: Serialização polimórfica com System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Microsoft Learn: Preservar referências e tratar referências circulares](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references)
- [Newtonsoft.Json 13.0.4 no NuGet](https://www.nuget.org/packages/newtonsoft.json/)
