---
title: "Como mapear um tipo complexo em vez de uma entidade owned no EF Core 11"
description: "Entidades owned carregam uma chave oculta e identidade de referência que conflitam com value objects. Veja como mapear um value object como tipo complexo no EF Core 11, quando trocar e as armadilhas."
pubDate: 2026-07-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "owned-entities"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Resposta curta: no EF Core 11 (com .NET 11 e C# 14), mapeie um value object como `Address` ou `Money` com `ComplexProperty` em vez de `OwnsOne`. Um tipo complexo não tem chave nem identidade, então o EF Core o trata com semântica de valor: atribuí-lo copia os campos, compará-lo compara o conteúdo, e o `ExecuteUpdate` pode alterar suas propriedades. Uma entidade owned continua sendo um tipo de entidade por baixo dos panos, com uma chave shadow e identidade de referência, e é exatamente daí que vêm as surpresas que as pessoas enfrentam (você não pode atribuir uma referência compartilhada, a igualdade em LINQ quebra, a atualização em massa é bloqueada). Tipos complexos foram introduzidos no EF Core 8, ganharam mapeamento opcional (anulável) e colunas JSON no EF Core 10, e no EF Core 11 passaram a ser utilizáveis em hierarquias de herança TPT/TPC com uma API de configuração mais limpa. A troca é uma mudança de configuração de modelo mais uma migração.

Este post cobre o que de fato difere entre os dois mapeamentos, a configuração exata de `ComplexProperty` para table splitting e JSON, como migrar um mapeamento `OwnsOne` existente sem perder dados, e os casos em que você ainda precisa recorrer a entidades owned.

## Por que entidades owned nunca foram o formato certo para um value object

Quando o EF Core adicionou os tipos de entidade owned, eles foram apresentados como a forma de modelar value objects: um `Address` que vive dentro de um `Customer`, mapeado na mesma tabela. Isso funciona, mas sempre foi um compromisso. Uma entidade owned **é um tipo de entidade**. O EF Core dá a ela uma chave primária (normalmente uma chave shadow que ele gerencia para você), a rastreia no change tracker como um nó próprio, e raciocina sobre ela com identidade de referência. A [documentação de entidades owned](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities) alerta há anos sobre as arestas que decorrem disso.

Três dessas arestas incomodam o tempo todo.

Primeiro, você não pode compartilhar uma instância. Isto parece que deveria funcionar, mas não funciona:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws with owned entities
```

Como ambas as propriedades são o mesmo tipo de entidade, o EF Core vê uma entidade referenciada duas vezes e a recusa. Segundo, a igualdade em LINQ compara por identidade, não por conteúdo, então `context.Customers.Where(c => c.BillingAddress == c.ShippingAddress)` não significa o que você pensa. Terceiro, o `ExecuteUpdate` não dá nenhum suporte a propriedades de entidade owned.

Um tipo complexo é o mapeamento que realmente foi pensado para isso. Ele não tem identidade própria. É definido inteiramente por seus dados, que é a definição de um value object. Atribuí-lo copia os campos. Compará-lo compara os campos. E o EF Core 11 o suporta em `ExecuteUpdate`. A própria orientação do time do EF nas [notas de versão do EF Core 10](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types) é direta: "usuários que já usam tipos de entidade owned para isso são aconselhados a mudar para tipos complexos."

## O mapeamento mínimo de tipo complexo

Comece com o value object e a entidade que o contém. O value object não precisa de chave, nem de `Id`, nem de nada que cheire a identidade:

```csharp
// .NET 11, C# 14, EF Core 11
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; }
    public Address? BillingAddress { get; set; }
}
```

Há duas maneiras de dizer ao EF Core que isto é um tipo complexo. A API fluente em `OnModelCreating`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>(b =>
    {
        b.ComplexProperty(c => c.ShippingAddress);
        b.ComplexProperty(c => c.BillingAddress);
    });
}
```

Ou o atributo `[ComplexType]` no value object, que permite ao EF Core reconhecê-lo por convenção onde quer que seja usado:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}
```

Por padrão isto mapeia para **table splitting**: as colunas do endereço ficam diretamente na tabela `Customers` com um prefixo.

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress_Street] nvarchar(max) NOT NULL,
    [ShippingAddress_City] nvarchar(max) NOT NULL,
    [ShippingAddress_PostalCode] nvarchar(max) NOT NULL,
    [BillingAddress_Street] nvarchar(max) NULL,
    [BillingAddress_City] nvarchar(max) NULL,
    [BillingAddress_PostalCode] nvarchar(max) NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

Repare que não há uma tabela `Addresses` separada nem uma chave estrangeira. Esse é o ponto: o value object faz parte da linha de seu dono, sem join e sem identidade para gerenciar.

## Tipos complexos opcionais (anuláveis) precisam de pelo menos uma propriedade obrigatória

O `BillingAddress? BillingAddress` acima funciona porque o EF Core 10 adicionou suporte a tipos complexos **opcionais**. O objeto inteiro pode ser null, e o EF Core decide a presença a partir dos valores das colunas. Há uma regra que pega as pessoas de surpresa: um tipo complexo opcional precisa ter pelo menos uma propriedade obrigatória (não anulável). O EF Core usa essa coluna para distinguir "o endereço inteiro é null" de "o endereço está presente, mas seus campos opcionais são null." Se todas as propriedades de `Address` fossem anuláveis, o EF Core não teria sinal para diferenciar esses dois estados, e a construção do modelo lança exceção.

Na prática isso quase nunca é uma restrição, porque um endereço real tem pelo menos um campo que precisa estar presente. Se você realmente tem um value object em que todos os campos são opcionais, adicione um discriminador ou reconsidere se ele deveria ser anulável.

## Mapeando um tipo complexo para uma única coluna JSON

O table splitting espalha os campos por colunas. Se você preferir manter o value object como um único documento JSON opaco, o EF Core 10 adicionou `ToJson()` em propriedades complexas, e o EF Core 11 o mantém estável:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress, c => c.ToJson());
    b.ComplexProperty(c => c.BillingAddress, c => c.ToJson());
});
```

No SQL Server 2025 (ou Azure SQL) isto usa o tipo de coluna nativo `json`:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress] json NOT NULL,
    [BillingAddress] json NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

O mapeamento JSON lhe dá uma coisa que o table splitting não consegue fazer: **coleções dentro do tipo mapeado**. Um tipo complexo mapeado com table splitting tem que ser um único valor, mas um tipo complexo mapeado para JSON pode conter uma `List<string>` ou uma lista aninhada de value objects. Você ainda pode consultar dentro do documento. No SQL Server 2025, `context.Customers.Where(c => c.ShippingAddress.City == "Cluj")` traduz para uma busca com `JSON_VALUE`, e o EF Core 11 adiciona `EF.Functions.JsonPathExists` e `EF.Functions.JsonContains`, ambos funcionando contra tipos complexos mapeados para JSON. Para o panorama mais amplo sobre consultar dados mapeados em JSON, veja [como mapear e consultar colunas JSON no EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) e a [tradução de JSON_CONTAINS adicionada no SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/).

## O que a semântica de valor de fato lhe traz

Uma vez que o mapeamento é um tipo complexo, as três arestas das entidades owned desaparecem.

Compartilhar uma instância agora funciona, porque a atribuição copia os campos em vez de criar um alias para uma referência rastreada:

```csharp
// .NET 11, EF Core 11 - complex type mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress; // copies the values
await context.SaveChangesAsync(); // succeeds
```

A igualdade em LINQ compara o conteúdo, então isto retorna os clientes cujos dois endereços são genuinamente iguais:

```csharp
// .NET 11, EF Core 11
var sameAddress = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress)
    .ToListAsync();
```

E a atualização em massa alcança o interior do tipo complexo, o que as entidades owned nunca permitiram:

```csharp
// .NET 11, EF Core 11
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

Se você está ponderando os caminhos de escrita contra carregar e mutar entidades, os trade-offs são os mesmos abordados em [ExecuteUpdate vs carregar entidades e SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/); os tipos complexos simplesmente tornam o caso do value object elegível para o caminho rápido.

Structs também funcionam, o que se alinha bem com a ideia de "sem identidade":

```csharp
// .NET 11, C# 14, EF Core 11
public struct Money
{
    public required decimal Amount { get; set; }
    public required string Currency { get; set; }
}
```

Records também se encaixam bem, e a interação entre records, tipos complexos e change tracking vale a leitura completa em [como usar records com o EF Core 11 corretamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Migrando um mapeamento OwnsOne existente para um tipo complexo

Se você já usa `OwnsOne`, a troca é mecânica, e com table splitting normalmente é neutra em relação ao schema, porque as colunas têm o mesmo nome e tipo. Aqui está o procedimento.

1. **Confirme o formato de armazenamento atual.** Se seu `OwnsOne` mapeia para a tabela do dono (o padrão), as colunas já são `Owner_Property`. Se ele usa `OwnsOne(...).ToTable("Addresses")` (uma tabela separada) ou `OwnsOne(...).ToJson()`, anote isso, porque o armazenamento de destino importa para saber se a migração move dados.
2. **Remova o vazamento de identidade do value object.** Apague qualquer propriedade `Id`, qualquer configuração explícita de chave e qualquer navegação de volta para o dono. Um tipo complexo não pode ter chave nem referência de volta.
3. **Substitua `OwnsOne` por `ComplexProperty`.** Troque `b.OwnsOne(c => c.ShippingAddress)` por `b.ComplexProperty(c => c.ShippingAddress)`, e `b.OwnsOne(c => c.ShippingAddress, a => a.ToJson())` por `b.ComplexProperty(c => c.ShippingAddress, a => a.ToJson())`. Transfira a configuração por propriedade, como `HasMaxLength` e `HasColumnName`.
4. **Torne os value objects opcionais anuláveis no tipo CLR.** Se a referência owned pudesse estar ausente, declare a propriedade como `Address?` e confirme que o tipo tem pelo menos uma propriedade obrigatória para que o EF Core possa detectar null.
5. **Adicione e inspecione a migração.** Rode `dotnet ef migrations add SwitchAddressToComplexType`. Para um `OwnsOne` com table splitting na mesma tabela, a migração deve ser vazia ou quase vazia, porque as colunas não se movem. Se ela quiser dropar e recriar colunas, os nomes das suas colunas divergiram; fixe-os com `HasColumnName` até que o diff esteja limpo, para não perder dados.
6. **Verifique o comportamento de preservação de dados em uma cópia primeiro.** Aplique a migração em um banco de dados de teste restaurado a partir de produção antes de rodá-la de verdade, especialmente se você está saindo de uma tabela separada ou de JSON em `nvarchar` para o tipo `json` nativo.

A única migração que genuinamente move dados é ir de `OwnsOne(...).ToTable("Addresses")` (uma tabela separada) para um tipo complexo com table splitting. Não há um caminho autogerado limpo para isso, porque as linhas precisam mover-se da tabela filha para a pai. Escreva essa migração à mão: adicione as novas colunas, `UPDATE ... FROM` para copiar os valores, depois drope a tabela antiga. Se você já está no meio de um upgrade do EF Core, o mesmo cuidado se aplica ao resto do seu modelo; o [guia de migração do EF Core 6 para o EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cobre as breaking changes que tendem a surgir junto com esta.

## O EF Core 11 remove o atrito de herança e configuração

Duas coisas melhoraram especificamente no EF Core 11 que tornam a troca mais fácil.

Tipos complexos (e colunas JSON) agora funcionam em entidades que usam **herança TPT (table-per-type) e TPC (table-per-concrete-type)**. Antes do EF Core 11, uma propriedade complexa em um tipo base numa hierarquia TPT/TPC não tinha suporte, o que forçava você de volta às entidades owned para qualquer value object herdado. Agora isto mapeia corretamente:

```csharp
// .NET 11, C# 14, EF Core 11
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}

// OnModelCreating
modelBuilder.Entity<Animal>().UseTptMappingStrategy();
```

O EF Core 11 cria as colunas `Details_BirthDate` e `Details_Veterinarian` na tabela `Animal` como esperado.

A configuração também ficou mais curta. Antes, entrar em uma propriedade de um tipo complexo significava obter o complex builder primeiro:

```csharp
// Pre-EF Core 11
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.ShippingAddress)
    .Property(a => a.Street)
    .HasMaxLength(200);
```

O EF Core 11 permite encadear o acesso a membros direto em `Property`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Property(c => c.ShippingAddress.Street)
    .HasMaxLength(200);
```

O EF Core 11 também trouxe um lote de correções de estabilização para tipos complexos, incluindo a comparação correta de tipos complexos aninhados, a atribuição correta do `ExecuteUpdate` em propriedades aninhadas, e uma correção para um `NullReferenceException` quando dois tipos compartilhavam uma propriedade complexa anulável mapeada para a mesma coluna. Se você tentou tipos complexos no EF Core 9 e enfrentou arestas ásperas, o EF Core 11 é a versão em que eles pretendem ser um substituto completo das entidades owned.

## Quando você ainda precisa usar uma entidade owned

Tipos complexos não cobrem todos os casos. Recorra a `OwnsOne` ou `OwnsMany` quando:

- **Você precisa do value object em uma tabela separada.** Tipos complexos são sempre inline, seja como colunas divididas ou como uma única coluna JSON. Não existe `ComplexProperty(...).ToTable("Addresses")`. Se o seu schema exige os dados em sua própria tabela com uma chave estrangeira, isso é uma entidade owned (ou completa).
- **Você precisa de uma coleção mapeada para linhas separadas.** Um tipo complexo com table splitting precisa ser um único valor; coleções de structs não têm suporte algum. Um tipo complexo mapeado para JSON pode conter uma coleção dentro do documento, mas se você quer cada elemento como sua própria linha em uma tabela filha, `OwnsMany` continua sendo a ferramenta.
- **Algo genuinamente precisa de identidade.** Se dois "value objects" com o mesmo conteúdo precisam ser distinguíveis, ou você precisa rastreá-los e atualizá-los de forma independente, eles não são value objects. Modele-os como uma entidade relacionada de verdade.

A regra prática é a mesma que separa uma `class` de um `record`: se a coisa é definida por seus dados, mapeie-a como um tipo complexo; se ela tem uma identidade que sobrevive aos seus dados, é uma entidade. Para a maioria dos tipos `Address`, `Money`, `GeoPoint` e `DateRange` em uma base de código .NET 11, tipos complexos são agora o padrão correto, e entidades owned são a exceção à qual você recorre apenas quando o formato de armazenamento força a sua mão.

## Leitura relacionada

- [Como usar records com o EF Core 11 corretamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/) aprofunda em records como tipos complexos versus entidades e nas regras de change tracking por trás dessa divisão.
- [Como mapear e consultar colunas JSON no EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cobre o lado de consulta dos tipos complexos mapeados para JSON.
- [O EF Core 11 traduz Contains para JSON_CONTAINS no SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) explica as funções JSON que agora funcionam contra tipos complexos.
- [ExecuteUpdate vs carregar entidades e SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) enquadra o caminho de atualização em massa que os tipos complexos liberam para value objects.
- [Migre do EF Core 6 para o EF Core 11: breaking changes que realmente incomodam](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) é o complemento se esta troca faz parte de um upgrade maior.

## Fontes

- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
