---
title: "Migre um app EF Core com Cosmos após a mudança no escape dos ids gerados no EF Core 11"
description: "O EF Core 11 deixa de fazer escape de '/', '\\', '?' e '#' nos valores de id gerados para o Cosmos DB, então documentos gravados pelo EF Core 8-10 deixam de ser encontrados pela chave. Como descobrir se você é afetado, quando ativar o switch EscapeIllegalCosmosIdCharacters e como reescrever os ids com segurança usando um batch transacional."
pubDate: 2026-09-19
updatedDate: 2026-09-19
template: migration
tags:
  - "migration"
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/migrate-an-ef-core-cosmos-app-after-the-generated-id-escaping-change"
translatedBy: "claude"
translationDate: 2026-09-19
---

O EF Core 11 muda a forma como o provider do Azure Cosmos DB monta o `id` de um documento quando esse `id` é composto por mais de um valor. O EF Core 8, 9 e 10 substituíam `/`, `\`, `?` e `#` em cada parte por `^2F`, `^5C`, `^3F` e `^23`. O EF Core 11 (a mudança saiu no 11.0 preview 5, e eu a verifiquei no 11.0.0 RC 1) grava os caracteres crus. Se nenhum dos valores das suas chaves compostas contém esses quatro caracteres, a atualização não muda nada e você pode parar de ler depois da próxima seção. Se algum contém, `FindAsync` e as buscas por chave deixam de encontrar esses documentos após a atualização. Aí você tem duas opções: ativar o switch `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters` antes de o app iniciar, ou reescrever os ids afetados. Para chaves que contêm `/` ou `\`, o switch é a única opção que funciona, porque o Cosmos DB rejeita esses caracteres em um `id`. Conte com cerca de uma hora para a auditoria, e a maioria dos times não vai encontrar nada a fazer.

## Quem é realmente afetado

O escape só se aplicava a ids de várias partes. Eu li o `JsonIdDefinition` na tag do EF Core 11 RC 1: uma chave formada por um único valor é gravada como está, e o escape só acontece quando mais de um valor é unido com `|`. As propriedades de partition key são removidas do id antes dessa verificação. Então um tipo de entidade só entra no escopo se uma destas condições for verdadeira:

- A chave primária dele ainda tem duas ou mais propriedades depois que você remove as propriedades de partition key. Por exemplo, `HasKey(x => new { x.TenantId, x.OrderId, x.Sku })` com `HasPartitionKey(x => x.TenantId)` gera o id `OrderId|Sku`.
- Ele usa `HasDiscriminatorInJsonId()`. Apps que vieram do EF Core 8 muitas vezes ativaram isso no EF Core 9 para manter os antigos ids `Post|1`, então esta é a forma mais comum de ser afetado.

Além disso, um dos valores da chave precisa conter `/`, `\`, `?` ou `#`. Chaves GUID e inteiras não podem. Chaves string de texto livre ou com formato de caminho (SKUs como `shoes/red`, slugs como `2026/09/hello`, nomes de arquivo, URLs) são onde isso morde.

Passei as mesmas entidades pelo EF Core 10.0.12 e pelo EF Core 11.0.0 RC 1 sem banco de dados. Adicionar uma entidade a um `DbContext` executa o gerador de valor do id, então o id gerado pode ser lido direto do change tracker:

| Valores da chave | EF Core 10.0.12 | EF Core 11 RC 1 | EF Core 11 RC 1 + switch |
| ---------- | --------------- | --------------- | ------------------------ |
| `o-1`, `shoes/red` | `o-1\|shoes^2Fred` | `o-1\|shoes/red` | `o-1\|shoes^2Fred` |
| `o-1`, `shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` |
| `o-1`, `C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` | `o-1\|C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` |
| `o-1`, `a\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` |
| chave única `shoes/red` | `shoes/red` | `shoes/red` | `shoes/red` |
| `HasDiscriminatorInJsonId`, `2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` | `LegacyPost\|2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` |

As duas primeiras linhas são o motivo da mudança ([dotnet/efcore#38244](https://github.com/dotnet/efcore/issues/38244)). O caractere de escape `^` nunca recebia escape, então `shoes/red` e `shoes^2Fred` geravam o mesmo id e a segunda inserção sobrescrevia o primeiro documento em silêncio. O time do EF decidiu parar de fazer escape em vez de também fazer escape de `^`, porque fazer escape de `^` quebraria todo id existente que contém um circunflexo. A correção é o [dotnet/efcore#38245](https://github.com/dotnet/efcore/pull/38245), com merge em 2026-05-08. Observe que o separador `|` continua recebendo escape como `^|` nas duas versões, então essa parte dos seus ids não muda.

## O que quebra

| Área | Mudança após atualizar para o EF Core 11 | Gravidade |
| ---- | ------------------------------------ | -------- |
| `FindAsync` e consultas que filtram pela chave completa mais a partition key | O EF transforma essas operações em um point read usando o id recém-gerado, então documentos armazenados com id com escape voltam como `null` ou como resultado vazio | alta |
| Inserir uma entidade cuja chave coincide com um documento antigo | O novo id é diferente, então para `?` e `#` você ganha um segundo documento com os mesmos valores de chave em vez de um conflito | alta |
| Novas chaves contendo `/` ou `\` | O EF 11 agora envia esses caracteres no id, e o serviço do Cosmos DB não permite `/` e `\` em um id ([limites do serviço](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)), então a gravação falha | alta |
| Atualizações e exclusões de entidades carregadas por uma consulta | Continuam funcionando: `SaveChanges` usa o valor de `__id` que foi materializado a partir do documento, e não um recém-gerado | nenhuma |
| Consultas que não filtram pela chave completa | Continuam funcionando, elas não usam o id | nenhuma |

A segunda linha é a perigosa. O padrão comum "procure e, se não existir, adicione" retorna `null` para o documento antigo e cria uma duplicata ao lado dele. Nenhuma exceção é lançada.

## Checklist de pré-voo

- O app compila contra `Microsoft.EntityFrameworkCore.Cosmos` 11.0.0-rc.1.26425.128 (ou a GA quando sair), e você leu o restante das [breaking changes do EF Core 11](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes). O provider do Cosmos tem várias mudanças no 11, incluindo a remoção do I/O síncrono e da preservação de propriedades não mapeadas no round-trip.
- Você tem acesso pelo Data Explorer ou pelo SDK a todo container em que o EF grava.
- O backup contínuo ou uma restauração point-in-time está ativado na conta antes de você reescrever qualquer id.
- Você sabe quais propriedades de chave guardam strings fornecidas por usuários ou de texto livre.

## Passos da migração

1. **Liste os tipos de entidade com ids de várias partes.**
   Isto percorre o modelo do EF com as APIs públicas de metadados do Cosmos e aplica a mesma regra que o provider usa:

   ```csharp
   // EF Core 11.0 RC 1, .NET 11 RC 1
   foreach (var entityType in db.Model.GetEntityTypes().Where(t => !t.IsOwned()))
   {
       var key = entityType.FindPrimaryKey()!;
       var partitionKeyNames = entityType.GetPartitionKeyPropertyNames();
       var idParts = key.Properties.Count(p => !partitionKeyNames.Contains(p.Name));
       var discriminatorInId = entityType.GetDiscriminatorInKey()
           is IdDiscriminatorMode.EntityType or IdDiscriminatorMode.RootEntityType;

       Console.WriteLine($"{entityType.DisplayName(),-12} container={entityType.GetContainer(),-8} " +
           $"id parts={idParts} discriminator in id={discriminatorInId} " +
           $"-> {(idParts > 1 || discriminatorInId ? "AFFECTED" : "not affected")}");
   }
   ```

   Para um modelo com um `OrderLine` particionado (chave `TenantId, OrderId, Sku`) e um `Product` de chave única, ele imprime:

   ```text
   OrderLine    container=Orders   id parts=2 discriminator in id=False -> AFFECTED
   Product      container=Catalog  id parts=1 discriminator in id=False -> not affected
   ```

   Verifique: todo tipo de entidade marcado como `AFFECTED` tem pelo menos uma propriedade de chave `string`. Se todas forem `Guid`, `int` ou `long`, você terminou. O EF Core 11 gera os mesmos ids que o EF Core 10 para essas.

2. **Conte os documentos que realmente carregam uma sequência de escape.**
   Execute isto no Data Explorer em cada container que guarda um tipo afetado:

   ```sql
   -- Azure Cosmos DB for NoSQL
   SELECT c.id, c["$type"] FROM c
   WHERE CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C")
      OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23")
   ```

   `$type` é o nome do discriminador no JSON que o EF grava desde o EF Core 9. O EF Core 11 renomeou a propriedade do modelo para `Discriminator`, mas o nome no JSON continua `$type`. Verifique: zero linhas significa que nenhum documento armazenado vai mudar de id. Aí a única questão em aberto é se chaves *novas* podem conter esses caracteres, e o passo 3 continua valendo para elas.

3. **Decida: manter o escape antigo ou migrar para ids crus.**
   Use esta regra:

   - As chaves podem conter `/` ou `\`: mantenha o escape antigo com o switch (passo 4). Ids crus contendo esses caracteres não podem ser armazenados no Cosmos DB, então não há para onde migrar. A única alternativa é mudar os próprios valores das chaves.
   - As chaves podem conter apenas `?` ou `#`: você pode reescrever os ids (passo 5) e abandonar o escape antigo de vez. Isso também elimina o bug de colisão.
   - Os valores das chaves podem ser fornecidos por usuários: saiba que, com o switch ativado, um usuário que envia a string literal `shoes^2Fred` pode sobrescrever `shoes/red`. Se isso importa, valide a entrada da chave para que ela nunca contenha `^`.

   Verifique: registre a decisão por tipo de entidade. Um container misto pode precisar das duas.

4. **Se você mantiver o escape, ative o switch antes de o EF carregar.**
   O provider lê o switch uma única vez, em um campo `static readonly` de `JsonIdDefinition`. O lugar mais seguro para ele é o arquivo de projeto, porque o MSBuild o grava no `runtimeconfig.json`:

   ```xml
   <!-- EF Core 11.0, .NET 11 -->
   <ItemGroup>
     <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters"
                                     Value="true" />
   </ItemGroup>
   ```

   `AppContext.SetSwitch("Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters", true)` também funciona, desde que seja a primeira linha do `Program.cs`, antes de qualquer `DbContext` ter sido criado. Verifique com o próprio gerador de id (passo 6). Testei tanto a entrada no `runtimeconfig.json` quanto uma chamada a `SetSwitch` na inicialização no RC 1, e as duas geraram `o-1|shoes^2Fred`.

5. **Se você migrar para ids crus, reescreva os documentos no lugar.**
   O Cosmos DB não consegue renomear um `id`, então cada documento é recriado com o novo id e o antigo é excluído. Os dois documentos compartilham a partition key, então um batch transacional torna a troca atômica. Calcule o novo id com o próprio EF Core 11 em vez de reimplementar o formato: adicione uma instância só com a chave a um contexto descartável e leia `__id`. Faça a reescrita com o JSON cru e não pelo EF, porque o EF Core 11 não preserva mais propriedades JSON que não estão mapeadas no modelo, então salvar pelo EF as descartaria.

   ```csharp
   // EF Core 11.0 RC 1, Microsoft.Azure.Cosmos 3.x, .NET 11 RC 1
   // Run with the switch OFF, so EF generates the new ids.
   using var client = new CosmosClient(connectionString);
   var container = client.GetContainer("shop", "Orders");
   var query = new QueryDefinition(
       """
       SELECT * FROM c
       WHERE c["$type"] = "OrderLine"
         AND (CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C") OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23"))
       """);

   await using var idContext = new ShopContext(connectionString); // never saved
   using var iterator = container.GetItemQueryStreamIterator(query);
   while (iterator.HasMoreResults)
   {
       using var page = await iterator.ReadNextAsync();
       page.EnsureSuccessStatusCode();
       var documents = JsonNode.Parse(page.Content)!["Documents"]!.AsArray();

       foreach (var doc in documents.Select(d => d!.AsObject()))
       {
           var oldId = (string)doc["id"]!;
           var line = new OrderLine
           {
               TenantId = (string)doc["TenantId"]!,
               OrderId = (string)doc["OrderId"]!,
               Sku = (string)doc["Sku"]!,
           };
           var entry = idContext.Add(line);
           var newId = (string)entry.Property("__id").CurrentValue!;
           entry.State = EntityState.Detached;

           if (newId == oldId) continue; // the key really contains "^2F"
           if (newId.Contains('/') || newId.Contains('\\'))
           {
               Console.WriteLine($"BLOCKED  {oldId} -> {newId}");
               continue;
           }

           Console.WriteLine($"{(apply ? "REWRITE " : "DRY RUN ")} {oldId} -> {newId}");
           if (!apply) continue;

           var etag = (string)doc["_etag"]!;
           foreach (var system in new[] { "_rid", "_self", "_etag", "_attachments", "_ts" })
               doc.Remove(system);
           doc["id"] = newId;

           using var body = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(doc));
           using var result = await container
               .CreateTransactionalBatch(new PartitionKey(line.TenantId))
               .CreateItemStream(body)
               .DeleteItem(oldId, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag })
               .ExecuteAsync();

           if (!result.IsSuccessStatusCode)
               Console.WriteLine($"  FAILED {result.StatusCode}: {result.ErrorMessage}");
       }
   }
   ```

   A chave é lida das propriedades do próprio documento, e não recuperada do id com escape. É isso que torna a ferramenta segura para o caso de colisão: um documento armazenado como `o-1|shoes^2Fred` cujo `Sku` realmente é `shoes^2Fred` produz o mesmo id no EF 11, então é ignorado. Executei a lógica de id offline no RC 1 contra quatro documentos de exemplo. Ela imprimiu `BLOCKED o-1|shoes^2Fred -> o-1|shoes/red`, `DRY RUN o-1|gift^23card -> o-1|gift#card`, `DRY RUN o-1|what^3F -> o-1|what?` e ignorou o documento com o literal `shoes^2Fred`. Não executei o batch contra uma conta real nem contra o emulador, então rode primeiro o dry run e depois `--apply` contra uma cópia restaurada do banco de dados. O `IfMatchEtag` na exclusão faz o batch falhar em vez de perder uma gravação concorrente. Se falhar, execute a ferramenta de novo. Verifique: a consulta do passo 2 retorna apenas documentos `BLOCKED`, ou nenhum.

6. **Fixe o formato do id com um teste.**
   O gerador de id roda no `Add`, então um teste unitário pode verificar o formato sem o Cosmos DB:

   ```csharp
   // EF Core 11.0 RC 1, xUnit v3
   [Theory]
   [InlineData("shoes/red", "o-1|shoes^2Fred")] // expected with the switch on
   [InlineData("gift#card", "o-1|gift^23card")]
   public void Generated_id_matches_stored_documents(string sku, string expectedId)
   {
       using var db = new ShopContext("AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdA==");
       var entry = db.Add(new OrderLine { TenantId = "t1", OrderId = "o-1", Sku = sku });
       Assert.Equal(expectedId, entry.Property("__id").CurrentValue);
   }
   ```

   Verifique: o teste passa no CI com o mesmo `runtimeconfig.json` com que o app é distribuído. Se alguém remover o `RuntimeHostConfigurationOption`, quem falha é este teste, e não a produção.

## Verificação

Depois de implantar o EF Core 11, confira estas três coisas contra dados reais:

- `await db.OrderLines.FindAsync("t1", "o-1", "shoes/red")` (uma chave que antes recebia escape) retorna a entidade e não `null`.
- A consulta do passo 2 retorna a mesma contagem de antes se você manteve o switch, e zero (tirando as linhas `BLOCKED`) se você migrou.
- Uma consulta por duplicatas não retorna nada: `SELECT c.TenantId, c.OrderId, c.Sku, COUNT(1) AS n FROM c GROUP BY c.TenantId, c.OrderId, c.Sku`, e depois procure qualquer `n` maior que 1. Isso pega as inserções duplicadas silenciosas da tabela "O que quebra".

## Plano de rollback

Manter o switch é totalmente reversível: desfaça a atualização do pacote e o EF Core 10 gera os mesmos ids de sempre. Reescrever os ids não é reversível com um novo deploy. O EF Core 10 volta a gerar ids com escape e não encontra os documentos reescritos. Então reescrever te prende ao EF Core 11. Se você precisar de um caminho de volta, restaure o container a partir do backup feito antes da reescrita, ou implante o EF Core 11 com o switch ativado (os ids antigos continuam válidos com ele) e rode a ferramenta ao contrário. Teste esse caminho antes de depender dele.

## Pegadinhas

- **O nome do switch tem duas grafias por aí.** A issue e um comentário de código em `JsonIdDefinition` dizem `Microsoft.EntityFrameworkCore.EscapeIllegalIdCharacters`. O código na verdade lê `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters`, que também é o que diz a documentação de breaking changes. Configurei o nome mais curto no `runtimeconfig.json` no RC 1 e não teve efeito: os ids continuaram sem escape.
- **Ativar o switch tarde não faz nada.** No meu teste, `AppContext.SetSwitch` chamado depois de o primeiro `DbContext` ter gerado um id foi ignorado, e o contexto seguinte ainda produziu `o-2|shoes/red`. Apps hospedados que configuram switches a partir da configuração depois de `builder.Build()` caem nisso.
- **Ids de chave única nunca receberam escape.** Um `Product` com `Id = "shoes/red"` sempre foi gravado como `shoes/red`, no 10 e no 11, então a restrição do Cosmos DB sobre `/` já valia para ele. A mudança só afeta ids formados por vários valores.
- **Propriedades de partition key não fazem parte do id.** Ao verificar suas chaves, ignore as propriedades que você passa para `HasPartitionKey`. Esses valores podem conter qualquer coisa, porque o provider os envia como partition key e não no id.
- **Batches são por partição e limitados a 100 operações.** A ferramenta emite um batch por documento para manter as falhas localizadas. Se você agrupar vários documentos em um batch, agrupe-os por partition key e fique abaixo do limite.

## Relacionados

- A ferramenta de reescrita se apoia no mesmo mecanismo que o EF Core 11 agora usa em todo `SaveChanges`: [o EF Core 11 ativa por padrão os batches transacionais do Cosmos DB](/pt-br/2026/04/efcore-11-cosmos-transactional-batches/).
- Se você está pulando várias versões principais de uma vez, [migrar do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) lista as outras breaking changes que você vai encontrar no caminho.
- Outro padrão do EF Core 11 que muda em silêncio numa atualização: [nível de compatibilidade 150 vs 160 do SQL Server](/pt-br/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/).
- Para registrar em log todo point read e ver quais ids o EF pede ao Cosmos DB, [um interceptor do EF Core](/pt-br/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) é o gancho mais leve.
- Se tipos owned nos seus documentos do Cosmos também estão na lista da atualização, veja [complex types vs owned entities no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/).

## Fontes

- [Breaking changes do EF Core 11: caracteres ilegais de `id` no Cosmos não recebem mais escape](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes#cosmos-no-id-escape)
- [dotnet/efcore#38244: valores de `id` gerados podem colidir quando os valores da chave contêm sequências de escape](https://github.com/dotnet/efcore/issues/38244)
- [dotnet/efcore#38245: não fazer escape de caracteres ilegais no id](https://github.com/dotnet/efcore/pull/38245)
- [`JsonIdDefinition.cs` em v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinition.cs)
- [`JsonIdDefinitionFactory.cs` em v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinitionFactory.cs)
- [Cotas do serviço Azure Cosmos DB: caracteres permitidos no valor de ID](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)
- [Operações de batch transacional no Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [Breaking changes do EF Core 9: o discriminador não é mais incluído no `id`](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/breaking-changes#cosmos-id-property-changes)
