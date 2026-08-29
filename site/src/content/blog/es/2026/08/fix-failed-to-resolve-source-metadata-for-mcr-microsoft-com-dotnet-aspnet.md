---
title: "Solución: failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet"
description: "BuildKit no puede leer el manifiesto de tu imagen base. Verifica que el tag exista, repara el credential helper de Docker, abre los dos endpoints de MCR y haz pull previo para compilaciones sin red."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "buildkit"
  - "dotnet-11"
lang: "es"
translationOf: "2026/08/fix-failed-to-resolve-source-metadata-for-mcr-microsoft-com-dotnet-aspnet"
translatedBy: "claude"
translationDate: 2026-08-29
---

Esto es BuildKit fallando al leer el manifiesto de la imagen de tu línea `FROM`, y ocurre antes de que se ejecute una sola instrucción de tu Dockerfile. Cuatro causas cubren casi todos los casos, en este orden: el tag no existe (`11.0` no es un tag real mientras .NET 11 siga en preview), un credential helper roto en `~/.docker/config.json`, un proxy o firewall que bloquea `mcr.microsoft.com` o `*.data.mcr.microsoft.com`, o una compilación sin red con un builder que no puede ver las imágenes que descargaste localmente. Ejecuta primero `docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:10.0`. Si eso también falla, tu Dockerfile no es el problema.

```text
 => ERROR [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0
------
 > [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0:
------
failed to solve: failed to resolve source metadata for
mcr.microsoft.com/dotnet/aspnet:11.0: mcr.microsoft.com/dotnet/aspnet:11.0: not found
```

Todo lo que sigue está verificado contra Docker Engine 29 (BuildKit v0.32.x, Buildx v0.32), .NET 10 (`10.0`, publicado el 2025-11-11) y las previews de .NET 11, que en agosto de 2026 van por la Preview 7 con GA programada para noviembre de 2026. El mismo mecanismo aplica sin cambios a Engine 27 y 28, y al frontend compatible con BuildKit de Podman. Lo único que se mueve entre versiones es la redacción exacta de la cláusula final.

## Qué hace BuildKit cuando dice "resolve source metadata"

BuildKit no ejecuta tu Dockerfile de arriba abajo como lo hacía el builder clásico. Primero construye un grafo de dependencias, y para eso necesita saber qué es realmente cada referencia `FROM`. Eso significa una petición `HEAD https://mcr.microsoft.com/v2/dotnet/aspnet/manifests/<tag>` por imagen base y por compilación, para poder fijar la referencia a un digest de contenido antes de planificar nada. Esa petición es el paso "load metadata" que ves en la salida, y el mensaje que recibiste es ese paso fallando.

De esto se derivan tres consecuencias, y explican casi toda la confusión alrededor del error:

- **Se dispara aunque todas las capas estén en caché.** Las capas en caché no responden a la pregunta "¿este tag sigue apuntando al mismo digest?", así que BuildKit pregunta igual. Por eso una compilación sin red falla en una máquina que compiló exactamente la misma imagen una hora antes.
- **Se dispara antes de `RUN`, `COPY` y `WORKDIR`.** Ningún argumento de compilación que afecte al entorno puede ayudar, porque nada del entorno de compilación ha arrancado todavía. En particular, `--build-arg HTTP_PROXY=...` no hace nada aquí. Ese argumento se inyecta en los pasos `RUN`; no configura el cliente de registro del propio demonio de BuildKit.
- **La cláusula final después de los últimos dos puntos es el error real.** `not found` significa que el tag no existe. `dial tcp ...: i/o timeout` significa red. `error getting credentials` significa tu configuración de Docker. Lee esa cláusula primero y salta directo a la sección correspondiente más abajo.

Todo lo demás en el mensaje es envoltura de BuildKit. El verbo que falla es siempre el mismo.

## El repro mínimo

Dos etapas, una imagen de compilación y una de runtime, que es la forma que generan las plantillas de contenedor de .NET:

```dockerfile
# Docker Engine 29, BuildKit v0.32. Fails at "load metadata".
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`docker build .` falla de inmediato con el error de arriba y nunca llega a `dotnet publish`. Fíjate en que no interviene código de aplicación alguno. Un directorio vacío con solo este Dockerfile lo reproduce, que es la forma más rápida de demostrar que el problema no es tu proyecto.

## Solución 1: comprueba que el tag realmente existe

Esta es la causa más común hoy, y .NET 11 es el motivo. Microsoft no publica un tag flotante de versión mayor hasta que la release llega a GA. Durante la ventana de preview los tags son `11.0-preview` y el fijado `11.0.0-preview.7`, más variantes cualificadas por sistema operativo como `11.0-preview-resolute` y `11.0-preview-alpine`. No hay `11.0`. Ese tag aparece en noviembre de 2026 y no antes, así que un Dockerfile copiado de un proyecto .NET 10 y subido de versión a mano falla sobre un nombre que nunca ha existido.

Pregúntale al registro directamente en lugar de adivinar:

```bash
# Works against any registry, prints the manifest list and its platforms.
docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:11.0-preview
```

MCR también sirve el listado anónimo de tags de OCI, útil cuando quieres ver qué está publicado de verdad:

```bash
curl -s https://mcr.microsoft.com/v2/dotnet/aspnet/tags/list | jq '.tags[] | select(startswith("11.0"))'
```

Otros dos errores de tag producen exactamente el mismo mensaje. El primero es el renombrado del repositorio: .NET Core 3.1 y anteriores vivían bajo `mcr.microsoft.com/dotnet/core/aspnet`, y todo desde .NET 5 en adelante vive bajo `mcr.microsoft.com/dotnet/aspnet`. Un Dockerfile antiguo arrastrado conserva el segmento `core/` y recibe `not found` para cualquier versión moderna. El segundo es elegir una variante de sistema operativo retirada, como un tag `bullseye-slim` en una versión de .NET cuya base Debian ya avanzó. La [documentación de tags de imágenes de contenedor de .NET](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md) es la autoridad sobre qué variantes están vivas, y vale la pena leerla cada vez que cambias de imagen base en lugar de confiar en un post antiguo. Si estás eligiendo entre variantes de sistema operativo, las compensaciones descritas en [los tags de contenedor resolute para .NET 10](/es/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) también aplican a las previews de .NET 11.

## Solución 2: repara el credential helper de Docker

Si la cláusula final se lee así, el registro está bien y lo que está roto es tu configuración local de Docker:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0:
error getting credentials - err: exit status 1, out: ``
```

La CLI de Docker lee `~/.docker/config.json`, ve una entrada `credsStore` o `credHelpers`, y lanza un binario `docker-credential-<nombre>` para obtener las credenciales del registro. Cuando ese binario no está en el `PATH` o no puede llegar a un llavero, la CLI aborta antes de contactar siquiera con MCR. El disparador clásico es `"credsStore": "desktop"` en un archivo de configuración compartido con una distro de WSL2, un contenedor de CI o una sesión SSH remota donde `docker-credential-desktop` no existe.

MCR sirve sus imágenes públicas de forma anónima, así que no necesitas credenciales para él en absoluto. Borra la entrada:

```json
{
  "auths": {},
  "credsStore": ""
}
```

O elimina la clave `credsStore` por completo. En macOS el valor que funciona es `osxkeychain`, en Linux `pass` o `secretservice`, y si de verdad tienes un helper instalado, confirma que responde:

```bash
echo '{"ServerURL":"https://index.docker.io/v1/"}' | docker-credential-desktop get
```

Una variante relacionada aparece como `401 Unauthorized` en una petición HEAD a MCR. Eso significa que se están enviando credenciales obsoletas a un registro anónimo. Bórralas con `docker logout mcr.microsoft.com` y vuelve a compilar.

## Solución 3: abre los dos endpoints de MCR y configura el proxy del builder

Microsoft Artifact Registry reparte su trabajo entre dos nombres de host, y las reglas de firewall escritas solo contra el primero fallan de una forma que parece aleatoria. `mcr.microsoft.com` gestiona el descubrimiento de contenido, es decir, las peticiones de manifiestos y tags. `*.data.mcr.microsoft.com` es la CDN de Azure Front Door que sirve los bytes reales de las capas. Las [reglas de firewall para clientes](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md) de Microsoft exigen ambos sobre HTTPS en el puerto 443, y advierten explícitamente contra reglas específicas por región porque las regiones del endpoint de datos cambian por razones de rendimiento. Si permites solo el endpoint de registro, la resolución de metadatos funciona y el pull muere después. Si no permites ninguno, obtienes el error de este post.

La configuración del proxy es donde se pierde más tiempo, porque depende del driver de builder que uses y los dos se comportan distinto:

- **El driver `docker` por defecto** ejecuta BuildKit dentro del demonio de Docker, así que hereda la configuración de proxy del demonio. En Docker Desktop eso está en Settings, Resources, Proxies. En Linux es un drop-in de systemd en `/etc/systemd/system/docker.service.d/http-proxy.conf` seguido de `systemctl daemon-reload && systemctl restart docker`.
- **El driver `docker-container`** creado por `docker buildx create` ejecuta BuildKit en su propio contenedor, que no hereda nada. Tienes que pasar el entorno de forma explícita:

```bash
# Buildx v0.32. env.<key> sets variables inside the BuildKit container.
docker buildx create --name proxied \
  --driver docker-container \
  --driver-opt env.HTTP_PROXY=http://proxy.corp:8080 \
  --driver-opt env.HTTPS_PROXY=http://proxy.corp:8080 \
  --driver-opt env.NO_PROXY=localhost,127.0.0.1 \
  --use
```

Si tu proxy termina TLS con una autoridad certificadora corporativa, la cláusula final es `tls: failed to verify certificate: x509: certificate signed by unknown authority`. La solución del lado del demonio es instalar la CA en el almacén de confianza del host y reiniciar Docker. Para un builder `docker-container` tienes que meter la CA dentro de ese contenedor, ya sea montándola mediante un `buildkitd.toml` personalizado o compilando en el driver por defecto.

Los fallos puros de DNS se manifiestan como `dial tcp: lookup mcr.microsoft.com: no such host`, algo común en WSL2 tras un cambio de VPN. Fijar resolvers explícitos en `/etc/docker/daemon.json` con `"dns": ["1.1.1.1", "8.8.8.8"]` y reiniciar el demonio suele resolverlo.

## Solución 4: haz pull previo para compilaciones sin red, y cuida el driver del builder

Como la resolución de metadatos siempre quiere un registro vivo, una compilación aislada o con red inestable falla incluso cuando las capas están en disco. La solución es hacer que la imagen esté presente en el almacén local de imágenes, no meramente en caché:

```bash
# Run these while you still have connectivity.
docker pull mcr.microsoft.com/dotnet/sdk:10.0
docker pull mcr.microsoft.com/dotnet/aspnet:10.0
```

Con el driver `docker` por defecto, BuildKit puede entonces resolver la referencia desde el almacén de imágenes del demonio y la compilación sin red funciona. Añadir `--pull=false` hace la intención explícita e impide que BuildKit prefiera una búsqueda remota.

La trampa es que esto solo funciona en el driver por defecto. Un builder `docker-container` tiene su propio almacén de contenido y no puede ver las imágenes del demonio de Docker, que es [un comportamiento de larga data y redescubierto con frecuencia](https://github.com/moby/moby/issues/49542). Si creaste un builder personalizado para salida multiplataforma y luego te quedaste sin red, el pull previo no te sirve de nada. Vuelve con `docker buildx use default` para trabajo sin red, o levanta un mirror de registro al que el builder sí pueda llegar.

La misma distinción muerde en CI. Los runners de GitHub Actions que usan `docker/setup-buildx-action` obtienen un builder `docker-container` por defecto, así que un workflow que funciona en local tras un paso de `docker pull` seguirá golpeando el registro en el runner.

## Solución 5: haz coincidir la plataforma

Si el tag existe pero no tiene imagen para tu plataforma objetivo, el fallo llega en el mismo paso con una cola distinta:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0-nanoserver-ltsc2022:
no match for platform in manifest: not found
```

Dos formas comunes. La primera es un tag solo de Windows como `nanoserver` o `windowsservercore` solicitado desde un demonio que ejecuta contenedores Linux. Cambia Docker Desktop a contenedores Windows, o usa un tag de Linux. La segunda es un `--platform linux/arm64` explícito contra un tag que solo publica amd64, algo que ocurre con imágenes sidecar de terceros más a menudo que con las de Microsoft, ya que las imágenes de runtime de .NET publican amd64, arm64 y arm32v7. `docker buildx imagetools inspect` lista todas las plataformas de la manifest list, así que consúltalo antes de dar por rota la imagen.

## Variantes que parecen lo mismo pero no lo son

`failed to solve: process "/bin/sh -c dotnet restore" did not complete successfully` es un fallo completamente distinto. La resolución de metadatos funcionó y tu compilación ya está corriendo, así que el problema es NuGet, no el registro. De igual modo, `NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json` dentro de una etapa de compilación significa que el contenedor llega a MCR pero no a NuGet, que suele ser la misma historia de proxy una capa más abajo.

Si la imagen se descarga y arranca pero el contenedor sale de inmediato, ya pasaste este error y estás en territorio de runtime. El crash de globalización que cubre [la solución al paquete ICU ausente](/es/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) es el más común en imágenes base ligeras.

Por último, si te encuentras peleando con las líneas `FROM`, plantéate si necesitas un Dockerfile. El SDK puede producir una imagen OCI directamente, y [publicar una app .NET 11 con `/t:PublishContainer`](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) resuelve las imágenes base con una lógica al estilo NuGet que falla con mensajes mucho más específicos que los de BuildKit.

## Relacionado

- [Cómo publicar una app .NET 11 como imagen de contenedor con dotnet publish /t:PublishContainer](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [.NET 10 en Ubuntu 26.04: tags de contenedor resolute y Native AOT en el archivo](/es/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)
- [Solución: Couldn't find a valid ICU package installed on the system en un contenedor .NET](/es/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)
- [SBOM para .NET en Docker: deja de forzar a una sola herramienta a verlo todo](/es/2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything/)
- [Aspire vs Docker Compose para desarrollo local multiservicio](/es/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/)

## Fuentes

- [Reglas de firewall para clientes de Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md)
- [Guía de endpoints de Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/mcr-endpoints-guidance.md)
- [dotnet/dotnet-docker: tags soportados del runtime de ASP.NET Core](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md)
- [Documentación de Docker: opciones del driver de compilación docker-container](https://docs.docker.com/build/builders/drivers/docker-container/)
- [Documentación de Docker: variables de compilación y argumentos de proxy](https://docs.docker.com/build/building/variables/)
- [moby/moby#49542: BuildKit con el driver docker-container se niega a usar imágenes locales](https://github.com/moby/moby/issues/49542)
- [dotnet/core#8268: docker-compose build falla al descargar imágenes de mcr.microsoft.com](https://github.com/dotnet/core/issues/8268)
