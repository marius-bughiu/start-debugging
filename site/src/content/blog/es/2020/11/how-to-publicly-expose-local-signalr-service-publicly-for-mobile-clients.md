---
title: "Cómo exponer públicamente tu servicio local de SignalR para clientes móviles usando ngrok"
description: "Usa ngrok para exponer públicamente tu servicio local de SignalR de modo que los clientes móviles puedan conectarse sin configuración de red ni soluciones temporales para SSL."
pubDate: 2020-11-04
tags:
  - "csharp"
  - "signalr"
  - "xamarin-forms"
lang: "es"
translationOf: "2020/11/how-to-publicly-expose-local-signalr-service-publicly-for-mobile-clients"
translatedBy: "claude"
translationDate: 2026-05-01
---
Cuando trabajas con clientes móviles, no siempre es fácil ponerlos en la misma red que tu máquina de desarrollo, e incluso cuando lo logras, `localhost` tendrá un significado distinto, así que tienes que usar IPs, cambiar bindings y deshabilitar SSL o confiar en certificados autofirmados; en resumen, es un dolor de cabeza.

Saluda a [ngrok](https://ngrok.com).

ngrok te permite crear un proxy público y seguro que enrutará todas las solicitudes a un puerto específico en tu máquina de desarrollo. El plan gratuito permite túneles HTTP/TCP con URLs y puertos aleatorios para un único proceso, más un máximo de 40 conexiones/minuto. Esto debería ser más que suficiente para la mayoría. Si necesitas dominios reservados o subdominios personalizados, así como límites más altos, también hay planes de pago.

## Empecemos

Primero, ve y regístrate una cuenta en ngrok, descarga su cliente y extráelo a una ubicación de tu preferencia. Luego, siguiendo la [Setup & Installation guide](https://ngrok.com/docs/getting-started/), ejecuta el comando `ngrok authtoken` para autenticarte.

A continuación, arranca tu aplicación web y mira su URL. La mía es `https://localhost:44312/`, lo que significa que nos interesa redirigir el puerto 44312 sobre https. Así que, en la misma ventana de `cmd` que usaste para autenticarte, ejecuta `` ngrok http `https://localhost:44312/` ``, reemplazando, por supuesto, `https://localhost:44312/` con la URL de tu aplicación. Esto iniciará tu proxy y mostrará las URLs públicas que puedes usar para acceder a él.

![ngrok ejecutando un proxy público en el plan Free](/wp-content/uploads/2020/10/image-1.png)

Si no estás usando HTTPS, puedes usar la versión más corta `ngrok http 44312`.

Si recibes un 400 Bad Request -- Invalid Hostname, significa que alguien intenta validar la cabecera `Host` y falla porque no coinciden, ya que por defecto ngrok pasa todo a tu servidor web sin manipularlo. Para reescribir la cabecera `Host` usa el switch `-host-header=rewrite`.

En mi caso, usando ASP.NET Core + IIS Express, mi comando completo es este:

`ngrok http -host-header=rewrite https://localhost:44312`

Ahora copia la URL de la ventana anterior y actualízala en tus clientes. Ten en cuenta que, en el plan Free, cada vez que inicies o detengas ngrok la URL será distinta.

## ¡Pruébalo!

Puedes probar esto tú mismo fácilmente clonando el ejemplo original de Xamarin Forms SignalR Chat (el repositorio de GitHub ya no está disponible), ejecutando el proyecto .Web y exponiéndolo a través de `ngrok` como se explicó. Luego reemplaza la `ChatHubUrl` en `appsettings.json` con la que `ngrok` ha generado para ti.
