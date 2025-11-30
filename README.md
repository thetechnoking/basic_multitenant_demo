# Asterisk Multi-Tenant Management System

This project implements a multi-tenant PBX solution using **Node.js**, **Asterisk (Realtime PJSIP)**, and **MySQL**. It consists of two main services:

1.  **Express API Service**: Manages Tenants, Extensions, and generates dynamic Asterisk Dialplan configuration.
2.  **FastAGI Service**: A real-time decision engine that intercepts calls to enforce tenant isolation and distinguish between internal (extension-to-extension) and external (PSTN) calls.

## Features

  * **Tenant Isolation**: Ensures extensions can only call other extensions within the same tenant.
  * **Dynamic Configuration**: Automatically generates and reloads Asterisk dialplans upon tenant creation.
  * **Realtime PJSIP**: Uses MySQL to store SIP endpoints, Auth, and AORs, allowing immediate extension creation without reloading Asterisk.
  * **External Call Validation**: Validates global phone numbers using `google-libphonenumber` before allowing outbound trunk calls.

-----

## Prerequisites

  * **Node.js** (v14 or higher)
  * **Asterisk** (v16+) with PJSIP and Realtime Architecture configured (ODBC/MySQL).
  * **MySQL Server**
  * **Google Libphonenumber** (managed via NPM)

-----

## Installation

1.  **Clone the repository**:

    ```bash
    git clone https://github.com/your-repo/asterisk-tenant-manager.git
    cd asterisk-tenant-manager
    ```

2.  **Install Dependencies**:

    ```bash
    npm install
    ```

    *Required packages: `express`, `mysql2`, `dotenv`, `ding-dong`, `google-libphonenumber`.*

-----

## Database Setup

This project relies on standard Asterisk PJSIP tables (Realtime) plus a custom `tenants` table.

1.  **Import Asterisk PJSIP Schema**:
    Ensure your MySQL database contains the standard PJSIP tables (`ps_endpoints`, `ps_auths`, `ps_aors`, etc.). *Refer to the `mysql_config.sql` provided in the Asterisk source or Alembic scripts.*

2.  **Create Custom Tenant Table**:
    Run the following SQL command:

    ```sql
    CREATE TABLE tenants (
        id VARCHAR(255) NOT NULL,
        inbound_did VARCHAR(50),
        outbound_trunk VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    );
    ```

-----

## Configuration

### 1\. Environment Variables

Create a `.env` file in the root directory:

```env
# HTTP API Configuration
PORT=3000

# FastAGI Configuration
AGI_PORT=4573
AGI_URL=agi://localhost:4573

# Database Credentials
DB_HOST=localhost
DB_USER=asterisk_user
DB_PASSWORD=your_secure_password
DB_NAME=asterisk

# Asterisk Integration
# Directory where the API writes generated dialplan files
ASTERISK_CONFIG_DIR=/etc/asterisk/tenant_contexts
```

### 2\. Asterisk Configuration

Ensure Asterisk is configured to load the generated files and connect to the AGI.

**`extensions.conf`**:
Add this line to include the generated tenant contexts:

```asterisk
#include tenant_contexts/*.conf
```

**`extconfig.conf`** (Realtime Setup):
Ensure your PJSIP tables are mapped:

```ini
[settings]
ps_endpoints => odbc,asterisk
ps_auths => odbc,asterisk
ps_aors => odbc,asterisk
```

-----

## Running the Services

You need to run both the API and the AGI server. You can run them in separate terminals or use a process manager like PM2.

**1. Start the HTTP API**:

```bash
node server.js
```

*Listens on port 3000.*

**2. Start the FastAGI Server**:

```bash
node index.js
```

*Listens on port 4573.*

-----

## API Reference

### 1\. Create Tenant

Creates a tenant, writes the `.conf` file to disk, and reloads Asterisk.

  * **Endpoint**: `POST /tenant`
  * **Body**:
    ```json
    {
      "name": "acme_corp",
      "inbound_did": "14155550100",
      "outbound_trunk": "trunk_provider_a"
    }
    ```

### 2\. List Tenants

  * **Endpoint**: `GET /tenants`

### 3\. Create Extension

Creates a SIP extension in the Realtime database (no reload needed).

  * **Endpoint**: `POST /tenant/:id/extension`
  * **Body**:
    ```json
    {
      "username": "1001",
      "password": "SecretPassword!"
    }
    ```

### 4\. List Extensions

  * **Endpoint**: `GET /tenant/:id/extensions`

-----

## Testing

You can use the provided shell scripts or `curl` commands to test the system.

**Create Tenant**:

```bash
curl -X POST http://localhost:3000/tenant \
     -H "Content-Type: application/json" \
     -d '{"name": "acme", "inbound_did": "1000", "outbound_trunk": "pstn"}'
```

**Create Extension**:

```bash
curl -X POST http://localhost:3000/tenant/acme/extension \
     -H "Content-Type: application/json" \
     -d '{"username": "101", "password": "123"}'
```

-----

## How It Works

1.  **Provisioning**:

      * When a tenant is created, `server.js` generates a specific context `[outbound-tenant]` in a file inside `/etc/asterisk/tenant_contexts/`.
      * This context includes an `AGI()` call to your Node.js service.

2.  **Call Logic**:

      * **User Dials**: When Extension A dials a number, it hits the generated context.
      * **AGI Interception**: Asterisk connects to `localhost:4573`.
      * **Validation**: `index.js` checks:
          * Is the destination an internal extension? If so, does it belong to the **same tenant**?
          * Is it a valid external PSTN number?
      * **Routing**: The AGI sets variables (`IS_ALLOWED`, `TARGET_TYPE`).
      * **Execution**: Asterisk resumes dialplan execution.
          * If `INTERNAL`: `Dial(PJSIP/${EXTEN})`
          * If `EXTERNAL`: `Dial(PJSIP/${EXTEN}@trunk)`
          * If `DENIED`: Plays rejection message.
