---
title: "Windows-Sitzungsereignisse für Sperren, Entsperren, Anmelden und Abmelden in einer C#-App erkennen"
description: "Verwenden Sie SystemEvents.SessionSwitch in einer Desktop- oder Konsolen-App, überschreiben Sie OnSessionChange in einem Windows-Dienst oder hängen Sie sich selbst in WM_WTSSESSION_CHANGE ein. Mit .NET 10-Code für alle drei Varianten, dem versteckten Thread '.NET System Events', dem Grund, warum Dienste die Anmeldung sehen, Desktop-Apps aber nicht, Benachrichtigungen in falscher Reihenfolge und der Abfrage des aktuellen Sperrzustands mit WTSQuerySessionInformation."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "windows"
  - "worker-service"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-04
---

Kurze Antwort: In einem Prozess, der in der Sitzung des Benutzers läuft (WinForms, WPF oder eine einfache Konsolen-App), abonnieren Sie `Microsoft.Win32.SystemEvents.SessionSwitch` und werten `e.Reason` aus: `SessionLock`, `SessionUnlock`, `SessionLogon`, `SessionLogoff` sowie die Werte für Konsolen- und Remoteverbindungen. In einem Windows-Dienst setzen Sie `CanHandleSessionChangeEvent = true` und überschreiben `ServiceBase.OnSessionChange`, was beim generischen Host von .NET bedeutet, von `WindowsServiceLifetime` abzuleiten. Beides sind dünne Wrapper um dieselbe Win32-Benachrichtigung, `WM_WTSSESSION_CHANGE`, in die Sie sich auch direkt aus einer Fensterprozedur einhängen können. Um zu fragen "ist die Sitzung gerade gesperrt?", statt auf ein Ereignis zu warten, rufen Sie `WTSQuerySessionInformation` mit `WTSSessionInfoEx` auf.

Der Code in diesem Beitrag zielt auf .NET 10 (SDK 10.0.302) mit `Microsoft.Win32.SystemEvents` 10.0.12 und `Microsoft.Extensions.Hosting.WindowsServices` 10.0.12. Jedes Snippet wurde gegen `net10.0-windows` kompiliert, und die Aussagen zum Threading-Verhalten stammen aus dem `dotnet/runtime`-Quellcode dieser Pakete, den ich am Ende verlinke. Die zugrunde liegenden APIs sind seit Windows Vista unverändert, sodass derselbe Ansatz auch unter .NET 8, .NET 9 und dem .NET 11 RC funktioniert.

## Welche API welches Ereignis sieht

Windows löst pro Zustandsänderung einer Sitzung eine Benachrichtigung aus, und jede verwaltete API ist nur ein anderer Weg, sie zu empfangen. Die Werte sind überall gleich, was hilfreich ist, wenn Sie Ansätze mischen:

| Wert | `SessionSwitchReason` / `SessionChangeReason` | Bedeutung |
|---|---|---|
| 1 | `ConsoleConnect` | Eine Sitzung hat sich mit der physischen Konsole verbunden |
| 2 | `ConsoleDisconnect` | Eine Sitzung hat sich von der Konsole getrennt (schneller Benutzerwechsel) |
| 3 | `RemoteConnect` | Eine Sitzung hat sich über Remote Desktop verbunden |
| 4 | `RemoteDisconnect` | Ein Remote Desktop-Client hat die Verbindung getrennt |
| 5 | `SessionLogon` | Ein Benutzer hat sich angemeldet |
| 6 | `SessionLogoff` | Ein Benutzer hat sich abgemeldet |
| 7 | `SessionLock` | Die Sitzung wurde gesperrt |
| 8 | `SessionUnlock` | Die Sitzung wurde entsperrt |
| 9 | `SessionRemoteControl` | Der Status der Fernsteuerung hat sich geändert |

Der wichtige Unterschied liegt nicht in den Werten, sondern darin, *wer* sie empfängt. Ein mit `NOTIFY_FOR_THIS_SESSION` registriertes Fenster erfährt nur von seiner eigenen Sitzung. Ein Windows-Dienst läuft in Sitzung 0 und erhält Benachrichtigungen für jede Sitzung auf dem Rechner. Das hat eine Konsequenz, über die ständig jemand stolpert: **Eine Desktop-App sieht nie ihr eigenes `SessionLogon`**, weil sie erst nach der Anmeldung gestartet wurde, und sie sieht selten ihr eigenes `SessionLogoff`, weil sie in diesem Moment gerade beendet wird. Wenn Sie tatsächlich An- und Abmeldung brauchen, wollen Sie einen Dienst, oder für die Abmeldeseite `SystemEvents.SessionEnding`. Sperren und Entsperren funktionieren in beiden Fällen problemlos.

## Desktop- und Konsolen-Apps: SystemEvents.SessionSwitch

Für WinForms und WPF ist `Microsoft.Win32.SystemEvents` bereits Teil des Windows Desktop Shared Framework. Für eine Konsolen-App oder eine Bibliothek fügen Sie das Paket hinzu:

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

Das `-windows`-TFM ist nicht zwingend erforderlich: Das Paket enthält auch eine einfache `net10.0`-Assembly. Unter Linux und macOS ist diese Assembly ein Stub, der `PlatformNotSupportedException` wirft, daher macht das Ziel `net10.0-windows` aus einer Überraschung zur Laufzeit eine CA1416-Analyzer-Warnung an der Aufrufstelle. `AllowUnsafeBlocks` wird nur für den `LibraryImport`-Code weiter unten im Beitrag benötigt.

Das Ereignis selbst sind nur wenige Zeilen:

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

Drücken Sie Win+L und entsperren Sie wieder, dann erhalten Sie `SessionLock` gefolgt von `SessionUnlock`. Beim schnellen Benutzerwechsel erhalten Sie `ConsoleDisconnect`, wenn Sie die Sitzung verlassen, und `ConsoleConnect`, wenn Sie zurückkehren, meist zusammen mit Sperren und Entsperren. Verbinden Sie sich per RDP als derselbe Benutzer mit dem Rechner, meldet diese Sitzung `ConsoleDisconnect` gefolgt von `RemoteConnect`.

### Woher die Nachrichtenschleife kommt

Ältere Antworten zu diesem Thema behaupten, `SessionSwitch` "funktioniere nur mit einer Nachrichtenschleife", und die MS Learn-Seite des Ereignisses enthält diesen Hinweis immer noch. Unter modernem .NET ist das nur halb wahr. Seit .NET 6 (dotnet/runtime PR #53467, "Always spawn message loop thread for SystemEvents") erzeugt das erste Abonnement eines beliebigen `SystemEvents`-Ereignisses ein verstecktes `WS_POPUP`-Fenster auf einem eigenen Hintergrund-Thread namens `.NET System Events` und führt darauf `GetMessage`/`DispatchMessage` aus. Der Kommentar im Quellcode ist eindeutig: Es wird immer ein eigener Thread erzeugt, selbst wenn der aufrufende Thread STA ist, weil nicht garantiert ist, dass dieser Thread weiterhin Nachrichten verarbeitet. Eine Konsolen-App ohne UI empfängt die Ereignisse also ohne zusätzlichen Aufwand.

Das Abonnieren speziell von `SessionSwitch` ruft außerdem `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` für dieses versteckte Fenster auf. Daher stammt die Beschränkung auf "nur diese Sitzung".

### Auf welchem Thread Ihr Handler läuft

Beim Abonnieren erfasst `SystemEvents` den `AsyncOperationManager.SynchronizationContext` und ruft später `Send` darauf auf:

- In WinForms oder WPF erfasst ein Abonnement aus dem UI-Thread den UI-Kontext, sodass Ihr Handler auf den UI-Thread gemarshallt wird. Sie können direkt auf Steuerelemente zugreifen.
- In einer Konsolen-App oder einem Worker gibt es keinen Kontext, daher ist der erfasste ein einfacher `SynchronizationContext`, dessen `Send` inline ausführt. Ihr Handler läuft auf dem Thread `.NET System Events`.

Der zweite Fall ist relevant. Dieser Thread verteilt auch `PowerModeChanged`, `UserPreferenceChanged`, `DisplaySettingsChanged` und den Rest. Wenn Ihr Sperr-Handler einen blockierenden HTTP-Aufruf macht oder auf eine Sperre wartet, wartet jedes andere Systemereignis im Prozess mit. Geben Sie die Arbeit sofort ab, zum Beispiel an einen `Channel<T>` (das Muster aus [Channels statt BlockingCollection verwenden](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) passt hier perfekt) oder an `Task.Run`.

### Das Leck durch statische Ereignisse

`SessionSwitch` ist ein statisches Ereignis. Ein Handler, der `this` erfasst, hält den gesamten Objektgraphen am Leben, bis Sie das Abonnement aufheben. Genau so überlebt ein geschlossenes WPF-Fenster klassischerweise bis zum Ende des Prozesses. Die Hinweise auf MS Learn warnen ausdrücklich davor. Heben Sie das Abonnement in `Dispose`, `OnClosed` oder einem `finally` auf, und wenn Sie einem Fenster nachjagen, das nicht sterben will, zeigt [ein Vergleich mit `dotnet-gcdump`](/de/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/), dass `SystemEvents` es festhält.

## Windows-Dienste: OnSessionChange und der generische Host

Ein Dienst kann `SystemEvents.SessionSwitch` nicht sinnvoll nutzen. Er läuft in Sitzung 0, also beschränkt `NOTIFY_FOR_THIS_SESSION` das versteckte Fenster auf Sitzung 0, wo niemand etwas sperrt oder entsperrt. Die Dokumentation zu `WTSRegisterSessionNotification` sagt es klar: Dienste erhalten diese Benachrichtigungen über ihren Dienststeuerungshandler (`HandlerEx` mit `SERVICE_CONTROL_SESSIONCHANGE`), nicht über ein Fenster.

`System.ServiceProcess.ServiceBase` verdrahtet das bereits. Sie aktivieren es mit `CanHandleSessionChangeEvent = true` und überschreiben `OnSessionChange(SessionChangeDescription)`, das Ihnen den `Reason` und die `SessionId` der betroffenen Sitzung liefert. Bei einem modernen Worker Service steckt `ServiceBase` in `WindowsServiceLifetime`, das öffentlich und nicht versiegelt ist. Am saubersten ist es, davon abzuleiten und die Unterklasse als `IHostLifetime` zu registrieren:

1. Referenzieren Sie `Microsoft.Extensions.Hosting.WindowsServices` und rufen Sie wie gewohnt `AddWindowsService()` auf.
2. Leiten Sie von `WindowsServiceLifetime` ab, setzen Sie im Konstruktor `CanHandleSessionChangeEvent = true` und überschreiben Sie `OnSessionChange`.
3. Registrieren Sie die Unterklasse *nach* `AddWindowsService` als `IHostLifetime`, und zwar nur bei Ausführung als Dienst, damit die letzte Registrierung gewinnt.
4. Schieben Sie jede Benachrichtigung in einen Channel und verarbeiten Sie sie in einem `BackgroundService`.

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

Der Konstruktor ist entscheidend. `CanHandleSessionChangeEvent` fügt `SERVICE_ACCEPT_SESSIONCHANGE` zu den akzeptierten Steuercodes hinzu, die beim Start des Dienstes an den Service Control Manager gemeldet werden, und der Setter wirft `InvalidOperationException`, sobald der Dienst läuft. Das Setzen im Konstruktor ist früh genug, weil `WindowsServiceLifetime` `ServiceBase.Run` erst aus `WaitForStartAsync` aufruft.

Die Prüfung mit `IsWindowsService()` sorgt dafür, dass `dotnet run` weiterhin funktioniert: Außerhalb des SCM registriert `AddWindowsService` nichts, und beim Debuggen aus einer Konsole wollen Sie keine `ServiceBase`-Lifetime. Falls die Aufteilung in `IHostLifetime` und `BackgroundService` neu für Sie ist, erklärt [der Beitrag zum IHostedService-Vertrag](/de/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/), was der Host wann aufruft.

Anders als eine Desktop-App sieht dieser Dienst jeden Benutzer: Anmeldungen beim Systemstart, Abmeldungen, Sperren und Entsperren in jeder Sitzung sowie RDP-Verbindungen. Damit ist er das richtige Werkzeug für "erfassen, wann sich Benutzer an diesem Rechner anmelden" oder "den Job pausieren, solange irgendjemand gesperrt ist".

### Benachrichtigungen können in falscher Reihenfolge eintreffen

`ServiceBase` ruft `OnSessionChange` nicht auf dem Dispatcher-Thread des SCM auf. Jedes `SERVICE_CONTROL_SESSIONCHANGE` wird mit `ThreadPool.QueueUserWorkItem` eingereiht, sodass zwei kurz nacheinander eintreffende Benachrichtigungen (ein Sperren, unmittelbar gefolgt von einem Entsperren, oder `SessionLogoff` und `ConsoleDisconnect` aus derselben Aktion) auf verschiedenen Threadpool-Threads laufen und gleichzeitig ausgeführt werden oder die Reihenfolge tauschen können. Der Channel oben bewahrt die Reihenfolge der `TryWrite`-Aufrufe, nicht die Reihenfolge, in der Windows sie gesendet hat.

Wenn die Reihenfolge für Ihre Logik wichtig ist, behandeln Sie das Ereignis als Hinweis und lesen den tatsächlichen Zustand erneut: Fragen Sie die Sitzung bei der Verarbeitung des Ereignisses mit `WTSQuerySessionInformation` ab (nächster Abschnitt) und handeln Sie nach dem Ergebnis statt allein nach dem Reason-Code.

### Den Benutzernamen aus einer Sitzungs-ID ermitteln

`SessionChangeDescription` enthält nur eine Zahl. Um zu protokollieren, *wer* gesperrt oder sich angemeldet hat, fragen Sie Benutzername und Domäne der Sitzung mit `WTSQuerySessionInformation(..., WTSUserName)` und `WTSDomainName` ab, nach demselben P/Invoke-Muster wie unten. Tun Sie das zeitnah: Nach `SessionLogoff` wird die Sitzung abgebaut, und die Abfrage kann eine leere Zeichenfolge liefern.

## Den aktuellen Sperrzustand abfragen

Ereignisse informieren Sie über Übergänge. Beim Start brauchen Sie den aktuellen Zustand, denn niemand teilt Ihnen mit, dass die Sitzung beim Start Ihrer App bereits gesperrt war. `WTSQuerySessionInformation` mit der Klasse `WTSSessionInfoEx` liefert eine `WTSINFOEXW`, deren Feld `SessionFlags` den Wert `WTS_SESSIONSTATE_LOCK` (0) oder `WTS_SESSIONSTATE_UNLOCK` (1) enthält:

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

Drei Details darin macht man leicht falsch:

- **Der Offset ist 8, nicht 4.** Die Union in `WTSINFOEXW` enthält `LARGE_INTEGER`-Member und ist daher sowohl unter x86 als auch unter x64 auf 8 Byte ausgerichtet. `SessionFlags` bei `4 + 4 + 4` zu lesen, liefert Datenmüll. Wenn Sie nur die ersten drei Felder von `WTSINFOEX_LEVEL1_W` marshallen, müssen Sie die Namenspuffer fester Größe, die Sie nicht brauchen, gar nicht erst deklarieren.
- **Windows 7 und Server 2008 R2 vertauschen die Werte.** Die MS Learn-Seite zu `WTSINFOEX_LEVEL1_W` dokumentiert einen Codefehler, durch den `LOCK` auf diesen Versionen entsperrt bedeutet und umgekehrt. Vielleicht liefern Sie nicht mehr für Windows 7 aus, aber Server 2008 R2-Maschinen gibt es in manchen Umgebungen noch, und die Prüfung kostet nichts.
- **Ein Dienst übergibt eine echte Sitzungs-ID.** `WTS_CURRENT_SESSION` bedeutet aus einem Dienst heraus Sitzung 0. Übergeben Sie `SessionChangeDescription.SessionId` oder `WTSGetActiveConsoleSessionId()` für denjenigen, der an der physischen Konsole sitzt.

`SessionFlags` kann auch `WTS_SESSIONSTATE_UNKNOWN` (`0xFFFFFFFF`) sein, zum Beispiel bei einer Sitzung ohne Benutzer, weshalb die Methode `bool?` zurückgibt.

## Sich selbst in WM_WTSSESSION_CHANGE einhängen

`SystemEvents` ist bequem, kostet aber einen zusätzlichen Thread und ein verstecktes Fenster und marshallt über `Delegate.DynamicInvoke`. Wenn Sie ohnehin ein Fenster besitzen, ist es schlanker, dieses Fenster direkt zu registrieren. Dann erhalten Sie die Sitzungs-ID in `lParam` sowie `WTS_SESSION_CREATE` (0xA) und `WTS_SESSION_TERMINATE` (0xB), die die verwalteten Enums nicht benennen. In WPF hängen Sie sich in die `HwndSource` ein:

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

In WinForms ist dasselbe ein Überschreiben von `WndProc` plus Registrierung in `OnHandleCreated` und Abmeldung in `OnHandleDestroyed`. Verwenden Sie die Handle-Ereignisse statt Konstruktor und `Dispose`, weil WinForms das Handle eines Formulars neu erzeugen kann (das Ändern von `ShowInTaskbar` oder `RightToLeft` tut das), und das neue Handle ist nicht registriert:

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

Die Win32-Dokumentation verlangt pro erfolgreicher Registrierung einen Aufruf von `WTSUnRegisterSessionNotification`, bevor das Fenster zerstört wird. Wenn Sie ihn auslassen, stürzt nichts ab, aber es ist genau die Art von Leck, die zwei Jahre später als Support-Ticket auftaucht.

## Stolperfallen, die in Produktion auftauchen

- **Ein früher Autostart kann die Registrierung verpassen.** `WTSRegisterSessionNotification` kann mit `RPC_S_INVALID_BINDING` fehlschlagen, wenn es läuft, bevor die Remote Desktop Services bereit sind; die Dokumentation empfiehlt, auf das Ereignis `Global\TermSrvReadyEvent` zu warten. `SystemEvents` registriert einmal, beim ersten Abonnement von `SessionSwitch`, und prüft das Ergebnis nicht. Eine App, die bei der Anmeldung über einen `Run`-Schlüssel gestartet wird, ist fast immer unproblematisch, aber etwas, das sehr früh im Systemstart läuft, sollte sich direkt registrieren und es erneut versuchen oder einfach ein Dienst sein.
- **Eine Sperre ist nicht immer ein `SessionLock`.** Der schnelle Benutzerwechsel erzeugt typischerweise `ConsoleDisconnect` für die verlassene Sitzung, und das erneute Verbinden per RDP mit einer bestehenden Sitzung erzeugt `RemoteConnect`. Wenn Sie eigentlich "der Benutzer schaut nicht auf diese Sitzung" meinen, behandeln Sie auch die Disconnect-Gründe und bestätigen Sie mit `IsLocked()`.
- **Nutzen Sie Abmeldeereignisse nicht zum Speichern von Arbeit.** Wenn `SessionLogoff` einen Dienst erreicht, werden die Prozesse des Benutzers bereits beendet. Desktop-Apps, die bei Abmeldung oder Herunterfahren Zustand sichern müssen, sollten `SystemEvents.SessionEnding` (ausgelöst durch `WM_QUERYENDSESSION`, theoretisch abbrechbar) oder `SessionEnded` (durch `WM_ENDSESSION`) behandeln, und zwar schnell.
- **Blockieren Sie den Handler nie.** Das gilt für den Thread `.NET System Events` ebenso wie für den Threadpool-Callback des Dienstes. In einen Channel zu schreiben und zurückzukehren ist der sichere Standard, und genau so empfiehlt auch [der BackgroundService-Vergleich](/de/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/), lang laufende Arbeit in einen Hosted Service einzuspeisen.
- **Sitzung 0 hat keinen Desktop.** Ein Dienst, der auf `SessionLogon` mit einer UI reagiert, zeigt sie nirgendwo an. Starten Sie einen Hilfsprozess in der Sitzung des Benutzers (`WTSQueryUserToken` plus `CreateProcessAsUser`) oder lassen Sie eine Tray-App pro Benutzer auf `SessionSwitch` lauschen und über eine Named Pipe mit dem Dienst kommunizieren.

Wenn Sie sich nur eine Regel merken: Innerhalb der Benutzersitzung verwenden Sie `SystemEvents.SessionSwitch` (oder die rohe Fensternachricht, wenn Sie ein Fenster besitzen) und erwarten Sperr-, Entsperr- und Verbindungsereignisse, aber nicht Ihre eigene Anmeldung. Über alle Sitzungen hinweg verwenden Sie einen Dienst mit `OnSessionChange` und fragen den Zustand erneut ab, wenn die Reihenfolge zählt.

## Quellen

- [SystemEvents.SessionSwitch-Ereignis](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.systemevents.sessionswitch) auf MS Learn
- [ServiceBase.OnSessionChange](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.onsessionchange) und [CanHandleSessionChangeEvent](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.canhandlesessionchangeevent)
- [WTSRegisterSessionNotification](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification) und [WM_WTSSESSION_CHANGE](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)
- [WTSINFOEX_LEVEL1_W](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w), einschließlich des Flag-Fehlers unter Windows 7
- [SystemEvents.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Win32.SystemEvents/src/Microsoft/Win32/SystemEvents.cs) und [dotnet/runtime PR #53467](https://github.com/dotnet/runtime/pull/53467), das den Thread für die Nachrichtenschleife bedingungslos gemacht hat
- [ServiceBase.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.ServiceProcess.ServiceController/src/System/ServiceProcess/ServiceBase.cs) und [WindowsServiceLifetime.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.WindowsServices/src/WindowsServiceLifetime.cs) in dotnet/runtime
