---
title: "Solución: HTTP Error 500.30 - ASP.NET Core app failed to start después de implementar en IIS"
description: "500.30 significa que tu aplicación lanzó una excepción durante el arranque dentro de w3wp.exe. La excepción real ya está en el registro de eventos de Aplicación de Windows bajo IIS AspNetCore Module V2. Léelo primero y luego ordena la solución: framework compartido faltante, discrepancia x86/x64 del grupo de aplicaciones, configuración faltante o permisos del grupo de aplicaciones."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "iis"
  - "deployment"
lang: "es"
translationOf: "2026/08/fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis"
translatedBy: "claude"
translationDate: 2026-08-05
---

`500.30` no es una causa, es IIS informando que el ASP.NET Core Module arrancó el CLR dentro de `w3wp.exe` y tu aplicación lanzó una excepción antes de poder empezar a escuchar. La excepción real casi con certeza ya está en el servidor: abre el Visor de eventos, ve a **Registros de Windows > Aplicación** y busca la entrada más reciente con origen **IIS AspNetCore Module V2**. Cuando `stdoutLogEnabled` es `false`, el módulo captura los errores de arranque y escribe hasta 30 KB de ellos en ese evento, con traza de pila incluida. Si la entrada solo te da `exception code = '0xe0434352'` y nada más, establece `stdoutLogEnabled="true"` en `web.config` y vuelve a solicitar el sitio. Todo lo que sigue es ordenar las cuatro cosas que realmente lo provocan.

```text
HTTP Error 500.30 - ASP.NET Core app failed to start
```

Las compilaciones más antiguas del ASP.NET Core Module muestran exactamente el mismo fallo como `HTTP Error 500.30 - ANCM In-Process Start Failure`, que sigue siendo la cadena que usa la documentación de Microsoft en sus tablas de errores. Ambas significan lo mismo. Todo lo que sigue está verificado contra .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`) con ANCM V2 del .NET Hosting Bundle actual. El mecanismo no ha cambiado desde que el hospedaje in-process pasó a ser el predeterminado en ASP.NET Core 3.0, así que cada paso se aplica sin cambios a implementaciones `net8.0`, `net9.0` y `net10.0`.

## Por qué 500.30 es un síntoma y no un diagnóstico

Desde ASP.NET Core 3.0, las aplicaciones usan de forma predeterminada el **modelo de hospedaje in-process**. La propiedad MSBuild `<AspNetCoreHostingModel>` toma el valor `InProcess` por defecto, y `dotnet publish` escribe `hostingModel="inprocess"` en `web.config`. En ese modelo no hay un proceso `dotnet.exe` aparte. `aspnetcorev2.dll` carga el manejador de solicitudes in-process dentro del proceso de trabajo de IIS, arranca CoreCLR ahí, y tu `Program.cs` se ejecuta dentro de `w3wp.exe` usando `IISHttpServer` en lugar de Kestrel.

Eso te da un proceso en vez de dos y una ganancia real de throughput, pero colapsa el reporte de errores. Cuando la aplicación lanza una excepción antes de que `app.Run()` llegue al estado de escucha, el módulo tiene un CLR muerto dentro de su propio proceso y un byte de información que dar al navegador: el arranque falló. De ahí un único código de estado que cubre una cadena de conexión faltante, un binario de 32 bits en un proceso de trabajo de 64 bits, un runtime no instalado y una `DirectoryNotFoundException` sobre un llavero de protección de datos.

Vale la pena interiorizar dos consecuencias antes de empezar a cambiar cosas:

- **`startupTimeLimit` no te reinicia.** Al hospedar in-process, si transcurre la ventana de arranque predeterminada de 120 segundos del módulo, el proceso se mata y *no* se relanza, y `rapidFailsPerMinute` no aplica. El hospedaje out-of-process reintenta en la siguiente solicitud. In-process no.
- **El grupo de aplicaciones no se puede compartir.** El hospedaje in-process requiere un grupo de aplicaciones por aplicación. Dos aplicaciones in-process en un mismo grupo producen `500.35`, y mezclar una in-process con una out-of-process en un grupo produce `500.34`.

## La reproducción mínima

La implementación más pequeña que lo reproduce es una aplicación que lee configuración que existe localmente y no en el servidor:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

string cs = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("Connection string 'Default' is missing.");

builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlServer(cs));

var app = builder.Build();
app.MapGet("/", () => "ok");
app.Run();
```

Localmente esto se ejecuta porque `appsettings.Development.json` tiene la sección y `ASPNETCORE_ENVIRONMENT` es `Development`. En el servidor el entorno es `Production`, `appsettings.Production.json` nunca se agregó a la salida de publicación, y la excepción ocurre en la línea 3. F5 funciona, la implementación da 500.30, y nada en la aplicación está mal.

Esa forma cubre una gran parte de los reportes reales de 500.30: el fallo es ambiental, así que por construcción es invisible en la máquina del desarrollador.

## Leer el registro de eventos de Aplicación, que normalmente cierra la investigación

Haz esto antes de tocar `web.config`. En el servidor, ejecuta el Visor de eventos como administrador y abre **Registros de Windows > Aplicación**, o consúltalo directamente:

```powershell
# Windows Server 2022+, PowerShell 5.1 or 7.x. Run elevated on the web server.
Get-WinEvent -FilterHashtable @{
    LogName      = 'Application'
    ProviderName = 'IIS AspNetCore Module V2'
} -MaxEvents 5 | Format-List TimeCreated, Id, LevelDisplayName, Message
```

Buscas una de tres formas.

**Forma 1, la útil.** Una traza de pila administrada completa. El módulo capturó tu excepción de arranque no controlada y la emitió al registro de eventos porque `stdoutLogEnabled` es `false`. Lee el tipo de excepción y el marco superior, corrige eso, y terminaste. Este es el caso que la gente se salta porque la página del navegador no le dijo nada y asumió que el servidor tampoco lo haría.

**Forma 2, la opaca:**

```text
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
hit unexpected managed exception, exception code = '0xe0434352'.
Please check the stderr logs for more information.
Application '/LM/W3SVC/5/ROOT' with physical root 'C:\inetpub\wwwroot\myapp\'
failed to load clr and managed application. CLR worker thread exited prematurely
```

`0xe0434352` es el código Win32 genérico para "escapó una excepción administrada", nada más. No lleva tipo ni mensaje. Esta es la firma documentada de una aplicación x86 en un grupo de aplicaciones que no tiene habilitadas las aplicaciones de 32 bits, pero también aparece cada vez que la excepción escapó por un lugar donde el módulo no pudo capturar el detalle. Pasa al registro stdout.

**Forma 3, nada en absoluto.** Ningún evento de ANCM dentro del minuto siguiente a tu solicitud. Eso normalmente significa que el módulo nunca llegó a arrancar el CLR, y en realidad estás ante `500.0`, `500.31` o `500.32` y no ante una excepción de arranque. Ve la sección de variantes al final.

## Activar el registro stdout

Edita el `web.config` implementado en el servidor, no el de tu proyecto. Se regenera con cada publicación, que es exactamente lo que quieres para un interruptor de diagnóstico temporal.

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Deployed web.config, ASP.NET Core Module V2, .NET 11 -->
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet"
                  arguments=".\MyApp.dll"
                  stdoutLogEnabled="true"
                  stdoutLogFile=".\logs\stdout"
                  hostingModel="inprocess" />
    </system.webServer>
  </location>
</configuration>
```

Guardar `web.config` recicla el grupo de aplicaciones, así que basta con volver a solicitar el sitio. El módulo crea por sí mismo la carpeta `logs` para `stdoutLogFile`, y escribe un archivo nombrado con una marca de tiempo y el ID de proceso, por ejemplo `stdout_20260805184032_5412.log`. La identidad del grupo de aplicaciones necesita acceso de escritura a esa carpeta:

```console
icacls "C:\inetpub\wwwroot\myapp\logs" /grant "IIS AppPool\MyAppPool":(OI)(CI)M
```

Tres notas de lectura que ahorran tiempo:

- **El archivo existe pero está vacío.** El proceso murió antes de escribir nada en stdout. Eso apunta a una discrepancia de arquitectura o a un fallo de carga nativa, no a tu código.
- **El archivo tiene líneas normales de arranque y luego se detiene.** Lo que se ejecuta inmediatamente después de la última línea es tu sospechoso.
- **Vuelve a apagarlo.** `stdoutLogEnabled="true"` escribe un archivo nuevo por cada reciclaje de proceso para siempre, y la documentación es explícita en que dejarlo activo puede tumbar la aplicación o el servidor. Ponlo de nuevo en `false` cuando tengas tu respuesta.

Si stdout sigue en silencio, el fallo está por debajo del código administrado. Agrega el registro de depuración del propio módulo:

```xml
<!-- ASP.NET Core Module V2 diagnostic logging. Remove after troubleshooting. -->
<aspNetCore processPath="dotnet"
            arguments=".\MyApp.dll"
            stdoutLogEnabled="false"
            stdoutLogFile=".\logs\stdout"
            hostingModel="inprocess">
  <handlerSettings>
    <handlerSetting name="debugFile" value=".\logs\aspnetcore-debug.log" />
    <handlerSetting name="debugLevel" value="FILE,TRACE" />
  </handlerSettings>
</aspNetCore>
```

A diferencia de `stdoutLogFile`, el módulo **no** crea carpetas para `debugFile`. El directorio `logs` debe existir ya y ser escribible por la identidad del grupo, o no obtienes nada y sacas la conclusión equivocada. Este registro muestra la resolución de hostfxr, qué versiones del framework se consideraron y qué DLL falló al cargar.

## Solución 1: la aplicación lanzó una excepción durante el arranque, que es la mayoría de los casos

Si el registro de eventos o el registro stdout te dio una traza de pila, este eres tú. La agrupación en la práctica:

1. **Configuración presente localmente y ausente en el servidor.** `appsettings.Production.json` fuera de la salida de publicación, un valor de User Secrets que nunca tuvo equivalente en producción, una variable de entorno definida solo en tu máquina. Este es el [fallo de cadena de conexión faltante](/es/2026/05/fix-no-connection-string-named-defaultconnection/) en su forma de implementación.
2. **Fallos del grafo de DI en `builder.Build()`.** ASP.NET Core valida los ámbitos y el grafo de servicios al compilar en Development, y cualquier problema de `Unable to resolve service for type` o de dependencia cautiva aparece como un 500.30 en lugar de una página útil. Ve [unable to resolve service for type while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) y [cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
3. **Dependencias externas contactadas durante el arranque.** Key Vault con una directiva de acceso que no cubre la identidad administrada del grupo de aplicaciones es el caso que Microsoft menciona por nombre para 500.30. Una migración ejecutada al arrancar, un proveedor de configuración que llega a una base de datos, una descarga del documento de descubrimiento OIDC en un servidor sin salida a internet: todos convierten un problema de red en un fallo de arranque.
4. **Acceso a certificados y a protección de datos.** Cargar un certificado X.509 desde el almacén de la máquina, o persistir un llavero de protección de datos en una ruta que la identidad del grupo no puede escribir, lanza una excepción antes de la primera solicitud.

La solución estructural para toda esta categoría es hacer que los fallos de arranque sean explícitos y legibles en lugar de accidentales. Validar la configuración al arrancar con [`IValidateOptions<T>` y `ValidateOnStart`](/es/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) convierte "la aplicación da 500.30" en una `OptionsValidationException` con nombre que lista exactamente qué opciones faltan, que es la diferencia entre una corrección de cinco minutos y una tarde entera.

Para obtener la excepción cruda en el navegador en una máquina de staging, agrega la variable de entorno a `web.config`, y nunca hagas esto en un servidor público:

```xml
<!-- Staging and test servers only. Do not ship this to an internet-facing host. -->
<aspNetCore processPath="dotnet" arguments=".\MyApp.dll" hostingModel="inprocess">
  <environmentVariables>
    <environmentVariable name="ASPNETCORE_ENVIRONMENT" value="Development" />
    <environmentVariable name="ASPNETCORE_DETAILEDERRORS" value="true" />
  </environmentVariables>
</aspNetCore>
```

## Solución 2: el framework compartido al que apunta la aplicación no está instalado

Microsoft lista esto primero entre las causas de 500.30: la aplicación apunta a una versión del framework compartido de ASP.NET Core que no está presente. Revisa qué tiene el servidor realmente:

```console
dotnet --list-runtimes
```

Quieres una línea `Microsoft.AspNetCore.App` cuya versión mayor coincida con tu `TargetFramework`, y la quieres en la misma arquitectura que el grupo de aplicaciones. Si la aplicación es `net11.0` y el servidor llega como máximo a `Microsoft.AspNetCore.App 10.0.x`, esa es tu respuesta, porque ASP.NET Core no hace roll forward entre versiones mayores de forma predeterminada.

Instala el **.NET Hosting Bundle**, que instala el runtime, el framework compartido de ASP.NET Core y ANCM en un solo paquete. Dos reglas de instalación causan más 500.30 que la descarga misma:

- **IIS debe estar instalado antes que el Hosting Bundle.** Si el bundle se instaló primero, volver a ejecutar el instalador para repararlo es obligatorio, no opcional.
- **Reinicia el servidor web después de instalar.** El instalador cambia el `PATH` del sistema, y ASP.NET Core tampoco hace roll forward para versiones de parche de los paquetes del framework compartido, así que el mismo reinicio es necesario tras cada actualización del bundle:

```console
net stop was /y
net start w3svc
```

Un `iisreset` completo también funciona. Saltarse este paso es la razón por la que "instalé el runtime y sigue fallando" es un seguimiento tan común.

## Solución 3: la aplicación y el grupo de aplicaciones no coinciden en arquitectura

El hospedaje in-process requiere que la arquitectura de la aplicación y del runtime instalado coincida con la arquitectura del grupo de aplicaciones. No hay capa de adaptación. Un binario de 32 bits no puede arrancar CoreCLR dentro de un `w3wp.exe` de 64 bits.

En el Administrador de IIS, selecciona el grupo de aplicaciones, elige **Configuración avanzada** y establece **Habilitar aplicaciones de 32 bits**:

- `True` para una aplicación x86, incluida una implementación autocontenida x86 publicada con un SDK de 32 bits.
- `False` para una aplicación x64.

O desde la línea de comandos:

```console
%windir%\system32\inetsrv\appcmd set apppool /apppool.name:MyAppPool /enable32BitAppOnWin64:false
```

Ya que estás ahí, establece **Versión de .NET CLR** en **Sin código administrado** en la Configuración básica. ASP.NET Core arranca CoreCLR por sí mismo y nunca necesita el CLR de escritorio cargado en el proceso de trabajo. Está documentado como opcional pero recomendado, y elimina toda una clase de interacciones confusas con módulos heredados.

Una trampa específica del Hosting Bundle: si lo instalaste con `OPT_NO_X86=1` no tienes ningún runtime de 32 bits en esa máquina, y una aplicación x86 fallará sin importar cómo esté configurado el grupo.

## Solución 4: la identidad del grupo de aplicaciones no puede leer lo que necesita

La `ApplicationPoolIdentity` predeterminada es una cuenta virtual, y cada 500.30 causado por permisos se ve idéntico a cualquier otro 500.30. Si la identidad se cambió de `ApplicationPoolIdentity` a una cuenta de dominio o de servicio, verifica que tenga acceso de lectura a la carpeta de implementación y de escritura a cualquier lugar donde la aplicación escriba. Otorga sobre la carpeta usando el nombre del grupo:

```console
icacls "C:\inetpub\wwwroot\myapp" /grant "IIS AppPool\MyAppPool":(OI)(CI)RX
```

Dos casos que conviene revisar directamente: leer la clave privada de un certificado desde el almacén de la máquina requiere una ACL sobre el contenedor de claves, y cualquier código que toque `%USERPROFILE%` necesita **Cargar perfil de usuario** en `True` en el grupo de aplicaciones. Está en `True` de forma predeterminada y se desactiva con frecuencia en entornos endurecidos.

## Reduce la superficie a la mitad ejecutando la aplicación fuera de IIS

Antes de gastar otra hora en configuración de IIS, inicia sesión en el servidor, abre una consola en la carpeta de implementación y ejecuta la aplicación directamente:

```console
cd C:\inetpub\wwwroot\myapp
set ASPNETCORE_ENVIRONMENT=Production
dotnet MyApp.dll
```

La excepción se imprime en la consola con una traza de pila completa y sin necesidad de configurar registro. Si lanza aquí, el problema es tu aplicación o su configuración e IIS es inocente, lo que te lleva directo a la Solución 1. Si arranca limpio y sirve en `http://localhost:5000`, el problema es la capa de hospedaje: arquitectura, permisos o el módulo, lo que te lleva a la Solución 2, 3 o 4. Ese único comando decide qué mitad de este artículo necesitas.

Fíjate en la variable de entorno. Ejecutar bajo tu propia cuenta con tu propio entorno no es lo mismo que ejecutar como la identidad del grupo, así que una ejecución limpia aquí no demuestra que los permisos de archivos sean correctos. Demuestra que el código y los archivos de configuración implementados lo son.

## Los códigos vecinos que no son 500.30

El tráfico de búsqueda de 500.30 acumula muchos casos parecidos. Si tu página dice otra cosa, es un problema distinto con una solución distinta:

- **`500.0 - ANCM In-Process Handler Load Failure`**: el módulo no pudo cargar el manejador de solicitudes in-process en absoluto. `processPath` incorrecto, Hosting Bundle no instalado, IIS no reiniciado tras instalarlo, o falta el redistribuible de VC++.
- **`500.31 - ANCM Failed to Find Native Dependencies`**: `Microsoft.NETCore.App` o `Microsoft.AspNetCore.App` no está instalado. El registro de eventos nombra el framework y la versión exactos que no se encontraron. Instálalo, cambia el target o publica autocontenido.
- **`500.32 - ANCM Failed to Load dll`**: discrepancia de arquitectura del procesador, la misma causa raíz que la Solución 3 emergiendo una capa más abajo.
- **`500.33 - ANCM Request Handler Load Failure`**: la aplicación no referencia el framework `Microsoft.AspNetCore.App`. Revisa `.runtimeconfig.json`. Una aplicación de consola con `Microsoft.NET.Sdk` en vez de `Microsoft.NET.Sdk.Web` produce esto.
- **`500.34` y `500.35`**: modelos de hospedaje mezclados, o dos aplicaciones in-process, en un mismo grupo de aplicaciones. Sepáralas en grupos distintos.
- **`500.36 - ANCM Out-Of-Process Handler Load Failure`**: falta `aspnetcorev2_outofprocess.dll` junto a `aspnetcorev2.dll`. Repara el Hosting Bundle.
- **`500.37 - ANCM Failed to Start Within Startup Time Limit`**: el arranque superó los 120 segundos. Sube `startupTimeLimit`, o escalona el arranque de muchas aplicaciones que compiten por CPU en la misma máquina.
- **`500.38 - ANCM Application DLL Not Found`**: publicaste un ejecutable de archivo único y el hospedaje in-process no lo admite. Establece `<PublishSingleFile>false</PublishSingleFile>` o cambia a `<AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>`.
- **`502.5 - Process Failure`**: solo hospedaje out-of-process. El proceso backend no arrancó o no escuchó en `%ASPNETCORE_PORT%`. Frecuentemente una `BadImageFormatException` por una discrepancia de RID, visible en el registro stdout.
- **`500.19`**: un error de configuración de IIS al leer el propio `web.config`, normalmente porque ANCM no está registrado o la configuración está malformada. La aplicación nunca entró en escena.

Cambiar a hospedaje out-of-process es un movimiento de diagnóstico legítimo más que una solución. Poner `hostingModel="outofprocess"` en `web.config` recicla el proceso de trabajo y ejecuta tu aplicación como un `dotnet.exe` hijo, donde los fallos de arranque son mucho más fáciles de observar y `requestTimeout` y `rapidFailsPerMinute` vuelven a aplicar. Úsalo para obtener un error legible, y luego vuelve a in-process por el rendimiento.

La forma general de una investigación de 500.30 es corta si la tomas en orden: registro de eventos, luego ejecutarla desde la consola, luego arquitectura y runtime. Solo se convierte en una tarde larga cuando empiezas por la página del navegador e intentas adivinar.

## Relacionado

- [Fix: Unable to resolve service for type X while attempting to activate Y](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) es la excepción administrada más común escondida detrás de un 500.30.
- [Fix: Cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) cubre el otro fallo de DI que solo aparece una vez construido el contenedor.
- [Cómo validar opciones al arrancar con IValidateOptions&lt;T&gt; en .NET 11](/es/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) convierte "la aplicación no arrancó" en una excepción con nombre que dice qué opción está mal.
- [Fix: No connection string named 'DefaultConnection' could be found](/es/2026/05/fix-no-connection-string-named-defaultconnection/) es el hueco de configuración clásico que sobrevive hasta la implementación.
- [Fix: Could not load file or assembly en una aplicación publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) trata los problemas de salida de publicación que aparecen como un fallo de arranque.
- [Migrar de .NET 8 a .NET 11: la lista completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) incluye el paso de actualización del Hosting Bundle que un salto de versión mayor exige en cada servidor IIS.

## Fuentes

- [Troubleshoot ASP.NET Core on Azure App Service and IIS](https://learn.microsoft.com/en-us/aspnet/core/test/troubleshoot-azure-iis) en MS Learn, para las definiciones de 500.30 a 500.38, el registro stdout y el registro de depuración de ANCM.
- [Common error troubleshooting for Azure App Service and IIS with ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/azure-iis-errors-reference) para las cadenas literales del registro de Aplicación, incluida la firma `0xe0434352`.
- [ASP.NET Core Module (ANCM) for IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/aspnet-core-module) para los atributos del elemento `aspNetCore`, sus valores predeterminados y las características del hospedaje in-process.
- [Host ASP.NET Core on Windows with IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/) para el orden de instalación del Hosting Bundle, `net stop was /y` y la configuración del grupo de aplicaciones.
- [Install the .NET Hosting Bundle](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/hosting-bundle) para las opciones del instalador, incluida `OPT_NO_X86`.
