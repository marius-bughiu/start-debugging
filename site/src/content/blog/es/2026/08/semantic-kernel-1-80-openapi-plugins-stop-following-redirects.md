---
title: "Semantic Kernel 1.80.0 impide que los plugins de OpenAPI sigan redirecciones"
description: "Semantic Kernel .NET 1.80.0 trae un cambio incompatible: el HttpClient por defecto del plugin de OpenAPI ya no sigue redirecciones y cierra un bypass de SSRF. Esto es lo que cambia y por qué tu propio HttpClient reabre el agujero."
pubDate: 2026-08-19
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "es"
translationOf: "2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects"
translatedBy: "claude"
translationDate: 2026-08-19
---

Semantic Kernel .NET 1.80.0 salió el 2026-08-18, y la línea del changelog que importa es la más escueta: [".NET: [Breaking] Update OpenAPI HTTP client defaults"](https://github.com/microsoft/semantic-kernel/pull/14293). Cierra un agujero que Semantic Kernel venía documentando como limitación conocida en sus propios comentarios XML desde mayo.

## La validación era real, la redirección era la salida de emergencia

Desde que [PR #14029](https://github.com/microsoft/semantic-kernel/pull/14029) llegó en mayo de 2026, `RestApiOperationServerUrlValidationOptions` se aplica por defecto a cada plugin de OpenAPI. Si dejas `ServerUrlValidationOptions` en null, igual obtienes una instancia construida por defecto que exige https para todo lo que esté fuera de la lista de permitidos y rechaza los hosts que resuelven a loopback, link-local (incluida la dirección de metadatos de nube `169.254.169.254`), RFC1918, `fc00::/7`, NAT de nivel de operador, multicast y rangos reservados.

El problema era el orden. La validación corre contra la URL antes de que salga la solicitud. El `HttpClient` por defecto seguía redirecciones, así que un host público que hubieras permitido podía responder con un `302` apuntando a `http://169.254.169.254/latest/meta-data/` y el handler lo perseguía, habiendo pasado ya el filtro. Semantic Kernel lo decía en los comentarios del propio tipo y te indicaba configurar `AllowAutoRedirect = false` por tu cuenta.

## Qué cambió realmente en 1.80.0

La factory del plugin ya no resuelve su cliente por defecto a través de `HttpClientProvider.GetHttpClient()`. Ahora llama a un nuevo `GetNonRedirectingHttpClient()`, respaldado por un singleton de handler no desechable independiente con las redirecciones desactivadas:

```csharp
public static HttpClient GetNonRedirectingHttpClient()
    => new(NonDisposableHttpClientHandler.NonRedirectingInstance, disposeHandler: false);
```

Todos los puntos de entrada pasan por ahí: `ImportPluginFromOpenApiAsync`, `CreatePluginFromOpenApiAsync`, `OpenApiKernelPluginFactory.CreateFromOpenApiAsync`, más las extensiones de API Manifest y Copilot Agent Plugin. Una redirección ahora aparece como una `HttpOperationException` que lleva el estado `3xx` en vez de seguirse en silencio.

## Tu HttpClient sigue siendo cosa tuya

Esta es la parte que debes revisar antes de actualizar `Microsoft.SemanticKernel.Plugins.OpenApi` a 1.80.0. El nuevo valor por defecto solo aplica cuando Semantic Kernel construye el cliente. Si le pasas uno, se usa tal cual:

```csharp
var handler = new HttpClientHandler { AllowAutoRedirect = false };
using var http = new HttpClient(handler);

await kernel.ImportPluginFromOpenApiAsync(
    pluginName: "partner",
    uri: new Uri("https://partner.example.com/openapi.json"),
    executionParameters: new OpenApiFunctionExecutionParameters
    {
        HttpClient = http,
    });
```

El caso sutil es la inyección de dependencias. Las extensiones del kernel recurren a `kernel.Services.GetService<HttpClient>()` antes de llegar al valor por defecto, así que un registro simple de `AddHttpClient()` gana y trae de vuelta `AllowAutoRedirect = true` consigo. Si conectas los plugins dentro de un host, como en [ejecutar un plugin de Semantic Kernel desde un BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/), configura el handler primario de forma explícita.

La parte incompatible es real: una API interna que responde `301` ante una barra final que no coincide antes funcionaba y ahora lanza una excepción. Corrige el `servers[].url` del documento en vez de entregarle al plugin un cliente que siga redirecciones.
