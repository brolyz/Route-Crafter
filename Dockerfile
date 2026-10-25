FROM nginxinc/nginx-unprivileged:1.28-alpine

COPY --chown=nginx:nginx docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=nginx:nginx index.html styles.css robots.txt sitemap.xml LICENSE /usr/share/nginx/html/
COPY --chown=nginx:nginx js/ /usr/share/nginx/html/js/
COPY --chown=nginx:nginx vendor/ /usr/share/nginx/html/vendor/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -Y off -q -O /dev/null http://127.0.0.1:8080/ || exit 1
