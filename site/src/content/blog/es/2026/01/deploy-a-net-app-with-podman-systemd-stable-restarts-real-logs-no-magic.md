---
title: "Despliega una app .NET con Podman + systemd: reinicios estables, logs reales, sin magia"
description: "Despliega servicios .NET 9 y .NET 10 en una VM Linux usando Podman y systemd. Consigue reinicios estables, logs reales vía journald y una app en contenedor administrada como un servicio de verdad -- sin Kubernetes."
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "es"
translationOf: "2026/01/deploy-a-net-app-with-podman-systemd-stable-restarts-real-logs-no-magic"
translatedBy: "claude"
translationDate: 2026-04-30
---
Apareció hoy en r/dotnet: la gente sigue buscando una historia de "despliegue aburrido" para servicios .NET que no sea Kubernetes ni un script `nohup` frágil. Si estás en una VM Linux, Podman más systemd es un punto medio sólido: una app en contenedor administrada como un servicio de verdad.

Discusión original: [https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/](https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/)

## Por qué funciona bien para servicios .NET 9 y .NET 10

-   **Systemd es dueño de los reinicios**: si el proceso muere, se reinicia, y obtienes un motivo claro.
-   **Journald es dueño de los logs**: se acabó cazar archivos rotados en disco.
-   **Podman no tiene daemon**: systemd arranca exactamente lo que necesita.

## Compila y ejecuta el contenedor

Aquí va un `Containerfile` mínimo para una app .NET 9 (funciona igual para .NET 10, solo cambia el tag base):

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out

FROM base
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

Luego:

```bash
podman build -t myapp:1 .
podman run -d --name myapp -p 8080:8080 myapp:1
```

## Deja que systemd sea el dueño (la parte útil)

Podman puede generar un archivo de unidad que systemd entiende. Nota: `podman generate systemd` está obsoleto en Podman 4.4+ a favor de [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), pero la salida generada sigue funcionando y muestra el concepto con claridad:

```bash
podman generate systemd --new --name myapp --files
```

Esto produce algo como `container-myapp.service`. Muévelo a su lugar:

```bash
sudo mv container-myapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now container-myapp.service
```

Ahora obtienes comandos operativos limpios:

```bash
sudo systemctl status container-myapp.service
sudo journalctl -u container-myapp.service -f
sudo systemctl restart container-myapp.service
```

## Dos detalles que te salvan después

### Haz la configuración explícita

Usa variables de entorno y un directorio de configuración montado en lugar de meter secretos en la imagen. Con systemd puedes definir overrides en un archivo drop-in y reiniciar de forma segura.

### Elige una política de reinicio que se ajuste a la realidad

Si tu app falla rápido por configuración faltante, los reinicios infinitos son ruido. Prefiere una política de reinicio que no machaque la máquina. Systemd te permite controlar los retardos y los límites de ráfaga.

Si quieres una única prueba de "¿lo estoy haciendo bien?": reinicia la VM y mira si tu servicio .NET vuelve a levantarse sin que tengas que entrar por SSH. Esa es la vara.

Lectura adicional: [https://docs.podman.io/](https://docs.podman.io/)
