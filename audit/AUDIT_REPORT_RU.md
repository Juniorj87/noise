# Noise Hub — task-first выпуск

Проверка исходников: 7 октября 2026. Этот выпуск **не опубликован** на noisesui.vercel.app. Отчёт о разработке и тестах — не независимый аудит безопасности.

## Интерфейс
- Start предлагает три задачи: **обменять токен / разместить средства / увидеть позицию и вывести**.
- Основное меню: Start, Swap, Place funds, Positions / exit, More. Дубли Actions/Workflows больше не равнозначные главные разделы: специализированные операции находятся в More → Advanced.
- Referral и Leaderboard доступны в More → Community. Выплаты/денежный reward не обещаются.
- SuiPump и Perpsplexity удалены из публичной витрины. Исторические backend-модули не являются рекламируемыми продуктами.
- Сравнение начинается с актива. Отдельно показаны reported APR/APY, базовая ставка, известные incentives и неизвестные rewards. Компоненты не складываются в выдуманный APY; отсутствующие данные не равны нулю.
- После выбора провайдера карточки сравнения сворачиваются; их можно раскрыть снова. Review показывает вход, результат, minimum swap output, receipt coin, оценку gas и Noise fee. Полные типы, адрес получателя и digest — в технических деталях.
- AI рядом с review/риском. Без server key + model это явно **rules-based** объяснение, не имитация LLM. AI не подписывает и не меняет выбранную транзакцию. Смена формы/кошелька скрывает старое объяснение.
- Чёрно-синий стиль, Inter/Space Grotesk и прямоугольные панели сохранены. Проверены desktop 1440 px и mobile 390 px.

## Единый основной путь
**Suilend / NAVI / Kai / Scallop / Haedal:** actual swap output Coin → placement в одном PTB, если обмен нужен. Если актив совпадает — прямой вклад. При провале атомарной команды изменения состояния откатываются, но gas может быть списан. Подпись только пользовательским кошельком.

- Suilend/NAVI: lending, debt/health и отдельный свежий withdrawal. Health не универсальный risk-score. NAVI oracle updates включены перед выводом/borrow.
- Kai: реальные vault shares; underlying — оценка redemption, не прибыль. Performance fee показана отдельно.
- Scallop: supply → mint liquid sCoin shares; burn sCoin → redeem. Основной просмотр ограничен **свободными lending shares**, не всеми spool/collateral/borrow позициями. Специализированные операции остаются в Advanced.
- Haedal: minimum 1 SUI, официальный haSUI type и on-chain exchange rate. Exchange rate не выдаётся за APY. Minimum haSUI receipt защищён проверкой в PTB. Instant exit имеет протокольные fee/liquidity; устаревшие «9%» не подставляются. Delayed exit возвращает **заявку**, не немедленно доступные SUI; claim — отдельная транзакция после protocol unlock. Показаны доступные amount/timestamp/epoch заявки.
- SDK Scallop копирует Transaction: исправлена передача обновлённого PTB в общий сериализатор. Текущий Haedal ABI для instant/delayed/claim возвращает void и сам передаёт результат пользователю: убраны ошибочные transferObjects несуществующих результатов и в основном, и в legacy builder.
- Отсутствие позиции и ошибка чтения различаются. Haedal reads больше не превращают ошибку RPC в пустой баланс; tickets читаются с пагинацией и проверкой точного типа/владельца.

18 curated mainnet входных активов, включая WAL/NS. CoinMetadata и decimals проверяются. Это не рейтинг и не гарантия рынка/ликвидности для каждого провайдера. Вывод и последующий обратный swap — отдельные review, не универсальная автоматическая цепочка.

## Граница исполнения
Exact u64/BigInt, типы активов, owned position/ticket, limit amount, full simulation, freshness/60-second review expiry. Изменение формы/аккаунта инвалидирует bytes. Перед wallet call существующий HubWallet pipeline повторно проверяет симуляцию. Recovery journal хранит digest/status, не signing bytes/ключи. Pending/unknown нельзя слепо отправлять ещё раз. Receipt сверяет digest, sender и effects success.

## Монитор
Проверяет только чтения Sui RPC и пяти основных провайдеров. Есть checkedAt/latency/expiry, available/unavailable и явный stale snapshot. Отказ RPC не равен доказанному падению самого протокола. Это не route guarantee, не security-сертификат и не funded-wallet E2E.

## Подтверждённые проверки
- **271/271** автоматических теста; **19/19** живых read/build integration tests. Сборка импортирует **61** serverless-модуль; проверен синтаксис inline/external frontend JS.
- `tasks-execution.json`: Scallop direct SUI deposit и SUI→USDC→deposit; Haedal SUI stake — **3 успешные неподписанные симуляции**. Scallop receipt decimals сверены с chain metadata. Haedal annual APY не придуман.
- `tasks-exits.json`: Scallop supply→mint→burn→redeem; Haedal stake→instant exit; stake→delayed request — **3 успешные одноступенчатые roundtrip-симуляции**. Чужая заявка отклонена; haSUI decimals проверены.
- `tasks-ui.json`: Start/Place/Swap/Positions/More/Community/review в 1440/390 px; нет pageerrors, повторных IDs и horizontal body overflow; изменение amount выключает старые bytes и объяснение. Scallop selection сохраняется.
- `tasks-edge-ui.json`: публичные read-only position reads; принудительный outage не считается zero; неподходящий claim не получает signable review; монитор и вторичная навигация проверены. Wallet facade/фикстуры только для QA; финансовых подписей не было.
- Ранее проверены 6 Suilend/NAVI/Kai entry-сценариев, 3 primitive exit roundtrips, metadata 18 активов и 16 дополнительных token quotes; соответствующие `journey-*.json` сохранены как **исторические отдельные проверки**, не новое доказательство всех операций.
- Ранее Referral HTTP proof проверен unfunded тестовыми personal-message ключами; это не финансовая подпись. В production нужен PostgreSQL. LLM adapters протестированы с mock HTTP; пользовательского model key не было.

## Публичные сервисы и комиссия
20 scoped записей: Sui/native, Cetus/Aftermath, swap paths Turbos/FlowX/Momentum/Bluefin Spot, DeepBook Spot/Predict, NAVI/Suilend/Scallop, Bucket PSM, Haedal/Volo/SpringSui, STEAMM, Kai, Wormhole Connect. См. `PUBLIC_COVERAGE.json`. Не все функции любого протокола и не все исходные 32 проекта.
Wormhole Connect 6.0.0: отдельные source/destination wallets, provider fees, signing/recovery. Signed cross-chain теста нет; Noise bridge fee = 0.
Router Noise fee default **2 bps = 0,02%** из входного актива; quote на net input. Получатель:
`0xa29a8f72981c5644c348a51cd4aded6dbb47ad4361f7a825e19d377e9c4373a1`.
В новых atomic swap→Scallop симуляциях fee leg присутствует. Это **не доказательство поступившей выручки**: подписанных финансовых операций не было. Прямые вклады/bridge/LP не выдаются за fee-bearing swaps. Проверьте свой контроль над адресом.

## Что не выполнено
Реальный funded deposit → отдельный later withdrawal; существующий matured Haedal ticket claim; signed cross-chain transfer; независимый security review; production PostgreSQL/model credentials, нагрузка/SLA. Эти пункты нельзя заменить количеством симуляций. Перед широким запуском они обязательны по вашему плану. ZIP — исходники и инструкции, не опубликованный/сертифицированный production deployment.

`app.html` требует assets/shared и API: запуск через инструкции, не автономный file://.
