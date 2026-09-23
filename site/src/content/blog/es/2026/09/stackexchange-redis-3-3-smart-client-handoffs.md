---
title: "StackExchange.Redis 3.3 abandona un nodo de Redis antes de que el servidor te desconecte"
description: "StackExchange.Redis 3.3.0 agrega notificaciones de mantenimiento opcionales (smart client handoffs) para Redis Enterprise, Redis Cloud y Azure Managed Redis: timeouts relajados durante las migraciones, relectura de la topología y un cambio proactivo antes de que un endpoint desaparezca. Así se activa y este es el error SER010 que verás primero."
pubDate: 2026-09-23
tags:
  - "redis"
  - "stackexchange-redis"
  - "dotnet"
  - "resilience"
lang: "es"
translationOf: "2026/09/stackexchange-redis-3-3-smart-client-handoffs"
translatedBy: "claude"
translationDate: 2026-09-23
---

[StackExchange.Redis 3.3.0](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.0) salió el 18 de septiembre de 2026, seguido de [3.3.1](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.1) el 22 de septiembre. La funcionalidad principal son las notificaciones de mantenimiento nativas del servidor, que otros clientes de Redis llaman "smart client handoffs" o "hitless upgrades". Redis Enterprise y Redis Cloud ahora pueden avisar al cliente de .NET que un shard se está migrando, que un nodo está haciendo failover o que el endpoint al que está conectado está por ser reemplazado, y el cliente actúa en consecuencia en lugar de esperar a que un socket muera.

Si alguna vez viste una ráfaga de `RedisTimeoutException` durante una ventana de mantenimiento de un Redis administrado, esta es la solución para ese tipo de problema.

## Qué hace el cliente con cada notificación

Las notificaciones llegan como frames push de RESP3 en la misma conexión que transporta tus comandos. Según las [notas de diseño del PR #3191](https://github.com/StackExchange/StackExchange.Redis/pull/3191), el cliente reacciona sin que escribas código:

- `MIGRATING`, `FAILING_OVER`, `SMIGRATING`: los timeouts de los comandos en ese servidor se relajan (10 segundos por defecto, `maintRelaxedTimeout`).
- `MIGRATED`, `FAILED_OVER`: la ventana se cierra, con una breve cola relajada mientras todo se estabiliza.
- `SMIGRATED`: se vuelve a leer la topología del clúster y se vuelven a suscribir las suscripciones fragmentadas cuyos slots se movieron.
- `MOVING`: el cliente pide la dirección de reemplazo, drena el trabajo en curso y cambia la conexión antes de que el servidor la cierre.

Esta última es la más importante. El autor midió que el DNS va entre 4 y 19 segundos por detrás de una notificación `MOVING`, mientras que el servidor cierra el socket viejo a los 16 a 19 segundos aproximadamente. Al pedirle al servidor que indique el endpoint de reemplazo (`maintMovingEndpointType=Auto`, el valor por defecto), el traspaso se convierte en un cambio directo que se completa en menos de un segundo.

## Cómo activarlo en 3.3

Por ahora es opcional, incluso cuando te conectas a un hostname reconocido de Redis Cloud o Azure Managed Redis. La [documentación](https://seredis.dev/ServerMaintenanceEvent) indica que la activación automática para esos proveedores está prevista para una versión posterior. La cadena de conexión es el camino más simple:

```csharp
var muxer = await ConnectionMultiplexer.ConnectAsync(
    "my-redis.example.com:6379,maintNotifications=Auto,maintRelaxedTimeout=15");
```

La API fuertemente tipada está marcada como experimental, y en 3.3.1 eso es un error de compilación, no una advertencia:

```text
error SER010: 'StackExchange.Redis.ConfigurationOptions.MaintenanceNotifications' is for
evaluation purposes only and is subject to change or removal in future updates.
```

Suprímelo de forma explícita si quieres la propiedad y los tipos de eventos:

```csharp
#pragma warning disable SER010
using StackExchange.Redis;
using StackExchange.Redis.Maintenance;

var options = ConfigurationOptions.Parse("my-redis.example.com:6379");
options.MaintenanceNotifications = MaintenanceNotificationMode.Auto;

var muxer = await ConnectionMultiplexer.ConnectAsync(options);
muxer.ServerMaintenanceEvent += (_, e) =>
{
    if (e is PushMaintenanceEvent m)
        Console.WriteLine($"{m.NotificationType} seq {m.SequenceId} from {m.EndPoint}");
};
```

`MaintenanceNotificationMode` tiene tres valores. `Disabled` es el valor por defecto actual. `Auto` lo solicita durante el handshake y continúa si el servidor se niega. `Enabled` rechaza la conexión si las notificaciones no se pueden entregar, incluso cuando la conexión termina en RESP2, lo que lo convierte en una forma útil de comprobar que la funcionalidad está activa en staging.

## Dos cosas que revisar antes de llevarlo a producción

RESP3 es obligatorio. `protocol=resp2`, un `defaultVersion` menor a 6.0 o deshabilitar `HELLO` en el command map desactivan la funcionalidad en silencio con `Auto`.

Un traspaso deliberado también aparece como un evento `ConnectionFailed` con `FailureType == ConnectionFailureType.MaintenanceHandoff`. Si tienes alertas sobre `ConnectionFailed`, filtra ese valor o tu pager sonará en cada mantenimiento planificado.

Un cambio no es opcional: 3.3.0 agrega `topologyRefreshSeconds`, que vuelve a leer la topología cada 30 minutos por defecto (con jitter, `0` lo desactiva). Existe para endpoints que todavía responden a un handshake pero ya no pertenecen a la implementación.

Si Redis ya está detrás de tu `HybridCache`, consulta [cómo usar HybridCache en ASP.NET Core 11 con Redis como caché L2](/es/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/). Agregar `maintNotifications=Auto` a esa cadena de conexión es la mejora de resiliencia más barata que harás este mes.
