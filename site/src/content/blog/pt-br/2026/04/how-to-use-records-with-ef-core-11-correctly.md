---
title: "Como usar records com EF Core 11 corretamente"
description: "Um guia prático para misturar records do C# e EF Core 11. Onde records se encaixam, onde eles quebram o change tracking, e como modelar value objects, entidades e projeções sem brigar com o framework."
pubDate: 2026-04-21
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "records"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/04/how-to-use-records-with-ef-core-11-correctly"
translatedBy: "claude"
translationDate: 2026-04-24
---

Resposta curta: no EF Core 11 e C# 14, use tipos `record class` para projeções, DTOs e tipos complexos (value objects), e prefira uma `class` simples com propriedades `init`-only e um construtor de binding para entidades rastreadas. `record struct` está ok como tipo complexo, mas nunca como entidade rastreada. A fricção que as pessoas batem quase sempre vem de tentar usar records posicionais como entidades completas e depois se surpreender quando expressões `with`, igualdade por valor ou chaves primárias somente leitura colidem com o rastreamento de identidade do EF Core. O conserto não é uma configuração, é saber qual formato de record vai em qual cadeira.

Este post cobre as três cadeiras (entidade, tipo complexo, projeção), mostra as regras de binding de construtor que de fato vêm no EF Core 11, e percorre as pegadinhas específicas que tropeçam as pessoas: chaves geradas pelo banco, a expressão `with`, propriedades de navegação, armadilhas de igualdade por valor e records mapeados em JSON.

## Por que records e EF Core têm fama de brigar

Os records do C# foram desenhados para tornar fácil tipos de dados imutáveis e com igualdade por valor. Duas instâncias de um `record Address(string City, string Zip)` são iguais quando seus campos são iguais, não quando são a mesma referência. Essa é exatamente a semântica certa para um value object.

O change tracker do EF Core é construído sobre a suposição oposta. O [ChangeTracker](https://learn.microsoft.com/en-us/ef/core/change-tracking/) guarda um snapshot dos valores das propriedades de cada entidade quando a entidade é anexada pela primeira vez, e a [identity resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution) diz que dentro de um único `DbContext` há exatamente uma instância CLR por chave primária. Ambos dependem de identidade por referência, não de identidade por valor. Se você carimba um `record` com uma chave primária e depois muta produzindo uma nova instância via `with`, agora você tem duas referências CLR que comparam iguais mas não são a mesma entidade rastreada. O change tracker ou lança porque a PK já está rastreada, ou silenciosamente ignora suas edições.

A documentação oficial do C# diz há anos que "tipos record não são apropriados para uso como entity types em Entity Framework Core". Esse aviso é um resumo direto da situação acima, não uma proibição absoluta. Você pode usar records como entidades, e o EF Core 11 ainda suporta todos os mecanismos necessários para isso. Você só precisa escolher o formato não posicional, init-only, e jogar pelas regras de binding de construtor em [a documentação de construtores do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/constructors).

## Cadeira 1: records como tipos complexos (o sweet spot)

O EF Core 8 introduziu `ComplexProperty`, e o EF Core 11 deixou os tipos complexos estáveis o suficiente para recomendá-los como substituto padrão de owned entities na maioria dos casos. Tipos complexos são exatamente onde records brilham: um tipo complexo não tem identidade própria, sua igualdade por valor bate com a semântica do banco, e ele é feito para ser substituído por inteiro quando qualquer campo muda.

```csharp
// .NET 11, C# 14, EF Core 11
public record Address(string Street, string City, string PostalCode);

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Address ShippingAddress { get; set; } = new("", "", "");
    public Address BillingAddress { get; set; } = new("", "", "");
}

// OnModelCreating
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress);
    b.ComplexProperty(c => c.BillingAddress);
});
```

O que faz isso funcionar:

- `Address` é um `record class` posicional. O EF Core mapeia records posicionais out of the box para tipos complexos porque o construtor primário bate com os nomes das propriedades um para um.
- `Address` não precisa da própria chave primária, porque tipos complexos não têm identidade.
- Substituir o `ShippingAddress` de um cliente com `customer.ShippingAddress = customer.ShippingAddress with { City = "Cluj" };` atualiza a entidade rastreada como você espera. O EF Core vê o snapshot do `Customer` divergir dos valores anteriores e marca as três colunas mapeadas como dirty.

Se precisa de um tipo por valor, um `record struct` também é válido para uma propriedade complexa e evita a alocação extra no heap por linha. O trade-off é o de sempre: conjuntos grandes de campos doem na cópia, e você perde a possibilidade de adicionar um construtor sem parâmetros para as convenções do EF sem se desviar do caminho.

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency);
```

Use `record struct` para valores pequenos, de formato fixo (dinheiro, coordenadas, intervalos de data). Use `record class` para todo o resto.

## Cadeira 2: records como entidades (funciona, mas precisa de disciplina)

Se você quer uma entidade com aparência imutável, o formato que sobrevive ao change tracking é um `record class` com propriedades **não posicionais** init-only e um construtor de binding que o EF Core consiga chamar durante a materialização.

```csharp
// .NET 11, C# 14, EF Core 11
public record class BlogPost
{
    // EF binds to this ctor during materialization
    public BlogPost(int id, string title, DateTime publishedAt)
    {
        Id = id;
        Title = title;
        PublishedAt = publishedAt;
    }

    // Parameterless ctor lets EF (and serializers) create instances
    // before setting properties one at a time when needed.
    private BlogPost() { }

    public int Id { get; init; }
    public string Title { get; init; } = "";
    public DateTime PublishedAt { get; init; }

    // Navigation props cannot be bound via constructor.
    public List<Comment> Comments { get; init; } = new();
}
```

As regras de [a documentação de binding de construtor](https://learn.microsoft.com/en-us/ef/core/modeling/constructors), aplicadas a records:

1. Se o EF Core encontra um construtor cujos nomes e tipos de parâmetros batem com propriedades mapeadas, ele usa esse construtor durante a materialização. Propriedades em Pascal-case podem bater com parâmetros em camel-case.
2. Propriedades de navegação (coleções, referências) não podem ser ligadas via construtor. Mantenha-as fora do construtor primário e inicialize com um default.
3. Propriedades sem qualquer setter não são mapeadas por convenção. `init` conta como setter, então propriedades init-only são mapeadas. Uma propriedade declarada como `public string Title { get; }` sem setter algum é tratada como propriedade computada e ignorada.
4. Chaves geradas pelo banco precisam de uma chave gravável. `init` é gravável em tempo de inicialização do objeto, que é exatamente quando o EF Core seta o valor lido do banco, então `int Id { get; init; }` funciona para colunas de identidade geradas pelo banco.

Por que não usar um record posicional para a entidade em si? Duas razões.

Primeiro, um record posicional tem um **conjunto de propriedades implícito gerado pelo compilador** com setters `init`, mas também tem um método `<Clone>$` protegido e um construtor de cópia que expressões `with` usam. No momento em que você chama `post with { Title = "New title" }`, você ganha uma nova instância de `BlogPost` que tem a mesma chave primária da rastreada. Se você tenta `context.Update(newPost)` vai bater em `InvalidOperationException: The instance of entity type 'BlogPost' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked.` A identity resolution está fazendo o trabalho dela; você deu duas referências para o que ela acha que é a mesma linha.

Segundo, records posicionais geram `Equals` e `GetHashCode` baseados em valor. O change tracker do EF Core, o relationship fixup e `DbSet.Find` se apoiam em identidade por referência. Igualdade por valor não quebra isso de cara, mas cria comportamentos surpreendentes: duas entidades recém carregadas de queries diferentes podem ter hash igual sendo instâncias rastreadas diferentes, e `HashSet<BlogPost>` as colapsa. Mantenha igualdade por valor longe de qualquer coisa que tenha identidade.

Um record class com propriedades explícitas, como acima, evita as duas armadilhas. Você ganha a imutabilidade e o `ToString` legal, e abre mão da mutação baseada em `with` (que era o recurso que você não queria em uma entidade rastreada de qualquer jeito).

### Atualizando uma entidade no estilo imutável

Como a entidade é "imutável", o caminho de update não pode ser "mutar, depois SaveChanges". Os dois padrões viáveis no EF Core 11:

```csharp
// .NET 11, EF Core 11
// Pattern A: load, assign to a local with init setters cleared.
// Requires exposing init setters on the class.
var post = await db.BlogPosts.SingleAsync(p => p.Id == id);

// This mutates the tracked instance. Works because 'init' is
// a settable accessor from EF Core's point of view, and nothing
// stops you from assigning through reflection or source-gen.
// If you want real immutability, use Pattern B.
db.Entry(post).Property(p => p.Title).CurrentValue = "New title";
await db.SaveChangesAsync();

// Pattern B: detach the old, attach a freshly-constructed one,
// mark the touched columns modified. No 'with' expression.
var updated = new BlogPost(post.Id, "New title", post.PublishedAt);
db.Entry(post).State = EntityState.Detached;
db.Attach(updated);
db.Entry(updated).Property(p => p.Title).IsModified = true;
await db.SaveChangesAsync();
```

O Padrão A é onde a maioria dos times termina: usam records pelo `ToString` ergonômico, pela desestruturação e pela igualdade por campo nas leituras, e aceitam que o caminho de escrita passa pelo change tracker mutando as propriedades init via metadata do EF Core. Isso não é violação de imutabilidade no nível da linguagem, é só como o EF Core faz binding de propriedades. Existe uma issue de longa data no EF Core rastreando suporte de primeira classe para updates imutáveis ([efcore#11457](https://github.com/dotnet/efcore/issues/11457)) se você quiser a história completa.

## Cadeira 3: records como projeções e DTOs (sempre seguro)

Sempre que um record é materializado fora do change tracker, nenhum dos problemas acima se aplica. Projeções de records são o padrão mais entediante e mais útil:

```csharp
// .NET 11, C# 14, EF Core 11
public record PostSummary(int Id, string Title, DateTime PublishedAt);

// No tracking, no identity, no ChangeTracker snapshot.
var summaries = await db.BlogPosts
    .AsNoTracking()
    .Select(p => new PostSummary(p.Id, p.Title, p.PublishedAt))
    .ToListAsync();
```

O pipeline de queries do EF Core 11 faz binding alegre em records posicionais nas projeções. Você pode mandá-los direto pra fora de uma web API com `System.Text.Json`, que suporta serialização de records desde o .NET 5 e desserialização de records posicionais desde o .NET 7.

O mesmo argumento se aplica a DTOs de entrada em comandos: aceite um record posicional do controller, valide, mapeie para o formato de entidade acima, e deixe o EF Core rastrear a entidade. Manter o tipo de fio (record) separado do tipo de persistência (class com init) elimina a categoria inteira de bugs sobre a qual este post é.

Para mais sobre records como formatos de retorno, veja a [matriz de decisão no fim do post sobre múltiplos valores](/pt-br/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/).

## Chaves geradas pelo banco e propriedades init-only

Esse é o lugar mais comum onde as pessoas travam. Se `Id` é declarado como `public int Id { get; }` sem setter, o EF Core não vai mapear, e migrations vão reclamar de chave faltando. Se for `public int Id { get; init; }`, ele é mapeado e gravável durante a inicialização do objeto, que é exatamente quando o EF Core seta o valor que leu do banco.

Para inserts, o EF Core também precisa escrever o valor gerado de volta na entidade depois de `SaveChanges`. Ele faz isso pelo setter da propriedade, que para propriedades init-only ainda funciona porque o EF Core usa metadata de acesso de propriedade em vez da sintaxe pública do C#. Confirmado a partir do EF Core 11; isso é estável desde o EF Core 5.

O que não funciona: `public int Id { get; } = GetNextId();` com inicializador de campo e sem setter. O EF Core não vê setter, não mapeia a propriedade, e você ganha ou um erro de build de chave faltando ou uma shadow key não intencional.

## A expressão `with` é uma arma apontada para o pé em entidades rastreadas

Quando a entidade é um `record` (posicional ou não) com cópia gerada pelo construtor primário, `with` produz um clone que compara igual ao original mas é uma referência CLR diferente. O EF Core trata como "mesma chave, instância diferente", que dispara a identity resolution. A regra segura:

```csharp
// .NET 11, EF Core 11
// BAD: creates a second instance with the same PK.
var edited = post with { Title = "New" };
db.Update(edited); // throws InvalidOperationException on SaveChanges

// GOOD: mutate the tracked instance.
post.Title = "New"; // via init (within EF) or a regular setter
await db.SaveChangesAsync();
```

Se você genuinamente quer semântica de "destacar, clonar, reanexar", primeiro passe por `db.Entry(post).State = EntityState.Detached;`, depois anexe o clone e marque propriedades como `IsModified`. Na maioria das vezes você não quer isso. Você quer o Padrão A da seção anterior.

Tipos complexos não têm esse problema. Um `with` em um `Address` dentro de um `Customer` produz um novo valor, você atribui de volta a `customer.ShippingAddress`, e o EF Core compara campo por campo contra o snapshot. Esse é o ponto inteiro de tipos complexos.

## Igualdade por valor vs identidade em caminhos quentes

Se você insiste em uma entidade record posicional, lembre que igualdade por valor vaza para toda coleção apoiada em `GetHashCode`. Um `HashSet<BlogPost>` vai colapsar duas "entidades diferentes com os mesmos dados". Um dicionário com chave na entidade vai se comportar de forma imprevisível se duas PKs diferentes contiverem o mesmo payload. O workaround padrão é sobrescrever `Equals` e `GetHashCode` no record para chavear apenas pela chave primária, o que anula a razão inteira de você ter escolhido um record para começo.

O change tracker em si, a partir do EF Core 11, ainda usa identidade por referência internamente. Você pode conferir [a fonte do change-tracking](https://github.com/dotnet/efcore) para os detalhes, mas a versão curta é: o EF Core não "funde" duas entidades acidentalmente só porque são iguais por valor. Mas sim expõe essa fusão via `DbSet.Find`, `FirstOrDefault` em uma query rastreada, e relationship fixup, que é por isso que times ainda veem comportamentos estranhos que não conseguem explicar de cara.

De novo, o conserto não é discutir com o runtime. É manter igualdade por valor em tipos por valor (tipos complexos, DTOs) e deixar tipos de entidade com igualdade por referência padrão.

## Colunas JSON e records

O EF Core 7 adicionou mapeamento de colunas JSON, e o EF Core 11 estende mais com [tradução de JSON_CONTAINS no SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) e tipos complexos dentro de documentos JSON. Records posicionais são um encaixe ergonômico para tipos JSON owned:

```csharp
// .NET 11, C# 14, EF Core 11
public record TagSet(List<string> Tags, DateTime UpdatedAt);

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public TagSet Metadata { get; set; } = new(new(), DateTime.UtcNow);
}

// OnModelCreating
modelBuilder.Entity<Article>()
    .OwnsOne(a => a.Metadata, b => b.ToJson());
```

O record é uma propriedade complexa armazenada como JSON. Você substitui inteiro via `article.Metadata = article.Metadata with { Tags = [..article.Metadata.Tags, "net11"] };` e o EF Core serializa toda a subárvore no `SaveChanges`. Sem rastreamento de identidade, sem debate `with` vs mutação.

## Juntando tudo

Um domínio realista, ponta a ponta:

```csharp
// .NET 11, C# 14, EF Core 11
// Complex types (records)
public record Address(string Street, string City, string PostalCode);
public readonly record struct Money(decimal Amount, string Currency);

// Entity (class with init-only properties + binding ctor)
public class Order
{
    public Order(int id, string customerName, Money total, Address shipTo)
    {
        Id = id;
        CustomerName = customerName;
        Total = total;
        ShipTo = shipTo;
    }

    private Order() { } // EF fallback

    public int Id { get; init; }
    public string CustomerName { get; init; } = "";
    public Money Total { get; init; }
    public Address ShipTo { get; init; } = new("", "", "");

    public List<OrderLine> Lines { get; init; } = new();
}

// Projection/DTO (positional record)
public record OrderSummary(int Id, string CustomerName, decimal Total);

// Input command (positional record, validated before mapping)
public record CreateOrder(string CustomerName, Money Total, Address ShipTo);
```

Essa é a regra geral inteira: classes para coisas com identidade, records para coisas definidas pelos seus dados. O binding de construtor do EF Core 11, o mapeamento de tipo complexo e o mapeamento JSON suportam essa divisão sem configuração extra além de `ComplexProperty` ou `OwnsOne(..ToJson())` quando aplicável.

## Leituras relacionadas

- [EF Core 11 adiciona GetEntriesForState para pular DetectChanges](/2026/04/efcore-11-changetracker-getentriesforstate/) cobre os internals do change tracker em que este post se apoia.
- [EF Core 11 poda joins de referência desnecessários em split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) é um bom companheiro se suas entidades dependem muito de navigations.
- [EF Core 11 traduz Contains para JSON_CONTAINS no SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) se conecta com o padrão de record mapeado em JSON acima.
- [Como retornar múltiplos valores de um método em C# 14](/pt-br/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) aprofunda em quando records vencem sobre tuplas e classes no nível de retorno de método.

## Fontes

- [Construtores e property binding do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/constructors)
- [Visão geral do change tracking do EF Core](https://learn.microsoft.com/en-us/ef/core/change-tracking/)
- [Identity resolution do EF Core](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution)
- [Novidades do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Referência de tipos record do C#](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records)
- [Suporte a updates de entidade imutáveis (efcore#11457)](https://github.com/dotnet/efcore/issues/11457)
- [Documentar tipos record como entidades (EntityFramework.Docs#4438)](https://github.com/dotnet/EntityFramework.Docs/issues/4438)
