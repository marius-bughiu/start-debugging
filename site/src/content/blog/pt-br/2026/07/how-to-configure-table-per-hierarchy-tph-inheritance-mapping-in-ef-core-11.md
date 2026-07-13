---
title: "Como configurar o mapeamento de herança tabela por hierarquia (TPH) no EF Core 11"
description: "TPH é a estratégia de herança padrão do EF Core: uma tabela, uma coluna discriminadora. Veja como configurar o discriminador, compartilhar colunas, lidar com propriedades derivadas anuláveis e os detalhes no EF Core 11."
pubDate: 2026-07-13
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-13
---

Resposta curta: no EF Core 11 (com .NET 11 e C# 14), você não precisa fazer nada para obter tabela por hierarquia (TPH). É o padrão. No momento em que você mapeia um tipo base e ao menos um tipo derivado, o EF Core armazena toda a hierarquia em uma única tabela e adiciona uma coluna de string `Discriminator` para distinguir as linhas. A configuração é sobre ajustar esse padrão: renomear a coluna discriminadora com `HasDiscriminator`, escolher os valores armazenados com `HasValue`, mapear o discriminador para uma propriedade real, marcar a hierarquia como incompleta com `IsComplete(false)` e compartilhar colunas entre tipos irmãos. O EF Core 11 também remove uma limitação antiga ao permitir que tipos complexos e colunas JSON funcionem em hierarquias de herança, e corrige um bug de nulabilidade específico de TPH para propriedades complexas mapeadas para JSON.

Este artigo cobre a API de configuração exata, o esquema que o EF Core gera, como uma consulta contra uma hierarquia TPH realmente funciona, o detalhe das colunas anuláveis que surpreende todo mundo ao menos uma vez, e quando o TPH deixa de ser a escolha certa.

## Por que o TPH é o padrão e geralmente o correto

O EF Core oferece três estratégias de herança relacional: tabela por hierarquia (TPH), tabela por tipo (TPT) e tabela por tipo concreto (TPC). O TPH é o padrão porque é o mais rápido para o caso comum. Tudo vive em uma tabela, então carregar uma entidade é uma leitura de uma única linha sem joins, e consultar o tipo base é um `SELECT` simples sem `UNION` e sem se espalhar por várias tabelas. A [documentação de herança do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance) e o [guia de desempenho](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping) chegam à mesma regra: use TPH a menos que um benchmark ou uma restrição externa force você a sair dele.

O custo que você paga é uma tabela mais larga e esparsa. Cada propriedade de cada tipo derivado vira uma coluna na tabela compartilhada, e qualquer coluna usada apenas por algumas linhas precisa ser anulável. Para a maioria das hierarquias essa troca é aceitável. Quando deixa de ser, você migra para TPT ou TPC, que é uma decisão à parte tratada no final.

## O mapeamento padrão, sem nada configurado

O EF não varre seu assembly em busca de tipos derivados. Você inclui cada tipo no modelo explicitamente, geralmente expondo um `DbSet` ou referenciando-o em `OnModelCreating`. Aqui está uma hierarquia de dois níveis:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public string Network { get; set; } = "";
}

public class BankTransferPayment : Payment
{
    public string Iban { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
public class PaymentsContext : DbContext
{
    public DbSet<Payment> Payments { get; set; } = null!;
    public DbSet<CardPayment> CardPayments { get; set; } = null!;
    public DbSet<BankTransferPayment> BankTransferPayments { get; set; } = null!;
}
```

Sem nenhuma configuração de herança, o EF Core 11 gera uma única tabela com cada propriedade de cada tipo, além de uma coluna `Discriminator` que ele adiciona implicitamente:

```sql
CREATE TABLE [Payments] (
    [Id] int NOT NULL IDENTITY,
    [Amount] decimal(18,2) NOT NULL,
    [CreatedAt] datetime2 NOT NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [Last4] nvarchar(max) NULL,
    [Network] nvarchar(max) NULL,
    [Iban] nvarchar(max) NULL,
    CONSTRAINT [PK_Payments] PRIMARY KEY ([Id])
);
```

Duas coisas a observar. O discriminador é uma coluna de string que armazena o nome do tipo CLR (`"CardPayment"`, `"BankTransferPayment"`, `"Payment"`) para que o EF saiba qual tipo materializar em cada linha. E `Last4`, `Network` e `Iban` são todas anuláveis, porque uma linha `BankTransferPayment` não tem campos de cartão e uma linha `CardPayment` não tem IBAN. Essa nulabilidade é automática e, como veremos, não é algo que você possa sobrescrever para uma propriedade de tipo derivado.

## Como uma consulta TPH filtra por tipo

Quando você consulta o tipo base, o EF Core lê cada linha e usa o discriminador para construir o objeto concreto correto para cada uma:

```csharp
// .NET 11, EF Core 11
var all = await context.Payments.ToListAsync();
// SELECT [p].[Id], [p].[Amount], [p].[CreatedAt], [p].[Discriminator],
//        [p].[Last4], [p].[Network], [p].[Iban]
// FROM [Payments] AS [p]
```

Quando você consulta um tipo derivado, o EF adiciona um predicado sobre o discriminador para que você só receba as linhas correspondentes:

```csharp
// .NET 11, EF Core 11
var cards = await context.CardPayments
    .Where(c => c.Network == "Visa")
    .ToListAsync();
// ... WHERE [p].[Discriminator] = N'CardPayment' AND [p].[Network] = N'Visa'
```

Você também pode filtrar por tipo dentro de uma consulta do tipo base com `OfType<T>()` ou um padrão de tipo do C#, e ambos são traduzidos para o mesmo predicado sobre o discriminador:

```csharp
// .NET 11, EF Core 11
var cardsOnly = await context.Payments.OfType<CardPayment>().ToListAsync();
```

Há uma regra de materialização que vale conhecer: se a tabela contiver um valor de discriminador que não está mapeado para nenhum tipo do seu modelo, o EF lança uma exceção ao chegar nessa linha, porque não sabe o que construir. Isso só acontece se algo fora do EF gravou linhas com um discriminador desconhecido. Se essa é a sua situação, marque o mapeamento como incompleto (abaixo) para que o EF sempre adicione o filtro do discriminador, mesmo em consultas do tipo base.

## Configurando a coluna discriminadora e seus valores

A coluna `Discriminator` implícita e os nomes de tipo CLR que ela armazena raramente são o que você quer em um esquema com o qual precisa conviver. Renomeie a coluna, fixe seu tipo e escolha valores de string estáveis com `HasDiscriminator` e `HasValue`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Payment>()
        .HasDiscriminator<string>("payment_type")
        .HasValue<Payment>("base")
        .HasValue<CardPayment>("card")
        .HasValue<BankTransferPayment>("bank_transfer");
}
```

Fixar strings `HasValue` explícitas importa mais do que parece. Se você depende do padrão (o nome do tipo CLR), renomear uma classe em uma refatoração posterior muda silenciosamente o valor do discriminador armazenado, e cada linha existente em produção passa a ter um valor que seu novo modelo não reconhece. Valores explícitos desacoplam o banco de dados dos nomes das suas classes.

O discriminador não precisa ser uma string. Um `int` ou um `enum` é menor e indexa melhor:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator<int>("payment_type")
    .HasValue<Payment>(0)
    .HasValue<CardPayment>(1)
    .HasValue<BankTransferPayment>(2);
```

Como o EF adiciona o discriminador implicitamente como uma [shadow property](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), você também pode configurá-lo como qualquer outra propriedade, por exemplo limitando o comprimento da string para que não seja `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .Property("payment_type")
    .HasMaxLength(20);
```

## Mapeando o discriminador para uma propriedade real do .NET

Às vezes você quer que a etiqueta de tipo seja legível na própria entidade, não escondida em uma shadow property. Adicione uma propriedade ao tipo base e aponte `HasDiscriminator` para ela:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
    public string PaymentType { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator(p => p.PaymentType)
    .HasValue<CardPayment>("card")
    .HasValue<BankTransferPayment>("bank_transfer");
```

Agora `payment.PaymentType` é preenchido em cada entidade carregada. O EF gerencia o valor: ele o define no insert com base no tipo concreto, e não deixará você gravar um valor que contradiga o tipo. Trate-o como somente leitura no seu código. Um discriminador mapeado é útil para consultas de relatório e para respostas de API onde o cliente precisa do nome do tipo sem que você use reflexão sobre ele.

## Dizendo ao EF que a hierarquia está incompleta

Se outro sistema grava linhas na mesma tabela com valores de discriminador que você deliberadamente não mapeia, marque o discriminador como incompleto para que o EF sempre filtre, inclusive em consultas do tipo base:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator()
    .IsComplete(false);
```

Com `IsComplete(false)`, `context.Payments.ToListAsync()` adiciona `WHERE [payment_type] IN (N'card', N'bank_transfer', ...)` e ignora as linhas cujo discriminador não está mapeado, em vez de lançar uma exceção por causa delas. Essa é exatamente a saída de emergência para uma tabela compartilhada em que o EF possui apenas alguns dos tipos.

## Compartilhando uma coluna entre tipos irmãos

Por padrão, dois tipos irmãos que declaram uma propriedade com o mesmo nome recebem duas colunas separadas. Se as propriedades são do mesmo tipo e representam realmente o mesmo armazenamento, mapeie-as para uma única coluna com `HasColumnName`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Reference)
    .HasColumnName("Reference");

modelBuilder.Entity<BankTransferPayment>()
    .Property(b => b.Reference)
    .HasColumnName("Reference");
```

Isso mantém a tabela mais estreita, mas há uma armadilha de consulta que a documentação aponta explicitamente. Os provedores relacionais não adicionam o predicado do discriminador quando você lê uma coluna compartilhada por meio de um cast. Uma consulta como `(payment as CardPayment).Reference` retorna o valor de `Reference` também para as linhas irmãs, porque a coluna é fisicamente compartilhada. Para restringi-la a um único tipo, você precisa condicionar pelo tipo você mesmo:

```csharp
// .NET 11, EF Core 11 - guard the cast so siblings return null
var refs = await context.Payments
    .Select(p => p is CardPayment ? ((CardPayment)p).Reference : null)
    .ToListAsync();
```

Compartilhe colunas apenas quando os valores forem realmente o mesmo conceito. Na dúvida, deixe o EF dar a cada irmão sua própria coluna anulável.

## O detalhe das colunas anuláveis que ninguém espera

Aqui está o que surpreende as pessoas. Uma propriedade que é obrigatória em um tipo derivado não pode ser uma coluna `NOT NULL` sob TPH. Como todos os tipos compartilham uma tabela, uma coluna que pertence a `CardPayment` precisa ser anulável para que as linhas `BankTransferPayment` possam deixá-la vazia. Mesmo que `Last4` seja `required` em C#, o EF Core precisa mapeá-la como uma coluna anulável:

```sql
[Last4] nvarchar(max) NULL   -- required on CardPayment, still NULL in the DB
```

O banco de dados não vai impor por você que "todo pagamento com cartão tem Last4". A camada de aplicação e a própria validação do EF Core impõem isso na gravação, mas um `INSERT` bruto ou uma migração mal feita pode produzir uma linha de cartão com um `Last4` nulo e o esquema não impedirá. Se o não-nulo imposto pelo banco de dados em propriedades derivadas é um requisito rígido, essa é uma razão genuína para escolher TPT (cada tipo recebe sua própria tabela, então a coluna pode ser `NOT NULL` ali) ou para adicionar uma restrição `CHECK` manualmente em uma migração. Essa é a razão mais comum pela qual uma equipe move uma hierarquia para fora do TPH, então pese isso antes de se comprometer.

## O que o EF Core 11 mudou para herança

O TPH em si é estável há anos; as mudanças do EF Core 11 são sobre o que você pode colocar dentro de uma hierarquia. Tipos complexos e colunas JSON agora funcionam em tipos de entidade que usam herança TPT e TPC, o que antes não era suportado e forçava você a voltar para entidades owned em qualquer objeto de valor herdado. O TPH já suportava tipos complexos, e o EF Core 11 corrigiu um bug específico de TPH em que uma [propriedade complexa armazenada como JSON era marcada incorretamente como não anulável em uma hierarquia de classes TPH](https://github.com/dotnet/efcore/issues/37404). Então um objeto de valor mapeado em uma tabela TPH agora se comporta de forma anulável como deveria:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class CardMetadata
{
    public required string Bin { get; set; }
    public string? IssuerCountry { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public CardMetadata? Metadata { get; set; }
}
```

A configuração também ficou mais curta em todas as frentes. O EF Core 11 permite encadear o acesso a membros diretamente por meio de `Property`, então mergulhar em um tipo complexo ou em uma propriedade adjacente ao discriminador não precisa mais de um builder intermediário:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Metadata!.Bin)
    .HasMaxLength(8);
```

Se você está combinando um objeto de valor herdado com um mapeamento de divisão de tabela ou JSON, a mecânica desse mapeamento é a mesma de [como mapear um tipo complexo em vez de uma entidade owned no EF Core 11](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), e o lado de consulta JSON é coberto em [como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Atualizações em massa e filtros de consulta se dão bem com TPH

Como uma hierarquia TPH é uma única tabela, `ExecuteUpdate` e `ExecuteDelete` atingem um tipo derivado de forma limpa, aplicando o predicado do discriminador por você:

```csharp
// .NET 11, EF Core 11
await context.CardPayments
    .Where(c => c.Network == "Amex")
    .ExecuteUpdateAsync(s => s.SetProperty(c => c.Amount, c => c.Amount * 1.03m));
// UPDATE [p] SET [p].[Amount] = ... WHERE [p].[payment_type] = N'card' AND ...
```

Os compromissos entre essa via e carregar entidades são os mesmos de [como usar ExecuteUpdate e ExecuteDelete para gravações em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Os filtros de consulta também se combinam com o discriminador, então um filtro de exclusão lógica ou multitenant sobre o tipo base se aplica a toda a hierarquia, como descrito em [como usar filtros de consulta nomeados para exclusão lógica e multitenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

## Quando abandonar o TPH

Fique no TPH a menos que uma destas condições seja verdadeira:

- **Você precisa de não-nulo imposto pelo banco de dados em propriedades derivadas.** O TPH não consegue fazer isso; a coluna compartilhada precisa ser anulável. O TPT dá a cada tipo sua própria tabela, onde a coluna pode ser `NOT NULL`.
- **A tabela está ficando genuinamente esparsa e larga.** Uma hierarquia com muitos tipos derivados, cada um adicionando várias colunas obrigatórias no código, produz uma tabela que é majoritariamente nulos. Se isso prejudica o armazenamento ou seu DBA veta, o TPT normaliza ao custo de joins.
- **Você consulta majoritariamente um único tipo folha e os benchmarks mostram que o TPC vence.** O TPC mantém cada tipo concreto em sua própria tabela com todas as colunas inline, o que pode superar o TPH em consultas de um único tipo folha. Meça antes de trocar; o TPC traz sua própria geração de chaves e restrições de chave estrangeira.

Observe que mudar o tipo de uma entidade em tempo de execução (transformar um `CardPayment` em um `BankTransferPayment`) não é suportado em nenhuma estratégia. Você exclui e reinsere. Essa é uma realidade de modelagem, não uma limitação do TPH.

Para a regra prática: o TPH é o padrão porque é o padrão certo. Configure o discriminador para que seu esquema não dependa dos nomes das classes, lembre que colunas de tipo derivado são sempre anuláveis, e recorra a TPT ou TPC apenas quando uma restrição concreta ou um benchmark real disserem para você fazer isso. Se essa decisão faz parte de um salto de versão maior, o [guia de migração do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cobre as mudanças de herança e mapeamento que tendem a surgir junto.

## Leitura relacionada

- [Como mapear um tipo complexo em vez de uma entidade owned no EF Core 11](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) explica o mapeamento de objetos de valor, que agora funciona dentro das hierarquias de herança.
- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cobre o lado JSON das propriedades complexas em uma tabela TPH.
- [Como usar ExecuteUpdate e ExecuteDelete para gravações em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) mostra a via de gravação em massa que os predicados do discriminador deixam limpa.
- [Como usar filtros de consulta nomeados para exclusão lógica e multitenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) combina os filtros globais com uma hierarquia TPH.
- [Fix: The entity type requires a primary key to be defined no EF Core 11](/pt-br/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined) é o complemento quando falta a chave de um tipo base ou derivado.

## Fontes

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Modeling for performance: inheritance mapping](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core shadow properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)
- [Complex property stored as JSON marked non-nullable in TPH class hierarchy (efcore#37404)](https://github.com/dotnet/efcore/issues/37404)
