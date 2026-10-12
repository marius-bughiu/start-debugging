---
title: "Solución: \"does not support provisioning profiles\" al archivar una app iOS de Flutter tras migrar a Swift Package Manager"
description: "Un provisioning profile pasado a xcodebuild por línea de comandos se aplica a todos los targets de resource bundle de SwiftPM. Configura la firma manual en el target Runner."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "xcode"
  - "ci"
lang: "es"
translationOf: "2026/10/fix-does-not-support-provisioning-profiles-flutter-ios-archive-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-12
---

Deja de pasar `PROVISIONING_PROFILE_SPECIFIER` (y normalmente también `CODE_SIGN_STYLE`, `DEVELOPMENT_TEAM` y `CODE_SIGN_IDENTITY`) como argumentos de línea de comandos de `xcodebuild` o como `xcargs` de fastlane. Un build setting pasado por línea de comandos sobrescribe ese ajuste en **todos** los targets de la compilación. Tras la migración a SwiftPM, eso incluye el target de resource bundle que Xcode genera para cada plugin, como `url_launcher_ios_url_launcher_ios`, y un resource bundle no puede llevar un provisioning profile. Configura en su lugar la firma manual en la configuración Release del target `Runner` y luego archiva con `flutter build ipa`. Con CocoaPods, esos mismos argumentos solo funcionaban porque un hook `post_install` establecía `CODE_SIGNING_ALLOWED = NO` en cada pod. SwiftPM no tiene un hook así, por lo que la migración deja el error al descubierto. Todo lo que sigue se reprodujo con Flutter 3.44.8, Xcode 27.0 y CocoaPods 1.17.0.

## El error completo

Obtienes un error por cada plugin que incluye recursos (en la práctica, todo plugin con un manifiesto `PrivacyInfo.xcprivacy`), seguido del habitual fallo de archivado:

```
.../ios/Flutter/ephemeral/Packages/.packages/url_launcher_ios-6.4.2/Package.swift: error: url_launcher_ios_url_launcher_ios does not support provisioning profiles. url_launcher_ios_url_launcher_ios does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'url_launcher_ios_url_launcher_ios' from project 'url_launcher_ios')
.../ios/Flutter/ephemeral/Packages/.packages/shared_preferences_foundation-2.5.7/Package.swift: error: shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles. shared_preferences_foundation_shared_preferences_foundation does not support provisioning profiles, but provisioning profile MyApp AppStore has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor. (in target 'shared_preferences_foundation_shared_preferences_foundation' from project 'shared_preferences_foundation')
** ARCHIVE FAILED **
```

Fíjate en dos cosas: la ruta, que apunta a `Flutter/ephemeral/Packages/.packages/`, y el nombre del target, que sigue el patrón `<package>_<target>` de SwiftPM. Ambas indican que el target que falla es el resource bundle de un paquete Swift, no tu app ni el código de un plugin.

El consejo del mensaje, "Set the provisioning profile value to Automatic in the build settings editor", no sirve aquí. No puedes abrir los build settings de un target que Xcode sintetiza a partir de un `Package.swift`, y nada en ese target pide un profile. El profile se le está imponiendo desde fuera.

## Por qué el profile llega a targets que nunca configuraste

Xcode resuelve un build setting a través de varias capas, de menor a mayor prioridad: valores predeterminados de la plataforma, ajustes a nivel de proyecto, archivos xcconfig, ajustes a nivel de target y, por último, las sobrescrituras que pasas a `xcodebuild` como `NAME=value`. La capa más alta no está limitada a un target. Cuando un script de CI ejecuta:

```bash
# Xcode 27.0, Flutter 3.44.8 - the pattern that breaks
xcodebuild -workspace Runner.xcworkspace -scheme Runner \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM=ABCDE12345 \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore"
```

todos los targets que participan en el archivado reciben `PROVISIONING_PROFILE_SPECIFIER = MyApp AppStore`. La validación de firma de Xcode rechaza entonces ese ajuste en cualquier tipo de producto que no se pueda aprovisionar, como resource bundles, bibliotecas estáticas y frameworks. Apple no siempre ha aplicado esto de forma consistente: un [hilo de los foros de desarrolladores](https://developer.apple.com/forums/thread/700327) documenta el mismo error en dependencias nativas de paquetes Swift, que apareció en las betas de Xcode 13.3, desapareció en la GM de 13.3 y volvió en Xcode 14. En Xcode 27.0 se aplica.

Tras la migración, los targets de un archivado son `Runner`, el agregado `FlutterGeneratedPluginSwiftPackage`, el producto de biblioteca de cada plugin y un target `.bundle` por cada plugin que declara `resources:` en su `Package.swift`. La mayoría de los plugins oficiales ahora incluyen un manifiesto de privacidad de esa forma, así que casi cualquier app real tiene varios de estos bundles.

### Por qué funcionaba con CocoaPods

Ejecuté el mismo comando contra la misma app con SwiftPM desactivado (`enable-swift-package-manager: false` bajo `flutter: config:` en `pubspec.yaml`). También falla, solo que con otros nombres de target:

```
ios/Pods/Pods.xcodeproj: error: Pods-Runner does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: url_launcher_ios does not support provisioning profiles. ...
ios/Pods/Pods.xcodeproj: error: shared_preferences_foundation does not support provisioning profiles. ...
```

Así que la línea de comandos nunca fue correcta. Los proyectos que compilaban con ella tenían un bloque `post_install` en el `Podfile` parecido a este, normalmente copiado hace años de una respuesta de Stack Overflow:

```ruby
# ios/Podfile, CocoaPods 1.17.0
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
    end
  end
end
```

Con ese hook, el archivado pasa por todos los targets de pods y solo `Runner` se valida contra el profile. El hook funciona porque Xcode omite la validación de firma de un target que no tiene permitido firmar, aunque el profile forzado siga en sus ajustes. Al eliminar el `Podfile` como último paso de la migración, el hook desaparece con él, y SwiftPM no ofrece nada equivalente. No existe un `post_install` para paquetes, y el `Package.swift` generado bajo `Flutter/ephemeral` se reescribe en cada compilación.

## Reproducción mínima

```bash
# Flutter 3.44.8, Xcode 27.0, SwiftPM enabled (the default since 3.44)
flutter create --platforms=ios -e --org com.example myapp
cd myapp
flutter pub add url_launcher shared_preferences
# Xcode 27 rejects the template's 13.0 deployment target
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 13.0/IPHONEOS_DEPLOYMENT_TARGET = 15.0/g' \
  ios/Runner.xcodeproj/project.pbxproj
flutter build ios --simulator --debug   # applies the SwiftPM project migration
cd ios
xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../build/Runner.xcarchive archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=ABCDE12345 \
  PROVISIONING_PROFILE_SPECIFIER="MyApp AppStore" CODE_SIGN_IDENTITY="Apple Distribution"
```

No necesitas un certificado ni un profile reales para verlo. Xcode informa los errores "does not support provisioning profiles" de los dos targets de bundle durante la planificación de la compilación, junto al error esperado "No profile for team" de `Runner`.

## Solución 1: configura la firma manual en el target Runner y usa `flutter build ipa`

La firma pertenece a los targets que producen algo firmable: `Runner`, más las extensiones de app que tengas (extensión de compartir, extensión de servicio de notificaciones, widget). Configúrala ahí y en ningún otro lugar.

En Xcode, abre `ios/Runner.xcworkspace`, selecciona el target `Runner`, ve a **Signing & Capabilities**, elige la pestaña **Release**, desactiva **Automatically manage signing** y selecciona tu team y tu profile. Si prefieres ver el resultado, esto es lo que termina en la configuración Release del target `Runner` en `ios/Runner.xcodeproj/project.pbxproj`:

```
/* Flutter 3.44.8, Xcode 27.0 - Runner target, Release configuration */
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = ABCDE12345;
"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "MyApp AppStore";
```

Repite para la configuración `Profile` si archivas compilaciones de profile. Luego elimina todos los argumentos de firma del comando y archiva con normalidad:

```bash
# Flutter 3.44.8
flutter build ipa --release
```

Cuando moví esos mismos cuatro ajustes de la línea de comandos al target `Runner`, los errores de paquetes desaparecieron y solo quedó el error esperado "No profile ... found" de `Runner`. Mi máquina de pruebas no tiene un profile de distribución, así que la reproducción llega hasta ahí, pero ese error restante es el normal que obtienes solo para `Runner` cuando el profile indicado no está instalado.

`flutter build ipa` no añade sobrescrituras de firma por su cuenta. En Flutter 3.44.8, `build_ios.dart` lee los build settings resueltos de `Runner` después del archivado. Si `CODE_SIGN_STYLE` es `Manual` y tanto `PROVISIONING_PROFILE_SPECIFIER` como `DEVELOPMENT_TEAM` están definidos, busca el profile instalado que coincida y genera un `ExportOptions.plist` con `signingStyle` `manual` y una entrada `provisioningProfiles` para tu bundle ID. Si necesitas control total, por ejemplo en una app con extensiones, pasa tu propio archivo:

```bash
# Flutter 3.44.8
flutter build ipa --release --export-options-plist=ios/ExportOptions.plist
```

```xml
<!-- ios/ExportOptions.plist, Xcode 27.0 -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>ABCDE12345</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.example.myapp</key>
    <string>MyApp AppStore</string>
  </dict>
</dict>
</plist>
```

Incluye en `provisioningProfiles` solo los bundle IDs de la app y de sus extensiones. Los frameworks y bundles de plugins nunca llevan una entrada.

## Solución 2: en fastlane, cambia el proyecto, no la línea de comandos

La versión de fastlane del patrón incorrecto es `build_app(xcargs: "PROVISIONING_PROFILE_SPECIFIER=...")`, y `xcargs` es exactamente la capa de línea de comandos. Usa `update_code_signing_settings` con `targets:` para que el ajuste se escriba solo en `Runner`, y luego compila sin `xcargs` de firma:

```ruby
# fastlane 2.x, Flutter 3.44.8, Xcode 27.0
lane :release do
  update_code_signing_settings(
    path: "ios/Runner.xcodeproj",
    use_automatic_signing: false,
    targets: ["Runner"],
    build_configurations: ["Release"],
    team_id: "ABCDE12345",
    code_sign_identity: "Apple Distribution",
    sdk: "iphoneos*",
    profile_name: "MyApp AppStore"
  )
  build_app(
    workspace: "ios/Runner.xcworkspace",
    scheme: "Runner",
    configuration: "Release",
    export_method: "app-store",
    export_options: {
      provisioningProfiles: { "com.example.myapp" => "MyApp AppStore" }
    }
  )
end
```

El parámetro `targets` aplica por defecto a todos los targets del proyecto. Los bundles de plugins no están en `Runner.xcodeproj`, así que omitirlo no reproduciría el error, pero nombrar el target evita que una futura extensión o un target de pruebas reciban el profile equivocado.

## Solución 3: cambia el archivado a firma automática

Si no necesitas un profile específico, deja que Xcode lo administre. Mantén `CODE_SIGN_STYLE = Automatic` en `Runner` y deja que `xcodebuild` obtenga o cree los profiles con una clave de API de App Store Connect:

```bash
# Xcode 27.0
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Runner.xcarchive archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

Los targets de bundles de paquetes no necesitan firma en este modo, así que pasan la validación sin trabajo adicional. El costo es que la máquina de CI necesita la clave de API y crea profiles por su cuenta, algo que algunos procesos de lanzamiento no permiten.

## Soluciones alternativas que parecen correctas pero no lo son

- **`CODE_SIGNING_ALLOWED=NO` en la línea de comandos.** También llega a `Runner`, así que obtienes un archivo sin firmar que `-exportArchive` no puede convertir en un IPA subible.
- **Ajustes condicionales en la línea de comandos.** `"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]=MyApp AppStore"` no se interpreta como condicional. En Xcode 27.0 el valor resultó ser `iphoneos*]=MyApp AppStore` y `Runner` falló con "No profile ... matching 'iphoneos*]=MyApp AppStore' found". Las condiciones solo funcionan en archivos de proyecto y archivos xcconfig.
- **`-xcconfig` o `XCODE_XCCONFIG_FILE`.** Ambos aplican su archivo como sobrescritura a toda la compilación, así que un profile en ese archivo llega a los targets de paquetes igual que un argumento `NAME=value`.
- **Volver a desactivar SwiftPM.** `enable-swift-package-manager: false` junto con el antiguo hook `post_install` hace desaparecer el error, pero solo porque devuelve CocoaPods. Eso compra tiempo, no es una solución, y el trunk de CocoaPods pasa a solo lectura el 2 de diciembre de 2026.

## Errores parecidos que vienen de la misma línea de comandos

Omitir el profile pero mantener las demás sobrescrituras solo cambia el error. Con `CODE_SIGN_STYLE=Manual` y `CODE_SIGN_IDENTITY` en la línea de comandos y sin team, Xcode 27.0 informa `Signing for "url_launcher_ios_url_launcher_ios" requires a development team` por cada bundle. Añade `DEVELOPMENT_TEAM` y pasa a ser `No signing certificate "iOS Distribution" found` en los mismos targets de bundle. Los tres tienen la misma causa y la misma solución: ningún ajuste de firma en la línea de comandos.

Un mensaje distinto, `exportArchive: SomeKit.framework does not support provisioning profiles`, viene del paso de exportación, no del archivado. Significa que tu `ExportOptions.plist` (o el `export_options` de fastlane) asocia el bundle ID de un framework a un profile. Elimina esa entrada. Solo la app y sus extensiones pertenecen ahí.

Si el archivado supera la firma y luego falla por los deployment targets, eso es el mínimo de iOS 15 de Xcode 27, no un problema de firma. La versión de ese fallo del lado de CocoaPods se trata en [el artículo sobre conflictos de versiones de CocoaPods en compilaciones iOS de Flutter](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Relacionado

- [Migrar una app iOS de Flutter de CocoaPods a Swift Package Manager](/es/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) cubre la migración que elimina el hook del `Podfile`, incluido cómo trasladar otra lógica `post_install` personalizada.
- [Flutter 3.44 convierte SwiftPM en el valor predeterminado](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) explica por qué las apps actualizadas a 3.44 cambiaron sin que hicieras nada.
- [Solución: Unable to find a destination matching the provided destination specifier](/es/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) es otro fallo de compilación iOS causado por ajustes sobrantes de la época de CocoaPods.
- [Solución: the provisioning profile doesn't include the currently selected device](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) cubre el lado del registro de dispositivos del aprovisionamiento, desde el ángulo de .NET MAUI.

## Fuentes

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers), documentación de Flutter.
- [Build and release an iOS app](https://docs.flutter.dev/deployment/ios), documentación de Flutter (`flutter build ipa` y `--export-options-plist`).
- [`build_ios.dart` in flutter_tools](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_ios.dart), la generación de ExportOptions para firma manual.
- [update_code_signing_settings](https://docs.fastlane.tools/actions/update_code_signing_settings/), documentación de fastlane.
- [Apple Developer Forums thread 700327](https://developer.apple.com/forums/thread/700327), el mismo error en dependencias nativas de paquetes Swift en un archivado de CI con firma manual, y cómo cambió su aplicación entre Xcode 13 y 14.
- [Apple Developer Forums thread 726714](https://developer.apple.com/forums/thread/726714), la variante de CocoaPods, reportada para todos los targets del proyecto `Pods`.
