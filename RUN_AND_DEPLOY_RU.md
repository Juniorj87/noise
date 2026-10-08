# Запуск и публикация Noise Hub

Исходники исправлены, публикации на noisesui.vercel.app не было. Сначала прочитайте `AUDIT_REPORT_RU.md` и `PUBLIC_COVERAGE.json`: публично оставлены только ограниченные поддерживаемые направления, не все исходные 32 записи.

## Локально

Node.js 24 рекомендуется (минимум 22). Выполнять из корня:

```bash
npm ci
npm run build
npm test
npm run test:integration
```

Два терминала:

```bash
npm run dev
```

```bash
python3 -m http.server 3000 --bind 127.0.0.1 --directory public
```

Открыть http://127.0.0.1:3000/app.html. Frontend на localhost ожидает API 3001. Для read-only локального запуска БД может использовать SQLite fallback. Свой `.env.local` загружать явно:

```bash
node --env-file=.env.local server/src/server.js
```

Не запускать с буквальными placeholder credentials. В ZIP нет зависимостей node_modules, приватных ключей, `.env.local`, локальной БД и Vercel bindings.

## Конфигурация

- SUI_NETWORK=mainnet; RPC/gRPC/GraphQL должны соответствовать mainnet. Identity guard не обходить.
- Для production задать DATABASE_URL своего PostgreSQL; схема `database/schema.sql`. Проверить `npm run test:pg` с реальной БД отдельно.
- ADMIN_KEY и CRON_SECRET — собственные случайные server-side secrets.
- Default swap fee = 2 bps = 0,02%. `ACTION_HUB_DEFAULT_FEE_BPS` и `PLATFORM_SWAP_FEE_BPS` держать согласованными. Публичный адрес `ACTION_HUB_FEE_RECIPIENT`/`NOISE_HUB_REVENUE_WALLET` указан в `.env.example`; это получатель, не signing key. Проверьте, что вы действительно контролируете этот адрес.
- `PLATFORM_EARN_FEE_BPS=0`; новый earn fee leg не реализован. Не выдавать bridge/LP/DeepBook за fee-bearing router swaps.
- Без DATABASE_URL router fee НЕ отключается: действуют env/defaults. Настроенная неработающая БД блокирует fee config. Production admin сохраняет конфигурацию в БД; локальные admin changes — runtime only, повторить в env перед перезапуском.
- `SUI_GRAPHQL_URL` default https://graphql.mainnet.sui.io/graphql; для production нужны подходящие лимиты RPC/GraphQL. Public endpoints могут возвращать 429. Retry не гарантирует доступность.
- Главные маршруты: Start, Swap, Place funds, Positions / exit. More содержит Advanced; Community — Referral/Leaderboard. AI доступен рядом с review и в More. Automation/Skills не возвращены. Для реального LLM нужны серверный ключ и AI_MODEL; без них работают явно помеченные read-only tools. Referral/Leaderboard требуют DATABASE_URL для production persistence. Денежные выплаты не реализованы, PAYOUT_ENABLED=false.
- Никаких seed/mnemonic/private keys в сервере или frontend. Подпись выполняется пользовательским кошельком.

## Мост

Самостоятельно размещённый официальный Wormhole Connect 6.0.0 находится в `assets/wormhole` и копируется сборкой в `public/assets/wormhole`. Не удалять vendor files/LICENSE. Поддерживаемые в конфигурации сети: Sui/Ethereum/Arbitrum/Base/Solana, один конец Sui. Public RPC можно заменить на свои в конфигурации openBridge, без изменения chain identity. API keys в браузерной конфигурации будут публичными: использовать только подходящие публичные/ограниченные credentials.

У Connect собственные source/destination wallets, route fees, review, подпись и recovery. Noise не добавляет bridge fee. Для signed cross-chain E2E нужен отдельный ручной тест; успешная загрузка виджета его не заменяет.

## Повторить неподписанные проверки

```bash
npm run audit:reads
npm run audit:builds
npm run audit:new
npm run audit:liquidity
npm run audit:revision
npm run audit:journey
node scripts/audit-journey-exits.mjs
node scripts/audit-journey-receipts.mjs
```

Скрипты создают unsigned bytes и симулируют публичное mainnet-состояние; не подписывают/не отправляют. Необходим доступ к живым провайдерам. Object-version races, изменившийся баланс/ликвидность и RPC limits могут потребовать повторной сборки. Отчёты в audit перезаписываются.

## Vercel

Build command `npm run build`, output `public`, приложенный `vercel.json`. Указать production env в Vercel Dashboard и собственную PostgreSQL. Не переносить `.vercel` из старого архива. Function maxDuration в конфигурации 60s: проверить поддержку тарифа и время холодных SDK/GraphQL вызовов. Проверить crons и CRON_SECRET до включения.

После deploy повторить health, read и unsigned build проверки на production. Затем самостоятельно проверить небольшой реальный цикл wallet→review→sign→digest→receipt, обратные операции/claims и bridge recovery. Независимый security review необходим перед широким запуском. Тесты этой версии не гарантируют безопасность протоколов и не подтверждают уже полученную комиссию.

## Изменение каталога

`shared/registry.js`: полный исторический реестр и отдельный публичный allowlist. После изменения:

```bash
node scripts/gen-ui-registry.mjs
npm run build
npm test
```

Не добавлять LIVE/публичную кнопку без реального builder и проверки. Build artifacts в public не заменяют root HTML исходники.

## Новый цельный сценарий

Открыть app.html#journey. Выбрать исходный актив и поддерживаемый рынок Suilend/NAVI/Kai. Если типы активов различаются, swap и deposit входят в один атомарный PTB, в депозит попадает фактический output Coin. Подписать только после review и fresh simulation. После receipt обновить позиции; withdrawal — отдельная транзакция. При pending/unknown проверить digest и историю кошелька, не отправлять повторно. Не очищать журнал незавершённой операции ради нового submit.

## Gemini: настоящее общение с моделью

В Vercel Environment Variables задать:

```dotenv
AI_PROVIDER=gemini
GOOGLE_AI_API_KEY=<ваш секретный ключ Google AI Studio>
AI_MODEL=<доступный вашему аккаунту идентификатор Gemini>
```

Это пример конфигурации, не работающий ключ. Выбрать действительную модель провайдера; ключ не встраивать в HTML, public/, frontend bundles или VITE_/NEXT_PUBLIC_ переменные. Не присылать секрет в чат. Redeploy после изменения env. `/api/ai/providers` показывает только readiness booleans, не ключ. Проверить ответ с mode=llm; tools-only явно означает отсутствие/ошибку model configuration. При сбое источника AI должен показать unavailable, не выдумать баланс/rate. Нет автоматического trading-agent исполнения.

## Referral и Leaderboard

Учитываются только успешные on-chain receipts для подготовленных Workflows; старые действия не задним числом превращаются в рейтинг. Таблицы noise_workflow_builds/noise_workflow_receipts и noise_ref_codes/noise_ref_invites/noise_ref_challenges создаются backend при первом обращении. Production DB пользователь должен иметь необходимые права, затем проверить на своей PostgreSQL. При недоступной БД выводится ошибка, не фиктивное пустое состояние.

Referral использует origin открытого сайта, а не устаревший hardcoded domain. При переходе `/?ref=CODE#referral` code лишь заполняется; привязка происходит после явного opt-in и personal-message signature. Кошелёк должен поддерживать sui:signPersonalMessage. Код постоянный, inviter один, nonce 5 минут. Статистика — counts, не заработок. Revenue sharing/payouts потребуют отдельно согласованной политики, проверенного учёта дохода по активам и реальной системы выплат; этот выпуск их не рекламирует.

Для локального HTTP аудита приглашений запустить API с `DB_PATH=/data/noise-smoke.db` либо указать фактический DB_PATH скрипту `scripts/audit-referrals.mjs`. Скрипт подписывает только ownership messages вновь созданными тестовыми ключами без средств; удаляет свои строки. Не запускать тестовые регистрации на production без отдельной тестовой БД.

SuiPump/Perpsplexity удалены из публичного интерфейса этого выпуска. Проверка CoinMetadata сама по себе не обещает доступный DEX route.

## Новый интерфейс и дополнительные проверки
Открывать `http://127.0.0.1:3000/app.html` из распакованного проекта после сборки. Отдельный `app.html` без `assets/`, `shared/` и API не является автономным приложением; не открывать его как `file://` для проверки кошелька/API.

```bash
npm run audit:tasks
npm run audit:task-exits
```
Эти скрипты только читают mainnet и симулируют неподписанные транзакции. Тестовый публичный адрес не является кошельком, которым Noise управляет. Не подменять mainnet на testnet; не обходить fail-closed проверки.
Scallop в основном пути: свободные lending shares, не spool/borrow obligations. Haedal delayed: заявка, затем отдельный claim после unlock. Истёкший read-status не считается текущим здоровым статусом; перепроверить монитор. Процент мгновенного вывода Haedal не подставляется из устаревших документов.
