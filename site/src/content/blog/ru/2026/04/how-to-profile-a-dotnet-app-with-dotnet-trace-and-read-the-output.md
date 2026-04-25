---
title: "Как профилировать приложение .NET с помощью dotnet-trace и читать вывод"
description: "Полное руководство по профилированию приложений .NET 11 с dotnet-trace: установка, выбор подходящего профиля, захват с момента старта и чтение .nettrace в PerfView, Visual Studio, Speedscope или Perfetto."
pubDate: 2026-04-25
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "diagnostics"
  - "profiling"
lang: "ru"
translationOf: "2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output"
translatedBy: "claude"
translationDate: 2026-04-25
---

Чтобы профилировать приложение .NET с помощью `dotnet-trace`, установите глобальный инструмент командой `dotnet tool install --global dotnet-trace`, найдите PID целевого процесса с `dotnet-trace ps`, затем выполните `dotnet-trace collect --process-id <PID>`. Без флагов версии инструмента для .NET 10/11 по умолчанию используют профили `dotnet-common` и `dotnet-sampled-thread-time`, которые вместе покрывают то же, что покрывал старый профиль `cpu-sampling`. Нажмите Enter, чтобы остановить захват, и `dotnet-trace` запишет файл `.nettrace`. Чтобы прочитать его, откройте в Visual Studio или PerfView в Windows, либо конвертируйте в файл Speedscope или Chromium командой `dotnet-trace convert` и просмотрите в [speedscope.app](https://www.speedscope.app/) или `chrome://tracing` / Perfetto. В этой статье используется dotnet-trace 9.0.661903 в связке с .NET 11 (preview 3), но рабочий процесс стабилен ещё с .NET 5.

## Что на самом деле захватывает dotnet-trace

`dotnet-trace` — это профилировщик исключительно управляемого кода, который общается с процессом .NET через [диагностический порт](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port) и просит среду выполнения транслировать события через [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe). Никакой нативный профилировщик не подключается, ни один процесс не перезапускается, и привилегии администратора не требуются (исключение — глагол `collect-linux`, об этом ниже). На выходе получается файл `.nettrace`: бинарный поток событий плюс информация rundown (имена типов, карты IL-в-нативный код от JIT), отправляемая в конце сессии.

Этот контракт «только управляемый код» — главная причина, по которой команды выбирают `dotnet-trace` вместо PerfView, ETW или `perf record`. Вы получаете JIT-разрешённые управляемые стеки вызовов, события сборки мусора, выборки аллокаций, команды ADO.NET и пользовательские события на основе `EventSource` из единого инструмента, одинаково работающего на Windows, Linux и macOS. Чего вы не получаете от кроссплатформенного глагола `collect` — это нативные кадры, стеки ядра и события не-.NET процессов.

## Установка и первый трейс

Установите один раз на машину:

```bash
# Verified against dotnet-trace 9.0.661903, .NET 11 preview 3
dotnet tool install --global dotnet-trace
```

Инструмент берёт самую новую среду выполнения .NET на машине. Если установлен только .NET 6, он всё равно работает, но имена профилей .NET 10/11, появившиеся в 2025 году, будут недоступны. Выполните `dotnet-trace --version`, чтобы увидеть, что у вас.

Теперь найдите PID. Собственный глагол `ps` инструмента — самый безопасный вариант, потому что он печатает только управляемые процессы, у которых открыт диагностический endpoint:

```bash
dotnet-trace ps
# 21932 dotnet  C:\Program Files\dotnet\dotnet.exe   run --configuration Release
# 36656 dotnet  C:\Program Files\dotnet\dotnet.exe
```

Захватите 30 секунд против первого PID:

```bash
dotnet-trace collect --process-id 21932 --duration 00:00:00:30
```

В консоль выводится, какие провайдеры были включены, имя выходного файла (по умолчанию: `<appname>_<yyyyMMdd>_<HHmmss>.nettrace`) и живой счётчик KB. Нажмите Enter раньше, если хотите остановиться до окончания заданной длительности. Остановка не мгновенна: среде выполнения нужно сбросить информацию rundown по каждому JIT-скомпилированному методу, попавшему в трейс, что в большом приложении может занять десятки секунд. Не поддавайтесь искушению нажать Ctrl+C дважды.

## Выбор подходящего профиля

`dotnet-trace` кажется запутанным с первого раза именно потому, что у вопроса «какие события мне захватывать?» много правильных ответов. Инструмент поставляется с именованными профилями, чтобы не приходилось запоминать битовые маски ключевых слов. Начиная с dotnet-trace 9.0.661903, глагол `collect` поддерживает:

- `dotnet-common`: лёгкая диагностика среды выполнения. События GC, AssemblyLoader, Loader, JIT, Exceptions, Threading, JittedMethodILToNativeMap и Compilation на уровне `Informational`. Эквивалент `Microsoft-Windows-DotNETRuntime:0x100003801D:4`.
- `dotnet-sampled-thread-time`: выборки управляемых стеков потоков с частотой около 100 Hz для выявления горячих точек во времени. Использует встроенный sample profiler с управляемыми стеками.
- `gc-verbose`: сборки мусора плюс выборка аллокаций объектов. Тяжелее, чем `dotnet-common`, но единственный способ найти горячие точки аллокаций без отдельного memory-профилировщика.
- `gc-collect`: только сборки мусора, очень малые накладные расходы. Хорош для вопроса «GC ли тормозит меня?» без влияния на установившуюся пропускную способность.
- `database`: события команд ADO.NET и Entity Framework. Полезен для отлова N+1 запросов.

Когда вы выполняете `dotnet-trace collect` без флагов, инструмент теперь по умолчанию выбирает `dotnet-common` плюс `dotnet-sampled-thread-time`. Эта комбинация заменяет старый профиль `cpu-sampling`, который сэмплировал все потоки независимо от использования CPU и заставлял людей принимать простаивающие потоки за горячие. Если вам нужно точное старое поведение для совместимости со старыми трейсами, используйте `--profile dotnet-sampled-thread-time --providers "Microsoft-Windows-DotNETRuntime:0x14C14FCCBD:4"`.

Профили можно складывать через запятую:

```bash
dotnet-trace collect -p 21932 --profile dotnet-common,gc-verbose,database --duration 00:00:01:00
```

Для более тонкой настройки используйте `--providers`. Формат — `Provider[,Provider]`, где каждый провайдер — `Name[:Flags[:Level[:KeyValueArgs]]]`. Например, чтобы захватить только события блокировок (contention) на уровне verbose:

```bash
dotnet-trace collect -p 21932 --providers "Microsoft-Windows-DotNETRuntime:0x4000:5"
```

Если хочется более дружелюбного синтаксиса для ключевых слов среды выполнения, `--clrevents gc+contention --clreventlevel informational` эквивалентно `--providers Microsoft-Windows-DotNETRuntime:0x4001:4` и читается в скриптах гораздо легче.

## Захват с момента старта

Половина интересных проблем производительности случается в первые 200 мс, ещё до того, как вы успеете скопировать PID. .NET 5 добавил два способа подключить `dotnet-trace` до того, как среда выполнения начнёт обслуживать запросы.

Самый простой — позволить `dotnet-trace` запустить дочерний процесс:

```bash
dotnet-trace collect --profile dotnet-common,dotnet-sampled-thread-time -- dotnet exec ./bin/Debug/net11.0/MyApp.dll arg1 arg2
```

По умолчанию stdin/stdout дочернего процесса перенаправляются. Передайте `--show-child-io`, если нужно взаимодействовать с приложением в консоли. Используйте `dotnet exec <app.dll>` или опубликованный self-contained бинарник вместо `dotnet run`: последний порождает процессы сборки/лаунчера, которые могут подключиться к инструменту первыми и оставить ваше настоящее приложение приостановленным в среде выполнения.

Более гибкий вариант — диагностический порт. В одной оболочке:

```bash
dotnet-trace collect --diagnostic-port myport.sock
# Waiting for connection on myport.sock
# Start an application with the following environment variable:
# DOTNET_DiagnosticPorts=/home/user/myport.sock
```

В другой оболочке задайте переменную окружения и запустите как обычно:

```bash
export DOTNET_DiagnosticPorts=/home/user/myport.sock
./MyApp arg1 arg2
```

Среда выполнения остаётся приостановленной, пока инструмент не будет готов, после чего стартует как обычно. Этот шаблон отлично сочетается с контейнерами (примонтируйте сокет в контейнер), с сервисами, которые сложно обернуть, и с многопроцессными сценариями, где нужно трейсить только один конкретный дочерний процесс.

## Остановка по конкретному событию

Длинные трейсы шумные. Если вас интересует только участок между «JIT начал компилировать X» и «запрос завершён», `dotnet-trace` может остановиться в момент срабатывания конкретного события:

```bash
dotnet-trace collect -p 21932 \
  --stopping-event-provider-name Microsoft-Windows-DotNETRuntime \
  --stopping-event-event-name Method/JittingStarted \
  --stopping-event-payload-filter MethodNamespace:MyApp.HotPath,MethodName:Render
```

Поток событий парсится асинхронно, поэтому несколько лишних событий просочатся после совпадения, прежде чем сессия действительно закроется. Это обычно не проблема, когда вы ищете горячие точки.

## Чтение вывода .nettrace

Файл `.nettrace` — каноничный формат. Три просмотрщика работают с ним напрямую, ещё два становятся доступны после однострочной конвертации.

### PerfView (Windows, бесплатный)

[PerfView](https://github.com/microsoft/perfview) — оригинальный инструмент команды среды выполнения .NET. Откройте файл `.nettrace`, дважды кликните «CPU Stacks», если захватили `dotnet-sampled-thread-time`, или «GC Heap Net Mem» / «GC Stats», если захватили `gc-verbose` или `gc-collect`. Колонка «Exclusive %» показывает, где управляемые потоки тратили время; «Inclusive %» — какой стек вызовов добрался до горячего кадра.

PerfView насыщенный. Два клика, которые стоит запомнить: правый клик на кадре и «Set As Root», чтобы углубиться, и поле «Fold %», чтобы свернуть мелкие кадры и сделать горячий путь читаемым. Если трейс был обрезан необработанным исключением, запустите PerfView с флагом `/ContinueOnError`, и вы всё равно сможете изучить, что происходило вплоть до краха.

### Visual Studio Performance Profiler

Visual Studio 2022/2026 открывает файлы `.nettrace` напрямую через File > Open. Представление CPU Usage — самый дружелюбный интерфейс для тех, кто никогда не пользовался PerfView: flame graph, панель «Hot Path» и привязка к строкам исходного кода, если ваши PDB рядом. Минус — у Visual Studio меньше типов представлений, чем у PerfView, поэтому профилирование аллокаций и анализ GC обычно понятнее в PerfView.

### Speedscope (кроссплатформенный, в браузере)

Самый быстрый способ посмотреть трейс на Linux или macOS — конвертировать его в Speedscope и открыть результат в браузере. Можно попросить `dotnet-trace` сразу записывать в Speedscope:

```bash
dotnet-trace collect -p 21932 --format Speedscope --duration 00:00:00:30
```

Или конвертировать существующий `.nettrace`:

```bash
dotnet-trace convert myapp_20260425_120000.nettrace --format Speedscope -o myapp.speedscope.json
```

Перетащите получившийся `.speedscope.json` в [speedscope.app](https://www.speedscope.app/). Представление «Sandwich» — киллер-фича: сортирует методы по полному времени и позволяет кликнуть по любому, чтобы увидеть вызывающих и вызываемых рядом. Это самое близкое к PerfView, что доступно на Mac. Учтите, что конвертация с потерями: метаданные rundown, события GC и события исключений отбрасываются. Держите оригинальный `.nettrace` рядом, если позже захотите посмотреть аллокации.

### Perfetto / chrome://tracing

`--format Chromium` создаёт JSON-файл, который можно перетащить в `chrome://tracing` или [ui.perfetto.dev](https://ui.perfetto.dev/). Это представление сильно для вопросов параллелизма: всплески пула потоков, async-водопады и симптомы блокировок читаются на временной шкале естественнее, чем во flame graph. Сообщество писало про [использование dotnet-trace с Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/) с полным циклом, и мы подробнее разбирали [практический workflow Perfetto + dotnet-trace](/2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10/) в начале года.

### dotnet-trace report (CLI)

Если вы на сервере без GUI или просто нужна быстрая проверка, инструмент сам может суммировать трейс:

```bash
dotnet-trace report myapp_20260425_120000.nettrace topN -n 20
```

Печатает топ-20 методов по эксклюзивному времени CPU. Добавьте `--inclusive` для переключения на инклюзивное время и `-v` для печати полных сигнатур параметров. Это не замена просмотрщика, но хватит, чтобы ответить «не сломал ли деплой что-то очевидное?», не выходя из SSH.

## Подводные камни, которые ловят новичков

Несколько крайних случаев объясняют большинство жалоб «почему мой трейс пустой?».

- Буфер по умолчанию 256 МБ. Сценарии с высокой частотой событий (каждый метод в плотном цикле, выборка аллокаций на потоковой нагрузке) переполняют этот буфер, и события молча теряются. Увеличьте его флагом `--buffersize 1024` или сузьте список провайдеров.
- На Linux и macOS `--name` и `--process-id` требуют, чтобы целевое приложение и `dotnet-trace` имели одинаковую переменную окружения `TMPDIR`. Если они не совпадают, соединение завершается по таймауту без полезного сообщения об ошибке. Контейнеры и вызовы через `sudo` — обычные виновники.
- Трейс окажется неполным, если целевое приложение упадёт во время захвата. Среда выполнения обрезает файл, чтобы избежать повреждения. Откройте его в PerfView с `/ContinueOnError` и читайте, что есть: обычно этого достаточно, чтобы найти причину.
- `dotnet run` порождает вспомогательные процессы, которые подключаются к слушателю `--diagnostic-port` раньше, чем ваше настоящее приложение. Используйте `dotnet exec MyApp.dll` или опубликованный self-contained бинарник, когда трейсите со старта.
- По умолчанию `--resume-runtime true` позволяет приложению стартовать сразу, как только сессия готова. Если хотите, чтобы приложение оставалось приостановленным (редко, в основном для отладчиков), передайте `--resume-runtime:false`.
- Для .NET 10 на Linux с ядром 6.4+ новый глагол `collect-linux` захватывает события ядра, нативные кадры и общие машинно-широкие выборки, но требует root и записывает `.nettrace` в preview-формате, поддерживаемом ещё не всеми просмотрщиками. Используйте его, когда вам действительно нужны нативные кадры; во всех остальных случаях по умолчанию `collect`.

## Куда двигаться дальше

`dotnet-trace` — правильный инструмент для вопроса «что моё приложение делает прямо сейчас?». Для непрерывных метрик (RPS, размер кучи GC, длина очереди пула потоков) без формирования файла берите `dotnet-counters`. Для охоты на утечки памяти, где нужен реальный дамп кучи, берите `dotnet-gcdump`. Все три инструмента используют общую инфраструктуру диагностического порта, поэтому мышечная память install / `ps` / `collect` переносится без изменений.

Если вы пишете код для production, вам также нужна модель языка, дружественная к трассировке. Наши заметки про [отмену долго выполняющихся задач без взаимных блокировок](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), [потоковую отдачу файлов из эндпоинтов ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) и [чтение больших CSV в .NET 11 без выхода за пределы памяти](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) показывают шаблоны, которые на flame graph `dotnet-trace` выглядят совсем не так, как наивные версии, и это хорошо.

Формат `.nettrace` открыт: если хочется автоматизировать анализ, [Microsoft.Diagnostics.Tracing.TraceEvent](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent) программно читает те же файлы. Именно так работает PerfView под капотом, и так же вы строите разовый отчёт, когда ни один существующий просмотрщик не задаёт нужный вам вопрос.

## Источники

- [Справочник по диагностическому инструменту dotnet-trace](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace) (MS Learn, последнее обновление 2026-03-19)
- [Документация EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)
- [Документация диагностического порта](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port)
- [Известные провайдеры событий .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/well-known-event-providers)
- [PerfView на GitHub](https://github.com/microsoft/perfview)
- [Speedscope](https://www.speedscope.app/)
- [Perfetto UI](https://ui.perfetto.dev/)
