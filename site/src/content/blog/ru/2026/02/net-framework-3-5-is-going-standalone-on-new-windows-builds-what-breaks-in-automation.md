---
title: ".NET Framework 3.5 становится автономным в новых сборках Windows: что ломается"
description: "Начиная с Windows 11 Build 27965, .NET Framework 3.5 больше не является дополнительным компонентом Windows. Вот что ломается в CI, провижининге и эталонных образах, и как это исправить."
pubDate: 2026-02-07
tags:
  - "dotnet"
  - "windows"
lang: "ru"
translationOf: "2026/02/net-framework-3-5-is-going-standalone-on-new-windows-builds-what-breaks-in-automation"
translatedBy: "claude"
translationDate: 2026-04-29
---
Microsoft изменила то, что многие разработчики и ИТ-специалисты автоматизировали и затем забыли: начиная с **Windows 11 Insider Preview Build 27965**, **.NET Framework 3.5 больше не включается как дополнительный компонент Windows**. Если он вам нужен, теперь его необходимо получать в виде **автономного установщика**.

Это история о .NET Framework, но она ударит по командам, создающим современные сервисы на **.NET 10** и **C# 14**, потому что боль проявляется в таких местах, как свежие машины разработчиков, эфемерные агенты CI, эталонные образы и закрытые сети.

## Ключевая деталь: "NetFx3" больше не гарантируется

Из публикации:

-   Изменение применяется к **Build 27965 и будущим платформенным релизам** Windows.
-   Оно **не затрагивает Windows 10** и более ранние релизы Windows 11 вплоть до **25H2**.
-   Оно связано с реальностью жизненного цикла: **.NET Framework 3.5 приближается к окончанию поддержки 9 января 2029 года**.

Если ваши скрипты предполагают "включи функцию, и Windows сама всё сделает", ожидайте поломок на новой линейке.

## Что должен делать ваш провижининг сейчас

Относитесь к .NET Framework 3.5 как к зависимости, которую вы явно разворачиваете и проверяете. Как минимум:

-   Определяйте версии сборки Windows, которые подвержены новому поведению.
-   Проверяйте, можно ли запросить и включить `NetFx3` на этой машине.
-   Если нет, следуйте официальному руководству по автономному установщику и заметкам о совместимости.

Вот практическая защита, которую можно добавить в провижининг агента сборки или в шаг "preflight":

```powershell
# Works on Windows PowerShell 5.1 and PowerShell 7+
$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$build = [int]$os.CurrentBuildNumber

Write-Host "Windows build: $build"

# Query feature state (if the OS exposes it this way)
dism /online /Get-FeatureInfo /FeatureName:NetFx3

if ($build -ge 27965) {
  Write-Host ".NET Framework 3.5 is obtained via standalone installer on this Windows line."
  Write-Host "Official guidance (installers + compatibility + migration paths):"
  Write-Host "https://go.microsoft.com/fwlink/?linkid=2348700"
}
```

Это ничего не устанавливает само по себе. Это делает сбой явным, ранним и легко интерпретируемым, когда образ машины тихо изменился у вас под ногами.

## "Почему", по которому стоит действовать сейчас

Даже если вы планируете мигрировать, у вас, вероятно, всё ещё есть:

-   Внутренние инструменты или приложения от поставщиков, требующие 3.5
-   Наборы тестов, которые поднимают старые утилиты
-   Клиенты с длинными циклами обновления

Так что немедленная победа - это не "остаться на 3.5". Немедленная победа - сделать вашу среду предсказуемой, пока вы движетесь к поддерживаемым целям.

Источники:

-   [Публикация в .NET Blog: .NET Framework 3.5 переходит к автономному развёртыванию](https://devblogs.microsoft.com/dotnet/dotnet-framework-3-5-moves-to-standalone-deployment-in-new-versions-of-windows/)
-   [Руководство Microsoft Learn: установщики, совместимость и миграция](https://go.microsoft.com/fwlink/?linkid=2348700)
