---
title: "Migra una aplicación Blazor con componentes enrutables en otro assembly de .NET 8 a .NET 10"
description: "Cómo actualizar una Blazor Web App cuyas páginas viven en una biblioteca de clases Razor o en un proyecto .Client de .NET 8 a .NET 10: qué se mantiene igual (los dos registros de AdditionalAssemblies) y las cuatro cosas que se rompen, desde un 404 en blazor.web.js en hosts delgados hasta páginas NotFoundPage que se muestran en blanco. Medido en ASP.NET Core 8.0.32 y 10.0.10."
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet-10"
  - "dotnet-8"
  - "aspnet-core"
  - "razor-class-library"
lang: "es"
translationOf: "2026/10/migrate-blazor-routable-components-from-another-assembly-dotnet-8-to-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-15
---

Si tu Blazor Web App de .NET 8 muestra páginas que viven en otro assembly (una biblioteca de clases Razor, un proyecto `.Client`, un módulo de funcionalidad), el contrato de enrutamiento no cambia en .NET 10: el lado del endpoint sigue necesitando `MapRazorComponents<App>().AddAdditionalAssemblies(...)` y el `Router` interactivo sigue necesitando su parámetro `AdditionalAssemblies`. Ejecuté la misma matriz de siete casos de registro en ASP.NET Core 8.0.32 y 10.0.10, y todos los casos dieron el mismo resultado. Lo que se rompe está alrededor: un host sin archivos `.razor` propios deja de servir `blazor.web.js`, un `NotFoundPage` que vive en la biblioteca muestra un 404 vacío a menos que la biblioteca esté registrada en el lado del endpoint, el antiguo fragmento `<NotFound>` está obsoleto, y el error "Assembly already defined" pasa de tu línea de `Program.cs` al arranque de la aplicación. En una solución típica con una o dos bibliotecas de páginas, la actualización toma menos de una hora. Todo lo que sigue se compiló con el SDK 10.0.302 y `Microsoft.AspNetCore.Components.Web` 10.0.13.

## Por qué dejar .NET 8 ahora

- **El soporte de .NET 8 termina el 10 de noviembre de 2026.** .NET 10 es la LTS actual y tiene soporte hasta noviembre de 2028. Después de esa fecha, las aplicaciones en .NET 8 dejan de recibir parches de seguridad.
- **`NotFoundPage` funciona entre assemblies.** .NET 10 puede mostrar una página enrutable de "no encontrado" desde tu biblioteca compartida para URL desconocidas, llamadas a `NavigationManager.NotFound()` y reejecución de códigos de estado, en lugar de un fragmento en línea duplicado en cada host.
- **Los recursos estáticos se versionan con huella y se comprimen.** `MapStaticAssets` (agregado en .NET 9) sirve los archivos `_content/...` de la biblioteca y el script de Blazor con compresión en tiempo de compilación y ETags, lo que ayuda a las bibliotecas de páginas que incluyen su propio CSS y JS.

## Qué cambia entre .NET 8 y .NET 10

| Área | Cambio | Gravedad |
| --- | --- | --- |
| Host sin archivos `.razor` | `blazor.web.js` es un recurso web estático en .NET 10 y solo se emite cuando el proyecto contiene un componente. Los hosts delgados obtienen un 404. | alta |
| `NotFoundPage` en una biblioteca | La página debe tener `@page` y su assembly debe pasarse a `AddAdditionalAssemblies`, o la respuesta 404 queda vacía | media |
| Fragmento `<NotFound>` | Es `[Obsolete]` y lanza una excepción si se combina con `NotFoundPage` | media |
| Referencia de paquete de la RCL | `Microsoft.AspNetCore.Components.Web` 8.0.x debe pasar a 10.0.x | baja |
| Registro duplicado de assembly | "Assembly already defined" se lanza durante el arranque, no en la llamada a `AddAdditionalAssemblies` | baja |
| Nombres de miembros en componentes de la biblioteca | `ComponentBase` incorporó `RendererInfo` y `AssignedRenderMode` en .NET 9; un miembro de componente con el mismo nombre ahora lo oculta (CS0108) | baja |
| `UseStaticFiles` | Sigue funcionando después de publicar, pero la guía de migración lo reemplaza por `MapStaticAssets` | baja |

## Los dos registros y qué controla cada uno

Esta es la parte que la mayoría de las migraciones hace mal, normalmente porque la aplicación Blazor Server de .NET 7 solo necesitaba uno de ellos. Una Blazor Web App tiene dos enrutadores. El enrutamiento de endpoints de ASP.NET Core atiende la primera solicitud HTTP (y cada solicitud de navegación mejorada) y necesita saber qué assemblies contienen componentes con `@page`. El componente `Router` de Blazor gestiona la navegación una vez que se ejecuta de forma interactiva, y construye su propia tabla de rutas a partir de `AppAssembly` más `AdditionalAssemblies`.

Esta es la configuración de prueba: un host creado con la plantilla `blazor` de .NET 8 con Interactive Server, y una biblioteca de clases Razor `Shared.Pages` con una página.

```razor
@* Shared.Pages/Pages/Reports.razor, .NET 8 and .NET 10 *@
@page "/reports"
@rendermode InteractiveServer

<h1>Reports (from Shared.Pages)</h1>
<p>Rendered from @GetType().Assembly.GetName().Name</p>
<button @onclick="() => count++">Clicked @count</button>

@code {
    int count;
}
```

Activé y desactivé cada registro y el modo de renderizado de `<Routes />` con variables de entorno, y luego solicité `/reports` directamente. Los resultados fueron idénticos en 8.0.32 y 10.0.10:

| `Router.AdditionalAssemblies` | `AddAdditionalAssemblies` | Modo de renderizado de `<Routes>` | `GET /reports` |
| --- | --- | --- | --- |
| sin definir | sin definir | estático | 404 |
| definido | sin definir | estático | 404 |
| sin definir | definido | estático | 200 |
| definido | definido | estático | 200 |
| definido | sin definir | `InteractiveServer` | 404 |
| sin definir | definido | `InteractiveServer` | 200, y luego "not found" cuando arranca el circuito |
| definido | definido | `InteractiveServer` | 200 |

La sexta fila es la que confunde. El servidor prerenderiza la página correctamente, el navegador la muestra un momento, y luego el `Router` interactivo toma el control, no encuentra `/reports` en su propia tabla de rutas y reemplaza la página con el contenido de no encontrado. Lo confirmé en un navegador en ambas versiones. La quinta fila es el error opuesto: el enrutador interactivo conoce la página, pero la primera solicitud nunca llega a ella, porque no existe ningún endpoint.

Así que la regla para ambas versiones es simple: **registra cada assembly que contenga componentes enrutables en ambos lugares.** Si el componente `Routes` vive en el proyecto del servidor, su `AdditionalAssemblies` también debe incluir el assembly `.Client`.

## Lista de verificación previa

1. SDK de .NET 10 instalado (`dotnet --list-sdks` muestra `10.0.1xx` o posterior; yo usé 10.0.302). Si un `global.json` fija 8.0, actualízalo.
2. Una lista de cada assembly que contiene componentes con `@page`. Usa `grep -rln "@page" --include=*.razor .` y agrupa los resultados por proyecto.
3. Cada lugar que los registra. `grep -rn "AdditionalAssemblies" --include=*.razor --include=*.cs .` debería mostrar un `Router` y una cadena `MapRazorComponents` por host. Si solo muestra uno, ya tienes el error de la matriz anterior.
4. Una lista de las URL que deben seguir funcionando, incluida una URL de cada biblioteca y una que deba dar 404. Les harás curl después de cada paso.

## Pasos de la migración

1. **Cambia el destino de cada proyecto y actualiza el paquete de la biblioteca.** Cambia `<TargetFramework>net8.0</TargetFramework>` a `net10.0` en el host, el proyecto `.Client` y cada biblioteca de clases Razor. La plantilla de RCL referencia `Microsoft.AspNetCore.Components.Web` como paquete, así que también necesita una versión nueva:

   ```xml
   <!-- Shared.Pages.csproj, .NET 10 -->
   <Project Sdk="Microsoft.NET.Sdk.Razor">
     <PropertyGroup>
       <TargetFramework>net10.0</TargetFramework>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <SupportedPlatform Include="browser" />
     </ItemGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.Components.Web" Version="10.0.13" />
     </ItemGroup>
   </Project>
   ```

   Si otras aplicaciones todavía consumen la biblioteca en .NET 8, haz que tenga varios destinos con `<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` y condiciona la versión del paquete a `$(TargetFramework)`. Verifica con `dotnet build` y lee las advertencias: un CS0108 en un componente de la biblioteca significa que declara un miembro que ahora oculta un miembro de `ComponentBase` (consulta los problemas frecuentes).

2. **Pon la lista de assemblies en un solo lugar y úsala en ambos registros.** La mayoría de los errores del tipo "la página funciona al refrescar pero no al hacer clic" vienen de dos listas que se desincronizan. Una pequeña clase estática elimina el desfase:

   ```csharp
   // Host/RoutableAssemblies.cs, .NET 10
   using System.Reflection;

   namespace Host;

   public static class RoutableAssemblies
   {
       // Do NOT include typeof(Program).Assembly: it is already the app assembly.
       public static readonly Assembly[] Additional =
       [
           typeof(Shared.Pages._Imports).Assembly,
           // typeof(Host.Client._Imports).Assembly,
       ];
   }
   ```

   ```csharp
   // Host/Program.cs, .NET 10
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   ```razor
   @* Host/Components/Routes.razor, .NET 10 *@
   <Router AppAssembly="typeof(Program).Assembly"
           AdditionalAssemblies="RoutableAssemblies.Additional"
           NotFoundPage="typeof(Shared.Pages.Pages.NotFound)">
       <Found Context="routeData">
           <RouteView RouteData="routeData" DefaultLayout="typeof(Layout.MainLayout)" />
           <FocusOnNavigate RouteData="routeData" Selector="h1" />
       </Found>
   </Router>
   ```

   Verifica con `curl -s -o /dev/null -w '%{http_code}' http://localhost:5000/reports`, que debe devolver `200` para una URL por biblioteca, y luego abre la misma URL en un navegador y espera a que arranque el circuito (o el runtime de WebAssembly). La página debe seguir ahí después.

3. **Reemplaza `<NotFound>` por un `NotFoundPage` enrutable.** En .NET 10 el fragmento de renderizado `NotFound` está marcado como `[Obsolete("NotFound is deprecated. Use NotFoundPage instead.")]`. Las notas de la versión van más lejos y dicen que "isn't supported in .NET 10 or later", pero en mi prueba el fragmento todavía se renderizaba en 10.0.10 cuando no se definía `NotFoundPage`, así que es una obsolescencia que puedes programar y no una interrupción. Definir ambos lanza `InvalidOperationException: Setting NotFound and NotFoundPage properties simultaneously is not supported`. La página necesita una ruta, porque el enrutador valida que tenga un atributo `[Route]`:

   ```razor
   @* Shared.Pages/Pages/NotFound.razor, .NET 10 *@
   @page "/not-found"

   <h1>Not found (from Shared.Pages)</h1>
   ```

   Luego agrega el middleware de reejecución de códigos de estado que usa la plantilla de .NET 10, para que las URL desconocidas de la primera solicitud HTTP también terminen en esa página:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
   app.UseAntiforgery();
   ```

   Verifica que `GET /missing` devuelva `404` con el `<h1>` de tu página en el cuerpo, y que `GET /not-found` devuelva `200`. Si el cuerpo del 404 está vacío, lee el siguiente paso.

4. **Registra el assembly de la página de no encontrado en el lado del endpoint.** La reejecución es una segunda solicitud a través del enrutamiento de endpoints hacia `/not-found`. Si la página vive en una biblioteca que solo conoce el `Router`, no hay un endpoint para ella. Medido en 10.0.10 con la página en `Shared.Pages`:

   | `AddAdditionalAssemblies(Shared.Pages)` | `GET /missing` | `GET /not-found` |
   | --- | --- | --- |
   | falta | 404, cuerpo vacío | 404, cuerpo vacío |
   | presente | 404, "Not found (from Shared.Pages)" | 200 |

   El paso 2 ya corrige esto si la biblioteca está en la lista compartida. Verifica con las mismas dos solicitudes.

5. **Cambia `UseStaticFiles` por `MapStaticAssets`.** La guía de migración de .NET 9 reemplaza `app.UseStaticFiles()` por `app.MapStaticAssets()`, y la plantilla de .NET 10 lo usa. Sirve los recursos de la biblioteca bajo `_content/Shared.Pages/...` con variantes `.br` y `.gz` precomprimidas. Comprobé que mantener `UseStaticFiles` en .NET 10 sigue sirviendo `blazor.web.js` desde una carpeta de publicación, así que no es obligatorio, pero es lo que espera el resto de la plantilla (`@Assets["..."]`, `<ResourcePreloader />`, `<ImportMap />`):

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseAntiforgery();
   app.MapStaticAssets();
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   Verifica que `GET /_framework/blazor.web.js` devuelva `200` y que una hoja de estilos de la biblioteca como `/_content/Shared.Pages/Shared.Pages.bundle.scp.css` se siga cargando.

6. **Si el host no tiene archivos `.razor`, fuerza la inclusión del script de Blazor.** Este es el fallo que solo afecta a las arquitecturas más limpias. Cuando `App.razor`, el layout y cada página viven en bibliotecas y el host es solo `Program.cs`, .NET 8 seguía sirviendo `blazor.web.js`, porque era un recurso incrustado en el shared framework. En .NET 10 el script es un recurso web estático que el SDK agrega solo si el proyecto contiene al menos un componente. Mi host delgado, medido desde una carpeta de publicación:

   | Host | `GET /reports` | `GET /_framework/blazor.web.js` |
   | --- | --- | --- |
   | .NET 8.0.32, `UseStaticFiles` | 200 | 200 |
   | .NET 10.0.10, `MapStaticAssets` | 200 | 404 |
   | .NET 10.0.10, `MapStaticAssets` + `RequiresAspNetWebAssets` | 200 | 200 |

   La página sigue prerenderizándose, y por eso es fácil pasarlo por alto: nada es interactivo, y la única señal es un 404 en la pestaña de red del navegador. La solución es una propiedad de MSBuild:

   ```xml
   <!-- Host.csproj, .NET 10, host project without any .razor file -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
   </PropertyGroup>
   ```

   Verifica que `publish/wwwroot/_framework/blazor.web.js` exista después de `dotnet publish`, y luego haz clic en algo interactivo en el navegador.

7. **Para páginas WebAssembly y Auto en una biblioteca, revisa también el lado `.Client`.** Nada de esto cambió entre 8 y 10, pero la migración es un buen momento para corregirlo. Una página de biblioteca con `@rendermode InteractiveWebAssembly` tiene que poder descargarse en el navegador, así que el proyecto `.Client` debe referenciar la biblioteca, y el servidor debe seguir listándola en `AddAdditionalAssemblies` para la primera solicitud. Si `Routes` se ejecuta en WebAssembly (interactividad global), vive en `.Client` y su `Router` necesita la biblioteca en `AdditionalAssemblies`. Verifica cargando una página WebAssembly directamente y luego navegando a ella desde otra página.

## Verificación

Ejecuta esto contra la aplicación publicada (`dotnet publish -c Release -o out`, y luego `dotnet out/Host.dll`), no contra `bin/`:

```bash
#!/usr/bin/env bash
# .NET 10 smoke test for routable components from other assemblies
BASE=http://localhost:5000
for u in /reports /not-found /missing /_framework/blazor.web.js; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u")"
done
```

Resultado esperado: `200`, `200`, `404`, `200`. Luego, en un navegador:

- Abre una página de la biblioteca directamente y espera dos segundos. No debe convertirse en la página de no encontrado.
- Navega de una página del host a una página de la biblioteca haciendo clic en un enlace, y de regreso.
- Dispara `NavigationManager.NotFound()` desde una página de la biblioteca si lo usas, y confirma que se muestra el `NotFoundPage`.
- Revisa la pestaña de red en busca de cualquier 404 en `_framework/` o `_content/`.

## Reversión

El cambio es reversible siempre que mantengas la biblioteca compatible. Si la biblioteca tiene varios destinos `net8.0;net10.0`, puedes devolver el host a `net8.0` revirtiendo su `.csproj`. Recuerda qué no existe en 8: `MapStaticAssets` (usa `UseStaticFiles`), `NotFoundPage` (usa el fragmento `<NotFound>`), el parámetro `createScopeForStatusCodePages` de `UseStatusCodePagesWithReExecute` y `RequiresAspNetWebAssets` (inofensivo pero sin uso). Mantén esos cambios en un commit separado del cambio de destino para que la reversión sea un revert limpio.

## Problemas frecuentes de las pruebas

**"Assembly already defined" se movió.** Agregar el assembly propio de la aplicación a `AddAdditionalAssemblies` siempre ha sido un error. En 8.0.32 la traza de pila apunta directamente a tu código:

```text
Unhandled exception. System.InvalidOperationException: Assembly already defined.
   at Microsoft.AspNetCore.Components.Discovery.ComponentApplicationBuilder.AddLibrary(...)
   at Microsoft.AspNetCore.Builder.RazorComponentsEndpointConventionBuilderExtensions.AddAdditionalAssemblies(...)
   at Program.<Main>$(String[] args) in .../Host/Program.cs:line 29
```

En 10.0.10 el registro se difiere hasta que los endpoints se construyen por primera vez, así que el mismo error se registra como `Application startup exception` desde `RazorComponentEndpointDataSource.UpdateEndpoints()`, y ningún frame menciona `Program.cs`. Si ves ese mensaje después de la actualización, busca `typeof(Program).Assembly` en tu lista de assemblies adicionales, o la misma biblioteca agregada dos veces desde dos métodos auxiliares.

**Las rutas duplicadas entre assemblies fallan al momento de la solicitud, no en el arranque.** Cuando el host y una biblioteca declararon ambos `@page "/reports"`, la aplicación arrancó bien en 10.0.10 y la solicitud devolvió `500` con `AmbiguousMatchException: The request matched multiple endpoints`. Solo falla la URL que colisiona, así que una prueba de humo que la omita pasará. La salida de `grep -rn '@page "' --include=*.razor` de la lista de verificación previa, ordenada por ruta, las encuentra antes de que lleguen a producción.

**Un miembro de la biblioteca llamado `RendererInfo` ahora oculta un miembro del framework.** Mi primera versión de la página de prueba tenía una propiedad `string RendererInfo`. Compilaba sin problemas en .NET 8 y produjo `warning CS0108: 'Reports.RendererInfo' hides inherited member 'ComponentBase.RendererInfo'` en .NET 10, porque `ComponentBase` incorporó `RendererInfo` y `AssignedRenderMode` en .NET 9. La advertencia es inofensiva hasta que un compañero lee `RendererInfo.IsInteractive` en ese componente y obtiene tu cadena en su lugar. Renombra el miembro.

**Mantener `UseStaticFiles` y probar desde `bin/` da un falso 404.** Con la canalización de .NET 8 intacta (`UseStaticFiles`, sin `MapStaticAssets`), ejecutar `dotnet bin/Release/net10.0/Host.dll` en el entorno Production devolvió 404 para `blazor.web.js` incluso en un host normal con componentes, mientras que lo mismo en .NET 8 devolvió 200. `UseStaticFiles` solo ve los archivos que están físicamente en `wwwroot`, y fuera de Development nada agrega los recursos web estáticos de los proyectos referenciados ni del SDK. En .NET 8 el script de Blazor venía de un recurso incrustado, así que no le afectaba; en .NET 10 es un recurso web estático. La misma ejecución desde `bin/` con `MapStaticAssets` devolvió 200, porque lee el manifiesto de endpoints generado, y la carpeta de publicación devolvió 200 con cualquiera de los dos middleware. Prueba desde una carpeta de `dotnet publish` o con `dotnet run`, o terminarás persiguiendo el problema equivocado.

**El prerenderizado oculta un registro faltante en el `Router`.** Como muestra la matriz, una página registrada solo en el lado del endpoint se renderiza perfectamente en `curl` y en pruebas automatizadas de instantáneas de HTML. El fallo aparece solo después de que arranca el enrutador interactivo. Cualquier prueba de extremo a extremo para páginas de biblioteca tiene que esperar a la interactividad, por ejemplo haciendo clic en un botón y comprobando el resultado.

## Relacionado

- Si todavía estás en el modelo de hospedaje de .NET 7, empieza por [migrar una aplicación Blazor Server a Blazor United](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), y luego vuelve para la parte de varios assemblies.
- Para saber en qué modo de renderizado se ejecuta realmente una página de biblioteca una vez enrutada, consulta [qué es un modo de renderizado de Blazor y cuál ejecuta mi componente](/es/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).
- Un fallo relacionado con recursos estáticos y una causa distinta: [404 Not Found para blazor.server.js después de instalar un nuevo SDK de .NET](/es/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).
- Si una página de biblioteca declara un modo de renderizado que su componente padre no puede alojar, te encontrarás con [el error "render mode is not supported by the parent component's render mode"](/es/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/).
- El diseño de proyectos detrás de `.Client` y `AddAdditionalAssemblies` se compara en [Blazor Server vs WebAssembly vs United](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Fuentes

- [Route to components from multiple assemblies](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) (Microsoft Learn, ASP.NET Core Blazor routing)
- [Migrate from ASP.NET Core in .NET 8 to ASP.NET Core in .NET 9](https://learn.microsoft.com/en-us/aspnet/core/migration/80-to-90), incluido "Replace UseStaticFiles with MapStaticAssets" (Microsoft Learn)
- [Migrate from ASP.NET Core in .NET 9 to ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/migration/90-to-100) (Microsoft Learn)
- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0): "Blazor router has a NotFoundPage parameter" y "Blazor script as static web asset"
- [Map static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/map-static-files) (Microsoft Learn)
- [ASP.NET Core Razor class libraries](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/class-libraries) (Microsoft Learn)
- [`Router.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Components/src/Routing/Router.cs), el origen de la validación de `NotFoundPage` y del parámetro obsoleto `NotFound` (dotnet/aspnetcore)
- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) para las fechas de fin de soporte de .NET 8 y .NET 10
