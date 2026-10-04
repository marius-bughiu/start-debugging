---
title: "Cómo detectar los eventos de bloqueo, desbloqueo, inicio y cierre de sesión de Windows en una app de C#"
description: "Usa SystemEvents.SessionSwitch en una app de escritorio o de consola, sobrescribe OnSessionChange en un servicio de Windows, o engancha WM_WTSSESSION_CHANGE tú mismo. Incluye código de .NET 10 para los tres enfoques, el hilo oculto '.NET System Events', por qué los servicios ven el inicio de sesión y las apps de escritorio no, las notificaciones fuera de orden y cómo consultar el estado de bloqueo actual con WTSQuerySessionInformation."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "windows"
  - "worker-service"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-04
---

Respuesta corta: en un proceso que se ejecuta dentro de la sesión del usuario (WinForms, WPF o una app de consola simple), suscríbete a `Microsoft.Win32.SystemEvents.SessionSwitch` y haz un switch sobre `e.Reason`: `SessionLock`, `SessionUnlock`, `SessionLogon`, `SessionLogoff`, además de los valores de conexión y desconexión de consola y remota. En un servicio de Windows, establece `CanHandleSessionChangeEvent = true` y sobrescribe `ServiceBase.OnSessionChange`, lo que con el host genérico de .NET significa heredar de `WindowsServiceLifetime`. Ambos son envoltorios delgados sobre la misma notificación de Win32, `WM_WTSSESSION_CHANGE`, que también puedes enganchar directamente desde un procedimiento de ventana. Para preguntar "¿la sesión está bloqueada ahora mismo?" en lugar de esperar un evento, llama a `WTSQuerySessionInformation` con `WTSSessionInfoEx`.

El código de este artículo apunta a .NET 10 (SDK 10.0.302) con `Microsoft.Win32.SystemEvents` 10.0.12 y `Microsoft.Extensions.Hosting.WindowsServices` 10.0.12. Cada fragmento se verificó compilando contra `net10.0-windows`, y las afirmaciones sobre el comportamiento de los hilos provienen del código fuente de `dotnet/runtime` para esos paquetes, que enlazo al final. Las APIs subyacentes no han cambiado desde Windows Vista, así que el mismo enfoque funciona en .NET 8, .NET 9 y el .NET 11 RC.

## Qué API ve qué evento

Windows emite una notificación por cada cambio de estado de sesión, y cada API administrada es una forma distinta de recibirla. Los valores son los mismos en todas partes, lo cual es útil cuando combinas enfoques:

| Valor | `SessionSwitchReason` / `SessionChangeReason` | Significado |
|---|---|---|
| 1 | `ConsoleConnect` | Una sesión se conectó a la consola física |
| 2 | `ConsoleDisconnect` | Una sesión se desconectó de la consola (cambio rápido de usuario) |
| 3 | `RemoteConnect` | Una sesión se conectó mediante Remote Desktop |
| 4 | `RemoteDisconnect` | Un cliente de Remote Desktop se desconectó |
| 5 | `SessionLogon` | Un usuario inició sesión |
| 6 | `SessionLogoff` | Un usuario cerró sesión |
| 7 | `SessionLock` | La sesión se bloqueó |
| 8 | `SessionUnlock` | La sesión se desbloqueó |
| 9 | `SessionRemoteControl` | Cambió el estado del control remoto |

La diferencia importante no son los valores, sino *quién* los recibe. Una ventana registrada con `NOTIFY_FOR_THIS_SESSION` solo se entera de su propia sesión. Un servicio de Windows se ejecuta en la sesión 0 y recibe notificaciones de todas las sesiones de la máquina. Eso tiene una consecuencia con la que la gente tropieza constantemente: **una app de escritorio nunca ve su propio `SessionLogon`**, porque se inició después de que ocurriera el inicio de sesión, y rara vez ve su propio `SessionLogoff`, porque se está desmontando en ese momento. Si lo que realmente necesitas es el inicio y el cierre de sesión, quieres un servicio, o `SystemEvents.SessionEnding` para el lado del cierre. El bloqueo y el desbloqueo funcionan bien desde ambos.

## Apps de escritorio y de consola: SystemEvents.SessionSwitch

Para WinForms y WPF, `Microsoft.Win32.SystemEvents` ya forma parte del framework compartido de Windows Desktop. Para una app de consola o una biblioteca, agrega el paquete:

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

El TFM `-windows` no es estrictamente necesario: el paquete también incluye un ensamblado `net10.0` simple. En Linux y macOS ese ensamblado es un stub que lanza `PlatformNotSupportedException`, así que apuntar a `net10.0-windows` convierte una sorpresa en runtime en una advertencia del analizador CA1416 en el punto de llamada. `AllowUnsafeBlocks` solo se necesita para el código con `LibraryImport` que aparece más adelante en el artículo.

El evento en sí ocupa unas pocas líneas:

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

Presiona Win+L y desbloquea, y obtienes `SessionLock` seguido de `SessionUnlock`. Cambia de usuario con el cambio rápido de usuario y obtienes `ConsoleDisconnect` al salir y `ConsoleConnect` al volver, normalmente junto con el bloqueo y el desbloqueo. Conéctate por RDP a la máquina con el mismo usuario y esa sesión reporta `ConsoleDisconnect` seguido de `RemoteConnect`.

### De dónde sale el bucle de mensajes

Las respuestas antiguas sobre este tema dicen que `SessionSwitch` "solo funciona si tienes un bucle de mensajes", y la página de MS Learn del evento todavía incluye esa nota. En .NET moderno eso es solo una verdad a medias. Desde .NET 6 (dotnet/runtime PR #53467, "Always spawn message loop thread for SystemEvents"), la primera suscripción a cualquier evento de `SystemEvents` crea una ventana `WS_POPUP` oculta en un hilo en segundo plano dedicado llamado `.NET System Events` y ejecuta `GetMessage`/`DispatchMessage` en él. El comentario en el código fuente es explícito: siempre crea su propio hilo, incluso cuando el hilo que llama es STA, porque no hay garantía de que ese hilo siga procesando mensajes. Así que una app de consola sin UI recibe los eventos sin ningún trabajo adicional.

Suscribirse a `SessionSwitch` en particular también llama a `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` para esa ventana oculta. De ahí viene el alcance de "solo esta sesión".

### En qué hilo se ejecuta tu handler

Cuando te suscribes, `SystemEvents` captura `AsyncOperationManager.SynchronizationContext` y más tarde llama a `Send` sobre él:

- En WinForms o WPF, suscribirse desde el hilo de UI captura el contexto de UI, así que tu handler se serializa hacia el hilo de UI. Puedes tocar los controles directamente.
- En una app de consola o un worker no hay contexto, así que el capturado es un `SynchronizationContext` simple cuyo `Send` se ejecuta en línea. Tu handler se ejecuta en el hilo `.NET System Events`.

El segundo caso importa. Ese hilo también es el que despacha `PowerModeChanged`, `UserPreferenceChanged`, `DisplaySettingsChanged` y el resto. Si tu handler de bloqueo hace una llamada HTTP bloqueante o espera un lock, todos los demás eventos del sistema en el proceso también esperan. Delega el trabajo de inmediato, por ejemplo a un `Channel<T>` (el patrón de [usar canales en lugar de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) encaja perfectamente aquí) o a `Task.Run`.

### La fuga del evento estático

`SessionSwitch` es un evento estático. Un handler que captura `this` mantiene vivo todo el grafo de objetos hasta que cancelas la suscripción, que es la forma de manual en que una ventana WPF cerrada acaba sobreviviendo durante toda la vida del proceso. Las observaciones de MS Learn lo advierten explícitamente. Cancela la suscripción en `Dispose`, `OnClosed` o un `finally`, y si estás persiguiendo una ventana que no muere, [una comparación con `dotnet-gcdump`](/es/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) mostrará a `SystemEvents` reteniéndola.

## Servicios de Windows: OnSessionChange y el host genérico

Un servicio no puede usar `SystemEvents.SessionSwitch` de forma útil. Se ejecuta en la sesión 0, así que `NOTIFY_FOR_THIS_SESSION` limita la ventana oculta a la sesión 0, donde nadie bloquea ni desbloquea nada. La documentación de `WTSRegisterSessionNotification` lo dice claramente: los servicios reciben estas notificaciones a través de su manejador de control de servicio (`HandlerEx` con `SERVICE_CONTROL_SESSIONCHANGE`), no a través de una ventana.

`System.ServiceProcess.ServiceBase` ya conecta eso. Lo activas con `CanHandleSessionChangeEvent = true` y sobrescribes `OnSessionChange(SessionChangeDescription)`, que te da el `Reason` y el `SessionId` de la sesión afectada. Con un worker service moderno, `ServiceBase` está oculto dentro de `WindowsServiceLifetime`, que es público y no está sellado. El enfoque más limpio es heredar de él y registrar tu subclase como el `IHostLifetime`:

1. Referencia `Microsoft.Extensions.Hosting.WindowsServices` y llama a `AddWindowsService()` como siempre.
2. Hereda de `WindowsServiceLifetime`, establece `CanHandleSessionChangeEvent = true` en el constructor y sobrescribe `OnSessionChange`.
3. Registra la subclase como `IHostLifetime` *después* de `AddWindowsService`, solo cuando se ejecuta como servicio, para que gane el último registro.
4. Envía cada notificación a un canal y procésala en un `BackgroundService`.

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

El constructor importa. `CanHandleSessionChangeEvent` agrega `SERVICE_ACCEPT_SESSIONCHANGE` a los controles aceptados que se reportan al Service Control Manager cuando el servicio arranca, y el setter lanza `InvalidOperationException` una vez que el servicio está en ejecución. Establecerlo en el constructor es lo bastante temprano, porque `WindowsServiceLifetime` solo llama a `ServiceBase.Run` desde `WaitForStartAsync`.

La guarda `IsWindowsService()` mantiene funcionando `dotnet run`: fuera del SCM, `AddWindowsService` no registra nada, y no quieres un lifetime de `ServiceBase` al depurar desde una consola. Si la división entre `IHostLifetime` y `BackgroundService` es nueva para ti, [el artículo sobre el contrato de IHostedService](/es/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) explica qué llama el host y cuándo.

A diferencia de una app de escritorio, este servicio ve a todos los usuarios: inicios de sesión al arrancar, cierres de sesión, bloqueo y desbloqueo en cada sesión, y conexiones RDP. Eso lo convierte en la herramienta adecuada para "registrar cuándo los usuarios inician sesión en esta máquina" o "pausar el trabajo mientras alguien tenga la sesión bloqueada".

### Las notificaciones pueden llegar fuera de orden

`ServiceBase` no llama a `OnSessionChange` en el hilo despachador del SCM. Cada `SERVICE_CONTROL_SESSIONCHANGE` se encola con `ThreadPool.QueueUserWorkItem`, así que dos notificaciones que llegan casi juntas (un bloqueo seguido inmediatamente de un desbloqueo, o `SessionLogoff` y `ConsoleDisconnect` por la misma acción) se ejecutan en hilos distintos del thread pool y pueden ejecutarse de forma concurrente o intercambiar el orden. El canal de arriba preserva el orden de las llamadas a `TryWrite`, no el orden en que Windows las envió.

Si el orden importa para tu lógica, trata el evento como una pista y vuelve a leer el estado real: consulta la sesión con `WTSQuerySessionInformation` (siguiente sección) cuando proceses el evento, y actúa según lo que obtengas en lugar de basarte solo en el código de motivo.

### Obtener el nombre de usuario a partir de un id de sesión

`SessionChangeDescription` solo contiene un número. Para registrar *quién* bloqueó o inició sesión, consulta el nombre de usuario y el dominio de la sesión con `WTSQuerySessionInformation(..., WTSUserName)` y `WTSDomainName` usando el mismo patrón de P/Invoke que se muestra abajo. Hazlo pronto: después de `SessionLogoff` la sesión se está desmontando y la consulta puede devolver una cadena vacía.

## Consultar el estado de bloqueo actual

Los eventos te informan de las transiciones. Al arrancar necesitas el estado actual, porque nadie te va a avisar de que la sesión ya estaba bloqueada cuando se lanzó tu app. `WTSQuerySessionInformation` con la clase `WTSSessionInfoEx` devuelve un `WTSINFOEXW` cuyo campo `SessionFlags` contiene `WTS_SESSIONSTATE_LOCK` (0) o `WTS_SESSIONSTATE_UNLOCK` (1):

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

Hay tres detalles ahí que es fácil equivocar:

- **El offset es 8, no 4.** La unión dentro de `WTSINFOEXW` contiene miembros `LARGE_INTEGER`, así que está alineada a 8 bytes tanto en x86 como en x64. Leer `SessionFlags` en `4 + 4 + 4` te da basura. Serializar solo los tres primeros campos de `WTSINFOEX_LEVEL1_W` evita declarar los búferes de nombre de tamaño fijo que no necesitas.
- **Windows 7 y Server 2008 R2 intercambian los valores.** La página de MS Learn de `WTSINFOEX_LEVEL1_W` documenta un defecto de código por el que `LOCK` significa desbloqueado y viceversa en esas versiones. Puede que ya no distribuyas para Windows 7, pero todavía existen equipos con Server 2008 R2 en algunas flotas, y la comprobación no cuesta nada.
- **Un servicio pasa un id de sesión real.** `WTS_CURRENT_SESSION` desde un servicio significa la sesión 0. Pasa `SessionChangeDescription.SessionId`, o `WTSGetActiveConsoleSessionId()` para quien esté en la consola física.

`SessionFlags` también puede ser `WTS_SESSIONSTATE_UNKNOWN` (`0xFFFFFFFF`), por ejemplo para una sesión sin usuario, y por eso el método devuelve `bool?`.

## Enganchar WM_WTSSESSION_CHANGE tú mismo

`SystemEvents` es cómodo, pero cuesta un hilo adicional y una ventana oculta, y despacha a través de `Delegate.DynamicInvoke`. Si ya tienes tu propia ventana, registrarla directamente es más ligero y te da el id de sesión en `lParam`, además de `WTS_SESSION_CREATE` (0xA) y `WTS_SESSION_TERMINATE` (0xB), que los enums administrados no nombran. En WPF, engancha el `HwndSource`:

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

En WinForms lo mismo es un override de `WndProc` más el registro en `OnHandleCreated` y la cancelación del registro en `OnHandleDestroyed`. Usa los eventos del handle en lugar del constructor y `Dispose`, porque WinForms puede recrear el handle de un formulario (cambiar `ShowInTaskbar` o `RightToLeft` lo hace), y el nuevo handle no queda registrado:

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

La documentación de Win32 exige un `WTSUnRegisterSessionNotification` por cada registro exitoso antes de que se destruya la ventana. Omitirlo no hace fallar nada, pero es el tipo de fuga que aparece como ticket de soporte dos años después.

## Problemas que aparecen en producción

- **Un inicio automático temprano puede perder el registro.** `WTSRegisterSessionNotification` puede fallar con `RPC_S_INVALID_BINDING` si se ejecuta antes de que Remote Desktop Services esté listo; la documentación indica esperar al evento `Global\TermSrvReadyEvent`. `SystemEvents` se registra una sola vez, en la primera suscripción a `SessionSwitch`, y no comprueba el resultado. Una app lanzada desde una clave `Run` al iniciar sesión casi siempre está bien, pero algo que arranca muy temprano en el arranque debería registrarse directamente y reintentar, o simplemente ser un servicio.
- **Un bloqueo no siempre es un `SessionLock`.** El cambio rápido de usuario normalmente produce `ConsoleDisconnect` para la sesión que se abandona, y reconectar por RDP a una sesión existente produce `RemoteConnect`. Si lo que realmente quieres decir es "el usuario no está mirando esta sesión", maneja también los motivos de desconexión y confirma con `IsLocked()`.
- **No uses los eventos de cierre de sesión para guardar trabajo.** Para cuando `SessionLogoff` llega a un servicio, los procesos del usuario se están cerrando. Las apps de escritorio que necesitan persistir estado al cerrar sesión o apagar deberían manejar `SystemEvents.SessionEnding` (emitido desde `WM_QUERYENDSESSION`, cancelable en teoría) o `SessionEnded` (desde `WM_ENDSESSION`), y hacerlo rápido.
- **Nunca bloquees el handler.** Eso vale para el hilo `.NET System Events` y para el callback del thread pool del servicio. Escribir en un canal y retornar es el comportamiento seguro por defecto, que es también como [la comparación de BackgroundService](/es/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) recomienda alimentar trabajo de larga duración a un hosted service.
- **La sesión 0 no tiene escritorio.** Un servicio que reacciona a `SessionLogon` mostrando UI no la mostrará en ningún lado. Lanza un proceso auxiliar en la sesión del usuario (`WTSQueryUserToken` más `CreateProcessAsUser`) o haz que una app de bandeja por usuario escuche `SessionSwitch` y se comunique con el servicio mediante una named pipe.

Si necesitas recordar una sola regla: dentro de la sesión del usuario, usa `SystemEvents.SessionSwitch` (o el mensaje de ventana directo si tienes tu propia ventana) y espera eventos de bloqueo, desbloqueo y conexión, pero no tu propio inicio de sesión. A través de todas las sesiones, usa un servicio con `OnSessionChange`, y vuelve a consultar el estado cuando el orden importe.

## Fuentes

- [Evento SystemEvents.SessionSwitch](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.systemevents.sessionswitch) en MS Learn
- [ServiceBase.OnSessionChange](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.onsessionchange) y [CanHandleSessionChangeEvent](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.canhandlesessionchangeevent)
- [WTSRegisterSessionNotification](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification) y [WM_WTSSESSION_CHANGE](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)
- [WTSINFOEX_LEVEL1_W](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w), incluido el defecto de los flags en Windows 7
- [SystemEvents.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Win32.SystemEvents/src/Microsoft/Win32/SystemEvents.cs) y [dotnet/runtime PR #53467](https://github.com/dotnet/runtime/pull/53467), que hizo incondicional el hilo del bucle de mensajes
- [ServiceBase.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.ServiceProcess.ServiceController/src/System/ServiceProcess/ServiceBase.cs) y [WindowsServiceLifetime.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.WindowsServices/src/WindowsServiceLifetime.cs) en dotnet/runtime
