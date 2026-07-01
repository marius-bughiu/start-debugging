---
title: "Como implementar e consumir IAsyncDisposable com await using em C#"
description: "Um guia completo de IAsyncDisposable em C#: quando usar await using, como escrever DisposeAsync e DisposeAsyncCore corretamente, e os detalhes de empilhamento e ConfigureAwait que causam vazamento de recursos."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "idisposable"
lang: "pt-br"
translationOf: "2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Quando um tipo mantém um recurso que só pode ser liberado de forma assíncrona (um stream de rede que precisa descarregar, uma transação de banco de dados que precisa confirmar ou reverter, um escritor de canal que precisa drenar), `IDisposable` é o contrato errado. Seu método `Dispose()` é síncrono, então a única maneira de executar limpeza assíncrona a partir dele é bloquear sobre uma `Task`, o que arrisca deadlocks e esgotamento do pool de threads. O C# 8.0 (lançado com o .NET Core 3.0) adicionou `IAsyncDisposable` e a instrução `await using` justamente para este caso. Este artigo cobre os dois lados: como consumir um tipo async-disposable com `await using`, e como implementar `DisposeAsync` corretamente, incluindo o padrão `DisposeAsyncCore` e os dois detalhes (o empilhamento e o `ConfigureAwait`) que causam vazamento de recursos silenciosamente. Todos os exemplos têm como alvo o .NET 11 e o C# 14, mas a API e a semântica não mudaram desde o C# 8.0.

## Por que um Dispose síncrono não é suficiente

`IDisposable.Dispose()` retorna `void`. Se sua limpeza precisar de `await` (descarregar um buffer para um socket, enviar um frame final, confirmar uma transação), você tem três opções ruins dentro de um `Dispose` síncrono: bloquear com `.GetAwaiter().GetResult()`, bloquear com `.Wait()`, ou disparar e esquecer e torcer para que termine. As duas primeiras podem causar deadlocks em contextos com um contexto de sincronização de thread única e vão manter uma thread do pool ocupada durante toda a operação de E/S; a terceira perde erros e pode liberar o handle subjacente antes que o trabalho assíncrono se complete.

`IAsyncDisposable` corrige isso ao tornar a própria limpeza aguardável:

```csharp
// System namespace, available since .NET Core 3.0 / C# 8.0
public interface IAsyncDisposable
{
    ValueTask DisposeAsync();
}
```

Observe que o tipo de retorno é `ValueTask`, não `Task`. A liberação frequentemente se completa de forma síncrona (nada a descarregar), e `ValueTask` evita alocar um objeto `Task` nesse caminho comum. Você quase nunca faz `await` em uma chamada `DisposeAsync()` pura você mesmo; o compilador faz isso por você através do `await using`.

## Consumir um async-disposable com await using

O lado do consumidor é a parte que você escreverá com mais frequência, porque o framework já implementa `IAsyncDisposable` nos tipos que importam para você: `Stream`, `FileStream`, `DbConnection`, `DbTransaction`, `Utf8JsonWriter`, os wrappers de `ChannelWriter<T>`, `ServiceProvider` e mais.

Existem duas formas. A instrução `await using` limita a limpeza a um bloco explícito:

```csharp
// .NET 11, C# 14
await using (var stream = new FileStream("data.bin", FileMode.Open))
{
    await stream.ReadAsync(buffer);
} // DisposeAsync() is awaited here, at the closing brace
```

A declaração `await using` limita a limpeza ao fim do bloco contêiner, sem aninhamento extra:

```csharp
// .NET 11, C# 14
static async Task ProcessAsync()
{
    await using var stream = new FileStream("data.bin", FileMode.Open);

    await stream.ReadAsync(buffer);

    // DisposeAsync() is awaited when ProcessAsync's body exits,
    // whether by return or by an exception.
}
```

Ambas exigem que o método contêiner seja `async`, porque `await using` insere um `await` no ponto de liberação. Se você escrever `await using` em um método que não é async, obtém um erro de compilação, e se acidentalmente omitir o `await` e escrever um `using` comum sobre um `IAsyncDisposable`, o compilador chama o `Dispose()` síncrono se o tipo também implementar `IDisposable`, ou falha ao compilar se ele só implementar `IAsyncDisposable`. Esse recuo silencioso para a liberação síncrona é uma fonte real de bugs: sempre recorra a `await using` quando o tipo for async-disposable.

Um idiomatismo comum que você verá com as pilhas de EF Core e ADO.NET empilha dois `await` em uma linha, um para a chamada de fábrica e outro escondido na liberação:

```csharp
// .NET 11, C# 14 -- EF Core 11
await using var transaction = await context.Database.BeginTransactionAsync(token);

await context.SaveChangesAsync(token);
await transaction.CommitAsync(token);
// If CommitAsync is not reached (exception), DisposeAsync rolls back.
```

O primeiro `await` desembrulha a `Task<IDbContextTransaction>` de `BeginTransactionAsync`; o `await using` faz com que `DisposeAsync` seja aguardado quando o bloco sair. Se uma exceção pular `CommitAsync`, o `DisposeAsync` da transação faz o rollback por você.

## Implementar IAsyncDisposable quando a classe é sealed

Se seu tipo é `sealed` (ou você tem certeza de que ele nunca terá subclasses), a implementação é curta. Simplesmente libere seus recursos em `DisposeAsync`:

```csharp
// .NET 11, C# 14
public sealed class MetricsFlusher : IAsyncDisposable
{
    private readonly Channel<Metric> _channel = Channel.CreateUnbounded<Metric>();
    private readonly HttpClient _http;

    public MetricsFlusher(HttpClient http) => _http = http;

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.Complete();

        // Drain and ship whatever is buffered before we go away.
        await foreach (var metric in _channel.Reader.ReadAllAsync())
        {
            await _http.PostAsJsonAsync("/metrics", metric);
        }
    }
}
```

Como a classe é `sealed`, não há nenhum tipo derivado para o qual encadear a limpeza, então você não precisa da divisão `DisposeAsyncCore` descrita a seguir, e não precisa de `GC.SuppressFinalize` a menos que a classe também declare um finalizador (uma classe sealed que possui apenas recursos assíncronos gerenciados raramente o faz).

## Implementar o padrão completo de liberação assíncrona para uma classe base

No momento em que sua classe *não* é sealed, a orientação da Microsoft muda. Qualquer classe não sealed é uma classe base potencial, e uma classe derivada precisa de um gancho para adicionar sua própria limpeza assíncrona e tê-la composta com a limpeza da classe base. Esse gancho é um método `protected virtual ValueTask DisposeAsyncCore()`. `DisposeAsync` se torna código repetitivo que chama `DisposeAsyncCore`, suprime a finalização e retorna:

```csharp
// .NET 11, C# 14
public class ExampleAsyncDisposable : IAsyncDisposable
{
    private IAsyncDisposable? _inner = new SomeAsyncResource();

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_inner is not null)
        {
            await _inner.DisposeAsync().ConfigureAwait(false);
        }
        _inner = null;
    }
}
```

Uma classe derivada sobrescreve `DisposeAsyncCore`, limpa seus próprios recursos e encadeia para `base.DisposeAsyncCore()`. Ela nunca toca em `DisposeAsync`, então a chamada `GC.SuppressFinalize(this)` executa exatamente uma vez, no nível mais derivado. Isso espelha o padrão síncrono `Dispose()` / `protected virtual void Dispose(bool)`, apenas com tipos de retorno `ValueTask` e sem o parâmetro `bool disposing` (não há caminho de finalizador a distinguir no caso puramente assíncrono).

## Suportar tanto IDisposable quanto IAsyncDisposable

É comum implementar ambas as interfaces, para que tanto quem usa `using` síncrono quanto quem usa `await using` obtenha a limpeza correta. O detalhe crítico: se você implementar apenas `IAsyncDisposable` e quem chama envolver seu objeto em um `using` comum (ou entregá-lo a um contêiner que só conhece `IDisposable`), seu `DisposeAsync` nunca executa e você vaza o recurso. A Microsoft destaca isso explicitamente como um alerta.

O padrão duplo roteia ambos os pontos de entrada através de lógica compartilhada e usa `Dispose(false)` a partir do caminho assíncrono para que os recursos gerenciados não sejam liberados duas vezes:

```csharp
// .NET 11, C# 14
public class DualDisposable : IDisposable, IAsyncDisposable
{
    private Stream? _managed = new MemoryStream();
    private IAsyncDisposable? _asyncOnly = new SomeAsyncResource();

    public void Dispose()
    {
        Dispose(disposing: true);
        GC.SuppressFinalize(this);
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        Dispose(disposing: false); // false: async path already handled managed async resources
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (disposing)
        {
            _managed?.Dispose();
            _managed = null;

            if (_asyncOnly is IDisposable d)
            {
                d.Dispose();
                _asyncOnly = null;
            }
        }
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_asyncOnly is not null)
        {
            await _asyncOnly.DisposeAsync().ConfigureAwait(false);
        }

        if (_managed is IAsyncDisposable ad)
        {
            await ad.DisposeAsync().ConfigureAwait(false);
        }
        else
        {
            _managed?.Dispose();
        }

        _asyncOnly = null;
        _managed = null;
    }
}
```

O caminho de `DisposeAsync` passa `false` para `Dispose(bool)` porque `DisposeAsyncCore` já liberou os recursos gerenciados de forma assíncrona; passar `true` tentaria liberá-los uma segunda vez. Isso mantém os dois caminhos funcionalmente equivalentes sem liberação dupla.

## O detalhe de empilhamento que pula DisposeAsync

Este morde quem tenta ser organizado. Você não pode "empilhar" instruções `await using` do jeito que pode empilhar instruções `using` síncronas, porque se um construtor posterior ao primeiro lançar uma exceção, os objetos criados antes nunca são liberados:

```csharp
// .NET 11, C# 14 -- DO NOT DO THIS
var one = new ExampleAsyncDisposable();
var two = new AnotherAsyncDisposable(); // if this constructor throws...

await using (one.ConfigureAwait(false))
await using (two.ConfigureAwait(false))
{
    // ...neither one nor two has DisposeAsync called.
}
```

O problema é que os objetos são construídos *antes* de entrar nos blocos `await using`, então uma exceção entre a construção e o bloco os deixa sem liberação. A solução é construir e delimitar o escopo no mesmo passo. Qualquer uma destas três formas é segura:

```csharp
// .NET 11, C# 14 -- nested blocks
var one = new ExampleAsyncDisposable();
await using (one.ConfigureAwait(false))
{
    var two = new AnotherAsyncDisposable();
    await using (two.ConfigureAwait(false))
    {
        // two is disposed first, then one
    }
}

// .NET 11, C# 14 -- sequential declarations (cleanest)
await using var a = new ExampleAsyncDisposable();
await using var b = new AnotherAsyncDisposable();
// b is disposed before a at the end of the method
```

Prefira a forma de declaração. Se um construtor lançar uma exceção, a limpeza gerada pelo compilador para as variáveis já declaradas ainda executa, e você evita toda essa classe de bugs de empilhamento.

## ConfigureAwait sobre await using

Dentro do código de uma biblioteca você frequentemente quer `ConfigureAwait(false)` para que a continuação da liberação não capture o contexto de sincronização original. Você não pode simplesmente anexá-lo ao objeto; existe uma extensão dedicada, `ConfigureAwait(IAsyncDisposable, bool)`, que retorna um `ConfiguredAsyncDisposable`:

```csharp
// .NET 11, C# 14
await using (stream.ConfigureAwait(false))
{
    await stream.ReadAsync(buffer);
}
```

No código de aplicação sem nenhum contexto de sincronização a capturar (ASP.NET Core, aplicações de console, serviços de worker), você pode omiti-lo; ali ele não tem efeito. Em uma biblioteca que pode ser chamada a partir de uma interface de usuário ou de um contexto de ASP.NET legado, adicione-o, seguindo o mesmo raciocínio que você usa para `ConfigureAwait(false)` em await comuns.

## Onde você não precisa liberar de forma alguma

A injeção de dependência cuida disso por você. Quando você registra um serviço em um `IServiceCollection`, o contêiner rastreia se a instância resolvida implementa `IDisposable` ou `IAsyncDisposable` e a libera no fim do seu escopo. Um serviço com escopo (scoped) que implementa `IAsyncDisposable` tem seu `DisposeAsync` aguardado quando o escopo da requisição termina, desde que o próprio escopo tenha sido criado e liberado de forma assíncrona (o ASP.NET Core faz isso). Você não escreve `await using` sobre serviços injetados; você deixa o contêiner ser o dono do ciclo de vida deles. Liberar manualmente um serviço injetado é um bug que pode liberá-lo por baixo de outros consumidores.

## Quando recorrer ao IAsyncDisposable

Use-o quando a liberação realmente tiver que fazer E/S: descarregar um escritor com buffer para um socket ou arquivo, confirmar ou reverter uma transação, completar e drenar um [Channel](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/), ou fechar graciosamente uma conexão de longa duração. Não o adicione a um tipo cuja limpeza seja puramente síncrona (liberar um handle, limpar um campo); um `IDisposable` comum é mais simples e não obriga cada chamador a entrar em um método async. E se seu tipo produz um stream assíncrono, combine-o com [IAsyncEnumerable&lt;T&gt;](/pt-br/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) em vez de tentar acoplar o streaming à liberação.

A liberação assíncrona é uma peça da história mais ampla da correção assíncrona. Se seu `DisposeAsync` faz trabalho real, propague por ele um tempo limite ciente de cancelamento da mesma forma que você [aplicaria um tempo limite a qualquer operação assíncrona com CancellationTokenSource.CancelAfter](/pt-br/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/), e certifique-se de [propagar um CancellationToken pelos seus métodos async](/pt-br/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) para que a limpeza possa ser limitada. Quando a limpeza envolve parar trabalho em andamento, aplica-se aqui a mesma disciplina que permite [cancelar uma Task de longa duração sem deadlocks](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

Acerte as duas regras e a liberação assíncrona se torna entediante no melhor sentido: use `await using` no lado consumidor, e no lado da implementação divida `DisposeAsync` de `DisposeAsyncCore` para tipos não sealed, implemente também `IDisposable` se um chamador síncrono puder liberá-lo, e nunca empilhe blocos `await using`.

## Fontes

- [Implementar um método DisposeAsync (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync)
- [Interface IAsyncDisposable (referência da API no MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.iasyncdisposable)
- [Instrução e declaração using (referência da linguagem C#)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/using)
- [Perguntas frequentes sobre ConfigureAwait (.NET Blog)](https://devblogs.microsoft.com/dotnet/configureawait-faq/)
