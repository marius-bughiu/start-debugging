---
title: "Correção: Complex entry original ordinal '-1' is invalid ao salvar uma coleção complexa com ToJson"
description: "Atualize o Microsoft.EntityFrameworkCore para 10.0.10 ou posterior. Antes disso, fazer uma coleção aninhada crescer sob uma segunda propriedade complexa com ToJson quebrava o SaveChanges."
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
translationOf: "2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection"
translatedBy: "claude"
translationDate: 2026-09-09
---

Atualize o `Microsoft.EntityFrameworkCore` para 10.0.10 ou posterior. Entre 10.0.0 e 10.0.9, se uma entidade mapeava duas ou mais propriedades complexas com `ToJson()` e uma coleção aninhada dentro de uma delas ganhava um elemento entre a carga e o salvamento, o rastreador de mudanças forçava todas as entradas complexas achatadas para `Modified` ou `Unchanged`, incluindo as que estavam legitimamente em `Added`. Um elemento `Added` tem ordinal original `-1` por design, então a transição de estado batia direto em `ValidateOrdinal` e lançava a exceção. A correção é uma guarda de uma linha em `InternalEntryBase`, é independente de provedor, e não há nenhuma configuração que você precise mudar depois de atualizar.

## O erro em contexto

A exceção aparece a partir de `SaveChanges` ou `SaveChangesAsync`, antes de qualquer SQL ser enviado:

```
System.InvalidOperationException: Complex entry original ordinal '-1' is invalid for property
'XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner' as it's outside of the collection
of length '1'.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.
      InternalComplexCollectionEntry.ValidateOrdinal(InternalComplexEntry entry, Boolean original)
```

O caminho da propriedade na mensagem é uma cadeia achatada, não uma expressão C#. `[]` marca um salto por uma coleção complexa, então `XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner` se lê como "a coleção `Inner` de `XInnerEntry`, que vive dentro de um elemento `XDeepItem`, que vive dentro de um elemento `XMiddleData`, que pende de `XDeepData` em `XWidget`". Esse caminho é a sua rota mais rápida até a propriedade problemática.

Dois detalhes merecem uma conferida antes de seguir, porque distinguem este erro dos parecidos. Primeiro, a mensagem diz **original ordinal** e **for property**. A mensagem irmã diz **ordinal** e **for the collection**, e tem outra causa raiz. Segundo, a contagem no final é o tamanho da coleção *original*, aquela que o EF carregou do banco de dados, não o tamanho da coleção que você está tentando salvar.

## Por que o ordinal é -1: o que o EF Core realmente rastreia em uma coleção complexa

Coleções complexas chegaram no EF Core 10 e, em provedores relacionais, precisam ser mapeadas para uma única coluna JSON com `ToJson()`. Elas não podem ir para uma tabela separada. Essa restrição importa aqui: como não existe tabela nem chave, o EF não consegue identificar um elemento pela chave primária como faz com uma entidade owned. Ele identifica pelo **posição no array**.

Por isso o rastreador de mudanças guarda duas posições por elemento, em `InternalComplexEntry`:

```csharp
// EF Core 10.0 / 11.0, src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs
public int Ordinal
{
    // -1 is used to indicate that the entry is deleted
    get;
    set { /* ... */ }
}

public int OriginalOrdinal
{
    // -1 is used to indicate that the entry is added
    get;
    set { /* ... */ }
}
```

`Ordinal` é onde o elemento está na coleção que você está prestes a salvar. `OriginalOrdinal` é onde ele estava na coleção que o EF materializou. Os dois valores sentinela contam a história inteira:

- Um elemento que você **removeu** não tem posição na coleção atual, então o `Ordinal` dele é `-1`.
- Um elemento que você **adicionou** não tem posição na coleção original, então o `OriginalOrdinal` dele é `-1`.

Toda transição de estado para um estado rastreado passa o ordinal correspondente por uma verificação de limites:

```csharp
// EF Core 10.0, InternalEntryBase.InternalComplexCollectionEntry.ValidateOrdinal
public readonly int ValidateOrdinal(InternalComplexEntry entry, bool original, List<InternalComplexEntry?> entries)
{
    var ordinal = original ? entry.OriginalOrdinal : entry.Ordinal;
    if (ordinal < 0 || ordinal >= entries.Count)
    {
        var property = entry.ComplexProperty;
        throw new InvalidOperationException(
            original
                ? CoreStrings.ComplexCollectionEntryOriginalOrdinalInvalid(/* ... */)
                : CoreStrings.ComplexCollectionEntryOrdinalInvalid(/* ... */));
    }
    // ...
}
```

Essa verificação está correta isoladamente. `-1` realmente está fora dos limites. O bug era que algo mais acima pedia a uma entrada `Added` que virasse `Modified`, e `Added -> Modified` é exatamente a transição que valida o ordinal original. Uma entrada que deveria ter `OriginalOrdinal == -1` era empurrada por um caminho de código que proíbe isso.

O chamador acima era `SetComplexCollectionModified`. Quando a detecção de mudanças concluía que uma coleção complexa havia mudado, ela percorria `GetFlattenedComplexEntries()`, que devolve todas as entradas complexas do grafo aninhado inteiro da entidade, e colocava cada uma em `Modified` ou `Unchanged`. Os elementos recém-adicionados eram arrastados junto com o resto.

## Reprodução mínima: duas propriedades complexas JSON e uma coleção aninhada que cresce

Quem reportou a [dotnet/efcore#38299](https://github.com/dotnet/efcore/issues/38299) reduziu o gatilho a quatro condições que precisam valer ao mesmo tempo:

1. A entidade mapeia duas ou mais propriedades complexas com `ToJson()`.
2. Um desses documentos JSON contém objetos aninhados que por sua vez têm coleções.
3. O tipo de elemento de uma coleção aninhada declara duas ou mais propriedades de subcoleção `List<T>`.
4. Uma dessas subcoleções cresce entre a carga e o salvamento.

Se faltar qualquer uma delas, a entidade salva sem problema, e é por isso que isso parece intermitente em uma base de código real. Este é o menor modelo que satisfaz as quatro:

```csharp
// .NET 10, EF Core 10.0.7, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.1
public class Widget
{
    public int Id { get; set; }
    public required FlatData Flat { get; set; }   // JSON column 1
    public required DeepData Deep { get; set; }   // JSON column 2
}

public class FlatData
{
    public string? Note { get; set; }
}

public class DeepData
{
    public List<MiddleData> Middle { get; set; } = [];
}

public class MiddleData
{
    public string Name { get; set; } = "";
    public List<InnerEntry> Inner { get; set; } = [];   // sub-collection 1
    public List<InnerEntry> Extra { get; set; } = [];   // sub-collection 2
}

public class InnerEntry
{
    public string Value { get; set; } = "";
}
```

O mapeamento usa `ComplexProperty` para as duas raízes e `ComplexCollection` para tudo que é aninhado. `ToJson()` na raiz já basta; as coleções aninhadas herdam o mapeamento JSON:

```csharp
// .NET 10, EF Core 10.0.7
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Widget>(b =>
    {
        b.ComplexProperty(w => w.Flat, c => c.ToJson());

        b.ComplexProperty(w => w.Deep, c =>
        {
            c.ToJson();
            c.ComplexCollection(d => d.Middle, m =>
            {
                m.ComplexCollection(x => x.Inner);
                m.ComplexCollection(x => x.Extra);
            });
        });
    });
}
```

E as duas linhas que explodem:

```csharp
// .NET 10, EF Core 10.0.7. Throws on SaveChangesAsync, before any SQL is generated.
var widget = await db.Widgets.SingleAsync(w => w.Id == 1);
widget.Deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });
await db.SaveChangesAsync();
```

Nada aqui é exótico. É exatamente o formato em que você cai assim que segue o conselho da própria Microsoft e move um grafo de entidades owned mapeado em JSON para tipos complexos, e é por isso que os relatos se concentram em times fazendo essa migração. Se você está avaliando essa mudança, [tipos complexos versus entidades owned no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) cobre as trocas, e o [guia de mapeamento passo a passo](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) cobre a configuração.

## Correção, em detalhe

### Atualize para o EF Core 10.0.10 ou posterior

Esta é a correção de verdade, publicada no [PR #38373](https://github.com/dotnet/efcore/pull/38373) contra `release/10.0`. Suba todos os pacotes do EF Core em conjunto, incluindo o provedor:

```xml
<!-- .NET 10. Bump the provider package to a matching 10.0.x too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.12" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.12" />
```

A mudança ensina o percurso recursivo a deixar as entradas `Added` em paz:

```csharp
// EF Core 10.0.10+, InternalEntryBase.SetComplexCollectionModified
if (recurse)
{
    var newElementState = isModified ? EntityState.Modified : EntityState.Unchanged;
    foreach (var complexEntry in GetFlattenedComplexEntries())
    {
        // Added elements represent pending additions with no original ordinal, so forcing them to
        // Modified/Unchanged is incorrect and would fail the original ordinal validation. Leave their
        // state (computed by change detection) untouched, mirroring the bulk state-change logic in
        // InternalComplexCollectionEntry.SetState.
        if (!UseOldBehavior38299
            && complexEntry.EntityState is EntityState.Added)
        {
            continue;
        }

        complexEntry.SetEntityState(newElementState, modifyProperties: true);
    }
}
```

Duas coisas decorrem da leitura do patch. A guarda fica no rastreador de mudanças compartilhado, acima da abstração de provedor, então corrige SQL Server, Npgsql e SQLite de uma só vez; se você esperava que subir só o provedor ajudasse, não vai ajudar. E a mesma guarda está presente na base de código do EF Core 11 sem a flag `UseOldBehavior38299`, então atualizar para o EF Core 11 também resolve.

### Se você está preso abaixo de 10.0.10, escreva a coluna JSON sem o rastreador de mudanças

A falha vive inteiramente no rastreamento de mudanças. `ExecuteUpdateAsync` nunca chega perto dele, e o EF Core 10 consegue mirar diretamente uma propriedade complexa mapeada em JSON:

```csharp
// .NET 10, EF Core 10.0.7. Untracked read, then a set-based write.
var deep = await db.Widgets
    .AsNoTracking()
    .Where(w => w.Id == id)
    .Select(w => w.Deep)
    .SingleAsync();

deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });

await db.Widgets
    .Where(w => w.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(w => w.Deep, deep));
```

Em troca você perde as garantias usuais do `SaveChanges`: sem verificação de token de concorrência otimista, sem interceptors sobre a escrita, e o documento JSON inteiro é reescrito em vez de apenas o caminho alterado. Verifique a tradução contra o seu provedor antes de se comprometer com isso, e se você está recorrendo ao `ExecuteUpdate` de forma mais ampla, as trocas estão trabalhadas em [ExecuteUpdate versus carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

### Se você pode mudar o modelo, quebre uma das quatro condições

A condição 1 é a mais barata de remover. O percurso só produz o par ruim de `Added` com `-1` quando a entidade carrega mais de uma propriedade complexa JSON, então mapear a segunda com table splitting tira ela do jogo:

```csharp
// .NET 10, EF Core 10.0.7. Flat becomes Flat_Note on the Widgets table.
b.ComplexProperty(w => w.Flat);   // no ToJson()
```

Isso exige uma migração e muda o formato de armazenamento, então trate como último recurso e não como desbloqueio rápido. A condição 3 é o outro alvo fácil: se o tipo de elemento aninhado declara apenas uma `List<T>`, o formato fica fora do gatilho reportado. Nenhuma das duas é uma garantia do time do EF, são a lista minimizada do relator virada do avesso, então confirme contra o seu próprio modelo antes de se apoiar nelas.

## Detalhes e variantes: os outros erros de ordinal desta família

Outras três mensagens saem do mesmo canto do rastreador de mudanças e são confundidas com esta.

**`Complex entry ordinal '-1' is invalid for the collection '...' as it's outside of the collection of length 'N'.`** Repare na redação: *ordinal*, não *original ordinal*, e *for the collection*, não *for property*. Essa dispara quando você move uma entidade de `Deleted` de volta para `Unchanged`, que é a dança clássica do soft delete feito à mão. Foi a [dotnet/efcore#37724](https://github.com/dotnet/efcore/issues/37724), corrigida na **10.0.6** restaurando o ordinal atual a partir do original:

```csharp
// EF Core 10.0.6+, InternalComplexEntry.SetEntityState
if (oldState is EntityState.Detached or EntityState.Deleted
    && newState is not EntityState.Detached and not EntityState.Deleted)
{
    if (!UseOldBehavior37724 && Ordinal == -1)
    {
        Ordinal = OriginalOrdinal;
    }

    ContainingEntry.ValidateOrdinal(this, original: false);
}
```

Se você escreve soft delete virando `EntityState` na mão, considere não fazer isso: [filtros de consulta nomeados](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) expressam a mesma intenção sem tocar no rastreador de mudanças.

**`Index was out of range. Must be non-negative and less than the size of the collection.`** Uma `ArgumentOutOfRangeException`, não uma `InvalidOperationException`, lançada depois que a atualização do banco de dados já teve sucesso, durante a fase de aceitação das mudanças. Essa é a [dotnet/efcore#37585](https://github.com/dotnet/efcore/issues/37585), disparada ao remover um elemento de uma coleção complexa cujos elementos contêm suas próprias listas. Também corrigida na **10.0.6**.

**`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.`** Definir como `null` uma propriedade complexa anulável que contém uma coleção, em uma entidade rastreada, onde a coleção aninhada tem dois ou mais itens. Essa é a [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632), com marco na **10.0.13**. Até o EF Core 10.0.12, o último patch estável, ela continua aberta, então se é essa a mensagem que você está vendo, atualizar ainda não resolve.

Há também um caso em que o erro de ordinal é genuinamente seu, e não do EF. `ComplexCollectionEntry` expõe um indexador e `GetOriginalEntry(int)`, e ambos validam:

```csharp
// .NET 10, EF Core 10.0.12. Throws if the collection has fewer than 4 elements.
var entry = db.Entry(widget).ComplexCollection(w => w.Deep.Middle)[3];

// Throws if the collection loaded from the database had fewer than 4 elements,
// even when the current collection is longer.
var original = db.Entry(widget).ComplexCollection(w => w.Deep.Middle).GetOriginalEntry(3);
```

A segunda linha é a armadilha. Ler uma entrada original em um índice que só existe depois das suas adições em memória produz a mesma redação de *original ordinal* do bug acima, mas com um ordinal positivo em vez de `-1`. Se o ordinal na sua mensagem não é `-1`, você está olhando para a sua própria aritmética de índices.

## O que o switch Microsoft.EntityFrameworkCore.Issue38299 faz de verdade?

Cada um desses patches é publicado atrás de um switch de compatibilidade do `AppContext` no branch `release/10.0`:

```csharp
// EF Core 10.0.x, InternalEntryBase.InternalComplexCollectionEntry.cs
internal static readonly bool UseOldBehavior37724 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue37724", out var enabled) && enabled;

internal static readonly bool UseOldBehavior38299 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue38299", out var enabled) && enabled;
```

Leia a direção com atenção, porque é o inverso do que o nome sugere para a maioria. Colocar o switch em `true` **restaura o comportamento antigo e quebrado**. Ele existe para que um time que construiu uma solução alternativa em cima do bug consiga adotar uma versão de patch sem que essa solução quebre. Não é uma correção, e ligá-lo vai reintroduzir exatamente a exceção que trouxe você até aqui.

Se você realmente precisa fixar o comportamento antigo temporariamente, isso vai no arquivo de projeto e não no código, para ser definido antes de qualquer tipo do EF ser carregado:

```xml
<!-- .NET 10. Restores pre-10.0.10 behaviour. Do not use this to "fix" the crash. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.Issue38299" Value="true" />
</ItemGroup>
```

Os switches também funcionam como changelog. Faça `grep` por `UseOldBehavior` em `src/EFCore/ChangeTracking/Internal/` e você tem a lista completa do que mudou no rastreamento de coleções complexas ao longo da linha de patches 10.0: `37724` e `38299` em `InternalEntryBase`, `37585` e `38632` dentro do struct aninhado `InternalComplexCollectionEntry`.

Como os quatro bugs vivem no rastreamento de mudanças e não na geração de SQL, nenhum deles aparece em um log de consultas, em um trace de profiler ou em um diff de `dotnet ef migrations script`. O primeiro sinal é sempre uma exceção no `SaveChanges` com um frame `ValidateOrdinal` perto do topo da pilha. Se você vir esse frame, pare de ler a configuração do seu modelo e vá direto para as versões dos seus pacotes.

## Relacionados

- [Tipos complexos versus entidades owned no EF Core 11: qual escolher?](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [Como mapear um tipo complexo em vez de uma entidade owned no EF Core 11](/pt-br/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)
- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [Correção: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause](/pt-br/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/)
- [Como usar filtros de consulta nomeados para soft delete e multi-tenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)

## Fontes

- [dotnet/efcore#38299: ComplexProperty ToJson(): SaveChangesAsync throws "ordinal -1 is invalid" when nested sub-collection grows](https://github.com/dotnet/efcore/issues/38299)
- [dotnet/efcore#38373: a correção, contra release/10.0](https://github.com/dotnet/efcore/pull/38373)
- [dotnet/efcore#37724: Can't change state of entity with complex collection](https://github.com/dotnet/efcore/issues/37724)
- [dotnet/efcore#37585: Deleting an item from a ComplexCollection that contains an array results in Error](https://github.com/dotnet/efcore/issues/37585)
- [dotnet/efcore#38632: DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [Tipos complexos, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [InternalComplexEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
