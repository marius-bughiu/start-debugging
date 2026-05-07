---
title: "Correção: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"
description: "EF Core 11 lança essa exceção quando dois objetos compartilham a chave primária dentro de um DbContext. Desanexe o antigo ou atualize-o no lugar. AsNoTracking na leitura evita a colisão."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "change-tracker"
lang: "pt-br"
translationOf: "2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value"
translatedBy: "claude"
translationDate: 2026-05-07
---

A correção: um `DbContext` já tem uma entidade com essa chave primária no rastreador de alterações, e você passou uma segunda instância com a mesma chave. Atualize a instância rastreada no lugar com `SetValues`, desanexe-a antes de anexar a sua, ou leia com `AsNoTracking` para que nada fique rastreado desde o início. Contextos de longa duração e padrões "carregar e depois `Update(newDto)`" são os culpados habituais.

```text
System.InvalidOperationException: The instance of entity type 'Customer' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked. When attaching existing entities, ensure that only one entity instance with a given key value is attached. Consider using 'DbContextOptions.EnableSensitiveDataLogging' to see the conflicting key values.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.ThrowIdentityConflict(InternalEntityEntry entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.Add(...)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.StateManager.StartTracking(...)
   at Microsoft.EntityFrameworkCore.DbContext.SetEntityState(...)
   at Microsoft.EntityFrameworkCore.DbContext.Update[TEntity](TEntity entity)
```

Este guia foi escrito contra .NET 11 preview 4 e `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. O comportamento é idêntico desde EF Core 2.0; somente os detalhes internos do stack trace mudam entre versões. A exceção vem do invariante de `IdentityMap<T>`: um `DbContext` mantém no máximo uma instância rastreada por par `(EntityType, PrimaryKey)`, e qualquer segunda instância é rejeitada na hora.

## Por que o mapa de identidade existe

O rastreador de alterações do EF Core é construído ao redor de uma única regra: para cada tipo de entidade, cada valor de chave primária mapeia para no máximo um objeto CLR. Essa regra é o que permite ao `SaveChanges` decidir se uma linha está `Added`, `Modified` ou `Unchanged` sem ambiguidade, e o que faz a correção de navegação funcionar quando você carrega dados relacionados em pedaços. Dois objetos com a mesma chave significariam duas respostas concorrentes para "qual é o estado atual do cliente 42?", então o rastreador de alterações se recusa a aceitar o segundo. A exceção que você está olhando é essa recusa, e ela é lançada antes que sua chamada a `SaveChanges` seja executada, no momento em que o `DbContext` percebe o conflito durante `Attach`, `Update`, `Add` ou qualquer operação que percorra um grafo.

## Uma reprodução mínima

O modo de falha quase sempre tem essa forma: um handler HTTP lê uma entidade para validar uma solicitação, depois recria a mesma entidade a partir de um DTO e pede ao EF Core que a atualize.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public record CustomerDto(int Id, string Name, string Email);

public class CustomersController(AppDb db) : ControllerBase
{
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, CustomerDto dto)
    {
        var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
        if (existing is null) return NotFound();

        var updated = new Customer
        {
            Id = dto.Id,
            Name = dto.Name,
            Email = dto.Email
        };

        db.Update(updated); // throws: id is already tracked from the read above
        await db.SaveChangesAsync();
        return NoContent();
    }
}
```

A primeira chamada `FirstOrDefaultAsync` anexa `existing` (id 42) no estado `Unchanged`. Em seguida, `db.Update(updated)` tenta anexar um objeto CLR diferente com id 42. O rastreador de alterações o rejeita. O texto da exceção menciona "another instance with the same key value", o que é preciso mas fácil de ler errado numa tarde cansada: as "duas instâncias" são aquela que o EF Core já conhece e a que você está passando agora.

## Três correções, ranqueadas

Execute-as nessa ordem. As duas primeiras evitam o problema por completo; a terceira é para casos em que você genuinamente não consegue.

### 1. Atualize a entidade rastreada no lugar com SetValues

Se você já carregou a linha, o rastreador de alterações é seu aliado. Mute a instância rastreada e deixe o EF Core calcular o diff:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
    if (existing is null) return NotFound();

    db.Entry(existing).CurrentValues.SetValues(dto);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`CurrentValues.SetValues` copia os nomes de propriedade coincidentes do objeto fonte para a entidade rastreada e marca como `Modified` apenas as colunas que realmente mudaram. O `UPDATE` gerado toca somente colunas sujas. Esse é o padrão mais limpo para "editar uma linha existente a partir de um DTO" porque permanece dentro do mapa de identidade e produz SQL mínimo.

### 2. Leia com AsNoTracking, depois Update

Se você só carregou a linha para verificar existência, faça isso sem rastreamento:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var exists = await db.Customers
        .AsNoTracking()
        .AnyAsync(c => c.Id == id);
    if (!exists) return NotFound();

    var updated = new Customer { Id = dto.Id, Name = dto.Name, Email = dto.Email };
    db.Update(updated);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`AnyAsync` não materializa uma entidade, então nada fica rastreado. `db.Update(updated)` anexa a nova instância no estado `Modified` e o EF Core escreve cada propriedade como um único round-trip de `UPDATE`. A contrapartida em relação à correção 1 é que cada coluna é escrita pelo fio, suja ou não, porque o EF Core não tem valores originais para comparar. Para tabelas largas isso é desperdício; para tabelas estreitas é o código mais simples.

Para padrões mais amplos sobre o que rastreia e o que não rastreia, veja o resumo em [a API de entradas do rastreador de alterações](/2026/04/efcore-11-changetracker-getentriesforstate/).

### 3. Desanexe a entidade existente e depois anexe a sua

Quando você não consegue evitar a situação de instância dupla (um contexto de longa duração, uma biblioteca terceira que carrega sem você saber), desanexe primeiro a entrada conflitante:

```csharp
// .NET 11, EF Core 11.0.0
public async Task ReplaceCustomer(int id, Customer incoming)
{
    var local = db.ChangeTracker.Entries<Customer>()
        .FirstOrDefault(e => e.Entity.Id == id);

    if (local is not null)
        local.State = EntityState.Detached;

    db.Update(incoming);
    await db.SaveChangesAsync();
}
```

`ChangeTracker.Entries<T>()` é em memória e não toca o banco de dados. Definir `State = Detached` remove a entrada do mapa de identidade, o que libera a chave para a nova instância. Essa é a saída de emergência, não o padrão, porque te obriga a raciocinar sobre qual instância "vence" se qualquer outro código mantém uma referência à desanexada.

O EF Core 11 também expõe `db.Entry(local.Entity).State = EntityState.Detached` diretamente quando você já tem o objeto culpado em mãos. As duas formas fazem a mesma coisa: tiram a entrada do mapa de identidade.

## Formas comuns que disparam isso

### Um DbContext registrado como Singleton ou capturado em um Singleton

A grande maioria dos relatos de "mas meu código só atualiza uma vez" acaba sendo um desencontro de tempo de vida do `DbContext`. Um `DbContext` foi pensado para ser `Scoped`, ou seja, um por requisição. Se está registrado como `Singleton` (ou injetado em um), cada requisição empilha entidades no mesmo mapa de identidade e a segunda atualização da mesma chave lança.

```csharp
// Bad: long-lived AppDb captures the change tracker for the lifetime of the host
builder.Services.AddSingleton<AppDb>();

// Good: scoped per request, change tracker resets between requests
builder.Services.AddDbContext<AppDb>(o => o.UseSqlServer(cs));
```

Se você genuinamente precisa de um contexto dentro de um `Singleton` (por exemplo, um `BackgroundService` ou um job do Hangfire), injete `IDbContextFactory<AppDb>` e crie um contexto novo por unidade de trabalho:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class CustomerSyncService(IDbContextFactory<AppDb> factory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            // ... work with db ...
        }
    }
}
```

### Grafos carregados com eager loading que cruzam com uma entidade anexada manualmente

Se você carrega um cliente com seus pedidos em eager loading e depois tenta `Attach(customer)` de outro lugar (outro resultado de consulta, um corpo de requisição serializado, um hit de cache), o grafo de pedidos colide com qualquer coisa já rastreada. Ou você baixa a consulta do lado de leitura para `AsNoTracking()` para que o grafo não esteja no mapa, ou usa `db.Entry(customer).State = EntityState.Modified` apenas na raiz e percorre os filhos explicitamente.

### DbContext mockado em testes

Se você está usando um `DbContext` mockado para escrever testes, o mock muitas vezes não implementa o mapa de identidade corretamente, então produção bate nesse erro e os testes passam. O contrário também acontece: um provedor in-memory real rastreia entidades que o mock não rastreava, e o teste falha por motivos que nada têm a ver com o sistema sob teste. A correção é testar contra um provedor real; o guia [armadilhas ao mockar DbContext](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) cobre o que o mock dá e o que não dá.

### EnableSensitiveDataLogging é seu depurador

A mensagem de exceção diz "Consider using `DbContextOptions.EnableSensitiveDataLogging` to see the conflicting key values" por uma razão. Sem ela, o EF Core esconde a chave primária real no erro para evitar vazar PII nos logs. Habilite localmente para ver qual linha é a duplicada:

```csharp
// .NET 11, EF Core 11.0.0 -- development only
builder.Services.AddDbContext<AppDb>(o => o
    .UseSqlServer(cs)
    .EnableSensitiveDataLogging()
    .EnableDetailedErrors());
```

Nunca envie isso para produção; a mesma flag vai imprimir valores de parâmetros nos seus logs a cada comando.

## Variantes que parecem esse erro mas não são

### "Cannot insert explicit value for identity column"

Exceção diferente, causa diferente: o SQL Server rejeita uma chave primária diferente de zero numa coluna `IDENTITY`. A correção é `SET IDENTITY_INSERT ON` ou, mais comumente, não atribuir a chave no insert. O rastreador de alterações não está envolvido.

### "An attempt was made to use the model while it was being created"

Esse é um bug de ordem na inicialização, normalmente causado por um campo estático de `DbContext` ou por ler do modelo dentro de `OnModelCreating`. O mapa de identidade também não está envolvido.

### "A second operation was started on this context instance before a previous operation completed"

Isso é concorrência, não conflito de chave. Um `DbContext` com escopo não é thread-safe; dois `await` paralelos na mesma instância produzem essa exceção. Erro diferente, correção diferente (`IDbContextFactory` de novo, ou serialize o trabalho).

## Relacionado

Para o contexto mais amplo do EF Core, veja o resumo de [detecção de consultas N+1](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), o guia de [consultas compiladas em hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) e o passeio por [records como entidades do EF Core](/2026/04/how-to-use-records-with-ef-core-11-correctly/), que tem suas próprias armadilhas do mapa de identidade ao redor de expressões `with`. Quando você bate nesse erro em código de inicialização ao invés de um handler de requisição, a [checklist de DefaultConnection](/2026/05/fix-no-connection-string-named-defaultconnection/) cobre o lado da configuração. Para fixtures de teste que entregam um banco real para o seu código, o [passeio do Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) é a configuração mais limpa.

## Fontes

- [Tracking and No-Tracking Queries](https://learn.microsoft.com/en-us/ef/core/querying/tracking), documentação do EF Core.
- [Change Tracker API](https://learn.microsoft.com/en-us/ef/core/change-tracking/), documentação do EF Core.
- [Working with disconnected entity graphs](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), documentação do EF Core.
- [Interface `IDbContextFactory<TContext>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [Método `PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
