---
title: "Миграция с .NET Framework 4.8 на .NET 11 в 2026 году"
description: "Привязанный к версиям план миграции кодовой базы .NET Framework 4.8 на .NET 11 LTS в 2026 году: переход на SDK-style csproj, замена System.Web на ASP.NET Core, WCF, переход с EF6 на EF Core 11, удаление BinaryFormatter, замены AppDomain и реалистичный план отката."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "ru"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

Перевод кодовой базы .NET Framework 4.8 на .NET 11 — это не просто обновление версии. Это смена платформы, затрагивающая формат проекта, веб-стек, слой доступа к данным, модель хостинга и длинный список API, которые тихо исчезли в период с 2017 по 2026 год. Официальное окно поддержки .NET Framework 4.8 в 2026 году всё ещё открыто, но среда выполнения не получала функциональных обновлений с 2019 года, каждый современный план Azure App Service по умолчанию работает на стеке Core, и почти все NuGet-пакеты, на которые стоит полагаться, отказались от целевой платформы `net48`. Реалистичные трудозатраты для типичного бизнес-приложения составляют от двух до шести недель для небольшого сервиса и от двух до четырёх месяцев для средней кодовой базы с WCF, EF6 и фронтендом на WebForms или MVC 5. Приложения на WebForms либо остаются как есть, либо переписываются заново; пути миграции на месте не существует. В этой статье `net48` фиксируется как исходная платформа, а `net11.0` как целевая, и предполагается, что проект работает на Windows.

## Зачем мигрировать сейчас

- .NET Framework 4.8 находится в режиме обслуживания с момента выхода 4.8.1 в августе 2022 года. Никаких новых API, никаких новых возможностей языка C#. Среда выполнения .NET 11 поставляется с включённым по умолчанию динамическим PGO, модернизированным многоуровневым JIT и Native AOT для minimal APIs ASP.NET Core.
- Каждый новый фреймворк Microsoft (Aspire, Microsoft Agent Framework, Semantic Kernel 1.x, Azure Functions isolated worker) нацелен на `net8.0` или новее и не будет портирован назад. Оставаясь на 4.8, вы не сможете использовать ни один из них в своём процессе.
- Стоимость облака. Объём памяти среды выполнения .NET 11 для простаивающего minimal API на ASP.NET Core составляет примерно от 35 до 50 процентов от рабочего процесса ASP.NET 4.8 при сопоставимой нагрузке, что напрямую переводится в меньшие планы App Service или большую плотность подов в Kubernetes.
- Найм и инструменты. Анализаторы Roslyn, генераторы исходного кода и современный CLI `dotnet` предполагают проект в стиле SDK. Версия языка C# на `net48` ограничена C# 7.3, если не бороться с компилятором, что оставляет за бортом десятилетие языковых возможностей.

Если кодовая база — это десктопное приложение Windows (WinForms или WPF), которое работает только на Windows и не планируется к развёртыванию где-либо ещё, вопрос обоснован. Ответ всё равно обычно "да", потому что срок поддержки net48 заканчивается вместе с окном расширенной поддержки Windows 10, а поддержка в инструментах уже слабая.

## Что ломается

| Область                       | Изменение                                                                                                | Серьёзность |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ----------- |
| Формат проекта                | `packages.config` и старый XML csproj не поддерживаются в SDK .NET 11                                     | высокая     |
| `System.Web`                  | Удалён полностью. У `HttpContext.Current`, модулей, обработчиков, WebForms нет эквивалента в .NET 11      | высокая     |
| Сервер WCF                    | `System.ServiceModel` на стороне сервера не поддерживается. Используйте CoreWCF или переписывайте на gRPC или HTTP | высокая |
| Клиент WCF                    | Поддерживается через NuGet-пакеты `System.ServiceModel.*` 6.x с ограниченным набором привязок            | средняя     |
| Entity Framework 6            | Работает на .NET 11 с EF6 6.5.0 или новее, но новую разработку следует вести на EF Core 11              | средняя     |
| `AppDomain`                   | Существует только домен по умолчанию. Нет `CreateDomain`, нет выгружаемых контейнеров плагинов          | высокая     |
| `BinaryFormatter`             | Удалён в .NET 9, переключателя для включения нет                                                         | высокая     |
| .NET Remoting                 | Исчез. Замены нет; переписывайте на сетевой протокол, который вам действительно нужен                    | высокая     |
| Code Access Security          | Исчез. `[SecurityCritical]`, `PermissionSet`, песочница — всё удалено                                    | высокая     |
| `web.config`                  | Конфигурация переезжает в `appsettings.json`. Секции `system.web` не применяются                         | высокая     |
| `app.config`                  | Большинство настроек по-прежнему работают через `Microsoft.Extensions.Configuration.Xml`, но перенаправлений привязок больше нет | средняя |
| WPF и WinForms                | Поддерживаются на .NET 11, только на Windows. Большинству сторонних элементов управления нужна сборка 6.x или новее | средняя |
| `System.Drawing.Common`       | Кроссплатформенная поддержка удалена в .NET 6. С тех пор только Windows                                  | средняя     |

Прочитайте [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/) и [список критических изменений .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0) хотя бы один раз перед тем, как трогать `.csproj`. Первый список значительно длиннее второго.

## Предполётный чек-лист

Выполните это до того, как измените хотя бы один файл проекта.

1. Установите SDK .NET 11 на каждой машине разработчика и на каждом раннере CI. Проверьте с помощью `dotnet --list-sdks` и убедитесь, что появляется `11.0.x`. Оставьте установленным developer pack .NET Framework 4.8, чтобы старое решение по-прежнему открывалось в Visual Studio.
2. Установите .NET Upgrade Assistant CLI и сначала запустите его в режиме анализа. Он не мигрирует код; он создаёт отчёт с конкретными действиями.
   ```bash
   # .NET 11, upgrade-assistant 0.6.x
   dotnet tool install --global upgrade-assistant
   upgrade-assistant analyze MySolution.sln
   ```
3. Запустите .NET Portability Analyzer или `apiport` против скомпилированных сборок. Всё, что помечено как "not portable", — это работа по миграции, которую инструмент upgrade-assistant за вас не сделает.
4. Зафиксируйте базовый уровень. Запустите существующий набор тестов на .NET Framework 4.8 и сохраните результат. Чистый зелёный прогон на старой среде выполнения означает, что первый красный на .NET 11 — это однозначно регрессия миграции.
5. Проведите инвентаризацию сторонних NuGet-пакетов. Всё, что поставляется только со сборками `net48` или `net472`, является блокером. Замены: `log4net` 2.0.16, `Newtonsoft.Json` 13.x, `AutoMapper` 13.x, `Dapper` 2.1.x — все они мультицелевые и работают на .NET 11. Для всего остального нужен тикет на обновление в адрес вендора.
6. Разветвите миграцию. Запланируйте как минимум один PR на проект и отдельный PR для тестовых проектов. Один мега-PR для средней кодовой базы невозможно ревьюить.

## Шаги миграции

1. **Переведите каждый `.csproj` в SDK-style.** Замените старый XML заголовком SDK-style. Новый формат определяет файлы автоматически, отказывается от большинства ссылок на сборки и использует `PackageReference` вместо `packages.config`. Инструмент `try-convert` (поставляемый вместе с .NET Upgrade Assistant) выполняет механическую часть.

   ```xml
   <!-- src/MyApi.csproj, .NET 11, after conversion -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
       <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     </ItemGroup>
   </Project>
   ```

   Проверка: `dotnet build` завершается с ошибками, называющими удалённые API, а не с ошибками парсера самого файла проекта. Удалите `packages.config` после успешной конверсии.

2. **Удалите использование `BinaryFormatter` повсеместно.** Тип был удалён в .NET 9 без переключателя совместимости. Замените его на `System.Text.Json`, MessagePack или `protobuf-net` в зависимости от того, нужен ли вам JSON или бинарный формат передачи. Если у вас есть хранимые блобы, сериализованные с помощью `BinaryFormatter`, напишите одноразовую утилиту конверсии, которая всё ещё запускается на .NET Framework 4.8, чтобы перевести их в новый формат до вывода старой среды из эксплуатации. Выполнить эту конверсию из .NET 11 невозможно.

   Проверка: `grep -r "BinaryFormatter" src/` пуст. Любое блочное хранилище, ранее содержавшее данные в бинарном формате, было пересериализовано, и новый формат проходит круговой обход в модульном тесте.

3. **Перепишите веб-стек с `System.Web` на ASP.NET Core 11.** Это самый большой кусок работы. Контроллеры MVC 5 отображаются почти один в один на контроллеры ASP.NET Core, но атрибуты маршрутизации, привязка модели, фильтры действий и внедрение зависимостей различаются. `HttpContext.Current` исчез; контроллеры и middleware получают `HttpContext` явно. `Application_Start` в `Global.asax` становится стартовым кодом в `Program.cs`. Контроллеры WebAPI 2 очень близки к контроллерам ASP.NET Core, но наследуются от `ControllerBase`, а не от `ApiController`.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddControllers();
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.UseAuthentication();
   app.UseAuthorization();
   app.MapControllers();
   app.MapOpenApi();
   app.Run();
   ```

   У WebForms (`.aspx`) нет пути миграции. Либо оставьте приложение WebForms на .NET Framework 4.8 до конца его жизни за обратным прокси, либо перепишите затронутые страницы как Blazor, MVC или Razor Pages. Сравнение [Blazor Server vs Blazor WebAssembly vs Blazor United](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) — правильная отправная точка, если Blazor рассматривается как вариант.

   Проверка: у каждого контроллера есть хотя бы один интеграционный тест, который выполняет HTTP-маршрут против `WebApplicationFactory<Program>` и проверяет как код состояния, так и тело ответа.

4. **Переместите `web.config` в `appsettings.json`.** Строки подключения, пользовательские appSettings и конфигурация журналирования переезжают в JSON. Секции `system.web` не применяются. Секции `system.webServer`, конфигурирующие IIS, всё ещё применяются, если вы хостите за IIS через in-process модуль, но большинство производственных развёртываний теперь используют Kestrel напрямую. Настройки аутентификации переезжают из секций web.config `<authentication>` и `<authorization>` в `builder.Services.AddAuthentication(...)` и API политик авторизации.

   ```json
   // appsettings.json, .NET 11
   {
     "ConnectionStrings": {
       "Default": "Server=.;Database=App;Trusted_Connection=True;TrustServerCertificate=True;"
     },
     "Logging": {
       "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" }
     }
   }
   ```

   Проверка: приложение читает каждое значение, ранее задаваемое через конфигурацию, через `IConfiguration` или через шаблон строго типизированного `IOptions<T>`; в продакшен-коде не остаётся вызовов `ConfigurationManager.AppSettings`.

5. **Разберитесь с WCF.** WCF на стороне сервера не поддерживается на .NET 11. Два реалистичных пути:
   - **CoreWCF** (порт, поддерживаемый сообществом). Добавьте `CoreWCF.Primitives`, `CoreWCF.Http` и те привязки, которые вы фактически используете. Большинство сервисов на `BasicHttpBinding` и `NetTcpBinding` мигрируют со ссылкой на контракт и вызовом конфигурации `UseServiceModel`. Потоковая передача, транзакции и безопасность на уровне сообщений имеют разную степень поддержки; сверьтесь с [матрицей совместимости CoreWCF](https://github.com/CoreWCF/CoreWCF) прежде чем брать обязательства.
   - **Переписать на gRPC или HTTP API.** Более высокий потолок, больше работы. Правильный выбор, когда интерфейс WCF потребляли только клиенты, которые вы контролируете.

   WCF на стороне клиента поддерживается через NuGet-пакеты `System.ServiceModel.*` 6.x с `BasicHttpBinding`, `NetTcpBinding` (ограниченно) и `WSHttpBinding` (только безопасность транспорта). Если ваш клиент использует `WSFederationHttpBinding` или безопасность на уровне сообщений, потребителя придётся переписывать.

   Проверка: у каждой конечной точки WCF есть контрактный тест, который запускает клиент .NET 11 против либо нового хоста CoreWCF, либо переписанной замены, и проверяет те же полезные нагрузки, что и старый клиент .NET Framework.

6. **Перейдите с Entity Framework 6 на EF Core 11 (когда это оправдано).** EF6 работает на .NET 11 через пакет `EntityFramework` 6.5.0, поэтому строгий перенос без изменений возможен. Но EF6 не получает новых возможностей, API `DbContext` в EF Core ближе к тому, что вам нужно для внедрения зависимостей ASP.NET Core, а скомпилированные запросы EF Core 11 и трансляция коллекций примитивов заметно быстрее. Для большинства команд правильный выбор — выпустить миграцию сначала на EF6, а затем перейти на EF Core в последующем PR. Статья [EF Core compiled queries vs raw SQL vs Dapper](/ru/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) количественно оценивает выигрыши на горячем пути.

   Проверка: выбранный ORM проходит тот же набор интеграционных тестов, который выполнялся под EF6 на .NET Framework, включая любые тесты, проверявшие сгенерированный SQL.

7. **Замените загрузчики плагинов на `AppDomain.CreateDomain`.** `AppDomain` больше не является границей изоляции на .NET 11; существует только домен по умолчанию. Системы плагинов, которые ранее загружали сборки в дочерний `AppDomain` ради семантики выгрузки или изоляции отказов, должны перейти на `AssemblyLoadContext` с `isCollectible: true` и вызывать `Unload()` по завершении. Внепроцессные плагины через рабочие процессы `dotnet` — более безопасный шаблон, когда плагин не доверенный.

   Проверка: модульный тест загружает сборку плагина, вызывает её код, выгружает `AssemblyLoadContext` и проверяет, что `WeakReference` на контекст становится `null` после цикла `GC.Collect()`.

8. **Проверьте обновления версии языка C#.** Переход с C# 7.3 на C# 14 — это двенадцать выпусков языка за один шаг. Большая часть изменений аддитивна и безопасна, но ссылочные типы, допускающие null (введённые в C# 8), пометят тысячи предупреждений в унаследованном коде, если глобально включить `<Nullable>enable</Nullable>`. Реалистичный путь — сначала `<Nullable>annotations</Nullable>` (только аннотации, без диагностики), затем пофайловая конверсия с помощью прагм `#nullable enable`. Изменение разрешения перегрузок в C# 14, связанное с перегрузками span, описано в статье с исправлением [C# 14 overload resolution breaking change with spans](/ru/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).

   Проверка: `dotnet build -warnaserror` проходит чисто на согласованной области nullable перед слиянием.

9. **Обновите образы раннеров CI.** Поднимите `actions/setup-dotnet` в GitHub Actions до `dotnet-version: 11.0.x`, обновите базовый образ любого Dockerfile до `mcr.microsoft.com/dotnet/sdk:11.0` и `mcr.microsoft.com/dotnet/aspnet:11.0`, и удалите старый образ MSBuild для .NET Framework. Если какой-то проект всё ещё должен собираться под .NET Framework (например, одноразовая утилита конверсии `BinaryFormatter` из шага 2), оставьте один раннер `windows-2022` с установленным developer pack .NET Framework 4.8 и привяжите его к фильтру путей.

   Проверка: прогон пайплайна на ветке фичи зелёный от начала до конца, включая `dotnet publish`, сборку образа контейнера и тестовое развёртывание в staging-окружение.

## Проверка (smoke-чеклист)

После описанных шагов приложение должно пройти каждый пункт этого списка до слияния PR с миграцией:

- `dotnet --list-sdks` показывает `11.0.x`, а `dotnet --version` из корня репозитория выводит `11.0.x`.
- `dotnet restore && dotnet build -c Release` завершается с кодом 0 без предупреждений на согласованной области nullable.
- `dotnet test -c Release` зелёный, и количество тестов совпадает (или превышает) базовый уровень на .NET Framework 4.8.
- `dotnet publish -c Release` создаёт самодостаточный артефакт, который запускается на чистом staging-хосте без установленного распространяемого пакета .NET Framework 4.8.
- У каждого HTTP-маршрута есть хотя бы один интеграционный тест против `WebApplicationFactory<Program>`.
- В журналах нет first-chance ссылок на `BinaryFormatter`, `IWebHostBuilder`, `HttpContext.Current` или `ConfigurationManager` в продакшен-путях кода.
- Staging-развёртывание обслуживает золотой путь; p50/p95 задержка находится в пределах 20 процентов от базового уровня .NET Framework на эквивалентном оборудовании.

Если что-либо из этого не проходит, остановитесь. Частичная миграция на .NET 11 хуже, чем чистое развёртывание на .NET Framework 4.8, потому что обязывает вас поддерживать обе среды выполнения.

## Откат

Миграция обратима только до тех пор, пока схема базы данных и любые форматы передачи не изменены. Сам обмен среды выполнения обратим: откатите изменения в `.csproj` и переустановите распространяемый пакет .NET Framework 4.8 на хосте. Решения, которые делают откат дорогим, обычно ортогональны:

- Новая миграция EF Core 11 была применена к продакшен-базе данных. Сначала откатите схему.
- Полезные нагрузки JSON были пересериализованы под значениями по умолчанию `System.Text.Json`, отличными от `Newtonsoft.Json`. Потребители ниже по потоку, которые сопоставляют по порядку полей или обработке null, увидят расхождения.
- Аутентификация переехала с куки `FormsAuthentication` на куки data-protection ASP.NET Core. Существующие сессии аннулируются в любом случае.

Прагматичный план — держать развёртывание .NET Framework тёплым в отдельном слоте в течение недели после переключения и закрывать переключение feature flag на балансировщике нагрузки, а не на уровне развёртывания. После этого окна — исправляйтесь движением вперёд.

## Подводные камни, на которые мы наступили

- **`HttpClient` на .NET 11 строго применяет TLS server-name indication.** Вызовы к внутренним сервисам, представляющим сертификат без соответствующего SAN, проваливаются с `AuthenticationException`. Либо исправьте сертификат, либо осознанно установите `SslOptions.RemoteCertificateValidationCallback`. Настройки по умолчанию в .NET Framework были более мягкими, и это маскировало пробел в SAN.
- **`DateTime.Parse` на .NET 11 строже относится к неоднозначным форматам, чем .NET Framework 4.8.** Код, который выполнял круговой обход `DateTime` через строку без явного `IFormatProvider`, начнёт выбрасывать `FormatException` на входе, который принимался раньше. Всегда передавайте `CultureInfo.InvariantCulture` и известный формат. Статья [JSON value could not be converted to System.DateTime fix](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) покрывает самый частый вариант, когда дата приходит через JSON.
- **`Microsoft.Data.SqlClient` заменяет `System.Data.SqlClient` в любом современном сценарии.** EF Core 11 требует `Microsoft.Data.SqlClient` 7.x или новее. Транзитивная фиксация на старом `System.Data.SqlClient` скомпилируется, но упадёт во время выполнения на согласовании TLS 1.3 с более новыми серверами SQL Server.
- **Привязка конфигурации чувствительна к регистру в JSON и нечувствительна к регистру в `app.config`.** Свойство с именем `MaxRetries` в `appsettings.json` не привяжется к ключу `maxretries`. `ConfigurationManager` из .NET Framework это не волновало.
- **`HostingEnvironment.MapPath` исчез.** Замените на `IWebHostEnvironment.ContentRootPath` и `Path.Combine`. Синтаксис виртуального пути `~/` ни одним компонентом ASP.NET Core не понимается.
- **Суррогаты datacontract WCF не выполняют круговой обход идентично через CoreWCF.** Если вы зависите от `IDataContractSurrogate`, напишите контрактный тест, который проверяет точный формат передачи до и после миграции, а не только равенство объектов.

## Похожее

- [Миграция с .NET 8 на .NET 11: полный чек-лист](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Native AOT vs ReadyToRun vs JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Minimal APIs vs контроллеры в ASP.NET Core 11](/ru/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [System.Text.Json vs Newtonsoft.Json в 2026 году](/ru/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)
- [EF Core 11 vs Dapper для массовых вставок: реальный бенчмарк](/ru/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Источники

- [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/)
- [.NET 11 breaking changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET Upgrade Assistant documentation](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
- [CoreWCF project and compatibility matrix](https://github.com/CoreWCF/CoreWCF)
- [Migrate from ASP.NET to ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/migration/proper-to-2x/)
- [AssemblyLoadContext API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.loader.assemblyloadcontext)
