---
title: "Como usar filtros de consulta nomeados para soft delete e multi-tenancy no EF Core 11"
description: "Aplique dois filtros de consulta globais independentes à mesma entidade no EF Core 11: um filtro de soft delete e um filtro de tenant, cada um nomeado para que você possa desativar um sem o outro com IgnoreQueryFilters."
pubDate: 2026-07-03
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "pt-br"
translationOf: "2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Para executar um filtro de soft delete e um filtro de multi-tenancy na mesma entidade no EF Core 11, dê um nome a cada um: chame `HasQueryFilter("SoftDeletionFilter", e => !e.IsDeleted)` e `HasQueryFilter("TenantFilter", e => e.TenantId == _tenantId)` no `OnModelCreating`. Ambos são aplicados por padrão a cada consulta. Quando uma tela administrativa precisar ver linhas com soft delete, desative apenas esse filtro com `IgnoreQueryFilters(["SoftDeletionFilter"])`, e o filtro de tenant continua ativo para que você nunca vaze os dados de outro tenant. Os filtros de consulta nomeados chegaram no EF Core 10 e são a forma padrão de empilhar filtros no EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). Este post mostra a configuração completa: conectar o id do tenant ao contexto, marcar as exclusões automaticamente, desativar filtros de forma seletiva e o problema do join que descarta linhas silenciosamente.

## Por que um único filtro por entidade nunca foi suficiente

Um filtro de consulta global é uma cláusula `Where` extra que o EF Core injeta em cada consulta de um tipo de entidade. Dois casos de uso dominam. O soft delete mantém as linhas na tabela com um sinalizador `IsDeleted` em vez de emitir `DELETE`, então você obtém uma trilha de auditoria e um caminho de desfazer. A multi-tenancy armazena as linhas de muitos clientes em uma tabela com uma coluna `TenantId`, e o filtro garante que uma consulta só veja as linhas do tenant atual. Ambos são exatamente o tipo de predicado transversal que você nunca quer escrever à mão em cada `Where`, porque o único lugar em que você esquecer é um bug de vazamento de dados.

O problema antes do EF Core 10 era que cada tipo de entidade podia ter exatamente um filtro. Chamar `HasQueryFilter` duas vezes não empilhava os predicados, ele substituía o primeiro silenciosamente:

```csharp
// EF Core 9 and earlier -- the second call WINS, soft delete is lost
modelBuilder.Entity<Invoice>().HasQueryFilter(i => !i.IsDeleted);
modelBuilder.Entity<Invoice>().HasQueryFilter(i => i.TenantId == _tenantId);
// Result: only the tenant filter is active. Deleted rows come back.
```

A solução alternativa era combinar tudo com `&&` em uma única expressão:

```csharp
// EF Core 9 -- works, but the two concerns are now welded together
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

Isso compila e filtra corretamente, mas tem uma aresta afiada: você não pode desligar a metade. `IgnoreQueryFilters()` é tudo ou nada. No momento em que um relatório administrativo precisar incluir faturas com soft delete, você chama `IgnoreQueryFilters()`, e agora o filtro de tenant também some. Em um sistema multi-tenant isso não é um incômodo, é um incidente de segurança. Os filtros nomeados existem justamente para tornar possível o "desative um, mantenha o outro".

## Definindo dois filtros nomeados em uma entidade

No EF Core 11, `HasQueryFilter` tem uma sobrecarga que recebe uma chave de filtro como primeiro argumento. Forneça um nome e as chamadas se compõem em vez de sobrescrever:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Invoice
{
    public int Id { get; set; }
    public int TenantId { get; set; }
    public bool IsDeleted { get; set; }
    public decimal Amount { get; set; }
}

public class BillingContext(string tenantId) : DbContext
{
    private readonly int _tenantId = int.Parse(tenantId);

    public DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == _tenantId);
    }
}
```

Agora uma consulta simples é filtrada por ambos os predicados:

```csharp
// SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
var invoices = await context.Invoices.ToListAsync();
```

Ambos os predicados caem na mesma cláusula SQL `WHERE`, combinados com `AND`, exatamente como a versão com `&&` produzia. A diferença está inteiramente no que você pode fazer em seguida: cada predicado agora tem uma alça pela qual você pode segurar pelo nome.

Uma regra que o compilador não vai pegar: você não pode misturar um filtro nomeado e um sem nome no mesmo tipo de entidade. Assim que qualquer filtro de `Invoice` tiver nome, todos devem ter. Um `HasQueryFilter(i => ...)` sem nome em uma entidade que já tem filtros nomeados lança uma exceção no momento da construção do modelo. Escolha um estilo por entidade e mantenha-o.

## Colocando o id do tenant no contexto

Um filtro de soft delete é uma expressão constante, mas um filtro de tenant precisa de um valor em tempo de execução, e o filtro só pode ler estado que viva na instância do contexto. A conexão mais limpa é resolver o tenant atual uma única vez quando o contexto é construído. Em uma aplicação ASP.NET Core, isso normalmente significa lê-lo do usuário autenticado e passá-lo ao contexto por meio de injeção de dependência:

```csharp
// .NET 11 -- resolve tenant per request and feed it to the context
builder.Services.AddScoped<ITenantProvider, HttpTenantProvider>();

builder.Services.AddDbContext<BillingContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
});

// A small provider that pulls the tenant from the current principal
public sealed class HttpTenantProvider(IHttpContextAccessor accessor) : ITenantProvider
{
    public int TenantId =>
        int.Parse(accessor.HttpContext!.User.FindFirstValue("tenant_id")!);
}
```

Depois referencie o provedor a partir do contexto. Ler o tenant de forma preguiçosa dentro do filtro (em vez de fazer cache dele em um campo) importa mais do que parece, e a próxima seção explica por quê:

```csharp
// EF Core 11 -- the filter closes over a field EF re-reads on each query
public class BillingContext(DbContextOptions<BillingContext> options,
                            ITenantProvider tenant) : DbContext(options)
{
    private int TenantId => tenant.TenantId;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == TenantId);
    }
}
```

O EF Core avalia a expressão do tenant no momento da consulta, não na construção do modelo, então a propriedade é lida a cada consulta e traduzida em um parâmetro. Isso mantém o plano de consulta compilado reutilizável entre tenants sem deixar de isolar as linhas.

### A armadilha do pooling do DbContext

Se você usa `AddDbContextPool`, tome cuidado: um contexto do pool é reutilizado entre requisições, e o construtor dele não roda de novo na reutilização. Um id de tenant capturado em um campo dentro do construtor ficará desatualizado para a segunda requisição que receber aquela instância do pool. Ou evite o pooling para um contexto com escopo de tenant, ou resolva o tenant por meio de um provedor com escopo (scoped) lido no momento da consulta como mostrado acima, nunca um valor congelado na construção. Essa é a forma mais comum pela qual filtros de tenant nomeados vazam dados em produção.

## Soft delete sem tocar em cada ponto de chamada

O filtro esconde as linhas excluídas, mas algo ainda precisa definir `IsDeleted = true`. Você não quer isso espalhado pelos serviços. Sobrescreva `SaveChangesAsync` e converta as exclusões em atualizações no ponto de estrangulamento por onde passa cada escrita:

```csharp
// EF Core 11 -- intercept deletes and turn them into soft deletes
public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
{
    ChangeTracker.DetectChanges();

    foreach (var entry in ChangeTracker.Entries<Invoice>()
                 .Where(e => e.State == EntityState.Deleted))
    {
        entry.State = EntityState.Modified;
        entry.CurrentValues["IsDeleted"] = true;
    }

    return await base.SaveChangesAsync(ct);
}
```

Agora `context.Invoices.Remove(invoice)` seguido de `SaveChangesAsync` emite um `UPDATE` que vira o sinalizador, e o filtro de consulta faz a linha sumir das leituras comuns. Se você já executa um `ISaveChangesInterceptor` para carimbo de auditoria, esse é um lar ainda melhor para essa lógica. Veja [como usar interceptadores do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) para a versão com interceptador, que deixa `SaveChanges` intocado e sobrevive a ser chamada de qualquer repositório.

## Desativando um filtro e mantendo o outro

Este é todo o sentido de dar nomes. `IgnoreQueryFilters` aceita uma coleção de nomes de filtro, e apenas esses são desligados:

```csharp
// EF Core 11 -- see deleted invoices, but STILL scoped to the current tenant
var withDeleted = await context.Invoices
    .IgnoreQueryFilters(["SoftDeletionFilter"])
    .ToListAsync();
// SQL: WHERE TenantId = @__tenantId   (soft-delete predicate dropped, tenant kept)
```

O filtro de tenant fica intocado, então um administrador que veja "todas as faturas incluindo as excluídas" nunca vê os dados de outro cliente. O `IgnoreQueryFilters()` sem parâmetros ainda existe e ainda desliga tudo, o que você quase nunca quer em uma entidade filtrada por tenant. Trate a chamada sem parâmetros como um cheiro de código em qualquer tabela que carregue uma coluna de tenant.

### Nomeie seus filtros com constantes, não com literais de string

Os nomes de filtro são strings mágicas, e um erro de digitação em `IgnoreQueryFilters(["SoftDeletonFilter"])` falha silenciosamente ao não desativar nada. Fixe os nomes de uma vez só:

```csharp
// EF Core 11 -- one source of truth for filter names
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant = nameof(Tenant);
}

modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant, i => i.TenantId == TenantId);
```

Depois envolva a chamada de ignore em um método de extensão para que nenhum chamador jamais digite um nome de filtro:

```csharp
// EF Core 11 -- intent-revealing API, filter name hidden
public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> query)
    => query.IgnoreQueryFilters([InvoiceFilters.SoftDelete]);

// Call site reads like English and cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

## O join de navegação obrigatória que descarta linhas silenciosamente

O problema mais desagradável com filtros de consulta não tem nada a ver com nomes, e ele morde com mais força em modelos multi-tenant onde cada tabela carrega um filtro. Quando uma entidade filtrada está no lado obrigatório de uma navegação, o EF Core traduz um `Include` em um `INNER JOIN`. Se o filtro remove a linha pai, o inner join remove o filho também, e você obtém menos resultados do que esperava.

Considere um `Blog` filtrado com filhos `Post` obrigatórios:

```csharp
// EF Core 11 -- required navigation plus a filter on the principal
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired();
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));

var allPosts = await db.Posts.ToListAsync();                       // returns 6
var withBlog = await db.Posts.Include(p => p.Blog).ToListAsync();  // returns 3
```

A segunda consulta descarta todos os posts cujo blog foi filtrado, porque o `INNER JOIN` exige uma linha de blog correspondente. A documentação da Microsoft aponta isso diretamente: usar uma navegação obrigatória para alcançar uma entidade que tem um filtro de consulta global "pode levar a resultados inesperados". Há duas correções. Torne a navegação opcional para que o EF emita um `LEFT JOIN`:

```csharp
// EF Core 11 -- LEFT JOIN keeps the children even when the parent is filtered
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired(false);
```

Ou, melhor para a multi-tenancy, aplique o mesmo filtro de forma consistente em ambas as pontas para que as linhas filhas que ficariam soltas sejam removidas na origem:

```csharp
// EF Core 11 -- matching filters on both entities keep the two queries in sync
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));
modelBuilder.Entity<Post>().HasQueryFilter("UrlFilter", p => p.Blog.Url.Contains("fish"));
```

A abordagem do filtro consistente é o padrão correto quando a sua coluna de tenant vive em cada tabela: um `TenantFilter` tanto em `Blog` quanto em `Post` significa que nem um `INNER JOIN` nem um `LEFT JOIN` podem fazer surgir uma linha de outro tenant.

## Limites que vale a pena conhecer antes de se comprometer

Algumas restrições moldam até onde você pode levar isso. Os filtros só podem ser definidos no tipo de entidade raiz de uma hierarquia de herança, então você não pode colocar um filtro diferente em cada tipo derivado de um mapeamento tabela por hierarquia. O EF Core não detecta ciclos nas definições de filtro, então um filtro em `Blog` que referencia `Post` cujo filtro referencia `Blog` pode entrar em loop infinito durante a tradução, então defina-os com cuidado. E se você configura as entidades por meio de classes `IEntityTypeConfiguration<T>` em vez de diretamente no `OnModelCreating`, não há nenhuma instância do contexto da qual ler o tenant dentro de `Configure`; a solução documentada é adicionar um campo de contexto privado à classe de configuração e referenciá-lo a partir da expressão do filtro.

Uma nota de desempenho: como o valor do tenant vira um parâmetro de consulta, os predicados de soft delete e de tenant não fragmentam o seu cache de planos de consulta como uma constante embutida faria. Isso mantém os filtros nomeados baratos mesmo sob carga multi-tenant pesada. Se você está auditando a contagem de consultas enquanto adiciona filtros, cruze com [como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), já que um filtro que atravessa uma navegação pode adicionar um join que você não planejou.

Os filtros de consulta nomeados transformam os filtros globais de um instrumento tosco em um componível. Dois predicados, dois nomes e a capacidade de levantar exatamente um deles para exatamente uma consulta é a diferença entre um interruptor de soft delete e uma brecha de tenant acidental.

## Relacionado

- [Como usar interceptadores do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: FOREIGN KEY constraint failed ao excluir uma entidade no EF Core 11](/pt-br/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution no EF Core 11](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [Como fazer paginação por keyset (cursor) no EF Core 11](/pt-br/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)

## Fontes

- [Global Query Filters, documentação do EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
