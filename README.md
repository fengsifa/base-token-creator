# Tokenbase

A non-custodial ERC-20 Token Creator for Base. Wallets sign payment and deployment transactions; private keys never enter the application.

## Requirements

- Node.js 20+
- Docker Desktop with Docker Compose
- A PostgreSQL password for the local token_creator database
- A deployed Token Factory contract and Base configuration

## PostgreSQL

The database runs in Docker on an internal Compose network. PostgreSQL has no host port mapping and is not reachable from the public network. Run the application on the same internal Compose network so it can use the postgres host name.

Create a root .env file for Compose:

    POSTGRES_PASSWORD=replace-with-a-long-random-password

Set the server-side application connection in .env.local:

    DATABASE_URL=postgresql://token_creator:replace-with-a-long-random-password@postgres:5432/token_creator

When the Next.js server runs directly on the host instead of inside Compose, use the host name available to that server. Because port 5432 is intentionally not published, run the application inside the same Compose network for normal deployment.

Start PostgreSQL and the application together:

    docker compose up -d --build

The app is available at http://localhost:3000. The app container connects to PostgreSQL through the internal postgres host name. Only the app's local development port is bound to 127.0.0.1.

Start PostgreSQL only:

    docker compose up -d postgres

Stop the application and PostgreSQL:

    docker compose down

Stop PostgreSQL only:

    docker compose stop postgres

View status and health:

    docker compose ps
    docker compose logs postgres

Run the migration:

    Get-Content .\migrations\001_initial.sql | docker compose exec -T postgres psql -U token_creator -d token_creator

The migration creates the token_creator database schema and the tokens table used by the Creator and Admin APIs.

## Backup and restore

Create a compressed PostgreSQL backup:

    .\scripts\backup-db.ps1

Restore a dump after confirming the target database:

    Get-Content .\backups\token_creator-YYYYMMDD-HHMMSS.dump -Encoding Byte | docker compose exec -T postgres pg_restore -U token_creator -d token_creator --clean --if-exists

Backups are written to backups/, which is ignored by Git.

## Application setup

Copy .env.example to .env.local, then set the server-only values:

- DATABASE_URL
- ADMIN_SECRET

Configure the Base Sepolia RPC, Factory contract address, fee amount, and fee recipient as needed. The database is accessed only by the server through PostgreSQL.

Install and run:

    npm install
    npm run dev

Open http://localhost:3000/creator. Ordinary users do not need an account. The /admin page requires ADMIN_SECRET.

## Verification

    npm run lint
    npm run typecheck
    npm run build

For a full manual flow, verify wallet connection, Base network switching, payment transaction, Factory TokenCreated event, database lifecycle rows, Admin search/filter/pagination, refresh recovery, and BaseScan links.
