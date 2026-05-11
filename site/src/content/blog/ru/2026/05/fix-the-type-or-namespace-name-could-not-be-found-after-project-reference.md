---
title: "Fix: The type or namespace name 'X' could not be found (после добавления ProjectReference)"
description: "CS0246 сразу после свежей ProjectReference почти всегда означает несовпадение TargetFramework, устаревшую папку obj/ или отсутствующую директиву using. Пять решений по убыванию вероятности."
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
translationOf: "2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference"
translatedBy: "claude"
translationDate: 2026-05-11
---

Решение: в девяти случаях из десяти ваш проект-потребитель таргетит более низкий `TargetFramework`, чем референсный проект (поэтому SDK-pack даже не пытается разрешить сборку), каталоги `obj/` и `bin/` от предыдущей сборки всё ещё указывают на неверную reference-сборку, или тип скомпилировался чисто, но на месте вызова отсутствует директива `using`. Откройте оба `.csproj`-файла, выровняйте значения `TargetFramework`, запустите `dotnet build --no-incremental` (или удалите `obj/` и `bin/` руками на Windows) и только потом начинайте смотреть на `using`-директивы. Текст исключения и причина не менялись между .NET 6 и .NET 11 preview 4, так что один и тот же чек-лист применим к любому современному SDK-style проекту.

```text
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?)
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'MyApp.Domain' (are you missing an assembly reference?)
```

Два кода разделяют одну и ту же корневую причину по тонкой грани: `CS0246` означает, что компилятор не может найти тип верхнего уровня по короткому имени; `CS0234` означает, что компилятор нашёл пространство имён, но не увидел вложенный член. Оба срабатывают, как только C#-компилятор запрашивает у Roslyn символ, который читатель метаданных не может разрешить, что в SDK-style сборке происходит после того, как MSBuild закончил собирать список ссылок. Если этот список неверен, компилятор -- не тот слой, где нужно отлаживать.

Это руководство написано для .NET SDK 11.0.100-preview.4, MSBuild 17.13 и Roslyn 4.13. Поведение идентично в .NET 8 LTS и .NET 10. Коды ошибок компилятора стабильны с момента выхода Roslyn, поэтому решения применимы к каждой версии C#, начиная с 7.0.

## Почему компилятор не видит тип после добавления `ProjectReference`

Существует пять повторяющихся причин, и проверять их следует именно в таком порядке. Первые три объясняют подавляющее большинство поискового трафика, попадающего на точное сообщение выше.

1. **Несовпадение TargetFramework.** Ваш потребитель -- `net8.0`, а референсный проект -- `net11.0`, или потребитель -- `netstandard2.0`, а референсный проект -- `net8.0`. MSBuild поступает правильно и отказывается подключать ссылку, но выдаваемое им предупреждение (`NU1201` от NuGet или `NETSDK1005` от SDK) легко проскочить в выводе сборки. Следом срабатывает ошибка C# CS0246, и это тот самый симптом, который вы заметили.
2. **Устаревшие `obj/` и `bin/`.** Инкрементальные сборки в MSBuild агрессивны. После редактирования `.csproj` файл assets (`obj/project.assets.json`) и файлы откликов (`obj/*.csproj.AssemblyReference.cache`) могут расходиться с новым графом. Roslyn спокойно компилирует против старого набора ссылок и вы получаете CS0246 для типа, который существует на диске.
3. **Отсутствует директива `using`.** Вы добавили ссылку корректно, тип существует, сборка чистая, но место вызова не импортирует пространство имён. С включённым `ImplicitUsings` это редкость для BCL, но это правило для ваших собственных пространств имён. Подсказка компилятора в конце CS0246, `(are you missing a using directive or an assembly reference?)`, ставит этот вариант первым не зря.
4. **Проект отсутствует в solution.** Visual Studio и `dotnet build <solution>` собирают только те проекты, о которых знает файл `.sln`. Можно добавить `ProjectReference` на `.csproj`, которого нет в solution, и потребитель не найдёт тип, потому что производитель никогда не собирался. `dotnet build <consumer.csproj>` срабатывает, потому что обходит граф проектов напрямую; IDE падает, потому что обходит solution.
5. **`ReferenceOutputAssembly="false"` или `PrivateAssets="all"` на ссылке.** Оба -- легитимные элементы метаданных, используемые для подавления транзитивного распространения или для передачи ссылок только времени сборки (например, анализаторов), но каждый из них велит MSBuild не добавлять произведённую сборку в список ссылок компилятора. IDE часто показывает проект как сослонный в Solution Explorer, что делает этот случай самым медленным для обнаружения.

Есть менее распространённые причины, которые стоит назвать, чтобы исключить их по осмотру: чувствительная к регистру файловая система (Linux, macOS), где директива `using` не совпадает с регистром пространства имён точно; `Conditional` ItemGroup, исключающая ссылку для текущей `Configuration` или `TargetFramework`; multi-target потребитель (`<TargetFrameworks>net8.0;net11.0</TargetFrameworks>`), где только одна из внутренних сборок подхватывает ссылку; и global.json, фиксирующий версию SDK более старую, чем минимум `TargetFramework` потребителя.

## Ошибка в контексте

Вот как выглядит вывод сборки, когда срабатывает причина TargetFramework. Обратите внимание на строки перед CS0246, а не на сам CS0246:

```text
warning NU1201: Project Domain is not compatible with net8.0 (.NETCoreApp,Version=v8.0). Project Domain supports: net11.0 (.NETCoreApp,Version=v11.0)
warning MSB3277: Found conflicts between different versions of "System.Runtime" that could not be resolved.
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?) [C:\src\Api\Api.csproj]
```

`NU1201` -- это улика. Шаг restore у NuGet нашёл проект, но отверг его, потому что его набор target frameworks не содержит ничего, что потребитель мог бы потребить. Затем компилятор отработал с пустой ссылкой для этого проекта. CS0246 -- это следствие, а не сам баг.

## Минимальное воспроизведение

Наименьшая конфигурация из двух проектов, воспроизводящая несовпадение TargetFramework. Сохраните как `Domain/Domain.csproj` и `Api/Api.csproj`:

```xml
<!-- Domain/Domain.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```xml
<!-- Api/Api.csproj - .NET 8 LTS consumer of a net11.0 library -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Domain\Domain.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Domain/OrderService.cs - .NET 11 preview 4
namespace MyApp.Domain;

public sealed class OrderService
{
    public string Greet(int id) => $"order-{id}";
}
```

```csharp
// Api/Program.cs - .NET 8 LTS
using MyApp.Domain;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<OrderService>();

var app = builder.Build();
app.MapGet("/", (OrderService svc) => svc.Greet(1));
app.Run();
```

Запустите `dotnet build Api/Api.csproj` и получите точно ту же пару ошибок из предыдущей секции. CS0246 эффектен; предупреждение `NU1201` над ним -- настоящая поломка.

## Решение один: выровняйте значения TargetFramework

Самый безопасный шаг -- поднять потребителя, а не понижать библиотеку, потому что понижение обычно теряет API:

```xml
<!-- Api/Api.csproj - now .NET 11 to match the library -->
<TargetFramework>net11.0</TargetFramework>
```

Если потребителя сдвинуть нельзя, мульти-таргетируйте библиотеку, чтобы она поставляла сборку для обоих:

```xml
<!-- Domain/Domain.csproj -->
<TargetFrameworks>net8.0;net11.0</TargetFrameworks>
```

Для подлинно framework-нейтральных библиотек `netstandard2.0` всё ещё остаётся самым широким таргетом и потребляем из .NET Framework 4.7.2+, Mono, Unity и любого современного .NET. Выбирайте `netstandard2.0` только когда API-поверхность в него помещается; иначе мульти-таргетинг `net8.0` + `net11.0` -- более чистый вариант в 2026 году.

Заметка про `<TargetFrameworks>` с одним значением: пишите `<TargetFramework>` (единственное число). MSBuild считает их разными properties, и проект с `<TargetFrameworks>net8.0</TargetFrameworks>` собирается в `bin/<config>/net8.0/`, а не в `bin/<config>/`, что молча ломает нижестоящие инструменты, рассчитывающие на плоский layout.

## Решение два: удалите `obj/` и `bin/` после правки `.csproj`

Если фреймворки совпадают, но ошибка остаётся, кэш сборки устарел. Roslyn читает `obj/<project>.csproj.AssemblyReference.cache` и пер-проектный `*.GeneratedMSBuildEditorConfig.editorconfig`, чтобы сократить разрешение ссылок. Если вы отредактировали `.csproj` для добавления `ProjectReference`, пока предыдущая сборка ещё резидентна, кэш расходится с новым графом и компилятор работает против старого списка ссылок.

Правильный сброс в .NET 11 -- это `dotnet build --no-incremental` для разового чистого ребилда, или, в редких случаях, когда этого недостаточно, удалите папки сборки вручную:

```powershell
# .NET SDK 11.0.100-preview.4, PowerShell on Windows
Get-ChildItem -Path . -Include obj,bin -Recurse -Directory | Remove-Item -Recurse -Force
dotnet build
```

```bash
# .NET SDK 11.0.100-preview.4, bash on Linux/macOS
find . -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +
dotnet build
```

`dotnet clean` намеренно консервативен: он удаляет outputs, но сохраняет файл assets, а значит, не всегда лечит этот класс багов. Считайте его частичным сбросом, а не полным. Если рядом запущена IDE, закройте её перед удалением `obj/`, потому что языковая служба на Windows держит открытые дескрипторы файлов и удаление провалится на половине каталогов.

## Решение три: добавьте или исправьте директиву `using`

Когда ссылка здорова, компилятор может найти тип, но вам по-прежнему нужно импортировать его пространство имён на месте вызова. Решение механическое:

```csharp
// Api/Program.cs - .NET 11 preview 4
using MyApp.Domain;        // the namespace declared inside Domain/OrderService.cs
// using MyApp.Domain.Models; // for the CS0234 variant where you also need the nested namespace
```

Две тонкости кусают команды каждый релиз. Первая: `<ImplicitUsings>enable</ImplicitUsings>` добавляет фиксированный набор пространств имён (`System`, `System.Collections.Generic`, `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks` и SDK-специфичные дополнения), но не импортирует ваши собственные пространства имён. Вторая: начиная с C# 10 можно объявлять глобальные usings для закрытия этой бреши:

```xml
<!-- Api/Api.csproj - .NET 11 preview 4 -->
<ItemGroup>
  <Using Include="MyApp.Domain" />
</ItemGroup>
```

Это генерирует `GlobalUsings.g.cs` в `obj/` и экономит пер-файловую строку `using` везде, где потребляется `OrderService`. Цена: глобальные usings делают рефакторинг шумнее. Опечатка в глобальном пространстве имён роняет весь проект, а удалённая библиотека теперь прячется как одна правка MSBuild вместо волны красных подчёркиваний. Используйте их осознанно, а не рефлекторно.

## Решение четыре: подтвердите, что проект в solution

`dotnet sln list` -- самый быстрый способ проверить. Если ваш потребитель -- `Api/Api.csproj`, а библиотека -- `Domain/Domain.csproj`, оба должны появиться в `.sln`:

```bash
# .NET SDK 11.0.100-preview.4
dotnet sln list
# Project(s)
# ----------
# Api\Api.csproj
# Domain\Domain.csproj   <-- must be here
```

Если `Domain` отсутствует, IDE будет делать вид, что знает о нём (потому что `ProjectReference` разрешается на диске), но сборки в scope solution его пропустят, и одиночный ребилд потребителя упадёт, потому что `obj/project.assets.json` потребителя ссылается на сборку, которую никто не произвёл. Добавьте отсутствующий проект:

```bash
dotnet sln add Domain/Domain.csproj
```

Эта ловушка стала более частой в 2026, чем когда `slnx` и новый облегчённый формат solution появились в SDK .NET 11. CLI терпит сборку solution, перечисляющего проекты с разрозненными графами ссылок, а языковые сервисы в Visual Studio 2026 и Rider 2026.1 стали лучше предупреждать, когда сослонный проект находится вне активной solution. На более старом SDK предупреждение молчит. Об эргономике solution-файлов в целом стоит почитать про новый CLI: смотрите [улучшения dotnet sln CLI в .NET 11](/ru/2026/04/dotnet-11-sln-cli-solution-filters/).

## Решение пять: проверьте `ReferenceOutputAssembly` и `PrivateAssets`

Некоторые ссылки намеренно не передаются компилятору. Два элемента метаданных, которые нужно проверить на `ProjectReference`:

```xml
<!-- Will NOT add Domain.dll to the compiler's reference list -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  ReferenceOutputAssembly="false" />

<!-- Will not flow transitively to projects that consume the consumer -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  PrivateAssets="all" />
```

`ReferenceOutputAssembly="false"` корректен, когда референсный проект -- это инструмент времени сборки (генератор кода, хост анализаторов), чей output вы хотите вставить в граф сборки, но чью сборку не потребляете. Если он стоит на вашей настоящей библиотечной ссылке, потребитель падает CS0246, хотя граф сборки в остальном здоров.

`PrivateAssets="all"` -- это симметричный случай для транзитивных ссылок. Если `Api` ссылается на `Bff`, а `Bff` ссылается на `Domain` с `PrivateAssets="all"`, то `Api` не видит типы из `Domain`, хотя `Bff` видит. Подсказка лежит в проекте, который потребляет, а не в том, который производит.

## Варианты, похожие на ту же ошибку

Несколько соседних ошибок путают с CS0246 в поисковой выдаче:

- **`CS1069`: The type name 'X' could not be found in the namespace 'Y'. This type has been forwarded to assembly 'Z'.** Отсутствует type-forwarder. Добавьте сборку, названную в сообщении. Чаще всего встречается с `System.Configuration.ConfigurationManager` и `System.Drawing.Common` на современном .NET.
- **`CS8073` / `CS0518`: Predefined type 'System.Object' is not defined or imported.** Сломана неявная ссылка на `System.Runtime`. Почти всегда повреждённый `obj/` или вручную написанный `<Reference>`, исключающий фреймворк. `dotnet build --no-incremental` -- первая попытка.
- **`CS0433`: The type 'X' exists in both 'A' and 'B'.** Две сборки экспонируют один и тот же тип. Решается алиасом на `ProjectReference` (`<ProjectReference Include="..." Aliases="domain" />`) и директивой `extern alias` на месте вызова.
- **`NETSDK1005`: Assets file '...' doesn't have a target for 'net8.0'.** Ссылка идёт на пакет NuGet, скомпилированный под более высокий фреймворк, чем у потребителя. Та же корневая причина, что в Решении один выше, другое сообщение, потому что производитель -- пакет, а не проект.
- **`MSB4181`: The "ResolvePackageAssets" task returned false but did not log an error.** Настоящий провал restore; граф пакетов неразрешим. Удалите глобальный кэш `~/.nuget/packages/<name>/<version>/` для проблемного пакета и сделайте restore заново. Считайте это ортогональным к CS0246, хотя они часто соседствуют.

## Как читать вывод сборки для подтверждения решения

Сместите отладку с C#-списка ошибок на лог сборки. Компилятор -- неправильное место для начала, когда сломано разрешение ссылок. Три команды оправдывают своё место:

```bash
# .NET SDK 11.0.100-preview.4
dotnet build -v:n Api/Api.csproj
```

`-v:n` (`-verbosity normal`) печатает список разрешённых ссылок под `CoreCompile -> ResolveReferences`. Если вашей библиотеки нет в этом списке, компилятор её не видел и у вас проблема MSBuild, а не Roslyn.

```bash
dotnet build -bl Api/Api.csproj
```

`-bl` пишет `msbuild.binlog` рядом с проектом. Откройте его в [MSBuild Structured Log Viewer](https://msbuildlog.com/) и поищите `ResolveAssemblyReferences`. Просмотрщик показывает, какие именно пути к файлам MSBuild передал Roslyn и почему каждый из них был включён или пропущен.

```bash
dotnet msbuild Api/Api.csproj -t:ResolveReferences -p:DesignTimeBuild=false
```

Это запускает target разрешения ссылок изолированно, без вызова компилятора. Вывод лаконичен и говорит, в каком слое сбой: restore, разрешение или компиляция. CS0246 исчезает из шума.

## Граничные случаи, которые ловят опытных разработчиков

Некоторые паттерны воспроизводят CS0246 в коде, который при осмотре выглядит корректно:

- **`Directory.Packages.props` с `ManagePackageVersionsCentrally=true`.** Если вы забыли добавить запись `<PackageVersion>` для транзитивного пакета, который ваша библиотека экспонирует в API, потребитель не может разрешить тип из транзитивной зависимости. Сообщение -- CS0246, а не ожидаемая ошибка missing-version.
- **Мульти-таргетинг с `Condition`.** `<ProjectReference Include="..." Condition="'$(TargetFramework)' == 'net11.0'" />` пропустит ссылку для внутренней сборки `net8.0` мульти-таргет потребителя. IDE показывает ссылку; сборка `net8.0` не видит тип.
- **`global.json`, фиксирующий SDK без вашего `TargetFramework`.** Если `global.json` выбирает SDK 8.0.x, а проект таргетит `net11.0`, restore выдаёт безобидное предупреждение, а сборка падает CS0246 для каждого типа референсной библиотеки, потому что SDK-packs для `net11.0` не установлены.
- **Чувствительность к регистру в Linux.** `using MyApp.domain;` вместо `using MyApp.Domain;` компилируется в Windows и падает CS0246 в CI на Linux. Добавьте `<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>` и зафиксируйте регистр правилом `.editorconfig`.
- **Потребители Native AOT.** Если `<PublishAot>true</PublishAot>` установлен у потребителя, но не у библиотеки, AOT-анализатор помечает транзитивные trim-предупреждения как ошибки, и сборка может остановиться на нижестоящем CS0246, как только тип будет вырезан. Решение -- пометить библиотеку как trim-safe, а не глушить анализатор. Та же дисциплина trim, о которой говорит [пост про PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/), применима и здесь.

## Связанное

- Следующее исключение разрешения ссылок, в которое попадают команды после этого, -- это runtime-вариант, рассмотренный в [Unable to resolve service for type 'X' while attempting to activate 'Y'](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Эргономика solution-файла, которая делает этот класс багов проще для обнаружения: [изменения dotnet sln CLI в .NET 11](/ru/2026/04/dotnet-11-sln-cli-solution-filters/).
- Угловые случаи Native AOT, которые выводят CS0246 косвенно через trimming: [PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/).
- Политика предупреждений сборки, мешающая тихим `NU1201` прятаться под зелёным CI: [TreatWarningsAsErrors без саботажа dev-сборок](/ru/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).
- Когда отсутствующий тип -- это значение конфигурации, а сообщение похоже по духу: [no connection string named 'DefaultConnection' could be found](/ru/2026/05/fix-no-connection-string-named-defaultconnection/).

## Источники

- Microsoft Learn, [Compiler Error CS0246](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0246).
- Microsoft Learn, [Compiler Error CS0234](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0234).
- Microsoft Learn, [MSBuild ProjectReference protocol](https://learn.microsoft.com/en-us/visualstudio/msbuild/common-msbuild-project-items#projectreference).
- Microsoft Learn, [Implicit using directives in .NET 6+](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview#implicit-using-directives).
- Microsoft Learn, [global.json overview](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json).
- MSBuild source, [`Microsoft.Common.CurrentVersion.targets`](https://github.com/dotnet/msbuild/blob/main/src/Tasks/Microsoft.Common.CurrentVersion.targets), where `ResolveProjectReferences` lives.
