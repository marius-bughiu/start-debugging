---
title: "Как упаковать .NET MAUI приложение для Microsoft Store"
description: "Полное руководство по упаковке .NET MAUI 11 приложения для Windows как MSIX, объединению x64/x86/ARM64 в .msixupload и отправке через Partner Center: резервирование идентичности, Package.appxmanifest, флаги dotnet publish, объединение через MakeAppx и передача доверенного сертификата Store."
pubDate: 2026-05-04
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "windows"
  - "msix"
  - "microsoft-store"
  - "partner-center"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-package-a-maui-app-for-the-microsoft-store"
translatedBy: "claude"
translationDate: 2026-05-04
---

Краткий ответ: сначала зарезервируйте имя приложения в Partner Center, скопируйте сгенерированные значения Identity в `Platforms/Windows/Package.appxmanifest`, установите `WindowsPackageType=MSIX` и `AppxPackageSigningEnabled=true` в вашем `.csproj`, затем выполните `dotnet publish -f net10.0-windows10.0.19041.0 -c Release -p:RuntimeIdentifierOverride=win-x64` один раз на каждую архитектуру, которую хотите выпустить. Объедините полученные файлы `.msix` с помощью `MakeAppx.exe bundle` в один `.msixbundle`, оберните это в `.msixupload` (обычный zip с bundle и его symbol bundle), и загрузите его как пакет в submission Partner Center. Store повторно подписывает ваш bundle своим собственным сертификатом, так что локальный `PackageCertificateThumbprint` нужно сделать доверенным только на вашей сборочной машине.

Это руководство проходит полную пайплайн для .NET MAUI 11.0.0 на .NET 11, Windows App SDK 1.7 и потока submission Partner Center в том виде, в каком он существует в мае 2026. Всё ниже было проверено на `dotnet new maui` из .NET 11.0.100 SDK с `Microsoft.WindowsAppSDK` 1.7.250401001 и `Microsoft.Maui.Controls` 11.0.0. Различия с более ранними советами для .NET 8 и .NET 9 указаны там, где рецепт расходится.

## Почему "просто нажмите Опубликовать" перестало работать

Мастер публикации MAUI в Visual Studio поставляется с целью "Microsoft Store", но он не выпустил приемлемого для Store `.msixupload` ни в одном релизе MAUI с .NET 6. Мастер генерирует один `.msix` для одной архитектуры и на этом останавливается, что означает, что загрузки либо проваливают валидацию Partner Center напрямую (когда ваша предыдущая submission была bundle), либо тихо запирают вас в одну архитектуру на всю жизнь листинга. Команда MAUI отслеживает этот пробел как [dotnet/maui#22445](https://github.com/dotnet/maui/issues/22445) с 2024 года, и исправление не вошло в MAUI 11. CLI - это поддерживаемый путь.

Вторая причина, по которой мастер вводит в заблуждение, - это идентичность. Производимый им `.msix` подписывается тем локальным сертификатом, на который вы его указали, но submission в Store требует, чтобы элемент `Identity` вашего приложения (`Name`, `Publisher` и `Version`) точно совпадал со значениями, которые Partner Center зарезервировал для вас. Если manifest говорит `CN=DevCert`, а Partner Center ожидает `CN=4D2D9D08-...`, загрузка проваливается с обобщённым кодом ошибки в стиле 12345, который не называет проблемное поле. Зарезервировать имя сначала и вставить значения Partner Center в manifest перед сборкой - это единственный способ избежать этого цикла.

Хорошая новость: как только у вас есть правильный manifest, команды CLI стабильны между .NET 8, 9, 10 и 11. Изменилась только форма runtime identifier: `win10-x64` был выведен из эксплуатации в .NET 10 в пользу портативного `win-x64`, согласно [NETSDK1083](https://learn.microsoft.com/en-us/dotnet/core/tools/sdk-errors/netsdk1083). Всё остальное - тот же вызов `MSBuild`, который Xamarin поставлял в 2020.

## Шаг 1: Зарезервируйте имя и соберите значения идентичности

Войдите в [Partner Center](https://partner.microsoft.com/dashboard/apps-and-games/overview) и создайте новое приложение. Зарезервируйте имя. Откройте **Идентичность продукта** (или **Управление приложением > Идентичность приложения** в зависимости от версии панели, которую вы видите); вам нужны три строки:

- **Package/Identity Name**, например `12345Contoso.MyMauiApp`.
- **Package/Identity Publisher**, длинная строка `CN=...`, которую назначает Microsoft, например `CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A`.
- **Package/Publisher display name**, человекочитаемая версия, которая появляется в листинге Store.

Эти три значения должны попасть дословно в `Platforms/Windows/Package.appxmanifest`. Шаблон MAUI поставляет manifest-заглушку с `Name="maui-package-name-placeholder"`, который сборочная система обычно переписывает из вашего `.csproj`. Для сборок Store перезапишите его явно, чтобы элемент `Identity` пережил сборку.

```xml
<!-- Platforms/Windows/Package.appxmanifest, .NET MAUI 11 -->
<Identity
    Name="12345Contoso.MyMauiApp"
    Publisher="CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A"
    Version="1.0.0.0" />

<Properties>
  <DisplayName>My MAUI App</DisplayName>
  <PublisherDisplayName>Contoso</PublisherDisplayName>
  <Logo>Images\StoreLogo.png</Logo>
</Properties>
```

`Version` здесь использует четырёхчастную схему Win32 (`Major.Minor.Build.Revision`), и Partner Center рассматривает четвёртый сегмент как зарезервированный: он должен быть `0` для любой submission в Store. Если вы кодируете номера сборок CI в версию, поместите их в третий сегмент.

Пока вы в manifest, установите `<TargetDeviceFamily>` в `Windows.Desktop` с `MinVersion` равным `10.0.17763.0` (нижний предел для Windows App SDK 1.7) и `MaxVersionTested`, который соответствует тому, что вы реально протестировали. Установка `MaxVersionTested` слишком высоко заставляет Partner Center отметить submission для дополнительной сертификации; слишком низко - заставляет Windows отказывать в установке на более новых версиях ОС.

## Шаг 2: Подключите проект к сборкам MSIX

Свойства `.csproj` ниже заменяют весь совет "Настроить проект для MSIX" из документации Visual Studio. Добавьте этот блок один раз и забудьте о нём.

```xml
<!-- MyMauiApp.csproj, .NET MAUI 11.0.0 on .NET 11 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(Configuration)' == 'Release'">
  <WindowsPackageType>MSIX</WindowsPackageType>
  <AppxPackage>true</AppxPackage>
  <AppxPackageSigningEnabled>true</AppxPackageSigningEnabled>
  <GenerateAppxPackageOnBuild>true</GenerateAppxPackageOnBuild>
  <AppxAutoIncrementPackageRevision>False</AppxAutoIncrementPackageRevision>
  <AppxSymbolPackageEnabled>true</AppxSymbolPackageEnabled>
  <AppxBundle>Never</AppxBundle>
  <PackageCertificateThumbprint>AA11BB22CC33DD44EE55FF66AA77BB88CC99DD00</PackageCertificateThumbprint>
</PropertyGroup>

<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(RuntimeIdentifierOverride)' != ''">
  <RuntimeIdentifier>$(RuntimeIdentifierOverride)</RuntimeIdentifier>
</PropertyGroup>
```

Два из этих свойств не очевидны.

`AppxBundle=Never` выглядит неправильно, потому что Store хочет bundle, но сборка .NET MAUI умеет производить только один `.msix` для одной архитектуры за один вызов `dotnet publish`. Установка `AppxBundle=Always` здесь приводит к тому, что сборка пытается выполнить генерацию bundle в стиле UWP против не-UWP проекта и выдаёт загадочную ошибку `The target '_GenerateAppxPackage' does not exist in the project`, отслеживаемую в [dotnet/maui#17680](https://github.com/dotnet/maui/issues/17680). Вы собираете на каждую архитектуру и делаете bundle сами на следующем шаге.

`AppxSymbolPackageEnabled=true` производит `.appxsym` рядом с каждым `.msix`. `.msixupload`, который вы отправляете - это zip, содержимым которого является bundle плюс соседний symbol bundle, и Partner Center тихо отбрасывает аналитику сбоев, если одна из сторон отсутствует. Он не предупреждает; вы просто получаете пустые трассировки стека на панели Health шесть недель спустя.

Второй `<PropertyGroup>` - это обходной путь для [WindowsAppSDK#3337](https://github.com/microsoft/WindowsAppSDK/issues/3337), который открыт с момента переезда проекта на GitHub и не показывает признаков закрытия. Без него `dotnet publish` выбирает неявный RID до того, как target MSIX его прочитает, и получившийся пакет нацелен на архитектуру сборочного хоста, а не на ту, которую вы передали в командной строке.

`PackageCertificateThumbprint` важен только для sideload-установок. Partner Center повторно подписывает ваш bundle сертификатом, связанным с вашим аккаунтом publisher, поэтому самоподписанный сертификат подходит для submissions в Store. Сгенерируйте его командой `New-SelfSignedCertificate -Type Custom -Subject "CN=Contoso" -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")`, скопируйте отпечаток в файл проекта и доверьте сертификату в хранилище **Доверенные лица** на каких бы то ни было машинах, на которые вы делаете sideload, до того как листинг Store станет активным.

## Шаг 3: Соберите один MSIX на каждую архитектуру

Store сегодня принимает x64 и ARM64, плюс опциональную сборку x86 для длинного хвоста старых ПК. Запустите `dotnet publish` один раз на каждую архитектуру из **Developer Command Prompt for Visual Studio**, чтобы инструменты Windows SDK были в `PATH`.

```powershell
# .NET MAUI 11.0.0 on .NET 11, Windows App SDK 1.7
$tfm = "net10.0-windows10.0.19041.0"
$project = "src\MyMauiApp\MyMauiApp.csproj"

foreach ($rid in @("win-x64", "win-x86", "win-arm64")) {
    dotnet publish $project `
        -f $tfm `
        -c Release `
        -p:RuntimeIdentifierOverride=$rid
}
```

После того как все три запуска завершатся, пакеты по архитектурам окажутся по адресам:

```
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x64.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x86\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x86.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-arm64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_arm64.msix
```

Каждая папка также содержит symbol bundle `.appxsym`. Скопируйте все шесть артефактов в плоскую staging-папку, чтобы шаг bundling мог работать с одним каталогом.

```powershell
$staging = "artifacts\msix"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem -Recurse -Include *.msix, *.appxsym `
    -Path "src\MyMauiApp\bin\Release\$tfm" |
    Copy-Item -Destination $staging
```

Ваш журнал `dotnet build` сообщит `package version 1.0.0.0` для каждой архитектуры. Они должны совпадать в точности, иначе `MakeAppx.exe bundle` отклонит входной набор с `error 0x80080204: The package family is invalid`.

## Шаг 4: Объедините архитектуры в `.msixbundle`

`MakeAppx.exe` поставляется с Windows 11 SDK по адресу `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe`. Более новые версии SDK устанавливаются параллельно; выбирайте ту, которая соответствует вашему `MaxVersionTested`.

```powershell
$makeappx = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe"
$version = "1.0.0.0"

& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle"
```

Ключ `/d` говорит `MakeAppx` поглотить каждый `.msix` в папке и произвести толстый bundle, чья карта архитектур покрывает все три. Значение `/bv` (версия bundle) должно равняться `Version` в `Package.appxmanifest`; несоответствия вызывают отклонение submission Partner Center с `package version mismatch`.

Запустите второй проход для объединения файлов символов:

```powershell
& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle"
```

`MakeAppx` определяет расширение файла из входного набора и пропускает файлы `.msix` при объединении символов. Если вы забудете symbol bundle, загрузка всё равно пройдёт успешно, но Health Reports останется пустым.

## Шаг 5: Оберните как `.msixupload`

`.msixupload` - это просто zip с конкретным расширением. Partner Center автоматически обнаруживает файлы соседнего bundle и symbol bundle внутри него.

```powershell
$upload = "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixupload"

Compress-Archive `
    -Path "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle", `
          "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle" `
    -DestinationPath ($upload -replace '\.msixupload$', '.zip') -Force

Move-Item -Force ($upload -replace '\.msixupload$', '.zip') $upload
```

PowerShell 5.1 отказывается напрямую записывать расширение, отличное от `.zip`, через `Compress-Archive`, поэтому сниппет сначала пишет `.zip` и переименовывает. PowerShell 7.4+ принимает расширение напрямую.

## Шаг 6: Загрузите через Partner Center

Откройте зарезервированное приложение в Partner Center, нажмите **Начать вашу submission**, перейдите к разделу **Пакеты** и сбросьте `.msixupload`. Partner Center валидирует пакет на месте и выводит проблемы в трёх категориях:

- **Несоответствие идентичности.** `Identity Name` или `Publisher` в вашем manifest не совпадает со значениями, которые зарезервировал Partner Center. Откройте страницу **Идентичность продукта** панели рядом с `Package.appxmanifest`, исправьте manifest, пересоберите, перезапакуйте и перезагрузите. Не редактируйте zip `.msixupload` напрямую; bundle подписан, и цикл распаковать-отредактировать-перезапаковать аннулирует подпись.
- **Capabilities.** Любая `<Capability>`, которую вы декларируете, отображается на категорию Store, которая может потребовать дополнительной сертификации. `runFullTrust` (которое MAUI устанавливает неявно, потому что Win32 desktop приложениям оно нужно) одобрено для нормальных аккаунтов Store; `extendedExecutionUnconstrained` и аналогичные capabilities проходят дополнительную проверку.
- **Минимальная версия.** Если `MinVersion` в `<TargetDeviceFamily>` старше самой низкой версии Windows, которую Store сейчас поддерживает (10.0.17763.0 на май 2026), пакет отклоняется. Исправление - поднять её в manifest, а не понижать SDK.

Как только валидация проходит, заполните метаданные листинга, возрастной рейтинг и цену так же, как для любого другого приложения Store. Первая проверка обычно завершается за 24-48 часов; обновления для существующих приложений обычно проходят менее чем за 12.

## Пять подводных камней, которые съедят вечер

**1. Первая submission решает bundle против одного MSIX навсегда.** Если вы когда-либо загрузили один `.msix` для листинга, каждая будущая submission также должна быть одним `.msix`; вы не можете повысить существующий листинг до bundle, и вы не можете понизить bundle до одного `.msix`. Решите заранее и придерживайтесь bundles, даже если сегодня вы выпускаете только одну архитектуру.

**2. `Package Family Name` в Partner Center - это не то же самое, что `Identity Name`.** PFN - это `Identity.Name + "_" + первые 13 символов хеша Publisher`, и Windows выводит его автоматически. Если вы скопируете PFN в `Identity.Name` manifest, загрузка проваливается с вводящей в заблуждение ошибкой "package identity does not match", задокументированной в [dotnet/maui#32801](https://github.com/dotnet/maui/issues/32801).

**3. Windows App SDK - это framework-зависимость, а не redistributable, который вы поставляете.** Store устанавливает соответствующий пакет `Microsoft.WindowsAppRuntime.1.7` автоматически, пока вы используете framework-зависимую ссылку `WindowsAppSDK` из шаблона MAUI. Если вы переключитесь на self-contained, получившийся MSIX будет на 80MB больше, и Partner Center отклонит его за превышение бюджета размера на архитектуру в бесплатном уровне Store.

**4. Имена проектов с подчёркиваниями ломают MakeAppx.** `.csproj` с именем `My_App.csproj` производит пакеты, чьи имена файлов содержат подчёркивания в позициях, где `MakeAppx bundle` интерпретирует их как разделители версии, что проваливается с `error 0x80080204`. Переименуйте проект, чтобы использовать дефисы, или добавьте `<AssemblyName>MyApp</AssemblyName>`, чтобы переопределить имя вывода. Это отслеживается в [dotnet/maui#26486](https://github.com/dotnet/maui/issues/26486).

**5. Суффикс `Test` реален.** Папка `AppPackages\MyMauiApp_1.0.0.0_Test` называется так, потому что `dotnet publish` по умолчанию производит тестовые сертификаты. `.msix` внутри папки подходит для Store; вводит в заблуждение только имя папки. Скопируйте `.msix`, игнорируйте каталог `_Test` и двигайтесь дальше.

## Где это вписывается в CI пайплайн

Ничто в этом пайплайне не требует Visual Studio. Чистый раннер GitHub Actions `windows-latest` с .NET 11 SDK и установленным MAUI workload производит тот же `.msixupload` из этих команд. Единственный чувствительный материал - это отпечаток сертификата подписи и PFX, оба помещаются в секреты репозитория. После загрузки [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) позволяет вам толкнуть тот же артефакт прямо в черновую submission, не касаясь панели, что замыкает цикл полностью автоматизированного релиза.

Если вы вычищаете мобильные target frameworks из того же проекта, чтобы сборка Windows не тащила также workloads Android и iOS, [настройка MAUI 11 только для Windows и macOS](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) покрывает переписывания `<TargetFrameworks>`, которые вам нужны до того, как любая из команд publish выше сработает чисто. Для стороны Manifest Designer `Package.appxmanifest` и небольшого набора настроек темы, которые читает Store, [правильная поддержка тёмной темы в MAUI приложении](/ru/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) проходит через ключи ресурсов, которые появляются в генераторе скриншотов листинга. Если ваш листинг Store демонстрирует страницу Maps, [walkthrough кластеризации pin-карт MAUI 11](/2026/04/dotnet-maui-11-map-pin-clustering/) покрывает capability `MapsKey`, которую вам нужно декларировать в manifest до того, как команда сертификации одобрит приложение. И для более широкого тура того, что нового во фреймворке, который поставляется в вашем bundle, [что нового в .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) - это самое близкое к опоре release-notes, что есть в документации.

## Ссылки на источники

- [Use the CLI to publish packaged apps for Windows - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/publish-cli?view=net-maui-10.0)
- [Publish a .NET MAUI app for Windows (overview)](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/overview?view=net-maui-10.0)
- [App manifest schema reference](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/root-elements)
- [Create a certificate for package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)
- [MakeAppx.exe tool reference](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [WindowsAppSDK Issue #3337 - RID workaround](https://github.com/microsoft/WindowsAppSDK/issues/3337)
- [dotnet/maui Issue #22445 - .msixupload missing](https://github.com/dotnet/maui/issues/22445)
- [dotnet/maui Issue #32801 - package identity mismatch](https://github.com/dotnet/maui/issues/32801)
