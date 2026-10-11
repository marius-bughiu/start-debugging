---
title: "Como verificar se uma entidade já está sendo rastreada pelo DbContext antes de anexá-la no EF Core"
description: "Use DbSet.Local.FindEntry(key) para perguntar ao change tracker se uma entidade com determinada chave está rastreada, sem ida ao banco de dados nem varredura. Por que Entry(entity).State engana nessa verificação, por que Find faz consulta e um helper AttachOrMerge testado para o EF Core 10."
pubDate: 2026-10-11
template: how-to
tags:
  - "ef-core"
  - "dotnet-10"
  - "csharp"
  - "change-tracker"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Resposta curta:** chame `db.Set<T>().Local.FindEntry(id)`. Ele retorna o `EntityEntry<T>` rastreado para essa chave primária, ou `null` se nada com essa chave estiver rastreado, e nunca consulta o banco de dados. Se retornar uma entrada, copie seus valores para ela com `entry.CurrentValues.SetValues(incoming)` em vez de anexar. Se retornar `null`, `Attach` ou `Update` é seguro. Para chaves compostas use `Local.FindEntryUntyped([part1, part2])`. Não use `db.Entry(incoming).State == EntityState.Detached` para essa verificação: ele só informa sobre aquela instância de objeto, não sobre a chave.

Tudo abaixo foi executado com o EF Core 10.0.12 (`Microsoft.EntityFrameworkCore.Sqlite` 10.0.12) no .NET 10 SDK 10.0.302. A família `LocalView<T>.FindEntry` foi adicionada no EF Core 8 ([dotnet/efcore#29686](https://github.com/dotnet/efcore/pull/29686)), então o mesmo código funciona no EF Core 8, 9, 10 e nos release candidates do EF Core 11.

## Por que "está rastreada?" é uma pergunta sobre chaves, não sobre objetos

O change tracker mantém um identity map: para cada tipo de entidade, uma instância CLR rastreada por valor de chave primária. Quando você chama `Attach`, `Update` ou `Add` com uma segunda instância cuja chave já está no mapa, o EF Core lança a conhecida exceção [`The instance of entity type cannot be tracked because another instance with the same key value is already being tracked`](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

Então a pergunta que você realmente precisa responder antes de anexar é "o identity map já contém *alguma* instância com essa chave?" Isso é diferente de "*esta* instância está rastreada?", e a verificação mais sugerida responde a segunda.

## Um repro mínimo da armadilha

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite
using var db = new Shop(options);

var tracked  = db.Customers.First(c => c.Id == 1);           // tracked, Unchanged
var incoming = new Customer { Id = 1, Name = "changed" };    // e.g. deserialized from a request

Console.WriteLine(db.Entry(tracked).State);   // Unchanged
Console.WriteLine(db.Entry(incoming).State);  // Detached  <-- looks "safe"

db.Attach(incoming);
// InvalidOperationException: The instance of entity type 'Customer' cannot be tracked
// because another instance with the same key value for {'Id'} is already being tracked.
```

`db.Entry(incoming)` retorna sem problemas uma entrada no estado `Detached`, porque `incoming` de fato não está rastreado. Ele não lança exceção e não começa a rastrear o objeto (o change tracker ainda tinha exatamente uma entrada depois, na minha execução). Código que faz `if (db.Entry(x).State == EntityState.Detached) db.Attach(x);` passa na verificação e depois lança exceção na linha seguinte. Esse padrão serve para "eu já anexei exatamente este objeto?", e está errado para cenários desconectados em que o objeto veio de um DTO, de um cache ou de um corpo JSON.

## As opções, medidas

Liguei um contador a `CoreEventId.DetectChangesStarting` e um `DbCommandInterceptor` que conta os readers executados, e então rodei cada candidato contra um contexto que rastreava um `Customer`:

| Verificação | Responde à pergunta da chave? | Passadas de `DetectChanges` | Consultas ao banco |
| --- | --- | --- | --- |
| `db.Entry(incoming).State` | Não, apenas sobre aquela instância | 0 | 0 |
| `db.ChangeTracker.Entries<Customer>().Any(e => e.Entity.Id == 1)` | Sim, por varredura linear | 1 | 0 |
| `db.Customers.Find(1)` (rastreada) | Sim, retorna a instância rastreada | 0 | 0 |
| `db.Customers.Find(2)` (não rastreada) | Não é uma verificação: carrega a linha | 0 | 1 |
| `db.Customers.Local.FindEntry(1)` | Sim, por busca no identity map | 1 (do getter de `Local`) | 0 |
| `cachedLocal.FindEntry(1)` | Sim | 0 | 0 |

Algumas coisas se destacam.

**`Find` não é uma verificação de rastreamento.** Ele olha primeiro o identity map, e por isso o caso rastreado não custa nada, mas quando a chave não está rastreada ele vai ao banco de dados e passa a rastrear o que encontrar. Usar `Find` para decidir se deve anexar significa que você carrega uma linha que não queria, ou recebe de volta uma instância rastreada e depois anexa a sua própria cópia por cima dela, o que lança exceção.

**`ChangeTracker.Entries<T>()` funciona, mas faz varredura.** Ele executa `DetectChanges` primeiro e depois enumera todas as entradas rastreadas daquele tipo. Com dez entidades isso é ruído. Com um contexto de longa duração em um aplicativo desktop ou em um job em lote com dezenas de milhares de entradas, fazer isso uma vez por item recebido é quadrático. (No EF Core 11, a [API `GetEntriesForState`](/pt-br/2026/04/efcore-11-changetracker-getentriesforstate/) pula a passada de `DetectChanges`, mas continua sendo uma enumeração.)

**`Local.FindEntry` é a API feita para isso.** Ele resolve a chave pelo mesmo identity map que `Attach` verifica, então dá exatamente a resposta sobre a qual `Attach` vai agir. O único `DetectChanges` da tabela vem do getter da propriedade `DbSet<T>.Local`, não de `FindEntry`: quando guardei o `LocalView<Customer>` em uma variável e chamei `FindEntry` nela, o contador ficou em zero. A [documentação da API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry) diz o mesmo e recomenda reutilizar o objeto `Local` em buscas repetidas.

## Verificar e depois anexar ou mesclar

Este é o procedimento para uma atualização desconectada, o cenário em que essa pergunta costuma aparecer:

1. Obtenha a view local uma vez: `var local = db.Customers.Local;`.
2. Procure a chave com `local.FindEntry(incoming.Id)`.
3. Se uma entrada voltar, copie os valores recebidos para a instância rastreada com `entry.CurrentValues.SetValues(incoming)`. O EF Core marca como modificadas apenas as propriedades cujos valores realmente mudaram.
4. Se voltar `null`, nada tem essa chave, então `Update(incoming)` (ou `Attach` mais flags `IsModified` explícitas) é seguro.
5. Chame `SaveChanges` uma vez no final.

Como helper:

```csharp
// .NET 10, EF Core 10.0.12
static Customer AttachOrMerge(Shop db, Customer incoming)
{
    var existing = db.Customers.Local.FindEntry(incoming.Id);
    if (existing is null)
    {
        db.Customers.Update(incoming);   // nothing tracked with this key
        return incoming;
    }

    existing.CurrentValues.SetValues(incoming);  // merge into the tracked instance
    return existing.Entity;
}
```

Executando contra o contexto que já rastreia o cliente 1:

```text
Helper: same=True state=Modified name=merged modifiedProps=Name
```

O objeto retornado é a instância que o contexto já estava rastreando, seu estado passou de `Unchanged` para `Modified`, e apenas `Name` está marcada, então o `UPDATE` gerado toca uma coluna. Retorne a instância rastreada para quem chamou, em vez de `incoming`: depois da mesclagem, `incoming` continua sendo um objeto desconectado do qual o EF Core não sabe nada.

## Uma versão genérica para qualquer tipo de entidade

Raramente você quer um helper por entidade. `FindEntryUntyped` recebe os valores da chave como `IEnumerable<object?>` na ordem da chave, e o modelo informa quais propriedades formam a chave primária:

```csharp
// .NET 10, EF Core 10.0.12
static EntityEntry<T>? FindTrackedEntry<T>(DbContext db, T entity) where T : class
{
    var key = db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!;
    var entry = db.Entry(entity);   // Detached entry, does not start tracking
    var keyValues = key.Properties
        .Select(p => entry.Property(p.Name).CurrentValue)
        .ToArray();

    return db.Set<T>().Local.FindEntryUntyped(keyValues);
}

static bool IsTracked<T>(DbContext db, params object?[] keyValues) where T : class
    => db.Set<T>().Local.FindEntryUntyped(keyValues) is not null;
```

Ler a chave por `db.Entry(entity).Property(...)` em vez de reflexão faz com que chaves de shadow properties e chaves mapeadas para campos funcionem sem casos especiais. No repro, `FindTrackedEntry(db, incoming)` encontrou o cliente rastreado mesmo com `incoming` sendo um objeto diferente, que é exatamente o comportamento que falta à verificação com `Entry(...).State`.

## Armadilhas que vão te pegar

### Chaves compostas precisam de `FindEntryUntyped`, não de `FindEntry`

`FindEntry` é genérico, `FindEntry<TKey>(TKey keyValue)`. Se você passar um array ou uma lista, o compilador vincula `TKey` a `object[]` ou `List<object?>` sem reclamar, e o EF Core trata o conjunto inteiro como um único valor de chave:

```csharp
// .NET 10, EF Core 10.0.12. OrderLine has HasKey(x => new { x.OrderId, x.LineNo })
db.OrderLines.Local.FindEntry(new object[] { 10, 1 });
// ArgumentException: Entity type 'OrderLine' is defined with a 2-part composite key,
// but 1 values were passed to the 'Find' method.

db.OrderLines.Local.FindEntryUntyped([10, 1]);   // works, returns the tracked entry
```

Também tentei uma variável do tipo `IEnumerable<object?>`, esperando cair em uma sobrecarga não genérica. A mesma exceção: não existe uma sobrecarga `FindEntry(IEnumerable<object?>)` para chaves primárias, a versão sem tipo tem seu próprio nome.

### O tipo da chave deve coincidir exatamente

`FindEntry<TKey>` não converte. Com uma chave `int`:

```text
FindEntry(1L): ArgumentException: Property 'Customer.Id' is of type 'int' but the generic type provided is of type 'long'.
```

`FindEntryUntyped` não é mais tolerante, ele verifica o tipo do valor boxed:

```text
FindEntryUntyped([1L]): ArgumentException: The 'FindEntry' or 'GetEntries' method was passed a 'long' value for the 'Id' property, when a 'int' value was expected.
```

Isso aparece quando a chave chega de um valor de rota ou de um repositório genérico tipado como `long` ou `object`. Converta para o tipo CLR da propriedade da chave (`key.Properties[i].ClrType`) antes da chamada.

### Entidades excluídas continuam rastreadas

Depois de `db.Customers.Remove(customer2)`:

```text
FindEntry(2) after Remove: Deleted; Local.Count=1; Find(2)=entity
```

A *coleção* local esconde as entidades `Deleted` (`Local.Count` caiu para 1, [como a documentação descreve](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries#the-local-view)), mas `FindEntry` ainda retorna a entrada, e `Find` também. Isso é correto para o nosso propósito, já que a chave continua no identity map e `Attach` ainda lançaria exceção. Mas se a sua lógica de mesclagem assume que "encontrada" significa "viva", verifique `entry.State` antes de chamar `SetValues`, ou você vai ressuscitar mudanças de propriedades em uma linha que `SaveChanges` está prestes a excluir.

### "Não rastreada" não significa "existe no banco de dados"

Quando `FindEntry` retorna `null`, o helper chama `Update`, que marca todas as propriedades como modificadas e gera um `UPDATE`. Para uma chave que não existe na tabela, `SaveChanges` afeta zero linhas e lança `DbUpdateConcurrencyException`. No repro, `AttachOrMerge(db, new Customer { Id = 3 })` deixou a entidade em `Modified`, não em `Added`. Se o objeto recebido puder ser novo, decida isso a partir dos seus próprios dados (uma chave default, uma coluna de versão, uma flag explícita) antes de escolher entre `Add` e `Update`. Outra opção é dispensar o rastreamento por completo e usar [`ExecuteUpdate`](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) para a escrita.

### Valores default em chaves geradas pelo armazenamento

Anexar um `Customer` cujo `Id` é `0` não lança exceção e não colide: o EF Core vê uma chave gerada pelo armazenamento sem valor definido e rastreia a entidade como `Added` com um valor temporário. Verificar `FindEntry(0)` antes não diz nada útil nesse caso. Faça o desvio com `entry.IsKeySet` (ou `id == default`) antes de fazer a busca.

### Buscas por chave alternativa ou chave estrangeira

`LocalView<T>` também tem `FindEntry<TProperty>(string propertyName, TProperty value)` e `GetEntries(...)` para buscas que não usam a chave primária, por exemplo `Local.FindEntry(nameof(Customer.Email), email)`. Elas são rápidas quando a propriedade é uma chave alternativa ou uma chave estrangeira, porque o EF Core já mantém índices de busca para essas. Para propriedades comuns elas recorrem à varredura das entradas rastreadas. No repro, `Local.FindEntry(nameof(Customer.Name), "a")` retornou a entrada certa, mas `Name` não é uma chave, então foi uma varredura.

### Desligando o AutoDetectChanges

Com `db.ChangeTracker.AutoDetectChangesEnabled = false`, nem o getter de `Local` nem `Entries<T>()` disparam `DetectChanges` (contador em 0 nos dois). As buscas no identity map não são afetadas, já que as chaves não podem mudar em uma entidade rastreada. Se você desligar a detecção automática em um loop de importação em massa, chame `db.ChangeTracker.DetectChanges()` você mesmo antes de `SaveChanges` quando modificar entidades rastreadas diretamente.

## Quando a melhor correção é não rastrear

Se a verificação está no seu código porque uma leitura anterior, no mesmo contexto, rastreou a entidade que você agora quer atualizar, a correção mais limpa costuma estar a montante. Leia com `AsNoTracking()` quando o resultado só é exibido ou mapeado para um DTO (a [comparação entre AsNoTracking e AsNoTrackingWithIdentityResolution](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) mostra qual escolher), e mantenha os contextos de curta duração para que uma unidade de trabalho não herde as entidades rastreadas de outra. `FindEntry` é a ferramenta certa quando um contexto legitimamente vê a mesma chave por dois caminhos: um aplicativo desktop com contexto de longa duração, um job em lote que mescla registros de vários arquivos, ou um grafo que chega com entidades parcialmente sobrepostas às que você já carregou.

A mesma busca é útil em testes. Se você substituiu o provider por um fake e suas asserções dependem do que está rastreado, `Local.FindEntry` lê o identity map real, o que mantém você honesto da maneira descrita em [mockar um DbContext sem quebrar o change tracking](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

### Leia a seguir

- [Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/pt-br/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)
- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/pt-br/2026/04/efcore-11-changetracker-getentriesforstate/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [ExecuteUpdate vs loading entities and SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Fontes

- [`LocalView<TEntity>.FindEntry` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry), Microsoft Learn.
- [`LocalView<TEntity>.FindEntryUntyped` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentryuntyped), Microsoft Learn.
- [Accessing tracked entities](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries), documentação do EF Core (Entry, Find, Entries, a local view e seu custo de `DetectChanges`).
- [Lookup entities by primary key, alternate key, or foreign key](https://github.com/dotnet/efcore/pull/29686), PR #29686 do dotnet/efcore (mesclado em dezembro de 2022, lançado no EF Core 8).
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), documentação do EF Core.
