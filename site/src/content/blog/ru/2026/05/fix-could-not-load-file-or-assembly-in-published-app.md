---
title: "Исправление: System.IO.FileNotFoundException: Could not load file or assembly в опубликованном приложении"
description: "Работает с dotnet run, падает после dotnet publish. DLL обычно отсутствует в папке публикации, а не в среде выполнения. Проверьте deps.json, Private у ProjectReference и trimming."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "publish"
  - "trimming"
lang: "ru"
translationOf: "2026/05/fix-could-not-load-file-or-assembly-in-published-app"
translatedBy: "claude"
translationDate: 2026-05-12
---

Исправление: `FileNotFoundException: Could not load file or assembly` после `dotnet publish` почти всегда означает, что DLL отсутствует в папке публикации, а не то, что среда выполнения не может её найти. Просмотрите содержимое папки публикации, найдите недостающую сборку по имени и относитесь к этому как к ошибке упаковки. Четыре причины, которые покрывают девяносто процентов реальных сообщений: `ProjectReference` с `Private=false`, `PackageReference` с `PrivateAssets="all"`, trimming, удаляющий сборку, загружаемую через рефлексию, и публикация self-contained против framework-dependent, выбирающая неправильный RID. Установите `COREHOST_TRACE=1`, запустите опубликованный бинарник один раз, и журнал хоста сообщит вам, по какому пути производился поиск.

```text
Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.
File name: 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
   at MyApp.Program.Main(String[] args)

--- End of stack trace from previous location ---
   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()
   at System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)
```

Это руководство написано для .NET 11 preview 4 (среда выполнения `Microsoft.NETCore.App` 11.0.0-preview.4) и .NET SDK 11.0.100-preview.4 на Windows, Linux и macOS. Тип исключения, четырёхсоставная идентичность сборки в сообщении и правила поиска хоста не менялись со времён .NET Core 3.0; в .NET 8 и .NET 11 изменился анализатор trimmer, который теперь выдаёт предупреждения `IL2026` / `IL3050` сразу, чтобы вы перестали обнаруживать эту ошибку во время выполнения. Если в сообщении написано `Could not load file or assembly`, а затем `or one of its dependencies`, то отсутствует именно зависимость, а не сборка, названная первой. Прочитайте вторую часть прежде, чем что-либо менять.

## Почему среда выполнения не находит сборку

Хост .NET (`dotnet.exe` или заглушка apphost, создаваемая рядом с вашим `.exe` при `dotnet publish`) загружает сборки из фиксированного набора путей поиска, выводимых из вашего `<app>.deps.json`. Он не ищет в `PATH`, не ищет в GAC и не возвращается к папке bin проекта, который его собирал. Пути, которые он перебирает по порядку:

1. Каталог apphost (`AppContext.BaseDirectory`).
2. Каталог общего фреймворка для framework-dependent приложений (`{DOTNET_ROOT}/shared/Microsoft.NETCore.App/{version}`).
3. Резервные папки NuGet, если разрешение `useNuGet` включено (только в разработке).
4. Всё, что объявлено в `additionalProbingPaths` внутри `<app>.runtimeconfig.dev.json`, который **отсутствует** в опубликованном приложении.

Когда на машине разработчика сборка лежит в кеше NuGet и runtimeconfig указывает на него, `dotnet run` её находит. У опубликованного приложения нет ни кеша, ни runtimeconfig для разработки, поэтому тот же вызов выбрасывает исключение. Исключение — это сообщение хоста о том, что идентичность сборки в `<app>.deps.json` не разрешается ни в один файл на диске.

Официальная страница Microsoft Learn [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) — авторитетный справочник по порядку поиска; [инструкции по host tracing](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) описывают, как выгрузить журнал поиска в файл.

## Минимальное воспроизведение

```xml
<!-- .NET 11, SDK 11.0.100-preview.4 -->
<!-- src/MyApp/MyApp.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
      <Private>false</Private>
    </ProjectReference>
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14
using Contoso.Shared;

var greeter = new Greeter();
Console.WriteLine(greeter.Hello("world"));
```

`dotnet run` работает. `dotnet publish -c Release -r win-x64 -o ./out` завершается без ошибок. `./out/MyApp.exe` бросает `Could not load file or assembly 'Contoso.Shared'`. Флаг `<Private>false</Private>` указывает MSBuild не копировать `Contoso.Shared.dll` в выход потребителя, предполагая, что GAC или другой механизм развёртывания её предоставит. Для приложений .NET (Core) GAC не существует, и файл попросту отсутствует.

Это каноническая форма бага: одно свойство где-то в графе проектов говорит MSBuild не включать DLL, и шаг публикации это выполняет. Исправление — найти свойство и убрать его.

## Исправление 1: перестаньте подавлять копирование

Откройте файл проекта родителя недостающей сборки и поищите любое из этих свойств у ссылки:

```xml
<!-- These three lines all suppress the copy. Remove them. -->
<ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
  <Private>false</Private>
</ProjectReference>

<Reference Include="Contoso.Shared">
  <CopyLocal>false</CopyLocal>
</Reference>

<PackageReference Include="Some.Library" Version="1.0.0">
  <PrivateAssets>all</PrivateAssets>
</PackageReference>
```

`Private=false` и `CopyLocal=false` эквивалентны для ссылок на проекты и сборки. `PrivateAssets="all"` у `PackageReference` означает, что актив потребляется во время сборки, но не передаётся потребляющему проекту, поэтому DLL не попадает в `deps.json`. Легитимное применение `PrivateAssets="all"` — пакеты analyzer, генераторов исходного кода и build task (когда среде выполнения DLL не нужна никогда). Если пакет — это `Microsoft.Extensions.Logging.Abstractions` или что-либо, что вы вызываете во время выполнения, флаг проставлен неверно. Уберите его, запустите `dotnet publish` и убедитесь, что DLL теперь лежит рядом с вашим приложением.

Страница MS Learn [Controlling dependency assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) перечисляет все значения, принимаемые `PrivateAssets`, и что каждое из них отключает.

## Исправление 2: включите host tracing и прочитайте журнал поиска

Если вы не знаете, какая DLL отсутствует, спросите хост. Установите `COREHOST_TRACE=1` и `COREHOST_TRACEFILE=corehost.log` перед запуском опубликованного бинарника:

```powershell
# Windows, PowerShell, .NET 11
$env:COREHOST_TRACE = "1"
$env:COREHOST_TRACE_VERBOSITY = "4"
$env:COREHOST_TRACEFILE = "corehost.log"
./out/MyApp.exe
```

```bash
# Linux / macOS, bash, .NET 11
COREHOST_TRACE=1 COREHOST_TRACE_VERBOSITY=4 COREHOST_TRACEFILE=corehost.log ./out/MyApp
```

Журнал длинный, но искать нужно раздел `Attempting to load`. Каждая попытка записывается с полным путём, который пробовал хост. Последняя неуспешная попытка перед исключением — это ответ:

```text
Attempting to load: C:\out\Contoso.Shared.dll - false
Attempting to load: C:\out\runtimes\win-x64\lib\net11.0\Contoso.Shared.dll - false
File [C:\out\Contoso.Shared.dll] does not exist
```

Теперь вы знаете, что хост ожидал `Contoso.Shared.dll` непосредственно в папке приложения и не нашёл её. Исправление — сделать так, чтобы вывод публикации содержал файл по этому пути, а не добавлять пути поиска или контексты загрузки.

## Исправление 3: когда trimming тихо удаляет сборку

Trimming self-contained приложения на .NET 11 удаляет любую сборку, достижимость которой trimmer не может доказать статическим анализом. `Assembly.Load("Plugins.Foo")`, `Type.GetType("Some.Type, Some.Assembly")` и большинство DI-контейнеров на основе рефлексии для trimmer невидимы. Сборка исключается из вывода публикации и проявляется во время выполнения как `FileNotFoundException`.

Чтобы подтвердить, что причина — trimming, опубликуйте один раз, превратив предупреждения trimmer в ошибки:

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <TrimmerSingleWarn>false</TrimmerSingleWarn>
  <SuppressTrimAnalysisWarnings>false</SuppressTrimAnalysisWarnings>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

Если публикация теперь падает с `IL2026` или `IL3050`, указывая на точку вызова рефлексии, причина — trimming. Исправление — закрепить сборку как корневую, чтобы trimmer её сохранил:

```xml
<!-- .NET 11 -->
<ItemGroup>
  <TrimmerRootAssembly Include="Plugins.Foo" />
</ItemGroup>
```

Для отдельного типа пометьте метод, инициирующий загрузку, атрибутом `DynamicDependencyAttribute`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public static class PluginLoader
{
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicConstructors, "Plugins.Foo.Entry", "Plugins.Foo")]
    public static object Load() => Activator.CreateInstance(Type.GetType("Plugins.Foo.Entry, Plugins.Foo")!)!;
}
```

Полный список корней trimmer и атрибутов зависимостей приведён в [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming). Для более глубокого взгляда со стороны среды выполнения в статье [Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) разбираются те же предупреждения trimmer в более агрессивной форме.

## Исправление 4: неверный RID или framework-dependent, опубликованный как self-contained

Если сборка, упомянутая в ошибке, — это `Microsoft.NETCore.App` или один из её компонентов (`System.Private.CoreLib.dll`, `System.Runtime.dll`), проблема не в вашем коде: опубликованное приложение является framework-dependent, но на целевой машине нет совместимого установленного общего фреймворка:

```text
Could not load file or assembly 'System.Runtime, Version=11.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
```

Это сообщение означает, что хост нашёл `MyApp.dll`, прочитал `MyApp.runtimeconfig.json`, запросил `Microsoft.NETCore.App 11.0.0` и не получил ничего. Либо установите общий фреймворк на целевой машине (`dotnet --list-runtimes`), либо переопубликуйте как self-contained:

```bash
# .NET 11
dotnet publish -c Release -r win-x64 --self-contained true -o ./out
```

Среда выполнения помещает каждую DLL фреймворка в `./out`, приложение больше не зависит от установленной на машине среды выполнения, и FileNotFoundException исчезает. Соответствующая статья [сокращение времени холодного старта AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) подробнее обсуждает компромиссы публикации (размер против переносимости против холодного старта).

Другой сбой в форме RID — это NuGet-пакет с нативными бинарниками, поставляющий только некоторые RID. Если вы публикуете для `osx-arm64`, а пакет несёт только нативы `win-x64` и `linux-x64`, файл `runtimes/win-x64/native/foo.dll` из пакета исключается из вашей публикации, и управляемая обёртка бросает `FileNotFoundException`. Исправление — сообщить о пробеле сопровождающему пакета или зафиксировать версию, которая поставляет нужный вам RID. Папка `runtimes/` пакета — источник истины.

## Подводные камни и похожие случаи

**`Could not load file or assembly 'X' or one of its dependencies`.** Названная сборка на диске. Одна из её зависимостей — нет. Запустите `dotnet-dump analyze` или `dnSpy` на `X.dll`, чтобы прочитать список её ссылочных сборок, или используйте трассировку хоста из Исправления 2, чтобы найти сбой второго уровня. Рассматривать первое имя как недостающий файл — путь к хождению по кругу.

**`FileLoadException`, а не `FileNotFoundException`.** `FileLoadException: Could not load file or assembly 'X, Version=2.0.0.0'` означает, что файл присутствует, но версия, культура или public key token не совпадают с запрошенными. Это проблема перенаправления привязки сборок (часто встречается, когда транзитивная зависимость обновлена только на верхнем уровне). Исправление — добавить совпадающую версию в `PackageReference` верхнего уровня, чтобы разрешённый граф схлопнулся в одну версию. Среда выполнения больше не читает binding redirect из `app.config` в .NET (Core); это делала только среда .NET Framework. Если вы перенесли из `app.config`, перенаправления теперь игнорируются, и загружается версия, разрешённая в `deps.json`.

**`TypeLoadException` и `MissingMethodException`.** Это не ошибки "сборка не найдена". Они означают, что сборка загрузилась, но тип или метод внутри неё имеет сигнатуру, отличную от ожидаемой вызывающим, почти всегда из-за расхождения версий. Форма исправления та же, что и у `FileLoadException`: выровнять граф версий.

**`BadImageFormatException`.** Файл на диске, имя верное, но архитектура неверная (DLL `x86`, загруженная в процесс `x64`, или управляемая DLL, загруженная как нативная). Проверьте RID и `Platform` с обеих сторон. Это смежная категория, а не замаскированный `FileNotFoundException`.

**Публикация в один файл.** При `PublishSingleFile=true` apphost извлекает упакованные сборки во временную папку при первом запуске (`%TEMP%/.net/<appname>/<hash>`). Если вы видите `FileNotFoundException` для сборки, которую видно внутри single-file бандла (`dotnet-bundle list`), самая частая причина — собственный вызов `AssemblyLoadContext.LoadFromAssemblyPath(Assembly.GetExecutingAssembly().Location)`. `Assembly.Location` пуст для single-file бандлов в .NET 6+, поэтому аргумент пути неправильный. Переключитесь на `AppContext.BaseDirectory` или используйте `Assembly.LoadFromAssemblyName` и позвольте хосту найти упакованный файл.

**Развёртывание ASP.NET Core в IIS.** Если публикация поставляет файл, а IIS всё равно бросает исключение, проверьте, что `Identity` пула приложений имеет права на чтение папки публикации и что `aspnetcorev2.dll` имеет актуальную версию (`%programfiles%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll`). Устаревший ANCM подбирает старый `deps.json`. Это проблема развёртывания, а не сборки.

**Плагины / динамические контексты загрузки.** Если вы загружаете плагины через `AssemblyLoadContext`, контекст плагина не наследует сборки контекста по умолчанию. Плагину, вызывающему `Newtonsoft.Json`, нужна собственная `Newtonsoft.Json.dll` рядом с плагином или `AssemblyDependencyResolver`, построенный из пути к плагину. Форма та же, что и в Исправлении 1, но поверхность — папка плагина, а не папка приложения. Руководство MS Learn [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) показывает паттерн резолвера от начала до конца.

**Сборка скопировала, публикация — нет.** Publish выполняет другой набор целей MSBuild по сравнению с build (`ComputeFilesToPublish` вместо `BuiltProjectOutputGroup`). `<Content Include="Foo.dll" CopyToOutputDirectory="PreserveNewest" />` кладёт файл в `bin/`, но только `<None Include="Foo.dll"><Pack>true</Pack><CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory></None>` (или `<Content>` с флагом publish) помещает его в папку публикации. Если DLL появляется в `bin/Release/net11.0/`, но не в `bin/Release/net11.0/publish/`, это и есть причина.

## Связанное

- [Исправление: Тип или имя пространства имён не удаётся найти после ссылки на проект](/ru/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) — родственник этого исключения времени компиляции: те же расхождения по `Private` и `TargetFramework` проявляются как `CS0246` при сборке или как `FileNotFoundException` во время выполнения.
- [Исправление: MSBuild MSB3027 could not copy exceeded retry count](/ru/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) разбирает соответствующий сбой копирования на этапе публикации, оставляющий половину опубликованной папки.
- [Исправление: PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/) — похожий случай trim-and-publish, где сборка присутствует, а путь кода — нет.
- [Как сократить время холодного старта AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) обсуждает компромиссы self-contained против framework-dependent для того же шага публикации.
- [Как использовать Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) — более глубокий взгляд на предупреждения trimmer, которые ловят этот класс багов на этапе сборки.

## Источники

- [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) (MS Learn)
- [Host tracing in the .NET runtime host](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) (`dotnet/runtime`)
- [Controlling dependency assets with PackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) (MS Learn)
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming) (MS Learn)
- [`DynamicDependencyAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicdependencyattribute) (MS Learn)
- [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) (MS Learn)
- [`AppContext.BaseDirectory` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.appcontext.basedirectory) (MS Learn)
