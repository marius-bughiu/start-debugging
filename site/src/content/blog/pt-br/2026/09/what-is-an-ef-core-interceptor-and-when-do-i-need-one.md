---
title: "O que é um interceptor do EF Core e quando você precisa de um?"
description: "Um interceptor do EF Core é uma classe que o EF chama antes e depois de operações como executar um comando ou SaveChanges, e que pode modificá-las ou suprimi-las, não apenas observá-las. Aqui estão os sete pontos de interceptação do EF Core 11, as regras de registro e ciclo de vida, e os casos em que um filtro de consulta ou log é a resposta melhor."
pubDate: 2026-09-05
tags:
  - "ef-core"
  - "dotnet-11"
  - "csharp"
  - "aspnetcore"
lang: "pt-br"
translationOf: "2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one"
translatedBy: "claude"
translationDate: 2026-09-05
---

Um interceptor do EF Core é uma classe que você registra em um `DbContext` e que o EF chama antes e depois de uma operação específica: criar ou executar um comando, abrir uma conexão, iniciar uma transação, chamar `SaveChanges`, materializar uma entidade a partir dos resultados de uma consulta, compilar uma consulta LINQ ou resolver um conflito de identidade. O que importa, e o que separa os interceptors do log, é que a maioria dos pontos de interceptação deixa você **alterar ou suprimir** a operação em vez de apenas assisti-la. Você precisa de um quando uma preocupação tem de valer para todos os contextos da aplicação, não pode ser expressa no modelo e precisa alterar o comportamento: carimbar colunas de auditoria, acrescentar uma dica de consulta, resolver uma string de conexão por tenant ou engolir uma exceção de concorrência que você decidiu ser inofensiva. Se tudo o que você quer é ver o SQL, você quer log, e um interceptor é a ferramenta errada.

Tudo abaixo tem como alvo o EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). A superfície de interceptação em si não mudou no EF Core 11: as sete interfaces estão estáveis desde que o EF Core 7 adicionou `IIdentityResolutionInterceptor`. O que mudou ao redor dela vale a pena conhecer, e eu cubro isso nos detalhes finais.

## Os sete pontos de interceptação

Todo interceptor implementa uma ou mais interfaces derivadas de `IInterceptor`, todas no namespace `Microsoft.EntityFrameworkCore.Diagnostics`:

| Interface | O que intercepta | Singleton |
| --- | --- | --- |
| `IDbCommandInterceptor` | Criação e execução de comandos, falhas, descarte do `DbDataReader` | Não |
| `IDbConnectionInterceptor` | Criar, abrir e fechar conexões; falhas de conexão | Não |
| `IDbTransactionInterceptor` | Criar, usar, confirmar e reverter transações; savepoints | Não |
| `ISaveChangesInterceptor` | `SavingChanges` / `SavedChanges` / `SaveChangesFailed`, concorrência otimista | Não |
| `IMaterializationInterceptor` | Criar, inicializar e finalizar instâncias de entidade a partir de resultados de consulta | Sim |
| `IQueryExpressionInterceptor` | A árvore de expressão LINQ, antes de a consulta ser compilada | Sim |
| `IIdentityResolutionInterceptor` | Conflitos de identidade quando o contexto começa a rastrear uma instância nova | Sim |

As três primeiras são apenas relacionais; a interceptação de banco de dados não está disponível em provedores não relacionais como o provedor do Azure Cosmos DB. A coluna `Singleton` não é decorativa, e eu volto a ela mais abaixo porque errar nisso é a forma mais comum de fazer um interceptor destruir o desempenho em silêncio.

Para as quatro interfaces que não são singleton existem classes base sem lógica: `DbCommandInterceptor`, `DbConnectionInterceptor`, `DbTransactionInterceptor` e `SaveChangesInterceptor`. Herde delas e sobrescreva apenas os dois ou três métodos que interessam, em vez de implementar 20 membros de interface na mão.

## O formato de um par de métodos, e o que "suprimir" significa

Cada ponto de interceptação vem em um par antes/depois, e cada metade vem em variantes síncrona e assíncrona. `ReaderExecuting` roda antes de a consulta ser enviada ao banco; `ReaderExecuted` roda depois que ela retorna. `SavingChanges` roda antes do salvamento; `SavedChanges` depois de um salvamento bem-sucedido.

Os métodos "antes" retornam um `InterceptionResult` ou um `InterceptionResult<T>`, e esse valor de retorno é o canal de controle:

- Retorne o argumento `result` sem alterações e o EF segue normalmente. Este é o caso de apenas observar.
- Retorne `InterceptionResult.Suppress()` e o EF pula a operação inteira. Usado em operações sem valor de retorno, por exemplo o ponto de interceptação `ThrowingConcurrencyException`, onde suprimir significa "não lance `DbUpdateConcurrencyException`".
- Retorne `InterceptionResult<T>.SuppressWithResult(value)` e o EF pula a operação e usa o seu valor no lugar. Usado em operações que produzem algo, por exemplo devolver um `DbDataReader` fabricado a partir de um cache em vez de executar SQL.

Esse é todo o modelo mental. O log diz o que o EF fez; um interceptor tem direito a veto.

Aqui está um interceptor de comando mínimo e genuinamente útil: registrar qualquer comando que demore mais que um limite, junto com a parte do EF que o emitiu.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore.Relational 11.0
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;

public sealed class SlowCommandInterceptor(ILogger<SlowCommandInterceptor> logger)
    : DbCommandInterceptor
{
    private static readonly TimeSpan Threshold = TimeSpan.FromMilliseconds(200);

    public override DbDataReader ReaderExecuted(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result)
    {
        Report(command, eventData);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result,
        CancellationToken cancellationToken = default)
    {
        Report(command, eventData);
        return new ValueTask<DbDataReader>(result);
    }

    private void Report(DbCommand command, CommandExecutedEventData eventData)
    {
        if (eventData.Duration < Threshold)
        {
            return;
        }

        logger.LogWarning(
            "Slow command ({DurationMs} ms, source {Source}): {Sql}",
            (int)eventData.Duration.TotalMilliseconds,
            eventData.CommandSource,
            command.CommandText);
    }
}
```

Dois detalhes ali são os que as pessoas deixam passar. Primeiro, tanto a sobrescrita síncrona quanto a assíncrona são implementadas. O EF chama a que corresponde à chamada que a aplicação fez, então implementar apenas `ReaderExecuted` significa que o seu interceptor silenciosamente não faz nada em uma base de código assíncrona. Segundo, `eventData.CommandSource` diz se o comando veio de uma consulta, de `SaveChanges`, de `ExecuteUpdate` ou de uma migração, que costuma ser o filtro que você realmente quer.

## Registrando um interceptor

O registro acontece quando o contexto é configurado, através de `DbContextOptionsBuilder.AddInterceptors`:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .AddInterceptors(sp.GetRequiredService<SlowCommandInterceptor>()));
```

Resolver o interceptor a partir do provedor de serviços é o que permite que ele receba dependências por construtor, que é como ele obtém o `ILogger` acima. Registre primeiro o próprio interceptor (`builder.Services.AddSingleton<SlowCommandInterceptor>()` aqui, já que ele não guarda estado por requisição).

`OnConfiguring` também funciona, e continua sendo executado mesmo quando `AddDbContext` é usado, então é um lugar razoável para anexar interceptors que precisam valer independentemente de como o contexto é construído. Uma mesma instância de interceptor pode implementar várias das interfaces ao mesmo tempo; registre-a uma única vez e o EF roteia cada evento para a interface certa.

## Um interceptor de SaveChanges, do início ao fim

O interceptor real mais comum é o que carimba colunas de auditoria. Vale a pena escrevê-lo por inteiro porque o pareamento síncrono/assíncrono e a chamada ao rastreador de mudanças são fáceis de errar.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public interface IAuditable
{
    DateTimeOffset CreatedUtc { get; set; }
    DateTimeOffset ModifiedUtc { get; set; }
}

public sealed class TimestampInterceptor(TimeProvider clock) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        Stamp(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Stamp(eventData.Context);
        return new ValueTask<InterceptionResult<int>>(result);
    }

    private void Stamp(DbContext? context)
    {
        if (context is null)
        {
            return;
        }

        // The docs' own auditing sample calls DetectChanges here rather than
        // assuming the states are already current. Do the same.
        context.ChangeTracker.DetectChanges();

        var now = clock.GetUtcNow();

        foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    entry.Entity.CreatedUtc = now;
                    entry.Entity.ModifiedUtc = now;
                    break;
                case EntityState.Modified:
                    entry.Entity.ModifiedUtc = now;
                    break;
            }
        }
    }
}
```

Receber `TimeProvider` em vez de ler `DateTimeOffset.UtcNow` diretamente é o que torna isso testável; o mesmo raciocínio vale em qualquer ponto de uma base de código .NET 11, e combina com [testar código dependente de tempo com FakeTimeProvider](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). Se você quer a versão completa desse padrão, incluindo escrever uma trilha de mudanças e lidar com o usuário atual, eu escrevi isso à parte em [usar interceptors do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Suprimindo uma operação: o caso da concorrência

A demonstração mais clara do veto é `ISaveChangesInterceptor.ThrowingConcurrencyException`. O EF a chama imediatamente antes de lançar `DbUpdateConcurrencyException`. Se duas requisições disputam a exclusão da mesma linha, a perdedora vê zero linhas afetadas e recebe uma exceção, mesmo que o estado final desejado (a linha não existe mais) tenha sido alcançado:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
public sealed class SuppressDeleteConcurrencyInterceptor : ISaveChangesInterceptor
{
    public InterceptionResult ThrowingConcurrencyException(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result)
        => eventData.Entries.All(e => e.State == EntityState.Deleted)
            ? InterceptionResult.Suppress()
            : result;

    public ValueTask<InterceptionResult> ThrowingConcurrencyExceptionAsync(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result,
        CancellationToken cancellationToken = default)
        => new(ThrowingConcurrencyException(eventData, result));
}
```

`eventData.Entries` entrega os objetos `EntityEntry` envolvidos, então a decisão é tomada sobre estado real e não sobre uma correspondência de texto na mensagem de uma exceção. Em um provedor relacional você pode converter `eventData` para `RelationalConcurrencyExceptionEventData` e ler também o `Command` responsável.

## Quando você não precisa de um interceptor

Interceptors são o gancho mais pesado que o EF oferece, e recorrer a eles primeiro é um erro comum. Antes de escrever um, verifique se um mecanismo mais leve cobre o caso.

**Você quer ver o SQL.** Use `Microsoft.Extensions.Logging` ou o log simples com `LogTo`. A documentação é explícita ao dizer que interceptors não são o mecanismo de log, e um pipeline de log dá níveis, filtros e destinos de graça. Se você está atrás da quantidade de consultas em vez do texto delas, a abordagem em [detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) está mais perto do que você quer, e a configuração geral de log estruturado está em [Serilog e Seq no .NET 11](/pt-br/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

**Você quer um callback ao salvar ou ao rastrear, e síncrono serve.** O `DbContext` expõe eventos .NET comuns: `SavingChanges`, `SavedChanges`, `SaveChangesFailed`, `ChangeTracker.Tracked` e `ChangeTracker.StateChanged`. Eles são registrados por instância de contexto e podem ser anexados a qualquer momento, o que os torna mais simples que um interceptor. O problema é que eventos são apenas síncronos, então não conseguem fazer E/S sem bloqueio. Interceptors conseguem, porque as metades assíncronas retornam `ValueTask`.

**Você quer a mesma informação para todos os contextos do processo.** Isso é uma assinatura de `DiagnosticListener` na fonte `"Microsoft.EntityFrameworkCore"`, não um interceptor. Diagnostic listeners valem para todo o processo e apenas observam; interceptors são por contexto e podem modificar. Escolha considerando os dois eixos, não apenas um.

**Você quer filtrar toda consulta por exclusão lógica ou por tenant.** Isso é um filtro de consulta, não um `IQueryExpressionInterceptor`. Escrever um `ExpressionVisitor` para injetar uma cláusula `Where` é uma quantidade enorme de código frágil para reimplementar algo que o modelo já faz, e o EF Core 10 e 11 suportam vários filtros por entidade que podem ser desligados de forma independente, que é exatamente o caso que as pessoas resolviam na mão. Veja [filtros de consulta nomeados para exclusão lógica e multi-tenancy](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

**Você quer transformar o valor de uma propriedade na ida e na volta.** Isso é um conversor de valor.

**O comportamento vale para exatamente uma subclasse de `DbContext` e apenas no salvamento.** Sobrescrever `SaveChangesAsync` é mais simples, mais fácil de ler em um stack trace e mais fácil de testar. Recorra a `ISaveChangesInterceptor` quando a lógica precisar valer para vários tipos de contexto, ou quando ela precisar morar em uma biblioteca compartilhada que não é dona da classe do contexto.

## Detalhes que custam tempo de verdade

**Interceptors singleton e `ManyServiceProvidersCreatedWarning`.** `IMaterializationInterceptor`, `IQueryExpressionInterceptor` e `IIdentityResolutionInterceptor` são registrados no provedor de serviços *interno* do EF. Cada instância distinta que você passa para `AddInterceptors` faz um novo provedor interno ser construído, então passar `new MyMaterializationInterceptor()` dentro de uma lambda de `AddDbContext` que roda por escopo vai acabar disparando `ManyServiceProvidersCreatedWarning` e afundando o desempenho. Guarde uma única instância em um campo estático ou resolva um singleton da injeção de dependências. Como são compartilhados, esses interceptors precisam ser thread-safe e não devem guardar estado mutável; alcance coisas com escopo pela propriedade `Context` dos dados do evento.

**Dependências com escopo em um interceptor de `SaveChanges`.** Os interceptors que não são singleton escapam da restrição acima, mas se o seu depende de algo com escopo (um acessador de usuário atual, um resolvedor de tenant), ele próprio precisa ter escopo e ser resolvido pela sobrecarga `(sp, options)` de `AddDbContext`. Registrá-lo como singleton e injetar um serviço com escopo é o caminho clássico para [cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

**`ExecuteUpdate` e `ExecuteDelete` nunca chegam a um interceptor de `SaveChanges`.** Operações baseadas em conjunto contornam o rastreador de mudanças e vão direto para o SQL, então o carimbo de auditoria, a reescrita de exclusão lógica e o despacho de eventos de domínio pendurados em `SavingChanges` são todos pulados. Isso é por design e é a forma mais comum de uma trilha de auditoria desenvolver buracos silenciosos. O trade-off está descrito em [ExecuteUpdate e ExecuteDelete para escritas em massa](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Um `IDbCommandInterceptor` continua vendo esses comandos, porque no fim tudo vira um `DbCommand`.

**`ConnectionCreating` e `ConnectionCreated` só disparam quando o EF cria a conexão.** Se a sua aplicação constrói o `DbConnection` e o entrega ao EF, esses dois pontos de interceptação nunca rodam. `ConnectionOpening` continua rodando.

**`IIdentityResolutionInterceptor` não dispara para resultados de consulta.** No EF Core 11 ele só é invocado a partir de `Update`, `Attach` e chamadas de rastreamento similares, não para entidades que voltam de uma consulta. Isso é acompanhado em [dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574) e pode mudar. Se você só quer "a última escrita vence" no attach, o `UpdatingIdentityResolutionInterceptor` embutido poupa você de escrever um.

**Interceptar a árvore de expressão é o último recurso.** `IQueryExpressionInterceptor` é poderoso, e o próprio exemplo da documentação, adicionar uma ordenação secundária estável, termina com a observação de que adicionar `.ThenBy(e => e.Id)` diretamente à consulta é mais simples, mais fácil de entender e sempre funciona. Esse é o instinto certo. Um `ExpressionVisitor` que reescreve silenciosamente toda consulta da aplicação é um problema de depuração que você herda para sempre.

**Interceptors rodam em ordem e enxergam as decisões uns dos outros.** Interceptors injetados por extensões rodam primeiro, na ordem de resolução do provedor de serviços, e depois os da aplicação. Um interceptor posterior pode consultar `InterceptionResult<T>.HasResult` para ver se um anterior já suprimiu a operação, o que importa se você os empilha.

**Uma adição do EF Core 11 que vale conhecer.** `ChangeTracker.GetEntriesForState(added, modified, deleted, unchanged)` é um enumerador filtrado por estado que pula a passagem implícita de `DetectChanges` que `Entries()` executa. Ele existe exatamente para caminhos quentes como interceptors de `SaveChanges` e ganchos de auditoria, onde a mesma varredura roda duas vezes por salvamento. Os detalhes e o trade-off estão em [EF Core 11 adiciona GetEntriesForState](/pt-br/2026/04/efcore-11-changetracker-getentriesforstate/).

## A versão curta

Escreva um interceptor quando precisar *alterar* o que o EF faz, em todos os contextos, em um ponto que o modelo não consegue expressar. Use log quando precisar ver o que ele fez, eventos .NET quando precisar de um callback síncrono simples em um contexto, um diagnostic listener quando precisar de observação em todo o processo, e um filtro de consulta ou conversor de valor quando a preocupação for realmente do modelo. Implemente as duas metades, síncrona e assíncrona, de qualquer par que você sobrescrever, mantenha interceptors singleton sem estado e compartilhados, e lembre que tudo que desvia de `SaveChanges` também desvia do seu `ISaveChangesInterceptor`.

## Relacionado

- [Como usar interceptors do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core 11 adiciona GetEntriesForState para pular DetectChanges](/pt-br/2026/04/efcore-11-changetracker-getentriesforstate/)
- [Como usar filtros de consulta nomeados para exclusão lógica e multi-tenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [Como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: cannot consume scoped service from singleton](/pt-br/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Fontes

- [Interceptors -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)
- [.NET events -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/events)
- [Using diagnostic listeners -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/diagnostic-listeners)
- [IIdentityResolutionInterceptor Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.iidentityresolutioninterceptor)
- [CommandExecutedEventData Class -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.commandexecutedeventdata)
- [What's New in EF Core 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Identity resolution interceptor is not called for query results -- dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574)
