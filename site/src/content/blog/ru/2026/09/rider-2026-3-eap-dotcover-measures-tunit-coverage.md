---
title: "Rider 2026.3 EAP: dotCover наконец измеряет покрытие TUnit"
description: "Early Access Program для Rider 2026.3 открылась 7 сентября 2026 года. Под разноцветными скобками спрятана строка, которая действительно меняет сборку: dotCover теперь показывает покрытие для тестов TUnit при наличии Microsoft.Testing.Platform 2.3.0 и одной ссылки на пакет."
pubDate: 2026-09-08
tags:
  - "dotnet"
  - "testing"
  - "rider"
  - "code-coverage"
  - "tooling"
lang: "ru"
translationOf: "2026/09/rider-2026-3-eap-dotcover-measures-tunit-coverage"
translatedBy: "claude"
translationDate: 2026-09-08
---

JetBrains открыла [Early Access Program для Rider 2026.3](https://blog.jetbrains.com/dotnet/2026/09/07/rider-2026-3-eap/) 7 сентября 2026 года. Заголовочные новшества те, что хорошо смотрятся на скриншоте: разноцветные скобки (по умолчанию выключены, Settings | Editor | General | Appearance), панель фильтров во всплывающем окне автодополнения и отдельная категория плагинов Game Development. Изменение, которое реально разблокирует репозиторий, находится двумя предложениями ниже: интеграция dotCover в Rider теперь измеряет покрытие для юнит-тестов, написанных на TUnit.

## Почему проекты на TUnit ничего не показывали

TUnit -- это тестовый фреймворк, изначально построенный под Microsoft.Testing.Platform. Адаптера VSTest у него нет, и в этом весь смысл: тестовый проект собирается в исполняемый файл, который владеет собственной точкой входа и говорит по протоколу MTP, вместо того чтобы работать под управлением `vstest.console`. Это тот же архитектурный сдвиг, который стоит за [переходом с VSTest на Microsoft.Testing.Platform в .NET 11](/ru/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).

Раннер покрытия dotCover внутри IDE подключался к хосту VSTest. Когда хоста VSTest в схеме нет, команда "Cover Unit Tests" на проекте TUnit либо выдавала пустой отчёт, либо отказывалась запускаться, и в JetBrains это отслеживали как [DCVR-12871](https://youtrack.jetbrains.com/projects/DCVR/issues/DCVR-12871). Командам, которым нужны были цифры, приходилось откатываться на `dotnet test --coverage` с `Microsoft.Testing.Extensions.CodeCoverage` и читать файл Cobertura. В CI это работает нормально и совершенно бесполезно, когда нужна зелёная и красная разметка на полях рядом со строкой, которую вы правите.

## Как включить

После обновления покрытие само не появится. Есть два условия, оба прямо названы в анонсе EAP.

Во-первых, тестовому проекту нужен пакет фреймворка профилировщика:

```xml
<ItemGroup>
  <PackageReference Include="TUnit" />
  <PackageReference Include="JetBrains.dotCover.Framework" />
</ItemGroup>
```

Во-вторых, минимальная версия платформы -- `Microsoft.Testing.Platform` 2.3.0 или новее. Это та же 2.3.0, которая в июле 2026 года принесла [потоковую запись TRX и аннотации GitHub Actions](/ru/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/), так что большинство репозиториев с актуальным TUnit уже выше этой планки. Проверяйте то, что реально восстановилось, а не то, что объявлено:

```bash
dotnet list package --include-transitive | grep Microsoft.Testing.Platform
```

Затем убедитесь, что Rider вообще работает через MTP: Settings | Build, Execution, Deployment | Unit Testing | Testing Platform, и поставьте галочку "Enable Test Platform support". Без неё Rider по-прежнему идёт через старый раннер, и вы снова получите пустой отчёт.

## Второе новшество, ради которого стоит рискнуть с EAP

Data breakpoints перестали быть ритуалом окна Watches. Переменную можно щёлкнуть правой кнопкой прямо в редакторе и настроить точку там же, либо создать её напрямую из окна Breakpoints, указав адрес памяти и размер области. Поддерживаются доступ на чтение и запись, условия и логирование. Для поиска поля, которое затирает другой поток, это заметно более короткий путь, чем прежний сценарий.

Сборки EAP бесплатны, пока идёт программа, и у них есть срок годности, так что относитесь к этому как к способу разблокировать покрытие TUnit-репозитория прямо сейчас, а не как к машине, с которой вы выпускаете релизы.
