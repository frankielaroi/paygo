# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**PayGo is a pay-as-you-go asset financing platform**: assets (e.g. solar kits, devices) are
sold on installment, customers pay in small increments, and access to the asset is unlocked
in proportion to what they have paid.

Financed assets are GPS-tracked and can be **remotely immobilized** when a contract falls
into arrears, over a raw TCP link to Teltonika devices (see *Device Telemetry* below).

**Built so far:** Prisma 7 + Postgres wiring (`src/prisma/`), the `User` (staff) and
`Customer` (rider) models with `CustomerContact`, and the RBAC layer — `StaffRole`, the
permission map in `src/users/enums/role.enum.ts`, `@Roles`/`@RequirePermissions`/`@Public`/
`@CurrentUser`, and `RolesGuard`. One migration is applied:
`init_users_customers_rbac`.

**Not built yet:** authentication itself (no `auth/` module, no `JwtAuthGuard`, nothing
populates `request.user`, and `User.passwordHash` is never written), plans, contracts,
payments, ledger, positions, enforcement, the `src/tcp/` device module, Redis/BullMQ, and
Swagger.

Everything below describing those unbuilt pieces is the **target architecture and the
conventions to follow when adding code**, not files that already exist. When implementing a
feature, create the structure described here rather than inventing a new one. Do not cite
paths from this document as if they were already present — check first.

## Common Development Commands

### Running the Application

```bash
npm run start:dev      # development with hot-reload
npm run start:debug    # development with --inspect
npm run start:prod     # runs dist/main (requires npm run build first)
npm run build          # nest build
```

### Testing

```bash
npm test                                  # all unit tests
npm test -- src/auth/auth.service.spec.ts # a single test file
npm run test:watch
npm run test:cov                          # coverage -> ./coverage
npm run test:e2e                          # uses test/jest-e2e.json
```

Jest config lives inline in `package.json` with `rootDir: "src"` and
`testRegex: ".*\\.spec\\.ts$"`, so unit tests must sit **next to the source file** they
cover. E2E specs live in `test/` and only run via `test:e2e`, which uses its own config.

### Code Quality

```bash
npm run format   # prettier --write over src/ and test/
npm run lint     # eslint --fix over src, apps, libs, test
```

Prettier is enforced through ESLint (`eslint-plugin-prettier`), so a formatting violation
is a lint error. Run both before considering a change done.

### Database (Prisma)

```bash
npm run migration:dev -- --name add_payment_plans  # create + apply a migration in dev
npm run migration:deploy                           # apply pending migrations (CI/prod)
npm run db:reset                                   # drop, recreate (DEV ONLY)
npm run prisma:generate                            # regenerate the client after schema edits
npm run db:studio                                  # browse data
```

**This project runs Prisma 7**, which differs from most Prisma material online:

- The generator is `prisma-client` (not `prisma-client-js`) and emits **TypeScript sources**
  to `src/generated/prisma`, which is git-ignored and excluded from ESLint and Prettier.
  Import from `../generated/prisma/client`; enums come from `../generated/prisma/enums`.
- The output lives under `src/` on purpose. Outside it, `tsc` widens the rootDir and the
  build emits `dist/src/main.js`, breaking `npm run start:prod`.
- **A driver adapter is required** — there is no `datasourceUrl` or `datasources` option.
  `PrismaService` constructs `new PrismaPg({ connectionString })` from `@prisma/adapter-pg`.
- Connection config lives in `prisma7.config.ts`, and `datasource db` in the schema has no
  `url`. The Prisma CLI does **not** auto-load `.env`; `prisma7.config.ts` does it via
  `import "dotenv/config"`.

**Rules:**

- **Never use `prisma db push` on anything but a scratch database.** Every schema change
  ships as a checked-in migration in `prisma/migrations/`.
- Run `npx prisma generate` after every `schema.prisma` edit, or the generated types will
  lag behind and TypeScript errors will be misleading.
- Never hand-edit an applied migration. Write a new one.
- `migrate reset` and `migrate dev` are destructive against the target database. Confirm
  `DATABASE_URL` points at a local/dev database before running either.

### Docker

```bash
docker compose up -d      # Postgres + Redis for local development
docker compose down
docker compose logs -f api
```

Local Postgres and Redis run in Compose; the app normally runs on the host via
`start:dev` against those containers.

## Architecture Overview

NestJS application, modular by domain feature.

### Module Structure

- `AppModule` is the root module and imports `ConfigModule.forRoot({ isGlobal: true })`,
  `PrismaModule`, and each feature module.
- Every feature is a self-contained module directory: controller, service, DTOs, and its
  own guards/processors where relevant. Features never import another feature's service
  directly from a deep path — import the owning module and inject the exported provider.
- Cross-cutting infrastructure (Prisma, config, logging, queue setup) lives in
  `src/common/` or its own top-level module, never inside a feature.

```
src/
  main.ts
  app.module.ts
  prisma/                  # PrismaModule + PrismaService (global)
  config/                  # typed config factories + env validation schema
  common/
    decorators/            # @CurrentUser, @Roles, @Public
    guards/                # JwtAuthGuard, RolesGuard
    interceptors/
    filters/               # Prisma + HTTP exception filters
    pipes/
  auth/
    auth.module.ts
    auth.service.ts
    auth.controller.ts
    strategy/jwt.strategy.ts
    dto/
  users/                   # STAFF ONLY: admins + field agents. Authenticates to back office
    enums/role.enum.ts
  customers/               # riders being financed. KYC, guarantors. NOT in users (see below)
  assets/                  # financed motorbikes: identity, GPS device, state
  plans/                   # financing plans: price, deposit, tenor, rate
  contracts/               # a customer's plan on a motorbike; payment schedule
  payments/                # inbound payments, provider webhooks, allocation
  ledger/                  # append-only double-entry account movements
  positions/               # telemetry persistence: GPS fixes, ignition, movement
  enforcement/             # desired mobility state, arrears rules, safety interlock
    reconciler.service.ts  #   desired vs confirmed state -> command, when safe
  tcp/                     # raw TCP device protocol (see Device Telemetry)
    tcp.module.ts
    tcp-server.service.ts  # net.Server: IMEI handshake, socket map, ACKs, sendCommand
    codec8-parser.ts       # binary AVL packet -> plain JS position object
    command-encoder.ts     # relay command (setdigout) -> binary frame
    crc16.ts               # checksum, used in both directions
  queues/                  # BullMQ queue registration + processors
```

### Database: Prisma + PostgreSQL

- `prisma/schema.prisma` is the single source of truth for the data model.
- `PrismaService` extends `PrismaClient` and implements `OnModuleInit` (call
  `await this.$connect()`); it is provided and exported by a **global** `PrismaModule` so
  feature services inject it without re-importing.
- Services depend on `PrismaService` directly. Do not add a generic repository layer
  around Prisma — the client *is* the data-access layer.
- Prisma types (`Prisma.CustomerCreateInput`, `Prisma.ContractGetPayload<...>`) are the
  internal model types. DTOs exist for the HTTP boundary, not as duplicate models.
- Use `prisma.$transaction` for any operation that writes more than one row and must be
  all-or-nothing (recording a payment + its ledger entries + the contract update).
- Avoid N+1: use `include`/`select` rather than looping queries. Select explicitly on
  read paths that return lists.
- Never interpolate user input into `$queryRawUnsafe`. Use `$queryRaw` with tagged
  template parameters if raw SQL is genuinely needed.

**`User` and `Customer` are deliberately separate models.** `User` is staff who sign into the
back office (admin, field agent). `Customer` is the rider being financed. Do not merge them
into one table with a role column, and do not add a `CUSTOMER` value to the staff role enum.

- It is a security boundary, not tidiness. With one table, role assignment is the only thing
  between a rider and admin — a default-value bug, a mass-assignment slip, or a seeded test
  row becomes privilege escalation. Separate models make that unrepresentable.
- The records share almost no columns. Customers carry KYC (national ID, photo, address,
  guarantors, next of kin); staff carry branch and supervisor. Merged, every one of those is
  nullable and every query is filtered by role.
- Customer identity is a **phone number**, not an email and password — a field agent
  registers them, and many never sign in at all. If a rider app ships later, give `Customer`
  its own phone/OTP credential rather than moving riders into `users`.
- `contract.customerId`, ledger rows and audit records all point at `Customer`. Changing
  this later is a migration across financial history, so it does not get revisited casually.

### Money and Financial Correctness

This is a financing system; arithmetic bugs are the expensive kind.

- **Never use `Float`/JS `number` for money.** Store amounts as `Int` in the smallest
  currency unit (or Prisma `Decimal` where fractional minor units matter) and keep the
  currency on the same record.
- Every monetary column carries an explicit currency; never assume a default.
- Payment ingestion must be **idempotent**, keyed on the provider's transaction
  reference with a unique constraint. A replayed webhook must not create a second payment
  or a second set of ledger entries.
- Financial history is **append-only**: corrections are reversing entries, never `UPDATE`
  or `DELETE` on the ledger.
- Derive balances from the ledger. Cached balances on a contract, if any, are a
  denormalization that must be recomputed inside the same transaction that writes entries.
- Amount validation belongs in DTOs (`@IsInt()`, `@IsPositive()`) *and* in the service —
  the DTO guards the shape, the service guards the business rule.

### Device Telemetry & Remote Immobilization (Teltonika TCP)

`TcpModule` is imported by `AppModule` and starts on `OnApplicationBootstrap`, so the
process runs **two servers**: the normal HTTP server, and a raw `net.Server` for devices on
`TCP_DEVICE_PORT` (default **5027**). Anything that changes startup, shutdown, or process
management has to account for both.

**This is one application, not two services.** The device layer and the REST API share the
process, the Prisma client, and the DI container. Decoded telemetry is written through the
same services the REST controllers use — there is no separate telemetry store and no second
source of truth. The enforcement job injects `TcpServerService` and calls a method on it;
there is no internal HTTP hop between business logic and device control. Do not propose
splitting the TCP listener into its own service without a concrete reason, and if it is ever
split, the shared database and service layer are what must not be duplicated.

**Device-facing and frontend-facing code are separate modules.** `tcp/` owns the socket and
the binary protocol and is the only thing that knows Codec 8 exists. The frontend's live-map
and history endpoints are ordinary REST/WebSocket handlers reading what was persisted. No
controller reaches into the socket map, and no frontend request is served straight off a
device connection — a device that is offline must degrade to last-known state, not hang.

**Horizontal scaling constraint (not a day-one problem).** A device's socket lives on exactly
one instance. With a single instance, `sendCommand` always finds the connection and this is a
non-issue — which covers a lot of runway. Behind a load balancer it is not: an enforcement job
on instance A cannot reach a tracker connected to instance B, and `sendCommand` returning
"not connected" would be a **false negative** that silently skips an immobilization. Before
running more than one instance, the socket registry has to become shared (Redis-backed
IMEI → instance map plus a pub/sub hop, using the Redis that BullMQ already requires). Until
then, treat "more than one replica" as a change that requires this work first, not a
scaling knob to turn.

Protocol flow: device opens a socket → IMEI handshake → `TcpServerService` keeps a
`Map<imei, connection>` → incoming Codec 8 AVL packets are parsed and ACKed → outgoing
`setdigout` relay commands are encoded and written back to that socket.

**Layering — this is the rule that matters most here:**

- `src/tcp/` is a **protocol layer only**. It parses bytes, ACKs, and writes bytes. It
  contains no financing logic, no arrears checks, and no database decisions.
- `sendCommand(imei, 'immobilize' | 'restore')` **fires immediately and unconditionally**.
  It does not check speed, ignition, or anything else.
- **The safety interlock lives in `enforcement/`, never in `tcp/`.** Before any
  `immobilize` call, the reconciler must confirm from persisted telemetry that the asset is
  stationary — speed == 0 **and** ignition off, sustained for
  `IMMOBILIZE_STATIONARY_SECONDS` — plus that the contract is genuinely in arrears.
  Immobilizing a moving vehicle can kill someone. Do not add a convenience path that reaches
  `sendCommand` without passing that check, and do not "temporarily" bypass it for testing
  against a live device.
- Every immobilize/restore is audit-logged: who or what triggered it, the contract, the
  telemetry snapshot the interlock relied on, and the device's response.

### Enforcement: Desired State, Not Commands

Enforcement is a **reconciler**, not a command sender. Each asset stores a desired mobility
state (`MOBILE` / `IMMOBILIZED`) plus the last **device-confirmed** state. Nothing outside
`enforcement/` calls `sendCommand`.

- Enforcement rules (arrears, payment, admin action) only ever **write desired state**.
- The reconciler compares desired against confirmed and emits a command when they diverge
  *and* it is safe right now. It runs on device handshake, on telemetry arrival, and on a
  timer.
- Confirmed state advances only on the device's response or subsequent telemetry — **never**
  on a successful `write()`.

**Why not a pending-command queue.** A device reconnecting is usually a device that was just
powered on or just regained signal *while being ridden*. Draining a queued immobilize at
handshake therefore fires at a moving motorbike: the offline case and the most dangerous case
are the same case. Converging on desired state also removes stale-intent expiry, the ordering
problem when immobilize and restore are both pending (latest desired state simply wins), and
double-execution on retry, because convergence is idempotent where command replay is not.

**Restore is asymmetric with immobilize and must stay that way.** Immobilize needs the
interlock because it can kill someone; restore cannot hurt anyone. Restore is therefore
automatic and ungated — it fires immediately, including the moment an offline tracker
reconnects. A rider who has paid must not be stranded waiting for someone to click a button;
that is their day's income.

- **Restore triggers on "contract became current", not "payment received."** The decision
  reads the derived ledger balance inside the same transaction that posts the payment
  entries. Triggering off the webhook would let a token payment unlock a bike that is months
  down — and triggering off the balance means arrears cleared by an admin adjustment,
  write-off or restructure restores the bike too, which is correct.
- The "current enough to restore" threshold is **configuration**, not a literal in the
  service: fully current, within a grace amount, or one installment behind. It will be tuned.
- Immobilize, by contrast, typically does *not* fire at handshake. It waits for the next
  confirmed stationary moment.

Because desired state is a single mutable field, keep an **append-only log of desired-state
changes** — actor, contract, arrears snapshot, and the telemetry the interlock relied on.
That log is what answers a rider disputing an immobilization.

**Telemetry ingestion:**

- `onPositionReceived` must write through to `positions/` (or emit via
  `@nestjs/event-emitter` for other modules to consume) — not just log. Keep the socket
  handler fast: hand off to a queue rather than doing heavy work inline.
- **TCP is a stream, not a message boundary.** `tryParsePackets` must track how many bytes
  `parseCodec8Packet` actually consumed, slice exactly that much off the buffer, and loop
  until the buffer is empty or holds an incomplete packet. Clearing the whole buffer after
  one packet silently drops data whenever a device sends packets back-to-back — which
  happens in weak-signal areas, exactly when the data matters.
- Devices drop and reconnect constantly; treat it as normal. Overwriting the `Map` entry on
  reconnect is the correct behaviour — destroy the superseded socket so it does not leak.
- A socket being present in the map is **not** proof the device is reachable. Never report
  immobilization as confirmed on the basis of a successful `write()`; confirm from the
  device's response or subsequent telemetry.
- **Verify IO IDs against the actual unit.** IO 239 (ignition) and 240 (movement) are
  Teltonika standards, but firmware and model differences exist — confirm against the
  specific FMB920 (or other) parameter list, using captured hex, before trusting field
  names.
- Prefer TLS where the device firmware supports it, terminated ahead of this handler.
  Plaintext device traffic on the public internet is a last resort, and the IMEI handshake
  alone is not authentication — an IMEI is guessable and spoofable, so never let telemetry
  alone authorize a financial or enforcement action.

Operationally: run behind a process manager or orchestrator restart policy — a crash drops
every device's connectivity at once, silently. Load test at the real expected
concurrent-device count before trusting it at fleet scale.

### Authentication & Authorization

- JWT authentication via Passport, signed with **RS256** — `PRIVATE_KEY` signs,
  `PUBLIC_KEY` verifies; keys come from the environment and are never committed.
- `JwtStrategy` in `src/auth/strategy/jwt.strategy.ts` validates the token and resolves
  the user; `JwtAuthGuard` is registered globally, with `@Public()` opting an endpoint out.
- RBAC: staff roles enumerated in `src/users/enums/role.enum.ts`, applied with `@Roles(...)`
  and enforced by `RolesGuard`. The staff roles are **admin** and **field agent**. Customers
  are a separate model and are **not** a role in this enum — see *Database* above.
- Role boundaries that matter: a field agent must not read or move money belonging to another
  agent's customers, and **immobilize/restore is not a field-agent capability by default** —
  an agent in the field is the most likely person to want that button and the least able to
  verify the bike is stopped. Grant it deliberately or not at all.
- If a rider-facing API ships, it authenticates `Customer` (phone/OTP) on its own path and
  issues tokens that the staff guards do not accept. A customer sees only their own contract,
  payments and bike.
- Authorization is checked in the service against the resource's owner, not only by role
  in the guard. Role alone never proves the record belongs to the caller. For customers that
  means comparing against `Customer.assignedAgentId`.
- Capabilities live in the **permission map** in `src/users/enums/role.enum.ts`, not in
  database tables — with two fixed roles, a permissions table would be a join on every
  request and a migration for every change. Prefer `@RequirePermissions(...)` over
  `@Roles(...)` on routes, so adding a role does not mean revisiting every controller. Move
  the map into the database only when admins need to edit roles at runtime.
- The principal type `AuthenticatedStaff` carries an explicit `kind: 'staff'`, and
  `RolesGuard` rejects anything else. When customer auth ships, a rider token must not
  satisfy a staff route just because it carries an id — the guard must never resolve a
  subject without checking which kind it is.
- Password hashing with argon2 or bcrypt. Never log tokens, keys, password hashes, or
  full payment payloads.

### Validation & API Contract

- A global `ValidationPipe` with `{ whitelist: true, forbidNonWhitelisted: true,
  transform: true }` — unknown properties are rejected, not silently ignored.
- Request/response DTOs live in each feature's `dto/`, use `class-validator` decorators,
  and are annotated with `@ApiProperty` for Swagger.
- Never accept a Prisma input type as a request body; that would let a client write any
  column.
- Entities are never returned raw. Map to a response DTO so hashes, internal ids, and
  provider payloads cannot leak.

### Swagger / OpenAPI

`@nestjs/swagger` is configured in `main.ts` and served at **`/api`**. Use `DocumentBuilder`
with `addBearerAuth()`. Every controller gets `@ApiTags`, and every endpoint documents its
non-2xx responses. Consider disabling the docs route when `NODE_ENV === 'production'`.

### Background Jobs: Redis + BullMQ

- `@nestjs/bullmq` with Redis for work that must not block a request: provider webhook
  processing, payment reconciliation, unlock-token generation, SMS/push notifications,
  overdue-contract sweeps.
- Queues are registered in `src/queues/`; processors are `@Processor`-decorated classes
  that delegate to a feature service rather than holding business logic themselves.
- Job handlers must be **idempotent and retry-safe** — BullMQ will retry, and a retried
  payment job must not double-post to the ledger.
- Job payloads carry ids, not whole entities; re-read from the database inside the handler.

### Configuration

- All configuration comes from the environment through `ConfigService`. Do not read
  `process.env` outside `src/config/`.
- Validate the environment at boot (Joi or a Zod schema in `ConfigModule.forRoot`) so a
  missing `DATABASE_URL` or key fails at startup, not on first request.
- `.env` is git-ignored; keep a committed `.env.example` listing every variable with safe
  placeholder values.

Expected variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string used by Prisma |
| `PORT` | HTTP port (`main.ts` falls back to 3000) |
| `NODE_ENV` | `development` / `test` / `production` |
| `PRIVATE_KEY` / `PUBLIC_KEY` | RS256 JWT signing keypair (PEM) |
| `JWT_EXPIRES_IN` | Access token lifetime |
| `REDIS_HOST` / `REDIS_PORT` | BullMQ connection |
| `TCP_DEVICE_PORT` | Raw TCP listener for Teltonika devices (default 5027) |
| `IMMOBILIZE_STATIONARY_SECONDS` | Interlock: how long an asset must be stopped first |
| `RESTORE_ARREARS_THRESHOLD` | How current a contract must be to auto-restore mobility |

### Testing Strategy

- Unit tests sit beside the source file and mock `PrismaService` — a plain object of
  `jest.fn()`s is preferred over a deep mock, so the assertions show the exact query shape.
- Financial logic (payment allocation, schedule generation, ledger balance, interest or
  fee calculation) is tested at the unit level with explicit numeric fixtures, including
  the awkward cases: overpayment, underpayment, partial installment, early settlement,
  currency rounding.
- Webhook and payment endpoints get a test that submits the same payload twice and asserts
  exactly one payment and one balanced set of ledger entries.
- The protocol layer is tested with **synthetic and captured buffers** — no hardware
  required. `crc16`, `parseCodec8Packet` and `command-encoder` are pure functions; keep real
  hex dumps as fixtures and assert byte offsets against them, so a firmware or model
  difference shows up as a failing test rather than a misread coordinate.
- The interlock gets its own tests, written as denials: moving asset → no command sent;
  ignition on → no command sent; stationary but not yet sustained → no command sent;
  contract current → no command sent. Assert `sendCommand` was *not* called.
- The reconciler gets tests for the cases that only appear over time: a device reconnecting
  while moving with `IMMOBILIZED` desired (no command, then a command once stationary
  telemetry arrives); desired `MOBILE` on reconnect (command sent immediately); a payment
  clearing arrears while the tracker is offline (desired flips, confirmed state unchanged,
  command on reconnect); and running the reconciler twice with no state change (no second
  command).
- E2E tests in `test/` run against a **dedicated test database** — never the development
  one — provisioned with `prisma migrate deploy` and truncated between tests.

## Conventions

- Run `npm run lint` and `npm test` before treating a change as complete.
- New feature module → generate with `npx nest g module <name>` /`g controller` /
  `g service` so it matches the framework's expected wiring.
- Errors thrown from services are Nest HTTP exceptions (`NotFoundException`,
  `ConflictException`, …); do not let raw Prisma errors reach the client — a
  `PrismaClientKnownRequestError` filter maps `P2002` → 409 and `P2025` → 404.
- Migration names describe the change (`add_contract_payment_schedule`), not the ticket.
