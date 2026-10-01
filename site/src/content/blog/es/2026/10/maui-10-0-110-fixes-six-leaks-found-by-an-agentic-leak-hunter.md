---
title: ".NET MAUI 10.0.110 corrige seis fugas de memoria encontradas por un cazador de fugas agéntico"
description: "MAUI 10.0.110 incluye seis correcciones de fugas para BackButtonBehavior, SwipeItemView, ListView.RefreshCommand, IndicatorView, GeometryGroup y TableView. La mayoría fueron reportadas y corregidas por workflows de gh-aw, y importan sobre todo si usas RelayCommand de CommunityToolkit.Mvvm."
pubDate: 2026-10-01
tags:
  - "maui"
  - "dotnet"
  - "memory-leaks"
  - "mvvm"
lang: "es"
translationOf: "2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter"
translatedBy: "claude"
translationDate: 2026-10-01
---

[.NET MAUI 10.0.110](https://github.com/dotnet/maui/releases/tag/10.0.110) llegó el 22 de septiembre de 2026 con 181 commits. Al leer las notas de la versión salta a la vista un patrón: seis entradas con el prefijo `[leak-fix]`, cinco de ellas escritas por `github-actions[bot]`. El equipo de MAUI ahora ejecuta dos workflows agénticos, un "Daily Memory Leak Hunter" que abre issues `[leak-scan]` y un "Memory Leak Fixer" que abre PRs contra ellos, y 10.0.110 es la primera versión de servicio en la que su producción se publica en bloque.

## Las seis fugas

- `BackButtonBehavior.Command` (Shell), [#36345](https://github.com/dotnet/maui/issues/36345)
- `SwipeItemView.Command`, [#36343](https://github.com/dotnet/maui/issues/36343)
- `ListView.RefreshCommand`, [#36344](https://github.com/dotnet/maui/issues/36344)
- `IndicatorView` enlazado a un `ObservableCollection` compartido, [#35775](https://github.com/dotnet/maui/issues/35775)
- `GeometryGroup.Children` con un `GeometryCollection` compartido, [#36365](https://github.com/dotnet/maui/issues/36365)
- `TableView.Root` con un `TableRoot` compartido, [#36355](https://github.com/dotnet/maui/issues/36355)

Las seis tienen la misma forma de error: un control se suscribe a un evento de algo que vive más que él, con un delegado fuerte y sin liberar la suscripción al descargarse.

## Por qué tu aplicación pudo verse afectada aunque las pruebas de MAUI no

Las tres fugas de comandos son las más interesantes. `BackButtonBehavior` hacía esto:

```csharp
newCommand.CanExecuteChanged += CanExecuteChanged;
```

y solo cancelaba la suscripción cuando la propiedad `Command` volvía a cambiar. La propia clase `Command` de MAUI emite `CanExecuteChanged` a través de un `WeakEventManager`, así que nunca producía fugas. Pero `CommunityToolkit.Mvvm.Input.RelayCommand`, y cualquier `ICommand` escrito a mano con un `event EventHandler` simple, mantiene una referencia fuerte. Si ese comando vive en un servicio singleton o en un view model reutilizado, cada página que lo enlazó a un botón de retroceso quedaba retenida después de navegar:

```text
ICommand (singleton / DI / static / reused VM)
  -> CanExecuteChanged (strong delegate)
     -> BackButtonBehavior
        -> attached page context
```

La corrección, en el [PR #36370](https://github.com/dotnet/maui/pull/36370), enruta la suscripción a través del helper interno `WeakCommandSubscription` que `Button`, `ImageButton` y `RefreshView` ya usaban:

```csharp
WeakCommandSubscription _commandSubscription;

void OnCommandChanged(ICommand oldCommand, ICommand newCommand)
{
    _commandSubscription?.Dispose();
    _commandSubscription = null;

    if (newCommand != null)
    {
        _commandSubscription = new WeakCommandSubscription(this, newCommand, CanExecuteChanged);
        IsEnabledCore = Command.CanExecute(CommandParameter);
    }
    else
    {
        IsEnabledCore = true;
    }
}
```

`WeakCommandSubscription` usa un `DependentHandle`, de modo que el comando referencia al control solo de forma débil. No cambió ninguna API pública.

## Cómo lo demostraron los bots

Cada issue `[leak-scan]` incluye un repro independiente contra el paquete publicado `Microsoft.Maui.Controls` en un `net10.0` simple, sin emulador. Instala un `IDispatcherProvider` de prueba mediante `[ModuleInitializer]` para poder construir controles sin interfaz, asigna 30 controles con una carga de 1 MB cada uno, los descarta, fuerza varios ciclos de GC y cuenta los `WeakReference` que sobreviven. Después, el PR del corrector amplía la theory existente `CommandsSubscribedToCanExecuteCollect` en `CommandTests.cs` y publica una ejecución en rojo (sin parche, el comportamiento sigue vivo) junto a una en verde. Es un rastro de evidencia mejor que el de la mayoría de las correcciones de fugas escritas por humanos.

El mismo harness es una buena plantilla para tus propios controles: si escribes una vista personalizada que se suscribe a un `ICommand` enlazable o a `INotifyCollectionChanged`, una prueba de xunit de 40 líneas detecta la fuga antes de que haga falta una captura del heap.

## Qué hacer

Actualiza el paquete:

```xml
<PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
```

Si lo resolvías manualmente con `Command = null` en `OnDisappearing`, puedes eliminar ese código tras actualizar. Si usas `RelayCommand` en view models de larga vida con `SwipeView`, el pull-to-refresh de `ListView` o los botones de retroceso de Shell, actualiza primero y mide después: parte de tus reportes de "MAUI pierde memoria al navegar" probablemente eran estas fugas.

Para la versión de servicio anterior de MAUI 10, consulta [MAUI 10.0.100 y UsePlatformHandler](/es/2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends/).
