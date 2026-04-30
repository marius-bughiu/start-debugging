---
title: "AWS Lambda soporta .NET 10: qué verificar antes de cambiar el runtime"
description: "AWS Lambda ahora soporta .NET 10, pero la actualización del runtime no es la parte difícil. Aquí hay una checklist práctica que cubre cold starts, trimming, native AOT y forma de despliegue."
pubDate: 2026-01-08
tags:
  - "aws"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime"
translatedBy: "claude"
translationDate: 2026-04-30
---
El soporte de AWS Lambda para **.NET 10** está empezando a aparecer en canales de la comunidad hoy, y es el tipo de cambio que parece "listo" hasta que te topas con cold starts, trimming o una dependencia nativa en producción.

Discusión de origen: [r/dotnet thread](https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws_lambda_supports_net_10/)

## El soporte de runtime es la parte fácil; la forma de tu despliegue es la parte difícil

Mover un Lambda de .NET 8/9 a **.NET 10** no es solo un bump del target framework. El runtime que selecciones controla:

-   **Comportamiento de cold start**: JIT, ReadyToRun, native AOT y cuánto código envíes cambian el perfil de inicio.
-   **Empaquetado**: imagen de contenedor vs ZIP, más cómo manejas las bibliotecas nativas.
-   **Frameworks pesados en reflection**: trimming y AOT pueden convertir "funciona localmente" en "falla en runtime".

Si quieres .NET 10 principalmente por rendimiento, no asumas que la actualización del runtime de Lambda es la victoria. Mide los cold starts con tu handler real, dependencias reales, variables de entorno reales y configuración de memoria real.

## Un handler mínimo de Lambda en .NET 10 que puedes hacer benchmark

Aquí hay un handler pequeño que es fácil de hacer benchmark y fácil de romper con trimming. También muestra un patrón que me gusta: mantener el handler diminuto, empujar todo lo demás detrás de DI o caminos de código explícitos.

```cs
using Amazon.Lambda.Core;

[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

public sealed class Function
{
    // Use a static instance to avoid per-invocation allocations.
    private static readonly HttpClient Http = new();

    public async Task<Response> FunctionHandler(Request request, ILambdaContext context)
    {
        // Touch something typical: logging + a small outbound call.
        context.Logger.LogLine($"RequestId={context.AwsRequestId} Name={request.Name}");

        var status = await Http.GetStringAsync("https://example.com/health");
        return new Response($"Hello {request.Name}. Upstream says: {status.Length} chars");
    }
}

public sealed record Request(string Name);
public sealed record Response(string Message);
```

Ahora publica de una manera que coincida con tu camino de producción previsto. Si estás probando trimming, hazlo explícito:

```bash
dotnet publish -c Release -f net10.0 -p:PublishTrimmed=true
```

Si planeas ir más lejos hacia native AOT en .NET 10, publica también de esa forma y valida que tus dependencias sean realmente compatibles con AOT (serialización, reflection, libs nativas).

## Una checklist práctica para el primer rollout de .NET 10

-   **Mide cold start y estado estable por separado**: p50 y p99 para ambos.
-   **Activa trimming solo si puedes probarlo**: las fallas de trimming usualmente son fallas en runtime.
-   **Confirma la configuración de memoria de tu Lambda**: cambia la asignación de CPU y puede invertir tus resultados.
-   **Fija dependencias sensibles a TFMs**: `Amazon.Lambda.*`, serializadores y cualquier cosa que use reflection.

Si quieres un primer paso seguro, actualiza el runtime a **.NET 10** y mantén la misma estrategia de despliegue. Una vez que esté estable, experimenta con trimming o AOT en una rama y solo despáchalo cuando tu monitoreo diga que es aburrido.
