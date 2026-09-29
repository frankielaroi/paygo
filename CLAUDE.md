# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**PayGo is a pay-as-you-go asset financing platform**: assets (e.g. solar kits, devices) are
sold on installment, customers pay in small increments, and access to the asset is unlocked
in proportion to what they have paid.

Financed assets are GPS-tracked and can be **remotely immobilized** when a contract falls
into arrears, over a raw TCP link to Teltonika devices (see *Device Telemetry* below).

**Built so far:**

- Prisma 7 + Postgres wiring (`src/prisma/`), with staff, customer, and fleet tracking models.
  Migrations include RBAC, auth hardening, and `add_fleet_tracking`.
- RBAC: `StaffRole`, the permission map in `src/users/enums/role.enum.ts`, the
  `@Roles` / `@RequirePermissions` / `@Public` / `@CurrentUser` decorators, and `RolesGuard`.
- Auth (`src/auth/`): RS256 JWT access tokens, rotating refresh tokens, argon2id password
  hashing, `JwtStrategy`, `JwtAuthGuard`. Endpoints: `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/logout`, `GET /auth/me`.
- Login protection: per-IP rate limiting (`@nestjs/throttler`, a separate `login` bucket) and
  per-account lockout on `User.failedLoginAttempts` / `lockedUntil`.
- Environment validation at boot (`src/config/env.validation.ts`, zod). A missing or
  malformed key aborts the bootstrap.
- Swagger at `/api` (JSON at `/api-json`), configured in `src/config/swagger.ts`.
- An admin seed (`npm run db:seed`), idempotent on email and never overwriting an existing
  user's password.
- The device protocol layer (`src/tcp/`): Codec 8 parser, Codec 12 command encoder, CRC-16, and
  `TcpServerService` (IMEI handshake, socket map, framing, ACKs, `sendCommand`). It emits
  `device.connected`, `device.disconnected`, `device.positions` and `device.command-response`
  through `EventEmitterModule`, and persists nothing.
- Tracking (`src/tracking/`): IMEI-to-bike mapping, deduplicated position history, monotonic
  current snapshots, derived online/offline status, authenticated SSE updates, and a typed
  safety snapshot lookup for Enforcement. An admin registers each bike and tracker IMEI.

**Not built yet:** plans, contracts, payments, ledger, enforcement, Redis/BullMQ,
customer (rider) authentication, revoking sessions on password change
(`RefreshTokenService.revokeAllForUser` exists but nothing calls it), and a job to delete
expired refresh token rows.

`src/tracking/` subscribes to `device.positions`. The protocol layer remains unaware of bike
records and persistence; tracking resolves each IMEI, stores readable telemetry, and never
makes immobilization decisions.

Everything below describing those unbuilt pieces is the **target architecture and the
conventions to follow when adding code**, not files that already exist. When implementing a
feature, create the structure described here rather than inventing a new one. Do not cite
paths from this document as if they were already present: check first.

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
npm test                                  # unit tests under src/
npm test -- src/auth/auth.service.spec.ts # a single test file
npm run test:tools                        # the device simulator's own tests
npm run test:e2e                          # uses test/jest-e2e.json
npm run test:all                          # unit, tools and e2e in sequence
npm run test:watch
npm run test:cov                          # coverage -> ./coverage
```

Three suites, three configs. `npm test` covers `src/` only, so a change to `tools/` needs
`npm run test:tools`, and CI should run `npm run test:all`.

Jest config lives inline in `package.json` with `rootDir: "src"` and
`testRegex: ".*\\.spec\\.ts$"`, so unit tests must sit **next to the source file** they
cover. E2E specs live in `test/` and only run via `test:e2e`, which uses its own config.

### Code Quality: no `any`

`any` is a lint error, and `noImplicitAny` is on. The rule that actually does the work is the
`no-unsafe-*` family, not `no-explicit-any`: most `any` in a Nest codebase arrives from
untyped library returns rather than from someone typing the word.

Consequences worth knowing before reaching for a cast:

- `jest.Mock` is `any`-typed. Narrow it once per spec with
  `as unknown as jest.Mock<unknown, [ArgsType]>` and read the calls through that, rather
  than asserting on `.mock.calls[0][0]` inline.
- `expect.objectContaining()` returns `any`. Assert on typed call arguments instead.
- `app.getHttpServer()` is `any` unless the app is typed: use
  `INestApplication<App>` with `App` from `supertest/types`, which is what the e2e specs do.
- Generated Prisma code is excluded from linting, so its internals do not count.



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
  build emits `dist/src/main.js`, breaking `npm run start:prod`. For the same reason
  `tsconfig.build.json` excludes `tools`, `prisma` and `prisma7.config.ts`: any `.ts` file outside
  `src/` that the build compiles moves `main.js` and breaks production start. Check
  `ls dist/main.js` after adding top-level TypeScript.
- **A driver adapter is required**, there is no `datasourceUrl` or `datasources` option.
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

### Dependency constraint: this project is on NestJS 11, so Nest packages stay on CJS-era majors

The Nest 12 line of the satellite packages is published as **pure ESM**, which Jest cannot
`require` on Node 22, and it also peer-requires `@nestjs/common@^12`. Every affected package
is therefore pinned to the last CommonJS major. Do not "update" these without moving the
whole app to Nest 12 and giving Jest an ESM setup:

| Package | Pinned | Latest is ESM |
| --- | --- | --- |
| `@nestjs/config` | 4.0.4 | 12.x |
| `@nestjs/jwt` | 11.0.2 | 12.x |
| `@nestjs/passport` | 11.0.5 | 12.x |
| `@nestjs/swagger` | 11.4.7 | 12.x |

Symptom if one slips through: `createRequireEsmError` / "Must use import to load ES Module"
from Jest, while `npm run start` keeps working. The app boots either way, so only the tests
catch it.

### Test runner quirks this project has to live with

- `moduleNameMapper` maps `^(\.{1,2}/.*)\.js$` to `$1` in both Jest configs. The generated
  Prisma client uses NodeNext `.js` specifiers that point at `.ts` files, which the CJS
  resolver cannot follow.
- `test:e2e` runs with `NODE_OPTIONS=--experimental-vm-modules` via `cross-env`. Prisma 7
  loads its query compiler through a dynamic `import()`, and without the flag any e2e test
  that boots `PrismaModule` fails with "A dynamic import callback was invoked without
  --experimental-vm-modules".
- `db:seed` runs under **tsx**, not ts-node. ts-node cannot resolve the generated client's
  `.js` specifiers at runtime.
- The auth e2e spec needs the seeded admin and the `SEED_ADMIN_*` values from `.env`.

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
  directly from a deep path, import the owning module and inject the exported provider.
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
  tracking/                # IMEI resolution, current status, history, and live updates
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
  around Prisma, the client *is* the data-access layer.
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
  between a rider and admin, a default-value bug, a mass-assignment slip, or a seeded test
  row becomes privilege escalation. Separate models make that unrepresentable.
- The records share almost no columns. Customers carry KYC (national ID, photo, address,
  guarantors, next of kin); staff carry branch and supervisor. Merged, every one of those is
  nullable and every query is filtered by role.
- Customer identity is a **phone number**, not an email and password, a field agent
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
- Amount validation belongs in DTOs (`@IsInt()`, `@IsPositive()`) *and* in the service,
  the DTO guards the shape, the service guards the business rule.

### Device Telemetry & Remote Immobilization (Teltonika TCP)

`TcpModule` is imported by `AppModule` and starts on `OnApplicationBootstrap`, so the
process runs **two servers**: the normal HTTP server, and a raw `net.Server` for devices on
`TCP_DEVICE_PORT` (default **5027**). Anything that changes startup, shutdown, or process
management has to account for both.

**This is one application, not two services.** The device layer and the REST API share the
process, the Prisma client, and the DI container. Decoded telemetry is written through the
same services the REST controllers use, there is no separate telemetry store and no second
source of truth. The enforcement job injects `TcpServerService` and calls a method on it;
there is no internal HTTP hop between business logic and device control. Do not propose
splitting the TCP listener into its own service without a concrete reason, and if it is ever
split, the shared database and service layer are what must not be duplicated.

**Device-facing and frontend-facing code are separate modules.** `tcp/` owns the socket and
the binary protocol and is the only thing that knows Codec 8 exists. The frontend's live-map
and history endpoints are ordinary REST/WebSocket handlers reading what was persisted. No
controller reaches into the socket map, and no frontend request is served straight off a
device connection, a device that is offline must degrade to last-known state, not hang.

**Horizontal scaling constraint (not a day-one problem).** A device's socket lives on exactly
one instance. With a single instance, `sendCommand` always finds the connection and this is a
non-issue, which covers a lot of runway. Behind a load balancer it is not: an enforcement job
on instance A cannot reach a tracker connected to instance B, and `sendCommand` returning
"not connected" would be a **false negative** that silently skips an immobilization. Before
running more than one instance, the socket registry has to become shared (Redis-backed
IMEI → instance map plus a pub/sub hop, using the Redis that BullMQ already requires). Until
then, treat "more than one replica" as a change that requires this work first, not a
scaling knob to turn.

Protocol flow: device opens a socket → IMEI handshake → `TcpServerService` keeps a
`Map<imei, connection>` → incoming Codec 8 AVL packets are parsed and ACKed → outgoing
`setdigout` relay commands are encoded and written back to that socket.

**Layering, this is the rule that matters most here:**

- `src/tcp/` is a **protocol layer only**. It parses bytes, ACKs, and writes bytes. It
  contains no financing logic, no arrears checks, and no database decisions.
- `sendCommand(imei, 'immobilize' | 'restore')` **fires immediately and unconditionally**.
  It does not check speed, ignition, or anything else.
- **The safety interlock lives in `enforcement/`, never in `tcp/`.** Before any
  `immobilize` call, the reconciler must confirm from persisted telemetry that the asset is
  stationary, speed == 0 **and** ignition off, sustained for
  `IMMOBILIZE_STATIONARY_SECONDS`, plus that the contract is genuinely in arrears.
  Immobilizing a moving vehicle can kill someone. Do not add a convenience path that reaches
  `sendCommand` without passing that check, and do not "temporarily" bypass it for testing
  against a live device.
- Every immobilize/restore is audit-logged: who or what triggered it, the contract, the
  telemetry snapshot the interlock relied on, and the device's response.

### What `src/tcp/` actually does, as built

Files: `crc16.ts`, `codec8-parser.ts` (framing, records, handshake), `command-encoder.ts`,
`tcp-server.service.ts`, `tcp.events.ts`, `tcp.module.ts`.

- **Parsing is pure and never throws.** `parseFrame` returns a tagged result: `incomplete` (wait
  for more bytes), `records`, `command-response`, `invalid` (framed but unusable: skip this frame
  and carry on), or `unrecoverable` (the stream cannot be resynchronised: close the connection).
  Every result that consumed bytes reports how many, and the caller slices exactly that much.
- **Bad CRC is deliberately not acknowledged.** The device keeps the records and resends, which
  is what makes weak-signal data recoverable. Acknowledging a corrupt packet loses it silently.
- **A record must exactly fill its packet.** The leading and trailing record counts must agree
  and the parsed records must end where the trailing count begins. Both checks exist because a
  misread IO layout still produces plausible coordinates, which is worse than an error.
- **`satellites === 0` sets `hasFix: false`.** Teltonika sends 0/0 coordinates with no fix, and
  storing that as a position puts the bike in the Gulf of Guinea. An interlock reading it as
  "stationary" would be reading nothing at all.
- **Codec 8 Extended (0x8e) is refused, not guessed at.** It uses 2-byte IO ids and counts.
  Configure devices for plain Codec 8, or implement 8E properly first.
- **`ignition` and `movement` are `boolean | null`.** Null means the device did not report the
  property, which is not the same as off. An interlock must treat null as unknown, not as safe.
- **Every socket is tracked, not only handshaken ones.** `server.close()` waits for open
  connections, so a device that connects and never identifies itself would hang shutdown
  forever. This was a real bug, caught by a test that closed the server with such a connection
  open.
- **A close only deregisters the IMEI if it still points at that socket.** Otherwise the close
  event of an already-replaced socket deletes the live entry and the device looks offline while
  it is not.
- **`sendCommand` returns a result, never throws.** `{ delivered: false, reason: 'not-connected' }`
  is a first-class outcome, because the caller must be able to tell "the device refused" from
  "the device was unreachable". A successful write is not confirmation: that comes from the
  `device.command-response` event or later telemetry.
- **Which digital output value immobilizes depends on the wiring, not the protocol.**
  `command-encoder.ts` maps immobilize to `setdigout 1` and restore to `setdigout 0`, matching
  the simulator. With a normally-closed relay the meaning inverts, and shipping it backwards
  means "immobilize" starts a bike and "restore" strands a rider. Verify on a bench relay before
  any vehicle.

**Testing it without hardware, at two levels.**

- `src/tcp/codec8-fixtures.ts` builds packets for the specs. It is a **separate encoder with its
  own CRC loop**, never an import of `crc16.ts`, so the parser is checked against bytes it did not
  produce. If the builder and the parser shared code, a misreading of the Teltonika spec would
  agree with itself and every test would pass. `crc16.spec.ts` anchors both by pinning the real
  CRC against published CRC-16/ARC vectors. It is named `codec8-fixtures.ts`, not `.spec.ts`, so
  Jest does not treat it as a suite.
- `tools/fake-device/` is a full device simulator for driving a **running** server
  (`npm run simulator -- --help`). Its own tests run under `npm run test:tools`, which needs a
  separate Jest config because the main one has `rootDir: src` and would otherwise skip them
  silently.
- **`src/` must never import from `tools/`.** `tools` is excluded from `tsconfig.build.json`, so a
  production build would either fail to resolve the import or drag the tool into `dist`. That is
  the second reason the specs use the fixture rather than the simulator's encoder.

**The simulator (`tools/fake-device/`).** It is a test instrument, so it is held to the same
standard as the app: linted, formatted, type-checked and tested.

- Scenarios: `stationary`, `moving`, `idle`, `abrupt-disconnect`, `corrupt-crc`, `corrupt-data`,
  `reconnect` (drops, comes back, delivers what it stored) and `split-writes` (each packet written
  in two chunks). `--devices N` runs a small fleet with distinct IMEIs.
- **It honours acknowledgements.** Records stay in a queue until the server acknowledges the exact
  count that was sent. A mismatched or missing ACK means retransmission, which is what makes the
  server's "never acknowledge a corrupt packet" rule observable: refuse one and the device sends it
  again rather than losing it.
- **It buffers while offline.** With no connection, cycles keep queueing records up to
  `--store N`, then drop the oldest as a real unit with finite memory does. On reconnect the
  backlog goes out, batched up to `--batch N`. This is the case enforcement has to handle: a
  decision made while a device was away must be reconciled against the telemetry that arrives when
  it returns.
- **It retries on ACK timeout.** Without that it would wait forever for a server that never
  answered, which is the one failure a test instrument must not hide. Two tests deadlocked before
  this existed, which is how it was found.
- Its tests run against a **minimal stub server**, not against `TcpServerService`. An instrument
  has to be trustworthy independently of the thing it measures; testing them against each other
  would make a shared misreading of the protocol look like agreement.
- Negative CLI numbers need the equals form (`--lat=-1.30`), since a leading dash parses as a flag.

`tcp-server.service.spec.ts` drives the real service over loopback sockets rather than a mocked
socket, because framing bugs only appear when bytes actually arrive split or back to back.

**`TCP_DEVICE_ENABLED=false` is set for `npm run test:e2e`.** Otherwise both e2e suites boot
`AppModule` in parallel and fight over port 5027. `listen(0)` picks an ephemeral port and
`port()` reports it, which is how the integration spec avoids the same clash.

### Enforcement: Desired State, Not Commands

Enforcement is a **reconciler**, not a command sender. Each asset stores a desired mobility
state (`MOBILE` / `IMMOBILIZED`) plus the last **device-confirmed** state. Nothing outside
`enforcement/` calls `sendCommand`.

- Enforcement rules (arrears, payment, admin action) only ever **write desired state**.
- The reconciler compares desired against confirmed and emits a command when they diverge
  *and* it is safe right now. It runs on device handshake, on telemetry arrival, and on a
  timer.
- Confirmed state advances only on the device's response or subsequent telemetry, **never**
  on a successful `write()`.

**Why not a pending-command queue.** A device reconnecting is usually a device that was just
powered on or just regained signal *while being ridden*. Draining a queued immobilize at
handshake therefore fires at a moving motorbike: the offline case and the most dangerous case
are the same case. Converging on desired state also removes stale-intent expiry, the ordering
problem when immobilize and restore are both pending (latest desired state simply wins), and
double-execution on retry, because convergence is idempotent where command replay is not.

**Restore is asymmetric with immobilize and must stay that way.** Immobilize needs the
interlock because it can kill someone; restore cannot hurt anyone. Restore is therefore
automatic and ungated, it fires immediately, including the moment an offline tracker
reconnects. A rider who has paid must not be stranded waiting for someone to click a button;
that is their day's income.

- **Restore triggers on "contract became current", not "payment received."** The decision
  reads the derived ledger balance inside the same transaction that posts the payment
  entries. Triggering off the webhook would let a token payment unlock a bike that is months
  down, and triggering off the balance means arrears cleared by an admin adjustment,
  write-off or restructure restores the bike too, which is correct.
- The "current enough to restore" threshold is **configuration**, not a literal in the
  service: fully current, within a grace amount, or one installment behind. It will be tuned.
- Immobilize, by contrast, typically does *not* fire at handshake. It waits for the next
  confirmed stationary moment.

Because desired state is a single mutable field, keep an **append-only log of desired-state
changes**, actor, contract, arrears snapshot, and the telemetry the interlock relied on.
That log is what answers a rider disputing an immobilization.

**Telemetry ingestion:**

- `onPositionReceived` must write through to `positions/` (or emit via
  `@nestjs/event-emitter` for other modules to consume), not just log. Keep the socket
  handler fast: hand off to a queue rather than doing heavy work inline.
- **TCP is a stream, not a message boundary.** `tryParsePackets` must track how many bytes
  `parseCodec8Packet` actually consumed, slice exactly that much off the buffer, and loop
  until the buffer is empty or holds an incomplete packet. Clearing the whole buffer after
  one packet silently drops data whenever a device sends packets back-to-back, which
  happens in weak-signal areas, exactly when the data matters.
- Devices drop and reconnect constantly; treat it as normal. Overwriting the `Map` entry on
  reconnect is the correct behaviour, destroy the superseded socket so it does not leak.
- A socket being present in the map is **not** proof the device is reachable. Never report
  immobilization as confirmed on the basis of a successful `write()`; confirm from the
  device's response or subsequent telemetry.
- **Verify IO IDs against the actual unit.** IO 239 (ignition) and 240 (movement) are
  Teltonika standards, but firmware and model differences exist, confirm against the
  specific FMB920 (or other) parameter list, using captured hex, before trusting field
  names.
- Prefer TLS where the device firmware supports it, terminated ahead of this handler.
  Plaintext device traffic on the public internet is a last resort, and the IMEI handshake
  alone is not authentication, an IMEI is guessable and spoofable, so never let telemetry
  alone authorize a financial or enforcement action.

Operationally: run behind a process manager or orchestrator restart policy, a crash drops
every device's connectivity at once, silently. Load test at the real expected
concurrent-device count before trusting it at fleet scale.

### Authentication & Authorization

- JWT authentication via Passport, signed with **RS256**. Keys are stored
  **base64-encoded PEM** in `JWT_PRIVATE_KEY_BASE64` / `JWT_PUBLIC_KEY_BASE64` so a PEM fits
  on one line, and are decoded in exactly one place, `src/config/jwt.config.ts`. Keys are
  never committed; the pair in `.env` is a development pair and must be regenerated per
  environment.
- `JwtStrategy` in `src/auth/strategy/jwt.strategy.ts` verifies the token and then
  **re-reads the user from the database on every request**, returning the role from the row
  rather than from the token. A deactivation or demotion therefore takes effect immediately
  instead of at token expiry. Do not "optimise" this into trusting the token payload without
  first adding real revocation.
- `ThrottlerGuard`, `JwtAuthGuard` and `RolesGuard` are registered globally in `AppModule`, in
  that order: rate limit before doing any work, then authenticate, then authorize. A new route
  is protected by default and opts out with `@Public()`.
- **Login must not leak which accounts exist.** Every failure (unknown email, wrong password,
  deactivated account) returns the same `401 Invalid credentials`, and the unknown-email path
  still runs an argon2 verification against a dummy hash so the response time does not
  differ. Tests assert both properties; keep them passing.
- RBAC: staff roles enumerated in `src/users/enums/role.enum.ts`, applied with `@Roles(...)`
  and enforced by `RolesGuard`. The staff roles are **admin** and **field agent**. Customers
  are a separate model and are **not** a role in this enum, see *Database* above.
- Role boundaries that matter: a field agent must not read or move money belonging to another
  agent's customers, and **immobilize/restore is not a field-agent capability by default**,
  an agent in the field is the most likely person to want that button and the least able to
  verify the bike is stopped. Grant it deliberately or not at all.
- If a rider-facing API ships, it authenticates `Customer` (phone/OTP) on its own path and
  issues tokens that the staff guards do not accept. A customer sees only their own contract,
  payments and bike.
- Authorization is checked in the service against the resource's owner, not only by role
  in the guard. Role alone never proves the record belongs to the caller. For customers that
  means comparing against `Customer.assignedAgentId`.
- Capabilities live in the **permission map** in `src/users/enums/role.enum.ts`, not in
  database tables, with two fixed roles, a permissions table would be a join on every
  request and a migration for every change. Prefer `@RequirePermissions(...)` over
  `@Roles(...)` on routes, so adding a role does not mean revisiting every controller. Move
  the map into the database only when admins need to edit roles at runtime.
- The principal type `AuthenticatedStaff` carries an explicit `kind: 'staff'`, and
  `RolesGuard` rejects anything else. When customer auth ships, a rider token must not
  satisfy a staff route just because it carries an id, the guard must never resolve a
  subject without checking which kind it is.
- Password hashing is **argon2id** via `PasswordService`, which owns the parameters so they
  can be raised in one place. `verify` treats a malformed stored hash as a failed password
  rather than throwing, so a corrupt row cannot 500 and mark an account as special.
- Never log tokens, keys, password hashes, or full payment payloads.

### Sessions: rotating refresh tokens

Access tokens are short-lived and carry the role; refresh tokens are long-lived and
revocable. `RefreshTokenService` owns them.

- A refresh token is **opaque random bytes**, not a JWT, stored only as a **SHA-256 hash**.
  A signed self-contained refresh token cannot be revoked without a blocklist, which ends up
  being the same database lookup with worse properties. Hashing means a database leak yields
  nothing replayable.
- **Rotation is unconditional.** Every refresh consumes the presented token and issues a new
  one, so a stolen token is useful only until the legitimate client next refreshes.
- **Replaying a rotated token revokes every session for that account**, including the
  replacement the legitimate client holds. Either the token leaked or someone is replaying it;
  neither is recoverable quietly, so both parties are forced to log in again.
- **The reuse revocation must not run inside a transaction that then throws.** The revocation
  has to commit while the request fails, and one transaction cannot do both: the throw rolls
  the revocation back, leaving the leaked family live. This was a real bug here, and it passed
  its unit tests until the `$transaction` test double was made to roll back on throw. Any test
  double for `$transaction` in this codebase must model rollback.
- Rotation claims the row with a conditional `updateMany` on `revokedAt: null` and checks
  `count === 1`. Two concurrent refreshes with the same token both pass the earlier checks;
  only one may win, and the loser is treated as a reuse rather than handed a second session.
- Confirmed state comes from the database. `revoke` is idempotent, so a client can always
  complete a logout.
- `revokeAllForUser` exists for password changes and suspected compromise. Wire it into the
  password change flow when that ships.

### Login protection: two independent layers

Both are needed, and neither substitutes for the other.

- **Per IP**, via `@nestjs/throttler`, on its own `login` bucket so credential endpoints do not
  share a budget with ordinary traffic (`@Throttle({ login: {} })`). Configured by
  `LOGIN_RATE_LIMIT` and `LOGIN_RATE_WINDOW_SECONDS`.
- **Per account**, via `User.failedLoginAttempts` and `lockedUntil`. IP limits do nothing
  against a distributed attack on one known admin address, which is the realistic threat.
- **The lockout must not become an oracle.** A locked account returns the same
  `401 Invalid credentials` as a wrong password, and the locked path still runs an argon2
  verification against a dummy hash so the response time does not reveal the lock. Otherwise
  the endpoint answers "does this email exist" for anyone willing to fail five times.
- **Keep the lockout window short** (`LOGIN_LOCKOUT_MINUTES`, default 15). A long lockout
  hands anyone who knows an admin's email a way to keep that person out of the system. This is
  a genuine tradeoff, not a setting to raise casually.
- Failed attempts are only counted against accounts that exist, so the table cannot be used to
  probe for addresses.

### Validation & API Contract

- A global `ValidationPipe` with `{ whitelist: true, forbidNonWhitelisted: true,
  transform: true }`, unknown properties are rejected, not silently ignored.
- Request/response DTOs live in each feature's `dto/`, use `class-validator` decorators,
  and are annotated with `@ApiProperty` for Swagger.
- Never accept a Prisma input type as a request body; that would let a client write any
  column.
- Entities are never returned raw. Map to a response DTO so hashes, internal ids, and
  provider payloads cannot leak.

### Swagger / OpenAPI

Set up in `src/config/swagger.ts` and mounted from `main.ts`. UI at **`/api`**, document at
**`/api-json`**.

- **Off by default in production.** `setupSwagger` returns false without mounting when
  `NODE_ENV === 'production'`, unless `SWAGGER_ENABLED=true` is set explicitly. The document
  names every endpoint and role boundary in the system, so publishing it is a deliberate act.
- Bearer auth is registered under the scheme name `bearer`; protected endpoints carry
  `@ApiBearerAuth('bearer')`. `@Public()` routes deliberately carry no security requirement,
  which makes the generated document a readable audit of what is unauthenticated.
- Every controller gets `@ApiTags`, every endpoint an `@ApiOperation` and its non-2xx
  responses. Response DTOs are real classes with `@ApiProperty`, never inline object literals,
  so the schema section stays usable.
- The response DTO is what the document promises. Returning an entity directly would publish
  the password hash column into the public schema.

### Background Jobs: Redis + BullMQ

- `@nestjs/bullmq` with Redis for work that must not block a request: provider webhook
  processing, payment reconciliation, unlock-token generation, SMS/push notifications,
  overdue-contract sweeps.
- Queues are registered in `src/queues/`; processors are `@Processor`-decorated classes
  that delegate to a feature service rather than holding business logic themselves.
- Job handlers must be **idempotent and retry-safe**, BullMQ will retry, and a retried
  payment job must not double-post to the ledger.
- Job payloads carry ids, not whole entities; re-read from the database inside the handler.

### Configuration

- All configuration comes from the environment through `ConfigService`. Do not read
  `process.env` outside `src/config/`.
- The environment **is** validated at boot: `validateEnv` (zod) is passed to
  `ConfigModule.forRoot`, so a missing `DATABASE_URL` or a JWT key that is not a base64 PEM
  aborts the bootstrap instead of failing on the first login. Add new variables to that schema,
  not just to `.env`.
- The schema **strips unknown variables**, so `ConfigService` only exposes what is declared.
  A variable that is not in the schema cannot be read through `ConfigService` at all.
- Inject `ConfigService<Env, true>` and read with `config.get('KEY', { infer: true })`, which
  is typed against the schema. An untyped `ConfigService` returns `unknown` or `any` and
  defeats both the schema and the no-any rule.
- Defaults live in the schema, in one place, not scattered as `?? '15m'` at call sites.
- `.env` is git-ignored; keep a committed `.env.example` listing every variable with safe
  placeholder values.

Expected variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string used by Prisma |
| `PORT` | HTTP port (`main.ts` falls back to 3000) |
| `NODE_ENV` | `development` / `test` / `production` |
| `JWT_PRIVATE_KEY_BASE64` | RS256 signing key, base64-encoded PEM |
| `JWT_PUBLIC_KEY_BASE64` | RS256 verification key, base64-encoded PEM |
| `JWT_EXPIRES_IN` | Access token lifetime (default `15m`) |
| `JWT_ISSUER` | Expected `iss` claim, verified on every request (default `paygo`) |
| `SWAGGER_ENABLED` | Set to `true` to publish `/api` in production |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh token lifetime (default 30) |
| `LOGIN_MAX_ATTEMPTS` | Failed logins before a per-account lockout (default 5) |
| `LOGIN_LOCKOUT_MINUTES` | Lockout duration; keep it short (default 15) |
| `LOGIN_RATE_LIMIT` / `LOGIN_RATE_WINDOW_SECONDS` | Per-IP limit on credential endpoints |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Used only by `npm run db:seed` |
| `REDIS_HOST` / `REDIS_PORT` | BullMQ connection |
| `TCP_DEVICE_ENABLED` | `false` disables the device listener (set for e2e runs) |
| `TCP_DEVICE_PORT` | Raw TCP listener for Teltonika devices (default 5027) |
| `TRACKING_OFFLINE_AFTER_SECONDS` | Quiet period before a bike is reported offline (default 300) |
| `IMMOBILIZE_STATIONARY_SECONDS` | Interlock: how long an asset must be stopped first |
| `RESTORE_ARREARS_THRESHOLD` | How current a contract must be to auto-restore mobility |

### Testing Strategy

- Unit tests sit beside the source file and mock `PrismaService`, a plain object of
  `jest.fn()`s is preferred over a deep mock, so the assertions show the exact query shape.
- Financial logic (payment allocation, schedule generation, ledger balance, interest or
  fee calculation) is tested at the unit level with explicit numeric fixtures, including
  the awkward cases: overpayment, underpayment, partial installment, early settlement,
  currency rounding.
- Webhook and payment endpoints get a test that submits the same payload twice and asserts
  exactly one payment and one balanced set of ledger entries.
- The protocol layer is tested with **synthetic and captured buffers**, no hardware
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
- Auth gets tests for what it must refuse, not only what it allows: wrong password, unknown
  email, deactivated account, identical failure messages, a hash verification on the
  unknown-email path, no token issued on failure, and a tampered signature rejected. When
  tampering with a token in a test, alter a character in the **middle** of the signature: the
  final base64url character of an RSA signature carries unused bits, so changing it can
  decode to the same signature and the test will pass a token that was never really modified.
- **A test double must not be more forgiving than the real thing.** The `$transaction` double
  in `refresh-token.service.spec.ts` restores a snapshot when the callback throws, because
  without that a write-then-throw looks committed and a rollback bug passes its own tests. That
  is exactly what happened here once.
- When a test is meant to catch a specific bug, **verify that it does**: reintroduce the bug,
  watch the test fail, then restore. A test written against reasoning about the code, rather
  than against the failing behaviour, can easily assert nothing.
- E2E tests in `test/` run against a **dedicated test database**, never the development
  one, provisioned with `prisma migrate deploy` and truncated between tests.

## Conventions

- Run `npm run lint` and `npm test` before treating a change as complete.
- New feature module → generate with `npx nest g module <name>` /`g controller` /
  `g service` so it matches the framework's expected wiring.
- Errors thrown from services are Nest HTTP exceptions (`NotFoundException`,
  `ConflictException`, …); do not let raw Prisma errors reach the client, a
  `PrismaClientKnownRequestError` filter maps `P2002` → 409 and `P2025` → 404.
- Migration names describe the change (`add_contract_payment_schedule`), not the ticket.

@architecture.md

## Commit & PR rules

- **Never** add any mention of Claude, AI, or co-authorship to git commits or
  pull requests. No `Co-Authored-By: Claude …` trailer, no "Generated with
  Claude Code" line, no AI attribution anywhere in commit messages or PR bodies.
  Write commit/PR text as a normal human author would.


## Writing style

- **Never** use em dashes (the `-` character) anywhere: not in commit messages,
  PR titles or bodies, code comments, documentation, or chat replies. Use commas,
  parentheses, colons, or separate sentences instead.
