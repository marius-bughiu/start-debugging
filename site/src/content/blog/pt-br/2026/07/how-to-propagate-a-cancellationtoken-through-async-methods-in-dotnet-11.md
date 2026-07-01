---
title: "Como propagar um CancellationToken por métodos async no .NET 11"
description: "Passe um CancellationToken de forma limpa por cada camada de uma cadeia de chamadas async no .NET 11: convenção do último parâmetro, valores padrão, tokens vinculados, RequestAborted do ASP.NET Core e o analisador CA2016 que detecta os que você esquece."
pubDate: 2026-07-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "pt-br"
translationOf: "2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-01
---

O cancelamento no .NET só funciona se o token chegar ao código que faz o bloqueio. Um `CancellationToken` que você cria no topo de uma requisição mas nunca passa para `HttpClient.GetAsync`, `DbContext.SaveChangesAsync` ou uma chamada `Stream.ReadAsync` é peso morto: a operação externa continua rodando até o fim porque nada rio abaixo está ouvindo. Propagar o token significa passar esse único parâmetro por cada método async entre o lugar onde o cancelamento é solicitado e o lugar onde o trabalho realmente acontece. Este post cobre as regras mecânicas no .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): onde o parâmetro vai, qual deveria ser seu valor padrão, como combinar tokens, como o ASP.NET Core entrega um de graça e como o analisador `CA2016` encontra as chamadas que você esqueceu de repassar. Todos os exemplos compilam contra o .NET 11.

## Por que um token que não viaja é inútil

O cancelamento no .NET é cooperativo. Não existe `Task.Kill()`, e o runtime nunca interrompe uma thread por conta própria. Um `CancellationToken` é apenas um sinal que passa de "não solicitado" para "solicitado" quando alguém chama `Cancel()` no `CancellationTokenSource` proprietário. O código reage a essa mudança apenas se verificar `token.IsCancellationRequested`, chamar `token.ThrowIfCancellationRequested()`, ou entregar o token a uma API do framework que faz essas verificações internamente. Se o token nunca chega à chamada bloqueante, a chamada bloqueante não tem como saber que deveria parar.

Essa é toda a razão pela qual a propagação importa. Considere esta cadeia:

```csharp
// .NET 11, C# 14 -- broken: the token stops at the top
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync();          // no token -- runs to completion
    var enriched = await EnrichAsync(rows);    // no token -- runs to completion
    return Assemble(enriched);
}
```

Você pode chamar `Cancel()` o dia todo. `LoadRowsAsync` e `EnrichAsync` nunca veem o sinal, então `BuildReportAsync` termina todo o seu trabalho antes que o `catch (OperationCanceledException)` no ponto de chamada tenha sequer a chance de disparar. A solução não é código esperto, é disciplina: o token precisa ser um parâmetro em cada método do caminho, e cada chamada precisa repassá-lo.

```csharp
// .NET 11, C# 14 -- correct: the token reaches the leaves
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync(ct);
    var enriched = await EnrichAsync(rows, ct);
    return Assemble(enriched);
}
```

## O procedimento de propagação de ponta a ponta

Esta é a sequência para passar um token de um ponto de entrada até uma chamada de E/S. Cada passo é uma regra que você aplica de forma mecânica.

1. **Aceite o token como último parâmetro.** Dê a cada método async da cadeia um parâmetro `CancellationToken`, e coloque-o por último para que se leia de forma consistente em todo o seu código e combine com as próprias assinaturas do framework.
2. **Nomeie-o de forma consistente.** Use `cancellationToken` em APIs públicas de biblioteca (essa é a convenção da BCL) ou `ct` no código interno da aplicação. Escolha um e mantenha-o para que o repasse seja localizável com grep.
3. **Repasse-o para cada chamada aguardada que aceite um.** Se um método que você chama tem uma sobrecarga ou parâmetro `CancellationToken`, passe seu token para ele. Não passe `CancellationToken.None` "por segurança": isso faz a chamada abrir mão do cancelamento silenciosamente.
4. **Dê a ele um valor padrão apenas em verdadeiros pontos de entrada.** Métodos voltados para biblioteca usam `CancellationToken cancellationToken = default` para que quem não se importa possa omiti-lo. Métodos internos que sempre têm um token não deveriam receber um valor padrão, para que um argumento ausente seja um lembrete em tempo de compilação.
5. **Combine tokens quando você adiciona seu próprio prazo.** Se um método precisa do seu próprio tempo limite além do token do chamador, vincule-os com `CancellationTokenSource.CreateLinkedTokenSource` em vez de escolher um e descartar o outro.
6. **Ative o `CA2016`.** Deixe o analisador sinalizar as chamadas que você deixou passar nos passos 3 a 5.

O resto deste post detalha as partes dessa lista que têm nuances reais.

## Onde o parâmetro vai e como chamá-lo

A convenção em toda a BCL é: `CancellationToken` é o **último** parâmetro, e se chama `cancellationToken`. Olhe qualquer API async moderna e você verá o formato:

```csharp
// From the BCL, for reference
Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken);
Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
Task<HttpResponseMessage> GetAsync(string requestUri, CancellationToken cancellationToken);
```

Replique isso no seu próprio código. Duas razões pelas quais isso não é apenas cosmético:

- **O analisador `CA2016` se baseia na posição do último parâmetro.** Ele observa um método que recebe um `CancellationToken` como último parâmetro, depois verifica se as chamadas internas o repassam. Ponha o token no meio e você enfraquece as ferramentas que deveriam pegar seus erros.
- **Parâmetros opcionais precisam vir por último de qualquer forma.** Quando você dá um valor padrão ao token (`= default`), o C# o obriga a ficar depois de todos os parâmetros não opcionais, então a regra do último parâmetro surge de graça das regras da linguagem.

Para o nome, a divisão é: `cancellationToken` para tudo que é público ou com formato de biblioteca (a consistência com a BCL vence); `ct` é aceitável e comum no código interno da aplicação, onde a brevidade ajuda a legibilidade de cadeias de chamadas longas. O importante é que seja um único nome, para que quem lê um método veja instantaneamente se o token está sendo repassado ou descartado.

## `default`, `CancellationToken.None` e quando dar um valor padrão

`default(CancellationToken)` e `CancellationToken.None` são o mesmo valor: um token que nunca pode ser cancelado. `IsCancellationRequested` é sempre `false` e `CanBeCanceled` é `false`. Eles diferem apenas na sinalização de intenção, e a linguagem lhe dá `= default` como a forma idiomática de parâmetro opcional:

```csharp
// .NET 11, C# 14
public async Task<User> GetUserAsync(int id, CancellationToken cancellationToken = default)
{
    return await _db.Users.FindAsync([id], cancellationToken)
        ?? throw new KeyNotFoundException();
}
```

A decisão que faz as pessoas tropeçarem é **se deve ou não dar um valor padrão ao parâmetro**. A regra que mantém você honesto:

- **Métodos públicos / de biblioteca: dê um valor padrão.** Chamadores que genuinamente não têm um token (um `Main` de console de nível superior, um caminho dispare-e-esqueça) podem omiti-lo, e o método ainda compila. É por isso que cada método async da BCL dá um valor padrão ao token.
- **Métodos internos que sempre rodam sob um token: não dê um valor padrão.** Se `BuildReportAsync` só é chamado de um manipulador de requisições que tem um token, deixar o parâmetro sem valor padrão significa que o compilador reclama no instante em que alguém o chama sem repassar um token. Esse erro de compilação é um recurso. Dar-lhe um valor padrão ali deixaria um token descartado passar como um silencioso `CancellationToken.None`.

O antipadrão a evitar é recorrer a `CancellationToken.None` dentro de um método que já tem um token real em escopo. Isso não é "seguro", é um vazamento de cancelamento disfarçado de cautela.

```csharp
// .NET 11, C# 14 -- wrong: leaks cancellation on purpose
public async Task ProcessAsync(CancellationToken ct)
{
    // ct is right there, and we throw it away
    await _client.PostAsync(url, content, CancellationToken.None);
}
```

O único uso legítimo de `CancellationToken.None` é uma chamada que você deliberadamente quer que rode até o fim mesmo que a operação externa seja cancelada, por exemplo, gravar um registro de auditoria final ou liberar um recurso. Deixe essa intenção óbvia com um comentário, porque caso contrário um revisor a lerá como um bug.

## Combinar o token do chamador com o seu próprio tempo limite

Uma situação real comum: um método recebe o `CancellationToken` do chamador, mas também precisa do seu próprio tempo limite ("desista desta chamada rio abaixo depois de 5 segundos"). Não escolha um e ignore o outro. Vincule-os para que o cancelamento de **qualquer** uma das fontes pare o trabalho. `CancellationTokenSource.CreateLinkedTokenSource` produz uma fonte cujo token dispara quando qualquer um de seus tokens pai dispara:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithTimeoutAsync(
    string url,
    CancellationToken cancellationToken)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
        cancellationToken, timeoutCts.Token);

    try
    {
        return await _client.GetStringAsync(url, linkedCts.Token);
    }
    catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested
                                             && !cancellationToken.IsCancellationRequested)
    {
        // Distinguish "we timed out" from "the caller cancelled us"
        throw new TimeoutException($"GET {url} exceeded 5s");
    }
}
```

Dois detalhes tornam isso correto:

- **Libere a fonte vinculada.** `CreateLinkedTokenSource` registra callbacks nos seus pais; não liberá-la vaza esses registros por toda a vida do token pai mais longevo. O `using` cuida disso.
- **O filtro `when` separa as duas causas de cancelamento.** Quando o token dispara você recebe uma `OperationCanceledException` de qualquer forma. Verificar `timeoutCts.IsCancellationRequested` contra `cancellationToken.IsCancellationRequested` diz qual fonte disparou, de modo que um cancelamento iniciado pelo chamador se propaga como está, enquanto um tempo limite aflora como uma `TimeoutException`. Essa é a mesma disciplina que você precisa ao [cancelar uma Task de longa duração sem causar deadlock](/pt-br/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

Se você só precisa de um tempo limite e não há token de entrada, `CancelAfter` em uma única fonte é mais simples que uma vinculada. Recorra à vinculação especificamente quando um token do chamador e um prazo local precisam ambos vencer.

## O ASP.NET Core entrega um token: use-o

Em uma aplicação web você raramente cria o token do topo da cadeia por conta própria. O ASP.NET Core expõe `HttpContext.RequestAborted`, um `CancellationToken` que dispara quando o cliente se desconecta ou o servidor aborta a requisição. Tanto as minimal APIs quanto os controladores MVC o vinculam automaticamente: declare um parâmetro `CancellationToken` e o framework o preenche a partir de `RequestAborted`.

```csharp
// .NET 11, C# 14 -- minimal API
app.MapGet("/reports/{id}", async (
    int id,
    ReportService reports,
    CancellationToken cancellationToken) =>
{
    var report = await reports.BuildAsync(id, cancellationToken);
    return Results.Ok(report);
});
```

```csharp
// .NET 11, C# 14 -- MVC controller
[HttpGet("reports/{id}")]
public async Task<IActionResult> Get(int id, CancellationToken cancellationToken)
{
    var report = await _reports.BuildAsync(id, cancellationToken);
    return Ok(report);
}
```

Esse token injetado é o ponto de entrada para toda a cadeia de propagação. Repasse-o para `BuildAsync`, que o repassa para suas consultas do EF Core e chamadas de `HttpClient`, e um cliente que fecha a aba do navegador agora para todo esse trabalho rio abaixo em vez de pagar por uma consulta que ninguém vai ler. O comportamento a esperar: quando `RequestAborted` dispara no meio da requisição, seus awaits lançam `OperationCanceledException` (ou sua subclasse `TaskCanceledException`), que o framework trata como uma requisição cancelada em vez de um 500. Se você vê essa exceção nos logs do `HttpClient`, muitas vezes é exatamente isto funcionando como pretendido; veja [por que uma TaskCanceledException aflora do HttpClient](/pt-br/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para a distinção entre tempo limite e cancelamento.

Uma ressalva específica do trabalho em segundo plano: `RequestAborted` está limitado à requisição. Se um manipulador de requisições dispara trabalho que deveria sobreviver à resposta, não lhe dê `RequestAborted`: ele será cancelado no instante em que a resposta se completar. Esse trabalho pertence a um serviço hospedado com seu próprio ciclo de vida, que é o padrão por trás de [rodar trabalho dispare-e-esqueça com segurança usando BackgroundService](/pt-br/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Propagar por streaming e `IAsyncEnumerable<T>`

Fluxos async precisam que o token seja conectado através do iterador, e o mecanismo é ligeiramente diferente porque é o consumidor, não o produtor, quem fornece o token no momento da enumeração. O produtor marca o parâmetro com `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
public async IAsyncEnumerable<Row> ReadRowsAsync(
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    await using var reader = await _source.OpenAsync(cancellationToken);
    while (await reader.ReadAsync(cancellationToken))
    {
        yield return reader.Current;
    }
}
```

O consumidor anexa um token com `WithCancellation`, e o compilador o roteia para o parâmetro `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
await foreach (var row in ReadRowsAsync().WithCancellation(cancellationToken))
{
    Process(row);
}
```

Sem `[EnumeratorCancellation]`, o token de `WithCancellation` é silenciosamente ignorado e a enumeração não pode ser cancelada: uma quebra sutil de propagação que o analisador `CA2016` nem sempre pega. Se você é novo com fluxos async, o resumo de [quando recorrer a IAsyncEnumerable](/pt-br/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) cobre o panorama mais amplo.

## Deixe o `CA2016` pegar os que você descarta

Passar um token à mão por uma cadeia de chamadas profunda é exatamente o tipo de tarefa em que você vai pular uma chamada. O analisador `CA2016` ("Repasse o parâmetro CancellationToken para métodos que recebem um") foi feito para isso: ele inspeciona um método que tem um `CancellationToken` como último parâmetro, depois sinaliza qualquer chamada interna que poderia aceitar o token, diretamente ou via uma sobrecarga, mas não o faz. Transforme-o em um erro de compilação para que um token descartado falhe na CI em vez de ser enviado:

```xml
<!-- .editorconfig -- .NET 11 -->
[*.cs]
dotnet_diagnostic.CA2016.severity = error
```

O `CA2016` vem com os analisadores do SDK do .NET, que estão ativados por padrão para projetos que têm como alvo o .NET 11, então você só precisa elevar a severidade. Ele vem com uma correção de código, então no Visual Studio ou com `dotnet format analyzers` você pode repassar automaticamente o token por um arquivo inteiro. O que ele não fará é inventar um token onde o método envolvente não tem nenhum: esse é o caso de tornar o parâmetro não opcional nos métodos internos, para que o compilador force você a adicioná-lo.

Uma nota sobre os pontos cegos do `CA2016`: ele se baseia na convenção do último parâmetro e na presença de uma sobrecarga correspondente. Ele não sinalizará uma chamada que recebe o token em uma posição que não seja a última, e não raciocina sobre o roteamento de `[EnumeratorCancellation]`. Trate-o como uma rede forte para o caso comum, não como uma prova de que cada caminho está coberto.

## Os erros de propagação que impedem os tokens de funcionar

Alguns padrões quebram a propagação mesmo quando o token está tecnicamente presente:

- **Fonte nova por chamada.** Criar `new CancellationTokenSource()` dentro de um método e passar *o* token dele ignora completamente o token do chamador. Vincule, não substitua.
- **`async void`.** Um token não pode se propagar para fora de um método `async void` porque não há `Task` para um chamador aguardar ou observar a `OperationCanceledException`. Mantenha os caminhos de cancelamento em `async Task`: as razões se sobrepõem bastante a [por que async void é quase sempre errado](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).
- **Engolir a `OperationCanceledException`.** Capturá-la e retornar um valor padrão esconde o cancelamento dos chamadores, de modo que um `Task.WhenAll` externo ou um await nunca fica sabendo que a operação parou. Deixe-a subir a menos que você tenha uma razão específica para traduzi-la (como o caso do tempo limite acima).
- **Esquecer a folha síncrona.** Um laço apertado de CPU no fundo de uma cadeia async não tem nenhuma API aguardada para a qual entregar o token. Adicione um explícito `cancellationToken.ThrowIfCancellationRequested()` dentro do laço para que o token ainda tenha um ponto de verificação.

A propagação não é um recurso que você ativa; é uma propriedade que você mantém. Cada novo método async é mais um elo que ou repassa o token ou corta silenciosamente a cadeia. Adicione o parâmetro, repasse-o em cada chamada, deixe o `CA2016` proteger as chamadas que você esquece, e reserve `CancellationToken.None` para a rara operação que você realmente quer que termine não importa o quê.

## Fontes

- [CA2016: Forward the CancellationToken parameter to methods that take one](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2016) -- Microsoft Learn
- [HttpContext.RequestAborted Property](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpcontext.requestaborted) -- Microsoft Learn
- [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) -- Microsoft Learn
- [CancellationTokenSource.CreateLinkedTokenSource](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.createlinkedtokensource) -- Microsoft Learn
- [EnumeratorCancellationAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute) -- Microsoft Learn
</content>
</invoke>
