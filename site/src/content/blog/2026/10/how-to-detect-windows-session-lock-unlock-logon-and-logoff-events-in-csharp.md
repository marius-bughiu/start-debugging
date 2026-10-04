---
title: "How to detect Windows session lock, unlock, logon and logoff events in a C# app"
description: "Use SystemEvents.SessionSwitch in a desktop or console app, override OnSessionChange in a Windows service, or hook WM_WTSSESSION_CHANGE yourself. Covers .NET 10 code for all three, the hidden '.NET System Events' thread, why services see logon but desktop apps do not, out-of-order notifications, and how to query the current lock state with WTSQuerySessionInformation."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "windows"
  - "worker-service"
  - "how-to"
---

Short answer: in a process that runs inside the user's session (WinForms, WPF, or a plain console app), subscribe to `Microsoft.Win32.SystemEvents.SessionSwitch` and switch on `e.Reason`: `SessionLock`, `SessionUnlock`, `SessionLogon`, `SessionLogoff`, plus the console and remote connect/disconnect values. In a Windows service, set `CanHandleSessionChangeEvent = true` and override `ServiceBase.OnSessionChange`, which with the .NET generic host means subclassing `WindowsServiceLifetime`. Both are thin wrappers over the same Win32 notification, `WM_WTSSESSION_CHANGE`, which you can also hook directly from a window procedure. To ask "is the session locked right now?" instead of waiting for an event, call `WTSQuerySessionInformation` with `WTSSessionInfoEx`.

The code in this post targets .NET 10 (SDK 10.0.302) with `Microsoft.Win32.SystemEvents` 10.0.12 and `Microsoft.Extensions.Hosting.WindowsServices` 10.0.12. Every snippet was compile-checked against `net10.0-windows`, and the behavioural claims about threading come from the `dotnet/runtime` source for those packages, which I link at the end. The APIs underneath are unchanged since Windows Vista, so the same approach works on .NET 8, .NET 9 and the .NET 11 RC.

## Which API sees which event

Windows raises one notification per session state change, and every managed API is a different way of receiving it. The values are the same everywhere, which is useful when you mix approaches:

| Value | `SessionSwitchReason` / `SessionChangeReason` | Meaning |
|---|---|---|
| 1 | `ConsoleConnect` | A session connected to the physical console |
| 2 | `ConsoleDisconnect` | A session disconnected from the console (fast user switching) |
| 3 | `RemoteConnect` | A session connected over Remote Desktop |
| 4 | `RemoteDisconnect` | A Remote Desktop client disconnected |
| 5 | `SessionLogon` | A user logged on |
| 6 | `SessionLogoff` | A user logged off |
| 7 | `SessionLock` | The session was locked |
| 8 | `SessionUnlock` | The session was unlocked |
| 9 | `SessionRemoteControl` | Remote control status changed |

The important difference is not the values but *who* receives them. A window registered with `NOTIFY_FOR_THIS_SESSION` only hears about its own session. A Windows service runs in session 0 and receives notifications for every session on the machine. That has a consequence people trip over constantly: **a desktop app never sees its own `SessionLogon`**, because it was started after the logon happened, and it rarely sees its own `SessionLogoff`, because it is being torn down at that moment. If "logon" and "logoff" are what you actually need, you want a service, or `SystemEvents.SessionEnding` for the logoff side. Lock and unlock work fine from both.

## Desktop and console apps: SystemEvents.SessionSwitch

For WinForms and WPF, `Microsoft.Win32.SystemEvents` is already part of the Windows Desktop shared framework. For a console app or a library, add the package:

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

The `-windows` TFM is not strictly required: the package also ships a plain `net10.0` assembly. On Linux and macOS that assembly is a stub that throws `PlatformNotSupportedException`, so targeting `net10.0-windows` turns a runtime surprise into a CA1416 analyzer warning at the call site. `AllowUnsafeBlocks` is only needed for the `LibraryImport` code later in the post.

The event itself is a few lines:

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

Press Win+L and unlock, and you get `SessionLock` followed by `SessionUnlock`. Switch users with fast user switching and you get `ConsoleDisconnect` when you leave and `ConsoleConnect` when you come back, usually alongside the lock and unlock. RDP into the machine as the same user and that session reports `ConsoleDisconnect` followed by `RemoteConnect`.

### Where the message pump comes from

Older answers on this topic say `SessionSwitch` "only works if you have a message loop", and the MS Learn page for the event still carries that note. On modern .NET that is only half true. Since .NET 6 (dotnet/runtime PR #53467, "Always spawn message loop thread for SystemEvents"), the first subscription to any `SystemEvents` event creates a hidden `WS_POPUP` window on a dedicated background thread named `.NET System Events` and runs `GetMessage`/`DispatchMessage` on it. The comment in the source is explicit: it always creates its own thread, even when the calling thread is STA, because there is no guarantee that thread will keep pumping. So a console app with no UI receives the events without any extra work.

Subscribing to `SessionSwitch` specifically also calls `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` for that hidden window. That is where the "this session only" scope comes from.

### Which thread your handler runs on

When you subscribe, `SystemEvents` captures `AsyncOperationManager.SynchronizationContext` and later calls `Send` on it:

- In WinForms or WPF, subscribing from the UI thread captures the UI context, so your handler is marshalled to the UI thread. You can touch controls directly.
- In a console app or worker, there is no context, so the captured one is a plain `SynchronizationContext` whose `Send` runs inline. Your handler executes on the `.NET System Events` thread.

The second case matters. That thread is also what dispatches `PowerModeChanged`, `UserPreferenceChanged`, `DisplaySettingsChanged` and the rest. If your lock handler does a blocking HTTP call or waits on a lock, every other system event in the process waits too. Hand the work off immediately, for example to a `Channel<T>` (the pattern from [using channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) fits perfectly here) or to `Task.Run`.

### The static event leak

`SessionSwitch` is a static event. A handler that captures `this` keeps the whole object graph alive until you unsubscribe, which is the textbook way a closed WPF window ends up surviving for the life of the process. The MS Learn remarks warn about it explicitly. Unsubscribe in `Dispose`, `OnClosed` or a `finally`, and if you are chasing a window that will not die, [a `dotnet-gcdump` comparison](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) will show `SystemEvents` holding it.

## Windows services: OnSessionChange and the generic host

A service cannot use `SystemEvents.SessionSwitch` usefully. It runs in session 0, so `NOTIFY_FOR_THIS_SESSION` scopes the hidden window to session 0, where nobody locks or unlocks anything. The `WTSRegisterSessionNotification` documentation says it plainly: services receive these notifications through their service control handler (`HandlerEx` with `SERVICE_CONTROL_SESSIONCHANGE`), not through a window.

`System.ServiceProcess.ServiceBase` already wires that up. You opt in with `CanHandleSessionChangeEvent = true` and override `OnSessionChange(SessionChangeDescription)`, which gives you the `Reason` and the `SessionId` of the affected session. With a modern worker service, `ServiceBase` is hidden inside `WindowsServiceLifetime`, which is public and not sealed. The cleanest approach is to subclass it and register your subclass as the `IHostLifetime`:

1. Reference `Microsoft.Extensions.Hosting.WindowsServices` and call `AddWindowsService()` as usual.
2. Subclass `WindowsServiceLifetime`, set `CanHandleSessionChangeEvent = true` in the constructor, and override `OnSessionChange`.
3. Register the subclass as `IHostLifetime` *after* `AddWindowsService`, only when running as a service, so the last registration wins.
4. Push each notification into a channel and process it in a `BackgroundService`.

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

The constructor matters. `CanHandleSessionChangeEvent` adds `SERVICE_ACCEPT_SESSIONCHANGE` to the accepted controls that are reported to the Service Control Manager when the service starts, and the setter throws `InvalidOperationException` once the service is running. Setting it in the constructor is early enough, because `WindowsServiceLifetime` only calls `ServiceBase.Run` from `WaitForStartAsync`.

The `IsWindowsService()` guard keeps `dotnet run` working: outside the SCM, `AddWindowsService` registers nothing, and you do not want a `ServiceBase` lifetime when debugging from a console. If the `IHostLifetime` and `BackgroundService` split is new to you, [the IHostedService contract post](/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) walks through what the host calls and when.

Unlike a desktop app, this service sees every user: logons at boot, logoffs, lock and unlock in each session, and RDP connects. That makes it the right tool for "track when users log on to this machine" or "pause the job while anyone is locked out".

### Notifications can arrive out of order

`ServiceBase` does not call `OnSessionChange` on the SCM's dispatcher thread. Each `SERVICE_CONTROL_SESSIONCHANGE` is queued with `ThreadPool.QueueUserWorkItem`, so two notifications that arrive close together (a lock immediately followed by an unlock, or `SessionLogoff` and `ConsoleDisconnect` from the same action) run on different thread pool threads and can execute concurrently or swap order. The channel above preserves the order of `TryWrite` calls, not the order Windows sent them.

If ordering matters for your logic, treat the event as a hint and re-read the actual state: query the session with `WTSQuerySessionInformation` (next section) when you process the event, and act on what you get back instead of on the reason code alone.

### Getting the user name from a session id

`SessionChangeDescription` only carries a number. To log *who* locked or logged on, query the session's user name and domain with `WTSQuerySessionInformation(..., WTSUserName)` and `WTSDomainName` using the same P/Invoke pattern as below. Do it promptly: after `SessionLogoff` the session is being torn down and the query can return an empty string.

## Asking for the current lock state

Events tell you about transitions. On startup you need the current state, because nobody will tell you the session was already locked when your app launched. `WTSQuerySessionInformation` with the `WTSSessionInfoEx` class returns a `WTSINFOEXW` whose `SessionFlags` field holds `WTS_SESSIONSTATE_LOCK` (0) or `WTS_SESSIONSTATE_UNLOCK` (1):

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

Three details in there are easy to get wrong:

- **The offset is 8, not 4.** The union inside `WTSINFOEXW` contains `LARGE_INTEGER` members, so it is 8-byte aligned on both x86 and x64. Reading `SessionFlags` at `4 + 4 + 4` gives you garbage. Marshalling only the first three fields of `WTSINFOEX_LEVEL1_W` avoids declaring the fixed-size name buffers you do not need.
- **Windows 7 and Server 2008 R2 swap the values.** The MS Learn page for `WTSINFOEX_LEVEL1_W` documents a code defect where `LOCK` means unlocked and vice versa on those versions. You may not ship to Windows 7 any more, but Server 2008 R2 boxes still exist in some fleets, and the check costs nothing.
- **A service passes a real session id.** `WTS_CURRENT_SESSION` from a service means session 0. Pass `SessionChangeDescription.SessionId`, or `WTSGetActiveConsoleSessionId()` for whoever is at the physical console.

`SessionFlags` can also be `WTS_SESSIONSTATE_UNKNOWN` (`0xFFFFFFFF`), for example for a session with no user, which is why the method returns `bool?`.

## Hooking WM_WTSSESSION_CHANGE yourself

`SystemEvents` is convenient, but it costs an extra thread and a hidden window, and it marshals through `Delegate.DynamicInvoke`. If you already own a window, registering that window directly is lighter and gives you the session id in `lParam`, plus `WTS_SESSION_CREATE` (0xA) and `WTS_SESSION_TERMINATE` (0xB), which the managed enums do not name. In WPF, hook the `HwndSource`:

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

In WinForms the same thing is an override of `WndProc` plus registration in `OnHandleCreated` and unregistration in `OnHandleDestroyed`. Use the handle events rather than the constructor and `Dispose`, because WinForms can recreate a form's handle (changing `ShowInTaskbar` or `RightToLeft` does it), and the new handle is not registered:

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

The Win32 docs require one `WTSUnRegisterSessionNotification` per successful registration before the window is destroyed. Skipping it does not crash anything, but it is the kind of leak that shows up as a support ticket two years later.

## Gotchas that show up in production

- **Early autostart can miss the registration.** `WTSRegisterSessionNotification` can fail with `RPC_S_INVALID_BINDING` if it runs before Remote Desktop Services is ready; the docs say to wait for the `Global\TermSrvReadyEvent` event. `SystemEvents` registers once, on the first `SessionSwitch` subscription, and does not check the result. An app launched from a `Run` key at logon is almost always fine, but something that starts very early in boot should register directly and retry, or simply be a service.
- **A lock is not always a `SessionLock`.** Fast user switching typically produces `ConsoleDisconnect` for the session being left, and reconnecting RDP to an existing session produces `RemoteConnect`. If what you really mean is "the user is not looking at this session", handle the disconnect reasons too, and confirm with `IsLocked()`.
- **Do not use logoff events to save work.** By the time `SessionLogoff` reaches a service, the user's processes are being shut down. Desktop apps that need to persist state on logoff or shutdown should handle `SystemEvents.SessionEnding` (raised from `WM_QUERYENDSESSION`, cancellable in theory) or `SessionEnded` (from `WM_ENDSESSION`), and do it fast.
- **Never block the handler.** That is true for the `.NET System Events` thread and for the service's thread pool callback. Writing to a channel and returning is the safe default, which is also how [the BackgroundService comparison](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) recommends feeding long-running work into a hosted service.
- **Session 0 has no desktop.** A service that reacts to `SessionLogon` by showing UI will show it nowhere. Launch a helper process into the user's session (`WTSQueryUserToken` plus `CreateProcessAsUser`) or have a per-user tray app listen to `SessionSwitch` and talk to the service over a named pipe.

If you need one rule to remember: inside the user's session, use `SystemEvents.SessionSwitch` (or the raw window message if you own a window) and expect lock, unlock and connect events but not your own logon. Across all sessions, use a service with `OnSessionChange`, and re-query the state when order matters.

## Sources

- [SystemEvents.SessionSwitch event](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.systemevents.sessionswitch) on MS Learn
- [ServiceBase.OnSessionChange](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.onsessionchange) and [CanHandleSessionChangeEvent](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.canhandlesessionchangeevent)
- [WTSRegisterSessionNotification](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification) and [WM_WTSSESSION_CHANGE](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)
- [WTSINFOEX_LEVEL1_W](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w), including the Windows 7 flag defect
- [SystemEvents.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Win32.SystemEvents/src/Microsoft/Win32/SystemEvents.cs) and [dotnet/runtime PR #53467](https://github.com/dotnet/runtime/pull/53467), which made the message loop thread unconditional
- [ServiceBase.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.ServiceProcess.ServiceController/src/System/ServiceProcess/ServiceBase.cs) and [WindowsServiceLifetime.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.WindowsServices/src/WindowsServiceLifetime.cs) in dotnet/runtime
