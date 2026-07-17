---
title: "Solução: \"The property could not be mapped, because it is not a supported primitive type or a valid entity type\" no EF Core 11"
description: "O EF Core encontrou uma propriedade que não sabe armazenar. Mapeie como tipo complexo, converta com HasConversion, dê uma chave a ela ou ignore com [NotMapped]."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

O EF Core lança `The property 'X.Y' could not be mapped, because it is of type 'Z' which is not a supported primitive type or a valid entity type` quando seu modelo expõe uma propriedade que o EF Core não consegue transformar em coluna nem tratar como relacionamento. Corrija de uma entre quatro formas, em ordem de preferência: mapeie como tipo complexo com `ComplexProperty` se for um objeto de valor, converta em um escalar com `HasConversion` (um conversor de valores) se for uma lista de enum ou um wrapper personalizado, dê uma chave ao tipo para que o EF Core o mapeie como entidade relacionada, ou exclua-a por completo com `[NotMapped]` / `EntityTypeBuilder.Ignore` se ela nunca deve ser persistida. Isso se aplica ao `Microsoft.EntityFrameworkCore` 11.0 no .NET 11 com C# 14, e a mensagem está estável desde o EF Core 3.0.

## O erro em contexto

A exceção completa em tempo de execução é uma `InvalidOperationException` lançada enquanto o EF Core constrói o modelo, o que significa que ela dispara na primeira vez que você toca o `DbContext` (uma consulta, um `SaveChanges` ou `dotnet ef migrations add`), não quando você compila:

```
System.InvalidOperationException: The property 'Customer.Tags' could not be mapped, because it is of type 'HashSet<Tag>' which is not a supported primitive type or a valid entity type. Either explicitly map this property, or ignore it using the '[NotMapped]' attribute or by using 'EntityTypeBuilder.Ignore' in 'OnModelCreating'.
```

Os dois identificadores na mensagem são a única coisa que você precisa ler: a propriedade (`Customer.Tags`) e seu tipo (`HashSet<Tag>`). O EF Core está dizendo que percorreu sua entidade, encontrou este membro e não tinha nenhuma regra para armazená-lo. A última frase lista as saídas de emergência, mas não a correta, e é por isso que este erro manda tanta gente direto para o `[NotMapped]` mesmo quando os dados deveriam ser salvos.

## Por que isso acontece

O EF Core mapeia uma propriedade de exatamente uma entre três maneiras. Um escalar vira uma coluna (`int`, `string`, `decimal`, `DateTime`, `Guid`, `bool`, um `enum` e, desde o EF Core 8, também `DateOnly` e `TimeOnly` e coleções de primitivos como `List<string>`). Um tipo com uma chave detectável vira uma entidade relacionada, conectada por meio de uma chave estrangeira. E um objeto de valor sem chave vira um tipo complexo ou uma entidade própria, armazenado inline na tabela do proprietário.

Este erro significa que a propriedade não se encaixou em nenhuma das três. O tipo não é um escalar que o EF Core conhece, não tem uma chave que o EF Core consiga encontrar (então não pode ser um relacionamento), e você nunca disse ao EF Core para tratá-lo como tipo complexo ou próprio. Gatilhos comuns:

- Uma **classe ou struct personalizada** usada como objeto de valor (`Address`, `Money`, `GeoPoint`) que você nunca configurou.
- Uma **coleção de um tipo personalizado** (`List<OrderLine>`, `HashSet<Tag>`) cujo tipo de elemento não tem chave.
- Uma **coleção de enum** (`List<Status>`). Um único enum mapeia sem problema, mas antes do EF Core 8 uma coleção deles não, e uma coleção de um tipo personalizado continua não mapeando sem configuração.
- Um **dicionário ou objeto arbitrário** (`Dictionary<string, string>`, `IDictionary`, `object`, `dynamic`, `JsonElement`) que não tem representação natural em coluna.
- Um **tipo de outra biblioteca** (`NodaTime.Instant`, um primitivo de domínio) sem mapeamento de provedor embutido.

A solução nunca é adivinhar. Decida o que o dado *é* e então escolha o mapeamento que corresponde.

## Reprodução mínima

O menor programa que reproduz o erro usa um objeto de valor que parece inofensivo. `Address` não tem `Id`, então o EF Core não consegue transformá-lo em entidade relacionada, e não é um escalar, então o EF Core lança o erro:

```csharp
// .NET 11, C# 14, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
await db.Database.EnsureCreatedAsync(); // throws here while building the model

public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; } // unmapped: not scalar, no key
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

O EF Core informa `The property 'Customer.ShippingAddress' could not be mapped, because it is of type 'Address'...`. A propriedade é real, o tipo é real, mas nada no modelo diz ao EF Core como `Address` vira armazenamento.

## A solução, em detalhe

Trabalhe de cima para baixo. O primeiro mapeamento que corresponde à sua intenção é o correto.

### 1. É um objeto de valor: mapeie como tipo complexo

Se a propriedade é um objeto de valor que pertence à linha do proprietário (um endereço, um valor monetário, uma coordenada), mapeie com `ComplexProperty`. Um tipo complexo não tem identidade e é armazenado inline, que é exatamente o que um objeto de valor quer:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>()
        .ComplexProperty(c => c.ShippingAddress);
}
```

Ou marque o tipo com `[ComplexType]` para que o EF Core o detecte por convenção em todos os lugares onde ele aparece:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}
```

Isso mapeia com divisão de tabela: colunas `ShippingAddress_Street` e `ShippingAddress_City` em `Customers`, sem join, sem chave estrangeira. Tipos complexos são o substituto moderno das entidades próprias para objetos de valor, e trazem semântica de valor que as entidades próprias nunca tiveram. A história completa, incluindo quando eles ainda ficam aquém, está em [como mapear um tipo complexo em vez de uma entidade própria no EF Core 11](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Se o tipo for um `record`, leia primeiro [como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/), porque a igualdade de records interage com o rastreamento de mudanças de formas que vale a pena entender antes de publicar.

### 2. Na verdade é um escalar: converta com HasConversion

Se a propriedade é conceitualmente um único valor para o qual o EF Core não tem um mapeamento embutido, um conversor de valores o transforma em um escalar no caminho para o banco de dados e de volta na saída. Isso cobre tipos do `NodaTime`, primitivos de domínio ou um enum que você quer armazenar como seu nome em texto:

```csharp
// .NET 11, EF Core 11 - store the enum as its name, not its int
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<string>();
```

Para um tipo wrapper personalizado, forneça as duas direções explicitamente:

```csharp
// .NET 11, EF Core 11 - EmailAddress is a struct wrapping a string
modelBuilder.Entity<Customer>()
    .Property(c => c.Email)
    .HasConversion(
        email => email.Value,          // to the database column (nvarchar)
        value => new EmailAddress(value)); // back from the column
```

Um conversor de valores é a ferramenta certa quando existe um mapeamento limpo e sem perdas para uma única coluna. Se o mapeamento perde informação ou o tipo é genuinamente composto (vários campos), use um tipo complexo em vez disso. Não recorra a um conversor apenas para serializar um grafo de objetos inteiro em uma string; esse caminho vem a seguir e tem arestas mais afiadas.

### 3. É uma coleção ou um dicionário: coleções de primitivos ou uma coluna JSON

O EF Core 8 adicionou mapeamento nativo para **coleções de primitivos**, então no EF Core 11 uma `List<string>`, `int[]` ou `List<DateOnly>` mapeia automaticamente para uma coluna JSON sem configuração. Se você ainda vê o erro para uma coleção de primitivos, está no EF Core 7 ou anterior; atualizar resolve de vez.

Para uma coleção de um **tipo personalizado** ou um **dicionário**, o EF Core não consegue inferir o formato, então serialize a propriedade inteira para uma coluna JSON. No EF Core 11 a rota mais limpa para uma coleção de objetos de valor é um tipo complexo mapeado para JSON:

```csharp
// .NET 11, EF Core 11 - store the whole collection as one json document
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Tags, b => b.ToJson());
```

Para um `Dictionary<string, string>` ou outro saco de forma livre, um conversor de valores que executa `System.Text.Json` te dá o mesmo armazenamento de coluna única:

```csharp
// .NET 11, EF Core 11 - dictionary stored as a json string
modelBuilder.Entity<Customer>()
    .Property(c => c.Metadata)
    .HasConversion(
        dict => JsonSerializer.Serialize(dict, (JsonSerializerOptions?)null),
        json => JsonSerializer.Deserialize<Dictionary<string, string>>(json, (JsonSerializerOptions?)null)
                ?? new());
```

Uma coluna JSON é consultável nos provedores modernos, então você não abre mão da filtragem para obter armazenamento de coluna única. O lado das consultas, incluindo as funções SQL que entram em um documento JSON, é coberto em [como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/). Se você precisa de um formato de serialização personalizado em vez do padrão, [como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) mostra como controlar exatamente o que acaba na coluna.

### 4. Na verdade é uma entidade relacionada: dê uma chave a ela

Se a propriedade deveria ser sua própria tabela com suas próprias linhas (um `Order` referenciando registros `OrderLine` reais, não um objeto de valor inline), então é uma entidade, e o erro significa que o EF Core não conseguiu encontrar uma chave para estabelecer o relacionamento. Adicione uma chave e o EF Core conecta a chave estrangeira automaticamente:

```csharp
// .NET 11, C# 14, EF Core 11
public class OrderLine
{
    public int Id { get; set; }     // now discoverable as a key
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public List<OrderLine> Lines { get; set; } = []; // maps as a one-to-many
}
```

Se o tipo tem um identificador que não se chama `Id` nem `OrderLineId`, diga ao EF Core com `HasKey` no `OnModelCreating`. Um tipo sem chave que não tem chave natural, mas ainda precisa das próprias linhas, deve ser mapeado como coleção própria com `OwnsMany`. E se o erro que você está de fato encarando é [a entidade de tipo 'X' exige que uma chave primária seja definida](/pt-br/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/), esse é o irmão próximo: o EF Core avançou o suficiente para tratar o tipo como entidade, mas depois não encontrou nenhuma chave.

### 5. Ela nunca deve ser persistida: ignore-a

Se a propriedade é uma conveniência calculada, um cache ou uma referência de serviço que não tem nada a fazer no banco de dados, exclua-a. O atributo é o mais rápido:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    [NotMapped]
    public string DisplayName => $"{Name} (#{Id})";
}
```

Ou faça isso na configuração do modelo, o que mantém os POCOs ignorantes da persistência livres de atributos do EF Core:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Ignore(c => c.DisplayName);
```

`Ignore` é a solução correta apenas quando a resposta para "esta coluna deveria existir?" é genuinamente não. Recorrer a ele para silenciar o erro sobre dados que você pretendia salvar é a forma mais comum de este erro virar um bug silencioso de perda de dados.

## Detalhes e variantes

**Uma propriedade calculada somente leitura disparou o erro.** O EF Core tenta mapear qualquer propriedade legível, incluindo as de corpo de expressão. Se `DisplayName => ...` é derivada de outras colunas, não precisa de armazenamento; ignore-a. Se é custosa e você a quer no banco de dados, mapeie uma coluna calculada com `HasComputedColumnSql` em vez disso.

**Quebrou depois que você adicionou `required` ou mudou um tipo.** Adicionar uma propriedade de um tipo não mapeado, ou trocar um `string` por uma struct personalizada, introduz o membro não mapeado. O erro nomeia a propriedade exata; verifique o que mudou naquele tipo.

**Uma coleção de enum.** `List<Status>` lança o erro no EF Core 7 e anteriores porque coleções de enum ainda não eram coleções de primitivos. No EF Core 8 em diante mapeia para uma coluna JSON automaticamente. Se você está no meio de uma atualização, o comportamento das coleções de enum é uma entre várias mudanças de mapeamento no [guia de migração do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**O tipo vive em outro assembly e você não pode anotá-lo.** Você não pode colocar `[ComplexType]` nem `[NotMapped]` em um tipo que não é seu, mas todo atributo tem um equivalente fluente no `OnModelCreating` (`ComplexProperty`, `Property(...).HasConversion(...)`, `Ignore`). Configure a partir do seu `DbContext` e você nunca toca no tipo alheio.

**Uma navegação para um tipo abstrato ou de interface.** O EF Core não consegue mapear uma propriedade tipada como interface (`IAddress`) ou como uma base não mapeada sem um discriminador. Mapeie o tipo concreto, ou configure a herança explicitamente.

**É um filtro de `DbSet`, não uma propriedade persistida.** Se a "propriedade" é na verdade um helper que consulta outros dados, ela não pertence à entidade de forma alguma. Mova-a para um repositório ou um serviço para que o EF Core nunca a veja durante a construção do modelo.

A decisão que te mantém fora deste erro para sempre é uma única pergunta feita antes de adicionar a propriedade: o que é isto, em termos de armazenamento? Um objeto de valor vai inline como tipo complexo. Um único valor conversível recebe um `HasConversion`. Um saco de dados vira coluna JSON. Algo com identidade vira entidade relacionada com uma chave. E um helper puramente em memória é ignorado. O EF Core lança o erro precisamente porque se recusa a adivinhar qual deles você quis dizer.

## Relacionados

- [Como mapear um tipo complexo em vez de uma entidade própria no EF Core 11](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) é o mergulho fundo no mapeamento de objeto de valor para o qual este erro aponta com mais frequência.
- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cobre como armazenar e filtrar uma coleção ou documento serializado.
- [Solução: a entidade de tipo 'X' exige que uma chave primária seja definida](/pt-br/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) é o erro irmão quando o EF Core trata o tipo como entidade mas não encontra chave.
- [Como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/) importa quando seu objeto de valor é um record e o rastreamento de mudanças entra em jogo.
- [Como escrever um JsonConverter personalizado no System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) molda exatamente o que uma propriedade de conversor para JSON armazena.

## Fontes

- [Conversões de valores, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)
- [Tipos complexos, novidades do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Coleções de primitivos, novidades do EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#primitive-collections)
- [Excluir tipos ou propriedades do modelo, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/#excluding-types-from-the-model)
- [dotnet/efcore issue #15987: property could not be mapped, not a supported primitive type](https://github.com/dotnet/efcore/issues/15987)
