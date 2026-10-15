---
title: "Миграция Blazor-приложения с маршрутизируемыми компонентами в другой сборке с .NET 8 на .NET 10"
description: "Обновление Blazor Web App, страницы которого находятся в библиотеке классов Razor или в проекте .Client, с .NET 8 на .NET 10: что остаётся прежним (обе регистрации AdditionalAssemblies) и четыре вещи, которые ломаются, от 404 на blazor.web.js в тонких хостах до пустых страниц NotFoundPage. Замеры на ASP.NET Core 8.0.32 и 10.0.10."
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet-10"
  - "dotnet-8"
  - "aspnet-core"
  - "razor-class-library"
lang: "ru"
translationOf: "2026/10/migrate-blazor-routable-components-from-another-assembly-dotnet-8-to-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-15
---

Если ваш Blazor Web App на .NET 8 отображает страницы из другой сборки (библиотеки классов Razor, проекта `.Client`, функционального модуля), контракт маршрутизации в .NET 10 не меняется: на стороне конечных точек по-прежнему нужен `MapRazorComponents<App>().AddAdditionalAssemblies(...)`, а интерактивному `Router` по-прежнему нужен параметр `AdditionalAssemblies`. Я прогнал одну и ту же матрицу из семи вариантов регистрации на ASP.NET Core 8.0.32 и 10.0.10, и все варианты дали одинаковый результат. Ломается то, что вокруг: хост без собственных файлов `.razor` перестаёт отдавать `blazor.web.js`, `NotFoundPage` из библиотеки рендерит пустой ответ 404, если библиотека не зарегистрирована на стороне конечных точек, старый фрагмент `<NotFound>` помечен как устаревший, а ошибка "Assembly already defined" переезжает из строки в вашем `Program.cs` в запуск приложения. Для типичного решения с одной-двумя библиотеками страниц обновление занимает меньше часа. Всё ниже собрано с SDK 10.0.302 и `Microsoft.AspNetCore.Components.Web` 10.0.13.

## Зачем уходить с .NET 8 сейчас

- **Поддержка .NET 8 заканчивается 10 ноября 2026 года.** .NET 10 сейчас является LTS и поддерживается до ноября 2028 года. После этой даты приложения на .NET 8 перестанут получать исправления безопасности.
- **`NotFoundPage` работает между сборками.** .NET 10 умеет отображать маршрутизируемую страницу "не найдено" из вашей общей библиотеки для неизвестных URL, вызовов `NavigationManager.NotFound()` и повторного выполнения по коду состояния, вместо встроенного фрагмента, продублированного в каждом хосте.
- **Статические ресурсы получают отпечатки и сжатие.** `MapStaticAssets` (появился в .NET 9) отдаёт файлы библиотеки `_content/...` и скрипт Blazor со сжатием на этапе сборки и ETag, что полезно для библиотек страниц со своими CSS и JS.

## Что меняется между .NET 8 и .NET 10

| Область | Изменение | Важность |
| --- | --- | --- |
| Хост без файлов `.razor` | `blazor.web.js` в .NET 10 является статическим веб-ресурсом и создаётся, только если в проекте есть компонент. Тонкие хосты получают 404. | высокая |
| `NotFoundPage` в библиотеке | У страницы должен быть `@page`, а её сборка должна быть передана в `AddAdditionalAssemblies`, иначе ответ 404 будет пустым | средняя |
| Фрагмент `<NotFound>` | `[Obsolete]`, а в сочетании с `NotFoundPage` выбрасывает исключение | средняя |
| Ссылка на пакет в RCL | `Microsoft.AspNetCore.Components.Web` 8.0.x нужно перевести на 10.0.x | низкая |
| Повторная регистрация сборки | "Assembly already defined" выбрасывается при запуске, а не в вызове `AddAdditionalAssemblies` | низкая |
| Имена членов в компонентах библиотеки | В .NET 9 у `ComponentBase` появились `RendererInfo` и `AssignedRenderMode`; член компонента с тем же именем теперь скрывает их (CS0108) | низкая |
| `UseStaticFiles` | После публикации по-прежнему работает, но руководство по миграции заменяет его на `MapStaticAssets` | низкая |

## Две регистрации и что контролирует каждая

Именно здесь большинство миграций ошибаются, обычно потому что приложению Blazor Server на .NET 7 хватало одной из них. В Blazor Web App два маршрутизатора. Маршрутизация конечных точек ASP.NET Core обрабатывает первый HTTP-запрос (и каждый запрос расширенной навигации) и должна знать, в каких сборках есть компоненты с `@page`. Компонент Blazor `Router` обрабатывает навигацию, когда приложение уже работает интерактивно, и строит собственную таблицу маршрутов из `AppAssembly` плюс `AdditionalAssemblies`.

Вот тестовая конфигурация: хост, созданный из шаблона `blazor` для .NET 8 с Interactive Server, и библиотека классов Razor `Shared.Pages` с одной страницей.

```razor
@* Shared.Pages/Pages/Reports.razor, .NET 8 and .NET 10 *@
@page "/reports"
@rendermode InteractiveServer

<h1>Reports (from Shared.Pages)</h1>
<p>Rendered from @GetType().Assembly.GetName().Name</p>
<button @onclick="() => count++">Clicked @count</button>

@code {
    int count;
}
```

Я переключал каждую регистрацию и режим рендеринга `<Routes />` через переменные окружения, затем напрямую запрашивал `/reports`. Результаты на 8.0.32 и 10.0.10 совпали:

| `Router.AdditionalAssemblies` | `AddAdditionalAssemblies` | Режим рендеринга `<Routes>` | `GET /reports` |
| --- | --- | --- | --- |
| не задан | не задан | статический | 404 |
| задан | не задан | статический | 404 |
| не задан | задан | статический | 200 |
| задан | задан | статический | 200 |
| задан | не задан | `InteractiveServer` | 404 |
| не задан | задан | `InteractiveServer` | 200, затем "не найдено" после запуска канала |
| задан | задан | `InteractiveServer` | 200 |

Шестая строка самая запутанная. Сервер корректно предварительно рендерит страницу, браузер на мгновение её показывает, а затем управление берёт интерактивный `Router`, не находит `/reports` в своей таблице маршрутов и заменяет страницу содержимым "не найдено". Я подтвердил это в браузере на обеих версиях. Пятая строка это обратная ошибка: интерактивный маршрутизатор страницу знает, но самый первый запрос до неё не доходит, потому что конечной точки нет.

Поэтому правило для обеих версий простое: **регистрируйте каждую сборку с маршрутизируемыми компонентами в обоих местах.** Если компонент `Routes` находится в серверном проекте, его `AdditionalAssemblies` должен включать и сборку `.Client`.

## Контрольный список перед началом

1. Установлен .NET 10 SDK (`dotnet --list-sdks` показывает `10.0.1xx` или новее; я использовал 10.0.302). Если `global.json` закрепляет 8.0, обновите его.
2. Список всех сборок, содержащих компоненты с `@page`. Выполните `grep -rln "@page" --include=*.razor .` и сгруппируйте результаты по проектам.
3. Все места, где они регистрируются. `grep -rn "AdditionalAssemblies" --include=*.razor --include=*.cs .` должен показать один `Router` и одну цепочку `MapRazorComponents` на хост. Если он показывает только одно, у вас уже есть ошибка из матрицы выше.
4. Список URL, которые должны продолжать работать, включая один URL из каждой библиотеки и один, который должен давать 404. Вы будете проверять их через curl после каждого шага.

## Шаги миграции

1. **Смените целевую платформу всех проектов и обновите пакет в библиотеке.** Замените `<TargetFramework>net8.0</TargetFramework>` на `net10.0` в хосте, проекте `.Client` и каждой библиотеке классов Razor. Шаблон RCL ссылается на `Microsoft.AspNetCore.Components.Web` как на пакет, поэтому его версию тоже нужно обновить:

   ```xml
   <!-- Shared.Pages.csproj, .NET 10 -->
   <Project Sdk="Microsoft.NET.Sdk.Razor">
     <PropertyGroup>
       <TargetFramework>net10.0</TargetFramework>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <SupportedPlatform Include="browser" />
     </ItemGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.Components.Web" Version="10.0.13" />
     </ItemGroup>
   </Project>
   ```

   Если другие приложения всё ещё используют библиотеку на .NET 8, сделайте её мультитаргетной через `<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` и привяжите версию пакета к `$(TargetFramework)`. Проверьте через `dotnet build` и прочитайте предупреждения: CS0108 на компоненте библиотеки означает, что он объявляет член, который теперь скрывает член `ComponentBase` (см. подводные камни).

2. **Храните список сборок в одном месте и используйте его для обеих регистраций.** Большинство ошибок вида "страница работает после обновления, но не по клику" возникают из-за расхождения двух списков. Небольшой статический класс устраняет расхождение:

   ```csharp
   // Host/RoutableAssemblies.cs, .NET 10
   using System.Reflection;

   namespace Host;

   public static class RoutableAssemblies
   {
       // Do NOT include typeof(Program).Assembly: it is already the app assembly.
       public static readonly Assembly[] Additional =
       [
           typeof(Shared.Pages._Imports).Assembly,
           // typeof(Host.Client._Imports).Assembly,
       ];
   }
   ```

   ```csharp
   // Host/Program.cs, .NET 10
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   ```razor
   @* Host/Components/Routes.razor, .NET 10 *@
   <Router AppAssembly="typeof(Program).Assembly"
           AdditionalAssemblies="RoutableAssemblies.Additional"
           NotFoundPage="typeof(Shared.Pages.Pages.NotFound)">
       <Found Context="routeData">
           <RouteView RouteData="routeData" DefaultLayout="typeof(Layout.MainLayout)" />
           <FocusOnNavigate RouteData="routeData" Selector="h1" />
       </Found>
   </Router>
   ```

   Проверьте: `curl -s -o /dev/null -w '%{http_code}' http://localhost:5000/reports` должен вернуть `200` для одного URL из каждой библиотеки, затем откройте тот же URL в браузере и дождитесь запуска канала (или среды выполнения WebAssembly). После этого страница должна остаться на месте.

3. **Замените `<NotFound>` на маршрутизируемую `NotFoundPage`.** В .NET 10 фрагмент рендеринга `NotFound` помечен как `[Obsolete("NotFound is deprecated. Use NotFoundPage instead.")]`. Примечания к выпуску идут дальше и говорят, что он "isn't supported in .NET 10 or later", но в моём тесте фрагмент всё ещё рендерился на 10.0.10, когда `NotFoundPage` не был задан, так что это устаревание, которое можно запланировать, а не отказ. Если задать оба, будет выброшено `InvalidOperationException: Setting NotFound and NotFoundPage properties simultaneously is not supported`. Странице нужен маршрут, потому что маршрутизатор проверяет наличие у неё атрибута `[Route]`:

   ```razor
   @* Shared.Pages/Pages/NotFound.razor, .NET 10 *@
   @page "/not-found"

   <h1>Not found (from Shared.Pages)</h1>
   ```

   Затем добавьте middleware повторного выполнения по коду состояния, которое использует шаблон .NET 10, чтобы неизвестные URL из первого HTTP-запроса тоже попадали на эту страницу:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
   app.UseAntiforgery();
   ```

   Проверьте, что `GET /missing` возвращает `404` с `<h1>` вашей страницы в теле, а `GET /not-found` возвращает `200`. Если тело ответа 404 пустое, прочитайте следующий шаг.

4. **Зарегистрируйте сборку страницы "не найдено" на стороне конечных точек.** Повторное выполнение это второй запрос через маршрутизацию конечных точек к `/not-found`. Если страница находится в библиотеке, о которой знает только `Router`, для неё нет конечной точки. Замер на 10.0.10 со страницей в `Shared.Pages`:

   | `AddAdditionalAssemblies(Shared.Pages)` | `GET /missing` | `GET /not-found` |
   | --- | --- | --- |
   | отсутствует | 404, пустое тело | 404, пустое тело |
   | есть | 404, "Not found (from Shared.Pages)" | 200 |

   Шаг 2 уже исправляет это, если библиотека входит в общий список. Проверьте теми же двумя запросами.

5. **Перейдите с `UseStaticFiles` на `MapStaticAssets`.** Руководство по миграции на .NET 9 заменяет `app.UseStaticFiles()` на `app.MapStaticAssets()`, и шаблон .NET 10 использует именно его. Он отдаёт ресурсы библиотеки по пути `_content/Shared.Pages/...` с заранее сжатыми вариантами `.br` и `.gz`. Я проверил, что `UseStaticFiles` на .NET 10 по-прежнему отдаёт `blazor.web.js` из папки публикации, так что переход не обязателен, но именно его ожидает остальной шаблон (`@Assets["..."]`, `<ResourcePreloader />`, `<ImportMap />`):

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseAntiforgery();
   app.MapStaticAssets();
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   Проверьте, что `GET /_framework/blazor.web.js` возвращает `200` и что таблица стилей библиотеки, например `/_content/Shared.Pages/Shared.Pages.bundle.scp.css`, по-прежнему загружается.

6. **Если у хоста нет файлов `.razor`, принудительно верните скрипт Blazor.** Это поломка, которая бьёт только по самым чистым архитектурам. Когда `App.razor`, макет и все страницы находятся в библиотеках, а хост состоит лишь из `Program.cs`, .NET 8 всё равно отдавал `blazor.web.js`, потому что он был встроенным ресурсом в общем фреймворке. В .NET 10 скрипт является статическим веб-ресурсом, который SDK добавляет, только если в проекте есть хотя бы один компонент. Мой тонкий хост, замер из папки публикации:

   | Хост | `GET /reports` | `GET /_framework/blazor.web.js` |
   | --- | --- | --- |
   | .NET 8.0.32, `UseStaticFiles` | 200 | 200 |
   | .NET 10.0.10, `MapStaticAssets` | 200 | 404 |
   | .NET 10.0.10, `MapStaticAssets` + `RequiresAspNetWebAssets` | 200 | 200 |

   Страница по-прежнему предварительно рендерится, поэтому это легко пропустить: ничего не интерактивно, а единственный сигнал это 404 на вкладке сети браузера. Исправление это одно свойство MSBuild:

   ```xml
   <!-- Host.csproj, .NET 10, host project without any .razor file -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
   </PropertyGroup>
   ```

   Проверьте, что после `dotnet publish` существует `publish/wwwroot/_framework/blazor.web.js`, затем нажмите на что-нибудь интерактивное в браузере.

7. **Для страниц WebAssembly и Auto в библиотеке проверьте и сторону `.Client`.** Между 8 и 10 здесь ничего не изменилось, но миграция хороший повод это поправить. Страница библиотеки с `@rendermode InteractiveWebAssembly` должна быть доступна для загрузки браузером, поэтому проект `.Client` должен ссылаться на библиотеку, а сервер по-прежнему должен перечислять её в `AddAdditionalAssemblies` для первого запроса. Если сам `Routes` работает на WebAssembly (глобальная интерактивность), он находится в `.Client`, и его `Router` должен получить библиотеку в `AdditionalAssemblies`. Проверьте, загрузив страницу WebAssembly напрямую, а затем перейдя на неё с другой страницы.

## Проверка

Запускайте это против опубликованного приложения (`dotnet publish -c Release -o out`, затем `dotnet out/Host.dll`), а не против `bin/`:

```bash
#!/usr/bin/env bash
# .NET 10 smoke test for routable components from other assemblies
BASE=http://localhost:5000
for u in /reports /not-found /missing /_framework/blazor.web.js; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u")"
done
```

Ожидается: `200`, `200`, `404`, `200`. Затем в браузере:

- Откройте страницу библиотеки напрямую и подождите две секунды. Она не должна превратиться в страницу "не найдено".
- Перейдите со страницы хоста на страницу библиотеки по ссылке и обратно.
- Вызовите `NavigationManager.NotFound()` со страницы библиотеки, если вы его используете, и убедитесь, что отображается `NotFoundPage`.
- Проверьте на вкладке сети отсутствие 404 для `_framework/` и `_content/`.

## Откат

Изменение обратимо, пока вы сохраняете совместимость библиотеки. Если библиотека мультитаргетна `net8.0;net10.0`, вы можете откатить хост на `net8.0`, вернув его `.csproj`. Помните, чего в 8 нет: `MapStaticAssets` (используйте `UseStaticFiles`), `NotFoundPage` (используйте фрагмент `<NotFound>`), параметра `createScopeForStatusCodePages` у `UseStatusCodePagesWithReExecute` и `RequiresAspNetWebAssets` (безвреден, но не используется). Держите эти изменения в отдельном коммите от смены целевой платформы, чтобы откат был чистым revert.

## Подводные камни из тестовых прогонов

**"Assembly already defined" переехала.** Добавление собственной сборки приложения в `AddAdditionalAssemblies` всегда было ошибкой. На 8.0.32 трассировка стека указывает прямо на ваш код:

```text
Unhandled exception. System.InvalidOperationException: Assembly already defined.
   at Microsoft.AspNetCore.Components.Discovery.ComponentApplicationBuilder.AddLibrary(...)
   at Microsoft.AspNetCore.Builder.RazorComponentsEndpointConventionBuilderExtensions.AddAdditionalAssemblies(...)
   at Program.<Main>$(String[] args) in .../Host/Program.cs:line 29
```

На 10.0.10 регистрация откладывается до первого построения конечных точек, поэтому та же ошибка логируется как `Application startup exception` из `RazorComponentEndpointDataSource.UpdateEndpoints()`, и ни один кадр не упоминает `Program.cs`. Если после обновления вы видите это сообщение, поищите `typeof(Program).Assembly` в списке дополнительных сборок или ту же библиотеку, добавленную дважды из двух вспомогательных методов.

**Дублирующиеся маршруты между сборками падают во время запроса, а не при запуске.** Когда и хост, и библиотека объявили `@page "/reports"`, приложение на 10.0.10 запустилось нормально, а запрос вернул `500` с `AmbiguousMatchException: The request matched multiple endpoints`. Ломается только конфликтующий URL, поэтому дымовой тест, который его пропускает, пройдёт. Вывод `grep -rn '@page "' --include=*.razor` из контрольного списка, отсортированный по маршруту, находит такие случаи до выпуска.

**Член библиотеки с именем `RendererInfo` теперь скрывает член фреймворка.** В первой версии моей тестовой страницы было свойство `string RendererInfo`. На .NET 8 оно компилировалось без замечаний, а на .NET 10 выдало `warning CS0108: 'Reports.RendererInfo' hides inherited member 'ComponentBase.RendererInfo'`, потому что в .NET 9 у `ComponentBase` появились `RendererInfo` и `AssignedRenderMode`. Предупреждение безвредно, пока коллега не прочитает `RendererInfo.IsInteractive` в этом компоненте и не получит вашу строку. Переименуйте член.

**`UseStaticFiles` вместе с тестом из `bin/` даёт ложный 404.** При оставленном конвейере .NET 8 (`UseStaticFiles`, без `MapStaticAssets`) запуск `dotnet bin/Release/net10.0/Host.dll` в окружении Production возвращал 404 для `blazor.web.js` даже в обычном хосте с компонентами, тогда как тот же запуск на .NET 8 возвращал 200. `UseStaticFiles` видит только файлы, физически лежащие в `wwwroot`, а вне Development ничто не добавляет статические веб-ресурсы из подключённых проектов и SDK. В .NET 8 скрипт Blazor приходил из встроенного ресурса, поэтому его это не касалось; в .NET 10 это статический веб-ресурс. Тот же запуск из `bin/` с `MapStaticAssets` вернул 200, потому что он читает сгенерированный манифест конечных точек, а папка публикации вернула 200 с любым из middleware. Тестируйте из папки `dotnet publish` или через `dotnet run`, иначе вы будете искать не ту проблему.

**Предварительный рендеринг скрывает отсутствующую регистрацию в `Router`.** Как показывает матрица, страница, зарегистрированная только на стороне конечных точек, идеально рендерится в `curl` и в автоматических тестах снимков HTML. Сбой появляется только после запуска интерактивного маршрутизатора. Любой сквозной тест для страниц библиотек должен дожидаться интерактивности, например нажимая кнопку и проверяя результат.

## Связанные материалы

- Если вы всё ещё на модели хостинга .NET 7, начните с [миграции приложения Blazor Server на Blazor United](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), а затем возвращайтесь к части о нескольких сборках.
- О том, в каком режиме рендеринга на самом деле работает страница библиотеки после маршрутизации, см. [что такое режим рендеринга Blazor и какой из них запускает мой компонент](/ru/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).
- Похожий сбой статических ресурсов с другой причиной: [404 Not Found для blazor.server.js после установки нового .NET SDK](/ru/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).
- Если страница библиотеки объявляет режим рендеринга, который её родитель не может разместить, вы столкнётесь с [ошибкой "render mode is not supported by the parent component's render mode"](/ru/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/).
- Структура проекта за `.Client` и `AddAdditionalAssemblies` сравнивается в [Blazor Server против WebAssembly против United](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Источники

- [Route to components from multiple assemblies](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) (Microsoft Learn, ASP.NET Core Blazor routing)
- [Migrate from ASP.NET Core in .NET 8 to ASP.NET Core in .NET 9](https://learn.microsoft.com/en-us/aspnet/core/migration/80-to-90), включая "Replace UseStaticFiles with MapStaticAssets" (Microsoft Learn)
- [Migrate from ASP.NET Core in .NET 9 to ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/migration/90-to-100) (Microsoft Learn)
- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0): "Blazor router has a NotFoundPage parameter" и "Blazor script as static web asset"
- [Map static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/map-static-files) (Microsoft Learn)
- [ASP.NET Core Razor class libraries](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/class-libraries) (Microsoft Learn)
- [`Router.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Components/src/Routing/Router.cs), источник проверки `NotFoundPage` и устаревшего параметра `NotFound` (dotnet/aspnetcore)
- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) для дат окончания поддержки .NET 8 и .NET 10
