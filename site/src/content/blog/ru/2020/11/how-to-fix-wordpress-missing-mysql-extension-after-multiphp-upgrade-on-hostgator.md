---
title: "Как исправить ошибку 'Missing MySQL extension' в WordPress после обновления MultiPHP на HostGator"
description: "Исправьте ошибку WordPress 'Missing MySQL extension' после обновления PHP через MultiPHP manager на HostGator, удалив устаревший handler из .htaccess."
pubDate: 2020-11-06
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "ru"
translationOf: "2020/11/how-to-fix-wordpress-missing-mysql-extension-after-multiphp-upgrade-on-hostgator"
translatedBy: "claude"
translationDate: 2026-05-01
---
После обновления версии PHP вашего сайта WordPress через MultiPHP manager до PHP 7 вы можете столкнуться со следующей ошибкой:

`Your PHP installation appears to be missing the MySQL extension which is required by WordPress.`

Причина - устаревший handler в файле `.htaccess`.

## Как это исправить

1.  [Найдите файл .htaccess](https://www.youtube.com/watch?v=7ZG8c8wwEbs) через File Manager cPanel
2.  Создайте резервную копию файла
3.  Отредактируйте файл, удалив устаревший handler. Он должен выглядеть примерно так:

```plaintext
# Use PHP71 as default
AddHandler application/x-httpd-php71 .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/php71/lib
</IfModule>
```

ИЛИ

```plaintext
#Use PHPedge as default
AddHandler application/x-httpd-php-edge .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/phpedge/lib
</IfModule>
```

Сохраните файл - и ошибка должна пропасть.
