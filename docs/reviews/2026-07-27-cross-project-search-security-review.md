# Security review: explicit all-project search

**Дата:** 2026-07-27  
**Область:** `cross-project-search.ts`, durable nonce store, WP-33  
**Решение:** offline core/runtime contract допустим; live pre-router/Telegram
wiring остаётся выключенным.

## Проверенный результат

Workspace получает отдельную read-only операцию поиска по изолированным Project
indexes без создания общего индекса и без расширения ordinary recall. Выпуск
receipt остаётся trusted pre-router responsibility; модель, prompt content и
nested tool call не получают issuer surface.

## Границы и доказательства

| Риск | Code-owned граница | Доказательство |
|---|---|---|
| Model/prompt инициирует fan-out | Issuance требует operator origin и `nested=false`; receipt имеет HMAC | Model/nested deny tests |
| Receipt используется для другого запроса | MAC связывает owner, Workspace session/generation, normalized query hash, mode, archive flag и limit | Wrong-field tests до nonce consume |
| Replay после restart | Durable typed nonce удаляется atomic publication; namespaces `search` и `excerpt` разделены | Restart после issue/consume |
| Ordinary recall расширяется | Новый service вызывается только с Workspace lease и receipt; существующий scoped router не изменён | Project-lease deny и scoped-memory regression |
| Общий индекс смешивает проекты | Fan-out получает exact index на каждый registry Project; общего store/API нет | Exact resolver call trace |
| Foreign/archived project попадает в выдачу | Owner проверяется повторно; archive исключён, если receipt не связывает include flag | Foreign/archive tests |
| Index возвращает чужой hit | Exact scope/project/content/path/chunk validation; traversal и duplicate chunk — hard failure | Cross-scope/traversal/duplicate tests |
| Arbitrary excerpt path | UI получает one-use capability; open API использует только signed fields и повторно сверяет hash/size | Exact open, content mismatch и replay tests |
| Unbounded fan-out/read | Caps: 20 hits/project, 1000 projects, 1 MiB excerpt; все входят в code path до эффекта | Invalid config/project cap tests |

## Остаточные блокеры

- Trusted pre-router ещё не выпускает receipt из реального Telegram operator
  span; этот API нельзя добавлять в autonomous model tool catalog.
- Production project-index/readExcerpt adapters должны использовать confined
  descriptors и новый published ledger verdict.
- Nonce-store path/secret должны прийти из защищённого control-plane factory;
  ключ нельзя хранить в manifest или логах.
- Live activation требует E2E с реальным registry restart и отдельного
  согласования оператора.

До этого `search_all_projects` остаётся offline opt-in composition; ни один
обычный ход Aisy не получает межпроектные markers.

## Regression evidence

- 11 core + 5 Node persistence targeted tests;
- общий regression: 1256 core, 229 app, 102 Telegram gateway tests;
- 34 Python tests passed, 1 platform-specific skip.
