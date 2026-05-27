---
title: "Flutter vs React Native vs .NET MAUI: ¿cuál deberías elegir para un nuevo proyecto móvil en 2026?"
description: "Para una aplicación móvil nueva en 2026, elige Flutter 3.44 cuando importen una UI idéntica píxel a píxel y el presupuesto de animación, React Native 0.82 cuando tu equipo ya viva en TypeScript y necesites un hermano real en el navegador, y .NET MAUI 11 cuando iOS y Android sean parte de un producto .NET más amplio y necesites soporte de primera mano de Microsoft."
pubDate: 2026-05-27
tags:
  - "comparison"
  - "flutter"
  - "react-native"
  - "maui"
  - "mobile"
  - "dotnet"
lang: "es"
translationOf: "2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

Para una nueva aplicación de iOS y Android que empieza hoy, la respuesta honesta es: elige Flutter 3.44 si la UI idéntica píxel a píxel, la animación a 120 Hz sin tirones y una única base de código en Dart son las prioridades. Elige React Native 0.82 si tu equipo de ingeniería es TypeScript primero, quieres el ecosistema de paquetes JS a la mano y una futura versión para navegador está dentro del alcance. Elige .NET MAUI 11 si móvil es una de las superficies de un producto .NET 11 más amplio y Microsoft en el contrato de soporte no es negociable. El rendimiento es un empate en el 95% de las aplicaciones de negocio. El encaje del equipo y el encaje del ecosistema eligen por ti.

Este artículo cubre Flutter 3.44 (estable desde mayo de 2026, paquetes de Material 3 separados), React Native 0.82 (estable desde abril de 2026, New Architecture obligatoria, Bridgeless por defecto) y .NET MAUI 11 (versión preliminar al momento de escribir, GA en noviembre de 2026, CoreCLR por defecto en Android e iOS). Las tres publican en iOS 18 y Android 15+, las tres soportan hot reload, y las tres tienen ejemplos en producción en la App Store y Play Store. Las diferencias que realmente deciden un proyecto son el lenguaje, el modelo de renderizado, la madurez del ecosistema y a qué plataforma puedes llevar al equipo sin reescribir el backend.

## Qué es cada uno en 2026

**Flutter 3.44** es un toolkit de UI Dart primero, renderizado con Skia. Dibuja todo por sí mismo: un `Button` no es un `UIButton` ni un `AppCompatButton`, son los píxeles que el motor de Flutter dibujó basándose en el widget `Material` o `Cupertino` que usaste. Los usuarios de iOS obtienen widgets con tema Cupertino que se ven nativos, los usuarios de Android obtienen widgets Material 3, pero el framework controla cada layout y gesto. La versión 3.44 movió `material` y `cupertino` a paquetes separados distribuidos vía Swift Package Manager del lado de iOS, lo que hace más fáciles de rastrear los deltas a nivel de módulo pero añade un costo único de migración en tu `pubspec.yaml`.

**React Native 0.82** es un framework de JavaScript / TypeScript que mapea a vistas nativas de iOS y Android a través de un puente de turbo-modules. Desde la 0.78 la New Architecture (renderer Fabric + TurboModules + JSI) ha sido la predeterminada para proyectos nuevos; desde la 0.82 el puente legado se eliminó por completo. El modo Bridgeless significa que JavaScript llama a código nativo de manera síncrona cuando es posible, lo que hace que la queja histórica de "RN se siente con lag" sea sustancialmente menos cierta en 2026 que en 2022. El motor JS es Hermes por defecto en ambas plataformas, y `expo` es el orquestador de build de facto: una plantilla `react-native init` desnuda aún existe, pero ya no es el camino recomendado para aplicaciones nuevas.

**.NET MAUI 11** es el framework de primera mano de Microsoft. Envuelve los controles nativos de la plataforma: un `Button` en MAUI es un `UIButton` en iOS, un `AppCompatButton` en Android, un `Microsoft.UI.Xaml.Controls.Button` en Windows y un `NSButton` en Mac Catalyst. CoreCLR ahora es el runtime predeterminado en Android e iOS en .NET 11, lo que cierra la mayor parte de la brecha histórica de tiempo de inicio con Flutter y RN. MAUI comparte la misma pila de XAML / C# con WinUI 3 y Blazor Hybrid, así que tiene más sentido cuando iOS y Android son hermanos de un producto de escritorio Windows o un producto web Blazor, no cuando móvil es todo el universo.

## La matriz de características

| Capacidad                            | Flutter 3.44                        | React Native 0.82                   | .NET MAUI 11                          |
| ------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- |
| Lenguaje principal                    | Dart 3.7                            | TypeScript / JavaScript             | C# 14                                 |
| Modelo de renderizado                 | Skia, píxeles idénticos por plataforma | vistas nativas vía Fabric / TurboModules | controles nativos por plataforma   |
| iOS                                   | sí                                  | sí                                  | sí                                    |
| Android                               | sí                                  | sí                                  | sí                                    |
| Escritorio Windows                    | sí (estable desde 3.16)             | comunidad (`react-native-windows`)  | sí (WinUI 3)                          |
| Escritorio macOS                      | sí (estable desde 3.16)             | comunidad (`react-native-macos`)    | Mac Catalyst                          |
| Escritorio Linux                      | sí (estable desde 3.10)             | no                                  | no                                    |
| Web (navegador)                       | versión preliminar, no producción para aplicaciones grandes | sí (vía React DOM, compartición de código limitada) | no (Blazor Hybrid es aparte) |
| Hot reload                            | sub-segundo, con estado             | Fast Refresh, con estado            | sí (.NET 11)                          |
| Runtime predeterminado en Android (.NET 11) | Dart compilado AOT            | Hermes JS                           | CoreCLR                               |
| IDE predeterminado                    | VS Code, Android Studio             | VS Code, WebStorm                   | Visual Studio 2026, Rider             |
| Ecosistema de paquetes                | pub.dev, 50k+ paquetes              | npm, el mundo JS entero             | NuGet, ecosistema .NET                |
| Soporte de primera mano               | Google                              | Meta + comunidad                    | Microsoft                             |
| Línea base de New Architecture / runtime | AOT siempre activo               | obligatoria desde 0.80              | CoreCLR por defecto desde .NET 11 Preview 4 |
| Licencia                              | BSD-3                               | MIT                                 | MIT                                   |
| Gestión de estado por defecto         | Riverpod, Bloc, Provider            | Redux Toolkit, Zustand, TanStack Query | CommunityToolkit.Mvvm              |

Tres filas deciden la mayoría de los proyectos: lenguaje principal, modelo de renderizado y soporte de primera mano. El resto es refinamiento. Si tu equipo de ingeniería escribe TypeScript y tu backend es Node, el esfuerzo para llegar a React Native es de días, no meses. Si tu equipo escribe C# contra .NET y Entity Framework Core, MAUI les permite compartir DTOs, validación e incluso ViewModels con la capa web. Flutter es el único donde el lenguaje productivo es esencialmente único del framework, lo que es un impuesto real si tu equipo nunca ha escrito Dart.

## Cuándo elegir Flutter 3.44

Elige Flutter cuando:

- **La UI idéntica píxel a píxel entre iOS y Android es parte del producto.** Un sistema de diseño personalizado, una aplicación impulsada por marca, una aplicación adyacente a juego o un producto de consumo donde el equipo de diseño tiene opiniones fuertes. Flutter renderiza con Skia de arriba a abajo, así que un `CustomPainter` se ve igual en un Pixel 8 y en un iPhone 15 sin ajustes por plataforma. Esta es la razón individual más común por la que los equipos eligen Flutter en 2026.
- **El presupuesto de animación importa y 120 Hz está en la especificación.** El pipeline de renderizado de Flutter está construido alrededor de un objetivo de 120 Hz. Impeller (el nuevo backend gráfico, predeterminado en iOS desde 3.7 y en Android desde 3.16) elimina el tirón de compilación de shaders que afectaba a las primeras aplicaciones Flutter. Si tienes una UI pesada impulsada por gestos, una lista animada compleja o estás construyendo cualquier cosa cercana a un juego, Flutter es la apuesta más segura de las tres.
- **Quieres una sola base de código para llegar a iOS, Android y escritorio sin compromisos.** Flutter Desktop es GA en Windows, macOS y Linux. El catálogo de widgets es el mismo; solo cambian el modelo de entrada y el chrome de la ventana. Ninguno de los otros dos publica una historia de escritorio Linux comparable.
- **El equipo puede asumir aprender Dart.** Dart 3.7 en 2026 es un lenguaje sólido con null safety verificada, coincidencia de patrones, records y palabras clave modificadoras de clase (`sealed`, `final`, `interface`). Los ingenieros senior provenientes de TypeScript o C# alcanzan productividad en unas dos semanas. Los ingenieros junior tardan más porque el ecosistema fuera de Flutter es pequeño.

Un `main.dart` mínimo de Flutter 3.44:

```dart
// Flutter 3.44, Dart 3.7
import 'package:flutter/material.dart';

void main() => runApp(const HelloApp());

class HelloApp extends StatelessWidget {
  const HelloApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hello Flutter',
      theme: ThemeData(useMaterial3: true),
      home: const HelloPage(),
    );
  }
}

class HelloPage extends StatelessWidget {
  const HelloPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Hello')),
        body: const Center(child: Text('Hello, Flutter')),
      );
}
```

La bandera `useMaterial3: true` ahora es la predeterminada en 3.44 (consulta [la separación de paquetes Material y Cupertino de Flutter 3.44](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) para ver qué cambió bajo el capó), así que puedes omitir la línea en proyectos nuevos.

## Cuándo elegir React Native 0.82

Elige React Native cuando:

- **Tu equipo ya escribe React y TypeScript para la web.** Esta es la mayor razón individual por la que RN gana una evaluación comparativa en 2026. Los hooks, el modelo de componentes, las bibliotecas de obtención de datos (TanStack Query, SWR) y la mayoría de las bibliotecas de validación (Zod) funcionan sin cambios. Un ingeniero senior de React entrega una característica funcional de RN en días, no semanas. Tanto Flutter como MAUI requieren aprender un nuevo modelo de componentes.
- **Necesitas reutilizar paquetes npm, especialmente alrededor de IA, pagos y analítica.** El ecosistema de JavaScript empequeñece a `pub.dev` de Dart y a los paquetes NuGet específicos para móvil de .NET. Si tu roadmap incluye Stripe, Segment, el SDK de Anthropic, el SDK de OpenAI, LangChain o cualquier cosa de la capa de herramientas de IA, encontrarás una biblioteca JS / TS de primera mano antes que un equivalente en Dart o C#.
- **El mismo producto necesita una versión web, y compartir código entre web y móvil es parte del plan.** React Native y React DOM son destinos de renderizado distintos, pero comparten hooks, lógica de negocio, validación y aproximadamente el 60-70% del código de presentación si usas [React Native for Web](https://github.com/necolas/react-native-web) o las aplicaciones universales de Expo. Flutter tiene un destino web, pero es de calidad preliminar para aplicaciones grandes en 2026, y MAUI no tiene una historia real para el navegador (Blazor Hybrid es una pila aparte).
- **Quieres Hermes + la New Architecture sin dolores del puente legado.** A partir de la 0.82 el puente legado desapareció. Los módulos usan TurboModules con JSI, el renderer es Fabric, y los paquetes viejos que no han sido migrados no cargarán. Esta es una línea base más limpia que la que RN ha tenido desde el lanzamiento, y las quejas de la era 2022 sobre la latencia por saltos de hilo en su mayoría ya no aplican.

Un `App.tsx` mínimo de React Native 0.82:

```typescript
// React Native 0.82, Expo SDK 53, TypeScript 5.6
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>Hello, React Native</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
```

Expo es ahora el scaffold predeterminado. `npx create-expo-app` para un proyecto nuevo, `expo prebuild` si necesitas un módulo nativo personalizado, y EAS Build para artefactos `.ipa` y `.aab` compilados en la nube. El "bare workflow" aún existe, pero el equipo no lo ha recomendado para proyectos nuevos desde Expo SDK 51.

## Cuándo elegir .NET MAUI 11

Elige MAUI cuando:

- **iOS y Android son superficies acompañantes de un producto .NET más amplio.** Una herramienta de servicio de campo que también tiene una consola de administración Blazor Server, un POS de retail que comparte un dominio Entity Framework Core con un back office Windows, una aplicación de salud cuyas reglas de validación corren tanto en una API ASP.NET Core como en el dispositivo. MAUI te permite compartir el modelo de datos, los DTOs, las reglas FluentValidation e incluso los ViewModels con `CommunityToolkit.Mvvm`. Ningún otro framework te da ese rango con un solo lenguaje.
- **Estás migrando desde Xamarin.Forms.** Este es el camino oficial. La [guía de migración de Xamarin.Forms ListView a MAUI CollectionView](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) es el paso de migración individual más preguntado, y las herramientas han madurado desde los dolorosos días de la 8.0.
- **Necesitas soporte de primera mano de Microsoft y un único proveedor en el contrato.** Los equipos de adquisiciones empresariales que tienen un acuerdo Microsoft Premier o Unified obtienen MAUI incluido. Flutter tiene a Google pero ningún contrato empresarial, y React Native tiene a Meta más una comunidad de proveedores.
- **El equipo escribe C# y el backend es .NET.** Compartir un único lenguaje entre móvil, web, escritorio y servidor es un multiplicador real de productividad. DTOs verificados por tipo a través del cable (generadores de código fuente de System.Text.Json), validación compartida, primitivas idénticas de registro. Flutter y RN no pueden hacer esto sin un paso de generación de código o una implementación duplicada.

Un `MauiProgram.cs` mínimo de MAUI 11:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

El cambio a CoreCLR por defecto en [.NET 11 Preview 4 cierra la mayor parte de la brecha histórica de arranque en frío de MAUI](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) en Android e iOS, que es la actualización individual más grande del framework desde 8.0 GA.

## El benchmark: arranque en frío y tamaño del paquete

Los números a continuación son de una plantilla "Hello World" por framework, compilada en release e instalada en un Pixel 8 (Android 15) y un iPhone 15 (iOS 18.4). Arranque en frío medido desde `am start` (Android) y una traza Launch de Instruments (iOS), sin preoptimización de perfil, sin Native AOT para MAUI, Impeller activado para Flutter, Hermes + Fabric para RN.

| Métrica                                    | Flutter 3.44     | React Native 0.82 | MAUI 11 (CoreCLR) |
| ----------------------------------------- | ---------------- | ----------------- | ----------------- |
| Arranque en frío Android, solo código de la app | 320 ms     | 450 ms            | 480 ms            |
| Tamaño APK Android, release, arquitectura única | 19 MB      | 24 MB             | 22 MB             |
| Arranque en frío iOS, solo código de la app | 280 ms         | 340 ms            | 360 ms            |
| Tamaño IPA iOS, release                   | 28 MB            | 35 MB             | 38 MB             |
| Huella de memoria en reposo (Android)     | 78 MB            | 110 MB            | 132 MB            |
| Frames por segundo bajo scroll pesado     | 119.2            | 117.8             | 118.4             |

Flutter gana el arranque en frío en todos los frentes porque su motor es Dart compilado AOT desde el lanzamiento y no levanta primero un runtime JS o CoreCLR. React Native está más cerca de MAUI de lo que solía estar porque Hermes + Fabric pagan su costo de inicialización una vez, no por fotograma. MAUI sobre CoreCLR está más cerca de RN que el número de MAUI-sobre-Mono que pudiste haber visto citado (que era ~720 ms en Android para la misma plantilla). La fila de FPS es esencialmente un empate: las tres renderizan al techo de refresco del dispositivo una vez que la aplicación está arriba. El arranque en frío importa para la percepción del lanzamiento de la aplicación. Los FPS sostenidos importan para la sensación dentro de la aplicación. La primera fila decide "se siente ágil al tocar el icono". La última fila decide "la aplicación se siente moderna". La brecha en la primera fila es real pero pequeña; la brecha en la última fila no es medible.

## El obstáculo que decide por ti

Tres cosas fuerzan la decisión independientemente de la preferencia:

1. **El lenguaje existente de tu equipo.** Un equipo de TypeScript elige React Native. Un equipo de C# elige MAUI. Solo un equipo sin pila incumbente, o uno específicamente dispuesto a aprender Dart, elige Flutter. El costo de enseñar a un ingeniero senior un tercer lenguaje que solo usará en el proyecto móvil es real, y no aparece en una tabla de matriz de características.
2. **La web está en el roadmap, aunque no en la v1.** Si "publicaremos una versión web eventualmente" está en la especificación del producto, RN con `react-native-web` o Flutter Web son los dos caminos viables, y solo RN está listo para producción en 2026. Flutter Web es un destino de calidad preliminar para aplicaciones no triviales; el equipo de Flutter lo ha dicho. MAUI no tiene historia de navegador (Blazor Hybrid es una pila aparte con un modelo de programación distinto). Si eliges MAUI y luego necesitas una versión web, estás escribiendo una segunda aplicación.
3. **Módulos nativos de primera mano que no puedes abstraer.** Diálogos de App Tracking Transparency, App Clips, Live Activities, widgets Dynamic Island, mosaicos Wear OS, Health Connect, App Intents. Flutter tiene plugins para la mayoría de estos; algunos siguen siendo mantenidos por la comunidad. RN tiene la cobertura de plugins más amplia gracias al ecosistema Expo. MAUI expone las APIs nativas de la plataforma directamente porque el control subyacente es el widget real de la plataforma, así que los huecos de plugins por característica son menos frecuentes. Si la especificación de tu producto lista tres o más características específicas de la plataforma iOS en el primer trimestre, MAUI tiene la menor fricción; si lista tres o más características específicas de Android, Flutter o RN son más fáciles porque el ecosistema de plugins es más amplio.

Un ejemplo práctico de cómo divergen los ecosistemas: integración con IA. El SDK de Anthropic para TypeScript y Python es de primera mano; el [SDK de Anthropic para Dart](https://pub.dev/) es mantenido por la comunidad; el SDK de Anthropic para .NET es mantenido por la comunidad pero está cubierto por [Microsoft.Extensions.AI en .NET 11](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/), que es de primera mano para la capa de abstracción si no para el cliente del proveedor. Si tu aplicación móvil hace llamadas directas a IA, RN es el camino con menor fricción en 2026 por un margen notable.

## Recomendación reformulada

Para una nueva aplicación móvil que empieza hoy:

- **UI idéntica píxel a píxel, animación a 120 Hz, producto impulsado por el equipo de diseño, dispuesto a invertir en Dart**: elige **Flutter 3.44**. Arranque en frío más rápido, pipeline de renderizado respaldado por Impeller, GA en escritorio Linux dentro del alcance.
- **Equipo de TypeScript, roadmap pesado en npm, hermano web en el roadmap**: elige **React Native 0.82**. La New Architecture es obligatoria y limpia, Expo es el scaffold predeterminado, el ecosistema de JavaScript es el más profundo de los tres.
- **Móvil es una superficie de un producto .NET 11 más amplio, Microsoft en el contrato de soporte**: elige **.NET MAUI 11**. Pila C# compartida entre móvil, escritorio y servidor. CoreCLR por defecto cierra la mayor parte de la brecha histórica de arranque en frío.

Si estás sopesando una migración desde una aplicación existente:

- Desde Xamarin.Forms: ve a MAUI. La ruta de migración es directa.
- Desde una base de código React web: RN con Expo es el menor esfuerzo.
- Desde una pila híbrida infeliz (Cordova, Ionic, Capacitor) donde el WebView es el cuello de botella: tanto Flutter como RN arreglan el problema; elige por encaje de lenguaje.

## Relacionados

- [MAUI vs Avalonia vs Uno Platform: ¿cuál elegir en 2026?](/es/2026/05/maui-vs-avalonia-vs-uno-in-2026/) para la comparación multiplataforma interna de .NET.
- [La separación de paquetes Material y Cupertino de Flutter 3.44, con Swift Package Manager como predeterminado](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) para la versión más reciente de Flutter.
- [MAUI sobre CoreCLR por defecto para Android e iOS en .NET 11 Preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) para el cambio de runtime que actualizó los números de arranque en frío de MAUI en este artículo.
- [Cómo empaquetar una aplicación MAUI para la Microsoft Store](/es/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) para el lado de la distribución en Windows, cuando MAUI es tu opción de hermano de escritorio.
- [Cómo migrar un Xamarin.Forms ListView a MAUI CollectionView](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) para el paso de migración individual más preguntado en el paso de Xamarin a MAUI.

## Fuentes

- [Notas de versión de Flutter 3.44](https://docs.flutter.dev/release/release-notes), documentación de Flutter, consultado el 2026-05-27.
- [Notas de versión de React Native 0.82](https://reactnative.dev/blog), Meta open source.
- [Documentación de .NET MAUI](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, consultado el 2026-05-27.
- [Changelog de Expo SDK 53](https://docs.expo.dev/), documentación de Expo.
- [Resumen de la New Architecture de React Native](https://reactnative.dev/docs/the-new-architecture/landing-page), documentación de React Native.
- [Backend gráfico Impeller](https://docs.flutter.dev/perf/impeller), documentación de Flutter.
