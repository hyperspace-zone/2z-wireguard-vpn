# Защита входа по email от OTP-флуда

## Production и доверенный IP

Контур production: `app.hyperspace.zone` → Caddy на web (`84.32.83.69`) →
Caddy на control-plane (`5.199.161.13`) → Fastify, слушающий только `127.0.0.1:8080`.
Staging и testnet выведены из эксплуатации; эти изменения не создают их заново.

Web Caddy перезаписывает X-Forwarded-For адресом TCP-клиента. Control-plane
доверяет цепочке только от web `84.32.83.69` / `10.179.228.36`. Fastify получает
явный allowlist `TRUSTED_PROXY_CIDRS=127.0.0.1,::1,84.32.83.69,10.179.228.36`.
Прямой клиент control-plane не может назначить себе IP заголовками X-Forwarded-For,
X-Real-IP или CF-Connecting-IP. Произвольный Authorization не создаёт новый лимит.
IPv6-адреса внутри одного /64 делят счётчик.

Конфигурации Caddy: `infra/caddy/Caddyfile.app.mainnet.example` и
`infra/caddy/Caddyfile.control-plane.mainnet.example`. Они совместимы с установленным
Caddy 2.6 (`skip_log`; в новых версиях директива переименована в `log_skip`).
Перед применением: `caddy validate --adapter caddyfile --config PATH`; создать
`/var/log/caddy` с владельцем caddy и без доступа других пользователей; применять
через `systemctl reload caddy`, сохранив предыдущий Caddyfile.

## Пять уровней защиты

1. **Логирование.** Caddy пишет только auth access metadata в
   `/var/log/caddy/auth-access.json`: время, TCP IP, HTTP method/path/status/duration.
   Заголовки, cookies, query-параметры и тела запросов не записываются. Размер одного
   файла 10 MiB, максимум 10 архивных файлов, возраст максимум 7 дней. При флуде
   лимит размера может сократить доступную историю: это не гарантированные 7 дней.
   На API `journalctl -u hyperspace-control-plane-api` содержит JSON-события
   `auth_security_request` и `auth_security_summary`: проверенный `client_ip`,
   `request_id`, action/status/reason и HMAC-SHA256 нормализованного email, а не
   адрес или код. Один исходный event на IP/action/outcome в минуту; повторы
   агрегируются. Summary относится к IP/action/outcome, не к одному email.
   Отдельный счётчик `auth_audit_overflow_total` отмечает превышение ёмкости 2000
   одновременно активных audit-buckets. IP/email не используются в labels Prometheus.
   HTTP→HTTPS redirects не пишут access-log. Глобальные Caddy error logs также
   скрывают headers/query и download-token из пути `/artifacts/download/...`.
   Для реально созданных OTP `metadata` хранит `source_ip`, `request_id`,
   `turnstile_verified` и `delivery_status`. Старые записи без source_ip восстановить
   задним числом невозможно.

2. **Ограничение до БД/отправки.** Все auth POST относятся к категории auth:
   30 запросов за 5 минут с IP. OTP request-code и register дополнительно делят
   лимит 5 запросов за 15 минут с IP. Изменить email, Authorization или forwarding
   headers для обхода лимита нельзя. Счётчики IP ограничены 10000 buckets и при
   заполнении отклоняют новые identities, не вытесняя действующие ограничения.
   Durable recipient-limit: 60 секунд cooldown и 3 admitted попытки за 15 минут.
   Заблокированный запрос не создаёт challenge, пользователя или отправку.
   Неудачные попытки verify-code не сбрасываются при resend, срок кода не продлевается;
   после пяти ошибочных вводов нужно дождаться истечения текущего окна.
   Верификация кода не требует новой CAPTCHA, но остаётся под auth IP-лимитом.

3. **Turnstile.** Managed-виджет на формах OTP и регистрации. API проверяет token
   через Siteverify, `success`, точный hostname `app.hyperspace.zone` и action
   `email_otp` / `register` до создания пользователя/challenge. Пустой, поддельный,
   истёкший или повторно использованный token отклоняется. При проблеме Cloudflare
   вход по email/регистрация fail closed (503), а не пропускают запрос. До 8
   одновременных проверок; timeout 5 секунд. Google/password и существующие сессии
   не требуют Turnstile. Ошибка загрузки виджета оставляет отправку disabled и
   показывает предложение перезагрузить страницу/воспользоваться Google.

4. **Общий бюджет и sender.** 80 admitted попыток в UTC-сутки и не чаще 1/секунду
   для OTP, независимо от IP/email. Это начальные safety-настройки, не тариф Resend.
   Бюджет сохраняется в `email_auth_send_limits`; перезапуск или второй API-инстанс
   не обходит его. Failed attempts тоже расходуют бюджет. Billing/meta письма
   не используют этот OTP-бюджет, но общая квота/скорость аккаунта Resend всё равно
   общая: проверьте тариф и оставьте для них запас. Нет неограниченной очереди:
   busy-запрос получает Retry-After. Sender: максимум 2 in-flight, 5 секунд timeout,
   Idempotency-Key на challenge, без циклов повторной отправки. При 429/ошибке
   провайдера применяется durable backoff 30–300 секунд. Неотправленный challenge
   помечается failed/consumed, не копится как действующий OTP; прежний рабочий
   код сохраняется. Таблица quota state чистится небольшими пачками по 500 строк
   старше двух дней, не затрагивая историю OTP.

5. **Алерты.** `HyperspaceEmailAuthAbuseBlocked` — warning после 5 минут устойчивого
   >1 blocked request/сек, один агрегат по service/cluster. `BudgetLow` — warning
   при использовании ≥80% бюджета. `BudgetExhausted`, `DeliveryUnavailable`,
   `TurnstileValidationUnavailable` — critical после 5 минут. Delivery alert означает,
   что последняя попытка не удалась и последующая успешная отправка не подтвердила
   восстановление; это не непрерывный probe провайдера. Последний исход сохраняется
   в quota state: перезапуск API сам по себе не объявляет доставку восстановленной.
   Budget snapshot stale — warning.
   `HyperspaceEmailAuthLimiterUnavailable` — critical при отказе durable quota storage;
   `HyperspaceAuthAuditCapacityExceeded` — warning при переполнении audit-buckets.
   Все service alerts наследуют host/IP control-plane и показывают Service access
   в Telegram. Не увеличивать бюджет и не выключать CAPTCHA автоматически из-за атаки.

## Внешние настройки и секреты

Cloudflare → Turnstile: widget `hyperspace-production-auth`, hostname только
`app.hyperspace.zone`, mode Managed, pre-clearance выключен. DNS-only режим остаётся;
включать проксирование gates не требуется. В будущем при включении proxy на web
нужно отдельно настроить проверенную цепочку Cloudflare IP; доверять произвольному
CF-Connecting-IP нельзя. CSP, если добавляется, должен разрешать script/frame
`https://challenges.cloudflare.com`.

Site Key публичный и отдаётся только через `/v1/public/auth/security`; Secret Key
не попадает в Git, web bundle, API response или лог. Операторский оригинал:
`/root/hyperspace/.provider_creds/cloudflare/turnstile-production-secret` (0600 root).
Runtime-копия на control-plane: `/etc/hyperspace/turnstile-production-secret`
(0640 root:hyperspace). API читает её через `TURNSTILE_SECRET_KEY_FILE` при старте;
после ротации заменить обе копии и перезапустить только API.

Параметры перечислены в `infra/systemd/control-plane-api.env.example`. В production:
`TURNSTILE_ENABLED=true`, site key, secret file и exact hostname обязательны.
Неполная конфигурация не позволяет API запуститься. Миграции `0052`/`0053` обязательны
перед rollout; API не продолжает отправку без durable quota storage.

Resend: проверить verified sending domain, доступ ключа к нему, дневную/месячную
квоту и аккаунтный RPS-limit. Отдельный API key для OTP удобен для ротации, но не
создаёт отдельную квоту аккаунта. Платный тариф/новый сервис для этих мер не обязателен.
HTTP 429 сам по себе не доказывает исчерпание квоты: sender различает allowlisted
`rate_limit_exceeded`, `daily_quota_exceeded` и `monthly_quota_exceeded`.
Безопасное имя ошибки попадает в audit reason и `email_auth_provider_errors_total`;
произвольные response body/message никогда не записываются. Квотные ошибки дают
backoff 300 секунд, не автоматический resend. Send-only ключ может не иметь доступа
даже к `/usage`; в таком случае лимиты проверяются владельцем аккаунта в dashboard.
Результат отправки/ошибка показываются прямо на форме входа или регистрации,
а не только в скрытом event-log. При 503 интерфейс не утверждает, что письмо отправлено.

## Проверка и безопасный rollout

- Unit tests: `npm test -w @hyperspace-zone/control-plane-api`.
- Caddy logging/proxy policy: `node --test scripts/security/caddy-auth-config.test.mjs`;
  сами конфигурации дополнительно валидируются установленным Caddy до reload.
- Browser integration: после web build `node scripts/security/email-auth-ui-smoke.mjs`.
  Cloudflare-виджет и API замоканы; это проверка UI, не доказательство реального CAPTCHA.
- PostgreSQL integration: `EMAIL_AUTH_INTEGRATION_TEST=1 node --test
  apps/control-plane-api/dist/services/email-auth.integration.test.js` с DATABASE_URL.
  Создаёт случайную `test_email_auth_*` schema с пустыми копиями auth-таблиц,
  проверяет quota concurrency/restart, cooldown, resend, replay и полный OTP login,
  удаляет только эту schema в finally. Реальные пользователи/почта не затрагиваются.
- Проверять missing token на app и прямом control-plane: 403 без нового challenge.
- Проверять реальные hostname/action/token в production вручную через форму;
  production test-key или bypass CAPTCHA никогда не включать.
- После rollout проверить `/health`, новый security endpoint, auth IP в журнале,
  budget metrics, Caddy access path без query и loaded Prometheus rules.
- При откате API сохранять quota table/state и исходные auth logs. Не откатывать
  защиту автоматически в unrestricted sending mode.

Документация провайдеров: [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
[hostnames](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/),
[Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
