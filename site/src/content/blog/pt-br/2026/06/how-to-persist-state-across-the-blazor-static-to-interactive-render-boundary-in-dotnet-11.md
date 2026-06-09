---
title: "Como persistir o estado através do limite de renderização estático-para-interativo do Blazor no .NET 11"
description: "Um componente Blazor pré-renderizado executa sua inicialização duas vezes e perde o estado na transição para interativo. Resolva isso com o atributo [PersistentState] ou o serviço PersistentComponentState no .NET 11."
pubDate: 2026-06-09
template: how-to
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "ssr"
lang: "pt-br"
translationOf: "2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-09
---

Um componente Blazor no template Blazor Web App executa sua inicialização duas vezes: uma durante a pré-renderização (renderização estática do lado do servidor) e outra quando o componente renderiza de forma interativa. Tudo o que você buscou ou calculou em `OnInitializedAsync` na primeira vez desaparece na segunda, então o componente busca de novo, e o usuário vê a UI pré-renderizada piscar ao ser substituída. A solução é capturar esse estado durante a pré-renderização e passá-lo para o outro lado do limite. No .NET 11 você tem duas formas de fazer isso: o atributo declarativo `[PersistentState]` (o caminho fácil, disponível desde o .NET 10) e o serviço imperativo `PersistentComponentState` (disponível desde o .NET 8, para tudo o que o atributo não conseguir expressar). Este post tem como alvo o .NET 11 (em versão prévia no momento da escrita, com GA programado para novembro de 2026) e o conjunto de pacotes `Microsoft.AspNetCore.Components` 11.0.x.

## Por que o componente inicializa duas vezes

O template Blazor Web App renderiza uma página em duas passadas. A primeira passada é a pré-renderização: o servidor executa seu componente como HTML estático, executa `OnInitialized` / `OnInitializedAsync` e envia a marcação resultante para que a página seja pintada rápido e indexada bem. A segunda passada é a interatividade: assim que o runtime inicia (um circuito SignalR para `InteractiveServer`, a carga WASM baixada para `InteractiveWebAssembly`, ou qualquer um dos dois para `InteractiveAuto`), o Blazor instancia uma cópia nova do componente e executa a inicialização uma segunda vez.

Essa segunda instância não herda nenhum campo que você definiu durante a pré-renderização. Ela começa a partir dos valores padrão. Se sua inicialização era assim:

```razor
@* PrerenderedCounter1.razor *@
@* .NET 11, Blazor Web App, any interactive render mode *@
@page "/prerendered-counter-1"
@inject ILogger<PrerenderedCounter1> Logger

<p role="status">Current count: @currentCount</p>

@code {
    private int currentCount;

    protected override void OnInitialized()
    {
        currentCount = Random.Shared.Next(100);
        Logger.LogInformation("currentCount set to {Count}", currentCount);
    }
}
```

você verá `currentCount set to 41` durante a pré-renderização e `currentCount set to 92` um instante depois, quando o componente fica interativo, com uma virada visível de 41 para 92 no navegador. Com um número aleatório é apenas uma curiosidade. Com uma chamada ao banco de dados é uma consulta duplicada, um tempo até interativo mais lento e uma piscada real entre o valor pré-renderizado e o rebuscado.

Isso é especificamente o limite de pré-renderização-para-interativo. Se o seu componente `Routes` não tem um render mode e você chega à página por meio de uma [navegação aprimorada](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) interna, a pré-renderização não acontece, então a inicialização executa uma vez e não há nada a persistir. Para reproduzir a dupla inicialização você precisa de um carregamento completo da página.

## A solução declarativa: o atributo `[PersistentState]`

A forma mais limpa de levar o estado para o outro lado do limite no .NET 11 é colocá-lo em uma propriedade pública e anotá-la com `[PersistentState]`. O Blazor serializa a propriedade dentro do HTML pré-renderizado e depois a desserializa de volta na instância interativa antes da inicialização. Seu trabalho é apenas detectar se o valor foi restaurado:

```razor
@* PrerenderedCounter2.razor *@
@* .NET 11 / .NET 10. [PersistentState] requires aspnetcore 10.0+ *@
@page "/prerendered-counter-2"
@inject ILogger<PrerenderedCounter2> Logger

<p role="status">Current count: @CurrentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int? CurrentCount { get; set; }

    protected override void OnInitialized()
    {
        if (CurrentCount is null)
        {
            CurrentCount = Random.Shared.Next(100);
            Logger.LogInformation("CurrentCount set to {Count}", CurrentCount);
        }
        else
        {
            Logger.LogInformation("CurrentCount restored to {Count}", CurrentCount);
        }
    }

    private void IncrementCount() => CurrentCount++;
}
```

Agora o log diz `CurrentCount set to 96` durante a pré-renderização e `CurrentCount restored to 96` quando a interatividade entra. Mesmo valor, sem um segundo `Random.Shared.Next`, sem piscada.

Três regras fazem isso funcionar e são fáceis de tropeçar:

1. **A propriedade deve ser `public`.** O framework usa reflexão sobre ela para serialização, análise de trimming e geração de código-fonte. Um campo `private` com o atributo não será detectado.
2. **Use um tipo anulável ou cujo valor padrão seja detectável.** Você precisa distinguir "restaurado" de "nunca definido". Um tipo anulável (`int?`, `WeatherForecast[]?`) é o sinal idiomático. Para tipos de referência, `null` significa que a pré-renderização precisa preenchê-lo.
3. **Preencha apenas quando for null.** A guarda `if (CurrentCount is null)` é o que mantém o trabalho custoso na passada de pré-renderização e o pula na passada interativa.

A versão realista é um carregamento de dados. Busque na pré-renderização, reutilize no interativo:

```razor
@* ContactList.razor -- .NET 11, InteractiveAuto render mode *@
@page "/contacts"
@inject IContactService Contacts

@if (Items is null)
{
    <p>Loading...</p>
}
else
{
    <ul>@foreach (var c in Items) { <li>@c.Name</li> }</ul>
}

@code {
    [PersistentState]
    public IReadOnlyList<Contact>? Items { get; set; }

    protected override async Task OnInitializedAsync()
    {
        // Runs the query on the prerender pass; the interactive pass
        // gets Items back already populated and skips the call.
        Items ??= await Contacts.GetAllAsync();
    }
}
```

### Manter o estado vinculado à instância correta

Quando uma página renderiza vários componentes do mesmo tipo em um laço, o estado persistido tem que ser correspondido de volta à instância correta. Use a diretiva `@key` para que o Blazor possa alinhar os blobs serializados ao componente certo:

```razor
@* Parent.razor -- .NET 11 *@
@page "/parent"

@foreach (var element in elements)
{
    <PersistentChild @key="element.Name" />
}
```

Dentro de `PersistentChild`, a propriedade `[PersistentState]` é restaurada por chave. Sem `@key`, duas instâncias podem acabar trocando ou perdendo seu estado.

### Dados somente leitura e navegação aprimorada

Por padrão, o estado persistido é carregado apenas quando um componente interativo aparece pela primeira vez na página. Isso é proposital: impede que uma navegação aprimorada posterior à mesma página atropele o estado ao vivo, como um formulário pela metade. Se o seu estado é somente leitura e é barato estar errado sobre ele por um momento (dados em cache que raramente mudam), opte pelas atualizações durante a navegação aprimorada com `AllowUpdates`:

```csharp
// .NET 11 -- allow the value to refresh on enhanced navigation
[PersistentState(AllowUpdates = true)]
public WeatherForecast[]? Forecasts { get; set; }

protected override async Task OnInitializedAsync()
{
    Forecasts ??= await ForecastService.GetForecastAsync();
}
```

Note que a persistência através de navegações aprimoradas é um recurso do .NET 10+. No .NET 8 e .NET 9, o serviço `PersistentComponentState` só entregava estado no carregamento inicial da página, nunca através de uma navegação aprimorada em um circuito já em execução. Se você depende desse comportamento, o .NET 11 é onde ele funciona de forma limpa.

### Pular a restauração em situações específicas

O .NET 10 adicionou um segundo trabalho ao `[PersistentState]`: persistir o estado quando um circuito `InteractiveServer` é despejado e restaurá-lo na reconexão, de modo que uma conexão caída não apague mais o estado do componente. Isso introduz dois casos em que você pode querer abrir mão de uma restauração. `RestoreBehavior` os controla:

```csharp
// Do not restore the prerendered value (start fresh on interactivity)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipInitialValue)]
public string? NoPrerenderedData { get; set; }

// Do not restore the last snapshot on reconnection (force fresh data after a reconnect)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipLastSnapshot)]
public int CounterNotRestoredOnReconnect { get; set; }
```

## A solução imperativa: o serviço `PersistentComponentState`

O atributo cobre a maioria dos casos, mas às vezes você precisa persistir algo que não é uma única propriedade: um valor derivado de vários campos, uma chave que você calcula em tempo de execução, ou estado que você só persiste sob certas condições. Injete o serviço `PersistentComponentState` e registre um callback. Este é o mecanismo original do .NET 8 e ainda funciona no .NET 11 exatamente como antes:

```razor
@* PrerenderedCounter3.razor -- .NET 11, PersistentComponentState service *@
@page "/prerendered-counter-3"
@implements IDisposable
@inject ILogger<PrerenderedCounter3> Logger
@inject PersistentComponentState ApplicationState

<p role="status">Current count: @currentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    private int currentCount;
    private PersistingComponentStateSubscription persistingSubscription;

    protected override void OnInitialized()
    {
        if (!ApplicationState.TryTakeFromJson<int>(
            nameof(currentCount), out var restoredCount))
        {
            currentCount = Random.Shared.Next(100);
            Logger.LogInformation("currentCount set to {Count}", currentCount);
        }
        else
        {
            currentCount = restoredCount!;
            Logger.LogInformation("currentCount restored to {Count}", currentCount);
        }

        // Register LAST to avoid a race condition at app shutdown.
        persistingSubscription = ApplicationState.RegisterOnPersisting(PersistCount);
    }

    private Task PersistCount()
    {
        ApplicationState.PersistAsJson(nameof(currentCount), currentCount);
        return Task.CompletedTask;
    }

    private void IncrementCount() => currentCount++;

    void IDisposable.Dispose() => persistingSubscription.Dispose();
}
```

A forma é sempre a mesma:

1. `TryTakeFromJson<T>("key", out var value)` primeiro. Se retornar `true`, você está na passada interativa e o valor foi restaurado. Se for `false`, você está na passada de pré-renderização e precisa produzir o valor.
2. Registre um callback de persistência com `RegisterOnPersisting` e dentro dele chame `PersistAsJson("key", value)`. Registre-o no **fim** da inicialização para evitar uma condição de corrida durante o encerramento da aplicação.
3. Descarte a `PersistingComponentStateSubscription` para que o callback não vaze. Implementar `IDisposable` não é opcional aqui.

Se você precisa controlar a restauração de forma imperativa do mesmo jeito que `RegisterOnPersisting` controla a persistência, o .NET 10 adicionou `RegisterOnRestoring`, que permite engatar no passo de restauração. Isso combina naturalmente com os cenários de reconexão de circuito acima.

## Persistir estado que vive em um serviço, não em um componente

O estado nem sempre pertence a um componente. Se um serviço de DI com escopo (scoped) contém os dados, você também pode persistir suas propriedades. Marque a propriedade com `[PersistentState]` e registre o serviço para persistência com `RegisterPersistentService`, dizendo ao Blazor a qual render mode ele se aplica (o render mode não pode ser inferido do tipo de serviço):

```csharp
// CounterTracker.cs -- .NET 11
public class CounterTracker
{
    [PersistentState]
    public int CurrentCount { get; set; }

    public void IncrementCount() => CurrentCount++;
}
```

```csharp
// Program.cs -- .NET 11
using Microsoft.AspNetCore.Components.Web;

builder.Services.AddScoped<CounterTracker>();

builder.Services.AddRazorComponents()
    .RegisterPersistentService<CounterTracker>(RenderMode.InteractiveAuto);
```

Apenas serviços com escopo (scoped) são suportados. O argumento de render mode (`RenderMode.Server`, `RenderMode.Webassembly` ou `RenderMode.InteractiveAuto`) decide quais contextos interativos recebem o estado desserializado. Como a serialização funciona a partir da instância real, você pode marcar uma abstração como o serviço persistente e manter a implementação concreta como internal, o que é útil quando o servidor de pré-renderização e o cliente WebAssembly compartilham uma interface, mas não a implementação.

## O que trafega pela rede e a linha de segurança que você não pode cruzar

O estado persistido é incorporado no HTML e transferido para o cliente. Onde ele aterrissa depende do render mode, e esse é o único erro que transforma uma conveniência em um vazamento:

- **`InteractiveServer`**: o estado vai e volta pelo navegador, mas é protegido pelo [ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/introduction), então está criptografado em trânsito.
- **`InteractiveWebAssembly` e `InteractiveAuto`**: o estado é exposto ao navegador em texto claro, porque o código WebAssembly executa no cliente e precisa lê-lo. O modo `Auto` pode resolver para WebAssembly, então trate-o como o caso CSR.

A regra: nunca coloque nada privado no estado persistido de um componente WebAssembly ou Auto. Persista a lista de contatos, não o token de acesso. Se você precisa de segredos somente do servidor, mantenha-os no servidor e busque-os depois da interatividade, ou fique no `InteractiveServer`.

## Serialização, trimming e Native AOT

Por padrão, `[PersistentState]` e `PersistAsJson` serializam com `System.Text.Json` usando as configurações padrão. Isso tem duas consequências que vale a pena planejar.

Primeiro, o serializador padrão não é seguro para trimming. Se você publica com trimming de IL ou [Native AOT](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), você deve preservar os tipos que persiste ou o ida e volta vai falhar em tempo de execução assim que os metadados forem removidos. Configure um gerador de código-fonte `JsonSerializerContext` para seus tipos persistidos, a mesma disciplina que você aplicaria ao [escrever um JsonConverter personalizado para System.Text.Json](/pt-br/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

Segundo, se a forma JSON padrão não te serve (um formato binário compacto, uma codificação legada, um tipo que o System.Text.Json trata de forma desajeitada), o .NET 10 introduziu `PersistentComponentStateSerializer<T>` para que você possa assumir o controle da serialização de um tipo específico:

```csharp
// Registered in Program.cs; applies to int? persisted state
builder.Services.AddSingleton<PersistentComponentStateSerializer<int?>,
    CustomIntSerializer>();
```

O serializador implementa `Persist(T value, IBufferWriter<byte> writer)` e `Restore(ReadOnlySequence<byte> data)`. Sem um serializador personalizado registrado para um tipo, o Blazor recorre ao JSON, então você só implementa isso para os tipos que precisam.

## Componentes incorporados em Razor Pages ou MVC

Um detalhe que não se aplica ao template Blazor Web App, mas que pega as pessoas ao incorporar Blazor em uma aplicação existente: se você solta componentes interativos dentro de uma view de Razor Pages ou MVC, o mecanismo de persistência precisa que o tag helper seja adicionado manualmente. Coloque `<persist-component-state />` logo antes do `</body>` de fechamento no seu layout:

```cshtml
@* Pages/Shared/_Layout.cshtml -- only needed for Razor Pages / MVC hosts *@
<body>
    ...
    <persist-component-state />
</body>
```

Projetos Blazor Web App puros conectam isso automaticamente; você só precisa do tag helper no caso de hosting misto.

## Como escolher entre os dois modelos

Recorra primeiro a `[PersistentState]`. É menos código, lida com o limite de pré-renderização e com a reconexão de circuito de graça, e `AllowUpdates` mais `RestoreBehavior` cobrem as variações comuns de forma declarativa. Desça para o serviço `PersistentComponentState` quando a unidade de estado não for uma única propriedade pública, quando você calcular a chave de persistência em tempo de execução, ou quando você precisar persistir condicionalmente dentro do callback. Ambos podem coexistir na mesma aplicação, e ambos resolvem o mesmo problema subjacente: garantir que o trabalho que você fez durante a pré-renderização sobreviva ao salto para a interatividade em vez de rodar tudo de novo.

Se você ainda está decidindo quais render modes suas páginas devem usar, os trade-offs em [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) enquadram onde a pré-renderização sequer se aplica, e se você está movendo uma aplicação mais antiga para esse modelo, a [checklist de migração de Blazor Server para Blazor Web App](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) aponta a dupla execução da pré-renderização como a única coisa que pega. Para passar mensagens de uso único em vez de persistir o estado de renderização, [o suporte a TempData no Blazor SSR no .NET 11](/pt-br/2026/04/blazor-ssr-tempdata-dotnet-11/) é a ferramenta certa no lugar.

Fonte primária: [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0) no Microsoft Learn, que documenta o atributo `[PersistentState]`, o serviço `PersistentComponentState`, `RegisterPersistentService` e o ponto de extensibilidade `PersistentComponentStateSerializer<T>` para .NET 10 e .NET 11.
