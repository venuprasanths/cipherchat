const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function removeDemoUsers() {
    try {
        const result = await pool.query(
            "DELETE FROM users WHERE email IN ('alice@example.com', 'bob@example.com')"
        );
        console.log(`✅ Removed ${result.rowCount} demo accounts`);
        
        // Show remaining users
        const remaining = await pool.query("SELECT id, name, email FROM users");
        console.log('\n📋 Remaining users:');
        console.table(remaining.rows);
        
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await pool.end();
    }
}

removeDemoUsers();