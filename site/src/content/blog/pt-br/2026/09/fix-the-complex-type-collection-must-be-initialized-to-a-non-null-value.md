---
title: "Correção: The complex type collection must be initialized to a non-null value"
description: "No EF Core 10.0.x, definir como null uma propriedade complexa que contém uma coleção de dois elementos dentro de uma coleção complexa ToJson quebra o DetectChanges. Corrigido no 11.0.0-rc.1."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "change-tracker"
  - "json"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/09/fix-the-complex-type-collection-must-be-initialized-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-09
---

`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.` tem duas causas que compartilham a mesma mensagem. Se o caminho na mensagem aponta para uma propriedade que você simplesmente nunca atribuiu, inicialize-a (`public List<Entry> Entries { get; set; } = new();`) e pronto. Se a propriedade está inicializada e a exceção sai de `DetectChanges` ou `SaveChanges`, você caiu no [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632): no EF Core 10.0.0 até 10.0.12, atribuir `null` a uma propriedade complexa anulável cujo tipo contém uma coleção de dois ou mais elementos, dentro de uma coleção complexa mapeada com `ToJson()`, quebra a detecção de alterações antes de qualquer SQL ser gerado. A correção já foi integrada e chega no `11.0.0-rc.1`; o backport para 10.0.x está no marco 10.0.13 e ainda não saiu.

## O erro em contexto

A mensagem vem de `CoreStrings.ComplexCollectionNotInitialized`, e vale a pena lê-la caractere por caractere, porque outras quatro mensagens desse canto do rastreador de alterações são quase idênticas:

```
System.InvalidOperationException: The complex type collection 'Root[]Group[]Item.Meta.Entries'
must be initialized to a non-null value before the elements can be accessed.
```

No caso do bug, os frames que importam vão, do mais interno para o mais externo, de `InternalComplexCollectionEntry.GetEntry` para `InternalComplexEntry.set_Ordinal`, depois `InternalComplexCollectionEntry.RemoveEntry` e por fim `ChangeDetector.DetectComplexCollectionChanges`. Se o seu stack trace contém `RemoveEntry` e `set_Ordinal`, você está diante do bug do EF, não de um null seu. Se, em vez disso, o topo da pilha é a sua própria chamada a `EntityEntry.ComplexCollection(...)`, você está diante da causa 1 abaixo.

O caminho da propriedade é uma cadeia achatada, não uma expressão C#. `[]` marca um salto através de uma coleção complexa e é seguido pelo tipo do elemento, então `Root[]Group[]Item.Meta.Entries` se lê como "a coleção `Entries` em `Meta`, que pende de um elemento `Item`, que vive dentro de um elemento `Group`, que vive em uma coleção de `Root`". Esse caminho é o jeito mais rápido de achar a propriedade problemática em um modelo profundo.

## Por que o rastreador de alterações não aceita uma coleção nula

Coleções complexas chegaram no EF Core 10, e em provedores relacionais elas [precisam ser mapeadas para uma única coluna JSON com `ToJson()`](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types). Não podem ir para uma tabela própria. Essa restrição é a razão de existir dessa mensagem: sem tabela e sem chave, o EF não consegue identificar um elemento pela chave primária como faz com uma entidade owned. Ele o identifica pela **posição na lista CLR**.

Por isso `InternalComplexCollectionEntry` mantém duas listas paralelas de entradas, uma para valores atuais e outra para valores originais, e toda entrada que ele devolve é derivada da coleção CLR que está de fato no objeto. `GetEntry` não consegue inventar uma posição em uma lista que não existe:

```csharp
// EF Core 10 and 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
if (original)
{
    if (_containingEntry.GetOriginalValue(_complexCollection) == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionEntryOriginalNull(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
else
{
    if (_containingEntry[_complexCollection] == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionNotInitialized(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
```

Dois ramos, duas mensagens diferentes. `ComplexCollectionNotInitialized` é o ramo do valor atual. Se em vez disso você recebe `The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'`, a coleção era `null` quando a linha foi materializada e você a inicializou depois.

Repare no que o `ChangeDetector` faz, porque isso explica por que uma coleção nula nem sempre explode. `DetectComplexCollectionChanges` lê os dois lados e trata uma diferença de nulidade como uma alteração, não como um erro:

```csharp
// EF Core 11, ChangeDetector.DetectComplexCollectionChanges
var currentCollection = (IList?)entry[complexProperty];
var originalCollection = (IList?)entry.GetOriginalValue(complexProperty);
var changesFound = currentCollection == null != (originalCollection == null);
```

Os dois laços de elementos são protegidos por `!= null`. Ou seja, uma coleção nula pura e simples sobrevive à detecção de alterações; ela só falha quando algo tenta alcançar um *elemento*.

## Causa 1: a propriedade de coleção é realmente null

Aqui a mensagem está fazendo o trabalho dela. Ela dispara no momento em que você indexa a entrada do rastreador de alterações para uma coleção que nunca foi atribuída:

```csharp
// .NET 10, EF Core 10.0.12. Throws ComplexCollectionNotInitialized.
public class Distributor
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Address> ShippingCenters { get; set; } = null!;  // never assigned
}

var entry = db.Entry(distributor).ComplexCollection(d => d.ShippingCenters)[0];
```

A orientação da Microsoft é direta: inicialize a coleção inline para que a propriedade nunca possa ser null.

```csharp
// .NET 10, EF Core 10.0.12. The documented shape.
public List<Address> ShippingCenters { get; set; } = new();
```

Ao contrário de uma coleção de navegação, o EF não cria a lista para você, e não há proxy de carregamento lento para disfarçar. Vale checar duas variantes da mesma causa antes de sair caçando um bug:

- **Uma propriedade de coleção anulável.** Se você declarou `List<Address>? ShippingCenters` e a coluna JSON guarda `NULL` do SQL, a materialização devolve `null` fielmente, e o primeiro acesso a um elemento falha. Ou torne a propriedade não anulável e preencha a coluna com `'[]'`, ou verifique o null antes de tocar no rastreador de alterações.
- **Uma propriedade complexa anulável no caminho.** Em `Root[]Group[]Item.Meta.Entries`, `Entries` pode muito bem estar inicializada em todo `Meta` que você constrói, mas se o próprio `Meta` for `null` não existe `Entries` para ler. Esse é exatamente o formato do bug do EF descrito abaixo, e também um formato que você mesmo pode produzir ao indexar o rastreador em um item cujo `Meta` você acabou de limpar.

Se esse estilo de mapeamento é novo para você, [tipos complexos versus entidades owned no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explica por que tipos complexos se comportam de forma diferente dos grafos de entidades owned dos quais a maioria está migrando, e o [guia de mapeamento passo a passo](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) cobre a configuração em si.

## Causa 2: dotnet/efcore#38632, o caminho de reindexação

O caso interessante é aquele em que todas as coleções do seu modelo estão inicializadas e a exceção mesmo assim sai de `SaveChangesAsync`. Quatro condições precisam se alinhar, e elas são comuns o bastante em um modelo real para que as pessoas caiam nisso sem fazer nada de estranho.

```csharp
// .NET 10, EF Core 10.0.12. Complex types are never discovered by convention,
// so every value type here carries [ComplexType].
public class Root
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Group> Groups { get; set; } = new();
}

[ComplexType]
public class Group
{
    public required string Title { get; set; }
    public List<Item> Items { get; set; } = new();
}

[ComplexType]
public class Item
{
    public required string Sku { get; set; }
    public Meta? Meta { get; set; }               // nullable complex property
}

[ComplexType]
public class Meta
{
    public required string Kind { get; set; }     // optional complex types need one required property
    public List<Entry> Entries { get; set; } = new();
}

[ComplexType]
public class Entry
{
    public required string Key { get; set; }
    public string? Value { get; set; }
}
```

```csharp
// .NET 10, EF Core 10.0.12. On relational providers a complex collection must be JSON.
modelBuilder.Entity<Root>()
    .ComplexCollection(r => r.Groups, g => g.ToJson());
```

E a mutação, que é mais ou menos o carregar-alterar-salvar mais banal possível:

```csharp
// .NET 10, EF Core 10.0.12. Throws inside DetectChanges, before any SQL is sent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);

var item = root.Groups[0].Items[0];
// item.Meta.Entries came back from the JSON column with two elements.
item.Meta = null;

await db.SaveChangesAsync();
```

Definir `Meta` como null remove a entrada complexa que a contém. A remoção dispara uma reindexação das entradas que vinham depois, e essa reindexação atribui `Ordinal` em cada entrada sobrevivente, o que volta para `GetEntry` em `Meta.Entries`. A essa altura `Meta` já é `null`, então o ramo de valor atual mostrado acima lança a exceção. Com um elemento ou nenhum em `Entries` não há nada a reindexar e o mesmo código salva sem problema, o que é a razão de o bug parecer tão arbitrário visto de fora.

Quem reportou viu o problema no 10.0.9 e no 10.0.10, um comentarista reconfirmou no 10.0.11 em 2026-08-15, e a issue continua aberta contra o 10.0.12, o patch estável atual. É independente de provedor, confirmado tanto no Npgsql quanto no SQLite, porque a falha fica no rastreador de alterações compartilhado, acima da abstração de provedor. Só subir a versão do provedor não resolve.

## Correção, em detalhe

### Vá para o EF Core 11 RC1

O [PR #38667](https://github.com/dotnet/efcore/pull/38667) foi integrado na `main` em 2026-07-20 com o marco 11.0-rc1, então a correção já está hoje nos pacotes `11.0.0-rc.1.26425.128`. A mudança é uma reordenação, não lógica nova: as entradas rastreadas agora são devolvidas antes da checagem de null da coleção CLR, de modo que a reindexação durante a limpeza funciona mesmo quando o valor complexo pai já virou `null`.

```csharp
// EF Core 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
// Must check tracked entries first to allow reindexing during cleanup when the parent is null.
var existingEntries = original ? _originalEntries : _entries;
if (existingEntries != null
    && (uint)ordinal < (uint)existingEntries.Count
    && existingEntries[ordinal] is { } existingEntry)
{
    return existingEntry;
}
```

```xml
<!-- .NET 10 or .NET 11. Bump the provider package to a matching 11.0.0-rc.1 too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="11.0.0-rc.1.26425.128" />
```

O EF Core 11 fica estável junto com o .NET 11 em novembro de 2026, então essa é uma janela curta de versão prévia, não algo indefinido. Ainda assim é uma versão prévia, então leia o resto das notas de versão do EF Core 11 antes de levar para produção.

### Acompanhe o 10.0.13 se você precisa de uma versão de servicing

A issue foi reaberta depois da correção na `main` justamente para acompanhar o backport para `release/10.0`, e carrega o marco 10.0.13. Se você está em uma faixa de servicing suportada e não pode usar uma versão prévia, essa é a versão a monitorar. Até lá, atualizar dentro do 10.0.x não resolve.

### Divida a mutação em dois SaveChanges

O gatilho precisa de dois ou mais elementos na coleção aninhada no momento em que o pai vira null. Encolher a coleção em um salvamento próprio, de forma que tanto o snapshot atual quanto o original estejam vazios antes de anular o pai, evita a reindexação por completo:

```csharp
// .NET 10, EF Core 10.0.12. Two round trips, no reindex over a null parent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);
var item = root.Groups[0].Items[0];

item.Meta!.Entries.Clear();
await db.SaveChangesAsync();   // original values are accepted here

item.Meta = null;
await db.SaveChangesAsync();
```

Isso é a lista mínima de gatilhos de quem reportou o bug virada do avesso, não uma garantia da equipe do EF, e custa uma ida extra ao banco de dados e a atomicidade de um único salvamento. Envolva as duas chamadas em uma transação explícita se o estado intermediário não for algo que você queira que outro leitor veja, e confirme contra o seu próprio modelo antes de depender disso.

### Escreva a coluna JSON sem o rastreador de alterações

A falha vive inteiramente na detecção de alterações, e o `ExecuteUpdateAsync` nunca chega perto dela. O EF Core 10 consegue mirar diretamente uma coleção complexa mapeada para JSON:

```csharp
// .NET 10, EF Core 10.0.12. Untracked read, then a set-based write.
var groups = await db.Roots
    .AsNoTracking()
    .Where(r => r.Id == id)
    .Select(r => r.Groups)
    .SingleAsync();

groups[0].Items[0].Meta = null;

await db.Roots
    .Where(r => r.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(r => r.Groups, groups));
```

Você abre mão das garantias usuais do `SaveChanges` nessa escrita: sem checagem de concorrência otimista, sem interceptadores de `SaveChanges`, e o documento JSON inteiro é reescrito em vez de apenas o caminho alterado. Se você vai recorrer a esse padrão de forma mais ampla, os compromissos estão analisados em [ExecuteUpdate versus carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

## Mensagens parecidas que caem nesta página

Outras quatro strings em `CoreStrings` mencionam coleções complexas e valores nulos, e não têm nada a ver com a #38632.

**`The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'.`** Essa é a `ComplexCollectionEntryOriginalNull`, o ramo irmão do mesmo `if`. A coleção era `null` quando a linha foi materializada. Ler valores originais de uma coleção que nunca os teve não é um bug, é uma pergunta sem resposta. Recarregue a entidade ou pare de ler valores originais nesse caminho.

**`The value for the property '...' cannot be set, because it's on the complex type collection element '...[N]' that contains a 'null' value.`** Essa é a `ComplexCollectionNullElementSetter`. A coleção existe, mas um dos seus *elementos* é `null`. Um array JSON como `[{...}, null]` provoca isso. Filtre os nulos antes de salvar, ou pare de escrevê-los no array.

**`Complex entry original ordinal '-1' is invalid for property '...' as it's outside of the collection of length 'N'.`** Um bug diferente com uma correção diferente, tratado em [Complex entry original ordinal '-1' is invalid ao salvar uma coleção complexa ToJson](/pt-br/2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection/). Repare na redação: *original ordinal*, e *for property*. Aquele foi corrigido no 10.0.10, então, ao contrário deste, atualizar dentro do 10.0.x resolve.

**`The complex type collection '...' cannot be configured because complex value type collections are not supported.`** Essa é a `ComplexValueTypeCollection`, lançada na construção do modelo, não ao salvar. Elementos de uma coleção complexa precisam ser tipos de referência; uma `List<Coordinate>` em que `Coordinate` é um `readonly record struct` não mapeia. Acompanhe a [dotnet/efcore#31411](https://github.com/dotnet/efcore/issues/31411) se você precisa disso.

Se o seu erro menciona `AS JSON option can be specified only for column of nvarchar(max)`, isso é um problema de tipo de coluna do SQL Server e não do rastreador de alterações, e está tratado à parte em [a correção do AS JSON no Azure SQL](/pt-br/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/). Para a história geral de mapeamento, [como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) é o ponto de partida.

## Fontes

- [dotnet/efcore#38632: ComplexCollection + ToJson(): DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [dotnet/efcore#38667: a correção, integrada em 2026-07-20](https://github.com/dotnet/efcore/pull/38667)
- [Tipos complexos, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [Versões e planejamento do EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
- [ChangeDetector.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/ChangeDetector.cs)
- [CoreStrings.resx, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx)
