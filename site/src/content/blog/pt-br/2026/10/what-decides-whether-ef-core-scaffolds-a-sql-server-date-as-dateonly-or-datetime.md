---
title: "O que decide se o EF Core faz o scaffold de uma coluna `date` do SQL Server como `DateOnly` ou `DateTime`?"
description: "A versão do EF Core do provedor SQL Server no seu projeto de inicialização decide: o EF Core 7 e anteriores fazem o scaffold de date como DateTime, o EF Core 8 até o 11 fazem como DateOnly. Aqui está o mapeamento de tipos que toma a decisão, a saída medida do EF Core 7, 8, 10 e 11 RC 2, e as duas formas de recuperar DateTime sem remapear a coluna silenciosamente para datetime2."
pubDate: 2026-10-16
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "sql-server"
  - "scaffolding"
  - "dateonly"
lang: "pt-br"
translationOf: "2026/10/what-decides-whether-ef-core-scaffolds-a-sql-server-date-as-dateonly-or-datetime"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Resposta curta:** uma única coisa decide, a versão de `Microsoft.EntityFrameworkCore.SqlServer` (e de `Microsoft.EntityFrameworkCore.Design`) que o seu projeto de inicialização referencia quando você executa `dotnet ef dbcontext scaffold`. O scaffolder pergunta à fonte de mapeamento de tipos do provedor qual é o tipo CLR padrão de cada tipo de armazenamento. Até o EF Core 7, essa busca retorna `DateTime` para `date` e `TimeSpan` para `time`. A partir do EF Core 8, passando pelo EF Core 10 e pelos release candidates do EF Core 11, ela retorna `DateOnly` e `TimeOnly`. Não existe nenhuma opção do `dotnet ef` para mudar isso. Se você precisa de `DateTime` de volta, sobrescreva o mapeamento de tipos em tempo de design por meio de `IDesignTimeServices`, ou edite o template T4. Se você usar a correção de template das notas oficiais de breaking changes exatamente como escrita, suas colunas `date` acabam mapeadas como `datetime2` em runtime. O restante deste post mostra por quê, e como corrigir.

Medi tudo abaixo no macOS com o SDK 10.0.302 contra `Microsoft.EntityFrameworkCore.SqlServer` 7.0.20, 8.0.32, 10.0.13 e 11.0.0-rc.2.26504.105 (no SDK 11.0.100-rc.1). Não há SQL Server nesta máquina, então construí manualmente o `DatabaseModel` que o scaffolder normalmente lê de `INFORMATION_SCHEMA` e o passei pelos serviços reais de design-time do SQL Server. O caminho de geração de código (fábrica de modelo de scaffolding, gerador de C#, templates T4) é o mesmo que o `dotnet ef dbcontext scaffold` executa depois de ler o esquema.

## A fonte de mapeamento de tipos decide, não a ferramenta

Quando você faz o scaffold, o EF Core lê o tipo de armazenamento de cada coluna (`date`, `datetime2`, `nvarchar(50)` e assim por diante) e precisa escolher um tipo CLR. Ele não tem uma tabela separada de regras de scaffolding para isso. Ele chama `IScaffoldingTypeMapper.FindMapping(storeType, ...)`, que pergunta ao `IRelationalTypeMappingSource` do provedor qual é o mapeamento padrão daquele tipo de armazenamento. Qualquer tipo CLR que o provedor registre primeiro para `date` é o que vai parar na sua entidade.

No EF Core 8, o provedor SQL Server ganhou suporte nativo a `DateOnly` e `TimeOnly` ([dotnet/efcore#24507](https://github.com/dotnet/efcore/issues/24507)) e os tornou os mapeamentos padrão de `date` e `time`. A [página de breaking changes do EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only) lista isso como uma mudança de impacto médio que afeta apenas quem usa database-first e refaz o scaffold.

Aqui está uma sonda que pergunta diretamente ao mapeador:

```csharp
// .NET 10, EF Core 10.0.13 (same code compiles against 7.0.20, 8.0.32, 11.0.0-rc.2)
// Reference Microsoft.EntityFrameworkCore.Design with IncludeAssets="all" so the code can see its types.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Scaffolding.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Design.Internal;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
new SqlServerDesignTimeServices().ConfigureDesignTimeServices(services);
services.AddEntityFrameworkDesignTimeServices();
var mapper = services.BuildServiceProvider().GetRequiredService<IScaffoldingTypeMapper>();

foreach (var storeType in new[] { "date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset" })
    Console.WriteLine($"{storeType,-15} -> {mapper.FindMapping(storeType, keyOrIndex: false, rowVersion: false)?.ClrType.Name}");
```

Os resultados, uma coluna por versão do provedor:

| Tipo de armazenamento | EF Core 7.0.20 | EF Core 8.0.32 | EF Core 10.0.13 | EF Core 11.0 RC 2 |
| --- | --- | --- | --- | --- |
| `date` | `DateTime` | `DateOnly` | `DateOnly` | `DateOnly` |
| `time` | `TimeSpan` | `TimeOnly` | `TimeOnly` | `TimeOnly` |
| `datetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetime2` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `smalldatetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetimeoffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` |

Então estes são os fatos que decidem:

- **A versão do pacote do provedor no projeto de inicialização.** O `dotnet ef` carrega `Microsoft.EntityFrameworkCore.Design` e o provedor a partir da saída de build do seu projeto, não do pacote da ferramenta, então o mapeamento vem da versão do EF Core do projeto. Fixar uma versão mais antiga do `dotnet-ef` não traz `DateTime` de volta. Só rende o aviso "tools version is older than that of the runtime", ou algo pior.
- **O tipo de armazenamento, não os dados.** `date` e `time` mudaram. `datetime`, `datetime2` e `smalldatetime` fazem scaffold para `DateTime` em todas as versões, porque nenhum deles é somente data.
- **O provedor.** Essa é uma decisão por provedor. Os serviços de design-time do Npgsql (verifiquei a 10.0.3) também mapeiam `date` do PostgreSQL para `DateOnly` e `time` para `TimeOnly`.

Mais nada importa: nem a versão do SQL Server, nem o nível de compatibilidade do banco de dados, nem `--use-database-names`, nem `--data-annotations`.

## Como o código gerado fica antes e depois

Fiz o scaffold de uma tabela com uma chave `int`, um `date NOT NULL`, um `date` anulável, um `time` e um `datetime2`. O EF Core 7.0.20 escreve isto:

```csharp
// Scaffolded by EF Core 7.0.20
public partial class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime? ShippedOn { get; set; }
    public TimeSpan CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
    entity.Property(e => e.OrderDate).HasColumnType("date");
    entity.Property(e => e.ShippedOn).HasColumnType("date");
});
```

O EF Core 8.0.32, 10.0.13 e 11.0 RC 2 escrevem isto, idêntico nos três:

```csharp
// Scaffolded by EF Core 8.0.32 / 10.0.13 / 11.0.0-rc.2
public partial class Order
{
    public int Id { get; set; }
    public DateOnly OrderDate { get; set; }
    public DateOnly? ShippedOn { get; set; }
    public TimeOnly CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
});
```

Veja o que desapareceu de `OnModelCreating`. No EF Core 7, `DateTime` é mapeado para `datetime2` por convenção, então o scaffolder precisava escrever `HasColumnType("date")` para manter a coluna como `date`. No EF Core 8+, `DateOnly` é mapeado para `date` por convenção, então o scaffolder trata `HasColumnType("date")` como redundante e o remove. O tipo da coluna não está mais em lugar nenhum do código gerado. Ele é implícito pelo tipo CLR. Esse detalhe é o motivo de o caminho óbvio de volta para `DateTime` estar quebrado.

## A correção de template da documentação perde o tipo da coluna

A página de breaking changes sugere uma mitigação: execute `dotnet new ef-templates`, abra `CodeTemplates/EFCore/EntityType.t4` e troque o tipo CLR quando a coluna for `date` ou `time`:

```csharp
// EntityType.t4 snippet from the EF Core 8 breaking-changes page
var clrType = property.GetColumnType() switch
{
    "date" when property.ClrType == typeof(DateOnly) => typeof(DateTime),
    "date" when property.ClrType == typeof(DateOnly?) => typeof(DateTime?),
    "time" when property.ClrType == typeof(TimeOnly) => typeof(TimeSpan),
    "time" when property.ClrType == typeof(TimeOnly?) => typeof(TimeSpan?),
    _ => property.ClrType
};
```

Apliquei essa edição aos templates do EF Core 10.0.13 (`Microsoft.EntityFrameworkCore.Templates` 10.0.13) e fiz o scaffold de novo. A entidade agora diz `DateTime OrderDate`. Mas o `DbContext.t4` ainda renderiza a fluent API a partir do modelo, onde a propriedade é `DateOnly`, então ele continua omitindo `HasColumnType("date")`. Você obtém uma propriedade `DateTime` sem tipo de coluna em lugar nenhum.

Em runtime, o EF Core então aplica a convenção de `DateTime`, que é `datetime2`. Aqui está um contexto equivalente ao que o template produziu, ao lado de outro com o tipo da coluna restaurado:

```csharp
// .NET 10, EF Core 10.0.13
var day = new DateTime(2026, 10, 16);
foreach (DbContext db in new DbContext[] { new ImplicitContext(), new ExplicitContext() })
{
    var p = db.Model.FindEntityType(typeof(Order))!.FindProperty(nameof(Order.OrderDate))!;
    Console.WriteLine($"{db.GetType().Name}: {p.GetColumnType()}");
    Console.WriteLine(db.Set<Order>().Where(o => o.OrderDate == day).ToQueryString());
}

public class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
}

public class ImplicitContext() : ShopContext(false); // what the docs' template produces
public class ExplicitContext() : ShopContext(true);  // with HasColumnType("date")

public abstract class ShopContext(bool explicitType) : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlServer("Server=.;Database=Shop");
    protected override void OnModelCreating(ModelBuilder b) => b.Entity<Order>(e =>
    {
        e.Property(x => x.Id).ValueGeneratedNever();
        if (explicitType) e.Property(x => x.OrderDate).HasColumnType("date");
    });
}
```

Saída:

```text
ImplicitContext: datetime2
DECLARE @day datetime2 = '2026-10-16T00:00:00.0000000';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
ExplicitContext: date
DECLARE @day date = '2026-10-16';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
```

Sem o tipo da coluna, todo parâmetro comparado com essa coluna vai pela rede como `datetime2`. `datetime2` tem [precedência de tipo de dados](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql) maior que `date`, então o SQL Server converte a coluna para `datetime2` na comparação. Um `DateTime` com parte de horário nunca é igual a uma data armazenada, enquanto um parâmetro `date` teria descartado o horário antes. Se o projeto também usa migrações, `GenerateCreateScript()` agora emite `[OrderDate] datetime2 NOT NULL`, e o próximo `migrations add` que tocar a tabela vai querer alterar a coluna. A metade de `time` do trecho é inofensiva, porque `TimeSpan` já é mapeado para `time` por convenção.

A correção é mais um bloco no mesmo template, logo depois do `switch`, para que a propriedade trocada carregue seu tipo de armazenamento junto:

```csharp
// CodeTemplates/EFCore/EntityType.t4, EF Core 10.0.13 templates, after the clrType switch
        usings.AddRange(code.GetRequiredUsings(clrType));

        if (clrType != property.ClrType)
        {
            // Keep the store type: DateTime/TimeSpan would otherwise map to datetime2/time by convention.
            usings.Add("System.ComponentModel.DataAnnotations.Schema");
#>
    [Column(TypeName = "<#= property.GetColumnType() #>")]
<#
        }
```

Depois substitua `property.ClrType` por `clrType` nas linhas de `needsNullable`, `needsInitializer` e da propriedade, como a documentação mostra. Com o scaffold refeito, a entidade sai assim:

```csharp
// Scaffolded by EF Core 10.0.13 with the patched EntityType.t4
using System.ComponentModel.DataAnnotations.Schema;

public partial class Order
{
    public int Id { get; set; }

    [Column(TypeName = "date")]
    public DateTime OrderDate { get; set; }

    [Column(TypeName = "date")]
    public DateTime? ShippedOn { get; set; }

    [Column(TypeName = "time")]
    public TimeSpan CutoffTime { get; set; }

    public DateTime CreatedAt { get; set; }
}
```

O atributo é emitido independentemente de você passar `--data-annotations`, porque ele é escrito pelo código do seu template, não pelo gerador de anotações. É o que você quer aqui, já que o lado da fluent API nunca vai escrevê-lo.

## A reversão mais limpa: sobrescrever o mapeamento de tipos em tempo de design

A abordagem por template corrige a saída depois que o EF já decidiu que a propriedade é `DateOnly`. Uma opção mais robusta é mudar a própria decisão, o que faz o EF Core 8+ se comportar exatamente como o EF Core 7 para `date` e `time`, fluent API incluída. O `dotnet ef` descobre qualquer implementação de `IDesignTimeServices` no projeto de inicialização e a executa **depois** dos registros do provedor e do próprio EF (veja `DesignTimeServicesBuilder.CreateServiceCollection`), então um `AddSingleton` posterior vence:

```csharp
// .NET 10, EF Core 10.0.13 / 11.0. Lives in the startup project; only used by dotnet ef.
#pragma warning disable EF1001 // SqlServerTypeMappingSource is an internal API
using System.Data;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.SqlServer.Infrastructure.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;

public sealed class ShopDesignTimeServices : IDesignTimeServices
{
    public void ConfigureDesignTimeServices(IServiceCollection services)
        => services.AddSingleton<IRelationalTypeMappingSource, DateTimeScaffoldingTypeMappingSource>();
}

public sealed class DateTimeScaffoldingTypeMappingSource(
    TypeMappingSourceDependencies dependencies,
    RelationalTypeMappingSourceDependencies relationalDependencies,
    ISqlServerSingletonOptions sqlServerSingletonOptions)
    : SqlServerTypeMappingSource(dependencies, relationalDependencies, sqlServerSingletonOptions)
{
    protected override RelationalTypeMapping? FindMapping(in RelationalTypeMappingInfo mappingInfo)
        => mappingInfo.StoreTypeNameBase switch
        {
            "date" => new SqlServerDateTimeTypeMapping("date", DbType.Date),
            "time" => new SqlServerTimeSpanTypeMapping("time"),
            _ => base.FindMapping(mappingInfo)
        };
}
```

Com isso registrado, o EF Core 10.0.13 faz o scaffold da mesma tabela com a saída do EF Core 7, byte por byte: `DateTime OrderDate`, `DateTime? ShippedOn`, `TimeSpan CutoffTime` e `HasColumnType("date")` de volta em `OnModelCreating`. Como a comparação agora acontece entre `DateTime` e seu padrão `datetime2`, o gerador de código sabe que o tipo explícito da coluna é necessário. Uma coluna `time(0)` também sai certa, como `HasColumnType("time(0)")`, onde o EF Core 10 padrão escreve `TimeOnly` com `HasPrecision(0)`.

Três coisas a saber sobre essa rota:

- `SqlServerTypeMappingSource` vive em um namespace `Internal`, daí a supressão de `EF1001`. Seu construtor tinha dois parâmetros no EF Core 8 e 9 e ganhou `ISqlServerSingletonOptions` no EF Core 10, então espere ter que mexer nessa classe em upgrades de versão major.
- Ela afeta apenas o tempo de design. Seu `DbContext` em runtime nunca vê esse serviço, porque `IDesignTimeServices` só é invocado pelas ferramentas.
- Use `AddSingleton`, não `TryAddSingleton`. O provedor já registrou sua fonte de mapeamento de tipos, então um `TryAdd` silenciosamente não faz nada. A mesma armadilha aparece quando você [substitui o pluralizador do `dbcontext scaffold`](/pt-br/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/).

Se você faz o scaffold pelo EF Core Power Tools ou pela CLI `efcpt`, isso já vem pronto: o motor de engenharia reversa dele inclui uma sobrescrita de `SqlServerTypeMappingSource` que faz exatamente o acima, controlada por `type-mappings` / `use-DateOnly-TimeOnly` em `efcpt-config.json`. O esquema de configuração publicado lista essa opção com padrão `false`, então confira seu arquivo de configuração em vez de presumir qual tipo você vai obter.

## Vale a pena reverter?

Normalmente não. Para uma coluna que guarda um dia de calendário, `DateOnly` é o tipo honesto. Um `DateTime` mapeado para `date` carrega um horário e um `Kind` que o banco de dados descarta, e essa incompatibilidade está por trás de muitos bugs de diferença de um dia quando valores cruzam fusos horários ou fronteiras de JSON. O EF Core 8+ traduz os membros comuns de `DateOnly` no SQL Server, o `System.Text.Json` o serializa como `"2026-10-16"` de fábrica, e o Dapper [trata `DateOnly` nativamente de novo desde a 2.1.86](/pt-br/2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support/).

Reverta quando você não conseguir migrar os consumidores na mesma versão: um assembly de DTOs compartilhado, uma camada de relatórios que faz aritmética com `DateTime` em todo lugar, ou uma equipe que refaz o scaffold toda semana e não consegue absorver algumas centenas de erros de compilação de uma vez. Nesse caso, escolha uma das duas correções acima e coloque-a no repositório, para que a próxima pessoa que refizer o scaffold obtenha os mesmos tipos.

## Armadilhas que aparecem depois de refazer o scaffold

- **Modelos migrados pela metade.** Se você faz o scaffold de apenas algumas tabelas com `--table`, as novas entidades recebem `DateOnly` e as antigas, mantidas à mão, continuam com `DateTime`. Ambos funcionam, já que o EF Core 8+ mapeia `DateTime` com `HasColumnType("date")` sem problemas, mas junções e comparações entre eles agora precisam de conversões em C#. Decida um tipo por coluna, não por data de scaffold.
- **Modelos code-first não são afetados.** O padrão para uma propriedade `DateTime` existente continua sendo `datetime2`, e um `HasColumnType("date")` explícito continua funcionando. Nada muda em runtime quando você atualiza o pacote. Só o código recém-gerado muda. Se uma migração de repente quiser alterar uma coluna depois de um upgrade, procure um tipo de coluna ausente como o descrito acima, e depois leia [por que o EF Core relata pending model changes](/pt-br/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/).
- **`datetime` continua `DateTime`.** Apenas `date` e `time` mudaram. Uma coluna `datetime` legada (precisão de 3,33 ms) ainda faz scaffold como `DateTime` com `HasColumnType("datetime")`, em todas as versões.
- **Atualizando do EF Core 6 ou 7 com o pacote do ErikEJ.** Se você usava `ErikEJ.EntityFrameworkCore.SqlServer.DateOnlyTimeOnly` e `UseDateOnlyTimeOnly()` para obter `DateOnly` antes do EF Core 8, remova ambos no upgrade. O suporte agora é nativo. O resto desse salto é coberto no [passo a passo das breaking changes do EF Core 6 ao 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Verifique o SQL, não o C#.** O remapeamento para `datetime2` acima compila, executa e retorna resultados plausíveis para valores à meia-noite. A única forma de enxergá-lo é pelo tipo do parâmetro, então [registre em log o SQL que o EF Core gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) ou chame `ToQueryString()` uma vez depois de qualquer personalização de scaffolding.

## Relacionados

- [How to add custom pluralization to `dotnet ef dbcontext scaffold` with `IPluralizer`](/pt-br/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/), o outro hook de `IDesignTimeServices` que você vai querer na mesma classe.
- [Migrate EF Core 6 to EF Core 11: the breaking changes that bite](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix "The JSON value could not be converted to System.DateTime"](/pt-br/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/), incluindo quando um valor de rede deveria ser um `DateOnly`.
- [How to log the SQL that EF Core 11 generates](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Fontes

- [Breaking changes in EF Core 8.0: SQL Server `date` and `time` now scaffold to `DateOnly` and `TimeOnly`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only), Microsoft Learn.
- [dotnet/efcore#24507: DateOnly and TimeOnly support for SQL Server](https://github.com/dotnet/efcore/issues/24507)
- [Custom reverse engineering templates (T4)](https://learn.microsoft.com/en-us/ef/core/managing-schemas/scaffolding/templates), Microsoft Learn.
- [Design-time services](https://learn.microsoft.com/en-us/ef/core/cli/services), Microsoft Learn.
- [`DesignTimeServicesBuilder.cs` on the release/10.0 branch](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Design/Internal/DesignTimeServicesBuilder.cs), dotnet/efcore.
- [Data type precedence (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql), Microsoft Learn.
- [EF Core Power Tools `SqlServerTypeMappingSource`](https://github.com/ErikEJ/EFCorePowerTools/blob/master/src/Core/RevEng.Core.80/SqlServerTypeMappingSource.cs) and [efcpt config schema](https://github.com/ErikEJ/EFCorePowerTools/blob/master/samples/efcpt-schema.json), ErikEJ/EFCorePowerTools.
