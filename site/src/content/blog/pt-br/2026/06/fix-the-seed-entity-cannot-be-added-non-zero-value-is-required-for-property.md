---
title: "Correção: The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'"
description: "O HasData semeia uma entidade com chave gerada pelo banco mas sem valor explícito. Dê a cada linha um Id estável diferente de zero, ou use UseSeeding para chaves geradas."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property"
translatedBy: "claude"
translationDate: 2026-06-25
---

A correção: você chamou `HasData` para semear uma entidade cuja chave primária é gerada pelo banco (uma coluna `IDENTITY`), mas deixou a chave no valor padrão do CLR (`0` para `int`, `Guid.Empty` para `Guid`). O `HasData` monta o script de inserção em tempo de migração sem tocar no banco de dados, então não pode contar com o banco para distribuir as chaves. Dê a cada linha semeada um valor de chave explícito, estável e diferente de zero (`new Country { Id = 1, ... }`). Se você realmente quer que o banco gere a chave, não use `HasData` de jeito nenhum: use `UseSeeding`/`UseAsyncSeeding` no lugar. Este guia é escrito para .NET 11, C# 14 e `Microsoft.EntityFrameworkCore` 11.0.0, mas o texto da mensagem e o comportamento não mudaram desde o EF Core 2.1.

```text
System.InvalidOperationException: The seed entity for entity type 'Country' cannot be added
because a non-zero value is required for property 'Id'. Consider providing a negative value
to avoid collisions with non-seed data.
   at Microsoft.EntityFrameworkCore.Metadata.Internal.EntityType.<>c__DisplayClass...
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateData(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Este é um erro de validação do modelo, não um erro de consulta em tempo de execução. Ele dispara na primeira vez que o EF Core constrói o seu modelo: a primeira consulta, o primeiro `SaveChanges`, o primeiro acesso a `context.Model` ou, o mais comum, quando você roda `dotnet ef migrations add`. O nome do tipo entre aspas é a entidade que você semeou; a propriedade entre aspas é a chave primária dela. A dica "consider providing a negative value" no final é um conselho de verdade, não enrolação, e a seção mais abaixo sobre colisões explica por quê.

## Por que o HasData precisa da chave escrita explicitamente

O `HasData` (a documentação agora o chama de [model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding), já que "seeding" prometia mais do que ele entrega) pertence às migrações. Quando você adiciona uma migração, o EF Core compara as linhas semeadas no seu modelo atual com as linhas que ele registrou no último snapshot do modelo, e emite chamadas a `InsertData`, `UpdateData` ou `DeleteData` para reconciliá-las. Essa comparação acontece em tempo de design, na sua máquina, sem conexão com o banco de dados.

A chave primária é o que torna a comparação possível. O EF Core a usa para reconhecer "esta é a mesma linha que inseri na migração anterior, mas o Name mudou" em contraste com "esta é uma linha totalmente nova". Sem um valor de chave estável, ele não tem nada para casar entre migrações. Por isso o validador do modelo impõe uma regra rígida: cada linha de `HasData` precisa carregar um valor explícito para a sua chave primária, mesmo quando essa chave estiver configurada como gerada pelo banco.

Quando a chave é gerada pelo banco e você a deixa no valor padrão do CLR, o EF Core não consegue distinguir entre "o desenvolvedor esqueceu de definir a chave" e "o desenvolvedor quer a chave 0". Em vez de inserir silenciosamente uma linha com `Id = 0` (que colide feio com colunas identity), ele lança uma exceção. A [lista de limitações do model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) coloca isso em primeiro lugar: "O valor da chave primária precisa ser especificado mesmo que normalmente seja gerado pelo banco. Ele será usado para detectar mudanças de dados entre migrações."

## O menor repro

Uma única entidade com um `Id` convencional e uma chamada a `HasData` que o omite.

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
public class Country
{
    public int Id { get; set; }      // conventional PK -> store-generated IDENTITY
    public string Name { get; set; } = "";
}

public class AppDbContext : DbContext
{
    public DbSet<Country> Countries => Set<Country>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=SeedRepro;Trusted_Connection=True");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Country>().HasData(
            new Country { Name = "USA" },      // no Id -> Id stays 0 -> throws
            new Country { Name = "Canada" });
    }
}
```

Rode `dotnet ef migrations add Seed` contra isso e você recebe a exceção. As propriedades `Id` valem `0`, o EF Core trata `0` como "sem valor" para uma chave `int` gerada pelo banco, e a validação falha antes de qualquer código de migração ser escrito.

## Correção 1: dê a cada linha semeada uma chave explícita e estável

Esta é a correção certa para dados de referência genuínos: tabelas de consulta pequenas e fixas que só mudam por meio de migrações (países, moedas, papéis, status). Atribua a cada linha um valor de chave na mão e nunca o reutilize nem o renumere.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = 1, Name = "USA" },
    new Country { Id = 2, Name = "Canada" },
    new Country { Id = 3, Name = "Mexico" });
```

Duas regras mantêm isso funcionando ao longo do tempo:

1. **Os valores de chave agora fazem parte do histórico do seu esquema.** Trate-os como imutáveis. Se você mudar a linha 2 de `Id = 2` para `Id = 22`, a próxima migração emite um `DeleteData` para `2` e um `InsertData` para `22`, o que joga fora a linha antiga e tudo que a referenciava por chave estrangeira.
2. **Escolha os valores explicitamente, não deixe que eles deslizem.** Constantes fixas no código estão bem. O que você não deve fazer é calculá-las a partir de algo não determinístico (um contador de laço que depende da ordem da coleção, `DateTime.Now`, uma chamada a `Guid.NewGuid()`), porque a comparação da migração precisa produzir os mesmos valores em cada máquina.

Se a chave for um `Guid`, a mesma regra se aplica: forneça um `Guid` fixo, escrito no código, não `Guid.NewGuid()`. Um GUID recém-gerado a cada build faz cada migração achar que a linha mudou.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - fixed GUIDs, not Guid.NewGuid()
modelBuilder.Entity<Role>().HasData(
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), Name = "Admin" },
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3302"), Name = "User" });
```

## Correção 2: use chaves negativas para escapar de colisões de identity

A própria dica da exceção, "consider providing a negative value to avoid collisions with non-seed data", resolve um problema que você encontra mais tarde, não o que está na sua frente. Quando você semeia `Id = 1, 2, 3` em uma coluna `IDENTITY` do SQL Server, o contador de identity não sabe das suas linhas semeadas. O primeiro `INSERT` real após a semeadura começa o contador em `1`, tenta usar uma chave que a sua semeadura já tomou, e falha com uma violação de chave primária, ou a maquinaria de `IDENTITY_INSERT` entra em cena e as coisas ficam confusas.

Chaves negativas para os dados semeados contornam isso. Linhas reais geradas pelo usuário contam para cima a partir de `1`; suas linhas de referência semeadas vivem abaixo de `0` e nunca se sobrepõem.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = -1, Name = "USA" },
    new Country { Id = -2, Name = "Canada" },
    new Country { Id = -3, Name = "Mexico" });
```

Esta é a recomendação de longa data do time do EF Core para tabelas de consulta respaldadas por `IDENTITY` que também recebem inserções em tempo de execução. É exagero para uma tabela que é *apenas* semeada (uma tabela de consulta pura na qual o app nunca insere), onde chaves positivas se leem de forma mais natural.

## Correção 3: pare de usar HasData para esses dados

Se a sua razão para recorrer ao `HasData` era "só quero algumas linhas iniciais no banco", você provavelmente não quer model managed data de jeito nenhum. O `HasData` foi feito para dados estáticos, determinísticos e de propriedade das migrações, e nada mais. Para dados que devam usar chaves geradas pelo banco, dependam de outras linhas, ou sejam apenas dados de inicialização convenientes, o time do EF Core agora recomenda [UseSeeding e UseAsyncSeeding](/pt-br/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), introduzidos no EF Core 9. Eles executam um `SaveChanges` real contra um banco de dados ativo, então o banco gera as chaves e a regra de não-zero nunca se aplica.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
protected override void OnConfiguring(DbContextOptionsBuilder options)
    => options
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            if (!context.Set<Country>().Any())
            {
                // No Id set: the database generates it on SaveChanges. No error.
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<Country>().AnyAsync(ct))
            {
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                await context.SaveChangesAsync(ct);
            }
        });
```

O `UseSeeding` é chamado a partir de `EnsureCreated` e `Migrate` e de `dotnet ef database update`, mesmo quando não há migrações pendentes. Implemente as duas sobrecargas, a sync e a async: as ferramentas do EF Core chamam a síncrona, e ela vai pular a semeadura silenciosamente se só a versão async existir. Como o corpo da semeadura roda como código de aplicação sem o requisito de chave em tempo de design, omitir `Id` é exatamente o certo aqui: o banco o atribui.

## Variantes que produzem o mesmo erro

A redação da mensagem é idêntica em todos esses casos, então o tráfego de busca aterrissa aqui para todos eles. A causa é sempre a mesma (uma linha de `HasData` à qual falta um valor de chave explícito gerado pelo banco), mas a superfície difere.

- **Entidades owned e tipos complexos.** `OwnsOne(...).HasData(...)` precisa da chave do *proprietário* em cada linha semeada, fornecida via objeto anônimo: `new { CountryId = 1, ... }`. Omita-a e você recebe o erro de não-zero contra a propriedade de chave do proprietário.
- **Linhas de tabela de junção muitos-para-muitos.** Semear a tabela de junção com `UsingEntity(...).HasData(...)` exige ambas as chaves estrangeiras em cada linha. Um lado faltando ou em zero lança esse mesmo erro. Veja [como semear uma relação muitos-para-muitos no EF Core 11](/pt-br/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) para a configuração completa da entidade de junção.
- **Chaves compostas.** Cada coluna da chave composta precisa estar definida em cada linha semeada. Um zero em qualquer uma das partes dispara o erro para aquela propriedade.
- **Chaves com conversão de valor.** Um ID fortemente tipado (um `record struct CountryId(int Value)`) respaldado por um conversor de valor ainda precisa de um valor diferente do padrão. A instância padrão converte para o padrão do banco, que conta como "sem valor".

Um erro diferente mas facilmente confundido é `The seed entity for entity type 'X' cannot be added because there was no value provided for the required property 'Y'`, onde `Y` é uma propriedade obrigatória que não é chave, como `Name`. Esse significa que uma coluna `[Required]` ou `IsRequired()` ficou nula em uma linha semeada, não que a chave esteja faltando. A correção ali é preencher a propriedade não-chave que falta.

Se o modelo nunca chega a ser construído o suficiente para validar os dados semeados porque o EF Core nem encontra uma chave para o tipo, você está diante de um problema diferente: veja a correção para [the entity type requires a primary key to be defined](/pt-br/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/).

## Por que "é só colocar Id = 0 explicitamente" não funciona

Uma falsa correção tentadora é escrever `new Country { Id = 0, Name = "USA" }` e supor que ser explícito satisfaz o validador. Não satisfaz. Para uma chave gerada pelo banco, o EF Core compara o valor com o valor padrão do CLR, e `0` *é* o padrão para `int`. O validador não consegue distinguir o seu `0` deliberado de um campo não definido, então ele continua lançando a exceção. Os únicos valores que passam são os diferentes do padrão: qualquer `int` diferente de zero, qualquer `Guid` não vazio, qualquer composto diferente do padrão. Se você de fato precisa de uma linha com chave `0`, isso é um sinal de que a chave não deveria ser gerada pelo banco; marque-a com `ValueGeneratedNever()` e o validador para de aplicar a regra de não-zero, porque a chave agora é inteiramente responsabilidade sua.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - opt out of store generation, then 0 is allowed
modelBuilder.Entity<Country>(b =>
{
    b.Property(c => c.Id).ValueGeneratedNever();
    b.HasData(new Country { Id = 0, Name = "Unknown" });   // now valid
});
```

Esse é um padrão real para uma linha sentinela "desconhecido", mas faça isso de forma deliberada: uma vez que a chave seja `ValueGeneratedNever`, cada inserção futura nessa tabela precisa fornecer a própria chave, incluindo inserções em tempo de execução vindas do seu app.

## Relacionados

- [Como semear dados com UseSeeding e UseAsyncSeeding no EF Core 11](/pt-br/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) cobre o caminho moderno de semeadura em tempo de execução que evita esse erro por completo.
- [Como semear uma relação muitos-para-muitos no EF Core 11](/pt-br/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) percorre o `HasData` da entidade de junção onde esse erro costuma aparecer.
- [Correção: The entity type 'X' requires a primary key to be defined](/pt-br/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) é o erro anterior quando o EF Core nem consegue descobrir uma chave.
- [Migrar do EF Core 6 para o EF Core 11: mudanças disruptivas que realmente mordem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cobre o que mais mudou se você está atualizando uma configuração de semeadura antiga.

## Fontes

- A [documentação de data seeding](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) do EF Core no Microsoft Learn: a seção "model managed data", sua lista de limitações ("o valor da chave primária precisa ser especificado mesmo que normalmente seja gerado pelo banco"), e a alternativa `UseSeeding`/`UseAsyncSeeding`.
- [dotnet/efcore #27871, "Warn when seeding with a 0 key"](https://github.com/dotnet/efcore/issues/27871): a discussão do time sobre o caso de chave zero por trás dessa exceção.
- [dotnet/EntityFramework.Docs #1528](https://github.com/dotnet/EntityFramework.Docs/issues/1528): a justificativa para chaves de semeadura negativas em tabelas respaldadas por `IDENTITY`.
