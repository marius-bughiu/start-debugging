---
title: "Как найти обработчики async void, вызывающие ANR в Android-приложении на .NET MAUI"
description: "Play Console сообщает, что доля ANR превысила 0.47%, и выдаёт нативную трассировку, забитую кадрами libcoreclr.so. Разбираем, как перейти от этой бесполезной трассировки к конкретному обработчику события async void, заблокировавшему главный поток: printer для Looper, обёртка SynchronizationContext, называющая машину состояний, и dotnet-trace через dsrouter."
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
lang: "ru"
translationOf: "2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-09-07
---

Короткий ответ: трассировка ANR из Google Play не назовёт ваш метод на C#, поэтому не читайте её так, будто назовёт. Перечислите все `async void` в кодовой базе с помощью VSTHRD100, сузьте список до тех, что привязаны к событиям интерфейса, а затем установите в сборку Release две вещи: `Android.Util.IPrinter` на главный `Looper`, который замеряет каждое сообщение главного потока, и обёртку `SynchronizationContext`, которая считывает упакованную асинхронную машину состояний из отправленного продолжения, чтобы в журнале появлялось `MainPage+<OnSyncClicked>d__7`, а не анонимный Runnable. Первый инструмент ловит работу до первого `await`, второй - работу после него. Вместе они дают имя метода.

Статья ориентирована на .NET 11 (`11.0.100-preview.7`, выпущен 2026-08-11, GA запланирован на 2026-11-10) с .NET MAUI 11 на `net11.0-android`, где CoreCLR является единственной мобильной средой выполнения. Всё описанное работает и на .NET 10 с Mono; различия отмечены там, где они существенны.

## Почему `async void` вообще появляется в отчётах об ANR

Сам по себе `async void` поток не блокирует. Он приводит к ANR косвенно, тремя механизмами, которые все заканчиваются в одном и том же месте.

**Синхронный префикс выполняется в потоке вызывающего кода.** Метод `async` не уступает управление на открывающей скобке. Он выполняется подряд, пока не встретит `await` над чем-то, что ещё не завершилось. В обработчике нажатия на главном потоке Android каждая строка до этой первой настоящей точки приостановки является работой главного потока, а ключевое слово `async` в сигнатуре создаёт обратное впечатление.

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

Пять секунд такого поведения, и диспетчер ввода Android сдаётся. `await` в последней строке ничем вам не помогает.

**Он лишает вызывающий код возможности дождаться результата, поэтому кто-то добавляет блокировку.** Поскольку метод `async void` не возвращает ничего, что можно ожидать, как только второй участок кода потребует его результат, путь наименьшего сопротивления - это `.Result` или `.Wait()`. В потоке с `SynchronizationContext`, который направляет продолжения обратно к самому себе, это классическая [асинхронная взаимная блокировка](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/), а в Android заблокированный поток - как раз тот, время которого Android и замеряет.

```csharp
private async void OnRefreshClicked(object sender, EventArgs e)
{
    // The handler could not be awaited, so this got "fixed" by blocking.
    var settings = _settings.LoadAsync().Result;   // main thread parked, permanently
    await ReloadAsync(settings);
}
```

**Он реентерабелен.** Ничто не мешает второму касанию запустить второй вызов, пока первый приостановлен. Два перекрывающихся запуска конкурируют за один и тот же `SemaphoreSlim` или одно и то же `SQLiteConnection`, и эта конкуренция проявляется как зависание главного потока, которое воспроизводится только при быстром двойном нажатии. Полный разбор того, когда эта конструкция уместна, есть в статье [async void vs async Task в C#: когда какой вариант правильный](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Что Android измеряет на самом деле

Знание точного бюджета подсказывает, какие обработчики стоит исследовать. Согласно [документации Android по ANR](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs):

| Триггер | Ограничение по времени |
| --- | --- |
| Диспетчеризация ввода (касание, клавиша) | 5 секунд |
| Broadcast receiver с установленным `FLAG_RECEIVER_FOREGROUND` | 10 с на Android 13 и ниже, 10-20 с на Android 14+ |
| Broadcast receiver с фоновым приоритетом | 60 с на Android 13 и ниже, 60-120 с на Android 14+ |
| `onCreate` / `onStartCommand` / `onBind` службы переднего плана | 20 секунд |
| Фоновая служба | 200 секунд |

Именно диспетчеризация ввода бьёт по приложениям MAUI, и именно её видят пользователи, потому что по определению приложение было на переднем плане и по нему нажимали. Ставки задаёт Play: воспринимаемая пользователем доля ANR - это ключевой показатель с порогом плохого поведения 0.47% в целом, оцениваемым по скользящему окну в 28 дней, и его превышение снижает обнаруживаемость приложения на всех устройствах ([требования Play Console к техническому качеству](https://support.google.com/googleplay/android-developer/answer/17492799)).

## Почему трассировки от Play недостаточно

Извлеките запись об ANR и посмотрите на главный поток. На доступном вам устройстве:

```sh
# Everything in the device's dropbox, newest last
adb shell dumpsys dropbox --print data_app_anr | tail -300

# Or the full set, which is what you want for a device that has been running a while
adb bugreport anr.zip
unzip -o anr.zip -d anr && ls anr/FS/data/anr/
```

Заголовок сообщает о триггере:

```
ANR in com.example.orders (com.example.orders/crc64e1fb321c08285b90.MainActivity)
PID: 14882
Reason: Input dispatching timed out (Waited 5003ms for MotionEvent)
```

Однако трассировку стека главного потока выгружает ART, который разрешает символы кадров Java. Ваш обработчик кадром Java не является. В Android-приложении на CoreCLR вы получите примерно такое:

```
"main" prio=5 tid=1 Native
  #00 pc 00000000000a1b3c  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+28)
  #01 pc 00000000004f21d8  /data/app/.../lib/arm64/libcoreclr.so (???)
  #02 pc 00000000004e0a44  /data/app/.../lib/arm64/libcoreclr.so (???)
  at crc64e1fb321c08285b90.MainActivity.n_onCreate(Native method)
  at android.os.Handler.dispatchMessage(Handler.java:106)
  at android.os.Looper.loop(Looper.java:294)
```

Это вся информация, которую вы получаете: безымянные нативные кадры внутри `libcoreclr.so` (`libmonosgen-2.0.so`, если вы всё ещё на Mono под .NET 10). Бесполезной её назвать нельзя. Она относит проблему к одной из трёх категорий:

- Кадры, застрявшие в `syscall`, `futex_wait` или `pthread_cond_wait` под средой выполнения: главный поток **заблокирован**, то есть речь о блокировке, `.Result`, `.Wait()` или `SemaphoreSlim.Wait()`.
- Кадры, крутящиеся внутри `libcoreclr.so` без системного вызова сверху: главный поток **выполняет управляемый код**, то есть работу, ограниченную процессором, внутри обработчика.
- `android.os.MessageQueue.nativePollOnce` на самом верху: главный поток был **простаивающим** в момент снятия дампа. ANR где-то в другом месте, либо дамп пришёл с опозданием. Android прямо документирует это, и охота на обработчики по такой сигнатуре - потраченные впустую усилия.

Есть и четвёртая форма, которую стоит распознать до начала работы: стек, остановившийся внутри `coreclr_initialize` сразу после холодного запуска. Это не ваш код, а регрессия запуска CoreCLR, зафиксированная в [dotnet/android#10588](https://github.com/dotnet/android/issues/10588), где большое приложение, стартовавшее за секунду на Mono, на CoreCLR может занимать около шести секунд и превышать бюджет операционной системы. Такие случаи группируются в vitals отдельно, под `handleBindApplication`. Если это ваш случай, решение лежит в работе над запуском, описанной в статье [перевод Android-приложения на MAUI с Mono на CoreCLR](/ru/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/), а не в разборе обработчиков.

## Процедура разбора из пяти шагов

1. **Перечислите все объявления и делегаты `async void` в решении.** Добавьте `Microsoft.VisualStudio.Threading.Analyzers` и включите VSTHRD100 (методы async void) и VSTHRD101 (делегаты и лямбды async void) как предупреждения сборки. Это даёт полный набор кандидатов за одну сборку, включая лямбды `async`, присвоенные `EventHandler`, которые текстовый поиск пропускает.
2. **Отсортируйте кандидатов по тому, могут ли они выполняться в главном потоке.** Только обработчики, достижимые из события интерфейса, из обратного вызова жизненного цикла `Loaded`/`Appearing` или из тела `MainThread.BeginInvokeOnMainThread`, способны вызвать ANR по диспетчеризации ввода. Всё остальное - проблема корректности, а не ANR.
3. **Инструментируйте главный `Looper` в сборке Release** так, чтобы каждое сообщение главного потока, превысившее порог, попадало в журнал вместе со своей длительностью. Это ловит синхронный префикс, который никогда не касается `SynchronizationContext` и потому невидим для всех остальных приёмов из этой статьи.
4. **Оберните `SynchronizationContext` главного потока** так, чтобы медленные возобновлённые продолжения записывали в журнал имя владеющей ими асинхронной машины состояний. Именно этот шаг превращает длительность в имя метода.
5. **Подтвердите результат с помощью `dotnet-trace` через `dotnet-dsrouter`** и прочитайте flame graph главного потока, чтобы исправление было измерено, а не предположено.

## Шаги 1 и 2: статический проход

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

Затем выгрузите список:

```sh
dotnet build -c Release -f net11.0-android -warnaserror:none \
  | grep -E 'VSTHRD10[01]' | sort -u
```

Ожидайте шума. VSTHRD100 срабатывает и на законных обработчиках событий, о чём давно идёт спор в [microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510): анализатор не может знать, что метод с сигнатурой `(object, EventArgs)` обязан быть `void`. Не подавляйте предупреждение, чтобы просто идти дальше. Цель шага 1 - инвентаризация, а на шаге 2 вы вручную фильтруете список до обработчиков, способных выполняться в главном потоке. В типичном приложении MAUI среднего размера список из 60 срабатываний VSTHRD100 сжимается до 8-10 реальных кандидатов.

`AsyncFixer03` из пакета AsyncFixer сообщает о той же форме "запустил и забыл", если вы предпочитаете не добавлять зависимость от vs-threading. Подойдёт любой вариант; не запускайте оба, иначе будете разбирать каждую находку дважды.

## Шаг 3: измерить каждое сообщение главного потока

`Looper.setMessageLogging` пишет строку в начале и в конце каждой доставки сообщения. Вычитание меток времени даёт точную длительность каждой единицы работы главного потока, включая синхронный префикс обработчика.

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

Устанавливайте его рано и только в сборке, которую собираетесь выбросить:

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

Затем наблюдайте за ним при реальном использовании:

```sh
adb logcat -s anr-hunt:W
```

Порог в 300 мс агрессивен намеренно. Для ANR по диспетчеризации ввода нужно 5000 мс, но обработчик, который стоит 400 мс на вашем рабочем телефоне, обойдётся в несколько секунд на четырёхлетнем устройстве с холодным кешем страниц, а именно с таких устройств и приходит ваш показатель в vitals.

Это даёт вам длительность и строку с адресатом Looper. Чего это не даёт, так это имени метода на C#: продолжение, отправленное средой выполнения, приходит как обобщённая обёртка `Java.Lang.IRunnable`, поэтому поле `<callback>` выглядит как непрозрачный тип `crc64...`. Для этого нужен шаг 4.

## Шаг 4: назвать машину состояний

`Task` отправляет свои продолжения через `SynchronizationContext.Post`, и в главном потоке Android этот контекст перенаправляет их обратно на главный `Handler`. Оберните его, и вы сможете изучить отправленное состояние, прежде чем передать его дальше.

Тонкость в том, что делегат `SendOrPostCallback` - это не ваш метод. Среда выполнения использует один общий статический обратный вызов и передаёт настоящее продолжение в `state` как `Action`, целью которой является упакованная асинхронная машина состояний. Эта упаковка представляет собой обобщённый тип, аргументом которого выступает сгенерированная компилятором структура вашего метода, и её имя содержит имя исходного метода.

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

Установите её в главном потоке, после того как MAUI настроил свой собственный контекст:

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

Строка журнала, которую вы ищете, выглядит так, и ради неё всё и затевалось:

```
W anr-hunt: continuation 4412 ms: MyApp.MainPage+<OnSyncClicked>d__7
```

Три ограничения, каждое из которых важно:

- Через обёртку проходят только те продолжения, чей `await` захватил контекст **после** её установки. Устанавливайте её в `OnCreate`, до построения первой страницы.
- `MainThread.BeginInvokeOnMainThread` и `IDispatcher` из MAUI отправляют сообщения напрямую в `Handler` Android, а не через `SynchronizationContext`, поэтому эту обёртку они обходят полностью. Printer для Looper из шага 3 их всё же видит, и поэтому вы запускаете оба инструмента.
- Код, ожидающий с [`ConfigureAwait(false)`](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/), контекст вообще не захватывает, и его продолжение здесь справедливо невидимо. Это и есть желаемое поведение: оно не возобновляется в главном потоке.

## Шаг 5: подтвердить с помощью `dotnet-trace`

Как только появился подозреваемый, измерьте его. Под CoreCLR в .NET 11 диагностический компонент встроен в среду выполнения, поэтому `EnableDiagnostics` не нужен (в .NET 10 с Mono нужен, и он добавляет `libmono-component-diagnostics_tracing.so` в пакет).

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

Перейдите на нужный экран, нажмите кнопку, нажмите Enter для остановки и откройте `.speedscope.json` на [speedscope.app](https://speedscope.app/). Выберите главный поток, переключитесь в режим sandwich и отсортируйте по собственному времени. Нужный кадр - это `MainPage.OnSyncClicked` с широким сплошным блоком, а прямо под ним то, что действительно расходует время.

Профилируйте только сборки `Release`. Сборки Debug на Android выполняются под интерпретатором (`UseInterpreter=true`) ради hot reload, и полученные из них замеры являются вымыслом.

## Исправления в том порядке, в котором их стоит пробовать

Как только обработчик назван, починка почти всегда сводится к одному из четырёх вариантов.

**Сделайте обработчик тонкой оболочкой над методом, возвращающим `Task`.** Сигнатура события требует `void`, но никто не требует длинного тела.

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

**Перенесите синхронный префикс в пул потоков.** `Task.Run` здесь подходит именно потому, что работа ограничена процессором или блокирующим вводом-выводом и сейчас выполняется в потоке интерфейса. Ради этого случая `Task.Run` и существует.

**Уберите блокирующий вызов.** Если обработчик содержит `.Result`, `.Wait()` или `GetAwaiter().GetResult()`, вся описанная выше инструментация бессмысленна, пока это не исчезнет. Механическая версия разобрана в статье [переход от блокирующих вызовов .Result/.Wait() к сквозной асинхронности](/ru/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/).

**Привязывайтесь к команде, а не к событию.** `AsyncRelayCommand` из MVVM Community Toolkit возвращает `Task`, за которой следит фреймворк, что полностью убирает `async void` из вашего кода и бесплатно даёт `IsRunning` в качестве защиты от повторного входа.

## Ловушки, которые съедают полдня

**Отбрасывание `_ =` в стиле "запустил и забыл" по-прежнему проглатывает исключения.** Оболочка выше пишет в журнал внутри `SyncAsync`, и именно это делает её безопасной. Голый `_ = SomethingAsync()` без `try` внутри несёт тот же риск необработанного исключения, что и `async void`, только тише, и компилятор не предупредит, потому что отбрасывание подавляет [CS4014](/ru/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/).

**`StrictMode` этого не найдёт.** `StrictMode.ThreadPolicy` с `DetectAll()` ловит обращения к диску и сети в главном потоке, что является полезной смежной проверкой, но слеп к управляемой работе, ограниченной процессором, и к потоку, заблокированному на управляемой блокировке. И то и другое является причинами ANR.

**Ваш кластер ANR может вообще не быть обработчиком.** Проверьте верхний кадр кластера в vitals, прежде чем тратить на это день. `handleBindApplication` означает медленный запуск. `nativePollOnce` означает, что главный поток простаивал. Только формы "занят" и "заблокирован" указывают на обработчик.

**Не выпускайте инструментацию никуда.** Printer для `Looper` выделяет строку на каждое сообщение, а обёртка `SynchronizationContext` добавляет `Stopwatch` и замыкание на каждое отправленное продолжение. Оба варианта достаточно дёшевы, чтобы оставить их включёнными на время отладочной сессии на сборке Release, и оба неприемлемы в продакшене. Закройте их за константой, определяемой в MSBuild (`<DefineConstants>$(DefineConstants);ANR_HUNT</DefineConstants>` в отдельной конфигурации сборки), чтобы код не попал в Play Store по случайности.

**Следите за уровнем API.** Бюджеты broadcast receiver ужесточились в Android 14, и приёмник, комфортно укладывавшийся в 10 секунд, теперь под нагрузкой на процессор может попасть в окно 10-20 секунд. Если вы недавно меняли целевой уровень, сверьтесь с тем, [что меняется на уровне API 36](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

Общая закономерность во всём этом такова: `async void` - это не ошибка. Это конструкция, которая делает ошибку невидимой: она убирает возвращаемое значение, позволившее бы вызывающему коду дождаться результата, путь исключения, сообщивший бы вам о сбое, и предупреждение компилятора, которое пометило бы проблему. Назвать машину состояний - это и есть способ вернуть себе эту видимость.

## Похожие материалы

- [async void vs async Task в C#: когда какой вариант правильный](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Решение: взаимная блокировка при вызове .Result или .Wait() у async-метода в C#](/ru/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Перевод Android-приложения на .NET MAUI с Mono на CoreCLR в .NET 11](/ru/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)
- [ConfigureAwait(false) vs значение по умолчанию в .NET 11: имеет ли это ещё значение?](/ru/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Переход от блокирующих вызовов .Result/.Wait() к сквозной асинхронности в устаревшей кодовой базе на C#](/ru/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)

## Источники

- [Diagnose and fix ANRs, Android Developers](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs)
- [ANRs, документация Android по качеству приложений](https://developer.android.com/topic/performance/vitals/anr)
- [Требования Play Console к техническому качеству](https://support.google.com/googleplay/android-developer/answer/17492799)
- [Профилирование производительности в .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/profiling)
- [Документация по dotnet-dsrouter, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter)
- [Tracing .NET for Android applications, dotnet/android](https://github.com/dotnet/android/blob/main/Documentation/guides/tracing.md)
- [Документация анализаторов VSTHRD100 и VSTHRD101, microsoft/vs-threading](https://github.com/microsoft/vs-threading/blob/main/docfx/analyzers/index.md)
- [Ложное срабатывание VSTHRD100 на обработчиках событий, microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510)
- [CoreCLR ANR while running large app, dotnet/android#10588](https://github.com/dotnet/android/issues/10588)
- [Сбор и чтение отчётов об ошибках, документация Android Studio](https://developer.android.com/studio/debug/bug-report)
