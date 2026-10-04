---
title: "Como detectar eventos de bloqueio, desbloqueio, logon e logoff da sessão do Windows em um app C#"
description: "Use SystemEvents.SessionSwitch em um app desktop ou de console, sobrescreva OnSessionChange em um serviço do Windows ou intercepte WM_WTSSESSION_CHANGE você mesmo. Cobre código .NET 10 para as três abordagens, a thread oculta '.NET System Events', por que serviços veem o logon e apps desktop não, notificações fora de ordem e como consultar o estado atual de bloqueio com WTSQuerySessionInformation."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "windows"
  - "worker-service"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-04
---

Resposta curta: em um processo que roda dentro da sessão do usuário (WinForms, WPF ou um app de console simples), assine `Microsoft.Win32.SystemEvents.SessionSwitch` e faça um switch em `e.Reason`: `SessionLock`, `SessionUnlock`, `SessionLogon`, `SessionLogoff`, além dos valores de conexão e desconexão do console e remotas. Em um serviço do Windows, defina `CanHandleSessionChangeEvent = true` e sobrescreva `ServiceBase.OnSessionChange`, o que, com o host genérico do .NET, significa criar uma subclasse de `WindowsServiceLifetime`. Ambos são wrappers finos sobre a mesma notificação Win32, `WM_WTSSESSION_CHANGE`, que você também pode interceptar diretamente a partir de um procedimento de janela. Para perguntar "a sessão está bloqueada agora?" em vez de esperar por um evento, chame `WTSQuerySessionInformation` com `WTSSessionInfoEx`.

O código deste post usa .NET 10 (SDK 10.0.302) com `Microsoft.Win32.SystemEvents` 10.0.12 e `Microsoft.Extensions.Hosting.WindowsServices` 10.0.12. Cada trecho foi compilado contra `net10.0-windows`, e as afirmações sobre threading vêm do código-fonte do `dotnet/runtime` desses pacotes, que linko no final. As APIs por baixo não mudaram desde o Windows Vista, então a mesma abordagem funciona no .NET 8, no .NET 9 e no .NET 11 RC.

## Qual API vê qual evento

O Windows dispara uma notificação por mudança de estado da sessão, e cada API gerenciada é uma forma diferente de recebê-la. Os valores são os mesmos em todo lugar, o que ajuda quando você mistura abordagens:

| Valor | `SessionSwitchReason` / `SessionChangeReason` | Significado |
|---|---|---|
| 1 | `ConsoleConnect` | Uma sessão se conectou ao console físico |
| 2 | `ConsoleDisconnect` | Uma sessão se desconectou do console (troca rápida de usuário) |
| 3 | `RemoteConnect` | Uma sessão se conectou via Remote Desktop |
| 4 | `RemoteDisconnect` | Um cliente de Remote Desktop se desconectou |
| 5 | `SessionLogon` | Um usuário fez logon |
| 6 | `SessionLogoff` | Um usuário fez logoff |
| 7 | `SessionLock` | A sessão foi bloqueada |
| 8 | `SessionUnlock` | A sessão foi desbloqueada |
| 9 | `SessionRemoteControl` | O status de controle remoto mudou |

A diferença importante não está nos valores, mas em *quem* os recebe. Uma janela registrada com `NOTIFY_FOR_THIS_SESSION` só fica sabendo da própria sessão. Um serviço do Windows roda na sessão 0 e recebe notificações de todas as sessões da máquina. Isso tem uma consequência em que as pessoas tropeçam o tempo todo: **um app desktop nunca vê o próprio `SessionLogon`**, porque foi iniciado depois que o logon aconteceu, e raramente vê o próprio `SessionLogoff`, porque está sendo encerrado nesse momento. Se "logon" e "logoff" são o que você realmente precisa, você quer um serviço, ou `SystemEvents.SessionEnding` para o lado do logoff. Bloqueio e desbloqueio funcionam bem nos dois.

## Apps desktop e de console: SystemEvents.SessionSwitch

Para WinForms e WPF, `Microsoft.Win32.SystemEvents` já faz parte do shared framework do Windows Desktop. Para um app de console ou uma biblioteca, adicione o pacote:

```xml
<!-- SessionWatch.csproj, .NET 10 SDK -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Win32.SystemEvents" Version="10.0.12" />
  </ItemGroup>
</Project>
```

O TFM `-windows` não é estritamente necessário: o pacote também inclui um assembly `net10.0` simples. No Linux e no macOS esse assembly é um stub que lança `PlatformNotSupportedException`, então mirar `net10.0-windows` transforma uma surpresa em runtime em um aviso do analisador CA1416 no ponto de chamada. `AllowUnsafeBlocks` só é necessário para o código com `LibraryImport` mais adiante no post.

O evento em si ocupa poucas linhas:

```csharp
// .NET 10, C# 14, Microsoft.Win32.SystemEvents 10.0.12
using Microsoft.Win32;

Console.WriteLine($"Locked right now: {SessionState.IsLocked()}");

SessionSwitchEventHandler onSwitch = (_, e) =>
{
    // Runs on the ".NET System Events" thread, not the main thread.
    Console.WriteLine($"{DateTime.Now:HH:mm:ss} {e.Reason} (thread: {Thread.CurrentThread.Name})");
};

SessionEndedEventHandler onEnded = (_, e) =>
    Console.WriteLine($"{DateTime.Now:HH:mm:ss} session ending: {e.Reason}");

SystemEvents.SessionSwitch += onSwitch;
SystemEvents.SessionEnded += onEnded;

try
{
    Console.WriteLine("Lock the workstation (Win+L), then unlock. Press Enter to quit.");
    Console.ReadLine();
}
finally
{
    // Static events root your handler (and everything it captures) forever.
    SystemEvents.SessionSwitch -= onSwitch;
    SystemEvents.SessionEnded -= onEnded;
}
```

Pressione Win+L e desbloqueie, e você recebe `SessionLock` seguido de `SessionUnlock`. Troque de usuário com a troca rápida de usuário e você recebe `ConsoleDisconnect` ao sair e `ConsoleConnect` ao voltar, geralmente junto com o bloqueio e o desbloqueio. Conecte-se via RDP na máquina como o mesmo usuário e essa sessão reporta `ConsoleDisconnect` seguido de `RemoteConnect`.

### De onde vem o loop de mensagens

Respostas mais antigas sobre esse tema dizem que `SessionSwitch` "só funciona se você tiver um loop de mensagens", e a página do MS Learn para o evento ainda traz essa observação. No .NET moderno isso é só meia verdade. Desde o .NET 6 (dotnet/runtime PR #53467, "Always spawn message loop thread for SystemEvents"), a primeira assinatura de qualquer evento de `SystemEvents` cria uma janela `WS_POPUP` oculta em uma thread de segundo plano dedicada chamada `.NET System Events` e executa `GetMessage`/`DispatchMessage` nela. O comentário no código-fonte é explícito: ele sempre cria a própria thread, mesmo quando a thread chamadora é STA, porque não há garantia de que essa thread continuará processando mensagens. Assim, um app de console sem UI recebe os eventos sem nenhum trabalho extra.

Assinar `SessionSwitch` especificamente também chama `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` para essa janela oculta. É daí que vem o escopo "somente esta sessão".

### Em qual thread o seu handler roda

Quando você assina, `SystemEvents` captura `AsyncOperationManager.SynchronizationContext` e depois chama `Send` nele:

- No WinForms ou no WPF, assinar a partir da thread de UI captura o contexto de UI, então o seu handler é encaminhado para a thread de UI. Você pode mexer nos controles diretamente.
- Em um app de console ou worker, não há contexto, então o capturado é um `SynchronizationContext` simples cujo `Send` roda inline. O seu handler executa na thread `.NET System Events`.

O segundo caso importa. Essa thread também é a que despacha `PowerModeChanged`, `UserPreferenceChanged`, `DisplaySettingsChanged` e o resto. Se o seu handler de bloqueio faz uma chamada HTTP bloqueante ou espera por um lock, todos os outros eventos de sistema do processo esperam também. Repasse o trabalho imediatamente, por exemplo para um `Channel<T>` (o padrão de [usar channels em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) se encaixa perfeitamente aqui) ou para `Task.Run`.

### O vazamento do evento estático

`SessionSwitch` é um evento estático. Um handler que captura `this` mantém o grafo de objetos inteiro vivo até você cancelar a assinatura, que é a forma clássica de uma janela WPF fechada acabar sobrevivendo durante toda a vida do processo. As observações do MS Learn alertam sobre isso explicitamente. Cancele a assinatura em `Dispose`, `OnClosed` ou em um `finally`, e se você estiver caçando uma janela que não morre, [uma comparação com `dotnet-gcdump`](/pt-br/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) vai mostrar `SystemEvents` segurando-a.

## Serviços do Windows: OnSessionChange e o host genérico

Um serviço não consegue usar `SystemEvents.SessionSwitch` de forma útil. Ele roda na sessão 0, então `NOTIFY_FOR_THIS_SESSION` restringe a janela oculta à sessão 0, onde ninguém bloqueia ou desbloqueia nada. A documentação de `WTSRegisterSessionNotification` diz isso claramente: serviços recebem essas notificações pelo seu handler de controle de serviço (`HandlerEx` com `SERVICE_CONTROL_SESSIONCHANGE`), não por uma janela.

`System.ServiceProcess.ServiceBase` já faz essa ligação. Você opta por ela com `CanHandleSessionChangeEvent = true` e sobrescreve `OnSessionChange(SessionChangeDescription)`, que entrega o `Reason` e o `SessionId` da sessão afetada. Com um worker service moderno, `ServiceBase` fica escondido dentro de `WindowsServiceLifetime`, que é público e não é sealed. A abordagem mais limpa é criar uma subclasse dele e registrá-la como o `IHostLifetime`:

1. Referencie `Microsoft.Extensions.Hosting.WindowsServices` e chame `AddWindowsService()` como de costume.
2. Crie uma subclasse de `WindowsServiceLifetime`, defina `CanHandleSessionChangeEvent = true` no construtor e sobrescreva `OnSessionChange`.
3. Registre a subclasse como `IHostLifetime` *depois* de `AddWindowsService`, somente quando estiver rodando como serviço, para que o último registro prevaleça.
4. Envie cada notificação para um channel e processe-a em um `BackgroundService`.

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Hosting.WindowsServices 10.0.12
using System.ServiceProcess;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Options;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "SessionAudit");

var sessionEvents = Channel.CreateUnbounded<SessionChangeDescription>();
builder.Services.AddSingleton(sessionEvents);

if (WindowsServiceHelpers.IsWindowsService())
{
    // Registered after AddWindowsService, so this one wins when IHostLifetime is resolved.
    builder.Services.AddSingleton<IHostLifetime, SessionAwareLifetime>();
}

builder.Services.AddHostedService<SessionAuditWorker>();
builder.Build().Run();

sealed class SessionAwareLifetime : WindowsServiceLifetime
{
    private readonly ChannelWriter<SessionChangeDescription> _writer;

    public SessionAwareLifetime(
        IHostEnvironment environment,
        IHostApplicationLifetime applicationLifetime,
        ILoggerFactory loggerFactory,
        IOptions<HostOptions> hostOptions,
        IOptions<WindowsServiceLifetimeOptions> serviceOptions,
        Channel<SessionChangeDescription> channel)
        : base(environment, applicationLifetime, loggerFactory, hostOptions, serviceOptions)
    {
        // Must be set before the SCM starts the service, or it throws.
        CanHandleSessionChangeEvent = true;
        _writer = channel.Writer;
    }

    protected override void OnSessionChange(SessionChangeDescription changeDescription)
    {
        // Keep this fast: hand off and return to the SCM dispatcher.
        _writer.TryWrite(changeDescription);
        base.OnSessionChange(changeDescription);
    }
}

sealed class SessionAuditWorker(
    Channel<SessionChangeDescription> channel,
    ILogger<SessionAuditWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var change in channel.Reader.ReadAllAsync(stoppingToken))
        {
            logger.LogInformation("Session {SessionId}: {Reason}", change.SessionId, change.Reason);
        }
    }
}
```

O construtor importa. `CanHandleSessionChangeEvent` adiciona `SERVICE_ACCEPT_SESSIONCHANGE` aos controles aceitos que são reportados ao Service Control Manager quando o serviço inicia, e o setter lança `InvalidOperationException` quando o serviço já está rodando. Defini-lo no construtor é cedo o bastante, porque `WindowsServiceLifetime` só chama `ServiceBase.Run` a partir de `WaitForStartAsync`.

A verificação com `IsWindowsService()` mantém o `dotnet run` funcionando: fora do SCM, `AddWindowsService` não registra nada, e você não quer um lifetime de `ServiceBase` ao depurar a partir de um console. Se a divisão entre `IHostLifetime` e `BackgroundService` é novidade para você, [o post sobre o contrato do IHostedService](/pt-br/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) explica o que o host chama e quando.

Diferente de um app desktop, este serviço vê todos os usuários: logons na inicialização, logoffs, bloqueio e desbloqueio em cada sessão e conexões RDP. Isso o torna a ferramenta certa para "registrar quando usuários fazem logon nesta máquina" ou "pausar o job enquanto alguém estiver bloqueado".

### Notificações podem chegar fora de ordem

`ServiceBase` não chama `OnSessionChange` na thread de despacho do SCM. Cada `SERVICE_CONTROL_SESSIONCHANGE` é enfileirado com `ThreadPool.QueueUserWorkItem`, então duas notificações que chegam próximas (um bloqueio seguido imediatamente de um desbloqueio, ou `SessionLogoff` e `ConsoleDisconnect` vindos da mesma ação) rodam em threads diferentes do thread pool e podem executar de forma concorrente ou trocar de ordem. O channel acima preserva a ordem das chamadas a `TryWrite`, não a ordem em que o Windows as enviou.

Se a ordem importa para a sua lógica, trate o evento como uma dica e releia o estado real: consulte a sessão com `WTSQuerySessionInformation` (próxima seção) ao processar o evento e aja com base no que voltar, em vez de apenas no código do motivo.

### Obtendo o nome do usuário a partir de um session id

`SessionChangeDescription` carrega apenas um número. Para registrar *quem* bloqueou ou fez logon, consulte o nome de usuário e o domínio da sessão com `WTSQuerySessionInformation(..., WTSUserName)` e `WTSDomainName` usando o mesmo padrão de P/Invoke mostrado abaixo. Faça isso rapidamente: depois de `SessionLogoff` a sessão está sendo desmontada e a consulta pode retornar uma string vazia.

## Consultando o estado atual de bloqueio

Eventos informam sobre transições. Na inicialização você precisa do estado atual, porque ninguém vai avisar que a sessão já estava bloqueada quando o seu app foi iniciado. `WTSQuerySessionInformation` com a classe `WTSSessionInfoEx` retorna um `WTSINFOEXW` cujo campo `SessionFlags` contém `WTS_SESSIONSTATE_LOCK` (0) ou `WTS_SESSIONSTATE_UNLOCK` (1):

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

static partial class SessionState
{
    private const int WTSSessionInfoEx = 25;
    private const int WTS_SESSIONSTATE_LOCK = 0;
    private const int WTS_SESSIONSTATE_UNLOCK = 1;
    private static readonly nint WTS_CURRENT_SERVER_HANDLE = 0;
    private const int WTS_CURRENT_SESSION = -1;

    [LibraryImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSQuerySessionInformation(
        nint hServer, int sessionId, int infoClass, out nint buffer, out int bytesReturned);

    [LibraryImport("wtsapi32.dll")]
    private static partial void WTSFreeMemory(nint memory);

    [LibraryImport("kernel32.dll")]
    private static partial int WTSGetActiveConsoleSessionId();

    /// <summary>Returns true if locked, false if unlocked, null if Windows does not know.</summary>
    public static bool? IsLocked(int sessionId = WTS_CURRENT_SESSION)
    {
        if (!WTSQuerySessionInformation(WTS_CURRENT_SERVER_HANDLE, sessionId, WTSSessionInfoEx,
                out nint buffer, out _))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastPInvokeError());
        }

        try
        {
            // WTSINFOEXW is { DWORD Level; WTSINFOEX_LEVEL Data; }. The union holds
            // LARGE_INTEGER fields, so it is 8-byte aligned and starts at offset 8.
            if (Marshal.ReadInt32(buffer) != 1) return null;
            var head = Marshal.PtrToStructure<Level1Head>(buffer + 8);
            int flags = head.SessionFlags;

            // Windows 7 / Server 2008 R2 report these two values swapped (documented defect).
            bool win7 = Environment.OSVersion.Version is { Major: 6, Minor: 1 };
            return flags switch
            {
                WTS_SESSIONSTATE_LOCK => !win7,
                WTS_SESSIONSTATE_UNLOCK => win7,
                _ => null,
            };
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Level1Head
    {
        public uint SessionId;
        public int SessionState;   // WTS_CONNECTSTATE_CLASS
        public int SessionFlags;
    }

    public static int ActiveConsoleSessionId() => WTSGetActiveConsoleSessionId();
}
```

Três detalhes ali são fáceis de errar:

- **O offset é 8, não 4.** A union dentro de `WTSINFOEXW` contém membros `LARGE_INTEGER`, então ela é alinhada em 8 bytes tanto em x86 quanto em x64. Ler `SessionFlags` em `4 + 4 + 4` devolve lixo. Fazer marshalling apenas dos três primeiros campos de `WTSINFOEX_LEVEL1_W` evita declarar os buffers de nome de tamanho fixo de que você não precisa.
- **O Windows 7 e o Server 2008 R2 trocam os valores.** A página do MS Learn para `WTSINFOEX_LEVEL1_W` documenta um defeito de código em que `LOCK` significa desbloqueado e vice-versa nessas versões. Talvez você não distribua mais para o Windows 7, mas máquinas com Server 2008 R2 ainda existem em alguns parques, e a verificação não custa nada.
- **Um serviço passa um session id real.** `WTS_CURRENT_SESSION` a partir de um serviço significa a sessão 0. Passe `SessionChangeDescription.SessionId`, ou `WTSGetActiveConsoleSessionId()` para quem estiver no console físico.

`SessionFlags` também pode ser `WTS_SESSIONSTATE_UNKNOWN` (`0xFFFFFFFF`), por exemplo para uma sessão sem usuário, e é por isso que o método retorna `bool?`.

## Interceptando WM_WTSSESSION_CHANGE você mesmo

`SystemEvents` é conveniente, mas custa uma thread extra e uma janela oculta, e faz o encaminhamento via `Delegate.DynamicInvoke`. Se você já tem uma janela, registrar essa janela diretamente é mais leve e entrega o session id em `lParam`, além de `WTS_SESSION_CREATE` (0xA) e `WTS_SESSION_TERMINATE` (0xB), que os enums gerenciados não nomeiam. No WPF, intercepte o `HwndSource`:

```csharp
// .NET 10, C# 14, WPF
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

public partial class MainWindow : Window
{
    private const int WM_WTSSESSION_CHANGE = 0x02B1;
    private const int NOTIFY_FOR_THIS_SESSION = 0;
    private const int WTS_SESSION_LOCK = 0x7;
    private const int WTS_SESSION_UNLOCK = 0x8;

    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSRegisterSessionNotification(nint hWnd, int dwFlags);

    [LibraryImport("wtsapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSUnRegisterSessionNotification(nint hWnd);

    private HwndSource? _source;

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _source = (HwndSource)PresentationSource.FromVisual(this);
        _source.AddHook(WndProc);
        if (!WTSRegisterSessionNotification(_source.Handle, NOTIFY_FOR_THIS_SESSION))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastPInvokeError());
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        if (_source is not null)
        {
            WTSUnRegisterSessionNotification(_source.Handle);
            _source.RemoveHook(WndProc);
        }
        base.OnClosed(e);
    }

    private nint WndProc(nint hwnd, int msg, nint wParam, nint lParam, ref bool handled)
    {
        if (msg == WM_WTSSESSION_CHANGE)
        {
            // lParam is the session id the change applies to.
            switch ((int)wParam)
            {
                case WTS_SESSION_LOCK: PauseSensitiveUi(); break;
                case WTS_SESSION_UNLOCK: ResumeSensitiveUi(); break;
            }
        }
        return 0;
    }

    private void PauseSensitiveUi() => Title = "Locked";
    private void ResumeSensitiveUi() => Title = "Unlocked";
}
```

No WinForms, a mesma coisa é um override de `WndProc` mais o registro em `OnHandleCreated` e o cancelamento do registro em `OnHandleDestroyed`. Use os eventos de handle em vez do construtor e do `Dispose`, porque o WinForms pode recriar o handle de um formulário (alterar `ShowInTaskbar` ou `RightToLeft` faz isso), e o novo handle não fica registrado:

```csharp
// .NET 10, C# 14, Windows Forms
using System.Runtime.InteropServices;

public partial class MainForm : Form
{
    private const int WM_WTSSESSION_CHANGE = 0x02B1;

    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSRegisterSessionNotification(nint hWnd, int dwFlags);

    [LibraryImport("wtsapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSUnRegisterSessionNotification(nint hWnd);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        WTSRegisterSessionNotification(Handle, 0 /* NOTIFY_FOR_THIS_SESSION */);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        WTSUnRegisterSessionNotification(Handle);
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_WTSSESSION_CHANGE)
        {
            var reason = (Microsoft.Win32.SessionSwitchReason)(int)m.WParam;
            Text = $"{reason} (session {(int)m.LParam})";
        }
        base.WndProc(ref m);
    }
}
```

A documentação Win32 exige um `WTSUnRegisterSessionNotification` para cada registro bem-sucedido antes que a janela seja destruída. Pular isso não derruba nada, mas é o tipo de vazamento que aparece como um chamado de suporte dois anos depois.

## Armadilhas que aparecem em produção

- **Uma inicialização automática muito cedo pode perder o registro.** `WTSRegisterSessionNotification` pode falhar com `RPC_S_INVALID_BINDING` se rodar antes de o Remote Desktop Services estar pronto; a documentação diz para esperar pelo evento `Global\TermSrvReadyEvent`. `SystemEvents` registra uma única vez, na primeira assinatura de `SessionSwitch`, e não verifica o resultado. Um app iniciado a partir de uma chave `Run` no logon quase sempre funciona, mas algo que inicia muito cedo no boot deve registrar diretamente e tentar de novo, ou simplesmente ser um serviço.
- **Um bloqueio nem sempre é um `SessionLock`.** A troca rápida de usuário normalmente produz `ConsoleDisconnect` para a sessão que está sendo deixada, e reconectar via RDP a uma sessão existente produz `RemoteConnect`. Se o que você realmente quer dizer é "o usuário não está olhando para esta sessão", trate também os motivos de desconexão e confirme com `IsLocked()`.
- **Não use eventos de logoff para salvar trabalho.** Quando `SessionLogoff` chega a um serviço, os processos do usuário já estão sendo encerrados. Apps desktop que precisam persistir estado no logoff ou no desligamento devem tratar `SystemEvents.SessionEnding` (disparado a partir de `WM_QUERYENDSESSION`, cancelável em teoria) ou `SessionEnded` (a partir de `WM_ENDSESSION`), e fazer isso rápido.
- **Nunca bloqueie o handler.** Isso vale para a thread `.NET System Events` e para o callback do thread pool do serviço. Escrever em um channel e retornar é o padrão seguro, que também é como [a comparação de BackgroundService](/pt-br/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) recomenda alimentar trabalho de longa duração em um hosted service.
- **A sessão 0 não tem área de trabalho.** Um serviço que reage a `SessionLogon` mostrando UI não vai mostrá-la em lugar nenhum. Inicie um processo auxiliar na sessão do usuário (`WTSQueryUserToken` mais `CreateProcessAsUser`) ou faça um app de bandeja por usuário escutar `SessionSwitch` e conversar com o serviço por um named pipe.

Se você precisa lembrar de uma única regra: dentro da sessão do usuário, use `SystemEvents.SessionSwitch` (ou a mensagem de janela bruta, se você tem uma janela) e espere eventos de bloqueio, desbloqueio e conexão, mas não o seu próprio logon. Em todas as sessões, use um serviço com `OnSessionChange` e consulte o estado novamente quando a ordem importar.

## Fontes

- [Evento SystemEvents.SessionSwitch](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.systemevents.sessionswitch) no MS Learn
- [ServiceBase.OnSessionChange](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.onsessionchange) e [CanHandleSessionChangeEvent](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.canhandlesessionchangeevent)
- [WTSRegisterSessionNotification](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification) e [WM_WTSSESSION_CHANGE](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)
- [WTSINFOEX_LEVEL1_W](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w), incluindo o defeito de flags do Windows 7
- [SystemEvents.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Win32.SystemEvents/src/Microsoft/Win32/SystemEvents.cs) e [dotnet/runtime PR #53467](https://github.com/dotnet/runtime/pull/53467), que tornou incondicional a thread do loop de mensagens
- [ServiceBase.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.ServiceProcess.ServiceController/src/System/ServiceProcess/ServiceBase.cs) e [WindowsServiceLifetime.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.WindowsServices/src/WindowsServiceLifetime.cs) no dotnet/runtime
