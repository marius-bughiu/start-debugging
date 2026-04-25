---
title: "Kestrel deja las excepciones de su parser HTTP/1.1 en .NET 11"
description: "El parser de solicitudes HTTP/1.1 de Kestrel en .NET 11 reemplaza BadHttpRequestException con un struct de resultado, reduciendo la sobrecarga de solicitudes malformadas hasta en un 40%."
pubDate: 2026-04-08
tags:
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "performance"
lang: "es"
translationOf: "2026/04/kestrel-non-throwing-parser-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Cada solicitud HTTP/1.1 malformada que llegaba a Kestrel lanzaba una `BadHttpRequestException`. Esa excepción asignaba una traza de pila, desenvolvía la pila de llamadas, y era capturada en algún lugar más arriba, todo por una solicitud que nunca iba a producir una respuesta válida. En .NET 11, el parser [cambia a una ruta de código sin throws](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), y la diferencia es medible: **20-40% más throughput** en escenarios con tráfico malformado frecuente.

## Por qué las excepciones eran costosas

Lanzar una excepción en .NET no es gratis. El runtime captura una traza de pila, recorre la pila de llamadas buscando un `catch` coincidente, y asigna el objeto de excepción en el heap. Para una solicitud bien formada esto nunca dispara, así que no lo notas. Pero los escáneres de puertos, clientes mal configurados, y tráfico malicioso pueden empujar miles de solicitudes malas por segundo. Cada una pagaba el impuesto completo de excepción.

```csharp
// Before (.NET 10 and earlier): every parse failure threw
try
{
    ParseRequestLine(buffer);
}
catch (BadHttpRequestException ex)
{
    Log.ConnectionBadRequest(logger, ex);
    return;
}
```

En rutas calientes, `try/catch` con throws frecuentes se convierte en un cuello de botella de throughput.

## El enfoque del struct de resultado

El parser de .NET 11 retorna un struct de resultado ligero en su lugar:

```csharp
// After (.NET 11): no exception on parse failure
var result = ParseRequestLine(buffer);

if (result.Status == ParseStatus.Error)
{
    Log.ConnectionBadRequest(logger, result.ErrorReason);
    return;
}
```

El struct lleva un campo `Status` (`Success`, `Incomplete`, o `Error`) y una cadena de razón de error cuando es relevante. Sin asignación en heap, sin desenvolver la pila, sin sobrecarga de bloques `catch`. Las solicitudes válidas no ven ningún cambio porque ya tomaban la ruta exitosa.

## Cuándo importa esto

Si tu servidor está detrás de un balanceador de carga que hace chequeos de salud con TCP crudo, o si expones Kestrel directamente a internet, estás siendo golpeado constantemente por solicitudes malformadas. Las implementaciones honeypot, las puertas de enlace de API que manejan protocolos mixtos, y cualquier servicio expuesto a escaneos de puertos se benefician.

La mejora es enteramente interna a Kestrel. No hay cambio de API, ni flag de configuración, ni opt-in. Actualiza a .NET 11 y el parser es más rápido por defecto.

## Otras victorias de rendimiento en .NET 11

Esta no es la única reducción de asignaciones en .NET 11 Preview. El middleware de logging HTTP ahora hace pool de sus instancias de `ResponseBufferingStream`, reduciendo asignaciones por solicitud cuando el logging del cuerpo de respuesta está habilitado. Combinado con el cambio del parser, .NET 11 continúa el patrón del equipo de runtime de convertir rutas calientes pesadas en excepciones en flujos de resultados basados en structs.

Si quieres ver el impacto en tu propia carga de trabajo, ejecuta un benchmark antes/después con [Bombardier](https://github.com/codesenberg/bombardier) o `wrk` mientras inyectas un porcentaje de solicitudes malformadas. El cambio del parser es transparente, pero los números deberían hablar por sí mismos.
