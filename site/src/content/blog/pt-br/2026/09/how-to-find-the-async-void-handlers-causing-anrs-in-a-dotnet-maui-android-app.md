---
title: "Como encontrar os manipuladores async void que causam ANR em um app Android do .NET MAUI"
description: "O Play Console diz que sua taxa de ANR passou de 0.47% e entrega uma stack trace nativa cheia de frames de libcoreclr.so. Veja como sair dessa trace inútil e chegar ao manipulador de evento async void exato que travou a thread principal, usando um printer de Looper, um wrapper de SynchronizationContext que nomeia a máquina de estados e o dotnet-trace via dsrouter."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "maui"
  - "android"
  - "async"
  - "performance"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-09-07
---

Resposta curta: a stack trace de ANR que o Google Play entrega não vai nomear o seu método C#, então pare de lê-la como se fosse. Enumere todo `async void` da base de código com o VSTHRD100, reduza aos que estão ligados a eventos de interface e então instale duas coisas em um build Release: um `Android.Util.IPrinter` no `Looper` principal que mede o tempo de cada mensagem da thread principal, e um wrapper de `SynchronizationContext` que lê a máquina de estados assíncrona empacotada na continuação publicada, para que a linha de log diga `MainPage+<OnSyncClicked>d__7` em vez de um Runnable anônimo. O primeiro pega o trabalho feito antes do primeiro `await`, o segundo pega o trabalho feito depois. Juntos, eles dão um nome de método.

Este artigo tem como alvo o .NET 11 (`11.0.100-preview.7`, lançado em 2026-08-11, GA prevista para 2026-11-10) com .NET MAUI 11 em `net11.0-android`, onde o CoreCLR é o único runtime móvel. Tudo aqui também funciona no .NET 10 com Mono; as diferenças estão marcadas onde importam.

## Por que `async void` aparece nos relatórios de ANR

`async void` não bloqueia uma thread por conta própria. Ele causa ANR de forma indireta, por três mecanismos que terminam todos no mesmo lugar.

**O prefixo síncrono roda na thread de quem chamou.** Um método `async` não cede o controle na chave de abertura. Ele executa direto até encontrar um `await` sobre algo que ainda não foi concluído. Em um manipulador de clique na thread principal do Android, cada linha antes desse primeiro ponto de suspensão real é trabalho da thread principal, e a palavra-chave `async` na assinatura faz parecer que não é.

```csharp
// MainPage.xaml.cs, .NET 11, net11.0-android, MAUI 11
private async void OnSyncClicked(object sender, EventArgs e)
{
    using var db = new SqliteConnection(_dbPath);   // opens the file, ~40 ms cold
    var orders = db.Query<Order>(
        "select * from Orders where Status = 0");    // 3-9 s on a 40k-row table
    await RenderAsync(orders);                       // the first real await, far too late
}
```

Cinco segundos disso e o despachante de entrada do Android desiste. O `await` da última linha não está ajudando em nada.

**Ele tira de quem chama a possibilidade de aguardar, então alguém adiciona um bloqueio.** Como um método `async void` não devolve nada aguardável, no momento em que um segundo trecho de código precisa do resultado dele, o caminho de menor resistência é `.Result` ou `.Wait()`. Em uma thread com um `SynchronizationContext` que redireciona as continuações de volta para si mesma, isso é o [deadlock assíncrono clássico](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/), e no Android a thread em deadlock é justamente a que o Android está cronometrando.

```csharp
private async void OnRefreshClicked(object sender, EventArgs e)
{
    // The handler could not be awaited, so this got "fixed" by blocking.
    var settings = _settings.LoadAsync().Result;   // main thread parked, permanently
    await ReloadAsync(settings);
}
```

**Ele é reentrante.** Nada impede que um segundo toque inicie uma segunda invocação enquanto a primeira está suspensa. Duas execuções sobrepostas disputam o mesmo `SemaphoreSlim` ou a mesma `SQLiteConnection`, e essa disputa aparece como um travamento da thread principal que só reproduz com um toque duplo rápido. Se você quer o tratamento completo de quando a construção é legítima, veja [async void vs async Task em C#: quando cada um é correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## O que o Android está realmente medindo

Conhecer o orçamento exato diz quais manipuladores valem investigação. Conforme a [documentação de ANR do Android](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs):

| Gatilho | Tempo limite |
| --- | --- |
| Despacho de entrada (toque, tecla) | 5 segundos |
| Broadcast receiver com `FLAG_RECEIVER_FOREGROUND` | 10 s no Android 13 e anteriores, 10-20 s no Android 14+ |
| Broadcast receiver com prioridade de segundo plano | 60 s no Android 13 e anteriores, 60-120 s no Android 14+ |
| `onCreate` / `onStartCommand` / `onBind` de serviço em primeiro plano | 20 segundos |
| Serviço em segundo plano | 200 segundos |

O despacho de entrada é o que morde apps MAUI, e é o que os usuários veem, porque por definição o app estava em primeiro plano e sendo tocado. As apostas são definidas pelo Play: a taxa de ANR percebida pelo usuário é uma métrica central com limite de mau comportamento de 0.47% no geral, avaliada em uma janela móvel de 28 dias, e ultrapassá-lo torna seu app menos descobrível em todos os dispositivos ([requisitos de qualidade técnica do Play Console](https://support.google.com/googleplay/android-developer/answer/17492799)).

## Por que a trace que o Play entrega não basta

Extraia o registro do ANR e olhe a thread principal. Em um dispositivo ao qual você tem acesso:

```sh
# Everything in the device's dropbox, newest last
adb shell dumpsys dropbox --print data_app_anr | tail -300

# Or the full set, which is what you want for a device that has been running a while
adb bugreport anr.zip
unzip -o anr.zip -d anr && ls anr/FS/data/anr/
```

O cabeçalho informa o gatilho:

```
ANR in com.example.orders (com.example.orders/crc64e1fb321c08285b90.MainActivity)
PID: 14882
Reason: Input dispatching timed out (Waited 5003ms for MotionEvent)
```

A stack trace da thread principal, porém, é gerada pelo ART, que resolve símbolos de frames Java. Seu manipulador não é um frame Java. Em um app Android sobre CoreCLR, você recebe algo com este formato:

```
"main" prio=5 tid=1 Native
  #00 pc 00000000000a1b3c  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+28)
  #01 pc 00000000004f21d8  /data/app/.../lib/arm64/libcoreclr.so (???)
  #02 pc 00000000004e0a44  /data/app/.../lib/arm64/libcoreclr.so (???)
  at crc64e1fb321c08285b90.MainActivity.n_onCreate(Native method)
  at android.os.Handler.dispatchMessage(Handler.java:106)
  at android.os.Looper.loop(Looper.java:294)
```

Essa é toda a história que você recebe: frames nativos sem nome dentro de `libcoreclr.so` (`libmonosgen-2.0.so` se você ainda estiver no Mono sob .NET 10). Não é inútil. Isso classifica o problema em um de três grupos:

- Frames parados em `syscall`, `futex_wait` ou `pthread_cond_wait` sob o runtime: a thread principal está **bloqueada**, o que significa um lock, um `.Result`, um `.Wait()` ou um `SemaphoreSlim.Wait()`.
- Frames girando dentro de `libcoreclr.so` sem nenhuma chamada de sistema por cima: a thread principal está **executando código gerenciado**, o que significa trabalho limitado por CPU em um manipulador.
- `android.os.MessageQueue.nativePollOnce` no topo: a thread principal estava **ociosa** quando o dump foi tirado. O ANR está em outro lugar, ou o dump chegou atrasado. O Android documenta isso explicitamente, e caçar seus manipuladores com essa assinatura é esforço desperdiçado.

Existe um quarto formato que vale reconhecer antes de começar: uma pilha parada dentro de `coreclr_initialize` logo após uma inicialização a frio. Isso não é o seu código, é a regressão de inicialização do CoreCLR registrada em [dotnet/android#10588](https://github.com/dotnet/android/issues/10588), onde um app grande que iniciava em um segundo com Mono pode levar cerca de seis com CoreCLR e estourar o orçamento do sistema operacional. Esses casos se agrupam separadamente no vitals sob `handleBindApplication`. Se esse for o seu formato, a correção é o trabalho de inicialização coberto em [migrar um app Android do MAUI de Mono para CoreCLR](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/), não a triagem de manipuladores.

## O fluxo de triagem em cinco passos

1. **Enumere toda declaração e todo delegate `async void` da solução.** Adicione `Microsoft.VisualStudio.Threading.Analyzers` e transforme VSTHRD100 (métodos async void) e VSTHRD101 (delegates e lambdas async void) em avisos de compilação. Isso dá o conjunto completo de candidatos em um único build, incluindo as lambdas `async` atribuídas a `EventHandler` que uma busca textual não encontra.
2. **Classifique os candidatos pela possibilidade de rodarem na thread principal.** Só manipuladores alcançáveis a partir de um evento de interface, de um callback de ciclo de vida `Loaded`/`Appearing` ou do corpo de um `MainThread.BeginInvokeOnMainThread` podem produzir um ANR de despacho de entrada. Todo o resto é um problema de correção, não um ANR.
3. **Instrumente o `Looper` principal em um build Release** para que toda mensagem da thread principal que ultrapasse um limite seja registrada com sua duração. Isso pega o prefixo síncrono, que nunca toca o `SynchronizationContext` e por isso é invisível para todas as outras técnicas aqui.
4. **Envolva o `SynchronizationContext` da thread principal** para que continuações lentas retomadas registrem o nome da máquina de estados assíncrona à qual pertencem. Este é o passo que transforma uma duração em um nome de método.
5. **Confirme com `dotnet-trace` via `dotnet-dsrouter`** e leia o flame graph da thread principal, para que a correção seja medida em vez de presumida.

## Passos 1 e 2: a passada estática

```xml
<!-- MyApp.csproj, .NET 11 -->
<ItemGroup>
  <PackageReference Include="Microsoft.VisualStudio.Threading.Analyzers" Version="17.14.15">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

```ini
# .editorconfig
dotnet_diagnostic.VSTHRD100.severity = warning   # Avoid async void methods
dotnet_diagnostic.VSTHRD101.severity = warning   # Avoid unsupported async delegates
```

Depois despeje a lista:

```sh
dotnet build -c Release -f net11.0-android -warnaserror:none \
  | grep -E 'VSTHRD10[01]' | sort -u
```

Espere ruído. O VSTHRD100 dispara também em manipuladores de evento legítimos, que é a reclamação antiga em [microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510): o analisador não tem como saber que um método cuja assinatura é `(object, EventArgs)` é obrigado a ser `void`. Não suprima e siga em frente. O objetivo do passo 1 é o inventário, e o passo 2 é onde você filtra, na mão, até sobrarem os manipuladores que podem executar na thread principal. Em um app MAUI de porte médio típico, uma lista de 60 itens do VSTHRD100 encolhe para 8 ou 10 candidatos reais.

O `AsyncFixer03`, do pacote AsyncFixer, relata o mesmo formato "dispare e esqueça" se você preferir não adicionar a dependência do vs-threading. Qualquer um serve; não rode os dois, ou você vai triar cada achado duas vezes.

## Passo 3: medir cada mensagem da thread principal

`Looper.setMessageLogging` escreve uma linha no início e no fim de cada despacho de mensagem. Subtrair os carimbos de tempo dá a duração exata de cada unidade de trabalho da thread principal, incluindo o prefixo síncrono de um manipulador.

```csharp
// Platforms/Android/MainThreadWatchdog.cs, .NET 11, net11.0-android
using Android.OS;
using Android.Util;

sealed class MainThreadWatchdog(long thresholdMs) : Java.Lang.Object, IPrinter
{
    private long _startedAt;
    private string? _current;

    public void Println(string? message)
    {
        if (string.IsNullOrEmpty(message))
            return;

        // Looper emits ">>>>> Dispatching to <handler> <callback>: <what>"
        // then "<<<<< Finished to <handler> <callback>".
        if (message[0] == '>')
        {
            _current = message;
            _startedAt = SystemClock.UptimeMillis();
            return;
        }

        var elapsed = SystemClock.UptimeMillis() - _startedAt;
        if (elapsed >= thresholdMs)
            Log.Warn("anr-hunt", $"main thread busy {elapsed} ms: {_current}");
        _current = null;
    }
}
```

Instale cedo, e apenas em um build que você pretende descartar:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(thresholdMs: 300));
#endif
}
```

Depois observe sob uso real:

```sh
adb logcat -s anr-hunt:W
```

Um limite de 300 ms é agressivo de propósito. Um ANR de despacho de entrada precisa de 5000 ms, mas um manipulador que custa 400 ms no seu celular de desenvolvimento vai custar vários segundos em um aparelho de quatro anos atrás com o cache de páginas frio, e é desses aparelhos que vem o seu número de vitals.

O que isso dá é uma duração e uma string com o alvo do Looper. O que não dá é um nome de método C#: uma continuação publicada pelo runtime chega como um wrapper genérico `Java.Lang.IRunnable`, então o campo `<callback>` aparece como um tipo opaco `crc64...`. É para isso que serve o passo 4.

## Passo 4: nomear a máquina de estados

`Task` publica suas continuações por meio de `SynchronizationContext.Post`, e na thread principal do Android esse contexto é o que redireciona de volta para o `Handler` principal. Envolva-o e você poderá inspecionar o estado publicado antes de repassá-lo.

A sutileza é que o delegate `SendOrPostCallback` não é o seu método. O runtime usa um único callback estático compartilhado e passa a continuação real em `state`, como uma `Action` cujo alvo é a máquina de estados assíncrona empacotada. Esse pacote é um tipo genérico cujo argumento de tipo é a struct gerada pelo compilador para o seu método, e o nome dele contém o nome do método original.

```csharp
// Platforms/Android/AnrHuntingSyncContext.cs, .NET 11
using System.Diagnostics;
using Android.Util;

sealed class AnrHuntingSyncContext(SynchronizationContext inner, long thresholdMs)
    : SynchronizationContext
{
    public override void Post(SendOrPostCallback d, object? state)
    {
        var origin = Describe(d, state);
        inner.Post(_ =>
        {
            var sw = Stopwatch.StartNew();
            d(state);
            if (sw.ElapsedMilliseconds >= thresholdMs)
                Log.Warn("anr-hunt", $"continuation {sw.ElapsedMilliseconds} ms: {origin}");
        }, null);
    }

    public override SynchronizationContext CreateCopy() =>
        new AnrHuntingSyncContext(inner.CreateCopy(), thresholdMs);

    // Best effort. Reads the boxed state machine the runtime passes as `state`;
    // this is an implementation detail, so fall back to the delegate's method.
    private static string Describe(SendOrPostCallback d, object? state)
    {
        if (state is Action a && a.Target is { } box)
        {
            var t = box.GetType();
            if (t.IsGenericType)
                // AsyncStateMachineBox`1[MyApp.MainPage+<OnSyncClicked>d__7]
                return t.GetGenericArguments()[0].FullName ?? t.Name;
            return t.FullName ?? t.Name;
        }
        return $"{d.Method.DeclaringType?.FullName}.{d.Method.Name}";
    }
}
```

Instale na thread principal, depois que o MAUI montou o próprio contexto:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(300));
    SynchronizationContext.SetSynchronizationContext(
        new AnrHuntingSyncContext(SynchronizationContext.Current!, thresholdMs: 300));
#endif
}
```

A linha de log que você está caçando tem esta cara, e é o objetivo de todo o exercício:

```
W anr-hunt: continuation 4412 ms: MyApp.MainPage+<OnSyncClicked>d__7
```

Três restrições, todas relevantes:

- Só passam pelo wrapper as continuações cujo `await` capturou o contexto **depois** de você instalá-lo. Instale em `OnCreate`, antes de a primeira página ser construída.
- `MainThread.BeginInvokeOnMainThread` e o `IDispatcher` do MAUI publicam direto no `Handler` do Android, não pelo `SynchronizationContext`, então eles escapam inteiramente deste wrapper. O printer do Looper do passo 3 ainda os vê, e é por isso que você roda os dois.
- Código que aguarda com [`ConfigureAwait(false)`](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/) não captura o contexto de forma alguma, e sua continuação é corretamente invisível aqui. Esse é o comportamento desejado: ela não está retomando na thread principal.

## Passo 5: confirmar com `dotnet-trace`

Quando tiver um suspeito, meça. Sob CoreCLR no .NET 11 o componente de diagnóstico já vem embutido no runtime, então `EnableDiagnostics` não é necessário (no .NET 10 com Mono é, e ele coloca `libmono-component-diagnostics_tracing.so` no pacote).

```sh
# .NET 11, dotnet-trace and dotnet-dsrouter 9.0.652701 or newer
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-dsrouter

# Physical Android device. Use 10.0.2.2 instead of 127.0.0.1 on an emulator.
dotnet build -t:Run -c Release -f net11.0-android \
  -p:DiagnosticAddress=127.0.0.1 -p:DiagnosticPort=9000 \
  -p:DiagnosticSuspend=false -p:DiagnosticListenMode=connect

dotnet-trace collect --dsrouter android --format speedscope
```

Navegue até a tela, toque no botão, pressione Enter para parar e abra o `.speedscope.json` em [speedscope.app](https://speedscope.app/). Selecione a thread principal, mude para a visão sandwich e ordene por tempo próprio. O frame que você procura é `MainPage.OnSyncClicked` com um bloco largo e contínuo, e logo abaixo o que realmente está consumindo o tempo.

Faça profiling apenas de builds `Release`. Builds Debug no Android rodam sob o interpretador (`UseInterpreter=true`) para hot reload, e os tempos que saem dali são ficção.

## As correções, na ordem em que você deve tentá-las

Uma vez nomeado o manipulador, o conserto é quase sempre uma de quatro coisas.

**Transforme o manipulador em uma casca fina sobre um método que devolve `Task`.** A assinatura do evento obriga `void`, mas nada obriga o corpo a ser longo.

```csharp
// The only line allowed to be async void.
private void OnSyncClicked(object sender, EventArgs e) => _ = SyncAsync();

private async Task SyncAsync()
{
    _syncButton.IsEnabled = false;                    // re-entrancy guard
    try
    {
        var orders = await Task.Run(() => _repo.LoadPendingOrders());
        await RenderAsync(orders);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "sync failed");           // an async void body cannot do this
    }
    finally
    {
        _syncButton.IsEnabled = true;
    }
}
```

**Empurre o prefixo síncrono para o thread pool.** `Task.Run` é a ferramenta certa aqui justamente porque o trabalho é limitado por CPU ou por IO bloqueante e no momento roda na thread de interface. É esse o caso para o qual `Task.Run` existe.

**Remova a chamada bloqueante.** Se o manipulador contém `.Result`, `.Wait()` ou `GetAwaiter().GetResult()`, nada da instrumentação acima importa até isso sumir. A versão mecânica está coberta em [migrar de chamadas bloqueantes .Result/.Wait() para async em toda a cadeia](/pt-br/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/).

**Faça binding a um command em vez de um evento.** O `AsyncRelayCommand` do MVVM Community Toolkit devolve uma `Task` que o framework observa, o que elimina o `async void` do seu código por completo e dá `IsRunning` de graça como guarda de reentrância.

## Armadilhas que custam uma tarde

**Um descarte `_ =` do tipo dispare e esqueça ainda engole exceções.** A casca acima registra dentro de `SyncAsync`, e é isso que a torna segura. Um `_ = SomethingAsync()` pelado sem um `try` dentro tem o mesmo risco de exceção não observada que `async void`, só que mais silencioso, e o compilador não vai avisar porque o descarte suprime o [CS4014](/pt-br/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/).

**O `StrictMode` não vai achar isso.** `StrictMode.ThreadPolicy` com `DetectAll()` pega acesso a disco e rede na thread principal, o que é uma verificação adjacente útil, mas é cego para trabalho gerenciado limitado por CPU e para uma thread bloqueada em um lock gerenciado. Ambos são causas de ANR.

**Seu cluster de ANR pode não ser um manipulador.** Confira o frame do topo do cluster no vitals antes de gastar um dia nisso. `handleBindApplication` significa inicialização lenta. `nativePollOnce` significa que a thread principal estava ociosa. Só os formatos ocupado ou bloqueado apontam para um manipulador.

**Não envie a instrumentação a lugar nenhum.** O printer do `Looper` aloca uma string por mensagem e o wrapper de `SynchronizationContext` adiciona um `Stopwatch` e um closure por continuação publicada. Ambos são baratos o bastante para ficarem ligados durante uma sessão de depuração sobre um build Release, e ambos são inaceitáveis em produção. Feche-os atrás de uma constante definida pelo MSBuild (`<DefineConstants>$(DefineConstants);ANR_HUNT</DefineConstants>` em uma configuração de build dedicada) para que o código não chegue à Play Store por acidente.

**Fique de olho no nível de API.** Os orçamentos de broadcast receiver apertaram no Android 14, e um receiver que estava confortavelmente abaixo de 10 segundos agora pode ser empurrado para a janela de 10-20 segundos sob pressão de CPU. Se você mudou o target recentemente, confira com [o que muda no nível de API 36](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

O padrão por trás de tudo isso é que `async void` não é o bug. É a construção que torna o bug invisível: ela remove o valor de retorno que teria permitido a quem chamou aguardar, o caminho de exceção que teria avisado que falhou e o aviso do compilador que teria sinalizado. Nomear a máquina de estados é como você recupera essa visibilidade.

## Relacionados

- [async void vs async Task em C#: quando cada um é correto](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Solução: deadlock ao chamar .Result ou .Wait() em um método async em C#](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Migre um app Android do .NET MAUI de Mono para CoreCLR no .NET 11](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)
- [ConfigureAwait(false) vs o padrão no .NET 11: ainda importa?](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Migrar de chamadas bloqueantes .Result/.Wait() para async em toda a cadeia em uma base de código C# legada](/pt-br/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)

## Fontes

- [Diagnose and fix ANRs, Android Developers](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs)
- [ANRs, documentação de qualidade de apps do Android](https://developer.android.com/topic/performance/vitals/anr)
- [Requisitos de qualidade técnica do Play Console](https://support.google.com/googleplay/android-developer/answer/17492799)
- [Profiling de desempenho no .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/profiling)
- [Documentação do dotnet-dsrouter, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter)
- [Tracing .NET for Android applications, dotnet/android](https://github.com/dotnet/android/blob/main/Documentation/guides/tracing.md)
- [Documentação dos analisadores VSTHRD100 e VSTHRD101, microsoft/vs-threading](https://github.com/microsoft/vs-threading/blob/main/docfx/analyzers/index.md)
- [Falso positivo do VSTHRD100 em manipuladores de evento, microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510)
- [CoreCLR ANR while running large app, dotnet/android#10588](https://github.com/dotnet/android/issues/10588)
- [Capturar e ler relatórios de bug, documentação do Android Studio](https://developer.android.com/studio/debug/bug-report)
