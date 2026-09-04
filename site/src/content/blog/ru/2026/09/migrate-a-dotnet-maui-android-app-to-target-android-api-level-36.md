---
title: "Переводим приложение .NET MAUI для Android на целевой уровень API 36"
description: "Google Play требует целевой уровень API 36 с 2026-08-31, продления действуют до 2026-11-01. Полный путь .NET MAUI от net9.0-android до API 36: смена target framework, жёстко прописанный uses-sdk, который молча удерживает старый уровень, режим edge-to-edge без возможности отказа, предиктивный жест назад и правила для больших экранов."
pubDate: 2026-09-04
updatedDate: 2026-09-04
template: migration
tags:
  - "migration"
  - "maui"
  - "android"
  - "google-play"
  - "dotnet-10"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36"
translatedBy: "claude"
translationDate: 2026-09-04
---

Изменение в сборке занимает одну строку. Миграция состоит из изменений поведения. Google Play начал требовать целевой уровень API 36 для новых приложений и обновлений с 2026-08-31, с продлением по каждому приложению через Play Console до 2026-11-01, так что если на этой неделе ваше обновление отклонили, причина в этом. В приложении .NET MAUI целевой уровень API не является настройкой манифеста, которую вы правите: он выводится из версии платформы Android в вашем `TargetFramework`, а .NET 9 доходит максимум до API 35. Значит, это обновление .NET SDK до .NET 10 (или .NET 11), а не правка манифеста. Заложите день на небольшое приложение и спринт на любое, где есть фиксированная ориентация, собственная кнопка назад или вручную подобранные отступы. Это руководство ориентируется на .NET 10 с .NET MAUI 10.0.100 (выпуск 2026-08-20) как на конечную точку и отмечает, чем отличается .NET 11.

## Почему Play проверяет именно целевой уровень

- **Пропуском служит `targetSdkVersion`, а не `compileSdk` и не `minSdk`.** Play читает `android:targetSdkVersion` из объединённого манифеста внутри вашего AAB. Одной только компиляции против платформы API 36 недостаточно.
- **Установленные копии не удаляются, отсекаются новые пользователи.** Согласно [политике целевого уровня API в Play Console](https://support.google.com/googleplay/android-developer/answer/11926878), приложения ниже порога остаются на устройствах, где они уже стоят, но перестают быть доступными новым пользователям на версиях Android новее целевого уровня приложения. Воронка установок деградирует тихо, а не ломается заметно.
- **Порог каждого года равен релизу прошлого года.** API 36 это Android 16. Требованием 2027 года станет API 37 (Android 17), который .NET for Android уже поставляет как стабильный, так что проделанная сейчас работа будет повторяться раз в год всегда.

## Что ломается

| Область | Изменение при целевом API 36 | Серьёзность |
| --- | --- | --- |
| Edge-to-edge | `windowOptOutEdgeToEdgeEnforcement` объявлен устаревшим и игнорируется на устройствах с Android 16 | высокая |
| Безопасные области .NET MAUI | `ContentPage.SafeAreaEdges` по умолчанию равен `None` начиная с .NET 10, поэтому страницы идут от края до края | высокая |
| Предиктивный жест назад | Анимации возврата на домашний экран и между активностями включены по умолчанию; `OnBackPressed` не вызывается | высокая |
| Большие экраны | `android:screenOrientation`, `resizableActivity`, `minAspectRatio` и `maxAspectRatio` игнорируются начиная с `sw600dp` | высокая (планшеты, складные устройства) |
| .NET SDK | Для API 36 нужен `net10.0-android` или новее; рабочая нагрузка .NET 9 останавливается на API 35 | высокая |
| Минимальный API | .NET 11 поднимает нижнюю границу с API 21 до API 24 | средняя (только .NET 11) |
| Отрисовка текста | `android:elegantTextHeight` объявлен устаревшим и игнорируется | низкая |
| Планирование задач | `ScheduledExecutorService.scheduleAtFixedRate` навёрстывает не более одного пропущенного запуска | низкая |
| Датчики здоровья | `BODY_SENSORS` заменён гранулярными разрешениями `android.permissions.health` | низкая (если вы не читаете пульс) |

Первые две строки складываются. Переход на .NET 10 ради API 36 в том же коммите меняет и собственное значение безопасных областей .NET MAUI по умолчанию, поэтому приложение, которое нормально выглядело на .NET 9 с целевым уровнем 35, может выйти из миграции с заголовком под строкой состояния сразу по двум независимым причинам.

## Подготовительный список

- Установлен .NET 10 SDK, восстановлена рабочая нагрузка `maui-android`: `dotnet workload install maui-android`.
- Платформа Android SDK для API 36 реально присутствует на машине сборки и в CI. Её отсутствие даёт [XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207), а не предупреждение.
- Физическое устройство или образ эмулятора с Android 16. Эти изменения поведения зависят и от версии системы, и от вашего целевого уровня, так что эмулятор с Android 14 скроет их все до единого.
- Снимки текущего интерфейса на телефоне и планшете, до того как вы что-то поменяете. Они понадобятся, чтобы оценить регрессии по отступам.
- Уже решённый вопрос с размером страницы 16 КБ, поскольку это отдельное требование Play со своим режимом отказа. См. [почему Google Play отклоняет приложение Flutter или MAUI из-за размера страницы 16 КБ](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Шаги миграции

1. **Выясните, какой уровень у вас на самом деле сейчас.** Читайте не csproj, а объединённый манифест, который выдаёт сборка:

   ```bash
   dotnet build -f net9.0-android -c Release
   grep -o 'targetSdkVersion="[0-9.]*"' obj/Release/net9.0-android/AndroidManifest.xml
   ```

   **Проверка:** вы получаете одно число. Если оно меньше версии платформы Android в вашем `TargetFramework`, значит его что-то фиксирует, и шаг 3 для вас важнее всего.

2. **Переведите target framework на .NET 10.** Версия платформы Android в TFM и становится `targetSdkVersion`, так что эта единственная правка и есть миграция:

   ```xml
   <!-- .csproj, .NET 10, .NET MAUI 10.0.100 -->
   <PropertyGroup>
     <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   Голый `net10.0-android` разрешается в API 36, что является [документированным значением по умолчанию для .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10). Зафиксируйте явно как `net10.0-android36.0`, если хотите, чтобы сборка падала, а не уезжала при последующем переходе на .NET 11, потому что .NET for Android перевёл API 37 в стабильные в .NET 11 Preview 5 и теперь проекты .NET 11 по умолчанию нацелены на `net11.0-android37`. `$(SupportedOSPlatformVersion)` это отдельная ось: она становится `minSdkVersion` и к требованию Play отношения не имеет.

   **Проверка:** пересоберите и повторите `grep` из шага 1 для `obj/Release/net10.0-android/AndroidManifest.xml`. Он должен вывести `targetSdkVersion="36"`.

3. **Удалите из манифеста любой жёстко прописанный `uses-sdk`.** Это самая частая причина, по которой шаг 2 выглядит бесполезным. .NET for Android записывает `targetSdkVersion` только тогда, когда в шаблонном манифесте его ещё нет, а явное значение побеждает безоговорочно ([`ManifestDocument.cs`](https://github.com/dotnet/android/blob/main/src/Xamarin.Android.Build.Tasks/Utilities/ManifestDocument.cs)):

   ```xml
   <!-- Platforms/Android/AndroidManifest.xml: delete the uses-sdk line entirely -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
     <application android:allowBackup="true" android:icon="@mipmap/appicon" android:supportsRtl="true" />
   </manifest>
   ```

   Собственное [руководство Microsoft по XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) советовало добавлять именно этот элемент, чтобы удержать целевой уровень при обновлении SDK, поэтому множество проектов эпохи Xamarin.Forms до сих пор его несут. Текущий шаблон .NET MAUI вообще не содержит элемента `uses-sdk`, и это то состояние, которое вам нужно.

   **Проверка:** `grep -c uses-sdk Platforms/Android/AndroidManifest.xml` возвращает `0`, а объединённый манифест по-прежнему показывает `targetSdkVersion="36"`.

4. **Определитесь со стратегией edge-to-edge, потому что права голоса у вас больше нет.** При целевом уровне 36 атрибут `windowOptOutEdgeToEdgeEnforcement` [объявлен устаревшим и отключён](https://developer.android.com/about/versions/16/behavior-changes-16) на устройствах с Android 16. Если он был в `Platforms/Android/Resources/values/styles.xml`, удалите его. Затем выберите значение `SafeAreaEdges` для каждой страницы вместо того, чтобы принимать умолчание .NET 10, равное `None`:

   ```xml
   <!-- .NET MAUI 10.0.100: ContentPage defaults to SafeAreaEdges="None" -->
   <ContentPage SafeAreaEdges="Container">
       <Grid SafeAreaEdges="Container" RowDefinitions="Auto,*">
           <Label Text="Not under the status bar" />
       </Grid>
   </ContentPage>
   ```

   `Container` воспроизводит поведение .NET 9, при котором содержимое держится в стороне от системных панелей и вырезов экрана. `All` дополнительно уходит от клавиатуры, и это то, что нужно, если вы полагались на платформенную настройку Android `WindowSoftInputModeAdjust.Resize`. `None` это иммерсивный вариант, и он должен быть осознанным выбором, а не унаследованным по случайности умолчанием.

   **Проверка:** на устройстве с Android 16 строка состояния и панель жестовой навигации не перекрывают ни один нажимаемый элемент на трёх ваших основных экранах, в светлой и тёмной темах.

5. **Почините собственную обработку кнопки назад, пока предиктивный жест её не поглотил.** При целевом уровне 36 анимации предиктивного возврата включены по умолчанию, `onBackPressed()` не вызывается, а `KeyEvent.KEYCODE_BACK` не доставляется. Любое переопределение активности вроде такого перестаёт работать:

   ```csharp
   // Broken at targetSdkVersion 36 on Android 16
   public override void OnBackPressed()
   {
       if (_hasUnsavedChanges) { ShowConfirmDialog(); return; }
       base.OnBackPressed();
   }
   ```

   Обрабатывайте это в собственном навигационном слое .NET MAUI, который продолжает работать на всех платформах:

   ```csharp
   // .NET MAUI 10.0.100, cross-platform
   protected override bool OnBackButtonPressed()
   {
       if (!_hasUnsavedChanges)
           return base.OnBackButtonPressed();

       Dispatcher.Dispatch(async () => await DisplayAlertAsync("Discard changes?", "...", "OK"));
       return true; // handled
   }
   ```

   Аварийный выход со стороны Android это `android:enableOnBackInvokedCallback="false"` на `<application>` или на отдельной `<activity>`, и он является временной затычкой, а не решением.

   **Проверка:** проведите пальцем от края экрана и задержите. Вы должны увидеть анимацию предпросмотра, а после отпускания должно произойти то, что задумано вашим обработчиком.

6. **Проверьте фиксированную ориентацию и жёсткие соотношения сторон.** На экранах от `sw600dp` целевой уровень 36 заставляет Android игнорировать `android:screenOrientation`, `android:resizableActivity`, `android:minAspectRatio` и `android:maxAspectRatio`, а также `SetRequestedOrientation` во время выполнения. В .NET MAUI это обычно означает атрибут на `MainActivity`:

   ```csharp
   // Ignored on sw600dp+ displays at targetSdkVersion 36
   [Activity(ScreenOrientation = ScreenOrientation.Portrait, /* ... */)]
   public class MainActivity : MauiAppCompatActivity { }
   ```

   Временный отказ оформляется свойством манифеста, и Google заявил, что он перестанет действовать на уровне API 37:

   ```xml
   <application>
     <property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
               android:value="true" />
   </application>
   ```

   **Проверка:** запустите на эмуляторе планшета или складного устройства и поверните его. Если в альбомной ориентации макет непригоден, чините макет, потому что отказ покупает вам один год.

7. **Обновите CI, чтобы он не собирал против отсутствующей платформы.** Отсутствие API 36 на агенте проявляется как XA5207, и лечится это целью сборки, а не загрузкой с портала:

   ```bash
   dotnet build -t:InstallAndroidDependencies -f net10.0-android \
     -p:AndroidSdkDirectory="$ANDROID_HOME" \
     -p:AcceptAndroidSDKLicenses=true
   ```

   Аргумент `-f` обязателен, иначе MSBuild сообщит `MSB4057: The target "InstallAndroidDependencies" does not exist in the project`.

   **Проверка:** чистый прогон CI с пустым кешем SDK выдаёт подписанный AAB без XA5207.

## Контрольный список проверки

- `obj/Release/net10.0-android/AndroidManifest.xml` содержит `targetSdkVersion="36"` и тот `minSdkVersion`, который вы задумывали.
- Предрелизный отчёт Play Console на внутреннем канале не показывает предупреждения о целевом уровне API.
- Каждый экран проверен на телефоне с Android 16 на перекрытие отступами сверху и снизу, а также с открытой клавиатурой.
- Жест назад, кнопка назад и любой диалог подтверждения выхода ведут себя как раньше.
- Прогон на планшете или складном устройстве в обеих ориентациях, если вы вообще поставляете приложение на большие экраны.
- Доля сессий без сбоев и частота ANR не изменились после недели на внутреннем канале, прежде чем повышать сборку.

## План отката

Возврат `TargetFramework` к `net9.0-android` восстанавливает прежний целевой уровень и прежнее поведение безопасных областей .NET MAUI, и это чистый откат при условии, что вы не начали заодно использовать API из .NET 10. Что откатить нельзя, так это сторону Play: после публикации AAB с целевым уровнем 36 вы уже не сможете опубликовать более низкий целевой уровень в тот же канал, потому что Play применяет порог к каждой загрузке. Считайте внутренний канал своим окном отката, а перевод в production односторонним действием.

## Мелочи, которые стоят реального времени

- **Манифест записывает только старшую версию.** `net11.0-android36.1` даёт `android:targetSdkVersion="36"`, потому что генератор манифеста берёт старший компонент уровня API. Если вы ожидали увидеть `36.1` в объединённом манифесте и пошли искать ошибку, её там нет.
- **.NET 9 вас туда не приведёт.** Рабочая нагрузка Android для .NET 9 поставила привязки API 35 и на этом остановилась, поэтому `net9.0-android36.0` не является допустимым TFM. Выполнить требование Play без смены SDK невозможно.
- **У предиктивного возврата была настоящая ошибка в .NET MAUI.** `MauiAppCompatActivity` регистрировал обработчик назад безусловно, что подавляло анимацию возврата на домашний экран даже на корневой странице, где .NET MAUI нечего было обрабатывать. Исправлено переходом на `OnBackPressedCallback` из AndroidX, состояние `Enabled` которого отслеживает, может ли навигация действительно вернуться назад ([dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223)), и выпущено в .NET MAUI 10.0.90. У `BlazorWebView` была та же ошибка и собственное исправление в том же выпуске. Если анимация возврата подтормаживает на Android 16, проверьте версию .NET MAUI, прежде чем отлаживать собственный код.
- **`ScrollView` игнорирует `SafeAreaEdges` при уходе от клавиатуры.** `SoftInput` там не действует, потому что `ScrollView` управляет собственными отступами содержимого. Оберните его в `Grid` и задайте `SafeAreaEdges` на контейнере.
- **Значки строки состояния пропадают на новом фоне от края до края.** В .NET 11 Preview 7 добавили `Window.StatusBarTheme` для управления контрастом значков независимо от темы приложения, начиная с Android 6.0. В .NET 10 вы задаёте `WindowInsetsControllerCompat.AppearanceLightStatusBars` самостоятельно.
- **Продление Play выдаётся по каждому приложению и ограничено сроком.** Продление до 2026-11-01 запрашивается из уведомления Play Console на затронутом приложении, автоматически оно не выдаётся и не сдвигает срок по API 37 на следующий год.

## Связанное

- [Перевод приложения .NET MAUI для Android с Mono на CoreCLR в .NET 11](/ru/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/) охватывает вторую половину перехода на .NET 11, включая нижнюю границу API 24.
- [Почему Google Play отклоняет приложение Flutter или MAUI из-за размера страницы 16 КБ](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) это второе требование Play, блокирующее загрузку.
- [Как исправить "Doesn't support required ABI" при установке приложения .NET MAUI для Android](/ru/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) это сбой на этапе установки, который возникает сразу после смены идентификаторов среды выполнения.
- [Как исправить перекрытие интерфейсом Flutter панели навигации Android после перехода на SDK 35](/ru/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) это то же самое принудительное edge-to-edge, но со стороны Flutter.
- [Миграция с Xamarin.Forms на .NET MAUI 11](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/), если жёстко прописанный `uses-sdk` из шага 3 оказался наименьшей из ваших проблем.

## Источники

- [Требования к целевому уровню API для приложений Google Play](https://support.google.com/googleplay/android-developer/answer/11926878), справка Play Console.
- [Изменения поведения: приложения с целевым уровнем Android 16 и выше](https://developer.android.com/about/versions/16/behavior-changes-16), Android Developers.
- [Что нового в .NET MAUI для .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10) и [для .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Разметка с безопасными областями](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/safe-area), Microsoft Learn, включая критическое изменение `ContentPage` в .NET 10.
- [Ошибка XA5207 в .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) и [цели сборки](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-targets), Microsoft Learn.
- [Заметки о выпуске .NET for Android 11 Preview 5](https://github.com/dotnet/android/releases/tag/36.99.0-preview.5.308), где API 37 переведён в стабильные, а .NET 11 по умолчанию нацелен на `net11.0-android37`.
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), исправление регистрации предиктивного возврата.
