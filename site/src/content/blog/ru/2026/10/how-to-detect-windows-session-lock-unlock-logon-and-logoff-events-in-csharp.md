---
title: "Как отслеживать блокировку, разблокировку, вход и выход из сеанса Windows в приложении на C#"
description: "Используйте SystemEvents.SessionSwitch в настольном или консольном приложении, переопределите OnSessionChange в службе Windows или перехватывайте WM_WTSSESSION_CHANGE самостоятельно. Код на .NET 10 для всех трёх вариантов, скрытый поток '.NET System Events', почему служба видит вход в систему, а настольное приложение нет, уведомления не по порядку и как узнать текущее состояние блокировки через WTSQuerySessionInformation."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "windows"
  - "worker-service"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-04
---

Короткий ответ: в процессе, который работает внутри сеанса пользователя (WinForms, WPF или обычное консольное приложение), подпишитесь на `Microsoft.Win32.SystemEvents.SessionSwitch` и разбирайте `e.Reason`: `SessionLock`, `SessionUnlock`, `SessionLogon`, `SessionLogoff`, а также значения подключения и отключения консоли и удалённого сеанса. В службе Windows установите `CanHandleSessionChangeEvent = true` и переопределите `ServiceBase.OnSessionChange`, что при использовании универсального хоста .NET означает наследование от `WindowsServiceLifetime`. Оба варианта представляют собой тонкие обёртки над одним и тем же уведомлением Win32, `WM_WTSSESSION_CHANGE`, которое можно перехватить и напрямую из оконной процедуры. Чтобы спросить "заблокирован ли сеанс прямо сейчас?", а не ждать события, вызовите `WTSQuerySessionInformation` с `WTSSessionInfoEx`.

Код в этой статье рассчитан на .NET 10 (SDK 10.0.302) с `Microsoft.Win32.SystemEvents` 10.0.12 и `Microsoft.Extensions.Hosting.WindowsServices` 10.0.12. Каждый фрагмент проверен компиляцией под `net10.0-windows`, а утверждения о потоках основаны на исходном коде этих пакетов в `dotnet/runtime`, ссылки на который приведены в конце. Нижележащие API не менялись со времён Windows Vista, поэтому тот же подход работает на .NET 8, .NET 9 и .NET 11 RC.

## Какой API видит какое событие

Windows генерирует одно уведомление на каждое изменение состояния сеанса, а каждый управляемый API лишь по-своему его принимает. Значения везде одинаковые, что удобно, когда подходы смешиваются:

| Значение | `SessionSwitchReason` / `SessionChangeReason` | Смысл |
|---|---|---|
| 1 | `ConsoleConnect` | Сеанс подключился к физической консоли |
| 2 | `ConsoleDisconnect` | Сеанс отключился от консоли (быстрое переключение пользователей) |
| 3 | `RemoteConnect` | Сеанс подключился через Remote Desktop |
| 4 | `RemoteDisconnect` | Клиент Remote Desktop отключился |
| 5 | `SessionLogon` | Пользователь вошёл в систему |
| 6 | `SessionLogoff` | Пользователь вышел из системы |
| 7 | `SessionLock` | Сеанс заблокирован |
| 8 | `SessionUnlock` | Сеанс разблокирован |
| 9 | `SessionRemoteControl` | Изменилось состояние удалённого управления |

Важное различие не в значениях, а в том, *кто* их получает. Окно, зарегистрированное с `NOTIFY_FOR_THIS_SESSION`, узнаёт только о своём сеансе. Служба Windows работает в сеансе 0 и получает уведомления обо всех сеансах на машине. Из этого следует то, на чём постоянно спотыкаются: **настольное приложение никогда не видит собственный `SessionLogon`**, потому что оно запущено уже после входа в систему, и редко видит собственный `SessionLogoff`, потому что в этот момент оно как раз завершается. Если вам действительно нужны вход и выход, вам нужна служба или `SystemEvents.SessionEnding` для стороны выхода. Блокировка и разблокировка прекрасно работают в обоих случаях.

## Настольные и консольные приложения: SystemEvents.SessionSwitch

Для WinForms и WPF `Microsoft.Win32.SystemEvents` уже входит в общий фреймворк Windows Desktop. Для консольного приложения или библиотеки добавьте пакет:

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

TFM `-windows` не обязателен: пакет содержит и обычную сборку `net10.0`. В Linux и macOS эта сборка является заглушкой, которая выбрасывает `PlatformNotSupportedException`, поэтому нацеливание на `net10.0-windows` превращает сюрприз во время выполнения в предупреждение анализатора CA1416 в месте вызова. `AllowUnsafeBlocks` нужен только для кода с `LibraryImport` далее в статье.

Само событие занимает несколько строк:

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

Нажмите Win+L и разблокируйте, и вы получите `SessionLock`, а затем `SessionUnlock`. Переключитесь на другого пользователя через быстрое переключение, и при уходе придёт `ConsoleDisconnect`, а при возвращении `ConsoleConnect`, обычно вместе с блокировкой и разблокировкой. Подключитесь к машине по RDP под тем же пользователем, и этот сеанс сообщит `ConsoleDisconnect`, а затем `RemoteConnect`.

### Откуда берётся цикл обработки сообщений

В старых ответах на эту тему говорится, что `SessionSwitch` "работает только при наличии цикла сообщений", и страница MS Learn для этого события до сих пор содержит такое примечание. В современном .NET это верно лишь наполовину. Начиная с .NET 6 (dotnet/runtime PR #53467, "Always spawn message loop thread for SystemEvents") первая подписка на любое событие `SystemEvents` создаёт скрытое окно `WS_POPUP` в выделенном фоновом потоке с именем `.NET System Events` и запускает в нём `GetMessage`/`DispatchMessage`. Комментарий в исходном коде говорит об этом прямо: собственный поток создаётся всегда, даже если вызывающий поток является STA, потому что нет гарантии, что тот продолжит обрабатывать сообщения. Поэтому консольное приложение без UI получает события без какой-либо дополнительной работы.

Подписка именно на `SessionSwitch` также вызывает `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` для этого скрытого окна. Отсюда и ограничение "только этот сеанс".

### В каком потоке выполняется обработчик

При подписке `SystemEvents` захватывает `AsyncOperationManager.SynchronizationContext` и позже вызывает на нём `Send`:

- В WinForms или WPF подписка из UI-потока захватывает контекст UI, поэтому обработчик маршалируется в UI-поток. С элементами управления можно работать напрямую.
- В консольном приложении или worker контекста нет, поэтому захватывается обычный `SynchronizationContext`, чей `Send` выполняется синхронно на месте. Обработчик выполняется в потоке `.NET System Events`.

Второй случай важен. Этот же поток рассылает `PowerModeChanged`, `UserPreferenceChanged`, `DisplaySettingsChanged` и остальные события. Если обработчик блокировки делает блокирующий HTTP-вызов или ждёт lock, все остальные системные события в процессе тоже ждут. Передавайте работу дальше немедленно, например в `Channel<T>` (паттерн из статьи [об использовании каналов вместо BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) здесь подходит идеально) или в `Task.Run`.

### Утечка через статическое событие

`SessionSwitch` является статическим событием. Обработчик, который захватывает `this`, удерживает весь граф объектов, пока вы не отпишетесь, и это хрестоматийный способ, которым закрытое окно WPF доживает до конца жизни процесса. В примечаниях MS Learn об этом прямо предупреждают. Отписывайтесь в `Dispose`, `OnClosed` или `finally`, а если вы ищете окно, которое никак не умирает, [сравнение снимков `dotnet-gcdump`](/ru/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) покажет, что его удерживает `SystemEvents`.

## Службы Windows: OnSessionChange и универсальный хост

Служба не может с пользой использовать `SystemEvents.SessionSwitch`. Она работает в сеансе 0, поэтому `NOTIFY_FOR_THIS_SESSION` ограничивает скрытое окно сеансом 0, где никто ничего не блокирует и не разблокирует. Документация `WTSRegisterSessionNotification` говорит об этом прямо: службы получают эти уведомления через свой обработчик управления службой (`HandlerEx` с `SERVICE_CONTROL_SESSIONCHANGE`), а не через окно.

`System.ServiceProcess.ServiceBase` уже всё это подключает. Вы включаете поддержку через `CanHandleSessionChangeEvent = true` и переопределяете `OnSessionChange(SessionChangeDescription)`, который передаёт `Reason` и `SessionId` затронутого сеанса. В современной worker-службе `ServiceBase` спрятан внутри `WindowsServiceLifetime`, который является открытым и не запечатанным. Самый чистый подход: унаследоваться от него и зарегистрировать наследника как `IHostLifetime`:

1. Подключите `Microsoft.Extensions.Hosting.WindowsServices` и, как обычно, вызовите `AddWindowsService()`.
2. Унаследуйтесь от `WindowsServiceLifetime`, установите `CanHandleSessionChangeEvent = true` в конструкторе и переопределите `OnSessionChange`.
3. Зарегистрируйте наследника как `IHostLifetime` *после* `AddWindowsService` и только при запуске в качестве службы, чтобы победила последняя регистрация.
4. Отправляйте каждое уведомление в канал и обрабатывайте его в `BackgroundService`.

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

Конструктор здесь важен. `CanHandleSessionChangeEvent` добавляет `SERVICE_ACCEPT_SESSIONCHANGE` к принимаемым управляющим кодам, о которых сообщается диспетчеру управления службами при запуске службы, а сеттер выбрасывает `InvalidOperationException`, как только служба запущена. Установка в конструкторе происходит достаточно рано, потому что `WindowsServiceLifetime` вызывает `ServiceBase.Run` только из `WaitForStartAsync`.

Проверка `IsWindowsService()` сохраняет работоспособность `dotnet run`: вне SCM `AddWindowsService` ничего не регистрирует, а время жизни на основе `ServiceBase` при отладке из консоли вам не нужно. Если разделение на `IHostLifetime` и `BackgroundService` для вас в новинку, [статья о контракте IHostedService](/ru/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) разбирает, что и когда вызывает хост.

В отличие от настольного приложения, эта служба видит всех пользователей: входы при загрузке, выходы, блокировку и разблокировку в каждом сеансе, а также подключения по RDP. Поэтому она является правильным инструментом для задач вроде "отслеживать, когда пользователи входят на эту машину" или "приостанавливать задание, пока кто-то заблокирован".

### Уведомления могут приходить не по порядку

`ServiceBase` не вызывает `OnSessionChange` в потоке диспетчера SCM. Каждый `SERVICE_CONTROL_SESSIONCHANGE` ставится в очередь через `ThreadPool.QueueUserWorkItem`, поэтому два уведомления, пришедшие почти одновременно (блокировка, сразу за которой следует разблокировка, или `SessionLogoff` и `ConsoleDisconnect` от одного действия), выполняются в разных потоках пула и могут выполняться параллельно или поменяться местами. Канал выше сохраняет порядок вызовов `TryWrite`, а не порядок, в котором их отправила Windows.

Если порядок важен для вашей логики, воспринимайте событие как подсказку и перечитывайте фактическое состояние: при обработке события запрашивайте сеанс через `WTSQuerySessionInformation` (следующий раздел) и действуйте по полученному результату, а не только по коду причины.

### Получение имени пользователя по идентификатору сеанса

`SessionChangeDescription` содержит только число. Чтобы записать в журнал, *кто* заблокировал сеанс или вошёл в систему, запросите имя пользователя и домен сеанса через `WTSQuerySessionInformation(..., WTSUserName)` и `WTSDomainName`, используя тот же паттерн P/Invoke, что и ниже. Делайте это без промедления: после `SessionLogoff` сеанс уже разбирается, и запрос может вернуть пустую строку.

## Запрос текущего состояния блокировки

События сообщают о переходах. При запуске же нужно текущее состояние, потому что никто не скажет вам, что сеанс уже был заблокирован, когда приложение стартовало. `WTSQuerySessionInformation` с классом `WTSSessionInfoEx` возвращает `WTSINFOEXW`, поле `SessionFlags` которого содержит `WTS_SESSIONSTATE_LOCK` (0) или `WTS_SESSIONSTATE_UNLOCK` (1):

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

Здесь есть три детали, в которых легко ошибиться:

- **Смещение равно 8, а не 4.** Объединение внутри `WTSINFOEXW` содержит члены `LARGE_INTEGER`, поэтому оно выровнено по 8 байтам как на x86, так и на x64. Чтение `SessionFlags` по смещению `4 + 4 + 4` даёт мусор. Маршалинг только первых трёх полей `WTSINFOEX_LEVEL1_W` избавляет от необходимости объявлять ненужные буферы имён фиксированного размера.
- **Windows 7 и Server 2008 R2 меняют значения местами.** Страница MS Learn для `WTSINFOEX_LEVEL1_W` документирует дефект в коде, из-за которого на этих версиях `LOCK` означает "разблокирован" и наоборот. Возможно, вы больше не поставляете ПО под Windows 7, но машины с Server 2008 R2 в некоторых парках всё ещё встречаются, а проверка ничего не стоит.
- **Служба передаёт реальный идентификатор сеанса.** `WTS_CURRENT_SESSION` из службы означает сеанс 0. Передавайте `SessionChangeDescription.SessionId` или `WTSGetActiveConsoleSessionId()` для того, кто сидит за физической консолью.

`SessionFlags` также может быть равен `WTS_SESSIONSTATE_UNKNOWN` (`0xFFFFFFFF`), например для сеанса без пользователя, поэтому метод возвращает `bool?`.

## Самостоятельный перехват WM_WTSSESSION_CHANGE

`SystemEvents` удобен, но обходится в дополнительный поток и скрытое окно, а маршалинг идёт через `Delegate.DynamicInvoke`. Если у вас уже есть собственное окно, прямая регистрация этого окна легче и даёт идентификатор сеанса в `lParam`, а также `WTS_SESSION_CREATE` (0xA) и `WTS_SESSION_TERMINATE` (0xB), для которых в управляемых перечислениях нет имён. В WPF подключитесь к `HwndSource`:

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

В WinForms то же самое делается переопределением `WndProc`, регистрацией в `OnHandleCreated` и отменой регистрации в `OnHandleDestroyed`. Используйте события дескриптора, а не конструктор и `Dispose`, потому что WinForms может пересоздать дескриптор формы (это происходит, например, при изменении `ShowInTaskbar` или `RightToLeft`), и новый дескриптор не будет зарегистрирован:

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

Документация Win32 требует вызывать `WTSUnRegisterSessionNotification` один раз на каждую успешную регистрацию до уничтожения окна. Пропуск этого вызова ничего не роняет, но это именно та утечка, которая через два года всплывает в виде обращения в поддержку.

## Подводные камни, которые проявляются в продакшене

- **Ранний автозапуск может пропустить регистрацию.** `WTSRegisterSessionNotification` может завершиться ошибкой `RPC_S_INVALID_BINDING`, если вызван до готовности служб удалённых рабочих столов; документация предписывает дождаться события `Global\TermSrvReadyEvent`. `SystemEvents` регистрируется один раз, при первой подписке на `SessionSwitch`, и не проверяет результат. Приложение, запускаемое из ключа `Run` при входе в систему, почти всегда в порядке, но то, что стартует очень рано при загрузке, должно регистрироваться напрямую с повторными попытками или просто быть службой.
- **Блокировка не всегда приходит как `SessionLock`.** Быстрое переключение пользователей обычно порождает `ConsoleDisconnect` для покидаемого сеанса, а повторное подключение по RDP к существующему сеансу порождает `RemoteConnect`. Если на самом деле вы имеете в виду "пользователь не смотрит на этот сеанс", обрабатывайте и причины отключения, а затем подтверждайте через `IsLocked()`.
- **Не используйте события выхода для сохранения работы.** К тому моменту, когда `SessionLogoff` доходит до службы, процессы пользователя уже завершаются. Настольные приложения, которым нужно сохранить состояние при выходе или выключении, должны обрабатывать `SystemEvents.SessionEnding` (генерируется из `WM_QUERYENDSESSION`, теоретически отменяемое) или `SessionEnded` (из `WM_ENDSESSION`) и делать это быстро.
- **Никогда не блокируйте обработчик.** Это верно и для потока `.NET System Events`, и для обратного вызова пула потоков в службе. Запись в канал с немедленным возвратом является безопасным вариантом по умолчанию, и именно так [сравнение BackgroundService](/ru/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) рекомендует передавать длительную работу в размещённую службу.
- **В сеансе 0 нет рабочего стола.** Служба, которая реагирует на `SessionLogon` показом UI, покажет его в никуда. Запустите вспомогательный процесс в сеансе пользователя (`WTSQueryUserToken` плюс `CreateProcessAsUser`) или сделайте так, чтобы приложение в трее для каждого пользователя слушало `SessionSwitch` и общалось со службой через именованный канал.

Если нужно запомнить одно правило: внутри сеанса пользователя используйте `SystemEvents.SessionSwitch` (или сырое оконное сообщение, если окно ваше) и ожидайте события блокировки, разблокировки и подключения, но не собственного входа в систему. Для всех сеансов используйте службу с `OnSessionChange` и перезапрашивайте состояние, когда важен порядок.

## Источники

- [Событие SystemEvents.SessionSwitch](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.systemevents.sessionswitch) на MS Learn
- [ServiceBase.OnSessionChange](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.onsessionchange) и [CanHandleSessionChangeEvent](https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicebase.canhandlesessionchangeevent)
- [WTSRegisterSessionNotification](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification) и [WM_WTSSESSION_CHANGE](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)
- [WTSINFOEX_LEVEL1_W](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w), включая дефект флагов в Windows 7
- [SystemEvents.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Win32.SystemEvents/src/Microsoft/Win32/SystemEvents.cs) и [dotnet/runtime PR #53467](https://github.com/dotnet/runtime/pull/53467), сделавший поток цикла сообщений безусловным
- [ServiceBase.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.ServiceProcess.ServiceController/src/System/ServiceProcess/ServiceBase.cs) и [WindowsServiceLifetime.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.WindowsServices/src/WindowsServiceLifetime.cs) в dotnet/runtime
