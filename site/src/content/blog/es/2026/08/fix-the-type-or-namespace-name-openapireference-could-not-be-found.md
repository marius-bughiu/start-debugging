---
title: "Solución: The type or namespace name 'OpenApiReference' could not be found"
description: "OpenApiReference se eliminó en Microsoft.OpenApi 2.0. Cambiar el using a Microsoft.OpenApi no basta: reemplaza cada uso por una referencia tipada como OpenApiSchemaReference."
pubDate: 2026-08-11
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "openapi"
lang: "es"
translationOf: "2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-08-11
---

`OpenApiReference` ya no existe. Microsoft.OpenApi 2.0 consolidó todos los espacios de nombres del modelo dentro de `Microsoft.OpenApi` y además eliminó el tipo de referencia genérico, así que cambiar `using Microsoft.OpenApi.Models;` por `using Microsoft.OpenApi;` resuelve el error de espacio de nombres y deja este otro en pie. La solución es reemplazar cada `new OpenApiReference { Type = ..., Id = "X" }` por la clase de referencia tipada del componente al que apuntabas, por ejemplo `new OpenApiSchemaReference("X", document)` o `new OpenApiSecuritySchemeReference("Bearer", document)`. Todo lo que sigue está verificado contra el SDK 10.0.201, `Microsoft.AspNetCore.OpenApi` 10.0.10 y `Microsoft.OpenApi` 2.11.0.

## El error en contexto

Hay dos errores en esta familia y quien busca llega aquí con cualquiera de los dos. Si todavía tienes las directivas `using` viejas, el compilador se queja del espacio de nombres, no del tipo:

```
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
error CS0234: The type or namespace name 'Any' does not exist in the namespace 'Microsoft.OpenApi' (are you missing an assembly reference?)
```

Borra esos using, o reemplázalos por `using Microsoft.OpenApi;`, y obtienes el error que realmente te trajo hasta aquí:

```
error CS0246: The type or namespace name 'OpenApiReference' could not be found (are you missing a using directive or an assembly reference?)
error CS0246: The type or namespace name 'OpenApiString' could not be found (are you missing a using directive or an assembly reference?)
error CS0117: 'OpenApiSecurityScheme' does not contain a definition for 'Reference'
error CS0029: Cannot implicitly convert type 'string' to 'Microsoft.OpenApi.JsonSchemaType?'
error CS1061: 'OpenApiDocument' does not contain a definition for 'SerializeAsJson'
```

Ese segundo bloque es la pista. `CS0234` significa "el espacio de nombres se movió". `CS0246` sobre `OpenApiReference` significa concretamente "el tipo desapareció", y ninguna directiva using lo va a traer de vuelta.

## Por qué ocurre

`Microsoft.AspNetCore.OpenApi` pasó a depender de forma dura de Microsoft.OpenApi 2.x a partir de la versión 10.0, y .NET 11 mantiene esa decisión. Agrega el paquete a un proyecto web `net10.0` limpio y verás la dependencia transitiva:

```
> Microsoft.AspNetCore.OpenApi      10.0.10     10.0.10
   > Microsoft.OpenApi              2.0.0
```

Microsoft.OpenApi 2.0 introdujo tres cambios que caen sobre la misma línea de tu código:

- **Los espacios de nombres se consolidaron.** `Microsoft.OpenApi.Models`, `Microsoft.OpenApi.Any`, `Microsoft.OpenApi.Interfaces` y `Microsoft.OpenApi.Writers` se fusionaron en `Microsoft.OpenApi`. El ensamblado público expone ahora exactamente tres espacios de nombres: `Microsoft.OpenApi`, `Microsoft.OpenApi.Reader` y `Microsoft.OpenApi.MicrosoftExtensions`.
- **`OpenApiReference` se eliminó**, junto con la propiedad `Reference` de todos los modelos referenciables. `OpenApiSecurityScheme` ya no tiene ningún miembro `Reference`, y eso es el `CS0117` de arriba.
- **Las referencias pasaron a ser tipos de primera clase.** En vez de adjuntar una referencia a un modelo vacío, construyes un objeto de referencia dedicado que implementa la misma interfaz que aquello a lo que apunta.

Si usas Swashbuckle en lugar del generador integrado, el mismo precipicio existe un paquete más allá. Swashbuckle.AspNetCore 9.0.6 resuelve `Microsoft.OpenApi` 1.6.25 y tu código viejo sigue compilando; Swashbuckle.AspNetCore 10.1.0 resuelve `Microsoft.OpenApi` 2.3.0 y deja de compilar. Lo que te rompe es actualizar Swashbuckle, no actualizar el SDK.

## Reproducción mínima

Esta es la forma que casi todo el mundo tiene, normalmente dentro de una llamada a `AddSecurityRequirement` de Swagger copiada de algún tutorial de JWT:

```csharp
// FAILS on .NET 10/11 with Microsoft.OpenApi 2.x
using Microsoft.OpenApi.Models;
using Microsoft.OpenApi.Any;

var reference = new OpenApiReference
{
    Type = ReferenceType.SecurityScheme,
    Id = "Bearer"
};

var scheme = new OpenApiSecurityScheme
{
    Reference = reference
};

var schema = new OpenApiSchema
{
    Type = "string",
    Default = new OpenApiString("hello")
};

var json = new OpenApiDocument().SerializeAsJson(OpenApiSpecVersion.OpenApi3_0);
```

Seis líneas, cinco cambios incompatibles distintos. Arreglarlos error de compilación por error de compilación es lento, así que conviene conocer todo el mapeo de antemano.

## La solución, paso a paso

### 1. Reemplaza las directivas using

Todos los using de modelos `Microsoft.OpenApi.*` colapsan en uno solo:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
using Microsoft.OpenApi;
using System.Text.Json.Nodes;   // needed wherever you used IOpenApiAny
```

Buscar y reemplazar `using Microsoft.OpenApi.Models;` por `using Microsoft.OpenApi;` en todo el proyecto es seguro. Simplemente borra `using Microsoft.OpenApi.Any;` y `using Microsoft.OpenApi.Interfaces;`.

### 2. Reemplaza OpenApiReference por la referencia tipada

Esta es la parte que ningún `using` arregla. Microsoft.OpenApi 2.x incluye una clase de referencia por cada componente referenciable, todas con la misma forma de constructor `(string referenceId, OpenApiDocument hostDocument = null, string externalResource = null)`:

| `ReferenceType` anterior | Tipo nuevo |
| --- | --- |
| `ReferenceType.Schema` | `OpenApiSchemaReference` |
| `ReferenceType.SecurityScheme` | `OpenApiSecuritySchemeReference` |
| `ReferenceType.Parameter` | `OpenApiParameterReference` |
| `ReferenceType.RequestBody` | `OpenApiRequestBodyReference` |
| `ReferenceType.Response` | `OpenApiResponseReference` |
| `ReferenceType.Header` | `OpenApiHeaderReference` |
| `ReferenceType.Example` | `OpenApiExampleReference` |
| `ReferenceType.Link` | `OpenApiLinkReference` |
| `ReferenceType.Callback` | `OpenApiCallbackReference` |
| `ReferenceType.Tag` | `OpenApiTagReference` |
| `ReferenceType.PathItem` | `OpenApiPathItemReference` |

Así, la referencia al esquema de seguridad se convierte en una sola expresión:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
// old: new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }
var schemeRef = new OpenApiSecuritySchemeReference("Bearer", document);
```

Estos tipos de referencia implementan la interfaz de su destino (`OpenApiSchemaReference` es un `IOpenApiSchema`, `OpenApiSecuritySchemeReference` es un `IOpenApiSecurityScheme`), así que encajan directamente en las colecciones que antes recibían el modelo en sí.

### 3. Arregla el daño colateral de esas mismas líneas

En el mismo bloque suelen aparecer otros tres cambios de nombre:

- `OpenApiSchema.Type` pasó de `string` al enum de banderas `JsonSchemaType`, cuyos miembros son `Null`, `Boolean`, `Integer`, `Number`, `String`, `Object` y `Array`. Como es un enum `[Flags]`, la nulabilidad de OpenAPI 3.1 se expresa como `JsonSchemaType.String | JsonSchemaType.Null` en vez de con una propiedad `Nullable` aparte.
- Toda la jerarquía `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiArray`, `OpenApiObject` y el resto) se eliminó en favor de `JsonNode`, de `System.Text.Json.Nodes`.
- `SerializeAsJson` y `SerializeAsYaml` ahora son métodos de extensión asíncronos: `SerializeAsJsonAsync` y `SerializeAsYamlAsync`. `Maximum`, `Minimum`, `ExclusiveMaximum` y `ExclusiveMinimum` cambiaron de `double?` a `string?` para que los números de precisión arbitraria sobrevivan al ida y vuelta.

### 4. La versión completa que funciona

Aquí está la reproducción anterior, reescrita como el transformador de documento que realmente registrarías en una app .NET 11. Compila limpio contra `Microsoft.AspNetCore.OpenApi` 10.0.10:

```csharp
// .NET 11, Microsoft.AspNetCore.OpenApi 10.0.10, Microsoft.OpenApi 2.11.0
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

public sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();

        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };

        document.Security ??= new List<OpenApiSecurityRequirement>();
        document.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecuritySchemeReference("Bearer", document)] = new List<string>()
        });

        return Task.CompletedTask;
    }
}
```

Y los equivalentes del lado de los esquemas:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var schema = new OpenApiSchema
{
    Type = JsonSchemaType.String | JsonSchemaType.Null,   // was Type = "string" + Nullable = true
    Default = (JsonNode)"hello",                          // was new OpenApiString("hello")
    Enum = new List<JsonNode> { (JsonNode)"a", (JsonNode)"b" },
    Maximum = "100"                                       // was double? Maximum = 100
};

IOpenApiSchema widgetRef = new OpenApiSchemaReference("Widget", document);

string json = await document.SerializeAsJsonAsync(OpenApiSpecVersion.OpenApi3_1);
```

Serializar un documento construido así produce exactamente lo que esperas, con el requisito de seguridad expresado por nombre de esquema y el componente intacto:

```json
{
  "openapi": "3.1.1",
  "components": {
    "securitySchemes": {
      "Bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    }
  },
  "security": [ { "Bearer": [ ] } ]
}
```

## Detalles que muerden cuando el código ya compila

**No "arregles" esto actualizando Microsoft.OpenApi a 3.x.** Es tentador, porque 3.9.0 es la versión actual en NuGet mientras que ASP.NET Core 10 fija la 2.0.0. Agrega un `PackageReference` explícito a 3.9.0 en un proyecto que use el generador integrado y la compilación falla dentro del propio código generado por Microsoft:

```
obj\Debug\net10.0\Microsoft.AspNetCore.OpenApi.SourceGenerators\...\OpenApiXmlCommentSupport.generated.cs(399,41):
error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only
```

El generador de código fuente de comentarios XML que viene con `Microsoft.AspNetCore.OpenApi` 10.0.10 está escrito contra la superficie 2.x. Quédate en la línea 2.x hasta que el paquete de ASP.NET Core se mueva.

**Sí fija Microsoft.OpenApi en 2.7.5 o posterior.** La 2.0.0 que ASP.NET Core 10.0.10 resuelve de forma transitiva arrastra un aviso de severidad alta, y NuGet te lo dirá al restaurar:

```
warning NU1903: Package 'Microsoft.OpenApi' 2.0.0 has a known high severity vulnerability
```

Es CVE-2026-49451, recursión no controlada ante referencias circulares de esquema, que afecta de 2.0.0-preview.11 a 2.7.4 y de 3.0.0 a 3.5.3. Agregar un `<PackageReference Include="Microsoft.OpenApi" Version="2.11.0" />` explícito elimina la advertencia y sigue compilando limpio contra el generador de 10.0.10. Importa sobre todo si tu app analiza documentos OpenAPI que no escribiste tú.

**Las colecciones ya no se inicializan solas.** En la 1.x, `new OpenApiDocument().Components` te devolvía un `OpenApiComponents` vacío. En la 2.x es null, igual que `Components.Schemas`, `Components.SecuritySchemes` y `Document.Tags`. `Paths` y `Servers` siguen inicializados. Por eso el transformador de arriba usa `??=` en cada nivel antes de indexar, y por eso es la `NullReferenceException` más común justo después de que la actualización compile bien.

**Las referencias se resuelven de forma perezosa a través del workspace del documento.** Si construyes un documento a mano en vez de dejar que lo construya ASP.NET Core, el `Target` de una referencia sigue siendo null y sus propiedades delegadas vuelven vacías hasta que registras los componentes:

```csharp
// .NET 11, Microsoft.OpenApi 2.11.0
var reference = new OpenApiSchemaReference("Widget", document);
// reference.Target is null here, reference.Description is empty

document.Workspace.RegisterComponents(document);
// reference.Target is now resolved, reference.Description reads through to the target
```

La resolución es perezosa, así que una referencia creada antes de la llamada a `RegisterComponents` empieza a resolverse bien después. La serialización emite el `$ref` en cualquier caso; lo que sorprende son las lecturas a través del proxy.

**Vigila los tipos de interfaz en las firmas de los transformadores.** `Components.Schemas` es un `IDictionary<string, IOpenApiSchema>` y `Components.SecuritySchemes` es un `IDictionary<string, IOpenApiSecurityScheme>`, no las clases concretas. El código que asumía el tipo concreto ahora necesita una conversión o un patrón, porque el valor puede ser un objeto de referencia en vez de un esquema en línea.

**`OpenApiSecuritySchemeReference` no se representa como un `$ref`.** Su `Reference.ReferenceV3` es simplemente `Bearer`, mientras que el de `OpenApiSchemaReference("Widget")` es `#/components/schemas/Widget`. Eso es correcto según la especificación de OpenAPI: un requisito de seguridad se identifica por el nombre del esquema. No salgas a buscar un `$ref` ausente en la salida.

## Relacionado

Si estás resolviendo una actualización más amplia de OpenAPI, estos cubren las piezas vecinas: el paso fuera de Swashbuckle está detallado en [migrar de Swashbuckle al generador de OpenAPI integrado](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/), y la reescritura de filtros a transformadores que suele acompañarlo está en [portar IOperationFilter e ISchemaFilter a transformadores de OpenAPI](/es/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/). Para la API de transformadores en sí, mira [personalizar el documento con AddOperationTransformer y AddSchemaTransformer](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/). Una vez que el documento vuelve a compilar, todavía necesitas dónde mostrarlo, y eso está en [servir documentación OpenAPI con Scalar](/es/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/). Y si este error apareció como parte de un salto mayor, la [lista de verificación de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) enumera los demás paquetes que se movieron al mismo tiempo.

## Fuentes

- [Guía de actualización a OpenAPI.NET 2.0](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md), la lista autorizada de tipos eliminados y propiedades renombradas.
- [Issue 61123 de dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/issues/61123), el reporte de la desaparición de `OpenApiSecurityScheme.Reference` en .NET 10 Preview 2.
- [Issue 3522 de Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3522), el cambio de espacios de nombres tal como lo vivieron los usuarios de Swashbuckle.
- [GHSA-v5pm-xwqc-g5wc](https://github.com/advisories/GHSA-v5pm-xwqc-g5wc) / CVE-2026-49451, el aviso detrás de la advertencia `NU1903`.
