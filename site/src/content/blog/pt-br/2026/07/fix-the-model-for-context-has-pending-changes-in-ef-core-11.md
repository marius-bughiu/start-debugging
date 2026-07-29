---
title: "Correção: \"The model for context 'X' has pending changes\" no EF Core 11"
description: "O EF Core lança PendingModelChangesWarning quando seu modelo não bate mais com o último snapshot de migração. Adicione a migração ou corrija o falso positivo."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "migration"
lang: "pt-br"
translationOf: "2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-29
---

Execute `dotnet ef migrations add <Name>` e depois `dotnet ef database update`. Desde o EF Core 9.0, `Migrate()`, `MigrateAsync()` e `dotnet ef database update` comparam seu modelo atual com o snapshot gravado pela última migração e lançam `PendingModelChangesWarning` se eles divergirem, e a causa esmagadoramente comum é uma mudança de modelo sem migração por trás. Se a migração que você acabou de gerar está vazia, ou é idêntica toda vez que você a regera, você tem um falso positivo: valores não determinísticos em `HasData`, um snapshot de modelo ausente, opções de Identity que só existem no projeto de inicialização, ou um snapshot produzido por uma versão mais antiga do EF Core. Este artigo é voltado ao EF Core 11.0 no .NET 11 (preview 6 no momento da escrita, GA em novembro de 2026) com C# 14, e tudo se aplica sem mudanças até o EF Core 9.0, onde a exceção foi introduzida.

## O erro em contexto

A exceção em runtime, lançada por uma chamada a `Database.Migrate()` na inicialização:

```
Microsoft.EntityFrameworkCore.Migrations[20409]
System.InvalidOperationException: An error was generated for warning 'Microsoft.EntityFrameworkCore.Migrations.PendingModelChangesWarning': The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes. This exception can be suppressed or logged by passing event ID 'RelationalEventId.PendingModelChangesWarning' to the 'ConfigureWarnings' method in 'DbContext.OnConfiguring' or 'AddDbContext'.
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.ValidateMigrations(String targetMigration)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.Migrate(DatabaseFacade databaseFacade)
```

A mesma falha pela CLI é mais curta, e o código de saída é diferente de zero:

```
Build started...
Build succeeded.
The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes.
```

O ID de evento `20409` é `RelationalEventId.PendingModelChangesWarning` (`CoreEventId.RelationalBaseId + 409`), na categoria de log `Microsoft.EntityFrameworkCore.Migrations`. No EF Core 9.0.0 a mensagem não tinha o link `aka.ms`, que é a única diferença de texto entre 9.0 e 11.0.

## Por que isso acontece

A verificação compara dois modelos: o modelo de tempo de design que o EF constrói agora a partir do seu `DbContext`, e o snapshot do modelo serializado em `Migrations/AppDbContextModelSnapshot.cs` quando você rodou `migrations add` pela última vez. Ela **não** olha para o seu banco de dados. Essa é a informação mais útil sobre esse erro, porque significa que um banco de dados perfeitamente atualizado não vai te salvar, e um desatualizado não vai causar o erro.

A comparação é a mesma que alimenta a geração de migrações. Da própria implementação do `Migrator` no EF Core:

```csharp
// efcore/src/EFCore.Relational/Migrations/Internal/Migrator.cs, EF Core 11
public bool HasPendingModelChanges()
    => _migrationsModelDiffer.HasDifferences(
        FinalizeModel(_migrationsAssembly.ModelSnapshot?.Model)?.GetRelationalModel(),
        _designTimeModel.Model.GetRelationalModel());
```

Duas consequências decorrem desse formato. Primeiro, o diff roda sobre o modelo *relacional*, então ele enxerga tipos de coluna, tamanhos, nulabilidade, índices e nomes de constraints, não apenas suas classes de entidade. Um `HasMaxLength(128)` que antes era `450` é uma mudança pendente mesmo que nenhuma propriedade C# tenha mudado. Segundo, se `ModelSnapshot` for `null`, o modelo de origem é `null` e cada tabela do seu modelo aparece como uma diferença.

A motivação do time do EF foi direta: aplicar migrações em silêncio enquanto o modelo já passou delas produz um banco de dados que não corresponde ao código, e essa falha aparece muito depois como uma exceção de coluna inexistente em produção. Antes do EF Core 9.0, `Migrate()` aplicava as migrações que tinha e retornava sem dizer nada.

## Reprodução mínima

Dois arquivos e um comando esquecido:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public string? Slug { get; set; }   // added after the last migration
}

public class AppDbContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=.;Database=Demo;Trusted_Connection=True;Encrypt=False");
}
```

```csharp
// Program.cs, .NET 11
using var db = new AppDbContext();
db.Database.Migrate();   // throws PendingModelChangesWarning
```

Adicione `Slug`, pule o `dotnet ef migrations add AddBlogSlug`, e o próximo `Migrate()` lança a exceção. O banco de dados é irrelevante aqui: apague, recrie ou aponte para um servidor novo, e você recebe exatamente a mesma exceção.

## Correção, em ordem de probabilidade

**1. Adicione a migração que você esqueceu.** Essa é a correção certa na grande maioria dos casos:

```bash
dotnet ef migrations add AddBlogSlug
```

Depois aplique com `dotnet ef database update`, ou deixe o `Migrate()` fazer isso na próxima inicialização. O EF Core 11 também junta esses dois passos em um, o que é útil quando a aplicação roda em um contêiner que você não pode reconstruir: `dotnet ef database update AddBlogSlug --add` gera a migração, compila com Roslyn e aplica em um único comando. Isso é detalhado no artigo sobre [criar e aplicar uma migração em um único passo](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/).

**2. Regere um snapshot ausente ou editado à mão.** Se alguém escreveu uma classe de migração à mão, ou apagou o `AppDbContextModelSnapshot.cs`, ou resolveu um conflito de merge nele pegando um lado inteiro, o snapshot não descreve mais o modelo que as migrações produzem. Rode `dotnet ef migrations add` uma vez com as ferramentas: a migração gerada vai conter o desvio real, e o snapshot é reescrito como efeito colateral. Nunca edite o snapshot à mão para fazer o erro sumir, porque a próxima migração gerada é comparada com o que você deixou ali.

**3. Substitua valores não determinísticos de `HasData` por constantes.** Um `Guid.NewGuid()` ou `DateTime.UtcNow` dentro de um objeto de seed é avaliado toda vez que o modelo é construído, então o modelo realmente difere do snapshot a cada execução. O EF Core detecta esse caso específico e acompanha o erro com um segundo diagnóstico:

> The model for context '{contextType}' changes each time it is built. This is usually caused by dynamic values used in a 'HasData' call (e.g. `new DateTime()`, `Guid.NewGuid()`). Add a new migration and examine its contents to locate the cause, and replace the dynamic call with a static, hardcoded value.

A correção é fixar os valores:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<Blog>().HasData(new Blog
{
    Id = 1,
    Name = "Start Debugging",
    // Not Guid.NewGuid(), not DateTime.UtcNow.
    PublicId = Guid.Parse("9e4f49fe-0786-44c6-9061-53d2aa84fab3"),
    CreatedUtc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
});
```

Regere a migração depois de corrigir o modelo, já que a anterior capturou um valor aleatório. Se os dados realmente precisam ser dinâmicos, eles não pertencem ao modelo: mova-os para `UseSeeding`/`UseAsyncSeeding`, que roda fora do snapshot. O procedimento completo está em [migrar do HasData para UseAsyncSeeding](/pt-br/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/), e os trade-offs estão em [HasData vs UseSeeding](/pt-br/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/).

**4. Dê às ferramentas do EF a mesma configuração que sua aplicação tem.** O ASP.NET Core Identity é o caso clássico. Opções como `Stores.SchemaVersion` ou `Stores.MaxLengthForKeys` mudam o modelo, são definidas no contêiner de DI da aplicação, e as ferramentas do EF não as enxergam se você as executa apenas contra o projeto do `DbContext`. O snapshot então descreve um modelo diferente do que a aplicação em execução constrói. Ou você passa a aplicação como projeto de inicialização:

```bash
dotnet ef migrations add AddBlogSlug --project src/Data --startup-project src/Web
```

ou implementa `IDesignTimeDbContextFactory<T>` ao lado do contexto para que os dois caminhos construam o modelo de forma idêntica:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbContextDesignTimeFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var services = new ServiceCollection();
        services.AddDefaultIdentity<ApplicationUser>(options =>
            {
                options.Stores.SchemaVersion = IdentitySchemaVersions.Version2;
                options.Stores.MaxLengthForKeys = 256;
            })
            .AddEntityFrameworkStores<AppDbContext>();

        var optionsBuilder = new DbContextOptionsBuilder<AppDbContext>();
        optionsBuilder.UseApplicationServiceProvider(services.BuildServiceProvider());
        optionsBuilder.UseSqlServer();
        return new AppDbContext(optionsBuilder.Options);
    }
}
```

**5. Regere um snapshot escrito por uma versão mais antiga do EF Core.** A geração de snapshots melhora entre releases, então um snapshot produzido pelo EF Core 6 pode divergir de um modelo do EF Core 11 mesmo sem nenhuma mudança de código. O EF Core também detecta isso, com `RelationalEventId.OldMigrationVersion` (`20414`): "Pending model changes were detected for context '{contextType}', but the model snapshot was created with EF Core version '{efVersion}'." Adicione uma migração vazia para reescrever o snapshot na versão atual, confirme que o `Up` dela está genuinamente vazio, e mantenha-a. Esse é um passo de rotina em uma [migração do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**6. Suprima o aviso, mas só nos dois casos em que ele é um falso positivo real.** Se suas migrações são geradas ou escolhidas dinamicamente pela substituição de serviços do EF, ou você verificou que não sobrou nada para migrar, suprima o evento específico:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<AppDbContext>(options => options
    .UseSqlServer(connectionString)
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));
```

Use `w.Log(RelationalEventId.PendingModelChangesWarning)` se preferir vê-lo no log em vez de silenciá-lo. A supressão também é a única alavanca quando a última migração foi gerada para um provider diferente do que a aplica (SQLite localmente, SQL Server em produção), mas a Microsoft chama isso explicitamente de cenário sem suporte e com chance de parar de funcionar, então gere um conjunto separado de migrações por provider.

## Como saber qual é a sua causa

Comece pelo comando, não pela exceção. O `dotnet ef migrations has-pending-model-changes` existe desde o EF Core 8.0 e sai com código diferente de zero quando o modelo desviou, o que faz dele a coisa certa para rodar no CI antes de uma implantação:

```bash
dotnet ef migrations has-pending-model-changes
```

O equivalente programático, `context.Database.HasPendingModelChanges()`, transforma a mesma verificação em um teste que falha no pull request que esqueceu a migração:

```csharp
// .NET 11, EF Core 11.0.0, xUnit v3
[Fact]
public void Model_has_no_pending_changes()
{
    using var context = new AppDbContext();
    Assert.False(context.Database.HasPendingModelChanges());
}
```

Depois gere uma migração e leia. O método `Up` gerado é o diff, em termos claros: um `AddColumn` diz qual propriedade você esqueceu, um `AlterColumn` com `maxLength: 128` contra uma coluna legada `nvarchar(450)` diz que o modelo e o esquema do banco discordam sobre o tamanho, e um `InsertData` com um GUID novo toda vez aponta a causa 3. Apague a migração com `dotnet ef migrations remove` se ela se mostrar espúria.

Se a migração gerada está vazia e o erro continua, a comparação interna do EF está vendo algo que o gerador não emite. Reproduza o que o `HasPendingModelChanges` faz e imprima as operações cruas:

```csharp
// .NET 11, EF Core 11.0.0. Uses EF internals: pin your EF version if you keep this.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

using var context = new AppDbContext();

var differ = context.GetService<IMigrationsModelDiffer>();
var initializer = context.GetService<IModelRuntimeInitializer>();
var snapshot = context.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;

var source = snapshot is null ? null : initializer.Initialize(snapshot).GetRelationalModel();
var target = context.GetService<IDesignTimeModel>().Model.GetRelationalModel();

foreach (var operation in differ.GetDifferences(source, target))
{
    Console.WriteLine(operation.GetType().Name);
}
```

`IMigrationsModelDiffer` é uma interface pública, mas um serviço de uso interno, então trate isso como ferramenta de depuração e não como código de produção.

## Detalhes e variantes

**Reverter parou de disparar o erro no 9.0.2.** O EF Core 9.0.0 e 9.0.1 lançavam `PendingModelChangesWarning` mesmo quando você apontava para uma migração anterior explícita, o que tornava o rollback impossível sem suprimir o aviso. Isso foi corrigido no 9.0.2: a verificação agora só roda quando nenhuma migração de destino é especificada, então `dotnet ef database update AddBlogSlug` e `dotnet ef database update 0` funcionam com mudanças pendentes.

**"No migrations were found in assembly" é o irmão do EF Core 11, não o mesmo erro.** O `RelationalEventId.MigrationsNotFound` (`20406`) era um log informativo e passa a lançar exceção por padrão a partir do EF Core 11.0. Ele dispara quando não há migração nenhuma, tipicamente porque você chama `Migrate()` por hábito enquanto gerencia o esquema com DACPACs ou SQL escrito à mão. Remova a chamada a `Migrate()`, ou suprima esse evento separado com `w.Ignore(RelationalEventId.MigrationsNotFound)`.

**Cada tipo `DbContext` precisa da sua própria migração.** Adicionar uma migração para o `AppDbContext` não faz nada pelo `AuditDbContext`. A exceção nomeia o contexto, então leia: `dotnet ef migrations add <Name> --context AuditDbContext`.

**Projetos multi-target precisam de `--framework` desde o EF Core 10.** Se seu projeto usa `<TargetFrameworks>`, as ferramentas falham com "The project targets multiple frameworks" antes mesmo de chegar à comparação do modelo. Passe `--framework net11.0`.

**`EnsureCreated()` nunca lança esse erro.** Ele não usa migrações, então não lê o snapshot nem aplica o histórico de migrações. Se você mistura `EnsureCreated()` nos testes com `Migrate()` em produção, só o caminho de produção falha.

**O esquema do banco continua não sendo verificado.** Passar nessa verificação significa que seu modelo bate com a sua última migração. Não diz nada sobre a migração ter sido aplicada, nem sobre alguém ter editado uma coluna à mão em produção. Aplicar mudanças de esquema em um passo discreto de implantação, como descrito em [aplicar migrações do EF Core 11 com um migration bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), é o que fecha essa lacuna.

## Relacionados

- [Aplicar migrações do EF Core 11 em produção com um migration bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) - onde a verificação `has-pending-model-changes` entra em um pipeline de implantação.
- [Criar e aplicar uma migração em um único comando](/pt-br/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) - a opção `--add` do EF Core 11.
- [Migrar do HasData para UseAsyncSeeding](/pt-br/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/) - a correção definitiva para dados de seed que continuam disparando esse erro.
- [HasData vs UseSeeding no EF Core 11](/pt-br/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) - qual mecanismo de seed pertence ao modelo e qual não pertence.
- [Migrar do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) - as outras breaking changes que aparecem na mesma atualização.

## Fontes

- [Breaking changes no EF Core 9: exceção lançada ao aplicar migrações se houver mudanças pendentes no modelo](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) - a lista oficial de causas e mitigações, incluindo o exemplo da factory de tempo de design para Identity.
- [Breaking changes no EF Core 11: o EF Core agora lança exceção por padrão quando nenhuma migração é encontrada](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes) - a mudança do `MigrationsNotFound`.
- [Gerenciando migrações: verificando mudanças pendentes no modelo](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) - `has-pending-model-changes` e `HasPendingModelChanges()`.
- [dotnet/efcore#35285: contexto e informações sobre o erro PendingModelChangesWarning do 9.0](https://github.com/dotnet/efcore/issues/35285) - a triagem do próprio time do EF sobre os falsos positivos.
- [dotnet/efcore#35342](https://github.com/dotnet/efcore/issues/35342) e sua correção no 9.0.2 - a regressão do rollback.
- [Migrator.cs no dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) e [RelationalStrings.resx](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Properties/RelationalStrings.resx) - a comparação em si e o texto exato da mensagem.
