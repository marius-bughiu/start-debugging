---
title: "Migrar para longe do BinaryFormatter depois da remoção no .NET moderno"
description: "A implementação do BinaryFormatter foi removida no .NET 9 e continua lançando PlatformNotSupportedException no .NET 10 e no .NET 11: como escolher um serializador substituto, ler blobs NRBF já persistidos com o NrbfDecoder e o que quebra em WinForms, WPF e ResX."
pubDate: 2026-09-02
updatedDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "binaryformatter"
  - "serialization"
  - "system-text-json"
  - "dotnet-10"
  - "dotnet-11"
  - "security"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet"
translatedBy: "claude"
translationDate: 2026-09-02
---

Um serviço que serializa os próprios tipos no próprio armazenamento leva de um a três dias para sair do `BinaryFormatter`. Uma base de código onde os payloads NRBF cruzaram uma fronteira que você não controla (uma fila, uma coluna de banco compartilhada, um cliente desktop que é publicado no próprio calendário) leva semanas, porque a parte difícil não é trocar o serializador, é drenar os payloads antigos. A implementação embutida foi removida no .NET 9 Preview 6 e continua removida: no .NET 9, no .NET 10 e no .NET 11 preview, `BinaryFormatter.Serialize` e `BinaryFormatter.Deserialize` lançam [`PlatformNotSupportedException`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal) para qualquer tipo de projeto, e a antiga propriedade MSBuild `EnableUnsafeBinaryFormatterSerialization` sozinha não traz mais nada de volta. Este guia foi escrito contra o .NET 10.0.11 (GA) com notas para o SDK do .NET 11 (preview 7, agosto de 2026), `System.Formats.Nrbf` 10.0.11 e `System.Runtime.Serialization.Formatters` 10.0.11.

## Por que isso não é opcional

- **Não sobrou nenhuma flag.** No .NET 8 a chave de desativação passou a ficar ligada por padrão e `<EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>` ainda funcionava. A partir do .NET 9 a propriedade sozinha é inerte; o código que implementava a funcionalidade nem está no framework compartilhado.
- **O pacote de compatibilidade é explicitamente sem suporte.** O `System.Runtime.Serialization.Formatters` publica uma implementação funcional, vulnerabilidades incluídas. É um paliativo para cumprir um prazo, não um destino.
- **O risco é o formato, não os bugs.** O NRBF codifica dentro do payload quais tipos instanciar, o que é o [CWE-502, "Deserialization of Untrusted Data"](https://cwe.mitre.org/data/definitions/502.html). Nenhuma quantidade de correções conserta um formato cuja função é deixar o payload escolher o construtor.
- **Dá para ler os blobs antigos sem desserializá-los.** O `NrbfDecoder`, publicado no .NET 9 junto com a remoção, decodifica NRBF em registros sem carregar um único tipo personalizado. É isso que torna possível uma migração em fases em vez de um corte de uma vez.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| `BinaryFormatter.Serialize` / `Deserialize` | Lança `PlatformNotSupportedException` em toda chamada, em todos os tipos de projeto | alta |
| `EnableUnsafeBinaryFormatterSerialization` | Não basta mais sozinha; precisa também do pacote de compatibilidade | alta |
| Blobs NRBF persistidos | Nada no framework vai mais desserializá-los | alta |
| `SoapFormatter`, `NetDataContractSerializer` | Removidos ou classificados como [serializadores perigosos](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-security-guide); não são destino de migração | alta |
| Área de transferência e arrastar e soltar no WinForms/WPF | Só uma lista de tipos intrínsecos faz a ida e volta. `DataFormats.Serializable` e formatos personalizados falham com qualquer outra coisa | alta |
| Designer do WinForms / ResX | A serialização em tempo de design de um tipo personalizado precisa de um `TypeConverter` | média |
| `Exception(SerializationInfo, StreamingContext)` | Obsoleto como `SYSLIB0051`; a serialização legada de exceções é peso morto | média |
| `MSB3825` do MSBuild | Aviso sobre recursos em formato binário; suprima com `GenerateResourceWarnOnBinaryFormatterUse` | baixa |
| `SettingsPropertyValue.PropertyValue` | É do tipo `object`, então as configurações de usuário do `System.Configuration` com tipos personalizados não podem migrar sem quebrar a API | alta |

## Checklist de pré-voo

- SDK do .NET 10.0.100 ou posterior instalado (`dotnet --list-sdks`).
- Um inventário: `grep -rn "BinaryFormatter\|IFormatter\|SoapFormatter\|NetDataContractSerializer" --include=*.cs .` mais uma varredura das dependências NuGet, porque os chamadores transitivos são os que surpreendem.
- Testes de ida e volta em torno de cada fronteira de serialização **antes** de encostar em qualquer coisa. Bugs de serialização são silenciosos; aparecem como um campo nulo três versões depois.
- Uma amostra de payloads persistidos reais tirados do armazenamento de produção. Payloads sintéticos não exercitam a deriva de versões.
- Uma decisão, escrita, sobre se você controla tanto o produtor quanto o consumidor de cada payload. Se não controla, você precisa do caminho de leitura dupla do passo 4, não de uma troca direta.

## Passos da migração

1. **Inventarie cada fronteira de payload, não cada ponto de chamada.** Agrupe os usos de `BinaryFormatter` por onde os bytes vão parar: só em memória (um utilitário de clonagem profunda), cache local ao processo, armazenamento durável (coluna de banco, blob, arquivo em disco) e entre processos (área de transferência, fila, RPC estilo remoting). Os usos em memória e locais ao processo podem ser trocados num único commit. Os duráveis e entre processos precisam de uma janela de transição de formato. Registre o conjunto fechado de tipos que chega a cada fronteira.

   Verificação: cada ocorrência do `grep` acima está atribuída a exatamente um dos quatro grupos, e cada fronteira durável tem um responsável nomeado e uma lista nomeada dos tipos serializados.

2. **Escolha o serializador substituto por fronteira.** Não existe substituto direto, e você não precisa escolher o mesmo em todo lugar. A [comparação oficial](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer) se resume assim: `System.Text.Json` quando o payload pode ser texto e você consegue anotar os tipos (a única opção da lista com suporte AOT de primeira classe e geração de código-fonte); `DataContractSerializer` quando você não consegue mudar os tipos de jeito nenhum, porque é o único serializador recomendado que honra `[Serializable]` e `ISerializable`; [MessagePack for C#](https://github.com/MessagePack-CSharp/MessagePack-CSharp) ou [protobuf-net](https://github.com/protobuf-net/protobuf-net) quando o payload precisa continuar sendo binário compacto.

   Verificação: cada fronteira do passo 1 tem um serializador anotado ao lado, com um motivo de uma linha. Se o motivo for "era o padrão", volte atrás.

3. **Troque primeiro os usos em memória e locais ao processo.** São ganhos de graça e reduzem a superfície dos passos difíceis. Um tipo `[Serializable]` migrando para `System.Text.Json` precisa de opt-in explícito para tudo que antes era implícito: campos não são serializados a menos que você peça, membros privados precisam de um contrato personalizado, e `[Serializable]` em si não significa nada.

   ```csharp
   // .NET 10.0.11, C# 14
   using System.Text.Json;
   using System.Text.Json.Serialization;

   [JsonSourceGenerationOptions(IncludeFields = true)]
   [JsonSerializable(typeof(CartSnapshot))]
   internal partial class CartContext : JsonSerializerContext;

   public sealed class CartSnapshot
   {
       public int Version;                 // a field, so IncludeFields is required
       public string? CouponCode { get; set; }
       public List<int> LineItemIds { get; set; } = [];
   }

   byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, CartContext.Default.CartSnapshot);
   CartSnapshot? back = JsonSerializer.Deserialize(bytes, CartContext.Default.CartSnapshot);
   ```

   Verificação: `dotnet test` está verde, e uma asserção de ida e volta compara cada membro público **e** privado, não só os que você lembrou.

4. **Adicione um caminho de leitura dupla em cada fronteira durável.** Este é o passo que permite publicar. O `NrbfDecoder.StartsWithPayloadHeader` diz se os bytes que você acabou de ler são NRBF legado, e nesse caso você decodifica, serializa de novo com o serializador novo e reescreve. As leituras migram o corpus de forma preguiçosa; as escritas usam só o formato novo desde o primeiro dia.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   internal static CartSnapshot Load(string path)
   {
       byte[] raw = File.ReadAllBytes(path);

       if (!NrbfDecoder.StartsWithPayloadHeader(raw))
       {
           return JsonSerializer.Deserialize(raw, CartContext.Default.CartSnapshot)!;
       }

       CartSnapshot upgraded = ReadLegacy(raw);
       File.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(upgraded, CartContext.Default.CartSnapshot));
       return upgraded;
   }
   ```

   Verificação: um teste que escreve uma amostra NRBF real de produção num arquivo temporário, chama `Load`, confere os valores e depois confere que um segundo `Load` não pega mais o ramo legado.

5. **Implemente o `ReadLegacy` com o `NrbfDecoder`, um tipo por vez.** O `NrbfDecoder` decodifica; ele nunca instancia seus tipos, nunca carrega um assembly e nunca recorre. A construção é você que faz, e é exatamente por isso que ele é seguro sobre entrada não confiável. O `ClassRecord` expõe os membros por nome com acessores tipados, e o `TypeNameMatches` compara nomes de tipo ignorando a identidade do assembly, então encaminhamento de tipos e mudanças de versão de assembly não quebram nada.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   private static CartSnapshot ReadLegacy(byte[] raw)
   {
       using MemoryStream stream = new(raw);
       ClassRecord root = NrbfDecoder.DecodeClassRecord(stream);

       if (!root.TypeNameMatches(typeof(CartSnapshot)))
       {
           throw new InvalidDataException($"Unexpected payload type '{root.TypeName.AssemblyQualifiedName}'.");
       }

       SZArrayRecord<int> ids = (SZArrayRecord<int>)root.GetArrayRecord(nameof(CartSnapshot.LineItemIds))!;
       if (ids.Length > 10_000)
       {
           throw new InvalidDataException("Line item array exceeds the sane limit.");
       }

       return new CartSnapshot
       {
           Version = root.HasMember(nameof(CartSnapshot.Version)) ? root.GetInt32(nameof(CartSnapshot.Version)) : 1,
           CouponCode = root.GetString(nameof(CartSnapshot.CouponCode)),
           LineItemIds = [.. ids.GetArray()],
       };
   }
   ```

   O `HasMember` é a saída de emergência para versionamento: um campo que foi adicionado ou renomeado entre a escrita do payload e hoje devolve `false`, não uma exceção. A checagem de tamanho antes do `GetArray` não é opcional, porque o NRBF torna barato para um payload hostil prometer dois bilhões de nulos.

   Verificação: um teste de decodificação por tipo legado contra um payload real armazenado, mais um teste afirmando que um payload grande demais ou com o tipo errado lança `InvalidDataException` em vez de alocar memória.

6. **Se você realmente não pode mudar os tipos, use o `DataContractSerializer` no lugar dos passos 3 a 5.** É a única opção recomendada que honra o modelo de programação de `[Serializable]` e `ISerializable`, então os tipos ficam intactos. O detalhe é que os tipos conhecidos precisam ser informados antecipadamente, inclusive os privados, e alguns tipos comuns (`DateTimeOffset` em particular) não estão na lista permitida padrão. O `PreserveObjectReferences` restaura o comportamento de identidade de objetos e ciclos que o `BinaryFormatter` dava de graça.

   ```csharp
   // .NET 10.0.11
   using System.Runtime.Serialization;

   DataContractSerializer serializer = new(
       typeof(CartSnapshot),
       new DataContractSerializerSettings
       {
           KnownTypes = [typeof(PercentageCoupon), typeof(FixedAmountCoupon), typeof(DateTimeOffset)],
           PreserveObjectReferences = true,
       });
   ```

   Não recorra ao `NetDataContractSerializer` só porque o nome parece mais próximo. Ele embute informação de tipo no payload do mesmo jeito que o `BinaryFormatter` e está listado como serializador perigoso.

   Verificação: um teste de ida e volta sobre o fechamento completo de tipos conhecidos, incluindo um grafo com um ciclo deliberado, passando com `PreserveObjectReferences = true`.

7. **Trate WinForms e WPF separadamente.** Desde o .NET 9 os dois frameworks usam internamente um subconjunto do NRBF para área de transferência, arrastar e soltar e recursos de tempo de design, mas só para uma lista intrínseca: os primitivos, `string`, `decimal`, `TimeSpan`, `DateTime`, `nint`, `nuint`, `PointF`, `RectangleF`, mais `Bitmap` e `ImageListStreamer` no WinForms, e arrays e listas desses. Qualquer outra coisa cai de volta no `BinaryFormatter` e falha. A correção prescrita para área de transferência e arrastar e soltar é você mesmo colocar um `string` ou `byte[]` na área de transferência, normalmente JSON, e fazer o parse do lado que recebe. Para a serialização Designer/ResX de um tipo personalizado, registre um `TypeConverter` para que o Designer o use em vez de cair no `BinaryFormatter`.

   Verificação: um copiar e colar manual e um arrastar e soltar entre duas instâncias do app em execução para cada formato personalizado, mais uma ida e volta no Designer (abrir um formulário, salvar, reabrir) sem `MSB3825` e sem exceção em tempo de execução.

8. **Só então decida sobre o pacote de compatibilidade.** Se uma dependência de terceiros chama `BinaryFormatter` internamente e você não pode esperar pela correção dela, instale o `System.Runtime.Serialization.Formatters` apenas no projeto de **aplicação**. O pacote não muda a identidade de tipo do `BinaryFormatter`, então as bibliotecas do grafo pegam a implementação funcional sem serem recompiladas.

   ```xml
   <!-- .NET 10.0.11. Unsupported, and a temporary measure. -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>
   </PropertyGroup>

   <ItemGroup>
     <PackageReference Include="System.Runtime.Serialization.Formatters" Version="10.0.11" />
   </ItemGroup>
   ```

   Para ResX especificamente há um segundo portão: coloque também a chave de AppContext `System.Resources.Extensions.UseBinaryFormatter` em `true`.

   Verificação: a referência ao pacote existe em exatamente um arquivo de projeto, e existe uma issue de acompanhamento datada nomeando a dependência que obrigou a isso.

## Verifique a migração

- `grep -rn "BinaryFormatter" --include=*.cs src/` não devolve nada fora do caminho de decodificação legado e dos testes dele.
- `dotnet build -warnaserror` está limpo, sem `SYSLIB0011` e sem `MSB3825`.
- `dotnet test -c Release` está verde e inclui pelo menos um teste de decodificação por tipo legado contra uma amostra real de payload de produção.
- Uma execução em staging lê o corpus de produção: registre a contagem de payloads que pegaram o ramo legado e confirme que ela tende a zero ao longo da janela de transição.
- Os logs não mostram nenhuma `PlatformNotSupportedException` de primeira chance.
- Se o app for WinForms ou WPF, área de transferência e arrastar e soltar foram exercitados entre dois processos, não só dentro de um.

## Rollback

A mudança de código é reversível; a mudança de dados não é. Quando o passo 4 reescreve um blob no formato novo, os bytes antigos se foram, então um rollback para um build que só entende NRBF não consegue lê-los. Duas consequências que valem planejamento: guarde os bytes do formato anterior por toda a sua janela de rollback (escreva o payload atualizado numa coluna ou chave nova em vez de sobrescrever no lugar, e descarte o antigo só depois que a janela fechar), e mantenha o caminho de leitura legado com `NrbfDecoder` no código por pelo menos uma versão depois que o contador de migração chegar a zero. Se você publicar com o pacote de compatibilidade como ponte, o rollback é trivial mas a exposição de segurança é real durante todo o tempo em que ele estiver publicado, então date a issue de acompanhamento.

## Armadilhas que vale conhecer antes de começar

**`[Serializable]` não significa nada para o `System.Text.Json`.** Tipos que faziam ida e volta pelo `BinaryFormatter` com campos privados e sem construtor público vão produzir `{}` silenciosamente em JSON. A falha não é uma exceção, é saída vazia, e é por isso que o teste de ida e volta do passo 3 precisa comparar o estado privado.

**A identidade de objetos desaparece.** O `BinaryFormatter` preservava referências e lidava com ciclos. O `System.Text.Json` precisa de `ReferenceHandler.Preserve`, o `DataContractSerializer` precisa de `PreserveObjectReferences = true`, e se você pular os dois, um objeto filho compartilhado vira silenciosamente dois objetos depois da ida e volta. Onde o código antigo dependia de igualdade por referência depois da desserialização, essa premissa agora está errada.

**O `NrbfDecoder` é um decodificador, não um emulador do `BinaryFormatter`.** O comportamento dele deliberadamente não corresponde ao do `BinaryFormatter`, então você não pode usar uma decodificação bem-sucedida como prova de que uma chamada ao `BinaryFormatter` teria sido segura. Ele também não suporta arrays com índice inicial diferente de zero, que o .NET Framework conseguia escrever em payloads NRBF mas o .NET nunca leu.

**Algumas bibliotecas não podem ser migradas de jeito nenhum.** O `SettingsPropertyValue.PropertyValue` é do tipo `object`, então um arquivo de configurações do `System.Configuration` podia guardar literalmente qualquer coisa. Não existe conjunto fechado de tipos contra o qual decodificar, o que significa que não existe caminho com `NrbfDecoder` sem quebrar a API. Tipos assim são a razão de o inventário do passo 1 vir primeiro.

**A serialização de exceções é uma obsolescência à parte.** O `SYSLIB0051` cobre o construtor `Exception(SerializationInfo, StreamingContext)` e o resto do suporte de serialização legado. Suas exceções personalizadas provavelmente ainda carregam esse construtor; remover é seguro quando nada mais faz ida e volta de exceções por um formatter, e é um bom `grep` para rodar na mesma passada.

**A conversão entre versões precisa rodar em algum lugar que ainda tenha uma implementação.** Se você também está deixando o .NET Framework para trás, escreva a ferramenta de conversão de blobs de passagem única enquanto ainda tiver um runtime com `BinaryFormatter` funcional, ou use o `System.Formats.Nrbf`, que tem multi-targeting para .NET Standard 2.0 e .NET Framework justamente para que o lado da decodificação possa rodar em qualquer lugar.

## Relacionados

- O passo do BinaryFormatter fica dentro do salto maior do [checklist de atualização do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), e costuma ser o item mais caro de [mover uma base de código do .NET Framework 4.8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/).
- Se JSON for o seu substituto, as hierarquias de tipos `[Serializable]` que o BinaryFormatter tratava implicitamente precisam de [anotações explícitas de `JsonDerivedType`](/pt-br/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), e formatos estranhos normalmente acabam num [`JsonConverter` personalizado](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- Times que fizerem isso junto com uma limpeza de Newtonsoft devem ler primeiro [a migração de Newtonsoft para System.Text.Json numa base grande](/pt-br/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/), porque as duas passadas mexem nos mesmos arquivos.
- Builds com trimming e AOT batem numa parede vizinha: veja [reflection-based serialization has been disabled for this application](/pt-br/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) e a triagem mais ampla de [PlatformNotSupportedException no Native AOT](/pt-br/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Fontes

- [BinaryFormatter migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/), Microsoft Learn
- [Breaking change: In-box BinaryFormatter implementation removed and always throws](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal), Microsoft Learn
- [Read BinaryFormatter (NRBF) payloads](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads), Microsoft Learn
- [Choose a serializer](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer), Microsoft Learn
- [WinForms and WPF OLE guidance](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/winforms-wpf-ole-guidance), Microsoft Learn
- [BinaryFormatter removal from .NET 9 is complete](https://github.com/dotnet/announcements/issues/317), dotnet/announcements
- [BinaryFormatter obsoletion plan](https://github.com/dotnet/designs/blob/main/accepted/2020/better-obsoletion/binaryformatter-obsoletion.md), dotnet/designs
- [MS-NRBF: .NET Remoting Binary Format specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/)
