---
title: "Cómo solucionar 'Missing MySQL extension' en WordPress tras una actualización de MultiPHP en HostGator"
description: "Soluciona el error de WordPress 'Missing MySQL extension' tras actualizar PHP con el MultiPHP manager en HostGator eliminando el handler obsoleto del .htaccess."
pubDate: 2020-11-06
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "es"
translationOf: "2020/11/how-to-fix-wordpress-missing-mysql-extension-after-multiphp-upgrade-on-hostgator"
translatedBy: "claude"
translationDate: 2026-05-01
---
Tras actualizar la versión de PHP de tu sitio WordPress usando el MultiPHP manager para utilizar PHP 7, podrías encontrarte con el siguiente error:

`Your PHP installation appears to be missing the MySQL extension which is required by WordPress.`

Esto se debe a un handler obsoleto en tu archivo `.htaccess`.

## Cómo solucionarlo

1.  [Localiza tu archivo .htaccess](https://www.youtube.com/watch?v=7ZG8c8wwEbs) usando el File Manager del cPanel
2.  Crea una copia de seguridad del archivo
3.  Edita el archivo eliminando el handler obsoleto, que debería verse así:

```plaintext
# Use PHP71 as default
AddHandler application/x-httpd-php71 .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/php71/lib
</IfModule>
```

O bien:

```plaintext
#Use PHPedge as default
AddHandler application/x-httpd-php-edge .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/phpedge/lib
</IfModule>
```

Guarda el archivo y el error debería desaparecer.
