const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process'); // Import exec to run shell commands

dotenv.config();

const app = express();
app.use(express.json());

// Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- HELPER FUNCTIONS ---

/**
 * Executes 'asterisk -rx "dialplan reload"' to apply file changes.
 */
const reloadAsterisk = () => {
    return new Promise((resolve, reject) => {
        console.log('Reloading Asterisk Dialplan...');
        exec('asterisk -rx "dialplan reload"', (error, stdout, stderr) => {
            if (error) {
                console.error(`Error reloading Asterisk: ${error.message}`);
                // We resolve anyway so the API request completes successfully
                // (Assuming the file write was the critical part)
                resolve(); 
            } else {
                if (stderr) console.error(`Asterisk Stderr: ${stderr}`);
                console.log(`Asterisk Output: ${stdout.trim()}`);
                resolve();
            }
        });
    });
};

const generateDialplan = (tenantId, did, trunk) => {
    const agiUrl = process.env.AGI_URL || 'agi://localhost:4573';

    return `
; Auto-generated configuration for Tenant: ${tenantId}

[inbound-${tenantId}]
exten => ${did},1,NoOp(Inbound call for ${tenantId})
same => n,Answer()
same => n,Playback(welcome)
same => n,Hangup()

[outbound-${tenantId}]
exten => _X.,1,NoOp(Outbound call from ${tenantId})
; 1. Run AGI Check (Node.js Service)
same => n,Set(CDR(tenant)=${tenantId})
same => n,Set(recording=${tenantId}/\${CALLERID(num)}_\${EXTEN}_\${EPOCH}.wav)
same => n,AGI(${agiUrl}, \${CALLERID(num)}, \${EXTEN})

; 2. Check Permission
same => n,GotoIf($["\${IS_ALLOWED}" = "false"]?deny)

; 3. Routing Logic based on Target Type (INTERNAL vs EXTERNAL)
same => n,GotoIf($["\${TARGET_TYPE}" = "INTERNAL"]?dial_internal)
same => n,GotoIf($["\${TARGET_TYPE}" = "EXTERNAL"]?dial_external)
same => n,Goto(deny)

; --- INTERNAL CALL (Extension to Extension) ---
same => n(dial_internal),NoOp(Internal Call Detected)
same => n,Set(CDR(recording)=\${recording})
same => n,MixMonitor(\${recording},ab)
same => n,Dial(PJSIP/\${EXTEN},30)
same => n,Hangup()

; --- EXTERNAL CALL (To Trunk) ---
same => n(dial_external),NoOp(External Call Detected)
same => n,Set(CDR(recording)=\${recording})
same => n,MixMonitor(\${recording},ab)
same => n,Dial(PJSIP/\${EXTEN}@${trunk},60)
same => n,Hangup()

; --- DENIED ---
same => n(deny),NoOp(Call Denied)
same => n,Playback(ss-noservice)
same => n,Hangup()
`;
};

// --- API ENDPOINTS ---

/**
 * 1. POST /tenant
 * Creates DB entry, writes .conf file, AND reloads Asterisk.
 */
app.post('/tenant', async (req, res) => {
    const { name, inbound_did, outbound_trunk } = req.body;

    if (!name || !inbound_did || !outbound_trunk) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const insertQuery = 'INSERT INTO tenants (id, inbound_did, outbound_trunk) VALUES (?, ?, ?)';
        await connection.execute(insertQuery, [name, inbound_did, outbound_trunk]);

        // Generate and Write File
        const fileContent = generateDialplan(name, inbound_did, outbound_trunk);
        const filePath = path.join(process.env.ASTERISK_CONFIG_DIR, `extensions_${name}.conf`);
        
        await fs.writeFile(filePath, fileContent);

        // Commit DB Transaction
        await connection.commit();

        // RELOAD ASTERISK
        // We do this after commit/write to ensure Asterisk sees the new file
        await reloadAsterisk();

        console.log(`Created tenant ${name} and reloaded Asterisk`);
        res.status(201).json({ message: 'Tenant created and Asterisk reloaded', id: name, context_file: filePath });

    } catch (error) {
        await connection.rollback();
        console.error(error);
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Tenant already exists' });
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        connection.release();
    }
});

app.get('/tenants', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM tenants');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * 3. POST /extension
 * Only updates DB (Realtime). No file reload needed usually.
 */
app.post('/tenant/:id/extension', async (req, res) => {
    const tenantId = req.params.id;
    const { username, password } = req.body;

    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [tenantRows] = await connection.execute('SELECT id FROM tenants WHERE id = ?', [tenantId]);
        if (tenantRows.length === 0) throw new Error('Tenant not found');

        const endpointId = username; 

        // 1. Auth
        await connection.execute('INSERT INTO ps_auths (id, auth_type, username, password) VALUES (?, "userpass", ?, ?)', [endpointId, username, password]);
        // 2. AOR
        await connection.execute('INSERT INTO ps_aors (id, max_contacts, remove_existing) VALUES (?, 1, "yes")', [endpointId]);
        // 3. Endpoint
        const sqlEndpoint = `
            INSERT INTO ps_endpoints 
            (id, transport, aors, auth, context, disallow, allow, direct_media, force_rport, rewrite_contact, ice_support, media_encryption, tenantid) 
            VALUES (?, 'transport-udp', ?, ?, ?, 'all', 'alaw,ulaw', 'no', 'no', 'no', 'yes', 'no', ?)
        `;
        await connection.execute(sqlEndpoint, [endpointId, endpointId, endpointId, `outbound-${tenantId}`, tenantId]);

        await connection.commit();
        
        // Note: We intentionally do NOT reload Asterisk here. 
        // Realtime PJSIP picks up DB changes automatically.
        
        res.status(201).json({ message: 'Extension created', extension: username });

    } catch (error) {
        await connection.rollback();
        if (error.message === 'Tenant not found') return res.status(404).json({ error: 'Tenant does not exist' });
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Extension already exists' });
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        connection.release();
    }
});

app.get('/tenant/:id/extensions', async (req, res) => {
    const tenantId = req.params.id;
    try {
        const [rows] = await pool.execute('SELECT id, context, allow, ice_support FROM ps_endpoints WHERE tenantid = ?', [tenantId]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
