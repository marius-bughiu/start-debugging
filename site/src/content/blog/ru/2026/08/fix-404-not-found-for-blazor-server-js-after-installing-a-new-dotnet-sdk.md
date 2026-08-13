---
title: "Исправление: 404 Not Found для blazor.server.js после установки нового SDK .NET"
description: "blazor.server.js возвращает 404 в .NET 10, потому что скрипт перестал быть встроенным ресурсом. Добавьте RequiresAspNetWebAssets в host-проект или убедитесь, что в нём есть файл .razor."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnet-core"
  - "dotnet-10"
  - "dotnet-11"
  - "static-web-assets"
lang: "ru"
translationOf: "2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk"
translatedBy: "claude"
translationDate: 2026-08-13
---

Добавьте `<RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>` в host-проект и выполните restore. В .NET 10 скрипт Blazor перестал быть встроенным ресурсом в `Microsoft.AspNetCore.Components.Server` и стал файлом из пакета NuGet `Microsoft.AspNetCore.App.Internal.Assets`, который SDK подтягивает только тогда, когда в проекте есть хотя бы один файл `.razor`. Нет файла `.razor` в host-проекте, нет и скрипта: 404. Всё описанное ниже измерено на SDK 10.0.201 и ASP.NET Core 10.0.5 под Windows 11.

## Ошибка в контексте

Консоль браузера для `_Host.cshtml`, который без изменений работал начиная с .NET 6:

```
GET https://localhost:5001/_framework/blazor.server.js net::ERR_ABORTED 404 (Not Found)
Uncaught ReferenceError: Blazor is not defined
```

Страница отрисовывает свой предварительно отрендеренный HTML и дальше ничего не делает. Circuit не открывается, ни одна кнопка не работает, а журнал сервера молчит, потому что 404 от middleware статических файлов не является исключением. То же самое происходит с `_framework/blazor.web.js` в Blazor Web App.

Самое запутанное здесь: что именно послужило триггером. Файл проекта не менялся. Очень часто не менялся и target framework. Кто-то установил SDK .NET 10, и приложение, которое вчера собиралось и запускалось, теперь возвращает 404 для одного-единственного файла.

## Почему скрипт исчез

До .NET 9 включительно `blazor.server.js` был встроенным ресурсом внутри сборки общего фреймворка, а `MapBlazorHub()` регистрировал отдельную конечную точку, которая читала его из этой сборки. Эта конечная точка не могла не найти файл, потому что файл находился внутри той же DLL, которая её регистрировала.

В .NET 10 её убрали. Хавьер Кальварро Нельсон из команды ASP.NET Core [объяснил это прямо](https://github.com/dotnet/aspnetcore/issues/64381#issuecomment-3546832403), когда об этом сообщили впервые:

"In 10.0, we stopped embedding the `server.js` and the `.web.js` files inside their respective assemblies so that we can compress and fingerprint them like any other files."

Это действительно улучшение. Теперь скрипт получает сжатие Gzip на этапе сборки, Brotli при публикации, хеш содержимого в URL и годовой immutable `Cache-Control`. Но это меняет то, откуда берётся файл. Теперь это статический веб-ресурс, поставляемый пакетом NuGet, который SDK добавляет в граф восстановления у вас за спиной. На моей машине:

```
C:\Users\mariu\.nuget\packages\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
  blazor.server.js
  blazor.server.js.map
  blazor.web.js
  blazor.web.js.map
  blazor.webassembly.js
  blazor.webassembly.js.map
```

Версию фиксирует SDK, а не ваш проект. Решает это `Microsoft.NETCoreSdk.BundledVersions.props` из установки SDK:

```xml
<!-- C:\Program Files\dotnet\sdk\10.0.201\Microsoft.NETCoreSdk.BundledVersions.props -->
<KnownAspNetCorePack Include="Microsoft.AspNetCore.App.Internal.Assets"
                     TargetFramework="net10.0"
                     AspNetCorePackVersion="10.0.5" />
```

А вот та часть, которая и вызывает 404. SDK добавляет этот пакет не во все веб-проекты, потому что большинство веб-проектов не являются приложениями Blazor и никому не нужен скрипт Blazor, скачиваемый в minimal API. Он угадывает, по одной-единственной эвристике:

```xml
<!-- Sdks\Microsoft.NET.Sdk.Web.ProjectSystem\targets\Microsoft.NET.Sdk.Web.ProjectSystem.targets -->
<Target Name="ResolveRequiredWebAssets" BeforeTargets="ProcessFrameworkReferences">
  <PropertyGroup>
    <RequiresAspNetWebAssets
      Condition="'$(RequiresAspNetWebAssets)' == '' and @(Content->AnyHaveMetadataValue(Extension, .razor))">true</RequiresAspNetWebAssets>
  </PropertyGroup>
</Target>
```

Если в host-проекте есть файл `.razor` среди элементов `Content`, пакет подключается. Иначе `RequiresAspNetWebAssets` откатывается к значению по умолчанию `false`, пакет никогда не восстанавливается, и `_framework/blazor.server.js` просто отсутствует в манифесте статических веб-ресурсов приложения. Никакого предупреждения на этапе сборки нет. Сборка проходит успешно.

У множества реальных приложений Blazor Server нет ни одного файла `.razor` в host-проекте. Если ваши компоненты живут в Razor Class Library, а host состоит только из `Program.cs`, `_Host.cshtml` и ссылки на проект, эвристика говорит "это не приложение Blazor", и вы получаете 404.

## Минимальное воспроизведение

Host на ASP.NET Core, который отдаёт компоненты Blazor Server из RCL. Ничего экзотического:

```xml
<!-- BzSrv.csproj, .NET 10, SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\BzLib\BzLib.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Program.cs, .NET 10, ASP.NET Core 10.0.5
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();

var app = builder.Build();
app.UseStaticFiles();
app.MapBlazorHub();
app.MapFallbackToPage("/_Host");
app.Run();
```

```html
<!-- Pages/_Host.cshtml -->
<component type="typeof(App)" render-mode="ServerPrerendered" />
<script src="_framework/blazor.server.js"></script>
```

Соберите проект и посмотрите, что решил restore:

```bash
dotnet build
grep -o "Microsoft.AspNetCore.App.Internal.Assets/[0-9.]*" obj/project.assets.json
# (no output)
grep -c "blazor.server.js" bin/Debug/net10.0/BzSrv.staticwebassets.runtime.json
# 0
```

Пакета нет в графе восстановления, а скрипта нет в манифесте. Запрос к нему возвращает HTTP 404 с телом нулевой длины. Перенесите в host-проект хотя бы один файл `.razor` или задайте свойство ниже, и оба счётчика перестанут быть нулевыми.

## Исправление

**Задайте свойство в host-проекте.** Это поддерживаемый обходной путь, и именно на него указывает команда ASP.NET Core. Оно должно быть в проекте, который использует `Microsoft.NET.Sdk.Web`, то есть в том, который реально обслуживает запросы, а не в RCL:

```xml
<!-- BzSrv.csproj, .NET 10 / .NET 11 -->
<PropertyGroup>
  <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
</PropertyGroup>
```

Затем выполните restore, потому что пакет попадает в граф именно во время восстановления, а не во время сборки:

```bash
dotnet restore
```

`dotnet build` запускает неявный restore, поэтому обычной пересборки, как правило, достаточно. Шаг CI, который выполняет `dotnet build --no-restore` поверх восстановления, сделанного до добавления свойства, этого не подхватит. После изменения обе проверки дают положительный результат, и файл отдаётся размером 164838 байт.

**Либо добавьте файл `.razor` в host-проект.** Перенос `App.razor` (или любого компонента) обратно в host удовлетворяет эвристику без всяких свойств MSBuild. Нормально, если такой файл у вас и так планировался, но это странная причина двигать код, а свойство лучше выражает намерение.

**Не хватайтесь за `MapStaticAssets()`.** Это самый распространённый плохой совет по этой ошибке, и о нём стоит сказать конкретно, потому что он отнимает часы. Перевод работающего конвейера на `MapStaticAssets()` не чинит отсутствующий пакет, а `UseStaticFiles()` никогда и не был проблемой. Команда [закрыла PR от сообщества](https://github.com/dotnet/aspnetcore/pull/66060#issuecomment-5068880296), который строился на таком диагнозе:

"`blazor.web.js` and `blazor.server.js` are shipped as static web assets, and `app.UseStaticFiles()` already serves them without `MapStaticAssets()` (this is what our own server-side Blazor E2E tests exercise, using `UseStaticFiles()` and `MapBlazorHub()` with no `MapStaticAssets()` call)."

Это совпадает с моими измерениями. При наличии пакета `UseStaticFiles()` и `MapBlazorHub()` отдают скрипт и в Development, и из опубликованного вывода, без `MapStaticAssets()` где бы то ни было.

## Что на самом деле возвращает каждая конфигурация

Девять запусков на одном и том же воспроизведении, каждый из них является HTTP-запросом к `/_framework/blazor.server.js` к настоящему процессу Kestrel:

| Host-проект | Конвейер | Окружение | Запуск из | Результат |
| --- | --- | --- | --- | --- |
| есть `.razor` | `UseStaticFiles()` | Development | `dotnet run` | 200, 164838 байт |
| есть `.razor` | `UseStaticFiles()` | Development | вывод сборки | 200 |
| есть `.razor` | `UseStaticFiles()` | Production | вывод сборки | **404** |
| есть `.razor` | `UseStaticFiles()` | Production | опубликованный вывод | 200 |
| есть `.razor` | `MapStaticAssets()` | Development | вывод сборки | 200 |
| есть `.razor` | `MapStaticAssets()` | Production | вывод сборки | **500** |
| нет `.razor` | `UseStaticFiles()` | Development | вывод сборки | **404** |
| нет `.razor`, свойство задано | `UseStaticFiles()` | Development | вывод сборки | 200 |
| `EnableDefaultContentItems=false` | любой | любое | любой | пакет не восстанавливается |

Две строки заслуживают отдельного объяснения.

**Production поверх вывода сборки возвращает 404 даже при правильно настроенном проекте.** `WebApplication.CreateBuilder` вызывает `UseStaticWebAssets()` только в окружении Development. В Development манифест статических веб-ресурсов отображает `_framework/` прямо в показанную выше папку кеша NuGet. В любом другом окружении это отображение не применяется, а у вывода сборки нет собственного `wwwroot/_framework/`, так что отдавать нечего. Опубликованный вывод работает, потому что `dotnet publish` копирует реальные файлы (вместе с вариантами `.gz` и `.br`) в `wwwroot/_framework/`. Это бьёт по smoke-тестам в CI и по образам контейнеров, которые запускают вывод `dotnet build` с `ASPNETCORE_ENVIRONMENT=Staging`. Это не новинка .NET 10, но до .NET 10 конечная точка со встроенным ресурсом скрывала проблему именно для этого файла.

**Та же конфигурация под `MapStaticAssets()` возвращает 500, а не 404**, и это полезная диагностика. Конечная точка регистрируется из `BzSrv.staticwebassets.endpoints.json`, который копируется в выходной каталог и читается независимо от окружения, поэтому маршрутизация срабатывает. А вот файловый провайдер выдать байты уже не может:

```
System.IO.FileNotFoundException: Could not find file '...\BzSrv\wwwroot\_framework\blazor.server.js'.
   at System.IO.FileInfo.get_Length()
   at Microsoft.AspNetCore.Builder.StaticAssetDevelopmentRuntimeHandler...
```

500 с такой трассировкой означает, что манифест знает про скрипт, а файловый провайдер до него не дотягивается: значит, с пакетом всё в порядке, а неправильно выбрано окружение или выходной каталог. Чистый 404 означает, что скрипта в манифесте не было никогда: значит, пакет отсутствует, и ваше решение: `RequiresAspNetWebAssets`.

## Подводные камни и похожие случаи

**`EnableDefaultContentItems=false` молча отключает эвристику.** Условие MSBuild проверяет элементы `Content`, а не файлы на диске. Host-проект с `App.razor` прямо рядом с `Program.cs` всё равно не восстановит пакет, если стандартные шаблоны содержимого отключены. Проверено: тот же проект, тот же файл, пакета нет. Задавайте свойство явно в любом проекте, который настраивает элементы содержимого под себя.

**Проект на `Microsoft.NET.Sdk.Razor` не определяет это автоматически никогда.** Цель `ResolveRequiredWebAssets` поставляется только в `Microsoft.NET.Sdk.Web.ProjectSystem.targets`. Если ваш host использует Razor SDK или задаёт `<OutputType>Library</OutputType>`, `RequiresAspNetWebAssets` за вас не выставит ничто, сколько бы компонентов он ни содержал. Именно такой случай описан в [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545). Задавайте свойство вручную.

**`packages.lock.json` превращает исправление в ошибку сборки.** Добавление свойства меняет граф восстановления, поэтому заблокированный restore отклонит его с сообщением, которое стоит узнавать в лицо:

```
error NU1004: The package references have changed for net10.0. Lock file's package references: None,
project's package references: Microsoft.AspNetCore.App.Internal.Assets >= 10.0.5. The packages lock
file is inconsistent with the project dependencies so restore can't be run in locked mode.
```

Один раз перегенерируйте файл блокировки и закоммитьте его:

```bash
dotnet restore --force-evaluate
```

**Restore должен иметь возможность дотянуться до пакета.** Это настоящий пакет с nuget.org, а не что-то, встроенное в установку SDK. Сборки без доступа к сети и приватные ленты без зеркала upstream его не найдут, а какая версия будет запрошена, решает версия SDK, а не ваш target framework. Установите новый патч SDK, и вашей офлайн-ленте понадобится соответствующая новая версия `Microsoft.AspNetCore.App.Internal.Assets`.

**Если папка пакета исчезает, приложение не отдаёт 404, а вообще не стартует.** Очистка кеша NuGet при сохранившемся устаревшем выводе сборки даёт вот это при запуске, ещё до того, как Kestrel займёт порт:

```
Unhandled exception. System.IO.DirectoryNotFoundException: ...\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
   at Microsoft.AspNetCore.Hosting.StaticWebAssets.StaticWebAssetsLoader.UseStaticWebAssetsCore(...)
   at Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(String[] args)
```

Манифест в `bin` хранит абсолютный путь в кеш пакетов. Удалите `bin` и `obj`, затем пересоберите.

**Приложение на .NET 9 может нарваться на это, вообще не обновляясь.** [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353) описывает приложение Blazor на `net9.0`, которое начало отдавать 404 в тот момент, когда был установлен SDK .NET 10. Причиной оказалась переменная `DOTNET_ROLL_FORWARD=LatestMajor` в окружении: приложение переезжало на среду выполнения 10.0, где скрипт больше не встроен, продолжая при этом собираться как проект .NET 9, который пакет никогда не восстанавливает. Проверьте `dotnet --info` на наличие этой переменной, прежде чем трогать файл проекта. Запустите на среде выполнения 9.0, и встроенный ресурс будет на месте, а всё будет работать, с SDK .NET 10 или без него.

**Документация занижает масштаб.** [Статья о структуре проекта Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0) говорит, что файл `.razor` нужен "in order to automatically include the Blazor script when the app is published". Это влияет и на `dotnet build`: воспроизведение выше даёт 404 под `dotnet run` в Development, задолго до того, как кто-либо что-либо публикует.

**В .NET 11 всё это без изменений.** Модель доставки статических ресурсов и свойство `RequiresAspNetWebAssets` переходят дальше, а указанная выше страница документации в равной мере относится к монидентификаторам `aspnetcore-10.0` и `aspnetcore-11.0`. Обновление за пределы 10 требование не снимает.

## Похожие материалы

Если вы в процессе обновления и это одна из нескольких вещей, сломавшихся разом, пункты по Blazor собраны в [чек-листе перехода с .NET 8 на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), а сторона render mode того же перехода описана в [миграции приложения Blazor Server на Blazor United](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/). После того как скрипт загрузился и circuit действительно открылся, следующие два сбоя, с которыми сталкиваются чаще всего, это [баннер переподключения после разрыва circuit](/ru/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/) и [вызовы взаимодействия с JavaScript, которые невозможно выполнить во время предварительного рендеринга](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). Если вы ещё решаете, должен ли host вообще размещать компоненты, компромиссы разобраны в [Blazor Server против WebAssembly против United](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Источники

- [ASP.NET Core Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0): свойство `RequiresAspNetWebAssets` и правило про хотя бы один файл `.razor`.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0): `MapStaticAssets` против `UseStaticFiles` и что каждый из них может и не может отдавать.
- [dotnet/aspnetcore#64381](https://github.com/dotnet/aspnetcore/issues/64381): исходное сообщение об ошибке с объяснением команды, почему скрипты перестали быть встроенными ресурсами.
- [dotnet/aspnetcore#66175](https://github.com/dotnet/aspnetcore/issues/66175): тот же 404 на SDK 10.0.201 после обновления приложения Blazor Server, закрыт добавлением свойства.
- [dotnet/aspnetcore#66059](https://github.com/dotnet/aspnetcore/issues/66059) и [предложенный по нему PR](https://github.com/dotnet/aspnetcore/pull/66060): почему возврат старых конечных точек со встроенными ресурсами отклонён, и подтверждение того, что `UseStaticFiles()` сегодня отдаёт эти файлы.
- [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353): вариант с roll forward, ломающий приложения `net9.0` после установки SDK.
- [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545): вариант с `OutputType` и не-Web SDK.
