---
title: "Исправление: восстановление NuGet в Azure DevOps завершается ошибкой \"Unable to find version 'x.y.z' of package\" для внутреннего фида"
description: "Версия существует, но пайплайн её не видит. Проверьте роль удостоверения сборки на фиде, представление фида в URL, какой nuget.config использует задача, сопоставление источников пакетов и 30-минутный HTTP-кеш."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "nuget"
  - "azure-devops"
  - "dotnet"
  - "dotnet-10"
  - "ci-cd"
lang: "ru"
translationOf: "2026/10/fix-azure-devops-nuget-restore-unable-to-find-version-of-package-from-an-internal-feed"
translatedBy: "claude"
translationDate: 2026-10-29
---

Решение: если в фиде Azure Artifacts пакет есть, а восстановление в пайплайне сообщает, что не может найти версию, то сборка почти всегда обращается не к тому фиду, который вы имеете в виду, либо обращается от имени удостоверения, которое не видит эту версию. Проверьте по порядку: есть ли у удостоверения сборки пайплайна роль **Feed and Upstream Reader (Collaborator)** на фиде? (Обычная роль **Feed Reader** не может получить версию из вышестоящего источника, такого как NuGet.org, если она ещё не сохранена в фиде.) Указывает ли URL фида на представление вроде `@Release`, в которое версия никогда не продвигалась? Использует ли задача восстановления `nuget.config` из вашего репозитория или сгенерированный? Не направляет ли `packageSourceMapping` идентификатор пакета в другой источник? И наконец, не отдаёт ли самостоятельно размещённый агент устаревший список версий из 30-минутного HTTP-кеша NuGet?

Всё ниже проверено на .NET 10 SDK (10.0.302, NuGet 7.6.0) и актуальных задачах Azure DevOps Services (`NuGetAuthenticate@1`, `DotNetCoreCLI@2`, `NuGetCommand@2`) по состоянию на октябрь 2026 года. Те же причины применимы к .NET 8, 9 и предварительным версиям .NET 11, потому что ошибка исходит от механизма разрешения версий NuGet и модели разрешений фида, а не от версии SDK.

Ошибка выглядит по-разному в зависимости от того, какой клиент выполняет восстановление. `nuget.exe restore` для проекта с `packages.config` выводит более старое сообщение:

```text
// nuget.exe 6.x/7.x, packages.config restore
Unable to find version '1.5.0' of package 'Contoso.Core'.
  https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json: Package 'Contoso.Core.1.5.0' is not found on source 'https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json'.
```

`dotnet restore`, `msbuild -t:restore` и `nuget.exe` для проектов с PackageReference выводят `NU1102`, и эта версия гораздо полезнее, потому что показывает, что на самом деле вернул каждый источник:

```text
// dotnet restore, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Внимательно прочитайте вторую строку. "Found 1 version(s)" означает, что аутентификация сработала и идентификатор пакета найден. Фид просто не вернул `1.5.0` этому вызывающему. Это сужает проблему до вопроса "какие версии это удостоверение видит через этот URL", и именно этим управляют причины ниже.

## Почему версия есть в браузере, но нет в пайплайне

Когда вы открываете фид в веб-интерфейсе Azure DevOps, вы смотрите на него от своего имени (часто как Feed Owner), через представление `@Local` по умолчанию, при включённых всех вышестоящих источниках. Пайплайн видит фид как другой субъект, возможно через другой URL и с `nuget.config`, который вы не писали. Любая из этих причин может скрыть версию:

1. **Версиям из вышестоящих источников нужна роль, позволяющая их сохранять.** Azure Artifacts отдаёт пакет из вышестоящего источника (NuGet.org, другой фид), сохраняя копию в вашем фиде при первом запросе. Согласно [таблице разрешений фида](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions), действие "Save packages from upstream sources" требует роль **Feed and Upstream Reader (Collaborator)** или выше. Удостоверение сборки с ролью только **Feed Reader** может восстанавливать уже сохранённые версии, но не новые. Ваш ноутбук без проблем восстановил `1.5.0` на прошлой неделе, потому что вы Collaborator и ваше восстановление сохранило эту версию; следующая версия, которую ещё никто не восстанавливал, в CI завершится ошибкой.
2. **Не то удостоверение сборки.** Пайплайн работает либо от `Project Collection Build Service (<org>)`, либо от `<Project> Build Service (<org>)`. Какое именно, зависит от настройки "Limit job authorization scope to current project". Выдача роли другому удостоверению ничего не даст.
3. **URL с представлением.** `.../_packaging/contoso-internal@Release/nuget/v3/index.json` показывает только версии, продвинутые в `@Release`. Свежеопубликованная `1.5.0` находится в `@Local`, пока кто-нибудь не продвинет её.
4. **Задача проигнорировала ваш `nuget.config`.** `DotNetCoreCLI@2` и `NuGetCommand@2` с `feedsToUse: 'select'` генерируют временную конфигурацию, содержащую только фид, выбранный в `vstsFeed` (и NuGet.org, если `includeNuGetOrg` равен true).
5. **Сопоставление источников пакетов** направляет `Contoso.*` в один источник, а нужная вам версия лежит в другом. Тогда NuGet сообщает, что версии из другого источника "were not considered".
6. **Устаревший HTTP-кеш.** На самостоятельно размещённом агенте NuGet повторно использует кешированный список версий пакета до 30 минут, поэтому версия, опубликованная пять минут назад, невидима для следующего запуска.
7. **Задержка вышестоящего источника или заблокированная внешняя версия.** Пакетам с NuGet.org может потребоваться от 3 до 6 часов, чтобы появиться через вышестоящий источник, а для идентификатора пакета, который вы тоже публикуете внутри, внешние версии могут быть заблокированы.

## Минимальное воспроизведение: тот же NU1102 из локального фида в папке

Для того чтобы увидеть, как NuGet ведёт себя, когда источник возвращает меньше версий, чем вы запросили, Azure DevOps не нужен. Это воспроизведение локально имитирует причины 1 и 3 с помощью источника, который "показывает" вызывающему только `1.4.0`.

```bash
# .NET SDK 10.0.302, macOS/Linux shell
mkdir -p feed lib app
cd lib && dotnet new classlib -n Contoso.Core -o . -f net10.0
dotnet pack -c Release -p:Version=1.4.0 -o ../feed
cd ../app && dotnet new console -f net10.0
dotnet add package Contoso.Core --version 1.5.0 --no-restore
```

```xml
<!-- app/nuget.config, NuGet 7.6 -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="contoso-internal" value="../feed" />
  </packageSources>
</configuration>
```

```text
// dotnet restore output, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Это в точности та форма, которую вы получаете от Azure Artifacts, когда удостоверение сборки не может сохранить `1.5.0` из вышестоящего источника или когда URL указывает на представление, где есть только `1.4.0`. Восстановление не сломано. Оно честно сообщает то, что ему вернул источник.

## Исправление 1: выдайте нужному удостоверению сборки роль Collaborator

Это причина большинства сообщений вида "у меня на машине работает": разработчики обычно имеют роль Collaborator или выше, а у удостоверения сборки в старых фидах часто только Reader.

1. Выясните, от имени какого удостоверения работает пайплайн. В **Project settings > Pipelines > Settings** проверьте **Limit job authorization scope to current project for non-release pipelines**. Если настройка включена, удостоверение - `<Project> Build Service (<org>)`. Если выключена, это `Project Collection Build Service (<org>)`. У релизных пайплайнов есть собственный переключатель на той же странице.
2. Откройте **Artifacts**, выберите фид, нажмите значок шестерёнки **Feed settings**, затем **Permissions**.
3. Добавьте это удостоверение (найдите его по запросу "Build Service") с ролью **Feed and Upstream Reader (Collaborator)**. Если пайплайн ещё и публикует пакеты, выдайте обоим удостоверениям сборки роль **Feed Publisher (Contributor)**, как рекомендует документация.
4. Если фид находится в другом проекте, чем пайплайн, и вы используете удостоверение уровня проекта, то этот другой проект тоже должен выдать удостоверению как минимум **Edit project-level information**, согласно примечанию в конце раздела [Manage permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions#pipelines-permissions).

В Azure DevOps Services новые фиды уже выдают обоим удостоверениям сборки роль Collaborator. Ломаются фиды, созданные до появления этого значения по умолчанию, фиды, созданные в Azure DevOps Server 2022 (где её получает только удостоверение коллекции), и фиды, у которых кто-то "ужесточил" разрешения.

Затем убедитесь, что пайплайн вообще аутентифицируется. В .NET CLI поддерживаемый способ - `NuGetAuthenticate@1`, а на размещённых образах Ubuntu 24.04 и новее он обязателен, потому что `nuget.exe` там больше не поддерживается:

```yaml
# Azure Pipelines YAML, .NET SDK 10.0.302, NuGetAuthenticate@1
steps:
- task: UseDotNet@2
  inputs:
    packageType: sdk
    version: '10.0.x'

- task: NuGetAuthenticate@1

- script: dotnet restore MySolution.sln --configfile nuget.config
  displayName: Restore
```

`NuGetAuthenticate@1` устанавливает поставщик учётных данных Azure Artifacts и передаёт ему токен доступа задания для каждого фида Azure Artifacts в той же организации. Для фида в другой организации создайте PAT с правом **Packaging > Read**, оберните его в сервисное подключение NuGet и передайте через `nuGetServiceConnections`, как показано в [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore).

## Исправление 2: укажите представление, в котором действительно есть версия

Посмотрите на URL фида в вашем `nuget.config`. Всё, что идёт после `@` в сегменте фида, - это представление:

```xml
<!-- nuget.config, NuGet 7.6: the @Release view only sees promoted versions -->
<add key="contoso-internal"
     value="https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal@Release/nuget/v3/index.json" />
```

Каждый фид начинается с `@Local`, `@Prerelease` и `@Release`. `@Local` содержит всё, что опубликовано в фиде, плюс всё, что сохранено из вышестоящих источников. `@Prerelease` и `@Release` содержат только то, что Feed Publisher явно продвинул. Либо продвиньте версию (откройте пакет, выберите **Promote**, укажите представление), либо пусть публикующий пайплайн продвигает её последним шагом. Если потребляющая сборка должна видеть непродвинутые версии, уберите суффикс `@Release`, чтобы использовалось представление фида по умолчанию.

То же самое относится к случаю, когда нужная версия приходит через вышестоящий источник типа "фид к фиду". Определение вышестоящего источника называет представление другого фида, поэтому версия, не продвинутая там, невидима и через ваш фид.

## Исправление 3: не давайте задаче заменять ваш nuget.config

Этот YAML выглядит безобидно, но отбрасывает `nuget.config` из вашего репозитория:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2: generates a temporary nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: select
    vstsFeed: 'contoso-internal'
    includeNuGetOrg: false
```

При `feedsToUse: select` задача записывает временную конфигурацию только с `vstsFeed` (и NuGet.org, если `includeNuGetOrg: true`). Если в вашем `nuget.config` перечислены два фида, или используется URL фида уровня проекта с сегментом проекта, или есть `packageSourceMapping`, ничего из этого не применяется к данному восстановлению. Укажите задаче использовать ваш файл:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2 with the repo's nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: config
    nugetConfigPath: 'nuget.config'
```

Или вовсе откажитесь от задачи восстановления и запустите `dotnet restore --configfile nuget.config` после `NuGetAuthenticate@1`, как в исправлении 1. Преимущество в том, что CI запускает ровно то же, что разработчик запускает локально.

Пока вы в этом файле, следуйте собственному совету Microsoft для фидов с вышестоящими источниками: начните `<packageSources>` с `<clear />` и перечислите ровно один фид Azure Artifacts с включёнными вышестоящими источниками. NuGet опрашивает все источники параллельно и берёт первый ответ, поэтому два источника делают восстановление недетерминированным. Один фид с вышестоящими источниками ищет в фиксированном порядке: пакеты, опубликованные в фиде, затем пакеты, сохранённые из вышестоящих источников, затем каждый вышестоящий источник в настроенном порядке.

## Исправление 4: проверьте сопоставление источников пакетов

Если в репозитории используется [сопоставление источников пакетов](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping), ошибка сообщает об этом прямо:

```text
// dotnet restore output, .NET SDK 10.0.302, with packageSourceMapping
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
error NU1102:   - Versions from contoso-release were not considered
```

"Were not considered" означает, что версия вполне может лежать в `contoso-release`, но ни один шаблон сопоставления не направляет `Contoso.Core` туда. Каждый идентификатор пакета разрешается только по тем источникам, чьи шаблоны ему соответствуют, и побеждает наиболее специфичный шаблон. Исправьте сопоставление:

```xml
<!-- nuget.config, NuGet 7.6 -->
<packageSourceMapping>
  <packageSource key="contoso-internal">
    <package pattern="Contoso.*" />
    <package pattern="*" />
  </packageSource>
</packageSourceMapping>
```

Когда есть один фид с включёнными вышестоящими источниками, самое простое корректное сопоставление - `*` на этот фид. Сопоставление имеет смысл только тогда, когда вы действительно держите два источника, и тогда нужно перечислить каждый внутренний префикс.

## Исправление 5: обойдите HTTP-кеш на самостоятельно размещённых агентах

Размещённые агенты стартуют с пустым кешем, поэтому это затрагивает только самостоятельно размещённые агенты и машины разработчиков. [HTTP-кеш](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders#http-cache) NuGet хранит список версий, который вернул каждый источник, и записи младше 30 минут используются повторно. Опубликуйте `1.5.0`, запустите потребляющую сборку через три минуты на том же агенте, и восстановление всё равно увидит кешированный список, заканчивающийся на `1.4.0`.

```bash
# .NET SDK 10.0.302
dotnet restore --no-http-cache
# or, for packages.config projects with nuget.exe
nuget restore MySolution.sln -NoHttpCache
# or clear it once
dotnet nuget locals http-cache --clear
```

`--no-http-cache` достаточно дёшев, чтобы оставить его включённым в CI на шаге, который восстанавливает только что опубликованные внутренние пакеты. Не прибегайте к `dotnet nuget locals all --clear` на общем агенте: очистка `global-packages` заставит все остальные пайплайны на этой машине заново скачивать всё.

## Исправление 6: дождитесь вышестоящего источника или разрешите внешние версии

Два поведения на стороне фида дают тот же симптом "nearest version" для пакетов, которые происходят с NuGet.org:

- **Задержка распространения.** В [документации по вышестоящим источникам](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) указано, что между публикацией в NuGet.org и доступностью версии через вышестоящий источник обычно проходит от 3 до 6 часов. Между фидами Azure Artifacts это обычно несколько минут. Если зависимость, выпущенная сегодня утром, не восстанавливается, а версия недельной давности восстанавливается, подождите или зафиксируйте предыдущую версию на несколько часов.
- **Заблокированные внешние версии.** Если вы публикуете внутри идентификатор пакета, который существует и публично, Azure Artifacts может блокировать сохранение новых публичных версий этого идентификатора для защиты от подмены зависимостей. Feed Owner может разрешить их для отдельного пакета через **Allow externally-sourced versions** на странице пакета или через REST-вызов `versionsFromExternalUpstreams: AllowExternalVersions`, описанный в [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior). Дайте до 3 часов на распространение этого изменения.

Также проверьте **Feed settings > Upstream sources** на статус неудачной синхронизации. Сломанный вышестоящий источник останавливает обновление метаданных для всех пакетов этого протокола, поэтому новые версии перестают появляться даже из исправных вышестоящих источников.

## Подводные камни, которые похожи на эту ошибку, но ею не являются

**`NU1101: Unable to find package Contoso.Core. No packages exist with this id in source(s)`.** Это другая ситуация: идентификатор не найден вообще. Обычно неверен источник, либо фид привязан к проекту и в URL нет сегмента проекта (`https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/nuget/v3/index.json`), либо сопоставление источников пакетов исключает все источники для этого идентификатора.

**`NU1301: Unable to load the service index for source` или `401 Unauthorized`.** Аутентификация не удалась до начала разрешения версий. Добавьте `NuGetAuthenticate@1` и проверьте, что в `nuget.config` репозитория нигде не прописан `<packageSourceCredentials>` с истёкшим PAT, поскольку он переопределяет поставщик учётных данных.

**`403 Forbidden ... lacks permission to complete this action`.** Удостоверение дошло до фида, но у него вообще нет роли на нём. Исправление то же, что в исправлении 1, плюс проверка области авторизации задания.

**Версия восстанавливается в одном пайплайне и не восстанавливается в другом.** Разные пайплайны могут работать от разных удостоверений: у классических релизных пайплайнов свой переключатель области, а YAML-пайплайны, запущенные из другого проекта, работают от службы сборки того проекта.

**Версии при централизованном управлении пакетами.** С `Directory.Packages.props` версия в ошибке берётся из центрального файла, а не из `.csproj`, поэтому "исправление" файла проекта ничего не даёт. Если вы в процессе миграции, в руководстве по [переходу решения на централизованное управление пакетами](/ru/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) описано, откуда разрешается каждая версия.

**Пакет, исчезнувший после обновления SDK.** Если транзитивный пакет пропал, а не просто не разрешился, его могла убрать [обрезка пакетов NuGet в .NET 10](/ru/2026/05/nuget-package-pruning-default-net-10/), что является ожидаемым поведением, а не проблемой фида.

**Проблемы на стороне публикации.** Если версии в фиде действительно нет, публикация со стороны производителя не удалась или была отклонена. Версионирование с MinVer и настройка trusted publishing из статьи о [независимом выпуске нескольких пакетов NuGet](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) позволяют легко увидеть, какую версию создал каждый тег. О мерах безопасности на стороне NuGet.org, которые тоже блокируют публикацию, см. [что стоит закрыть в вашей учётной записи NuGet](/ru/2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10/).

## Чек-лист, который находит причину за пять минут

1. Прочитайте полный вывод `NU1102`. "Found N version(s)" означает, что аутентификация работает, а проблема в видимости. "Were not considered" означает сопоставление источников пакетов.
2. Скопируйте URL фида из журнала восстановления, а не из вашего локального `nuget.config`. Если задача сгенерировала временную конфигурацию, журнал показывает её путь; переключитесь на `feedsToUse: config`.
3. Поищите `@` в этом URL. Если есть представление, проверьте, продвинута ли в него версия.
4. Найдите версию на странице пакета в фиде. Если её там нет, но она существует на NuGet.org или в вышестоящем фиде, значит, она никогда не сохранялась: выдайте удостоверению сборки роль Collaborator или один раз восстановите её как Collaborator, чтобы сохранить.
5. Подтвердите, какое удостоверение сборки запускает задание, через настройку области авторизации задания, и проверьте именно это удостоверение на странице Permissions фида.
6. На самостоятельно размещённом агенте перезапустите с `--no-http-cache`.
7. Для пакета, выпущенного на NuGet.org сегодня, проверьте статус вышестоящего источника и настройку внешних версий пакета, затем подождите.

В девяти случаях из десяти ответ - шаг 4 или 5. Фид не лжёт, и NuGet не сломан; пайплайн просто другой читатель, чем вы.

## Источники

- [Manage permissions - Azure Artifacts](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions) (роли фида, имена удостоверений сборки, примечание о нескольких проектах)
- [What are upstream sources?](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) (порядок поиска, совет про единственный фид, задержка 3-6 часов)
- [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) (Allow external versions)
- [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) (`NuGetAuthenticate@1`, примечание про Ubuntu 24.04, фиды в других организациях)
- [Feed views](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/views)
- [NuGet Error NU1102](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1102)
- [Package Source Mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping)
- [Managing the global packages, cache, and temp folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) (30-минутный HTTP-кеш)
- [NuGet.Client Strings.resx](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.PackageManagement/Strings.resx) (сообщения `UnknownPackageSpecificVersion` и `PackageNotFoundOnSource`)
