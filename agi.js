require('dotenv').config();
const AGIServer = require('ding-dong');
const mysql = require('mysql2/promise');
const { PhoneNumberUtil } = require('google-libphonenumber');

const phoneUtil = PhoneNumberUtil.getInstance();

// --- DATABASE CONNECTION ---
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- HELPER FUNCTIONS (Same as before) ---
function isValidExternal(number) {
    try {
        const numberStr = number.startsWith('+') ? number : `+${number}`;
        const parsedNumber = phoneUtil.parseAndKeepRawInput(numberStr);
        return phoneUtil.isValidNumber(parsedNumber);
    } catch (e) {
        return false;
    }
}

async function checkTenantAuthorization(fromExt, toNum) {
    const connection = await pool.getConnection();
    try {
        // A. Check Internal Extension
        const [toRows] = await connection.execute(
            'SELECT tenantid FROM ps_endpoints WHERE id = ?', 
            [toNum]
        );

        if (toRows.length > 0) {
            const toTenant = toRows[0].tenantid;
            const [fromRows] = await connection.execute(
                'SELECT tenantid FROM ps_endpoints WHERE id = ?', 
                [fromExt]
            );

            if (fromRows.length === 0) return { allowed: false, type: 'UNKNOWN' };

            const fromTenant = fromRows[0].tenantid;
            
            if (fromTenant === toTenant) {
                return { allowed: true, type: 'INTERNAL' };
            } else {
                return { allowed: false, type: 'MISMATCH' };
            }
        }

        // B. Check External
        if (isValidExternal(toNum)) {
            return { allowed: true, type: 'EXTERNAL' };
        }

        return { allowed: false, type: 'INVALID' };

    } catch (err) {
        console.error('DB Error:', err);
        return { allowed: false, type: 'ERROR' };
    } finally {
        connection.release();
    }
}

// --- AGI HANDLER ---
const handler = async (context) => {
    // 'variables' event is fired when Asterisk finishes sending env vars
    const vars = await context.onEvent('variables')
        console.log(`Inside Vars Event: ${JSON.stringify(vars)}`);
        console.log(`Vars.aginetworkscript: ${vars.agi_network_script}`)
        // 1. Get Arguments (agi_arg_1, agi_arg_2)
        const fromExtension = vars.agi_arg_1;
        const toNumber = vars.agi_arg_2;

        console.log(`Processing: ${fromExtension} -> ${toNumber}`);

        if (!fromExtension || !toNumber) {
            console.error('Missing arguments');
            // ding-dong uses .setVariable() which returns a Promise
            await context.setVariable('IS_ALLOWED', 'false');
            context.end();
            return;
        }

        // 2. Perform Check
        const result = await checkTenantAuthorization(fromExtension, toNumber);

        console.log(`Result: ${result.type} (Allowed: ${result.allowed})`);

        // 3. Set Variables using ding-dong API
        try {
            await context.setVariable('IS_ALLOWED', result.allowed ? 'true' : 'false');
            await context.setVariable('TARGET_TYPE', result.type);
        } catch (err) {
            console.error('Error setting variables:', err);
        }

        // 4. End AGI Session
        context.end();
    
    context.onEvent('error', (err) => {
        console.error('AGI Context Error:', err);
    });
};

// --- START SERVER ---
const PORT = process.env.AGI_PORT || 4573;
const agi = new AGIServer(handler, {port: PORT});

agi.start();
console.log(`FastAGI Server (ding-dong) listening on port ${PORT}`);
