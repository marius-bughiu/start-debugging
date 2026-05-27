---
title: ".NET MAUI 10 SR6 завершает Material 3 на Android за одним флагом UseMaterial3"
description: "MAUI 10 SR6 (10.0.60) расширяет тему Material 3 на Button, Entry, SearchBar, DatePicker, Slider, ProgressBar, ImageButton, Switch и Shell на Android. Подключается одним свойством MSBuild. Без кастомных рендереров, без правки styles.xml."
pubDate: 2026-05-27
tags:
  - "dotnet"
  - "maui"
  - "android"
  - "material-3"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/05/maui-10-material-3-android-usematerial3-flag"
translatedBy: "claude"
translationDate: 2026-05-27
---

Microsoft выпустила [последнюю крупную часть поддержки Material 3 для .NET MAUI на Android](https://devblogs.microsoft.com/dotnet/dotnet-maui-material-3/) в релизе .NET MAUI 10 SR6 (10.0.60), анонсированном 26 мая 2026 года. Интересно не то, что Material 3 наконец появился. Интересно то, что подключение делается ровно одним свойством MSBuild и что команда полностью убрала из уравнения кастомизацию хендлеров.

Если вы следите за мобильной историей .NET 11, сам MAUI также [переключает среду выполнения по умолчанию на CoreCLR на Android и iOS в .NET 11 Preview 4](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/). Material 3 же, это возможность .NET MAUI 10, и поставляется сегодня в рамках поддерживаемой каденции service release.

## Как был нарезан выкат

Material 3 пришёл не сразу. Возможность была распределена по трём service-релизам .NET MAUI 10:

- **SR3 (10.0.30)**: базовые стили Material 3 для нескольких контролов.
- **SR4 (10.0.40)**: тему получил `CheckBox`.
- **SR6 (10.0.60)**: крупная партия. `Button`, `Entry`, `SearchBar`, `DatePicker`, `Slider`, `ProgressBar`, `ImageButton`, `Switch` и полная тема `Shell`.

Полный поддерживаемый набор в SR6 покрывает `Entry`, `Editor`, `SearchBar`, `RadioButton`, `ProgressBar`, `Slider`, `Picker`, `TimePicker`, `DatePicker`, `CheckBox`, `Switch`, `ImageButton`, `Button`, `Label`, `ActivityIndicator`, `Image` и `Shell`.

## Подключение одним свойством

Всё подключение, это одно свойство в вашем `.csproj`:

```xml
<PropertyGroup>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

Это вся поверхность. Пересоберите, разверните на устройстве или эмуляторе Android, и поддерживаемые контролы начнут автоматически подхватывать стили Material 3. Никакой кастомизации хендлеров, никаких кастомных рендереров, никаких операций над `Resources/values/styles.xml`, никаких изменений в `MainActivity`.

Если нужно ограничить флаг только Android, используйте стандартное условие MSBuild:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-android'))">
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

## Явные стили по-прежнему побеждают

Команда оставила правило приоритета именно таким, каким вы бы и хотели. Всё, что вы задаёте явно в XAML или C#, перекрывает значения по умолчанию от Material 3:

```xml
<Button Text="Save"
        BackgroundColor="#0F62FE"
        TextColor="White" />
```

Эта кнопка сохраняет свой IBM-синий. Material 3 заполняет только там, где вы ещё не прокрашивали. Кастомные хендлеры и рендереры не затрагиваются, что важно, если у вас уже есть дизайн-система, переопределяющая конкретные контролы; включение флага не перестилизует молча те места, которые вы намеренно настроили.

## Почему это важно

Визуальный разрыв на Android, одна из самых давних претензий к MAUI. Стандартные контролы выглядели устаревшими, исправление требовало погружения в XML тем Android, а любой обходной путь для отдельного контрола имел свойство расходиться с тем, что Google выпустит в следующем релизе Material. Один флаг MSBuild, отслеживающий Material 3 на протяжении SR-релизов, это заметное сокращение поверхности сопровождения для любой команды, у которой ещё не закреплена своя дизайн-система.

Прагматичный шаг для существующего MAUI 10 приложения: подняться до 10.0.60, выставить `UseMaterial3` в `true`, запустить приложение на эмуляторе Android и пройтись по каждому экрану. Любое место, где вы ранее вручную стилизовали, чтобы скомпенсировать старые значения по умолчанию, теперь кандидат на удаление.
