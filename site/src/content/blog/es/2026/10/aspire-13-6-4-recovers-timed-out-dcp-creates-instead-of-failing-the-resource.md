---
title: "Aspire 13.6.4 recupera las llamadas de creación de DCP que superan el tiempo de espera en lugar de marcar el recurso como fallido"
description: "Aspire 13.6.4 evita que una sola llamada de creación a DCP que agota el tiempo de espera o devuelve HTTP 504 envíe un recurso a FailedToStart, y expone tres timeouts de DcpPublisher que puedes aumentar en runners de CI lentos."
pubDate: 2026-10-25
tags:
  - "aspire"
  - "dotnet"
  - "ci"
lang: "es"
translationOf: "2026/10/aspire-13-6-4-recovers-timed-out-dcp-creates-instead-of-failing-the-resource"
translatedBy: "claude"
translationDate: 2026-10-25
---

Si tu AppHost de Aspire 13.6 falla de forma aleatoria en CI con un recurso atascado en `FailedToStart`, [Aspire 13.6.4](https://github.com/microsoft/aspire/releases/tag/v13.6.4), publicado el 24 de octubre de 2026, es el parche que necesitas. Cambia la forma en que el AppHost se comunica con el Developer Control Plane (DCP) cuando una llamada de creación no responde a tiempo, y por fin te permite ajustar esos timeouts.

## Una sola llamada de creación lenta bastaba para matar un recurso

Desde la 13.6.0, una única solicitud `Create` al servidor de API de DCP que agotaba el tiempo de espera o devolvía HTTP 504 no se reintentaba. El recurso pasaba directamente a `FailedToStart`, y todo lo que hacía `WaitFor` sobre él fallaba con "Stopped waiting for resource ... because it failed to start." El reporte en [microsoft/aspire#20691](https://github.com/microsoft/aspire/issues/20691) vino de runners `macos-15-intel` alojados en GitHub con 2 vCPU, donde el último proyecto del grafo arrancaba mientras sus dependencias aún se estaban iniciando. Los registros mostraban un `TimeoutRejectedException` de Polly tras el presupuesto de 20 segundos del cliente, o un `GatewayTimeout` de DCP tras unos 34 segundos.

Lo complicado es que un timeout no significa que la creación haya fallado. DCP pudo haber confirmado el objeto un instante después de que el cliente se rindiera, así que tampoco es seguro reintentar a ciegas.

## Confirmar primero, luego reintentar el mismo objeto

La corrección de [#20752](https://github.com/microsoft/aspire/pull/20752) (portada a la rama en [#20868](https://github.com/microsoft/aspire/pull/20868)) trata una creación con timeout, 502, 503, 504 o 429 como ambigua. Antes de reintentar, el AppHost emite un `GET` para el mismo objeto con nombre. Si DCP ya lo creó, se usa ese objeto y el recurso sigue iniciándose. Si el `GET` devuelve 404, la creación se reintenta con retroceso exponencial con jitter limitado a 5 segundos. También se acepta una respuesta de "already exists" en un reintento, ya que el intento anterior pudo haberse confirmado después de la comprobación. El `GET` importa porque evita el bloqueo de publicación del servidor de API, detrás del cual podría quedarse bloqueado un segundo `POST`.

El `HttpClientTimeout` de 100 segundos propio del paquete KubernetesClient ahora está deshabilitado, de modo que ya no puede recortar un presupuesto configurado ni aparecer como una cancelación sin relación aparente.

## Tres ajustes bajo DcpPublisher

Los presupuestos ahora son opciones normales en la configuración del AppHost:

| Clave | Valor predeterminado | Propósito |
| --- | --- | --- |
| `DcpPublisher:KubernetesApiTimeout` | 40 s | Por operación de la API |
| `DcpPublisher:KubernetesInitializationAdditionalTimeout` | 20 s | Se suma hasta la primera operación exitosa |
| `DcpPublisher:KubernetesCreateRecoveryTimeout` | 2 min | Presupuesto total para recuperar una creación |

Cada valor debe estar entre un segundo y diez minutos, y los timeouts de API e inicialización sumados no pueden superar los diez minutos; de lo contrario, la validación de opciones falla al arrancar. Los flujos de watch y de registros ya establecidos no están sujetos a estos límites.

En un runner con recursos limitados, auméntalos en el `appsettings.json` del AppHost:

```json
{
  "DcpPublisher": {
    "KubernetesApiTimeout": "00:01:30",
    "KubernetesInitializationAdditionalTimeout": "00:00:45",
    "KubernetesCreateRecoveryTimeout": "00:05:00"
  }
}
```

O conserva los valores predeterminados del repositorio y defínelos solo en el workflow de CI, ya que las variables de entorno también se enlazan a través de `IConfiguration`:

```yaml
env:
  DcpPublisher__KubernetesApiTimeout: "00:01:30"
  DcpPublisher__KubernetesCreateRecoveryTimeout: "00:05:00"
```

Para actualizar, sube la versión de `Aspire.AppHost.Sdk` y de los paquetes `Aspire.Hosting.*` a `13.6.4`. La misma versión también restringe los registros de diagnóstico de la CLI en Unix a archivos `0600` dentro de un directorio `0700`, porque esos registros pueden contener URL de inicio de sesión del dashboard. Si te estás poniendo al día con la línea 13.6, el [artículo sobre el historial de ejecuciones del dashboard](/es/2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs/) cubre la funcionalidad principal de esa versión.
