# Публичные benchmarks/trading: скорость и ограничение нагрузки

## Реализация

Mongo `trading_latest` читается по ID действующих nodes и targets, выбранный
target фильтруется в Mongo, а не после передачи всех документов. Projection
ограничивает поля. Индекс `(targetId,nodeId,networkProfile)` поддерживает эти
чтения; benchmark latest — `(sourceGateId,targetGateId,transport)`. Batch size
512 избегает лишнего getMore для текущих 270 trading/144 benchmark документов.
Mongo pool: максимум 3, минимум 1 соединение, waitQueueTimeout 250 ms.
Нет нового клиента/TLS handshake на каждую страницу.

Public API держит ровно два фиксированных снимка: matrix и trading latency.
Обновление каждые 10 секунд, single-flight, максимум 2 MiB JSON на снимок.
Категория/target выбираются из готового trading снимка: произвольные параметры
не создают ни новых cache entries, ни дополнительных запросов к БД. Некорректные
параметры ограничены schema. Cold reads разделяют один refresh. Сбой: retry
через 5 секунд, last-good до 60 секунд с `snapshotStatus=stale`; затем 503.
`generatedAt`, `measuredAt`, revisions не переписываются временем чтения.
UI показывает предупреждение stale. Это freshness снимка, не обещание, что
каждый endpoint/measurement здоров: freshness исходных измерений проверяется
независимо. Cache нельзя использовать для применения VPN, balances/payments
или eligibility trading preset. Проверка перед покупкой остаётся fresh.

Только успешные live anonymous ответы matrix/latency получают
`Cache-Control: public, max-age=0, s-maxage=5, must-revalidate` и weak ETag.
Cookies/Authorization, stale/error, Pair Routes, checkout и остальные `/api/*`
остаются no-store. 304 не возвращается для stale/failed snapshot. Query string
сохраняется в CDN cache key, иначе смешаются разные category/target.

Чтобы атака не усиливалась логированием, public measurement completion logs
ограничены 60 success + 60 error строками/min/process. Успешные частые probe
poll/report логируются с sampling 1/100; operational errors/reports и отдельный
auth audit не подавляются. Метрики считают **все** запросы. Request logs —
выборка для диагностики, не источник точного request count или биллинга.

Отдельный бюджет public measurements: 120 запросов/min/IP, 600/min/process,
максимум 8 одновременно, без очереди. IP overflow — 429, global/concurrency —
503; Retry-After и no-store. Все эти budgets независимы от gate/probe polling,
auth и billing. Настройки API: `PUBLIC_MEASUREMENTS_WINDOW_SECONDS`,
`PUBLIC_MEASUREMENTS_IP_MAX`, `PUBLIC_MEASUREMENTS_GLOBAL_MAX`,
`PUBLIC_MEASUREMENTS_MAX_IN_FLIGHT`. IPv6 адреса агрегируются по /64.

Эта реализация снижает нагрузку на обе БД. Однако публичные API и core пока
делят Fastify process/CPU: защита от объёмной DDoS требует edge/origin controls,
а не только RAM cache. Для более строгой CPU-изоляции можно вынести serving
этих снимков в отдельный процесс на существующем web host — без новой VM.

## Cloudflare — действия администратора

Работать только с `app.hyperspace.zone`. `control-plane`, `db`, Mongo и домены
gate оставить DNS-only: WireGuard не идёт через обычный HTTP proxy Cloudflare.

1. DNS → `app` A `84.32.83.69` → **Proxied**, оранжевое облако.
2. SSL/TLS → **Full (strict)**. Не Flexible. HTTPS сертификат Caddy валиден.
3. Caching → Cache Rules → Create rule `Hyperspace public measurement snapshots`:

   ```text
   (http.host eq "app.hyperspace.zone"
    and http.request.method in {"GET" "HEAD"}
    and http.request.uri.path in {"/api/v1/public/benchmarks/gate-matrix" "/api/v1/public/trading/latency"}
    and http.cookie eq ""
    and not any(http.request.headers["authorization"][*] ne ""))
   ```

   - Cache eligibility: **Eligible for cache**.
   - Edge TTL: **Use cache-control header if present, bypass cache if not**.
   - Browser TTL: **Respect origin**.
   - Не задавать TTL override и не игнорировать query string. `s-maxage=5`
     задаётся API. Не включать Cache Everything для всего `/api/*`.
   - Не задавать status-code TTL override: 429/503/stale не кэшировать.
4. Security → WAF/Rate limiting → правило `Hyperspace measurement reads`:

   ```text
   (http.host eq "app.hyperspace.zone"
    and http.request.method in {"GET" "HEAD"}
    and http.request.uri.path in {"/api/v1/public/benchmarks/gate-matrix" "/api/v1/public/trading/latency" "/api/v1/public/trading/pairs"})
   ```

   Counting characteristic: IP; стартовый лимит **30 requests / 10 seconds**;
   action **Block**, duration **10 seconds**, если эти значения доступны на
   тарифе. Если панель предлагает другие интервалы/платную функцию — прислать
   варианты; API budget уже работает независимо от доступности WAF rule.
   Не включать Managed Challenge для всего `/api/*`: это ломает machine clients.
5. Проверить login/Turnstile, real client IP, gates heartbeats, benchmarks,
   trading. После нескольких запросов проверить `CF-Cache-Status: HIT`, Age,
   сохранённые original timestamps. HTTP errors не должны давать HIT.
6. Только после proxy/DNS/health проверки закрыть обход web origin:

   ```bash
   sudo bash /opt/2z-wireguard-vpn/scripts/security/enable-cloudflare-web-origin --proxy-verified
   ```

   Скрипт предназначен только для `84.32.83.69`, проверяет DNS IP на попадание
   в Cloudflare ranges и иначе отказывается. Отдельная nft table блокирует
   только TCP/80,443 и UDP/443 извне CF; сохраняет прямые health checks с
   observability. SSH/9100/другие tables не меняются; UFW глобально не включает.
   Service переживает reboot. Откат:

   ```bash
   sudo systemctl disable --now hyperspace-web-origin.service
   ```

Web Caddy доверяет CF-Connecting-IP **только** когда TCP peer принадлежит
официальному Cloudflare range; direct посетителю принудительно ставит его
remote_host. CP доверяет forwarding только текущему web host. Прямой публичный
запрос к измерениям на control-plane получает 403 ещё в Caddy, до Node/БД;
agents, health, metrics и остальные API не меняются. CF ranges проверены
7 октября 2026; сверять перед будущими изменениями/включением origin guard:
https://www.cloudflare.com/ips-v4 и https://www.cloudflare.com/ips-v6.

Документация провайдера:
[Cache Rules settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/),
[origin protection](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/),
[rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## Проверки и monitoring

Unit: Mongo catalog filters; live Mongo indexes/read selection; cache
single-flight, errors/backoff/age expiry/size budget, ETag/auth bypass,
query-cardinality, independent global/IP/concurrency budgets, fresh checkout.
Public API outage не должен срывать core health или transactional routes.

Metrics: `hyperspace_public_measurement_snapshot_updated_at_seconds`,
`hyperspace_public_measurement_snapshot_refresh_seconds`,
`hyperspace_public_measurement_snapshot_refresh_total`,
`hyperspace_public_measurement_load_shed_total`. Labels фиксированные, без
сырого target/query/IP. Warning правила для snapshot stale и load shedding
в `infra/observability/prometheus/rules/hyperspace-public-measurements.yml`.

Staging/testnet выведены из эксплуатации: изменения проверять локально и в
изолированных Mongo test collections, затем live production с runtime rollback.
Не объявлять canary проверенным, если соответствующей VM уже нет.

## Production rollout — 7 октября 2026

API, optional probes worker, web UI, Caddy и Prometheus rules обновлены.
Core worker не перезапускался, gate binaries и финансовые настройки не менялись.
Runtime rollback: `/opt/hyperspace-rollbacks/public-reads-20261007T091620Z`
на control-plane. Копия web: `/var/backups/hyperspace-web-public-reads-20261007/`.
Оба Caddyfile сохранены как `/etc/caddy/Caddyfile.before-public-reads-20261007`.
Cloudflare DNS/WAF и web origin guard **ещё не включены**: требуется ручной
шаг администратора из раздела выше.

Одинаковый readonly замер до/после: 12 HTTP запросов на каждый endpoint,
три cold и три warm браузерных открытия каждой из пяти страниц. Все 60
API запросов вернули 200; 30 браузерных открытий без JavaScript ошибок.

| Endpoint | Медиана server processing до | После | HTTP round-trip после |
|---|---:|---:|---:|
| Benchmarks matrix | 17 ms | 2 ms | 30 ms |
| Trading CEX | 26 ms | 1 ms | 20 ms |
| Trading Hyperliquid | 30 ms | 1 ms | 20 ms |

Это **не** время полной загрузки страницы. Cold browser readiness осталась
около 360–420 ms; загрузка JS, render и карты в этих условиях доминируют.
Raw результаты вне репозитория на dev: `/tmp/hyperspace-production-page-timings-20261007.json`
и `/tmp/hyperspace-production-page-timings-after-optimization-20261007.json`.

Live outage drill временно остановил только Mongo примерно на 65 секунд:
core health и public gates оставались 200, completed probe schedule продолжал
обновляться, delivery outbox вырос с 1 до 165. Last-good measurements выдавались
как `stale` с `no-store` и неизменным `generatedAt`; после 60 секунд API вернул
503. Mongo восстановлен в `finally`, оба snapshot автоматически вернулись в
live, delivery backlog снова сокращается. Этот drill не выпускал и не проверял
реальные VPN-конфиги и не выполнял платежи.

Финальная проверка также исправила retention warning: statement-level запрет
legacy measurement writes срабатывал на пустом `ON DELETE SET NULL` при удалении
старых probe jobs. Guard теперь row-level: реальные SQL-записи измерений всё
ещё запрещены, пустое FK-обслуживание разрешено. В Mongo-backed режиме worker
чистит только SQL job journals; measurement retention выполняется Mongo TTL.
Repair для уже завершённого cutover — `scripts/db/repair-mongo-measurement-guards.sql`
(только probes/5433, только пустые legacy tables, без удаления данных).
Native rollback-only smoke test — `scripts/db/check-mongo-measurement-guards.sql`.
