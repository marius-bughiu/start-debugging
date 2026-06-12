---
title: "Correção: The entity type 'X' requires a primary key to be defined no EF Core 11"
description: "O EF Core não encontra uma chave para o seu tipo. Nomeie uma propriedade Id ou {Type}Id, adicione [Key], chame HasKey ou, se for uma view ou SQL cru, chame HasNoKey."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined"
translatedBy: "claude"
translationDate: 2026-06-12
---

A correção: o EF Core monta o seu modelo e encontra um tipo que ele acha que é uma entidade, mas para o qual não consegue achar uma chave primária. Você tem três opções reais, em ordem: dê uma chave ao tipo (nomeie uma propriedade `Id` ou `{Type}Id`, adicione `[Key]` ou chame `modelBuilder.Entity<T>().HasKey(...)`); diga ao EF Core que o tipo é intencionalmente sem chave com `HasNoKey()` (o correto para views e resultados de SQL cru); ou impeça que o EF Core o trate como entidade removendo o `DbSet<T>` sobrando ou chamando `modelBuilder.Ignore<T>()`. Escolha a que corresponde ao que o tipo realmente é.

```text
System.InvalidOperationException: The entity type 'OrderSummary' requires a primary key to be defined.
If you intended to use a keyless entity type, call 'HasNoKey' in 'OnModelCreating'.
For more information on keyless entity types, see https://go.microsoft.com/fwlink/?linkid=2141943.
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateNonNullPrimaryKeys(IModel model)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Este é um erro de validação do modelo, não um erro de consulta em tempo de execução. Ele dispara na primeira vez que o EF Core monta o modelo: a primeira consulta, o primeiro `SaveChanges`, o primeiro comando `dotnet ef` ou uma chamada a `context.Model`. O nome de tipo entre aspas é aquele para o qual o EF Core não conseguiu definir chave. Este guia foi escrito para .NET 11, C# 14 e `Microsoft.EntityFrameworkCore` 11.0.0. O comportamento e o texto da mensagem não mudaram desde o EF Core 7, então tudo aqui se aplica até aquela versão.

## O que "requires a primary key" realmente significa

Quando o EF Core monta o seu modelo, ele executa um conjunto de convenções. Uma delas, a `KeyDiscoveryConvention`, tenta escolher uma chave primária para cada tipo de entidade procurando uma propriedade chamada, sem distinguir maiúsculas, `Id` ou `{EntityTypeName}Id`. Se encontra exatamente uma propriedade assim, ela se torna a chave. Se não encontra nenhuma, a entidade fica sem chave, e então o `ModelValidator` é executado e rejeita entidades sem chave que não foram marcadas explicitamente como tais. Essa rejeição é a exceção que você está lendo.

Então o erro sempre significa uma de duas coisas:

1. O EF Core acha que este tipo é uma entidade, mas a convenção não conseguiu descobrir uma chave e você não configurou nenhuma.
2. O EF Core não deveria estar tratando este tipo como uma entidade, mas algo o arrastou para o modelo.

Toda a correção é descobrir qual dessas é verdadeira. Duas perguntas resolvem: este tipo corresponde a uma tabela ou view real que eu leio e escrevo, e ele tem um identificador único natural? Se a resposta a ambas for sim, o tipo quer uma chave. Se for uma projeção, uma linha de relatório ou um resultado de SQL cru, ele quer `HasNoKey` ou ficar de fora do modelo por completo.

## A menor reprodução

Um `DbSet` de um tipo cuja propriedade de chave não está nomeada de uma forma que a convenção reconheça.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class AppDb : DbContext
{
    public DbSet<OrderSummary> OrderSummaries => Set<OrderSummary>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}

public class OrderSummary
{
    public Guid Reference { get; set; }   // not "Id", not "OrderSummaryId"
    public decimal Total { get; set; }
}
```

`Reference` é um identificador perfeitamente bom, mas a convenção não sabe disso. Ela procurou por `Id` ou `OrderSummaryId`, não achou nenhum, deixou o tipo sem chave e a validação falhou. O mesmo erro aparece se você mapeia uma view de SQL para uma classe, devolve linhas de `FromSql` para um tipo não mapeado ou expõe por acidente um DTO como `DbSet`.

## Correção 1: dê uma chave ao tipo

Use isto quando o tipo é uma entidade real que você consulta e persiste. Três formas, em ordem crescente de explicitude.

Renomeie a propriedade para que a convenção a encontre:

```csharp
// .NET 11, EF Core 11.0.0 -- convention discovers this automatically
public class OrderSummary
{
    public Guid Id { get; set; }          // discovered by KeyDiscoveryConvention
    public decimal Total { get; set; }
}
```

Ou mantenha o seu próprio nome e anote-o:

```csharp
// .NET 11, EF Core 11.0.0
public class OrderSummary
{
    [Key]
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Ou configure-o em `OnModelCreating`, que é o lugar certo quando você não pode ou não quer colocar atributos no tipo (por exemplo, a classe vive em um projeto de domínio que não deve referenciar o EF Core):

```csharp
// .NET 11, EF Core 11.0.0
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderSummary>().HasKey(o => o.Reference);
}
```

Para uma chave composta, passe um objeto anônimo. Não há um equivalente de atributo `[Key]` que defina a ordem das colunas de forma confiável, então prefira a forma fluente:

```csharp
// .NET 11, EF Core 11.0.0 -- composite key, order matters for the index
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });
```

Uma armadilha dentro desta correção: a propriedade de chave precisa ser uma propriedade CLR legível e mapeada. Um **campo** público, uma propriedade marcada com `[NotMapped]` ou uma propriedade de um tipo que o EF Core não consegue mapear não serão descobertos, e você continuará recebendo o erro mesmo que "claramente haja um Id ali". Torne-a uma propriedade automática de um tipo mapeável (`int`, `long`, `Guid`, `string` e assim por diante).

## Correção 2: declare o tipo sem chave com HasNoKey

Use isto quando o tipo genuinamente não tem chave primária: uma view de banco de dados, o formato do resultado de um procedimento armazenado ou uma linha de relatório somente leitura. Tipos de entidade sem chave são somente leitura, nunca são rastreados pelo rastreador de mudanças e não podem participar de `SaveChanges`.

```csharp
// .NET 11, EF Core 11.0.0 -- a view with no natural key
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToView("vw_OrderSummary");
```

A forma de atributo é `[Keyless]` sobre a classe, que equivale a chamar `HasNoKey()`:

```csharp
// .NET 11, EF Core 11.0.0
[Keyless]
public class OrderSummary
{
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Se o tipo sem chave é alimentado por SQL cru em vez de uma view, mapeie-o para a consulta em vez de uma tabela:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToSqlQuery("SELECT Reference, SUM(Total) AS Total FROM Orders GROUP BY Reference");
```

Não recorra a `HasNoKey` apenas para fazer o erro desaparecer em um tipo que de fato tem identidade. Uma entidade sem chave não pode ser atualizada nem excluída pelo contexto, e o EF Core não deduplica linhas que compartilham os mesmos valores, então você pode obter silenciosamente duplicatas em memória. `HasNoKey` é uma afirmação sobre os dados, não um atalho.

## Correção 3: impeça que o EF Core mapeie o tipo por completo

Muitas vezes o tipo não é uma entidade e nunca deveria ter sido. Ele foi arrastado para o modelo de uma de três formas:

- Você adicionou um `DbSet<SomeDto>` para uma projeção ou view-model. Remova-o e projete com `Select` para o DTO em vez disso.
- Uma entidade mapeada tem uma propriedade de navegação apontando para o tipo, então o EF Core o mapeou de forma transitiva. Se essa navegação não deveria ser um relacionamento, marque-a com `[NotMapped]`.
- Você chamou `modelBuilder.Entity<SomeDto>()` em algum lugar (muitas vezes para configurar uma única propriedade), o que o registra como entidade.

Para excluir um tipo explicitamente, ignore-o:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Ignore<OrderSummary>();
```

Ou, sobre uma propriedade que esteja causando o mapeamento transitivo:

```csharp
// .NET 11, EF Core 11.0.0
public class Order
{
    public int Id { get; set; }

    [NotMapped]
    public OrderSummary? Computed { get; set; }   // a view model, not a relationship
}
```

Para projeções pontuais raramente você precisa de um tipo mapeado. Projete direto para o formato que você quer e o EF Core nunca tenta definir chave para ele:

```csharp
// .NET 11, EF Core 11.0.0 -- no DbSet, no HasNoKey, nothing to key
var summaries = await db.Orders
    .GroupBy(o => o.CustomerId)
    .Select(g => new OrderSummary { Reference = g.Key, Total = g.Sum(o => o.Total) })
    .ToListAsync();
```

## Variantes que terminam neste mesmo erro

### Mapear um record sem Id

Um `record` posicional funciona bem como entidade, mas só se um de seus parâmetros se tornar uma chave descobrível. `public record OrderSummary(Guid Reference, decimal Total);` cai neste erro pela mesma razão que a classe: `Reference` não é `Id`. Nomeie o primeiro parâmetro `Id`, adicione `[property: Key]` ao parâmetro posicional ou configure `HasKey` em `OnModelCreating`. A mecânica de mapear records, incluindo propriedades init-only e igualdade por valor, é coberta no guia sobre [usar records com EF Core 11 corretamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

### Tipos de resultado de Database.SqlQuery<T> e FromSql

`db.Database.SqlQuery<OrderSummary>($"...")` mapeia `OrderSummary` como um tipo implícito sem chave no momento da consulta, e esse caminho não precisa de nenhuma configuração. Mas se você também chamar `modelBuilder.Entity<OrderSummary>()` para o mesmo tipo em outro lugar, você agora o registrou como uma entidade comum, e a convenção exige uma chave. Ou mantenha o tipo fora de `OnModelCreating` por completo (deixe o `SqlQuery` cuidar dele), ou registre-o explicitamente com `HasNoKey()`. Esta é a causa raiz por trás de [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), onde um tipo de consulta colidiu com uma entidade configurada de mesmo nome.

### O erro nomeia um tipo que você não escreveu

Se o tipo entre aspas é um tipo do framework ou de uma biblioteca, uma navegação o arrastou para dentro. Encontre a entidade que o referencia e decida: relacionamento real (configure a chave no tipo referenciado) ou não (marque a navegação com `[NotMapped]` ou faça `Ignore<T>()` do tipo). Isto costuma aparecer com colunas JSON fortemente tipadas e chaves estrangeiras entre esquemas, como em [dotnet/efcore#36614](https://github.com/dotnet/efcore/issues/36614).

### Só falha sob dotnet ef, não em tempo de execução

`dotnet ef migrations add` e `dotnet ef database update` montam o modelo completo, então trazem à tona erros de modelo que um caminho de código mais estreito em tempo de execução talvez ainda não tenha disparado. O erro é real; as ferramentas apenas o encontraram primeiro. Se a build em tempo de design nem consegue construir o seu contexto, você verá uma mensagem diferente primeiro; essa é coberta em [por que dotnet ef migrations add não consegue criar o seu DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

### Uma chave anulável ou ofuscada

Se a sua propriedade de chave é anulável (`int?`), o EF Core a descobrirá, mas o `ModelValidator` rejeita chaves primárias nulas com uma mensagem muito próxima. Torne a chave não anulável. Da mesma forma, se uma classe base e uma classe derivada ambas declaram `Id`, o membro ofuscado pode confundir a descoberta; declare a chave uma única vez no tipo que o EF Core mapeia.

## Confirmando a correção

Depois de aplicar uma das três correções, force uma build do modelo sem executar o seu app para que o ciclo de feedback seja rápido:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef dbcontext info --startup-project ./Api
```

Se o modelo for válido, isto imprime o provedor e os detalhes do contexto. Se um tipo ainda estiver sem chave e sem marcação, ele lança a mesma exceção, e a mensagem diz exatamente qual tipo continua sem resolução. Resolva-os um de cada vez; um modelo com vários tipos de view ou DTO pode lançar uma vez por tipo até que cada um seja tratado.

O modelo mental que vale a pena guardar: este erro é o EF Core pedindo que você classifique um tipo. Entidade com identidade, formato somente leitura sem chave, ou não-uma-entidade. Uma vez que você responde isso, a correção é mecânica. Quando você liga esses tipos aos seus testes e quer que o rastreamento de mudanças se comporte, os padrões de [simular o DbContext sem quebrar o rastreamento de mudanças](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) e [pré-aquecer o modelo do EF Core antes da primeira consulta](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) combinam bem com ter as suas chaves corretas.

## Fontes

- [Keyless entity types](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types), documentação do EF Core, sobre `HasNoKey`, `[Keyless]` e as restrições de somente leitura.
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys), documentação do EF Core, sobre a descoberta por convenção, `[Key]` e chaves compostas.
- [Model validation and conventions](https://learn.microsoft.com/en-us/ef/core/modeling/), documentação do EF Core.
- [dotnet/efcore#29198](https://github.com/dotnet/efcore/issues/29198) e [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), os issues canônicos por trás desta mensagem.
