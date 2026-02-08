---
title: "How to fix WordPress Missing MySQL extension after MultiPHP upgrade on HostGator"
description: "Fix the 'Missing MySQL extension' WordPress error after upgrading PHP via the MultiPHP manager on HostGator by removing the obsolete handler from .htaccess."
pubDate: 2020-11-06
updatedDate: 2023-11-05
tags:
  - "wordpress"
---
After upgrading your WordPress site’s PHP version using the MultiPHP manager to use PHP 7, you might be running into the following error:

`Your PHP installation appears to be missing the MySQL extension which is required by WordPress.`

This is caused by an obsolete handler in your `.htaccess` file.

## Fixing it

1.  [Locate your .htaccess file](https://www.youtube.com/watch?v=7ZG8c8wwEbs) using the cPanel File Manager
2.  Create a backup of the file
3.  Edit the file by removing the obsolete handler, which should look like this:

```plaintext
# Use PHP71 as default
AddHandler application/x-httpd-php71 .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/php71/lib
</IfModule>
```

OR

```plaintext
#Use PHPedge as default
AddHandler application/x-httpd-php-edge .php
<IfModule mod_suphp.c>
    suPHP_ConfigPath /opt/phpedge/lib
</IfModule>
```

Save the file and the error should be gone.
