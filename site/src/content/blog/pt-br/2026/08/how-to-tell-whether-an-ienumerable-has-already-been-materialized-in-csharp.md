---
title: "Como saber se um IEnumerable<T> já foi materializado em C#"
description: "Não existe uma flag HasBeenEnumerated em IEnumerable<T>. Veja o que TryGetNonEnumeratedCount realmente verifica, por que Enumerable.Range passa em um teste de ICollection<T> e a guarda que evita um ToList() desperdiçado."
pubDate: 2026-08-23
tags:
  - "csharp"
  - "linq"
  - "dotnet"
  - "performance"
lang: "pt-br"
translationOf: "2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-23
---

Não existe nenhuma API no .NET que responda "esta sequência `IEnumerable<T>` já foi enumerada?", e nenhuma que responda "esta sequência está apoiada em memória?". A interface tem exatamente um membro, `GetEnumerator()`, e nada no contrato exige que uma implementação lembre que você a chamou. O que você realmente tem é `Enumerable.TryGetNonEnumeratedCount` (.NET 6 e posteriores), que diz se a *contagem* é barata, mais um conjunto de testes de tipo que você mesmo pode executar. Esses dois sinais se sobrepõem a "já materializado", mas não são a mesma coisa, e é nessas lacunas que os bugs moram. Tudo abaixo foi medido no .NET 10.0.201 com C# 14.

## Por que a pergunta não tem resposta direta

`IEnumerable<T>` é uma fábrica de enumeradores, não um contêiner. Chamar `GetEnumerator()` duas vezes é legal, e cada chamada tem o direito de produzir uma passagem nova e independente sobre os dados. Um `List<int>` entrega um enumerador struct sobre um array existente. Um método com `yield return` constrói uma máquina de estados que executa o corpo do seu método desde o início. Um `DbSet<T>` abre uma conexão e emite SQL. Os três satisfazem a mesma interface, e apenas o primeiro mantém os elementos em memória.

Então "já foi materializado?" se divide em três perguntas distintas que as pessoas confundem:

1. Os elementos já estão em memória, de modo que uma segunda passagem seja gratuita?
2. A contagem está disponível sem percorrer a sequência?
3. *Este objeto de sequência em particular* já foi percorrido uma vez?

A BCL dá uma resposta parcial para (1), uma boa resposta para (2) e nenhuma resposta para (3).

## O que o runtime realmente rastreia: a máquina de estados do iterador

Iteradores gerados pelo compilador carregam sim um campo de estado, e você pode olhar para ele. Isso é um recurso de depuração, não uma API, mas vale ver uma vez porque explica o comportamento que você observa:

```csharp
// .NET 10.0.201, C# 14
static IEnumerable<int> Lazy()
{
    yield return 1;
    yield return 2;
}

static string ReadState(object o)
{
    var f = o.GetType().GetField("<>1__state",
        BindingFlags.Instance | BindingFlags.NonPublic);
    return f is null ? "no state field" : $"{f.GetValue(o)}";
}

var seq = Lazy();
Console.WriteLine(ReadState(seq));      // -2  : constructed, never enumerated
var e = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, e)); // True : the first call returns "this"
e.MoveNext();
Console.WriteLine(ReadState(seq));      // 1   : mid-enumeration
```

O sentinela `-2` é o caminho rápido do compilador: a primeira chamada a `GetEnumerator()` na thread criadora muda o estado para `0` e devolve o mesmo objeto em vez de alocar um clone. Toda chamada depois disso devolve um clone com estado próprio. É por isso que o segundo enumerador recomeça do início enquanto o primeiro mantém sua posição, e é por isso que não há um bit compartilhado de "já enumerado" para você ler. Usar reflexão sobre `<>1__state` fala de um objeto, em um caminho de código, para um compilador; não coloque isso em produção.

## TryGetNonEnumeratedCount, e exatamente o que ele testa

Adicionado no .NET 6 e ainda com o mesmo formato no .NET 11, `Enumerable.TryGetNonEnumeratedCount` é a única primitiva suportada de "posso olhar sem tocar". A [implementação do runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs) são três testes de tipo em ordem:

```csharp
// System.Linq.Enumerable, .NET 10, abridged
public static bool TryGetNonEnumeratedCount<TSource>(
    this IEnumerable<TSource> source, out int count)
{
    if (source is ICollection<TSource> collectionoft) { count = collectionoft.Count; return true; }
    if (source is Iterator<TSource> iterator)
    {
        int c = iterator.GetCount(onlyIfCheap: true);
        if (c >= 0) { count = c; return true; }
    }
    if (source is ICollection collection) { count = collection.Count; return true; }
    count = 0;
    return false;
}
```

`Iterator<TSource>` é a classe base interna dos iteradores do próprio LINQ, então o ramo do meio é a parte que você não consegue replicar de fora do `System.Linq`. As [observações documentadas](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) dizem isso com todas as letras: "uma série de testes de tipo que identificam subtipos comuns cuja contagem pode ser determinada sem enumerar".

Passar todos os formatos comuns de sequência por esse método, mais os testes de tipo que você escreveria à mão, dá isto no .NET 10.0.201:

| Sequência | `TryGetNonEnumeratedCount` | `is ICollection<T>` | `is IReadOnlyCollection<T>` | `is IQueryable` |
| --- | --- | --- | --- | --- |
| `int[]` | true, 3 | true | true | false |
| `List<int>` | true, 3 | true | true | false |
| `HashSet<int>` | true, 3 | true | true | false |
| `Queue<int>` | true, 3 | **false** | true | false |
| `Stack<int>` | true, 3 | **false** | true | false |
| `ReadOnlyCollection<int>` | true, 3 | true | true | false |
| `ImmutableArray<int>` | true, 3 | true | true | false |
| `Enumerable.Empty<int>()` | true, 0 | true | true | false |
| `Enumerable.Range(0, 1_000_000_000)` | **true, 1000000000** | **true** | true | false |
| `Enumerable.Repeat(7, 500)` | true, 500 | true | true | false |
| `list.Select(x => x)` | **true, 3** | false | false | false |
| `list.Where(x => true)` | false | false | false | false |
| `list.Take(2)` | true, 2 | **true** | true | false |
| `list.Skip(1)` | true, 2 | **true** | true | false |
| `list.OrderBy(x => x)` | true, 3 | false | false | false |
| `list.Distinct()` | false | false | false | false |
| `list.Concat(list)` | true, 6 | false | false | false |
| `((IEnumerable)list).Cast<int>()` | true, 3 | true | true | false |
| `list.DefaultIfEmpty()` | true, 3 | false | false | false |
| `Enumerable.Reverse(list)` | true, 3 | false | false | false |
| `list.GroupBy(x => x).SelectMany(g => g)` | false | false | false | false |
| método iterador com `yield return` | false | false | false | false |
| `list.AsQueryable()` | false | false | false | **true** |
| `list.ToList()` / `.ToArray()` | true, 3 | true | true | false |

## Três armadilhas escondidas nessa tabela

**Uma contagem barata não é uma sequência materializada.** `Enumerable.Range(0, 1_000_000_000)` reporta uma contagem de um bilhão em tempo constante e passa em `is ICollection<int>`, mas nada foi alocado. `RangeIterator` implementa `IList<T>` desde o .NET 8; no .NET 6 e no .NET 7 a mesma expressão falha no teste de `ICollection<T>` porque o iterador só implementava o interno `IPartition<int>`. Se o seu código diz `if (source is ICollection<T>) { /* safe to keep the reference */ }`, você também está dizendo "é seguro segurar uma sequência de um bilhão de elementos e enumerá-la duas vezes".

A mesma armadilha aparece em `Select`. `list.Select(x => x)` devolve `true` de `TryGetNonEnumeratedCount` com a contagem da lista de origem, porque a contagem de uma projeção é igual à da origem. O seletor não rodou para um único elemento. Obter a contagem não disse nada sobre o trabalho já estar feito.

**`ICollection<T>` deixa passar dois tipos muito comuns.** `Queue<T>` e `Stack<T>` implementam a `ICollection` não genérica e a genérica `IReadOnlyCollection<T>`, mas não `ICollection<T>`. Uma guarda escrita como `source as ICollection<T>` cai silenciosamente em uma cópia defensiva nos dois casos. `IReadOnlyCollection<T>` é o teste melhor se tudo o que você precisa é `Count` e enumeração repetida.

**Diferido não significa incontável, e contável não significa barato de percorrer.** `Where` e `Distinct` devolvem `false` mesmo quando a origem é um `List<int>`, porque o predicado decide a contagem. `OrderBy` devolve `true` com a contagem da origem, mas enumerá-lo ainda realiza uma ordenação completa. Não trate um resultado `true` como permissão para enumerar à vontade.

## Um ICollection<T> preguiçoso derrota toda verificação

Toda técnica aqui é um teste de tipo, e um teste de tipo pode ser satisfeito por uma implementação que faz trabalho caro a cada `GetEnumerator()`. Isso não é hipotético: uma navegação de coleção do EF Core sob proxies de carregamento preguiçoso é um `ICollection<T>` cuja enumeração pode ir ao banco de dados.

```csharp
// .NET 10.0.201, C# 14
sealed class LazyCollection : ICollection<int>
{
    public static int WorkDone;
    public int Count => 3;              // cheap, known up front
    public bool IsReadOnly => true;
    public IEnumerator<int> GetEnumerator()
    {
        WorkDone++;                     // expensive, runs on every pass
        return Enumerable.Range(0, 3).GetEnumerator();
    }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    // mutating members omitted
}
```

Esse tipo reporta `is ICollection<int> == true` e `TryGetNonEnumeratedCount == true` com contagem 3, sem ter feito nenhum trabalho. Um `foreach` depois, `WorkDone` vale 1, e sobe a cada passagem seguinte. Nenhuma API consegue distinguir isso de um `List<int>`. Se você controla a fronteira, a correção é parar de passar `IEnumerable<T>` e passar `IReadOnlyList<T>` ou um tipo concreto, o que transforma um palpite em tempo de execução em uma garantia em tempo de compilação. Esse é o mesmo argumento para [escolher o tipo de retorno certo entre IEnumerable, IAsyncEnumerable e IQueryable](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/).

## A guarda que vale a pena escrever

Na prática ninguém quer uma flag `HasBeenEnumerated`. As pessoas querem saber se um `ToList()` defensivo vai ser desperdiçado. Responda essa pergunta diretamente:

```csharp
// .NET 10.0.201, C# 14
public static IReadOnlyCollection<T> Materialize<T>(this IEnumerable<T> source)
{
    ArgumentNullException.ThrowIfNull(source);

    return source switch
    {
        // Deferred against a remote store: always pull it in, once.
        IQueryable<T> q => q.ToList(),

        // Known in-memory BCL types: reuse the reference, no copy.
        T[] a => a,
        List<T> l => l,
        IReadOnlyCollection<T> c when c.GetType().Assembly == typeof(List<T>).Assembly => c,

        _ => source.ToList(),
    };
}
```

O ramo `IQueryable<T>` vem primeiro porque um queryable é o único caso em que uma segunda enumeração é inequivocamente uma segunda ida ao servidor, e onde os testes de tipo do LINQ devolvem `false` de qualquer forma. A verificação de assembly no terceiro ramo é deliberadamente conservadora: aceita `Queue<T>`, `Stack<T>`, `ReadOnlyCollection<T>` e companhia enquanto rejeita o `LazyCollection` acima e qualquer tipo de navegação de ORM. Se o seu código não tem coleções apoiadas de forma preguiçosa, reduza esse ramo a um simples `IReadOnlyCollection<T> c => c` e fique com a versão de uma linha.

Repare no que *não* está na guarda: `TryGetNonEnumeratedCount`. Ele responde a outra pergunta. Use-o quando você realmente quer uma contagem e aceita um plano B, que é o padrão para o qual ele foi projetado:

```csharp
// .NET 10.0.201, C# 14
int capacity = source.TryGetNonEnumeratedCount(out int known) ? known : 16;
var buffer = new List<T>(capacity);
```

## O que a guarda economiza

Medido com `Stopwatch` e `GC.GetAllocatedBytesForCurrentThread`, 100 iterações, sobre um `List<int>` de 1.000.000 de elementos passado como `IEnumerable<int>`, .NET 10.0.201 em Release:

| Abordagem | Tempo | Alocado |
| --- | --- | --- |
| `input.ToList()` | 793,93 us/op | 4.000.056 bytes/op |
| `input as IReadOnlyCollection<int> ?? input.ToList()` | 1,09 us/op | 0 bytes/op |

São medições grosseiras de laço, não números do BenchmarkDotNet, mas a coluna de alocação é exata e é o ponto: a cópia cega aloca um segundo array de apoio de quatro megabytes no heap de objetos grandes a cada chamada, e a guarda não aloca nada. Em um caminho quente que recebe uma lista já materializada, a cópia defensiva é o custo inteiro do método. O mesmo raciocínio vale sempre que você tenta [ler um arquivo grande sem estourar a memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

## Deixe o analisador achar os pontos de chamada

Você não precisa auditar isso na mão. CA1851, "Possible multiple enumerations of 'IEnumerable' collection", foi introduzido no .NET 7 e continua **desabilitado por padrão no .NET 10**. Ligue-o:

```ini
# .editorconfig
[*.{cs,vb}]
dotnet_diagnostic.CA1851.severity = warning
```

Com `EnableNETAnalyzers` e `AnalysisLevel` definidos como `latest`, este código produz dois diagnósticos no .NET 10.0.201:

```csharp
public static void Twice(IEnumerable<int> input)
{
    var count = input.Count();              // CA1851
    foreach (var i in input) { _ = i; }     // CA1851
}
```

```text
warning CA1851: Possible multiple enumerations of 'IEnumerable' collection.
Consider using an implementation that avoids multiple enumerations.
```

Reescrever o corpo para vincular primeiro através de uma guarda limpa os dois avisos:

```csharp
public static void Guarded(IEnumerable<int> input)
{
    var list = input as IReadOnlyCollection<int> ?? input.ToList();
    var count = list.Count;
    foreach (var i in list) { _ = i; }
}
```

Dois botões de configuração importam em bases de código reais. `enumeration_methods` deixa você registrar seus próprios métodos que consomem um argumento `IEnumerable`, e `assume_method_enumerates_parameters` inverte a suposição padrão, que hoje é a de que um método seu *não* enumera o que você entrega a ele. Esse padrão é o motivo de CA1851 ficar calado quando você passa a mesma sequência para dois auxiliares seus.

## IQueryable e IAsyncEnumerable precisam de regras separadas

Para `IQueryable<T>`, nada disso vale: todo teste de tipo devolve `false`, e cada enumeração é uma nova tradução do provedor e uma nova ida ao servidor. O sinal que você quer é o tipo estático, e a correção é chamar `ToListAsync()` uma vez na fronteira. Enumeração repetida de um queryable dentro de um laço é uma das formas por trás [dos problemas de consulta N+1 no EF Core](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), e uma consulta que não pode ser traduzida de jeito nenhum produz [o erro "The LINQ expression could not be translated"](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) em vez de uma ida dupla silenciosa.

Para `IAsyncEnumerable<T>` não existe `TryGetNonEnumeratedCount` algum, nem equivalente de `ICollection<T>`, nem contagem barata. O único jeito de saber quantos elementos uma sequência assíncrona guarda é aguardar todos eles, que é exatamente o que [IAsyncEnumerable foi projetado para deixar você evitar](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/). Materialize uma vez com `await source.ToListAsync()` e passe a lista adiante, ou reestruture para que uma única passagem baste.

O resumo honesto é que "isso já foi materializado?" não tem resposta e "uma segunda passagem vai ser barata?" tem, na maioria das vezes. Teste `IQueryable<T>` primeiro, depois `IReadOnlyCollection<T>` em vez de `ICollection<T>`, trate `TryGetNonEnumeratedCount` como uma dica de capacidade e não como uma verificação de materialização, e deixe o CA1851 apontar onde você esqueceu.

## Relacionados

- [IEnumerable vs IAsyncEnumerable vs IQueryable em C#: qual o método deve retornar?](/pt-br/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [O que é IAsyncEnumerable&lt;T&gt; e quando devo usá-lo?](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Como ler um CSV grande no .NET 11 sem estourar a memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Correção: "The LINQ expression could not be translated" no EF Core 11](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Fontes

- [Enumerable.TryGetNonEnumeratedCount&lt;TSource&gt; Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) no MS Learn
- [Count.cs no dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs), a implementação dos testes de tipo
- [Range.SpeedOpt.cs no dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Range.SpeedOpt.cs), onde `RangeIterator` declara `IList<T>`
- [CA1851: Possible multiple enumerations of 'IEnumerable' collection](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1851) no MS Learn
- [Execução adiada e avaliação preguiçosa no LINQ](https://learn.microsoft.com/en-us/dotnet/standard/linq/deferred-execution-lazy-evaluation) no MS Learn
