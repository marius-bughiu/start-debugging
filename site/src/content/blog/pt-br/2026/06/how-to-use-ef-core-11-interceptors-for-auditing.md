---
title: "Como usar os interceptadores do EF Core 11 para auditoria"
description: "Marque colunas CreatedBy/ModifiedOn e escreva um rastro completo de mudanças com um ISaveChangesInterceptor no EF Core 11, incluindo os detalhes de injeção de dependência, usuário atual e ExecuteUpdate."
pubDate: 2026-06-08
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/how-to-use-ef-core-11-interceptors-for-auditing"
translatedBy: "claude"
translationDate: 2026-06-08
---

Para auditar mudanças no EF Core 11, implemente `ISaveChangesInterceptor` (ou derive da classe base sem operações `SaveChangesInterceptor`), sobrescreva `SavingChangesAsync` para percorrer `context.ChangeTracker.Entries()` antes de a escrita chegar ao banco de dados, e registre-o com `optionsBuilder.AddInterceptors(...)`. Dentro do interceptador, você ou marca colunas de auditoria (`CreatedBy`, `CreatedOnUtc`, `ModifiedBy`, `ModifiedOnUtc`) nas entidades que implementam um marcador `IAuditable`, ou constrói uma linha de rastro de mudanças por propriedade modificada. Tudo isso roda dentro da mesma transação que o seu `SaveChanges`, então uma falha de auditoria reverte a escrita de negócio junto. Este artigo usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) e C# 14.

Os interceptadores são a ferramenta certa aqui precisamente porque ficam no ponto de passagem obrigatório pelo qual toda escrita precisa passar. Você não pode esquecer de chamá-los, não pode contorná-los a partir de algum método de repositório esquecido, e eles veem o `ChangeTracker` totalmente populado com os valores originais e atuais de cada propriedade. Esses são exatamente os dados que um registro de auditoria precisa.

## Por que um interceptador supera sobrescrever o SaveChanges

A resposta folclórica para "marque meus carimbos de tempo" é sobrescrever `SaveChanges` em um `DbContext` base:

```csharp
// The pattern people reach for first -- it works, but it has problems
public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<IAuditable>())
    {
        if (entry.State == EntityState.Added)
            entry.Entity.CreatedOnUtc = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

Isso acopla a auditoria à sua subclasse de `DbContext`. No momento em que você tiver um segundo contexto, uma biblioteca que traz o próprio contexto, ou um teste que usa um `DbContext` cru, o comportamento desaparece silenciosamente. Também força você a sobrescrever manualmente tanto `SaveChanges` quanto `SaveChangesAsync`, e não deixa um lugar limpo para injetar o usuário atual sem tornar o contexto ciente de questões HTTP.

Um `ISaveChangesInterceptor` é uma classe separada, testável e de responsabilidade única. Você o registra uma vez, ele se aplica a todo contexto ao qual está anexado, e o EF Core chama a variante sync ou async automaticamente dependendo de qual sobrecarga de `SaveChanges` quem chamou usou. A documentação oficial do EF Core descreve os interceptadores como o gancho suportado para exatamente esse tipo de questão transversal, veja o [guia de interceptadores do Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors).

## A superfície do interceptador que você realmente usa

`ISaveChangesInterceptor` define seis métodos, três sync e três async:

- `SavingChanges` / `SavingChangesAsync`: disparam antes de o EF gerar e enviar o SQL. É aqui que o trabalho de auditoria pertence, porque o `ChangeTracker` ainda reflete o que a aplicação definiu.
- `SavedChanges` / `SavedChangesAsync`: disparam após uma escrita bem-sucedida. Use-os para capturar valores gerados pelo banco de dados (chaves de identidade, colunas calculadas) que não eram conhecidos antes da escrita.
- `SaveChangesFailed` / `SaveChangesFailedAsync`: disparam quando a escrita lança uma exceção, para que você possa marcar como falha uma linha de auditoria em andamento.

Você raramente implementa a interface diretamente. Derive de `SaveChangesInterceptor`, que fornece implementações virtuais sem operações dos seis, e sobrescreva apenas o que precisar.

```csharp
// .NET 11, EF Core 11, C# 14
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class AuditableEntityInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChanges(eventData, result);
    }

    private static void StampAuditColumns(DbContext? context)
    {
        if (context is null) return;
        // implementation below
    }
}
```

Dois detalhes que confundem as pessoas. Primeiro, `eventData.Context` é anulável, então proteja-o. Segundo, você deve sobrescrever tanto `SavingChanges` quanto `SavingChangesAsync`; o EF Core não roteia um para o outro. Se você só sobrescrever a versão async e em algum lugar do seu caminho de código chamar o `SaveChanges()` síncrono, sua lógica de auditoria nunca roda. Sobrescrever ambos com um método privado compartilhado é o padrão seguro. Se você quiser forçar tudo para o caminho async, lance `NotSupportedException` da sobrescrita sync para que uma chamada síncrona perdida falhe ruidosamente em vez de pular a auditoria silenciosamente.

O valor de retorno `InterceptionResult<int>` é como você suprimiria ou substituiria o salvamento. Para auditoria você quase nunca quer isso, então passar o `result` recebido diretamente (que é o que `base.Saving...` faz) é o correto.

## Marcar colunas de auditoria em entidades auditáveis

O padrão leve: uma interface marcadora mais propriedades sombra ou reais. Defina o contrato uma vez.

```csharp
// .NET 11, C# 14
public interface IAuditable
{
    DateTime CreatedOnUtc { get; set; }
    string? CreatedBy { get; set; }
    DateTime? ModifiedOnUtc { get; set; }
    string? ModifiedBy { get; set; }
}
```

Agora preencha `StampAuditColumns`. A chamada chave é `ChangeTracker.Entries<IAuditable>()`, que retorna apenas as entidades rastreadas que implementam a interface, já particionadas por `EntityState`.

```csharp
// .NET 11, EF Core 11, C# 14
private void StampAuditColumns(DbContext? context)
{
    if (context is null) return;

    var now = _timeProvider.GetUtcNow().UtcDateTime; // TimeProvider, .NET 8+
    var user = _currentUser.UserId ?? "system";

    foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
    {
        switch (entry.State)
        {
            case EntityState.Added:
                entry.Entity.CreatedOnUtc = now;
                entry.Entity.CreatedBy = user;
                break;

            case EntityState.Modified:
                entry.Entity.ModifiedOnUtc = now;
                entry.Entity.ModifiedBy = user;
                break;

            case EntityState.Deleted:
                // optional: convert hard delete to soft delete here
                break;
        }
    }
}
```

Uma sutileza que vale destacar: uma entidade cuja única propriedade modificada é a participação em uma coleção própria, ou cuja mudança é em uma entidade relacionada, pode aparecer aqui como `Modified`. Se você quiser ignorar o "modificado só porque um filho mudou", pode adicionalmente verificar `entry.Properties.Any(p => p.IsModified)`. Para a maioria dos casos de colunas de auditoria, a verificação simples de `State` é o que você quer.

Injete `TimeProvider` em vez de chamar `DateTime.UtcNow` diretamente. Isso torna o interceptador testável com um relógio falso, o que importa porque o carimbo de tempo é a coisa que você mais quer afirmar nos testes.

## Registrar o interceptador com o ciclo de vida certo

Aqui está o detalhe que produz mais relatos de bug. O interceptador precisa do usuário atual, que normalmente vem de `IHttpContextAccessor`. Isso torna o interceptador efetivamente scoped (por requisição). Mas o ingênuo `AddInterceptors(new AuditableEntityInterceptor())` cria uma instância quase singleton sem injeção de dependência.

Registre o interceptador na injeção de dependência e resolva-o ao configurar o contexto:

```csharp
// .NET 11, ASP.NET Core 11 -- Program.cs
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, HttpContextCurrentUser>();
builder.Services.AddScoped<AuditableEntityInterceptor>();

builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(
        sp.GetRequiredService<AuditableEntityInterceptor>());
});
```

Como `AddDbContext` é scoped por padrão e o callback de configuração recebe o `IServiceProvider` com escopo de requisição, resolver aqui um interceptador scoped dá a cada requisição a sua própria instância com o `ICurrentUser` correto. Se você registrar o interceptador como singleton enquanto ele depende de `IHttpContextAccessor`, ou capturará um `HttpContext` obsoleto ou disparará a validação "Cannot consume scoped service from singleton". Se você já viu essa mensagem exata, a [solução para não conseguir consumir um serviço scoped a partir de um singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/) explica por que o contêiner a rejeita.

Leia o usuário através do accessor no momento em que `SavingChanges` roda, não no construtor, para que a busca sempre reflita a requisição ativa:

```csharp
// .NET 11, C# 14
public sealed class HttpContextCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

## Escrever um rastro completo de mudanças, não só carimbos de tempo

Marcar colunas responde "quem tocou nesta linha e quando". Um rastro de mudanças responde "o que exatamente mudou". Para isso você percorre as propriedades modificadas e registra os valores original versus atual. O EF Core te dá ambos através de `PropertyEntry`.

```csharp
// .NET 11, EF Core 11, C# 14
private static List<AuditTrail> BuildTrail(DbContext context, DateTime now, string user)
{
    var trail = new List<AuditTrail>();

    foreach (var entry in context.ChangeTracker.Entries())
    {
        if (entry.Entity is AuditTrail) continue; // never audit the audit table
        if (entry.State is EntityState.Detached or EntityState.Unchanged) continue;

        var record = new AuditTrail
        {
            TableName = entry.Metadata.GetTableName(),
            Action = entry.State.ToString(),
            UserId = user,
            TimestampUtc = now,
            Changes = new Dictionary<string, object?>()
        };

        foreach (var prop in entry.Properties)
        {
            if (entry.State == EntityState.Added)
                record.Changes[prop.Metadata.Name] = prop.CurrentValue;
            else if (entry.State == EntityState.Modified && prop.IsModified)
                record.Changes[prop.Metadata.Name] =
                    new { Old = prop.OriginalValue, New = prop.CurrentValue };
            else if (entry.State == EntityState.Deleted)
                record.Changes[prop.Metadata.Name] = prop.OriginalValue;
        }

        trail.Add(record);
    }

    return trail;
}
```

Serialize `Changes` para uma coluna JSON e você terá um histórico consultável. Note que `entry.Properties` só enumera propriedades escalares; navegações e tipos próprios precisam de `entry.References` e `entry.Collections` se você se importa com eles.

## O problema da chave temporária e por que SavedChanges existe

Para linhas inseridas com chaves geradas pelo banco de dados, `prop.CurrentValue` durante `SavingChanges` é um marcador de posição temporário, não o valor de identidade real. O EF Core ainda não conversou com o banco de dados. Se o seu rastro de auditoria registra a chave primária de novas linhas, capturá-la em `SavingChanges` escreve o valor errado.

Essa é a razão inteira pela qual `SavedChanges` existe. O padrão limpo é de duas fases: construa as linhas de auditoria em `SavingChanges`, mantenha-as na instância do interceptador, depois resolva os valores de chave já reais e persista o rastro em `SavedChangesAsync`.

```csharp
// .NET 11, EF Core 11, C# 14
private readonly List<(EntityEntry Entry, AuditTrail Record)> _pending = [];

public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
    DbContextEventData eventData, InterceptionResult<int> result,
    CancellationToken ct = default)
{
    _pending.Clear();
    var ctx = eventData.Context!;
    foreach (var entry in ctx.ChangeTracker.Entries())
        // ... stash (entry, partial record) into _pending
    return base.SavingChangesAsync(eventData, result, ct);
}

public override async ValueTask<int> SavedChangesAsync(
    SaveChangesCompletedEventData eventData, int result,
    CancellationToken ct = default)
{
    foreach (var (entry, record) in _pending)
        record.EntityId = entry.Property("Id").CurrentValue?.ToString();

    // persist _pending to the audit store now that keys are real
    return await base.SavedChangesAsync(eventData, result, ct);
}
```

Como o interceptador agora mantém estado por salvamento em `_pending`, ele deve ser scoped ou transient, nunca um singleton compartilhado. Um singleton entrelaçaria `_pending` entre requisições concorrentes e corromperia o rastro. Essa é mais uma razão pela qual o registro de injeção de dependência acima usa `AddScoped`.

Se você percorre o `ChangeTracker` em um caminho quente e ao fazer profiling viu o `DetectChanges` aparecer, a [API `GetEntriesForState` do EF Core 11 pula a varredura completa de DetectChanges](/pt-br/2026/04/efcore-11-changetracker-getentriesforstate/) quando você só precisa das entradas em um estado específico.

## O detalhe que pula sua auditoria silenciosamente: ExecuteUpdate e ExecuteDelete

`SaveChangesInterceptor` só dispara para `SaveChanges` e `SaveChangesAsync`. As operações em massa `ExecuteUpdate` e `ExecuteDelete` traduzem diretamente para uma única instrução SQL e nunca carregam entidades no `ChangeTracker`, então contornam completamente o seu interceptador de auditoria. Isso é por design e é uma fonte frequente de confusão do tipo "por que esta mudança não está no registro de auditoria".

```csharp
// This UPDATE is NOT audited -- it never touches the ChangeTracker
await db.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Cancelled));
```

Se um caminho de código precisa ser auditado, ou você o roteia através de entidades rastreadas e `SaveChanges`, ou audita a operação em massa explicitamente no ponto de chamada. Os compromissos entre os dois estilos de escrita são cobertos no guia sobre [ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Escolha o caminho em massa por throughput, aceite que ele está fora do interceptador, e faça disso uma decisão explícita em vez de uma surpresa.

## Exclusões lógicas a partir do mesmo gancho

Como o interceptador vê as entradas `EntityState.Deleted` antes de o SQL ser gerado, ele é o lugar natural para converter uma exclusão física em uma exclusão lógica. Mude o estado para `Modified` e defina a sua flag:

```csharp
// .NET 11, EF Core 11, C# 14
case EntityState.Deleted when entry.Entity is ISoftDeletable sd:
    entry.State = EntityState.Modified;
    sd.IsDeleted = true;
    sd.DeletedOnUtc = now;
    sd.DeletedBy = user;
    break;
```

Combine isso com um filtro de consulta global (`modelBuilder.Entity<T>().HasQueryFilter(e => !e.IsDeleted)`) para que as linhas excluídas logicamente desapareçam das consultas normais. Só lembre que o interceptador e o filtro são duas metades de um único recurso: o interceptador escreve a flag, o filtro a oculta.

## Verificar que funciona

Os interceptadores são fáceis de testar unitariamente porque são classes simples. Construa um com um `TimeProvider` e um `ICurrentUser` falsos, adicione uma entidade a um contexto configurado com o interceptador, chame `SaveChangesAsync` e afirme os valores marcados. Para cobertura de ponta a ponta, um contexto em memória ou SQLite com o interceptador registrado através de `AddInterceptors` exercita o pipeline real do EF. Se você construir esse arcabouço de testes em torno de um contexto falsificado, as regras para manter o rastreamento de mudanças intacto estão em [como simular DbContext sem quebrar o rastreamento de mudanças](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/), e se as suas escritas de auditoria começarem a lançar exceções sobre uso concorrente do contexto, veja [uma segunda operação foi iniciada nesta instância de contexto](/pt-br/2026/05/fix-second-operation-was-started-on-this-context-instance/).

A versão curta: derive de `SaveChangesInterceptor`, sobrescreva tanto `SavingChanges` quanto `SavingChangesAsync`, percorra `ChangeTracker.Entries()` para os dados, registre o interceptador como scoped através da injeção de dependência para que ele possa ler o usuário atual, use `SavedChangesAsync` quando precisar de chaves reais, e lembre que `ExecuteUpdate`/`ExecuteDelete` contornam todo o mecanismo. Isso cobre a grande maioria dos requisitos reais de auditoria em .NET sem uma única linha de código de auditoria vazando para a sua lógica de domínio.

Fonte primária: a [documentação de interceptadores do EF Core](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors) no Microsoft Learn, que inclui o exemplo canônico de banco de dados de auditoria separado sobre o qual este artigo se constrói.
