---
title: "Solución: The antiforgery token could not be decrypted en ASP.NET Core"
description: "El error significa que Data Protection perdió la clave que firmó el token. Persiste las claves en un almacén compartido y duradero y llama a SetApplicationName para que cada instancia lea el mismo conjunto de claves."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
lang: "es"
translationOf: "2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-12
---

The antiforgery token could not be decrypted porque la clave de Data Protection que lo firmó ya no está en el conjunto de claves que tu aplicación está leyendo. De forma predeterminada, ASP.NET Core escribe esas claves en una carpeta por máquina y por usuario que no sobrevive al reinicio de un contenedor y no se comparte entre instancias. Persiste las claves en un almacén duradero que toda instancia pueda leer (recurso compartido de archivos, base de datos, Azure Blob, Redis) y fija `SetApplicationName` con el mismo valor en todas partes. Esa es la solución completa. El resto de este artículo explica por qué ocurre y el código exacto para cada almacén.

Esto aplica a ASP.NET Core 11 (`.NET 11`), pero el mismo stack de Data Protection y la misma solución se remontan a ASP.NET Core 2.x.

## El error en contexto

Verás uno de estos, normalmente en un POST justo después de un despliegue, un escalado horizontal o el reinicio de un contenedor:

```
Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException: The antiforgery token could not be decrypted.
 ---> System.Security.Cryptography.CryptographicException: The key {0cf0e637-...} was not found in the key ring.
   at Microsoft.AspNetCore.DataProtection.KeyManagement.KeyRingBasedDataProtector.UnprotectCore(...)
   at Microsoft.AspNetCore.Antiforgery.DefaultAntiforgeryTokenSerializer.Deserialize(String serializedToken)
```

La excepción interna es la pista clave. `The key {guid} was not found in the key ring` significa que el token hace referencia a una clave que esta instancia nunca ha visto. Un mensaje interno distinto, `The payload was invalid`, apunta a una clave que existe pero no puede descifrar este token concreto, lo que normalmente significa que dos aplicaciones comparten un conjunto de claves sin un nombre de aplicación coincidente (más sobre esto abajo).

En Blazor y Razor Pages la misma causa raíz se manifiesta como un HTTP 400 con `Bad Request - antiforgery token validation failed`, y en MVC como un bucle de redirección en el inicio de sesión porque la cookie de antiforgery nunca puede validarse.

## Por qué ocurre

Los tokens de antiforgery son cifrados y firmados por ASP.NET Core Data Protection. La validación solo funciona si la instancia que lee el token todavía conserva la clave que lo escribió. Hay cuatro formas de perder esa clave:

- **Las claves son efímeras.** Sin configuración explícita, Data Protection persiste las claves en `%LOCALAPPDATA%\ASP.NET\DataProtection-Keys` (Windows) o `$HOME/.aspnet/DataProtection-Keys` (Linux). En un contenedor esa ruta vive dentro de la capa de escritura y se borra en cada reinicio, así que cada contenedor nuevo genera un conjunto de claves fresco y rechaza todos los tokens emitidos por el anterior.
- **Escalaste horizontalmente.** Dos o más instancias detrás de un balanceador de carga generan cada una su propio conjunto de claves. Un token emitido por la instancia A llega a la instancia B, cuyo conjunto no contiene la clave de A. Esta es la causa más común en producción.
- **La identidad cambió.** Al ejecutarse bajo IIS, el reciclaje del grupo de aplicaciones o un cambio de identidad mueve la carpeta de claves, porque la ruta predeterminada está vinculada al usuario. Los slots de despliegue de Azure App Service tienen el mismo efecto: el slot de staging y el de producción no comparten claves a menos que se lo indiques.
- **Dos aplicaciones, un conjunto, sin nombre de aplicación.** Cuando varias aplicaciones apuntan al mismo almacén pero no establecen un `SetApplicationName` coincidente, sus tokens colisionan. Data Protection aísla por discriminador de aplicación, así que un desajuste produce `The payload was invalid`.

La vida útil predeterminada de las claves es de 90 días, así que la rotación legítima de claves casi nunca causa esto. Si lo ves, la clave falta, no ha expirado.

## Reproducción mínima

Esta es la aplicación más pequeña que reproduce el error a través de un reinicio. Ejecútala, envía el formulario y luego reinicia el proceso antes de enviarlo de nuevo.

```csharp
// .NET 11, ASP.NET Core 11
// No Data Protection configuration: keys are ephemeral.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();

app.MapGet("/", (HttpContext ctx, IAntiforgery af) =>
{
    var tokens = af.GetAndStoreTokens(ctx);
    return Results.Content($"""
        <form action="/submit" method="post">
          <input name="{tokens.FormFieldName}" type="hidden" value="{tokens.RequestToken}" />
          <button type="submit">Submit</button>
        </form>
        """, "text/html");
});

app.MapPost("/submit", () => "OK").RequireAntiforgery();

app.Run();
```

Carga `/`, copia el formulario renderizado, reinicia la aplicación y luego haz POST del formulario antiguo. Como el conjunto de claves en memoria se regeneró en el reinicio, el token ya no se descifra y obtienes `AntiforgeryValidationException`. En un único proceso de larga duración no lo verás, que es exactamente por qué esto se escapa en las pruebas locales y solo aparece en contenedores y granjas.

## La solución, en detalle

Elige el almacén que coincida con dónde ejecutas. En todos los casos la regla es la misma: una ubicación que todas las instancias puedan leer y escribir, más un nombre de aplicación estable.

### 1. Recurso compartido de archivos (UNC o volumen montado): lo más simple para VMs y hardware dedicado

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(@"\\fileserver\dpkeys\myapp"))
    .SetApplicationName("MyApp");
```

En Kubernetes, monta un `PersistentVolume` compartido (ReadWriteMany) y apunta `PersistKeysToFileSystem` a la ruta de montaje. Las claves entonces sobreviven a cualquier pod individual. Esta es la solución de menor fricción cuando ya tienes almacenamiento compartido.

### 2. Base de datos vía EF Core: sin infraestructura extra si ya tienes una base de datos

Agrega el paquete [`Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`](https://www.nuget.org/packages/Microsoft.AspNetCore.DataProtection.EntityFrameworkCore/) y un contexto que implemente `IDataProtectionKeyContext`:

```csharp
// .NET 11, EF Core 11
public class KeysDbContext : DbContext, IDataProtectionKeyContext
{
    public KeysDbContext(DbContextOptions<KeysDbContext> options) : base(options) { }
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
}
```

```csharp
// Program.cs
builder.Services.AddDbContext<KeysDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Keys")));

builder.Services.AddDataProtection()
    .PersistKeysToDbContext<KeysDbContext>()
    .SetApplicationName("MyApp");
```

Ejecuta una migración que cree la tabla `DataProtectionKeys` una vez, y cada instancia leerá el mismo conjunto. Esta es la opción a la que recurro más a menudo porque no necesita nada que la aplicación no tenga ya.

### 3. Azure Blob Storage: la opción limpia para App Service y Azure Container Apps

Agrega [`Azure.Extensions.AspNetCore.DataProtection.Blobs`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Blobs). Usa una identidad administrada en lugar de una cadena de conexión:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToAzureBlobStorage(
        new Uri("https://mystorage.blob.core.windows.net/dpkeys/keys.xml"),
        new DefaultAzureCredential())
    .SetApplicationName("MyApp");
```

Esto también soluciona la variante de slots de despliegue: cuando staging y producción apuntan al mismo blob, intercambiar slots ya no invalida las sesiones activas. Para defensa en profundidad, envuélvelo con `ProtectKeysWithAzureKeyVault` (paquete [`Azure.Extensions.AspNetCore.DataProtection.Keys`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Keys)) para que el propio conjunto de claves esté cifrado en reposo.

### 4. Redis: la menor latencia para granjas grandes

Agrega `Microsoft.AspNetCore.DataProtection.StackExchangeRedis` y reutiliza el multiplexor que ya usas para caché:

```csharp
// .NET 11, ASP.NET Core 11
var redis = ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis")!);
builder.Services.AddDataProtection()
    .PersistKeysToStackExchangeRedis(redis, "DataProtection-Keys")
    .SetApplicationName("MyApp");
```

Sea cual sea el almacén que elijas, `SetApplicationName` no es opcional en un escenario de múltiples aplicaciones o slots. Establece el discriminador de aplicación que Data Protection mezcla en la derivación de la clave, y el valor debe ser idéntico byte a byte en cada instancia y slot que deba confiar en los tokens de los demás.

## Detalles y variantes

**`The payload was invalid` en lugar de `key not found`.** La clave existe pero el discriminador de aplicación difiere. Dos aplicaciones comparten un almacén, y a una le falta `SetApplicationName` o tiene un valor distinto. Establece el mismo nombre en ambas. Esto también es por qué copiar una aplicación publicada a una nueva ruta de raíz de contenido puede romper los tokens: ASP.NET Core recurre a derivar el nombre de la aplicación de la ruta de raíz de contenido cuando no estableces uno explícitamente, así que la propia ruta se convierte en el discriminador.

**Claves cifradas en reposo que otras instancias no pueden leer.** En Windows, Data Protection cifra el conjunto de claves con DPAPI vinculado al usuario o a la máquina actual de forma predeterminada. Una clave escrita bajo una identidad es ilegible bajo otra, lo que produce el mismo síntoma aunque las claves estén físicamente presentes. Cuando compartes claves entre máquinas, o bien desactiva el cifrado por máquina, o bien usa un protector explícito y portátil como `ProtectKeysWithCertificate`.

**Funciona en local, falla en el contenedor.** Es lo esperado. Un único proceso en tu máquina de desarrollo mantiene su conjunto efímero en memoria durante toda la sesión, así que el token siempre se descifra. El error solo aparece cuando entra en escena una segunda instancia o un reinicio. Reprodúcelo ejecutando dos instancias localmente en puertos distintos sin nada delante, o reiniciando entre solicitudes como en la reproducción de arriba.

**No lo "soluciones" desactivando antiforgery.** Quitar `[ValidateAntiForgeryToken]` o `.RequireAntiforgery()` hace desaparecer el error y reabre un agujero de CSRF. El token está haciendo su trabajo. Persiste las claves en su lugar.

**`DisableAutomaticKeyGeneration` en réplicas de solo lectura.** Si ejecutas un worker que debe consumir claves pero nunca acuñarlas, llama a `DisableAutomaticKeyGeneration()` para que no cree una clave competidora en el conjunto compartido. Déjalo desactivado en la instancia que es dueña de la rotación.

## Lecturas relacionadas

- [.NET 10.0.7 sale fuera de banda para corregir CVE-2026-40372 en ASP.NET Core Data Protection](/es/2026/04/dotnet-10-0-7-oob-cve-2026-40372-dataprotection/) cubre una falla de validación HMAC en el mismo stack, y por qué quieres tu conjunto de claves parcheado.
- [Cómo implementar refresh tokens en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) se apoya en Data Protection para la misma canalización de cifrado.
- [Los formularios Blazor con SSR estático obtienen validación del lado del cliente en .NET 11 Preview 5](/es/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/) es donde los tokens de antiforgery aparecen en formularios Blazor renderizados estáticamente.
- [Cómo persistir estado a través del límite de renderizado estático-a-interactivo de Blazor en .NET 11](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) trata la clase relacionada de errores de "estado perdido a través de un límite".
- [Cómo agregar un filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) te ayuda a exponer esta excepción de forma limpia en lugar de como un 400 pelado.

## Fuentes

- [Configure ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/overview?view=aspnetcore-11.0) - las APIs exactas `PersistKeysTo*`, `ProtectKeysWith*` y `SetApplicationName` y los nombres de paquetes.
- [Key storage providers in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/implementation/key-storage-providers?view=aspnetcore-11.0) - proveedores de sistema de archivos, Azure Blob, Redis y EF Core.
- [Data Protection key management and lifetime](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/default-settings?view=aspnetcore-11.0) - vida útil predeterminada de 90 días y ubicaciones de almacenamiento predeterminadas.
- [dotnet/aspnetcore #47185: The antiforgery token could not be decrypted](https://github.com/dotnet/aspnetcore/issues/47185) - reportes del mundo real y orientación de los mantenedores.
