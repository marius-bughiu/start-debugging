---
title: "Migra una app .NET MAUI para Android al nivel de API 36"
description: "Google Play exige el nivel de API objetivo 36 desde el 2026-08-31, con prórrogas hasta el 2026-11-01. Este es el camino completo en .NET MAUI desde net9.0-android hasta API 36: el cambio de target framework, el uses-sdk fijo que te deja en silencio en el nivel anterior, el modo edge-to-edge sin opción de exclusión, el gesto de retroceso predictivo y las reglas de pantallas grandes."
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
lang: "es"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36"
translatedBy: "claude"
translationDate: 2026-09-04
---

El cambio en la compilación es una línea. Los cambios de comportamiento son la migración. Google Play empezó a exigir el nivel de API objetivo 36 para apps nuevas y actualizaciones el 2026-08-31, con una prórroga por app disponible en Play Console hasta el 2026-11-01, así que si esta semana te rechazaron una actualización, esta es la razón. En una app .NET MAUI el nivel de API objetivo no es un ajuste del manifiesto que edites: se deriva de la versión de la plataforma Android en tu `TargetFramework`, y .NET 9 llega como máximo a API 35. Eso significa que esto es una actualización del SDK de .NET a .NET 10 (o .NET 11), no un retoque del manifiesto. Calcula un día para una app pequeña y un sprint para cualquiera que tenga orientación bloqueada, un botón de retroceso personalizado o insets ajustados a mano. Esta guía apunta a .NET 10 con .NET MAUI 10.0.100 (publicado el 2026-08-20) como destino, e indica en qué se diferencia .NET 11.

## Por qué Play revisa el nivel objetivo, y no otro

- **`targetSdkVersion` es la puerta, no `compileSdk` ni `minSdk`.** Play lee `android:targetSdkVersion` del manifiesto combinado dentro de tu AAB. Compilar contra la plataforma API 36 no basta por sí solo.
- **Las instalaciones existentes no se eliminan, pero los usuarios nuevos quedan fuera.** Según la [política de nivel de API objetivo de Play Console](https://support.google.com/googleplay/android-developer/answer/11926878), las apps por debajo del mínimo siguen en los dispositivos que ya las tienen, pero dejan de estar disponibles para usuarios nuevos en versiones de Android más recientes que el objetivo de la app. Tu embudo de instalación se degrada en silencio en lugar de romperse de forma visible.
- **El mínimo de cada año es la versión del año anterior.** API 36 es Android 16. El requisito de 2027 será API 37 (Android 17), que .NET for Android ya publica como estable, así que el trabajo que hagas aquí es trabajo que harás una vez al año para siempre.

## Qué se rompe

| Área | Cambio con el objetivo API 36 | Severidad |
| --- | --- | --- |
| Edge-to-edge | `windowOptOutEdgeToEdgeEnforcement` queda obsoleto y se ignora en dispositivos con Android 16 | alta |
| Áreas seguras de .NET MAUI | `ContentPage.SafeAreaEdges` vale `None` por defecto desde .NET 10, así que las páginas van de borde a borde | alta |
| Retroceso predictivo | Las animaciones de vuelta al inicio y entre actividades están activas por defecto; `OnBackPressed` no se llama | alta |
| Pantallas grandes | `android:screenOrientation`, `resizableActivity`, `minAspectRatio` y `maxAspectRatio` se ignoran a partir de `sw600dp` | alta (tablets, plegables) |
| SDK de .NET | API 36 necesita `net10.0-android` o posterior; la carga de trabajo de .NET 9 se detiene en API 35 | alta |
| API mínima | .NET 11 sube el mínimo de API 21 a API 24 | media (solo .NET 11) |
| Renderizado de texto | `android:elegantTextHeight` queda obsoleto y se ignora | baja |
| Programación de tareas | `ScheduledExecutorService.scheduleAtFixedRate` repite como máximo una ejecución perdida | baja |
| Sensores de salud | `BODY_SENSORS` se sustituye por permisos granulares `android.permissions.health` | baja (salvo que leas la frecuencia cardiaca) |

Las dos primeras filas se combinan. Actualizar a .NET 10 para conseguir API 36 también cambia el valor por defecto de las áreas seguras del propio .NET MAUI en el mismo commit, así que una app que se veía bien en .NET 9 con objetivo 35 puede salir del proceso con la barra de título debajo de la barra de estado por dos motivos independientes.

## Lista de comprobación previa

- SDK de .NET 10 instalado, con la carga de trabajo `maui-android` restaurada: `dotnet workload install maui-android`.
- La plataforma del SDK de Android para API 36 realmente presente en la máquina de compilación y en CI. Si falta, obtienes [XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207), no una advertencia.
- Un dispositivo físico o una imagen de emulador con Android 16. Estos cambios de comportamiento dependen tanto de la versión del sistema como de tu objetivo, así que un emulador con Android 14 te ocultará todos ellos.
- Capturas de tu interfaz actual en un celular y en una tablet, antes de tocar nada. Las necesitarás para juzgar las regresiones de insets.
- El estado de tu app respecto al tamaño de página de 16 KB ya resuelto, porque es un requisito de Play aparte con su propio modo de fallo. Consulta [por qué Google Play rechaza una app Flutter o MAUI por el tamaño de página de 16 KB](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Pasos de migración

1. **Averigua a qué apuntas hoy realmente.** No leas el csproj, lee el manifiesto combinado que produce la compilación:

   ```bash
   dotnet build -f net9.0-android -c Release
   grep -o 'targetSdkVersion="[0-9.]*"' obj/Release/net9.0-android/AndroidManifest.xml
   ```

   **Verificación:** obtienes un único número. Si es menor que la versión de plataforma Android de tu `TargetFramework`, algo lo está fijando, y el paso 3 es el que más importa en tu caso.

2. **Mueve el target framework a .NET 10.** La versión de plataforma Android del TFM es lo que se convierte en `targetSdkVersion`, así que esta única edición es la migración real:

   ```xml
   <!-- .csproj, .NET 10, .NET MAUI 10.0.100 -->
   <PropertyGroup>
     <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   `net10.0-android` a secas se resuelve a API 36, que es [el valor por defecto documentado de .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10). Fíjalo de forma explícita como `net10.0-android36.0` si prefieres que la compilación falle en lugar de desplazarse cuando más adelante pases a .NET 11, porque .NET for Android promovió API 37 a estable en .NET 11 Preview 5 y ahora los proyectos .NET 11 apuntan por defecto a `net11.0-android37`. `$(SupportedOSPlatformVersion)` es un eje distinto: se convierte en `minSdkVersion` y no tiene nada que ver con el requisito de Play.

   **Verificación:** vuelve a compilar y repite el `grep` del paso 1 contra `obj/Release/net10.0-android/AndroidManifest.xml`. Debe imprimir `targetSdkVersion="36"`.

3. **Elimina cualquier `uses-sdk` fijo de tu manifiesto.** Esta es la causa más común de que el paso 2 parezca no hacer nada. .NET for Android solo escribe `targetSdkVersion` cuando la plantilla del manifiesto no tiene ya uno, y un valor explícito gana sin discusión ([`ManifestDocument.cs`](https://github.com/dotnet/android/blob/main/src/Xamarin.Android.Build.Tasks/Utilities/ManifestDocument.cs)):

   ```xml
   <!-- Platforms/Android/AndroidManifest.xml: delete the uses-sdk line entirely -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
     <application android:allowBackup="true" android:icon="@mipmap/appicon" android:supportsRtl="true" />
   </manifest>
   ```

   La propia [guía de XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) de Microsoft indicaba añadir exactamente este elemento para conservar un nivel objetivo durante una actualización del SDK, así que muchos proyectos de la época de Xamarin.Forms todavía lo arrastran. La plantilla actual de .NET MAUI no incluye ningún elemento `uses-sdk`, que es el estado que quieres.

   **Verificación:** `grep -c uses-sdk Platforms/Android/AndroidManifest.xml` devuelve `0`, y el manifiesto combinado sigue mostrando `targetSdkVersion="36"`.

4. **Decide tu estrategia de edge-to-edge, porque ya no tienes voto.** Con objetivo 36 el atributo `windowOptOutEdgeToEdgeEnforcement` está [obsoleto y deshabilitado](https://developer.android.com/about/versions/16/behavior-changes-16) en dispositivos con Android 16. Si lo tenías en `Platforms/Android/Resources/values/styles.xml`, bórralo. Después elige un valor de `SafeAreaEdges` por página en lugar de aceptar el valor por defecto de .NET 10, que es `None`:

   ```xml
   <!-- .NET MAUI 10.0.100: ContentPage defaults to SafeAreaEdges="None" -->
   <ContentPage SafeAreaEdges="Container">
       <Grid SafeAreaEdges="Container" RowDefinitions="Auto,*">
           <Label Text="Not under the status bar" />
       </Grid>
   </ContentPage>
   ```

   `Container` reproduce el comportamiento de .NET 9 de mantenerse fuera de las barras del sistema y de los recortes de pantalla. `All` además evita el teclado, que es lo que quieres si dependías del platform-specific `WindowSoftInputModeAdjust.Resize` de Android. `None` es la opción inmersiva, y es una decisión deliberada, no un valor por defecto que debas heredar por accidente.

   **Verificación:** en un dispositivo con Android 16, la barra de estado y la barra de navegación por gestos no se superponen a ningún control pulsable en tus tres pantallas principales, en tema claro y oscuro.

5. **Arregla el manejo personalizado del retroceso antes de que el retroceso predictivo se lo coma.** Con objetivo 36 las animaciones de retroceso predictivo están activas por defecto, `onBackPressed()` no se llama y `KeyEvent.KEYCODE_BACK` no se despacha. Cualquier sobrescritura de actividad como esta deja de ejecutarse:

   ```csharp
   // Broken at targetSdkVersion 36 on Android 16
   public override void OnBackPressed()
   {
       if (_hasUnsavedChanges) { ShowConfirmDialog(); return; }
       base.OnBackPressed();
   }
   ```

   Trátalo en la superficie de navegación propia de .NET MAUI, que sigue funcionando en todas las plataformas:

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

   La salida de emergencia de Android es `android:enableOnBackInvokedCallback="false"` en `<application>` o en una sola `<activity>`, y es un parche temporal, no una solución.

   **Verificación:** desliza desde el borde de la pantalla y mantén. Deberías ver la animación de anticipación, y al soltar debería ocurrir lo que tu manejador pretende.

6. **Audita la orientación bloqueada y las relaciones de aspecto fijas.** En pantallas de `sw600dp` o más, el objetivo 36 hace que Android ignore `android:screenOrientation`, `android:resizableActivity`, `android:minAspectRatio` y `android:maxAspectRatio`, junto con `SetRequestedOrientation` en tiempo de ejecución. En .NET MAUI eso suele significar un atributo en `MainActivity`:

   ```csharp
   // Ignored on sw600dp+ displays at targetSdkVersion 36
   [Activity(ScreenOrientation = ScreenOrientation.Portrait, /* ... */)]
   public class MainActivity : MauiAppCompatActivity { }
   ```

   La exclusión temporal es una propiedad del manifiesto, y Google ha indicado que deja de aplicarse en el nivel de API 37:

   ```xml
   <application>
     <property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
               android:value="true" />
   </application>
   ```

   **Verificación:** ejecuta la app en un emulador de tablet o plegable y rota. Si el diseño es inservible en horizontal, arregla el diseño, porque la exclusión solo te compra un año.

7. **Actualiza CI para que no compile contra una plataforma que no tiene.** Que falte API 36 en un agente aparece como XA5207, y la solución es un target, no una descarga desde un portal:

   ```bash
   dotnet build -t:InstallAndroidDependencies -f net10.0-android \
     -p:AndroidSdkDirectory="$ANDROID_HOME" \
     -p:AcceptAndroidSDKLicenses=true
   ```

   El argumento `-f` es obligatorio; si no, MSBuild informa `MSB4057: The target "InstallAndroidDependencies" does not exist in the project`.

   **Verificación:** una ejecución limpia de CI desde una caché vacía del SDK produce un AAB firmado sin XA5207.

## Lista de verificación

- `obj/Release/net10.0-android/AndroidManifest.xml` contiene `targetSdkVersion="36"` y el `minSdkVersion` que pretendías.
- El informe previo al lanzamiento de Play Console en un canal interno no muestra ninguna advertencia de nivel de API objetivo.
- Todas las pantallas revisadas en un celular con Android 16 buscando superposición de insets, arriba y abajo, y también con el teclado abierto.
- El gesto de retroceso, el botón de retroceso y cualquier diálogo de confirmación al salir se comportan igual que antes.
- Ejecución en tablet o plegable en ambas orientaciones, si distribuyes a pantallas grandes.
- Tasa libre de fallos y tasa de ANR estables tras una semana en un canal interno, antes de promover.

## Plan de reversión

Revertir el `TargetFramework` a `net9.0-android` restaura el nivel objetivo anterior y el comportamiento anterior de las áreas seguras de .NET MAUI, y es una reversión limpia siempre que no hayas adoptado además APIs de .NET 10. Lo que no puedes revertir es el lado de Play: una vez que has publicado un AAB con objetivo 36, después no puedes publicar un nivel objetivo menor en el mismo canal, porque Play aplica el mínimo en cada subida. Trata el canal interno como tu ventana de reversión y la promoción a producción como algo de un solo sentido.

## Detalles que cuestan tiempo real

- **El manifiesto escribe solo la versión mayor.** `net11.0-android36.1` produce `android:targetSdkVersion="36"`, porque el generador del manifiesto toma el componente mayor del nivel de API. Si esperabas ver `36.1` en el manifiesto combinado y te pusiste a buscar un error, no lo hay.
- **.NET 9 no te lleva hasta ahí.** La carga de trabajo de Android de .NET 9 publicó enlaces de API 35 y se quedó ahí, así que `net9.0-android36.0` no es un TFM válido. No hay forma de cumplir el requisito de Play sin mover el SDK.
- **El retroceso predictivo tuvo un error real en .NET MAUI.** `MauiAppCompatActivity` registraba un callback de retroceso de forma incondicional, lo que suprimía la animación de vuelta al inicio de Android incluso en una página raíz donde .NET MAUI no tenía nada que consumir. Se corrigió cambiando a un `OnBackPressedCallback` de AndroidX cuyo estado `Enabled` sigue si la navegación puede realmente retroceder ([dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223)), y se publicó en .NET MAUI 10.0.90. `BlazorWebView` tenía el mismo error y su propia corrección en la misma versión. Si tu animación de retroceso se entrecorta en Android 16, revisa tu versión de .NET MAUI antes de depurar tu propio código.
- **`ScrollView` ignora `SafeAreaEdges` para evitar el teclado.** `SoftInput` no tiene efecto ahí, porque `ScrollView` gestiona sus propios insets de contenido. Envuélvelo en un `Grid` y pon `SafeAreaEdges` en el contenedor.
- **Los iconos de la barra de estado desaparecen sobre tu nuevo fondo de borde a borde.** .NET 11 Preview 7 añadió `Window.StatusBarTheme` para controlar el contraste de los iconos con independencia del tema de la app, en Android 6.0 y posteriores. En .NET 10 configuras tú mismo `WindowInsetsControllerCompat.AppearanceLightStatusBars`.
- **La prórroga de Play es por app y tiene fecha límite.** La prórroga al 2026-11-01 se solicita desde la notificación de Play Console en la app afectada, no se concede automáticamente, y no mueve la fecha límite de API 37 del año que viene.

## Relacionado

- [Migra una app .NET MAUI para Android de Mono a CoreCLR en .NET 11](/es/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/) cubre la otra mitad de un salto a .NET 11, incluido el mínimo de API 24.
- [Por qué Google Play rechaza una app Flutter o MAUI por el tamaño de página de 16 KB](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) es el otro requisito de Play que bloquea subidas.
- [Cómo corregir "Doesn't support required ABI" al instalar una app .NET MAUI para Android](/es/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) es el fallo en tiempo de instalación que aparece justo después de cambiar los identificadores de runtime.
- [Cómo corregir que la interfaz de Flutter se superponga a la barra de navegación de Android tras apuntar al SDK 35](/es/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) es la misma imposición de edge-to-edge vista desde Flutter.
- [Migrar de Xamarin.Forms a .NET MAUI 11](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/) por si el `uses-sdk` fijo del paso 3 resultó ser el menor de tus problemas.

## Fuentes

- [Requisitos de nivel de API objetivo para apps de Google Play](https://support.google.com/googleplay/android-developer/answer/11926878), Ayuda de Play Console.
- [Cambios de comportamiento: apps que apuntan a Android 16 o superior](https://developer.android.com/about/versions/16/behavior-changes-16), Android Developers.
- [Novedades de .NET MAUI en .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10) y [en .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Diseño con áreas seguras](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/safe-area), Microsoft Learn, incluido el cambio disruptivo de `ContentPage` en .NET 10.
- [Error XA5207 de .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) y [targets de compilación](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-targets), Microsoft Learn.
- [Notas de la versión de .NET for Android 11 Preview 5](https://github.com/dotnet/android/releases/tag/36.99.0-preview.5.308), que estabilizan API 37 y hacen que .NET 11 apunte por defecto a `net11.0-android37`.
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), la corrección del registro del retroceso predictivo.
