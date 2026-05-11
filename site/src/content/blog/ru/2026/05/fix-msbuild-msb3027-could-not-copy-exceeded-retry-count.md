---
title: "Fix: MSB3027 Could not copy X to Y. Exceeded retry count of 10. Failed"
description: "MSB3027 означает, что MSBuild десять раз пытался скопировать файл, а процесс по-прежнему удерживал место назначения. Завершите блокирующий процесс, исключите bin/obj из антивируса или повысьте CopyRetryCount."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "ru"
translationOf: "2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count"
translatedBy: "claude"
translationDate: 2026-05-11
---

Решение: задача `Copy` из MSBuild десять раз с паузами по секунде пыталась перезаписать файл в вашем каталоге `bin/`, а процесс по-прежнему удерживал на нём дескриптор. Найдите удерживающий процесс с помощью `handle.exe` или Resource Monitor, завершите его и пересоберите. В Windows удерживающий процесс почти всегда — это предыдущий запуск вашей собственной программы (`apphost.exe`, `MyApp.exe`, рабочий процесс IIS Express или дочерний `dotnet watch`), процесс build-server `MSBuild.exe`, оставшийся резидентным под Visual Studio, или антивирус с защитой в реальном времени, открывший свежую DLL для проверки за несколько миллисекунд до того, как MSBuild попытался её перезаписать. Если устранить источник блокировки нельзя, повысьте `CopyRetryCount` и `CopyRetryDelayMilliseconds` в `Directory.Build.props` и двигайтесь дальше.

```text
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed. The file is locked by: ".NET Host (4176)"  [C:\src\MyApp\MyApp.csproj]
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' because it is being used by another process.
```

Статья написана для .NET SDK 11.0.100-preview.4, MSBuild 17.13 и Visual Studio 17.14. Задача `Copy` и текст сообщения MSB3027 стабильны со времён MSBuild 15 (Visual Studio 2017), поэтому тот же чек-лист подходит для любого современного SDK-style проекта, от `net6.0` до `net11.0`. Что изменилось недавно, так это поведение повторных попыток: между SDK 7.0.306 и 7.0.400 путь повторов для некоторых подклассов `IOException` был ужесточён, и поэтому сбои CI, которые раньше были невидимыми (повтор завершался успешно), теперь всплывают как MSB3027.

## Что на самом деле означает MSB3027

`MSB3027` выбрасывает задача `Copy` из MSBuild в конце своего цикла повторов. Задача подключается через стандартные цели `_CopyFilesMarkedCopyLocal` и `CopyFilesToOutputDirectory` внутри `Microsoft.Common.CurrentVersion.targets`, которые срабатывают ближе к концу каждой `dotnet build`. Циклом управляют два свойства:

- `CopyRetryCount` по умолчанию равно `10`. Задача завершается ошибкой после такого числа подряд идущих сбоев.
- `CopyRetryDelayMilliseconds` по умолчанию равно `1000`. Задача спит столько между попытками.

Полное окно из десяти повторов составляет около десяти секунд. Если процесс удерживает целевой файл дольше десяти секунд, срабатывает MSB3027. MSBuild выводит внутреннее исключение (`System.IO.IOException`) на следующей строке как `MSB3021`, поэтому эти два кода ошибок почти всегда идут вместе.

Запись Microsoft Learn о [MSB3027](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) называет четыре канонические причины: файл удерживает другая программа, у вашей учётной записи нет прав на запись в место назначения, на диске не хватает места или сетевая шара недоступна. На практике на рабочей станции разработчика первая причина объясняет значительно больше 95 процентов обращений.

## Почему это происходит (в порядке приоритета)

Вот семь повторяющихся причин, упорядоченных по тому, насколько часто они объясняют сбой в реальном проекте на .NET 11.

1. **Предыдущий запуск вашей собственной программы всё ещё жив.** Консольные приложения, заблокированные на `Console.ReadKey`, dotnet-`IHostedService` worker'ы, ожидающие корректного завершения, и осиротевшие процессы `apphost.exe` от упавшей сессии отладки удерживают блокировку на основном исполняемом файле. Сообщение об ошибке прямо называет процесс, например `The file is locked by: ".NET Host (4176)"`.
2. **IIS Express или пул приложений Kestrel удерживает сборку.** `dotnet run`, `iisexpress.exe` и рабочий процесс IIS (`w3wp.exe`) удерживают эксклюзивный read share на загруженной DLL. Сборка, запущенная из Visual Studio, пока ещё работает предыдущая сессия F5, попадает в это каждый раз.
3. **`dotnet watch` в разгаре пересборки.** Hot reload подменяет сборки на лету, но при rude edit запускает полный перезапуск, и существует небольшое окно, когда старый процесс и новая сборка трогают один и тот же файл. Проекты с большим количеством генераторов исходного кода усиливают этот эффект, потому что выходная DLL генератора копируется дважды. Репозиторий dotnet SDK отслеживает это в [dotnet/sdk#40911](https://github.com/dotnet/sdk/issues/40911) ещё со времён .NET 8.
4. **Антивирус в реальном времени просканировал файл ровно в тот момент, когда MSBuild его записал.** Windows Defender, CrowdStrike Falcon, SentinelOne и подобные открывают каждый новый `.exe` и `.dll` для проверки. Сканирование занимает несколько сотен миллисекунд, но если следующему проекту в параллельной сборке нужно скопировать тот же файл, копирование может попасть в гонку со сканером. Исключения Defender для корня репозитория полностью устраняют этот сценарий сбоя.
5. **OneDrive или другой клиент синхронизации открыл файл.** Функция "Files On-Demand" в OneDrive открывает дескриптор на запись для любого файла внутри синхронизированной папки, когда дегидратирует или регидратирует содержимое. Если ваше дерево исходников лежит в `C:\Users\<вы>\OneDrive\...`, это случайным образом вызывает MSB3027 во время длинных сборок.
6. **Build server MSBuild (или VS BuildHost) ещё подключён.** При `MSBUILDDISABLENODEREUSE=0` (значение по умолчанию) MSBuild оставляет узлы `MSBuild.exe` живыми между сборками. Внутри Visual Studio эквивалент — это `VBCSCompiler.exe` и build server Roslyn. Они почти никогда не удерживают цели копирования, но зависший узел может закрепить только что скомпилированную сборку.
7. **Параллельные проекты в одном решении копируют один и тот же файл в один и тот же момент.** Два проекта в одном `.sln`, зависящие от общей библиотеки, каждый пытается скопировать эту библиотеку в свой собственный выход. При параллелизме `/m` вторая копия может натолкнуться на MSB3021 при `OpenWrite` и исчерпать бюджет повторов. Это регрессировало в SDK 7.0.400 и отслеживается в [dotnet/msbuild#9169](https://github.com/dotnet/msbuild/issues/9169).

## Минимальная репродукция: консольное приложение, которое удерживает собственный бинарник

Минимальный воспроизводящий пример — консольное приложение, которое не завершается. Сохраните это как `MyApp/Program.cs` и `MyApp/MyApp.csproj`:

```xml
<!-- MyApp.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// Program.cs - .NET 11, C# 14
Console.WriteLine("running, press any key to exit");
Console.ReadKey();
```

Запустите его в одном терминале:

```text
dotnet run
```

Затем измените `Program.cs` (добавьте пробел) и из второго терминала:

```text
dotnet build
```

Вторая сборка выводит:

```text
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file because it is being used by another process.
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed.
```

Это канонический случай. Первый терминал владеет DLL, потому что хост .NET открыл её только с `FILE_SHARE_READ`, что исключает запись.

## Решение в деталях

### 1. Найдите удерживающий процесс и завершите его

Сообщение после `MSB3027` перечисляет процесс, когда MSBuild может его разрешить. Когда не может (обычно в контейнерах или на машинах с ограничениями), воспользуйтесь одним из этих вариантов:

```text
:: sysinternals handle.exe - https://learn.microsoft.com/sysinternals/downloads/handle
handle64.exe -nobanner -accepteula C:\src\MyApp\bin\Debug\net11.0\MyApp.dll
```

```powershell
# Get-Process by module path (PowerShell 7.4+)
Get-Process | Where-Object { $_.Modules.FileName -contains 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' }
```

```text
:: Kill by image name
taskkill /im MyApp.exe /f
:: Or by PID from handle.exe output
taskkill /pid 4176 /f
```

Для IIS Express: щёлкните правой кнопкой по значку в системном трее и выберите `Exit All`, или `iisexpress /stop /siteid:<id>`. Для полного IIS грубый вариант — `iisreset`; точечный — `Stop-WebAppPool -Name "<pool>"`.

### 2. Не запускайте программу из того же терминала, в котором собираете

Самое чистое решение — это рабочий процесс: не оставляйте подключённую сессию отладки во время пересборки. В Visual Studio пути `Edit and Continue` и `Hot Reload` обычно решают это за вас. Из командной строки лучше использовать `dotnet watch` (который знает о пересборке), чем ручной цикл `dotnet run` плюс отдельный `dotnet build`.

Если вы уже на `dotnet watch` и видите MSB3027 на каждой пересборке, симптом обычно — это генератор исходного кода, чья выходная DLL переписывается при каждой компиляции. Обходной приём, задокументированный в репозитории SDK, состоит в том, чтобы перенести генератор в отдельный `.csproj` с `<EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>` и `<EmitCompilerGeneratedFiles>false</EmitCompilerGeneratedFiles>`, а затем сослаться на проект генератора через `OutputItemType="Analyzer" ReferenceOutputAssembly="false"`. DLL генератора перестаёт быть целью копирования.

### 3. Добавьте исключения антивируса для репозитория

Для Microsoft Defender откройте `Windows Security` > `Virus & threat protection` > `Manage settings` > `Exclusions` > `Add or remove exclusions` > `Add an exclusion` > `Folder` и добавьте:

- Корень репозитория или как минимум каждую подпапку `bin/` и `obj/`.
- `%USERPROFILE%\.nuget\packages` (глобальный кеш NuGet).
- `%USERPROFILE%\.dotnet` (установку SDK).

Для CrowdStrike / SentinelOne / корпоративно управляемого Defender вы не сможете сделать это сами; заведите тикет в IT-команду и сошлитесь на `.gitattributes` или `.editorconfig` вашей команды как доказательство того, что папки bin/obj — это артефакты сборки, а не пользовательские данные. Сама [документация Defender по исключениям](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus) подтверждает, что сканирование вывода сборки в реальном времени — ведущая причина периодических сбоев MSBuild в корпоративных окружениях.

### 4. Уберите репозиторий из OneDrive

Если `pwd` внутри вашего репозитория выводит `C:\Users\<вы>\OneDrive\source\...`, перенесите его. Клиенты синхронизации любого типа (OneDrive, Dropbox, Google Drive, iCloud) удерживают дескриптор на запись для файлов, которые они загружают или гидрируют, и освобождают этот дескриптор по своим часам, а не по часам MSBuild. `C:\src\<repo>` вне любой синхронизируемой папки — стандартная раскладка для .NET-работы под Windows.

### 5. Повысьте бюджет повторов (крайнее средство)

Если блокировку устранить нельзя (CI-агент с общим кешем, антивирус, который нельзя исключить, параллельная сборка, бьющая по общей зависимости), повысьте бюджет. Поместите это в `Directory.Build.props` в корне репозитория, чтобы это применилось ко всем проектам:

```xml
<!-- Directory.Build.props - .NET 11 SDK, MSBuild 17.13 -->
<Project>
  <PropertyGroup>
    <CopyRetryCount>20</CopyRetryCount>
    <CopyRetryDelayMilliseconds>2000</CopyRetryDelayMilliseconds>
  </PropertyGroup>
</Project>
```

Это даёт задаче `Copy` сорок секунд бюджета повторов. Большие значения лишь скрывают более серьёзную проблему (зависший процесс, неверно настроенный антивирус) и заставляют каждую неудачную сборку всплывать только через минуту, поэтому не повышайте их выше `CopyRetryCount=20`.

Для специфичного для CI случая, когда параллельные проекты соревнуются за одну и ту же общую DLL, лучшее решение — выставить `BuildInParallel=false` для проблемного решения или оформить общую библиотеку как `<PackageReference>` на NuGet-фид вместо `<ProjectReference>`. Оба варианта убирают гонку.

### 6. Отключите build server, когда узлы MSBuild зависают

Зависшие узлы MSBuild редки, но заметны: `tasklist /fi "imagename eq MSBuild.exe"` показывает узлы, которые не использовались повторно много минут. Завершите их через:

```text
dotnet build-server shutdown
```

Запускайте это между сборками в скриптах, страдающих от периодических MSB3027, или задайте `MSBUILDDISABLENODEREUSE=1`, чтобы вовсе отключить переиспользование узлов. Время сборки вырастет на несколько секунд, но хвостовые сбои из-за блокировок файлов исчезнут.

## Подводные камни и вариации

- **MSB3026 — это предупреждение, а не ошибка.** Оно означает, что MSBuild повторил копирование и повтор прошёл успешно. Если вы видите только MSB3026, сборка прошла, и чинить нечего; шум лишь сообщает, что произошла временная блокировка. Воспринимайте повторяющиеся MSB3026 как сигнал добавить исключение Defender, прежде чем на следующей неделе оно перерастёт в MSB3027.
- **MSB3021 без MSB3027.** Это более старое поведение, до того как добавили цикл повторов. Если вы видите только MSB3021, у вас гораздо более старый тулчейн (.NET Core 2.x или `msbuild.exe` из VS 2015), а решение то же самое, только без ручки `CopyRetryCount`.
- **Варианты на Linux и macOS.** Номер ошибки тот же. Unix-ядра не навязывают обязательную блокировку файлов так, как Windows, поэтому большинство причин блокировок не применимо. Остаются ошибки прав (целевой каталог принадлежит `root` после Docker-сборки) и заполненные файловые системы. `df -h` и `ls -ld bin/` исключают и то, и другое за секунды.
- **Контейнеры.** Сборка внутри Linux-контейнера с подключённым томом с хоста Windows — худшее из обоих миров: антивирус хоста сканирует файлы, записываемые изнутри контейнера. Либо собирайте внутри контейнера, используя локальный для контейнера том (`docker volume create`), либо собирайте на хосте напрямую.
- **The file is locked by: 'System' or 'unknown'.** Когда удерживающий процесс отображается как `System (4)` или без имени, виновник почти всегда — драйвер антивируса в режиме ядра. Defender, CrowdStrike и SentinelOne всплывают именно так. `taskkill` пользовательского режима не поможет; решение — исключение или временное отключение защиты в реальном времени.
- **Native AOT и публикация с трим.** `dotnet publish -c Release` для проекта Native AOT иногда записывает выходной `.exe` дважды (один раз на шаге публикации, второй — на верификации trim). На медленном IO это конкурирует само с собой. Добавьте `<PublishAot>true</PublishAot>` и `<PublishSingleFile>false</PublishSingleFile>` вместе, чтобы избежать двойного копирования.

## Связанные материалы

- [Fix: The type or namespace name 'X' could not be found after adding a project reference](/ru/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) — другая половина набора инструментов для устранения проблем в SDK-style проектах. Сбои ссылок и сбои копирования имеют общую корневую причину чаще, чем кажется.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/) охватывает сценарии trim и AOT, где MSB3027 также вылезает из пути публикации.
- [How to profile a .NET app with dotnet-trace and read the output](/ru/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) пригодится, когда удерживающий процесс — это ваша собственная программа и вы хотите выяснить, что вообще удерживало её от завершения.
- [.NET watch in .NET 11 preview 3: Aspire crash recovery](/ru/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/) — недавнее изменение SDK, влияющее на вариант этого сбоя в `dotnet watch`.
- [Visual Studio 2026 Hot Reload: auto-restart on rude edits](/ru/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) — IDE-аналог причины с hot reload.

## Источники

- Microsoft Learn, [MSB3027 diagnostic code - MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) (официальная страница-справка)
- Microsoft Learn, [Configure Microsoft Defender Antivirus exclusions by extension, name, or location](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus)
- GitHub, [dotnet/msbuild#9169 File copy is no longer retried, causing builds to randomly fail](https://github.com/dotnet/msbuild/issues/9169)
- GitHub, [dotnet/sdk#40911 dotnet watch fails with MSB3021 (locked file) when project references custom source generator](https://github.com/dotnet/sdk/issues/40911)
- Microsoft Sysinternals, [handle.exe](https://learn.microsoft.com/en-us/sysinternals/downloads/handle) — канонический инструмент, чтобы назвать блокирующий процесс
